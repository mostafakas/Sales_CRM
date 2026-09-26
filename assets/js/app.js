// App shell: session, navigation by role, router, clock, notifications badge.
import { L, isAr, esc, setLang, toggleTheme, fmtLongDate, zparts, pad, byId } from './core/utils.js';
import { requireSession, session, isHR, isLeader, isFinance, isAdmin, isPM, seesAll, hasCRM, canApprove, logout, now } from './core/session.js';
import { loadPolicy, roleLabel, policy, savePolicy } from './core/policy.js';
import { ymd } from './core/utils.js';
import { toast, toastErr, modal, avatar } from './core/ui.js';
import { startDirectory } from './services/directory.js';
import { startNotifications, onNotifications, unreadCount } from './services/notify.js';
import { watchInbox } from './services/requests.js';
import { auth, updatePassword, updateDoc, ref, read } from './core/fb.js';

const ROUTES = [
  { id: 'home', group: 'me', icon: 'fa-house', ar: 'يومي', en: 'My day', load: () => import('./views/home.js'), bottom: true },
  { id: 'requests', group: 'me', icon: 'fa-paper-plane', ar: 'طلباتي', en: 'My requests', load: () => import('./views/requests.js'), bottom: true },
  { id: 'attendance', group: 'me', icon: 'fa-calendar-check', ar: 'حضوري', en: 'My attendance', load: () => import('./views/attendance.js') },
  { id: 'chat', group: 'me', icon: 'fa-comments', ar: 'الشات', en: 'Chat', load: () => import('./views/chat.js'), badge: 'chat', bottom: true },
  { id: 'payslips', group: 'me', icon: 'fa-receipt', ar: 'قسائم الراتب', en: 'Payslips', load: () => import('./views/payslips.js') },
  { id: 'profile', group: 'me', icon: 'fa-circle-user', ar: 'حسابي', en: 'My profile', load: () => import('./views/profile.js') },
  { id: 'notifications', group: null, icon: 'fa-bell', ar: 'الإشعارات', en: 'Notifications', load: () => import('./views/notifications.js') },

  { id: 'monitor', group: 'team', icon: 'fa-signal', ar: 'المتابعة اللحظية', en: 'Live monitor', when: () => isLeader() || seesAll(), load: () => import('./views/monitor.js') },
  { id: 'approvals', group: 'team', icon: 'fa-inbox', ar: 'الموافقات', en: 'Approvals', when: canApprove, load: () => import('./views/approvals.js'), badge: 'inbox', bottom: true },
  { id: 'leaves', group: 'team', icon: 'fa-umbrella-beach', ar: 'الإجازات والأرصدة', en: 'Leaves & balances', when: () => isLeader() || seesAll(), load: () => import('./views/leaves.js') },
  { id: 'reports', group: 'team', icon: 'fa-chart-column', ar: 'التقارير الشهرية', en: 'Monthly reports', when: () => isLeader() || seesAll() || isFinance(), load: () => import('./views/reports.js') },

  { id: 'employees', group: 'hr', icon: 'fa-users', ar: 'الموظفين', en: 'Employees', when: isHR, load: () => import('./views/employees.js') },
  { id: 'daily', group: 'hr', icon: 'fa-user-clock', ar: 'الحضور اليومي', en: 'Daily attendance', when: isHR, load: () => import('./views/daily.js') },
  { id: 'schedules', group: 'hr', icon: 'fa-calendar-days', ar: 'الجداول', en: 'Schedules', when: () => isHR() || isLeader(), load: () => import('./views/schedules.js') },

  { id: 'payroll', group: 'finance', icon: 'fa-money-check-dollar', ar: 'الرواتب', en: 'Payroll', when: isFinance, load: () => import('./views/payroll.js') },
  { id: 'treasury', group: 'finance', icon: 'fa-vault', ar: 'الخزينة والمصروفات', en: 'Treasury', when: isFinance, load: () => import('./views/treasury.js') },

  { id: 'activity', group: 'admin', icon: 'fa-list-check', ar: 'سجل النشاط', en: 'Activity log', when: isAdmin, load: () => import('./views/activity.js') },
  { id: 'settings', group: 'admin', icon: 'fa-sliders', ar: 'الإعدادات', en: 'Settings', when: () => isAdmin() || isHR(), load: () => import('./views/settings.js') }
];
const GROUPS = {
  me: { ar: 'أنا', en: 'Me' }, team: { ar: 'الفريق', en: 'Team' }, hr: { ar: 'الموارد البشرية', en: 'Human resources' },
  finance: { ar: 'المالية', en: 'Finance' }, admin: { ar: 'النظام', en: 'System' }, apps: { ar: 'تطبيقات', en: 'Apps' }
};

let current = null; // { id, cleanup }
let inboxCount = 0, chatCount = 0;
const allowed = (r) => !r.when || r.when();

