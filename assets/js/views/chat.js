// Chat: 1:1 conversations with text, images and files. Admins can open any conversation and archive it.
import { L, esc, fmtTime, fmtDate, ymd, relTime, debounce } from '../core/utils.js';
import { toast, toastErr, avatar, empty, loader, confirmDialog, modal, STATUS_META } from '../core/ui.js';
import { session, now, isAdmin } from '../core/session.js';
import { read, toMs } from '../core/fb.js';
import { activePeople, person, nameOf, onDirectory } from '../services/directory.js';
import { play } from '../core/sounds.js';
import { ensureChat, watchMyChats, watchAllChats, watchMessages, sendText, sendFile, loadFile, markRead, archiveChat, listArchive, otherOf, unreadOf, ek, MAX_FILE } from '../services/chat.js';

const fmtSize = (n) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const fileIcon = (mime = '', name = '') => /pdf/.test(mime) ? 'fa-file-pdf' : /sheet|excel|csv/.test(mime + name) ? 'fa-file-excel' : /word|document/.test(mime) ? 'fa-file-word' : /zip|rar|7z/.test(mime + name) ? 'fa-file-zipper' : /image/.test(mime) ? 'fa-file-image' : /video/.test(mime) ? 'fa-file-video' : /audio/.test(mime) ? 'fa-file-audio' : 'fa-file-lines';
const presence = (p) => {
  if (!p) return '';
  const on = p.dayKey && p.status && p.status !== 'Offline';
  if (on) { const m = STATUS_META[p.status]; return `<span class="chat-presence on" style="--c:${m.color}">${esc(L(m.ar, m.en))}</span>`; }
  return `<span class="chat-presence">${p.lastChange ? L(`آخر نشاط ${relTime(toMs(p.lastChange))}`, `Last active ${relTime(toMs(p.lastChange))}`) : L('غير متصل', 'Offline')}</span>`;
};
const dotFor = (p) => { const on = p && p.dayKey && p.status && p.status !== 'Offline'; return `<span class="status-dot" style="background:${on ? STATUS_META[p.status].color : 'var(--neutral)'}"></span>`; };

