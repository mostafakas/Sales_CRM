// Performance: every criterion is measured by the system (tasks, attendance, discipline…) except the few marked
// "manual" (the reviewer gives 1–5 stars and must write the evidence). The month's review then goes up a chain —
// leader → team supervisor → project manager → HR → admin — each stage approving (with notes), editing the
// manual scores or returning it one step; the admin sends it to the employee. Weights, criteria, grades (with the
// share of the salary's variable part each grade earns) live in Settings → Reviews.
import { db, doc, col, watch, query, where, setDoc, updateDoc, serverTimestamp, toMs, arrayUnion } from '../core/fb.js';
import { session, now, isAdmin, isPM, isHR, LEADER_ROLES } from '../core/session.js';
import { userError } from '../core/ui.js';
import { L } from '../core/utils.js';
import { policy, isWorkingPlan, savePolicy } from '../core/policy.js';
import { summarize } from './reports.js';
import { inPeriod, doneDay } from './tasks.js';
import { notify } from './notify.js';
import { person, activePeople, nameOf } from './directory.js';
import { track } from './activity.js';

// ---------- what each criterion can be measured by ----------
export const METRICS = {
  target: { kind: 'employee', icon: 'fa-bullseye', ar: 'نسبة إنجاز التاسكات المطلوبة', en: 'Share of due tasks finished' },
  quality: { kind: 'employee', icon: 'fa-gem', ar: 'التاسكات اللي اتقبلت من أول مرة', en: 'Tasks accepted first time' },
  punctuality: { kind: 'employee', icon: 'fa-clock', ar: 'الحضور في الميعاد + تسليم التاسكات في ميعادها', en: 'On-time arrival + on-time delivery' },
  discipline: { kind: 'both', icon: 'fa-shield-halved', ar: 'الانضباط: غياب، نسيان قفل اليوم، بريك زيادة، انصراف بدري', en: 'Discipline: absence, forgotten day-end, long breaks, leaving early' },
  response: { kind: 'employee', icon: 'fa-bolt', ar: 'سرعة البدء في التاسك بعد ما يتسند', en: 'How fast assigned tasks are started' },
  team_target: { kind: 'leader', icon: 'fa-bullseye', ar: 'نسبة إنجاز تاسكات الفريق', en: 'Team tasks finished' },
  team_quality: { kind: 'leader', icon: 'fa-gem', ar: 'تاسكات الفريق اللي اتقبلت من أول مرة', en: 'Team tasks accepted first time' },
  lead_punctuality: { kind: 'leader', icon: 'fa-clock', ar: 'حضوره في الميعاد + تسليم الفريق في الميعاد', en: 'Own arrival + team on-time delivery' },
  planning: { kind: 'leader', icon: 'fa-diagram-project', ar: 'تاسكات الفريق بمواعيد تسليم + توزيع متوازن', en: 'Team tasks with due dates + balanced load' },
  team_dev: { kind: 'leader', icon: 'fa-seedling', ar: 'متوسط درجات فريقه', en: 'Average score of the team' },
  review_speed: { kind: 'leader', icon: 'fa-bolt', ar: 'سرعة مراجعة تاسكات الفريق', en: 'How fast team tasks are reviewed' },
  manual: { kind: 'both', icon: 'fa-star', ar: 'تقييم المدير (من 5 + دليل مكتوب)', en: 'Manager rating (out of 5 + evidence)' }
};
export const metricLabel = (k) => (METRICS[k] ? L(METRICS[k].ar, METRICS[k].en) : k);
export const TEMPLATES = { employee: ['الموظف', 'Employee'], leader: ['الليدر والسوبر فايزر', 'Leader & supervisor'] };
export const DEFAULT_EVAL = {
  templates: {
    employee: [
      { id: 'target', name: 'تحقيق التارجت', weight: 30, source: 'target' },
      { id: 'quality', name: 'جودة ودقة العمل (القبول من أول مرة)', weight: 35, source: 'quality' },
      { id: 'punct', name: 'الالتزام بالمواعيد', weight: 10, source: 'punctuality' },
      { id: 'rules', name: 'اتباع النظام والتعليمات', weight: 10, source: 'discipline' },
      { id: 'coop', name: 'التعاون والسلوك المهني', weight: 5, source: 'manual' },
      { id: 'resp', name: 'الاستجابة والمتابعة', weight: 5, source: 'response' },
      { id: 'smart', name: 'الذكاء وحل المشكلات والابتكار (بأدلة)', weight: 5, source: 'manual' }
    ],
    leader: [
      { id: 'dtarget', name: 'تحقيق مستهدفات القسم', weight: 25, source: 'team_target' },
      { id: 'dquality', name: 'جودة مخرجات القسم', weight: 20, source: 'team_quality' },
      { id: 'punct', name: 'الالتزام بالمواعيد', weight: 15, source: 'lead_punctuality' },
      { id: 'plan', name: 'التخطيط وتوزيع المهام', weight: 10, source: 'planning' },
      { id: 'lead', name: 'قيادة وتطوير الفريق', weight: 10, source: 'team_dev' },
      { id: 'resp', name: 'الاستجابة والمتابعة', weight: 5, source: 'review_speed' },
      { id: 'rules', name: 'الالتزام بالتقارير والنظام', weight: 10, source: 'discipline' },
      { id: 'smart', name: 'حل المشكلات والابتكار', weight: 10, source: 'manual' }
    ]
  },
  grades: [
    { name: 'متميز', min: 90, effect: 'مؤهل للترقية والمكافأة الاستثنائية', variable: 100 },
    { name: 'مطابق للتوقعات', min: 80, effect: 'استحقاق كامل للمتغير', variable: 100 },
    { name: 'تقريب من التوقعات', min: 70, effect: 'استحقاق جزئي + خطة تطوير', variable: 50 },
    { name: 'دون المستوى', min: 0, effect: 'مراجعة فورية مع المدير', variable: 0 }
  ],
  salaryLink: false   // the salary's variable (KPI) part = the grade's share, once the month's review is sent
};
export function evalSettings() {
  const e = policy.evaluation || {};
  const t = e.templates || {};
  return {
    templates: { employee: (t.employee && t.employee.length ? t.employee : DEFAULT_EVAL.templates.employee), leader: (t.leader && t.leader.length ? t.leader : DEFAULT_EVAL.templates.leader) },
    grades: (e.grades && e.grades.length && e.grades[0].effect !== undefined ? e.grades : DEFAULT_EVAL.grades),
    salaryLink: !!e.salaryLink
  };
}
export const saveEvalSettings = (patch) => savePolicy({ evaluation: { ...evalSettings(), ...patch } });

