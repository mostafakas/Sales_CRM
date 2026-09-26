// My profile: info, photo, password, language/theme, leave balances with ledger.
import { L, esc, isAr, setLang, toggleTheme, imageToDataUrl, num, fmtDate } from '../core/utils.js';
import { toast, toastErr, avatar, busy, modal, empty } from '../core/ui.js';
import { session, now } from '../core/session.js';
import { roleLabel, leaveTypes } from '../core/policy.js';
import { auth, updateDoc, ref, updatePassword, EmailAuthProvider, reauthenticateWithCredential, list, query, col, where, toMs } from '../core/fb.js';
import { nameOf } from '../services/directory.js';
import { getBalance, remaining } from '../services/requests.js';

export function balanceTable(bal) {
  return `<div class="table-wrap"><table class="table"><thead><tr>
    <th>${L('النوع', 'Type')}</th><th class="num">${L('المستحق', 'Entitled')}</th><th class="num">${L('تعديلات', 'Adjust')}</th><th class="num">${L('المستخدم', 'Used')}</th><th class="num">${L('المتبقي', 'Remaining')}</th></tr></thead><tbody>
    ${leaveTypes.filter(t => t.active !== false).map(t => {
      const b = bal.types[t.id] || { entitled: 0, used: 0, adjust: 0 };
      const rem = remaining(b);
      return `<tr><td><b>${esc(L(t.ar, t.en))}</b></td><td class="num">${t.unlimited ? '∞' : num(b.entitled, 1)}</td><td class="num">${num(b.adjust || 0, 1)}</td><td class="num">${num(b.used || 0, 1)}</td>
        <td class="num"><b style="color:${!t.unlimited && rem <= 0 ? 'var(--bad)' : 'inherit'}">${t.unlimited ? '—' : num(rem, 1)}</b></td></tr>`;
    }).join('')}</tbody></table></div>`;
}

