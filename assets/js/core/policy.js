// Company policy (settings/general + settings/leave) with safe defaults, and the
// pure calculations built on it: day keys, lateness, working days, schedule modes.
import { read, ref, watch, setDoc, serverTimestamp } from './fb.js';
import { L, zparts, ymd, addDays, weekday, hmToMin, minutesOfDay, dateRange } from './utils.js';

export const DEFAULT_POLICY = {
  workStart: '09:00',
  workEnd: '17:00',
  graceMinutes: 15,
  weekend: [5, 6],                // Friday, Saturday
  dayBoundaryHour: 4,             // work after midnight until 04:00 belongs to the previous day
  remoteNeedsApproval: true,
  defaultRemoteQuota: 4,          // remote days per month
  excuseHoursPerMonth: 4,
  lateTiers: [                    // deduction per late day (fraction of a day's pay)
    { after: 15, day: 0.25 },
    { after: 60, day: 0.5 },
    { after: 180, day: 1 }
  ],
  lateDeductionEnabled: false,
  absenceDeductDays: 1,
  payrollDayDivisor: 30,
  breakMaxMinutes: 60,
  carryOverMax: 0,                // unused annual days carried to next year
  trackingStart: '',              // first day attendance is tracked by this system (set at go-live)
  singleSession: true,
  hrEmail: '',
  statuses: {
    Online: { enabled: true },
    Break: { enabled: true },
    Meeting: { enabled: true }
  },
  workflow: {
    leave: ['leader', 'hr'],
    remote: ['leader'],
    excuse: ['leader'],
    mission: ['leader'],
    correction: ['leader', 'hr'],
    advance: ['leader', 'hr', 'finance'],
    letter: ['hr']
  }
};

export const DEFAULT_LEAVE_TYPES = [
  { id: 'annual', ar: 'إجازة اعتيادية', en: 'Annual leave', days: 21, paid: true, attachment: false, color: 'brand', active: true },
  { id: 'casual', ar: 'إجازة عارضة', en: 'Casual leave', days: 6, paid: true, attachment: false, color: 'info', active: true },
  { id: 'sick', ar: 'إجازة مرضية', en: 'Sick leave', days: 14, paid: true, attachment: true, color: 'warn', active: true },
  { id: 'unpaid', ar: 'إجازة بدون أجر', en: 'Unpaid leave', days: 0, paid: false, attachment: false, color: 'bad', active: true, unlimited: true }
];

export const REQUEST_TYPES = {
  leave:      { ar: 'إجازة', en: 'Leave', icon: 'fa-umbrella-beach', tile: 'warn' },
  remote:     { ar: 'عمل أونلاين', en: 'Remote work', icon: 'fa-house-laptop', tile: '' },
  excuse:     { ar: 'إذن تأخير / انصراف', en: 'Late / early permission', icon: 'fa-clock', tile: 'info' },
  mission:    { ar: 'مأمورية', en: 'Business mission', icon: 'fa-briefcase', tile: 'ok', retired: true }, // no longer requested; kept to show old records
  correction: { ar: 'تصحيح حضور', en: 'Attendance correction', icon: 'fa-pen-to-square', tile: 'neutral' },
  advance:    { ar: 'سلفة', en: 'Salary advance', icon: 'fa-hand-holding-dollar', tile: 'ok' },
  letter:     { ar: 'خطاب من HR', en: 'HR letter', icon: 'fa-file-signature', tile: 'info' }
};
export const REQUEST_STATUS = {
  pending_leader:  { ar: 'عند المدير المباشر', en: 'With manager', cls: 'warn' },
  pending_hr:      { ar: 'عند HR', en: 'With HR', cls: 'warn' },
  pending_finance: { ar: 'عند المالية', en: 'With finance', cls: 'warn' },
  pending_admin:   { ar: 'عند الأدمن', en: 'With admin', cls: 'warn' },
  approved:        { ar: 'معتمد', en: 'Approved', cls: 'ok' },
  rejected:        { ar: 'مرفوض', en: 'Rejected', cls: 'bad' },
  cancelled:       { ar: 'ملغي', en: 'Cancelled', cls: '' }
};
export const MODE_META = {
  office:  { ar: 'المكتب', en: 'Office', cls: 'm-office', icon: 'fa-building' },
  remote:  { ar: 'أونلاين', en: 'Remote', cls: 'm-remote', icon: 'fa-house-laptop' },
  leave:   { ar: 'إجازة', en: 'Leave', cls: 'm-leave', icon: 'fa-umbrella-beach' },
  mission: { ar: 'مأمورية', en: 'Mission', cls: 'm-mission', icon: 'fa-briefcase' },
  off:     { ar: 'راحة', en: 'Day off', cls: 'm-off', icon: 'fa-bed' },
  holiday: { ar: 'عطلة رسمية', en: 'Holiday', cls: 'm-holiday', icon: 'fa-flag' }
};
export const ROLE_META = {
  employee: { ar: 'موظف', en: 'Employee' },
  leader: { ar: 'مدير فريق', en: 'Team leader' },
  sales_manager: { ar: 'مدير السيلز', en: 'Sales manager' },   // a team leader for the sales team
  pm: { ar: 'مدير المشروعات', en: 'Project manager' },
  hr: { ar: 'موارد بشرية', en: 'HR' },
  finance: { ar: 'المالية', en: 'Finance' },
  admin: { ar: 'مدير النظام', en: 'Administrator' }
};
export const statusLabel = (s) => { const m = REQUEST_STATUS[s]; return m ? L(m.ar, m.en) : s; };
export const typeLabel = (t) => { const m = REQUEST_TYPES[t]; return m ? L(m.ar, m.en) : t; };
export const modeLabel = (m) => { const x = MODE_META[m]; return x ? L(x.ar, x.en) : m; };
export const roleLabel = (r) => { const x = ROLE_META[normRole(r)]; return x ? L(x.ar, x.en) : r; };
export const normRole = (raw) => { const r = String(raw || '').trim().toLowerCase(); return r === 'supervisor' ? 'hr' : (ROLE_META[r] ? r : 'employee'); };

