// Attendance engine: start day, status changes, end day, and closing days people forgot to end.
// Live state lives on users/{email}; each work day is archived in attendance_days/{email}_{date}.
import {
  db, doc, col, writeBatch, serverTimestamp, toMs, read, list, query, where, addDoc, getDoc, setDoc, listF
} from '../core/fb.js';
import { session, now, isHR, seesAll, isFinance } from '../core/session.js';
import { policy, dayKey, planFor } from '../core/policy.js';
import { cairoMs, addDays, L } from '../core/utils.js';

export const COUNTED = ['Online', 'Break', 'Meeting'];
export const dayDocId = (email, date) => `${email}_${date}`;
const zeroBank = () => ({ Online: 0, Break: 0, Meeting: 0 });

export function liveBank(u, at = now()) {
  const bank = { ...zeroBank(), ...(u && u.timeBank || {}) };
  const st = u && u.status;
  if (st && st !== 'Offline' && COUNTED.includes(st)) {
    const start = toMs(u.lastChange) || u.lastChangeClient || at;
    bank[st] += Math.max(0, at - start);
  }
  return bank;
}

function logEntry(u, email, from, to, dur, by, key) {
  return {
    user: email, name: (u && u.name) || email, leaderEmail: (u && u.leaderEmail) || '', from_status: from || 'Offline', to_status: to,
    duration_ms: COUNTED.includes(from) ? Math.round(dur) : null,
    changed_by: by === session.email ? 'user' : 'admin', changed_by_email: by, changed_by_name: (session.profile && session.profile.name) || by,
    dayKey: key, timestamp: serverTimestamp()
  };
}

/** Returns the stale day key if the user has an unfinished previous day */
export function staleDay(u, at = now()) {
  if (!u || !u.dayKey) return null;
  const today = dayKey(at);
  if (u.dayKey >= today) return null;
  // days from the old system (before go-live, or docs the new app never touched) are not reviewable here
  if (u.checkedOut === undefined) return null;
  if (policy.trackingStart && u.dayKey < policy.trackingStart) return null;
  if (u.checkedOut && (!u.status || u.status === 'Offline')) return null;
  return u.dayKey;
}

/**
 * Close a previous day that was never ended. Time still running is counted only up to the
 * planned end of that day, and the day is flagged so HR can review it.
 */
export async function closeStaleDay(email, u, by = session.email) {
  window.dispatchEvent(new Event('am:data-changed'));
  const key = u.dayKey;
  const sched = await read('schedules', `${email}_${key.slice(0, 7)}`).catch(() => null);
  const plan = planFor(key, sched);
  const endCap = cairoMs(key, plan.end || policy.workEnd);
  const bank = { ...zeroBank(), ...(u.timeBank || {}) };
  const last = toMs(u.lastChange) || endCap;
  let add = 0;
  if (u.status && u.status !== 'Offline' && COUNTED.includes(u.status)) {
    add = Math.max(0, endCap - last);
    bank[u.status] += add;
  }
  const checkOut = Math.max(last, u.status !== 'Offline' ? endCap : last);
  const b = writeBatch(db);
  b.update(doc(db, 'users', email), { status: 'Offline', timeBank: bank, lastChange: serverTimestamp(), lastChangeClient: Date.now(), checkedOut: true });
  b.set(doc(db, 'attendance_days', dayDocId(email, key)), {
    email, date: key, workMs: bank.Online, breakMs: bank.Break, meetingMs: bank.Meeting,
    checkOutMs: checkOut, closed: true, closedBy: by === email ? 'auto' : 'hr', autoClosed: true, updatedAt: serverTimestamp()
  }, { merge: true });
  b.set(doc(col('logs')), logEntry(u, email, u.status, 'Offline', add, by, key));
  await b.commit();
}

/** Start (or resume) today. mode: 'office' | 'remote' */
export async function startDay(mode, { remoteApproved = true } = {}) {
  window.dispatchEvent(new Event('am:data-changed'));
  const email = session.email;
  let u = await read('users', email);
  if (staleDay(u)) { await closeStaleDay(email, u); u = await read('users', email); }
  const at = now();
  const key = dayKey(at);
  const resuming = u.dayKey === key;
  const b = writeBatch(db);
  const bank = resuming ? { ...zeroBank(), ...(u.timeBank || {}) } : zeroBank();
  const upd = {
    status: 'Online', lastChange: serverTimestamp(), lastChangeClient: Date.now(), timeBank: bank,
    dayKey: key, checkedOut: false, workLocation: resuming ? (u.workLocation || mode) : mode,
    remotePending: resuming ? !!u.remotePending : (mode === 'remote' && !remoteApproved)
  };
  if (!resuming) upd.firstOnlineAt = serverTimestamp();
  b.update(doc(db, 'users', email), upd);
  const dayRef = doc(db, 'attendance_days', dayDocId(email, key));
  if (resuming) {
    b.set(dayRef, { closed: false, checkOutMs: null, updatedAt: serverTimestamp() }, { merge: true });
  } else {
    b.set(dayRef, {
      email, name: u.name || email, date: key, leaderEmail: u.leaderEmail || '', department: u.department || '',
      mode, remotePending: mode === 'remote' && !remoteApproved,
      checkIn: serverTimestamp(), checkInMs: at, checkOutMs: null, workMs: 0, breakMs: 0, meetingMs: 0,
      closed: false, closedBy: '', autoClosed: false, corrected: false, updatedAt: serverTimestamp()
    }, { merge: true });
  }
  b.set(doc(col('logs')), logEntry(u, email, 'Offline', 'Online', 0, email, key));
  await b.commit();
  return { resumed: resuming, key };
}

