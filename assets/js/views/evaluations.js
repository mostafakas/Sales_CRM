// Performance reviews. Admins and project managers review everyone every week — attendance and tasks are scored
// automatically, KPIs and stars by hand — send the week to the employee, and send the month (the average of its
// weeks). Everyone else sees only the reviews sent to them, marks them seen and can reply.
import { L, esc, ymd, fmtDate } from '../core/utils.js';
import { toast, toastErr, avatar, modal, busy, confirmDialog, empty, loader } from '../core/ui.js';
import { session, now, isAdmin } from '../core/session.js';
import { toMs } from '../core/fb.js';
import { activePeople, person, nameOf, officialDepartments } from '../services/directory.js';
import { teamMonth } from '../services/reports.js';
import { startTasks, onTasks, allTasks, periodRange, weekOfDate } from '../services/tasks.js';
import {
  PILLARS, PILLAR_META, pillarLabel, evalSettings, canEvaluate, attendanceScore, tasksScore, kpisScore, kpiPct, ratingScore, totalOf, gradeOf,
  kpiTemplate, watchMonthEvals, watchMine, saveWeek, monthOf, sendMonth, sendExisting, markSeen, reply, evalId
} from '../services/evaluations.js';
import { periodPicker, monthName } from './task-ui.js';

const weekLabel = (w) => (w ? L(`أسبوع ${w}`, `Week ${w}`) : L('الشهر', 'Month'));
const rangeText = (month, week) => { const r = periodRange(month, week); return `${Number(r.from.slice(8))}–${Number(r.to.slice(8))} ${monthName(month)}`; };
const toneOf = (v) => (gradeOf(v) || {}).tone || '';
const score = (v) => (v == null ? '<span class="muted">—</span>' : `<span class="ev-sc ${toneOf(v)} num">${v}</span>`);
const ring = (v, size = '') => { const g = gradeOf(v); return `<div class="ev-ring ${size} ${g ? g.tone : ''}" style="--v:${v ?? 0}"><div><b class="num">${v ?? '—'}</b>${g ? `<small>${esc(g.name)}</small>` : ''}</div></div>`; };
const bar = (k, v) => `<div class="ev-pbar"><span class="ev-plabel"><i class="fas ${PILLAR_META[k].icon}" style="color:${PILLAR_META[k].color}"></i>${esc(pillarLabel(k))}</span>
  <div class="ev-track"><span style="width:${v ?? 0}%;background:${PILLAR_META[k].color}"></span></div><b class="num">${v ?? '—'}</b></div>`;
const starRow = (n, editable = false, i = 0) => `<span class="ev-stars ${editable ? 'edit' : ''}">${[1, 2, 3, 4, 5].map(s => editable
  ? `<button type="button" data-star="${i}:${s}" class="${s <= n ? 'on' : ''}" aria-label="${s}"><i class="fas fa-star"></i></button>`
  : `<i class="fas fa-star ${s <= n ? 'on' : ''}"></i>`).join('')}</span>`;
const statusBadge = (ev) => !ev ? `<span class="badge">${L('لسه', 'Not yet')}</span>`
  : !ev.sent ? `<span class="badge info"><i class="fas fa-floppy-disk"></i>${L('متسجّل · مش متبعت', 'Saved · not sent')}</span>`
  : ev.seenAt ? `<span class="badge ok"><i class="fas fa-check-double"></i>${L('اتبعت · شافه', 'Sent · seen')}</span>${ev.reply ? ` <i class="fas fa-comment-dots" style="color:var(--brand)" title="${L('ردّ', 'Replied')}"></i>` : ''}`
  : `<span class="badge brand"><i class="fas fa-paper-plane"></i>${L('اتبعت', 'Sent')}</span>`;
const attFacts = (a) => !a ? L('مفيش أيام شغل خلصت في الفترة دي — المحور مش هيدخل في الحساب.', 'No finished working days in this period — this pillar is left out.')
  : L(`حضر ${a.present} يوم · غياب ${a.absent} · تأخير ${a.lateDays} يوم (${a.lateMinutes} دقيقة) · انصراف بدري ${a.early} · نسي يقفل ${a.forgot} · الالتزام ${a.commitment}% · في الميعاد ${a.punctual}%`,
    `${a.present} days present · ${a.absent} absent · late ${a.lateDays} days (${a.lateMinutes} min) · left early ${a.early} · forgot ${a.forgot} · commitment ${a.commitment}% · on time ${a.punctual}%`);
