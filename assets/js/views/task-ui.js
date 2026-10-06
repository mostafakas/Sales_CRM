// Building blocks of the Tasks page: the task card, the create / edit window, the status-change dialog and the
// task details (checklist, comments with @mentions and files, history).
import { L, esc, fmtDate, fmtTime, ymd, debounce } from '../core/utils.js';
import { toast, toastErr, avatar, modal, busy, confirmDialog } from '../core/ui.js';
import { session, now } from '../core/session.js';
import { toMs } from '../core/fb.js';
import { person, nameOf } from '../services/directory.js';
import {
  STATUS, ORDER, PRIORITY, isLate, canManage, canEdit, canDelete, canMove, needsReason, assignable, allProjects, projectById, taskById,
  createTasks, editTask, moveTask, toggleCheck, deleteTask, watchComments, addComment, deleteComment, uploadFile, loadFile, MAX_FILE
} from '../services/tasks.js';

export const who = (e) => person(e) || { email: e, name: nameOf(e) };
const first = (e) => String(nameOf(e) || '').split(' ')[0];
export const stamp = (ms) => ms ? esc(ymd(ms) === ymd(now()) ? fmtTime(ms) : `${fmtDate(ymd(ms))} ${fmtTime(ms)}`) : '';
export const statusBadge = (s) => `<span class="tk-badge ${STATUS[s].cls}"><i class="fas ${STATUS[s].icon}"></i>${STATUS[s].label}</span>`;
export const prioBadge = (p) => p && p !== 'normal' ? `<span class="badge ${PRIORITY[p].cls}">${esc(L(PRIORITY[p].ar, PRIORITY[p].en))}</span>` : '';
export function dueText(t) {
  if (!t.due) return '';
  if (isLate(t)) { const d = Math.max(1, Math.round((new Date(ymd(now())) - new Date(t.due)) / 86400000)); return `<span class="tk-late"><i class="fas fa-triangle-exclamation"></i> ${L(`متأخر ${d === 1 ? 'يوم' : d === 2 ? 'يومين' : d + ' أيام'}`, `${d}d late`)}</span>`; }
  return `<span><i class="far fa-calendar"></i> ${esc(t.due === ymd(now()) ? L('النهارده', 'Today') : fmtDate(t.due))}</span>`;
}
const checkProgress = (t) => { const c = t.checklist || []; return c.length ? { done: c.filter(x => x.done).length, all: c.length } : null; };

/** a task card (board / lists) */
export function card(t, { draggable = false } = {}) {
  const cp = checkProgress(t);
  const p = t.projectId ? projectById(t.projectId) : null;
  return `<div class="tk-card ${isLate(t) ? 'late' : ''} pr-${t.priority || 'normal'}" data-open="${esc(t.id)}" ${draggable ? 'draggable="true"' : ''}>
    <div class="tk-card-top"><span class="tk-num num">#${t.num}</span>${prioBadge(t.priority)}${t.projectName ? `<span class="tk-proj" style="--pc:${esc((p && p.color) || '#1b1bdb')}">${esc(t.projectName)}</span>` : ''}</div>
    <b class="tk-title">${esc(t.title)}</b>
    ${cp ? `<div class="tk-cl"><div class="tk-bar"><span style="width:${Math.round(cp.done / cp.all * 100)}%"></span></div><small class="num">${cp.done}/${cp.all}</small></div>` : ''}
    <div class="tk-meta"><span class="tk-who">${avatar(who(t.assignee), 'xs')}${esc(first(t.assignee))}</span>${dueText(t)}
      ${t.commentsCount ? `<span><i class="far fa-comment"></i> ${t.commentsCount}</span>` : ''}
      ${t.status === 'done' && t.doneAt ? `<span class="tk-doneat"><i class="fas fa-check"></i> ${stamp(toMs(t.doneAt))}</span>` : ''}</div></div>`;
}

