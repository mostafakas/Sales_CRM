// In-app notifications (+ browser notification when the tab is open).
import { col, addDoc, serverTimestamp, query, where, watch, updateDoc, ref, writeBatch, db, doc, toMs } from '../core/fb.js';
import { session } from '../core/session.js';
import { normEmail } from '../core/utils.js';

export async function notify(to, title, body = '', link = '') {
  to = normEmail(to);
  if (!to || to === session.email) return;
  try {
    await addDoc(col('notifications'), { to, title, body, link, read: false, from: session.email, at: serverTimestamp() });
  } catch (e) { console.warn('notify failed', e && e.message); }
}
export async function notifyMany(list, title, body, link) {
  const uniq = [...new Set((list || []).map(normEmail).filter(Boolean))];
  await Promise.all(uniq.map(t => notify(t, title, body, link)));
}

let items = [];
const subs = new Set();
export const onNotifications = (fn) => { subs.add(fn); fn(items); return () => subs.delete(fn); };
export const unreadCount = () => items.filter(n => !n.read).length;

export function startNotifications() {
  let first = true;
  watch(query(col('notifications'), where('to', '==', session.email)), (rows, snap) => {
    const fresh = [];
    if (!first && snap && snap.docChanges) snap.docChanges().forEach(ch => { if (ch.type === 'added') fresh.push(ch.doc.data()); });
    first = false;
    items = rows.sort((a, b) => (toMs(b.at) || 0) - (toMs(a.at) || 0)).slice(0, 100);
    subs.forEach(f => f(items));
    fresh.forEach(n => {
      try {
        if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
          new Notification(n.title, { body: n.body || '', icon: 'assets/img/icon-192.png' });
        }
      } catch {}
    });
  });
}
export async function markRead(id) { try { await updateDoc(ref('notifications', id), { read: true }); } catch {} }
export async function markAllRead() {
  const unread = items.filter(n => !n.read);
  if (!unread.length) return;
  const b = writeBatch(db);
  unread.slice(0, 400).forEach(n => b.update(doc(db, 'notifications', n.id), { read: true }));
  await b.commit();
}
