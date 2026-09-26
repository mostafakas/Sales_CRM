// In-app notifications (+ browser notification when the tab is open).
import { col, addDoc, serverTimestamp, query, where, watch, updateDoc, ref, writeBatch, db, doc, toMs } from '../core/fb.js';
import { session } from '../core/session.js';
import { normEmail, L } from '../core/utils.js';
import { livePop } from '../core/ui.js';
import { play } from '../core/sounds.js';

// kind: request (new request for an approver) · approved · rejected · progress · info
export function notify(to, title, body = '', link = '', kind = 'info') {
  to = normEmail(to);
  if (!to || to === session.email) return Promise.resolve();
  // fire-and-forget: the write syncs in the background, nobody waits for it
  return addDoc(col('notifications'), { to, title, body, link, kind, read: false, from: session.email, at: serverTimestamp() })
    .catch(e => console.warn('notify failed', e && e.message));
}
export function notifyMany(list, title, body, link, kind = 'info') {
  const uniq = [...new Set((list || []).map(normEmail).filter(Boolean))];
  return Promise.all(uniq.map(t => notify(t, title, body, link, kind)));
}
const KIND = {
  request: { icon: 'fa-inbox', cls: 'warn', sound: 'request', action: ['مراجعة', 'Review'] },
  approved: { icon: 'fa-circle-check', cls: 'ok', sound: 'approved', action: ['عرض', 'View'] },
  rejected: { icon: 'fa-circle-xmark', cls: 'bad', sound: 'rejected', action: ['عرض', 'View'] },
  progress: { icon: 'fa-forward', cls: 'info', sound: 'info', action: ['عرض', 'View'] },
  info: { icon: 'fa-bell', cls: '', sound: 'info', action: ['فتح', 'Open'] }
};

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
      const k = KIND[n.kind] || KIND.info;
      livePop({ icon: k.icon, cls: k.cls, title: n.title, text: n.body || '', href: n.link || '#/notifications', action: L(k.action[0], k.action[1]) });
      play(k.sound);
      window.dispatchEvent(new CustomEvent('am:notification', { detail: n }));
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