/** status change with the note / reason it needs. Resolves true when moved. */
export async function move(t, to) {
  let note = '';
  if (to === 'done') {
    note = await confirmDialog({ title: L(`إنهاء #${t.num}`, `Finish #${t.num}`), message: t.title, okText: 'Finished', okClass: 'btn-success', input: { label: L('ملاحظة التسليم (اختياري)', 'Delivery note (optional)') } });
    if (note === null) return false;
  } else if (to === 'review') {
    note = await confirmDialog({ title: L(`تسليم #${t.num} للمراجعة`, `Hand #${t.num} in for review`), message: t.title, okText: L('سلّم للمراجعة', 'Hand in'), input: { label: L('ملاحظة لليدر (اختياري)', 'Note for the leader (optional)') } });
    if (note === null) return false;
  } else if (needsReason(t, to)) {
    note = await confirmDialog({ title: to === 'hold' ? L(`إيقاف #${t.num}`, `Put #${t.num} on hold`) : L(`رجوع #${t.num}`, `Send #${t.num} back`), message: t.title, okText: to === 'hold' ? 'On hold' : L('رجّعه', 'Send back'), okClass: to === 'hold' ? 'btn-primary' : 'btn-danger', input: { label: to === 'hold' ? L('سبب الإيقاف', 'Why is it on hold?') : L('سبب الإرجاع', 'Why is it sent back?'), required: true } });
    if (!note) return false;
  }
  try { await moveTask(t, to, note); toast(`#${t.num} → ${STATUS[to].label}`); return true; } catch (ex) { toastErr(ex); return false; }
}

