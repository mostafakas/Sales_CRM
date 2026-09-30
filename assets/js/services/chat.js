// Chat: 1:1 conversations and admin-made groups — text, links, images, files and voice notes (stored in Firestore
// chunks), read receipts, per-chat mute, optional edit/delete, and the admin archive.
import { db, doc, col, read, list, watch, query, where, orderBy, limit, writeBatch, setDoc, updateDoc, serverTimestamp, increment, toMs, settle, deleteField } from '../core/fb.js';
import { session, isAdmin } from '../core/session.js';
import { userError } from '../core/ui.js';
import { imageToDataUrl, L } from '../core/utils.js';
import { track } from './activity.js';

export const MAX_FILE = 5 * 1024 * 1024;           // 5 MB per file / voice note
const CHUNK = 700000;                              // base64 characters per Firestore doc (< 1 MB)
export const ek = (email) => String(email || '').toLowerCase().replace(/[^a-z0-9]/g, '_'); // safe map key
export const chatIdFor = (a, b) => [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('__');
export const otherOf = (chat, me = session.email) => (chat.members || []).find(m => m !== me) || me;
export const othersOf = (chat, me = session.email) => (chat.members || []).filter(m => m !== me);
export const unreadOf = (chat, me = session.email) => Number((chat.unread || {})[ek(me)] || 0);

// ---------- groups ----------
export const isGroup = (chat) => !!chat && chat.type === 'group';
export const isGroupAdmin = (chat, me = session.email) => isGroup(chat) && (chat.admins || []).includes(me);
/** who may rename the group and add / remove members: the system admin and the group's admins */
export const canManageGroup = (chat) => isGroup(chat) && (isAdmin() || isGroupAdmin(chat));
export const isMuted = (chat, me = session.email) => !!((chat && chat.muted) || {})[ek(me)];
/** members (other than the sender) whose last visit is after the message */
export const seenBy = (chat, atMs, by = session.email) => othersOf(chat, by).filter(m => atMs && (toMs((chat.lastRead || {})[ek(m)]) || 0) >= atMs);
/** sender may edit / delete only when the admin switched it on for this group (admins always may delete) */
export const canEditMessage = (chat, m) => !!m && !m.deleted && !m.archivedAt && ((m.by === session.email && isGroup(chat) && !!chat.allowEdit && (chat.members || []).includes(session.email)) || isAdmin());
const uniq = (arr) => [...new Set((arr || []).map(x => String(x).toLowerCase()).filter(Boolean))];

/** System admin: create a group with the chosen people; `admins` are the group admins (the creator is always one) */
export async function createGroup({ name, members, admins = [], photo = '' }) {
  if (!isAdmin()) throw userError('إنشاء الجروبات للأدمن بس.', 'Only admins can create groups.');
  const n = String(name || '').trim().slice(0, 80);
  if (!n) throw userError('اكتب اسم الجروب.', 'Enter a group name.');
  const all = uniq([session.email, ...members]).sort();
  if (all.length < 2) throw userError('اختار عضو واحد على الأقل.', 'Pick at least one member.');
  const ref = doc(col('chats'));
  await setDoc(ref, {
    type: 'group', name: n, photo, members: all, admins: uniq([session.email, ...admins]).filter(a => all.includes(a)),
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: session.email, lastMessage: null,
    unread: Object.fromEntries(all.map(m => [ek(m), 0])), lastRead: {}, muted: {}, allowEdit: false
  });
  track('chat.group_create', { target: n, detail: `${all.length}` });
  return ref.id;
}
/** Rename / photo / members (group admins), plus admins and the edit switch (system admin only) */
export async function updateGroup(chat, { name, photo, members, admins, allowEdit }) {
  if (!canManageGroup(chat)) throw userError('مش مسموح لك تعدّل الجروب ده.', 'You cannot change this group.');
  const upd = {};
  if (name !== undefined) { const n = String(name).trim().slice(0, 80); if (!n) throw userError('اكتب اسم الجروب.', 'Enter a group name.'); upd.name = n; }
  if (photo !== undefined) upd.photo = photo;
  let adm = chat.admins || [];
  if (admins !== undefined && isAdmin()) { adm = uniq(admins); upd.admins = adm; }
  if (members !== undefined) {
    const all = uniq([...members, ...adm]).sort(); // an admin of the group is always a member
    if (all.length < 2) throw userError('الجروب لازم يبقى فيه عضوين على الأقل.', 'A group needs at least two members.');
    upd.members = all;
    all.filter(m => !(chat.members || []).includes(m)).forEach(m => { upd[`unread.${ek(m)}`] = 0; });
  }
  if (allowEdit !== undefined && isAdmin()) upd.allowEdit = !!allowEdit;
  if (!Object.keys(upd).length) return;
  await updateDoc(doc(db, 'chats', chat.id), upd);
  track('chat.group_update', { target: chat.name || '', detail: Object.keys(upd).filter(k => !k.startsWith('unread.')).join(', ') });
}
/** My notification setting for one chat: muted = no popup and no sound (the unread counter still counts) */
export const setMuted = (chat, on) => updateDoc(doc(db, 'chats', chat.id), { [`muted.${ek(session.email)}`]: !!on });

/** Open (or create) the 1:1 conversation with someone */
export async function ensureChat(other) {
  const me = session.email, o = String(other).toLowerCase();
  if (!o || o === me) throw userError('اختار شخص تاني.', 'Pick someone else.');
  const id = chatIdFor(me, o);
  const cur = await read('chats', id).catch(() => null);
  if (!cur) {
    const members = [me, o].sort();
    await setDoc(doc(db, 'chats', id), { members, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: me, lastMessage: null, unread: { [ek(members[0])]: 0, [ek(members[1])]: 0 }, lastRead: {} });
  }
  return id;
}

export const watchMyChats = (cb) => watch(query(col('chats'), where('members', 'array-contains', session.email)), rows => cb(sortChats(rows)));
export const watchAllChats = (cb) => watch(col('chats'), rows => cb(sortChats(rows)));
const sortChats = (rows) => rows.sort((a, b) => (toMs(b.updatedAt) || 0) - (toMs(a.updatedAt) || 0));
export const watchMessages = (chatId, cb, n = 200) =>
  watch(query(col(`chats/${chatId}/messages`), orderBy('at', 'desc'), limit(n)), rows => cb(rows.slice().reverse()));
export const listArchive = (chatId) => list(query(col(`chat_archive/${chatId}/messages`), orderBy('at', 'asc'), limit(2000)));

async function post(chat, msg, preview) {
  const b = writeBatch(db);
  const m = doc(col(`chats/${chat.id}/messages`));
  b.set(m, { by: session.email, type: 'text', text: '', ...msg, at: serverTimestamp() });
  const upd = {
    lastMessage: { by: session.email, text: preview.slice(0, 140), type: msg.type || 'text', at: serverTimestamp() },
    updatedAt: serverTimestamp(), [`unread.${ek(session.email)}`]: 0
  };
  othersOf(chat).forEach(o => { upd[`unread.${ek(o)}`] = increment(1); }); // one counter per member
  b.update(doc(db, 'chats', chat.id), upd);
  await settle(b.commit(), 6000);
  return m.id;
}
export function sendText(chat, text) {
  const t = String(text || '').trim();
  if (!t) return Promise.resolve();
  if (t.length > 4000) throw userError('الرسالة طويلة جداً.', 'The message is too long.');
  return post(chat, { type: 'text', text: t }, t);
}

const readAsDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });

