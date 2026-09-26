// Finance: treasury ledger (deposits & expenses), categories, freelancers.
import { L, esc, money, num, fmtMonth, addMonths, ym as ymOf, ymd, fmtDate, imageToDataUrl } from '../core/utils.js';
import { toast, toastErr, modal, empty, busy, bindActions, confirmDialog, avatar } from '../core/ui.js';
import { session, now, isAdmin } from '../core/session.js';
import { watch, col, db, doc, setDoc, addDoc, deleteDoc, updateDoc, serverTimestamp, list, query, where, read } from '../core/fb.js';
import { person, allPeople } from '../services/directory.js';
import { exportSheet } from './export.js';

const CATS = {
  deposit: ['إيداع', 'Deposit'], salary: ['رواتب', 'Salaries'], advance: ['سلف', 'Advances'], freelancer: ['فريلانسرز', 'Freelancers'],
  rent: ['إيجار', 'Rent'], utilities: ['مرافق وإنترنت', 'Utilities & internet'], marketing: ['تسويق', 'Marketing'], equipment: ['أجهزة ومعدات', 'Equipment'],
  expense: ['مصروفات عامة', 'General expenses'], other: ['أخرى', 'Other']
};
const catLabel = (k) => L(...(CATS[k] || [k, k]));
const OUT_CATS = ['expense', 'rent', 'utilities', 'marketing', 'equipment', 'other'];

