// Monthly calculations shared by "My attendance", monthly reports and payroll.
import { list, query, col, where, toMs } from '../core/fb.js';
import { session, now, isHR, seesAll, isFinance } from '../core/session.js';
import { policy, planFor, lateness, earlyLeave, isWorkingPlan, lateDeductionDays, dayKey, leaveType, trackedSince } from '../core/policy.js';
import { person } from './directory.js';
import { monthDates, hmToMin, minutesOfDay } from '../core/utils.js';
import { rangeDays, monthDays } from './attendance.js';
import { activePeople, allPeople, trackedPeople } from './directory.js';

/** Approved excuse minutes that cover a given check-in / check-out */
function excuseCovers(excuses, date, kind, minute) {
  return excuses.some(e => e.startDate === date && (e.excuseKind || 'late') === kind && (kind === 'late' ? hmToMin(e.toTime) >= minute : hmToMin(e.fromTime) <= minute));
}

/** Classify one day for one person */
export function classifyDay(date, plan, rec, excuses, todayKey, since = '') {
  const row = { date, plan, rec: rec || null, status: 'none', mode: plan.mode, late: 0, early: 0, workMs: 0, breakMs: 0, meetingMs: 0, flags: [] };
  if (rec && rec.status) {
    row.status = rec.status;
  }
  if (rec && rec.checkInMs) {
    row.status = row.status === 'none' ? (rec.mode === 'remote' ? 'remote' : 'present') : row.status;
    row.mode = rec.mode || plan.mode;
    row.workMs = rec.workMs || 0; row.breakMs = rec.breakMs || 0; row.meetingMs = rec.meetingMs || 0;
    const effPlan = isWorkingPlan(plan) ? plan : { ...plan, mode: 'office', start: null };
    if (isWorkingPlan(plan)) {
      const l = lateness(rec.checkInMs, effPlan).late;
      row.late = l && excuseCovers(excuses, date, 'late', Math.round(minutesOfDay(rec.checkInMs))) ? 0 : l;
      const e = rec.closed ? earlyLeave(rec.checkOutMs, effPlan, date) : 0;
      row.early = e && excuseCovers(excuses, date, 'early', Math.round(minutesOfDay(rec.checkOutMs))) ? 0 : e;
      if (row.late && l !== row.late) row.flags.push('excused');
    } else row.flags.push('extra-day');
    if (rec.autoClosed) row.flags.push('forgot');
    if (rec.remotePending) row.flags.push('remote-pending');
    if (rec.corrected) row.flags.push('corrected');
    return row;
  }
  if (row.status !== 'none') return row;
  if (plan.mode === 'leave') { row.status = 'leave'; return row; }
  if (plan.mode === 'off' || plan.mode === 'holiday') { row.status = plan.mode; return row; }
  if (plan.mode === 'mission') { row.status = 'mission'; return row; }
  if (date > todayKey) { row.status = 'future'; return row; }
  if (date === todayKey) { row.status = 'today'; return row; }
  if (since && date < since) { row.status = 'none'; row.flags.push('untracked'); return row; }
  row.status = 'absent';
  return row;
}

export function summarize(rows) {
  const t = { planned: 0, present: 0, office: 0, remote: 0, mission: 0, absent: 0, leave: 0, leaveByType: {}, unpaidLeave: 0, off: 0, holiday: 0, lateDays: 0, lateMinutes: 0, earlyMinutes: 0, workMs: 0, breakMs: 0, meetingMs: 0, forgot: 0, lateDeductDays: 0, extraDays: 0 };
  rows.forEach(r => {
    if (r.flags.includes('untracked')) return;
    if (isWorkingPlan(r.plan) || r.plan.mode === 'leave') t.planned++;
    switch (r.status) {
      case 'present': t.present++; t.office++; break;
      case 'remote': t.present++; t.remote++; break;
      case 'mission': t.present++; t.mission++; break;
      case 'absent': t.absent++; break;
      case 'leave': {
        t.leave++;
        const lt = (r.plan && r.plan.leaveType) || (r.rec && r.rec.leaveType) || 'annual';
        t.leaveByType[lt] = (t.leaveByType[lt] || 0) + 1;
        if (leaveType(lt).paid === false) t.unpaidLeave++;
        break;
      }
      case 'off': t.off++; break;
      case 'holiday': t.holiday++; break;
    }
    if (r.late) { t.lateDays++; t.lateMinutes += r.late; t.lateDeductDays += lateDeductionDays(r.late); }
    t.earlyMinutes += r.early || 0;
    t.workMs += r.workMs; t.breakMs += r.breakMs; t.meetingMs += r.meetingMs;
    if (r.flags.includes('forgot')) t.forgot++;
    if (r.flags.includes('extra-day')) t.extraDays++;
  });
  // attendance commitment: share of planned working days not lost to absence
  const attended = Math.max(0, t.present - t.extraDays);
  const due = attended + t.absent;
  t.commitment = due > 0 ? Math.round((attended / due) * 100) : 100;
  return t;
}