// ---------- grades ----------
const clamp = (x) => Math.max(0, Math.min(100, Math.round(x)));
const pct = (a, b) => (b > 0 ? clamp(a / b * 100) : null);
export function gradeOf(total) {
  if (total == null) return null;
  const gs = evalSettings().grades.slice().sort((a, b) => Number(b.min) - Number(a.min));
  let i = gs.findIndex(g => total >= Number(g.min));
  if (i < 0) i = gs.length - 1;
  const tones = ['ok', 'brand', 'warn', 'bad'];
  const tone = gs.length <= 1 ? 'ok' : tones[Math.round(i / (gs.length - 1) * 3)];
  return { ...gs[i], tone };
}
export const toneOf = (v) => (v == null ? '' : v >= 80 ? 'ok' : v >= 70 ? 'brand' : v >= 50 ? 'warn' : 'bad');

// ---------- who is measured with which template, and by whom ----------
export const isLeaderish = (p) => !!p && p.role !== 'admin' && (LEADER_ROLES.includes(p.role) || activePeople().some(x => x.leaderEmail === p.email && !x.isSuspended));
export const templateOf = (p) => (isLeaderish(p) ? 'leader' : 'employee');
/** a leader's team: direct reports, and for a team supervisor the teams of the leaders under them */
export function teamOfPerson(p) {
  const direct = activePeople().filter(x => x.leaderEmail === p.email && x.email !== p.email);
  if (p.role !== 'team_supervisor') return direct;
  const leads = new Set(direct.map(x => x.email));
  return [...direct, ...activePeople().filter(x => leads.has(x.leaderEmail) && x.email !== p.email)];
}
export const STAGES = {
  leader: { ar: 'الليدر', en: 'Leader', icon: 'fa-user-tie' },
  supervisor: { ar: 'السوبر فايزر', en: 'Supervisor', icon: 'fa-user-shield' },
  pm: { ar: 'مدير المشروعات', en: 'Project manager', icon: 'fa-diagram-project' },
  hr: { ar: 'HR', en: 'HR', icon: 'fa-id-badge' },
  admin: { ar: 'الأدمن', en: 'Admin', icon: 'fa-crown' }
};
export const stageLabel = (k) => L(STAGES[k].ar, STAGES[k].en);
/** the review chain of one person: leader → supervisor → PM → HR → admin, skipping what does not exist */
export function chainFor(p) {
  const out = [];
  const add = (key, email = '') => { if (!email || email !== p.email) out.push({ key, email }); };
  const ld = p.leaderEmail && person(p.leaderEmail);
  if (ld && !ld.isSuspended && !['admin', 'pm', 'hr'].includes(ld.role)) {
    add(ld.role === 'team_supervisor' ? 'supervisor' : 'leader', ld.email);
    const sv = ld.role !== 'team_supervisor' && ld.leaderEmail && person(ld.leaderEmail);
    if (sv && !sv.isSuspended && sv.role === 'team_supervisor') add('supervisor', sv.email);
  }
  if (p.role !== 'pm' && activePeople().some(x => x.role === 'pm')) add('pm');
  if (p.role !== 'hr' && activePeople().some(x => x.role === 'hr')) add('hr');
  add('admin');
  return out;
}
const actsAs = (s) => !!s && (s.email ? s.email === session.email : (s.key === 'admin' ? isAdmin() : session.role === s.key));
/** may I act on this review now? (the admin may act at any stage) */
export const canAct = (ev) => !!ev && !ev.sent && !!ev.chain && ev.email !== session.email && (isAdmin() || actsAs(ev.chain[ev.stage]));
/** may I start this person's review? (the first stage, or the admin) */
export const canStart = (p) => !!p && p.email !== session.email && (isAdmin() || actsAs(chainFor(p)[0]));
export const seesAllReviews = () => isAdmin() || isPM() || isHR();
/** whose performance I may open */
export function viewable() {
  if (seesAllReviews()) return activePeople().filter(p => p.role !== 'admin' && p.email !== session.email);
  const me = person(session.email);
  return me ? teamOfPerson(me) : [];
}
export const canView = (email) => email === session.email || viewable().some(p => p.email === email);