function renderNav() {
  const nav = byId('nav');
  let h = '';
  Object.keys(GROUPS).forEach(g => {
    const items = ROUTES.filter(r => r.group === g && allowed(r));
    if (g === 'apps') {
      if (hasCRM()) h += `<div class="nav-group"><div class="nav-label">${esc(L(GROUPS.apps.ar, GROUPS.apps.en))}</div>
        <a class="nav-item" href="sales_app.html" target="_blank" rel="noopener"><i class="fas fa-briefcase"></i><span>${L('المبيعات CRM', 'Sales CRM')}</span><i class="fas fa-arrow-up-right-from-square" style="margin-inline-start:auto;font-size:11px;opacity:.6"></i></a></div>`;
      return;
    }
    if (!items.length) return;
    h += `<div class="nav-group"><div class="nav-label">${esc(L(GROUPS[g].ar, GROUPS[g].en))}</div>`;
    items.forEach(r => {
      h += `<a class="nav-item" href="#/${r.id}" data-route="${r.id}"><i class="fas ${r.icon}"></i><span>${esc(L(r.ar, r.en))}</span>${r.badge ? `<span class="badge-count hidden" data-badge="${r.badge}"></span>` : ''}</a>`;
    });
    h += '</div>';
  });
  nav.innerHTML = h;
  const bn = byId('bottom-nav');
  bn.innerHTML = ROUTES.filter(r => r.bottom && allowed(r)).slice(0, 4).map(r =>
    `<a href="#/${r.id}" data-route="${r.id}"><i class="fas ${r.icon}"></i><span>${esc(L(r.ar, r.en))}</span></a>`).join('') +
    `<a href="#" id="bn-more"><i class="fas fa-bars"></i><span>${L('المزيد', 'More')}</span></a>`;
  byId('bn-more').onclick = (e) => { e.preventDefault(); document.body.classList.add('nav-open'); };
  renderUserChip();
}
function renderUserChip() {
  const p = session.profile || {};
  byId('user-chip').innerHTML = `${avatar({ ...p, email: session.email }, 'sm')}
    <div class="who"><b class="truncate">${esc(p.name || session.email)}</b><span>${esc(p.title || roleLabel(session.role))}</span></div>
    <button class="btn btn-on-navy btn-icon btn-sm" id="logout-btn" title="${L('تسجيل خروج', 'Sign out')}" aria-label="${L('تسجيل خروج', 'Sign out')}"><i class="fas fa-right-from-bracket"></i></button>`;
  byId('logout-btn').onclick = async () => {
    const { confirmDialog } = await import('./core/ui.js');
    const live = p.status && p.status !== 'Offline';
    const ok = await confirmDialog({
      title: L('تسجيل الخروج', 'Sign out'),
      message: live ? L('لسه يومك شغال. تسجيل الخروج مش هيقفل اليوم — استخدم «إنهاء اليوم» من صفحة يومي لو خلصت شغل.', 'Your day is still running. Signing out does not end it — use "End day" on My day when you finish.') : '',
      okText: L('خروج', 'Sign out')
    });
    if (ok) logout();
  };
}
function setBadges() {
  document.querySelectorAll('[data-badge="inbox"]').forEach(b => { b.textContent = inboxCount; b.classList.toggle('hidden', !inboxCount); });
  const n = unreadCount();
  const bc = byId('bell-count'); bc.textContent = n > 9 ? '9+' : n; bc.classList.toggle('hidden', !n);
  document.querySelectorAll('[data-badge="chat"]').forEach(b => { b.textContent = chatCount > 99 ? '99+' : chatCount; b.classList.toggle('hidden', !chatCount); });
  const cc = byId('chat-count'); if (cc) { cc.textContent = chatCount > 9 ? '9+' : chatCount; cc.classList.toggle('hidden', !chatCount); }
  const base = document.title.replace(/^\(\d+\+?\)\s*/, '');
  document.title = (chatCount ? `(${chatCount > 99 ? '99+' : chatCount}) ` : '') + base;
}

