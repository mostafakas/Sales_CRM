// Admin tool: change an account's username (its sign-in email).
// Every record is keyed by the email, so the data is copied to the new key first, references are
// re-pointed, old copies are removed, and only then the password service switches the login itself.
import { db, doc, writeBatch, list, query, col, where, read, serverTimestamp } from '../core/fb.js';
import { L, normEmail } from '../core/utils.js';
import { userError } from '../core/ui.js';
import { callService } from './authsvc.js';

const strip = (o) => { const { id, ...rest } = o || {}; return rest; };
const reKey = (id, from, to, fallback) => (id.startsWith(from + '_') ? to + id.slice(from.length) : (id.endsWith('_' + from) ? id.slice(0, -from.length) + to : fallback));

async function commit(ops, onProgress, label) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(([op, c, id, data]) => {
      const r = doc(db, c, id);
      if (op === 'set') b.set(r, data); else if (op === 'update') b.update(r, data); else b.delete(r);
    });
    await b.commit();
    onProgress && onProgress(label, Math.min(ops.length, i + 400), ops.length);
  }
}

export async function renameAccount(fromRaw, toRaw, onProgress, actor = '') {
  const from = normEmail(fromRaw), to = normEmail(toRaw);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw userError('اسم المستخدم الجديد لازم يكون إيميل صحيح.', 'The new username must be a valid email.');
  if (from === to) throw userError('ده نفس اسم المستخدم الحالي.', 'That is the current username.');

  onProgress && onProgress('check');
  await callService('renameCheck', { from, to });

  const u = await read('users', from);
  if (!u) throw userError('الموظف مش موجود.', 'Employee not found.');
  const by = (c, f) => list(query(col(c), where(f, '==', from))).catch(() => []);
  const [priv, general, bals, days, daysL, scheds, schedsL, reqs, reqsL, team, ledger, atts, attsL, advs, pay, logs, logsL] = await Promise.all([
    read('employees_private', from).catch(() => null), read('settings', 'general').catch(() => null),
    by('balances', 'email'), by('attendance_days', 'email'), by('attendance_days', 'leaderEmail'),
    by('schedules', 'email'), by('schedules', 'leaderEmail'), by('requests', 'email'), by('requests', 'leaderEmail'),
    by('users', 'leaderEmail'), by('balance_ledger', 'email'), by('attachments', 'owner'), by('attachments', 'leaderEmail'),
    by('advances', 'email'), by('payroll_items', 'email'), by('logs', 'user'), by('logs', 'leaderEmail')
  ]);

  const ops = [], dels = [];
  const lead = (x) => (x.leaderEmail === from ? { leaderEmail: to } : {});
  ops.push(['set', 'users', to, { ...strip(u), renamedFrom: from, renamedAt: serverTimestamp() }]);
  if (priv) { ops.push(['set', 'employees_private', to, { ...strip(priv), email: to }]); dels.push(['del', 'employees_private', from]); }
  bals.forEach(b => { ops.push(['set', 'balances', reKey(b.id, from, to, `${to}_${b.year}`), { ...strip(b), email: to }]); dels.push(['del', 'balances', b.id]); });
  days.forEach(d => { ops.push(['set', 'attendance_days', reKey(d.id, from, to, `${to}_${d.date}`), { ...strip(d), email: to, ...lead(d) }]); dels.push(['del', 'attendance_days', d.id]); });
  daysL.filter(d => d.email !== from).forEach(d => ops.push(['update', 'attendance_days', d.id, { leaderEmail: to }]));
  scheds.forEach(s => { ops.push(['set', 'schedules', reKey(s.id, from, to, `${to}_${s.month}`), { ...strip(s), email: to, ...lead(s) }]); dels.push(['del', 'schedules', s.id]); });
  schedsL.filter(s => s.email !== from).forEach(s => ops.push(['update', 'schedules', s.id, { leaderEmail: to }]));
  reqs.forEach(r => ops.push(['update', 'requests', r.id, { email: to, ...lead(r) }]));
  reqsL.filter(r => r.email !== from).forEach(r => ops.push(['update', 'requests', r.id, { leaderEmail: to }]));
  team.filter(p => p.id !== from).forEach(p => ops.push(['update', 'users', p.id, { leaderEmail: to }]));
  ledger.forEach(x => ops.push(['update', 'balance_ledger', x.id, { email: to }]));
  atts.forEach(a => ops.push(['update', 'attachments', a.id, { owner: to, ...lead(a) }]));
  attsL.filter(a => a.owner !== from).forEach(a => ops.push(['update', 'attachments', a.id, { leaderEmail: to }]));
  advs.forEach(a => ops.push(['update', 'advances', a.id, { email: to }]));
  pay.forEach(p => { ops.push(['set', 'payroll_items', reKey(p.id, from, to, `${p.month}_${to}`), { ...strip(p), email: to }]); dels.push(['del', 'payroll_items', p.id]); });
  logs.forEach(g => ops.push(['update', 'logs', g.id, { user: to, ...lead(g) }]));
  logsL.filter(g => g.user !== from).forEach(g => ops.push(['update', 'logs', g.id, { leaderEmail: to }]));
  if (general && normEmail(general.hrEmail) === from) ops.push(['update', 'settings', 'general', { hrEmail: to }]);

  await commit(ops, onProgress, 'copy');
  dels.push(['set', 'audit_log', `rename_${Date.now()}`, { action: 'user.rename', target: to, from, by: normEmail(actor), at: serverTimestamp() }]);
  await commit(dels, onProgress, 'cleanup');
  onProgress && onProgress('login');
  await callService('rename', { from, to });
  return { moved: ops.length + dels.length, attendance: days.length, requests: reqs.length };
}

export const renameStepText = (step) => ({
  check: L('بنتأكد إن الاسم الجديد متاح…', 'Checking the new username is free…'),
  copy: L('بننقل البيانات…', 'Moving data…'),
  cleanup: L('بنشيل النسخ القديمة…', 'Removing old copies…'),
  login: L('بنغيّر اسم الدخول…', 'Switching the sign-in name…')
}[step] || '');