/** create (t = null; preset = { projectId, assignee }) or edit a task */
export function editor(t, preset = {}) {
  const isNew = !t;
  const people = assignable();
  const picked = new Set(isNew ? (preset.assignee ? [preset.assignee] : (people.length === 1 ? [people[0].email] : [])) : [t.assignee]);
  let checklist = t ? (t.checklist || []).map(x => ({ ...x })) : [];
  const reassign = !isNew && canManage(t);
  const m = modal({
    title: isNew ? L('تاسك جديد', 'New task') : L(`تعديل #${t.num}`, `Edit #${t.num}`), icon: 'fa-list-check',
    body: `<div class="col gap-12">
      <div class="field"><label>${L('اسم التاسك', 'Task name')} *</label><input class="input" id="tk-title" maxlength="200" value="${esc(t ? t.title : '')}"></div>
      ${isNew || reassign ? `<div class="field"><label>${isNew ? L('الموظف', 'Employee') : L('مسند لـ', 'Assigned to')} *</label>
        <div class="ct-pick"><button type="button" class="input ct-pick-btn" id="tk-who"><span id="tk-who-t"></span><i class="fas fa-chevron-down"></i></button>
          <div class="ct-dd hidden" id="tk-dd"><div class="search"><i class="fas fa-search"></i><input class="input" id="tk-q" placeholder="${L('ابحث بالاسم', 'Search by name')}"></div><div class="ct-dd-list" id="tk-list"></div></div></div>
        ${isNew ? `<small class="xs muted">${L('لو اخترت أكتر من موظف، كل واحد بياخد نسخة منفصلة بحالتها.', 'Several employees → each gets a separate copy with its own status.')}</small>` : ''}</div>` : ''}
      <div class="form-grid">
        <div class="field"><label>${L('المشروع', 'Project')}</label><select class="select" id="tk-proj"><option value="">${L('بدون مشروع', 'No project')}</option>${allProjects().filter(p => p.status !== 'done' || (t && t.projectId === p.id)).map(p => `<option value="${esc(p.id)}" ${(t ? t.projectId : preset.projectId) === p.id ? 'selected' : ''}>${esc(p.name)}${p.clientName ? ` — ${esc(p.clientName)}` : ''}</option>`).join('')}</select></div>
        <div class="field"><label>${L('الأولوية', 'Priority')}</label><select class="select" id="tk-pr">${Object.entries(PRIORITY).map(([k, v]) => `<option value="${k}" ${(t ? t.priority : 'normal') === k ? 'selected' : ''}>${esc(L(v.ar, v.en))}</option>`).join('')}</select></div>
        <div class="field"><label>${L('ميعاد التسليم', 'Due date')}</label><input class="input" type="date" id="tk-due" value="${esc(t ? t.due || '' : '')}"></div>
      </div>
      <div class="field"><label>${L('التفاصيل', 'Details')}</label><textarea class="textarea" id="tk-details" maxlength="6000" style="min-height:90px">${esc(t ? t.details || '' : '')}</textarea></div>
      <div class="field"><label>${L('خطوات التاسك (Checklist)', 'Checklist')}</label><div id="tk-cl" class="tk-cl-edit"></div>
        <div class="row gap-8 mt-8"><input class="input" id="tk-cl-new" maxlength="300" placeholder="${L('اكتب خطوة واضغط Enter', 'Type a step and press Enter')}"><button class="btn" type="button" id="tk-cl-add"><i class="fas fa-plus"></i></button></div></div>
    </div>`,
    foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="tk-save"><i class="fas fa-${isNew ? 'plus' : 'floppy-disk'}"></i> ${isNew ? L('إنشاء التاسك', 'Create task') : L('حفظ', 'Save')}</button>`
  });
  const drawCl = () => {
    m.$('#tk-cl').innerHTML = checklist.map((x, i) => `<div class="tk-cl-row"><i class="far ${x.done ? 'fa-square-check' : 'fa-square'}"></i><span class="grow">${esc(x.text)}</span><button type="button" class="btn btn-ghost btn-icon btn-sm" data-rm="${i}"><i class="fas fa-xmark"></i></button></div>`).join('') || `<p class="xs muted">${L('مفيش خطوات — اختياري.', 'No steps — optional.')}</p>`;
  };
  const addStep = () => { const v = m.$('#tk-cl-new').value.trim(); if (!v) return; checklist.push({ id: Math.random().toString(36).slice(2, 9), text: v, done: false }); m.$('#tk-cl-new').value = ''; drawCl(); };
  m.$('#tk-cl-add').onclick = addStep;
  m.$('#tk-cl-new').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addStep(); } };
  m.$('#tk-cl').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { checklist.splice(Number(b.dataset.rm), 1); drawCl(); } };
  drawCl();
  if (m.$('#tk-who')) {
    const single = !isNew;
    const label = () => { const el = m.$('#tk-who-t'); el.innerHTML = picked.size ? [...picked].map(e => `<span class="ct-chip">${avatar(who(e), 'xs')}${esc(nameOf(e))}</span>`).join('') : `<span class="muted">${L('اختار موظف…', 'Pick an employee…')}</span>`; };
    const drawList = () => {
      const q = m.$('#tk-q').value.trim().toLowerCase();
      m.$('#tk-list').innerHTML = people.filter(p => !q || `${p.name} ${p.title} ${p.department} ${p.email}`.toLowerCase().includes(q))
        .map(p => `<label class="ct-dd-row"><input type="${single ? 'radio' : 'checkbox'}" name="tkp" data-pick="${esc(p.email)}" ${picked.has(p.email) ? 'checked' : ''}>${avatar(p, 'sm')}<span class="min0"><b class="truncate">${esc(p.name || p.email)}${p.email === session.email ? ` <span class="muted">(${L('أنا', 'me')})</span>` : ''}</b><small class="truncate">${esc(p.title || '')}${p.department ? ' · ' + esc(p.department) : ''}</small></span></label>`).join('')
        || `<div class="muted small" style="padding:10px">${L('مفيش نتائج', 'No results')}</div>`;
    };
    m.$('#tk-who').onclick = () => { const dd = m.$('#tk-dd'); dd.classList.toggle('hidden'); if (!dd.classList.contains('hidden')) { drawList(); m.$('#tk-q').focus(); } };
    m.$('#tk-q').oninput = debounce(drawList, 100);
    m.$('#tk-list').onchange = (e) => { const c = e.target.closest('[data-pick]'); if (!c) return; if (single) { picked.clear(); picked.add(c.dataset.pick); m.$('#tk-dd').classList.add('hidden'); } else if (c.checked) picked.add(c.dataset.pick); else picked.delete(c.dataset.pick); label(); };
    m.el.addEventListener('mousedown', (e) => { if (!e.target.closest('.ct-pick')) m.$('#tk-dd').classList.add('hidden'); });
    label();
  }
  m.$('#tk-save').onclick = (e) => busy(e.currentTarget, async () => {
    const f = { title: m.$('#tk-title').value, details: m.$('#tk-details').value, due: m.$('#tk-due').value, priority: m.$('#tk-pr').value, projectId: m.$('#tk-proj').value, checklist };
    if (!f.title.trim()) { m.$('#tk-title').focus(); return; }
    if ((isNew || reassign) && !picked.size) { toast(L('اختار الموظف', 'Pick the employee'), '', 'warn'); m.$('#tk-dd').classList.remove('hidden'); return; }
    try {
      if (isNew) { const made = await createTasks(f, [...picked]); m.close(); toast(made.length > 1 ? L(`اتعمل ${made.length} تاسك`, `${made.length} tasks created`) : L(`اتعمل التاسك #${made[0].num}`, `Task #${made[0].num} created`)); }
      else { await editTask(t, { ...f, ...(reassign ? { assignee: [...picked][0] } : {}) }); m.close(); toast(L('اتحفظ', 'Saved')); }
    } catch (ex) { toastErr(ex); }
  });
}

