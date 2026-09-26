// "Choose a new password" page — opened from the reset email (keeps the whole flow on our own domain).
import { auth, verifyPasswordResetCode, confirmPasswordReset } from './core/fb.js';
import { L, esc, isAr, setLang, toggleTheme, byId } from './core/utils.js';

const T = {
  pill: L('بوابة داخلية آمنة', 'Secure internal portal'),
  headline: L('كلمة مرور جديدة.', 'A new password.'),
  tagline: L('اختار كلمة مرور قوية مش مستخدمها في أي مكان تاني.', 'Pick a strong password you do not use anywhere else.')
};
document.querySelectorAll('[data-t]').forEach(el => { el.textContent = T[el.dataset.t] || ''; });
const langBtn = byId('lang-btn');
langBtn.textContent = isAr ? 'EN' : 'ع';
langBtn.onclick = () => setLang(isAr ? 'en' : 'ar');
const setIcon = () => { byId('theme-btn').innerHTML = `<i class="fas ${document.documentElement.dataset.theme === 'dark' ? 'fa-sun' : 'fa-moon'}"></i>`; };
setIcon(); byId('theme-btn').onclick = () => { toggleTheme(); setIcon(); };

const state = byId('state');
const params = new URLSearchParams(location.search);
const code = params.get('oobCode') || '';
const mode = params.get('mode') || 'resetPassword';
const signIn = (email) => `<a class="btn btn-grad btn-lg btn-block mt-16" href="index.html" id="go"><i class="fas fa-right-to-bracket"></i> ${L('تسجيل الدخول', 'Sign in')}</a>`;
const fail = (title, text) => { state.innerHTML = `<h2>${esc(title)}</h2><p class="sub">${esc(text)}</p><a class="btn btn-lg btn-block" href="index.html">${L('رجوع لصفحة الدخول', 'Back to sign in')}</a>`; };

async function start() {
  if (!code || mode !== 'resetPassword') return fail(L('اللينك مش كامل', 'Incomplete link'), L('افتح اللينك من الإيميل تاني، أو اطلب لينك جديد من «نسيت كلمة المرور؟».', 'Open the link from the email again, or request a new one from "Forgot password?".'));
  let email;
  try { email = await verifyPasswordResetCode(auth, code); }
  catch (e) { return fail(L('اللينك انتهى', 'This link has expired'), L('اللينك بيشتغل مرة واحدة ولمدة ساعة تقريباً. اطلب لينك جديد من «نسيت كلمة المرور؟».', 'Links work once and for about an hour. Request a new one from "Forgot password?".')); }
  state.innerHTML = `<h2>${L('اختار كلمة مرور جديدة', 'Choose a new password')}</h2>
    <p class="sub">${L('للحساب', 'For')} <b dir="ltr">${esc(email)}</b></p>
    <form id="f" class="col gap-16" novalidate>
      <div class="field"><label for="p1">${L('كلمة المرور الجديدة (8 حروف على الأقل)', 'New password (at least 8 characters)')}</label>
        <div class="input-group"><input class="input" id="p1" type="password" autocomplete="new-password" dir="ltr" style="height:48px" required minlength="8">
        <button type="button" class="btn btn-ghost" id="eye" aria-label="Show"><i class="fas fa-eye"></i></button></div></div>
      <div class="field"><label for="p2">${L('تأكيد كلمة المرور', 'Confirm password')}</label><input class="input" id="p2" type="password" autocomplete="new-password" dir="ltr" style="height:48px" required minlength="8"></div>
      <div id="err" class="alert bad hidden" role="alert"></div>
      <button class="btn btn-grad btn-lg btn-block" id="save" type="submit">${L('حفظ كلمة المرور', 'Save password')}</button>
    </form>`;
  byId('eye').onclick = () => { const s = byId('p1').type === 'password'; byId('p1').type = byId('p2').type = s ? 'text' : 'password'; byId('eye').innerHTML = `<i class="fas ${s ? 'fa-eye-slash' : 'fa-eye'}"></i>`; };
  byId('f').onsubmit = async (e) => {
    e.preventDefault();
    const p1 = byId('p1').value, p2 = byId('p2').value, err = byId('err');
    err.classList.add('hidden');
    if (p1.length < 8) { err.textContent = L('كلمة المرور لازم تكون 8 حروف على الأقل.', 'The password must be at least 8 characters.'); err.classList.remove('hidden'); return; }
    if (p1 !== p2) { err.textContent = L('كلمتين المرور مش متطابقين.', 'The passwords do not match.'); err.classList.remove('hidden'); return; }
    const b = byId('save'); b.disabled = true;
    try {
      await confirmPasswordReset(auth, code, p1);
      try { sessionStorage.setItem('am_prefill', email); } catch {}
      state.innerHTML = `<div class="alert ok mb-16"><i class="fas fa-circle-check"></i><div>${L('تم تغيير كلمة المرور بنجاح.', 'Your password has been changed.')}</div></div>
        <h2>${L('تمام كده 👌', 'All set 👌')}</h2><p class="sub">${L('ادخل دلوقتي باسم المستخدم وكلمة المرور الجديدة.', 'Sign in now with your username and new password.')}</p>${signIn(email)}`;
    } catch (ex) {
      b.disabled = false;
      const c = String(ex && ex.code);
      err.textContent = c.includes('weak-password') ? L('كلمة المرور ضعيفة، جرّب واحدة أطول.', 'That password is too weak — try a longer one.')
        : (c.includes('expired') || c.includes('invalid-action')) ? L('اللينك انتهى. اطلب لينك جديد من «نسيت كلمة المرور؟».', 'The link expired. Request a new one from "Forgot password?".')
        : c.includes('network') ? L('مفيش اتصال بالإنترنت.', 'No internet connection.') : L('تعذّر الحفظ، حاول تاني.', 'Could not save, please try again.');
      err.classList.remove('hidden');
    }
  };
}
start();