/** Store a data URL in chat_files (chunked) and return its meta */
async function storeFile(chat, dataUrl, name, mime, onProgress) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const size = Math.round(b64.length * 0.75);
  if (size > MAX_FILE) throw userError('الملف أكبر من 5 ميجا.', 'The file is larger than 5 MB.');
  const chunks = Math.ceil(b64.length / CHUNK) || 1;
  const fref = doc(col('chat_files'));
  const safe = String(name || 'file').slice(0, 180);
  await setDoc(fref, { chatId: chat.id, by: session.email, name: safe, mime, size, chunks, at: serverTimestamp() });
  for (let i = 0; i < chunks; i++) {
    await setDoc(doc(db, `chat_files/${fref.id}/chunks`, String(i)), { i, data: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
    onProgress && onProgress((i + 1) / chunks);
  }
  return { id: fref.id, name: safe, mime, size };
}

/** Upload a file (images are compressed first) and post it. onProgress(0..1) */
export async function sendFile(chat, file, caption = '', onProgress) {
  if (!file) return;
  const isImg = /^image\/(png|jpe?g|webp|gif|bmp)$/i.test(file.type) && file.type !== 'image/gif';
  let dataUrl, mime = file.type || 'application/octet-stream', thumb = '';
  if (isImg) {
    dataUrl = await imageToDataUrl(file, 1600, 0.82);
    thumb = await imageToDataUrl(file, 360, 0.7);
    mime = (dataUrl.match(/^data:([^;]+);/) || [])[1] || 'image/jpeg';
  } else {
    if (file.size > MAX_FILE) throw userError('الملف أكبر من 5 ميجا.', 'The file is larger than 5 MB.');
    dataUrl = await readAsDataUrl(file);
  }
  const meta = { ...(await storeFile(chat, dataUrl, file.name, mime, onProgress)), ...(thumb ? { thumb } : {}) };
  const text = String(caption || '').trim().slice(0, 4000);
  return post(chat, { type: isImg ? 'image' : 'file', text, file: meta }, text || (isImg ? '📷 صورة' : `📎 ${meta.name}`));
}

/** Post a recorded voice note. `seconds` = its length. */
export async function sendVoice(chat, blob, seconds, onProgress) {
  if (!blob || !blob.size) return;
  if (blob.size > MAX_FILE) throw userError('التسجيل أكبر من 5 ميجا. سجّل رسالة أقصر.', 'The recording is larger than 5 MB. Record a shorter one.');
  const mime = (blob.type || 'audio/webm').split(';')[0];
  const meta = { ...(await storeFile(chat, await readAsDataUrl(blob), `voice.${mime.includes('mp4') ? 'm4a' : (mime.includes('ogg') ? 'ogg' : 'webm')}`, mime, onProgress)), dur: Math.max(1, Math.round(seconds || 0)) };
  return post(chat, { type: 'voice', text: '', file: meta }, '🎤 رسالة صوتية');
}

const fileCache = new Map();
/** Full file as an object URL */
export async function loadFile(meta) {
  if (fileCache.has(meta.id)) return fileCache.get(meta.id);
  const info = await read('chat_files', meta.id);
  if (!info) throw userError('الملف مش موجود.', 'File not found.');
  const parts = await list(col(`chat_files/${meta.id}/chunks`));
  const b64 = parts.sort((a, b) => Number(a.i ?? a.id) - Number(b.i ?? b.id)).map(p => p.data).join('');
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr], { type: info.mime || meta.mime }));
  fileCache.set(meta.id, url);
  return url;
}

