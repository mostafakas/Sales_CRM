import { auth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, read, updateDoc, ref, serverTimestamp } from './core/fb.js';
import { L, isAr, setLang, toggleTheme, normEmail, byId } from './core/utils.js';
import { newSessionId, logoutReasonText } from './core/session.js';

const T = {
  pill: L('بوابة داخلية آمنة', 'Secure internal portal'),
  headline: L('كل شغلك في مكان واحد.', 'Everything about your workday, in one place.'),
  tagline: L('الحضور، الطلبات، الإجازات، والرواتب — بوابة موظفي الماستر لتقنية المعلومات.', 'Attendance, requests, leave and payroll — the AL MASTER employee portal.'),
  city: L('القاهرة، مصر', 'Cairo, Egypt'),
  welcome: L('أهلاً بيك 👋', 'Welcome back 👋'),
  welcomeSub: L('سجّل دخولك بإيميل الشغل.', 'Sign in with your work email.'),
  email: L('البريد الإلكتروني', 'Email'),
  password: L('كلمة المرور', 'Password'),
  forgot: L('نسيت كلمة المرور؟', 'Forgot password?'),
  signin: L('تسجيل الدخول', 'Sign in'),
  help: L('مشكلة في الدخول؟ تواصل مع الموارد البشرية.', 'Trouble signing in? Contact HR.'),
  back: L('رجوع لتسجيل الدخول', 'Back to sign in'),
  resetTitle: L('استعادة كلمة المرور', 'Reset password'),
  resetSub: L('هنبعتلك لينك على إيميلك تعمل منه كلمة مرور جديدة.', "We'll email you a link to set a new password."),
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
  if (r) { const el = byId('reason'); el.textContent = logoutReasonText(r); el.classList.toggle('hidden', !el.textContent); sessionStorage.removeItem('am_logout_reason'); }
} catch {}

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
  const email = normEmail(byId('email').value);
  const pass = byId('password').value;
  if (!email || !pass) { showError(L('اكتب الإيميل وكلمة المرور.', 'Enter your email and password.')); return; }
  signingIn = true;
  btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;border-color:rgba(255,255,255,.3);border-top-color:#fff"></span>';
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    signingIn = false; btn.disabled = false; btn.innerHTML = btnText;
    const code = err && err.code || '';
    if (code.includes('too-many-requests')) showError(L('محاولات كتير غلط. استنى شوية وجرب تاني.', 'Too many attempts. Please wait and try again.'));
    else if (code.includes('network')) showError(L('مفيش اتصال بالإنترنت.', 'No internet connection.'));
    else showError(L('الإيميل أو كلمة المرور غلط.', 'Incorrect email or password.'));
    return;
  }
  try {
    const p = await read('users', email);
    if (!p) { await signOut(auth); throw Object.assign(new Error('x'), { ui: logoutReasonText('no-profile') }); }
    if (p.isSuspended) { await signOut(auth); throw Object.assign(new Error('x'), { ui: logoutReasonText('suspended') }); }
    // write the new session id BEFORE leaving the page, so other devices get signed out cleanly
    await updateDoc(ref('users', email), { sessionId: newSessionId(), lastLoginAt: serverTimestamp() });
    location.replace('app.html');
  } catch (err) {
    signingIn = false; btn.disabled = false; btn.innerHTML = btnText;
    showError(err.ui || L('تعذّر تحميل بيانات حسابك. حاول تاني.', 'Could not load your account. Please try again.'));
  }
};

byId('reset-form').onsubmit = async (e) => {
  e.preventDefault();
  const email = normEmail(byId('reset-email').value);
  const box = byId('reset-msg');
  if (!email) return;
  const b = byId('reset-btn'); b.disabled = true;
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (err) { /* same message either way so emails can't be probed */ }
  box.className = 'alert ok';
  box.textContent = L('لو الإيميل ده مسجل عندنا، هيوصلك لينك الاستعادة خلال دقايق. شوف الـ Spam كمان.', 'If this email is registered, a reset link is on its way. Check spam too.');
  b.disabled = false;
};
