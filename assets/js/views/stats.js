// "My stats" — one employee's month at a glance: office and remote days, every late arrival with its time,
// leave by type, attendance and hours, tasks and to-dos, requests, and the change from the previous period.
// An employee sees only their own; an admin can open anyone's (#/stats/<email>), incl. the month's deductions.
import { L, esc, num, fmtHours, fmtMin, fmtTime, fmtDay, money, minutesOfDay, hmToMin, ymd, monthDates, addMonths } from '../core/utils.js';
import { avatar, loader, empty } from '../core/ui.js';
import { session, now, isAdmin } from '../core/session.js';
import { read } from '../core/fb.js';
import { policy, isWorkingPlan, leaveTypeLabel, typeLabel } from '../core/policy.js';
import { personMonth, summarize } from '../services/reports.js';
import { scopeFor } from '../services/attendance.js';
import { person, activePeople, nameOf } from '../services/directory.js';
import { startTasks, onTasks, allTasks, periodRange, inPeriod, doneDay, isLate } from '../services/tasks.js';
import { watchTodos } from '../services/todos.js';
import { salaryParts, rulesOf, violationsFrom, priceViolations, violationText } from '../services/salary.js';
import { periodPicker, monthName } from './task-ui.js';
import { showDayDetails } from './attendance.js';
import { setTabLabel } from '../tabs.js';