export default async function render(root, { params }) {
  let openId = params && params[0] ? decodeURIComponent(params[0]) : '';
  let mode = 'mine', chats = [], allChats = [], term = '', openChat = null, msgs = [], showArchive = false, archived = [];
  let unChats = null, unAll = null, unMsgs = null;
  const admin = isAdmin();

  root.innerHTML = `
    <div class="chat-app ${openId ? 'has-open' : ''}" id="app">
      <aside class="card chat-side">
        <div class="chat-side-head">
          <h2>${L('الشات', 'Chat')}</h2>
          <div class="chat-new-wrap">
            <button class="btn btn-primary btn-sm" id="new"><i class="fas fa-pen-to-square"></i> ${L('محادثة جديدة', 'New chat')}</button>
            <div class="chat-picker hidden" id="picker">
              <div class="search"><i class="fas fa-search"></i><input class="input" id="pq" placeholder="${L('ابحث عن موظف', 'Find a colleague')}"></div>
              <div class="chat-picker-list" id="plist"></div>
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

  // ---------- conversation list ----------
  function convTitle(c) {
    if (c.members.includes(session.email)) { const o = person(otherOf(c)); return o ? (o.name || o.email) : nameOf(otherOf(c)); }
    return c.members.map(nameOf).join(' ↔ ');
  }
  function drawList() {
    const src = mode === 'all' ? allChats : chats;
    const rows = src.filter(c => !term || convTitle(c).toLowerCase().includes(term) || (c.members || []).some(m => m.includes(term)));
    const el = $('#convs');
    if (!rows.length) {
      el.innerHTML = empty('fa-comments', mode === 'all' ? L('مفيش محادثات لسه', 'No conversations yet') : L('ابدأ محادثة', 'Start a conversation'), mode === 'all' ? '' : L('اضغط «محادثة جديدة» واختار زميل.', 'Click "New chat" and pick a colleague.'));
      return;
    }
    el.innerHTML = rows.map(c => {
      const mine = c.members.includes(session.email);
      const o = mine ? person(otherOf(c)) : null;
      const lm = c.lastMessage;
      const n = mine ? unreadOf(c) : 0;
      const pic = mine ? `<span class="avatar-wrap">${avatar(o || { email: otherOf(c), name: nameOf(otherOf(c)) }, '')}${dotFor(o)}</span>`
        : `<span class="chat-duo">${c.members.map(m => avatar(person(m) || { email: m, name: nameOf(m) }, 'sm')).join('')}</span>`;
      const prev = lm ? `${lm.by === session.email ? L('أنت: ', 'You: ') : (!mine ? nameOf(lm.by).split(' ')[0] + ': ' : '')}${lm.text || ''}` : (c.archivedAt ? L('📦 اتأرشفت', '📦 Archived') : L('لسه مفيش رسائل', 'No messages yet'));
      return `<a class="chat-conv ${c.id === openId ? 'on' : ''} ${n ? 'unread' : ''}" href="#/chat/${encodeURIComponent(c.id)}">
        ${pic}
        <span class="grow min0"><span class="row between gap-8"><b class="truncate">${esc(convTitle(c))}</b><small class="faint num">${lm && lm.at ? esc(ymd(toMs(lm.at)) === ymd(now()) ? fmtTime(toMs(lm.at)) : fmtDate(toMs(lm.at))) : ''}</small></span>
        <span class="row between gap-8"><small class="truncate">${esc(prev)}</small>${n ? `<span class="badge-count">${n > 99 ? '99+' : n}</span>` : ''}</span></span></a>`;
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
    $('#thread').innerHTML = `<div class="chat-empty">${empty('fa-comments', L('اختار محادثة', 'Pick a conversation'), L('أو ابدأ واحدة جديدة مع أي زميل.', 'Or start a new one with any colleague.'))}</div>`;
  }
  async function openThread(id) {
    if (unMsgs) { unMsgs(); unMsgs = null; }
    openId = id; window.__amOpenChat = id; showArchive = false; archived = [];
    $('#app').classList.toggle('has-open', !!id);
    if (!id) { openChat = null; emptyThread(); drawList(); return; }
    openChat = [...chats, ...allChats].find(c => c.id === id) || await read('chats', id).catch(() => null);
    if (!openChat) { $('#thread').innerHTML = `<div class="chat-empty">${empty('fa-lock', L('المحادثة مش متاحة', 'Conversation not available'))}</div>`; return; }
    drawList();
    const member = openChat.members.includes(session.email);
    const o = member ? person(otherOf(openChat)) : null;
    const head = member
      ? `<span class="avatar-wrap">${avatar(o || { email: otherOf(openChat), name: nameOf(otherOf(openChat)) })}${dotFor(o)}</span><div class="grow min0"><b class="truncate">${esc(convTitle(openChat))}</b><div class="small">${o ? presence(o) : ''}${o && o.title ? ` · <span class="muted">${esc(o.title)}</span>` : ''}</div></div>`
      : `<span class="chat-duo">${openChat.members.map(m => avatar(person(m) || { email: m, name: nameOf(m) }, 'sm')).join('')}</span><div class="grow min0"><b class="truncate">${esc(convTitle(openChat))}</b><div class="small muted"><i class="fas fa-eye"></i> ${L('بتشوفها كأدمن — مش بتظهر للطرفين', 'Viewing as admin — they are not notified')}</div></div>`;
    $('#thread').innerHTML = `
      <header class="chat-head">
        <a class="btn btn-ghost btn-icon chat-back" href="#/chat" aria-label="${L('رجوع', 'Back')}"><i class="fas fa-arrow-right" data-flip></i></a>
        ${head}
        ${admin ? `<div class="row gap-4"><button class="btn btn-sm btn-ghost" id="arch-view" title="${L('الرسائل المؤرشفة', 'Archived messages')}"><i class="fas fa-box-archive"></i><span class="hide-sm"> ${L('الأرشيف', 'Archive')}</span></button><button class="btn btn-sm btn-ghost" id="arch" title="${L('أرشفة المحادثة', 'Archive conversation')}" style="color:var(--bad)"><i class="fas fa-folder-minus"></i><span class="hide-sm"> ${L('أرشفة', 'Archive now')}</span></button></div>` : ''}
      </header>
      <div class="chat-msgs" id="msgs">${loader()}</div>
      ${member ? `<form class="chat-compose" id="compose">
        <div class="chat-upload hidden" id="up"><div class="progress"><span style="width:0%"></span></div><small id="up-t"></small></div>
        <div class="row gap-8" style="align-items:flex-end">
          <label class="btn btn-ghost btn-icon" title="${L('إرفاق صورة أو ملف', 'Attach an image or file')}"><i class="fas fa-paperclip"></i><input type="file" id="file" multiple hidden></label>
          <textarea class="input chat-input" id="text" rows="1" placeholder="${L('اكتب رسالة…', 'Write a message…')}"></textarea>
          <button class="btn btn-primary btn-icon" type="submit" aria-label="${L('إرسال', 'Send')}"><i class="fas fa-paper-plane" data-flip></i></button>
        </div></form>` : ''}`;
    let known = null;
    unMsgs = watchMessages(id, rows => {
      // a new message from the other person while the conversation is open → soft "receive" sound
      if (known && rows.some(m => !known.has(m.id) && m.by !== session.email)) play('receive');
      known = new Set(rows.map(m => m.id));
      msgs = rows; drawMsgs();
      if (member && !document.hidden) markRead(openChat);
    });
    if (member) wireComposer();
    if (admin) {
      $('#arch').onclick = async () => {
        const ok = await confirmDialog({ title: L('أرشفة المحادثة', 'Archive conversation'), message: L('كل الرسائل الحالية هتتنقل للأرشيف ومش هتظهر للطرفين تاني. الأدمن بس يقدر يشوفها من «الأرشيف». تكمّل؟', 'All current messages move to the archive and disappear for both people. Only admins can see them under "Archive". Continue?'), okText: L('أرشفة', 'Archive'), okClass: 'btn-danger' });
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

  function bubble(m, prev, seenAt) {
    const mine = m.by === session.email;
    const member = openChat.members.includes(session.email);
    const side = member ? (mine ? 'me' : 'them') : (m.by === openChat.members[0] ? 'them' : 'me');
    const grouped = prev && prev.by === m.by && (toMs(m.at) || 0) - (toMs(prev.at) || 0) < 5 * 60000;
    const at = toMs(m.at);
    let body = '';
    if (m.type === 'image' && m.file) body += `<button class="chat-img" data-file="${esc(m.file.id)}" title="${esc(m.file.name)}"><img src="${esc(m.file.thumb || '')}" alt="${esc(m.file.name)}" loading="lazy"></button>`;
    if (m.type === 'file' && m.file) body += `<button class="chat-file" data-file="${esc(m.file.id)}"><i class="fas ${fileIcon(m.file.mime, m.file.name)}"></i><span class="min0 grow"><b class="truncate">${esc(m.file.name)}</b><small>${esc(fmtSize(m.file.size || 0))}</small></span><i class="fas fa-download"></i></button>`;
    if (m.text) body += `<div class="chat-text">${esc(m.text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')}</div>`;
    const who = !member && !grouped ? `<small class="chat-who">${esc(nameOf(m.by))}</small>` : '';
    const tick = side === 'me' && member ? `<i class="fas ${seenAt && at && at <= seenAt ? 'fa-check-double seen' : (at ? 'fa-check' : 'fa-clock')}"></i>` : '';
    return `<div class="chat-row ${side} ${grouped ? 'grouped' : ''}">${who}<div class="chat-bubble ${m.archivedAt ? 'archived' : ''}">${body}<span class="chat-meta num">${at ? esc(fmtTime(at)) : ''} ${tick}</span></div></div>`;
  }
  function drawMsgs() {
    const el = $('#msgs'); if (!el || !openChat) return;
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    const list = showArchive ? [...archived.map(m => ({ ...m, archivedAt: m.archivedAt || true })), ...msgs] : msgs;
    const other = otherOf(openChat);
    const seenAt = openChat.lastRead ? toMs(openChat.lastRead[ek(other)]) : 0;
    if (!list.length) { el.innerHTML = `<div class="chat-empty">${empty('fa-hand', L('قول أهلاً 👋', 'Say hello 👋'), openChat.archivedAt && !showArchive ? L('الرسائل القديمة اتأرشفت.', 'Older messages were archived.') : '')}</div>`; return; }
    let html = '', day = '', prev = null;
    if (showArchive && archived.length) html += `<div class="chat-day"><span>${L(`📦 ${archived.length} رسالة مؤرشفة`, `📦 ${archived.length} archived messages`)}</span></div>`;
    list.forEach((m, i) => {
      const at = toMs(m.at) || now();
      const d = ymd(at);
      if (d !== day) { day = d; prev = null; html += `<div class="chat-day"><span>${esc(d === ymd(now()) ? L('النهارده', 'Today') : fmtDate(d))}</span></div>`; }
      if (showArchive && i === archived.length && archived.length) html += `<div class="chat-day"><span>${L('الرسائل الحالية', 'Current messages')}</span></div>`;
      html += bubble(m, prev, seenAt); prev = m;
    });
    el.innerHTML = html;
    if (stick || !el.dataset.init) { el.scrollTop = el.scrollHeight; el.dataset.init = '1'; }
  }
  $('#thread').addEventListener('click', async (e) => {
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

  function wireComposer() {
    const f = $('#compose'), ta = $('#text'), fi = $('#file');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; };
    ta.oninput = grow;
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); f.requestSubmit(); } };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const t = ta.value; if (!t.trim()) return;
      ta.value = ''; grow();
      play('send');
      try { await sendText(openChat, t); } catch (ex) { ta.value = t; toastErr(ex); }
    };
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
    ta.focus();
  }

  // ---------- live data ----------
  unChats = watchMyChats(rows => {
    chats = rows; drawList();
    if (openId) {
      const c = rows.find(x => x.id === openId);
      if (c && openChat && openChat.id === c.id) { openChat = c; if (!document.hidden) markRead(c); drawMsgs(); }
      else if (c && !openChat) openThread(openId);
    }
  });
  const offDir = onDirectory(() => { drawList(); });
  const onVis = () => { if (!document.hidden && openChat) markRead(openChat); };
  document.addEventListener('visibilitychange', onVis);
  if (openId) {
    if (admin) { const c = await read('chats', openId).catch(() => null); if (c && !c.members.includes(session.email)) { mode = 'all'; modes && modes.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.m === 'all')); unAll = watchAllChats(rows => { allChats = rows; if (mode === 'all') drawList(); }); } }
    openThread(openId);
  } else emptyThread();

  return () => {
    unChats && unChats(); unAll && unAll(); unMsgs && unMsgs(); offDir && offDir();
    document.removeEventListener('click', closePicker); document.removeEventListener('visibilitychange', onVis);
    window.__amOpenChat = '';
  };
}
