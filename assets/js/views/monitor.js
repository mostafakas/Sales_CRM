// Live monitor: a real-time board of who is working, on a break, in a meeting, finished, not started, or away.
import { L, esc, fmtDur, fmtTime, fmtMin, fmtHours, num, debounce, hmToMin, ymd } from '../core/utils.js';
import { toast, toastErr, avatar, STATUS_META, empty, confirmDialog, bindActions, modal } from '../core/ui.js';
import { session, now, isHR, seesAll } from '../core/session.js';
import { dayKey, planFor, lateness, modeLabel, roleLabel, isWorkingPlan, policy, leaveType, withShift } from '../core/policy.js';
import { toMs, list, query, col, where } from '../core/fb.js';
import { onDirectory, supervisedPeople as managedPeople, departments } from '../services/directory.js';
import { liveBank, staleDay, closeStaleDay, changeStatus, resetLive, COUNTED } from '../services/attendance.js';
import { showDayDetails } from './attendance.js';
import { classifyDay } from '../services/reports.js';

// board states, in display order
const STATES = {
  working:    { ar: 'بيشتغل', en: 'Working', color: 'var(--ok)', icon: 'fa-laptop-code', cls: 'ok' },
  meeting:    { ar: 'في اجتماع', en: 'In a meeting', color: 'var(--info)', icon: 'fa-users', cls: 'info' },
  break:      { ar: 'استراحة', en: 'On break', color: 'var(--warn)', icon: 'fa-mug-hot', cls: 'warn' },
  notstarted: { ar: 'ما بدأش', en: 'Not started', color: 'var(--border-strong)', icon: 'fa-hourglass-start', cls: '' },
  ended:      { ar: 'خلّص يومه', en: 'Day ended', color: 'var(--brand)', icon: 'fa-flag-checkered', cls: 'brand' },
  away:       { ar: 'إجازة / خارج', en: 'Away / off', color: 'var(--neutral)', icon: 'fa-umbrella-beach', cls: '' }
};
const ORDER = Object.keys(STATES);
const FROM_STATUS = { Online: 'working', Break: 'break', Meeting: 'meeting' };
const VIEW_KEY = 'am_monitor_view';
// the headline time is work + meetings (breaks are shown on their own row and are not part of it)
const SEGS = ['Online', 'Meeting'];
const bankTotal = (b) => (b.Online || 0) + (b.Meeting || 0);
/** width % of work and meetings in the day bar; past the planned hours the bar is full and keeps the proportions */
const segWidths = (b, target) => { const d = Math.max(target || 1, bankTotal(b)); return SEGS.map(k => ((b[k] || 0) / d * 100).toFixed(2)); };
const planMs = (p) => (p && p.start && p.end ? Math.max(0, hmToMin(p.end) - hmToMin(p.start)) * 60000 : 8 * 3600000);

