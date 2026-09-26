// One-time migration from the old system's collections into the new data model.
// Safe to re-run: every target document has a deterministic id and old collections are never deleted.
import { db, doc, writeBatch, serverTimestamp, deleteField, list, col, read, setDoc, toMs } from '../core/fb.js';
import { session, now } from '../core/session.js';
import { DEFAULT_POLICY, leaveTypes, normRole, stagesFor } from '../core/policy.js';
import { ymd, dateRange, weekday, normEmail } from '../core/utils.js';
import { emptyBalance, balanceId } from './requests.js';

const SENSITIVE = ['fullSalary', 'fixedDeductions', 'allowance', 'incentive', 'kpi', 'salary_base', 'monthly_finance', 'bank_account', 'instapay', 'phone_number', 'telegram_id', 'mute_notifications', 'fl_total_credit', 'fl_total_paid', 'fl_total_deducted', 'fl_archived_paid', 'fl_archived_deducted', 'fl_reset_date', 'leaveBalances', 'onlineDaysLimit'];
const OLD_TYPE = { annual: ['leave', 'annual'], sick: ['leave', 'sick'], casual: ['leave', 'casual'], excuse_late: ['excuse', null, 'late'], excuse_early: ['excuse', null, 'early'], online_work: ['remote'] };
const OLD_MODE = { online: { mode: 'remote' }, office: { mode: 'office' }, off: { mode: 'off' }, sick: { mode: 'leave', leaveType: 'sick' }, casual: { mode: 'leave', leaveType: 'casual' } };

class Writer {
  constructor(dry) { this.dry = dry; this.ops = []; this.count = 0; }
  set(path, id, data, merge = false) { this.ops.push(['set', path, id, data, merge]); this.count++; }
  update(path, id, data) { this.ops.push(['update', path, id, data]); this.count++; }
  async flush(progress) {
    if (this.dry) return;
    for (let i = 0; i < this.ops.length; i += 350) {
      const b = writeBatch(db);
      this.ops.slice(i, i + 350).forEach(([op, path, id, data, merge]) => {
        const r = doc(db, path, id);
        if (op === 'set') b.set(r, data, merge ? { merge: true } : undefined); else b.update(r, data);
      });
      await b.commit();
      progress && progress(Math.min(this.ops.length, i + 350), this.ops.length);
    }
  }
}
const isWeekend = (d) => (DEFAULT_POLICY.weekend || [5, 6]).includes(weekday(d));

