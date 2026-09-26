// Activity trail: who did what and when. Only admins can read it (Settings → Activity log).
import { col, addDoc, serverTimestamp } from '../core/fb.js';
import { session } from '../core/session.js';

export function track(action, meta = {}) {
  if (!session.email) return Promise.resolve();
  return addDoc(col('activity'), {
    by: session.email, name: (session.profile && session.profile.name) || session.email, action,
    target: String(meta.target || '').slice(0, 200), detail: String(meta.detail || '').slice(0, 300), at: serverTimestamp()
  }).catch(e => console.warn('activity', e && e.message));
}
