// The tasks area at the top of a group chat: three coloured lanes (New / In progress / Finished) with my tasks
// (a leader sees the tasks they gave), the leader's "New task" dialog, and the task details.
import { L, esc, fmtDate, fmtTime, ymd, debounce } from '../core/utils.js';
import { toast, toastErr, avatar, modal, busy, confirmDialog } from '../core/ui.js';
import { session, now } from '../core/session.js';
import { person, nameOf } from '../services/directory.js';
import { toMs } from '../core/fb.js';
import {
  TASK_STATUS, TASK_ORDER, watchTasks, assignableIn, canCreateTasks, isTaskLeader, canMove, createTasks, moveTask, editTask, deleteTask, isLate, doneAtMs
} from '../services/tasks.js';

const LS_OPEN = 'am_tasks_open';
const FINISHED_SHOWN = 3;
const who = (e) => person(e) || { email: e, name: nameOf(e) };
const first = (e) => String(nameOf(e) || '').split(' ')[0];
const dueText = (t) => {
  if (!t.due) return '';
  if (isLate(t)) { const d = Math.round((new Date(ymd(now())) - new Date(t.due)) / 86400000); return `<span class="ct-late"><i class="fas fa-triangle-exclamation"></i> ${L(`متأخر ${d === 1 ? 'يوم' : d === 2 ? 'يومين' : d + ' أيام'}`, `${d} day${d > 1 ? 's' : ''} late`)}</span>`; }
  return `<span><i class="far fa-calendar"></i> ${esc(t.due === ymd(now()) ? L('النهارده', 'Today') : fmtDate(t.due))}</span>`;
};
const statusBadge = (s) => `<span class="ct-badge ${TASK_STATUS[s].cls}">${TASK_STATUS[s].label}</span>`;
const stamp = (ms) => ms ? esc(ymd(ms) === ymd(now()) ? fmtTime(ms) : `${fmtDate(ymd(ms))} ${fmtTime(ms)}`) : '';

/**
 * host: an empty element in the thread. getChat() → the open group; getMsgs() → loaded messages;
 * jumpTo(messageId) scrolls the chat to a message.
 */