export default async function render(root) {
  const p = () => session.profile || {};
  const year = new Date(now()).getFullYear();
  root.innerHTML = `<div class="page-head"><div><h2>${L('حسابي', 'My profile')}</h2></div></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
      <section class="card card-pad" id="info"></section>
      <section class="card" id="prefs"></section>
      <section class="card" style="grid-column:1/-1" id="bal"></section>
    </div>`;
  function drawInfo() {
    const u = p();
    root.querySelector('#info').innerHTML = `<div class="row gap-16 mb-16">
        <label style="cursor:pointer;position:relative" title="${L('تغيير الصورة', 'Change photo')}">${avatar({ ...u, email: session.email }, 'xl')}
          <input type="file" accept="image/*" hidden id="photo"><span class="btn btn-sm btn-icon btn-primary" style="position:absolute;bottom:0;inset-inline-end:0;border-radius:50%"><i class="fas fa-camera"></i></span></label>
        <div><h3 style="font-size:20px">${esc(u.name || session.email)}</h3><div class="muted">${esc(u.title || '')}</div><span class="badge brand mt-8">${esc(roleLabel(u.role))}</span></div></div>
      <dl class="kv">
        <dt>${L('الإيميل', 'Email')}</dt><dd dir="ltr" style="text-align:start">${esc(session.email)}</dd>
        <dt>${L('القسم', 'Department')}</dt><dd>${esc(u.department || '—')}</dd>
        <dt>${L('المدير المباشر', 'Manager')}</dt><dd>${esc(u.leaderEmail ? nameOf(u.leaderEmail) : '—')}</dd>
        <dt>${L('تاريخ التعيين', 'Hire date')}</dt><dd>${esc(u.hireDate ? fmtDate(u.hireDate) : '—')}</dd>
        <dt>${L('حصة الأونلاين الشهرية', 'Monthly remote quota')}</dt><dd>${esc(num(u.remoteQuota ?? 0))} ${L('يوم', 'days')}</dd>
      </dl>`;
    root.querySelector('#photo').onchange = async (e) => {
      try {
        const data = await imageToDataUrl(e.target.files[0], 240, 0.8);
        await updateDoc(ref('users', session.email), { photo: data });
        toast(L('تم تحديث الصورة', 'Photo updated'));
      } catch (ex) { toastErr(ex); }
    };
  }
  drawInfo();
  const onProf = () => drawInfo();
  window.addEventListener('am:profile', onProf);

  root.querySelector('#prefs').innerHTML = `<div class="card-head"><h3>${L('الإعدادات الشخصية', 'Preferences')}</h3></div>
    <div class="card-body col gap-16">
      <div class="row between"><div><b>${L('اللغة', 'Language')}</b><div class="xs muted">${L('عربي أو إنجليزي', 'Arabic or English')}</div></div>
        <div class="tabs"><button class="tab ${isAr ? 'active' : ''}" data-lang="ar">عربي</button><button class="tab ${!isAr ? 'active' : ''}" data-lang="en">English</button></div></div>
      <div class="row between"><div><b>${L('الوضع الليلي', 'Dark mode')}</b></div><label class="switch"><input type="checkbox" id="dark" ${document.documentElement.dataset.theme === 'dark' ? 'checked' : ''}><span></span></label></div>
      <div class="row between"><div><b>${L('إشعارات المتصفح', 'Browser notifications')}</b><div class="xs muted" id="np"></div></div><button class="btn btn-sm" id="np-btn">${L('تفعيل', 'Enable')}</button></div>
      <div class="divider" style="margin:0"></div>
      <button class="btn" id="pw-btn"><i class="fas fa-key"></i> ${L('تغيير كلمة المرور', 'Change password')}</button>
    </div>`;
  root.querySelectorAll('[data-lang]').forEach(b => b.onclick = async () => {
    try { await updateDoc(ref('users', session.email), { lang: b.dataset.lang }); } catch {}
    setLang(b.dataset.lang);
  });
  root.querySelector('#dark').onchange = () => toggleTheme();
  const np = root.querySelector('#np');
  const npState = () => { np.textContent = !('Notification' in window) ? L('غير مدعومة', 'Not supported') : ({ granted: L('مفعّلة', 'Enabled'), denied: L('مقفولة من المتصفح', 'Blocked in browser'), default: L('مش مفعّلة', 'Not enabled') })[Notification.permission]; };
  npState();
  root.querySelector('#np-btn').onclick = async () => { try { await Notification.requestPermission(); } catch {} npState(); };
  root.querySelector('#pw-btn').onclick = () => {
    const m = modal({
      title: L('تغيير كلمة المرور', 'Change password'), icon: 'fa-key', size: 'narrow',
      body: `<form class="col gap-16" id="pwf">
        <div class="field"><label>${L('كلمة المرور الحالية', 'Current password')}</label><input class="input" type="password" name="cur" required autocomplete="current-password"></div>
        <div class="field"><label>${L('الجديدة (8 حروف على الأقل)', 'New (min 8 characters)')}</label><input class="input" type="password" name="p1" minlength="8" required autocomplete="new-password"></div>
        <div class="field"><label>${L('تأكيد الجديدة', 'Confirm new')}</label><input class="input" type="password" name="p2" minlength="8" required autocomplete="new-password"></div>
        <div class="alert bad hidden" id="pwe"></div></form>`,
      foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="pws">${L('حفظ', 'Save')}</button>`
    });
    m.$('#pws').onclick = (e) => busy(e.currentTarget, async () => {
      const f = m.$('#pwf'), err = m.$('#pwe');
      err.classList.add('hidden');
      if (f.p1.value.length < 8 || f.p1.value !== f.p2.value) { err.textContent = L('كلمتين المرور مش متطابقين أو قصيرين.', 'Passwords do not match or are too short.'); err.classList.remove('hidden'); return; }
      try {
        await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(session.email, f.cur.value));
        await updatePassword(auth.currentUser, f.p1.value);
        m.close(); toast(L('تم تغيير كلمة المرور', 'Password changed'));
      } catch (ex) {
        err.textContent = /wrong-password|invalid-credential/.test(ex.code || '') ? L('كلمة المرور الحالية غلط.', 'Current password is incorrect.') : L('تعذّر التغيير، حاول تاني.', 'Could not change password.');
        err.classList.remove('hidden');
      }
    });
  };

  const bal = await getBalance(session.email, year);
  const ledger = await list(query(col('balance_ledger'), where('email', '==', session.email), where('year', '==', year))).catch(() => []);
  ledger.sort((a, b) => (toMs(b.at) || 0) - (toMs(a.at) || 0));
  root.querySelector('#bal').innerHTML = `<div class="card-head"><h3>${L(`أرصدة الإجازات ${year}`, `Leave balances ${year}`)}</h3></div>${balanceTable(bal)}
    <div class="card-body"><div class="label mb-8">${L('آخر الحركات', 'Recent movements')}</div>
    ${ledger.length ? `<div class="table-wrap"><table class="table"><tbody>${ledger.slice(0, 15).map(l => `<tr><td class="num xs">${esc(fmtDate(toMs(l.at)))}</td><td>${esc((leaveTypes.find(t => t.id === l.type) || {})[isAr ? 'ar' : 'en'] || l.type)}</td>
      <td class="num"><b style="color:${l.delta < 0 ? 'var(--bad)' : 'var(--ok)'}">${l.delta > 0 ? '+' : ''}${num(l.delta, 1)}</b></td><td class="xs muted">${esc(l.reason === 'request' ? L('طلب إجازة', 'Leave request') : (l.reason === 'revoked' ? L('إلغاء اعتماد', 'Revoked') : l.reason))}</td></tr>`).join('')}</tbody></table></div>` : `<p class="muted small">${L('مفيش حركات السنة دي', 'No movements this year')}</p>`}</div>`;
  return () => window.removeEventListener('am:profile', onProf);
}
