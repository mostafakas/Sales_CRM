// Tasks, projects and clients (the "Tasks" page). Who sees what:
//   employee → the tasks assigned to them · leader → the tasks of the people they lead (task.leader = them)
//   project manager (role "pm") and admin → everything, with full control.
// Statuses: New → In progress → Review → Finished, plus On hold. An employee hands work in for review; the leader /
// project manager finishes it or sends it back with a reason. Tasks someone made for themselves they may finish.
import {
  db, doc, col, watch, query, where, runTransaction, updateDoc, deleteDoc, setDoc, writeBatch, serverTimestamp, arrayUnion, increment, toMs, list, read
} from '../core/fb.js';
import { session, now, isAdmin, isPM, isHR } from '../core/session.js';
import { userError } from '../core/ui.js';
import { L, ymd } from '../core/utils.js';
import { dayKey } from '../core/policy.js';
import { person, nameOf, activePeople } from './directory.js';
import { notifyMany } from './notify.js';
import { track } from './activity.js';

export const STATUS = {
  new: { label: 'New', ar: 'جديد', cls: 'new', icon: 'fa-circle-plus' },
  in_progress: { label: 'In progress', ar: 'قيد التنفيذ', cls: 'inprog', icon: 'fa-person-digging' },
  review: { label: 'Review', ar: 'مراجعة', cls: 'review', icon: 'fa-magnifying-glass' },
  hold: { label: 'On hold', ar: 'متوقف', cls: 'hold', icon: 'fa-circle-pause' },
  done: { label: 'Finished', ar: 'منتهي', cls: 'done', icon: 'fa-circle-check' }
};
export const ORDER = ['new', 'in_progress', 'review', 'hold', 'done'];
export const PRIORITY = {
  normal: { ar: 'عادي', en: 'Normal', cls: '' },
  high: { ar: 'مهم', en: 'High', cls: 'warn' },
  urgent: { ar: 'عاجل', en: 'Urgent', cls: 'bad' }
};
export const PROJECT_STATUS = { active: { ar: 'شغال', en: 'Active', cls: 'ok' }, hold: { ar: 'متوقف', en: 'On hold', cls: 'warn' }, done: { ar: 'خلص', en: 'Completed', cls: '' } };
export const taskLink = (id) => `#/tasks/t/${encodeURIComponent(id)}`;
export const isLate = (t) => !!t.due && t.status !== 'done' && t.due < ymd(now());
export const doneDay = (t) => dayKey(toMs(t.doneAt) || now());

// ---------- who may do what ----------
export const seesAllTasks = () => isAdmin() || isPM();
/** admin, project manager, or the task's leader */
export const canManage = (t) => !!t && (seesAllTasks() || t.leader === session.email);
const ownTask = (t) => !!t && t.createdBy === session.email && t.assignee === session.email;
export const canEdit = (t) => canManage(t) || ownTask(t);
export const canDelete = canEdit;
/** may I move this task to `to`? */
export function canMove(t, to) {
  if (!t || t.status === to || !STATUS[to]) return false;
  if (canManage(t)) return true;
  if (t.assignee !== session.email) return false;
  if (ownTask(t)) return true;                                       // my own task: I finish it myself
  const a = t.status;
  return (a === 'new' && ['in_progress', 'review', 'hold'].includes(to)) || (a === 'in_progress' && ['review', 'hold'].includes(to)) || (a === 'hold' && to === 'in_progress');
}
/** a reason is required to put a task on hold or to send it back from review / finished */
export const needsReason = (t, to) => to === 'hold' || ((t.status === 'review' || t.status === 'done') && (to === 'in_progress' || to === 'new'));
/** people I may give tasks to */
export function assignable() {
  const me = person(session.email) || session.profile || {};
  const out = activePeople();
  if (seesAllTasks()) return out;
  const team = out.filter(p => p.leaderEmail === session.email);
  if (me.selfTasks) team.unshift(person(session.email) || { email: session.email, name: me.name });
  return team.filter((p, i, a) => a.findIndex(x => x.email === p.email) === i);
}
export const canCreate = () => assignable().length > 0;
export const canManageProjects = () => seesAllTasks();

