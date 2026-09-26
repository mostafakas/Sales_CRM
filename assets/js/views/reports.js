// Monthly reports: company / department / team / person, with Excel & PDF export and month close.
import { L, esc, num, fmtMonth, addMonths, ym as ymOf, fmtHours, fmtMin, fmtDate, money } from '../core/utils.js';
import { toast, toastErr, avatar, empty, loader, busy, confirmDialog } from '../core/ui.js';
import { session, now, isHR, isFinance, seesAll } from '../core/session.js';
import { leaveTypes, leaveTypeLabel, policy } from '../core/policy.js';
import { read, setDoc, doc, db, serverTimestamp, toMs } from '../core/fb.js';
import { teamMonth, STATUS_DAY } from '../services/reports.js';
import { departments } from '../services/directory.js';
import { personMonthView } from './attendance.js';
import { exportSheet } from './export.js';

export default async function render(root) {
  let month = addMonths(ymOf(now()), 0), data = null, dept = '', tab = 'summary', snapshot = null;
  const wide = seesAll() || isFinance();
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>${L('التقارير الشهرية', 'Monthly reports')}</h2><p>${wide ? L('تقرير الشركة والأقسام وكل موظف.', 'Company, departments and each employee.') : L('تقرير فريقك.', 'Your team report.')}</p></div>
      <div class="row gap-8"><button class="btn btn-icon" data-m="-1"><i class="fas fa-chevron-right" data-flip></i></button><b id="ml" style="min-width:130px;text-align:center"></b><button class="btn btn-icon" data-m="1"><i class="fas fa-chevron-left" data-flip></i></button></div></div>
    <div class="filters no-print">
      <div class="tabs" id="rt"><button class="tab active" data-t="summary">${L('الملخص', 'Summary')}</button><button class="tab" data-t="people">${L('الموظفين', 'Employees')}</button><button class="tab" data-t="person">${L('تقرير موظف', 'Employee report')}</button></div>
      ${wide ? `<select class="select" id="dept"><option value="">${L('كل الأقسام', 'All departments')}</option>${departments().map(d => `<option>${esc(d)}</option>`).join('')}</select>` : ''}
      <div class="grow"></div>
      <span id="snap"></span>
      <button class="btn" id="xls"><i class="fas fa-file-excel"></i> Excel</button>
      <button class="btn" id="pdf"><i class="fas fa-print"></i> PDF</button>
      ${isHR() ? `<button class="btn btn-primary" id="close"><i class="fas fa-lock"></i> ${L('إقفال الشهر', 'Close month')}</button>` : ''}
    </div>
    <div class="print-head"><img src="assets/img/logo-full.png" alt="AL MASTER" style="height:24px;width:auto"><div style="text-align:end"><b>${L('تقرير الحضور الشهري', 'Monthly attendance report')}</b><div class="small" id="ph"></div></div></div>
    <div id="body">${loader()}</div>`;
  const people = () => (data ? data.people.filter(x => !dept || x.person.department === dept) : []);
  const agg = (list) => {
    const t = { n: list.length, present: 0, remote: 0, absent: 0, leave: 0, lateDays: 0, lateMinutes: 0, earlyMinutes: 0, workMs: 0, forgot: 0, commitment: 0, requests: 0, unpaid: 0 };
    list.forEach(x => { const s = x.totals; t.present += s.present; t.remote += s.remote; t.absent += s.absent; t.leave += s.leave; t.lateDays += s.lateDays; t.lateMinutes += s.lateMinutes; t.earlyMinutes += s.earlyMinutes; t.workMs += s.workMs; t.forgot += s.forgot; t.commitment += s.commitment; t.requests += x.requests.length; t.unpaid += s.unpaidLeave; });
    t.commitment = list.length ? Math.round(t.commitment / list.length) : 0;
    return t;
  };
  const bars = (rows, max, fmt, cls = '') => `<div class="bars">${rows.map(([label, v]) => `<div class="bar-row"><span class="truncate">${esc(label)}</span><div class="track"><div class="fill ${cls}" style="width:${max ? (v / max * 100).toFixed(1) : 0}%"></div></div><b class="num">${esc(fmt(v))}</b></div>`).join('')}</div>`;

  function drawSummary(body) {
    const list = people();
    if (!list.length) { body.innerHTML = `<div class="card">${empty('fa-chart-column', L('مفيش بيانات', 'No data'))}</div>`; return; }
    const t = agg(list);
    const tile = (icon, cls, label, v, sub = '') => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value">${v}</div>${sub ? `<div class="hint">${esc(sub)}</div>` : ''}</div>`;
    const byDept = {};
    list.forEach(x => { const d = x.person.department || L('بدون قسم', 'No department'); (byDept[d] = byDept[d] || []).push(x); });
    const deptRows = Object.entries(byDept).map(([d, l]) => [d, agg(l)]);
    const lateTop = list.filter(x => x.totals.lateMinutes).sort((a, b) => b.totals.lateMinutes - a.totals.lateMinutes).slice(0, 8);
    const absentTop = list.filter(x => x.totals.absent).sort((a, b) => b.totals.absent - a.totals.absent).slice(0, 8);
    const leaveBy = {}; list.forEach(x => Object.entries(x.totals.leaveByType).forEach(([k, v]) => { leaveBy[k] = (leaveBy[k] || 0) + v; }));
    const remoteUse = list.map(x => [x.person.name, x.totals.remote, Number(x.person.remoteQuota ?? policy.defaultRemoteQuota)]).filter(r => r[1]).sort((a, b) => b[1] - a[1]).slice(0, 10);
    body.innerHTML = `
      <div class="grid g-4 keep-2 mb-16">
        ${tile('fa-users', '', L('الموظفين', 'Employees'), num(t.n))}
        ${tile('fa-chart-simple', t.commitment >= 90 ? 'ok' : 'warn', L('متوسط الالتزام', 'Avg commitment'), num(t.commitment) + '%')}
        ${tile('fa-user-check', 'ok', L('أيام حضور', 'Attendance days'), num(t.present), L(`منها ${t.remote} أونلاين`, `${t.remote} remote`))}
        ${tile('fa-user-xmark', 'bad', L('أيام غياب', 'Absence days'), num(t.absent))}
        ${tile('fa-clock', 'warn', L('إجمالي التأخير', 'Total lateness'), esc(fmtMin(t.lateMinutes)), L(`${t.lateDays} مرة`, `${t.lateDays} times`))}
        ${tile('fa-umbrella-beach', 'info', L('أيام إجازة', 'Leave days'), num(t.leave), t.unpaid ? L(`منها ${t.unpaid} بدون أجر`, `${t.unpaid} unpaid`) : '')}
        ${tile('fa-laptop-code', '', L('ساعات شغل مسجلة', 'Logged work hours'), esc(fmtHours(t.workMs)))}
        ${tile('fa-triangle-exclamation', t.forgot ? 'warn' : 'neutral', L('أيام ما اتقفلتش', 'Days not ended'), num(t.forgot))}
      </div>
      <div class="grid g-2">
        <section class="card"><div class="card-head"><h3>${L('الالتزام حسب القسم', 'Commitment by department')}</h3></div><div class="card-body">${bars(deptRows.map(([d, a]) => [d, a.commitment]), 100, v => v + '%', 'ok')}</div></section>
        <section class="card"><div class="card-head"><h3>${L('أكتر تأخير', 'Most late')}</h3></div><div class="card-body">${lateTop.length ? bars(lateTop.map(x => [x.person.name, x.totals.lateMinutes]), lateTop[0].totals.lateMinutes, fmtMin, 'warn') : empty('fa-face-smile', L('مفيش تأخير', 'No lateness'))}</div></section>
        <section class="card"><div class="card-head"><h3>${L('أكتر غياب', 'Most absent')}</h3></div><div class="card-body">${absentTop.length ? bars(absentTop.map(x => [x.person.name, x.totals.absent]), absentTop[0].totals.absent, v => num(v) + L(' يوم', ' d'), 'bad') : empty('fa-face-smile', L('مفيش غياب', 'No absence'))}</div></section>
        <section class="card"><div class="card-head"><h3>${L('الإجازات حسب النوع', 'Leave by type')}</h3></div><div class="card-body">${Object.keys(leaveBy).length ? bars(Object.entries(leaveBy).map(([k, v]) => [leaveTypeLabel(k), v]), Math.max(...Object.values(leaveBy)), v => num(v) + L(' يوم', ' d')) : empty('fa-umbrella-beach', L('مفيش إجازات', 'No leave'))}</div></section>
        <section class="card" style="grid-column:1/-1"><div class="card-head"><h3>${L('استخدام حصة الأونلاين', 'Remote quota usage')}</h3></div><div class="card-body">${remoteUse.length ? `<div class="bars">${remoteUse.map(([n, used, q]) => `<div class="bar-row"><span class="truncate">${esc(n)}</span><div class="track"><div class="fill ${used > q ? 'bad' : ''}" style="width:${Math.min(100, q ? used / q * 100 : 100).toFixed(1)}%"></div></div><b class="num">${num(used)} / ${num(q)}</b></div>`).join('')}</div>` : empty('fa-house-laptop', L('مفيش أيام أونلاين', 'No remote days'))}</div></section>
      </div>`;
  }
  function drawPeople(body) {
    const list = people().sort((a, b) => a.totals.commitment - b.totals.commitment);
    body.innerHTML = `<div class="card"><div class="table-wrap"><table class="table"><thead><tr>
      <th>${L('الموظف', 'Employee')}</th><th class="num">${L('حضور', 'Present')}</th><th class="num">${L('أونلاين', 'Remote')}</th><th class="num">${L('غياب', 'Absent')}</th><th class="num">${L('إجازة', 'Leave')}</th>
      <th class="num">${L('تأخير', 'Late')}</th><th class="num">${L('انصراف مبكر', 'Early')}</th><th class="num">${L('ساعات', 'Hours')}</th><th class="num">${L('طلبات', 'Requests')}</th><th class="num">${L('الالتزام', 'Commitment')}</th></tr></thead><tbody>
      ${list.map(x => { const s = x.totals; return `<tr><td><div class="person">${avatar(x.person, 'sm')}<div><b>${esc(x.person.name)}</b><span>${esc(x.person.department || '')}</span></div></div></td>
        <td class="num">${num(s.present)}</td><td class="num">${num(s.remote)}</td><td class="num" style="color:${s.absent ? 'var(--bad)' : 'inherit'}">${num(s.absent)}</td><td class="num">${num(s.leave)}</td>
        <td class="num">${s.lateMinutes ? esc(fmtMin(s.lateMinutes)) : '—'}<div class="xs muted">${s.lateDays ? L(`${s.lateDays} مرة`, `${s.lateDays}×`) : ''}</div></td><td class="num">${s.earlyMinutes ? esc(fmtMin(s.earlyMinutes)) : '—'}</td>
        <td class="num">${esc(fmtHours(s.workMs))}</td><td class="num">${num(x.requests.length)}</td>
        <td class="num"><span class="badge ${s.commitment >= 90 ? 'ok' : (s.commitment >= 75 ? 'warn' : 'bad')}">${num(s.commitment)}%</span></td></tr>`; }).join('') || `<tr><td colspan="10">${empty('fa-users', L('مفيش موظفين', 'No employees'))}</td></tr>`}</tbody></table></div></div>`;
  }
  function drawPerson(body) {
    const list = people();
    body.innerHTML = `<div class="card card-pad mb-16 no-print"><div class="field" style="max-width:360px"><label>${L('اختار موظف', 'Choose an employee')}</label><select class="select" id="pp"><option value="">—</option>${list.map(x => `<option value="${esc(x.person.email)}">${esc(x.person.name)}</option>`).join('')}</select></div></div><div id="pv"></div>`;
    body.querySelector('#pp').onchange = (e) => {
      const email = e.target.value; const pv = body.querySelector('#pv');
      if (!email) { pv.innerHTML = ''; return; }
      const x = list.find(y => y.person.email === email);
      personMonthView(pv, email, { initialYm: month, title: `<div class="row gap-8">${avatar(x.person)}<div><b>${esc(x.person.name)}</b><div class="xs muted">${esc(x.person.title || '')}</div></div></div>` });
    };
  }
  function draw() {
    const body = root.querySelector('#body');
    if (!data) { body.innerHTML = loader(); return; }
    ({ summary: drawSummary, people: drawPeople, person: drawPerson })[tab](body);
    root.querySelector('#snap').innerHTML = snapshot ? `<span class="badge ok"><i class="fas fa-lock"></i>${L('الشهر مقفول', 'Month closed')} · ${esc(fmtDate(toMs(snapshot.closedAt)))}</span>` : '';
  }
  async function load() {
    root.querySelector('#ml').textContent = fmtMonth(month);
    root.querySelector('#ph').textContent = fmtMonth(month) + (dept ? ` · ${dept}` : '');
    data = null; draw();
    try {
      [data, snapshot] = await Promise.all([teamMonth(month), isHR() ? read('monthly_reports', month).catch(() => null) : Promise.resolve(null)]);
      draw();
    } catch (e) { root.querySelector('#body').innerHTML = `<div class="card">${empty('fa-triangle-exclamation', L('تعذّر تحميل التقرير', 'Could not load report'), e.message)}</div>`; }
  }
  root.querySelectorAll('#rt .tab').forEach(b => b.onclick = () => { tab = b.dataset.t; root.querySelectorAll('#rt .tab').forEach(x => x.classList.toggle('active', x === b)); draw(); });
  root.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { month = addMonths(month, Number(b.dataset.m)); load(); });
  const ds = root.querySelector('#dept'); if (ds) ds.onchange = (e) => { dept = e.target.value; root.querySelector('#ph').textContent = fmtMonth(month) + (dept ? ` · ${dept}` : ''); draw(); };
  root.querySelector('#pdf').onclick = () => window.print();
  root.querySelector('#xls').onclick = () => {
    if (!data) return;
    const list = people();
    const perPerson = list.map(x => {
      const s = x.totals;
      const o = { [L('الموظف', 'Employee')]: x.person.name, [L('القسم', 'Department')]: x.person.department || '', [L('أيام حضور', 'Present')]: s.present, [L('أونلاين', 'Remote')]: s.remote, [L('غياب', 'Absent')]: s.absent,
        [L('إجازة', 'Leave')]: s.leave, [L('مرات التأخير', 'Late days')]: s.lateDays, [L('دقائق التأخير', 'Late minutes')]: s.lateMinutes, [L('انصراف مبكر (دقيقة)', 'Early (min)')]: s.earlyMinutes,
        [L('ساعات الشغل', 'Work hours')]: Math.round(s.workMs / 36000) / 100, [L('الالتزام %', 'Commitment %')]: s.commitment, [L('طلبات', 'Requests')]: x.requests.length };
      leaveTypes.forEach(t => { o[L(t.ar, t.en)] = s.leaveByType[t.id] || 0; });
      return o;
    });
    const daily = [];
    list.forEach(x => x.rows.forEach(r => { if (r.status === 'future') return; daily.push({ [L('الموظف', 'Employee')]: x.person.name, [L('التاريخ', 'Date')]: r.date, [L('الحالة', 'Status')]: L((STATUS_DAY[r.status] || {}).ar || '', (STATUS_DAY[r.status] || {}).en || ''), [L('تأخير (دقيقة)', 'Late (min)')]: r.late || 0, [L('ساعات', 'Hours')]: Math.round((r.workMs || 0) / 36000) / 100 }); }));
    exportSheet(`report_${month}${dept ? '_' + dept : ''}`, [{ name: L('الموظفين', 'Employees'), rows: perPerson }, { name: L('تفصيلي يومي', 'Daily detail'), rows: daily }]);
  };
  const cb = root.querySelector('#close');
  if (cb) cb.onclick = async () => {
    const ok = await confirmDialog({ title: L('إقفال الشهر', 'Close month'), message: L('هيتحفظ نسخة ثابتة من أرقام الشهر ده تُستخدم كمرجع حتى لو اتعدلت بيانات بعدين. راجع الأيام اللي ما اتقفلتش والطلبات المعلقة الأول.', 'A fixed snapshot of this month is saved for reference even if data changes later. Review unfinished days and pending requests first.'), okText: L('إقفال', 'Close') });
    if (!ok || !data) return;
    await busy(cb, async () => {
      try {
        const rows = data.people.map(x => ({ email: x.person.email, name: x.person.name, department: x.person.department || '', ...Object.fromEntries(Object.entries(x.totals).filter(([k]) => k !== 'leaveByType')), leaveByType: x.totals.leaveByType, requests: x.requests.length }));
        await setDoc(doc(db, 'monthly_reports', month), { month, rows, summary: agg(data.people), closedBy: session.email, closedAt: serverTimestamp() });
        snapshot = { closedAt: { seconds: Date.now() / 1000 } }; draw(); toast(L('تم إقفال الشهر', 'Month closed'));
      } catch (e) { toastErr(e); }
    });
  };
  await load();
}
