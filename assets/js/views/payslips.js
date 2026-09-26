import { L, esc, money, fmtMonth } from '../core/utils.js';
import { empty } from '../core/ui.js';
import { session } from '../core/session.js';
import { watch, query, col, where } from '../core/fb.js';
import { openPayslip } from './payslip.js';

export default async function render(root) {
  root.innerHTML = `<div class="page-head"><div><h2>${L('قسائم الراتب', 'Payslips')}</h2><p>${L('بتظهر هنا بعد ما المالية تعتمد رواتب الشهر.', 'They appear here once finance approves the month.')}</p></div></div><div class="grid g-auto" id="list"></div>`;
  const unsub = watch(query(col('payroll_items'), where('email', '==', session.email), where('published', '==', true)), rows => {
    rows.sort((a, b) => b.month.localeCompare(a.month));
    const el = root.querySelector('#list');
    el.innerHTML = rows.length ? rows.map(i => `<button class="card card-pad hover" data-id="${esc(i.id)}" style="text-align:start;cursor:pointer;font-family:inherit;color:inherit">
      <div class="row between"><span class="icon-tile ok"><i class="fas fa-receipt"></i></span><span class="badge ${i.status === 'paid' ? 'ok' : 'warn'}">${i.status === 'paid' ? L('تم التحويل', 'Paid') : L('معتمد', 'Approved')}</span></div>
      <div class="mt-16 muted small">${esc(fmtMonth(i.month))}</div><div class="num" style="font-size:24px;font-weight:700">${esc(money(i.net))}</div></button>`).join('')
      : `<div class="card" style="grid-column:1/-1">${empty('fa-receipt', L('مفيش قسائم لسه', 'No payslips yet'))}</div>`;
    el.querySelectorAll('[data-id]').forEach(b => b.onclick = () => openPayslip(rows.find(r => r.id === b.dataset.id)));
  });
  return unsub;
}
