// Company announcements: written by the admin / HR for everyone or for some departments. Each reader leaves a
// read mark (announcements/{id}/reads/{email}) so the writers see who read it; ann_seen/{email} keeps my own
// read marks in one document (cheap unread counters). "Important" ones pop up until the reader confirms.
import { db, doc, col, watch, list, writeBatch, setDoc, updateDoc, deleteDoc, serverTimestamp, toMs, increment } from '../core/fb.js';
import { session, isAdmin, isHR, now } from '../core/session.js';
import { userError } from '../core/ui.js';
import { L, ymd } from '../core/utils.js';
import { activePeople, person, nameOf } from './directory.js';
import { notifyMany } from './notify.js';
import { track } from './activity.js';

export const canWriteAnnouncements = () => isAdmin() || isHR();
let all = [], seen = {}, started = false;
const subs = new Set();
const emit = () => subs.forEach(f => f());

/** Announcements this person should see (audience + not expired); writers also see expired ones */
export function visibleTo(list_ = all, email = session.email) {
  const me = person(email) || session.profile || {};
  const today = ymd(now());
  return list_.filter(a => {
    if (a.createdBy === email || canWriteAnnouncements()) return true;
    if (a.expiresOn && a.expiresOn < today) return false;
    return audienceHas(a, me);
  }).sort((a, b) => (b.pinned === true) - (a.pinned === true) || (toMs(b.createdAt) || now()) - (toMs(a.createdAt) || now()));
}
const audienceHas = (a, p) => !a.departments || !a.departments.length || a.departments.includes((p && p.department) || '');
export const isExpired = (a) => !!a.expiresOn && a.expiresOn < ymd(now());
export const isRead = (a) => !!seen[a.id] || a.createdBy === session.email;
export const unread = () => visibleTo().filter(a => !isRead(a) && !isExpired(a));
export const announcements = () => visibleTo();
export const onAnnouncements = (fn) => { subs.add(fn); fn(); return () => subs.delete(fn); };
/** the people an announcement is for (active, not the writer) */
export const audienceOf = (a) => activePeople().filter(p => p.email !== a.createdBy && audienceHas(a, p));

export function startAnnouncements() {
  if (started) return; started = true;
  watch(col('announcements'), rows => { all = rows; emit(); });
  watch(doc(db, 'ann_seen', session.email), d => { seen = (d && d.ids) || {}; emit(); });
}

/** Mark announcements as read by me (one batch) */
export async function markRead(items) {
  const todo = (items || []).filter(a => a && !isRead(a));
  if (!todo.length) return;
  todo.forEach(a => { seen[a.id] = true; });
  emit();
  const b = writeBatch(db);
  todo.forEach(a => {
    b.set(doc(db, `announcements/${a.id}/reads`, session.email), { email: session.email, at: serverTimestamp() });
    b.update(doc(db, 'announcements', a.id), { readCount: increment(1) }); // "read by n of N" without reading every mark
  });
  b.set(doc(db, 'ann_seen', session.email), { ids: Object.fromEntries(todo.map(a => [a.id, true])), updatedAt: serverTimestamp() }, { merge: true });
  try { await b.commit(); } catch (e) { console.warn('ann read', e && e.message); }
}

const clean = ({ title, body, image = '', departments = [], pinned = false, important = false, expiresOn = '' }) => {
  const t = String(title || '').trim().slice(0, 150);
  if (!t) throw userError('اكتب عنوان الإعلان.', 'Enter a title.');
  const b = String(body || '').trim().slice(0, 5000);
  return { title: t, body: b, image: String(image || ''), departments: [...new Set(departments)].filter(Boolean), pinned: !!pinned, important: !!important, expiresOn: /^\d{4}-\d{2}-\d{2}$/.test(expiresOn) ? expiresOn : '' };
};
export async function publish(data) {
  if (!canWriteAnnouncements()) throw userError('الإعلانات للأدمن والـ HR بس.', 'Only admins and HR can post announcements.');
  const a = { ...clean(data), createdBy: session.email, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  const ref = doc(col('announcements'));
  await setDoc(ref, a);
  const to = audienceOf(a).map(p => p.email);
  notifyMany(to, L(`📢 ${a.title}`, `📢 ${a.title}`), a.body.slice(0, 140), '#/announcements', a.important ? 'request' : 'info');
  track('ann.create', { target: a.title, detail: a.departments.length ? a.departments.join('، ') : L('الكل', 'everyone') });
  return ref.id;
}
export async function edit(a, data) {
  if (!canWriteAnnouncements()) throw userError('الإعلانات للأدمن والـ HR بس.', 'Only admins and HR can post announcements.');
  await updateDoc(doc(db, 'announcements', a.id), { ...clean(data), updatedAt: serverTimestamp() });
  track('ann.update', { target: data.title || a.title });
}
export async function remove(a) {
  if (!canWriteAnnouncements()) throw userError('الإعلانات للأدمن والـ HR بس.', 'Only admins and HR can post announcements.');
  await deleteDoc(doc(db, 'announcements', a.id));
  track('ann.delete', { target: a.title });
}
/** who read it (with the time) and who did not yet */
export async function readersOf(a) {
  const rows = await list(col(`announcements/${a.id}/reads`));
  const read = new Map(rows.map(r => [r.id, toMs(r.at)]));
  const aud = audienceOf(a);
  return { read: aud.filter(p => read.has(p.email)).map(p => ({ p, at: read.get(p.email) })).sort((x, y) => (y.at || 0) - (x.at || 0)), unread: aud.filter(p => !read.has(p.email)) };
}
export function remind(a, emails) {
  notifyMany(emails, L(`تذكير: ${a.title}`, `Reminder: ${a.title}`), L('لسه مقريتش الإعلان ده.', 'You have not read this announcement yet.'), '#/announcements', 'request');
  track('ann.remind', { target: a.title, detail: `${emails.length}` });
}
export const writerName = (a) => nameOf(a.createdBy);
