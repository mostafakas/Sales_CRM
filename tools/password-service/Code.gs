/**
 * AL MASTER HR — password service (Google Apps Script, free).
 *
 * What it does (things the browser can't do alone on Firebase's free plan):
 *   • reset   — HR/admin sets a temporary password for an employee (they must change it at next sign-in)
 *   • forgot  — "Forgot password?" on the sign-in page: emails a reset link to the employee's recovery (Outlook) email
 *   • welcome — emails a new employee their username + temporary password
 *   • ping    — health check used by Settings → System
 *
 * Setup: see README.md in this folder. Secrets live in Script Properties, never in this file:
 *   SERVICE_ACCOUNT = the whole JSON key from Firebase Console → Project settings → Service accounts
 */

const PROJECT_ID = 'almaster-b8c18';
const WEB_API_KEY = 'AIzaSyCXyuT529aGwiS5j_RPxW_zEeAtkYc7JlM'; // public web key (same as in the site)
const FROM_NAME = 'AL MASTER HR';
const HR_ROLES = ['hr', 'supervisor', 'admin'];
const FORGOT_COOLDOWN_SEC = 600;  // one reset email per account every 10 minutes
const FORGOT_DAILY_CAP = 60;      // keeps Gmail's daily sending quota safe

// ---------------------------------------------------------------- entry points
function doGet() {
  return json_({ ok: true, service: 'almaster-password-service', configured: !!prop_('SERVICE_ACCOUNT') });
}

