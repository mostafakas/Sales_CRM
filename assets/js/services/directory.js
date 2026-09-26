// People directory: a single live listener on users, shared by every screen.
import { col, watch, query, where, orderBy } from '../core/fb.js';
import { session, isHR } from '../core/session.js';

let people = [];
let ready = null;
const subs = new Set();
let started = false;

export function startDirectory() {
  if (started) return ready;
  started = true;
  ready = new Promise((resolve) => {
    watch(col('users'), (rows) => {
      people = rows.map(r => ({ ...r, email: r.id }));
      people.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, 'ar'));
      resolve(people);
      subs.forEach(f => f(people));
    }, () => resolve(people));
  });
  return ready;
}
export const onDirectory = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export const allPeople = () => people;
export const activePeople = () => people.filter(p => !p.isSuspended);
/** Active people whose attendance is tracked (executives can be excluded per employee) */
export const trackedPeople = () => activePeople().filter(p => p.trackAttendance !== false);
export const person = (email) => people.find(p => p.email === email) || null;
export const nameOf = (email) => (person(email) || {}).name || (email ? String(email).split('@')[0] : '—');
/** People the current user manages: everyone for HR/admin, direct reports for leaders */
export function managedPeople() {
  if (isHR()) return activePeople();
  return activePeople().filter(p => p.leaderEmail === session.email);
}
export const teamOf = (leaderEmail) => activePeople().filter(p => p.leaderEmail === leaderEmail);
export function departments() {
  const s = new Set(); people.forEach(p => p.department && s.add(p.department));
  return [...s].sort();
}