// ---------- live policy ----------
export const policy = structuredClone(DEFAULT_POLICY);
export let leaveTypes = structuredClone(DEFAULT_LEAVE_TYPES);
export let holidays = {}; // 'YYYY-MM-DD' -> name
const subs = new Set();
export const onPolicy = (fn) => { subs.add(fn); return () => subs.delete(fn); };
function merge(target, src) { Object.keys(src || {}).forEach(k => { target[k] = src[k]; }); }

export async function loadPolicy() {
  const [g, lv, hd] = await Promise.all([
    read('settings', 'general').catch(() => null),
    read('settings', 'leave').catch(() => null),
    read('settings', 'holidays').catch(() => null)
  ]);
  if (g) { merge(policy, g); policy.workflow = { ...DEFAULT_POLICY.workflow, ...(g.workflow || {}) }; policy.statuses = { ...DEFAULT_POLICY.statuses, ...(g.statuses || {}) }; }
  if (lv && Array.isArray(lv.types) && lv.types.length) leaveTypes = lv.types;
  holidays = (hd && hd.days) || {};
  if (!g) {
    // Fall back to the old system's work_config when present (first run after migration)
    const legacy = await read('system_settings', 'work_config').catch(() => null);
    if (legacy && typeof legacy.workStart === 'string') policy.workStart = legacy.workStart;
  }
  watch(ref('settings', 'general'), d => { if (d) { merge(policy, d); policy.workflow = { ...DEFAULT_POLICY.workflow, ...(d.workflow || {}) }; } subs.forEach(f => f()); });
  watch(ref('settings', 'leave'), d => { if (d && Array.isArray(d.types) && d.types.length) leaveTypes = d.types; subs.forEach(f => f()); });
  watch(ref('settings', 'holidays'), d => { holidays = (d && d.days) || {}; subs.forEach(f => f()); });
}
const audit = (a, d) => import('../services/activity.js').then(m => m.track(a, { detail: d })).catch(() => {});
export async function savePolicy(part) { await setDoc(ref('settings', 'general'), { ...part, updatedAt: serverTimestamp() }, { merge: true }); audit('settings.update', Object.keys(part).join(', ')); }
export async function saveLeaveTypes(types) { await setDoc(ref('settings', 'leave'), { types, updatedAt: serverTimestamp() }, { merge: true }); audit('settings.update', 'leave types'); }
export async function saveHolidays(days) { await setDoc(ref('settings', 'holidays'), { days, updatedAt: serverTimestamp() }); audit('settings.update', 'holidays'); }

export const leaveType = (id) => leaveTypes.find(t => t.id === id) || { id, ar: id, en: id, days: 0, paid: true };
export const leaveTypeLabel = (id) => { const t = leaveType(id); return L(t.ar, t.en); };

// ---------- day logic ----------
/** Work-day key for a moment: the Cairo date, shifted back by the day boundary hour. */
export function dayKey(ms) { return ymd(ms - (policy.dayBoundaryHour || 0) * 3600000); }
export const isWeekend = (dateStr) => (policy.weekend || []).includes(weekday(dateStr));
export const isHoliday = (dateStr) => !!holidays[dateStr];

// ---------- personal working hours (users/{email}.workStart / workEnd; empty = company hours) ----------
let personOf = () => null;
/** The people directory registers how to look a person up by email. */
export const setPersonLookup = (fn) => { personOf = fn || (() => null); };
/** { start, end, grace } for a person — `who` is an email or a profile; each falls back to the company setting */
export function hoursFor(who) {
  const p = who && typeof who === 'object' ? (personOf(who.email) || who) : personOf(who);
  const own = p && p.workStart && p.workEnd;
  const g = p && p.graceMinutes !== undefined && p.graceMinutes !== null && p.graceMinutes !== '' ? Number(p.graceMinutes) : Number(policy.graceMinutes) || 0;
  return { start: own ? p.workStart : policy.workStart, end: own ? p.workEnd : policy.workEnd, grace: g };
}

