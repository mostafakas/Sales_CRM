// Group tasks: inside a group chat, a team leader hands tasks to the employees they lead (their leaderEmail).
// Each employee sees only their own tasks; the leader sees the ones they gave. Statuses: New → In progress → Finished.
// The employee and the leader move a task forward; only the leader can send a Finished task back (with a reason).
import { db, doc, col, watch, query, where, runTransaction, updateDoc, deleteDoc, serverTimestamp, arrayUnion, toMs } from '../core/fb.js';
import { session, now, isAdmin } from '../core/session.js';
import { userError } from '../core/ui.js';
import { L, ymd } from '../core/utils.js';
import { person, nameOf } from './directory.js';
import { notify } from './notify.js';
import { track } from './activity.js';
import { isGroup } from './chat.js';

export const TASK_STATUS = {
  new: { label: 'New', cls: 'new', icon: 'fa-circle-plus' },
  in_progress: { label: 'In progress', cls: 'inprog', icon: 'fa-spinner' },
  done: { label: 'Finished', cls: 'done', icon: 'fa-circle-check' }
};
export const TASK_ORDER = ['new', 'in_progress', 'done'];
export const taskLink = (chatId, taskId) => `#/chat/${encodeURIComponent(chatId)}/${encodeURIComponent(taskId)}`;
export const isLate = (t) => !!t.due && t.status !== 'done' && t.due < ymd(now());

/** Group members this person may give tasks to: the employees they lead (admins: anyone in the group) */
export function assignableIn(chat) {
  if (!isGroup(chat) || !(chat.members || []).includes(session.email)) return [];
  return (chat.members || []).filter(e => e !== session.email)
    .map(e => person(e)).filter(p => p && !p.isSuspended && (isAdmin() || p.leaderEmail === session.email));
}
export const canCreateTasks = (chat) => assignableIn(chat).length > 0;
/** the leader who gave the task (or a system admin) */
export const isTaskLeader = (t) => !!t && (t.leader === session.email || isAdmin());
/** May I move this task to `to`? */
export function canMove(t, to) {
  if (!t || t.status === to || !TASK_STATUS[to]) return false;
  if (isTaskLeader(t)) return true;                                            // incl. Finished → In progress
  if (t.assignee !== session.email) return false;
  return (t.status === 'new' && (to === 'in_progress' || to === 'done')) || (t.status === 'in_progress' && to === 'done');
}

/** My tasks in one group (admins: all of them), sorted by number. Two queries merged: given to me / given by me. */
export function watchTasks(chatId, cb) {
  const path = `chats/${chatId}/tasks`;
  const sort = (rows) => rows.sort((a, b) => (a.num || 0) - (b.num || 0));
  if (isAdmin()) return watch(col(path), rows => cb(sort(rows)), () => cb([]));
  let mine = [], given = [];
  const emit = () => { const m = new Map(); [...mine, ...given].forEach(t => m.set(t.id, t)); cb(sort([...m.values()])); };
  const a = watch(query(col(path), where('assignee', '==', session.email)), rows => { mine = rows; emit(); }, () => { mine = []; emit(); });
  const b = watch(query(col(path), where('leader', '==', session.email)), rows => { given = rows; emit(); }, () => { given = []; emit(); });
  return () => { a(); b(); };
}

const cleanTask = ({ title, details, due }) => {
  const t = String(title || '').trim().slice(0, 200);
  if (!t) throw userError('اكتب اسم التاسك.', 'Enter a task name.');
  const d = String(details || '').trim().slice(0, 4000);
  const du = /^\d{4}-\d{2}-\d{2}$/.test(String(due || '')) ? due : '';
  return { title: t, details: d, due: du };
};