// ---------- the measures ----------
const HOUR = 3600000;
const inR = (d, r) => !!d && d >= r.from && d <= r.to;
const dayOf = (ms) => new Date(ms + 3 * HOUR).toISOString().slice(0, 10);
const createdMs = (k) => toMs(k.createdAt) || ((k.history || [])[0] || {}).at || null;
const returned = (k) => (k.history || []).some(h => (h.from === 'review' || h.from === 'done') && (h.to === 'in_progress' || h.to === 'new'));
/** tasks that belong to a period: due in it, or (no due date) finished in it */
const relevant = (ts, range) => ts.filter(k => inR(k.due, range) || (!k.due && k.status === 'done' && inPeriod(k, range)));
const hrs = (h) => (h < 1 ? L('أقل من ساعة', 'under an hour') : h < 48 ? L(`${Math.round(h)} ساعة`, `${Math.round(h)} h`) : L(`${Math.round(h / 24)} يوم`, `${Math.round(h / 24)} days`));
/** hours to act → score: ≤ 4h 100, 24h 70, 72h+ 30 */
const speedScore = (h) => clamp(h <= 4 ? 100 : h <= 24 ? 100 - (h - 4) * 1.5 : h <= 72 ? 70 - (h - 24) * 40 / 48 : 30);
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const endOf = (range) => Math.min(now(), new Date(`${range.to}T23:59:59+03:00`).getTime());

