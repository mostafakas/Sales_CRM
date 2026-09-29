// Approvals inbox (manager / HR / finance) + decided history.
import { L, esc, num, addDays, ymd, money, fmtMonth } from '../core/utils.js';
import { toast, toastErr, confirmDialog, empty, bindActions, busy, modal } from '../core/ui.js';
import { session, now, isHR, isAdmin } from '../core/session.js';
import { REQUEST_TYPES, typeLabel } from '../core/policy.js';
import { watchInbox, watchManaged, decide, revokeRequest, setResponse, getBalance, remaining, advancePlan } from '../services/requests.js';
import { requestCard, showRequestDetails, requestTitle } from './request-card.js';
import { play } from '../core/sounds.js';

export default async function render(root) {
  let inbox = [], history = [], tab = 'inbox', typeF = '', histUnsub = null;
  root.innerHTML = `
    <div class="page-head"><div><h2>${L('الموافقات', 'Approvals')}</h2><p>${L('الطلبات اللي مستنية قرارك، وسجل الطلبات اللي اتقررت.', 'Requests waiting for your decision, and decided history.')}</p></div></div>
    <div class="filters">
      <div class="tabs" id="tabs"><button class="tab active" data-t="inbox">${L('مستنية قرارك', 'Waiting for me')} <span class="num" id="n-inbox"></span></button>
        <button class="tab" data-t="history">${L('السجل (آخر 90 يوم)', 'History (90 days)')}</button></div>
      <select class="select" id="type-f"><option value="">${L('كل الأنواع', 'All types')}</option>${Object.keys(REQUEST_TYPES).map(k => `<option value="${k}">${esc(typeLabel(k))}</option>`).join('')}</select>
    </div>
    <div class="grid g-auto" id="list"></div>`;

  const canDecideOwn = (r) => r.email !== session.email || isAdmin();
  async function balanceHint(r) {
    if (r.type !== 'leave') return '';
    try {
      const b = await getBalance(r.email, Number(r.startDate.slice(0, 4)));
      const t = b.types[r.leaveType];
      return t ? `<div class="xs muted"><i class="fas fa-scale-balanced"></i> ${L('رصيد الموظف المتاح:', 'Employee balance:')} <b class="num">${num(remaining(t), 1)}</b> ${L('يوم', 'days')}</div>` : '';
    } catch { return ''; }
  }
  async function draw() {
    root.querySelector('#n-inbox').textContent = inbox.length ? `(${num(inbox.length)})` : '';
    const src = (tab === 'inbox' ? inbox : history).filter(r => !typeF || r.type === typeF);
    const el = root.querySelector('#list');
    if (!src.length) {
      el.innerHTML = `<div class="card" style="grid-column:1/-1">${tab === 'inbox' ? empty('fa-inbox', L('مفيش طلبات مستنياك', 'Nothing waiting for you'), L('كله تمام 👌', 'All caught up 👌')) : empty('fa-folder-open', L('مفيش سجل', 'No history'))}</div>`;
      return;
    }
    el.innerHTML = src.map(r => {
      let actions = '';
      if (tab === 'inbox') {
        actions = canDecideOwn(r)
          ? `<button class="btn btn-sm btn-danger" data-action="reject" data-id="${esc(r.id)}"><i class="fas fa-xmark"></i> ${L('رفض', 'Reject')}</button>
             <button class="btn btn-sm btn-ok" data-action="approve" data-id="${esc(r.id)}"><i class="fas fa-check"></i> ${L('موافقة', 'Approve')}</button>`
          : `<span class="badge">${L('طلبك الشخصي', 'Your own request')}</span>`;
      } else if (isHR() && r.status === 'approved' && ['leave', 'remote', 'mission'].includes(r.type) && (r.endDate || r.startDate) >= ymd(now())) {
        actions = `<button class="btn btn-sm" data-action="revoke" data-id="${esc(r.id)}"><i class="fas fa-rotate-left"></i> ${L('إلغاء الاعتماد', 'Revoke')}</button>`;
      }
      return `<div data-wrap="${esc(r.id)}">${requestCard(r, { showPerson: true, actions })}</div>`;
    }).join('');
    if (tab === 'inbox') {
      for (const r of src.filter(x => x.type === 'leave')) {
        const hint = await balanceHint(r);
        const card = el.querySelector(`[data-wrap="${CSS.escape(r.id)}"] .req-card`);
        if (card && hint) card.insertAdjacentHTML('beforeend', hint);
      }
    }
  }
  const find = (id) => inbox.find(r => r.id === id) || history.find(r => r.id === id);
  /** Admin: review a salary advance — amount, installments and first month can be changed before approving */
  function approveAdvance(r) {
    const m = modal({
      title: `${L('اعتماد سلفة', 'Approve advance')} — ${r.name}`, icon: 'fa-hand-holding-dollar', size: 'narrow',
      body: `<form class="form-grid" id="af">
          <div class="field span-2"><label>${L('المبلغ (ج.م)', 'Amount (EGP)')}</label><input class="input num" type="number" min="1" step="1" name="amount" value="${esc(r.amount)}"></div>
          <div class="field"><label>${L('عدد الأقساط', 'Installments')}</label><input class="input num" type="number" min="1" max="24" name="installments" value="${esc(r.installments)}"></div>
          <div class="field"><label>${L('أول شهر خصم', 'First month')}</label><input class="input" type="month" name="startMonth" value="${esc(r.startMonth || '')}"></div>
          <div class="span-2 alert info" id="ap"></div>
          ${r.reason ? `<div class="span-2"><div class="label mb-8">${L('السبب', 'Reason')}</div><div class="reason">${esc(r.reason)}</div></div>` : ''}
        </form><p class="xs muted mt-8">${L('لو غيّرت حاجة، التعديل بيتسجل في تاريخ الطلب والموظف بيوصله إشعار بالقيم النهائية.', 'Any change is recorded in the request history and the employee is notified of the final values.')}</p>`,
      foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-ok" id="aok"><i class="fas fa-check"></i> ${L('اعتماد', 'Approve')}</button>`
    });
    const f = m.$('#af');
    const read_ = () => ({ amount: Number(f.amount.value), installments: Math.max(1, Math.min(24, Number(f.installments.value) || 1)), startMonth: f.startMonth.value });
    const draw = () => {
      const v = read_();
      const p = advancePlan(v.amount, v.installments, v.startMonth);
      m.$('#ap').innerHTML = v.amount > 0 && v.startMonth
        ? `<i class="fas fa-calendar-check"></i><span>${L('القسط الشهري:', 'Monthly installment:')} <b class="num">${esc(money(p.perMonth))}</b> · ${esc(fmtMonth(p.startMonth))} ← ${esc(fmtMonth(p.endMonth))}</span>`
        : `<i class="fas fa-circle-info"></i><span>${L('اكتب المبلغ وأول شهر.', 'Enter the amount and first month.')}</span>`;
    };
    f.addEventListener('input', draw); draw();
    m.$('#aok').onclick = (e) => busy(e.currentTarget, async () => {
      const v = read_();
      if (!(v.amount > 0) || !v.startMonth) { f.amount.focus(); return; }
      try { await decide(r.id, 'approve', '', v); play('approved'); m.close(); toast(L('تم اعتماد السلفة', 'Advance approved'), `${r.name} — ${money(v.amount)}`); } catch (ex) { toastErr(ex); }
    });
  }
  bindActions(root, {
    details: ({ id }) => { const r = find(id); if (r) showRequestDetails(r); },
    approve: async ({ id }, btn) => {
      const r = find(id); if (!r) return;
      if (r.type === 'advance' && r.status === 'pending_admin') { approveAdvance(r); return; }
      let note = '';
      if (r.type === 'letter' && r.status === 'pending_hr') {
        note = await confirmDialog({ title: L('اعتماد الخطاب', 'Approve letter'), message: L('اكتب رد للموظف (مثلاً: الخطاب جاهز للاستلام من HR).', 'Write a response to the employee (e.g. the letter is ready for pickup).'), okText: L('اعتماد', 'Approve'), okClass: 'btn-ok', input: { label: L('الرد', 'Response'), required: true } });
        if (note === null) return;
      } else if (r.quotaWarning) {
        const ok = await confirmDialog({ title: L('تخطي الحصة', 'Over quota'), message: L('الطلب ده بيتخطى حصة الأونلاين الشهرية للموظف. توافق برضه؟', 'This exceeds the employee\'s monthly remote quota. Approve anyway?'), okText: L('موافقة', 'Approve'), okClass: 'btn-ok' });
        if (!ok) return;
      }
      await busy(btn, async () => {
        try {
          const res = await decide(id, 'approve', note || '');
          play('approved');
          if (note) await setResponse(id, note);
          toast(res === 'approved' ? L('تم اعتماد الطلب', 'Request approved') : L('اتنقل للمرحلة التالية', 'Moved to next stage'), `${r.name} — ${requestTitle(r)}`);
        } catch (e) { toastErr(e); }
      });
    },
    reject: async ({ id }) => {
      const r = find(id); if (!r) return;
      const note = await confirmDialog({ title: L('رفض الطلب', 'Reject request'), message: `${r.name} — ${requestTitle(r)}`, okText: L('رفض', 'Reject'), okClass: 'btn-danger', input: { label: L('سبب الرفض (هيوصل للموظف)', 'Reason (sent to the employee)'), required: true } });
      if (note === null) return;
      try { await decide(id, 'reject', note); play('rejected'); toast(L('تم رفض الطلب', 'Request rejected')); } catch (e) { toastErr(e); }
    },
    revoke: async ({ id }) => {
      const note = await confirmDialog({ title: L('إلغاء اعتماد', 'Revoke approval'), message: L('الرصيد هيرجع للموظف والأيام هتتشال من الجدول.', 'The balance is returned and the days are removed from the schedule.'), okText: L('إلغاء الاعتماد', 'Revoke'), okClass: 'btn-danger', input: { label: L('السبب', 'Reason'), required: true } });
      if (note === null) return;
      try { await revokeRequest(id, note); toast(L('تم إلغاء الاعتماد', 'Approval revoked')); } catch (e) { toastErr(e); }
    }
  });
  root.querySelectorAll('#tabs .tab').forEach(b => b.onclick = () => {
    tab = b.dataset.t; root.querySelectorAll('#tabs .tab').forEach(x => x.classList.toggle('active', x === b));
    if (tab === 'history' && !histUnsub) {
      root.querySelector('#list').innerHTML = `<div class="page-loader" style="grid-column:1/-1"><span class="spinner"></span></div>`;
      histUnsub = watchManaged(addDays(ymd(now()), -90), rows => { history = rows.filter(r => !String(r.status).startsWith('pending')); if (tab === 'history') draw(); });
    } else draw();
  });
  root.querySelector('#type-f').onchange = (e) => { typeF = e.target.value; draw(); };
  const unsub = watchInbox(rows => { inbox = rows; if (tab === 'inbox') draw(); });
  return () => { unsub && unsub(); histUnsub && histUnsub(); };
}
