// Payroll: monthly run computed from salary data + attendance + advances, with manual adjustments.
// Each employee's salary then moves through: pending → approved (admin) → paid (transfer receipt attached,
// accountant or admin) → sent (payslip published to the employee). Admins may move a salary to any status.
import { db, doc, col, list, query, where, read, writeBatch, serverTimestamp, setDoc, updateDoc, runTransaction } from '../core/fb.js';
import { session, now, isAdmin } from '../core/session.js';
import { policy } from '../core/policy.js';
import { fmtMonth, ymd, L, imageToDataUrl } from '../core/utils.js';
import { userError } from '../core/ui.js';
import { activePeople, person } from './directory.js';
import { teamMonth } from './reports.js';
import { notify } from './notify.js';
import { track } from './activity.js';

export const itemId = (month, email) => `${month}_${email}`;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---------- statuses ----------
export const PAY_ORDER = ['pending', 'approved', 'paid', 'sent'];
export const PAY_STATUS = {
  pending: { ar: 'انتظار', en: 'Pending', cls: 'pending', icon: 'fa-hourglass-half' },
  approved: { ar: 'معتمد', en: 'Approved', cls: 'approved', icon: 'fa-circle-check' },
  paid: { ar: 'تم تحويل الراتب', en: 'Salary transferred', cls: 'paid', icon: 'fa-money-bill-transfer' },
  sent: { ar: 'تم إرسال القسيمة', en: 'Payslip sent', cls: 'sent', icon: 'fa-paper-plane' }
};
export const payStatus = (i) => (i && PAY_ORDER.includes(i.status) ? i.status : 'pending');
export const payStatusLabel = (s) => L(PAY_STATUS[s].ar, PAY_STATUS[s].en);
/** Statuses the signed-in user may move this salary to (admins: any; accountant: the next step after approval) */
export function allowedMoves(i) {
  const cur = payStatus(i);
  if (isAdmin()) return PAY_ORDER.filter(s => s !== cur);
  if (!i || i.email === session.email) return [];
  if (cur === 'approved') return ['paid'];
  if (cur === 'paid') return ['sent'];
  return [];
}

// ---------- calculation ----------
export function computeItem({ person: p, priv, totals, advances, manual = {} }) {
  const sal = (priv && priv.salary) || {};
  const basic = Number(sal.basic) || 0;
  const allowances = (sal.allowances || []).reduce((s, a) => s + (Number(a.amount) || 0), 0);
  const fixed = Number(sal.fixedDeductions) || 0;
  const dayRate = basic / (Number(policy.payrollDayDivisor) || 30);
  const absenceDays = totals ? totals.absent * (Number(policy.absenceDeductDays) || 0) : 0;
  const unpaidDays = totals ? totals.unpaidLeave : 0;
  const lateDays = totals && policy.lateDeductionEnabled ? totals.lateDeductDays : 0;
  const advance = advances.reduce((s, a) => s + a.installment, 0);
  const other = (manual.otherDeductions || []).reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const bonus = Number(manual.bonus) || 0, incentive = Number(manual.incentive) || 0;
  const lines = {
    absence: r2(absenceDays * dayRate), unpaid: r2(unpaidDays * dayRate), late: r2(lateDays * dayRate)
  };
  const gross = r2(basic + allowances + bonus + incentive);
  const deductions = r2(fixed + lines.absence + lines.unpaid + lines.late + advance + other);
  const bank = String((priv && priv.bank) || '').replace(/\s/g, '');
  const payTo = (priv && priv.instapay) ? 'InstaPay' : (bank ? `${L('حساب بنكي', 'Bank account')} •••${bank.slice(-4)}` : '');
  return {
    email: p.email, name: p.name || p.email, title: p.title || '', department: p.department || '', hireDate: p.hireDate || '', payTo,
    basic, allowances: r2(allowances), allowanceLines: sal.allowances || [], bonus, incentive, fixed,
    absenceDays, unpaidDays, lateDays: r2(lateDays), lateMinutes: totals ? totals.lateMinutes : 0, presentDays: totals ? totals.present : 0,
    absenceDeduction: lines.absence, unpaidDeduction: lines.unpaid, lateDeduction: lines.late,
    advance: r2(advance),
    // enough about each advance to explain the installment on the payslip ("installment 2 of 5 — 6,000 left")
    advanceRefs: advances.map(a => ({ id: a.id, amount: a.installment, total: Number(a.amount) || 0, paidBefore: Number(a.paid) || 0, count: Number(a.installments) || 0 })),
    otherDeductions: manual.otherDeductions || [], note: manual.note || '',
    gross, deductions, net: r2(gross - deductions), dayRate: r2(dayRate),
    att: totals ? {
      absent: totals.absent || 0, unpaidLeave: totals.unpaidLeave || 0, lateDeductDays: totals.lateDeductDays || 0, lateMinutes: totals.lateMinutes || 0,
      lateDays: totals.lateDays || 0, present: totals.present || 0, office: totals.office || 0, remote: totals.remote || 0, leave: totals.leave || 0,
      planned: totals.planned || 0, workMs: totals.workMs || 0
    } : null
  };
}