/** Leader: create the task — one separate copy per chosen employee, each with its own number and status */
export async function createTasks(chat, { title, details, due, assignees }) {
  const allowed = assignableIn(chat).map(p => p.email);
  const who = [...new Set(assignees || [])].filter(e => allowed.includes(e));
  if (!who.length) throw userError('اختار موظف واحد على الأقل.', 'Pick at least one employee.');
  const base = cleanTask({ title, details, due });
  const chatRef = doc(db, 'chats', chat.id);
  const made = await runTransaction(db, async (tx) => {
    const snap = await tx.get(chatRef);
    let seq = Number((snap.exists() && snap.data().taskSeq) || 0);
    const out = who.map(email => {
      const ref = doc(col(`chats/${chat.id}/tasks`));
      seq += 1;
      const t = { ...base, num: seq, assignee: email, leader: session.email, status: 'new', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), doneAt: null, doneNote: '', returnReason: '', history: [{ by: session.email, from: '', to: 'new', at: now(), note: '' }] };
      tx.set(ref, t);
      return { id: ref.id, ...t };
    });
    tx.update(chatRef, { taskSeq: seq });
    return out;
  });
  made.forEach(t => notify(t.assignee, L(`تاسك جديد #${t.num}: ${t.title}`, `New task #${t.num}: ${t.title}`), L(`من ${nameOf(session.email)} في ${chat.name}${t.due ? ` · التسليم ${t.due}` : ''}`, `From ${nameOf(session.email)} in ${chat.name}${t.due ? ` · due ${t.due}` : ''}`), taskLink(chat.id, t.id), 'request'));
  track('chat.task_create', { target: chat.name || '', detail: `${base.title} → ${who.map(nameOf).join('، ')}` });
  return made;
}

/** Move a task. `note` = the delivery note (→ Finished) or the reason (Finished → In progress, required). */
export async function moveTask(chat, t, to, note = '') {
  if (!canMove(t, to)) throw userError('مش مسموح لك تغيّر حالة التاسك ده.', 'You cannot change this task.');
  const back = t.status === 'done' && to !== 'done';
  const n = String(note || '').trim().slice(0, 1000);
  if (back && !n) throw userError('اكتب سبب الإرجاع.', 'Enter the reason for sending it back.');
  const upd = { status: to, updatedAt: serverTimestamp(), history: arrayUnion({ by: session.email, from: t.status, to, at: now(), note: n }) };
  if (to === 'done') { upd.doneAt = serverTimestamp(); upd.doneNote = n; }
  if (back) { upd.doneAt = null; upd.returnReason = n; }
  await updateDoc(doc(db, `chats/${chat.id}/tasks`, t.id), upd);
  const link = taskLink(chat.id, t.id);
  if (to === 'done' && t.leader !== session.email) notify(t.leader, L(`${nameOf(session.email)} خلّص #${t.num}: ${t.title}`, `${nameOf(session.email)} finished #${t.num}: ${t.title}`), n || chat.name || '', link, 'approved');
  if (back && t.assignee !== session.email) notify(t.assignee, L(`التاسك #${t.num} رجع In progress`, `Task #${t.num} was sent back`), L(`السبب: ${n}`, `Reason: ${n}`), link, 'rejected');
}

/** Leader: change the text / due date */
export async function editTask(chat, t, fields) {
  if (!isTaskLeader(t)) throw userError('التعديل لليدر اللي عمل التاسك بس.', 'Only the leader who gave the task can edit it.');
  await updateDoc(doc(db, `chats/${chat.id}/tasks`, t.id), { ...cleanTask(fields), updatedAt: serverTimestamp() });
}
export async function deleteTask(chat, t) {
  if (!isTaskLeader(t)) throw userError('الحذف لليدر اللي عمل التاسك بس.', 'Only the leader who gave the task can delete it.');
  await deleteDoc(doc(db, `chats/${chat.id}/tasks`, t.id));
  track('chat.task_delete', { target: chat.name || '', detail: `#${t.num} ${t.title}` });
}
export const doneAtMs = (t) => toMs(t.doneAt) || 0;
