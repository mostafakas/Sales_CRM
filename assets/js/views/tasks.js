// The Tasks page: three tabs — Tasks (Board / List / Calendar with filters), Projects and Clients.
// Routes: #/tasks · #/tasks/t/<taskId> · #/tasks/projects[/<id>] · #/tasks/clients[/<id>]
import { L, esc, fmtDate, ymd, addDays, debounce } from '../core/utils.js';
import { toast, toastErr, avatar, empty, modal, busy, confirmDialog } from '../core/ui.js';
import { session, now, isAdmin, isHR } from '../core/session.js';
import { activePeople, person, nameOf, onDirectory } from '../services/directory.js';
import {
  STATUS, ORDER, PRIORITY, PROJECT_STATUS, startTasks, onTasks, allTasks, allProjects, allClients, projectById, clientById, isLate, doneDay, canMove,
  canCreate, canManageProjects, seesAllTasks, saveProject, deleteProject, saveClient, deleteClient, importFromCrm, migrateChatTasks, setSelfTasks, taskById, pendingPeople
} from '../services/tasks.js';
import { watchMonth } from '../services/todos.js';
import { card, move, editor, details, who, statusBadge } from './task-ui.js';
import { setTabLabel } from '../tabs.js';
import { dayKey } from '../core/policy.js';

const LS = () => `am_tk_${session.email}`;
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(LS()) || '{}'); } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(LS(), JSON.stringify(p)); } catch {} };
const isLeaderOfAny = () => activePeople().some(p => p.leaderEmail === session.email);

export default async function render(root, { params = [] }) {
  startTasks();
  const tab = ['projects', 'clients', 'team'].includes(params[0]) ? params[0] : 'tasks';
  const subId = params[1] ? decodeURIComponent(params[1]) : '';
  const showClients = seesAllTasks() || isLeaderOfAny() || isHR();
  if (isAdmin()) migrateChatTasks().then(n => { if (n) toast(L(`اتنقل ${n} تاسك من الشات لصفحة التاسكات`, `${n} chat tasks moved to the Tasks page`)); }).catch(e => console.warn('migrate', e && e.message));

  root.innerHTML = `<div class="tk-page">
    <div class="tk-head">
      <div class="seg tk-tabs" id="tabs">
        <a href="#/tasks" class="${tab === 'tasks' ? 'on' : ''}"><i class="fas fa-list-check"></i> ${L('التاسكات', 'Tasks')}</a>
        <a href="#/tasks/projects" class="${tab === 'projects' ? 'on' : ''}"><i class="fas fa-diagram-project"></i> ${L('المشاريع', 'Projects')}</a>
        ${showClients ? `<a href="#/tasks/clients" class="${tab === 'clients' ? 'on' : ''}"><i class="fas fa-handshake"></i> ${L('العملاء', 'Clients')}</a>` : ''}
        ${showClients ? `<a href="#/tasks/team" class="${tab === 'team' ? 'on' : ''}"><i class="fas fa-people-group"></i> ${L('الفريق', 'Team')}</a>` : ''}
        <a href="#/todo"><i class="fas fa-square-check"></i> To-Do</a>
      </div>
      <div class="row gap-8 wrap" id="head-actions"></div>
    </div>
    <div id="body"></div></div>`;
  const body = root.querySelector('#body'), actions = root.querySelector('#head-actions');
  let cleanup = () => {};
  if (tab === 'tasks') cleanup = tasksTab(body, actions, params[0] === 't' ? subId : '');
  if (tab === 'projects') cleanup = subId ? projectPage(body, actions, subId) : projectsTab(body, actions);
  if (tab === 'clients') cleanup = subId ? clientPage(body, actions, subId) : clientsTab(body, actions);
  if (tab === 'team') cleanup = teamTab(body, actions);
  return () => cleanup();
}

