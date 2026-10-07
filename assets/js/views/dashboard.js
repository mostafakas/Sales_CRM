// Dashboard (admin & HR for everyone; a leader the admin allowed sees their own team): one month at a glance —
// attendance commitment, absences, lateness, actual work hours, by department and by person, plus task delivery.
import { L, esc, num, fmtHours, fmtMin, ymd } from '../core/utils.js';
import { avatar, loader, empty } from '../core/ui.js';
import { session, now, isHR, isAdmin } from '../core/session.js';
import { toMs } from '../core/fb.js';
import { teamMonth, summarize } from '../services/reports.js';
import { nameOf, person } from '../services/directory.js';
import { startTasks, onTasks, allTasks, doneDay, periodRange, inPeriod } from '../services/tasks.js';
import { periodPicker } from './task-ui.js';
import { watchMonth } from '../services/todos.js';

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const avgHours = (t) => (t.present ? (t.workMs + t.meetingMs) / t.present : 0);

/** task delivery for a set of tasks in a period (by due date; tasks without one count in every period) */
function taskStats(ts, range) {
  const today = ymd(now());
  const rel = ts.filter(t => inPeriod(t, range));
  const done = rel.filter(t => t.status === 'done');
  const onTime = done.filter(t => !t.due || doneDay(t) <= t.due).length;
  const lateOpen = rel.filter(t => t.status !== 'done' && t.due && t.due < today).length;
  const open = rel.filter(t => t.status !== 'done').length;
  return { total: rel.length, done: done.length, onTime, lateOpen, open, rate: pct(done.length, done.length + open), onTimeRate: pct(onTime, done.length) };
}