const taskFacts = (t) => !t ? L('مفيش تاسكات ميعادها في الفترة دي — المحور مش هيدخل في الحساب.', 'No tasks due in this period — this pillar is left out.')
  : L(`${t.all} تاسك · خلص ${t.done} · في الميعاد ${t.onTime} · رجع من المراجعة ${t.returned}`, `${t.all} tasks · ${t.done} done · ${t.onTime} on time · ${t.returned} sent back`);
// the window opens at its top (the header with the score), not scrolled to its first input
const atTop = (m) => setTimeout(() => { const b = m.$('.modal-body'); if (b) b.scrollTop = 0; if (document.activeElement && m.el.contains(document.activeElement)) document.activeElement.blur(); }, 80);
const weightOf = (ev, k) => Number(((ev && ev.weights) || evalSettings().weights)[k]) || 0;

/** read-only details of one review (week or month); the owner marks it seen and can reply */
function details(ev, { onChange } = {}) {
  const own = ev.email === session.email;
  if (own && ev.sent) markSeen(ev);
  const p = person(ev.email) || { email: ev.email, name: ev.name || nameOf(ev.email) };
  const sec = (k, inner) => `<section class="ev-sec"><div class="ev-sec-head"><span class="icon-tile" style="background:${PILLAR_META[k].color}1f;color:${PILLAR_META[k].color}"><i class="fas ${PILLAR_META[k].icon}"></i></span>
    <b class="grow">${esc(pillarLabel(k))}</b><small class="muted">${L('الوزن', 'Weight')} ${weightOf(ev, k)}%</small>${score(ev.scores ? ev.scores[k] : null)}</div>${inner}</section>`;
  const body = ev.week ? `
    ${sec('attendance', `<p class="small muted">${esc(attFacts(ev.auto && ev.auto.attendance))}</p>`)}
    ${sec('tasks', `<p class="small muted">${esc(taskFacts(ev.auto && ev.auto.tasks))}</p>`)}
    ${sec('kpis', (ev.kpis || []).length ? `<table class="table ev-kt"><thead><tr><th>${L('المؤشر', 'KPI')}</th><th>${L('المستهدف', 'Target')}</th><th>${L('المحقق', 'Actual')}</th><th>%</th></tr></thead><tbody>${ev.kpis.map(k => `<tr><td>${esc(k.name)}</td><td><span class="num">${esc(k.target)}</span> <small class="muted">${esc(k.unit || '')}</small></td><td><b class="num">${esc(k.actual === '' ? '—' : k.actual)}</b></td><td>${kpiPct(k) == null ? '—' : `<b class="num">${kpiPct(k)}%</b>`}</td></tr>`).join('')}</tbody></table>` : `<p class="small muted">${L('مفيش KPIs في الأسبوع ده.', 'No KPIs this week.')}</p>`)}
    ${sec('rating', (ev.ratings || []).length ? `<div class="ev-crit">${ev.ratings.map(r => `<div class="ev-crow"><span class="grow">${esc(r.name)}</span>${starRow(Number(r.stars) || 0)}</div>`).join('')}</div>` : `<p class="small muted">${L('مفيش تقييم بالنجوم.', 'No star rating.')}</p>`)}`
    : `<div class="ev-bars">${PILLARS.map(k => bar(k, ev.scores ? ev.scores[k] : null)).join('')}</div>
      <div class="ev-weeks mt-16">${(ev.weeks || []).map(w => `<div class="ev-wk"><small>${weekLabel(w.week)}</small>${score(w.total)}<small class="muted">${esc(w.grade || '')}</small></div>`).join('')}</div>`;
  const m = modal({
    title: `${ev.week ? weekLabel(ev.week) : L('تقييم الشهر', 'Monthly review')} · ${ev.week ? rangeText(ev.month, ev.week) : monthName(ev.month)}`, icon: 'fa-star-half-stroke', size: 'wide',
    body: `<div class="ev-ed">
      <div class="ev-ed-head">${avatar(p, 'lg')}<div class="grow"><b>${esc(p.name || p.email)}</b><div class="small muted">${esc(p.department || ev.department || '')}${ev.sentAt ? ` · ${L('اتبعت', 'sent')} ${esc(fmtDate(ymd(toMs(ev.sentAt))))} ${L('من', 'by')} ${esc(nameOf(ev.sentBy || ev.by))}` : ''}</div></div>${ring(ev.total, 'lg')}</div>
      ${body}
      ${ev.comment ? `<div class="ev-note"><i class="fas fa-quote-right"></i><div><b>${L('ملاحظات', 'Notes')}</b><p>${esc(ev.comment)}</p></div></div>` : ''}
      ${ev.reply ? `<div class="ev-note reply"><i class="fas fa-reply"></i><div><b>${own ? L('ردّك', 'Your reply') : L(`ردّ ${p.name || ''}`, 'Their reply')}</b><p>${esc(ev.reply)}</p></div></div>`
        : own && ev.sent ? `<div class="field mt-16"><label>${L('عندك تعليق على التقييم؟ (اختياري)', 'Any comment on the review? (optional)')}</label><textarea class="textarea" id="ev-reply" maxlength="1000" rows="3"></textarea></div>` : ''}
    </div>`,
    foot: own && ev.sent && !ev.reply ? `<button class="btn" data-close>${L('إغلاق', 'Close')}</button><button class="btn btn-primary" id="ev-send-reply"><i class="fas fa-reply"></i> ${L('إرسال الرد', 'Send reply')}</button>` : `<button class="btn" data-close>${L('إغلاق', 'Close')}</button>`
  });
  atTop(m);
  const rb = m.$('#ev-send-reply');
  if (rb) rb.onclick = (e) => busy(e.currentTarget, async () => {
    const t = m.$('#ev-reply').value.trim();
    if (!t) { m.$('#ev-reply').focus(); return; }
    try { await reply(ev, t); toast(L('اتبعت ردّك', 'Reply sent')); m.close(); onChange && onChange(); } catch (ex) { toastErr(ex); }
  });
}

