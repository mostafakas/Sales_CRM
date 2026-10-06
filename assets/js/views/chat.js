// Chat: 1:1 conversations and groups — text, links, images, files, voice notes, "seen by", per-chat mute.
// The system admin creates groups, picks their admins and may allow editing / deleting in a group; admins can
// also open any conversation and archive it.
import { L, esc, fmtTime, fmtDate, ymd, relTime, debounce, imageToDataUrl } from '../core/utils.js';
import { toast, toastErr, avatar, empty, loader, confirmDialog, modal, busy, STATUS_META } from '../core/ui.js';
import { session, now, isAdmin } from '../core/session.js';
import { read, toMs } from '../core/fb.js';
import { activePeople, person, nameOf, onDirectory, departments } from '../services/directory.js';
import { play } from '../core/sounds.js';
import {
  ensureChat, watchMyChats, watchAllChats, watchMessages, sendText, sendFile, sendVoice, loadFile, markRead, archiveChat, listArchive,
  otherOf, othersOf, unreadOf, ek, MAX_FILE, isGroup, canManageGroup, isMuted, seenBy, canEditMessage, createGroup, updateGroup, setMuted,
  editMessage, deleteMessage, mentionedMe
} from '../services/chat.js';
import { startTasks, allTasks, taskById, taskLink } from '../services/tasks.js';
import { setTabLabel } from '../tabs.js';

const fmtSize = (n) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const fmtLen = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
const fileIcon = (mime = '', name = '') => /pdf/.test(mime) ? 'fa-file-pdf' : /sheet|excel|csv/.test(mime + name) ? 'fa-file-excel' : /word|document/.test(mime) ? 'fa-file-word' : /zip|rar|7z/.test(mime + name) ? 'fa-file-zipper' : /image/.test(mime) ? 'fa-file-image' : /video/.test(mime) ? 'fa-file-video' : /audio/.test(mime) ? 'fa-file-audio' : 'fa-file-lines';
const presence = (p) => {
  if (!p) return '';
  const on = p.dayKey && p.status && p.status !== 'Offline';
  if (on) { const m = STATUS_META[p.status]; return `<span class="chat-presence on" style="--c:${m.color}">${esc(L(m.ar, m.en))}</span>`; }
  return `<span class="chat-presence">${p.lastChange ? L(`آخر نشاط ${relTime(toMs(p.lastChange))}`, `Last active ${relTime(toMs(p.lastChange))}`) : L('غير متصل', 'Offline')}</span>`;
};
const dotFor = (p) => { const on = p && p.dayKey && p.status && p.status !== 'Offline'; return `<span class="status-dot" style="background:${on ? STATUS_META[p.status].color : 'var(--neutral)'}"></span>`; };
const who = (email) => person(email) || { email, name: nameOf(email) };
const groupPic = (c, size = '') => c.photo ? `<span class="avatar ${size}"><img src="${esc(c.photo)}" alt=""></span>` : `<span class="avatar chat-gav ${size}" aria-hidden="true"><i class="fas fa-users"></i></span>`;
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Escaped message text: http(s) links clickable, "@name" of mentioned members highlighted and "#12" of tagged
 * tasks shown as a chip with the task title (the title travels inside the message, so every member can read it).
 */
function richText(m) {
  const names = (m.mentions || []).map(e => ({ e, n: '@' + nameOf(e) })).sort((a, b) => b.n.length - a.n.length);
  const tasks = m.tasks || [];
  const parts = [];
  if (names.length) parts.push(names.map(x => reEsc(x.n)).join('|'));
  if (tasks.length) parts.push(`#(?:${tasks.map(t => Number(t.num) || 0).join('|')})(?![0-9])`);
  const re = parts.length ? new RegExp(`(${parts.join('|')})`, 'g') : null;
  const deco = (txt) => !re ? esc(txt) : txt.split(re).map((p, i) => {
    if (!(i % 2)) return esc(p);
    if (p[0] === '#') { const t = tasks.find(x => `#${x.num}` === p); return t ? `<button class="chat-taskref" data-task="${esc(t.id)}" title="${esc(t.title)}">#${Number(t.num) || 0} · ${esc(t.title)}</button>` : esc(p); }
    const x = names.find(n => n.n === p);
    return `<span class="chat-mention ${x && x.e === session.email ? 'me' : ''}">${esc(p)}</span>`;
  }).join('');
  return String(m.text || '').split(/(https?:\/\/[^\s<]+)/g).map((part, i) => i % 2 ? `<a href="${esc(part)}" target="_blank" rel="noopener">${esc(part)}</a>` : deco(part)).join('');
}