async function activeAdvances(month) {
  const all = await list(query(col('advances'), where('status', '==', 'active'))).catch(() => []);
  return all.filter(a => (a.startMonth || '') <= month).map(a => {
    const left = r2((Number(a.amount) || 0) - (Number(a.paid) || 0));
    return { ...a, installment: r2(Math.min(left, Number(a.perMonth) || left)) };
  }).filter(a => a.installment > 0);
}

/** Build (or rebuild) the month. Only salaries still "pending" are recalculated; manual fields are kept. */
export async function buildRun(month) {
  if (!isAdmin()) throw userError('إعادة الحساب للأدمن بس.', 'Only admins can recalculate payroll.');
  const run = await read('payroll_runs', month);
  if (run && run.status === 'closed') throw userError('ده أرشيف رواتب من السيستم القديم ومينفعش يتحسب تاني.', 'This is a legacy payroll archive and cannot be recalculated.');
  const people = activePeople().filter(p => !p.isSuspended);
  const [privs, existing, att, advs] = await Promise.all([
    list(col('employees_private')), list(query(col('payroll_items'), where('month', '==', month))),
    teamMonth(month, { people }), activeAdvances(month)
  ]);
  const b = writeBatch(db);
  let count = 0;
  for (const p of people) {
    const priv = privs.find(x => x.id === p.email) || {};
    if (priv.contract === 'freelancer') continue;
    const old = existing.find(x => x.email === p.email) || {};
    if (old.status && payStatus(old) !== 'pending') continue; // approved / transferred / sent are frozen
    const totals = (att.people.find(x => x.person.email === p.email) || {}).totals;
    const item = computeItem({ person: p, priv, totals, advances: advs.filter(a => a.email === p.email), manual: old });
    b.set(doc(db, 'payroll_items', itemId(month, p.email)), { ...item, month, status: 'pending', published: false, updatedAt: serverTimestamp() });
    count++;
  }
  b.set(doc(db, 'payroll_runs', month), { month, status: 'draft', builtBy: session.email, builtAt: serverTimestamp() }, { merge: true });
  await b.commit();
  track('payroll.build', { target: month, detail: `${count}` });
}

export async function saveManual(month, email, manual) {
  if (!isAdmin()) throw userError('تعديل الراتب للأدمن بس.', 'Only admins can adjust salaries.');
  const it = await read('payroll_items', itemId(month, email));
  if (['paid', 'sent'].includes(payStatus(it))) throw userError('الراتب ده اتحوّل بالفعل. رجّعه «معتمد» الأول عشان تعدّله.', 'This salary was already transferred. Move it back to "Approved" to edit it.');
  const p = person(email) || { email, name: it.name };
  const priv = await read('employees_private', email).catch(() => ({})) || {};
  const totals = it.att || null; // attendance numbers captured when the run was built
  const advances = (it.advanceRefs || []).map(a => ({ id: a.id, installment: a.amount, amount: a.total, paid: a.paidBefore, installments: a.count }));
  const next = computeItem({ person: p, priv, totals, advances, manual });
  await updateDoc(doc(db, 'payroll_items', itemId(month, email)), { ...next, updatedAt: serverTimestamp(), editedBy: session.email });
}