/** an employee's own reviews, newest month first */
function mine(root, host = null) {
  let rows = null;
  if (!host) root.innerHTML = `<div class="ev-page"><div class="page-head"><div><h2>${L('تقييمي', 'My reviews')}</h2><p>${L('تقييم أدائك كل أسبوع، وتقييم الشهر كله. بيظهر هنا أول ما يتبعتلك.', 'Your weekly and monthly performance reviews, as soon as they are sent to you.')}</p></div></div><div id="mine">${loader()}</div></div>`;
  const box = host || root.querySelector('#mine');
  const draw = () => {
    if (!rows) return;
    if (!rows.length) { box.innerHTML = `<div class="card">${empty('fa-star-half-stroke', L('مفيش تقييمات لسه', 'No reviews yet'), L('أول ما مديرك يبعتلك تقييم هيظهر هنا وهيوصلك إشعار.', 'Reviews sent to you will show here, with a notification.'))}</div>`; return; }
    const months = [...new Set(rows.map(r => r.month))].sort().reverse();
    box.innerHTML = months.map(mo => {
      const ms = rows.filter(r => r.month === mo);
      const mon = ms.find(r => !r.week), weeks = ms.filter(r => r.week).sort((a, b) => a.week - b.week);
      return `<section class="ev-month"><h3 class="ev-mh">${esc(monthName(mo))}</h3><div class="ev-cards">
        ${mon ? `<button class="card ev-card month ${mon.seenAt ? '' : 'new'}" data-ev="${esc(mon.id)}">${ring(mon.total, 'lg')}<div class="grow"><b>${L('تقييم الشهر', 'Monthly review')}</b>${mon.seenAt ? '' : `<span class="badge bad">${L('جديد', 'New')}</span>`}
          <div class="ev-bars sm">${PILLARS.map(k => bar(k, mon.scores ? mon.scores[k] : null)).join('')}</div></div></button>` : ''}
        ${weeks.map(w => `<button class="card ev-card ${w.seenAt ? '' : 'new'}" data-ev="${esc(w.id)}">${ring(w.total)}<div class="grow"><b>${weekLabel(w.week)}</b><small class="muted" style="display:block">${esc(rangeText(w.month, w.week))}</small>${w.seenAt ? '' : `<span class="badge bad">${L('جديد', 'New')}</span>`}</div></button>`).join('')}
      </div></section>`;
    }).join('');
    box.querySelectorAll('[data-ev]').forEach(b => b.onclick = () => details(rows.find(r => r.id === b.dataset.ev)));
  };
  const un = watchMine(r => { rows = r; draw(); });
  return () => un();
}

