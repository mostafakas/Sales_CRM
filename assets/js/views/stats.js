// «الأداء» — one person's performance in one place: the score of every review criterion (measured by the system:
// tasks, quality, punctuality, discipline…), the month's review and its approval chain (leader → supervisor →
// project manager → HR → admin, who sends it), then the numbers behind it: office / remote days, every late
// arrival, leave, absence, hours, tasks, to-dos and requests, against the previous period.
// Everyone sees their own numbers (their score and the reviewers' notes only once the review is sent); leaders see
// their team, supervisors their leaders' teams, PM / HR / admin everyone. #/stats/team lists the people I review.
import { L, esc, num, fmtHours, fmtMin, fmtTime, fmtDay, fmtDate, money, minutesOfDay, hmToMin, ymd, monthDates, addMonths } from '../core/utils.js';
import { avatar, loader, empty, toast, toastErr, busy, confirmDialog } from '../core/ui.js';
import { session, now, isAdmin } from '../core/session.js';
import { read, toMs } from '../core/fb.js';
import { policy, isWorkingPlan, leaveTypeLabel, typeLabel } from '../core/policy.js';
import { personMonth, summarize, teamMonth } from '../services/reports.js';
import { scopeFor } from '../services/attendance.js';
import { person, nameOf } from '../services/directory.js';
import {
  METRICS, TEMPLATES, STAGES, stageLabel, measure as scorePerson, totalOf, gradeOf, toneOf, templateOf, teamOfPerson, chainFor, canAct, canStart, viewable, canView,
  watchReview, watchMonthReviews, act, markSeen, reply, evalId
} from '../services/evaluations.js';
import { startTasks, onTasks, allTasks, periodRange, inPeriod, doneDay, isLate } from '../services/tasks.js';
import { watchTodos } from '../services/todos.js';
import { salaryParts, rulesOf, violationsFrom, priceViolations, violationText } from '../services/salary.js';
import { periodPicker, monthName } from './task-ui.js';
import { showDayDetails } from './attendance.js';
import { setTabLabel } from '../tabs.js';

