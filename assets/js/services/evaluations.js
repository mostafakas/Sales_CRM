// Performance reviews: each employee is reviewed every week (the four weeks of a month: 1–7, 8–14, 15–21, 22–end)
// on four pillars — attendance & discipline and tasks (automatic), KPIs (actual vs target, per department) and a
// star rating — and the weeks add up to the month. Only admins and project managers review; an employee sees a
// review only once it has been sent to them. Weights, grade bands, criteria and KPI templates live in Settings.
import { db, doc, col, watch, query, where, setDoc, updateDoc, serverTimestamp } from '../core/fb.js';
import { session, isAdmin, isPM } from '../core/session.js';
import { userError } from '../core/ui.js';
import { L } from '../core/utils.js';
import { policy, isWorkingPlan, savePolicy } from '../core/policy.js';
import { summarize } from './reports.js';
import { inPeriod, doneDay, periodRange } from './tasks.js';
import { notify } from './notify.js';
import { nameOf } from './directory.js';
import { track } from './activity.js';

export const PILLARS = ['attendance', 'tasks', 'kpis', 'rating'];
export const PILLAR_META = {
  attendance: { ar: 'الحضور والانتظام', en: 'Attendance & discipline', icon: 'fa-user-clock', color: '#1D9E75' },
  tasks: { ar: 'التاسكات', en: 'Tasks', icon: 'fa-clipboard-check', color: '#378ADD' },
  kpis: { ar: 'الـ KPIs', en: 'KPIs', icon: 'fa-bullseye', color: '#7F77DD' },
  rating: { ar: 'التقييم بالنجوم', en: 'Star rating', icon: 'fa-star', color: '#EF9F27' }
};
export const pillarLabel = (k) => L(PILLAR_META[k].ar, PILLAR_META[k].en);
export const DEFAULT_EVAL = {
  weights: { attendance: 25, tasks: 30, kpis: 30, rating: 15 },
  grades: [{ name: 'ممتاز', min: 90 }, { name: 'جيد جداً', min: 80 }, { name: 'جيد', min: 70 }, { name: 'مقبول', min: 60 }, { name: 'ضعيف', min: 0 }],
  criteria: ['جودة الشغل', 'الالتزام بالمواعيد', 'التواصل والتعاون', 'المبادرة'],
  kpis: {},            // { department: [{ id, name, unit, target (a month), weight }] }
  salaryLink: false    // use the month's KPI score for the KPI part of the salary
};
export function evalSettings() {
  const e = policy.evaluation || {};
  return { ...DEFAULT_EVAL, ...e, weights: { ...DEFAULT_EVAL.weights, ...(e.weights || {}) }, grades: (e.grades && e.grades.length ? e.grades : DEFAULT_EVAL.grades), criteria: (e.criteria && e.criteria.length ? e.criteria : DEFAULT_EVAL.criteria), kpis: e.kpis || {} };
}
export const saveEvalSettings = (patch) => savePolicy({ evaluation: { ...evalSettings(), ...patch } });
export const canEvaluate = () => isAdmin() || isPM();