// ---------- live data ----------
let tasks = [], projects = [], clients = [], started = false;
const subs = new Set();
const emit = () => subs.forEach(f => { try { f(); } catch (e) { console.warn(e); } });
export const onTasks = (fn) => { subs.add(fn); fn(); return () => subs.delete(fn); };
export const allTasks = () => tasks;
export const allProjects = () => projects;
export const allClients = () => clients;
export const taskById = (id) => tasks.find(t => t.id === id || t.legacyId === id) || null;
export const projectById = (id) => projects.find(p => p.id === id) || null;
export const clientById = (id) => clients.find(c => c.id === id) || null;
/** my open tasks + (leaders / managers) tasks waiting for my review → the menu badge */
export const badgeCount = () => tasks.filter(t => (t.assignee === session.email && !['done', 'review'].includes(t.status)) || (t.status === 'review' && canManage(t) && t.assignee !== session.email)).length;

export function startTasks() {
  if (started) return; started = true;
  const merge = (parts) => { const m = new Map(); parts.forEach(p => p.forEach(t => m.set(t.id, t))); tasks = [...m.values()].sort((a, b) => (b.num || 0) - (a.num || 0)); emit(); };
  if (seesAllTasks() || isHR()) watch(col('tasks'), rows => merge([rows]), () => merge([]));   // HR: read-only, for the dashboard
  else {
    let mine = [], led = [];
    watch(query(col('tasks'), where('assignee', '==', session.email)), rows => { mine = rows; merge([mine, led]); }, () => {});
    watch(query(col('tasks'), where('leader', '==', session.email)), rows => { led = rows; merge([mine, led]); }, () => {});
  }
  watch(col('tk_projects'), rows => { projects = rows.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar')); emit(); }, () => {});
  watch(col('tk_clients'), rows => { clients = rows.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar')); emit(); }, () => {});
}

// ---------- notifications: the important moments go to the admins, project managers, the leader and the assignee ----------
const managers = () => activePeople().filter(p => p.role === 'admin' || p.role === 'pm').map(p => p.email);
function tell(t, title, body = '', extra = []) {
  const to = [...managers(), t.leader, t.assignee, ...extra].filter(e => e && e !== session.email);
  notifyMany(to, title, body, taskLink(t.id), 'progress');
}

// ---------- tasks ----------
const cleanChecklist = (cl) => (Array.isArray(cl) ? cl : []).map(x => ({ id: String(x.id || Math.random().toString(36).slice(2, 9)), text: String(x.text || '').trim().slice(0, 300), done: !!x.done })).filter(x => x.text).slice(0, 50);
function cleanFields(f) {
  const title = String(f.title || '').trim().slice(0, 200);
  if (!title) throw userError('اكتب اسم التاسك.', 'Enter a task name.');
  const p = f.projectId ? projectById(f.projectId) : null;
  const c = p && p.clientId ? clientById(p.clientId) : (f.clientId ? clientById(f.clientId) : null);
  return {
    title, details: String(f.details || '').trim().slice(0, 6000), priority: PRIORITY[f.priority] ? f.priority : 'normal',
    due: /^\d{4}-\d{2}-\d{2}$/.test(String(f.due || '')) ? f.due : '',
    projectId: p ? p.id : '', projectName: p ? p.name : '', clientId: c ? c.id : '', clientName: c ? c.name : '',
    checklist: cleanChecklist(f.checklist)
  };
}
/** next task numbers (one shared counter) */
async function nextNums(n) {
  const ref = doc(db, 'counters', 'tasks');
  return runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    const seq = Number((s.exists() && s.data().seq) || 0);
    tx.set(ref, { seq: seq + n });
    return Array.from({ length: n }, (_, i) => seq + i + 1);
  });
}
/** Create a task — one separate copy per chosen person, each with its own number and status */
export async function createTasks(fields, assignees) {
  const allowed = new Set(assignable().map(p => p.email));
  const who = [...new Set(assignees || [])].filter(e => allowed.has(e));
  if (!who.length) throw userError('اختار الموظف.', 'Pick the employee.');
  const base = cleanFields(fields);
  const nums = await nextNums(who.length);
  const b = writeBatch(db);
  const made = who.map((email, i) => {
    const p = person(email) || {};
    // the responsible leader: me when I lead them, else their own leader (a self task goes to my leader)
    const leader = email === session.email ? (p.leaderEmail || '') : (p.leaderEmail === session.email ? session.email : (p.leaderEmail || session.email));
    const ref = doc(col('tasks'));
    const t = { ...base, num: nums[i], assignee: email, leader, createdBy: session.email, status: 'new', createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      doneAt: null, doneNote: '', returnReason: '', holdReason: '', commentsCount: 0, history: [{ by: session.email, from: '', to: 'new', at: now(), note: '' }] };
    b.set(ref, t);
    return { id: ref.id, ...t };
  });
  await b.commit();
  made.forEach(t => tell(t, L(`تاسك جديد #${t.num}: ${t.title}`, `New task #${t.num}: ${t.title}`), L(`لـ ${nameOf(t.assignee)} · من ${nameOf(session.email)}${t.due ? ` · التسليم ${t.due}` : ''}`, `For ${nameOf(t.assignee)} · from ${nameOf(session.email)}${t.due ? ` · due ${t.due}` : ''}`)));
  track('task.create', { target: base.title, detail: who.map(nameOf).join('، ') });
  return made;
}
export async function editTask(t, fields) {
  if (!canEdit(t)) throw userError('مش مسموح لك تعدّل التاسك ده.', 'You cannot edit this task.');
  const f = cleanFields(fields);
  const upd = { ...f, updatedAt: serverTimestamp() };
  if (fields.assignee && fields.assignee !== t.assignee && canManage(t)) {
    if (!assignable().some(p => p.email === fields.assignee)) throw userError('مش مسموح تسند التاسك للشخص ده.', 'You cannot assign it to this person.');
    upd.assignee = fields.assignee;
    upd.history = arrayUnion({ by: session.email, from: t.status, to: t.status, at: now(), note: L(`اتنقل من ${nameOf(t.assignee)} لـ ${nameOf(fields.assignee)}`, `reassigned from ${nameOf(t.assignee)} to ${nameOf(fields.assignee)}`) });
  }
  await updateDoc(doc(db, 'tasks', t.id), upd);
  if (upd.assignee) tell({ ...t, assignee: upd.assignee }, L(`التاسك #${t.num} اتسند لـ ${nameOf(upd.assignee)}`, `Task #${t.num} reassigned to ${nameOf(upd.assignee)}`), t.title, [t.assignee]);
}
export async function moveTask(t, to, note = '') {
  if (!canMove(t, to)) throw userError('مش مسموح لك تغيّر حالة التاسك ده للحالة دي.', 'You cannot move this task there.');
  const n = String(note || '').trim().slice(0, 1000);
  if (needsReason(t, to) && !n) throw userError('اكتب السبب.', 'Enter the reason.');
  const upd = { status: to, updatedAt: serverTimestamp(), history: arrayUnion({ by: session.email, from: t.status, to, at: now(), note: n }) };
  if (to === 'done') { upd.doneAt = serverTimestamp(); upd.doneNote = n; }
  if (t.status === 'done' && to !== 'done') upd.doneAt = null;
  if (to === 'hold') upd.holdReason = n;
  if (needsReason(t, to) && to !== 'hold') upd.returnReason = n;
  if (to === 'review') upd.reviewAt = serverTimestamp();
  await updateDoc(doc(db, 'tasks', t.id), upd);
  const who = nameOf(session.email);
  const msg = {
    in_progress: t.status === 'hold' ? L(`${who} رجّع #${t.num} للشغل`, `${who} resumed #${t.num}`) : (needsReason(t, to) ? L(`#${t.num} رجع In progress`, `#${t.num} sent back`) : L(`${who} بدأ #${t.num}`, `${who} started #${t.num}`)),
    review: L(`#${t.num} مستني مراجعة`, `#${t.num} is waiting for review`),
    hold: L(`#${t.num} اتوقف`, `#${t.num} put on hold`),
    done: L(`✓ #${t.num} خلص`, `✓ #${t.num} finished`),
    new: L(`#${t.num} رجع New`, `#${t.num} moved back to New`)
  }[to];
  tell(t, msg, `${t.title}${n ? ` — ${n}` : ''}`);
}
/** tick a checklist item (assignee or managers) */
export async function toggleCheck(t, itemId) {
  if (!(canEdit(t) || t.assignee === session.email)) throw userError('مش مسموح لك.', 'Not allowed.');
  const checklist = (t.checklist || []).map(x => x.id === itemId ? { ...x, done: !x.done } : x);
  await updateDoc(doc(db, 'tasks', t.id), { checklist, updatedAt: serverTimestamp() });
}
export async function deleteTask(t) {
  if (!canDelete(t)) throw userError('مش مسموح لك تحذف التاسك ده.', 'You cannot delete this task.');
  await deleteDoc(doc(db, 'tasks', t.id));
  tell(t, L(`اتحذف التاسك #${t.num}`, `Task #${t.num} deleted`), t.title);
  track('task.delete', { target: `#${t.num} ${t.title}` });
}

// ---------- comments (with @mentions and files) ----------
export const watchComments = (id, cb) => watch(query(col(`tasks/${id}/comments`)), rows => cb(rows.sort((a, b) => (toMs(a.at) || now()) - (toMs(b.at) || now()))), () => cb([]));
export async function addComment(t, text, { mentions = [], file = null } = {}) {
  const tx = String(text || '').trim().slice(0, 3000);
  if (!tx && !file) return;
  const b = writeBatch(db);
  b.set(doc(col(`tasks/${t.id}/comments`)), { by: session.email, text: tx, mentions: mentions.slice(0, 20), ...(file ? { file } : {}), at: serverTimestamp() });
  b.update(doc(db, 'tasks', t.id), { commentsCount: increment(1), updatedAt: serverTimestamp() });
  await b.commit();
  const to = [t.assignee, t.leader, ...mentions].filter(e => e && e !== session.email);
  notifyMany(to, L(`💬 ${nameOf(session.email)} على #${t.num}`, `💬 ${nameOf(session.email)} on #${t.num}`), tx.slice(0, 140) || (file ? `📎 ${file.name}` : ''), taskLink(t.id), 'info');
}
export const deleteComment = (t, c) => deleteDoc(doc(db, `tasks/${t.id}/comments`, c.id));

const CHUNK = 700000;
export const MAX_FILE = 5 * 1024 * 1024;
export async function uploadFile(t, file, onProgress) {
  if (!file) return null;
  if (file.size > MAX_FILE) throw userError('الملف أكبر من 5 ميجا.', 'The file is larger than 5 MB.');
  const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const chunks = Math.ceil(b64.length / CHUNK) || 1;
  const ref = doc(col('task_files'));
  const meta = { taskId: t.id, by: session.email, name: String(file.name || 'file').slice(0, 180), mime: file.type || 'application/octet-stream', size: file.size, chunks, at: serverTimestamp() };
  await setDoc(ref, meta);
  for (let i = 0; i < chunks; i++) { await setDoc(doc(db, `task_files/${ref.id}/chunks`, String(i)), { i, data: b64.slice(i * CHUNK, (i + 1) * CHUNK) }); onProgress && onProgress((i + 1) / chunks); }
  return { id: ref.id, name: meta.name, mime: meta.mime, size: meta.size };
}
const fileCache = new Map();
export async function loadFile(meta) {
  if (fileCache.has(meta.id)) return fileCache.get(meta.id);
  const parts = await list(col(`task_files/${meta.id}/chunks`));
  const b64 = parts.sort((a, b) => Number(a.i ?? a.id) - Number(b.i ?? b.id)).map(p => p.data).join('');
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr], { type: meta.mime }));
  fileCache.set(meta.id, url);
  return url;
}

