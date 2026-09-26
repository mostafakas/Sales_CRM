// My requests: list, filter, cancel, details, new request.
import { L, esc, num } from '../core/utils.js';
import { toast, toastErr, confirmDialog, empty, bindActions } from '../core/ui.js';
import { REQUEST_TYPES, typeLabel } from '../core/policy.js';
import { watchMyRequests, cancelRequest } from '../services/requests.js';
import { requestCard, showRequestDetails } from './request-card.js';
import { openRequestForm } from './request-form.js';

export default async function render(root) {
  let rows = [], tab = 'all', typeF = '';
  root.innerHTML = `
    <div class="page-head">
      <div><h2>${L('طلباتي', 'My requests')}</h2><p>${L('كل طلباتك وحالتها ومسار الموافقة.', 'All your requests, their status and approval path.')}</p></div>
      <button class="btn btn-primary" id="new-btn"><i class="fas fa-plus"></i> ${L('طلب جديد', 'New request')}</button>
    </div>
    <div class="filters">
      <div class="tabs" id="tabs">
        <button class="tab active" data-t="all">${L('الكل', 'All')} <span class="num" data-c="all"></span></button>
        <button class="tab" data-t="pending">${L('قيد المراجعة', 'Pending')} <span class="num" data-c="pending"></span></button>
        <button class="tab" data-t="approved">${L('معتمد', 'Approved')} <span class="num" data-c="approved"></span></button>
        <button class="tab" data-t="closed">${L('مرفوض / ملغي', 'Rejected / cancelled')} <span class="num" data-c="closed"></span></button>
      </div>
      <select class="select" id="type-f"><option value="">${L('كل الأنواع', 'All types')}</option>${Object.keys(REQUEST_TYPES).map(k => `<option value="${k}">${esc(typeLabel(k))}</option>`).join('')}</select>
    </div>
    <div class="grid g-auto" id="list"></div>`;
  root.querySelector('#new-btn').onclick = () => openRequestForm();
  root.querySelector('#type-f').onchange = (e) => { typeF = e.target.value; draw(); };
  root.querySelectorAll('#tabs .tab').forEach(b => b.onclick = () => {
    tab = b.dataset.t; root.querySelectorAll('#tabs .tab').forEach(x => x.classList.toggle('active', x === b)); draw();
  });
  const match = (r) => tab === 'all' || (tab === 'pending' && String(r.status).startsWith('pending')) || (tab === 'approved' && r.status === 'approved') || (tab === 'closed' && ['rejected', 'cancelled'].includes(r.status));
  function draw() {
    ['all', 'pending', 'approved', 'closed'].forEach(t => {
      const n = rows.filter(r => t === 'all' || (t === 'pending' && String(r.status).startsWith('pending')) || (t === 'approved' && r.status === 'approved') || (t === 'closed' && ['rejected', 'cancelled'].includes(r.status))).length;
      const el = root.querySelector(`[data-c="${t}"]`); if (el) el.textContent = n ? `(${num(n)})` : '';
    });
    const list = rows.filter(r => match(r) && (!typeF || r.type === typeF));
    root.querySelector('#list').innerHTML = list.length
      ? list.map(r => requestCard(r, { actions: String(r.status).startsWith('pending') ? `<button class="btn btn-sm" data-action="cancel" data-id="${esc(r.id)}"><i class="fas fa-ban"></i> ${L('إلغاء', 'Cancel')}</button>` : '' })).join('')
      : `<div class="card" style="grid-column:1/-1">${empty('fa-paper-plane', L('مفيش طلبات هنا', 'No requests here'), L('اضغط «طلب جديد» عشان تبدأ.', 'Click "New request" to start.'))}</div>`;
  }
  bindActions(root, {
    details: ({ id }) => { const r = rows.find(x => x.id === id); if (r) showRequestDetails(r); },
    cancel: async ({ id }) => {
      const ok = await confirmDialog({ title: L('إلغاء الطلب', 'Cancel request'), message: L('متأكد إنك عايز تلغي الطلب ده؟', 'Cancel this request?'), okText: L('إلغاء الطلب', 'Cancel request'), okClass: 'btn-danger', cancelText: L('رجوع', 'Back') });
      if (!ok) return;
      try { await cancelRequest(id); toast(L('تم إلغاء الطلب', 'Request cancelled')); } catch (e) { toastErr(e); }
    }
  });
  const unsub = watchMyRequests(r => { rows = r; draw(); });
  return () => unsub && unsub();
}