/** One person, one month */
export async function personMonth(email, ym, leaderScope) {
  const [days, schedules, reqs] = await Promise.all([
    monthDays(email, ym, leaderScope),
    list(query(col('schedules'), ...(leaderScope ? [where('leaderEmail', '==', leaderScope)] : []), where('email', '==', email), where('month', '==', ym))).catch(() => []),
    list(query(col('requests'), ...(leaderScope ? [where('leaderEmail', '==', leaderScope)] : []), where('email', '==', email))).catch(() => [])
  ]);
  const schedule = schedules[0] || null;
  const excuses = reqs.filter(r => r.type === 'excuse' && r.status === 'approved');
  const recs = Object.fromEntries(days.map(d => [d.date, d]));
  const todayKey = dayKey(now());
  const since = trackedSince(person(email));
  const rows = monthDates(ym).map(d => classifyDay(d, planFor(d, schedule), recs[d], excuses, todayKey, since));
  return { rows, totals: summarize(rows), schedule, requests: reqs };
}

/** Everyone I manage, one month */
export async function teamMonth(ym, { people } = {}) {
  const all = seesAll() || isFinance();
  const scope = all ? undefined : session.email;
  const from = `${ym}-01`, to = `${ym}-31`;
  const [days, schedules, reqs] = await Promise.all([
    rangeDays(from, to, scope),
    list(query(col('schedules'), ...(scope ? [where('leaderEmail', '==', scope)] : []), where('month', '==', ym))).catch(() => []),
    list(query(col('requests'), ...(scope ? [where('leaderEmail', '==', scope)] : []), where('startDate', '>=', `${ym}-01`))).catch(() => [])
  ]);
  const ppl = (people || (all ? activePeople() : activePeople().filter(p => p.leaderEmail === session.email))).filter(p => p.trackAttendance !== false);
  const todayKey = dayKey(now());
  const out = ppl.map(p => {
    const sch = schedules.find(s => s.email === p.email) || null;
    const recs = Object.fromEntries(days.filter(d => d.email === p.email).map(d => [d.date, d]));
    const excuses = reqs.filter(r => r.email === p.email && r.type === 'excuse' && r.status === 'approved');
    const since = trackedSince(p);
    const rows = monthDates(ym).map(d => classifyDay(d, planFor(d, sch), recs[d], excuses, todayKey, since));
    const myReqs = reqs.filter(r => r.email === p.email && (r.startDate || '').slice(0, 7) === ym);
    return { person: p, rows, totals: summarize(rows), requests: myReqs };
  });
  return { people: out, days, schedules, requests: reqs };
}

export const STATUS_DAY = {
  present: { ar: 'حاضر', en: 'Present', cls: 'present', badge: 'ok' },
  remote: { ar: 'أونلاين', en: 'Remote', cls: 'remote', badge: 'brand' },
  mission: { ar: 'مأمورية', en: 'Mission', cls: 'present', badge: 'info' },
  absent: { ar: 'غياب', en: 'Absent', cls: 'absent', badge: 'bad' },
  leave: { ar: 'إجازة', en: 'Leave', cls: 'leave', badge: 'warn' },
  off: { ar: 'راحة', en: 'Off', cls: 'off', badge: '' },
  holiday: { ar: 'عطلة', en: 'Holiday', cls: 'holiday', badge: '' },
  future: { ar: '', en: '', cls: '', badge: '' },
  today: { ar: 'النهارده', en: 'Today', cls: '', badge: 'brand' },
  none: { ar: '—', en: '—', cls: '', badge: '' }
};
