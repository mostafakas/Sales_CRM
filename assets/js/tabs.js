// Top tabs: every page you open stays as a tab under the top bar (one tab per section). A tab remembers its full
// address (e.g. the open conversation or employee file) and the scroll position; switching reloads the page there.
// Pinned tabs sit first, show their icon only and can't be closed by accident. Saved per user in this browser.
import { L, esc } from './core/utils.js';
import { session } from './core/session.js';

const MAX = 10;
let tabs = [];            // [{ id, hash, sub, pinned, scroll, used }]
let active = '';
let routes = [], allowed = () => true;
let pendingScroll = 0;
const key = () => `am_tabs_${session.email}`;
const routeOf = (id) => routes.find(r => r.id === id);
const save = () => { try { localStorage.setItem(key(), JSON.stringify({ tabs: tabs.map(({ id, hash, sub, pinned, scroll }) => ({ id, hash, sub, pinned, scroll })), active })); } catch {} };
const order = () => { tabs = [...tabs.filter(t => t.pinned), ...tabs.filter(t => !t.pinned)]; };

export function initTabs(list, isAllowed) {
  routes = list; allowed = isAllowed;
  try {
    const s = JSON.parse(localStorage.getItem(key()) || 'null');
    if (s && Array.isArray(s.tabs)) tabs = s.tabs.filter(t => t && routeOf(t.id) && allowed(routeOf(t.id))).map(t => ({ ...t, used: 0 }));
  } catch { tabs = []; }
  if (!tabs.length) tabs = [{ id: 'home', hash: '#/home', sub: '', pinned: true, scroll: 0, used: 0 }];
  order();
  const bar = document.getElementById('tabbar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const x = e.target.closest('[data-close]'); if (x) { e.stopPropagation(); closeTab(x.dataset.close); return; }
    const t = e.target.closest('[data-tab]'); if (t) openTab(t.dataset.tab);
  });
  // middle mouse button closes a tab (mousedown is cancelled so the browser doesn't start auto-scrolling)
  bar.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  bar.addEventListener('mouseup', (e) => { const t = e.target.closest('[data-tab]'); if (t && e.button === 1) { e.preventDefault(); closeTab(t.dataset.tab); } });
  bar.addEventListener('contextmenu', (e) => { const t = e.target.closest('[data-tab]'); if (!t) return; e.preventDefault(); menu(t.dataset.tab, e.clientX, e.clientY); });
  // drag to reorder (pinned tabs always stay first)
  let dragId = '';
  bar.addEventListener('dragstart', (e) => { const t = e.target.closest('[data-tab]'); if (!t) return; dragId = t.dataset.tab; e.dataTransfer.effectAllowed = 'move'; t.classList.add('dragging'); });
  bar.addEventListener('dragend', () => { dragId = ''; bar.querySelectorAll('.dragging').forEach(x => x.classList.remove('dragging')); });
  bar.addEventListener('dragover', (e) => { if (dragId) e.preventDefault(); });
  bar.addEventListener('drop', (e) => {
    e.preventDefault();
    const to = e.target.closest('[data-tab]'); if (!dragId || !to || to.dataset.tab === dragId) return;
    const from = tabs.findIndex(t => t.id === dragId), at = tabs.findIndex(t => t.id === to.dataset.tab);
    const [moved] = tabs.splice(from, 1); tabs.splice(at, 0, moved);
    order(); save(); draw();
  });
  // Alt+1…9 → that tab, Alt+W → close the current one
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (/^Digit[1-9]$/.test(e.code)) { const t = tabs[Number(e.code.slice(5)) - 1]; if (t) { e.preventDefault(); openTab(t.id); } }
    else if (e.code === 'KeyW') { e.preventDefault(); closeTab(active); }
  });
}

/** Called by the router before it renders a page: keep the old tab's scroll, make / update this page's tab.
 *  Returns the scroll position to restore (only when the page was reopened from its tab). */
export function enterTab(r, hash) {
  const prev = tabs.find(t => t.id === active);
  if (prev && prev.id !== r.id) prev.scroll = Math.round(window.scrollY);
  let t = tabs.find(x => x.id === r.id);
  if (!t) {
    t = { id: r.id, hash, sub: '', pinned: false, scroll: 0, used: 0 };
    const i = tabs.findIndex(x => x.id === active);
    tabs.splice(i >= 0 ? i + 1 : tabs.length, 0, t);                       // opens next to the current tab
    const loose = tabs.filter(x => !x.pinned && x.id !== r.id);
    if (tabs.length > MAX && loose.length) { const oldest = loose.sort((a, b) => a.used - b.used)[0]; tabs = tabs.filter(x => x !== oldest); }
  } else if (t.hash !== hash) { t.hash = hash; t.sub = ''; }
  t.used = Date.now();
  active = r.id;
  const y = pendingScroll; pendingScroll = 0;
  order(); save(); draw();
  return y;
}

