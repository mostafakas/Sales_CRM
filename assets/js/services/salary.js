// Salary structure and per-employee deduction rules.
// employees_private/{email}.salary = { total, parts: { basic|allowances|regularity|kpi: { mode: 'pct'|'amt', value } }, fixedDeductions, basic }
// employees_private/{email}.rules  = see DEFAULT_RULES (every employee has their own copy, edited in their file)
// Violations come straight from attendance: lateness, absence without leave, a remote day whose request was
// rejected, and leaving early. Each is priced by the employee's rules and taken from the right salary part.
import { L, fmtMin } from '../core/utils.js';
import { policy } from '../core/policy.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const PARTS = ['basic', 'allowances', 'regularity', 'kpi'];
export const PART_META = {
  basic: { ar: 'الأساسي', en: 'Basic' },
  allowances: { ar: 'البدلات', en: 'Allowances' },
  regularity: { ar: 'الانتظام', en: 'Regularity' },
  kpi: { ar: 'KPI', en: 'KPI' }
};
export const partLabel = (p) => L(PART_META[p].ar, PART_META[p].en);

export const DEFAULT_RULES = {
  // per late check-in (after the grace period), % of the monthly regularity amount; the month's lateness is capped
  late: { tiers: [{ upTo: 30, pct: 10 }, { upTo: 60, pct: 15 }, { upTo: 0, pct: 20 }], capPct: 60 },
  // absence without leave: the day's value of basic + allowances + regularity; from the 2nd absence in the month × next
  absence: { first: 1, next: 1.5 },
  // a remote day whose request was rejected: the day's value of regularity + allowances
  remoteRejected: true,
  // leaving before the end of the shift, per time: % of the monthly regularity, or a fixed amount from it
  early: { mode: 'pct', value: 0 }
};
export function rulesOf(priv) {
  const r = (priv && priv.rules) || {};
  const late = { ...DEFAULT_RULES.late, ...(r.late || {}) };
  late.tiers = (Array.isArray(late.tiers) && late.tiers.length ? late.tiers : DEFAULT_RULES.late.tiers)
    .map(t => ({ upTo: Number(t.upTo) || 0, pct: Number(t.pct) || 0 }))
    .sort((a, b) => (a.upTo || Infinity) - (b.upTo || Infinity));
  return {
    late, absence: { ...DEFAULT_RULES.absence, ...(r.absence || {}) },
    remoteRejected: r.remoteRejected !== undefined ? !!r.remoteRejected : DEFAULT_RULES.remoteRejected,
    early: { ...DEFAULT_RULES.early, ...(r.early || {}) }
  };
}

/** Monthly amount of each part. Employees saved before the new structure: basic + allowance list, no regularity/KPI. */
export function salaryParts(priv) {
  const s = (priv && priv.salary) || {};
  const fixed = Number(s.fixedDeductions) || 0;
  if (s.parts && Number(s.total)) {
    const total = Number(s.total);
    const amt = (p) => { const x = s.parts[p] || {}; return r2(x.mode === 'pct' ? total * (Number(x.value) || 0) / 100 : Number(x.value) || 0); };
    return { total, basic: amt('basic'), allowances: amt('allowances'), regularity: amt('regularity'), kpi: amt('kpi'), fixed, structured: true };
  }
  const basic = Number(s.basic) || 0;
  const allowances = (s.allowances || []).reduce((t, a) => t + (Number(a.amount) || 0), 0);
  return { total: r2(basic + allowances), basic, allowances: r2(allowances), regularity: 0, kpi: 0, fixed, structured: false };
}

