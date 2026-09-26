// Signed-in user, role checks, server clock, single-session enforcement.
import {
  auth, onAuthStateChanged, signOut, ref, read, watch, setDoc, updateDoc, serverTimestamp, getDoc, doc, db,
  query, where, col, list, toMs
} from './fb.js';
import { normEmail, L } from './utils.js';
import { normRole, policy } from './policy.js';

export const session = {
  user: null,        // firebase auth user
  email: '',
  profile: null,     // users/{email}
  role: 'employee',
  team: [],          // emails that report to me
  offset: 0,         // server - client (ms)
};
const LS_SESSION = 'am_session_id';
export const localSessionId = () => { try { return localStorage.getItem(LS_SESSION) || ''; } catch { return ''; } };
export function newSessionId() {
  const id = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  try { localStorage.setItem(LS_SESSION, id); } catch {}
  return id;
}

export const now = () => Math.round(Date.now() + session.offset);

/** Estimate server clock offset by writing a server timestamp and reading it back. */
export async function syncClock() {
  try {
    const r = doc(db, '_clock', session.user.uid);
    const t0 = Date.now();
    await setDoc(r, { t: serverTimestamp() });
    const s = await getDoc(r);
    const t1 = Date.now();
    const srv = toMs(s.data().t);
    if (srv) session.offset = srv - (t0 + t1) / 2;
  } catch (e) { console.warn('clock sync failed', e && e.message); }
}

// ---------- role helpers ----------
export const role = () => session.role;
export const perms = () => (session.profile && session.profile.permissions) || {};
export const isAdmin = () => session.role === 'admin';
export const isHR = () => session.role === 'hr' || isAdmin();
export const isFinance = () => session.role === 'finance' || isAdmin() || !!perms().payroll;
export const isLeader = () => session.role === 'leader' || session.team.length > 0;
export const canApprove = () => isLeader() || isHR() || isFinance();
export const hasCRM = () => !!perms().crm || isAdmin();
export const canSeeTeamOf = (email) => isHR() || session.team.includes(normEmail(email));

/**
 * Wait for auth + profile. Redirects to login if signed out.
 * Resolves with session once the profile is valid.
 */
export function requireSession({ onProfileChange } = {}) {
  return new Promise((resolve, reject) => {
    let first = true;
    onAuthStateChanged(auth, async (u) => {
      if (!u) { if (first) location.replace('index.html'); return; }
      if (!first) return;
      first = false;
      session.user = u;
      session.email = normEmail(u.email);
      try {
        const p = await read('users', session.email);
        if (!p) { await forceLogout('no-profile'); return; }
        if (p.isSuspended) { await forceLogout('suspended'); return; }
        applyProfile(p);
        const teamDocs = await list(query(col('users'), where('leaderEmail', '==', session.email))).catch(() => []);
        session.team = teamDocs.filter(x => !x.isSuspended).map(x => x.id);
        await syncClock();
        watch(ref('users', session.email), (d) => {
          if (!d) return;
          if (d.isSuspended) { forceLogout('suspended'); return; }
          if (policy.singleSession !== false && d.sessionId && localSessionId() && d.sessionId !== localSessionId()) { forceLogout('other-device'); return; }
          applyProfile(d);
          onProfileChange && onProfileChange(d);
        });
        resolve(session);
      } catch (e) { reject(e); }
    });
  });
}
function applyProfile(p) {
  session.profile = p;
  session.role = normRole(p.role);
}

export async function forceLogout(reason) {
  try { sessionStorage.setItem('am_logout_reason', reason || ''); } catch {}
  try { await signOut(auth); } catch {}
  location.replace('index.html');
}
export async function logout() {
  try { await signOut(auth); } catch {}
  location.replace('index.html');
}
export const logoutReasonText = (r) => ({
  'suspended': L('الحساب ده موقوف. تواصل مع الموارد البشرية.', 'This account is suspended. Please contact HR.'),
  'other-device': L('تم تسجيل الدخول بحسابك من جهاز تاني، فاتقفلت الجلسة هنا.', 'Your account signed in on another device, so this session was closed.'),
  'no-profile': L('الحساب ده لسه ما اتفعّلش. تواصل مع الموارد البشرية.', 'This account is not activated yet. Please contact HR.')
}[r] || '');
