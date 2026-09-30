// Admin: activity log — what every user did (sign-ins, attendance, requests, approvals, HR edits, settings, payroll, chat).
import { L, esc, fmtDate, fmtTime, ymd, addDays, cairoMs, relTime } from '../core/utils.js';
import { avatar, empty, loader, toastErr, presenceBadge } from '../core/ui.js';
import { now } from '../core/session.js';
import { list, query, col, where, limit, Timestamp, toMs } from '../core/fb.js';
import { allPeople, person, nameOf } from '../services/directory.js';
import { STATUS_META } from '../core/ui.js';

const CATS = {
  all: ['الكل', 'All', 'fa-layer-group'],
  account: ['الدخول والحساب', 'Sign-in & account', 'fa-right-to-bracket'],
  attendance: ['الحضور والحالة', 'Attendance & status', 'fa-clock'],
  requests: ['الطلبات والموافقات', 'Requests & approvals', 'fa-paper-plane'],
  hr: ['تعديلات الموظفين', 'Employee changes', 'fa-user-pen'],
  settings: ['الإعدادات', 'Settings', 'fa-sliders'],
  payroll: ['الرواتب', 'Payroll', 'fa-money-check-dollar'],
  chat: ['الشات', 'Chat', 'fa-comments']
};
const ACTIONS = {
  'auth.login': ['سجّل دخول', 'Signed in', 'fa-right-to-bracket', 'ok'],
  'auth.logout': ['سجّل خروج', 'Signed out', 'fa-right-from-bracket', ''],
  'auth.password_change': ['غيّر كلمة المرور', 'Changed password', 'fa-key', 'warn'],
  'auth.password_set': ['اختار كلمة مرور جديدة', 'Set a new password', 'fa-key', 'warn'],
  'profile.photo': ['غيّر صورته', 'Changed photo', 'fa-camera', ''],
  'profile.recovery_email': ['غيّر إيميل الاستعادة', 'Changed recovery email', 'fa-envelope', ''],
  'request.submit': ['قدّم طلب', 'Submitted a request', 'fa-paper-plane', 'brand'],
  'request.cancel': ['ألغى طلب', 'Cancelled a request', 'fa-ban', ''],
  'request.approve': ['وافق على طلب', 'Approved a request', 'fa-check', 'ok'],
  'request.reject': ['رفض طلب', 'Rejected a request', 'fa-xmark', 'bad'],
  'request.revoke': ['ألغى طلب معتمد', 'Revoked an approval', 'fa-rotate-left', 'bad'],
  'settings.update': ['عدّل الإعدادات', 'Changed settings', 'fa-sliders', 'info'],
  'payroll.build': ['حسب الرواتب', 'Calculated payroll', 'fa-calculator', 'info'],
  'payroll.approved': ['اعتمد الرواتب', 'Approved payroll', 'fa-check-double', 'ok'],
  'payroll.draft': ['رجّع الرواتب مسودة', 'Reopened payroll', 'fa-rotate-left', 'warn'],
  'payroll.paid': ['قفل صرف الرواتب', 'Closed payroll as paid', 'fa-money-bill-transfer', 'ok'],
  'payroll.pay': ['سجّل صرف رواتب', 'Recorded salary payment', 'fa-money-bill-transfer', 'ok'],
  'payroll.status': ['غيّر حالة راتب', 'Changed a salary status', 'fa-money-bill-transfer', 'info'],
  'chat.archive': ['أرشف محادثة', 'Archived a chat', 'fa-box-archive', 'warn'],
  'chat.group_create': ['عمل جروب شات', 'Created a chat group', 'fa-users', 'brand'],
  'chat.group_update': ['عدّل جروب شات', 'Edited a chat group', 'fa-users-gear', 'info'],
  'user.create': ['أضاف موظف', 'Added an employee', 'fa-user-plus', 'brand'],
  'user.update': ['عدّل بيانات موظف', 'Edited an employee', 'fa-user-pen', 'info'],
  'user.rename': ['غيّر اسم مستخدم', 'Changed a username', 'fa-right-left', 'warn'],
  'user.password_reset': ['عمل ريسيت باسورد', 'Reset a password', 'fa-key', 'warn'],
  'balance.adjust': ['عدّل رصيد', 'Adjusted a balance', 'fa-scale-balanced', 'info']
};
const catOf = (a) => a.startsWith('status') ? 'attendance' : a.startsWith('auth.') || a.startsWith('profile.') ? 'account' : a.startsWith('request.') ? 'requests'
  : a.startsWith('user.') || a.startsWith('balance.') ? 'hr' : a.startsWith('settings.') ? 'settings' : a.startsWith('payroll.') ? 'payroll' : a.startsWith('chat.') ? 'chat' : 'hr';
