// Finance: monthly payroll. The admin builds and adjusts; each salary then moves
// pending → approved (admin) → transferred (receipt attached) → payslip sent. The accountant only moves statuses.
import { L, esc, money, fmtMonth, addMonths, ym as ymOf, fmtDate, fmtTime } from '../core/utils.js';
import { toast, toastErr, modal, avatar, empty, busy, bindActions, confirmDialog, loader } from '../core/ui.js';
import { now, isAdmin } from '../core/session.js';
import { watch, query, col, where, ref, list, toMs } from '../core/fb.js';
import { buildRun, saveManual, recordAdvancePayout, PAY_ORDER, PAY_STATUS, payStatus, payStatusLabel, allowedMoves, setPayStatus, MAX_PROOF } from '../services/payroll.js';
import { openPayslip } from './payslip.js';
import { salaryParts } from '../services/salary.js';
import { exportSheet } from './export.js';

const fmtSize = (n) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export default async function render(root) {
  const admin = isAdmin();
  let month = ymOf(now()), run = null, items = [], unsubs = [], privs = null;
  // salary data changed after the salary was calculated? (only matters while it is still pending)
  const salaryOf = (email) => salaryParts((privs && privs.find(x => x.id === email)) || {});
  const extrasOf = (x) => Number(x.allowances || 0) + Number(x.regularity || 0) + Number(x.kpiFull ?? x.kpi ?? 0);
  const isStale = (i) => { if (!privs || !admin || payStatus(i) !== 'pending') return false; const c = salaryOf(i.email); return c.basic !== Number(i.basic || 0) || Math.round(c.allowances + c.regularity + c.kpi) !== Math.round(extrasOf(i)) || c.fixed !== Number(i.fixed || 0); };
  const loadPrivs = () => list(col('employees_private')).then(r => { privs = r; draw(); }).catch(() => {});
  root.innerHTML = `
    <div class="page-head"><div><h2>${L('الرواتب', 'Payroll')}</h2><p>${admin
      ? L('الخصومات بتتحسب تلقائياً من الغياب والإجازات بدون أجر والتأخير (لو مفعّل) وأقساط السلف. غيّر حالة كل راتب من العمود «الحالة».', 'Deductions come from absence, unpaid leave, lateness (if enabled) and advance installments. Change each salary\'s status in the "Status" column.')
      : L('بعد ما الأدمن يعتمد الراتب، سجّل التحويل بإيصاله، وبعدين ابعت القسيمة للموظف.', 'Once the admin approves a salary, record the transfer with its receipt, then send the payslip.')}</p></div>
      <div class="row gap-8"><button class="btn btn-icon" data-m="-1"><i class="fas fa-chevron-right" data-flip></i></button><b id="ml" style="min-width:130px;text-align:center"></b><button class="btn btn-icon" data-m="1"><i class="fas fa-chevron-left" data-flip></i></button></div></div>
    <div class="card mb-16"><div class="card-body row between" style="flex-wrap:wrap;gap:12px" id="bar"></div></div>
    <div class="grid g-4 keep-2 mb-16" id="kpi"></div>
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr>
      <th>${L('الموظف', 'Employee')}</th><th class="num">${L('الأساسي', 'Basic')}</th><th class="num">${L('بدلات ومكافآت', 'Allowances & bonus')}</th><th class="num">${L('الإجمالي', 'Gross')}</th><th class="num">${L('الاستقطاعات', 'Deductions')}</th><th class="num">${L('الصافي', 'Net')}</th><th>${L('الحالة', 'Status')}</th><th></th>
    </tr></thead><tbody id="rows"></tbody></table></div></div>
    <div class="card mt-16" id="adv"></div>`;

  const statusBadge = (s) => `<span class="pay-badge ${PAY_STATUS[s].cls}"><i class="fas ${PAY_STATUS[s].icon}"></i>${esc(payStatusLabel(s))}</span>`;
  function statusCell(i) {
    const s = payStatus(i);
    const moves = allowedMoves(i);
    const receipt = i.proof ? `<div class="xs muted mt-4"><i class="fas fa-paperclip"></i> ${L('إيصال مرفق', 'Receipt attached')}</div>` : '';
    if (!moves.length) return statusBadge(s) + receipt;
    const opts = PAY_ORDER.filter(k => k === s || moves.includes(k));
    return `<select class="pay-select ${PAY_STATUS[s].cls}" data-status="${esc(i.id)}" aria-label="${L('الحالة', 'Status')}">${opts.map(k => `<option value="${k}" ${k === s ? 'selected' : ''}>${esc(payStatusLabel(k))}</option>`).join('')}</select>${receipt}`;
  }

  function draw() {
    root.querySelector('#ml').textContent = fmtMonth(month);
    const counts = Object.fromEntries(PAY_ORDER.map(s => [s, items.filter(i => payStatus(i) === s).length]));
    root.querySelector('#bar').innerHTML = `<div class="row-wrap gap-8">${items.length ? PAY_ORDER.map(s => `<span class="pay-badge ${PAY_STATUS[s].cls}">${esc(payStatusLabel(s))} <b class="num">${counts[s]}</b></span>`).join('') : `<span class="badge">${L('لسه متعملش', 'Not started')}</span>`}
        ${run && run.builtAt ? `<span class="xs muted">${L('آخر حساب:', 'Last calculated:')} ${esc(fmtDate(toMs(run.builtAt)))} ${esc(fmtTime(toMs(run.builtAt)))}</span>` : ''}</div>
      <div class="row-wrap gap-8">
        ${admin && !(run && run.status === 'closed') ? `<button class="btn btn-primary" data-action="build"><i class="fas fa-calculator"></i> ${items.length ? L('إعادة الحساب من الحضور', 'Recalculate from attendance') : L('إنشاء رواتب الشهر', 'Create this month\'s payroll')}</button>` : ''}
        ${items.length ? `<button class="btn" data-action="xls"><i class="fas fa-file-excel"></i> Excel</button>` : ''}
      </div>`;
    const stale = items.filter(isStale);
    const bar = root.querySelector('#bar');
    const old = root.querySelector('#stale-banner'); if (old) old.remove();
    if (stale.length) bar.insertAdjacentHTML('afterend', `<div id="stale-banner" class="alert warn" style="margin:0 20px 16px"><i class="fas fa-triangle-exclamation"></i><div class="grow">${L(`بيانات الراتب اتغيّرت لـ ${stale.length} موظف بعد آخر حساب (${stale.slice(0, 3).map(i => esc(i.name)).join('، ')}${stale.length > 3 ? '…' : ''}). اضغط «إعادة الحساب» عشان الأرقام تتحدّث.`, `Salary data changed for ${stale.length} employee(s) since the last calculation (${stale.slice(0, 3).map(i => esc(i.name)).join(', ')}${stale.length > 3 ? '…' : ''}). Click "Recalculate" to update.`)}</div><button class="btn btn-sm btn-primary" data-action="build"><i class="fas fa-calculator"></i> ${L('إعادة الحساب', 'Recalculate')}</button></div>`);
    const sum = (k) => items.reduce((s, i) => s + (Number(i[k]) || 0), 0);
    const k = (icon, cls, label, v) => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value" style="font-size:20px">${esc(money(v))}</div></div>`;
    root.querySelector('#kpi').innerHTML = k('fa-sack-dollar', '', L('إجمالي الرواتب', 'Total gross'), sum('gross')) + k('fa-minus', 'bad', L('إجمالي الاستقطاعات', 'Total deductions'), sum('deductions')) +
      k('fa-wallet', 'ok', L('صافي المطلوب صرفه', 'Net payable'), sum('net')) + k('fa-money-bill-transfer', 'info', L('اتحوّل', 'Transferred'), items.filter(i => ['paid', 'sent'].includes(payStatus(i))).reduce((s, i) => s + (i.net || 0), 0));
    root.querySelector('#rows').innerHTML = items.length ? items.map(i => `<tr>
      <td><div class="person">${avatar({ name: i.name, email: i.email }, 'sm')}<div><b>${esc(i.name)}</b><span>${esc(i.title || '')}</span></div></div></td>
      <td class="num">${esc(money(i.basic || 0, false))}${isStale(i) && salaryOf(i.email).basic !== Number(i.basic || 0) ? `<div><span class="badge warn" title="${L('القيمة الجديدة في ملف الموظف', 'New value in the employee file')}">${L('الجديد', 'New')}: ${esc(money(salaryOf(i.email).basic, false))}</span></div>` : ''}</td>
      <td class="num">${esc(money(Number(i.gross || 0) - Number(i.basic || 0), false))}${isStale(i) && Math.round(salaryOf(i.email).allowances + salaryOf(i.email).regularity + salaryOf(i.email).kpi) !== Math.round(extrasOf(i)) ? `<div><span class="badge warn">${L('الجديد', 'New')}: ${esc(money(salaryOf(i.email).allowances + salaryOf(i.email).regularity + salaryOf(i.email).kpi, false))}</span></div>` : ''}${(() => {
        const bits = [...(i.allowanceLines || []).map(a => [a.name || L('بدل', 'Allowance'), a.amount]),
          ...((i.allowanceLines || []).length ? [] : [[L('بدلات', 'Allowances'), i.allowances]]), [L('انتظام', 'Regularity'), i.regularity],
          [`KPI${i.kpiMode ? (i.kpiMode === 'pct' ? ` ${i.kpiValue}%` : ` (${L('محدد', 'set')})`) : ''}`, i.kpi], [L('مكافأة', 'Bonus'), i.bonus], [L('حوافز', 'Incentive'), i.incentive]].filter(x => Number(x[1]) > 0);
        return bits.length ? `<div class="xs muted">${bits.map(([n, v]) => `${esc(n)} ${esc(money(v, false))}`).join(' · ')}</div>` : ''; })()}</td>
      <td class="num">${esc(money(i.gross, false))}</td>
      <td class="num">${esc(money(i.deductions || 0, false))}${(() => { const parts = [[L('تأخير', 'Late'), i.lateDeduction], [L('غياب', 'Absence'), (i.absenceDeduction || 0) + (i.unpaidDeduction || 0)], [L('أونلاين مرفوض', 'Rejected remote'), i.remoteDeduction], [L('انصراف مبكر', 'Early leave'), i.earlyDeduction], [L('سلفة', 'Advance'), i.advance], [L('ثابتة', 'Fixed'), i.fixed], [L('أخرى', 'Other'), (i.otherDeductions || []).reduce((s, d) => s + (Number(d.amount) || 0), 0)]].filter(x => Number(x[1]) > 0); return parts.length ? `<div class="xs muted">${parts.map(([n, v]) => `${esc(n)} ${esc(money(v, false))}`).join(' · ')}</div>` : ''; })()}${i.structured === false && admin && payStatus(i) === 'pending' ? `<div><span class="badge warn" title="${L('حدد الراتب الكامل وأجزاءه من ملف الموظف', 'Set the full salary and its parts in the employee file')}">${L('هيكل الراتب مش متحدد', 'No salary structure')}</span></div>` : ''}</td>
      <td class="num"><b>${esc(money(i.net, false))}</b></td>
      <td>${statusCell(i)}</td>
      <td style="text-align:end;white-space:nowrap">
        <button class="btn btn-sm btn-icon" data-action="slip" data-id="${esc(i.id)}" title="${L('القسيمة', 'Payslip')}"><i class="fas fa-receipt"></i></button>
        ${admin && ['pending', 'approved'].includes(payStatus(i)) ? `<button class="btn btn-sm btn-icon" data-action="edit" data-id="${esc(i.id)}" title="${L('تعديل', 'Edit')}"><i class="fas fa-pen"></i></button>` : ''}
      </td></tr>`).join('')
      : `<tr><td colspan="8">${empty('fa-money-check-dollar', L('مفيش رواتب للشهر ده لسه', 'No payroll for this month yet'), admin ? L('اضغط «إنشاء رواتب الشهر».', 'Click "Create this month\'s payroll".') : L('الأدمن لسه ما حسبش رواتب الشهر ده.', 'The admin has not calculated this month yet.'))}</td></tr>`;
  }

  /** Transfer receipt dialog; `onConfirm({ file, note, onProgress })` runs the transfer (the dialog stays open on failure) */
  function askProof(i, onConfirm) {
    {
      let file = null;
      const m = modal({
        title: `${L('تسجيل تحويل الراتب', 'Record salary transfer')} — ${i.name}`, icon: 'fa-money-bill-transfer', size: 'narrow',
        body: `<div class="col gap-16">
          <div class="alert info"><i class="fas fa-circle-info"></i><div>${L('صافي الراتب:', 'Net pay:')} <b class="num">${esc(money(i.net))}</b>${i.payTo ? ` · ${esc(i.payTo)}` : ''}</div></div>
          <label class="dropzone" id="pz"><input type="file" accept="image/*,application/pdf" hidden id="pf"><i class="fas fa-cloud-arrow-up"></i>
            <div id="pn">${L('إيصال التحويل (إجباري): اختار صورة أو PDF، أو الصق سكرين شوت (Ctrl+V)، أو اسحب الملف هنا', 'Transfer receipt (required): pick an image or PDF, paste a screenshot (Ctrl+V), or drop a file here')}</div></label>
          <div id="pv"></div>
          <div class="field"><label>${L('ملاحظة (اختياري) — مثلاً رقم العملية', 'Note (optional) — e.g. transaction number')}</label><input class="input" id="pnote" maxlength="300"></div>
          <div class="progress hidden" id="pp"><span style="width:0%"></span></div>
          <p class="xs muted">${L('الإيصال هيظهر للموظف في قسيمته لما تتبعتله.', 'The receipt is shown to the employee on their payslip once it is sent.')}</p></div>`,
        foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-ok" id="pok" disabled><i class="fas fa-check"></i> ${L('تأكيد التحويل', 'Confirm transfer')}</button>`
      });
      const pick = (f) => {
        if (!f) return;
        if (!/^image\//.test(f.type) && f.size > MAX_PROOF) { toast(L('الملف كبير', 'File too large'), L('الحد الأقصى 5 ميجا.', 'Max 5 MB.'), 'bad'); return; }
        file = f;
        m.$('#pn').textContent = `${f.name || L('سكرين شوت', 'Screenshot')} · ${fmtSize(f.size)}`;
        m.$('#pv').innerHTML = /^image\//.test(f.type) ? `<img src="${URL.createObjectURL(f)}" alt="" style="max-height:220px;border-radius:12px;border:1px solid var(--border);margin:auto">` : '';
        m.$('#pok').disabled = false;
      };
      m.$('#pf').onchange = (e) => pick(e.target.files[0]);
      m.el.addEventListener('paste', (e) => { const f = [...((e.clipboardData && e.clipboardData.files) || [])][0]; if (f) { e.preventDefault(); pick(f); } });
      const pz = m.$('#pz');
      pz.ondragover = (e) => { e.preventDefault(); pz.style.borderColor = 'var(--brand)'; };
      pz.ondragleave = () => { pz.style.borderColor = ''; };
      pz.ondrop = (e) => { e.preventDefault(); pz.style.borderColor = ''; pick(((e.dataTransfer && e.dataTransfer.files) || [])[0]); };
      m.$('#pok').onclick = (e) => busy(e.currentTarget, async () => {
        const bar = m.$('#pp'); bar.classList.remove('hidden');
        try {
          await onConfirm({ file, note: m.$('#pnote').value, onProgress: (x) => { bar.firstElementChild.style.width = Math.round(x * 100) + '%'; } });
          m.close();
        } catch (ex) { bar.classList.add('hidden'); toastErr(ex); }
      });
    }
  }

  async function changeStatus(sel) {
    const i = items.find(x => x.id === sel.dataset.status); if (!i) return;
    const cur = payStatus(i), target = sel.value;
    sel.value = cur; // stays on the current status until the change is saved
    if (target === cur) return;
    const ci = PAY_ORDER.indexOf(cur), ti = PAY_ORDER.indexOf(target);
    if (ci < 2 && ti >= 2) { askProof(i, (opts) => run_(i, target, opts)); return; }
    const msg = ci >= 2 && ti < 2
      ? L(`هيتلغي تسجيل تحويل راتب ${i.name}: حركة الخزينة هتتمسح وقسط السلفة هيرجع، والقسيمة هتختفي من عنده. تكمّل؟`, `${i.name}'s transfer will be undone: the treasury entry is removed, the advance installment returned, and the payslip hidden. Continue?`)
      : target === 'sent' ? L(`القسيمة هتظهر لـ ${i.name} ويوصله إشعار. تكمّل؟`, `The payslip becomes visible to ${i.name} and they are notified. Continue?`)
      : `${i.name}: ${payStatusLabel(cur)} ← ${payStatusLabel(target)}`;
    const ok = await confirmDialog({ title: payStatusLabel(target), message: msg, okText: L('تأكيد', 'Confirm'), okClass: ci >= 2 && ti < 2 ? 'btn-danger' : 'btn-primary' });
    if (!ok) return;
    sel.disabled = true;
    try { await run_(i, target, {}); } catch (ex) { toastErr(ex); } finally { sel.disabled = false; }
  }
  async function run_(i, target, opts) {
    const r = await setPayStatus(i, target, opts);
    toast(payStatusLabel(target), i.name);
    if (r && r.legacyTreasury) toast(L('امسح حركة الخزينة يدوياً', 'Remove the treasury entry manually'), L('التحويل ده اتسجل من النسخة القديمة ومش مربوط بحركة خزينة معيّنة.', 'This transfer was recorded by the old version and is not linked to a treasury entry.'), 'warn');
  }
  root.addEventListener('change', (e) => { const s = e.target.closest('[data-status]'); if (s) changeStatus(s); });

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
    build: (_, b) => busy(b, async () => { try { await buildRun(month); await loadPrivs(); toast(L('اتحسبت الرواتب', 'Payroll calculated'), L('اللي اتعتمد أو بعده ما اتغيّرش.', 'Approved and later salaries were left unchanged.')); } catch (e) { toastErr(e); } }),
    slip: ({ id }) => openPayslip(items.find(x => x.id === id)),
    edit: ({ id }) => {
      const i = items.find(x => x.id === id);
      const m = modal({
        title: `${L('تعديل', 'Adjust')} — ${i.name}`, icon: 'fa-pen', size: '',
        body: `<form class="form-grid" id="ef">
          <div class="field span-2"><label>${L(`KPI الشهر ده (الكامل ${money(i.kpiFull || 0, false)})`, `This month's KPI (full ${money(i.kpiFull || 0, false)})`)}</label>
            <div class="row gap-8"><select class="select" name="kpiMode" style="max-width:170px"><option value="" ${!i.kpiMode ? 'selected' : ''}>${L('كامل', 'Full')}</option><option value="pct" ${i.kpiMode === 'pct' ? 'selected' : ''}>${L('نسبة %', '%')}</option><option value="amt" ${i.kpiMode === 'amt' ? 'selected' : ''}>${L('قيمة', 'Amount')}</option></select>
              <input class="input num" type="number" min="0" step="0.01" name="kpiValue" value="${esc(i.kpiMode ? i.kpiValue : '')}" style="max-width:140px" ${!i.kpiMode ? 'disabled' : ''}></div></div>
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
      m.$('[name=kpiMode]').onchange = (e) => { const v = m.$('[name=kpiValue]'); v.disabled = !e.target.value; if (!e.target.value) v.value = ''; else v.focus(); };
      m.$('#sv').onclick = (e) => busy(e.currentTarget, async () => {
        const f = m.$('#ef');
        const otherDeductions = [...od.children].map(r => ({ reason: r.querySelector('[data-r]').value.trim(), amount: Number(r.querySelector('[data-a]').value || 0) })).filter(d => d.amount);
        const kpiMode = f.kpiMode.value;
        try { await saveManual(month, i.email, { bonus: Number(f.bonus.value || 0), incentive: Number(f.incentive.value || 0), otherDeductions, note: f.note.value.trim(), kpiMode, kpiValue: kpiMode ? Number(f.kpiValue.value || 0) : null }); m.close(); toast(L('تم الحفظ', 'Saved')); } catch (ex) { toastErr(ex); }
      });
    },
    xls: () => exportSheet(`payroll_${month}`, [{
      name: month, rows: items.map(i => ({
        [L('الموظف', 'Employee')]: i.name, [L('الأساسي', 'Basic')]: i.basic, [L('البدلات', 'Allowances')]: i.allowances, [L('الانتظام', 'Regularity')]: i.regularity || 0, KPI: i.kpi || 0, [L('مكافأة', 'Bonus')]: i.bonus, [L('حوافز', 'Incentive')]: i.incentive,
        [L('الإجمالي', 'Gross')]: i.gross, [L('ثابتة', 'Fixed')]: i.fixed, [L('غياب', 'Absence')]: i.absenceDeduction, [L('بدون أجر', 'Unpaid')]: i.unpaidDeduction, [L('تأخير', 'Late')]: i.lateDeduction,
        [L('أونلاين مرفوض', 'Rejected remote')]: i.remoteDeduction || 0, [L('انصراف مبكر', 'Early leave')]: i.earlyDeduction || 0,
        [L('سلف', 'Advance')]: i.advance, [L('أخرى', 'Other')]: (i.otherDeductions || []).reduce((s, d) => s + d.amount, 0), [L('الصافي', 'Net')]: i.net, [L('الحالة', 'Status')]: payStatusLabel(payStatus(i))
      }))
    }])
  });
  root.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { month = addMonths(month, Number(b.dataset.m)); subscribe(); });
  subscribe();
  loadPrivs();
  drawAdvances();
  return () => unsubs.forEach(u => u());
}
