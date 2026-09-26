// My attendance — monthly calendar, totals and day details. `personMonthView` is reused by HR.
import { L, esc, fmtTime, fmtHours, fmtMin, num, ym as ymOf, addMonths, fmtMonth, weekday, fmtDay, isAr } from '../core/utils.js';
import { modal, empty, loader, STATUS_META } from '../core/ui.js';
import { session, now } from '../core/session.js';
import { modeLabel, leaveTypeLabel, dayKey } from '../core/policy.js';
import { toMs } from '../core/fb.js';
import { personMonth, STATUS_DAY } from '../services/reports.js';
import { dayLogs, scopeFor } from '../services/attendance.js';
import { openRequestForm } from './request-form.js';

const DOW = () => isAr ? ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function statTiles(t) {
  const tile = (icon, cls, label, value, unit = '') => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value">${value}${unit ? `<small>${esc(unit)}</small>` : ''}</div></div>`;
  return `<div class="grid g-4 keep-2">
    ${tile('fa-user-check', 'ok', L('أيام حضور', 'Days present'), num(t.present), L(`منها ${t.remote} أونلاين`, `${t.remote} remote`))}
    ${tile('fa-user-xmark', 'bad', L('غياب', 'Absent'), num(t.absent), L('يوم', 'days'))}
    ${tile('fa-clock', 'warn', L('إجمالي التأخير', 'Total lateness'), esc(fmtMin(t.lateMinutes)), L(`في ${t.lateDays} يوم`, `on ${t.lateDays} days`))}
    ${tile('fa-umbrella-beach', 'info', L('إجازات', 'Leave days'), num(t.leave), L('يوم', 'days'))}
    ${tile('fa-laptop-code', '', L('ساعات الشغل', 'Work hours'), esc(fmtHours(t.workMs)))}
    ${tile('fa-mug-hot', 'warn', L('استراحات', 'Breaks'), esc(fmtHours(t.breakMs)))}
    ${tile('fa-door-open', 'neutral', L('انصراف مبكر', 'Early leave'), esc(fmtMin(t.earlyMinutes)))}
    ${tile('fa-chart-simple', t.commitment >= 90 ? 'ok' : (t.commitment >= 75 ? 'warn' : 'bad'), L('نسبة الالتزام', 'Commitment'), num(t.commitment), '%')}
  </div>`;
}

export function calendarHTML(rows, ym) {
  const first = weekday(`${ym}-01`);
  const todayKey = dayKey(now());
  let h = `<div class="cal">${DOW().map(d => `<div class="dow">${esc(d)}</div>`).join('')}`;
  for (let i = 0; i < first; i++) h += `<div></div>`;
  rows.forEach(r => {
    const meta = STATUS_DAY[r.status] || STATUS_DAY.none;
    const clickable = r.status !== 'future';
    let line = '';
    if (r.rec && r.rec.checkInMs) line = `${fmtTime(r.rec.checkInMs)}${r.rec.checkOutMs ? ' → ' + fmtTime(r.rec.checkOutMs) : ''}`;
    else if (r.status === 'leave') line = leaveTypeLabel(r.plan.leaveType || (r.rec && r.rec.leaveType));
    else if (r.status === 'holiday') line = r.plan.name || L(meta.ar, meta.en);
    else if (r.status === 'future' && r.plan.mode === 'remote') line = modeLabel('remote');
    else line = L(meta.ar, meta.en);
    h += `<div class="day ${meta.cls} ${r.date === todayKey ? 'today' : ''} ${clickable ? 'clickable' : ''}" data-day="${r.date}" ${clickable ? 'tabindex="0" role="button"' : ''}>
      <div class="row between"><span class="d">${+r.date.slice(8)}</span>${r.late ? `<i class="fas fa-clock" style="color:var(--bad);font-size:10px" title="${esc(fmtMin(r.late))}"></i>` : ''}${r.flags.includes('forgot') ? '<i class="fas fa-triangle-exclamation" style="color:var(--warn);font-size:10px"></i>' : ''}</div>
      <div class="meta muted truncate">${esc(line)}</div>
      ${r.workMs ? `<div class="meta num xs">${esc(fmtHours(r.workMs))}</div>` : ''}
    </div>`;
  });
  return h + '</div>';
}