const hm = (min) => { const m = Math.round(min); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const avg = (xs) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
const pct = (a, b) => (b > 0 ? Math.round(a / b * 100) : 0);
const planMin = (p) => (p && p.start && p.end ? Math.max(0, hmToMin(p.end) - hmToMin(p.start)) : 8 * 60);
const DOW = () => [L('أحد', 'Sun'), L('اتنين', 'Mon'), L('تلات', 'Tue'), L('أربع', 'Wed'), L('خميس', 'Thu'), L('جمعة', 'Fri'), L('سبت', 'Sat')];

/** every number of one period, from the classified days (+ requests, tasks, to-dos) */
function measure(rows, requests, range, tasks, todos) {
  const t = summarize(rows);
  const att = rows.filter(r => r.rec && r.rec.checkInMs);
  const lates = rows.filter(r => r.late > 0);
  const ins = att.map(r => minutesOfDay(r.rec.checkInMs));
  const outs = att.filter(r => r.rec.closed && r.rec.checkOutMs).map(r => minutesOfDay(r.rec.checkOutMs));
  const worked = t.workMs + t.meetingMs;
  const required = att.filter(r => isWorkingPlan(r.plan)).reduce((s, r) => s + planMin(r.plan) * 60000, 0);
  const due = rows.filter(r => isWorkingPlan(r.plan) && !['future', 'today'].includes(r.status) && !(r.flags || []).includes('untracked')).length;
  const leaves = rows.filter(r => r.status === 'leave');
  const reqs = (requests || []).filter(q => q.startDate && q.startDate >= range.from && q.startDate <= range.to && q.status !== 'cancelled');
  const ts = tasks.filter(k => inPeriod(k, range));
  const done = ts.filter(k => k.status === 'done'), open = ts.filter(k => k.status !== 'done');
  const td = todos.filter(x => x.date >= range.from && x.date <= range.to);
  return {
    t, lates, leaves, due, worked, required, reqs, att,
    avgIn: avg(ins), avgOut: avg(outs),
    perDay: t.present ? worked / t.present : 0,
    breakOver: rows.filter(r => r.breakMs > (Number(policy.breakMaxMinutes) || 60) * 60000).length,
    early: rows.filter(r => r.early > 0), shift10: att.filter(r => r.rec.shift === '10').length,
    remotePending: rows.filter(r => (r.flags || []).includes('remote-pending')).length,
    tasks: { all: ts.length, done: done.length, open: open.length, late: open.filter(isLate).length, onTime: pct(done.filter(k => !k.due || doneDay(k) <= k.due).length, done.length) },
    todo: { all: td.length, done: td.filter(x => x.done).length }
  };
}

// ---------- performance building blocks ----------
const ring = (v, size = '', locked = false) => { const g = gradeOf(v); return `<div class="ev-ring ${size} ${locked ? '' : g ? g.tone : ''}" style="--v:${locked ? 0 : v ?? 0}"><div>${locked ? '<i class="fas fa-lock muted"></i>' : `<b class="num">${v ?? '—'}</b>${g ? `<small>${esc(g.name)}</small>` : ''}`}</div></div>`; };
const chip = (v) => (v == null ? '<span class="muted">—</span>' : `<span class="ev-sc ${toneOf(v)} num">${v}</span>`);
const starsOf = (n) => `<span class="ev-stars">${[1, 2, 3, 4, 5].map(s => `<i class="fas fa-star ${s <= n ? 'on' : ''}"></i>`).join('')}</span>`;
const ACTION = { submit: ['اعتمد', 'Approved', 'ok', 'fa-check'], approve: ['اعتمد', 'Approved', 'ok', 'fa-check'], send: ['اعتمد وبعت للموظف', 'Sent to the employee', 'brand', 'fa-paper-plane'], return: ['رجّعه', 'Returned it', 'warn', 'fa-rotate-left'] };
const personHead = (p, own, extra = '') => `<div class="row gap-12">${avatar(p, 'lg')}<div><h2>${own ? L('أدائي', 'My performance') : esc(p.name || p.email)}</h2><p>${esc(p.title || '')}${p.department ? ' · ' + esc(p.department) : ''}${extra}</p></div></div>`;
const tabsBar = (on) => viewable().length ? `<div class="seg"><a href="#/stats" class="${on === 'me' ? 'on' : ''}"><i class="fas fa-user"></i>${L('أدائي', 'Mine')}</a><a href="#/stats/team" class="${on === 'team' ? 'on' : ''}"><i class="fas fa-users"></i>${L('الفريق', 'Team')}</a></div>` : '';
/** the chain as steps: done ✓ / with whom now / still to come */
function stepper(ev, p) {
  const chain = ev ? ev.chain : chainFor(p);
  return `<div class="pf-steps">${chain.map((s, i) => {
    const st = !ev ? 'todo' : ev.sent || i < ev.stage ? 'done' : i === ev.stage ? (ev.status === 'returned' ? 'back' : 'now') : 'todo';
    const icon = st === 'done' ? 'fa-check' : st === 'now' ? 'fa-hourglass-half' : st === 'back' ? 'fa-rotate-left' : STAGES[s.key].icon;
    return `<div class="pf-step ${st}"><span class="pf-dot"><i class="fas ${icon}"></i></span><div><b>${esc(stageLabel(s.key))}</b><small>${esc(s.email ? nameOf(s.email) : s.key === 'admin' ? L('بيبعته للموظف', 'sends it') : '')}</small></div></div>`;
  }).join('<span class="pf-line"></span>')}</div>`;
}

/** #/stats/team — everyone I review, their score this month and where their review is */
async function teamView(root) {
  let month = ymd(now()).slice(0, 7), data = null, revs = [], un = null, mineOnly = false;
  root.innerHTML = `<div class="st-page">
    <div class="page-head"><div><h2>${L('أداء الفريق', 'Team performance')}</h2><p>${L('درجة كل واحد محسوبة من السيستم، وتقييم الشهر بيعدّي على الليدر ← السوبر فايزر ← مدير المشروعات ← HR ← الأدمن اللي بيبعته.', 'Scores are measured by the system; the monthly review goes leader → supervisor → PM → HR → admin, who sends it.')}</p></div>
      <div class="row gap-8 wrap">${tabsBar('team')}<span id="period"></span></div></div>
    <div class="row gap-8 mb-16"><label class="row gap-8 small"><input type="checkbox" id="mine-only"> ${L('اللي مستنيين دوري بس', 'Waiting for me only')}</label></div>
    <div id="tm">${loader()}</div></div>`;
  const $ = (s) => root.querySelector(s);
  async function load() {
    $('#tm').innerHTML = loader();
    if (un) un();
    un = watchMonthReviews(month, rows => { revs = rows; draw(); });
    data = await teamMonth(month).catch(() => ({ people: [] }));
    draw();
  }
  function draw() {
    $('#period').innerHTML = periodPicker(month, 0, { ahead: 0, weeks: false });
    if (!data) return;
    const range = periodRange(month, 0);
    const rowsOf = Object.fromEntries(data.people.map(x => [x.person.email, x.rows]));
    const items = viewable().map(p => {
      const ev = revs.find(r => r.id === evalId(p.email, month)) || null;
      const manual = Object.fromEntries(((ev && ev.criteria) || []).filter(c => c.source === 'manual' && c.stars).map(c => [c.id, { stars: c.stars, evidence: c.evidence }]));
      const live = scorePerson(p, { rows: rowsOf[p.email] || [], tasks: allTasks(), range, teamRows: rowsOf }, manual);
      const turn = ev ? canAct(ev) : canStart(p);
      const weak = live.criteria.filter(c => c.score != null).sort((a, b) => a.score - b.score)[0];
      return { p, ev, live, turn, weak };
    }).filter(x => !mineOnly || x.turn)
      .sort((a, b) => (b.turn - a.turn) || (a.p.name || '').localeCompare(b.p.name || '', 'ar'));
    const waiting = items.filter(x => x.turn).length;
    $('#tm').innerHTML = !items.length ? `<div class="card">${empty('fa-users', mineOnly ? L('مفيش تقييمات مستنياك 👌', 'Nothing waiting for you 👌') : L('مفيش حد في فريقك', 'No one in your team'))}</div>`
      : `${waiting ? `<div class="pf-alert"><i class="fas fa-hourglass-half"></i> ${L(`${waiting} تقييم مستني دورك في ${monthName(month)}`, `${waiting} reviews waiting for you`)}</div>` : ''}
      <div class="card"><div class="table-wrap"><table class="table pf-table"><thead><tr><th>${L('الموظف', 'Employee')}</th><th>${L('الدرجة', 'Score')}</th><th>${L('المعايير', 'Criteria')}</th><th>${L('أضعف نقطة', 'Weakest')}</th><th>${L('تقييم الشهر', 'Monthly review')}</th><th></th></tr></thead><tbody>
      ${items.map(({ p, ev, live, turn, weak }) => `<tr class="${turn ? 'turn' : ''}"><td><div class="row gap-8">${avatar(p, 'sm')}<div><b>${esc(p.name || p.email)}</b><div class="xs muted">${esc(p.department || '')} · ${esc(L(...TEMPLATES[live.template]))}</div></div></div></td>
        <td><div class="row gap-8">${ring(ev && ev.sent ? ev.total : live.total, 'sm')}</div></td>
        <td><div class="pf-dots">${live.criteria.map(c => `<span class="${c.score == null ? 'na' : toneOf(c.score)}" title="${esc(c.name)}: ${c.score ?? '—'}"></span>`).join('')}</div></td>
        <td>${weak ? `<span class="small">${esc(weak.name)}</span> ${chip(weak.score)}` : '<span class="muted">—</span>'}</td>
        <td>${!ev ? `<span class="badge">${L('لسه متبدأش', 'Not started')}</span>` : ev.sent ? `<span class="badge ok"><i class="fas fa-paper-plane"></i>${L('اتبعت', 'Sent')}${ev.seenAt ? ' · ' + L('شافه', 'seen') : ''}</span>`
          : `<span class="badge ${ev.status === 'returned' ? 'warn' : 'info'}">${ev.status === 'returned' ? L('راجع لـ', 'Back to') : L('عند', 'With')} ${esc(stageLabel(ev.chain[ev.stage].key))}</span>`}${turn ? ` <span class="badge brand">${L('دورك', 'Your turn')}</span>` : ''}</td>
        <td><a class="btn btn-sm ${turn ? 'btn-primary' : ''}" href="#/stats/${encodeURIComponent(p.email)}/${month}">${turn ? `<i class="fas fa-pen"></i> ${ev ? L('راجع', 'Review') : L('قيّم', 'Review')}` : `<i class="fas fa-eye"></i> ${L('افتح', 'Open')}`}</a></td></tr>`).join('')}
      </tbody></table></div></div>
      <p class="xs muted mt-8"><i class="fas fa-circle-info"></i> ${L('النقط الملونة = المعايير بالترتيب (أخضر كويس، أصفر محتاج انتباه، أحمر ضعيف، رمادي ملوش داتا).', 'Dots = the criteria in order (green good, amber needs attention, red weak, grey no data).')}</p>`;
  }
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-pp-month]')) { month = e.target.value; load(); }
    if (e.target.id === 'mine-only') { mineOnly = e.target.checked; draw(); }
  });
  const off = onTasks(() => draw());
  await load();
  return () => { off(); if (un) un(); };
}

