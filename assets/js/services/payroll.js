// Payroll: monthly run computed from salary data + attendance + advances, with manual adjustments.
import { db, doc, col, list, query, where, read, writeBatch, serverTimestamp, setDoc, updateDoc, runTransaction } from '../core/fb.js';
import { session, now } from '../core/session.js';
import { policy } from '../core/policy.js';
import { fmtMonth } from '../core/utils.js';
import { activePeople, person } from './directory.js';
import { teamMonth } from './reports.js';
import { notify } from './notify.js';
import { track } from './activity.js';

export const itemId = (month, email) => `${month}_${email}`;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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
  return {
    email: p.email, name: p.name || p.email, title: p.title || '', department: p.department || '',
    basic, allowances: r2(allowances), allowanceLines: sal.allowances || [], bonus, incentive, fixed,
    absenceDays, unpaidDays, lateDays: r2(lateDays), lateMinutes: totals ? totals.lateMinutes : 0, presentDays: totals ? totals.present : 0,
    absenceDeduction: lines.absence, unpaidDeduction: lines.unpaid, lateDeduction: lines.late,
    advance: r2(advance), advanceRefs: advances.map(a => ({ id: a.id, amount: a.installment })),
    otherDeductions: manual.otherDeductions || [], note: manual.note || '',
    gross, deductions, net: r2(gross - deductions), dayRate: r2(dayRate),
    att: totals ? { absent: totals.absent || 0, unpaidLeave: totals.unpaidLeave || 0, lateDeductDays: totals.lateDeductDays || 0, lateMinutes: totals.lateMinutes || 0, present: totals.present || 0, remote: totals.remote || 0, leave: totals.leave || 0 } : null
  };
}

async function activeAdvances(month) {
  const all = await list(query(col('advances'), where('status', '==', 'active'))).catch(() => []);
  return all.filter(a => (a.startMonth || '') <= month).map(a => {
    const left = r2((Number(a.amount) || 0) - (Number(a.paid) || 0));
    return { ...a, installment: r2(Math.min(left, Number(a.perMonth) || left)) };
  }).filter(a => a.installment > 0);
}

/** Build (or rebuild) the draft run. Keeps manual fields of existing items. */
export async function buildRun(month) {
  const run = await read('payroll_runs', month);
  if (run && run.status && run.status !== 'draft') throw Object.assign(new Error('locked'), { userMessage: 'الرواتب اتعتمدت للشهر ده. رجّعها مسودة الأول.' });
  const people = activePeople().filter(p => !p.isSuspended);
  const [privs, existing, att, advs] = await Promise.all([
    list(col('employees_private')), list(query(col('payroll_items'), where('month', '==', month))),
    teamMonth(month, { people }), activeAdvances(month)
  ]);
  const b = writeBatch(db);
  let total = 0, count = 0;
  for (const p of people) {
    const priv = privs.find(x => x.id === p.email) || {};
    if (priv.contract === 'freelancer') continue;
    const old = existing.find(x => x.email === p.email) || {};
    const totals = (att.people.find(x => x.person.email === p.email) || {}).totals;
    const item = computeItem({ person: p, priv, totals, advances: advs.filter(a => a.email === p.email), manual: old });
    b.set(doc(db, 'payroll_items', itemId(month, p.email)), { ...item, month, status: old.status === 'paid' ? 'paid' : 'pending', published: false, updatedAt: serverTimestamp() });
    total += item.net; count++;
  }
  b.set(doc(db, 'payroll_runs', month), { month, status: 'draft', count, totalNet: r2(total), builtBy: session.email, builtAt: serverTimestamp() }, { merge: true });
  await b.commit();
  track('payroll.build', { target: month, detail: `${count}` });
}

export async function saveManual(month, email, manual) {
  const it = await read('payroll_items', itemId(month, email));
  const p = person(email) || { email, name: it.name };
  const priv = await read('employees_private', email).catch(() => ({})) || {};
  const totals = it.att || null; // attendance numbers captured when the run was built
  const advances = (it.advanceRefs || []).map(a => ({ id: a.id, installment: a.amount }));
  const next = computeItem({ person: p, priv, totals, advances, manual });
  await updateDoc(doc(db, 'payroll_items', itemId(month, email)), { ...next, updatedAt: serverTimestamp(), editedBy: session.email });
}

export async function setRunStatus(month, status) {
  track('payroll.' + status, { target: month });
  const items = await list(query(col('payroll_items'), where('month', '==', month)));
  const b = writeBatch(db);
  b.set(doc(db, 'payroll_runs', month), { status, [`${status}At`]: serverTimestamp(), [`${status}By`]: session.email, totalNet: r2(items.reduce((s, i) => s + (i.net || 0), 0)), count: items.length }, { merge: true });
  items.forEach(i => b.update(doc(db, 'payroll_items', i.id), { published: status !== 'draft' }));
  await b.commit();
  if (status === 'approved') await Promise.all(items.map(i => notify(i.email, `قسيمة راتب ${fmtMonth(month)} جاهزة`, '', '#/payslips')));
}

/** Mark items paid: treasury entry per person + advance installments recorded. */
export async function markPaid(month, emails) {
  track('payroll.pay', { target: month, detail: `${emails.length}` });
  const items = (await list(query(col('payroll_items'), where('month', '==', month)))).filter(i => emails.includes(i.email) && i.status !== 'paid');
  for (const i of items) {
    await runTransaction(db, async (tx) => {
      const advSnaps = [];
      for (const a of (i.advanceRefs || [])) advSnaps.push([a, await tx.get(doc(db, 'advances', a.id))]);
      advSnaps.forEach(([a, s]) => {
        if (!s.exists()) return;
        const d = s.data(); const paid = r2((Number(d.paid) || 0) + a.amount);
        tx.update(doc(db, 'advances', a.id), { paid, status: paid >= Number(d.amount) - 0.01 ? 'settled' : 'active', updatedAt: serverTimestamp() });
      });
      tx.update(doc(db, 'payroll_items', i.id), { status: 'paid', paidAt: serverTimestamp(), paidBy: session.email });
      tx.set(doc(col('treasury')), { type: 'salary', amount: i.net, title: `راتب ${fmtMonth(month)} — ${i.name}`, email: i.email, month, date: new Date(now()).toISOString().slice(0, 10), by: session.email, at: serverTimestamp() });
    });
    await notify(i.email, `تم تحويل راتب ${fmtMonth(month)}`, '', '#/payslips');
  }
  return items.length;
}

/** Advance paid out in cash from treasury (when finance approves an advance request) */
export async function recordAdvancePayout(adv) {
  await setDoc(doc(db, 'treasury', `advance_${adv.id}`), { type: 'advance', amount: adv.amount, title: `سلفة — ${adv.name || adv.email}`, email: adv.email, month: new Date(now()).toISOString().slice(0, 7), date: new Date(now()).toISOString().slice(0, 10), by: session.email, at: serverTimestamp() });
  await updateDoc(doc(db, 'advances', adv.id), { paidOut: true });
}