// =====================================================================================================
// Tasks tab: Board / List / Calendar
// =====================================================================================================
function tasksTab(body, actions, openId, fixed = {}) {
  const prefs = { view: 'board', scope: 'all', who: '', project: '', client: '', priority: '', due: '', ...loadPrefs(), ...fixed.prefs };
  let q = '', finishedDay = '', calMonth = ymd(now()).slice(0, 7);
  const isFixed = !!fixed.projectId;
  if (!isFixed) setTabLabel('');
  const people = () => { const s = new Set(allTasks().map(t => t.assignee).filter(Boolean)); return [...s].map(e => who(e)).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar')); };
  const drawActions = () => {
    actions.innerHTML = `
      <div class="seg" id="views">${[['board', 'fa-table-columns', 'Board'], ['list', 'fa-list', 'List'], ['calendar', 'fa-calendar-days', L('التقويم', 'Calendar')]].map(([v, i, t]) => `<button data-view="${v}" class="${prefs.view === v ? 'on' : ''}"><i class="fas ${i}"></i> ${t}</button>`).join('')}</div>
      ${!isFixed && seesAllTasks() ? `<button class="btn btn-ghost btn-sm" id="notion-imp"><i class="fas fa-file-import"></i> ${L('استيراد من Notion', 'Import from Notion')}</button>` : ''}
      ${!isFixed && (isLeaderOfAny() || isAdmin()) ? `<button class="btn btn-ghost btn-sm" id="team-perm" title="${L('مين يقدر يعمل تاسكات لنفسه', 'Who may create their own tasks')}"><i class="fas fa-user-gear"></i> ${L('صلاحيات الفريق', 'Team access')}</button>` : ''}
      ${canCreate() ? `<button class="btn btn-primary" id="new-task"><i class="fas fa-plus"></i> ${L('تاسك جديد', 'New task')}</button>` : ''}`;
  };
  const filtersHTML = () => {
    const mgr = seesAllTasks() || isLeaderOfAny();
    return `<div class="tk-filters">
      <div class="search"><i class="fas fa-search"></i><input class="input" id="tf-q" placeholder="${L('بحث بالعنوان أو الرقم', 'Search title or number')}" value="${esc(q)}"></div>
      ${mgr ? `<select class="select" id="tf-who"><option value="">${L('كل الموظفين', 'Everyone')}</option><option value="__me" ${prefs.who === '__me' ? 'selected' : ''}>${L('تاسكاتي أنا', 'My tasks')}</option>${allTasks().some(t => !t.assignee) ? `<option value="__pending" ${prefs.who === '__pending' ? 'selected' : ''}>${L('ملهمش يوزر لسه', 'No account yet')}</option>` : ''}${people().filter(p => p.email !== session.email).map(p => `<option value="${esc(p.email)}" ${prefs.who === p.email ? 'selected' : ''}>${esc(p.name || p.email)}</option>`).join('')}</select>` : ''}
      ${isFixed ? '' : `<select class="select" id="tf-project"><option value="">${L('كل المشاريع', 'All projects')}</option><option value="__none" ${prefs.project === '__none' ? 'selected' : ''}>${L('بدون مشروع', 'No project')}</option>${allProjects().map(p => `<option value="${esc(p.id)}" ${prefs.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`}
      ${mgr && !isFixed ? `<select class="select" id="tf-client"><option value="">${L('كل العملاء', 'All clients')}</option>${allClients().map(c => `<option value="${esc(c.id)}" ${prefs.client === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : ''}
      <select class="select" id="tf-priority"><option value="">${L('كل الأولويات', 'Any priority')}</option>${Object.entries(PRIORITY).map(([k, v]) => `<option value="${k}" ${prefs.priority === k ? 'selected' : ''}>${esc(L(v.ar, v.en))}</option>`).join('')}</select>
      <select class="select" id="tf-due"><option value="">${L('أي ميعاد', 'Any due date')}</option>${[['late', L('المتأخر', 'Late')], ['today', L('النهارده', 'Today')], ['week', L('الأسبوع ده', 'This week')], ['none', L('من غير ميعاد', 'No due date')]].map(([k, t]) => `<option value="${k}" ${prefs.due === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
      ${(prefs.who || prefs.project || prefs.client || prefs.priority || prefs.due || q) ? `<button class="btn btn-ghost btn-sm" id="tf-clear"><i class="fas fa-filter-circle-xmark"></i> ${L('مسح الفلاتر', 'Clear')}</button>` : ''}
    </div>`;
  };
  const filtered = () => {
    const today = ymd(now()), wk = addDays(today, 7);
    const qq = q.trim().toLowerCase().replace(/^#/, '');
    return allTasks().filter(t => {
      if (fixed.projectId && t.projectId !== fixed.projectId) return false;
      if (prefs.who === '__me' && t.assignee !== session.email) return false;
      if (prefs.who === '__pending' && t.assignee) return false;
      if (prefs.who && prefs.who !== '__me' && prefs.who !== '__pending' && t.assignee !== prefs.who) return false;
      if (!isFixed && prefs.project === '__none' && t.projectId) return false;
      if (!isFixed && prefs.project && prefs.project !== '__none' && t.projectId !== prefs.project) return false;
      if (!isFixed && prefs.client && t.clientId !== prefs.client) return false;
      if (prefs.priority && (t.priority || 'normal') !== prefs.priority) return false;
      if (prefs.due === 'late' && !isLate(t)) return false;
      if (prefs.due === 'today' && t.due !== today) return false;
      if (prefs.due === 'week' && !(t.due && t.due >= today && t.due <= wk)) return false;
      if (prefs.due === 'none' && t.due) return false;
      if (qq && !(String(t.num) === qq || `${t.title} ${t.projectName || ''} ${nameOf(t.assignee)}`.toLowerCase().includes(qq))) return false;
      return true;
    });
  };
  const sortOpen = (a, b) => ({ urgent: 0, high: 1, normal: 2 }[a.priority || 'normal'] - { urgent: 0, high: 1, normal: 2 }[b.priority || 'normal']) || (a.due || '9999').localeCompare(b.due || '9999') || a.num - b.num;

  function board(rows) {
    const vd = finishedDay || dayKey(now()), past = !!finishedDay && finishedDay !== dayKey(now());
    return `<div class="tk-board">${ORDER.map(s => {
      let list = rows.filter(t => t.status === s);
      if (s === 'done') list = list.filter(t => doneDay(t) === vd).sort((a, b) => (b.doneAt && b.doneAt.toMillis ? b.doneAt.toMillis() : 0) - (a.doneAt && a.doneAt.toMillis ? a.doneAt.toMillis() : 0));
      else list = list.sort(sortOpen);
      return `<section class="tk-col ${STATUS[s].cls}" data-col="${s}">
        <header><i class="fas ${STATUS[s].icon}"></i><b>${STATUS[s].label}</b><small>${esc(STATUS[s].ar)}</small><span class="num">${list.length}</span></header>
        ${s === 'done' ? `<div class="tk-dayn"><button class="btn btn-ghost btn-icon btn-sm" data-fday="-1"><i class="fas fa-chevron-right" data-flip></i></button><input type="date" class="input" id="tk-fday" max="${dayKey(now())}" value="${vd}"><button class="btn btn-ghost btn-icon btn-sm" data-fday="1" ${past ? '' : 'disabled'}><i class="fas fa-chevron-left" data-flip></i></button></div>` : ''}
        <div class="tk-col-body">${list.map(t => card(t, { draggable: true })).join('') || `<div class="tk-none">${s === 'done' && past ? L('مفيش حاجة خلصت اليوم ده', 'Nothing finished that day') : L('مفيش', 'None')}</div>`}</div></section>`;
    }).join('')}</div>`;
  }
  function listView(rows) {
    const sorted = rows.slice().sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || sortOpen(a, b));
    if (!sorted.length) return `<div class="card">${empty('fa-list-check', L('مفيش تاسكات', 'No tasks'))}</div>`;
    return `<div class="card table-wrap"><table class="table tk-table"><thead><tr><th>#</th><th>${L('التاسك', 'Task')}</th><th>${L('المشروع', 'Project')}</th><th>${L('مسند لـ', 'Assignee')}</th><th>${L('الأولوية', 'Priority')}</th><th>${L('الحالة', 'Status')}</th><th>${L('التسليم', 'Due')}</th></tr></thead><tbody>
      ${sorted.map(t => `<tr data-open="${esc(t.id)}" class="${isLate(t) ? 'late' : ''}"><td class="num muted">#${t.num}</td><td><b>${esc(t.title)}</b>${(t.checklist || []).length ? ` <small class="muted num">${t.checklist.filter(x => x.done).length}/${t.checklist.length}</small>` : ''}</td>
        <td>${esc(t.projectName || '—')}</td><td>${t.assignee ? `<span class="tk-who">${avatar(who(t.assignee), 'xs')}${esc(nameOf(t.assignee))}</span>` : `<span class="tk-who pending"><i class="fas fa-user-clock"></i>${esc(t.pendingAssignee || '—')}</span>`}</td>
        <td>${t.priority && t.priority !== 'normal' ? `<span class="badge ${PRIORITY[t.priority].cls}">${esc(L(PRIORITY[t.priority].ar, PRIORITY[t.priority].en))}</span>` : `<span class="muted">${L('عادي', 'Normal')}</span>`}</td>
        <td>${statusBadge(t.status)}</td><td class="${isLate(t) ? 'tk-late' : ''}">${t.due ? esc(fmtDate(t.due)) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function calendar(rows) {
    const [y, mo] = calMonth.split('-').map(Number);
    const first = new Date(Date.UTC(y, mo - 1, 1)), days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const lead = (first.getUTCDay() + 1) % 7;                     // week starts on Saturday
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<div class="tk-cal-cell empty"></div>');
    for (let d = 1; d <= days; d++) {
      const ds = `${calMonth}-${String(d).padStart(2, '0')}`;
      const items = rows.filter(t => t.due === ds).sort(sortOpen);
      cells.push(`<div class="tk-cal-cell ${ds === ymd(now()) ? 'today' : ''}"><span class="num">${d}</span>${items.slice(0, 4).map(t => `<button class="tk-cal-item ${STATUS[t.status].cls} ${isLate(t) ? 'late' : ''}" data-open="${esc(t.id)}" title="${esc(t.title)}">#${t.num} ${esc(t.title)}</button>`).join('')}${items.length > 4 ? `<small class="muted">+${items.length - 4}</small>` : ''}</div>`);
    }
    const names = [L('السبت', 'Sat'), L('الأحد', 'Sun'), L('الاتنين', 'Mon'), L('التلات', 'Tue'), L('الأربع', 'Wed'), L('الخميس', 'Thu'), L('الجمعة', 'Fri')];
    return `<div class="card tk-cal"><div class="row between mb-8"><button class="btn btn-ghost btn-icon" data-cal="-1"><i class="fas fa-chevron-right" data-flip></i></button><b>${esc(fmtDate(calMonth + '-01').replace(/^\d+\s/, ''))}</b><button class="btn btn-ghost btn-icon" data-cal="1"><i class="fas fa-chevron-left" data-flip></i></button></div>
      <div class="tk-cal-grid">${names.map(n => `<div class="tk-cal-h">${n}</div>`).join('')}${cells.join('')}</div>
      <p class="xs muted mt-8">${L('التاسكات بتظهر على يوم التسليم. اللي من غير ميعاد مش هنا.', 'Tasks appear on their due date; tasks without one are not shown here.')}</p></div>`;
  }
  const draw = () => {
    drawActions();
    const rows = filtered();
    const open = rows.filter(t => t.status !== 'done');
    const pend = !isFixed && seesAllTasks() ? pendingPeople().filter(x => x.count) : [];
    body.innerHTML = `${pend.length ? `<div class="alert warn mb-8"><i class="fas fa-user-clock"></i><span class="grow">${L(`${pend.reduce((s, x) => s + x.count, 0)} تاسك لأشخاص ملهمش يوزر لسه: ${pend.slice(0, 6).map(x => `${esc(x.name)} (${x.count})`).join('، ')}${pend.length > 6 ? '…' : ''}`, `${pend.reduce((s, x) => s + x.count, 0)} tasks belong to people without an account: ${pend.slice(0, 6).map(x => `${esc(x.name)} (${x.count})`).join(', ')}`)}</span><button class="btn btn-sm" id="pend-link"><i class="fas fa-link"></i> ${L('ربط بيوزرات', 'Link to accounts')}</button></div>` : ''}${filtersHTML()}
      <div class="tk-stats">${ORDER.filter(s => s !== 'done').map(s => `<span class="tk-stat ${STATUS[s].cls}"><i class="fas ${STATUS[s].icon}"></i>${STATUS[s].label}<b class="num">${rows.filter(t => t.status === s).length}</b></span>`).join('')}
        <span class="tk-stat late"><i class="fas fa-triangle-exclamation"></i>${L('متأخر', 'Late')}<b class="num">${open.filter(isLate).length}</b></span></div>
      <div id="tk-view">${prefs.view === 'list' ? listView(rows) : prefs.view === 'calendar' ? calendar(rows) : board(rows)}</div>`;
    if (!allTasks().length && !canCreate()) body.querySelector('#tk-view').innerHTML = `<div class="card">${empty('fa-list-check', L('مفيش تاسكات ليك لسه', 'No tasks for you yet'), L('أول ما الليدر يدّيك تاسك هيظهر هنا.', 'Tasks your leader gives you will show up here.'))}</div>`;
  };
  const setPref = (k, v) => { prefs[k] = v; if (!isFixed) savePrefs({ view: prefs.view, who: prefs.who, project: prefs.project, client: prefs.client, priority: prefs.priority, due: prefs.due }); draw(); };
  body.addEventListener('change', (e) => {
    const id = e.target.id;
    if (id === 'tf-who') setPref('who', e.target.value);
    if (id === 'tf-project') setPref('project', e.target.value);
    if (id === 'tf-client') setPref('client', e.target.value);
    if (id === 'tf-priority') setPref('priority', e.target.value);
    if (id === 'tf-due') setPref('due', e.target.value);
    if (id === 'tk-fday') { finishedDay = e.target.value >= dayKey(now()) ? '' : e.target.value; draw(); }
  });
  body.addEventListener('input', debounce((e) => { if (e.target.id === 'tf-q') { q = e.target.value; const pos = e.target.selectionStart; draw(); const el = body.querySelector('#tf-q'); el.focus(); el.setSelectionRange(pos, pos); } }, 250));
  body.addEventListener('click', (e) => {
    if (e.target.closest('#pend-link')) { import('./notion-import.js').then(m => m.openPendingPeople()); return; }
    if (e.target.closest('#tf-clear')) { q = ''; Object.assign(prefs, { who: '', project: '', client: '', priority: '', due: '' }); setPref('who', ''); return; }
    const fd = e.target.closest('[data-fday]'); if (fd) { const d = addDays(finishedDay || dayKey(now()), Number(fd.dataset.fday)); finishedDay = d >= dayKey(now()) ? '' : d; draw(); return; }
    const cal = e.target.closest('[data-cal]'); if (cal) { const [y, m] = calMonth.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + Number(cal.dataset.cal), 1)); calMonth = d.toISOString().slice(0, 7); draw(); return; }
    const o = e.target.closest('[data-open]'); if (o) details(o.dataset.open);
  });
  actions.onclick = (e) => {
    const v = e.target.closest('[data-view]'); if (v) { setPref('view', v.dataset.view); return; }
    if (e.target.closest('#new-task')) editor(null, { projectId: fixed.projectId || (prefs.project && prefs.project !== '__none' ? prefs.project : '') });
    if (e.target.closest('#team-perm')) teamAccess();
    if (e.target.closest('#notion-imp')) import('./notion-import.js').then(m => m.openNotionImport());
  };
  // drag a card to another column
  let dragId = '';
  body.addEventListener('dragstart', (e) => { const c = e.target.closest('.tk-card'); if (!c) return; dragId = c.dataset.open; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  body.addEventListener('dragend', () => { dragId = ''; body.querySelectorAll('.dragging,.drop-ok,.drop-no').forEach(x => x.classList.remove('dragging', 'drop-ok', 'drop-no')); });
  body.addEventListener('dragover', (e) => {
    const col = e.target.closest('[data-col]'); if (!col || !dragId) return;
    const t = taskById(dragId); const ok = t && canMove(t, col.dataset.col);
    body.querySelectorAll('.drop-ok,.drop-no').forEach(x => x.classList.remove('drop-ok', 'drop-no'));
    col.classList.add(ok ? 'drop-ok' : 'drop-no');
    if (ok) e.preventDefault();
  });
  body.addEventListener('drop', async (e) => {
    const col = e.target.closest('[data-col]'); if (!col || !dragId) return;
    e.preventDefault();
    const t = taskById(dragId); dragId = '';
    body.querySelectorAll('.drop-ok,.drop-no').forEach(x => x.classList.remove('drop-ok', 'drop-no'));
    if (t) await move(t, col.dataset.col);
  });
  const off1 = onTasks(draw), off2 = onDirectory(draw);
  if (openId) setTimeout(() => details(openId), 400);
  return () => { off1(); off2(); };
}

/** leaders (their team) and admins (everyone): who may create tasks for themselves */
function teamAccess() {
  const ppl = (isAdmin() ? activePeople() : activePeople().filter(p => p.leaderEmail === session.email)).filter(p => p.email !== session.email);
  const m = modal({
    title: L('صلاحيات الفريق', 'Team access'), icon: 'fa-user-gear', size: 'narrow',
    body: `<p class="small muted mb-8">${L('اللي متعلّم عليه يقدر يعمل تاسكات لنفسه، وبتظهر لليدر بتاعه.', 'Ticked people may create tasks for themselves; their leader sees them.')}</p>
      <div class="chat-members">${ppl.map(p => `<label class="chat-member" style="cursor:pointer">${avatar(p, 'sm')}<span class="grow min0"><b class="truncate">${esc(p.name || p.email)}</b><small class="truncate">${esc(p.title || '')}</small></span><span class="switch"><input type="checkbox" data-self="${esc(p.email)}" ${p.selfTasks ? 'checked' : ''}><span></span></span></label>`).join('') || `<p class="muted small">${L('مفيش موظفين', 'No employees')}</p>`}</div>`,
    foot: `<button class="btn btn-primary" data-close>${L('تمام', 'Done')}</button>`
  });
  m.$$('[data-self]').forEach(c => c.onchange = async () => { try { await setSelfTasks(c.dataset.self, c.checked); toast(c.checked ? L('اتفعّلت', 'Enabled') : L('اتقفلت', 'Disabled'), nameOf(c.dataset.self)); } catch (ex) { c.checked = !c.checked; toastErr(ex); } });
}

// =====================================================================================================
// Projects
// =====================================================================================================
const visibleProjects = () => {
  if (seesAllTasks()) return allProjects();
  const mine = new Set(allTasks().map(t => t.projectId).filter(Boolean));
  return allProjects().filter(p => p.leader === session.email || (p.members || []).includes(session.email) || mine.has(p.id));
};
const statsOf = (pid) => { const ts = allTasks().filter(t => t.projectId === pid); const done = ts.filter(t => t.status === 'done').length; return { all: ts.length, done, late: ts.filter(isLate).length, open: ts.length - done, pct: ts.length ? Math.round(done / ts.length * 100) : 0 }; };
function projectCard(p) {
  const s = statsOf(p.id);
  return `<a class="card tk-pcard" href="#/tasks/projects/${encodeURIComponent(p.id)}" style="--pc:${esc(p.color || '#1b1bdb')}">
    <div class="row between gap-8"><b class="truncate">${esc(p.name)}</b><span class="badge ${PROJECT_STATUS[p.status || 'active'].cls}">${esc(L(PROJECT_STATUS[p.status || 'active'].ar, PROJECT_STATUS[p.status || 'active'].en))}</span></div>
    <div class="xs muted">${p.clientName ? `<i class="fas fa-handshake"></i> ${esc(p.clientName)} · ` : ''}${p.leader ? `${L('الليدر', 'Lead')}: ${esc(nameOf(p.leader))}` : ''}</div>
    <div class="tk-bar big"><span style="width:${s.pct}%"></span></div>
    <div class="row between xs muted"><span class="num">${s.pct}% · ${s.done}/${s.all} ${L('تاسك', 'tasks')}${s.late ? ` · <span class="tk-late">${s.late} ${L('متأخر', 'late')}</span>` : ''}</span><span>${p.end ? `${L('ينتهي', 'Ends')} ${esc(fmtDate(p.end))}` : ''}</span></div>
    <div class="tk-avs">${(p.members || []).slice(0, 6).map(e => avatar(who(e), 'xs')).join('')}${(p.members || []).length > 6 ? `<small class="muted">+${p.members.length - 6}</small>` : ''}</div></a>`;
}
function projectsTab(body, actions) {
  setTabLabel(L('المشاريع', 'Projects'));
  let st = 'active';
  const draw = () => {
    actions.innerHTML = canManageProjects() ? `<button class="btn btn-primary" id="new-p"><i class="fas fa-plus"></i> ${L('مشروع جديد', 'New project')}</button>` : '';
    const rows = visibleProjects().filter(p => st === 'all' || (p.status || 'active') === st);
    body.innerHTML = `<div class="seg mb-16" id="pst">${[['active', L('الشغالة', 'Active')], ['hold', L('المتوقفة', 'On hold')], ['done', L('اللي خلصت', 'Completed')], ['all', L('الكل', 'All')]].map(([k, t]) => `<button data-st="${k}" class="${st === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      ${rows.length ? `<div class="tk-pgrid">${rows.map(projectCard).join('')}</div>` : `<div class="card">${empty('fa-diagram-project', L('مفيش مشاريع هنا', 'No projects here'), canManageProjects() ? L('اضغط «مشروع جديد».', 'Click "New project".') : '')}</div>`}`;
  };
  body.onclick = (e) => { const b = e.target.closest('[data-st]'); if (b) { st = b.dataset.st; draw(); } };
  actions.onclick = (e) => { if (e.target.closest('#new-p')) projectEditor(null); };
  const off = onTasks(draw);
  return () => off();
}
function projectPage(body, actions, id) {
  body.innerHTML = `<a href="#/tasks/projects" class="btn btn-ghost btn-sm mb-8"><i class="fas fa-arrow-right" data-flip></i> ${L('كل المشاريع', 'All projects')}</a><div id="phead"></div><div id="pboard" class="mt-16"></div>`;
  const head = body.querySelector('#phead');
  const drawHead = () => {
    const p = projectById(id);
    if (!p) { head.innerHTML = `<div class="card">${empty('fa-diagram-project', L('المشروع مش موجود أو مش متاح ليك', 'Project not found or not available to you'))}</div>`; return; }
    setTabLabel(p.name);
    const s = statsOf(p.id);
    head.innerHTML = `<section class="card tk-phead" style="--pc:${esc(p.color || '#1b1bdb')}">
        <div class="row between gap-12 wrap"><div><h2>${esc(p.name)}</h2><div class="muted small">${p.clientName ? `<a href="#/tasks/clients/${encodeURIComponent(p.clientId)}"><i class="fas fa-handshake"></i> ${esc(p.clientName)}</a> · ` : ''}${p.leader ? `${L('الليدر', 'Lead')}: ${esc(nameOf(p.leader))} · ` : ''}${p.start ? esc(fmtDate(p.start)) : ''}${p.end ? ` ← ${esc(fmtDate(p.end))}` : ''}</div></div>
          <div class="row gap-8"><span class="badge ${PROJECT_STATUS[p.status || 'active'].cls}">${esc(L(PROJECT_STATUS[p.status || 'active'].ar, PROJECT_STATUS[p.status || 'active'].en))}</span>${canManageProjects() ? `<button class="btn btn-ghost btn-sm" id="pe"><i class="fas fa-pen"></i> ${L('تعديل', 'Edit')}</button><button class="btn btn-ghost btn-sm" id="pd" style="color:var(--bad)"><i class="fas fa-trash"></i></button>` : ''}</div></div>
        ${p.description ? `<p class="mt-8" style="white-space:pre-wrap">${esc(p.description)}</p>` : ''}
        <div class="tk-pstats"><div><b class="num">${s.pct}%</b><small>${L('إنجاز', 'Done')}</small></div><div><b class="num">${s.open}</b><small>${L('مفتوحة', 'Open')}</small></div><div><b class="num">${s.done}</b><small>${L('خلصت', 'Finished')}</small></div><div><b class="num ${s.late ? 'tk-late' : ''}">${s.late}</b><small>${L('متأخرة', 'Late')}</small></div>
          <div class="tk-avs">${(p.members || []).map(e => avatar(who(e), 'sm')).join('')}</div></div>
        <div class="tk-bar big"><span style="width:${s.pct}%"></span></div></section>`;
    const pe = head.querySelector('#pe'); if (pe) pe.onclick = () => projectEditor(p);
    const pd = head.querySelector('#pd'); if (pd) pd.onclick = async () => { if (await confirmDialog({ title: L('حذف المشروع', 'Delete project'), message: L('التاسكات بتاعته مش هتتمسح، بس هتبقى من غير مشروع.', 'Its tasks stay, without a project.'), okText: L('حذف', 'Delete'), okClass: 'btn-danger' })) { try { await deleteProject(p); location.hash = '#/tasks/projects'; } catch (ex) { toastErr(ex); } } };
  };
  const inner = tasksTab(body.querySelector('#pboard'), actions, '', { projectId: id, prefs: { project: '', client: '' } });
  const off = onTasks(drawHead);
  return () => { inner(); off(); };
}
function projectEditor(p) {
  const members = new Set((p && p.members) || []);
  const m = modal({
    title: p ? L('تعديل المشروع', 'Edit project') : L('مشروع جديد', 'New project'), icon: 'fa-diagram-project',
    body: `<div class="col gap-12">
      <div class="form-grid"><div class="field"><label>${L('اسم المشروع', 'Name')} *</label><input class="input" id="pn" maxlength="120" value="${esc(p ? p.name : '')}"></div>
        <div class="field"><label>${L('العميل', 'Client')}</label><select class="select" id="pc"><option value="">${L('بدون عميل', 'No client')}</option>${allClients().map(c => `<option value="${esc(c.id)}" ${p && p.clientId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label>${L('الليدر المسؤول', 'Responsible leader')}</label><select class="select" id="pl"><option value="">—</option>${activePeople().map(x => `<option value="${esc(x.email)}" ${p && p.leader === x.email ? 'selected' : ''}>${esc(x.name || x.email)}</option>`).join('')}</select></div>
        <div class="field"><label>${L('الحالة', 'Status')}</label><select class="select" id="ps">${Object.entries(PROJECT_STATUS).map(([k, v]) => `<option value="${k}" ${(p ? p.status : 'active') === k ? 'selected' : ''}>${esc(L(v.ar, v.en))}</option>`).join('')}</select></div>
        <div class="field"><label>${L('البداية', 'Start')}</label><input class="input" type="date" id="pst2" value="${esc(p ? p.start || '' : '')}"></div>
        <div class="field"><label>${L('النهاية', 'End')}</label><input class="input" type="date" id="pen" value="${esc(p ? p.end || '' : '')}"></div>
        <div class="field"><label>${L('اللون', 'Colour')}</label><input class="input" type="color" id="pco" value="${esc(p ? p.color || '#1b1bdb' : '#1b1bdb')}" style="padding:4px;height:42px"></div></div>
      <div class="field"><label>${L('الوصف', 'Description')}</label><textarea class="textarea" id="pdz" maxlength="3000">${esc(p ? p.description || '' : '')}</textarea></div>
      <div class="field"><label>${L('فريق المشروع', 'Project team')} <span class="num muted" id="pmc">(${members.size})</span></label>
        <div class="search mb-8"><i class="fas fa-search"></i><input class="input" id="pmq" placeholder="${L('ابحث بالاسم', 'Search')}"></div><div class="chat-members" id="pml"></div></div></div>`,
    foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="psave"><i class="fas fa-floppy-disk"></i> ${L('حفظ', 'Save')}</button>`
  });
  const drawM = () => { const q = m.$('#pmq').value.trim().toLowerCase(); m.$('#pml').innerHTML = activePeople().filter(x => !q || `${x.name} ${x.department}`.toLowerCase().includes(q)).sort((a, b) => members.has(b.email) - members.has(a.email)).map(x => `<label class="chat-member" style="cursor:pointer"><input type="checkbox" data-m="${esc(x.email)}" ${members.has(x.email) ? 'checked' : ''}>${avatar(x, 'sm')}<span class="grow min0"><b class="truncate">${esc(x.name || x.email)}</b><small class="truncate">${esc(x.title || '')}</small></span></label>`).join(''); m.$('#pmc').textContent = `(${members.size})`; };
  m.$('#pmq').oninput = debounce(drawM, 100);
  m.$('#pml').onchange = (e) => { const c = e.target.closest('[data-m]'); if (!c) return; if (c.checked) members.add(c.dataset.m); else members.delete(c.dataset.m); m.$('#pmc').textContent = `(${members.size})`; };
  drawM();
  m.$('#psave').onclick = (e) => busy(e.currentTarget, async () => {
    const f = { name: m.$('#pn').value, clientId: m.$('#pc').value, leader: m.$('#pl').value, status: m.$('#ps').value, start: m.$('#pst2').value, end: m.$('#pen').value, color: m.$('#pco').value, description: m.$('#pdz').value, members: [...members] };
    if (!f.name.trim()) { m.$('#pn').focus(); return; }
    try { await saveProject(p, f); m.close(); toast(L('اتحفظ المشروع', 'Project saved')); } catch (ex) { toastErr(ex); }
  });
}

// =====================================================================================================
// Clients
// =====================================================================================================
function clientsTab(body, actions) {
  setTabLabel(L('العملاء', 'Clients'));
  let q = '';
  const draw = () => {
    actions.innerHTML = canManageProjects() ? `${isAdmin() ? `<button class="btn btn-ghost btn-sm" id="crm-imp"><i class="fas fa-file-import"></i> ${L('استيراد من الـ CRM', 'Import from CRM')}</button>` : ''}<button class="btn btn-primary" id="new-c"><i class="fas fa-plus"></i> ${L('عميل جديد', 'New client')}</button>` : '';
    const rows = allClients().filter(c => !q || `${c.name} ${c.company} ${c.contact} ${c.phone} ${c.email}`.toLowerCase().includes(q));
    const projs = (cid) => allProjects().filter(p => p.clientId === cid);
    const openT = (cid) => allTasks().filter(t => t.clientId === cid && t.status !== 'done').length;
    body.innerHTML = `<div class="search mb-16" style="max-width:360px"><i class="fas fa-search"></i><input class="input" id="cq" placeholder="${L('ابحث عن عميل', 'Search clients')}" value="${esc(q)}"></div>
      ${rows.length ? `<div class="card table-wrap"><table class="table"><thead><tr><th>${L('العميل', 'Client')}</th><th>${L('الشخص المسؤول', 'Contact')}</th><th>${L('التليفون', 'Phone')}</th><th>${L('الإيميل', 'Email')}</th><th class="num">${L('مشاريع', 'Projects')}</th><th class="num">${L('تاسكات مفتوحة', 'Open tasks')}</th></tr></thead><tbody>
        ${rows.map(c => `<tr data-c="${esc(c.id)}" style="cursor:pointer"><td><b>${esc(c.name)}</b>${c.company ? `<div class="xs muted">${esc(c.company)}</div>` : ''}</td><td>${esc(c.contact || '—')}</td><td dir="ltr" style="text-align:start">${esc(c.phone || '—')}</td><td dir="ltr" style="text-align:start">${esc(c.email || '—')}</td><td class="num">${projs(c.id).length}</td><td class="num">${openT(c.id)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="card">${empty('fa-handshake', L('مفيش عملاء', 'No clients'), canManageProjects() ? L('اضغط «عميل جديد»، أو استورد من الـ CRM.', 'Click "New client", or import from the CRM.') : '')}</div>`}`;
  };
  body.addEventListener('input', debounce((e) => { if (e.target.id === 'cq') { q = e.target.value.trim().toLowerCase(); draw(); const el = body.querySelector('#cq'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 200));
  body.addEventListener('click', (e) => { const r = e.target.closest('[data-c]'); if (r) location.hash = `#/tasks/clients/${encodeURIComponent(r.dataset.c)}`; });
  actions.onclick = async (e) => {
    if (e.target.closest('#new-c')) clientEditor(null);
    const imp = e.target.closest('#crm-imp');
    if (imp) busy(imp, async () => { try { const r = await importFromCrm(); toast(L(`اتنقل ${r.clients} عميل و${r.projects} مشروع`, `${r.clients} clients and ${r.projects} projects imported`)); } catch (ex) { toastErr(ex); } });
  };
  const off = onTasks(draw);
  return () => off();
}
function clientPage(body, actions, id) {
  const draw = () => {
    const c = clientById(id);
    actions.innerHTML = '';
    if (!c) { body.innerHTML = `<div class="card">${empty('fa-handshake', L('العميل مش موجود', 'Client not found'))}</div>`; return; }
    setTabLabel(c.name);
    const projs = allProjects().filter(p => p.clientId === id);
    const open = allTasks().filter(t => t.clientId === id && t.status !== 'done');
    body.innerHTML = `<a href="#/tasks/clients" class="btn btn-ghost btn-sm mb-8"><i class="fas fa-arrow-right" data-flip></i> ${L('كل العملاء', 'All clients')}</a>
      <section class="card card-pad"><div class="row between gap-12 wrap"><div><h2 style="font-size:20px">${esc(c.name)}</h2>${c.company ? `<div class="muted">${esc(c.company)}</div>` : ''}</div>
        ${canManageProjects() ? `<div class="row gap-8"><button class="btn btn-ghost btn-sm" id="ce"><i class="fas fa-pen"></i> ${L('تعديل', 'Edit')}</button><button class="btn btn-ghost btn-sm" id="cd" style="color:var(--bad)"><i class="fas fa-trash"></i></button></div>` : ''}</div>
        <dl class="tk-kv mt-8"><dt>${L('الشخص المسؤول', 'Contact')}</dt><dd>${esc(c.contact || '—')}</dd><dt>${L('التليفون', 'Phone')}</dt><dd dir="ltr" style="text-align:start">${esc(c.phone || '—')}</dd><dt>${L('الإيميل', 'Email')}</dt><dd dir="ltr" style="text-align:start">${esc(c.email || '—')}</dd></dl>
        ${c.notes ? `<p class="mt-8" style="white-space:pre-wrap">${esc(c.notes)}</p>` : ''}</section>
      <h3 class="mt-16 mb-8">${L('المشاريع', 'Projects')} (${projs.length})</h3>${projs.length ? `<div class="tk-pgrid">${projs.map(projectCard).join('')}</div>` : `<p class="muted small">${L('مفيش مشاريع للعميل ده.', 'No projects for this client.')}</p>`}
      <h3 class="mt-16 mb-8">${L('تاسكات مفتوحة', 'Open tasks')} (${open.length})</h3><div class="tk-plist">${open.map(t => card(t)).join('') || `<p class="muted small">${L('مفيش', 'None')}</p>`}</div>`;
    const ce = body.querySelector('#ce'); if (ce) ce.onclick = () => clientEditor(c);
    const cd = body.querySelector('#cd'); if (cd) cd.onclick = async () => { if (await confirmDialog({ title: L('حذف العميل', 'Delete client'), message: c.name, okText: L('حذف', 'Delete'), okClass: 'btn-danger' })) { try { await deleteClient(c); location.hash = '#/tasks/clients'; } catch (ex) { toastErr(ex); } } };
  };
  body.addEventListener('click', (e) => { const o = e.target.closest('[data-open]'); if (o) details(o.dataset.open); });
  const off = onTasks(draw);
  return () => off();
}
function clientEditor(c) {
  const m = modal({
    title: c ? L('تعديل العميل', 'Edit client') : L('عميل جديد', 'New client'), icon: 'fa-handshake', size: 'narrow',
    body: `<div class="col gap-12">
      <div class="field"><label>${L('اسم العميل', 'Client name')} *</label><input class="input" id="cn" maxlength="120" value="${esc(c ? c.name : '')}"></div>
      <div class="field"><label>${L('الشركة', 'Company')}</label><input class="input" id="cco" maxlength="120" value="${esc(c ? c.company || '' : '')}"></div>
      <div class="field"><label>${L('الشخص المسؤول', 'Contact person')}</label><input class="input" id="cct" maxlength="120" value="${esc(c ? c.contact || '' : '')}"></div>
      <div class="form-grid"><div class="field"><label>${L('التليفون', 'Phone')}</label><input class="input" id="cph" dir="ltr" maxlength="40" value="${esc(c ? c.phone || '' : '')}"></div>
        <div class="field"><label>${L('الإيميل', 'Email')}</label><input class="input" id="cem" dir="ltr" type="email" maxlength="120" value="${esc(c ? c.email || '' : '')}"></div></div>
      <div class="field"><label>${L('ملاحظات', 'Notes')}</label><textarea class="textarea" id="cno" maxlength="3000">${esc(c ? c.notes || '' : '')}</textarea></div></div>`,
    foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="csave"><i class="fas fa-floppy-disk"></i> ${L('حفظ', 'Save')}</button>`
  });
  m.$('#csave').onclick = (e) => busy(e.currentTarget, async () => {
    const f = { name: m.$('#cn').value, company: m.$('#cco').value, contact: m.$('#cct').value, phone: m.$('#cph').value, email: m.$('#cem').value, notes: m.$('#cno').value };
    if (!f.name.trim()) { m.$('#cn').focus(); return; }
    try { await saveClient(c, f); m.close(); toast(L('اتحفظ العميل', 'Client saved')); } catch (ex) { toastErr(ex); }
  });
}

// =====================================================================================================
// Team: everyone's load, delivery and to-do progress in one place
// =====================================================================================================
export function openTasksOf(email) {
  try { const k = `am_tk_${session.email}`; const p = JSON.parse(localStorage.getItem(k) || '{}'); p.who = email === session.email ? '__me' : email; localStorage.setItem(k, JSON.stringify(p)); } catch {}
  location.hash = '#/tasks';
}
function teamTab(body, actions) {
  setTabLabel(L('الفريق', 'Team'));
  actions.innerHTML = '';
  const ym = ymd(now()).slice(0, 7), today = ymd(now());
  let todos = [], sortBy = 'late';
  const un = watchMonth(ym, rows => { todos = rows; draw(); });
  const people = () => (seesAllTasks() || isHR()) ? activePeople() : activePeople().filter(p => p.leaderEmail === session.email);
  function stats(p) {
    const ts = allTasks().filter(t => t.assignee === p.email);
    const open = ts.filter(t => t.status !== 'done');
    const done = ts.filter(t => t.status === 'done' && doneDay(t).slice(0, 7) === ym);
    const onTime = done.filter(t => !t.due || doneDay(t) <= t.due).length;
    const td = todos.filter(x => x.owner === p.email), tdToday = td.filter(x => x.date === today);
    return { p, open: open.length, review: open.filter(t => t.status === 'review').length, hold: open.filter(t => t.status === 'hold').length, late: open.filter(isLate).length,
      done: done.length, onTime: done.length ? Math.round(onTime / done.length * 100) : null,
      todayDone: tdToday.filter(x => x.done).length, todayAll: tdToday.length, monthPct: td.length ? Math.round(td.filter(x => x.done).length / td.length * 100) : null,
      projects: new Set(open.map(t => t.projectId).filter(Boolean)).size };
  }
  function draw() {
    const rows = people().map(stats);
    const sorters = { late: (a, b) => b.late - a.late || b.open - a.open, open: (a, b) => b.open - a.open, done: (a, b) => b.done - a.done, todo: (a, b) => (a.monthPct ?? 101) - (b.monthPct ?? 101), name: (a, b) => (a.p.name || '').localeCompare(b.p.name || '', 'ar') };
    rows.sort(sorters[sortBy]);
    const max = Math.max(1, ...rows.map(r => r.open));
    const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
    const tdAll = sum('todayAll'), tdDone = sum('todayDone');
    const tile = (icon, cls, label, value, hint = '') => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
    body.innerHTML = `<div class="grid g-4 keep-2 mb-16">
        ${tile('fa-list-check', 'brand', L('تاسكات مفتوحة', 'Open tasks'), sum('open'), L(`عند ${rows.filter(r => r.open).length} شخص`, `held by ${rows.filter(r => r.open).length} people`))}
        ${tile('fa-triangle-exclamation', 'bad', L('متأخرة', 'Late'), sum('late'), L(`${rows.filter(r => r.late).length} شخص عنده متأخر`, `${rows.filter(r => r.late).length} people have late tasks`))}
        ${tile('fa-magnifying-glass', 'info', L('مستنية مراجعة', 'Waiting for review'), sum('review'))}
        ${tile('fa-circle-check', 'ok', L('خلصت الشهر ده', 'Finished this month'), sum('done'), L(`To-Do النهارده: ${tdDone}/${tdAll}`, `To-Do today: ${tdDone}/${tdAll}`))}
      </div>
      <div class="row between mb-8 wrap gap-8"><b>${L(`${rows.length} شخص`, `${rows.length} people`)}</b><div class="seg">${[['late', L('المتأخر', 'Late')], ['open', L('المفتوح', 'Open')], ['done', L('المنجز', 'Done')], ['todo', 'To-Do'], ['name', L('الاسم', 'Name')]].map(([k, t]) => `<button data-tsort="${k}" class="${sortBy === k ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      <div class="tm-grid">${rows.map(r => `<div class="card tm-card ${r.late ? 'has-late' : ''}">
        <div class="row gap-10">${avatar(r.p, '')}<div class="grow min0"><b class="truncate">${esc(r.p.name || r.p.email)}</b><small class="muted truncate">${esc(r.p.title || '')}${r.p.department ? ' · ' + esc(r.p.department) : ''}</small></div></div>
        <div class="tm-stats"><div><b class="num">${r.open}</b><small>${L('مفتوحة', 'Open')}</small></div><div class="${r.late ? 'bad' : ''}"><b class="num">${r.late}</b><small>${L('متأخرة', 'Late')}</small></div><div><b class="num">${r.review}</b><small>${L('مراجعة', 'Review')}</small></div><div class="ok"><b class="num">${r.done}</b><small>${L('خلصت', 'Done')}</small></div></div>
        <div class="tm-load" title="${L('حجم الشغل المفتوح', 'Open workload')}"><span style="width:${Math.round(r.open / max * 100)}%"></span></div>
        <div class="row between xs muted"><span>${r.onTime === null ? '' : L(`في الميعاد ${r.onTime}%`, `On time ${r.onTime}%`)}${r.projects ? ` · ${L(`${r.projects} مشروع`, `${r.projects} projects`)}` : ''}</span><span>To-Do ${r.todayAll ? `${r.todayDone}/${r.todayAll}` : '—'}${r.monthPct === null ? '' : ` · ${L('الشهر', 'month')} ${r.monthPct}%`}</span></div>
        <div class="row gap-8"><button class="btn btn-sm grow" data-tasks-of="${esc(r.p.email)}"><i class="fas fa-clipboard-check"></i> ${L('التاسكات', 'Tasks')}</button><a class="btn btn-sm grow" href="#/todo/${encodeURIComponent(r.p.email)}"><i class="fas fa-square-check"></i> To-Do</a></div>
      </div>`).join('') || `<div class="card">${empty('fa-people-group', L('مفيش حد في فريقك', 'Nobody in your team'))}</div>`}</div>`;
  }
  body.onclick = (e) => {
    const s = e.target.closest('[data-tsort]'); if (s) { sortBy = s.dataset.tsort; draw(); return; }
    const t = e.target.closest('[data-tasks-of]'); if (t) openTasksOf(t.dataset.tasksOf);
  };
  const off = onTasks(draw), off2 = onDirectory(draw);
  return () => { un(); off(); off2(); };
}