export default async function render(root, { params = [] }) {
  startTasks();
  const admin = isAdmin();
  const want = params[0] ? decodeURIComponent(params[0]) : '';
  if (want === 'team') return teamView(root);
  const email = want && canView(want) ? want : session.email;   // others only within my scope
  const own = email === session.email;
  const p = person(email) || { email, name: nameOf(email) };
  setTabLabel(own ? '' : (p.name || email));
  let month = /^\d{4}-\d{2}$/.test(params[1] || '') ? params[1] : ymd(now()).slice(0, 7), week = 0, cur = null, prev = null, todos = [], unTodo = null, priv = null;
  let teamRows = {}, review = null, unRev = null, form = null;
  const people = viewable();

  root.innerHTML = `<div class="st-page">
    <div class="page-head">${personHead(p, own)}
      <div class="row gap-8 wrap">${tabsBar(own ? 'me' : '')}${people.length ? `<select class="select" id="who" style="min-width:200px"><option value="${esc(session.email)}">${L('أنا', 'Me')}</option>${people.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar')).map(x => `<option value="${esc(x.email)}" ${x.email === email ? 'selected' : ''}>${esc(x.name || x.email)}</option>`).join('')}</select>` : ''}<span id="period"></span></div></div>
    <div id="pf-top"></div><div id="pf-review"></div>
    <h3 class="pf-h"><i class="fas fa-chart-line"></i> ${L('الأرقام بالتفصيل', 'The numbers in detail')}</h3>
    <div id="st">${loader()}</div></div>`;
  const $ = (s) => root.querySelector(s);
  if (admin) priv = await read('employees_private', email).catch(() => null);
  const isLead = templateOf(p) === 'leader';
  // the manual criteria as the review has them (an employee sees them only once it is sent)
  const manualOf = () => (review && (!own || review.sent) ? Object.fromEntries((review.criteria || []).filter(c => c.source === 'manual' && c.stars).map(c => [c.id, { stars: c.stars, evidence: c.evidence }])) : {});
  const scoreFor = (rows, range, manual = manualOf()) => scorePerson(p, { rows, tasks: allTasks(), range, teamRows }, manual);

  async function load() {
    $('#st').innerHTML = loader();
    const scope = scopeFor(email);
    try {
      [cur, prev] = await Promise.all([personMonth(email, month, scope), personMonth(email, addMonths(month, -1), scope).catch(() => null)]);
      if (isLead) { const tm = await teamMonth(month, { people: teamOfPerson(p) }).catch(() => null); teamRows = tm ? Object.fromEntries(tm.people.map(x => [x.person.email, x.rows])) : {}; }
    } catch (e) { $('#st').innerHTML = `<div class="card">${empty('fa-triangle-exclamation', L('تعذّر تحميل البيانات', 'Could not load data'), esc(e.message || ''))}</div>`; return; }
    if (unTodo) unTodo();
    unTodo = watchTodos(email, [month, addMonths(month, -1)], rows => { todos = rows; draw(); });
    if (unRev) unRev();
    review = null; form = null;
    unRev = watchReview(email, month, ev => { review = ev; form = null; draw(); drawReview(); });
    draw(); drawReview();
  }

  /** the score and every criterion, for the picked period */
  function drawTop(range, prng) {
    const inRg = (r, rg) => r.date >= rg.from && r.date <= rg.to;
    const live = scoreFor(cur.rows.filter(r => inRg(r, range)), range);
    const before = prev ? scorePerson(p, { rows: prev.rows.filter(r => inRg(r, prng)), tasks: allTasks(), range: prng, teamRows: {} }, manualOf()).total : null;
    const sent = review && review.sent ? review : null;
    const locked = own && !sent;                                    // my score shows once the month's review reaches me
    const total = own ? (sent && !week ? sent.total : null) : live.total;
    const g = gradeOf(total);
    const d = !own && total != null && before != null ? total - before : null;
    $('#pf-top').innerHTML = `<section class="card pf-hero">
      <div class="pf-score">${ring(total, 'xl', locked || (own && week))}
        <div class="pf-grade">${locked ? `<b>${L('درجتك بتظهر لما تقييم الشهر يوصلك', 'Your score shows once the month\'s review reaches you')}</b><small class="muted">${L('الأرقام تحت بتتحدّث أول بأول.', 'The numbers below update live.')}</small>`
          : own && week ? `<b>${L('الدرجة بتتحسب على الشهر كله', 'The score is for the whole month')}</b>`
          : g ? `<b class="tone-${g.tone}">${esc(g.name)}</b><small>${esc(g.effect || '')}</small>${d != null && d !== 0 ? `<span class="st-d ${d > 0 ? 'ok' : 'bad'}"><i class="fas fa-arrow-${d > 0 ? 'up' : 'down'}"></i>${Math.abs(d)} ${L('نقطة عن الشهر اللي فات', 'pts vs last month')}</span>` : ''}` : `<b class="muted">${L('مفيش داتا كفاية', 'Not enough data')}</b>`}
          <span class="badge">${esc(L(...TEMPLATES[live.template]))}</span></div></div>
      <div class="pf-crit">${live.criteria.map(c => {
        const m = METRICS[c.source] || METRICS.manual;
        const hideManual = c.source === 'manual' && own && !sent;
        const v = hideManual ? null : c.score;
        return `<div class="pf-c ${v == null ? 'na' : toneOf(v)}"><div class="pf-c-top"><i class="fas ${m.icon}"></i><span class="grow">${esc(c.name)}</span><small>${c.weight}%</small></div>
          <div class="pf-c-val">${c.source === 'manual' ? (hideManual || !c.stars ? `<span class="pf-c-wait">${L('بيقيّمها المدير', 'Rated by the manager')}</span>` : starsOf(c.stars)) : `<b class="num">${v ?? '—'}</b>${v == null ? '' : '<small>%</small>'}`}</div>
          <div class="pf-c-bar"><span style="width:${v ?? 0}%"></span></div>
          <small class="pf-c-fact">${esc(hideManual ? '' : c.fact || (c.score == null ? L('مفيش داتا في الفترة دي', 'No data in this period') : ''))}</small></div>`;
      }).join('')}</div></section>`;
  }

  /** the month's review: the chain, what each reviewer wrote, and my part when it is my turn */
  function drawReview() {
    const box = $('#pf-review');
    if (!cur) { box.innerHTML = ''; return; }
    const ev = review;
    const mine = ev ? canAct(ev) : canStart(p);
    if (own && !(ev && ev.sent)) {
      box.innerHTML = `<section class="card pf-rev"><div class="card-head"><h3><i class="fas fa-clipboard-check"></i> ${L(`تقييم ${monthName(month)}`, `${monthName(month)} review`)}</h3></div>
        <div class="card-body">${empty('fa-hourglass-half', L('لسه ما وصلكش', 'Not with you yet'), L('بيعدّي على مديرينك وبيوصلك من الأدمن مع الملاحظات.', 'It goes through your managers and reaches you from the admin, with their notes.'))}</div></section>`;
      return;
    }
    if (!ev && !mine) {
      box.innerHTML = `<section class="card pf-rev"><div class="card-head"><h3><i class="fas fa-clipboard-check"></i> ${L(`تقييم ${monthName(month)}`, `${monthName(month)} review`)}</h3><span class="badge">${L('لسه متبدأش', 'Not started')}</span></div><div class="card-body">${stepper(null, p)}</div></section>`;
      return;
    }
    if (own && ev.sent) markSeen(ev);
    const hidden = new Set(ev ? ev.hidden || [] : []);
    const last = ev ? ev.stage === ev.chain.length - 1 : chainFor(p).length === 1;
    const adminSend = mine && last && isAdmin();
    const critName = (id) => (((ev && ev.criteria) || []).find(c => c.id === id) || {}).name || id;
    const hist = ((ev && ev.reviews) || []).map((r, i) => ({ r, i })).filter(({ r }) => !own || r.action !== 'return');
    const noteLine = (key, label, text) => (own && hidden.has(key)) ? '' : `<div class="pf-note ${hidden.has(key) ? 'hid' : ''}">${adminSend ? `<label class="pf-hide" title="${L('إخفاء عن الموظف', 'Hide from the employee')}"><input type="checkbox" data-hide="${key}" ${hidden.has(key) ? 'checked' : ''}><i class="fas fa-eye-slash"></i></label>` : ''}${label ? `<b>${esc(label)}:</b> ` : ''}${esc(text)}</div>`;
    const histHtml = hist.length ? `<div class="pf-hist">${hist.map(({ r, i }) => { const a = ACTION[r.action] || ACTION.submit; return `<div class="pf-entry">
        <div class="row gap-8">${avatar(person(r.by) || { name: r.name, email: r.by }, 'sm')}<b>${esc(r.name || nameOf(r.by))}</b><small class="muted">${esc(stageLabel(r.stage))} · ${esc(fmtDate(ymd(r.at)))} ${esc(fmtTime(r.at))}</small><span class="badge ${a[2]}"><i class="fas ${a[3]}"></i>${esc(L(a[0], a[1]))}</span></div>
        ${r.reason ? `<div class="pf-note warn"><b>${L('السبب', 'Reason')}:</b> ${esc(r.reason)}</div>` : ''}
        ${r.comment ? noteLine(`${i}:c`, '', r.comment) : ''}
        ${Object.entries(r.notes || {}).map(([id, t]) => noteLine(`${i}:${id}`, critName(id), t)).join('')}</div>`; }).join('')}</div>` : '';
    const sentPart = ev && ev.sent ? `<div class="pf-sent">${ring(ev.total, 'lg')}<div><b class="tone-${(gradeOf(ev.total) || {}).tone}">${esc(ev.grade)}</b><div class="small muted">${esc(ev.effect || '')}</div>${ev.sentAt ? `<div class="xs muted">${L('اتبعت', 'Sent')} ${esc(fmtDate(ymd(toMs(ev.sentAt) || now())))}</div>` : ''}</div></div>` : '';
    let formHtml = '';
    if (mine) {
      if (!form) {
        const draft = ev && ev.draft && ev.draft.by === session.email ? ev.draft : null;
        form = { manual: Object.fromEntries(((ev && ev.criteria) || []).filter(c => c.source === 'manual').map(c => [c.id, { stars: c.stars || 0, evidence: c.evidence || '' }])), notes: { ...((draft && draft.notes) || {}) }, comment: (draft && draft.comment) || '', hidden: [...hidden] };
      }
      const crit = scoreFor(cur.rows, periodRange(month, 0), form.manual).criteria;
      const stage = ev ? ev.chain[ev.stage] : chainFor(p)[0];
      const nxt = ev ? ev.chain[ev.stage + 1] : chainFor(p)[1];
      formHtml = `<div class="pf-form"><h4><i class="fas fa-pen-to-square"></i> ${L(`دورك (${stageLabel(stage.key)})`, `Your part (${stageLabel(stage.key)})`)}${isAdmin() && stage.key !== 'admin' ? ` <small class="muted">${L('— إنت أدمن وبتعتمد بدل المرحلة دي', '— acting as admin')}</small>` : ''}</h4>
        ${crit.filter(c => c.source === 'manual').map(c => `<div class="pf-man"><div class="row between wrap gap-8"><b>${esc(c.name)} <small class="muted">${c.weight}%</small></b><span class="ev-stars edit">${[1, 2, 3, 4, 5].map(s => `<button type="button" data-star="${esc(c.id)}:${s}" class="${s <= ((form.manual[c.id] || {}).stars || 0) ? 'on' : ''}"><i class="fas fa-star"></i></button>`).join('')}</span></div>
          <textarea class="textarea" rows="2" data-evd="${esc(c.id)}" placeholder="${L('الدليل: موقف أو مثال حصل فعلاً (إجباري)', 'Evidence: a real example (required)')}">${esc((form.manual[c.id] || {}).evidence || '')}</textarea></div>`).join('')}
        <details class="pf-notes" ${Object.keys(form.notes).length ? 'open' : ''}><summary><i class="fas fa-note-sticky"></i> ${L('ملاحظات على كل معيار (اختياري)', 'Notes on each criterion (optional)')}</summary>
          ${crit.filter(c => c.source !== 'manual').map(c => `<div class="pf-nrow"><span>${esc(c.name)} ${chip(c.score)}</span><input class="input" data-note="${esc(c.id)}" value="${esc(form.notes[c.id] || '')}" placeholder="${L('ملاحظتك…', 'Your note…')}"></div>`).join('')}</details>
        <div class="field mt-8"><label>${L('التقييم المكتوب', 'Written evaluation')}</label><textarea class="textarea" rows="3" id="pf-comment" placeholder="${L('نقط القوة، اللي محتاج يتحسن، والخطة…', 'Strengths, what to improve, the plan…')}">${esc(form.comment)}</textarea></div>
        <div class="pf-actions"><button class="btn" data-act="save"><i class="fas fa-floppy-disk"></i> ${L('حفظ مسودة', 'Save draft')}</button>
          ${ev && ev.stage > 0 ? `<button class="btn" data-act="return"><i class="fas fa-rotate-left"></i> ${L(`رجّعه لـ${stageLabel(ev.chain[ev.stage - 1].key)}`, 'Return')}</button>` : ''}
          <span class="grow"></span>
          <button class="btn btn-primary" data-act="submit"><i class="fas ${nxt ? 'fa-check' : 'fa-paper-plane'}"></i> ${nxt ? L(`اعتماد وتمرير لـ${stageLabel(nxt.key)}`, `Approve → ${stageLabel(nxt.key)}`) : L('اعتماد وإرسال للموظف', 'Approve & send')}</button></div></div>`;
    }
    box.innerHTML = `<section class="card pf-rev"><div class="card-head"><h3><i class="fas fa-clipboard-check"></i> ${L(`تقييم ${monthName(month)}`, `${monthName(month)} review`)}</h3>${ev && !ev.sent && !own ? `<span class="badge info">${L('الدرجة لحد دلوقتي', 'Score so far')} ${ev.total ?? '—'}</span>` : ''}</div>
      <div class="card-body">${own ? '' : stepper(ev, p)}${sentPart}${histHtml}${formHtml}
        ${own && ev && ev.sent ? (ev.reply ? `<div class="ev-note reply"><i class="fas fa-reply"></i><div><b>${L('ردّك', 'Your reply')}</b><p>${esc(ev.reply)}</p></div></div>`
          : `<div class="field mt-16"><label>${L('عندك تعليق على التقييم؟ (اختياري)', 'Any comment on the review? (optional)')}</label><textarea class="textarea" id="pf-reply" rows="2" maxlength="1000"></textarea></div><div class="row mt-8"><button class="btn btn-primary" id="pf-send-reply"><i class="fas fa-reply"></i> ${L('إرسال الرد', 'Send reply')}</button></div>`)
          : ev && ev.reply ? `<div class="ev-note reply"><i class="fas fa-reply"></i><div><b>${L(`ردّ ${p.name || ''}`, 'Their reply')}</b><p>${esc(ev.reply)}</p></div></div>` : ''}</div></section>`;
  }

  async function doAct(action, btn) {
    let reason = '';
    if (action === 'return') {
      reason = await confirmDialog({ title: L('رجّع التقييم', 'Return the review'), message: L('هيرجع للمرحلة اللي قبلك مع السبب.', 'It goes back one step, with your reason.'), okText: L('رجّعه', 'Return'), okClass: 'btn-danger', input: { label: L('السبب', 'Reason'), required: true } });
      if (!reason) return;
    }
    if (action === 'submit' && !(await confirmDialog({ title: L('اعتماد التقييم', 'Approve the review'), message: (review ? review.stage === review.chain.length - 1 : chainFor(p).length === 1) ? L('هيتبعت للموظف ويوصله إشعار.', 'It will be sent to the employee.') : L('هيتنقل للمرحلة اللي بعدك.', 'It moves to the next stage.'), okText: L('اعتماد', 'Approve') }))) return;
    await busy(btn, async () => {
      try {
        const fresh = scoreFor(cur.rows, periodRange(month, 0), form.manual);
        const r = await act(p, month, review, { action, fresh, manual: form.manual, comment: form.comment, notes: form.notes, reason, hidden: isAdmin() ? form.hidden : null });
        toast(action === 'save' ? L('اتحفظت المسودة', 'Draft saved') : action === 'return' ? L('اترجع', 'Returned') : r.sent ? L('اتبعت للموظف', 'Sent to the employee') : L('اتعتمد واتنقل للمرحلة اللي بعدك', 'Approved and passed on'), `${r.total ?? '—'} · ${r.grade}`);
      } catch (ex) { toastErr(ex); }
    });
  }
  $('#pf-review').addEventListener('input', (e) => {
    if (!form) return;
    const d = e.target.dataset;
    if (d.evd) (form.manual[d.evd] = form.manual[d.evd] || { stars: 0, evidence: '' }).evidence = e.target.value;
    else if (d.note) { if (e.target.value.trim()) form.notes[d.note] = e.target.value; else delete form.notes[d.note]; }
    else if (e.target.id === 'pf-comment') form.comment = e.target.value;
  });
  $('#pf-review').addEventListener('change', (e) => {
    const k = e.target.dataset.hide;
    if (k && form) { form.hidden = form.hidden.filter(x => x !== k); if (e.target.checked) form.hidden.push(k); e.target.closest('.pf-note').classList.toggle('hid', e.target.checked); }
  });
  $('#pf-review').addEventListener('click', (e) => {
    const st = e.target.closest('[data-star]');
    if (st && form) {
      const [id, s] = st.dataset.star.split(':'); const n = Number(s);
      const m = form.manual[id] = form.manual[id] || { stars: 0, evidence: '' };
      m.stars = m.stars === n ? n - 1 : n;
      st.parentElement.querySelectorAll('[data-star]').forEach(b => b.classList.toggle('on', Number(b.dataset.star.split(':')[1]) <= m.stars));
      return;
    }
    const a = e.target.closest('[data-act]');
    if (a) { doAct(a.dataset.act, a); return; }
    if (e.target.closest('#pf-send-reply')) {
      const t = $('#pf-reply').value.trim(); if (!t) { $('#pf-reply').focus(); return; }
      busy(e.target.closest('button'), async () => { try { await reply(review, t); toast(L('اتبعت ردّك', 'Reply sent')); } catch (ex) { toastErr(ex); } });
    }
  });

  function draw() {
    $('#period').innerHTML = periodPicker(month, week, { ahead: 0 });
    if (!cur) return;
    const range = periodRange(month, week);
    const inR = (r, rg) => r.date >= rg.from && r.date <= rg.to;
    const tasks = allTasks().filter(k => k.assignee === email);
    const m = measure(cur.rows.filter(r => inR(r, range)), cur.requests, range, tasks, todos);
    const prng = periodRange(addMonths(month, -1), week);
    // a period still running is compared with the same days of the previous month (1–7 Oct ↔ 1–7 Sep), not the whole month
    const tdy = ymd(now()), running = tdy >= range.from && tdy <= range.to;
    if (running) { const cap = `${prng.from.slice(0, 7)}-${tdy.slice(8)}`; prng.to = cap < prng.from ? prng.from : (cap < prng.to ? cap : prng.to); }
    const pm = prev ? measure(prev.rows.filter(r => inR(r, prng)), prev.requests, prng, tasks, todos) : null;
    const quota = Number(p.remoteQuota ?? policy.defaultRemoteQuota) || 0;
    // ↑/↓ against the previous month (same week when a week is picked); good = the direction that is better
    const delta = (now_, before, good = 'down') => {
      if (!pm || before == null || now_ == null) return '';
      if (Math.round(now_) === Math.round(before)) return `<span class="st-d same">=</span>`;
      const up = now_ > before;
      const ok = (good === 'up') === up;
      const p_ = before ? Math.round(Math.abs(now_ - before) / Math.abs(before) * 100) : null;
      return `<span class="st-d ${ok ? 'ok' : 'bad'}" title="${L('مقارنة بالفترة اللي قبلها', 'vs the previous period')}"><i class="fas fa-arrow-${up ? 'up' : 'down'}"></i>${p_ === null ? '' : `${p_}%`}</span>`;
    };
    drawTop(range, prng);
    const tile = (icon, cls, label, value, hint, d = '') => `<div class="card stat st-tile"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}${d}</div><div class="value">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
    const leaveTypes = Object.entries(m.t.leaveByType || {});
    const t = m.t;

    // the month, day by day
    const byDate = Object.fromEntries(cur.rows.map(r => [r.date, r]));
    const days = monthDates(month);
    const lead = new Date(`${days[0]}T00:00:00Z`).getUTCDay();
    const cls = (r) => !r ? '' : r.status === 'present' ? (r.late ? 'lt' : 'of') : r.status === 'remote' ? (r.late ? 'lt' : 're') : r.status === 'absent' ? 'ab' : r.status === 'leave' ? 'lv' : (r.status === 'off' || r.status === 'holiday') ? 'off' : '';
    const cal = `<div class="st-cal">${DOW().map(d => `<div class="st-dow">${d}</div>`).join('')}${'<div></div>'.repeat(lead)}${days.map(d => { const r = byDate[d]; return `<button class="st-day ${cls(r)} ${inR({ date: d }, range) ? '' : 'dim'} ${d === ymd(now()) ? 'today' : ''}" data-day="${d}" title="${esc(fmtDay(d))}">${Number(d.slice(8))}</button>`; }).join('')}</div>
      <div class="st-leg"><span><i class="of"></i>${L('مقر', 'Office')}</span><span><i class="re"></i>${L('أونلاين', 'Remote')}</span><span><i class="lt"></i>${L('تأخير', 'Late')}</span><span><i class="lv"></i>${L('إجازة', 'Leave')}</span><span><i class="ab"></i>${L('غياب', 'Absent')}</span><span><i class="off"></i>${L('راحة / عطلة', 'Off')}</span></div>`;
    // hours per day
    const daysW = m.att.filter(r => r.status === 'present' || r.status === 'remote');
    const maxW = Math.max(1, ...daysW.map(r => r.workMs + r.meetingMs), ...daysW.map(r => planMin(r.plan) * 60000));
    const bars = daysW.length ? `<div class="st-bars">${daysW.map(r => { const w = r.workMs + r.meetingMs; const need = planMin(r.plan) * 60000; return `<div class="st-bar ${w >= need ? 'ok' : 'low'}" title="${esc(fmtDay(r.date))}: ${esc(fmtHours(w))}"><span style="height:${Math.max(4, Math.round(w / maxW * 100))}%"></span><small>${Number(r.date.slice(8))}</small></div>`; }).join('')}</div>` : empty('fa-chart-column', L('مفيش أيام شغل في الفترة دي', 'No working days in this period'));
    const mix = t.workMs + t.meetingMs + t.breakMs;
    const reqByType = {};
    m.reqs.forEach(q => { const x = reqByType[q.type] = reqByType[q.type] || { all: 0, ok: 0, no: 0, wait: 0 }; x.all++; if (q.status === 'approved') x.ok++; else if (q.status === 'rejected') x.no++; else x.wait++; });
    let ded = '';
    if (admin && priv) {
      const parts = salaryParts(priv);
      if (parts.structured) {
        const priced = priceViolations(violationsFrom(cur.rows.filter(r => inR(r, range)), cur.requests), parts, rulesOf(priv));
        const total = priced.lines.reduce((s, l) => s + l.total, 0);
        ded = `<section class="card"><div class="card-head"><h3><i class="fas fa-money-bill-wave" style="color:var(--bad)"></i> ${L('الخصومات لحد دلوقتي', 'Deductions so far')} <span class="badge">${L('للأدمن بس', 'Admins only')}</span></h3><b class="num" style="color:${total ? 'var(--bad)' : 'var(--ok)'}">${esc(money(total))}</b></div>
          ${priced.lines.length ? `<div class="table-wrap"><table class="table"><tbody>${priced.lines.map(l => `<tr><td class="num nowrap">${esc(fmtDay(l.date))}</td><td>${esc(violationText(l))}</td><td class="num" style="color:var(--bad)">−${esc(money(l.total, false))}</td></tr>`).join('')}</tbody></table></div>` : `<div class="card-body">${empty('fa-face-smile', L('مفيش خصومات 👏', 'No deductions 👏'))}</div>`}</section>`;
      }
    }

    $('#st').innerHTML = `
      <div class="grid g-4 keep-2 mb-16">
        ${tile('fa-building', 'ok', L('أيام المقر', 'Office days'), num(t.office), L(`من ${m.due} يوم مطلوب`, `of ${m.due} working days`), delta(t.office, pm && pm.t.office, 'up'))}
        ${tile('fa-house-laptop', 'brand', L('أيام الأونلاين', 'Remote days'), num(t.remote), `${L(`الحصة ${quota} في الشهر`, `quota ${quota} a month`)}${m.remotePending ? ` · <span class="bad-txt">${L(`${m.remotePending} مستني موافقة`, `${m.remotePending} pending`)}</span>` : ''}`, delta(t.remote, pm && pm.t.remote, 'down'))}
        ${tile('fa-clock', 'warn', L('أيام التأخير', 'Late days'), `<span class="${t.lateDays ? 'bad-txt' : ''}">${num(t.lateDays)}</span>`, t.lateMinutes ? L(`إجمالي ${fmtMin(t.lateMinutes)}`, `${fmtMin(t.lateMinutes)} in total`) : L('مفيش تأخير 👌', 'Never late 👌'), delta(t.lateMinutes, pm && pm.t.lateMinutes, 'down'))}
        ${tile('fa-umbrella-beach', 'info', L('الإجازات', 'Leave'), num(t.leave), leaveTypes.length ? leaveTypes.map(([k, n]) => `${esc(leaveTypeLabel(k))} ${n}`).join(' · ') : L('مخدش إجازات', 'No leave taken'))}
        ${tile('fa-user-check', t.absent ? 'bad' : 'ok', L('الالتزام', 'Commitment'), `${t.commitment}<small>%</small>`, L(`غياب ${t.absent} يوم`, `${t.absent} days absent`), delta(t.commitment, pm && pm.t.commitment, 'up'))}
        ${tile('fa-right-to-bracket', '', L('متوسط الحضور', 'Average check-in'), m.avgIn == null ? '—' : `<span class="num">${hm(m.avgIn)}</span>`, m.avgOut == null ? '' : L(`متوسط الانصراف ${hm(m.avgOut)}`, `average check-out ${hm(m.avgOut)}`), delta(m.avgIn, pm && pm.avgIn, 'down'))}
        ${tile('fa-business-time', 'info', L('ساعات العمل الفعلية', 'Actual work hours'), esc(fmtHours(m.worked)), `${L(`متوسط ${fmtHours(m.perDay)} / يوم`, `${fmtHours(m.perDay)} / day`)}${m.required ? ` · ${pct(m.worked, m.required)}% ${L('من المطلوب', 'of required')}` : ''}`, delta(m.perDay, pm && pm.perDay, 'up'))}
        ${tile('fa-clipboard-check', 'ok', L('التاسكات', 'Tasks'), `${m.tasks.done}<small>/${m.tasks.all}</small>`, `${m.tasks.done ? L(`في الميعاد ${m.tasks.onTime}%`, `on time ${m.tasks.onTime}%`) : L('لسه مفيش منجز', 'none finished yet')}${m.tasks.late ? ` · <span class="bad-txt">${L(`${m.tasks.late} متأخر`, `${m.tasks.late} late`)}</span>` : ''}`, delta(m.tasks.done, pm && pm.tasks.done, 'up'))}
      </div>
      <div class="st-grid mb-16">
        <section class="card"><div class="card-head"><h3><i class="fas fa-clock" style="color:var(--warn)"></i> ${L('التأخيرات بمواعيدها', 'Late arrivals')}</h3><span class="num muted">${m.lates.length}</span></div>
          ${m.lates.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>${L('اليوم', 'Day')}</th><th class="num">${L('الميعاد', 'Start')}</th><th class="num">${L('الحضور', 'Check-in')}</th><th class="num">${L('التأخير', 'Late')}</th><th></th></tr></thead><tbody>
            ${m.lates.map(r => `<tr data-day="${r.date}" style="cursor:pointer"><td>${esc(fmtDay(r.date))}</td><td class="num muted">${esc(r.plan.start || policy.workStart)}</td><td class="num"><b>${esc(fmtTime(r.rec.checkInMs))}</b></td><td class="num bad-txt">${esc(fmtMin(r.late))}</td><td>${r.rec.shift === '10' ? `<span class="badge info">${L('شيفت 10', '10:00 shift')}</span>` : ''}${r.status === 'remote' ? `<span class="badge brand">${L('أونلاين', 'Remote')}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`
            : `<div class="card-body">${empty('fa-face-smile', L('مفيش ولا تأخير في الفترة دي 👏', 'Not late once in this period 👏'))}</div>`}</section>
        <section class="card"><div class="card-head"><h3><i class="fas fa-calendar-days"></i> ${monthName(month)}</h3></div><div class="card-body">${cal}</div></section>
      </div>
      <div class="st-grid mb-16">
        <section class="card"><div class="card-head"><h3><i class="fas fa-chart-column"></i> ${L('ساعات كل يوم (شغل + اجتماعات)', 'Hours per day (work + meetings)')}</h3><span class="xs muted">${L('أخضر = كمّل ساعاته', 'green = full hours')}</span></div><div class="card-body">${bars}</div></section>
        <section class="card"><div class="card-head"><h3><i class="fas fa-chart-pie"></i> ${L('شكل اليوم', 'How the day went')}</h3></div><div class="card-body">
          ${mix ? `<div class="st-mix"><span class="w" style="width:${pct(t.workMs, mix)}%"></span><span class="m" style="width:${pct(t.meetingMs, mix)}%"></span><span class="b" style="width:${pct(t.breakMs, mix)}%"></span></div>
          <div class="st-leg mb-8"><span><i class="w"></i>${L('شغل', 'Work')} ${pct(t.workMs, mix)}%</span><span><i class="m"></i>${L('اجتماعات', 'Meetings')} ${pct(t.meetingMs, mix)}%</span><span><i class="b"></i>${L('استراحة', 'Breaks')} ${pct(t.breakMs, mix)}%</span></div>` : ''}
          <div class="st-facts">
            <div><span>${L('استراحة زيادة عن المسموح', 'Break over the limit')}</span><b class="${m.breakOver ? 'bad-txt' : ''}">${L(`${m.breakOver} يوم`, `${m.breakOver} days`)}</b></div>
            <div><span>${L('انصراف بدري', 'Left early')}</span><b class="${m.early.length ? 'bad-txt' : ''}">${m.early.length ? L(`${m.early.length} يوم · ${fmtMin(m.early.reduce((s, r) => s + r.early, 0))}`, `${m.early.length} days · ${fmtMin(m.early.reduce((s, r) => s + r.early, 0))}`) : '—'}</b></div>
            <div><span>${L('نسي يقفل اليوم', 'Forgot to end the day')}</span><b class="${t.forgot ? 'bad-txt' : ''}">${t.forgot || '—'}</b></div>
            <div><span>${L('أيام شيفت 10', '10:00-shift days')}</span><b>${m.shift10 || '—'}</b></div>
            <div><span>To-Do</span><b>${m.todo.all ? `${pct(m.todo.done, m.todo.all)}% <small class="muted">(${m.todo.done}/${m.todo.all})</small>` : '—'}</b></div>
          </div></div></section>
      </div>
      <div class="st-grid mb-16">
        <section class="card"><div class="card-head"><h3><i class="fas fa-umbrella-beach"></i> ${L('أيام الإجازات', 'Leave days')}</h3><span class="num muted">${m.leaves.length}</span></div>
          ${m.leaves.length ? `<div class="table-wrap"><table class="table"><tbody>${m.leaves.map(r => `<tr><td>${esc(fmtDay(r.date))}</td><td><span class="badge warn">${esc(leaveTypeLabel((r.plan && r.plan.leaveType) || (r.rec && r.rec.leaveType) || 'annual'))}</span></td></tr>`).join('')}</tbody></table></div>` : `<div class="card-body">${empty('fa-mug-hot', L('مفيش إجازات في الفترة دي', 'No leave in this period'))}</div>`}</section>
        <section class="card"><div class="card-head"><h3><i class="fas fa-paper-plane"></i> ${L('الطلبات', 'Requests')}</h3><span class="num muted">${m.reqs.length}</span></div>
          ${m.reqs.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>${L('النوع', 'Type')}</th><th class="num">${L('اتقبل', 'Approved')}</th><th class="num">${L('اترفض', 'Rejected')}</th><th class="num">${L('مستني', 'Pending')}</th></tr></thead><tbody>${Object.entries(reqByType).map(([k, x]) => `<tr><td>${esc(typeLabel(k))} <small class="muted">(${x.all})</small></td><td class="num ok-txt">${x.ok || '—'}</td><td class="num ${x.no ? 'bad-txt' : ''}">${x.no || '—'}</td><td class="num">${x.wait || '—'}</td></tr>`).join('')}</tbody></table></div>` : `<div class="card-body">${empty('fa-paper-plane', L('مفيش طلبات في الفترة دي', 'No requests in this period'))}</div>`}</section>
      </div>
      ${ded}
      ${pm ? `<p class="xs muted mt-8"><i class="fas fa-arrows-up-down"></i> ${L(`الأسهم مقارنة بنفس الفترة من ${monthName(addMonths(month, -1))}${(() => { const r = periodRange(month, week), t = ymd(now()); return t >= r.from && t <= r.to ? ` (لحد يوم ${Number(t.slice(8))})` : ''; })()}`, `Arrows compare with the same period of ${monthName(addMonths(month, -1))}`)}</p>` : ''}`;
  }

  root.addEventListener('change', (e) => {
    if (e.target.id === 'who') location.hash = e.target.value === session.email ? '#/stats' : `#/stats/${encodeURIComponent(e.target.value)}/${month}`;
    if (e.target.matches('[data-pp-month]')) { month = e.target.value; week = 0; load(); }
  });
  root.addEventListener('click', (e) => {
    const w = e.target.closest('[data-pp-week]'); if (w) { week = Number(w.dataset.ppWeek); draw(); return; }
    const d = e.target.closest('[data-day]');
    if (d && cur) { const r = cur.rows.find(x => x.date === d.dataset.day); if (r) showDayDetails(email, r, { canRequest: email === session.email }); }
  });
  const off = onTasks(() => draw());
  await load();
  return () => { off(); if (unTodo) unTodo(); if (unRev) unRev(); };
}
