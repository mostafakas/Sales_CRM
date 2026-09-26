// Direct messages between employees: conversations, messages, files (stored in Firestore chunks), admin archive.
import { db, doc, col, read, list, watch, query, where, orderBy, limit, writeBatch, setDoc, updateDoc, serverTimestamp, increment, toMs, settle } from '../core/fb.js';
import { session, isAdmin } from '../core/session.js';
import { userError } from '../core/ui.js';
import { imageToDataUrl } from '../core/utils.js';
import { track } from './activity.js';

export const MAX_FILE = 5 * 1024 * 1024;           // 5 MB per file
const CHUNK = 700000;                              // base64 characters per Firestore doc (< 1 MB)
export const ek = (email) => String(email || '').toLowerCase().replace(/[^a-z0-9]/g, '_'); // safe map key
export const chatIdFor = (a, b) => [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('__');
export const otherOf = (chat, me = session.email) => (chat.members || []).find(m => m !== me) || me;
export const unreadOf = (chat, me = session.email) => Number((chat.unread || {})[ek(me)] || 0);

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
  const other = otherOf(chat);
  const b = writeBatch(db);
  const m = doc(col(`chats/${chat.id}/messages`));
  b.set(m, { by: session.email, type: 'text', text: '', ...msg, at: serverTimestamp() });
  b.update(doc(db, 'chats', chat.id), {
    lastMessage: { by: session.email, text: preview.slice(0, 140), type: msg.type || 'text', at: serverTimestamp() },
    updatedAt: serverTimestamp(), [`unread.${ek(other)}`]: increment(1), [`unread.${ek(session.email)}`]: 0
  });
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
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const size = Math.round(b64.length * 0.75);
  if (size > MAX_FILE) throw userError('الملف أكبر من 5 ميجا.', 'The file is larger than 5 MB.');
  const chunks = Math.ceil(b64.length / CHUNK) || 1;
  const fref = doc(col('chat_files'));
  await setDoc(fref, { chatId: chat.id, by: session.email, name: String(file.name || 'file').slice(0, 180), mime, size, chunks, at: serverTimestamp() });
  for (let i = 0; i < chunks; i++) {
    await setDoc(doc(db, `chat_files/${fref.id}/chunks`, String(i)), { i, data: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
    onProgress && onProgress((i + 1) / chunks);
  }
  const meta = { id: fref.id, name: String(file.name || 'file').slice(0, 180), mime, size, ...(thumb ? { thumb } : {}) };
  const text = String(caption || '').trim().slice(0, 4000);
  return post(chat, { type: isImg ? 'image' : 'file', text, file: meta }, text || (isImg ? '📷 صورة' : `📎 ${meta.name}`));
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

/**
 * Mark a conversation read for me — only when there is actually something new from the other person.
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
  track('chat.archive', { target: (chat.members || []).join(' ↔ '), detail: `${msgs.length}` });
  return msgs.length;
}