const hm = (min) => { const m = Math.round(min); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const avg = (xs) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
const pct = (a, b) => (b > 0 ? Math.round(a / b * 100) : 0);
const planMin = (p) => (p && p.start && p.end ? Math.max(0, hmToMin(p.end) - hmToMin(p.start)) : 8 * 60);
const DOW = () => [L('أحد', 'Sun'), L('اتنين', 'Mon'), L('تلات', 'Tue'), L('أربع', 'Wed'), L('خميس', 'Thu'), L('جمعة', 'Fri'), L('سبت', 'Sat')];

/** every number of one period, from the classified days (+ requests, tasks, to-dos) */
function measure(rows, requests, range, tasks, todos) {
  const t = summarize(rows);
  const att = rows.filter(r => r.rec && r.rec.checkInMs);
  const lates = rows.filter(r => r.late > 0);
  const ins = att.map(r => minutesOfDay(r.rec.checkInMs));
  const outs = att.filter(r => r.rec.closed && r.rec.checkOutMs).map(r => minutesOfDay(r.rec.checkOutMs));
  const worked = t.workMs + t.meetingMs;
  const required = att.filter(r => isWorkingPlan(r.plan)).reduce((s, r) => s + planMin(r.plan) * 60000, 0);
  const due = rows.filter(r => isWorkingPlan(r.plan) && !['future', 'today'].includes(r.status) && !(r.flags || []).includes('untracked')).length;
  const leaves = rows.filter(r => r.status === 'leave');
  const reqs = (requests || []).filter(q => q.startDate && q.startDate >= range.from && q.startDate <= range.to && q.status !== 'cancelled');
  const ts = tasks.filter(k => inPeriod(k, range));
  const done = ts.filter(k => k.status === 'done'), open = ts.filter(k => k.status !== 'done');
  const td = todos.filter(x => x.date >= range.from && x.date <= range.to);
  return {
    t, lates, leaves, due, worked, required, reqs, att,
    avgIn: avg(ins), avgOut: avg(outs),
    perDay: t.present ? worked / t.present : 0,
    breakOver: rows.filter(r => r.breakMs > (Number(policy.breakMaxMinutes) || 60) * 60000).length,
    early: rows.filter(r => r.early > 0), shift10: att.filter(r => r.rec.shift === '10').length,
    remotePending: rows.filter(r => (r.flags || []).includes('remote-pending')).length,
    tasks: { all: ts.length, done: done.length, open: open.length, late: open.filter(isLate).length, onTime: pct(done.filter(k => !k.due || doneDay(k) <= k.due).length, done.length) },
    todo: { all: td.length, done: td.filter(x => x.done).length }
  };
}

export default async function render(root, { params = [] }) {
  startTasks();
  const admin = isAdmin();
  const email = admin && params[0] ? decodeURIComponent(params[0]) : session.email;   // employees: always themselves
  const p = person(email) || { email, name: nameOf(email) };
  setTabLabel(email === session.email ? '' : (p.name || email));
  let month = ymd(now()).slice(0, 7), week = 0, cur = null, prev = null, todos = [], unTodo = null, priv = null;

  root.innerHTML = `<div class="st-page">
    <div class="page-head"><div class="row gap-12">${avatar(p, 'lg')}<div><h2>${email === session.email ? L('إحصائياتي', 'My stats') : esc(p.name || email)}</h2><p>${esc(p.title || '')}${p.department ? ' · ' + esc(p.department) : ''}</p></div></div>
      <div class="row gap-8 wrap">${admin ? `<select class="select" id="who" style="min-width:220px">${activePeople().slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar')).map(x => `<option value="${esc(x.email)}" ${x.email === email ? 'selected' : ''}>${esc(x.name || x.email)}</option>`).join('')}</select>` : ''}<span id="period"></span></div></div>
    <div id="st">${loader()}</div></div>`;
  const $ = (s) => root.querySelector(s);
  if (admin) priv = await read('employees_private', email).catch(() => null);

  async function load() {
    $('#st').innerHTML = loader();
    const scope = scopeFor(email);
    try {
      [cur, prev] = await Promise.all([personMonth(email, month, scope), personMonth(email, addMonths(month, -1), scope).catch(() => null)]);
    } catch (e) { $('#st').innerHTML = `<div class="card">${empty('fa-triangle-exclamation', L('تعذّر تحميل البيانات', 'Could not load data'), esc(e.message || ''))}</div>`; return; }
    if (unTodo) unTodo();
    unTodo = watchTodos(email, [month, addMonths(month, -1)], rows => { todos = rows; draw(); });
    draw();
  }

  function draw() {
    $('#period').innerHTML = periodPicker(month, week, { ahead: 0 });
    if (!cur) return;
    const range = periodRange(month, week);
    const inR = (r, rg) => r.date >= rg.from && r.date <= rg.to;
    const tasks = allTasks().filter(k => k.assignee === email);
    const m = measure(cur.rows.filter(r => inR(r, range)), cur.requests, range, tasks, todos);
    const prng = periodRange(addMonths(month, -1), week);
    // a period still running is compared with the same days of the previous month (1–7 Oct ↔ 1–7 Sep), not the whole month
    const tdy = ymd(now()), running = tdy >= range.from && tdy <= range.to;
    if (running) { const cap = `${prng.from.slice(0, 7)}-${tdy.slice(8)}`; prng.to = cap < prng.from ? prng.from : (cap < prng.to ? cap : prng.to); }
    const pm = prev ? measure(prev.rows.filter(r => inR(r, prng)), prev.requests, prng, tasks, todos) : null;
    const quota = Number(p.remoteQuota ?? policy.defaultRemoteQuota) || 0;
    // ↑/↓ against the previous month (same week when a week is picked); good = the direction that is better
    const delta = (now_, before, good = 'down') => {
      if (!pm || before == null || now_ == null) return '';
      if (Math.round(now_) === Math.round(before)) return `<span class="st-d same">=</span>`;
      const up = now_ > before;
      const ok = (good === 'up') === up;
      const p_ = before ? Math.round(Math.abs(now_ - before) / Math.abs(before) * 100) : null;
      return `<span class="st-d ${ok ? 'ok' : 'bad'}" title="${L('مقارنة بالفترة اللي قبلها', 'vs the previous period')}"><i class="fas fa-arrow-${up ? 'up' : 'down'}"></i>${p_ === null ? '' : `${p_}%`}</span>`;
    };
    const tile = (icon, cls, label, value, hint, d = '') => `<div class="card stat st-tile"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}${d}</div><div class="value">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
    const leaveTypes = Object.entries(m.t.leaveByType || {});
    const t = m.t;

    // the month, day by day
    const byDate = Object.fromEntries(cur.rows.map(r => [r.date, r]));
    const days = monthDates(month);
    const lead = new Date(`${days[0]}T00:00:00Z`).getUTCDay();
    const cls = (r) => !r ? '' : r.status === 'present' ? (r.late ? 'lt' : 'of') : r.status === 'remote' ? (r.late ? 'lt' : 're') : r.status === 'absent' ? 'ab' : r.status === 'leave' ? 'lv' : (r.status === 'off' || r.status === 'holiday') ? 'off' : '';
    const cal = `<div class="st-cal">${DOW().map(d => `<div class="st-dow">${d}</div>`).join('')}${'<div></div>'.repeat(lead)}${days.map(d => { const r = byDate[d]; return `<button class="st-day ${cls(r)} ${inR({ date: d }, range) ? '' : 'dim'} ${d === ymd(now()) ? 'today' : ''}" data-day="${d}" title="${esc(fmtDay(d))}">${Number(d.slice(8))}</button>`; }).join('')}</div>
      <div class="st-leg"><span><i class="of"></i>${L('مقر', 'Office')}</span><span><i class="re"></i>${L('أونلاين', 'Remote')}</span><span><i class="lt"></i>${L('تأخير', 'Late')}</span><span><i class="lv"></i>${L('إجازة', 'Leave')}</span><span><i class="ab"></i>${L('غياب', 'Absent')}</span><span><i class="off"></i>${L('راحة / عطلة', 'Off')}</span></div>`;
    // hours per day
    const daysW = m.att.filter(r => r.status === 'present' || r.status === 'remote');
    const maxW = Math.max(1, ...daysW.map(r => r.workMs + r.meetingMs), ...daysW.map(r => planMin(r.plan) * 60000));
    const bars = daysW.length ? `<div class="st-bars">${daysW.map(r => { const w = r.workMs + r.meetingMs; const need = planMin(r.plan) * 60000; return `<div class="st-bar ${w >= need ? 'ok' : 'low'}" title="${esc(fmtDay(r.date))}: ${esc(fmtHours(w))}"><span style="height:${Math.max(4, Math.round(w / maxW * 100))}%"></span><small>${Number(r.date.slice(8))}</small></div>`; }).join('')}</div>` : empty('fa-chart-column', L('مفيش أيام شغل في الفترة دي', 'No working days in this period'));
    const mix = t.workMs + t.meetingMs + t.breakMs;
    const reqByType = {};
    m.reqs.forEach(q => { const x = reqByType[q.type] = reqByType[q.type] || { all: 0, ok: 0, no: 0, wait: 0 }; x.all++; if (q.status === 'approved') x.ok++; else if (q.status === 'rejected') x.no++; else x.wait++; });
    let ded = '';
    if (admin && priv) {
      const parts = salaryParts(priv);
      if (parts.structured) {
        const priced = priceViolations(violationsFrom(cur.rows.filter(r => inR(r, range)), cur.requests), parts, rulesOf(priv));
        const total = priced.lines.reduce((s, l) => s + l.total, 0);
        ded = `<section class="card"><div class="card-head"><h3><i class="fas fa-money-bill-wave" style="color:var(--bad)"></i> ${L('الخصومات لحد دلوقتي', 'Deductions so far')} <span class="badge">${L('للأدمن بس', 'Admins only')}</span></h3><b class="num" style="color:${total ? 'var(--bad)' : 'var(--ok)'}">${esc(money(total))}</b></div>
          ${priced.lines.length ? `<div class="table-wrap"><table class="table"><tbody>${priced.lines.map(l => `<tr><td class="num nowrap">${esc(fmtDay(l.date))}</td><td>${esc(violationText(l))}</td><td class="num" style="color:var(--bad)">−${esc(money(l.total, false))}</td></tr>`).join('')}</tbody></table></div>` : `<div class="card-body">${empty('fa-face-smile', L('مفيش خصومات 👏', 'No deductions 👏'))}</div>`}</section>`;
      }
    }

    $('#st').innerHTML = `
      <div class="grid g-4 keep-2 mb-16">
        ${tile('fa-building', 'ok', L('أيام المقر', 'Office days'), num(t.office), L(`من ${m.due} يوم مطلوب`, `of ${m.due} working days`), delta(t.office, pm && pm.t.office, 'up'))}
        ${tile('fa-house-laptop', 'brand', L('أيام الأونلاين', 'Remote days'), num(t.remote), `${L(`الحصة ${quota} في الشهر`, `quota ${quota} a month`)}${m.remotePending ? ` · <span class="bad-txt">${L(`${m.remotePending} مستني موافقة`, `${m.remotePending} pending`)}</span>` : ''}`, delta(t.remote, pm && pm.t.remote, 'down'))}
        ${tile('fa-clock', 'warn', L('أيام التأخير', 'Late days'), `<span class="${t.lateDays ? 'bad-txt' : ''}">${num(t.lateDays)}</span>`, t.lateMinutes ? L(`إجمالي ${fmtMin(t.lateMinutes)}`, `${fmtMin(t.lateMinutes)} in total`) : L('مفيش تأخير 👌', 'Never late 👌'), delta(t.lateMinutes, pm && pm.t.lateMinutes, 'down'))}
        ${tile('fa-umbrella-beach', 'info', L('الإجازات', 'Leave'), num(t.leave), leaveTypes.length ? leaveTypes.map(([k, n]) => `${esc(leaveTypeLabel(k))} ${n}`).join(' · ') : L('مخدش إجازات', 'No leave taken'))}
        ${tile('fa-user-check', t.absent ? 'bad' : 'ok', L('الالتزام', 'Commitment'), `${t.commitment}<small>%</small>`, L(`غياب ${t.absent} يوم`, `${t.absent} days absent`), delta(t.commitment, pm && pm.t.commitment, 'up'))}
        ${tile('fa-right-to-bracket', '', L('متوسط الحضور', 'Average check-in'), m.avgIn == null ? '—' : `<span class="num">${hm(m.avgIn)}</span>`, m.avgOut == null ? '' : L(`متوسط الانصراف ${hm(m.avgOut)}`, `average check-out ${hm(m.avgOut)}`), delta(m.avgIn, pm && pm.avgIn, 'down'))}
        ${tile('fa-business-time', 'info', L('ساعات العمل الفعلية', 'Actual work hours'), esc(fmtHours(m.worked)), `${L(`متوسط ${fmtHours(m.perDay)} / يوم`, `${fmtHours(m.perDay)} / day`)}${m.required ? ` · ${pct(m.worked, m.required)}% ${L('من المطلوب', 'of required')}` : ''}`, delta(m.perDay, pm && pm.perDay, 'up'))}
        ${tile('fa-clipboard-check', 'ok', L('التاسكات', 'Tasks'), `${m.tasks.done}<small>/${m.tasks.all}</small>`, `${m.tasks.done ? L(`في الميعاد ${m.tasks.onTime}%`, `on time ${m.tasks.onTime}%`) : L('لسه مفيش منجز', 'none finished yet')}${m.tasks.late ? ` · <span class="bad-txt">${L(`${m.tasks.late} متأخر`, `${m.tasks.late} late`)}</span>` : ''}`, delta(m.tasks.done, pm && pm.tasks.done, 'up'))}
      </div>
      <div class="st-grid mb-16">
        <section class="card"><div class="card-head"><h3><i class="fas fa-clock" style="color:var(--warn)"></i> ${L('التأخيرات بمواعيدها', 'Late arrivals')}</h3><span class="num muted">${m.lates.length}</span></div>
          ${m.lates.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>${L('اليوم', 'Day')}</th><th class="num">${L('الميعاد', 'Start')}</th><th class="num">${L('الحضور', 'Check-in')}</th><th class="num">${L('التأخير', 'Late')}</th><th></th></tr></thead><tbody>
            ${m.lates.map(r => `<tr data-day="${r.date}" style="cursor:pointer"><td>${esc(fmtDay(r.date))}</td><td class="num muted">${esc(r.plan.start || policy.workStart)}</td><td class="num"><b>${esc(fmtTime(r.rec.checkInMs))}</b></td><td class="num bad-txt">${esc(fmtMin(r.late))}</td><td>${r.rec.shift === '10' ? `<span class="badge info">${L('شيفت 10', '10:00 shift')}</span>` : ''}${r.status === 'remote' ? `<span class="badge brand">${L('أونلاين', 'Remote')}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`
            : `<div class="card-body">${empty('fa-face-smile', L('مفيش ولا تأخير في الفترة دي 👏', 'Not late once in this period 👏'))}</div>`}</section>
        <section class="card"><div class="card-head"><h3><i class="fas fa-calendar-days"></i> ${monthName(month)}</h3></div><div class="card-body">${cal}</div></section>
      </div>
      <div class="st-grid mb-16">
        <section class="card"><div class="card-head"><h3><i class="fas fa-chart-column"></i> ${L('ساعات كل يوم (شغل + اجتماعات)', 'Hours per day (work + meetings)')}</h3><span class="xs muted">${L('أخضر = كمّل ساعاته', 'green = full hours')}</span></div><div class="card-body">${bars}</div></section>
        <section class="card"><div class="card-head"><h3><i class="fas fa-chart-pie"></i> ${L('شكل اليوم', 'How the day went')}</h3></div><div class="card-body">
          ${mix ? `<div class="st-mix"><span class="w" style="width:${pct(t.workMs, mix)}%"></span><span class="m" style="width:${pct(t.meetingMs, mix)}%"></span><span class="b" style="width:${pct(t.breakMs, mix)}%"></span></div>
          <div class="st-leg mb-8"><span><i class="w"></i>${L('شغل', 'Work')} ${pct(t.workMs, mix)}%</span><span><i class="m"></i>${L('اجتماعات', 'Meetings')} ${pct(t.meetingMs, mix)}%</span><span><i class="b"></i>${L('استراحة', 'Breaks')} ${pct(t.breakMs, mix)}%</span></div>` : ''}
          <div class="st-facts">
            <div><span>${L('استراحة زيادة عن المسموح', 'Break over the limit')}</span><b class="${m.breakOver ? 'bad-txt' : ''}">${L(`${m.breakOver} يوم`, `${m.breakOver} days`)}</b></div>
            <div><span>${L('انصراف بدري', 'Left early')}</span><b class="${m.early.length ? 'bad-txt' : ''}">${m.early.length ? L(`${m.early.length} يوم · ${fmtMin(m.early.reduce((s, r) => s + r.early, 0))}`, `${m.early.length} days · ${fmtMin(m.early.reduce((s, r) => s + r.early, 0))}`) : '—'}</b></div>
            <div><span>${L('نسي يقفل اليوم', 'Forgot to end the day')}</span><b class="${t.forgot ? 'bad-txt' : ''}">${t.forgot || '—'}</b></div>
            <div><span>${L('أيام شيفت 10', '10:00-shift days')}</span><b>${m.shift10 || '—'}</b></div>
            <div><span>To-Do</span><b>${m.todo.all ? `${pct(m.todo.done, m.todo.all)}% <small class="muted">(${m.todo.done}/${m.todo.all})</small>` : '—'}</b></div>
          </div></div></section>
      </div>
      <div class="st-grid mb-16">
        <section class="card"><div class="card-head"><h3><i class="fas fa-umbrella-beach"></i> ${L('أيام الإجازات', 'Leave days')}</h3><span class="num muted">${m.leaves.length}</span></div>
          ${m.leaves.length ? `<div class="table-wrap"><table class="table"><tbody>${m.leaves.map(r => `<tr><td>${esc(fmtDay(r.date))}</td><td><span class="badge warn">${esc(leaveTypeLabel((r.plan && r.plan.leaveType) || (r.rec && r.rec.leaveType) || 'annual'))}</span></td></tr>`).join('')}</tbody></table></div>` : `<div class="card-body">${empty('fa-mug-hot', L('مفيش إجازات في الفترة دي', 'No leave in this period'))}</div>`}</section>
        <section class="card"><div class="card-head"><h3><i class="fas fa-paper-plane"></i> ${L('الطلبات', 'Requests')}</h3><span class="num muted">${m.reqs.length}</span></div>
          ${m.reqs.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>${L('النوع', 'Type')}</th><th class="num">${L('اتقبل', 'Approved')}</th><th class="num">${L('اترفض', 'Rejected')}</th><th class="num">${L('مستني', 'Pending')}</th></tr></thead><tbody>${Object.entries(reqByType).map(([k, x]) => `<tr><td>${esc(typeLabel(k))} <small class="muted">(${x.all})</small></td><td class="num ok-txt">${x.ok || '—'}</td><td class="num ${x.no ? 'bad-txt' : ''}">${x.no || '—'}</td><td class="num">${x.wait || '—'}</td></tr>`).join('')}</tbody></table></div>` : `<div class="card-body">${empty('fa-paper-plane', L('مفيش طلبات في الفترة دي', 'No requests in this period'))}</div>`}</section>
      </div>
      ${ded}
      ${pm ? `<p class="xs muted mt-8"><i class="fas fa-arrows-up-down"></i> ${L(`الأسهم مقارنة بنفس الفترة من ${monthName(addMonths(month, -1))}${(() => { const r = periodRange(month, week), t = ymd(now()); return t >= r.from && t <= r.to ? ` (لحد يوم ${Number(t.slice(8))})` : ''; })()}`, `Arrows compare with the same period of ${monthName(addMonths(month, -1))}`)}</p>` : ''}`;
  }

  root.addEventListener('change', (e) => {
    if (e.target.id === 'who') location.hash = `#/stats/${encodeURIComponent(e.target.value)}`;
    if (e.target.matches('[data-pp-month]')) { month = e.target.value; week = 0; load(); }
  });
  root.addEventListener('click', (e) => {
    const w = e.target.closest('[data-pp-week]'); if (w) { week = Number(w.dataset.ppWeek); draw(); return; }
    const d = e.target.closest('[data-day]');
    if (d && cur) { const r = cur.rows.find(x => x.date === d.dataset.day); if (r) showDayDetails(email, r, { canRequest: email === session.email }); }
  });
  const off = onTasks(() => draw());
  await load();
  return () => { off(); if (unTodo) unTodo(); };
}