const statusName = (s) => { const m = STATUS_META[s] || STATUS_META.Offline; return L(m.ar, m.en); };

export default async function render(root, { params }) {
  let who = (params && params[0] && decodeURIComponent(params[0])) || '', cat = 'all';
  let from = ymd(now()), to = ymd(now());
  root.innerHTML = `
    <div class="page-head"><div><h2>${L('سجل النشاط', 'Activity log')}</h2><p>${L('كل اللي حصل على السيستم: الدخول، الحضور، الطلبات، الموافقات، تعديلات الموظفين، الإعدادات والرواتب.', 'Everything that happened: sign-ins, attendance, requests, approvals, employee edits, settings and payroll.')}</p></div></div>
    <div class="card mb-16"><div class="card-body col gap-12">
      <div class="filters" style="margin:0">
        <select class="select" id="who"><option value="">${L('كل المستخدمين', 'All users')}</option>${allPeople().slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar')).map(p => `<option value="${esc(p.email)}" ${p.email === who ? 'selected' : ''}>${esc(p.name || p.email)}</option>`).join('')}</select>
        <div class="seg" id="range">
          <button data-r="0" class="on">${L('النهارده', 'Today')}</button><button data-r="1">${L('امبارح', 'Yesterday')}</button><button data-r="7">${L('آخر 7 أيام', 'Last 7 days')}</button><button data-r="30">${L('آخر 30 يوم', 'Last 30 days')}</button>
        </div>
        <input class="input" type="date" id="day" value="${from}" style="max-width:170px">
      </div>
      <div class="fchips" id="cats">${Object.entries(CATS).map(([k, v]) => `<button class="fchip ${k === cat ? 'on' : ''}" data-c="${k}"><i class="fas ${v[2]}"></i>${esc(L(v[0], v[1]))}<span class="num" data-n="${k}"></span></button>`).join('')}</div>
    </div></div>
    <div id="who-card"></div>
    <div class="card" id="out">${loader()}</div>`;

  let rows = [];
  async function load() {
    root.querySelector('#out').innerHTML = loader();
    const a = Timestamp.fromMillis(cairoMs(from, '00:00')), b = Timestamp.fromMillis(cairoMs(addDays(to, 1), '00:00'));
    try {
      const [acts, logs, audits] = await Promise.all([
        list(query(col('activity'), where('at', '>=', a), where('at', '<', b), limit(3000))).catch(() => []),
        list(query(col('logs'), where('timestamp', '>=', a), where('timestamp', '<', b), limit(3000))).catch(() => []),
        list(query(col('audit_log'), where('at', '>=', a), where('at', '<', b), limit(1000))).catch(() => [])
      ]);
      rows = [
        ...acts.map(x => ({ at: toMs(x.at), by: x.by, name: x.name, action: x.action, target: x.target, detail: x.detail })),
        ...logs.map(x => ({ at: toMs(x.timestamp), by: x.changed_by_email || x.user, subject: x.user, name: x.changed_by_name || x.name, action: 'status', from: x.from_status, to: x.to_status, forced: x.changed_by === 'admin' })),
        ...audits.map(x => ({ at: toMs(x.at), by: x.by, action: x.action, target: x.target || '', detail: x.from ? `${x.from} → ${x.target}` : (x.suspended ? L('إيقاف الحساب', 'suspended') : '') }))
      ].filter(r => r.at).sort((x, y) => y.at - x.at);
      draw();
    } catch (e) { toastErr(e); root.querySelector('#out').innerHTML = empty('fa-triangle-exclamation', L('تعذّر تحميل السجل', 'Could not load the log'), e.message); }
  }
  const involves = (r) => !who || r.by === who || r.subject === who || r.target === who;
  function line(r) {
    const actor = person(r.by) || { email: r.by, name: r.name || nameOf(r.by) };
    let icon, cls, text;
    if (r.action === 'status') {
      icon = 'fa-circle-dot'; cls = '';
      const self = !r.forced || r.by === r.subject;
      text = self ? L(`غيّر حالته: ${statusName(r.from)} ← ${statusName(r.to)}`, `Status: ${statusName(r.from)} → ${statusName(r.to)}`)
        : L(`غيّر حالة ${nameOf(r.subject)}: ${statusName(r.from)} ← ${statusName(r.to)}`, `Changed ${nameOf(r.subject)}'s status: ${statusName(r.from)} → ${statusName(r.to)}`);
      if (r.to === 'Online' && r.from === 'Offline') { icon = 'fa-play'; cls = 'ok'; }
      if (r.to === 'Offline') { icon = 'fa-stop'; }
    } else {
      const m = ACTIONS[r.action] || [r.action, r.action, 'fa-circle-info', ''];
      icon = m[2]; cls = m[3]; text = L(m[0], m[1]);
      const tgt = r.target && r.target.includes('@') ? nameOf(r.target) : '';
      if (tgt && r.target !== r.by) text += ` — ${tgt}`;
    }
    return `<div class="act-row">
      <span class="act-time num">${esc(fmtTime(r.at))}</span>
      <span class="icon-tile ${cls}" style="width:30px;height:30px;font-size:12px"><i class="fas ${icon}"></i></span>
      <a class="person grow min0" href="#/activity/${encodeURIComponent(r.by)}" style="color:inherit;text-decoration:none">${avatar(actor, 'sm')}<div class="min0"><b class="truncate">${esc(actor.name || actor.email)}</b><span class="truncate">${esc(text)}${r.detail ? ` · <span class="faint">${esc(r.detail)}</span>` : ''}</span></div></a>
    </div>`;
  }
  function draw() {
    const mine = rows.filter(involves);
    root.querySelectorAll('[data-n]').forEach(el => { const k = el.dataset.n; const n = k === 'all' ? mine.length : mine.filter(r => catOf(r.action) === k).length; el.textContent = n || ''; });
    const shown = mine.filter(r => cat === 'all' || catOf(r.action) === cat);
    const wc = root.querySelector('#who-card');
    const p = who && person(who);
    wc.innerHTML = p ? `<div class="card card-pad mb-16 row gap-16" style="flex-wrap:wrap">${avatar(p, 'lg')}<div class="grow"><b style="font-size:17px">${esc(p.name || p.email)}</b><div class="muted small" dir="ltr" style="text-align:start">${esc(p.email)}</div>
        <div class="row-wrap gap-8 mt-8">${presenceBadge(p.dayKey === ymd(now()) ? p.status : 'Offline')}${p.lastLoginAt ? `<span class="badge">${L('آخر دخول', 'Last sign-in')} ${esc(relTime(toMs(p.lastLoginAt)))}</span>` : ''}</div></div>
        <a class="btn" href="#/employees/${encodeURIComponent(p.email)}"><i class="fas fa-id-card"></i> ${L('ملف الموظف', 'Employee file')}</a></div>` : '';
    const out = root.querySelector('#out');
    if (!shown.length) { out.innerHTML = empty('fa-list-check', L('مفيش نشاط في الفترة دي', 'No activity in this period')); return; }
    const byDay = new Map();
    shown.forEach(r => { const d = ymd(r.at); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r); });
    out.innerHTML = [...byDay.entries()].map(([d, rs]) => `<div class="act-day">${esc(fmtDate(d))} <span class="faint num">(${rs.length})</span></div>${rs.slice(0, 500).map(line).join('')}`).join('');
  }
  root.querySelector('#who').onchange = (e) => { who = e.target.value; draw(); };
  root.querySelector('#cats').onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) return; cat = b.dataset.c; root.querySelectorAll('#cats .fchip').forEach(x => x.classList.toggle('on', x === b)); draw(); };
  root.querySelector('#range').onclick = (e) => {
    const b = e.target.closest('[data-r]'); if (!b) return;
    root.querySelectorAll('#range button').forEach(x => x.classList.toggle('on', x === b));
    const n = Number(b.dataset.r), today = ymd(now());
    if (n === 1) { from = to = addDays(today, -1); } else { to = today; from = addDays(today, -Math.max(0, n - 1)); }
    root.querySelector('#day').value = from; load();
  };
  root.querySelector('#day').onchange = (e) => { if (!e.target.value) return; from = to = e.target.value; root.querySelectorAll('#range button').forEach(x => x.classList.remove('on')); load(); };
  load();
}
