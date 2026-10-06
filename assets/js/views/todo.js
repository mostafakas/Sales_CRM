// To-Do List page: the day plan of one person (#/todo or #/todo/<email>), linked to their tasks.
// The owner adds, ticks, notes, deletes and carries over; leaders / project managers / HR / admins look.
import { L, esc, fmtDate, addDays, num } from '../core/utils.js';
import { toast, toastErr, avatar, empty, busy, confirmDialog, modal } from '../core/ui.js';
import { session } from '../core/session.js';
import { person, nameOf, onDirectory } from '../services/directory.js';
import { watchTodos, addTodo, toggleTodo, editTodo, deleteTodo, moveTodos, canView, viewable, today } from '../services/todos.js';
import { startTasks, onTasks, allTasks, taskById, isLate } from '../services/tasks.js';
import { details, statusBadge } from './task-ui.js';
import { setTabLabel } from '../tabs.js';

const weekStart = (d) => { const x = new Date(`${d}T00:00:00Z`); return addDays(d, -((x.getUTCDay() + 1) % 7)); }; // Saturday
const DAYS = () => [L('السبت', 'Sat'), L('الأحد', 'Sun'), L('الاتنين', 'Mon'), L('التلات', 'Tue'), L('الأربع', 'Wed'), L('الخميس', 'Thu'), L('الجمعة', 'Fri')];