function completion(ts) {
  if (!ts.length) return null;
  const done = ts.filter(k => k.status === 'done').length;
  return { score: pct(done, ts.length), fact: L(`خلص ${done} من ${ts.length} تاسك`, `${done} of ${ts.length} tasks finished`) };
}
function firstTime(ts) {
  const done = ts.filter(k => k.status === 'done');
  if (!done.length) return null;
  const ok = done.filter(k => !returned(k)).length;
  return { score: pct(ok, done.length), fact: L(`${ok} من ${done.length} اتقبل من أول مرة${done.length - ok ? ` · ${done.length - ok} رجع للتعديل` : ''}`, `${ok} of ${done.length} accepted first time`) };
}
function onTimeTasks(ts) {
  const done = ts.filter(k => k.status === 'done' && k.due);
  if (!done.length) return null;
  const ok = done.filter(k => doneDay(k) <= k.due).length;
  return { score: pct(ok, done.length), ok, all: done.length };
}
function arrival(rows) {
  const att = rows.filter(r => r.rec && r.rec.checkInMs && isWorkingPlan(r.plan));
  if (!att.length) return null;
  const ok = att.filter(r => !r.late).length;
  return { score: pct(ok, att.length), ok, all: att.length };
}
const mix = (a, d, aTxt, dTxt) => (!a && !d ? null : { score: clamp(avg([a && a.score, d && d.score].filter(x => x != null))), fact: [a && aTxt(a), d && dTxt(d)].filter(Boolean).join(' · ') });
function discipline(rows) {
  const t = summarize(rows);
  if (t.present + t.absent === 0) return null;
  const breakOver = rows.filter(r => r.breakMs > (Number(policy.breakMaxMinutes) || 60) * 60000).length;
  const early = rows.filter(r => r.early > 0).length;
  const score = clamp(100 - (t.absent * 15 + t.forgot * 5 + breakOver * 3 + early * 5));
  const bits = [t.absent && L(`غياب ${t.absent}`, `${t.absent} absent`), t.forgot && L(`نسي يقفل ${t.forgot}`, `forgot ${t.forgot}`), breakOver && L(`بريك زيادة ${breakOver}`, `long break ${breakOver}`), early && L(`انصراف بدري ${early}`, `left early ${early}`)].filter(Boolean);
  return { score, fact: bits.length ? bits.join(' · ') : L('مفيش أي مخالفة 👌', 'No violations 👌') };
}
/** hours from being assigned a task to starting it (tasks assigned in the period by someone else) */
function response(ts, range, email) {
  const end = endOf(range);
  const hs = ts.filter(k => k.assignee === email && k.createdBy !== email).map(k => {
    const c = createdMs(k);
    if (!c || !inR(dayOf(c), range)) return null;
    const st = (k.history || []).find(h => h.at >= c && ['in_progress', 'review', 'done'].includes(h.to));
    return st ? (st.at - c) / HOUR : ((end - c) / HOUR > 24 ? (end - c) / HOUR : null);   // not started for over a day counts too
  }).filter(h => h != null);
  if (!hs.length) return null;
  const h = avg(hs);
  return { score: speedScore(h), fact: L(`متوسط ${hrs(h)} لحد ما يبدأ (${hs.length} تاسك)`, `${hrs(h)} on average to start (${hs.length} tasks)`) };
}
/** hours a team task waits in "Review" before the leader finishes it or sends it back */
function reviewSpeed(ts, range) {
  const end = endOf(range);
  const hs = [];
  ts.forEach(k => {
    const h = k.history || [];
    h.forEach((x, i) => {
      if (x.to !== 'review' || x.from === 'review' || !inR(dayOf(x.at), range)) return;
      const out = h.slice(i + 1).find(y => y.from === 'review' && y.to !== 'review');
      if (out) hs.push((out.at - x.at) / HOUR); else if ((end - x.at) / HOUR > 24) hs.push((end - x.at) / HOUR);
    });
  });
  if (!hs.length) return null;
  const h = avg(hs);
  return { score: speedScore(h), fact: L(`متوسط ${hrs(h)} لحد ما يراجع (${hs.length} مراجعة)`, `${hrs(h)} on average to review (${hs.length})`) };
}
function planning(ts, range, team) {
  const made = ts.filter(k => { const c = createdMs(k); return c && inR(dayOf(c), range); });
  if (!made.length) return null;
  const planned = made.filter(k => k.due && k.assignee).length;
  const counts = team.map(p => made.filter(k => k.assignee === p.email).length);
  const mean = avg(counts) || 0;
  const sd = counts.length > 1 && mean ? Math.sqrt(avg(counts.map(c => (c - mean) ** 2))) : 0;
  const balance = mean ? Math.max(0, 1 - sd / mean) * 100 : 100;
  return { score: clamp(0.7 * pct(planned, made.length) + 0.3 * balance), fact: L(`${planned} من ${made.length} تاسك ليه ميعاد ومسؤول · توازن التوزيع ${Math.round(balance)}%`, `${planned}/${made.length} with a due date and owner · balance ${Math.round(balance)}%`) };
}

