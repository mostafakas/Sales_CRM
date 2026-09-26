// Live monitor: a real-time board of who is working, on a break, in a meeting, finished, not started, or away.
import { L, esc, fmtDur, fmtTime, fmtMin, fmtHours, num, debounce, hmToMin, ymd } from '../core/utils.js';
import { toast, toastErr, avatar, STATUS_META, empty, confirmDialog, bindActions, modal } from '../core/ui.js';
import { session, now, isHR, seesAll } from '../core/session.js';
import { dayKey, planFor, lateness, modeLabel, roleLabel, isWorkingPlan, policy, leaveType } from '../core/policy.js';
import { toMs, list, query, col, where } from '../core/fb.js';
import { onDirectory, managedPeople, departments } from '../services/directory.js';
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
    const plan = planFor(t, schedules[u.email] || null);
    const on = isToday && u.status && u.status !== 'Offline';
    const fo = isToday ? toMs(u.firstOnlineAt) : null;
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
    i.late ? `<span class="badge bad">${L('تأخير', 'Late')} ${esc(fmtMin(i.late))}</span>` : '',
    i.pending ? `<span class="badge warn"><i class="fas fa-circle-exclamation"></i>${L('أونلاين بدون موافقة', 'Remote not approved')}</span>` : '',
    i.stale ? `<span class="badge bad"><i class="fas fa-triangle-exclamation"></i>${L('يوم مفتوح', 'Open day')} <span class="num">${esc(i.stale)}</span></span>` : ''
  ].join('');
  const where_ = (u, i) => {
    if (!(i.on || i.state === 'ended')) return '<span class="faint">—</span>';
    return `<span class="loc ${i.remote ? 'remote' : ''}"><i class="fas ${i.remote ? 'fa-house-laptop' : 'fa-building'}"></i>${esc(modeLabel(u.workLocation || 'office'))}</span>`;
  };
  const progress = (u, i) => {
    const pct = Math.min(100, Math.round((i.bank.Online / (i.target || 1)) * 100));
    return `<div class="mon-work"><div class="row between"><b class="num" data-live="${esc(u.email)}|Online">${fmtDur(i.bank.Online)}</b><small class="faint num">${esc(fmtHours(i.target))}</small></div>
      <div class="progress ${pct >= 100 ? 'ok' : ''}"><span data-prog="${esc(u.email)}" style="width:${pct}%"></span></div></div>`;
  };
  const actions = (u) => `<div class="row gap-4 mon-actions">
      <button class="btn btn-sm btn-ghost btn-icon" data-action="history" data-email="${esc(u.email)}" title="${L('سجل النهارده', "Today's log")}" aria-label="${L('سجل النهارده', "Today's log")}"><i class="fas fa-clock-rotate-left"></i></button>
      ${isHR() ? `<button class="btn btn-sm btn-ghost btn-icon" data-action="manage" data-email="${esc(u.email)}" title="${L('إدارة', 'Manage')}" aria-label="${L('إدارة', 'Manage')}"><i class="fas fa-ellipsis-vertical"></i></button>` : ''}
    </div>`;
  const who = (u, i) => `<div class="person"><span class="avatar-wrap">${avatar(u, 'sm')}<span class="status-dot" style="background:${STATES[i.state].color}"></span></span>
      <div class="min0"><b class="truncate">${esc(u.name || u.email)}</b><span class="truncate">${esc(u.title || roleLabel(u.role))}${u.department && seesAll() ? ` · ${esc(u.department)}` : ''}</span></div></div>`;

  function tableHTML(rows, infos) {
    return `<div class="card"><div class="table-wrap"><table class="table mon-table"><thead><tr>
        <th>${L('الموظف', 'Employee')}</th><th>${L('الحالة', 'Status')}</th><th>${L('المكان', 'Location')}</th><th>${L('الحضور', 'Check-in')}</th>
        <th style="min-width:180px">${L('وقت الشغل النهارده', 'Worked today')}</th><th>${L('استراحة / اجتماع', 'Break / meeting')}</th><th></th>
      </tr></thead><tbody>${rows.map(u => {
        const i = infos.get(u.email);
        return `<tr class="${i.on ? '' : 'idle'}" data-email="${esc(u.email)}">
          <td>${who(u, i)}${flags(i) ? `<div class="row-wrap gap-4 mt-8">${flags(i)}</div>` : ''}</td>
          <td class="mon-status">${statusCell(u, i)}</td>
          <td>${where_(u, i)}</td>
          <td class="num">${i.fo ? esc(fmtTime(i.fo)) : '<span class="faint">—</span>'}</td>
          <td>${i.fo ? progress(u, i) : '<span class="faint">—</span>'}</td>
          <td>${i.fo ? `<div class="num mon-sub"><span title="${L('استراحة', 'Break')}"><i class="fas fa-mug-hot"></i><span data-live="${esc(u.email)}|Break">${fmtDur(i.bank.Break)}</span></span><span title="${L('اجتماع', 'Meeting')}"><i class="fas fa-users"></i><span data-live="${esc(u.email)}|Meeting">${fmtDur(i.bank.Meeting)}</span></span></div>` : '<span class="faint">—</span>'}</td>
          <td style="text-align:end">${actions(u)}</td></tr>`;
      }).join('')}</tbody></table></div></div>`;
  }
  function cardsHTML(rows, infos) {
    return `<div class="mon-cards">${rows.map(u => {
      const i = infos.get(u.email);
      return `<article class="card mon-card ${i.on ? '' : 'idle'}" style="--st:${STATES[i.state].color}">
        <div class="row gap-8">${who(u, i)}<span class="grow"></span>${actions(u)}</div>
        <div class="row between gap-8 mon-card-status"><div class="mon-status">${statusCell(u, i)}</div>${where_(u, i)}</div>
        ${i.fo ? progress(u, i) : ''}
        <div class="row between xs muted">
          <span>${i.fo ? `<i class="fas fa-right-to-bracket"></i> <span class="num">${esc(fmtTime(i.fo))}</span>` : L('لسه ما سجّلش حضور', 'Not checked in yet')}</span>
          ${i.fo ? `<span class="num mon-sub"><span><i class="fas fa-mug-hot"></i><span data-live="${esc(u.email)}|Break">${fmtDur(i.bank.Break)}</span></span><span><i class="fas fa-users"></i><span data-live="${esc(u.email)}|Meeting">${fmtDur(i.bank.Meeting)}</span></span></span>` : ''}
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
      root.querySelectorAll(`[data-live^="${CSS.escape(u.email)}|"]`).forEach(el => { el.textContent = fmtDur(bank[el.dataset.live.split('|')[1]]); });
      const bar = root.querySelector(`[data-prog="${CSS.escape(u.email)}"]`);
      if (bar) bar.style.width = Math.min(100, Math.round((bank.Online / planMs(planFor(t, schedules[u.email] || null))) * 100)) + '%';
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
      const row = classifyDay(d, planFor(d, schedules[email] || null), { checkInMs: toMs(u.firstOnlineAt), mode: u.workLocation, workMs: b.Online, breakMs: b.Break, meetingMs: b.Meeting }, [], today());
      showDayDetails(email, row);
    },
    manage: ({ email }) => {
      const u = managedPeople().find(p => p.email === email); if (!u) return;
      const i = info(u);
      const cur = i.on ? u.status : 'Offline';
      const m = modal({
        title: u.name || email, icon: 'fa-user-gear', size: 'narrow',
        body: `<div class="col gap-8">
          <div class="label">${L('تغيير الحالة يدوياً', 'Force status')}</div>
          <div class="grid g-2" style="gap:8px">${[...COUNTED, 'Offline'].map(k => `<button class="btn btn-sm" data-force="${k}" ${cur === k ? 'disabled' : ''}><i class="fas ${STATUS_META[k].icon}"></i> ${esc(L(STATUS_META[k].ar, STATUS_META[k].en))}</button>`).join('')}</div>
          <div class="divider"></div>
          ${i.stale ? `<button class="btn btn-sm" data-do="close"><i class="fas fa-flag-checkered"></i> ${L(`قفل يوم ${i.stale} على ميعاد الانصراف`, `Close ${i.stale} at planned end time`)}</button>` : ''}
          <button class="btn btn-sm" data-do="reset"><i class="fas fa-rotate-left"></i> ${L('تصفير العدادات الحالية', 'Reset live counters')}</button>
          <a class="btn btn-sm" href="#/employees/${encodeURIComponent(email)}"><i class="fas fa-id-card"></i> ${L('ملف الموظف', 'Employee file')}</a>
        </div>`
      });
      m.$$('[data-force]').forEach(b => b.onclick = async () => {
        try { await changeStatus(email, b.dataset.force); toast(L('تم تغيير الحالة', 'Status changed')); m.close(); } catch (e) { toastErr(e); }
      });
      const c = m.$('[data-do="close"]'); if (c) c.onclick = async () => { try { await closeStaleDay(email, u); toast(L('تم قفل اليوم', 'Day closed')); m.close(); } catch (e) { toastErr(e); } };
      m.$('[data-do="reset"]').onclick = async () => {
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