export default async function render(root) {
  startTasks();
  let ym = ymd(now()).slice(0, 7), week = 0, dept = '', data = null, sortBy = 'late', todos = [], unTodo = null;
  const watchTodo = () => { if (unTodo) unTodo(); unTodo = watchMonth(ym, rows => { todos = rows; draw(); }); };
  const scopeAll = isAdmin() || isHR();
  root.innerHTML = `<div class="page-head"><div><h2>${L('الداشبورد', 'Dashboard')}</h2><p>${scopeAll ? L('الشركة كلها', 'The whole company') : L('فريقك', 'Your team')}</p></div>
      <div class="row gap-8 wrap"><select class="select" id="dept" style="min-width:160px"></select><span id="period"></span></div></div>
    <div id="dash">${loader()}</div>`;
  const $ = (s) => root.querySelector(s);

  async function load() {
    $('#dash').innerHTML = loader();
    try { data = await teamMonth(ym); } catch (e) { $('#dash').innerHTML = `<div class="card">${empty('fa-triangle-exclamation', L('تعذّر تحميل البيانات', 'Could not load data'), esc(e.message || ''))}</div>`; return; }
    const depts = [...new Set(data.people.map(x => x.person.department || L('بدون قسم', 'No department')))].sort((a, b) => a.localeCompare(b, 'ar'));
    $('#dept').innerHTML = `<option value="">${L('كل الأقسام', 'All departments')}</option>${depts.map(d => `<option ${d === dept ? 'selected' : ''}>${esc(d)}</option>`).join('')}`;
    draw();
  }

  function draw() {
    $('#period').innerHTML = periodPicker(ym, week, { ahead: 0 });
    if (!data) return;
    const range = periodRange(ym, week);
    const rows = data.people.filter(x => !dept || (x.person.department || L('بدون قسم', 'No department')) === dept);
    if (!rows.length) { $('#dash').innerHTML = `<div class="card">${empty('fa-users', L('مفيش موظفين', 'No employees'))}</div>`; return; }
    const tasks = allTasks();
    const per = rows.map(x => {
      const t = week ? summarize(x.rows.filter(r => r.date >= range.from && r.date <= range.to)) : x.totals;   // attendance of that week only
      const td = todos.filter(k => k.owner === x.person.email && k.date >= range.from && k.date <= range.to);
      return { p: x.person, t, hrs: avgHours(t), tk: taskStats(tasks.filter(k => k.assignee === x.person.email), range), td: td.length ? Math.round(td.filter(k => k.done).length / td.length * 100) : null, tdN: td.length };
    });
    const sum = (f) => per.reduce((s, x) => s + f(x), 0);
    const present = sum(x => x.t.present), absent = sum(x => x.t.absent), lateDays = sum(x => x.t.lateDays), lateMin = sum(x => x.t.lateMinutes);
    const commit = Math.round(sum(x => x.t.commitment) / per.length);
    const hrs = present ? sum(x => x.t.workMs + x.t.meetingMs) / present : 0;
    const allTk = taskStats(tasks.filter(k => per.some(x => x.p.email === k.assignee)), range);
    const tile = (icon, cls, label, value, hint = '') => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;

    // by department
    const byDept = {};
    per.forEach(x => { const d = x.p.department || L('بدون قسم', 'No department'); (byDept[d] = byDept[d] || []).push(x); });
    const deptRows = Object.entries(byDept).map(([d, xs]) => {
      const pr = xs.reduce((s, x) => s + x.t.present, 0);
      return { d, n: xs.length, commit: Math.round(xs.reduce((s, x) => s + x.t.commitment, 0) / xs.length), absent: xs.reduce((s, x) => s + x.t.absent, 0), lateMin: xs.reduce((s, x) => s + x.t.lateMinutes, 0), lateDays: xs.reduce((s, x) => s + x.t.lateDays, 0), hrs: pr ? xs.reduce((s, x) => s + x.t.workMs + x.t.meetingMs, 0) / pr : 0, tk: taskStats(tasks.filter(k => xs.some(x => x.p.email === k.assignee)), ym) };
    }).sort((a, b) => b.n - a.n);
    const maxHrs = Math.max(1, ...deptRows.map(r => r.hrs));

    // leaders' task delivery
    const leaders = [...new Set(tasks.map(k => k.leader).filter(Boolean))].filter(e => scopeAll || e === session.email);
    const leaderRows = leaders.map(e => ({ e, tk: taskStats(tasks.filter(k => k.leader === e), range) })).filter(r => r.tk.total).sort((a, b) => b.tk.total - a.tk.total);

    const topLate = per.filter(x => x.t.lateMinutes > 0).sort((a, b) => b.t.lateMinutes - a.t.lateMinutes).slice(0, 5);
    const topGood = per.filter(x => x.t.present > 0).sort((a, b) => b.t.commitment - a.t.commitment || a.t.lateMinutes - b.t.lateMinutes || b.hrs - a.hrs).slice(0, 5);
    const sorters = { todo: (a, b) => (a.td ?? 101) - (b.td ?? 101), late: (a, b) => b.t.lateMinutes - a.t.lateMinutes, absent: (a, b) => b.t.absent - a.t.absent, hours: (a, b) => b.hrs - a.hrs, commit: (a, b) => a.t.commitment - b.t.commitment, tasks: (a, b) => b.tk.lateOpen - a.tk.lateOpen || a.tk.rate - b.tk.rate, name: (a, b) => (a.p.name || '').localeCompare(b.p.name || '', 'ar') };
    const link = (p) => isAdmin() ? `#/stats/${encodeURIComponent(p.email)}` : (isHR() ? `#/employees/${encodeURIComponent(p.email)}` : `#/reports`);
    const th = (k, t) => `<th class="${k === 'name' ? '' : 'num'}"><button class="db-sort ${sortBy === k ? 'on' : ''}" data-sort="${k}">${t}${sortBy === k ? ' <i class="fas fa-arrow-down-short-wide"></i>' : ''}</button></th>`;

    $('#dash').innerHTML = `
      <div class="grid g-4 keep-2 mb-16">
        ${tile('fa-user-check', 'ok', L('نسبة الالتزام', 'Commitment'), `${commit}<small>%</small>`, L(`${num(present)} يوم حضور`, `${num(present)} days present`))}
        ${tile('fa-user-xmark', 'bad', L('أيام الغياب', 'Absent days'), num(absent), L(`${num(sum(x => x.t.leave))} يوم إجازة`, `${num(sum(x => x.t.leave))} leave days`))}
        ${tile('fa-clock', 'warn', L('التأخير', 'Lateness'), `${esc(fmtMin(lateMin))}`, L(`في ${num(lateDays)} يوم`, `on ${num(lateDays)} days`))}
        ${tile('fa-business-time', 'info', L('ساعات العمل الفعلية', 'Actual work hours'), esc(fmtHours(hrs)), L('متوسط اليوم (شغل + اجتماعات)', 'Daily average (work + meetings)'))}
        ${tile('fa-clipboard-check', 'ok', L('إنجاز التاسكات', 'Task completion'), `${allTk.rate}<small>%</small>`, L(`${allTk.done} خلصت · ${allTk.open} مفتوحة`, `${allTk.done} done · ${allTk.open} open`))}
        ${tile('fa-stopwatch', '', L('التسليم في الميعاد', 'Delivered on time'), `${allTk.onTimeRate}<small>%</small>`, L(`${allTk.onTime} من ${allTk.done}`, `${allTk.onTime} of ${allTk.done}`))}
        ${tile('fa-triangle-exclamation', 'bad', L('تاسكات متأخرة', 'Late tasks'), num(allTk.lateOpen), L('مفتوحة وعدّى ميعادها', 'Open and past due'))}
        ${tile('fa-house-laptop', 'brand', L('أيام أونلاين', 'Remote days'), num(sum(x => x.t.remote)), L(`${num(sum(x => x.t.forgot))} يوم نسيوا يقفلوه`, `${num(sum(x => x.t.forgot))} days not ended`))}
      </div>
      <div class="grid mb-16" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">
        <section class="card"><div class="card-head"><h3><i class="fas fa-clock" style="color:var(--bad)"></i> ${L('أكتر الناس تأخيراً', 'Most late')}</h3></div><div class="card-body db-rank">
          ${topLate.map((x, i) => `<a class="db-rank-row" href="${link(x.p)}"><span class="num db-pos">${i + 1}</span>${avatar(x.p, 'sm')}<span class="grow min0"><b class="truncate">${esc(x.p.name || x.p.email)}</b><small>${esc(x.p.department || '')}</small></span><span class="num bad-txt">${esc(fmtMin(x.t.lateMinutes))}<small> / ${x.t.lateDays} ${L('يوم', 'd')}</small></span></a>`).join('') || `<p class="muted small">${L('مفيش تأخير الشهر ده 👌', 'No lateness this month 👌')}</p>`}</div></section>
        <section class="card"><div class="card-head"><h3><i class="fas fa-award" style="color:var(--ok)"></i> ${L('الأكتر التزاماً', 'Most committed')}</h3></div><div class="card-body db-rank">
          ${topGood.map((x, i) => `<a class="db-rank-row" href="${link(x.p)}"><span class="num db-pos">${i + 1}</span>${avatar(x.p, 'sm')}<span class="grow min0"><b class="truncate">${esc(x.p.name || x.p.email)}</b><small>${esc(x.p.department || '')}</small></span><span class="num ok-txt">${x.t.commitment}%<small> · ${esc(fmtHours(x.hrs))}</small></span></a>`).join('') || `<p class="muted small">—</p>`}</div></section>
      </div>
      <section class="card mb-16"><div class="card-head"><h3><i class="fas fa-building"></i> ${L('مقارنة الأقسام', 'Departments')}</h3></div><div class="table-wrap"><table class="table">
        <thead><tr><th>${L('القسم', 'Department')}</th><th class="num">${L('موظفين', 'People')}</th><th class="num">${L('الالتزام', 'Commitment')}</th><th class="num">${L('غياب', 'Absent')}</th><th class="num">${L('التأخير', 'Late')}</th><th>${L('ساعات العمل / يوم', 'Hours / day')}</th><th class="num">${L('إنجاز التاسكات', 'Tasks done')}</th></tr></thead>
        <tbody>${deptRows.map(r => `<tr><td><b>${esc(r.d)}</b></td><td class="num">${r.n}</td><td class="num"><span class="db-pill ${r.commit >= 95 ? 'ok' : r.commit >= 85 ? 'warn' : 'bad'}">${r.commit}%</span></td><td class="num">${r.absent}</td><td class="num">${esc(fmtMin(r.lateMin))}</td>
          <td><div class="db-bar"><span style="width:${Math.round(r.hrs / maxHrs * 100)}%"></span><small class="num">${esc(fmtHours(r.hrs))}</small></div></td><td class="num">${r.tk.total ? `${r.tk.rate}%` : '—'}</td></tr>`).join('')}</tbody></table></div></section>
      ${leaderRows.length ? `<section class="card mb-16"><div class="card-head"><h3><i class="fas fa-user-tie"></i> ${L('التاسكات حسب الليدر', 'Tasks by leader')}</h3></div><div class="table-wrap"><table class="table">
        <thead><tr><th>${L('الليدر', 'Leader')}</th><th class="num">${L('تاسكات', 'Tasks')}</th><th class="num">${L('خلصت', 'Done')}</th><th class="num">${L('مفتوحة', 'Open')}</th><th class="num">${L('متأخرة', 'Late')}</th><th class="num">${L('الإنجاز', 'Completion')}</th><th class="num">${L('في الميعاد', 'On time')}</th></tr></thead>
        <tbody>${leaderRows.map(r => { const p = person(r.e) || { email: r.e, name: nameOf(r.e) }; return `<tr><td><span class="tk-who">${avatar(p, 'xs')}<b>${esc(p.name || r.e)}</b></span></td><td class="num">${r.tk.total}</td><td class="num">${r.tk.done}</td><td class="num">${r.tk.open}</td><td class="num ${r.tk.lateOpen ? 'bad-txt' : ''}">${r.tk.lateOpen}</td><td class="num">${r.tk.rate}%</td><td class="num">${r.tk.done ? r.tk.onTimeRate + '%' : '—'}</td></tr>`; }).join('')}</tbody></table></div></section>` : ''}
      <section class="card"><div class="card-head"><h3><i class="fas fa-users"></i> ${L('كل الموظفين', 'Everyone')}</h3><span class="xs muted">${L('اضغط على عنوان العمود للترتيب', 'Click a column title to sort')}</span></div><div class="table-wrap"><table class="table">
        <thead><tr>${th('name', L('الموظف', 'Employee'))}${th('commit', L('الالتزام', 'Commitment'))}${th('absent', L('غياب', 'Absent'))}${th('late', L('التأخير', 'Late'))}${th('hours', L('ساعات / يوم', 'Hours / day'))}${th('tasks', L('التاسكات', 'Tasks'))}${th('todo', 'To-Do')}</tr></thead>
        <tbody>${per.slice().sort(sorters[sortBy]).map(x => `<tr><td><a class="tk-who" href="${link(x.p)}" style="color:inherit">${avatar(x.p, 'xs')}<span><b>${esc(x.p.name || x.p.email)}</b><small class="muted"> · ${esc(x.p.department || '')}</small></span></a></td>
          <td class="num"><span class="db-pill ${x.t.commitment >= 95 ? 'ok' : x.t.commitment >= 85 ? 'warn' : 'bad'}">${x.t.commitment}%</span></td><td class="num">${x.t.absent}</td><td class="num">${x.t.lateMinutes ? `${esc(fmtMin(x.t.lateMinutes))} <small class="muted">(${x.t.lateDays})</small>` : '—'}</td>
          <td class="num">${x.t.present ? esc(fmtHours(x.hrs)) : '—'}</td><td class="num">${x.tk.total ? `${x.tk.done}/${x.tk.done + x.tk.open}${x.tk.lateOpen ? ` <span class="bad-txt">· ${x.tk.lateOpen} ${L('متأخر', 'late')}</span>` : ''}` : '—'}</td>
          <td class="num">${x.td === null ? '—' : `<a href="#/todo/${encodeURIComponent(x.p.email)}">${x.td}%</a> <small class="muted">(${x.tdN})</small>`}</td></tr>`).join('')}</tbody></table></div></section>`;
  }

  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-pp-month]') && e.target.value) { ym = e.target.value; week = 0; watchTodo(); load(); }
    if (e.target.id === 'dept') { dept = e.target.value; draw(); }
  });
  root.addEventListener('click', (e) => {
    const w = e.target.closest('[data-pp-week]'); if (w) { week = Number(w.dataset.ppWeek); draw(); return; }
    const s = e.target.closest('[data-sort]'); if (s) { sortBy = s.dataset.sort; draw(); }
  });
  const off = onTasks(() => draw());
  watchTodo();
  await load();
  return () => { off(); if (unTodo) unTodo(); };
}