/**
 * Every criterion of one person for one period, measured from what the viewer can see.
 * ctx: { rows (their classified days), tasks (all visible tasks), range, teamRows: { email → rows } }
 * manual: { criterionId → { stars, evidence } }
 */
export function measure(p, ctx, manual = {}, depth = 0) {
  const tpl = templateOf(p);
  const crit = evalSettings().templates[tpl];
  const mine = ctx.tasks.filter(k => k.assignee === p.email);
  const team = tpl === 'leader' ? teamOfPerson(p) : [];
  const teamSet = new Set(team.map(x => x.email));
  const teamTasks = tpl === 'leader' ? ctx.tasks.filter(k => teamSet.has(k.assignee) || (k.leader === p.email && k.assignee !== p.email)) : [];
  const relMine = relevant(mine, ctx.range), relTeam = relevant(teamTasks, ctx.range);
  const arr = (a) => L(`حضر في الميعاد ${a.ok} من ${a.all} يوم`, `on time ${a.ok}/${a.all} days`);
  const out = crit.map(c => {
    let r = null;
    switch (c.source) {
      case 'target': r = completion(relMine); break;
      case 'quality': r = firstTime(relMine); break;
      case 'punctuality': r = mix(arrival(ctx.rows), onTimeTasks(relMine), arr, d => L(`سلّم في الميعاد ${d.ok} من ${d.all} تاسك`, `delivered on time ${d.ok}/${d.all}`)); break;
      case 'discipline': r = discipline(ctx.rows); break;
      case 'response': r = response(ctx.tasks, ctx.range, p.email); break;
      case 'team_target': r = completion(relTeam); break;
      case 'team_quality': r = firstTime(relTeam); break;
      case 'lead_punctuality': r = mix(arrival(ctx.rows), onTimeTasks(relTeam), arr, d => L(`الفريق سلّم في الميعاد ${d.ok} من ${d.all}`, `team on time ${d.ok}/${d.all}`)); break;
      case 'planning': r = planning(teamTasks, ctx.range, team); break;
      case 'team_dev': {
        if (depth > 0) break;
        const ts = team.map(x => measure(x, { ...ctx, rows: (ctx.teamRows || {})[x.email] || [] }, {}, 1).total).filter(x => x != null);
        r = ts.length ? { score: clamp(avg(ts)), fact: L(`متوسط درجات ${ts.length} من فريقه`, `average of ${ts.length} team members`) } : null;
        break;
      }
      case 'review_speed': r = reviewSpeed(teamTasks, ctx.range); break;
      case 'manual': {
        const m = manual[c.id];
        r = m && Number(m.stars) > 0 ? { score: clamp(Number(m.stars) / 5 * 100), fact: m.evidence || '', stars: Number(m.stars), evidence: m.evidence || '' } : null;
        break;
      }
    }
    return { id: c.id, name: c.name, weight: Number(c.weight) || 0, source: c.source, score: r ? r.score : null, fact: r ? r.fact : '', ...(r && r.stars ? { stars: r.stars, evidence: r.evidence } : {}) };
  });
  return { template: tpl, criteria: out, total: totalOf(out) };
}
/** the weighted total of the criteria that have a score (missing ones are left out and the rest scaled) */
export function totalOf(criteria) {
  const xs = criteria.filter(c => c.score != null && c.weight > 0);
  const w = xs.reduce((s, c) => s + c.weight, 0);
  return w ? clamp(xs.reduce((s, c) => s + c.score * c.weight, 0) / w) : null;
}

