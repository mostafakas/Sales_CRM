// Live monitor: who is working, on break, in a meeting, remote, late or forgot to end the day.
import { L, esc, fmtDur, fmtTime, fmtMin, num, debounce } from '../core/utils.js';
import { toast, toastErr, avatar, presenceBadge, STATUS_META, empty, confirmDialog, bindActions, modal } from '../core/ui.js';
import { session, now, isHR } from '../core/session.js';
import { dayKey, planFor, lateness, modeLabel, roleLabel } from '../core/policy.js';
import { toMs } from '../core/fb.js';
import { onDirectory, managedPeople, departments } from '../services/directory.js';
import { liveBank, staleDay, closeStaleDay, changeStatus, resetLive, COUNTED } from '../services/attendance.js';
import { showDayDetails } from './attendance.js';
import { classifyDay } from '../services/reports.js';

export default async function render(root) {
  let filter = 'all', term = '', dept = '';
  root.innerHTML = `
    <div class="page-head"><div><h2>${L('المتابعة اللحظية', 'Live monitor')}</h2><p>${isHR() ? L('كل الموظفين دلوقتي.', 'Everyone, right now.') : L('فريقك دلوقتي.', 'Your team, right now.')}</p></div></div>
    <div class="grid g-4 keep-2 mb-16" id="kpis"></div>
    <div class="filters">
      <div class="tabs" id="ftabs">
        ${[['all', L('الكل', 'All')], ['Online', L('يعمل', 'Working')], ['Break', L('استراحة', 'Break')], ['Meeting', L('اجتماع', 'Meeting')], ['Offline', L('غير متصل', 'Offline')], ['remote', L('أونلاين', 'Remote')], ['late', L('متأخر', 'Late')], ['issues', L('محتاج مراجعة', 'Needs review')]]
          .map(([k, t]) => `<button class="tab ${k === 'all' ? 'active' : ''}" data-f="${k}">${esc(t)} <span class="num" data-n="${k}"></span></button>`).join('')}
      </div>
      ${isHR() ? `<select class="select" id="dept"><option value="">${L('كل الأقسام', 'All departments')}</option>${departments().map(d => `<option>${esc(d)}</option>`).join('')}</select>` : ''}
      <div class="search grow" style="max-width:280px"><i class="fas fa-search"></i><input class="input" id="q" placeholder="${L('بحث بالاسم', 'Search by name')}"></div>
    </div>
    <div class="grid g-auto" id="cards"></div>`;

  const today = () => dayKey(now());
  const info = (u) => {
    const on = u.dayKey === today() && u.status && u.status !== 'Offline';
    const fo = u.dayKey === today() ? toMs(u.firstOnlineAt) : null;
    const late = fo ? lateness(fo, planFor(today(), null)).late : 0;
    const stale = staleDay(u);
    return { on, fo, late, stale, remote: u.dayKey === today() && u.workLocation === 'remote', status: on ? u.status : 'Offline' };
  };
  const matches = (u, i) => {
    if (term && !(`${u.name} ${u.email} ${u.title}`.toLowerCase().includes(term))) return false;
    if (dept && u.department !== dept) return false;
    if (filter === 'all') return true;
    if (COUNTED.includes(filter) || filter === 'Offline') return i.status === filter;
    if (filter === 'remote') return i.remote && i.on;
    if (filter === 'late') return i.late > 0;
    if (filter === 'issues') return !!i.stale || !!u.remotePending;
    return true;
  };

  function draw() {
    const people = managedPeople().filter(p => (p.email !== session.email || isHR()) && p.trackAttendance !== false);
    const infos = new Map(people.map(p => [p.email, info(p)]));
    const count = (f) => people.filter(p => { const i = infos.get(p.email); const keep = filter; filter = f; const r = matches(p, i); filter = keep; return r; }).length;
    root.querySelectorAll('[data-n]').forEach(el => { const n = count(el.dataset.n); el.textContent = n ? `(${num(n)})` : ''; });
    const k = (icon, cls, label, v) => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value">${num(v)}<small>/ ${num(people.length)}</small></div></div>`;
    const on = people.filter(p => infos.get(p.email).on).length;
    root.querySelector('#kpis').innerHTML =
      k('fa-laptop-code', 'ok', L('شغالين دلوقتي', 'Working now'), on) +
      k('fa-house-laptop', '', L('أونلاين', 'Remote'), people.filter(p => { const i = infos.get(p.email); return i.on && i.remote; }).length) +
      k('fa-clock', 'warn', L('متأخرين النهارده', 'Late today'), people.filter(p => infos.get(p.email).late > 0).length) +
      k('fa-triangle-exclamation', 'bad', L('محتاجين مراجعة', 'Need review'), people.filter(p => infos.get(p.email).stale || p.remotePending).length);
    const list = people.filter(p => matches(p, infos.get(p.email)));
    const el = root.querySelector('#cards');
    if (!list.length) { el.innerHTML = `<div class="card" style="grid-column:1/-1">${empty('fa-users-slash', L('مفيش حد هنا', 'Nobody here'), isHR() ? '' : L('لو فريقك فاضي، اطلب من HR يربط الموظفين بيك.', 'If your team is empty, ask HR to assign members to you.'))}</div>`; return; }
    el.innerHTML = list.map(u => {
      const i = infos.get(u.email);
      const bank = u.dayKey === today() ? liveBank(u) : { Online: 0, Break: 0, Meeting: 0 };
      const meta = STATUS_META[i.status];
      return `<article class="card person-card" data-email="${esc(u.email)}">
        <div class="top"><span class="avatar-wrap">${avatar(u)}<span class="status-dot" style="background:${meta.color}"></span></span>
          <div class="grow"><b class="truncate">${esc(u.name || u.email)}</b><span class="truncate" style="display:block">${esc(u.title || roleLabel(u.role))}</span></div>
          ${presenceBadge(i.status)}</div>
        <div class="row-wrap gap-4">
          ${u.dayKey === today() && u.workLocation ? `<span class="badge brand"><i class="fas ${u.workLocation === 'remote' ? 'fa-house-laptop' : 'fa-building'}"></i>${esc(modeLabel(u.workLocation))}</span>` : ''}
          ${i.fo ? `<span class="badge"><i class="fas fa-right-to-bracket"></i><span class="num">${esc(fmtTime(i.fo))}</span></span>` : `<span class="badge">${L('ما بدأش النهارده', 'Not started today')}</span>`}
          ${i.late ? `<span class="badge bad">${L('تأخير', 'Late')} ${esc(fmtMin(i.late))}</span>` : ''}
          ${u.remotePending && u.dayKey === today() ? `<span class="badge warn">${L('أونلاين بدون موافقة', 'Remote unapproved')}</span>` : ''}
          ${i.stale ? `<span class="badge bad"><i class="fas fa-triangle-exclamation"></i>${L('ما قفلش يوم', 'Day not ended')} ${esc(i.stale)}</span>` : ''}
        </div>
        <div class="mini-stats">${COUNTED.map(k => `<div><b data-live="${esc(u.email)}|${k}">${fmtDur(bank[k])}</b><span>${esc(L(STATUS_META[k].ar, STATUS_META[k].en))}</span></div>`).join('')}</div>
        <div class="row gap-8">
          <button class="btn btn-sm grow" data-action="history" data-email="${esc(u.email)}"><i class="fas fa-clock-rotate-left"></i> ${L('سجل النهارده', "Today's log")}</button>
          ${isHR() ? `<button class="btn btn-sm btn-icon" data-action="manage" data-email="${esc(u.email)}" aria-label="${L('إدارة', 'Manage')}"><i class="fas fa-ellipsis"></i></button>` : ''}
        </div>
      </article>`;
    }).join('');
  }
  function tickTimers() {
    const t = today();
    managedPeople().forEach(u => {
      if (u.dayKey !== t || !u.status || u.status === 'Offline') return;
      const bank = liveBank(u);
      root.querySelectorAll(`[data-live^="${CSS.escape(u.email)}|"]`).forEach(el => { el.textContent = fmtDur(bank[el.dataset.live.split('|')[1]]); });
    });
  }
  root.querySelectorAll('#ftabs .tab').forEach(b => b.onclick = () => { filter = b.dataset.f; root.querySelectorAll('#ftabs .tab').forEach(x => x.classList.toggle('active', x === b)); draw(); });
  root.querySelector('#q').oninput = debounce((e) => { term = e.target.value.trim().toLowerCase(); draw(); }, 150);
  const dsel = root.querySelector('#dept'); if (dsel) dsel.onchange = (e) => { dept = e.target.value; draw(); };

  bindActions(root, {
    history: async ({ email }) => {
      const u = managedPeople().find(p => p.email === email); if (!u) return;
      const d = u.dayKey || today();
      const row = classifyDay(d, planFor(d, null), { checkInMs: toMs(u.firstOnlineAt), mode: u.workLocation, workMs: liveBank(u).Online, breakMs: liveBank(u).Break, meetingMs: liveBank(u).Meeting }, [], today());
      showDayDetails(email, row);
    },
    manage: ({ email }) => {
      const u = managedPeople().find(p => p.email === email); if (!u) return;
      const i = info(u);
      const m = modal({
        title: u.name, icon: 'fa-user-gear', size: 'narrow',
        body: `<div class="col gap-8">
          <div class="label">${L('تغيير الحالة يدوياً', 'Force status')}</div>
          <div class="grid g-2" style="gap:8px">${[...COUNTED, 'Offline'].map(k => `<button class="btn btn-sm" data-force="${k}" ${i.status === k ? 'disabled' : ''}>${esc(L(STATUS_META[k].ar, STATUS_META[k].en))}</button>`).join('')}</div>
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
  const off = onDirectory(draw);
  const iv = setInterval(tickTimers, 1000);
  const iv2 = setInterval(draw, 60000);
  return () => { off(); clearInterval(iv); clearInterval(iv2); };
}