function doPost(e) {
  let body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (x) { return json_({ ok: false, error: 'bad-request' }); }
  try {
    switch (body.action) {
      case 'ping': return json_(ping_());
      case 'forgot': return json_(forgot_(body));
      case 'reset': return json_(reset_(body));
      case 'welcome': return json_(welcome_(body));
      default: return json_({ ok: false, error: 'unknown-action' });
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    console.error(body.action, msg);
    const known = ['unauthenticated', 'forbidden', 'not-found', 'no-login', 'no-recovery-email', 'not-configured', 'bad-request'];
    return json_({ ok: false, error: known.indexOf(msg) >= 0 ? msg : 'server-error', detail: known.indexOf(msg) >= 0 ? '' : msg.slice(0, 300) });
  }
}

/** Run this once from the editor (select "setupCheck" → Run) to confirm everything is wired. */
function setupCheck() {
  const r = ping_();
  console.log(JSON.stringify(r, null, 2));
  if (!r.firebase) throw new Error('Service account not working — check the SERVICE_ACCOUNT script property.');
}

// ---------------------------------------------------------------- actions
function ping_() {
  const out = { ok: true, configured: !!prop_('SERVICE_ACCOUNT'), mailQuota: MailApp.getRemainingDailyQuota(), firebase: false };
  if (out.configured) { try { getDoc_('settings/public'); out.firebase = true; } catch (e) { out.detail = String(e.message || e).slice(0, 200); } }
  return out;
}

function reset_(b) {
  const me = caller_(b.idToken);
  if (HR_ROLES.indexOf(me.role) < 0) throw new Error('forbidden');
  const target = norm_(b.target);
  if (!target || target === me.email) throw new Error('forbidden');
  const t = getDoc_('users/' + target);
  if (!t) throw new Error('not-found');
  if (String(t.role || '').toLowerCase() === 'admin' && me.role !== 'admin') throw new Error('forbidden');

  const password = tempPassword_();
  const login = lookupLogin_(target);
  identity_('accounts:update', { localId: login.localId, password: password });
  // force the new-password popup and sign the account out everywhere
  patchDoc_('users/' + target, { mustChangePassword: true, sessionId: 'reset_' + Date.now() });

  let emailed = '';
  if (b.notify) {
    const to = recoveryEmail_(target);
    if (to) { sendCredentials_(to, t.name || target, target, password, b.origin, true); emailed = mask_(to); }
  }
  return { ok: true, password: password, emailed: emailed };
}

function welcome_(b) {
  const me = caller_(b.idToken);
  if (HR_ROLES.indexOf(me.role) < 0) throw new Error('forbidden');
  const target = norm_(b.target);
  const t = target && getDoc_('users/' + target);
  if (!t) throw new Error('not-found');
  if (!b.password || String(b.password).length < 6) throw new Error('bad-request');
  const to = recoveryEmail_(target);
  if (!to) throw new Error('no-recovery-email');
  sendCredentials_(to, t.name || target, target, String(b.password), b.origin, false);
  return { ok: true, emailed: mask_(to) };
}

function forgot_(b) {
  const neutral = { ok: true }; // same answer whatever happens, so accounts can't be probed
  let user = norm_(b.username);
  if (!user) return neutral;
  if (user.indexOf('@') < 0) {
    const pub = getDoc_('settings/public') || {};
    if (!pub.loginDomain) return neutral;
    user += '@' + String(pub.loginDomain).replace(/^@/, '');
  }
  const cache = CacheService.getScriptCache();
  if (cache.get('f_' + user)) return neutral;
  cache.put('f_' + user, '1', FORGOT_COOLDOWN_SEC);
  const dayKey = 'fday_' + Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyy-MM-dd');
  const n = Number(cache.get(dayKey) || 0);
  if (n >= FORGOT_DAILY_CAP) return neutral;
  cache.put(dayKey, String(n + 1), 21600);

  try {
    const p = getDoc_('users/' + user);
    if (!p || p.isSuspended === true) return neutral;
    const to = recoveryEmail_(user);
    if (!to) return neutral;
    const req = { requestType: 'PASSWORD_RESET', email: user, returnOobLink: true };
    if (b.origin && /^https:\/\//.test(b.origin)) req.continueUrl = b.origin;
    let link;
    try { link = identity_('accounts:sendOobCode', req).oobLink; }
    catch (x) { delete req.continueUrl; link = identity_('accounts:sendOobCode', req).oobLink; } // origin not in Authorized domains
    if (link) sendResetLink_(to, p.name || user, user, link);
  } catch (e) { console.error('forgot', user, e && e.message); }
  return neutral;
}

// ---------------------------------------------------------------- identity & Firestore (service account)
function caller_(idToken) {
  if (!idToken) throw new Error('unauthenticated');
  const r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + WEB_API_KEY, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) throw new Error('unauthenticated');
  const u = (JSON.parse(r.getContentText()).users || [])[0];
  if (!u || !u.email) throw new Error('unauthenticated');
  const email = String(u.email).toLowerCase();
  const p = getDoc_('users/' + email);
  if (!p || p.isSuspended === true) throw new Error('forbidden');
  return { email: email, role: String(p.role || '').toLowerCase() };
}

function lookupLogin_(email) {
  const r = identity_('accounts:lookup', { email: [email] });
  const u = (r.users || [])[0];
  if (!u) throw new Error('no-login');
  return u;
}

function identity_(method, payload) {
  const r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/projects/' + PROJECT_ID + '/' + method, {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + token_() },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  const code = r.getResponseCode(), text = r.getContentText();
  if (code >= 300) throw new Error('identity ' + method + ' ' + code + ' ' + text.slice(0, 200));
  return JSON.parse(text || '{}');
}

const FS_BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents/';
function fsPath_(path) { return path.split('/').map(encodeURIComponent).join('/'); }

function getDoc_(path) {
  const r = UrlFetchApp.fetch(FS_BASE + fsPath_(path), { headers: { Authorization: 'Bearer ' + token_() }, muteHttpExceptions: true });
  if (r.getResponseCode() === 404) return null;
  if (r.getResponseCode() >= 300) throw new Error('firestore get ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
  return fromFields_(JSON.parse(r.getContentText()).fields || {});
}

function patchDoc_(path, data) {
  const mask = Object.keys(data).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const r = UrlFetchApp.fetch(FS_BASE + fsPath_(path) + '?' + mask + '&currentDocument.exists=true', {
    method: 'patch', contentType: 'application/json', headers: { Authorization: 'Bearer ' + token_() },
    payload: JSON.stringify({ fields: toFields_(data) }), muteHttpExceptions: true
  });
  if (r.getResponseCode() >= 300) throw new Error('firestore patch ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
}

function fromValue_(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return fromFields_(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue_);
  return null;
}
function fromFields_(f) { const o = {}; Object.keys(f).forEach(k => { o[k] = fromValue_(f[k]); }); return o; }
function toFields_(o) {
  const f = {};
  Object.keys(o).forEach(k => {
    const v = o[k];
    if (typeof v === 'boolean') f[k] = { booleanValue: v };
    else if (typeof v === 'number') f[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    else if (v === null) f[k] = { nullValue: null };
    else f[k] = { stringValue: String(v) };
  });
  return f;
}

/** OAuth token for the Firebase service account (cached ~50 minutes). */
function token_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('sa_token');
  if (hit) return hit;
  const raw = prop_('SERVICE_ACCOUNT');
  if (!raw) throw new Error('not-configured');
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, '');
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit'
  });
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(unsigned, sa.private_key)).replace(/=+$/, '');
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }, muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) throw new Error('token ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
  const tok = JSON.parse(r.getContentText()).access_token;
  cache.put('sa_token', tok, 3000);
  return tok;
}

