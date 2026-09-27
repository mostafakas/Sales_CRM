// UI kit: toasts, modals, confirm, avatars, badges, empty states.
import { esc, html, raw, L, initials, qsa } from './utils.js';

// ---------- toast ----------
function toastRoot() {
  let r = document.querySelector('.toasts');
  if (!r) { r = document.createElement('div'); r.className = 'toasts'; r.setAttribute('role', 'status'); r.setAttribute('aria-live', 'polite'); document.body.appendChild(r); }
  return r;
}
export function toast(title, msg = '', type = 'ok') {
  const icons = { ok: 'fa-circle-check', bad: 'fa-circle-exclamation', warn: 'fa-triangle-exclamation', info: 'fa-circle-info' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i><div class="grow"><b>${esc(title)}</b>${msg ? `<p>${esc(msg)}</p>` : ''}</div>`;
  toastRoot().appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, type === 'bad' ? 6000 : 4000);
}
export const toastErr = (e, title) => {
  console.error(e);
  const code = e && (e.code || e.message) || '';
  let msg = L('حصل خطأ غير متوقع، حاول تاني.', 'Something went wrong, please try again.');
  if (/permission/i.test(code)) msg = L('مش مسموح لك بالعملية دي.', 'You do not have permission for this action.');
  else if (/unavailable|network|offline/i.test(code)) msg = L('مفيش اتصال بالإنترنت.', 'No internet connection.');
  else if (e && e.userMessage) msg = e.userMessage;
  if (e && e.diag) msg += ` [${e.diag}]`;
  toast(title || L('تعذّر التنفيذ', 'Action failed'), msg, 'bad');
};
export function userError(ar, en) { const e = new Error(en || ar); e.userMessage = L(ar, en); return e; }

// ---------- modal ----------
const openModals = [];
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !openModals.length) return;
  const top = openModals[openModals.length - 1];
  if (!top.locked) top.close();
});
/**
 * modal({ title, icon, body, foot, size, locked, onOpen })
 * body/foot are HTML strings (use html`` to escape). Returns { el, close, $ }.
 */
export function modal({ title, icon, body = '', foot = '', size = '', locked = false, onOpen, onClose } = {}) {
  const root = document.createElement('div');
  root.className = 'modal-root';
  root.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title || '')}">
    ${title ? `<div class="modal-head"><h3>${icon ? `<span class="icon-tile"><i class="fas ${icon}"></i></span>` : ''}${esc(title)}</h3>
      ${locked ? '' : `<button class="btn btn-ghost btn-icon btn-sm" data-close aria-label="${L('إغلاق', 'Close')}"><i class="fas fa-xmark"></i></button>`}</div>` : ''}
    <div class="modal-body">${body}</div>
    ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
  </div>`;
  const api = {
    el: root, locked,
    $: (sel) => root.querySelector(sel),
    $$: (sel) => [...root.querySelectorAll(sel)],
    close() {
      const i = openModals.indexOf(api); if (i >= 0) openModals.splice(i, 1);
      root.remove(); onClose && onClose();
    }
  };
  if (!locked) root.addEventListener('mousedown', (e) => { if (e.target === root) api.close(); });
  root.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => api.close()));
  document.body.appendChild(root);
  openModals.push(api);
  const f = root.querySelector('input:not([type=hidden]):not([disabled]),select,textarea');
  setTimeout(() => f && f.focus(), 60);
  onOpen && onOpen(api);
  return api;
}

export function confirmDialog({ title, message = '', okText, okClass = 'btn-primary', cancelText, input = null } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, size: 'narrow',
      body: `<p class="muted" style="white-space:pre-wrap">${esc(message)}</p>${input ? `<div class="field mt-16"><label>${esc(input.label || '')}</label><textarea class="textarea" data-inp placeholder="${esc(input.placeholder || '')}" ${input.required ? 'required' : ''}></textarea></div>` : ''}`,
      foot: `<button class="btn" data-no>${esc(cancelText || L('إلغاء', 'Cancel'))}</button><button class="btn ${okClass}" data-yes>${esc(okText || L('تأكيد', 'Confirm'))}</button>`,
      onClose: () => { if (!done) resolve(input ? null : false); }
    });
    m.$('[data-no]').onclick = () => m.close();
    m.$('[data-yes]').onclick = () => {
      if (input) {
        const v = m.$('[data-inp]').value.trim();
        if (input.required && !v) { m.$('[data-inp]').focus(); return; }
        done = true; m.close(); resolve(v);
      } else { done = true; m.close(); resolve(true); }
    };
  });
}