// ---------- edit / delete (only where the admin enabled it) ----------
const isLast = (chat, m) => chat.lastMessage && chat.lastMessage.by === m.by && toMs(chat.lastMessage.at) === toMs(m.at);
export async function editMessage(chat, m, text) {
  if (!canEditMessage(chat, m) || m.by !== session.email) throw userError('تعديل الرسايل مش مفعّل في الجروب ده.', 'Editing messages is not enabled in this group.');
  const t = String(text || '').trim();
  if (!t) throw userError('الرسالة فاضية.', 'The message is empty.');
  if (t.length > 4000) throw userError('الرسالة طويلة جداً.', 'The message is too long.');
  await updateDoc(doc(db, `chats/${chat.id}/messages`, m.id), { text: t, edited: true, editedAt: serverTimestamp() });
  if (isLast(chat, m)) updateDoc(doc(db, 'chats', chat.id), { 'lastMessage.text': t.slice(0, 140) }).catch(() => {});
}
export async function deleteMessage(chat, m) {
  if (!canEditMessage(chat, m)) throw userError('حذف الرسايل مش مفعّل في الجروب ده.', 'Deleting messages is not enabled in this group.');
  await updateDoc(doc(db, `chats/${chat.id}/messages`, m.id), { deleted: true, deletedAt: serverTimestamp(), text: '', type: 'text', file: deleteField() });
  if (isLast(chat, m) && (chat.members || []).includes(session.email)) updateDoc(doc(db, 'chats', chat.id), { 'lastMessage.text': L('🚫 رسالة اتمسحت', '🚫 Message deleted') }).catch(() => {});
}

/**
 * Mark a conversation read for me — only when there is actually something new from someone else.
 * (Writing on every snapshot would loop: our own pending write shows lastRead as null, which triggered
 * another write, flooding the conversation document and delaying real messages.)
 */
const reading = new Set();
export async function markRead(chat) {
  if (!chat || !(chat.members || []).includes(session.email)) return;
  const me = ek(session.email);
  const lr = chat.lastRead || {};
  if (me in lr && lr[me] == null) return;                      // our own write is still on its way
  const lm = chat.lastMessage;
  const incomingAt = lm && lm.by !== session.email ? (toMs(lm.at) || Infinity) : 0;
  const readAt = toMs(lr[me]) || 0;
  if (!unreadOf(chat) && (!incomingAt || readAt >= incomingAt)) return;
  if (reading.has(chat.id)) return;
  reading.add(chat.id);
  try { await settle(updateDoc(doc(db, 'chats', chat.id), { [`unread.${me}`]: 0, [`lastRead.${me}`]: serverTimestamp() }), 4000); }
  catch (e) { console.warn('markRead', e && e.message); }
  finally { setTimeout(() => reading.delete(chat.id), 1200); }
}

/** Admin: move every message of a conversation into the admin-only archive */
export async function archiveChat(chat) {
  if (!isAdmin()) throw userError('الأرشفة للأدمن بس.', 'Only admins can archive.');
  const msgs = await list(col(`chats/${chat.id}/messages`));
  const ops = [];
  ops.push(['set', doc(db, 'chat_archive', chat.id), { members: chat.members, lastArchivedAt: serverTimestamp(), lastArchivedBy: session.email }, true]);
  msgs.forEach(m => { const { id, ...data } = m; ops.push(['set', doc(db, `chat_archive/${chat.id}/messages`, id), { ...data, archivedAt: serverTimestamp() }]); ops.push(['del', doc(db, `chats/${chat.id}/messages`, id)]); });
  ops.push(['update', doc(db, 'chats', chat.id), { archivedAt: serverTimestamp(), archivedBy: session.email, archivedCount: increment(msgs.length), lastMessage: null, updatedAt: serverTimestamp() }]);
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(([op, r, d, merge]) => { if (op === 'set') b.set(r, d, merge ? { merge: true } : undefined); else if (op === 'update') b.update(r, d); else b.delete(r); });
    await b.commit();
  }
  track('chat.archive', { target: isGroup(chat) ? chat.name : (chat.members || []).join(' ↔ '), detail: `${msgs.length}` });
  return msgs.length;
}