/** Returns a report; when dry=false it also writes. */
export async function migrate({ dry = true, progress } = {}) {
  const w = new Writer(dry);
  const report = { users: 0, private: 0, balances: 0, requests: 0, schedules: 0, treasury: 0, payrollItems: 0, overrides: 0, photosShrunk: 0, notes: [] };
  const year = new Date(now()).getFullYear();
  const [users, hrStats, oldReqs, oldSched, fin, overrides, workCfg, existingReqs] = await Promise.all([
    list(col('users')), list(col('hr_stats')).catch(() => []), list(col('leave_requests')).catch(() => []),
    list(col('monthly_schedules')).catch(() => []), list(col('financial_months')).catch(() => []),
    list(col('attendance_override')).catch(() => []), read('system_settings', 'work_config').catch(() => null),
    list(col('requests')).catch(() => [])
  ]);
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));

  // 1) settings — attendance before today was not archived by the old system, so tracking starts today
  const general = await read('settings', 'general').catch(() => null);
  if (!general || !general.trackingStart) w.set('settings', 'general', { trackingStart: ymd(now()) }, true);
  if (!general) {
    w.set('settings', 'general', { ...DEFAULT_POLICY, trackingStart: ymd(now()), ...(workCfg && typeof workCfg.workStart === 'string' ? { workStart: workCfg.workStart } : {}), migratedAt: serverTimestamp() });
  }

  // 2) users → public profile + employees_private
  for (const u of users) {
    const email = u.id;
    const upd = {};
    const role = normRole(u.role);
    if (role !== u.role) upd.role = role;
    if (u.remoteQuota === undefined) upd.remoteQuota = Number(u.onlineDaysLimit) > 0 ? Number(u.onlineDaysLimit) : DEFAULT_POLICY.defaultRemoteQuota;
    if (u.photo && u.photo.length > 60000) { upd.photo = ''; report.photosShrunk++; }
    if (u.checkedOut === undefined) upd.checkedOut = (u.status || 'Offline') === 'Offline';
    const allowances = [];
    if (u.allowance && Number(u.allowance.value)) allowances.push({ name: 'بدلات', amount: u.allowance.type === 'percentage' ? Math.round((Number(u.fullSalary) || 0) * Number(u.allowance.value) / 100) : Number(u.allowance.value) });
    const priv = {
      email,
      salary: { basic: Number(u.salary_base) || Number(u.fullSalary) || 0, allowances, fixedDeductions: Number(u.fixedDeductions) || 0 },
      bank: u.bank_account || '', instapay: u.instapay || '', phone: u.phone_number || '', telegramId: u.telegram_id || '',
      contract: u.contract || 'fulltime', migratedAt: serverTimestamp()
    };
    if (u.contract === 'freelancer') Object.assign(priv, { flCredit: Number(u.fl_total_credit) || 0, flPaid: Number(u.fl_total_paid) || 0, flDeducted: Number(u.fl_total_deducted) || 0 });
    const hasSensitive = SENSITIVE.some(k => u[k] !== undefined);
    if (hasSensitive) { w.set('employees_private', email, priv, true); report.private++; SENSITIVE.forEach(k => { if (u[k] !== undefined) upd[k] = deleteField(); }); }
    if (Object.keys(upd).length) { w.update('users', email, upd); report.users++; }

    // legacy monthly_finance → payroll history items
    Object.entries(u.monthly_finance || {}).forEach(([month, m]) => {
      if (!/^\d{4}-\d{2}$/.test(month)) return;
      const ded = (m.deductions || []).map(d => ({ reason: d.reason || '', amount: Number(d.amount) || 0 }));
      const basic = Number(u.salary_base) || 0;
      const net = basic + (Number(m.bonus) || 0) + (Number(m.incentive) || 0) - ded.reduce((s, d) => s + d.amount, 0);
      w.set('payroll_items', `${month}_${email}`, { email, name: u.name || email, title: u.title || '', month, basic, allowances: 0, bonus: Number(m.bonus) || 0, incentive: Number(m.incentive) || 0, otherDeductions: ded, deductions: ded.reduce((s, d) => s + d.amount, 0), gross: basic + (Number(m.bonus) || 0) + (Number(m.incentive) || 0), net, status: m.status === 'paid' ? 'paid' : 'pending', published: m.status === 'paid' || m.status === 'approved', legacy: true }, true);
      w.set('payroll_runs', month, { month, legacy: true, status: 'closed' }, true);
      report.payrollItems++;
      if ((m.receipts || []).length) report.notes.push(`${email} ${month}: ${(m.receipts || []).length} receipt image(s) not migrated`);
    });

    // 3) balances for current year
    const bal = emptyBalance(email, year);
    const hs = hrStats.find(h => h.id === email);
    const lb = u.leaveBalances || null;
    if (hs && typeof hs.annualLeavesLeft === 'number' && bal.types.annual) bal.types.annual.adjust = hs.annualLeavesLeft - bal.types.annual.entitled;
    else if (lb && typeof lb.annual === 'number' && bal.types.annual) bal.types.annual.adjust = lb.annual - bal.types.annual.entitled;
    if (lb && typeof lb.casual === 'number' && bal.types.casual) bal.types.casual.adjust = lb.casual - bal.types.casual.entitled;
    if (lb && typeof lb.sick === 'number' && bal.types.sick) bal.types.sick.adjust = lb.sick - bal.types.sick.entitled;
    const existingBal = await read('balances', balanceId(email, year)).catch(() => null);
    if (!existingBal) { w.set('balances', balanceId(email, year), { ...bal, migrated: true, updatedAt: serverTimestamp() }); report.balances++; }
  }

  // 4) schedules
  const schedOut = {};
  for (const s of oldSched) {
    const email = normEmail(s.userId || s.id.split('_')[0]);
    const month = s.monthId || s.id.split('_').pop();
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const days = {};
    Object.entries(s.days || {}).forEach(([d, v]) => { const m = OLD_MODE[v && v.mode] || { mode: 'office' }; days[d] = { ...m, ...(v.start ? { start: v.start, end: v.end } : {}), legacy: true }; });
    const id = `${email}_${month}`;
    schedOut[id] = { email, month, leaderEmail: (userMap[email] || {}).leaderEmail || '', days };
  }

  // 5) requests
  const today = ymd(now());
  for (const r of oldReqs) {
    if (existingReqs.some(x => x.id === r.id)) continue;
    const email = normEmail(r.user);
    const u = userMap[email] || {};
    const [type, leaveType, excuseKind] = OLD_TYPE[r.type] || (r.req_class === 'online' ? ['remote'] : ['leave', 'annual']);
    const start = r.start_date || r.target_date || today;
    const end = r.end_date || start;
    let status = r.status;
    if (!['approved', 'rejected', 'cancelled'].includes(status)) status = u.leaderEmail ? 'pending_leader' : 'pending_hr';
    const days = dateRange(start, end).filter(d => !isWeekend(d)).length || 1;
    const nr = {
      email, name: r.name || u.name || email, leaderEmail: u.leaderEmail || r.managerId || '', department: u.department || '',
      type, startDate: start, endDate: end, days, reason: r.reason || '', status, stages: stagesFor(type, u),
      createdMs: toMs(r.submitted_at) || now(), createdAt: r.submitted_at || serverTimestamp(), updatedAt: serverTimestamp(), migrated: true,
      history: [{ at: toMs(r.submitted_at) || now(), by: email, byName: r.name || email, action: 'submitted', note: '' },
        ...(r.reviewed_by ? [{ at: toMs(r.reviewed_at) || now(), by: '', byName: r.reviewed_by, action: status === 'approved' ? 'approved_hr' : (status === 'rejected' ? 'rejected_hr' : 'submitted'), note: L_('نُقل من النظام القديم') }] : [])]
    };
    if (leaveType) nr.leaveType = leaveType;
    if (excuseKind) { nr.excuseKind = excuseKind; nr.fromTime = ''; nr.toTime = ''; nr.minutes = 0; }
    w.set('requests', r.id, nr);
    report.requests++;
    // future approved leave/remote → schedule days so check-in and reports know about them
    if (status === 'approved' && ['leave', 'remote'].includes(type) && end >= today) {
      dateRange(start, end).filter(d => !isWeekend(d)).forEach(d => {
        const id = `${email}_${d.slice(0, 7)}`;
        schedOut[id] = schedOut[id] || { email, month: d.slice(0, 7), leaderEmail: u.leaderEmail || '', days: {} };
        schedOut[id].days[d] = { mode: type === 'leave' ? 'leave' : 'remote', ...(leaveType ? { leaveType } : {}), requestId: r.id };
      });
    }
  }
  Object.entries(schedOut).forEach(([id, s]) => { w.set('schedules', id, { ...s, updatedAt: serverTimestamp() }, true); report.schedules++; });

  // 6) treasury (vault + expenses)
  const TYPE = { general: 'expense', freelancer: 'freelancer', emp_advance: 'advance', salary_payout: 'salary' };
  for (const m of fin) {
    const month = m.id;
    if (Number(m.vault)) { w.set('treasury', `legacy_${month}_open`, { type: 'deposit', amount: Number(m.vault), title: 'رصيد افتتاحي (النظام القديم)', date: `${month}-01`, month, legacy: true, at: serverTimestamp() }); report.treasury++; }
    (m.vault_logs || []).forEach((l, i) => { w.set('treasury', `legacy_${month}_in_${i}`, { type: 'deposit', amount: Number(l.amount) || 0, title: l.note || 'إيداع', date: `${month}-01`, month, legacy: true, atMs: l.timestamp || null, at: serverTimestamp() }); report.treasury++; });
    (m.expenses || []).forEach((e, i) => {
      if (e.type === 'fl_deduction') return;
      w.set('treasury', `legacy_${month}_out_${i}`, { type: TYPE[e.type] || 'expense', amount: Number(e.amount) || 0, title: e.title || '', date: /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : `${month}-01`, month, email: e.emp_email || e.fl_id || '', legacy: true, atMs: e.timestamp || null, at: serverTimestamp() });
      report.treasury++;
    });
  }

  // 7) attendance overrides
  overrides.forEach(o => {
    const email = normEmail(o.user); if (!email || !o.dayKey) return;
    w.set('attendance_days', `${email}_${o.dayKey}`, { email, date: o.dayKey, status: o.status === 'Absent' ? 'absent' : 'leave', leaderEmail: (userMap[email] || {}).leaderEmail || '', corrected: true, correctionNote: 'legacy override', closed: true }, true);
    report.overrides++;
  });

  w.set('settings', 'migration', { done: !dry, at: serverTimestamp(), by: session.email, report: { ...report, notes: report.notes.slice(0, 50) } }, true);
  report.total = w.count;
  await w.flush(progress);
  return report;
}
const L_ = (s) => s;