const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const histText = (h) => {
  if (!h.from) return L('عمل التاسك', 'created the task');
  if (h.from === h.to) return esc(h.note || '');
  const back = (h.from === 'review' || h.from === 'done') && (h.to === 'in_progress' || h.to === 'new');
  return back ? L(`رجّعه ${STATUS[h.to].label}`, `sent it back to ${STATUS[h.to].label}`) : L(`غيّره لـ ${STATUS[h.to].label}`, `moved it to ${STATUS[h.to].label}`);
};

/** task details: everything about one task, live */
export function details(id) {
  let t = taskById(id);
  if (!t) { toast(L('التاسك مش متاح ليك', 'This task is not available to you'), '', 'warn'); return; }
  let comments = [], unC = null;
  const m = modal({ title: `#${t.num} ${t.title}`, icon: 'fa-list-check', size: 'wide', body: '<div id="td"></div>', foot: '<div id="tdf" class="row gap-8 grow wrap"></div>' });
  const draw = () => {
    t = taskById(id) || t;
    const cp = (t.checklist || []);
    const canTick = canEdit(t) || t.assignee === session.email;
    const hist = (t.history || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    m.$('#td').innerHTML = `<div class="tk-detail">
      <div class="tk-d-main">
        <div class="row gap-8 wrap mb-8">${statusBadge(t.status)}${prioBadge(t.priority)}${isLate(t) ? dueText(t) : ''}</div>
        ${t.details ? `<div class="tk-d-text">${linkify(t.details)}</div>` : `<p class="muted small">${L('مفيش تفاصيل.', 'No details.')}</p>`}
        ${t.status === 'done' && t.doneNote ? `<div class="ct-note ok"><b>${L('ملاحظة التسليم', 'Delivery note')}</b>${esc(t.doneNote)}</div>` : ''}
        ${t.status === 'hold' && t.holdReason ? `<div class="ct-note warn"><b>${L('سبب الإيقاف', 'On hold because')}</b>${esc(t.holdReason)}</div>` : ''}
        ${t.status !== 'done' && t.returnReason ? `<div class="ct-note bad"><b>${L('آخر سبب إرجاع', 'Last sent back because')}</b>${esc(t.returnReason)}</div>` : ''}
        ${cp.length ? `<div><div class="label mb-8">${L('الخطوات', 'Checklist')} <span class="num muted">${cp.filter(x => x.done).length}/${cp.length}</span></div>
          <div class="tk-checks">${cp.map(x => `<label class="tk-check ${x.done ? 'done' : ''}"><input type="checkbox" data-ck="${esc(x.id)}" ${x.done ? 'checked' : ''} ${canTick ? '' : 'disabled'}><span>${esc(x.text)}</span></label>`).join('')}</div></div>` : ''}
        <div><div class="label mb-8">${L('التعليقات', 'Comments')} <span class="num muted">${comments.length || ''}</span></div>
          <div class="tk-comments" id="tk-cm">${comments.map(c => { const p = who(c.by); return `<div class="tk-c">${avatar(p, 'sm')}<div class="grow min0"><div class="row between gap-8"><b>${esc(p.name || p.email)}</b><small class="muted num">${stamp(toMs(c.at))}${c.by === session.email ? ` <button class="tk-c-x" data-cdel="${esc(c.id)}" title="${L('حذف', 'Delete')}"><i class="fas fa-trash"></i></button>` : ''}</small></div>
            ${c.text ? `<div class="tk-c-text">${linkify(c.text).replace(/@([^\s@]+(?: [^\s@]+)?)/g, (s) => `<span class="chat-mention">${s}</span>`)}</div>` : ''}
            ${c.file ? `<button class="chat-file" data-file='${esc(JSON.stringify(c.file))}'><i class="fas fa-paperclip"></i><span class="min0 grow"><b class="truncate">${esc(c.file.name)}</b><small>${Math.max(1, Math.round((c.file.size || 0) / 1024))} KB</small></span><i class="fas fa-download"></i></button>` : ''}</div></div>`; }).join('') || `<p class="muted small">${L('لسه مفيش تعليقات.', 'No comments yet.')}</p>`}</div>
          <div class="tk-c-new"><textarea class="textarea" id="tk-cmt" maxlength="3000" placeholder="${L('اكتب تعليق… @ لمنشن', 'Write a comment… @ to mention')}"></textarea>
            <div class="row gap-8"><label class="btn btn-sm"><i class="fas fa-paperclip"></i> ${L('ملف', 'File')}<input type="file" hidden id="tk-file"></label><small class="muted grow" id="tk-fname"></small><button class="btn btn-primary btn-sm" id="tk-send"><i class="fas fa-paper-plane"></i> ${L('إرسال', 'Send')}</button></div></div></div>
      </div>
      <aside class="tk-d-side">
        <dl class="tk-kv">
          <dt>${L('مسند لـ', 'Assigned to')}</dt><dd class="tk-who">${avatar(who(t.assignee), 'xs')}${esc(nameOf(t.assignee))}</dd>
          <dt>${L('الليدر', 'Leader')}</dt><dd>${t.leader ? `<span class="tk-who">${avatar(who(t.leader), 'xs')}${esc(nameOf(t.leader))}</span>` : '—'}</dd>
          <dt>${L('المشروع', 'Project')}</dt><dd>${t.projectName ? `<a href="#/tasks/projects/${encodeURIComponent(t.projectId)}">${esc(t.projectName)}</a>` : '—'}</dd>
          <dt>${L('العميل', 'Client')}</dt><dd>${esc(t.clientName || '—')}</dd>
          <dt>${L('التسليم', 'Due')}</dt><dd>${t.due ? esc(fmtDate(t.due)) : '—'}</dd>
          <dt>${L('اتعمل', 'Created')}</dt><dd>${stamp(toMs(t.createdAt))} · ${esc(first(t.createdBy || ''))}</dd>
          ${t.doneAt ? `<dt>${L('خلص', 'Finished')}</dt><dd>${stamp(toMs(t.doneAt))}</dd>` : ''}
        </dl>
        <div class="label mb-8 mt-16">${L('السجل', 'History')}</div>
        <div class="ct-hist">${hist.map(h => `<div><span class="ct-dot ${STATUS[h.to] ? STATUS[h.to].cls : ''}"></span><span class="grow"><b>${esc(nameOf(h.by))}</b> ${histText(h)}${h.note && h.from !== h.to ? `<small>${esc(h.note)}</small>` : ''}</span><small class="num">${stamp(h.at)}</small></div>`).join('')}</div>
      </aside></div>`;
    const moves = ORDER.filter(s => canMove(t, s));
    m.$('#tdf').innerHTML = `${canDelete(t) ? `<button class="btn btn-ghost" id="td-del" style="color:var(--bad)"><i class="fas fa-trash"></i></button>` : ''}${canEdit(t) ? `<button class="btn btn-ghost" id="td-edit"><i class="fas fa-pen"></i> ${L('تعديل', 'Edit')}</button>` : ''}
      <span class="grow"></span>${moves.map(s => `<button class="btn ${s === 'done' ? 'btn-success' : s === 'review' ? 'btn-primary' : ''}" data-mv="${s}"><i class="fas ${STATUS[s].icon}"></i> ${STATUS[s].label}</button>`).join('')}`;
    wire();
  };
  let pendingFile = null;
  const wire = () => {
    m.$$('[data-mv]').forEach(b => b.onclick = async () => { await move(taskById(id) || t, b.dataset.mv); });
    m.$$('#td a[href^="#/"]').forEach(a => a.addEventListener('click', () => m.close()));
    const ed = m.$('#td-edit'); if (ed) ed.onclick = () => { m.close(); editor(t); };
    const dl = m.$('#td-del'); if (dl) dl.onclick = async () => { if (await confirmDialog({ title: L(`حذف #${t.num}`, `Delete #${t.num}`), message: t.title, okText: L('حذف', 'Delete'), okClass: 'btn-danger' })) { try { await deleteTask(t); m.close(); toast(L('اتمسح', 'Deleted')); } catch (ex) { toastErr(ex); } } };
    m.$$('[data-ck]').forEach(c => c.onchange = async () => { try { await toggleCheck(t, c.dataset.ck); } catch (ex) { toastErr(ex); } });
    m.$$('[data-cdel]').forEach(b => b.onclick = async () => { const c = comments.find(x => x.id === b.dataset.cdel); if (c) try { await deleteComment(t, c); } catch (ex) { toastErr(ex); } });
    m.$$('[data-file]').forEach(b => b.onclick = async () => { try { const f = JSON.parse(b.dataset.file); const url = await loadFile(f); const a = document.createElement('a'); a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); } catch (ex) { toastErr(ex); } });
    const fi = m.$('#tk-file'); if (fi) fi.onchange = () => { pendingFile = fi.files[0] || null; if (pendingFile && pendingFile.size > MAX_FILE) { toast(L('الملف أكبر من 5 ميجا', 'File over 5 MB'), '', 'bad'); pendingFile = null; } m.$('#tk-fname').textContent = pendingFile ? pendingFile.name : ''; };
    const send = m.$('#tk-send');
    if (send) send.onclick = (e) => busy(e.currentTarget, async () => {
      const text = m.$('#tk-cmt').value;
      if (!text.trim() && !pendingFile) return;
      const people = [t.assignee, t.leader, t.createdBy].filter(Boolean);
      const mentions = [...new Set(people)].filter(e2 => text.includes('@' + nameOf(e2)) || text.includes('@' + first(e2)));
      try { const file = pendingFile ? await uploadFile(t, pendingFile) : null; await addComment(t, text, { mentions, file }); pendingFile = null; } catch (ex) { toastErr(ex); }
    });
  };
  unC = watchComments(id, rows => { const typing = m.$('#tk-cmt') ? m.$('#tk-cmt').value : ''; comments = rows; draw(); if (m.$('#tk-cmt') && typing && rows.length && rows[rows.length - 1].by !== session.email) m.$('#tk-cmt').value = typing; const box = m.$('#tk-cm'); if (box) box.scrollTop = box.scrollHeight; });
  const off = (async () => (await import('../services/tasks.js')).onTasks(() => { if (document.body.contains(m.el)) { const typing = m.$('#tk-cmt') ? m.$('#tk-cmt').value : ''; draw(); if (m.$('#tk-cmt')) m.$('#tk-cmt').value = typing; } }))();
  const close = m.close; m.close = () => { unC && unC(); off.then(f => f && f()); close(); };
  draw();
}