/** Change live status for a user (self, or a manager forcing it). */
export async function changeStatus(email, newStatus, by = session.email) {
  window.dispatchEvent(new Event('am:data-changed'));
  const u = await read('users', email);
  if (!u) throw new Error('no user');
  const old = u.status || 'Offline';
  if (old === newStatus) return;
  const at = now();
  const start = toMs(u.lastChange) || u.lastChangeClient || at;
  const dur = Math.max(0, at - start);
  const bank = { ...zeroBank(), ...(u.timeBank || {}) };
  if (COUNTED.includes(old)) bank[old] += dur;
  const key = u.dayKey || dayKey(at);
  const b = writeBatch(db);
  const upd = { status: newStatus, lastChange: serverTimestamp(), lastChangeClient: Date.now(), timeBank: bank };
  if (newStatus === 'Offline') upd.checkedOut = true;
  b.update(doc(db, 'users', email), upd);
  const dayUpd = { workMs: bank.Online, breakMs: bank.Break, meetingMs: bank.Meeting, updatedAt: serverTimestamp() };
  if (newStatus === 'Offline') Object.assign(dayUpd, { checkOutMs: at, closed: true, closedBy: by === email ? 'user' : 'hr' });
  b.set(doc(db, 'attendance_days', dayDocId(email, key)), dayUpd, { merge: true });
  b.set(doc(col('logs')), logEntry(u, email, old, newStatus, dur, by, key));
  await b.commit();
}
export const endDay = () => changeStatus(session.email, 'Offline');

/** HR/admin: reset a person's live counters (e.g. wrong start). Keeps the archived day. */
export async function resetLive(email) {
  window.dispatchEvent(new Event('am:data-changed'));
  const b = writeBatch(db);
  b.update(doc(db, 'users', email), { status: 'Offline', timeBank: zeroBank(), lastChange: serverTimestamp(), lastChangeClient: Date.now(), checkedOut: true });
  await b.commit();
}

/** HR: correct a day manually (check-in/out times, mode, totals) with a note. */
export async function correctDay(email, date, { checkInMs, checkOutMs, mode, workMs, note, status }) {
  window.dispatchEvent(new Event('am:data-changed'));
  const r = doc(db, 'attendance_days', dayDocId(email, date));
  const cur = (await getDoc(r)).data() || {};
  const u = await read('users', email);
  await setDoc(r, {
    email, date, name: cur.name || (u && u.name) || email, leaderEmail: cur.leaderEmail || (u && u.leaderEmail) || '',
    department: cur.department || (u && u.department) || '',
    ...(checkInMs !== undefined ? { checkInMs } : {}), ...(checkOutMs !== undefined ? { checkOutMs } : {}),
    ...(mode ? { mode } : {}), ...(workMs !== undefined ? { workMs } : {}), ...(status ? { status } : {}),
    closed: true, corrected: true, correctionNote: note || '', correctedBy: session.email,
    previous: cur.corrected ? (cur.previous || null) : { checkInMs: cur.checkInMs || null, checkOutMs: cur.checkOutMs || null, workMs: cur.workMs || 0, mode: cur.mode || null },
    updatedAt: serverTimestamp()
  }, { merge: true });
}

/** Days of one person in a month */
export function monthDays(email, ymStr, leaderEmail) {
  const f = [['email', '==', email], ['date', '>=', `${ymStr}-01`], ['date', '<=', `${ymStr}-31`]];
  if (leaderEmail) f.splice(1, 0, ['leaderEmail', '==', leaderEmail]);
  return listF('attendance_days', f);
}
/** leaderEmail filter needed when a leader (not HR) reads someone else's data */
export const scopeFor = (email) => (email === session.email || seesAll() || isFinance()) ? undefined : session.email;
/** Days of everyone for a date range */
export function rangeDays(from, to, leaderEmail) {
  const f = [['date', '>=', from], ['date', '<=', to]];
  if (leaderEmail) f.unshift(['leaderEmail', '==', leaderEmail]);
  return listF('attendance_days', f);
}
export function dayLogs(email, key, leaderEmail) {
  const f = [where('user', '==', email), where('dayKey', '==', key)];
  if (leaderEmail) f.push(where('leaderEmail', '==', leaderEmail));
  return list(query(col('logs'), ...f));
}
export const presenceText = (u) => {
  if (!u) return '';
  if (u.workLocation === 'remote') return L('أونلاين', 'Remote');
  if (u.workLocation === 'office') return L('المكتب', 'Office');
  return '—';
};
