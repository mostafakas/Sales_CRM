import { auth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, read, updateDoc, ref, serverTimestamp, addDoc, col } from './core/fb.js';
import { L, isAr, setLang, toggleTheme, normEmail, byId } from './core/utils.js';
import { newSessionId, logoutReasonText } from './core/session.js';
import { publicConfig, toLogin, callService } from './services/authsvc.js';

const T = {
  pill: L('بوابة داخلية آمنة', 'Secure internal portal'),
  headline: L('كل شغلك في مكان واحد.', 'Everything about your workday, in one place.'),
  tagline: L('الحضور، الطلبات، الإجازات، والرواتب — بوابة موظفي الماستر لتقنية المعلومات.', 'Attendance, requests, leave and payroll — the AL MASTER employee portal.'),
  city: L('القاهرة، مصر', 'Cairo, Egypt'),
  welcome: L('أهلاً بيك 👋', 'Welcome back 👋'),
  welcomeSub: L('سجّل دخولك باسم المستخدم بتاعك.', 'Sign in with your username.'),
  email: L('اسم المستخدم', 'Username'),
  password: L('كلمة المرور', 'Password'),
  forgot: L('نسيت كلمة المرور؟', 'Forgot password?'),
  signin: L('تسجيل الدخول', 'Sign in'),
  help: L('مشكلة في الدخول؟ تواصل مع الموارد البشرية.', 'Trouble signing in? Contact HR.'),
  back: L('رجوع لتسجيل الدخول', 'Back to sign in'),
  resetTitle: L('استعادة كلمة المرور', 'Reset password'),
  resetSub: L('اكتب اسم المستخدم، وهنبعت لينك تغيير كلمة المرور على إيميل الاستعادة (Outlook) المسجّل ليك.', 'Enter your username and we will email a reset link to your recovery (Outlook) email.'),
  sendLink: L('ابعت اللينك', 'Send link')
};
document.querySelectorAll('[data-t]').forEach(el => { el.textContent = T[el.dataset.t] || ''; });
document.title = `AL MASTER | ${T.signin}`;

const langBtn = byId('lang-btn');
langBtn.textContent = isAr ? 'EN' : 'ع';
langBtn.onclick = () => setLang(isAr ? 'en' : 'ar');
const setIcon = () => { byId('theme-btn').innerHTML = `<i class="fas ${document.documentElement.dataset.theme === 'dark' ? 'fa-sun' : 'fa-moon'}"></i>`; };
setIcon(); byId('theme-btn').onclick = () => { toggleTheme(); setIcon(); };

// reason for the last forced sign-out
try {
  const r = sessionStorage.getItem('am_logout_reason');
  const pre = sessionStorage.getItem('am_prefill'); if (pre) { byId('email').value = pre; sessionStorage.removeItem('am_prefill'); }
  if (r) { const el = byId('reason'); el.textContent = logoutReasonText(r); el.classList.toggle('hidden', !el.textContent); sessionStorage.removeItem('am_logout_reason'); }
} catch {}

// username hint: "ahmed" works when the admin set a login domain
publicConfig().then(c => {
  const hint = c.loginDomain ? `ahmed  ·  ahmed@${String(c.loginDomain).replace(/^@/, '')}` : 'name@company.com';
  byId('email').placeholder = hint; byId('reset-email').placeholder = hint;
}).catch(() => {});

const showError = (msg) => { const e = byId('login-error'); e.textContent = msg; e.classList.remove('hidden'); };
const btn = byId('login-btn');
const btnText = btn.innerHTML;
let signingIn = false;