export async function showDayDetails(email, row, { canRequest = false } = {}) {
  const meta = STATUS_DAY[row.status] || STATUS_DAY.none;
  const m = modal({
    title: fmtDay(row.date), icon: 'fa-calendar-day',
    body: `<div class="row-wrap mb-16"><span class="badge ${meta.badge}">${esc(L(meta.ar, meta.en) || modeLabel(row.plan.mode))}</span>
        ${row.mode ? `<span class="badge brand">${esc(modeLabel(row.mode))}</span>` : ''}
        ${row.late ? `<span class="badge bad">${L('تأخير', 'Late')} ${esc(fmtMin(row.late))}</span>` : ''}
        ${row.early ? `<span class="badge warn">${L('انصراف مبكر', 'Early')} ${esc(fmtMin(row.early))}</span>` : ''}
        ${row.flags.includes('forgot') ? `<span class="badge warn">${L('اتقفل تلقائياً', 'Auto-closed')}</span>` : ''}
        ${row.flags.includes('corrected') ? `<span class="badge info">${L('متعدّل من HR', 'Corrected by HR')}</span>` : ''}
        ${row.flags.includes('excused') ? `<span class="badge ok">${L('بإذن', 'Excused')}</span>` : ''}</div>
      <dl class="kv">
        <dt>${L('الخطة', 'Plan')}</dt><dd>${esc(modeLabel(row.plan.mode))}${row.plan.start ? ` · ${esc(row.plan.start)}–${esc(row.plan.end)}` : ''}</dd>
        <dt>${L('الحضور', 'Check-in')}</dt><dd class="num">${esc(row.rec && row.rec.checkInMs ? fmtTime(row.rec.checkInMs) : '—')}</dd>
        <dt>${L('الانصراف', 'Check-out')}</dt><dd class="num">${esc(row.rec && row.rec.checkOutMs ? fmtTime(row.rec.checkOutMs) : '—')}</dd>
        <dt>${L('شغل', 'Work')}</dt><dd>${esc(fmtHours(row.workMs))}</dd>
        <dt>${L('استراحة', 'Break')}</dt><dd>${esc(fmtHours(row.breakMs))}</dd>
        <dt>${L('اجتماعات', 'Meetings')}</dt><dd>${esc(fmtHours(row.meetingMs))}</dd>
        ${row.rec && row.rec.correctionNote ? `<dt>${L('ملاحظة التصحيح', 'Correction note')}</dt><dd>${esc(row.rec.correctionNote)}</dd>` : ''}
      </dl>
      <div class="mt-16"><div class="label mb-8">${L('سجل الحالات', 'Status log')}</div><div id="day-logs">${loader()}</div></div>`,
    foot: `${canRequest && row.date <= dayKey(now()) ? `<button class="btn" id="fix-btn"><i class="fas fa-pen-to-square"></i> ${L('طلب تصحيح', 'Request correction')}</button>` : ''}<button class="btn btn-primary" data-close>${L('تمام', 'OK')}</button>`
  });
  const fb = m.$('#fix-btn');
  if (fb) fb.onclick = () => { m.close(); openRequestForm('correction', { date: row.date }); };
  try {
    const logs = (await dayLogs(email, row.date, scopeFor(email))).sort((a, b) => (toMs(a.timestamp) || 0) - (toMs(b.timestamp) || 0));
    m.$('#day-logs').innerHTML = logs.length ? `<div class="timeline">${logs.map(l => {
      const s = STATUS_META[l.to_status] || STATUS_META.Offline;
      return `<div class="tl-item ${s.cls}"><div class="row between"><b class="small">${esc(L(s.ar, s.en))}</b><span class="xs muted num">${esc(fmtTime(toMs(l.timestamp)))}</span></div>${l.changed_by === 'admin' ? `<div class="xs muted">${L('بواسطة', 'by')} ${esc(l.changed_by_name || '')}</div>` : ''}</div>`;
    }).join('')}</div>` : `<p class="muted small">${L('مفيش سجل لليوم ده', 'No log for this day')}</p>`;
  } catch { m.$('#day-logs').innerHTML = `<p class="muted small">—</p>`; }
}

/** Render a person's month into `el` with a month switcher */
export async function personMonthView(el, email, { initialYm, canRequest = false, title = '' } = {}) {
  let ym = initialYm || ymOf(now());
  let data = null;
  el.innerHTML = `<div class="row between mb-16" style="flex-wrap:wrap;gap:10px">
      <div>${title}</div>
      <div class="row gap-8"><button class="btn btn-icon btn-sm" data-m="-1" aria-label="prev"><i class="fas fa-chevron-right" data-flip></i></button>
      <b id="pm-label" style="min-width:130px;text-align:center"></b>
      <button class="btn btn-icon btn-sm" data-m="1" aria-label="next"><i class="fas fa-chevron-left" data-flip></i></button></div>
    </div><div id="pm-body">${loader()}</div>`;
  async function load() {
    el.querySelector('#pm-label').textContent = fmtMonth(ym);
    el.querySelector('#pm-body').innerHTML = loader();
    try {
      data = await personMonth(email, ym, scopeFor(email));
      el.querySelector('#pm-body').innerHTML = `${statTiles(data.totals)}
        <div class="card mt-16"><div class="card-body">${calendarHTML(data.rows, ym)}</div>
        <div class="card-foot" style="justify-content:flex-start">
          ${[['present', 'ok'], ['remote', 'brand'], ['absent', 'bad'], ['leave', 'warn'], ['off', '']].map(([k, c]) => `<span class="badge ${c}"><span class="dot"></span>${esc(L(STATUS_DAY[k].ar, STATUS_DAY[k].en))}</span>`).join('')}
        </div></div>`;
      el.querySelectorAll('[data-day]').forEach(d => {
        const open = () => { const r = data.rows.find(x => x.date === d.dataset.day); if (r && r.status !== 'future') showDayDetails(email, r, { canRequest }); };
        d.onclick = open; d.onkeydown = (e) => { if (e.key === 'Enter') open(); };
      });
    } catch (e) {
      console.error(e);
      el.querySelector('#pm-body').innerHTML = `<div class="card">${empty('fa-triangle-exclamation', L('تعذّر تحميل البيانات', 'Could not load data'), e.message)}</div>`;
    }
  }
  el.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { ym = addMonths(ym, Number(b.dataset.m)); load(); });
  await load();
}

export default async function render(root) {
  root.innerHTML = `<div class="page-head"><div><h2>${L('حضوري', 'My attendance')}</h2><p>${L('اضغط على أي يوم عشان تشوف تفاصيله أو تطلب تصحيح.', 'Click any day for details or to request a correction.')}</p></div></div><div id="pm"></div>`;
  await personMonthView(root.querySelector('#pm'), session.email, { canRequest: true });
}
