import { L, esc, relTime } from '../core/utils.js';
import { empty } from '../core/ui.js';
import { toMs } from '../core/fb.js';
import { onNotifications, markRead, markAllRead } from '../services/notify.js';

export default async function render(root) {
  root.innerHTML = `<div class="page-head"><div><h2>${L('الإشعارات', 'Notifications')}</h2></div>
    <button class="btn btn-soft" id="all-read"><i class="fas fa-check-double"></i> ${L('تعليم الكل كمقروء', 'Mark all as read')}</button></div>
    <div class="card"><div class="list" id="nlist"></div></div>`;
  root.querySelector('#all-read').onclick = () => markAllRead();
  const off = onNotifications(items => {
    const el = root.querySelector('#nlist');
    if (!items.length) { el.innerHTML = empty('fa-bell-slash', L('مفيش إشعارات', 'No notifications')); return; }
    el.innerHTML = items.map(n => `<a class="list-item" href="${esc(n.link || '#/home')}" data-id="${esc(n.id)}" style="text-decoration:none;color:inherit;${n.read ? '' : 'background:var(--brand-soft)'}">
      <span class="icon-tile ${n.read ? 'neutral' : ''}"><i class="fas fa-bell"></i></span>
      <div class="grow"><b class="small">${esc(n.title)}</b>${n.body ? `<div class="xs muted">${esc(n.body)}</div>` : ''}</div>
      <span class="xs faint nowrap">${esc(relTime(toMs(n.at)))}</span></a>`).join('');
    el.querySelectorAll('[data-id]').forEach(a => a.addEventListener('click', () => markRead(a.dataset.id)));
  });
  return off;
}