// ---------- transfer receipt (stored in Firestore chunks, like chat files) ----------
export const MAX_PROOF = 5 * 1024 * 1024;
const CHUNK = 700000;
const readAsDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });

async function uploadProof(item, file, note, onProgress) {
  if (!file) throw userError('ارفق إيصال التحويل (صورة أو ملف).', 'Attach the transfer receipt (image or file).');
  const isImg = /^image\/(png|jpe?g|webp|bmp)$/i.test(file.type);
  let dataUrl, mime = file.type || 'application/octet-stream', thumb = '';
  if (isImg) {
    dataUrl = await imageToDataUrl(file, 1800, 0.85);
    thumb = await imageToDataUrl(file, 360, 0.7);
    mime = 'image/jpeg';
  } else {
    if (file.size > MAX_PROOF) throw userError('الملف أكبر من 5 ميجا.', 'The file is larger than 5 MB.');
    dataUrl = await readAsDataUrl(file);
  }
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const size = Math.round(b64.length * 0.75);
  if (size > MAX_PROOF) throw userError('الملف أكبر من 5 ميجا.', 'The file is larger than 5 MB.');
  const chunks = Math.ceil(b64.length / CHUNK) || 1;
  const pref = doc(col('payroll_proofs'));
  const name = String(file.name || (isImg ? 'receipt.jpg' : 'receipt')).slice(0, 180);
  await setDoc(pref, { itemId: item.id, email: item.email, month: item.month, by: session.email, name, mime, size, chunks, at: serverTimestamp() });
  for (let i = 0; i < chunks; i++) {
    await setDoc(doc(db, `payroll_proofs/${pref.id}/chunks`, String(i)), { i, data: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
    onProgress && onProgress((i + 1) / chunks);
  }
  return { id: pref.id, name, mime, size, ...(thumb ? { thumb } : {}), note: String(note || '').trim().slice(0, 300) };
}
const proofCache = new Map();
/** The receipt as an object URL */
export async function loadProof(meta) {
  if (proofCache.has(meta.id)) return proofCache.get(meta.id);
  const info = await read('payroll_proofs', meta.id);
  if (!info) throw userError('الإيصال مش موجود.', 'Receipt not found.');
  const parts = await list(col(`payroll_proofs/${meta.id}/chunks`));
  const b64 = parts.sort((a, b) => Number(a.i ?? a.id) - Number(b.i ?? b.id)).map(p => p.data).join('');
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr], { type: info.mime || meta.mime }));
  proofCache.set(meta.id, url);
  return url;
}

// ---------- status changes ----------
const treasuryIdOf = (item) => `salary_${item.id}`;

/** Transfer: receipt + treasury entry + advance installments, all at once. */
async function payItem(item, { file, note, onProgress }) {
  const proof = await uploadProof(item, file, note, onProgress);
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'payroll_items', item.id);
    const snap = await tx.get(ref);
    const cur = snap.data();
    if (!cur) throw userError('الراتب مش موجود.', 'Salary not found.');
    if (['paid', 'sent'].includes(payStatus(cur))) throw userError('الراتب ده اتسجل تحويله بالفعل.', 'This salary was already transferred.');
    const advSnaps = [];
    for (const a of (cur.advanceRefs || [])) advSnaps.push([a, await tx.get(doc(db, 'advances', a.id))]);
    const advancePaid = [];
    advSnaps.forEach(([a, s]) => {
      if (!s.exists()) return;
      const d = s.data(); const paid = r2((Number(d.paid) || 0) + a.amount);
      tx.update(doc(db, 'advances', a.id), { paid, status: paid >= Number(d.amount) - 0.01 ? 'settled' : 'active', updatedAt: serverTimestamp() });
      advancePaid.push({ id: a.id, amount: a.amount });
    });
    tx.set(doc(db, 'treasury', treasuryIdOf(item)), { type: 'salary', amount: cur.net, title: `راتب ${fmtMonth(cur.month)} — ${cur.name}`, email: cur.email, month: cur.month, date: ymd(now()), by: session.email, at: serverTimestamp() });
    const upd = { status: 'paid', paidAt: serverTimestamp(), paidBy: session.email, proof, treasuryId: treasuryIdOf(item), advancePaid, updatedAt: serverTimestamp() };
    if (payStatus(cur) === 'pending') Object.assign(upd, { approvedAt: serverTimestamp(), approvedBy: session.email }); // admin skipping ahead
    tx.update(ref, upd);
  });
}