export default async function render(root) {
  let filter = 'all', term = '', dept = '';
  let view = (() => { try { return localStorage.getItem(VIEW_KEY) || 'table'; } catch { return 'table'; } })();
  const narrow = matchMedia('(max-width: 820px)');
  let schedules = {}; // email -> schedule doc for this month

  root.innerHTML = `
    <div class="page-head">
      <div><h2>${L('المتابعة اللحظية', 'Live monitor')} <span class="live-pill"><span class="pulse"></span>${L('مباشر', 'Live')}</span></h2>
        <p>${seesAll() ? L('كل الموظفين اللي بيسجّلوا حضور — بيتحدّث لوحده.', 'Everyone who clocks in — updates on its own.') : L('فريقك — بيتحدّث لوحده.', 'Your team — updates on its own.')}</p></div>
      <div class="seg" id="viewseg" role="group" aria-label="${L('طريقة العرض', 'View')}">
        <button data-v="table" title="${L('جدول', 'Table')}"><i class="fas fa-table-list"></i><span>${L('جدول', 'Table')}</span></button>
        <button data-v="cards" title="${L('كروت', 'Cards')}"><i class="fas fa-grip"></i><span>${L('كروت', 'Cards')}</span></button>
      </div>
    </div>
    <section class="card mon-summary mb-16" id="summary"></section>
    <div class="filters mon-toolbar">
      <div class="search"><i class="fas fa-search"></i><input class="input" id="q" placeholder="${L('ابحث بالاسم أو المسمى', 'Search name or title')}"></div>
      ${seesAll() ? `<select class="select" id="dept"><option value="">${L('كل الأقسام', 'All departments')}</option>${departments().map(d => `<option>${esc(d)}</option>`).join('')}</select>` : ''}
      <div class="fchips" id="chips"></div>
    </div>
    <div id="board"></div>`;

  const today = () => dayKey(now());
  // HR manages everyone; a leader manages the people who report directly to them
  const canManage = (u) => isHR() || (u.leaderEmail === session.email && u.email !== session.email);

  async function loadSchedules() {
    const ym = today().slice(0, 7);
    try {
      const q = seesAll() ? query(col('schedules'), where('month', '==', ym)) : query(col('schedules'), where('leaderEmail', '==', session.email), where('month', '==', ym));
      const rows = await list(q);
      schedules = Object.fromEntries(rows.map(s => [s.email, s]));
    } catch { schedules = {}; }
  }

  const info = (u) => {
    const t = today();
    const isToday = u.dayKey === t;
    const plan = withShift(planFor(t, schedules[u.email] || null, u), isToday ? u.shift : '');
    const on = isToday && u.status && u.status !== 'Offline';
    const fo0 = isToday ? toMs(u.firstOnlineAt) : null;
    const fo = fo0 && dayKey(fo0) === t ? fo0 : null; // a check-in from another day (wrong device clock) is ignored
    let state;
    if (on) state = FROM_STATUS[u.status] || 'working';
    else if (fo) state = 'ended';
    else if (!isWorkingPlan(plan) || plan.mode === 'mission') state = 'away';
    else state = 'notstarted';
    const late = fo ? lateness(fo, plan).late : 0;
    const bank = isToday ? liveBank(u) : { Online: 0, Break: 0, Meeting: 0 };
    return {
      state, plan, fo, late, bank, on,
      stale: staleDay(u),
      remote: isToday && u.workLocation === 'remote',
      pending: isToday && !!u.remotePending,
      since: on ? (toMs(u.lastChange) || u.lastChangeClient) : null,
      target: planMs(plan)
    };
  };
  const matchesBase = (u) => {
    if (term && !(`${u.name || ''} ${u.email} ${u.title || ''}`.toLowerCase().includes(term))) return false;
    if (dept && u.department !== dept) return false;
    return true;
  };
  const matchesFilter = (i, f) => {
    if (f === 'all') return true;
    if (STATES[f]) return i.state === f;
    if (f === 'remote') return i.remote && (i.on || i.state === 'ended');
    if (f === 'late') return i.late > 0;
    if (f === 'review') return !!i.stale || i.pending;
    if (f === 'checkedin') return !!i.fo;
    return true;
  };

  function summaryHTML(people, infos) {
    const n = people.length || 0;
    const count = (s) => people.filter(p => infos.get(p.email).state === s).length;
    const counts = Object.fromEntries(ORDER.map(s => [s, count(s)]));
    const active = counts.working + counts.meeting + counts.break;
    const expected = people.filter(p => infos.get(p.email).state !== 'away').length;
    const checked = people.filter(p => infos.get(p.email).fo).length;
    const pct = expected ? Math.round((checked / expected) * 100) : 0;
    const metric = (f, icon, cls, label, v, hint) => `<button class="mon-metric ${filter === f ? 'on' : ''}" data-filter="${f}">
        <span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>
        <span class="grow"><span class="lbl">${esc(label)}</span><b class="num">${num(v)}</b>${hint ? `<small>${esc(hint)}</small>` : ''}</span></button>`;
    return `
      <div class="mon-main">
        <div class="mon-headline">
          <div class="mon-big num">${num(active)}<small>/ ${num(n)}</small></div>
          <div><b>${L('شغالين دلوقتي', 'Active right now')}</b><span>${L(`${num(checked)} من ${num(expected)} سجّلوا حضور النهارده`, `${num(checked)} of ${num(expected)} expected have checked in today`)}</span></div>
          <div class="mon-ring" style="--p:${pct}"><span class="num">${pct}%</span></div>
        </div>
        <div class="mon-dist" role="img" aria-label="${esc(ORDER.map(s => `${L(STATES[s].ar, STATES[s].en)} ${counts[s]}`).join(', '))}">
          ${n ? ORDER.filter(s => counts[s]).map(s => `<span style="flex:${counts[s]};background:${STATES[s].color}" title="${esc(L(STATES[s].ar, STATES[s].en))}: ${counts[s]}"></span>`).join('') : '<span style="flex:1;background:var(--surface-2)"></span>'}
        </div>
        <div class="mon-legend">
          ${ORDER.map(s => `<button class="${filter === s ? 'on' : ''}" data-filter="${s}"><span class="dot" style="background:${STATES[s].color}"></span>${esc(L(STATES[s].ar, STATES[s].en))}<b class="num">${num(counts[s])}</b></button>`).join('')}
        </div>
      </div>
      <div class="mon-metrics">
        ${metric('remote', 'fa-house-laptop', '', L('أونلاين النهارده', 'Remote today'), people.filter(p => { const i = infos.get(p.email); return i.remote && (i.on || i.state === 'ended'); }).length)}
        ${metric('late', 'fa-clock', 'warn', L('متأخرين', 'Late today'), people.filter(p => infos.get(p.email).late > 0).length, L(`بعد ${policy.workStart} + ${policy.graceMinutes || 0} د سماح`, `after ${policy.workStart} + ${policy.graceMinutes || 0}m grace`))}
        ${metric('review', 'fa-triangle-exclamation', 'bad', L('محتاجين مراجعة', 'Need review'), people.filter(p => { const i = infos.get(p.email); return i.stale || i.pending; }).length, L('يوم مفتوح أو أونلاين من غير موافقة', 'Open day or unapproved remote'))}
        ${metric('notstarted', 'fa-hourglass-start', '', L('ما بدأوش', 'Not started'), counts.notstarted)}
      </div>`;
  }

  const statusCell = (u, i) => {
    const s = STATES[i.state];
    const live = i.on ? 'live' : '';
    let sub = '';
    if (i.on && i.since) sub = L(`من ${fmtTime(i.since)}`, `since ${fmtTime(i.since)}`);
    else if (i.state === 'away') sub = i.plan.mode === 'leave' ? (leaveType(i.plan.leaveType) ? L(leaveType(i.plan.leaveType).ar, leaveType(i.plan.leaveType).en) : modeLabel('leave')) : modeLabel(i.plan.mode);
    else if (i.state === 'notstarted') sub = L(`الدوام ${i.plan.start || policy.workStart}`, `Starts ${i.plan.start || policy.workStart}`);
    return `<span class="badge ${s.cls} ${live}"><span class="dot"></span>${esc(L(s.ar, s.en))}</span>${sub ? `<small class="sub">${esc(sub)}</small>` : ''}`;
  };
  const flags = (i) => [
    i.plan.shift && (i.on || i.fo) ? `<span class="badge info"><i class="fas fa-clock-rotate-left"></i>${L('شيفت 10', '10:00 shift')}</span>` : '',
    i.late ? `<span class="badge bad">${L('تأخير', 'Late')} ${esc(fmtMin(i.late))}</span>` : '',
    i.pending ? `<span class="badge warn"><i class="fas fa-circle-exclamation"></i>${L('أونلاين بدون موافقة', 'Remote not approved')}</span>` : '',
    i.stale ? `<span class="badge bad"><i class="fas fa-triangle-exclamation"></i>${L('يوم مفتوح', 'Open day')} <span class="num">${esc(i.stale)}</span></span>` : ''
  ].join('');
  const where_ = (u, i) => {
    if (!(i.on || i.state === 'ended')) return '<span class="faint">—</span>';
    return `<span class="loc ${i.remote ? 'remote' : ''}"><i class="fas ${i.remote ? 'fa-house-laptop' : 'fa-building'}"></i>${esc(modeLabel(u.workLocation || 'office'))}</span>`;
  };
  // the day bar: work and meetings side by side, each in its own colour, against the planned hours
  const progress = (u, i) => {
    const w = segWidths(i.bank, i.target);
    return `<div class="mon-work"><div class="row between"><b class="num" data-live="${esc(u.email)}|Total" title="${L('العمل + الاجتماعات', 'Work + meetings')}">${fmtDur(bankTotal(i.bank))}</b><small class="faint num">${esc(fmtHours(i.target))}</small></div>
      <div class="progress stack">${SEGS.map((k, n) => `<span data-seg="${esc(u.email)}|${k}" style="width:${w[n]}%;background:${STATUS_META[k].color}" title="${esc(L(STATUS_META[k].ar, STATUS_META[k].en))}"></span>`).join('')}</div></div>`;
  };
  // the break, alone on its own row
  const subTimes = (u, i) => `<span title="${L('استراحة', 'Break')}"><i class="fas fa-mug-hot" style="color:var(--warn)"></i>${L('استراحة', 'Break')} <span data-live="${esc(u.email)}|Break">${fmtDur(i.bank.Break)}</span></span>`;
  const actions = (u) => `<div class="row gap-4 mon-actions">
      <button class="btn btn-sm btn-ghost btn-icon" data-action="history" data-email="${esc(u.email)}" title="${L('سجل النهارده', "Today's log")}" aria-label="${L('سجل النهارده', "Today's log")}"><i class="fas fa-clock-rotate-left"></i></button>
      ${canManage(u) ? `<button class="btn btn-sm btn-ghost btn-icon" data-action="manage" data-email="${esc(u.email)}" title="${L('إدارة', 'Manage')}" aria-label="${L('إدارة', 'Manage')}"><i class="fas fa-ellipsis-vertical"></i></button>` : ''}
    </div>`;
  const who = (u, i) => `<div class="person"><span class="avatar-wrap">${avatar(u, 'sm')}<span class="status-dot" style="background:${STATES[i.state].color}"></span></span>
      <div class="min0"><b class="truncate">${esc(u.name || u.email)}</b><span class="truncate">${esc(u.title || roleLabel(u.role))}${u.department && seesAll() ? ` · ${esc(u.department)}` : ''}</span></div></div>`;

  function tableHTML(rows, infos) {
    return `<div class="card"><div class="table-wrap"><table class="table mon-table"><thead><tr>
        <th>${L('الموظف', 'Employee')}</th><th>${L('الحالة', 'Status')}</th><th>${L('المكان', 'Location')}</th><th>${L('الحضور', 'Check-in')}</th>
        <th style="min-width:180px">${L('العمل والاجتماعات', 'Work & meetings')}</th><th>${L('الاستراحة', 'Break')}</th><th></th>
      </tr></thead><tbody>${rows.map(u => {
        const i = infos.get(u.email);
        return `<tr class="${i.on ? '' : 'idle'}" data-email="${esc(u.email)}">
          <td>${who(u, i)}${flags(i) ? `<div class="row-wrap gap-4 mt-8">${flags(i)}</div>` : ''}</td>
          <td class="mon-status">${statusCell(u, i)}</td>
          <td>${where_(u, i)}</td>
          <td class="num">${i.fo ? esc(fmtTime(i.fo)) : '<span class="faint">—</span>'}</td>
          <td>${i.fo || i.on ? progress(u, i) : '<span class="faint">—</span>'}</td>
          <td>${i.fo || i.on ? `<div class="num mon-sub">${subTimes(u, i)}</div>` : '<span class="faint">—</span>'}</td>
          <td style="text-align:end">${actions(u)}</td></tr>`;
      }).join('')}</tbody></table></div></div>`;
  }
  function cardsHTML(rows, infos) {
    return `<div class="mon-cards">${rows.map(u => {
      const i = infos.get(u.email);
      return `<article class="card mon-card ${i.on ? '' : 'idle'}" style="--st:${STATES[i.state].color}">
        <div class="row gap-8">${who(u, i)}${actions(u)}</div>
        <div class="row between gap-8 mon-card-status"><div class="mon-status">${statusCell(u, i)}</div>${where_(u, i)}</div>
        ${i.fo || i.on ? progress(u, i) : ''}
        <div class="row between xs muted">
          <span>${i.fo ? `<i class="fas fa-right-to-bracket"></i> <span class="num">${esc(fmtTime(i.fo))}</span>` : L('لسه ما سجّلش حضور', 'Not checked in yet')}</span>
          ${i.fo || i.on ? `<span class="num mon-sub">${subTimes(u, i)}</span>` : ''}
        </div>
        ${flags(i) ? `<div class="row-wrap gap-4">${flags(i)}</div>` : ''}
      </article>`;
    }).join('')}</div>`;
  }

  function draw() {
    const people = managedPeople().filter(p => (p.email !== session.email || isHR()) && p.trackAttendance !== false && !p.isSuspended);
    const infos = new Map(people.map(p => [p.email, info(p)]));
    const base = people.filter(matchesBase);
    root.querySelector('#summary').innerHTML = summaryHTML(base, infos);
    const chipDefs = [['all', L('الكل', 'All')], ...ORDER.map(s => [s, L(STATES[s].ar, STATES[s].en)]), ['remote', L('أونلاين', 'Remote')], ['late', L('متأخر', 'Late')], ['review', L('مراجعة', 'Review')]];
    root.querySelector('#chips').innerHTML = chipDefs.map(([k, t]) => {
      const c = base.filter(p => matchesFilter(infos.get(p.email), k)).length;
      return `<button class="fchip ${filter === k ? 'on' : ''}" data-filter="${k}">${esc(t)}<span class="num">${num(c)}</span></button>`;
    }).join('');
    const rows = base.filter(p => matchesFilter(infos.get(p.email), filter))
      .sort((a, b) => ORDER.indexOf(infos.get(a.email).state) - ORDER.indexOf(infos.get(b.email).state) || (a.name || a.email).localeCompare(b.name || b.email, 'ar'));
    const board = root.querySelector('#board');
    if (!rows.length) {
      board.innerHTML = `<div class="card">${empty('fa-users-slash', L('مفيش حد في الفلتر ده', 'Nobody matches this filter'), !people.length && !seesAll() ? L('لو فريقك فاضي، اطلب من HR يربط الموظفين بيك.', 'If your team is empty, ask HR to assign members to you.') : '')}</div>`;
      return;
    }
    const v = narrow.matches ? 'cards' : view;
    board.innerHTML = v === 'cards' ? cardsHTML(rows, infos) : tableHTML(rows, infos);
    root.querySelectorAll('#viewseg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  }

  function tick() {
    const t = today();
    managedPeople().forEach(u => {
      if (u.dayKey !== t || !u.status || u.status === 'Offline') return;
      const bank = liveBank(u);
      bank.Total = bankTotal(bank);
      root.querySelectorAll(`[data-live^="${CSS.escape(u.email)}|"]`).forEach(el => { el.textContent = fmtDur(bank[el.dataset.live.split('|')[1]]); });
      const w = segWidths(bank, planMs(withShift(planFor(t, schedules[u.email] || null, u), u.shift)));
      SEGS.forEach((k, n) => { const s = root.querySelector(`[data-seg="${CSS.escape(u.email)}|${k}"]`); if (s) s.style.width = w[n] + '%'; });
    });
  }

  root.addEventListener('click', (e) => {
    const f = e.target.closest('[data-filter]');
    if (f && root.contains(f)) { filter = filter === f.dataset.filter && f.dataset.filter !== 'all' ? 'all' : f.dataset.filter; draw(); }
    const v = e.target.closest('#viewseg button');
    if (v) { view = v.dataset.v; try { localStorage.setItem(VIEW_KEY, view); } catch {} draw(); }
  });
  root.querySelector('#q').oninput = debounce((e) => { term = e.target.value.trim().toLowerCase(); draw(); }, 150);
  const dsel = root.querySelector('#dept'); if (dsel) dsel.onchange = (e) => { dept = e.target.value; draw(); };
  narrow.addEventListener('change', draw);

  bindActions(root, {
    history: async ({ email }) => {
      const u = managedPeople().find(p => p.email === email); if (!u) return;
      const d = u.dayKey || today();
      const b = liveBank(u);
      const row = classifyDay(d, planFor(d, schedules[email] || null, email), { checkInMs: toMs(u.firstOnlineAt), mode: u.workLocation, shift: u.shift, workMs: b.Online, breakMs: b.Break, meetingMs: b.Meeting }, [], today());
      showDayDetails(email, row);
    },
    manage: ({ email }) => {
      const u = managedPeople().find(p => p.email === email); if (!u || !canManage(u)) return;
      const i = info(u);
      const hr = isHR();
      const cur = i.on ? u.status : 'Offline';
      // statuses are switched only on a day that is running today: someone who has not started yet (or is still
      // "running" a previous day) has no today to change — the change would land on the wrong day and not show
      const startedToday = u.dayKey === today() && !!i.fo;
      const why = i.stale ? L(`الموظف ما قفلش يوم ${i.stale} ولسه ما بدأش النهارده — اقفل اليوم ده الأول من الزرار تحت.`, `${i.stale} was never ended and today has not started — close that day first with the button below.`)
        : L('الموظف لسه ما بدأش يومه النهارده — تقدر تغيّر حالته بعد ما يبدأ.', 'This employee has not started today yet — you can change their status once they do.');
      const m = modal({
        title: u.name || email, icon: 'fa-user-gear', size: 'narrow',
        body: `<div class="col gap-8">
          <div class="label">${L('تغيير الحالة يدوياً', 'Force status')}</div>
          ${!startedToday ? `<p class="xs muted">${esc(why)}</p>` : ''}
          <div class="grid g-2" style="gap:8px">${[...COUNTED, 'Offline'].map(k => `<button class="btn btn-sm" data-force="${k}" ${cur === k || !startedToday ? 'disabled' : ''}><i class="fas ${STATUS_META[k].icon}"></i> ${esc(L(STATUS_META[k].ar, STATUS_META[k].en))}</button>`).join('')}</div>
          <div class="divider"></div>
          ${i.stale ? `<button class="btn btn-sm" data-do="close"><i class="fas fa-flag-checkered"></i> ${L(`قفل يوم ${i.stale} على ميعاد الانصراف`, `Close ${i.stale} at planned end time`)}</button>` : ''}
          ${hr ? `<button class="btn btn-sm" data-do="reset"><i class="fas fa-rotate-left"></i> ${L('تصفير العدادات الحالية', 'Reset live counters')}</button>
          <a class="btn btn-sm" href="#/employees/${encodeURIComponent(email)}"><i class="fas fa-id-card"></i> ${L('ملف الموظف', 'Employee file')}</a>` : ''}
        </div>`
      });
      m.$$('[data-force]').forEach(b => b.onclick = async () => {
        try { await changeStatus(email, b.dataset.force); toast(L('تم تغيير الحالة', 'Status changed')); m.close(); } catch (e) { toastErr(e); }
      });
      const c = m.$('[data-do="close"]'); if (c) c.onclick = async () => { try { await closeStaleDay(email, u); toast(L('تم قفل اليوم', 'Day closed')); m.close(); } catch (e) { toastErr(e); } };
      const rs = m.$('[data-do="reset"]'); if (rs) rs.onclick = async () => {
        const ok = await confirmDialog({ title: L('تصفير العدادات', 'Reset counters'), message: L('العدادات الحالية هترجع صفر والحالة «غير متصل». سجل اليوم المحفوظ مش هيتمسح.', 'Live counters go to zero and status to Offline. The archived day is kept.'), okClass: 'btn-danger' });
        if (!ok) return;
        try { await resetLive(email); toast(L('تم التصفير', 'Reset done')); m.close(); } catch (e) { toastErr(e); }
      };
    }
  });

  draw();
  loadSchedules().then(draw);
  const off = onDirectory(draw);
  const iv = setInterval(tick, 1000);
  const iv2 = setInterval(draw, 60000);
  return () => { off(); clearInterval(iv); clearInterval(iv2); narrow.removeEventListener('change', draw); };
}
