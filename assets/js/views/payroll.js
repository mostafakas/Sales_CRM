// Finance: monthly payroll run — build from attendance, adjust, approve (publish payslips), mark paid.
import { L, esc, money, num, fmtMonth, addMonths, ym as ymOf, fmtMin, fmtDate, fmtTime } from '../core/utils.js';
import { toast, toastErr, modal, avatar, empty, busy, bindActions, confirmDialog, loader } from '../core/ui.js';
import { now } from '../core/session.js';
import { watch, query, col, where, ref, list, toMs } from '../core/fb.js';
import { buildRun, saveManual, setRunStatus, markPaid, recordAdvancePayout } from '../services/payroll.js';
import { openPayslip } from './payslip.js';
import { exportSheet } from './export.js';

const RUN_STATUS = { draft: ['مسودة', 'Draft', 'warn'], approved: ['معتمد — القسائم ظاهرة للموظفين', 'Approved — payslips visible', 'brand'], paid: ['تم الصرف', 'Paid', 'ok'], closed: ['أرشيف النظام القديم', 'Legacy archive', ''] };

export default async function render(root) {
  let month = ymOf(now()), run = null, items = [], unsubs = [], privs = null;
  // salary data changed after the run was calculated?
  const salaryOf = (email) => { const p = privs && privs.find(x => x.id === email); const s = (p && p.salary) || {}; return { basic: Number(s.basic) || 0, allowances: (s.allowances || []).reduce((t, a) => t + (Number(a.amount) || 0), 0), fixed: Number(s.fixedDeductions) || 0 }; };
  const isStale = (i) => { if (!privs || !run || run.status !== 'draft') return false; const c = salaryOf(i.email); return c.basic !== Number(i.basic || 0) || Math.round(c.allowances) !== Math.round(Number(i.allowances || 0)) || c.fixed !== Number(i.fixed || 0); };
  const loadPrivs = () => list(col('employees_private')).then(r => { privs = r; draw(); }).catch(() => {});
  root.innerHTML = `
    <div class="page-head"><div><h2>${L('الرواتب', 'Payroll')}</h2><p>${L('الخصومات بتتحسب تلقائياً من الغياب والإجازات بدون أجر والتأخير (لو مفعّل) وأقساط السلف.', 'Deductions are calculated from absence, unpaid leave, lateness (if enabled) and advance installments.')}</p></div>
      <div class="row gap-8"><button class="btn btn-icon" data-m="-1"><i class="fas fa-chevron-right" data-flip></i></button><b id="ml" style="min-width:130px;text-align:center"></b><button class="btn btn-icon" data-m="1"><i class="fas fa-chevron-left" data-flip></i></button></div></div>
    <div class="card mb-16"><div class="card-body row between" style="flex-wrap:wrap;gap:12px" id="bar"></div></div>
    <div class="grid g-4 keep-2 mb-16" id="kpi"></div>
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr>
      <th>${L('الموظف', 'Employee')}</th><th class="num">${L('الأساسي', 'Basic')}</th><th class="num">${L('بدلات ومكافآت', 'Allowances & bonus')}</th><th class="num">${L('الإجمالي', 'Gross')}</th><th class="num">${L('الاستقطاعات', 'Deductions')}</th><th class="num">${L('الصافي', 'Net')}</th><th>${L('الحالة', 'Status')}</th><th></th>
    </tr></thead><tbody id="rows"></tbody></table></div></div>
    <div class="card mt-16" id="adv"></div>`;

  function draw() {
    root.querySelector('#ml').textContent = fmtMonth(month);
    const st = run ? (RUN_STATUS[run.status] || RUN_STATUS.draft) : null;
    const editable = !run || run.status === 'draft';
    root.querySelector('#bar').innerHTML = `<div class="row gap-8">${st ? `<span class="badge ${st[2]}">${esc(L(st[0], st[1]))}</span>` : `<span class="badge">${L('لسه متعملش', 'Not started')}</span>`}
        ${run && run.builtAt ? `<span class="xs muted">${L('آخر حساب:', 'Last calculated:')} ${esc(fmtDate(toMs(run.builtAt)))} ${esc(fmtTime(toMs(run.builtAt)))}</span>` : ''}</div>
      <div class="row-wrap gap-8">
        ${editable ? `<button class="btn btn-primary" data-action="build"><i class="fas fa-calculator"></i> ${run ? L('إعادة الحساب من الحضور', 'Recalculate from attendance') : L('إنشاء مسودة الرواتب', 'Create payroll draft')}</button>` : ''}
        ${run && run.status === 'draft' && items.length ? `<button class="btn btn-ok" data-action="approve"><i class="fas fa-check"></i> ${L('اعتماد ونشر القسائم', 'Approve & publish payslips')}</button>` : ''}
        ${run && run.status === 'approved' ? `<button class="btn" data-action="reopen"><i class="fas fa-rotate-left"></i> ${L('رجوع لمسودة', 'Back to draft')}</button><button class="btn btn-ok" data-action="payall"><i class="fas fa-money-bill-transfer"></i> ${L('تسجيل صرف الكل', 'Mark all paid')}</button>` : ''}
        ${items.length ? `<button class="btn" data-action="xls"><i class="fas fa-file-excel"></i> Excel</button>` : ''}
      </div>`;
    const stale = items.filter(isStale);
    const bar = root.querySelector('#bar');
    const old = root.querySelector('#stale-banner'); if (old) old.remove();
    if (stale.length) bar.insertAdjacentHTML('afterend', `<div id="stale-banner" class="alert warn" style="margin:0 20px 16px"><i class="fas fa-triangle-exclamation"></i><div class="grow">${L(`بيانات الراتب اتغيّرت لـ ${stale.length} موظف بعد آخر حساب (${stale.slice(0, 3).map(i => esc(i.name)).join('، ')}${stale.length > 3 ? '…' : ''}). اضغط «إعادة الحساب» عشان الأرقام تتحدّث.`, `Salary data changed for ${stale.length} employee(s) since the last calculation (${stale.slice(0, 3).map(i => esc(i.name)).join(', ')}${stale.length > 3 ? '…' : ''}). Click "Recalculate" to update.`)}</div><button class="btn btn-sm btn-primary" data-action="build"><i class="fas fa-calculator"></i> ${L('إعادة الحساب', 'Recalculate')}</button></div>`);
    const sum = (k) => items.reduce((s, i) => s + (Number(i[k]) || 0), 0);
    const k = (icon, cls, label, v) => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value" style="font-size:20px">${esc(money(v))}</div></div>`;
    root.querySelector('#kpi').innerHTML = k('fa-sack-dollar', '', L('إجمالي الرواتب', 'Total gross'), sum('gross')) + k('fa-minus', 'bad', L('إجمالي الاستقطاعات', 'Total deductions'), sum('deductions')) +
      k('fa-wallet', 'ok', L('صافي المطلوب صرفه', 'Net payable'), sum('net')) + k('fa-circle-check', 'info', L('اتصرف', 'Paid so far'), items.filter(i => i.status === 'paid').reduce((s, i) => s + (i.net || 0), 0));
    root.querySelector('#rows').innerHTML = items.length ? items.map(i => `<tr>
      <td><div class="person">${avatar({ name: i.name, email: i.email }, 'sm')}<div><b>${esc(i.name)}</b><span>${esc(i.title || '')}</span></div></div></td>
      <td class="num">${esc(money(i.basic || 0, false))}${isStale(i) && salaryOf(i.email).basic !== Number(i.basic || 0) ? `<div><span class="badge warn" title="${L('القيمة الجديدة في ملف الموظف', 'New value in the employee file')}">${L('الجديد', 'New')}: ${esc(money(salaryOf(i.email).basic, false))}</span></div>` : ''}</td>
      <td class="num">${esc(money((i.allowances || 0) + (i.bonus || 0) + (i.incentive || 0), false))}${isStale(i) && Math.round(salaryOf(i.email).allowances) !== Math.round(Number(i.allowances || 0)) ? `<div><span class="badge warn">${L('البدلات الجديدة', 'New allowances')}: ${esc(money(salaryOf(i.email).allowances, false))}</span></div>` : ''}${(i.allowanceLines || []).length || i.bonus || i.incentive ? `<div class="xs muted">${[...(i.allowanceLines || []).map(a => `${esc(a.name || L('بدل', 'Allowance'))} ${esc(money(a.amount, false))}`), i.bonus ? `${L('مكافأة', 'Bonus')} ${esc(money(i.bonus, false))}` : '', i.incentive ? `${L('حوافز', 'Incentive')} ${esc(money(i.incentive, false))}` : ''].filter(Boolean).join(' · ')}</div>` : ''}</td>
      <td class="num">${esc(money(i.gross, false))}</td>
      <td class="num">${esc(money(i.deductions || 0, false))}${(() => { const parts = [[L('غياب', 'Absence'), (i.absenceDeduction || 0) + (i.unpaidDeduction || 0)], [L('تأخير', 'Late'), i.lateDeduction], [L('سلفة', 'Advance'), i.advance], [L('ثابتة', 'Fixed'), i.fixed], [L('أخرى', 'Other'), (i.otherDeductions || []).reduce((s, d) => s + (Number(d.amount) || 0), 0)]].filter(x => Number(x[1]) > 0); return parts.length ? `<div class="xs muted">${parts.map(([n, v]) => `${esc(n)} ${esc(money(v, false))}`).join(' · ')}</div>` : ''; })()}</td>
      <td class="num"><b>${esc(money(i.net, false))}</b></td>
      <td>${i.status === 'paid' ? `<span class="badge ok">${L('اتصرف', 'Paid')}</span>` : `<span class="badge">${L('مستني', 'Pending')}</span>`}</td>
      <td style="text-align:end;white-space:nowrap">
        <button class="btn btn-sm btn-icon" data-action="slip" data-id="${esc(i.id)}" title="${L('القسيمة', 'Payslip')}"><i class="fas fa-receipt"></i></button>
        ${editable ? `<button class="btn btn-sm btn-icon" data-action="edit" data-id="${esc(i.id)}" title="${L('تعديل', 'Edit')}"><i class="fas fa-pen"></i></button>` : ''}
        ${run && run.status === 'approved' && i.status !== 'paid' ? `<button class="btn btn-sm btn-ok" data-action="pay" data-id="${esc(i.id)}">${L('صرف', 'Pay')}</button>` : ''}
      </td></tr>`).join('')
      : `<tr><td colspan="8">${empty('fa-money-check-dollar', L('مفيش رواتب للشهر ده لسه', 'No payroll for this month yet'), L('اضغط «إنشاء مسودة الرواتب».', 'Click "Create payroll draft".'))}</td></tr>`;
  }
  async function drawAdvances() {
    const advs = await list(query(col('advances'), where('status', '==', 'active'))).catch(() => []);
    root.querySelector('#adv').innerHTML = `<div class="card-head"><h3>${L('السلف الجارية', 'Active advances')}</h3></div>${advs.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>${L('الموظف', 'Employee')}</th><th class="num">${L('المبلغ', 'Amount')}</th><th class="num">${L('القسط', 'Installment')}</th><th class="num">${L('المسدد', 'Repaid')}</th><th>${L('من شهر', 'From')}</th><th></th></tr></thead><tbody>
      ${advs.map(a => `<tr><td>${esc(a.name || a.email)}</td><td class="num">${esc(money(a.amount, false))}</td><td class="num">${esc(money(a.perMonth, false))}</td><td class="num">${esc(money(a.paid || 0, false))}</td><td>${esc(a.startMonth ? fmtMonth(a.startMonth) : '')}</td>
        <td style="text-align:end">${a.paidOut ? `<span class="badge ok">${L('اتصرفت من الخزينة', 'Paid out')}</span>` : `<button class="btn btn-sm" data-action="payout" data-id="${esc(a.id)}">${L('تسجيل صرفها من الخزينة', 'Record cash payout')}</button>`}</td></tr>`).join('')}</tbody></table></div>` : `<div class="card-body">${empty('fa-hand-holding-dollar', L('مفيش سلف جارية', 'No active advances'))}</div>`}`;
    root.querySelector('#adv').onclick = async (e) => {
      const b = e.target.closest('[data-action="payout"]'); if (!b) return;
      const a = advs.find(x => x.id === b.dataset.id);
      await busy(b, async () => { try { await recordAdvancePayout(a); toast(L('اتسجلت في الخزينة', 'Recorded in treasury')); drawAdvances(); } catch (ex) { toastErr(ex); } });
    };
  }
  function subscribe() {
    unsubs.forEach(u => u()); unsubs = [];
    root.querySelector('#rows').innerHTML = `<tr><td colspan="8">${loader()}</td></tr>`;
    unsubs.push(watch(ref('payroll_runs', month), r => { run = r; draw(); }));
    unsubs.push(watch(query(col('payroll_items'), where('month', '==', month)), rows => { items = rows.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar')); draw(); }));
  }
  bindActions(root, {
    build: (_, b) => busy(b, async () => { try { await buildRun(month); await loadPrivs(); toast(L('اتحسبت الرواتب', 'Payroll calculated')); } catch (e) { toastErr(e); } }),
    approve: async (_, b) => {
      const ok = await confirmDialog({ title: L('اعتماد الرواتب', 'Approve payroll'), message: L('القسائم هتظهر لكل موظف ويوصله إشعار. تكمّل؟', 'Payslips become visible and employees are notified. Continue?'), okText: L('اعتماد', 'Approve'), okClass: 'btn-ok' });
      if (ok) busy(b, async () => { try { await setRunStatus(month, 'approved'); toast(L('تم الاعتماد', 'Approved')); } catch (e) { toastErr(e); } });
    },
    reopen: (_, b) => busy(b, async () => { try { await setRunStatus(month, 'draft'); } catch (e) { toastErr(e); } }),
    payall: async (_, b) => {
      const ok = await confirmDialog({ title: L('تسجيل صرف الرواتب', 'Mark payroll paid'), message: L('هيتسجل صرف كل الرواتب اللي لسه ماتصرفتش في الخزينة، وأقساط السلف هتتخصم.', 'All unpaid salaries are recorded in the treasury and advance installments are applied.'), okText: L('تسجيل الصرف', 'Mark paid'), okClass: 'btn-ok' });
      if (ok) busy(b, async () => { try { const n = await markPaid(month, items.map(i => i.email)); await setRunStatus(month, 'paid'); toast(L(`اتصرف ${n} راتب`, `${n} salaries paid`)); } catch (e) { toastErr(e); } });
    },
    pay: ({ id }, b) => busy(b, async () => { const i = items.find(x => x.id === id); try { await markPaid(month, [i.email]); toast(L('اتسجل الصرف', 'Marked paid')); } catch (e) { toastErr(e); } }),
    slip: ({ id }) => openPayslip(items.find(x => x.id === id)),
    edit: ({ id }) => {
      const i = items.find(x => x.id === id);
      const m = modal({
        title: `${L('تعديل', 'Adjust')} — ${i.name}`, icon: 'fa-pen', size: '',
        body: `<form class="form-grid" id="ef">
          <div class="field"><label>${L('مكافأة', 'Bonus')}</label><input class="input num" type="number" min="0" name="bonus" value="${esc(i.bonus || 0)}"></div>
          <div class="field"><label>${L('حوافز', 'Incentive')}</label><input class="input num" type="number" min="0" name="incentive" value="${esc(i.incentive || 0)}"></div>
          <div class="field span-2"><label>${L('خصومات إضافية', 'Other deductions')}</label><div id="od" class="col gap-8"></div><button type="button" class="btn btn-sm btn-soft mt-8" id="addod" style="align-self:flex-start"><i class="fas fa-plus"></i> ${L('خصم', 'Deduction')}</button></div>
          <div class="field span-2"><label>${L('ملاحظة تظهر في القسيمة', 'Note shown on payslip')}</label><input class="input" name="note" value="${esc(i.note || '')}"></div></form>
          <p class="xs muted mt-8">${L('الغياب والتأخير والسلف بتتحسب تلقائياً. لتغييرها صحّح الحضور واضغط «إعادة الحساب».', 'Absence, lateness and advances are automatic. To change them, correct attendance and recalculate.')}</p>`,
        foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="sv">${L('حفظ', 'Save')}</button>`
      });
      const od = m.$('#od');
      const add = (d = {}) => { const r = document.createElement('div'); r.className = 'row gap-8'; r.innerHTML = `<input class="input" data-r placeholder="${L('السبب', 'Reason')}" value="${esc(d.reason || '')}"><input class="input num" type="number" min="0" data-a value="${esc(d.amount ?? '')}" style="max-width:130px"><button type="button" class="btn btn-ghost btn-icon btn-sm"><i class="fas fa-trash"></i></button>`; r.querySelector('button').onclick = () => r.remove(); od.appendChild(r); };
      (i.otherDeductions || []).forEach(add);
      m.$('#addod').onclick = () => add();
      m.$('#sv').onclick = (e) => busy(e.currentTarget, async () => {
        const f = m.$('#ef');
        const otherDeductions = [...od.children].map(r => ({ reason: r.querySelector('[data-r]').value.trim(), amount: Number(r.querySelector('[data-a]').value || 0) })).filter(d => d.amount);
        try { await saveManual(month, i.email, { bonus: Number(f.bonus.value || 0), incentive: Number(f.incentive.value || 0), otherDeductions, note: f.note.value.trim() }); m.close(); toast(L('تم الحفظ', 'Saved')); } catch (ex) { toastErr(ex); }
      });
    },
    xls: () => exportSheet(`payroll_${month}`, [{
      name: month, rows: items.map(i => ({
        [L('الموظف', 'Employee')]: i.name, [L('الأساسي', 'Basic')]: i.basic, [L('البدلات', 'Allowances')]: i.allowances, [L('مكافأة', 'Bonus')]: i.bonus, [L('حوافز', 'Incentive')]: i.incentive,
        [L('الإجمالي', 'Gross')]: i.gross, [L('ثابتة', 'Fixed')]: i.fixed, [L('غياب', 'Absence')]: i.absenceDeduction, [L('بدون أجر', 'Unpaid')]: i.unpaidDeduction, [L('تأخير', 'Late')]: i.lateDeduction,
        [L('سلف', 'Advance')]: i.advance, [L('أخرى', 'Other')]: (i.otherDeductions || []).reduce((s, d) => s + d.amount, 0), [L('الصافي', 'Net')]: i.net, [L('الحالة', 'Status')]: i.status
      }))
    }])
  });
  root.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { month = addMonths(month, Number(b.dataset.m)); subscribe(); });
  subscribe();
  loadPrivs();
  drawAdvances();
  return () => unsubs.forEach(u => u());
}
