// To-Do List: each employee's own day plan (todos/{id}). An item may point at one of their tasks. The owner edits
// it; their leader, the project managers, HR and admins can look at it. Items are read month by month
// (owner + month, both equality filters — no extra index needed).
import { db, doc, col, watch, query, where, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp } from '../core/fb.js';
import { session, now, isAdmin, isPM, isHR } from '../core/session.js';
import { userError } from '../core/ui.js';
import { ymd } from '../core/utils.js';
import { person, activePeople } from './directory.js';

export const seesEveryone = () => isAdmin() || isPM() || isHR();
export const canView = (email) => email === session.email || seesEveryone() || ((person(email) || {}).leaderEmail === session.email);
export const viewable = () => seesEveryone() ? activePeople() : activePeople().filter(p => p.email === session.email || p.leaderEmail === session.email);
const scope = (email) => (email === session.email || seesEveryone()) ? [] : [where('leader', '==', session.email)];

/** one person's items for the given months ('YYYY-MM'), merged */
export function watchTodos(email, months, cb) {
  const parts = {};
  const emit = () => cb(Object.values(parts).flat().sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.order || 0) - (b.order || 0)));
  const offs = [...new Set(months)].map(m => watch(query(col('todos'), where('owner', '==', email), where('month', '==', m), ...scope(email)), rows => { parts[m] = rows; emit(); }, () => { parts[m] = []; emit(); }));
  return () => offs.forEach(f => f());
}
/** everyone I may see, one month (team tab / dashboard) */
export const watchMonth = (ym, cb) => watch(query(col('todos'), where('month', '==', ym), ...(seesEveryone() ? [] : [where('leader', '==', session.email)])), cb, () => cb([]));

const clean = (t) => { const x = String(t || '').trim().slice(0, 500); if (!x) throw userError('اكتب المهمة.', 'Write the item.'); return x; };
export async function addTodo(date, text, task = null) {
  const ref = doc(col('todos'));
  const me = person(session.email) || session.profile || {};
  await setDoc(ref, { owner: session.email, leader: me.leaderEmail || '', date, month: date.slice(0, 7), text: clean(text), note: '', done: false, doneAt: null,
    taskId: task ? task.id : '', taskNum: task ? task.num : 0, taskTitle: task ? String(task.title || '').slice(0, 200) : '', order: now(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  return ref.id;
}
const mine = (it) => { if (it.owner !== session.email) throw userError('الـ To-Do ده مش بتاعك.', 'This is not your to-do list.'); };
export async function toggleTodo(it) { mine(it); await updateDoc(doc(db, 'todos', it.id), { done: !it.done, doneAt: !it.done ? serverTimestamp() : null, updatedAt: serverTimestamp() }); }
export async function editTodo(it, f) { mine(it); await updateDoc(doc(db, 'todos', it.id), { ...(f.text !== undefined ? { text: clean(f.text) } : {}), ...(f.note !== undefined ? { note: String(f.note).slice(0, 1000) } : {}), updatedAt: serverTimestamp() }); }
export async function deleteTodo(it) { mine(it); await deleteDoc(doc(db, 'todos', it.id)); }
/** carry unfinished items over to another day */
export async function moveTodos(items, date) {
  const b = writeBatch(db);
  items.forEach(it => { mine(it); b.update(doc(db, 'todos', it.id), { date, month: date.slice(0, 7), updatedAt: serverTimestamp() }); });
  await b.commit();
}
export const today = () => ymd(now());
