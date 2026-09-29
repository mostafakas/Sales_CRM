// HR: daily attendance sheet with corrections and bulk-close of forgotten days.
import { L, esc, fmtTime, fmtMin, fmtHours, num, ymd, addDays, fmtDay, cairoMs, pad, zparts, debounce } from '../core/utils.js';
import { toast, toastErr, modal, avatar, empty, busy, bindActions, loader, confirmDialog } from '../core/ui.js';
import { now } from '../core/session.js';
import { planFor, modeLabel, dayKey, leaveTypeLabel, trackedSince } from '../core/policy.js';
import { list, query, col, where } from '../core/fb.js';
import { activePeople, departments } from '../services/directory.js';
import { rangeDays, correctDay, staleDay, closeStaleDay } from '../services/attendance.js';
import { classifyDay, STATUS_DAY } from '../services/reports.js';
import { exportSheet } from './export.js';

const hm = (ms) => { if (!ms) return ''; const p = zparts(ms); return `${pad(p.h)}:${pad(p.mi)}`; };

export default async function render(root) {
  let date = dayKey(now()), rows = [], term = '', dept = '', sf = '';
  root.innerHTML = `
    <div class="page-head"><div><h2>${L('الحضور اليومي', 'Daily attendance')}</h2><p id="dlabel"></p></div>
      <div class="row gap-8">
        <button class="btn btn-icon" data-d="-1" aria-label="prev"><i class="fas fa-chevron-right" data-flip></i></button>
        <input type="date" class="input" id="date" style="width:170px">
        <button class="btn btn-icon" data-d="1" aria-label="next"><i class="fas fa-chevron-left" data-flip></i></button>
        <button class="btn" id="xls"><i class="fas fa-file-excel"></i> Excel</button>
      </div></div>
    <div class="grid g-4 keep-2 mb-16" id="kpi"></div>
    <div id="stale" class="mb-16"></div>
    <div class="filters">
      <div class="search grow" style="max-width:280px"><i class="fas fa-search"></i><input class="input" id="q" placeholder="${L('بحث', 'Search')}"></div>
      <select class="select" id="dept"><option value="">${L('كل الأقسام', 'All departments')}</option>${departments().map(d => `<option>${esc(d)}</option>`).join('')}</select>
      <select class="select" id="sf"><option value="">${L('كل الحالات', 'All statuses')}</option>${['present', 'remote', 'absent', 'leave', 'off', 'holiday', 'today'].map(k => `<option value="${k}">${esc(L(STATUS_DAY[k].ar, STATUS_DAY[k].en))}</option>`).join('')}<option value="late">${L('متأخر', 'Late')}</option></select>
    </div>
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr>
      <th>${L('الموظف', 'Employee')}</th><th>${L('الخطة', 'Plan')}</th><th>${L('الحالة', 'Status')}</th><th>${L('حضور', 'In')}</th><th>${L('انصراف', 'Out')}</th><th>${L('تأخير', 'Late')}</th><th>${L('ساعات', 'Hours')}</th><th></th>
    </tr></thead><tbody id="rows"><tr><td colspan="8">${loader()}</td></tr></tbody></table></div></div>`;
  const dateInp = root.querySelector('#date');

  async function load() {
    dateInp.value = date;
    root.querySelector('#dlabel').textContent = fmtDay(date);
    root.querySelector('#rows').innerHTML = `<tr><td colspan="8">${loader()}</td></tr>`;
    const ym = date.slice(0, 7);
    const [days, schedules, reqs] = await Promise.all([
      rangeDays(date, date),
      list(query(col('schedules'), where('month', '==', ym))).catch(() => []),
      list(query(col('requests'), where('startDate', '==', date))).catch(() => [])
    ]);
    const todayKey = dayKey(now());
    rows = activePeople().filter(p => p.trackAttendance !== false).map(p => {
      const sch = schedules.find(s => s.email === p.email);
      const rec = days.find(d => d.email === p.email);
      const ex = reqs.filter(r => r.email === p.email && r.type === 'excuse' && r.status === 'approved');
      return { p, r: classifyDay(date, planFor(date, sch, p), rec, ex, todayKey, trackedSince(p)) };
    });
    draw();
    const stale = date === todayKey ? activePeople().filter(p => staleDay(p)) : [];
    root.querySelector('#stale').innerHTML = stale.length ? `<div class="alert warn"><i class="fas fa-triangle-exclamation"></i><span class="grow">${L(`${stale.length} موظف ما قفلوش يوم سابق.`, `${stale.length} people did not end a previous day.`)}</span><button class="btn btn-sm" id="close-all">${L('قفلهم على ميعاد الانصراف', 'Close at planned end')}</button></div>` : '';
    const ca = root.querySelector('#close-all');
    if (ca) ca.onclick = () => busy(ca, async () => {
      let n = 0; for (const p of stale) { try { await closeStaleDay(p.email, p); n++; } catch (e) { console.warn(e); } }
      toast(L(`اتقفل ${n} يوم`, `${n} days closed`)); load();
    });
  }
  function draw() {
    const vis = rows.filter(({ p, r }) => {
      if (term && !`${p.name} ${p.email}`.toLowerCase().includes(term)) return false;
      if (dept && p.department !== dept) return false;
      if (sf === 'late') return r.late > 0;
      if (sf && r.status !== sf) return false;
      return true;
    });
    const c = (s) => rows.filter(x => x.r.status === s).length;
    const k = (icon, cls, label, v) => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value">${num(v)}</div></div>`;
    root.querySelector('#kpi').innerHTML = k('fa-building', 'ok', L('في المكتب', 'Office'), c('present')) + k('fa-house-laptop', '', L('أونلاين', 'Remote'), c('remote')) +
      k('fa-user-xmark', 'bad', L('غياب', 'Absent'), c('absent')) + k('fa-clock', 'warn', L('متأخرين', 'Late'), rows.filter(x => x.r.late).length);
    root.querySelector('#rows').innerHTML = vis.length ? vis.map(({ p, r }) => {
      const meta = STATUS_DAY[r.status] || STATUS_DAY.none;
      const rec = r.rec || {};
      return `<tr>
        <td><div class="person">${avatar(p, 'sm')}<div><b>${esc(p.name)}</b><span>${esc(p.department || p.title || '')}</span></div></div></td>
        <td class="small">${esc(modeLabel(r.plan.mode))}${r.plan.leaveType ? ` · ${esc(leaveTypeLabel(r.plan.leaveType))}` : ''}</td>
        <td><span class="badge ${meta.badge}">${esc(L(meta.ar, meta.en) || '—')}</span>${r.flags.includes('forgot') ? ` <span class="badge warn" title="${L('اتقفل تلقائياً', 'Auto-closed')}"><i class="fas fa-triangle-exclamation"></i></span>` : ''}${r.flags.includes('corrected') ? ` <span class="badge info">${L('معدّل', 'Edited')}</span>` : ''}${r.flags.includes('remote-pending') ? ` <span class="badge warn">${L('أونلاين بدون موافقة', 'Unapproved remote')}</span>` : ''}</td>
        <td class="num">${esc(rec.checkInMs ? fmtTime(rec.checkInMs) : '—')}</td>
        <td class="num">${esc(rec.checkOutMs ? fmtTime(rec.checkOutMs) : (rec.checkInMs && !rec.closed ? L('لسه شغال', 'Working') : '—'))}</td>
        <td>${r.late ? `<span class="badge bad">${esc(fmtMin(r.late))}</span>` : '—'}</td>
        <td class="num">${r.workMs ? esc(fmtHours(r.workMs)) : '—'}</td>
        <td style="text-align:end"><button class="btn btn-sm" data-action="fix" data-email="${esc(p.email)}"><i class="fas fa-pen"></i> ${L('تصحيح', 'Correct')}</button></td></tr>`;
    }).join('') : `<tr><td colspan="8">${empty('fa-user-clock', L('مفيش نتائج', 'No results'))}</td></tr>`;
  }
  bindActions(root, {
    fix: ({ email }) => {
      const it = rows.find(x => x.p.email === email); if (!it) return;
      const rec = it.r.rec || {};
      const m = modal({
        title: `${L('تصحيح حضور', 'Correct attendance')} — ${it.p.name}`, icon: 'fa-pen-to-square', size: 'narrow',
        body: `<form class="form-grid" id="cf">
          <div class="field span-2"><label>${L('الحالة', 'Status')}</label><select class="select" name="status">
            <option value="">${L('حسب التسجيل', 'From records')}</option><option value="present">${L('حاضر', 'Present')}</option><option value="absent">${L('غياب', 'Absent')}</option><option value="leave">${L('إجازة', 'Leave')}</option></select></div>
          <div class="field"><label>${L('حضور', 'Check-in')}</label><input class="input" type="time" name="in" value="${esc(hm(rec.checkInMs))}"></div>
          <div class="field"><label>${L('انصراف', 'Check-out')}</label><input class="input" type="time" name="out" value="${esc(hm(rec.checkOutMs))}"></div>
          <div class="field span-2"><label>${L('المكان', 'Location')}</label><select class="select" name="mode"><option value="">—</option><option value="office" ${rec.mode === 'office' ? 'selected' : ''}>${L('المكتب', 'Office')}</option><option value="remote" ${rec.mode === 'remote' ? 'selected' : ''}>${L('أونلاين', 'Remote')}</option></select></div>
          <div class="field span-2"><label>${L('سبب التصحيح', 'Reason')} *</label><input class="input" name="note" required></div></form>
          <p class="xs muted mt-8">${L('القيم القديمة بتتحفظ مع التصحيح.', 'Previous values are kept with the correction.')}</p>`,
        foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="cs">${L('حفظ', 'Save')}</button>`
      });
      m.$('#cs').onclick = (e) => busy(e.currentTarget, async () => {
        const f = m.$('#cf');
        if (!f.note.value.trim()) { f.note.focus(); return; }
        const inMs = f.in.value ? cairoMs(date, f.in.value) : undefined;
        let outMs = f.out.value ? cairoMs(date, f.out.value) : undefined;
        if (inMs && outMs && outMs < inMs) outMs += 86400000;
        const work = inMs && outMs ? Math.max(0, outMs - inMs - (rec.breakMs || 0)) : undefined;
        try {
          await correctDay(email, date, { checkInMs: inMs, checkOutMs: outMs, mode: f.mode.value || undefined, workMs: work, note: f.note.value.trim(), status: f.status.value || undefined });
          m.close(); toast(L('تم التصحيح', 'Corrected')); load();
        } catch (ex) { toastErr(ex); }
      });
    }
  });
  root.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { date = addDays(date, Number(b.dataset.d)); load(); });
  dateInp.onchange = () => { if (dateInp.value) { date = dateInp.value; load(); } };
  root.querySelector('#q').oninput = debounce(e => { term = e.target.value.trim().toLowerCase(); draw(); }, 150);
  root.querySelector('#dept').onchange = e => { dept = e.target.value; draw(); };
  root.querySelector('#sf').onchange = e => { sf = e.target.value; draw(); };
  root.querySelector('#xls').onclick = () => exportSheet(`attendance_${date}`, [{
    name: date,
    rows: rows.map(({ p, r }) => ({
      [L('الموظف', 'Employee')]: p.name, [L('الإيميل', 'Email')]: p.email, [L('القسم', 'Department')]: p.department || '',
      [L('الخطة', 'Plan')]: modeLabel(r.plan.mode), [L('الحالة', 'Status')]: L((STATUS_DAY[r.status] || {}).ar || '', (STATUS_DAY[r.status] || {}).en || ''),
      [L('حضور', 'In')]: r.rec && r.rec.checkInMs ? fmtTime(r.rec.checkInMs) : '', [L('انصراف', 'Out')]: r.rec && r.rec.checkOutMs ? fmtTime(r.rec.checkOutMs) : '',
      [L('تأخير (دقيقة)', 'Late (min)')]: r.late || 0, [L('ساعات الشغل', 'Work hours')]: Math.round((r.workMs || 0) / 36000) / 100
    }))
  }]);
  await load();
}