/** Effective plan for a date: schedule override > holiday > weekend > office. `who` = email/profile when there may be no schedule. */
export function planFor(dateStr, schedule, who) {
  const h = hoursFor(who || (schedule && schedule.email) || '');
  const o = schedule && schedule.days && schedule.days[dateStr];
  if (o && o.mode) return { mode: o.mode, start: o.start || h.start, end: o.end || h.end, grace: h.grace, leaveType: o.leaveType, requestId: o.requestId, source: 'schedule' };
  if (isHoliday(dateStr)) return { mode: 'holiday', name: holidays[dateStr], start: null, end: null, source: 'holiday' };
  if (isWeekend(dateStr)) return { mode: 'off', start: null, end: null, source: 'weekend' };
  return { mode: 'office', start: h.start, end: h.end, grace: h.grace, source: 'default' };
}
export const isWorkingPlan = (p) => p.mode === 'office' || p.mode === 'remote' || p.mode === 'mission';
/**
 * The later shift: someone planned for 09:00 who starts after the grace period may choose to work 10:00–19:00
 * that day instead of being counted late. The choice is stored on the day (users.shift / attendance_days.shift).
 */
export const LATE_SHIFT = { id: '10', from: '09:00', start: '10:00', end: '19:00' };
export const canPickLateShift = (plan) => !!plan && isWorkingPlan(plan) && plan.start === LATE_SHIFT.from;
export const withShift = (plan, shift) => shift === LATE_SHIFT.id && canPickLateShift(plan) ? { ...plan, start: LATE_SHIFT.start, end: LATE_SHIFT.end, shift: LATE_SHIFT.id } : plan;

/** Count working days in a range (excludes weekends & holidays; schedule overrides respected) */
export function workingDays(from, to, schedulesByMonth = {}) {
  return dateRange(from, to).filter(d => {
    const p = planFor(d, schedulesByMonth[d.slice(0, 7)]);
    return p.mode !== 'off' && p.mode !== 'holiday';
  }).length;
}

/** Minutes late for a check-in (0 if within grace). Returns {late, raw} */
export function lateness(checkInMs, plan) {
  if (!checkInMs) return { late: 0, raw: 0 };
  if (plan && !isWorkingPlan(plan)) return { late: 0, raw: 0 };
  const start = hmToMin((plan && plan.start) || policy.workStart);
  // whole minutes: with a 30-minute grace, 09:30:59 is still on time and 09:31 is 31 minutes late
  const rawMin = Math.max(0, Math.floor(minutesOfDay(checkInMs) - start));
  const grace = plan && plan.grace !== undefined ? plan.grace : (policy.graceMinutes || 0);
  return { late: rawMin > grace ? rawMin : 0, raw: rawMin };
}
export function earlyLeave(checkOutMs, plan, dateStr) {
  if (!checkOutMs) return 0;
  if (plan && !isWorkingPlan(plan)) return 0;
  if (dateStr && ymd(checkOutMs) !== dateStr) return 0; // left after midnight
  const end = hmToMin((plan && plan.end) || policy.workEnd);
  return Math.max(0, Math.round(end - minutesOfDay(checkOutMs)));
}
export function lateDeductionDays(lateMin) {
  if (!lateMin) return 0;
  let d = 0;
  (policy.lateTiers || []).forEach(t => { if (lateMin > Number(t.after)) d = Math.max(d, Number(t.day) || 0); });
  return d;
}
/** Which approval stages a request of this type goes through for this requester */
/** Request types people can still file (retired ones only appear on old records) */
export const activeRequestTypes = () => Object.keys(REQUEST_TYPES).filter(k => !REQUEST_TYPES[k].retired);
export function stagesFor(type, requester) {
  if (type === 'advance') return ['admin']; // salary advances are decided by the admin only
  const wf = (policy.workflow && policy.workflow[type]) || ['hr'];
  const st = wf.filter(s => !(s === 'leader' && !(requester && requester.leaderEmail)));
  return st.length ? st : ['hr']; // nobody approves their own request
}
export function firstStatus(type, requester) {
  const st = stagesFor(type, requester);
  return st.length ? `pending_${st[0]}` : 'approved';
}
export function nextStatus(type, requester, current) {
  const st = stagesFor(type, requester);
  const i = st.indexOf(String(current).replace('pending_', ''));
  return i >= 0 && i < st.length - 1 ? `pending_${st[i + 1]}` : 'approved';
}
/** First date absence can be counted for a person: go-live date, hire date or account creation. */
export function trackedSince(p) {
  const created = p && p.createdAt ? ymd(p.createdAt.toMillis ? p.createdAt.toMillis() : (p.createdAt.seconds ? p.createdAt.seconds * 1000 : p.createdAt)) : '';
  return [policy.trackingStart || ymd(Date.now()), (p && p.hireDate) || '', created].filter(Boolean).sort().pop();
}
export { zparts, addDays };