export default async function render(root, { params }) {
  let openId = params && params[0] ? decodeURIComponent(params[0]) : '';
  // an old link to a chat task (#/chat/<group>/<task>) now opens the task on the Tasks page
  if (params && params[1]) { location.replace(taskLink(decodeURIComponent(params[1]))); return () => {}; }
  startTasks(); // "#" mentions list my tasks
  let mode = 'mine', chats = [], allChats = [], term = '', openChat = null, msgs = [], showArchive = false, archived = [];
  let unChats = null, unAll = null, unMsgs = null, recorder = null;
  const admin = isAdmin();

  root.innerHTML = `
    <div class="chat-app ${openId ? 'has-open' : ''}" id="app">
      <aside class="card chat-side">
        <div class="chat-side-head">
          <h2>${L('الشات', 'Chat')}</h2>
          <div class="row gap-4">
            ${admin ? `<button class="btn btn-soft btn-sm" id="newg" title="${L('جروب جديد', 'New group')}"><i class="fas fa-users"></i> ${L('جروب', 'Group')}</button>` : ''}
            <div class="chat-new-wrap">
              <button class="btn btn-primary btn-sm" id="new"><i class="fas fa-pen-to-square"></i> ${L('محادثة', 'New chat')}</button>
              <div class="chat-picker hidden" id="picker">
                <div class="search"><i class="fas fa-search"></i><input class="input" id="pq" placeholder="${L('ابحث عن موظف', 'Find a colleague')}"></div>
                <div class="chat-picker-list" id="plist"></div>
              </div>
            </div>
          </div>
        </div>
        ${admin ? `<div class="seg chat-modes" id="modes"><button data-m="mine" class="on">${L('محادثاتي', 'My chats')}</button><button data-m="all">${L('كل المحادثات', 'All chats')}</button></div>` : ''}
        <div class="search chat-search"><i class="fas fa-search"></i><input class="input" id="q" placeholder="${L('بحث في المحادثات', 'Search chats')}"></div>
        <div class="chat-convs" id="convs">${loader()}</div>
      </aside>
      <section class="card chat-thread" id="thread"></section>
    </div>`;
  const $ = (s) => root.querySelector(s);

  // ---------- new chat picker (everyone, with photos) ----------
  const drawPicker = () => {
    const q = $('#pq').value.trim().toLowerCase();
    const ppl = activePeople().filter(p => p.email !== session.email && (!q || `${p.name} ${p.title} ${p.department} ${p.email}`.toLowerCase().includes(q)))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));
    $('#plist').innerHTML = ppl.length ? ppl.map(p => `<button class="chat-person" data-to="${esc(p.email)}"><span class="avatar-wrap">${avatar(p, 'sm')}${dotFor(p)}</span><span class="min0 grow"><b class="truncate">${esc(p.name || p.email)}</b><small class="truncate">${esc(p.title || '')}${p.department ? ' · ' + esc(p.department) : ''}</small></span></button>`).join('')
      : `<div class="muted small" style="padding:14px">${L('مفيش نتائج', 'No results')}</div>`;
  };
  $('#new').onclick = (e) => { e.stopPropagation(); const pk = $('#picker'); pk.classList.toggle('hidden'); if (!pk.classList.contains('hidden')) { drawPicker(); $('#pq').value = ''; $('#pq').focus(); } };
  $('#pq').oninput = debounce(drawPicker, 100);
  $('#plist').onclick = async (e) => {
    const b = e.target.closest('[data-to]'); if (!b) return;
    $('#picker').classList.add('hidden');
    try { const id = await ensureChat(b.dataset.to); location.hash = `#/chat/${encodeURIComponent(id)}`; } catch (ex) { toastErr(ex); }
  };
  const closePicker = (e) => { if (!e.target.closest('.chat-new-wrap')) $('#picker').classList.add('hidden'); };
  document.addEventListener('click', closePicker);
  if (admin) $('#newg').onclick = () => groupEditor(null);

  // ---------- group: create / edit (name, photo, members, group admins) ----------
  function groupEditor(chat) {
    const isNew = !chat;
    const sys = isAdmin();
    let photo = (chat && chat.photo) || '';
    const members = new Set(isNew ? [] : othersOf(chat));
    const admins = new Set(isNew ? [] : (chat.admins || []));
    const m = modal({
      title: isNew ? L('جروب جديد', 'New group') : L('تعديل الجروب', 'Edit group'), icon: 'fa-users', size: '',
      body: `<div class="col gap-16">
        <div class="row gap-12">
          <label style="cursor:pointer" title="${L('صورة الجروب', 'Group photo')}"><span id="gp">${groupPic({ photo }, 'lg')}</span><input type="file" accept="image/*" hidden id="gph"></label>
          <div class="field grow"><label>${L('اسم الجروب', 'Group name')} *</label><input class="input" id="gn" maxlength="80" value="${esc((chat && chat.name) || '')}"></div>
        </div>
        <div>
          <div class="row between mb-8"><b>${L('الأعضاء', 'Members')} <span class="num muted" id="gc"></span></b>
            <div class="row gap-8"><select class="select" id="gd" style="min-width:150px"><option value="">${L('اختيار قسم كامل…', 'Select a department…')}</option>${departments().map(d => `<option>${esc(d)}</option>`).join('')}</select></div></div>
          <div class="search mb-8"><i class="fas fa-search"></i><input class="input" id="gq" placeholder="${L('ابحث بالاسم أو القسم', 'Search name or department')}"></div>
          <div class="chat-members" id="gl"></div>
          <p class="xs muted mt-8">${sys ? L('علّم «مشرف» جنب العضو عشان يبقى أدمن للجروب: يقدر يضيف ويشيل أعضاء ويغيّر الاسم والصورة.', 'Tick "admin" next to a member to make them a group admin: they can add / remove members and change the name and photo.') : L('مشرفين الجروب بيحددهم أدمن السيستم.', 'Group admins are chosen by the system admin.')}</p>
        </div></div>`,
      foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="gs"><i class="fas fa-floppy-disk"></i> ${isNew ? L('إنشاء الجروب', 'Create group') : L('حفظ', 'Save')}</button>`
    });
    const draw = () => {
      const q = m.$('#gq').value.trim().toLowerCase();
      const ppl = activePeople().filter(p => p.email !== session.email && (!q || `${p.name} ${p.title} ${p.department} ${p.email}`.toLowerCase().includes(q)))
        .sort((a, b) => (members.has(b.email) - members.has(a.email)) || (a.name || '').localeCompare(b.name || '', 'ar'));
      m.$('#gl').innerHTML = ppl.map(p => {
        const locked = !sys && admins.has(p.email); // a group admin cannot remove another admin
        return `<div class="chat-member"><label class="check grow min0"><input type="checkbox" data-mem="${esc(p.email)}" ${members.has(p.email) ? 'checked' : ''} ${locked ? 'disabled' : ''}>${avatar(p, 'sm')}<span class="min0"><b class="truncate">${esc(p.name || p.email)}</b><small class="truncate">${esc(p.title || '')}${p.department ? ' · ' + esc(p.department) : ''}</small></span></label>
          ${sys ? `<label class="check xs" title="${L('أدمن الجروب', 'Group admin')}"><input type="checkbox" data-adm="${esc(p.email)}" ${admins.has(p.email) ? 'checked' : ''} ${members.has(p.email) ? '' : 'disabled'}> ${L('مشرف', 'Admin')}</label>` : (admins.has(p.email) ? `<span class="badge brand">${L('مشرف', 'Admin')}</span>` : '')}</div>`;
      }).join('') || `<div class="muted small" style="padding:14px">${L('مفيش نتائج', 'No results')}</div>`;
      m.$('#gc').textContent = `(${members.size + 1})`;
    };
    m.$('#gl').onchange = (e) => {
      const t = e.target;
      if (t.dataset.mem) { if (t.checked) members.add(t.dataset.mem); else { members.delete(t.dataset.mem); admins.delete(t.dataset.mem); } }
      if (t.dataset.adm) { if (t.checked) admins.add(t.dataset.adm); else admins.delete(t.dataset.adm); }
      draw();
    };
    m.$('#gq').oninput = debounce(draw, 100);
    m.$('#gd').onchange = (e) => { const d = e.target.value; if (!d) return; activePeople().forEach(p => { if (p.department === d && p.email !== session.email) members.add(p.email); }); e.target.value = ''; draw(); };
    m.$('#gph').onchange = async (e) => { try { photo = await imageToDataUrl(e.target.files[0], 160, 0.8); m.$('#gp').innerHTML = groupPic({ photo }, 'lg'); } catch { toast(L('الصورة مش صالحة', 'Invalid image'), '', 'bad'); } };
    m.$('#gs').onclick = (e) => busy(e.currentTarget, async () => {
      const name = m.$('#gn').value.trim();
      if (!name) { m.$('#gn').focus(); return; }
      if (!members.size) { toast(L('اختار عضو واحد على الأقل', 'Pick at least one member'), '', 'warn'); return; }
      try {
        if (isNew) { const id = await createGroup({ name, photo, members: [...members], admins: [...admins] }); m.close(); toast(L('اتعمل الجروب', 'Group created'), name); location.hash = `#/chat/${encodeURIComponent(id)}`; }
        else {
          const keepMe = (chat.members || []).includes(session.email) ? [session.email] : [];
          await updateGroup(chat, { name, photo, members: [...members, ...keepMe], ...(sys ? { admins: [...admins, ...((chat.admins || []).includes(session.email) ? [session.email] : [])] } : {}) });
          m.close(); toast(L('اتحفظ', 'Saved'));
        }
      } catch (ex) { toastErr(ex); }
    });
    draw();
  }

  /** Group details: members and roles, my notifications, and (system admin) the edit / delete switch */
  function groupInfo(chat) {
    const member = (chat.members || []).includes(session.email);
    const m = modal({
      title: chat.name, icon: 'fa-users', size: 'narrow',
      body: `<div class="col gap-16">
        ${member ? `<div class="row between"><div><b>${L('إشعارات الجروب ده', 'Notifications for this group')}</b><div class="xs muted">${L('لو قفلتها مفيش بوب أب ولا صوت — العدّاد بيفضل يعدّ.', 'Off = no popup or sound; the unread counter still counts.')}</div></div><label class="switch"><input type="checkbox" id="gmute" ${isMuted(chat) ? '' : 'checked'}><span></span></label></div>` : ''}
        ${admin ? `<div class="row between"><div><b>${L('السماح بتعديل وحذف الرسايل', 'Allow editing and deleting messages')}</b><div class="xs muted">${L('كل عضو يقدر يعدّل أو يحذف رسايله هو في الجروب ده.', 'Each member may edit or delete their own messages in this group.')}</div></div><label class="switch"><input type="checkbox" id="gedit" ${chat.allowEdit ? 'checked' : ''}><span></span></label></div>` : ''}
        <div><div class="label mb-8">${L('الأعضاء', 'Members')} (${(chat.members || []).length})</div>
          <div class="chat-members">${(chat.members || []).map(e => who(e)).sort((a, b) => ((chat.admins || []).includes(b.email) - (chat.admins || []).includes(a.email)) || (a.name || '').localeCompare(b.name || '', 'ar'))
            .map(p => `<div class="chat-member"><span class="avatar-wrap">${avatar(p, 'sm')}${dotFor(person(p.email))}</span><span class="grow min0"><b class="truncate">${esc(p.name || p.email)}${p.email === session.email ? ` <span class="muted">(${L('أنت', 'you')})</span>` : ''}</b><small class="truncate">${esc(p.title || '')}</small></span>${(chat.admins || []).includes(p.email) ? `<span class="badge brand">${L('مشرف', 'Admin')}</span>` : ''}</div>`).join('')}</div></div>
      </div>`,
      foot: `${canManageGroup(chat) ? `<button class="btn" id="gedit-btn"><i class="fas fa-user-gear"></i> ${L('تعديل الأعضاء والاسم', 'Edit members & name')}</button>` : ''}<button class="btn btn-primary" data-close>${L('تمام', 'Done')}</button>`
    });
    const mu = m.$('#gmute'); if (mu) mu.onchange = async () => { try { await setMuted(chat, !mu.checked); toast(mu.checked ? L('الإشعارات شغالة', 'Notifications on') : L('الإشعارات اتقفلت للجروب ده', 'Notifications off for this group')); } catch (ex) { toastErr(ex); } };
    const ed = m.$('#gedit'); if (ed) ed.onchange = async () => { try { await updateGroup(chat, { allowEdit: ed.checked }); toast(ed.checked ? L('التعديل والحذف اتفعّلوا', 'Editing and deleting enabled') : L('التعديل والحذف اتقفلوا', 'Editing and deleting disabled')); } catch (ex) { toastErr(ex); } };
    const eb = m.$('#gedit-btn'); if (eb) eb.onclick = () => { m.close(); groupEditor(chat); };
  }

  // ---------- conversation list ----------
  function convTitle(c) {
    if (isGroup(c)) return c.name || L('جروب', 'Group');
    if (c.members.includes(session.email)) { const o = person(otherOf(c)); return o ? (o.name || o.email) : nameOf(otherOf(c)); }
    return c.members.map(nameOf).join(' ↔ ');
  }
  function drawList() {
    const src = mode === 'all' ? allChats : chats;
    const rows = src.filter(c => !term || convTitle(c).toLowerCase().includes(term) || (c.members || []).some(m => m.includes(term)));
    const el = $('#convs');
    if (!rows.length) {
      el.innerHTML = empty('fa-comments', mode === 'all' ? L('مفيش محادثات لسه', 'No conversations yet') : L('ابدأ محادثة', 'Start a conversation'), mode === 'all' ? '' : L('اضغط «محادثة» واختار زميل.', 'Click "New chat" and pick a colleague.'));
      return;
    }
    el.innerHTML = rows.map(c => {
      const mine = c.members.includes(session.email);
      const g = isGroup(c);
      const o = mine && !g ? person(otherOf(c)) : null;
      const lm = c.lastMessage;
      const n = mine ? unreadOf(c) : 0;
      const pic = g ? groupPic(c) : (mine ? `<span class="avatar-wrap">${avatar(o || who(otherOf(c)), '')}${dotFor(o)}</span>`
        : `<span class="chat-duo">${c.members.map(m => avatar(who(m), 'sm')).join('')}</span>`);
      const prev = lm ? `${lm.by === session.email ? L('أنت: ', 'You: ') : (g || !mine ? nameOf(lm.by).split(' ')[0] + ': ' : '')}${lm.text || ''}` : (c.archivedAt ? L('📦 اتأرشفت', '📦 Archived') : L('لسه مفيش رسائل', 'No messages yet'));
      return `<a class="chat-conv ${c.id === openId ? 'on' : ''} ${n ? 'unread' : ''}" href="#/chat/${encodeURIComponent(c.id)}">
        ${pic}
        <span class="grow min0"><span class="row between gap-8"><b class="truncate">${g ? '<i class="fas fa-users faint" style="font-size:11px"></i> ' : ''}${esc(convTitle(c))}</b><small class="faint num">${lm && lm.at ? esc(ymd(toMs(lm.at)) === ymd(now()) ? fmtTime(toMs(lm.at)) : fmtDate(toMs(lm.at))) : ''}</small></span>
        <span class="row between gap-8"><small class="truncate">${esc(prev)}</small><span class="row gap-4">${mine && isMuted(c) ? `<i class="fas fa-bell-slash faint" style="font-size:11px" title="${L('الإشعارات مقفولة', 'Muted')}"></i>` : ''}${mine && mentionedMe(c) ? `<span class="badge-at" title="${L('حد عملك منشن', 'You were mentioned')}">@</span>` : ''}${n ? `<span class="badge-count ${isMuted(c) ? 'muted-count' : ''}">${n > 99 ? '99+' : n}</span>` : ''}</span></span></span></a>`;
    }).join('');
  }
  $('#q').oninput = debounce((e) => { term = e.target.value.trim().toLowerCase(); drawList(); }, 120);
  const modes = $('#modes');
  if (modes) modes.onclick = (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    mode = b.dataset.m; modes.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (mode === 'all' && !unAll) unAll = watchAllChats(rows => { allChats = rows; if (mode === 'all') drawList(); if (openId && !openChat) openThread(openId); });
    drawList();
  };

  // ---------- thread ----------
  function emptyThread() {
    setTabLabel('');
    $('#thread').innerHTML = `<div class="chat-empty">${empty('fa-comments', L('اختار محادثة', 'Pick a conversation'), L('أو ابدأ واحدة جديدة مع أي زميل.', 'Or start a new one with any colleague.'))}</div>`;
  }
  function headHTML() {
    const member = openChat.members.includes(session.email);
    if (isGroup(openChat)) {
      return `<button class="chat-head-btn" id="ginfo">${groupPic(openChat)}<div class="grow min0"><b class="truncate">${esc(openChat.name)}</b><div class="small muted truncate">${L(`${openChat.members.length} عضو`, `${openChat.members.length} members`)}${member ? '' : ` · <i class="fas fa-eye"></i> ${L('بتشوفه كأدمن', 'Viewing as admin')}`}${openChat.allowEdit ? ` · <i class="fas fa-pen"></i> ${L('التعديل والحذف مفعّلين', 'Edit & delete on')}` : ''}</div></div></button>`;
    }
    const o = member ? person(otherOf(openChat)) : null;
    return member
      ? `<span class="avatar-wrap">${avatar(o || who(otherOf(openChat)))}${dotFor(o)}</span><div class="grow min0"><b class="truncate">${esc(convTitle(openChat))}</b><div class="small">${o ? presence(o) : ''}${o && o.title ? ` · <span class="muted">${esc(o.title)}</span>` : ''}</div></div>`
      : `<span class="chat-duo">${openChat.members.map(m => avatar(who(m), 'sm')).join('')}</span><div class="grow min0"><b class="truncate">${esc(convTitle(openChat))}</b><div class="small muted"><i class="fas fa-eye"></i> ${L('بتشوفها كأدمن — مش بتظهر للطرفين', 'Viewing as admin — they are not notified')}</div></div>`;
  }
  function drawHead() {
    const h = $('#chat-head-main'); if (!h || !openChat) return;
    h.innerHTML = headHTML();
    const gi = $('#ginfo'); if (gi) gi.onclick = () => groupInfo(openChat);
  }
  async function openThread(id) {
    if (unMsgs) { unMsgs(); unMsgs = null; }
    stopRecording(true);
    openId = id; window.__amOpenChat = id; showArchive = false; archived = [];
    $('#app').classList.toggle('has-open', !!id);
    if (!id) { openChat = null; emptyThread(); drawList(); return; }
    openChat = [...chats, ...allChats].find(c => c.id === id) || await read('chats', id).catch(() => null);
    if (openChat && !admin && !(openChat.members || []).includes(session.email)) openChat = null; // not (or no longer) a member
    if (!openChat) { $('#thread').innerHTML = `<div class="chat-empty">${empty('fa-lock', L('المحادثة مش متاحة', 'Conversation not available'))}</div>`; return; }
    drawList();
    setTabLabel(convTitle(openChat));
    const member = openChat.members.includes(session.email);
    $('#thread').innerHTML = `
      <header class="chat-head">
        <a class="btn btn-ghost btn-icon chat-back" href="#/chat" aria-label="${L('رجوع', 'Back')}"><i class="fas fa-arrow-right" data-flip></i></a>
        <div class="row gap-12 grow min0" id="chat-head-main"></div>
        ${admin ? `<div class="row gap-4"><button class="btn btn-sm btn-ghost" id="arch-view" title="${L('الرسائل المؤرشفة', 'Archived messages')}"><i class="fas fa-box-archive"></i><span class="hide-sm"> ${L('الأرشيف', 'Archive')}</span></button><button class="btn btn-sm btn-ghost" id="arch" title="${L('أرشفة المحادثة', 'Archive conversation')}" style="color:var(--bad)"><i class="fas fa-folder-minus"></i><span class="hide-sm"> ${L('أرشفة', 'Archive now')}</span></button></div>` : ''}
      </header>
      <div class="chat-msgs" id="msgs">${loader()}</div>
      ${member ? `<form class="chat-compose" id="compose">
        <div class="chat-upload hidden" id="up"><div class="progress"><span style="width:0%"></span></div><small id="up-t"></small></div>
        <div class="row gap-8" style="align-items:flex-end" id="compose-row">
          <label class="btn btn-ghost btn-icon" title="${L('إرفاق صورة أو ملف', 'Attach an image or file')}"><i class="fas fa-paperclip"></i><input type="file" id="file" multiple hidden></label>
          <textarea class="input chat-input" id="text" rows="1" placeholder="${isGroup(openChat) ? L('اكتب رسالة… (@ منشن · # تاسك)', 'Message… (@ mention · # task)') : L('اكتب رسالة…', 'Write a message…')}"></textarea>
          <button class="btn btn-ghost btn-icon" type="button" id="mic" title="${L('رسالة صوتية', 'Voice note')}" aria-label="${L('رسالة صوتية', 'Voice note')}"><i class="fas fa-microphone"></i></button>
          <button class="btn btn-primary btn-icon" type="submit" aria-label="${L('إرسال', 'Send')}"><i class="fas fa-paper-plane" data-flip></i></button>
        </div>
        <div class="chat-rec hidden" id="rec"><span class="rec-dot"></span><b class="num" id="rec-t">0:00</b><span class="grow small muted">${L('بيسجّل… اضغط إرسال لما تخلّص', 'Recording… press send when done')}</span>
          <button class="btn btn-ghost btn-icon" type="button" id="rec-x" title="${L('إلغاء', 'Cancel')}"><i class="fas fa-trash"></i></button>
          <button class="btn btn-primary btn-icon" type="button" id="rec-ok" title="${L('إرسال', 'Send')}"><i class="fas fa-paper-plane" data-flip></i></button></div>
      </form>` : ''}`;
    drawHead();
    let known = null;
    unMsgs = watchMessages(id, rows => {
      // a new message from someone else while the conversation is open → soft "receive" sound
      if (known && rows.some(m => !known.has(m.id) && m.by !== session.email) && !isMuted(openChat)) play('receive');
      known = new Set(rows.map(m => m.id));
      msgs = rows; drawMsgs();
      if (member && !document.hidden) markRead(openChat);
    });
    if (member) wireComposer();
    if (admin) {
      $('#arch').onclick = async () => {
        const ok = await confirmDialog({ title: L('أرشفة المحادثة', 'Archive conversation'), message: L('كل الرسائل الحالية هتتنقل للأرشيف ومش هتظهر للأعضاء تاني. الأدمن بس يقدر يشوفها من «الأرشيف». تكمّل؟', 'All current messages move to the archive and disappear for the members. Only admins can see them under "Archive". Continue?'), okText: L('أرشفة', 'Archive'), okClass: 'btn-danger' });
        if (!ok) return;
        try { const n = await archiveChat(openChat); toast(L(`اتأرشفت ${n} رسالة`, `${n} messages archived`)); } catch (ex) { toastErr(ex); }
      };
      $('#arch-view').onclick = async () => {
        showArchive = !showArchive;
        $('#arch-view').classList.toggle('btn-soft', showArchive);
        if (showArchive) { try { archived = await listArchive(id); } catch (ex) { toastErr(ex); archived = []; } }
        drawMsgs();
      };
    }
  }

  function bubble(m, prev) {
    const mine = m.by === session.email;
    const member = openChat.members.includes(session.email);
    const g = isGroup(openChat);
    const side = member ? (mine ? 'me' : 'them') : (g ? 'them' : (m.by === openChat.members[0] ? 'them' : 'me'));
    const grouped = prev && prev.by === m.by && (toMs(m.at) || 0) - (toMs(prev.at) || 0) < 5 * 60000;
    const at = toMs(m.at);
    let body = '';
    if (m.deleted) body = `<div class="chat-text chat-deleted"><i class="fas fa-ban"></i> ${L('الرسالة دي اتمسحت', 'This message was deleted')}</div>`;
    else {
      if (m.type === 'image' && m.file) body += `<button class="chat-img" data-file="${esc(m.file.id)}" title="${esc(m.file.name)}"><img src="${esc(m.file.thumb || '')}" alt="${esc(m.file.name)}" loading="lazy"></button>`;
      if (m.type === 'file' && m.file) body += `<button class="chat-file" data-file="${esc(m.file.id)}"><i class="fas ${fileIcon(m.file.mime, m.file.name)}"></i><span class="min0 grow"><b class="truncate">${esc(m.file.name)}</b><small>${esc(fmtSize(m.file.size || 0))}</small></span><i class="fas fa-download"></i></button>`;
      if (m.type === 'voice' && m.file) body += `<div class="chat-voice" data-voice="${esc(m.file.id)}"><button class="btn btn-icon chat-voice-play" data-play="${esc(m.file.id)}" aria-label="${L('تشغيل', 'Play')}"><i class="fas fa-play"></i></button><span class="chat-voice-wave"></span><span class="num small">${esc(fmtLen(m.file.dur))}</span></div>`;
      if (m.text) body += `<div class="chat-text">${richText(m)}</div>`;
    }
    const showWho = (g || !member) && side === 'them' && !grouped;
    const label = showWho ? `<small class="chat-who">${esc(nameOf(m.by))}</small>` : '';
    // read receipt: ✓✓ in a 1:1, "seen by n of N" (tap for the list) in a group
    let tick = '';
    if (mine && member && !m.archivedAt) {
      if (g) { const n = seenBy(openChat, at).length, total = othersOf(openChat).length; tick = at ? `<button class="chat-seen ${n === total && total ? 'all' : ''}" data-seen="${esc(m.id)}" title="${L('مين شاف الرسالة', 'Who saw this')}"><i class="fas ${n ? 'fa-check-double' : 'fa-check'}"></i> ${n}/${total}</button>` : '<i class="fas fa-clock"></i>'; }
      else { const seenAt = toMs((openChat.lastRead || {})[ek(otherOf(openChat))]) || 0; tick = `<i class="fas ${seenAt && at && at <= seenAt ? 'fa-check-double seen' : (at ? 'fa-check' : 'fa-clock')}"></i>`; }
    }
    const tools = canEditMessage(openChat, m) && at ? `<span class="chat-tools">${m.by === session.email && m.text && m.type === 'text' ? `<button data-edit="${esc(m.id)}" title="${L('تعديل', 'Edit')}"><i class="fas fa-pen"></i></button>` : ''}<button data-del="${esc(m.id)}" title="${L('حذف', 'Delete')}"><i class="fas fa-trash"></i></button></span>` : '';
    const tagged = !mine && !m.deleted && (m.mentions || []).includes(session.email);
    return `<div class="chat-row ${side} ${grouped ? 'grouped' : ''}" data-mid="${esc(m.id)}">${label}<div class="chat-bubble ${m.archivedAt ? 'archived' : ''} ${tagged ? 'mentioned' : ''}">${body}<span class="chat-meta num">${tools}${m.edited && !m.deleted ? `<span>${L('اتعدلت', 'edited')}</span>` : ''}${at ? esc(fmtTime(at)) : ''} ${tick}</span></div></div>`;
  }
  function drawMsgs() {
    const el = $('#msgs'); if (!el || !openChat) return;
    if (el.querySelector('audio')) { // don't rebuild under a playing voice note; refresh once it ends
      const a = el.querySelector('audio'); if (!a.paused && !a.ended) { a.onended = () => drawMsgs(); return; }
    }
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    const list = showArchive ? [...archived.map(m => ({ ...m, archivedAt: m.archivedAt || true })), ...msgs] : msgs;
    if (!list.length) { el.innerHTML = `<div class="chat-empty">${empty('fa-hand', L('قول أهلاً 👋', 'Say hello 👋'), openChat.archivedAt && !showArchive ? L('الرسائل القديمة اتأرشفت.', 'Older messages were archived.') : '')}</div>`; return; }
    let html = '', day = '', prev = null;
    if (showArchive && archived.length) html += `<div class="chat-day"><span>${L(`📦 ${archived.length} رسالة مؤرشفة`, `📦 ${archived.length} archived messages`)}</span></div>`;
    list.forEach((m, i) => {
      const at = toMs(m.at) || now();
      const d = ymd(at);
      if (d !== day) { day = d; prev = null; html += `<div class="chat-day"><span>${esc(d === ymd(now()) ? L('النهارده', 'Today') : fmtDate(d))}</span></div>`; }
      if (showArchive && i === archived.length && archived.length) html += `<div class="chat-day"><span>${L('الرسائل الحالية', 'Current messages')}</span></div>`;
      html += bubble(m, prev); prev = m;
    });
    el.innerHTML = html;
    if (stick || !el.dataset.init) { el.scrollTop = el.scrollHeight; el.dataset.init = '1'; }
  }

  /** Who saw one of my group messages, and who has not yet */
  function showSeen(m) {
    const at = toMs(m.at);
    const seen = seenBy(openChat, at), rest = othersOf(openChat).filter(e => !seen.includes(e));
    const row = (e, ok) => { const p = who(e); const t = toMs((openChat.lastRead || {})[ek(e)]); return `<div class="chat-member"><span class="avatar-wrap">${avatar(p, 'sm')}</span><span class="grow min0"><b class="truncate">${esc(p.name || e)}</b><small class="truncate">${ok && t ? `${L('آخر فتح للجروب', 'Last opened')} ${esc(ymd(t) === ymd(now()) ? fmtTime(t) : fmtDate(t) + ' ' + fmtTime(t))}` : L('لسه ما فتحش الجروب', 'Has not opened the group yet')}</small></span><i class="fas ${ok ? 'fa-check-double' : 'fa-clock'}" style="color:${ok ? 'var(--brand)' : 'var(--faint)'}"></i></div>`; };
    modal({
      title: L('مين شاف الرسالة', 'Seen by'), icon: 'fa-check-double', size: 'narrow',
      body: `<div class="label mb-8">${L('شافوها', 'Seen')} (${seen.length})</div><div class="chat-members">${seen.map(e => row(e, true)).join('') || `<p class="muted small">${L('لسه محدش', 'Nobody yet')}</p>`}</div>
        <div class="label mb-8 mt-16">${L('لسه', 'Not yet')} (${rest.length})</div><div class="chat-members">${rest.map(e => row(e, false)).join('') || `<p class="muted small">${L('الكل شافها 👌', 'Everyone has seen it 👌')}</p>`}</div>`,
      foot: `<button class="btn btn-primary" data-close>${L('تمام', 'OK')}</button>`
    });
  }

  $('#thread').addEventListener('click', async (e) => {
    const find = (id) => [...msgs, ...archived].find(x => x.id === id);
    const tr = e.target.closest('[data-task]');
    if (tr) {
      const t = taskById(tr.dataset.task);
      if (t) location.hash = taskLink(t.id);
      else toast(tr.title || L('تاسك', 'Task'), L('التاسك ده مش مسند ليك — بتشوف عنوانه بس.', 'This task is not assigned to you — you only see its title.'), 'info');
      return;
    }
    const seen = e.target.closest('[data-seen]'); if (seen) { const m = find(seen.dataset.seen); if (m) showSeen(m); return; }
    const ed = e.target.closest('[data-edit]');
    if (ed) {
      const m = find(ed.dataset.edit); if (!m) return;
      const dlg = modal({ title: L('تعديل الرسالة', 'Edit message'), icon: 'fa-pen', size: 'narrow', body: `<textarea class="textarea" id="et" maxlength="4000" style="min-height:120px">${esc(m.text)}</textarea>`, foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="es">${L('حفظ', 'Save')}</button>` });
      dlg.$('#es').onclick = (ev) => busy(ev.currentTarget, async () => { try { await editMessage(openChat, m, dlg.$('#et').value); dlg.close(); } catch (ex) { toastErr(ex); } });
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      const m = find(del.dataset.del); if (!m) return;
      const ok = await confirmDialog({ title: L('حذف الرسالة', 'Delete message'), message: L('الرسالة هتتمسح عند كل الأعضاء ويظهر مكانها «الرسالة دي اتمسحت».', 'The message is removed for everyone and replaced by "This message was deleted".'), okText: L('حذف', 'Delete'), okClass: 'btn-danger' });
      if (ok) { try { await deleteMessage(openChat, m); } catch (ex) { toastErr(ex); } }
      return;
    }
    const pl = e.target.closest('[data-play]');
    if (pl) {
      const m = [...msgs, ...archived].find(x => x.file && x.file.id === pl.dataset.play); if (!m) return;
      const box = pl.closest('.chat-voice'); pl.classList.add('loading');
      try {
        const url = await loadFile(m.file);
        $('#msgs').querySelectorAll('audio').forEach(a => a.pause());
        box.innerHTML = `<audio controls autoplay src="${url}" style="max-width:240px;height:36px"></audio>`;
      } catch (ex) { toastErr(ex); pl.classList.remove('loading'); }
      return;
    }
    const b = e.target.closest('[data-file]'); if (!b) return;
    const m = [...msgs, ...archived].find(x => x.file && x.file.id === b.dataset.file); if (!m) return;
    b.classList.add('loading');
    try {
      const url = await loadFile(m.file);
      if (m.type === 'image') {
        modal({ title: m.file.name, icon: 'fa-image', size: 'wide', body: `<div style="text-align:center"><img src="${url}" alt="" style="max-width:100%;max-height:70vh;border-radius:12px"></div>`, foot: `<a class="btn btn-primary" href="${url}" download="${esc(m.file.name)}"><i class="fas fa-download"></i> ${L('تحميل', 'Download')}</a>` });
      } else { const a = document.createElement('a'); a.href = url; a.download = m.file.name; document.body.appendChild(a); a.click(); a.remove(); }
    } catch (ex) { toastErr(ex); } finally { b.classList.remove('loading'); }
  });

  // ---------- voice notes ----------
  function stopRecording(discard) {
    if (!recorder) return;
    const r = recorder; recorder = null;
    clearInterval(r.timer);
    r.discard = !!discard;
    try { if (r.mr.state !== 'inactive') r.mr.stop(); } catch {}
    r.stream.getTracks().forEach(t => t.stop());
    const rec = $('#rec'), row = $('#compose-row');
    if (rec) rec.classList.add('hidden'); if (row) row.classList.remove('hidden');
  }
  async function startRecording() {
    if (recorder) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast(L('المتصفح ده مش بيدعم التسجيل', 'This browser cannot record audio'), '', 'bad'); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { toast(L('اسمح للموقع يستخدم المايك', 'Allow microphone access'), L('من علامة القفل جنب عنوان الموقع.', 'Use the lock icon next to the address bar.'), 'bad'); return; }
    const chat = openChat;
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    const mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 24000 });
    const parts = []; const t0 = Date.now();
    const r = recorder = { mr, stream, discard: false, timer: 0 };
    mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) parts.push(ev.data); };
    mr.onstop = async () => {
      if (r.discard) return;
      const blob = new Blob(parts, { type: mr.mimeType || mime || 'audio/webm' });
      const secs = (Date.now() - t0) / 1000;
      if (secs < 1 || !blob.size) return;
      const up = $('#up'), bar = up && up.querySelector('span'), label = $('#up-t');
      if (up) { up.classList.remove('hidden'); bar.style.width = '5%'; label.textContent = L('بيرفع الرسالة الصوتية…', 'Uploading voice note…'); }
      try { await sendVoice(chat, blob, secs, (p) => { if (bar) bar.style.width = Math.round(p * 100) + '%'; }); play('send'); }
      catch (ex) { toastErr(ex); }
      if (up) up.classList.add('hidden');
    };
    mr.start(1000);
    $('#compose-row').classList.add('hidden'); $('#rec').classList.remove('hidden');
    r.timer = setInterval(() => {
      const s = (Date.now() - t0) / 1000;
      const el = $('#rec-t'); if (el) el.textContent = fmtLen(s);
      // ~24 kbps ≈ 180 KB a minute; stop before the 5 MB storage limit (about 25 minutes)
      if (parts.reduce((t, b) => t + b.size, 0) > MAX_FILE * 0.92) { toast(L('وصلت للحد الأقصى للتسجيل، اتبعتت الرسالة', 'Maximum length reached — the note was sent'), '', 'info'); stopRecording(false); }
    }, 500);
  }

  function wireComposer() {
    const f = $('#compose'), ta = $('#text'), fi = $('#file');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; };
    ta.oninput = grow;
    ta.onkeydown = (e) => {
      if (suggest.open && suggest.key(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); f.requestSubmit(); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const t = ta.value; if (!t.trim()) return;
      const tags = collectTags(t);
      ta.value = ''; grow(); picked.people.clear(); picked.tasks.clear();
      play('send');
      try { await sendText(openChat, t, tags); } catch (ex) { ta.value = t; toastErr(ex); }
    };
    wireMentions(ta, grow);
    const upload = async (files) => {
      const up = $('#up'), bar = up.querySelector('span'), label = $('#up-t');
      for (const file of files) {
        if (file.size > MAX_FILE && !/^image\//.test(file.type)) { toast(L('الملف كبير', 'File too large'), L(`${file.name} أكبر من 5 ميجا.`, `${file.name} is larger than 5 MB.`), 'bad'); continue; }
        up.classList.remove('hidden'); bar.style.width = '5%'; label.textContent = file.name;
        try { await sendFile(openChat, file, '', (p) => { bar.style.width = Math.round(p * 100) + '%'; }); play('send'); }
        catch (ex) { toastErr(ex); }
      }
      up.classList.add('hidden');
    };
    fi.onchange = () => { const files = [...fi.files]; fi.value = ''; upload(files); };
    ta.addEventListener('paste', (e) => { const files = [...(e.clipboardData && e.clipboardData.files || [])]; if (files.length) { e.preventDefault(); upload(files); } });
    const th = $('#thread');
    th.ondragover = (e) => { e.preventDefault(); th.classList.add('drop'); };
    th.ondragleave = () => th.classList.remove('drop');
    th.ondrop = (e) => { e.preventDefault(); th.classList.remove('drop'); const files = [...(e.dataTransfer && e.dataTransfer.files || [])]; if (files.length) upload(files); };
    $('#mic').onclick = startRecording;
    $('#rec-x').onclick = () => stopRecording(true);
    $('#rec-ok').onclick = () => stopRecording(false);
    ta.focus();
  }

  // ---------- mentions: "@" members, "#" my tasks ----------
  const picked = { people: new Set(), tasks: new Map() };
  const suggest = { open: false, items: [], idx: 0, key: () => false };
  /** what to attach to the message: the people / tasks picked from the list that are still in the text (+ any "#12" typed by hand) */
  function collectTags(text) {
    if (!openChat || !isGroup(openChat)) return {};
    const mentions = [...picked.people].filter(e => text.includes('@' + nameOf(e)));
    const tasks = new Map([...picked.tasks].filter(([, t]) => new RegExp(`#${t.num}(?![0-9])`).test(text)));
    const mine = allTasks();
    (text.match(/#[0-9]+/g) || []).forEach(h => { const t = mine.find(x => `#${x.num}` === h); if (t) tasks.set(t.id, t); });
    return { mentions, tasks: [...tasks.values()].map(t => ({ id: t.id, num: t.num, title: t.title })) };
  }
  function wireMentions(ta, grow) {
    if (!isGroup(openChat)) return;
    const box = document.createElement('div'); box.className = 'chat-suggest hidden'; box.id = 'suggest';
    $('#compose').prepend(box);
    let token = null; // { kind: '@' | '#', start, q }
    const close = () => { suggest.open = false; box.classList.add('hidden'); token = null; };
    const pick = (i) => {
      const it = suggest.items[i]; if (!it || !token) return;
      const insert = it.kind === '@' ? `@${it.name} ` : `#${it.num} `;
      const before = ta.value.slice(0, token.start), after = ta.value.slice(ta.selectionStart);
      ta.value = before + insert + after;
      const pos = (before + insert).length; ta.setSelectionRange(pos, pos);
      if (it.kind === '@') picked.people.add(it.email); else picked.tasks.set(it.id, it.task);
      close(); grow(); ta.focus();
    };
    const draw = () => {
      box.innerHTML = suggest.items.map((it, i) => it.kind === '@'
        ? `<button type="button" data-i="${i}" class="${i === suggest.idx ? 'on' : ''}">${avatar(it.p, 'sm')}<span class="min0"><b class="truncate">${esc(it.name)}</b><small class="truncate">${esc(it.p.title || '')}</small></span></button>`
        : `<button type="button" data-i="${i}" class="${i === suggest.idx ? 'on' : ''}"><span class="sg-num">#${it.num}</span><span class="min0"><b class="truncate">${esc(it.task.title)}</b><small>${esc(it.status)}</small></span></button>`).join('');
      box.classList.toggle('hidden', !suggest.items.length); suggest.open = !!suggest.items.length;
    };
    const update = () => {
      const upto = ta.value.slice(0, ta.selectionStart);
      const mm = upto.match(/(^|\s)([@#])([^\s@#]{0,30})$/);
      if (!mm) { close(); return; }
      token = { kind: mm[2], start: upto.length - mm[3].length - 1, q: mm[3].toLowerCase() };
      if (token.kind === '@') {
        suggest.items = othersOf(openChat).map(e => ({ kind: '@', email: e, p: who(e), name: nameOf(e) }))
          .filter(x => !token.q || x.name.toLowerCase().includes(token.q) || x.email.includes(token.q)).sort((a, b) => a.name.localeCompare(b.name, 'ar')).slice(0, 8);
      } else {
        const STATUS = { new: 'New', in_progress: 'In progress', review: 'Review', hold: 'On hold', done: 'Finished' };
        suggest.items = allTasks().filter(t => t.status !== 'done').slice().sort((a, b) => b.num - a.num)
          .filter(t => !token.q || String(t.num).startsWith(token.q) || t.title.toLowerCase().includes(token.q))
          .slice(0, 8).map(t => ({ kind: '#', id: t.id, num: t.num, task: t, status: `${STATUS[t.status] || ''}${t.assignee !== session.email ? ' · ' + nameOf(t.assignee) : ''}` }));
      }
      suggest.idx = 0; draw();
    };
    suggest.key = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = suggest.items.length; suggest.idx = (suggest.idx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; draw(); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(suggest.idx); return true; }
      if (e.key === 'Escape') { e.preventDefault(); close(); return true; }
      return false;
    };
    ta.addEventListener('input', update);
    ta.addEventListener('click', update);
    ta.addEventListener('blur', () => setTimeout(close, 150));
    box.addEventListener('mousedown', (e) => { e.preventDefault(); const b = e.target.closest('[data-i]'); if (b) pick(Number(b.dataset.i)); });
  }
  /** scroll the chat to a message and flash it */
  function jumpTo(id) {
    const row = $('#msgs') && $('#msgs').querySelector(`[data-mid="${CSS.escape(id)}"]`);
    if (!row) { toast(L('الرسالة دي قديمة ومش ظاهرة في الشات', 'That message is no longer shown'), '', 'info'); return; }
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
  }

  // ---------- live data ----------
  unChats = watchMyChats(rows => {
    chats = rows; drawList();
    if (openId) {
      const c = rows.find(x => x.id === openId);
      if (c && openChat && openChat.id === c.id) { openChat = c; drawHead(); if (!document.hidden) markRead(c); drawMsgs(); }
      else if (c && !openChat) openThread(openId);
      else if (!c && openChat && mode !== 'all' && openChat.members.includes(session.email)) { openChat = null; location.hash = '#/chat'; } // removed from the group
    }
  });
  const offDir = onDirectory(() => { drawList(); });
  const onVis = () => { if (!document.hidden && openChat) markRead(openChat); };
  document.addEventListener('visibilitychange', onVis);
  if (openId) {
    if (admin) { const c = await read('chats', openId).catch(() => null); if (c && !c.members.includes(session.email)) { mode = 'all'; modes && modes.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.m === 'all')); unAll = watchAllChats(rows => { allChats = rows; if (mode === 'all') drawList(); const cur = rows.find(x => x.id === openId); if (cur && openChat && openChat.id === cur.id) { openChat = cur; drawHead(); drawMsgs(); } }); } }
    openThread(openId);
  } else emptyThread();

  return () => {
    stopRecording(true);
    unChats && unChats(); unAll && unAll(); unMsgs && unMsgs(); offDir && offDir();
    document.removeEventListener('click', closePicker); document.removeEventListener('visibilitychange', onVis);
    window.__amOpenChat = '';
  };
}