export default async function render(root, { params = [] }) {
  startTasks();
  const email = params[0] ? decodeURIComponent(params[0]) : session.email;
  if (!canView(email)) { root.innerHTML = `<div class="card">${empty('fa-lock', L('مش مسموح لك تشوف الـ To-Do ده', 'You cannot view this to-do list'))}</div>`; return; }
  const own = email === session.email;
  const p = person(email) || { email, name: nameOf(email) };
  setTabLabel(own ? '' : (p.name || email));
  let day = today(), items = [], un = null, monthsKey = '';

  root.innerHTML = `<div class="td-page">
    <div class="page-head"><div class="row gap-12">${avatar(p, 'lg')}<div><h2>${own ? 'To-Do List' : `To-Do — ${esc(p.name || email)}`}</h2><p>${own ? L('خطة يومك، مربوطة بتاسكاتك', 'Your day plan, linked to your tasks') : `${esc(p.title || '')}${p.department ? ' · ' + esc(p.department) : ''}`}</p></div></div>
      ${viewable().length > 1 ? `<select class="select" id="who" style="min-width:220px">${viewable().sort((a, b) => (a.email === session.email ? -1 : b.email === session.email ? 1 : (a.name || '').localeCompare(b.name || '', 'ar'))).map(x => `<option value="${esc(x.email)}" ${x.email === email ? 'selected' : ''}>${esc(x.email === session.email ? L('أنا', 'Me') : (x.name || x.email))}</option>`).join('')}</select>` : ''}</div>
    <div class="grid g-4 keep-2 mb-16" id="stats"></div>
    <div class="td-week card mb-16" id="week"></div>
    <div class="td-grid">
      <section class="card td-day"><div class="card-head"><div class="row gap-8"><button class="btn btn-ghost btn-icon btn-sm" data-step="-1"><i class="fas fa-chevron-right" data-flip></i></button><h3 id="day-t"></h3><button class="btn btn-ghost btn-icon btn-sm" data-step="1"><i class="fas fa-chevron-left" data-flip></i></button></div>
        <div class="row gap-8"><input class="input" type="date" id="day" style="width:160px"><button class="btn btn-soft btn-sm" id="to-today">${L('النهارده', 'Today')}</button></div></div>
        <div class="card-body"><div id="carry"></div><div class="td-list" id="list"></div>
        ${own ? `<form class="td-add" id="add"><input class="input" id="add-t" maxlength="500" placeholder="${L('ضيف مهمة لليوم ده…', 'Add an item for this day…')}"><select class="select" id="add-k"><option value="">${L('من غير تاسك', 'No task')}</option></select><button class="btn btn-primary" type="submit"><i class="fas fa-plus"></i></button></form>` : `<p class="xs muted mt-8"><i class="fas fa-eye"></i> ${L('بتشوفه بس — صاحبه هو اللي بيعدّل.', 'View only — the owner edits it.')}</p>`}</div></section>
      <section class="card"><div class="card-head"><h3><i class="fas fa-clipboard-check"></i> ${own ? L('تاسكاتي المفتوحة', 'My open tasks') : L('تاسكاته المفتوحة', 'Open tasks')}</h3><a class="btn btn-ghost btn-sm" href="#/tasks">${L('كل التاسكات', 'All tasks')} <i class="fas fa-arrow-left" data-flip></i></a></div><div class="card-body" id="tasks"></div></section>
    </div></div>`;
  const $ = (s) => root.querySelector(s);
  const myTasks = () => allTasks().filter(t => t.assignee === email);

  const subscribe = () => {
    const ws = weekStart(day);
    const months = [day.slice(0, 7), ws.slice(0, 7), addDays(ws, 6).slice(0, 7), addDays(day, -31).slice(0, 7)];
    const key = [...new Set(months)].sort().join(',');
    if (key === monthsKey) return; monthsKey = key;
    if (un) un();
    un = watchTodos(email, months, rows => { items = rows; draw(); });
  };
  const pctOf = (xs) => xs.length ? Math.round(xs.filter(x => x.done).length / xs.length * 100) : 0;

  function draw() {
    const dayItems = items.filter(x => x.date === day);
    const ws = weekStart(day), week = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const weekItems = items.filter(x => x.date >= ws && x.date <= week[6]);
    const open = myTasks().filter(t => t.status !== 'done');
    const late = open.filter(isLate);
    const tile = (icon, cls, label, value, hint = '') => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
    $('#stats').innerHTML =
      tile('fa-list-check', 'brand', day === today() ? L('إنجاز النهارده', 'Done today') : L('إنجاز اليوم ده', 'Done that day'), `${pctOf(dayItems)}<small>%</small>`, L(`${dayItems.filter(x => x.done).length} من ${dayItems.length}`, `${dayItems.filter(x => x.done).length} of ${dayItems.length}`)) +
      tile('fa-calendar-week', 'ok', L('إنجاز الأسبوع', 'This week'), `${pctOf(weekItems)}<small>%</small>`, L(`${weekItems.filter(x => x.done).length} من ${weekItems.length}`, `${weekItems.filter(x => x.done).length} of ${weekItems.length}`)) +
      tile('fa-clipboard-check', 'info', L('تاسكات مفتوحة', 'Open tasks'), num(open.length), L(`${open.filter(t => t.status === 'review').length} في المراجعة`, `${open.filter(t => t.status === 'review').length} in review`)) +
      tile('fa-triangle-exclamation', 'bad', L('تاسكات متأخرة', 'Late tasks'), num(late.length), late.length ? L('محتاجة تتعمل الأول', 'Do these first') : L('مفيش 👌', 'None 👌'));
    $('#week').innerHTML = week.map((d, i) => { const xs = items.filter(x => x.date === d); const pc = pctOf(xs); return `<button class="td-wd ${d === day ? 'on' : ''} ${d === today() ? 'today' : ''}" data-day="${d}"><small>${DAYS()[i]}</small><b class="num">${Number(d.slice(8))}</b><span class="td-ring" style="--p:${pc}"><i class="num">${xs.length ? `${xs.filter(x => x.done).length}/${xs.length}` : '—'}</i></span></button>`; }).join('');
    $('#day-t').textContent = day === today() ? L('النهارده', 'Today') : (day === addDays(today(), -1) ? L('امبارح', 'Yesterday') : (day === addDays(today(), 1) ? L('بكرة', 'Tomorrow') : fmtDate(day)));
    $('#day').value = day;
    // unfinished items from earlier days
    const left = items.filter(x => !x.done && x.date < today());
    $('#carry').innerHTML = own && left.length && day === today() ? `<div class="alert warn mb-8"><i class="fas fa-rotate"></i><span class="grow">${L(`عندك ${left.length} حاجة من أيام فاتت لسه مخلصتش`, `${left.length} unfinished items from earlier days`)}</span><button class="btn btn-sm" id="carry-go">${L('انقلهم للنهارده', 'Move to today')}</button></div>` : '';
    const row = (x) => { const t = x.taskId ? taskById(x.taskId) : null; return `<div class="td-item ${x.done ? 'done' : ''}" data-id="${esc(x.id)}">
      <label class="td-check"><input type="checkbox" ${x.done ? 'checked' : ''} ${own ? '' : 'disabled'} data-tg="${esc(x.id)}"><span></span></label>
      <div class="grow min0"><div class="td-text">${esc(x.text)}</div>
        ${x.taskId ? `<button class="td-task" data-task="${esc(x.taskId)}"><i class="fas fa-clipboard-check"></i> #${t ? t.num : x.taskNum} ${esc(t ? t.title : x.taskTitle)}${t ? ` ${statusBadge(t.status)}` : ''}</button>` : ''}
        ${x.note ? `<div class="td-note">${esc(x.note)}</div>` : ''}</div>
      ${own ? `<div class="td-tools"><button class="btn btn-ghost btn-icon btn-sm" data-note="${esc(x.id)}" title="${L('ملاحظة / تعديل', 'Note / edit')}"><i class="fas fa-pen"></i></button><button class="btn btn-ghost btn-icon btn-sm" data-del="${esc(x.id)}" title="${L('حذف', 'Delete')}"><i class="fas fa-trash"></i></button></div>` : ''}</div>`; };
    $('#list').innerHTML = dayItems.length ? dayItems.map(row).join('') : `<div class="td-empty">${empty('fa-mug-hot', L('مفيش حاجة متسجلة لليوم ده', 'Nothing planned for this day'), own ? L('اكتب أول مهمة تحت، أو ضيف تاسك من اللي على الجنب.', 'Write your first item below, or add one of your tasks.') : '')}</div>`;
    // the tasks panel
    const tdy = today(), wk = addDays(tdy, 7);
    const groups = [
      ['late', L('متأخر', 'Late'), open.filter(isLate)],
      ['today', L('النهارده', 'Today'), open.filter(t => t.due === tdy)],
      ['week', L('الأسبوع ده', 'This week'), open.filter(t => t.due > tdy && t.due <= wk)],
      ['later', L('بعد كده', 'Later'), open.filter(t => t.due > wk)],
      ['none', L('من غير ميعاد', 'No due date'), open.filter(t => !t.due)]
    ].filter(g => g[2].length);
    const inPlan = new Set(dayItems.map(x => x.taskId).filter(Boolean));
    $('#tasks').innerHTML = groups.length ? groups.map(([k, title, ts]) => `<div class="td-g ${k}"><div class="td-gh">${title} <span class="num">${ts.length}</span></div>${ts.map(t => `<div class="td-t"><button class="td-t-main" data-task="${esc(t.id)}"><span class="num muted">#${t.num}</span> <b>${esc(t.title)}</b>${t.projectName ? `<small>${esc(t.projectName)}</small>` : ''}</button>${statusBadge(t.status)}
      ${own ? (inPlan.has(t.id) ? `<span class="td-in"><i class="fas fa-check"></i></span>` : `<button class="btn btn-soft btn-sm" data-plan="${esc(t.id)}" title="${L('ضيفه للـ To-Do بتاع اليوم ده', 'Add to this day')}"><i class="fas fa-plus"></i> To-Do</button>`) : ''}</div>`).join('')}</div>`).join('')
      : empty('fa-mug-hot', L('مفيش تاسكات مفتوحة', 'No open tasks'));
    const sel = $('#add-k'); if (sel) { const v = sel.value; sel.innerHTML = `<option value="">${L('من غير تاسك', 'No task')}</option>${open.map(t => `<option value="${esc(t.id)}" ${v === t.id ? 'selected' : ''}>#${t.num} ${esc(t.title.slice(0, 50))}</option>`).join('')}`; }
  }

  const setDay = (d) => { if (!d) return; day = d; subscribe(); draw(); };
  root.addEventListener('click', async (e) => {
    const st = e.target.closest('[data-step]'); if (st) { setDay(addDays(day, Number(st.dataset.step))); return; }
    const wd = e.target.closest('[data-day]'); if (wd) { setDay(wd.dataset.day); return; }
    if (e.target.closest('#to-today')) { setDay(today()); return; }
    const tk = e.target.closest('[data-task]'); if (tk) { details(tk.dataset.task); return; }
    const pl = e.target.closest('[data-plan]'); if (pl) { const t = taskById(pl.dataset.plan); if (t) busy(pl, async () => { try { await addTodo(day, t.title, t); } catch (ex) { toastErr(ex); } }); return; }
    const dl = e.target.closest('[data-del]'); if (dl) { const x = items.find(i => i.id === dl.dataset.del); if (x && await confirmDialog({ title: L('حذف المهمة', 'Delete item'), message: x.text, okText: L('حذف', 'Delete'), okClass: 'btn-danger' })) { try { await deleteTodo(x); } catch (ex) { toastErr(ex); } } return; }
    const nt = e.target.closest('[data-note]');
    if (nt) {
      const x = items.find(i => i.id === nt.dataset.note); if (!x) return;
      const m = modal({ title: L('تعديل المهمة', 'Edit item'), icon: 'fa-pen', size: 'narrow', body: `<div class="col gap-12"><div class="field"><label>${L('المهمة', 'Item')}</label><input class="input" id="e-t" maxlength="500" value="${esc(x.text)}"></div><div class="field"><label>${L('ملاحظة', 'Note')}</label><textarea class="textarea" id="e-n" maxlength="1000">${esc(x.note || '')}</textarea></div></div>`, foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="e-s">${L('حفظ', 'Save')}</button>` });
      m.$('#e-s').onclick = (ev) => busy(ev.currentTarget, async () => { try { await editTodo(x, { text: m.$('#e-t').value, note: m.$('#e-n').value }); m.close(); } catch (ex) { toastErr(ex); } });
      return;
    }
    if (e.target.closest('#carry-go')) { const left = items.filter(x => !x.done && x.date < today()); try { await moveTodos(left, today()); toast(L(`اتنقل ${left.length} للنهارده`, `${left.length} moved to today`)); } catch (ex) { toastErr(ex); } }
  });
  root.addEventListener('change', async (e) => {
    if (e.target.id === 'day') setDay(e.target.value);
    if (e.target.id === 'who') location.hash = e.target.value === session.email ? '#/todo' : `#/todo/${encodeURIComponent(e.target.value)}`;
    const tg = e.target.closest('[data-tg]'); if (tg) { const x = items.find(i => i.id === tg.dataset.tg); if (x) try { await toggleTodo(x); } catch (ex) { toastErr(ex); tg.checked = !tg.checked; } }
  });
  const form = $('#add');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#add-t').value.trim(), t = taskById($('#add-k').value);
    if (!text && !t) { $('#add-t').focus(); return; }
    try { await addTodo(day, text || t.title, t); $('#add-t').value = ''; $('#add-k').value = ''; $('#add-t').focus(); } catch (ex) { toastErr(ex); }
  };
  subscribe(); draw();
  const off1 = onTasks(draw), off2 = onDirectory(draw);
  return () => { un && un(); off1(); off2(); };
}