export default async function render(root) {
  startTasks();
  if (!canEvaluate()) return mine(root);
  const today = ymd(now());
  let month = today.slice(0, 7), week = weekOfDate(today), view = 'team', q = '', dept = '';
  let team = null, evals = [], unEv = null, unMine = null;
  root.innerHTML = `<div class="ev-page">
    <div class="page-head"><div><h2>${L('تقييم الأداء', 'Performance reviews')}</h2><p>${L('كل موظف بيتقيّم كل أسبوع، والأسابيع بتتجمع في تقييم الشهر. الموظف مش بيشوف التقييم غير لما تبعتهوله.', 'Everyone is reviewed weekly and the weeks add up to the month. An employee sees a review only once you send it.')}</p></div>
      <div class="row gap-8 wrap">${isAdmin() ? '' : `<div class="seg" id="ev-view"><button data-v="team" class="on">${L('الفريق', 'Team')}</button><button data-v="mine">${L('تقييمي', 'Mine')}</button></div>`}
        ${isAdmin() ? `<a class="btn btn-ghost" href="#/settings/eval"><i class="fas fa-sliders"></i> ${L('إعدادات التقييم', 'Review settings')}</a>` : ''}</div></div>
    <div id="ev-team"><div class="ev-tools"><span id="period"></span><input class="input" id="q" placeholder="${L('دوّر بالاسم…', 'Search by name…')}"><select class="select" id="dept"><option value="">${L('كل الأقسام', 'All departments')}</option>${officialDepartments().map(d => `<option>${esc(d)}</option>`).join('')}</select>
      <span class="grow"></span><button class="btn btn-primary" id="send-all" style="display:none"></button></div>
      <div id="body">${loader()}</div></div>
    <div id="ev-mine" hidden></div></div>`;
  const $ = (s) => root.querySelector(s);
  const people = () => activePeople().filter(p => p.role !== 'admin' && p.email !== session.email && !p.isFreelancer)
    .filter(p => (!dept || p.department === dept) && (!q || (p.name || p.email).toLowerCase().includes(q)))
    .sort((a, b) => (a.department || '').localeCompare(b.department || '') || (a.name || '').localeCompare(b.name || '', 'ar'));
  const evOf = (email, w) => evals.find(e => e.id === evalId(email, month, w)) || null;
  function autoFor(p, w) {
    const range = periodRange(month, w);
    const tm = team && team.people.find(x => x.person.email === p.email);
    return {
      attendance: tm ? attendanceScore(tm.rows.filter(r => r.date >= range.from && r.date <= range.to)) : null,
      tasks: tasksScore(allTasks().filter(k => k.assignee === p.email), range)
    };
  }

  async function load() {
    $('#body').innerHTML = loader();
    if (unEv) unEv();
    team = null; evals = [];
    unEv = watchMonthEvals(month, rows => { evals = rows; draw(); });
    try { team = await teamMonth(month); } catch (e) { team = { people: [] }; console.warn(e); }
    draw();
  }

  function draw() {
    $('#period').innerHTML = periodPicker(month, week, { ahead: 0 });
    if (!team) return;
    const ppl = people();
    const sendAll = $('#send-all');
    if (!ppl.length) { $('#body').innerHTML = `<div class="card">${empty('fa-users', L('مفيش موظفين', 'No employees'))}</div>`; sendAll.style.display = 'none'; return; }
    if (week) {
      const unsent = ppl.map(p => evOf(p.email, week)).filter(e => e && !e.sent);
      sendAll.style.display = unsent.length ? '' : 'none';
      sendAll.innerHTML = `<i class="fas fa-paper-plane"></i> ${L(`إرسال ${unsent.length} تقييم متسجّل`, `Send ${unsent.length} saved reviews`)}`;
      sendAll.onclick = (e) => busy(e.currentTarget, async () => {
        if (!(await confirmDialog({ title: L('إرسال التقييمات', 'Send reviews'), message: L(`هيتبعت ${unsent.length} تقييم لأصحابهم ويوصلهم إشعار.`, `${unsent.length} reviews will be sent to their owners with a notification.`), okText: L('إرسال', 'Send') }))) return;
        try { for (const ev of unsent) await sendExisting(ev); toast(L('اتبعتت التقييمات', 'Reviews sent')); } catch (ex) { toastErr(ex); }
      });
      $('#body').innerHTML = `<div class="card"><div class="table-wrap"><table class="table ev-table"><thead><tr><th>${L('الموظف', 'Employee')}</th>${PILLARS.map(k => `<th><i class="fas ${PILLAR_META[k].icon}" style="color:${PILLAR_META[k].color}"></i> ${esc(pillarLabel(k))}</th>`).join('')}<th>${L('الإجمالي', 'Total')}</th><th>${L('الحالة', 'Status')}</th><th></th></tr></thead><tbody>
        ${ppl.map(p => {
          const ev = evOf(p.email, week), auto = autoFor(p, week);
          const sc = ev ? ev.scores : { attendance: auto.attendance && auto.attendance.score, tasks: auto.tasks && auto.tasks.score, kpis: null, rating: null };
          return `<tr><td><div class="row gap-8">${avatar(p, 'sm')}<div><b>${esc(p.name || p.email)}</b><div class="xs muted">${esc(p.department || '')}</div></div></div></td>
            ${PILLARS.map(k => `<td class="${ev ? '' : 'ev-pre'}" title="${ev ? '' : L('محسوب من السيستم — لسه متسجلش', 'Calculated — not saved yet')}">${score(sc[k])}</td>`).join('')}
            <td>${ev ? `${score(ev.total)} <small class="muted">${esc(ev.grade || '')}</small>` : '<span class="muted">—</span>'}</td><td>${statusBadge(ev)}</td>
            <td class="ev-act"><button class="btn btn-sm ${ev ? '' : 'btn-primary'}" data-edit="${esc(p.email)}"><i class="fas ${ev ? 'fa-pen' : 'fa-star'}"></i> ${ev ? L('تعديل', 'Edit') : L('قيّم', 'Review')}</button>
              ${ev && !ev.sent ? `<button class="btn btn-sm btn-ghost" data-send="${esc(p.email)}" title="${L('إرسال للموظف', 'Send to employee')}"><i class="fas fa-paper-plane"></i></button>` : ''}
              ${ev && ev.sent ? `<button class="btn btn-sm btn-ghost" data-view="${esc(ev.id)}" title="${L('زي ما الموظف شايفه', 'As the employee sees it')}"><i class="fas fa-eye"></i></button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div></div>
        <p class="xs muted mt-8"><i class="fas fa-circle-info"></i> ${L('الحضور والتاسكات بيتحسبوا لوحدهم من السيستم. الـ KPIs والنجوم بتدخلهم إنت. الأرقام الباهتة لسه متسجلتش.', 'Attendance and tasks are scored automatically; you enter KPIs and stars.')}</p>`;
    } else {
      sendAll.style.display = 'none';
      $('#body').innerHTML = `<div class="card"><div class="table-wrap"><table class="table ev-table"><thead><tr><th>${L('الموظف', 'Employee')}</th>${[1, 2, 3, 4].map(w => `<th>${weekLabel(w)}</th>`).join('')}<th>${L('الشهر', 'Month')}</th><th>${L('التقييم الشهري', 'Monthly review')}</th><th></th></tr></thead><tbody>
        ${ppl.map(p => {
          const weeks = [1, 2, 3, 4].map(w => evOf(p.email, w));
          const agg = monthOf(weeks.filter(Boolean)), mon = evOf(p.email, 0);
          const stale = mon && agg && mon.total !== agg.total;
          return `<tr><td><div class="row gap-8">${avatar(p, 'sm')}<div><b>${esc(p.name || p.email)}</b><div class="xs muted">${esc(p.department || '')}</div></div></div></td>
            ${weeks.map((ev, i) => `<td><button class="ev-wbtn ${ev ? (ev.sent ? 'sent' : 'saved') : ''}" data-week="${i + 1}" data-p="${esc(p.email)}" title="${ev ? '' : L('قيّم الأسبوع ده', 'Review this week')}">${ev ? `<b class="num">${ev.total ?? '—'}</b>` : '<i class="fas fa-plus"></i>'}</button></td>`).join('')}
            <td>${agg ? `${score(agg.total)} <small class="muted">${esc(agg.grade)}</small>` : '<span class="muted">—</span>'}</td>
            <td>${mon ? statusBadge(mon) : `<span class="badge">${L('مش متبعت', 'Not sent')}</span>`}${stale ? ` <span class="badge warn" title="${L('الأسابيع اتعدلت بعد ما اتبعت', 'Weeks changed after sending')}">${L('اتغيّر', 'Changed')}</span>` : ''}</td>
            <td class="ev-act">${agg ? `<button class="btn btn-sm ${mon && !stale ? '' : 'btn-primary'}" data-month="${esc(p.email)}"><i class="fas fa-paper-plane"></i> ${mon ? L('إعادة إرسال', 'Resend') : L('إرسال الشهري', 'Send month')}</button>` : ''}
              ${mon ? `<button class="btn btn-sm btn-ghost" data-view="${esc(mon.id)}"><i class="fas fa-eye"></i></button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div></div>
        <p class="xs muted mt-8"><i class="fas fa-circle-info"></i> ${L('تقييم الشهر = متوسط الأسابيع المتقيّمة. لما تبعته، الأسابيع اللي لسه متبعتتش بتتبعت معاه.', 'The month = the average of the reviewed weeks. Sending it also sends any weeks not sent yet.')}</p>`;
    }
    const pOf = (e) => person(e) || { email: e, name: nameOf(e) };
    $('#body').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editor(pOf(b.dataset.edit), week));
    $('#body').querySelectorAll('[data-week]').forEach(b => b.onclick = () => editor(pOf(b.dataset.p), Number(b.dataset.week)));
    $('#body').querySelectorAll('[data-view]').forEach(b => b.onclick = () => details(evals.find(e => e.id === b.dataset.view)));
    $('#body').querySelectorAll('[data-send]').forEach(b => b.onclick = (e) => busy(e.currentTarget, async () => {
      try { await sendExisting(evOf(b.dataset.send, week)); toast(L('اتبعت التقييم', 'Review sent')); } catch (ex) { toastErr(ex); }
    }));
    $('#body').querySelectorAll('[data-month]').forEach(b => b.onclick = async () => {
      const p = pOf(b.dataset.month);
      const weeks = [1, 2, 3, 4].map(w => evOf(p.email, w)).filter(Boolean);
      const agg = monthOf(weeks);
      const note = await confirmDialog({
        title: L(`تقييم ${p.name} عن ${monthName(month)}`, `${p.name} — ${monthName(month)}`),
        message: L(`الإجمالي ${agg.total ?? '—'} من 100 (${agg.grade}) — متوسط ${weeks.length} أسبوع.\nالأسابيع اللي لسه متبعتتش هتتبعت معاه.`, `Total ${agg.total ?? '—'} / 100 (${agg.grade}) — the average of ${weeks.length} weeks.\nWeeks not sent yet are sent with it.`),
        okText: L('إرسال', 'Send'), input: { label: L('ملاحظات على الشهر (اختياري)', 'Notes on the month (optional)'), placeholder: (evOf(p.email, 0) || {}).comment || '' }
      });
      if (note === null) return;
      try {
        await sendMonth(p, month, weeks, note || (evOf(p.email, 0) || {}).comment || '');
        for (const w of weeks.filter(x => !x.sent)) await sendExisting(w, { quiet: true });
        toast(L('اتبعت تقييم الشهر', 'Monthly review sent'));
      } catch (ex) { toastErr(ex); }
    });
  }

  /** the review window for one person and week */
  function editor(p, w) {
    const ev = evOf(p.email, w);
    const auto = autoFor(p, w);
    const set = evalSettings();
    const kpis = ev && ev.kpis && ev.kpis.length ? structuredClone(ev.kpis) : kpiTemplate(p.department || '');
    const ratings = set.criteria.map(name => ({ name, stars: Number(((ev && ev.ratings) || []).find(r => r && r.name === name)?.stars) || 0 }));
    const calc = () => {
      const sc = { attendance: auto.attendance ? auto.attendance.score : null, tasks: auto.tasks ? auto.tasks.score : null, kpis: (kpisScore(kpis) || {}).score ?? null, rating: (ratingScore(ratings) || {}).score ?? null };
      return { sc, total: totalOf(sc) };
    };
    const head = (k) => `<div class="ev-sec-head"><span class="icon-tile" style="background:${PILLAR_META[k].color}1f;color:${PILLAR_META[k].color}"><i class="fas ${PILLAR_META[k].icon}"></i></span>
      <b class="grow">${esc(pillarLabel(k))}</b><small class="muted">${L('الوزن', 'Weight')} ${Number(set.weights[k]) || 0}%</small><span data-sc="${k}"></span></div>`;
    const kRows = () => kpis.length ? `<table class="table ev-kt"><thead><tr><th>${L('المؤشر', 'KPI')}</th><th>${L('مستهدف الأسبوع', 'Week target')}</th><th>${L('المحقق', 'Actual')}</th><th>%</th><th></th></tr></thead><tbody>
      ${kpis.map((k, i) => `<tr><td>${k.custom ? `<input class="input select-sm" data-kn="${i}" value="${esc(k.name)}" placeholder="${L('اسم المؤشر', 'KPI name')}">` : `<b>${esc(k.name)}</b>${k.monthTarget ? `<div class="xs muted">${L('الشهري', 'Month')} ${esc(k.monthTarget)} ${esc(k.unit || '')}</div>` : ''}`}</td>
        <td><input class="input select-sm num" type="number" min="0" step="any" data-kt="${i}" value="${esc(k.target)}"></td>
        <td><input class="input select-sm num" type="number" min="0" step="any" data-ka="${i}" value="${esc(k.actual)}" placeholder="—"></td>
        <td data-kp="${i}">${kpiPct(k) == null ? '—' : `${kpiPct(k)}%`}</td>
        <td><button type="button" class="btn btn-ghost btn-icon btn-sm" data-kdel="${i}" title="${L('شيل', 'Remove')}"><i class="fas fa-xmark"></i></button></td></tr>`).join('')}</tbody></table>`
      : `<p class="small muted">${L(`مفيش KPIs متعرّفة لقسم ${p.department || '—'}.`, `No KPIs defined for ${p.department || '—'}.`)} ${isAdmin() ? `<a href="#/settings/eval">${L('عرّفها من الإعدادات', 'Define them in Settings')}</a>` : ''}</p>`;
    const m = modal({
      title: `${L('تقييم', 'Review')} ${p.name || p.email} · ${weekLabel(w)} (${rangeText(month, w)})`, icon: 'fa-star-half-stroke', size: 'wide',
      body: `<div class="ev-ed">
        <div class="ev-ed-head">${avatar(p, 'lg')}<div class="grow"><b>${esc(p.name || p.email)}</b><div class="small muted">${esc(p.title || '')}${p.department ? ' · ' + esc(p.department) : ''}</div>${ev ? `<div class="mt-4">${statusBadge(ev)}</div>` : ''}</div><div id="ev-total"></div></div>
        <section class="ev-sec">${head('attendance')}<p class="small muted">${esc(attFacts(auto.attendance))}</p></section>
        <section class="ev-sec">${head('tasks')}<p class="small muted">${esc(taskFacts(auto.tasks))}</p></section>
        <section class="ev-sec">${head('kpis')}<div id="ev-k">${kRows()}</div><button type="button" class="btn btn-ghost btn-sm mt-8" id="ev-kadd"><i class="fas fa-plus"></i> ${L('مؤشر للأسبوع ده بس', 'KPI for this week only')}</button></section>
        <section class="ev-sec">${head('rating')}<div class="ev-crit">${ratings.map((r, i) => `<div class="ev-crow"><span class="grow">${esc(r.name)}</span>${starRow(r.stars, true, i)}</div>`).join('')}</div></section>
        <div class="field mt-16"><label>${L('ملاحظات للموظف', 'Notes for the employee')}</label><textarea class="textarea" id="ev-comment" rows="3" maxlength="2000" placeholder="${L('نقط القوة، اللي محتاج يتحسن…', 'Strengths, what to improve…')}">${esc((ev && ev.comment) || '')}</textarea></div>
        ${ev && ev.reply ? `<div class="ev-note reply"><i class="fas fa-reply"></i><div><b>${L(`ردّ ${p.name || ''}`, 'Their reply')}</b><p>${esc(ev.reply)}</p></div></div>` : ''}
      </div>`,
      foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn" id="ev-save"><i class="fas fa-floppy-disk"></i> ${L('حفظ', 'Save')}</button>
        <button class="btn btn-primary" id="ev-send"><i class="fas fa-paper-plane"></i> ${ev && ev.sent ? L('حفظ وإعادة إرسال', 'Save & resend') : L('حفظ وإرسال للموظف', 'Save & send')}</button>`
    });
    const refresh = () => {
      const { sc, total } = calc();
      PILLARS.forEach(k => { const e = m.$(`[data-sc="${k}"]`); if (e) e.innerHTML = score(sc[k]); });
      m.$('#ev-total').innerHTML = ring(total, 'lg');
      kpis.forEach((k, i) => { const e = m.$(`[data-kp="${i}"]`); if (e) e.textContent = kpiPct(k) == null ? '—' : `${kpiPct(k)}%`; });
    };
    const drawK = () => { m.$('#ev-k').innerHTML = kRows(); refresh(); };
    m.el.addEventListener('input', (e) => {
      const d = e.target.dataset;
      if (d.ka != null) kpis[d.ka].actual = e.target.value;
      else if (d.kt != null) kpis[d.kt].target = e.target.value === '' ? '' : Number(e.target.value);
      else if (d.kn != null) kpis[d.kn].name = e.target.value;
      else return;
      refresh();
    });
    m.el.addEventListener('click', (e) => {
      const st = e.target.closest('[data-star]'), del = e.target.closest('[data-kdel]');
      if (st) {
        const [i, s] = st.dataset.star.split(':').map(Number);
        ratings[i].stars = ratings[i].stars === s ? s - 1 : s;     // clicking the same star again lowers it by one
        st.parentElement.querySelectorAll('[data-star]').forEach(b => b.classList.toggle('on', Number(b.dataset.star.split(':')[1]) <= ratings[i].stars));
        refresh();
      } else if (del) { kpis.splice(Number(del.dataset.kdel), 1); drawK(); }
    });
    m.$('#ev-kadd').onclick = () => { kpis.push({ id: 'c' + Date.now().toString(36), name: '', unit: '', weight: 1, target: '', actual: '', custom: true }); drawK(); const n = m.$$('[data-kn]'); n.length && n[n.length - 1].focus(); };
    const save = (send) => async (e) => busy(e.currentTarget, async () => {
      const ks = kpis.filter(k => String(k.name || '').trim()).map(k => ({ ...k, name: String(k.name).trim().slice(0, 80), target: k.target === '' ? 0 : Number(k.target) || 0, actual: k.actual === '' || k.actual == null ? '' : Number(k.actual) }));
      try {
        const rec = await saveWeek(p, month, w, { auto, kpis: ks, ratings, comment: m.$('#ev-comment').value }, { send });
        toast(send ? L('اتحفظ واتبعت للموظف', 'Saved and sent') : L('اتحفظ — لسه مش متبعت', 'Saved — not sent yet'), `${rec.total ?? '—'} · ${rec.grade}`);
        m.close();
      } catch (ex) { toastErr(ex); }
    });
    atTop(m);
    m.$('#ev-save').onclick = save(false);
    m.$('#ev-send').onclick = save(true);
    refresh();
  }

  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-pp-month]')) { month = e.target.value; load(); }
    else if (e.target.id === 'dept') { dept = e.target.value; draw(); }
  });
  root.addEventListener('click', (e) => {
    const wb = e.target.closest('[data-pp-week]');
    if (wb) { week = Number(wb.dataset.ppWeek); draw(); return; }
    const vb = e.target.closest('#ev-view [data-v]');
    if (vb) {
      view = vb.dataset.v;
      root.querySelectorAll('#ev-view [data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === view));
      $('#ev-team').hidden = view !== 'team'; $('#ev-mine').hidden = view !== 'mine';
      if (view === 'mine' && !unMine) { $('#ev-mine').innerHTML = loader(); unMine = mine(root, $('#ev-mine')); }
    }
  });
  $('#q').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); draw(); });
  const off = onTasks(() => { if (team) draw(); });
  load();
  return () => { off(); if (unEv) unEv(); if (unMine) unMine(); };
}