const covers = (r, d) => r.startDate <= d && (r.endDate || r.startDate) >= d;
/** Raw violations of a month from the classified attendance rows (see reports.classifyDay) */
export function violationsFrom(rows, requests = []) {
  const remote = requests.filter(r => r.type === 'remote');
  const out = [];
  (rows || []).forEach(r => {
    if (r.flags && r.flags.includes('untracked')) return;
    if (r.status === 'absent') out.push({ date: r.date, kind: 'absence' });
    if (r.late) out.push({ date: r.date, kind: 'late', minutes: r.late });
    if (r.early) out.push({ date: r.date, kind: 'early', minutes: r.early });
    if (r.rec && r.rec.mode === 'remote' && r.plan && r.plan.mode !== 'remote'
      && !remote.some(q => q.status === 'approved' && covers(q, r.date)) && remote.some(q => q.status === 'rejected' && covers(q, r.date))) {
      out.push({ date: r.date, kind: 'remote' });
    }
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Price the violations. Returns { lines, byPart: { basic, allowances, regularity }, byKind } — a part never goes
 * below zero, and lateness stops at the monthly cap.
 */
export function priceViolations(violations, parts, rules, divisor = Number(policy.payrollDayDivisor) || 30) {
  const day = (p) => (parts[p] || 0) / divisor;
  const left = { basic: parts.basic || 0, allowances: parts.allowances || 0, regularity: parts.regularity || 0 };
  const byPart = { basic: 0, allowances: 0, regularity: 0 };
  const byKind = { late: 0, absence: 0, remote: 0, early: 0 };
  const lateCap = (parts.regularity || 0) * (Number(rules.late.capPct) || 0) / 100;
  let lateSoFar = 0, absences = 0;
  const lines = (violations || []).map(v => {
    const want = {}; const line = { ...v };
    if (v.kind === 'late') {
      const tier = rules.late.tiers.find(t => !t.upTo || v.minutes <= t.upTo) || { pct: 0 };
      line.pct = tier.pct;
      const a = Math.min((parts.regularity || 0) * tier.pct / 100, Math.max(0, lateCap - lateSoFar));
      lateSoFar += a; want.regularity = a;
      if (a < (parts.regularity || 0) * tier.pct / 100) line.capped = true;
    } else if (v.kind === 'absence') {
      const f = absences++ === 0 ? Number(rules.absence.first) || 0 : Number(rules.absence.next) || 0;
      line.factor = f;
      want.basic = day('basic') * f; want.allowances = day('allowances') * f; want.regularity = day('regularity') * f;
    } else if (v.kind === 'remote') {
      if (!rules.remoteRejected) return null;
      want.regularity = day('regularity'); want.allowances = day('allowances');
    } else if (v.kind === 'early') {
      const val = Number(rules.early.value) || 0;
      if (!val) return null;
      line.mode = rules.early.mode; line.value = val;
      want.regularity = rules.early.mode === 'amt' ? val : (parts.regularity || 0) * val / 100;
    }
    line.amounts = {}; line.total = 0;
    Object.keys(want).forEach(p => {
      const a = r2(Math.min(want[p], left[p]));
      if (a <= 0) return;
      left[p] = r2(left[p] - a); byPart[p] = r2(byPart[p] + a);
      line.amounts[p] = a; line.total = r2(line.total + a);
    });
    byKind[v.kind] = r2(byKind[v.kind] + line.total);
    return line;
  }).filter(Boolean);
  return { lines, byPart, byKind, left };
}

/** One human sentence for a priced violation (payslip, attendance card) */
export function violationText(l) {
  if (l.kind === 'late') return L(`تأخير ${fmtMin(l.minutes)} — ${l.pct}% من الانتظام${l.capped ? ' (وصل للحد الأقصى)' : ''}`, `Late ${fmtMin(l.minutes)} — ${l.pct}% of regularity${l.capped ? ' (monthly cap reached)' : ''}`);
  if (l.kind === 'absence') return L(`غياب بدون إذن — ${l.factor === 1 ? 'قيمة يوم' : `قيمة ${l.factor} يوم`}`, `Absence without leave — ${l.factor} day value`);
  if (l.kind === 'remote') return L('أونلاين اترفض طلبه — قيمة يوم من الانتظام والبدلات', 'Remote day, request rejected — a day of regularity & allowances');
  if (l.kind === 'early') return L(`انصراف مبكر ${fmtMin(l.minutes)} — ${l.mode === 'amt' ? 'قيمة ثابتة' : `${l.value}%`} من الانتظام`, `Left ${fmtMin(l.minutes)} early — ${l.mode === 'amt' ? 'fixed amount' : `${l.value}%`} of regularity`);
  return l.kind;
}