// ---------------------------------------------------------------- helpers
function recoveryEmail_(email) {
  const p = getDoc_('employees_private/' + email);
  const v = p && String(p.contactEmail || '').trim();
  return v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : '';
}
function tempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Date.now());
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[(bytes[i] + 256) % chars.length];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '#' + (10 + ((bytes[9] + 256) % 90));
}
function norm_(v) { return String(v || '').trim().toLowerCase(); }
function mask_(e) { const p = String(e).split('@'); return p[0].slice(0, 2) + '•••@' + (p[1] || ''); }
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function escHtml_(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------------------------------------------------------------- emails
function shell_(title, bodyHtml) {
  return '<div style="font-family:Segoe UI,Tahoma,Arial,sans-serif;background:#f5f7ff;padding:24px">' +
    '<div style="max-width:520px;margin:auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e3e7f5">' +
    '<div style="background:#0a0f3d;color:#fff;padding:18px 24px;font-weight:800;letter-spacing:.04em">AL MASTER</div>' +
    '<div style="padding:24px;color:#0f1633;line-height:1.7"><h2 style="margin:0 0 12px;font-size:18px">' + title + '</h2>' + bodyHtml + '</div>' +
    '<div style="padding:14px 24px;color:#8b93aa;font-size:12px;border-top:1px solid #e3e7f5">AL MASTER Technology — HR portal</div></div></div>';
}
function sendCredentials_(to, name, username, password, origin, isReset) {
  const url = origin && /^https:\/\//.test(origin) ? origin : '';
  const title = isReset ? 'Your password was reset / تم إعادة تعيين كلمة المرور' : 'Your AL MASTER account / حسابك على بوابة الماستر';
  const html = shell_(title,
    '<p>Hi ' + escHtml_(name) + ',</p>' +
    '<p>' + (isReset ? 'HR has set a temporary password for your account.' : 'An account has been created for you on the AL MASTER employee portal.') + '</p>' +
    '<table style="border-collapse:collapse;margin:12px 0;font-size:14px">' +
    '<tr><td style="padding:6px 12px 6px 0;color:#5b6479">Username</td><td style="padding:6px 0;font-weight:700;direction:ltr">' + escHtml_(username) + '</td></tr>' +
    '<tr><td style="padding:6px 12px 6px 0;color:#5b6479">Temporary password</td><td style="padding:6px 0;font-weight:700;font-family:Consolas,monospace;direction:ltr">' + escHtml_(password) + '</td></tr></table>' +
    (url ? '<p><a href="' + escHtml_(url) + '" style="display:inline-block;background:#1b1bdb;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:700">Sign in</a></p>' : '') +
    '<p style="color:#5b6479;font-size:13px">You will be asked to choose your own password right after signing in.</p>' +
    '<p dir="rtl" style="text-align:right;color:#5b6479;font-size:13px;border-top:1px solid #eee;padding-top:12px">ادخل باسم المستخدم وكلمة المرور المؤقتة اللي فوق، وهيُطلب منك تختار كلمة مرور جديدة أول ما تدخل.</p>');
  MailApp.sendEmail({ to: to, subject: title, htmlBody: html, name: FROM_NAME });
}
function sendResetLink_(to, name, username, link) {
  const title = 'Reset your password / استعادة كلمة المرور';
  const html = shell_(title,
    '<p>Hi ' + escHtml_(name) + ',</p>' +
    '<p>We received a request to reset the password for <b style="direction:ltr">' + escHtml_(username) + '</b>.</p>' +
    '<p><a href="' + escHtml_(link) + '" style="display:inline-block;background:#1b1bdb;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:700">Choose a new password</a></p>' +
    '<p style="color:#5b6479;font-size:13px">The link works once and expires in about an hour. If you didn\'t ask for this, ignore this email — your password stays the same.</p>' +
    '<p dir="rtl" style="text-align:right;color:#5b6479;font-size:13px;border-top:1px solid #eee;padding-top:12px">اضغط الزرار اللي فوق عشان تختار كلمة مرور جديدة. لو ما طلبتش ده، تجاهل الإيميل.</p>');
  MailApp.sendEmail({ to: to, subject: title, htmlBody: html, name: FROM_NAME });
}
