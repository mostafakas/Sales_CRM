// Client for the free password service (Google Apps Script — see tools/password-service).
// Public config lives in settings/public (readable before sign-in): { loginDomain, authServiceUrl }.
import { auth, read, setDoc, ref, serverTimestamp } from '../core/fb.js';
import { L, normEmail } from '../core/utils.js';
import { userError } from '../core/ui.js';

let cfg = null;
export async function publicConfig(force = false) {
  if (cfg && !force) return cfg;
  cfg = (await read('settings', 'public').catch(() => null)) || {};
  return cfg;
}
export async function savePublicConfig(data) {
  await setDoc(ref('settings', 'public'), { ...data, updatedAt: serverTimestamp() }, { merge: true });
  cfg = null;
}
export const serviceReady = async () => !!(await publicConfig()).authServiceUrl;

/** "ahmed" → "ahmed@<loginDomain>"; full emails are kept as typed (lowercased). */
export function toLogin(input, domain) {
  const v = normEmail(input);
  if (!v || v.includes('@') || !domain) return v;
  return `${v}@${String(domain).replace(/^@/, '')}`;
}
export const siteUrl = () => location.origin + location.pathname.replace(/[^/]*$/, '');

const ERRORS = {
  'unauthenticated': ['انتهت الجلسة. سجّل دخول تاني.', 'Your session expired. Please sign in again.'],
  'forbidden': ['مش مسموح لك بالعملية دي.', 'You are not allowed to do this.'],
  'not-found': ['الموظف مش موجود.', 'Employee not found.'],
  'no-login': ['الموظف ده ملوش حساب دخول في Firebase Authentication.', 'This employee has no login in Firebase Authentication.'],
  'no-recovery-email': ['الموظف ملوش إيميل استعادة. ضيفه من ملفه الأول.', 'This employee has no recovery email. Add it in their profile first.'],
  'not-configured': ['خدمة كلمات المرور متركّبة بس ناقصها مفتاح الخدمة (SERVICE_ACCOUNT).', 'The password service is missing its SERVICE_ACCOUNT key.'],
  'email-taken': ['الإيميل ده عليه حساب دخول تاني بالفعل.', 'Another login already uses this email.'],
  'server-error': ['حصلت مشكلة في خدمة كلمات المرور.', 'The password service hit an error.']
};

export async function callService(action, payload = {}, { signedIn = true } = {}) {
  const c = await publicConfig();
  if (!c.authServiceUrl) throw userError('خدمة كلمات المرور لسه ما اتفعّلتش. الأدمن يفعّلها من الإعدادات ← النظام.', 'The password service is not set up yet. An admin can enable it in Settings → System.');
  const body = { action, origin: siteUrl(), ...payload };
  if (signedIn) body.idToken = await auth.currentUser.getIdToken();
  let res;
  try {
    // text/plain body = "simple" request, which Apps Script web apps accept cross-origin
    const r = await fetch(c.authServiceUrl, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' });
    res = await r.json();
  } catch (e) {
    throw userError('تعذّر الوصول لخدمة كلمات المرور. اتأكد من الرابط في الإعدادات.', 'Could not reach the password service. Check its URL in Settings.');
  }
  if (!res || !res.ok) {
    const [ar, en] = ERRORS[res && res.error] || ERRORS['server-error'];
    const e = userError(ar, en + (res && res.detail ? ` (${res.detail})` : ''));
    e.code = res && res.error;
    throw e;
  }
  return res;
}