byId('toggle-pw').onclick = () => {
  const p = byId('password'); const show = p.type === 'password';
  p.type = show ? 'text' : 'password';
  byId('toggle-pw').innerHTML = `<i class="fas ${show ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
};
byId('forgot-link').onclick = (e) => { e.preventDefault(); byId('reset-email').value = byId('email').value; byId('login-view').classList.add('hidden'); byId('reset-view').classList.remove('hidden'); };
byId('back-link').onclick = () => { byId('reset-view').classList.add('hidden'); byId('login-view').classList.remove('hidden'); };

// Already signed in with a valid account → straight to the app
onAuthStateChanged(auth, async (u) => {
  if (!u || signingIn) return;
  try {
    const p = await read('users', normEmail(u.email));
    if (p && !p.isSuspended) location.replace('app.html');
  } catch {}
});

byId('login-form').onsubmit = async (e) => {
  e.preventDefault();
  byId('login-error').classList.add('hidden');
  const cfg = await publicConfig().catch(() => ({}));
  const email = toLogin(byId('email').value, cfg.loginDomain);
  const pass = byId('password').value;
  if (!email || !pass) { showError(L('اكتب اسم المستخدم وكلمة المرور.', 'Enter your username and password.')); return; }
  if (!email.includes('@')) { showError(L('اكتب اسم المستخدم كامل زي ما HR بعتهولك (مثلاً name@company.com).', 'Type your full username as HR sent it (e.g. name@company.com).')); return; }
  signingIn = true;
  btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;border-color:rgba(255,255,255,.3);border-top-color:#fff"></span>';
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    signingIn = false; btn.disabled = false; btn.innerHTML = btnText;
    const code = err && err.code || '';
    if (code.includes('too-many-requests')) showError(L('محاولات كتير غلط. استنى شوية وجرب تاني.', 'Too many attempts. Please wait and try again.'));
    else if (code.includes('network')) showError(L('مفيش اتصال بالإنترنت.', 'No internet connection.'));
    else showError(L('اسم المستخدم أو كلمة المرور غلط.', 'Incorrect username or password.'));
    return;
  }
  try {
    const p = await read('users', email);
    if (!p) { await signOut(auth); throw Object.assign(new Error('x'), { ui: logoutReasonText('no-profile') }); }
    if (p.isSuspended) { await signOut(auth); throw Object.assign(new Error('x'), { ui: logoutReasonText('suspended') }); }
    // write the new session id BEFORE leaving the page, so other devices get signed out cleanly
    await updateDoc(ref('users', email), { sessionId: newSessionId(), lastLoginAt: serverTimestamp() });
    await Promise.race([addDoc(col('activity'), { by: email, name: p.name || email, action: 'auth.login', target: '', detail: (navigator.userAgentData && navigator.userAgentData.platform) || (/Mobi/.test(navigator.userAgent) ? 'mobile' : 'desktop'), at: serverTimestamp() }).catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
    location.replace('app.html');
  } catch (err) {
    signingIn = false; btn.disabled = false; btn.innerHTML = btnText;
    showError(err.ui || L('تعذّر تحميل بيانات حسابك. حاول تاني.', 'Could not load your account. Please try again.'));
  }
};

byId('reset-form').onsubmit = async (e) => {
  e.preventDefault();
  const box = byId('reset-msg');
  const cfg = await publicConfig().catch(() => ({}));
  const email = toLogin(byId('reset-email').value, cfg.loginDomain);
  if (!email) return;
  const b = byId('reset-btn'); b.disabled = true;
  try {
    if (cfg.authServiceUrl) await callService('forgot', { username: email }, { signedIn: false });
    else await sendPasswordResetEmail(auth, email);
  } catch (err) { /* same message either way so accounts can't be probed */ }
  box.className = 'alert ok';
  box.textContent = cfg.authServiceUrl
    ? L('لو الحساب ده له إيميل استعادة، هيوصله لينك تغيير كلمة المرور خلال دقايق (شوف Junk كمان). لو مفيش إيميل مسجّل، اطلب من HR يعملك كلمة مرور مؤقتة.', 'If this account has a recovery email, a reset link is on its way (check Junk too). No recovery email? Ask HR for a temporary password.')
    : L('لو الحساب ده مسجّل بإيميل حقيقي، هيوصلك لينك الاستعادة. لو لأ، اطلب من HR يعملك كلمة مرور مؤقتة.', 'If this account uses a real email, a reset link is on its way. Otherwise ask HR for a temporary password.');
  box.classList.remove('hidden');
  b.disabled = false;
};
