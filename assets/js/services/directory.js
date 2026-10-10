// People directory: a single live listener on users, shared by every screen.
import { col, watch, query, where, orderBy } from '../core/fb.js';
import { session, isHR, seesAll } from '../core/session.js';
import { setPersonLookup, policy, DEFAULT_DEPARTMENTS, savePolicy } from '../core/policy.js';

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
setPersonLookup(person);
export const nameOf = (email) => (person(email) || {}).name || (email ? String(email).split('@')[0] : '—');
/** People the current user manages: everyone for HR/admin, direct reports for leaders */
export function managedPeople() {
  if (seesAll()) return activePeople();
  return activePeople().filter(p => p.leaderEmail === session.email);
}
/** add a department to the official list (from the employee form or Settings) */
export async function addDepartment(name) {
  const n = String(name || '').trim().slice(0, 60);
  if (!n) return null;
  const list = officialDepartments();
  const same = list.find(d => d.toLowerCase() === n.toLowerCase());
  if (same) return same;
  await savePolicy({ departments: [...list, n] });
  policy.departments = [...list, n];
  return n;
}
export const teamOf = (leaderEmail) => activePeople().filter(p => p.leaderEmail === leaderEmail);
/** managedPeople() + for a team supervisor, the teams of the leaders under them (two levels) */
export function supervisedPeople() {
  const direct = managedPeople();
  if (seesAll() || session.role !== 'team_supervisor') return direct;
  const leads = new Set(direct.map(p => p.email));
  return [...direct, ...activePeople().filter(p => leads.has(p.leaderEmail) && p.email !== session.email)];
}
/** the team supervisor above a leader ('' when that leader's manager is not a team supervisor) */
export const supervisorOf = (leaderEmail) => { const l = leaderEmail && person(leaderEmail); const s = l && l.leaderEmail && person(l.leaderEmail); return s && s.role === 'team_supervisor' ? s.email : ''; };
/** the official departments (Settings), then any other name still written on someone's file */
export function departments() {
  const official = officialDepartments();
  const extra = new Set(); people.forEach(p => p.department && !official.includes(p.department) && extra.add(p.department));
  return [...official, ...[...extra].sort()];
}
export const officialDepartments = () => (Array.isArray(policy.departments) && policy.departments.length ? policy.departments : DEFAULT_DEPARTMENTS).slice();