/** A page can name what it shows (e.g. the open conversation) — shown after the page name on its tab */
export function setTabLabel(text) {
  const t = tabs.find(x => x.id === active); if (!t) return;
  const v = String(text || '').slice(0, 60);
  if (t.sub === v) return;
  t.sub = v; save(); draw();
}

/** Scroll back once the page has loaded enough content (data arrives a moment after the page opens) */
export function restoreScroll(y) {
  if (!y) return;
  let n = 0;
  const go = () => {
    if (document.documentElement.scrollHeight - window.innerHeight >= y - 4 || n >= 12) { window.scrollTo(0, y); return; }
    n += 1; setTimeout(go, 150);
  };
  setTimeout(go, 60);
}

function openTab(id) {
  const t = tabs.find(x => x.id === id); if (!t) return;
  if (id === active && location.hash === t.hash) return;
  const cur = tabs.find(x => x.id === active); if (cur && cur.id !== id) cur.scroll = Math.round(window.scrollY);
  pendingScroll = t.scroll || 0;
  if (location.hash === t.hash) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = t.hash;
}
function closeTab(id) {
  const i = tabs.findIndex(x => x.id === id); if (i < 0) return;
  if (tabs.length === 1) { if (id === 'home') return; tabs = [{ id: 'home', hash: '#/home', sub: '', pinned: true, scroll: 0, used: 0 }]; save(); location.hash = '#/home'; return; }
  const wasActive = id === active;
  tabs.splice(i, 1);
  save();
  if (wasActive) openTab((tabs[i] || tabs[i - 1]).id); else draw();
}
function togglePin(id) { const t = tabs.find(x => x.id === id); if (!t) return; t.pinned = !t.pinned; order(); save(); draw(); }
function closeOthers(id) { tabs = tabs.filter(t => t.id === id || t.pinned); save(); if (active !== id) openTab(id); else draw(); }

function menu(id, x, y) {
  document.querySelectorAll('.tab-menu').forEach(m => m.remove());
  const t = tabs.find(z => z.id === id); if (!t) return;
  const m = document.createElement('div');
  m.className = 'tab-menu';
  m.innerHTML = `
    <button data-m="pin"><i class="fas fa-thumbtack"></i>${t.pinned ? L('إلغاء التثبيت', 'Unpin') : L('تثبيت التاب', 'Pin tab')}</button>
    <button data-m="reload"><i class="fas fa-rotate-right"></i>${L('تحديث الصفحة دي', 'Reload this page')}</button>
    <button data-m="close"><i class="fas fa-xmark"></i>${L('قفل التاب', 'Close tab')}</button>
    <button data-m="others"><i class="fas fa-layer-group"></i>${L('قفل التابات التانية', 'Close other tabs')}</button>`;
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  m.style.left = `${Math.max(8, Math.min(x - (document.dir === 'rtl' ? r.width : 0), window.innerWidth - r.width - 8))}px`;
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off, true); } };
  document.addEventListener('mousedown', off, true);
  m.onclick = (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    m.remove(); document.removeEventListener('mousedown', off, true);
    if (b.dataset.m === 'pin') togglePin(id);
    if (b.dataset.m === 'close') closeTab(id);
    if (b.dataset.m === 'others') closeOthers(id);
    if (b.dataset.m === 'reload') { if (id === active) window.dispatchEvent(new HashChangeEvent('hashchange')); else openTab(id); }
  };
}

function draw() {
  const bar = document.getElementById('tabbar'); if (!bar) return;
  bar.innerHTML = tabs.map((t, n) => {
    const r = routeOf(t.id); if (!r) return '';
    const name = L(r.ar, r.en);
    const title = t.sub ? `${name} · ${t.sub}` : name;
    return `<div class="tab ${t.id === active ? 'on' : ''} ${t.pinned ? 'pinned' : ''}" data-tab="${esc(t.id)}" draggable="true" role="tab" aria-selected="${t.id === active}" title="${esc(title)}${n < 9 ? ` (Alt+${n + 1})` : ''}">
      <i class="fas ${r.icon}"></i>${t.pinned ? '' : `<span class="tab-name">${esc(name)}${t.sub ? `<small> · ${esc(t.sub)}</small>` : ''}</span>`}
      ${r.badge ? `<span class="badge-count hidden" data-badge="${r.badge}"></span>` : ''}
      ${t.pinned ? '' : `<button class="tab-x" data-close="${esc(t.id)}" aria-label="${L('قفل', 'Close')}"><i class="fas fa-xmark"></i></button>`}</div>`;
  }).join('');
  const on = bar.querySelector('.tab.on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  window.dispatchEvent(new Event('am:tabs-drawn'));   // the shell refreshes the badge counters
}