/** Admin: undo a transfer (treasury entry removed, advance installments returned). */
async function unpayItem(item) {
  let legacy = false;
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'payroll_items', item.id);
    const cur = (await tx.get(ref)).data();
    const advSnaps = [];
    for (const a of (cur.advancePaid || [])) advSnaps.push([a, await tx.get(doc(db, 'advances', a.id))]);
    advSnaps.forEach(([a, s]) => {
      if (!s.exists()) return;
      const paid = Math.max(0, r2((Number(s.data().paid) || 0) - a.amount));
      tx.update(doc(db, 'advances', a.id), { paid, status: 'active', updatedAt: serverTimestamp() });
    });
    if (cur.treasuryId) tx.delete(doc(db, 'treasury', cur.treasuryId)); else legacy = true;
    tx.update(ref, { status: 'approved', published: false, paidAt: null, paidBy: '', proof: null, treasuryId: '', advancePaid: [], sentAt: null, sentBy: '', updatedAt: serverTimestamp() });
  });
  return legacy;
}

/**
 * Move one salary to `target`. Reaching "paid" from before needs { file, note } (the transfer receipt).
 * Returns { legacyTreasury } when an old-system payment had no treasury link to undo.
 */
export async function setPayStatus(item, target, opts = {}) {
  const cur = payStatus(item);
  if (target === cur) return {};
  if (!allowedMoves(item).includes(target)) throw userError('مش مسموح لك تغيّر الحالة دي.', 'You are not allowed to make this change.');
  const ci = PAY_ORDER.indexOf(cur), ti = PAY_ORDER.indexOf(target);
  const ref = doc(db, 'payroll_items', item.id);
  let legacyTreasury = false;
  if (ci < 2 && ti >= 2) await payItem(item, opts);
  if (ci >= 2 && ti < 2) legacyTreasury = await unpayItem(item);
  if (target === 'pending' || target === 'approved') {
    await updateDoc(ref, { status: target, published: false, ...(target === 'approved' ? { approvedAt: serverTimestamp(), approvedBy: session.email } : {}), updatedAt: serverTimestamp() });
  } else if (target === 'sent') {
    await updateDoc(ref, { status: 'sent', published: true, sentAt: serverTimestamp(), sentBy: session.email, updatedAt: serverTimestamp() });
    notify(item.email, `قسيمة راتب ${fmtMonth(item.month)} وصلت`, `صافي الراتب ${item.net}`, '#/payslips', 'approved');
  } else if (target === 'paid' && ci === 3) {
    await updateDoc(ref, { status: 'paid', published: false, sentAt: null, sentBy: '', updatedAt: serverTimestamp() });
  }
  track('payroll.status', { target: item.email, detail: `${item.month}: ${PAY_STATUS[cur].ar} → ${PAY_STATUS[target].ar}` });
  return { legacyTreasury };
}

/** Advance paid out in cash from treasury (when finance approves an advance request) */
export async function recordAdvancePayout(adv) {
  await setDoc(doc(db, 'treasury', `advance_${adv.id}`), { type: 'advance', amount: adv.amount, title: `سلفة — ${adv.name || adv.email}`, email: adv.email, month: ymd(now()).slice(0, 7), date: ymd(now()), by: session.email, at: serverTimestamp() });
  await updateDoc(doc(db, 'advances', adv.id), { paidOut: true });
}