// ---------- the monthly review: evaluations/{email}_{YYYY-MM} ----------
export const evalId = (email, month) => `${email}_${month}`;
export const watchReview = (email, month, cb) => watch(doc(db, 'evaluations', evalId(email, month)), cb, () => cb(null));
export const watchMonthReviews = (month, cb) => watch(seesAllReviews() ? query(col('evaluations'), where('month', '==', month))
  : query(col('evaluations'), where('chainEmails', 'array-contains', session.email)), rows => cb(rows.filter(r => r.month === month)), () => cb([]));
/** reviews waiting for me (nav badge) */
export const watchPending = (cb) => watch(seesAllReviews() ? query(col('evaluations'), where('sent', '==', false))
  : query(col('evaluations'), where('chainEmails', 'array-contains', session.email)), rows => cb(rows.filter(canAct)), () => cb([]));

const stageActors = (s) => (s.email ? [s.email] : activePeople().filter(p => p.role === s.key).map(p => p.email));

/**
 * One step of the chain.
 * action: 'save' (keep my draft, nothing moves) | 'submit' (approve and pass on; at the last stage = send) | 'return' (one step back)
 * fresh: measure() of the month by the actor — stored when the actor sees everyone's data (or starts the review)
 */
export async function act(p, month, ev, { action, fresh, manual = {}, comment = '', notes = {}, reason = '', hidden = null }) {
  const chain = ev ? ev.chain : chainFor(p);
  const stage = ev ? ev.stage : 0;
  if (ev ? !canAct(ev) : !canStart(p)) throw userError('التقييم ده مش عندك دلوقتي.', 'This review is not with you now.');
  const s = chain[stage];
  const last = stage === chain.length - 1;
  const crit = (seesAllReviews() || !ev || stage === 0 ? fresh.criteria : ev.criteria).map(c => {
    if (c.source !== 'manual') return c;
    const m = manual[c.id] || {};
    const stars = Number(m.stars) || 0, evidence = String(m.evidence || '').trim().slice(0, 1000);
    return { ...c, stars, evidence, score: stars ? clamp(stars / 5 * 100) : null, fact: evidence };
  });
  if (action === 'submit') {
    const miss = crit.find(c => c.source === 'manual' && (!c.stars || !c.evidence));
    if (miss) throw userError(`«${miss.name}»: لازم تدّي درجة وتكتب الدليل.`, `"${miss.name}": give a rating and write the evidence.`);
  }
  if (action === 'return' && (!stage || !String(reason).trim())) throw userError('اكتب سبب الإرجاع.', 'Write why you are returning it.');
  const total = totalOf(crit), g = gradeOf(total) || {};
  const cleanNotes = Object.fromEntries(Object.entries(notes).map(([k, v]) => [k, String(v || '').trim().slice(0, 1000)]).filter(([, v]) => v));
  const send = action === 'submit' && last;
  const entry = { stage: s.key, by: session.email, name: nameOf(session.email), at: now(), action: send ? 'send' : action, comment: String(comment || '').trim().slice(0, 3000), notes: cleanNotes, ...(action === 'return' ? { reason: String(reason).trim().slice(0, 500) } : {}) };
  const next = send ? stage : action === 'submit' ? stage + 1 : action === 'return' ? stage - 1 : stage;
  const rec = {
    email: p.email, name: p.name || '', department: p.department || '', title: p.title || '', month, template: fresh.template,
    chain, chainEmails: chain.map(x => x.email).filter(Boolean), criteria: crit, total, grade: g.name || '', effect: g.effect || '', variable: g.variable ?? null,
    stage: next, sent: send, status: send ? 'sent' : action === 'return' ? 'returned' : action === 'save' ? ((ev && ev.status) || 'draft') : 'in_review',
    draft: action === 'save' ? { by: session.email, comment: entry.comment, notes: cleanNotes } : null,
    ...(hidden ? { hidden } : {}),
    updatedAt: serverTimestamp(), ...(ev ? {} : { createdAt: serverTimestamp(), createdBy: session.email }),
    ...(send ? { sentAt: serverTimestamp(), sentBy: session.email } : {}),
    ...(action === 'save' ? {} : { reviews: arrayUnion(entry) })
  };
  await setDoc(doc(db, 'evaluations', evalId(p.email, month)), rec, { merge: true });
  const who = p.name || nameOf(p.email);
  const link = `#/stats/${encodeURIComponent(p.email)}`;
  if (send) notify(p.email, L('تقييمك الشهري وصل', 'Your monthly review is here'), L(`${total ?? '—'} من 100 · ${g.name || ''}`, `${total ?? '—'} / 100 · ${g.name || ''}`), '#/stats', 'approved');
  else if (action === 'submit') stageActors(chain[next]).forEach(e => notify(e, L(`تقييم ${who} مستني اعتمادك`, `${who}'s review needs your approval`), L(`اعتمده ${nameOf(session.email)} (${stageLabel(s.key)})`, `approved by ${nameOf(session.email)}`), link, 'info'));
  else if (action === 'return') {
    const back = ((ev && ev.reviews) || []).filter(r => r.stage === chain[next].key && r.action !== 'return').pop();
    (back ? [back.by] : stageActors(chain[next])).forEach(e => notify(e, L(`تقييم ${who} رجعلك`, `${who}'s review was returned`), entry.reason, link, 'rejected'));
  }
  if (action !== 'save') track(send ? 'eval.send' : action === 'return' ? 'eval.return' : 'eval.approve', { target: who, detail: `${month}: ${total ?? '—'}` });
  return { total, grade: g.name || '', sent: send };
}
/** the employee: opened it / replied */
export const markSeen = (ev) => (ev.seenAt ? Promise.resolve() : updateDoc(doc(db, 'evaluations', ev.id), { seenAt: serverTimestamp() }).catch(() => {}));
export async function reply(ev, text) {
  const t = String(text || '').trim().slice(0, 1000);
  if (!t) return;
  await updateDoc(doc(db, 'evaluations', ev.id), { reply: t, replyAt: serverTimestamp(), seenAt: ev.seenAt || serverTimestamp() });
  notify(ev.sentBy, L(`${nameOf(session.email)} ردّ على تقييمه`, `${nameOf(session.email)} replied to their review`), t.slice(0, 140), `#/stats/${encodeURIComponent(session.email)}`, 'info');
}