// ---------- scores (0–100; null = nothing to judge in that period) ----------
const clamp = (x) => Math.max(0, Math.min(100, Math.round(x)));
/** attendance & discipline: half commitment (no absence), half punctuality, minus early leaves / forgotten days / long lateness */
export function attendanceScore(rows) {
  const t = summarize(rows);
  if (t.present + t.absent === 0) return null;
  const onTime = rows.filter(r => r.rec && r.rec.checkInMs && isWorkingPlan(r.plan) && !r.late).length;
  const punctual = t.present ? onTime / t.present * 100 : 0;
  const early = rows.filter(r => r.early > 0).length;
  const penalty = Math.min(20, early * 3 + t.forgot * 2 + Math.floor(t.lateMinutes / 30));
  return { score: clamp(0.5 * t.commitment + 0.5 * punctual - penalty), present: t.present, absent: t.absent, lateDays: t.lateDays, lateMinutes: t.lateMinutes, early, forgot: t.forgot, commitment: t.commitment, punctual: Math.round(punctual) };
}
/** tasks: 40% completed, 40% on time, 20% quality (finished without being sent back from review) */
export function tasksScore(tasks, range) {
  const rel = tasks.filter(k => (k.due && k.due >= range.from && k.due <= range.to) || (!k.due && k.status === 'done' && inPeriod(k, range)));
  if (!rel.length) return null;
  const done = rel.filter(k => k.status === 'done');
  const onTime = done.filter(k => !k.due || doneDay(k) <= k.due).length;
  const returned = done.filter(k => (k.history || []).some(h => (h.from === 'review' || h.from === 'done') && (h.to === 'in_progress' || h.to === 'new'))).length;
  const completion = done.length / rel.length, timely = done.length ? onTime / done.length : 0, quality = done.length ? 1 - returned / done.length : 0;
  return { score: clamp(40 * completion + 40 * timely + 20 * quality), all: rel.length, done: done.length, onTime, returned };
}
/** KPIs: each actual ÷ target (up to 120%), weighted */
export function kpisScore(kpis) {
  const used = (kpis || []).filter(k => Number(k.target) > 0 && k.actual !== '' && k.actual != null && !isNaN(Number(k.actual)));
  if (!used.length) return null;
  const wsum = used.reduce((s, k) => s + (Number(k.weight) || 1), 0);
  return { score: clamp(used.reduce((s, k) => s + Math.min(Number(k.actual) / Number(k.target), 1.2) * 100 * (Number(k.weight) || 1), 0) / wsum) };
}
export const kpiPct = (k) => (Number(k.target) > 0 && k.actual !== '' && k.actual != null ? Math.round(Number(k.actual) / Number(k.target) * 100) : null);
export function ratingScore(ratings) {
  const r = (ratings || []).map(x => Number(x && typeof x === 'object' ? x.stars : x)).filter(x => x > 0);
  return r.length ? { score: clamp(r.reduce((s, x) => s + x, 0) / r.length / 5 * 100) } : null;
}
/** the weighted total of the pillars that have a score */
export function totalOf(scores, weights = evalSettings().weights) {
  const ks = PILLARS.filter(k => scores[k] != null && (Number(weights[k]) || 0) > 0);
  const w = ks.reduce((s, k) => s + Number(weights[k]), 0);
  return w ? clamp(ks.reduce((s, k) => s + scores[k] * Number(weights[k]), 0) / w) : null;
}
export function gradeOf(total) {
  if (total == null) return null;
  const gs = evalSettings().grades.slice().sort((a, b) => Number(b.min) - Number(a.min));
  const i = gs.findIndex(g => total >= Number(g.min));
  const g = gs[i < 0 ? gs.length - 1 : i];
  const tone = ['ok', 'brand', 'info', 'warn', 'bad'][Math.min(4, Math.round((i < 0 ? gs.length - 1 : i) / Math.max(1, gs.length - 1) * 4))];
  return { name: g.name, tone };
}
/** a department's KPIs with this week's target (a month ÷ 4) */
export const kpiTemplate = (dept) => (evalSettings().kpis[dept] || []).map(k => ({ id: k.id, name: k.name, unit: k.unit || '', weight: Number(k.weight) || 1, monthTarget: Number(k.target) || 0, target: Math.round((Number(k.target) || 0) / 4 * 10) / 10, actual: '' }));