// ---------- team permission: "may create tasks for themselves" ----------
export async function setSelfTasks(email, on) {
  const p = person(email);
  if (!(isAdmin() || (p && p.leaderEmail === session.email))) throw userError('الصلاحية دي للأدمن أو ليدر الموظف.', 'Only an admin or the employee\'s leader can change this.');
  await updateDoc(doc(db, 'users', email), { selfTasks: !!on });
  track('task.selftasks', { target: nameOf(email), detail: on ? 'on' : 'off' });
}

// ---------- projects & clients (admin / project manager) ----------
export async function saveProject(p, f) {
  if (!canManageProjects()) throw userError('المشاريع للأدمن ومدير المشروعات.', 'Projects are managed by admins and project managers.');
  const name = String(f.name || '').trim().slice(0, 120);
  if (!name) throw userError('اكتب اسم المشروع.', 'Enter a project name.');
  const c = f.clientId ? clientById(f.clientId) : null;
  const data = { name, clientId: c ? c.id : '', clientName: c ? c.name : '', leader: f.leader || '', members: [...new Set(f.members || [])],
    start: f.start || '', end: f.end || '', status: PROJECT_STATUS[f.status] ? f.status : 'active', description: String(f.description || '').slice(0, 3000),
    color: /^#[0-9a-f]{6}$/i.test(f.color || '') ? f.color : '#1b1bdb', updatedAt: serverTimestamp() };
  if (p) await updateDoc(doc(db, 'tk_projects', p.id), data);
  else await setDoc(doc(col('tk_projects')), { ...data, createdBy: session.email, createdAt: serverTimestamp() });
  track(p ? 'project.update' : 'project.create', { target: name });
}
export async function deleteProject(p) {
  if (!canManageProjects()) throw userError('المشاريع للأدمن ومدير المشروعات.', 'Projects are managed by admins and project managers.');
  await deleteDoc(doc(db, 'tk_projects', p.id)); track('project.delete', { target: p.name });
}
export async function saveClient(c, f) {
  if (!canManageProjects()) throw userError('العملاء للأدمن ومدير المشروعات.', 'Clients are managed by admins and project managers.');
  const name = String(f.name || '').trim().slice(0, 120);
  if (!name) throw userError('اكتب اسم العميل.', 'Enter a client name.');
  const data = { name, company: String(f.company || '').slice(0, 120), contact: String(f.contact || '').slice(0, 120), phone: String(f.phone || '').slice(0, 40),
    email: String(f.email || '').slice(0, 120), notes: String(f.notes || '').slice(0, 3000), updatedAt: serverTimestamp() };
  if (c) await updateDoc(doc(db, 'tk_clients', c.id), data);
  else await setDoc(doc(col('tk_clients')), { ...data, createdBy: session.email, createdAt: serverTimestamp() });
  track(c ? 'client.update' : 'client.create', { target: name });
}
export async function deleteClient(c) {
  if (!canManageProjects()) throw userError('العملاء للأدمن ومدير المشروعات.', 'Clients are managed by admins and project managers.');
  await deleteDoc(doc(db, 'tk_clients', c.id)); track('client.delete', { target: c.name });
}
/** Admin: copy client and project names from the sales CRM (no budgets), once per record */
export async function importFromCrm() {
  if (!isAdmin()) throw userError('الاستيراد للأدمن بس.', 'Only admins can import.');
  const [cc, pp] = await Promise.all([list(col('clients')), list(col('projects'))]);
  const have = new Set(clients.map(c => c.crmId).filter(Boolean)), haveP = new Set(projects.map(p => p.crmId).filter(Boolean));
  const map = Object.fromEntries(clients.filter(c => c.crmId).map(c => [c.crmId, c]));
  let nc = 0, np = 0;
  for (const c of cc) {
    if (have.has(c.id)) continue;
    const ref = doc(col('tk_clients'));
    const d = { name: String(c.name || '—').slice(0, 120), company: '', contact: '', phone: String(c.phone || ''), email: String(c.email || ''), notes: '', crmId: c.id, createdBy: session.email, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    await setDoc(ref, d); map[c.id] = { id: ref.id, ...d }; nc++;
  }
  for (const p of pp) {
    if (haveP.has(p.id)) continue;
    const c = map[p.clientId];
    await setDoc(doc(col('tk_projects')), { name: String(p.title || p.name || '—').slice(0, 120), clientId: c ? c.id : '', clientName: c ? c.name : (p.clientName || ''), leader: '', members: [], start: '', end: '', status: 'active', description: '', color: '#1b1bdb', crmId: p.id, createdBy: session.email, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    np++;
  }
  track('crm.import', { detail: `${nc} / ${np}` });
  return { clients: nc, projects: np };
}

/** One-time move of the tasks that lived inside group chats (same ids, so old #mentions keep working) */
export async function migrateChatTasks() {
  if (!isAdmin()) return 0;
  const flag = await read('settings', 'migration').catch(() => null);
  if (flag && flag.tasksV2) return 0;
  const groups = (await list(col('chats'))).filter(c => c.type === 'group');
  const old = [];
  for (const g of groups) (await list(col(`chats/${g.id}/tasks`)).catch(() => [])).forEach(t => old.push({ ...t, chatId: g.id }));
  old.sort((a, b) => (toMs(a.createdAt) || 0) - (toMs(b.createdAt) || 0));
  if (old.length) {
    const nums = await nextNums(old.length);
    for (let i = 0; i < old.length; i += 400) {
      const b = writeBatch(db);
      old.slice(i, i + 400).forEach((t, k) => {
        const { id, chatId, num, ...rest } = t;
        b.set(doc(db, 'tasks', id), { ...rest, num: nums[i + k], oldNum: num || 0, chatId, legacyId: id, createdBy: t.leader || '', priority: 'normal', projectId: '', projectName: '', clientId: '', clientName: '', checklist: [], holdReason: '', commentsCount: 0, updatedAt: serverTimestamp() });
      });
      await b.commit();
    }
  }
  await setDoc(doc(db, 'settings', 'migration'), { tasksV2: true, tasksV2At: serverTimestamp() }, { merge: true });
  track('task.migrate', { detail: `${old.length}` });
  return old.length;
}
