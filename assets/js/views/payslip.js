// Branded, printable payslip.
import { L, esc, money, fmtMonth, fmtMin, num, fmtDate } from '../core/utils.js';
import { modal } from '../core/ui.js';

export function payslipHTML(i) {
  const row = (label, v, neg) => `<tr><td>${esc(label)}</td><td class="num" style="color:${neg ? 'var(--bad)' : 'inherit'}">${neg ? '−' : ''}${esc(money(v, false))}</td></tr>`;
  const earnings = [
    [L('الراتب الأساسي', 'Basic salary'), i.basic],
    ...((i.allowanceLines || []).length ? i.allowanceLines.map(a => [a.name || L('بدل', 'Allowance'), a.amount]) : (i.allowances ? [[L('البدلات', 'Allowances'), i.allowances]] : [])),
    ...(i.bonus ? [[L('مكافأة', 'Bonus'), i.bonus]] : []), ...(i.incentive ? [[L('حوافز', 'Incentive'), i.incentive]] : [])
  ];
  const deds = [
    ...(i.fixed ? [[L('خصومات ثابتة (تأمينات...)', 'Fixed deductions'), i.fixed]] : []),
    ...(i.absenceDeduction ? [[L(`غياب (${num(i.absenceDays, 1)} يوم)`, `Absence (${num(i.absenceDays, 1)} d)`), i.absenceDeduction]] : []),
    ...(i.unpaidDeduction ? [[L(`إجازة بدون أجر (${num(i.unpaidDays)} يوم)`, `Unpaid leave (${num(i.unpaidDays)} d)`), i.unpaidDeduction]] : []),
    ...(i.lateDeduction ? [[L(`تأخير (${fmtMin(i.lateMinutes)})`, `Lateness (${fmtMin(i.lateMinutes)})`), i.lateDeduction]] : []),
    ...(i.advance ? [[L('قسط سلفة', 'Advance installment'), i.advance]] : []),
    ...((i.otherDeductions || []).map(d => [d.reason || L('خصم', 'Deduction'), d.amount]))
  ];
  return `<div class="payslip">
    <div class="print-head" style="display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid var(--brand);padding-bottom:12px;margin-bottom:16px">
      <img src="assets/img/logo-full.png" alt="AL MASTER" style="height:26px;width:auto">
      <div style="text-align:end"><b>${L('قسيمة راتب', 'Payslip')}</b><div class="small muted">${esc(fmtMonth(i.month))}</div></div></div>
    <div class="row between mb-16" style="flex-wrap:wrap;gap:8px"><div><b style="font-size:16px">${esc(i.name)}</b><div class="small muted">${esc(i.title || '')}${i.department ? ' · ' + esc(i.department) : ''}</div></div>
      <div class="small muted" style="text-align:end">${L('أيام حضور:', 'Days present:')} <b class="num">${num(i.presentDays || (i.att && i.att.present) || 0)}</b>${i.status === 'paid' ? ` · <span class="badge ok">${L('تم التحويل', 'Paid')}</span>` : ''}</div></div>
    <div class="grid g-2">
      <div><div class="label mb-8" style="color:var(--ok)">${L('المستحقات', 'Earnings')}</div><table class="table"><tbody>${earnings.map(([l, v]) => row(l, v)).join('')}
        <tr><td><b>${L('الإجمالي', 'Gross')}</b></td><td class="num"><b>${esc(money(i.gross, false))}</b></td></tr></tbody></table></div>
      <div><div class="label mb-8" style="color:var(--bad)">${L('الاستقطاعات', 'Deductions')}</div><table class="table"><tbody>${deds.length ? deds.map(([l, v]) => row(l, v, true)).join('') : `<tr><td colspan="2" class="muted">${L('لا يوجد', 'None')}</td></tr>`}
        <tr><td><b>${L('إجمالي الاستقطاعات', 'Total deductions')}</b></td><td class="num"><b>${esc(money(i.deductions, false))}</b></td></tr></tbody></table></div>
    </div>
    <div class="hero mt-16" style="padding:18px 22px"><div class="row between"><span>${L('صافي الراتب', 'Net pay')}</span><b class="num" style="font-size:26px">${esc(money(i.net))}</b></div></div>
    ${i.note ? `<p class="small muted mt-16">${esc(i.note)}</p>` : ''}
    <div class="print-only" style="margin-top:48px"><div class="row between"><div style="text-align:center"><div style="border-bottom:1px solid #999;width:180px;height:30px"></div><span class="xs">${L('توقيع الموظف', 'Employee signature')}</span></div><div style="text-align:center"><div style="border-bottom:1px solid #999;width:180px;height:30px"></div><span class="xs">${L('الموارد البشرية / المالية', 'HR / Finance')}</span></div></div>
      <p class="xs muted" style="margin-top:24px;text-align:center">AL MASTER TECHNOLOGY · almaster.tech · ${esc(fmtDate(Date.now()))}</p></div>
  </div>`;
}
export function openPayslip(item) {
  const m = modal({
    title: `${L('قسيمة راتب', 'Payslip')} — ${fmtMonth(item.month)}`, icon: 'fa-receipt', size: 'wide',
    body: payslipHTML(item),
    foot: `<button class="btn" data-close>${L('إغلاق', 'Close')}</button><button class="btn btn-primary" id="pp"><i class="fas fa-print"></i> ${L('طباعة / PDF', 'Print / PDF')}</button>`
  });
  m.$('#pp').onclick = () => {
    document.body.classList.add('printing-modal');
    setTimeout(() => { window.print(); document.body.classList.remove('printing-modal'); }, 50);
  };
  return m;
}