export function mountTasks(host, { getChat, getMsgs, jumpTo }) {
  let tasks = [], filter = '', pendingOpen = '', un = null;
  let open = (() => { try { const v = localStorage.getItem(LS_OPEN); return v == null ? window.innerWidth > 900 : v === '1'; } catch { return true; } })();

  function start(chat) {
    if (un) { un(); un = null; }
    tasks = []; filter = '';
    draw();
    un = watchTasks(chat.id, rows => {
      tasks = rows; draw();
      if (pendingOpen) { const t = tasks.find(x => x.id === pendingOpen); if (t) { pendingOpen = ''; details(t); } }
    });
  }

  const visible = () => tasks.filter(t => !filter || (filter === '__me' ? t.assignee === session.email : t.assignee === filter));
  function card(t) {
    const mineToDo = t.assignee === session.email;
    const meta = mineToDo
      ? `<span>${L('من', 'From')} ${esc(first(t.leader))}</span>`
      : `<span class="ct-who">${avatar(who(t.assignee), 'xs')}${esc(first(t.assignee))}</span>`;
    let btns = '';
    if (t.status === 'done') {
      btns = isTaskLeader(t) ? `<button class="ct-btn back" data-mv="in_progress" data-t="${esc(t.id)}"><i class="fas fa-rotate-left"></i> ${L('رجّعه In progress', 'Back to In progress')}</button>`
        : `<span class="ct-doneat"><i class="fas fa-check"></i> ${stamp(doneAtMs(t))}</span>`;
    } else if (canMove(t, 'done')) {
      btns = `<button class="ct-btn inprog ${t.status === 'in_progress' ? 'on' : ''}" data-mv="in_progress" data-t="${esc(t.id)}" ${t.status === 'in_progress' ? 'disabled' : ''}>In progress</button><button class="ct-btn done" data-mv="done" data-t="${esc(t.id)}">Finished</button>`;
    }
    return `<div class="ct-card ${isLate(t) ? 'late' : ''}" data-open="${esc(t.id)}">
      <b class="ct-title"><span class="num">#${t.num}</span> ${esc(t.title)}</b>
      <div class="ct-meta">${meta}${dueText(t)}${t.status === 'done' && t.doneNote ? `<span title="${esc(t.doneNote)}"><i class="far fa-comment"></i></span>` : ''}</div>
      ${btns ? `<div class="ct-btns">${btns}</div>` : ''}</div>`;
  }
  function draw() {
    const chat = getChat();
    if (!chat) { host.innerHTML = ''; return; }
    const can = canCreateTasks(chat);
    if (!tasks.length && !can) { host.innerHTML = ''; host.classList.add('hidden'); return; }
    host.classList.remove('hidden');
    const rows = visible();
    const by = (s) => rows.filter(t => t.status === s);
    const lanes = TASK_ORDER.map(s => {
      let list = by(s);
      if (s === 'done') list = list.sort((a, b) => doneAtMs(b) - doneAtMs(a));
      else list = list.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.num - b.num);
      const shown = s === 'done' ? list.slice(0, FINISHED_SHOWN) : list;
      return `<div class="ct-lane ${TASK_STATUS[s].cls}"><div class="ct-lane-head">${TASK_STATUS[s].label} <span class="num">${list.length}</span></div>
        <div class="ct-lane-body">${shown.map(card).join('') || `<div class="ct-none">${L('مفيش', 'None')}</div>`}
        ${list.length > shown.length ? `<button class="ct-more" data-allfinished>+${list.length - shown.length} ${L('كمان', 'more')}</button>` : ''}</div></div>`;
    }).join('');
    const counts = TASK_ORDER.map(s => `<span class="ct-dot ${TASK_STATUS[s].cls}"></span>${by(s).length}`).join(' ');
    const people = [...new Set(tasks.map(t => t.assignee))];
    const showFilter = people.length > 1 || (people.length === 1 && people[0] !== session.email && tasks.some(t => t.assignee === session.email));
    host.innerHTML = `
      <div class="ct-head">
        <button class="ct-toggle" id="ct-toggle" aria-expanded="${open}"><i class="fas fa-chevron-${open ? 'up' : 'down'}"></i> <b>${L('التاسكات', 'Tasks')}</b> <span class="ct-counts num">${counts}</span></button>
        <div class="row gap-8">
          ${showFilter ? `<select class="select select-sm" id="ct-filter"><option value="">${L('كل الموظفين', 'Everyone')}</option>${tasks.some(t => t.assignee === session.email) ? `<option value="__me" ${filter === '__me' ? 'selected' : ''}>${L('تاسكاتي أنا', 'My tasks')}</option>` : ''}${people.filter(e => e !== session.email).sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'ar')).map(e => `<option value="${esc(e)}" ${filter === e ? 'selected' : ''}>${esc(nameOf(e))}</option>`).join('')}</select>` : ''}
          ${can ? `<button class="btn btn-primary btn-sm" id="ct-new"><i class="fas fa-plus"></i> ${L('تاسك جديد', 'New task')}</button>` : ''}
        </div>
      </div>
      ${open ? `<div class="ct-lanes">${lanes}</div>` : ''}`;
  }

  host.addEventListener('change', (e) => { if (e.target.id === 'ct-filter') { filter = e.target.value; draw(); } });
  host.addEventListener('click', async (e) => {
    if (e.target.closest('#ct-toggle')) { open = !open; try { localStorage.setItem(LS_OPEN, open ? '1' : '0'); } catch {} draw(); return; }
    if (e.target.closest('#ct-new')) { editor(null); return; }
    if (e.target.closest('[data-allfinished]')) { allFinished(); return; }
    const mv = e.target.closest('[data-mv]');
    if (mv) { e.stopPropagation(); const t = tasks.find(x => x.id === mv.dataset.t); if (t) move(t, mv.dataset.mv, mv); return; }
    const c = e.target.closest('[data-open]');
    if (c) { const t = tasks.find(x => x.id === c.dataset.open); if (t) details(t); }
  });

  /** status change, asking for the delivery note (→ Finished) or the reason (Finished → back) */
  async function move(t, to, btn) {
    let note = '';
    if (to === 'done') {
      note = await confirmDialog({ title: L(`إنهاء #${t.num}`, `Finish #${t.num}`), message: t.title, okText: 'Finished', okClass: 'btn-success', input: { label: L('ملاحظة التسليم (اختياري)', 'Delivery note (optional)'), placeholder: L('مثلاً: اتصلت بالـ 12 عميل، 4 مهتمين', 'e.g. called all 12 clients, 4 interested') } });
      if (note === null) return false;
    } else if (t.status === 'done') {
      note = await confirmDialog({ title: L(`رجوع #${t.num} لـ In progress`, `Send #${t.num} back`), message: t.title, okText: L('رجّعه', 'Send back'), okClass: 'btn-danger', input: { label: L('سبب الإرجاع', 'Reason'), required: true } });
      if (!note) return false;
    }
    try { await busy(btn, () => moveTask(getChat(), t, to, note)); toast(`#${t.num} → ${TASK_STATUS[to].label}`); return true; }
    catch (ex) { toastErr(ex); return false; }
  }

  // ---------- leader: new task / edit ----------
  function editor(t) {
    const chat = getChat();
    const isNew = !t;
    const people = isNew ? assignableIn(chat) : [];
    const picked = new Set();
    const m = modal({
      title: isNew ? L('تاسك جديد', 'New task') : L(`تعديل #${t.num}`, `Edit #${t.num}`), icon: 'fa-list-check', size: 'narrow',
      body: `<div class="col gap-12">
        <div class="field"><label>${L('اسم التاسك', 'Task name')} *</label><input class="input" id="tk-title" maxlength="200" value="${esc(t ? t.title : '')}"></div>
        ${isNew ? `<div class="field"><label>${L('الموظف', 'Employee')} *</label>
          <div class="ct-pick"><button type="button" class="input ct-pick-btn" id="tk-who"><span id="tk-who-t" class="muted">${L('اختار موظف أو أكتر…', 'Pick one or more…')}</span><i class="fas fa-chevron-down"></i></button>
            <div class="ct-dd hidden" id="tk-dd"><div class="search"><i class="fas fa-search"></i><input class="input" id="tk-q" placeholder="${L('ابحث بالاسم', 'Search by name')}"></div><div class="ct-dd-list" id="tk-list"></div></div></div>
          <small class="xs muted">${L('لو اخترت أكتر من موظف، كل واحد هياخد نسخة منفصلة من التاسك بحالتها.', 'Choosing several employees gives each one a separate copy with its own status.')}</small></div>` : ''}
        <div class="field"><label>${L('تفاصيل', 'Details')} <span class="muted">(${L('اختياري', 'optional')})</span></label><textarea class="textarea" id="tk-details" maxlength="4000" style="min-height:80px">${esc(t ? t.details || '' : '')}</textarea></div>
        <div class="field"><label>${L('ميعاد التسليم', 'Due date')} <span class="muted">(${L('اختياري', 'optional')})</span></label><input class="input" type="date" id="tk-due" min="${isNew ? ymd(now()) : ''}" value="${esc(t ? t.due || '' : '')}"></div>
      </div>`,
      foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="tk-save"><i class="fas fa-${isNew ? 'plus' : 'floppy-disk'}"></i> ${isNew ? L('إنشاء التاسك', 'Create task') : L('حفظ', 'Save')}</button>`
    });
    if (isNew) {
      const drawList = () => {
        const q = m.$('#tk-q').value.trim().toLowerCase();
        m.$('#tk-list').innerHTML = people.filter(p => !q || `${p.name} ${p.title} ${p.email}`.toLowerCase().includes(q))
          .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'))
          .map(p => `<label class="ct-dd-row"><input type="checkbox" data-pick="${esc(p.email)}" ${picked.has(p.email) ? 'checked' : ''}>${avatar(p, 'sm')}<span class="min0"><b class="truncate">${esc(p.name || p.email)}</b><small class="truncate">${esc(p.title || '')}</small></span></label>`).join('')
          || `<div class="muted small" style="padding:10px">${L('مفيش نتائج', 'No results')}</div>`;
      };
      const label = () => { const el = m.$('#tk-who-t'); el.classList.toggle('muted', !picked.size); el.innerHTML = picked.size ? [...picked].map(e => `<span class="ct-chip">${avatar(who(e), 'xs')}${esc(nameOf(e))}</span>`).join('') : L('اختار موظف أو أكتر…', 'Pick one or more…'); };
      m.$('#tk-who').onclick = () => { const dd = m.$('#tk-dd'); dd.classList.toggle('hidden'); if (!dd.classList.contains('hidden')) { drawList(); m.$('#tk-q').focus(); } };
      m.$('#tk-q').oninput = debounce(drawList, 100);
      m.$('#tk-list').onchange = (e) => { const c = e.target.closest('[data-pick]'); if (!c) return; if (c.checked) picked.add(c.dataset.pick); else picked.delete(c.dataset.pick); label(); };
      m.el.addEventListener('mousedown', (e) => { if (!e.target.closest('.ct-pick')) m.$('#tk-dd').classList.add('hidden'); });
      if (people.length === 1) { picked.add(people[0].email); label(); }
    }
    m.$('#tk-save').onclick = (e) => busy(e.currentTarget, async () => {
      const f = { title: m.$('#tk-title').value, details: m.$('#tk-details').value, due: m.$('#tk-due').value };
      if (!f.title.trim()) { m.$('#tk-title').focus(); return; }
      if (isNew && !picked.size) { toast(L('اختار الموظف', 'Pick the employee'), '', 'warn'); m.$('#tk-dd').classList.remove('hidden'); return; }
      try {
        if (isNew) { const made = await createTasks(chat, { ...f, assignees: [...picked] }); m.close(); toast(made.length > 1 ? L(`اتعمل ${made.length} تاسك`, `${made.length} tasks created`) : L(`اتعمل التاسك #${made[0].num}`, `Task #${made[0].num} created`)); }
        else { await editTask(chat, t, f); m.close(); toast(L('اتحفظ', 'Saved')); }
      } catch (ex) { toastErr(ex); }
    });
  }

  // ---------- details ----------
  function details(t) {
    const chat = getChat();
    const refs = (getMsgs() || []).filter(x => !x.deleted && (x.tasks || []).some(r => r.id === t.id));
    const hist = (t.history || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    const histTxt = (h) => !h.from ? L('عمل التاسك', 'created the task') : (h.from === 'done' ? L(`رجّعه ${TASK_STATUS[h.to].label}`, `sent it back to ${TASK_STATUS[h.to].label}`) : L(`غيّره لـ ${TASK_STATUS[h.to].label}`, `moved it to ${TASK_STATUS[h.to].label}`));
    const btns = t.status === 'done' ? (isTaskLeader(t) ? `<button class="btn" data-dmv="in_progress"><i class="fas fa-rotate-left"></i> ${L('رجّعه In progress', 'Back to In progress')}</button>` : '')
      : `${canMove(t, 'in_progress') ? `<button class="btn" data-dmv="in_progress">In progress</button>` : ''}${canMove(t, 'done') ? `<button class="btn btn-success" data-dmv="done">Finished</button>` : ''}`;
    const m = modal({
      title: `#${t.num} ${t.title}`, icon: 'fa-list-check',
      body: `<div class="col gap-12">
        <div class="row gap-8 wrap">${statusBadge(t.status)}${isLate(t) ? dueText(t) : ''}</div>
        <div class="ct-info">
          <div><small>${L('مسند لـ', 'Assigned to')}</small><span class="ct-who">${avatar(who(t.assignee), 'xs')}${esc(nameOf(t.assignee))}</span></div>
          <div><small>${L('من', 'From')}</small><span class="ct-who">${avatar(who(t.leader), 'xs')}${esc(nameOf(t.leader))}</span></div>
          <div><small>${L('التسليم', 'Due')}</small><span>${t.due ? esc(fmtDate(t.due)) : '—'}</span></div>
          <div><small>${L('اتعمل', 'Created')}</small><span>${stamp(toMs(t.createdAt))}</span></div>
        </div>
        ${t.details ? `<div class="ct-details">${esc(t.details)}</div>` : ''}
        ${t.status === 'done' && t.doneNote ? `<div class="ct-note ok"><b>${L('ملاحظة التسليم', 'Delivery note')}</b>${esc(t.doneNote)}</div>` : ''}
        ${t.status !== 'done' && t.returnReason ? `<div class="ct-note bad"><b>${L('سبب الإرجاع', 'Sent back because')}</b>${esc(t.returnReason)}</div>` : ''}
        <div><div class="label mb-8">${L('السجل', 'History')}</div><div class="ct-hist">${hist.map(h => `<div><span class="ct-dot ${TASK_STATUS[h.to] ? TASK_STATUS[h.to].cls : ''}"></span><span class="grow"><b>${esc(nameOf(h.by))}</b> ${histTxt(h)}${h.note ? `<small>${esc(h.note)}</small>` : ''}</span><small class="num">${stamp(h.at)}</small></div>`).join('')}</div></div>
        <div><div class="label mb-8">${L('الرسايل اللي اتكلمت عنه', 'Messages about it')} (${refs.length})</div>
          ${refs.length ? `<div class="ct-refs">${refs.slice(-20).map(x => `<button class="ct-ref" data-jump="${esc(x.id)}"><b>${esc(nameOf(x.by))}</b><span class="truncate">${esc(x.text || '')}</span><small class="num">${stamp(toMs(x.at))}</small></button>`).join('')}</div>` : `<p class="muted small">${L('لسه محدش عمل منشن للتاسك ده. اكتب #', 'Nobody has mentioned this task yet. Type #')}${t.num} ${L('في الشات.', 'in the chat.')}</p>`}</div>
      </div>`,
      foot: `${isTaskLeader(t) ? `<button class="btn btn-ghost" id="td-del" style="color:var(--bad)"><i class="fas fa-trash"></i></button><button class="btn btn-ghost" id="td-edit"><i class="fas fa-pen"></i> ${L('تعديل', 'Edit')}</button>` : ''}<span class="grow"></span>${btns}<button class="btn" data-close>${L('إغلاق', 'Close')}</button>`
    });
    m.$$('[data-dmv]').forEach(b => b.onclick = async () => { if (await move(t, b.dataset.dmv, b)) m.close(); });
    m.$$('[data-jump]').forEach(b => b.onclick = () => { m.close(); jumpTo(b.dataset.jump); });
    const ed = m.$('#td-edit'); if (ed) ed.onclick = () => { m.close(); editor(t); };
    const del = m.$('#td-del'); if (del) del.onclick = async () => {
      const ok = await confirmDialog({ title: L(`حذف #${t.num}`, `Delete #${t.num}`), message: L('التاسك هيتمسح نهائي عند الموظف وعندك.', 'The task is removed for good, for you and the employee.'), okText: L('حذف', 'Delete'), okClass: 'btn-danger' });
      if (!ok) return;
      try { await deleteTask(chat, t); m.close(); toast(L('اتمسح', 'Deleted')); } catch (ex) { toastErr(ex); }
    };
  }

  function allFinished() {
    const list = visible().filter(t => t.status === 'done').sort((a, b) => doneAtMs(b) - doneAtMs(a));
    const m = modal({ title: L(`التاسكات المنتهية (${list.length})`, `Finished tasks (${list.length})`), icon: 'fa-circle-check', size: 'narrow', body: `<div class="ct-lane done ct-lane-all"><div class="ct-lane-body">${list.map(card).join('')}</div></div>`, foot: `<button class="btn btn-primary" data-close>${L('تمام', 'OK')}</button>` });
    m.el.addEventListener('click', async (e) => {
      const mv = e.target.closest('[data-mv]');
      if (mv) { e.stopPropagation(); const t = tasks.find(x => x.id === mv.dataset.t); if (t && await move(t, mv.dataset.mv, mv)) m.close(); return; }
      const c = e.target.closest('[data-open]'); if (c) { const t = tasks.find(x => x.id === c.dataset.open); if (t) { m.close(); details(t); } }
    });
  }

  return {
    start,
    redraw: draw,
    list: () => tasks,
    open(id) { const t = tasks.find(x => x.id === id); if (t) details(t); else pendingOpen = id; },
    destroy() { if (un) { un(); un = null; } host.innerHTML = ''; }
  };
}