// ---------- storage: evaluations/{email}_{YYYY-MM}_w{1..4} (weeks) and _m (the month, once sent) ----------
export const evalId = (email, month, week) => `${email}_${month}_${week ? `w${week}` : 'm'}`;
export const watchMonthEvals = (month, cb) => watch(query(col('evaluations'), where('month', '==', month)), cb, () => cb([]));
/** the reviews sent to me (every month) */
export const watchMine = (cb, email = session.email) => watch(query(col('evaluations'), where('email', '==', email), where('sent', '==', true)), cb, () => cb([]));
export async function saveWeek(p, month, week, data, { send = false } = {}) {
  if (!canEvaluate()) throw userError('التقييم للأدمن ومدير المشروعات بس.', 'Only admins and project managers review.');
  const scores = { attendance: data.auto.attendance ? data.auto.attendance.score : null, tasks: data.auto.tasks ? data.auto.tasks.score : null, kpis: (kpisScore(data.kpis) || {}).score ?? null, rating: (ratingScore(data.ratings) || {}).score ?? null };
  const total = totalOf(scores);
  const rec = { email: p.email, name: p.name || '', department: p.department || '', month, week, range: periodRange(month, week), auto: data.auto, kpis: data.kpis, ratings: data.ratings, comment: String(data.comment || '').slice(0, 2000),
    scores, weights: evalSettings().weights, total, grade: (gradeOf(total) || {}).name || '', by: session.email, at: serverTimestamp(), ...(send ? { sent: true, sentAt: serverTimestamp(), sentBy: session.email } : {}) };
  await setDoc(doc(db, 'evaluations', evalId(p.email, month, week)), rec, { merge: true });
  if (send) notify(p.email, L(`تقييمك عن أسبوع ${week} وصل`, `Your week ${week} review is here`), L(`${total ?? '—'} من 100 · ${rec.grade}`, `${total ?? '—'} / 100 · ${rec.grade}`), '#/evaluations', 'approved');
  track(send ? 'eval.send' : 'eval.save', { target: nameOf(p.email), detail: `${month} W${week}: ${total ?? '—'}` });
  return rec;
}
/** the month = the average of its reviewed weeks */
export function monthOf(weekDocs) {
  const ws = (weekDocs || []).filter(w => w && w.week);
  if (!ws.length) return null;
  const scores = {};
  PILLARS.forEach(k => { const xs = ws.map(w => w.scores && w.scores[k]).filter(x => x != null); scores[k] = xs.length ? clamp(xs.reduce((s, x) => s + x, 0) / xs.length) : null; });
  const totals = ws.map(w => w.total).filter(x => x != null);
  const total = totals.length ? clamp(totals.reduce((s, x) => s + x, 0) / totals.length) : null;
  return { scores, total, grade: (gradeOf(total) || {}).name || '', weeks: ws.map(w => ({ week: w.week, total: w.total, grade: w.grade })).sort((a, b) => a.week - b.week) };
}
export async function sendMonth(p, month, weekDocs, comment = '') {
  if (!canEvaluate()) throw userError('التقييم للأدمن ومدير المشروعات بس.', 'Only admins and project managers review.');
  const m = monthOf(weekDocs);
  if (!m) throw userError('مفيش أسابيع متقيّمة في الشهر ده.', 'No reviewed weeks in this month.');
  await setDoc(doc(db, 'evaluations', evalId(p.email, month, 0)), { email: p.email, name: p.name || '', department: p.department || '', month, week: 0, ...m, comment: String(comment || '').slice(0, 2000),
    kpiAvg: m.scores.kpis, by: session.email, at: serverTimestamp(), sent: true, sentAt: serverTimestamp(), sentBy: session.email }, { merge: true });
  notify(p.email, L('تقييمك الشهري وصل', 'Your monthly review is here'), L(`${m.total ?? '—'} من 100 · ${m.grade}`, `${m.total ?? '—'} / 100 · ${m.grade}`), '#/evaluations', 'approved');
  track('eval.send', { target: nameOf(p.email), detail: `${month}: ${m.total ?? '—'}` });
}
export async function sendExisting(ev, { quiet = false } = {}) {
  await updateDoc(doc(db, 'evaluations', ev.id), { sent: true, sentAt: serverTimestamp(), sentBy: session.email });
  track('eval.send', { target: nameOf(ev.email), detail: `${ev.month} W${ev.week}: ${ev.total ?? '—'}` });
  if (!quiet) notify(ev.email, ev.week ? L(`تقييمك عن أسبوع ${ev.week} وصل`, `Your week ${ev.week} review is here`) : L('تقييمك الشهري وصل', 'Your monthly review is here'), `${ev.total ?? '—'} · ${ev.grade || ''}`, '#/evaluations', 'approved');
}
/** the employee: opened it / replied */
export const markSeen = (ev) => (ev.seenAt ? Promise.resolve() : updateDoc(doc(db, 'evaluations', ev.id), { seenAt: serverTimestamp() }).catch(() => {}));
export async function reply(ev, text) {
  const t = String(text || '').trim().slice(0, 1000);
  if (!t) return;
  await updateDoc(doc(db, 'evaluations', ev.id), { reply: t, replyAt: serverTimestamp(), seenAt: ev.seenAt || serverTimestamp() });
  notify(ev.sentBy || ev.by, L(`${nameOf(session.email)} ردّ على تقييمه`, `${nameOf(session.email)} replied to their review`), t.slice(0, 140), '#/evaluations', 'info');
}
export const sentLabel = (ev) => (ev && ev.sent ? (ev.seenAt ? L('اتبعت · شافه', 'Sent · seen') : L('اتبعت', 'Sent')) : (ev ? L('اتقيّم', 'Reviewed') : L('لسه', 'Not yet')));