export default async function render(root) {
  let month = ymOf(now()), all = [], tab = 'ledger';
  root.innerHTML = `
    <div class="page-head"><div><h2>${L('الخزينة والمصروفات', 'Treasury & expenses')}</h2></div>
      <div class="row gap-8"><button class="btn btn-icon" data-m="-1"><i class="fas fa-chevron-right" data-flip></i></button><b id="ml" style="min-width:130px;text-align:center"></b><button class="btn btn-icon" data-m="1"><i class="fas fa-chevron-left" data-flip></i></button></div></div>
    <div class="grid g-4 keep-2 mb-16" id="kpi"></div>
    <div class="filters"><div class="tabs" id="tt"><button class="tab active" data-t="ledger">${L('دفتر الحركات', 'Ledger')}</button><button class="tab" data-t="cats">${L('حسب البند', 'By category')}</button><button class="tab" data-t="fl">${L('الفريلانسرز', 'Freelancers')}</button></div>
      <div class="grow"></div>
      <button class="btn btn-ok" data-action="add" data-kind="in"><i class="fas fa-plus"></i> ${L('إيداع', 'Deposit')}</button>
      <button class="btn btn-danger" data-action="add" data-kind="out"><i class="fas fa-minus"></i> ${L('مصروف', 'Expense')}</button>
      <button class="btn" data-action="xls"><i class="fas fa-file-excel"></i></button></div>
    <div id="body"></div>`;
  const isIn = (t) => t.type === 'deposit';
  function draw() {
    root.querySelector('#ml').textContent = fmtMonth(month);
    const before = all.filter(t => (t.month || '') < month);
    const cur = all.filter(t => t.month === month);
    const bal = (arr) => arr.reduce((s, t) => s + (isIn(t) ? 1 : -1) * (Number(t.amount) || 0), 0);
    const opening = bal(before), inflow = cur.filter(isIn).reduce((s, t) => s + (Number(t.amount) || 0), 0), outflow = cur.filter(t => !isIn(t)).reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const k = (icon, cls, label, v) => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value" style="font-size:20px">${esc(money(v))}</div></div>`;
    root.querySelector('#kpi').innerHTML = k('fa-flag', 'neutral', L('رصيد أول الشهر', 'Opening balance'), opening) + k('fa-arrow-down', 'ok', L('إيداعات', 'Inflows'), inflow) + k('fa-arrow-up', 'bad', L('منصرف', 'Outflows'), outflow) + k('fa-vault', '', L('رصيد آخر الشهر', 'Closing balance'), opening + inflow - outflow);
    const body = root.querySelector('#body');
    if (tab === 'ledger') {
      const rows = cur.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || ((b.at && b.at.seconds) || 0) - ((a.at && a.at.seconds) || 0));
      body.innerHTML = `<div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>${L('التاريخ', 'Date')}</th><th>${L('البند', 'Category')}</th><th>${L('البيان', 'Description')}</th><th class="num">${L('وارد', 'In')}</th><th class="num">${L('منصرف', 'Out')}</th><th></th></tr></thead><tbody>
        ${rows.length ? rows.map(t => `<tr><td class="num nowrap">${esc(fmtDate(t.date))}</td><td><span class="badge ${isIn(t) ? 'ok' : ''}">${esc(catLabel(t.type))}</span></td><td>${esc(t.title || '')}${t.email && !['salary', 'freelancer', 'advance'].includes(t.type) ? `<div class="xs muted">${esc((person(t.email) || {}).name || t.email)}</div>` : ''}</td>
          <td class="num" style="color:var(--ok)">${isIn(t) ? esc(money(t.amount, false)) : ''}</td><td class="num" style="color:var(--bad)">${!isIn(t) ? esc(money(t.amount, false)) : ''}</td>
          <td style="text-align:end;white-space:nowrap">${t.attachmentId ? `<button class="btn btn-ghost btn-sm btn-icon" data-action="receipt" data-id="${esc(t.attachmentId)}" title="${L('الإيصال', 'Receipt')}"><i class="fas fa-paperclip"></i></button>` : ''}${(t.by === session.email || isAdmin()) && !['salary'].includes(t.type) ? `<button class="btn btn-ghost btn-sm btn-icon" data-action="del" data-id="${esc(t.id)}" title="${L('حذف', 'Delete')}"><i class="fas fa-trash"></i></button>` : ''}</td></tr>`).join('')
          : `<tr><td colspan="6">${empty('fa-vault', L('مفيش حركات الشهر ده', 'No movements this month'))}</td></tr>`}</tbody></table></div></div>`;
    } else if (tab === 'cats') {
      const out = cur.filter(t => !isIn(t));
      const by = {}; out.forEach(t => { by[t.type] = (by[t.type] || 0) + (Number(t.amount) || 0); });
      const max = Math.max(1, ...Object.values(by));
      body.innerHTML = `<div class="card card-pad">${Object.keys(by).length ? `<div class="bars">${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<div class="bar-row"><span class="truncate">${esc(catLabel(c))}</span><div class="track"><div class="fill ${c === 'salary' ? '' : 'warn'}" style="width:${(v / max * 100).toFixed(1)}%"></div></div><b class="num">${esc(money(v, false))}</b></div>`).join('')}</div>` : empty('fa-chart-bar', L('مفيش مصروفات', 'No expenses'))}</div>`;
    } else drawFreelancers(body);
  }
  async function drawFreelancers(body) {
    const privs = await list(query(col('employees_private'), where('contract', '==', 'freelancer'))).catch(() => []);
    body.innerHTML = `<div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>${L('الفريلانسر', 'Freelancer')}</th><th class="num">${L('المتفق عليه', 'Agreed')}</th><th class="num">${L('اتدفع', 'Paid')}</th><th class="num">${L('المتبقي', 'Remaining')}</th><th></th></tr></thead><tbody>
      ${privs.length ? privs.map(p => {
        const u = person(p.id) || { name: p.id, email: p.id };
        const paid = all.filter(t => t.type === 'freelancer' && t.email === p.id).reduce((s, t) => s + (Number(t.amount) || 0), 0);
        const credit = Number(p.flCredit) || 0;
        return `<tr><td><div class="person">${avatar(u, 'sm')}<div><b>${esc(u.name)}</b><span>${esc(u.title || '')}</span></div></div></td><td class="num">${esc(money(credit, false))}</td><td class="num">${esc(money(paid, false))}</td><td class="num"><b>${esc(money(credit - paid, false))}</b></td>
          <td style="text-align:end"><button class="btn btn-sm" data-action="flcredit" data-email="${esc(p.id)}" data-credit="${credit}">${L('تعديل المتفق', 'Edit agreed')}</button> <button class="btn btn-sm btn-ok" data-action="flpay" data-email="${esc(p.id)}">${L('دفعة', 'Pay')}</button></td></tr>`;
      }).join('') : `<tr><td colspan="5">${empty('fa-user-tie', L('مفيش فريلانسرز', 'No freelancers'), L('غيّر نوع التعاقد لـ «فريلانسر» من ملف الموظف.', 'Set contract to "Freelancer" in the employee editor.'))}</td></tr>`}</tbody></table></div></div>`;
  }
  function entryModal(kind, preset = {}) {
    const cats = kind === 'in' ? ['deposit'] : (preset.type ? [preset.type] : OUT_CATS);
    const m = modal({
      title: kind === 'in' ? L('إيداع في الخزينة', 'Deposit') : L('تسجيل مصروف', 'Record expense'), icon: kind === 'in' ? 'fa-arrow-down' : 'fa-arrow-up', size: 'narrow',
      body: `<form class="col gap-16" id="tf">
        ${cats.length > 1 ? `<div class="field"><label>${L('البند', 'Category')}</label><select class="select" name="type">${cats.map(c => `<option value="${c}">${esc(catLabel(c))}</option>`).join('')}</select></div>` : `<input type="hidden" name="type" value="${cats[0]}">`}
        <div class="field"><label>${L('المبلغ (ج.م)', 'Amount (EGP)')}</label><input class="input num" type="number" min="0.01" step="0.01" name="amount" required></div>
        <div class="field"><label>${L('البيان', 'Description')}</label><input class="input" name="title" value="${esc(preset.title || '')}" required></div>
        <div class="field"><label>${L('التاريخ', 'Date')}</label><input class="input" type="date" name="date" value="${ymd(now())}"></div>
        <label class="dropzone"><input type="file" accept="image/*" hidden name="file"><i class="fas fa-paperclip"></i> <span id="fn">${L('إرفاق إيصال (اختياري)', 'Attach receipt (optional)')}</span></label></form>`,
      foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="ok">${L('حفظ', 'Save')}</button>`
    });
    let file = null;
    m.$('[name=file]').onchange = async (e) => { try { file = await imageToDataUrl(e.target.files[0], 1400, 0.7); m.$('#fn').textContent = e.target.files[0].name; } catch { toast(L('صورة غير صالحة', 'Invalid image'), '', 'bad'); } };
    m.$('#ok').onclick = (e) => busy(e.currentTarget, async () => {
      const f = m.$('#tf'); const amount = Number(f.amount.value);
      if (!(amount > 0) || !f.title.value.trim()) { f.amount.focus(); return; }
      try {
        let attachmentId = null;
        if (file) { const a = await addDoc(col('attachments'), { owner: session.email, kind: 'receipt', name: 'receipt.jpg', data: file, createdAt: serverTimestamp() }); attachmentId = a.id; }
        const date = f.date.value || ymd(now());
        await addDoc(col('treasury'), { type: f.type.value, amount, title: f.title.value.trim(), date, month: date.slice(0, 7), email: preset.email || '', attachmentId, by: session.email, at: serverTimestamp() });
        m.close(); toast(L('اتسجلت', 'Recorded'));
      } catch (ex) { toastErr(ex); }
    });
  }
  bindActions(root, {
    add: ({ kind }) => entryModal(kind),
    del: async ({ id }) => {
      const ok = await confirmDialog({ title: L('حذف الحركة', 'Delete entry'), message: L('الحركة هتتمسح من الدفتر والرصيد هيتعدل.', 'The entry is removed and the balance adjusts.'), okClass: 'btn-danger', okText: L('حذف', 'Delete') });
      if (!ok) return;
      try { const t = all.find(x => x.id === id); await deleteDoc(doc(db, 'treasury', id)); await addDoc(col('audit_log'), { action: 'treasury.delete', target: id, detail: t ? `${t.title} ${t.amount}` : '', by: session.email, at: serverTimestamp() }); } catch (e) { toastErr(e); }
    },
    receipt: async ({ id }) => { try { const a = await read('attachments', id); if (a) modal({ title: L('الإيصال', 'Receipt'), body: `<img src="${esc(a.data)}" alt="" style="border-radius:12px">` }); } catch (e) { toastErr(e); } },
    flpay: ({ email }) => entryModal('out', { type: 'freelancer', email, title: `${L('دفعة', 'Payment')} — ${(person(email) || {}).name || email}` }),
    flcredit: async ({ email, credit }) => {
      const v = await confirmDialog({ title: L('المبلغ المتفق عليه', 'Agreed amount'), message: (person(email) || {}).name || email, input: { label: L('المبلغ (ج.م)', 'Amount (EGP)'), placeholder: credit, required: true } });
      if (v === null || isNaN(Number(v))) return;
      try { await setDoc(doc(db, 'employees_private', email), { flCredit: Number(v) }, { merge: true }); draw(); } catch (e) { toastErr(e); }
    },
    xls: () => exportSheet(`treasury_${month}`, [{ name: month, rows: all.filter(t => t.month === month).map(t => ({ [L('التاريخ', 'Date')]: t.date, [L('البند', 'Category')]: catLabel(t.type), [L('البيان', 'Description')]: t.title, [L('وارد', 'In')]: isIn(t) ? t.amount : '', [L('منصرف', 'Out')]: isIn(t) ? '' : t.amount })) }])
  });
  root.querySelectorAll('#tt .tab').forEach(b => b.onclick = () => { tab = b.dataset.t; root.querySelectorAll('#tt .tab').forEach(x => x.classList.toggle('active', x === b)); draw(); });
  root.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { month = addMonths(month, Number(b.dataset.m)); draw(); });
  const unsub = watch(col('treasury'), rows => { all = rows; draw(); });
  return unsub;
}
