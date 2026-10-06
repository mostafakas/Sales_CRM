// Birthdays: users/{email}.birthday holds "MM-DD" (everyone sees day and month), the full date with the year stays
// private in employees_private/{email}.birthDate. Wishes: birthday_wishes/{to}_{year}_{from}.
import { db, doc, col, watch, query, where, setDoc, updateDoc, serverTimestamp, toMs } from '../core/fb.js';
import { session, now } from '../core/session.js';
import { userError } from '../core/ui.js';
import { L, ymd, addDays } from '../core/utils.js';
import { activePeople, nameOf } from './directory.js';
import { notify } from './notify.js';

const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
/** "MM-DD" of a birthday as celebrated in a given year (29 Feb → 28 Feb in ordinary years) */
const dayIn = (md, year) => (md === '02-29' && !leap(year) ? '02-28' : md);
export const hasBirthday = (p, date = ymd(now())) => !!(p && p.birthday) && dayIn(p.birthday, Number(date.slice(0, 4))) === date.slice(5);
export const todays = () => activePeople().filter(p => hasBirthday(p));
/** birthdays in the next `days` days (today excluded), nearest first */
export function upcoming(days = 7) {
  const out = [];
  for (let i = 1; i <= days; i++) {
    const d = addDays(ymd(now()), i);
    activePeople().forEach(p => { if (hasBirthday(p, d)) out.push({ p, date: d, inDays: i }); });
  }
  return out;
}
export const thisYear = () => Number(ymd(now()).slice(0, 4));

export async function sendWish(to, text) {
  const t = String(text || '').trim().slice(0, 500);
  if (!t) throw userError('اكتب التهنئة.', 'Write your wish.');
  const year = thisYear();
  await setDoc(doc(db, 'birthday_wishes', `${to}_${year}_${session.email}`), { to, from: session.email, year, text: t, at: serverTimestamp() });
  notify(to, L(`🎂 ${nameOf(session.email)} بعتلك تهنئة بعيد ميلادك`, `🎂 ${nameOf(session.email)} sent you a birthday wish`), t.slice(0, 140), '#/home', 'approved');
}
/** wishes sent to someone this year (the birthday person) */
export const watchWishes = (email, cb) => watch(query(col('birthday_wishes'), where('to', '==', email), where('year', '==', thisYear())),
  rows => cb(rows.sort((a, b) => (toMs(a.at) || 0) - (toMs(b.at) || 0))), () => cb([]));
/** the wishes I sent this year (to show "sent ✓") */
export const watchSent = (cb) => watch(query(col('birthday_wishes'), where('from', '==', session.email), where('year', '==', thisYear())), rows => cb(rows), () => cb([]));

/** My own birth date (from "My profile"): day+month public, full date private */
export async function setMyBirthday(date) {
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw userError('التاريخ مش صحيح.', 'Invalid date.');
  await updateDoc(doc(db, 'users', session.email), { birthday: date ? date.slice(5) : '' });
  await setDoc(doc(db, 'employees_private', session.email), { email: session.email, birthDate: date || '', updatedAt: serverTimestamp() }, { merge: true });
}