/** Button loading state helper */
export async function busy(btn, fn) {
  if (!btn) return fn();
  const old = btn.innerHTML; btn.disabled = true;
  btn.innerHTML = `<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>`;
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = old; }
}

// ---------- visual atoms ----------
export function avatar(u, size = '') {
  const name = (u && (u.name || u.email)) || '?';
  if (u && u.photo) return `<span class="avatar ${size}"><img src="${esc(u.photo)}" alt=""></span>`;
  return `<span class="avatar ${size}" aria-hidden="true">${esc(initials(name))}</span>`;
}
export const STATUS_META = {
  Online: { ar: 'يعمل', en: 'Working', cls: 'ok', icon: 'fa-laptop-code', color: 'var(--ok)' },
  Break: { ar: 'استراحة', en: 'On break', cls: 'warn', icon: 'fa-mug-hot', color: 'var(--warn)' },
  Meeting: { ar: 'اجتماع', en: 'In meeting', cls: 'info', icon: 'fa-users', color: 'var(--info)' },
  Offline: { ar: 'غير متصل', en: 'Offline', cls: '', icon: 'fa-power-off', color: 'var(--neutral)' }
};
export function presenceBadge(status) {
  const s = STATUS_META[status] || STATUS_META.Offline;
  return `<span class="badge ${s.cls} ${status && status !== 'Offline' ? 'live' : ''}"><span class="dot"></span>${esc(L(s.ar, s.en))}</span>`;
}
export function empty(icon, title, text = '') {
  return `<div class="empty"><i class="fas ${icon}"></i><b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
}
export const loader = () => `<div class="page-loader"><span class="spinner"></span></div>`;
export function setHTML(el, h) { if (typeof el === 'string') el = document.getElementById(el); if (el) el.innerHTML = String(h); }

/** Bind [data-action] clicks inside root to handlers map */
export function bindActions(root, handlers) {
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t || !root.contains(t)) return;
    const fn = handlers[t.dataset.action];
    if (fn) { e.preventDefault(); fn(t.dataset, t, e); }
  });
}
export function formData(form) {
  const o = {};
  qsa('input,select,textarea', form).forEach(el => {
    if (!el.name) return;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'number') o[el.name] = el.value === '' ? null : Number(el.value);
    else o[el.name] = el.value.trim();
  });
  return o;
}
export { html, raw };

// ---------- live alert popup (chat messages, request updates) ----------
export function livePop({ icon = 'fa-bell', cls = '', who = null, title = '', text = '', href = '', action = '', ttl = 9000 }) {
  let root = document.querySelector('.chat-pops');
  if (!root) { root = document.createElement('div'); root.className = 'chat-pops'; document.body.appendChild(root); }
  const el = document.createElement('div');
  el.className = `chat-pop ${cls}`; el.setAttribute('role', 'alert');
  el.innerHTML = `${who ? avatar(who) : `<span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>`}
    <div class="grow min0"><b class="truncate">${esc(title)}</b>${text ? `<p>${esc(text)}</p>` : ''}
    <div class="row gap-8 mt-8">${href ? `<a class="btn btn-sm btn-primary" href="${esc(href)}">${esc(action || L('فتح', 'Open'))}</a>` : ''}<button class="btn btn-sm btn-ghost" data-x>${L('إغلاق', 'Dismiss')}</button></div></div>`;
  const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  el.querySelector('[data-x]').onclick = kill;
  const a = el.querySelector('a'); if (a) a.addEventListener('click', kill);
  root.prepend(el);
  while (root.children.length > 3) root.lastChild.remove();
  setTimeout(kill, ttl);
  return el;
}