/** New chat messages: badge everywhere + a popup (and a browser notification when the tab is hidden) */
async function startChatWatcher() {
  const { watchMyChats, unreadOf, otherOf } = await import('./services/chat.js');
  const { person, nameOf } = await import('./services/directory.js');
  const { avatar } = await import('./core/ui.js');
  const { toMs } = await import('./core/fb.js');
  let seen = now();
  let audio = null;
  const beep = () => {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = 880; g.gain.setValueAtTime(0.0001, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
      o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.4);
    } catch {}
  };
  const popup = (c, lm) => {
    const from = person(lm.by) || { email: lm.by, name: nameOf(lm.by) };
    let root = document.querySelector('.chat-pops');
    if (!root) { root = document.createElement('div'); root.className = 'chat-pops'; document.body.appendChild(root); }
    const el = document.createElement('div');
    el.className = 'chat-pop'; el.setAttribute('role', 'alert');
    el.innerHTML = `${avatar(from)}<div class="grow min0"><b class="truncate">${esc(from.name || from.email)}</b><p>${esc(lm.text || '')}</p>
      <div class="row gap-8 mt-8"><a class="btn btn-sm btn-primary" href="#/chat/${encodeURIComponent(c.id)}"><i class="fas fa-reply"></i> ${L('رد', 'Reply')}</a><button class="btn btn-sm btn-ghost" data-x>${L('إغلاق', 'Dismiss')}</button></div></div>`;
    const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
    el.querySelector('[data-x]').onclick = kill; el.querySelector('a').addEventListener('click', kill);
    root.prepend(el); while (root.children.length > 3) root.lastChild.remove();
    setTimeout(kill, 9000);
    beep();
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { const n = new Notification(from.name || from.email, { body: lm.text || '', icon: 'assets/img/icon-192.png', tag: c.id }); n.onclick = () => { window.focus(); location.hash = `#/chat/${encodeURIComponent(c.id)}`; n.close(); }; } catch {}
    }
  };
  watchMyChats(chats => {
    chatCount = chats.reduce((s, c) => s + unreadOf(c), 0);
    setBadges();
    let newest = seen;
    chats.forEach(c => {
      const lm = c.lastMessage; if (!lm || lm.by === session.email) return;
      const at = toMs(lm.at) || 0; if (at <= seen) return;
      newest = Math.max(newest, at);
      if (window.__amOpenChat === c.id && !document.hidden) return;
      popup(c, lm);
    });
    seen = newest;
  });
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'home';
  const [id, ...rest] = hash.split('/');
  let r = ROUTES.find(x => x.id === id);
  if (!r || !allowed(r)) r = ROUTES[0];
  document.body.classList.remove('nav-open');
  document.querySelectorAll('[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === r.id));
  byId('page-title').textContent = L(r.ar, r.en);
  document.title = `${L(r.ar, r.en)} | AL MASTER`;
  if (chatCount) setBadges();
  if (current && current.cleanup) { try { current.cleanup(); } catch {} }
  const view = byId('view');
  view.innerHTML = `<div class="page-loader"><span class="spinner"></span></div>`;
  try {
    const mod = await r.load();
    const token = {};
    current = { id: r.id, token };
    // fresh container per visit so listeners bound by a view never pile up
    const host = document.createElement('div');
    view.replaceChildren(host);
    const cleanup = await mod.default(host, { params: rest });
    if (current.token === token) current.cleanup = cleanup;
    else if (cleanup) cleanup();
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="card card-pad"><div class="empty"><i class="fas fa-triangle-exclamation"></i><b>${L('تعذّر تحميل الصفحة', 'Could not load this page')}</b><span>${esc(e && e.message || '')}</span></div></div>`;
  }
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function startClock() {
  const tick = () => {
    const p = zparts(now());
    byId('clock').textContent = `${pad(p.h)}:${pad(p.mi)}`;
    byId('today').textContent = fmtLongDate(now());
  };
  tick(); setInterval(tick, 15000);
}

async function forcePasswordChange() {
  const m = modal({
    title: L('غيّر كلمة المرور', 'Change your password'), icon: 'fa-key', locked: true, size: 'narrow',
    body: `<p class="muted mb-16">${L('ده أول دخول ليك. اختار كلمة مرور جديدة خاصة بيك (8 حروف على الأقل).', 'This is your first sign-in. Choose your own password (at least 8 characters).')}</p>
      <form id="pw-form" class="col">
        <div class="field"><label>${L('كلمة المرور الجديدة', 'New password')}</label><input class="input" type="password" name="p1" minlength="8" required autocomplete="new-password"></div>
        <div class="field"><label>${L('تأكيد كلمة المرور', 'Confirm password')}</label><input class="input" type="password" name="p2" minlength="8" required autocomplete="new-password"></div>
        <div id="pw-err" class="alert bad hidden"></div>
        <button class="btn btn-primary btn-lg btn-block" type="submit">${L('حفظ', 'Save')}</button>
      </form>`
  });
  m.$('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, p1 = f.p1.value, p2 = f.p2.value, err = m.$('#pw-err');
    if (p1.length < 8 || p1 !== p2) { err.textContent = L('كلمتين المرور مش متطابقين أو أقصر من 8 حروف.', 'Passwords do not match or are shorter than 8 characters.'); err.classList.remove('hidden'); return; }
    try {
      await updatePassword(auth.currentUser, p1);
      import('./services/activity.js').then(m => m.track('auth.password_set')).catch(() => {});
      await updateDoc(ref('users', session.email), { mustChangePassword: false });
      m.close(); toast(L('تم تغيير كلمة المرور', 'Password changed'));
    } catch (ex) {
      if (ex && ex.code === 'auth/requires-recent-login') { err.textContent = L('سجّل خروج وادخل تاني وبعدين غيّرها.', 'Please sign out, sign in again, then retry.'); err.classList.remove('hidden'); }
      else toastErr(ex);
    }
  };
}

async function boot() {
  byId('lang-btn').textContent = isAr ? 'EN' : 'ع';
  byId('lang-btn').onclick = () => setLang(isAr ? 'en' : 'ar');
  const setThemeIcon = () => { byId('theme-btn').innerHTML = `<i class="fas ${document.documentElement.dataset.theme === 'dark' ? 'fa-sun' : 'fa-moon'}"></i>`; };
  setThemeIcon();
  byId('theme-btn').onclick = () => { toggleTheme(); setThemeIcon(); };
  byId('menu-btn').onclick = () => document.body.classList.toggle('nav-open');
  byId('scrim').onclick = () => document.body.classList.remove('nav-open');

  try {
    await requireSession({ onProfileChange: (p) => { renderUserChip(); window.dispatchEvent(new CustomEvent('am:profile', { detail: p })); } });
    await loadPolicy();
  } catch (e) {
    console.error(e);
    byId('splash').innerHTML = `<div style="color:#fff;text-align:center;padding:24px"><b>${L('تعذّر الاتصال بالسيرفر', 'Could not reach the server')}</b><p style="opacity:.7;margin-top:8px">${esc(e && e.message || '')}</p><button class="btn btn-on-navy mt-16" onclick="location.reload()">${L('إعادة المحاولة', 'Retry')}</button></div>`;
    return;
  }
  await startDirectory();
  if (isHR() && !policy.trackingStart) { try { await savePolicy({ trackingStart: ymd(now()) }); } catch (e) { console.warn(e); } }
  startNotifications();
  startChatWatcher().catch(e => console.warn('chat', e && e.message));
  onNotifications(setBadges);
  if (canApprove()) watchInbox(rows => { inboxCount = rows.length; setBadges(); });
  renderNav();
  startClock();
  window.addEventListener('hashchange', route);
  await route();
  const s = byId('splash'); s.style.opacity = '0'; setTimeout(() => s.remove(), 300);
  if (session.profile && session.profile.mustChangePassword) forcePasswordChange();
  setupCheck();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if ('Notification' in window && Notification.permission === 'default') setTimeout(() => { try { Notification.requestPermission(); } catch {} }, 4000);
}
boot();

/** Tell people plainly when the Firebase side isn't set up yet (rules not published / old data not migrated). */
async function setupCheck() {
  let msg = '';
  try { await read('settings', 'general'); }
  catch (e) {
    if (String(e && e.code).includes('permission')) msg = isAdmin()
      ? L('قواعد الأمان الجديدة (firestore.rules) لسه ما اتنشرتش على Firebase، فأغلب الشاشات هتقول «مش مسموح». انشرها من Firebase Console ← Firestore ← Rules ← Publish.', 'The new security rules (firestore.rules) are not published on Firebase yet, so most screens will say "not allowed". Publish them in Firebase Console → Firestore → Rules → Publish.')
      : L('السيستم لسه بيتجهز من الإدارة، وبعض الشاشات ممكن ما تشتغلش دلوقتي.', 'The system is still being set up by the admin; some screens may not work yet.');
  }
  // keep the site address used in emailed links in sync (admins only, real https site)
  if (!msg && isAdmin() && location.protocol === 'https:' && !/^(localhost|127\.)/.test(location.hostname)) {
    try {
      const { publicConfig, savePublicConfig, siteUrl } = await import('./services/authsvc.js');
      const pub = await publicConfig(true);
      if (pub.authServiceUrl && pub.siteUrl !== siteUrl()) await savePublicConfig({ siteUrl: siteUrl() });
    } catch (e) { console.warn('siteUrl sync', e && e.message); }
  }
  if (!msg && isAdmin()) {
    const m = await read('settings', 'migration').catch(() => null);
    if (!m || !m.done) msg = L('بيانات السيستم القديم لسه ما اترحّلتش. افتح الإعدادات ← النظام والترحيل ← «معاينة» ثم «تنفيذ».', 'Data from the old system has not been migrated yet. Open Settings → System & migration → Preview, then Run.');
  }
  if (!msg) return;
  const view = byId('view');
  const b = document.createElement('div');
  b.className = 'alert warn';
  b.id = 'setup-banner';
  b.style.cssText = 'margin:16px clamp(16px,3vw,32px) 0;';
  b.innerHTML = `<i class="fas fa-triangle-exclamation"></i><div>${esc(msg)}</div>`;
  view.parentNode.insertBefore(b, view);
}
