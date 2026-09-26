// Weekly roster: office / remote / off / mission per person per day, with custom hours.
import { L, esc, ymd, addDays, weekday, fmtDate, isAr, debounce } from '../core/utils.js';
import { toast, toastErr, modal, avatar, empty, busy, loader } from '../core/ui.js';
import { now, isHR, session } from '../core/session.js';
import { planFor, MODE_META, modeLabel, policy, leaveTypeLabel, dayKey } from '../core/policy.js';
import { list, query, col, where } from '../core/fb.js';
import { managedPeople, departments } from '../services/directory.js';
import { setScheduleDay } from '../services/requests.js';

const DOW = () => isAr ? ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekStart = (d) => addDays(d, -((weekday(d) + 1) % 7)); // Saturday

export default async function render(root) {
  let start = weekStart(dayKey(now())), term = '', dept = '';
  let schedules = [];
  root.innerHTML = `
    <div class="page-head"><div><h2>${L('جداول العمل', 'Work schedules')}</h2><p>${L('خطة كل موظف: مكتب، أونلاين، راحة أو مأمورية. الإجازات بتتضاف تلقائياً من الطلبات المعتمدة.', 'Each person\'s plan: office, remote, off or mission. Leave is added automatically from approved requests.')}</p></div>
      <div class="row gap-8"><button class="btn btn-icon" data-w="-7"><i class="fas fa-chevron-right" data-flip></i></button><b id="wl" style="min-width:190px;text-align:center"></b><button class="btn btn-icon" data-w="7"><i class="fas fa-chevron-left" data-flip></i></button><button class="btn btn-sm" id="this">${L('الأسبوع ده', 'This week')}</button></div></div>
    <div class="filters">
      <div class="search grow" style="max-width:260px"><i class="fas fa-search"></i><input class="input" id="q" placeholder="${L('بحث', 'Search')}"></div>
      ${isHR() ? `<select class="select" id="dept"><option value="">${L('كل الأقسام', 'All departments')}</option>${departments().map(d => `<option>${esc(d)}</option>`).join('')}</select>` : ''}
      <div class="row-wrap gap-4">${['office', 'remote', 'leave', 'mission', 'off', 'holiday'].map(k => `<span class="chip ${MODE_META[k].cls}">${esc(modeLabel(k))}</span>`).join('')}</div>
    </div>
    <div class="card"><div class="table-wrap"><table class="table roster"><thead id="th"></thead><tbody id="tb"><tr><td>${loader()}</td></tr></tbody></table></div></div>`;
  async function load() {
    const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    root.querySelector('#wl').textContent = `${fmtDate(dates[0], { year: undefined })} — ${fmtDate(dates[6])}`;
    const months = [...new Set(dates.map(d => d.slice(0, 7)))];
    const scope = isHR() ? [] : [where('leaderEmail', '==', session.email)];
    schedules = (await Promise.all(months.map(m => list(query(col('schedules'), ...scope, where('month', '==', m))).catch(() => [])))).flat();
    draw(dates);
  }
  function draw(dates) {
    const today = dayKey(now());
    root.querySelector('#th').innerHTML = `<tr><th style="text-align:start">${L('الموظف', 'Employee')}</th>${dates.map(d => `<th style="${d === today ? 'color:var(--brand)' : ''}">${esc(DOW()[weekday(d)])}<div class="xs muted num">${+d.slice(8)}/${+d.slice(5, 7)}</div></th>`).join('')}</tr>`;
    const ppl = managedPeople().filter(p => (!term || `${p.name} ${p.email}`.toLowerCase().includes(term)) && (!dept || p.department === dept));
    root.querySelector('#tb').innerHTML = ppl.length ? ppl.map(p => `<tr><td style="text-align:start"><div class="person">${avatar(p, 'sm')}<div><b>${esc(p.name)}</b><span>${esc(p.title || '')}</span></div></div></td>
      ${dates.map(d => {
        const sch = schedules.find(s => s.email === p.email && s.month === d.slice(0, 7));
        const pl = planFor(d, sch);
        const meta = MODE_META[pl.mode] || MODE_META.office;
        const custom = pl.source === 'schedule' && pl.start && (pl.start !== policy.workStart || pl.end !== policy.workEnd);
        return `<td><div class="cell ${meta.cls}" data-email="${esc(p.email)}" data-date="${d}" role="button" tabindex="0" title="${esc(pl.name || '')}">
          <div>${esc(pl.mode === 'leave' && pl.leaveType ? leaveTypeLabel(pl.leaveType) : modeLabel(pl.mode))}</div>${custom ? `<div class="xs num">${esc(pl.start)}–${esc(pl.end)}</div>` : ''}</div></td>`;
      }).join('')}</tr>`).join('') : `<tr><td colspan="8">${empty('fa-users', L('مفيش موظفين', 'No employees'))}</td></tr>`;
    root.querySelectorAll('.cell').forEach(c => { c.onclick = () => edit(c.dataset.email, c.dataset.date); c.onkeydown = (e) => { if (e.key === 'Enter') edit(c.dataset.email, c.dataset.date); }; });
  }
  function edit(email, date) {
    const p = managedPeople().find(x => x.email === email);
    const sch = schedules.find(s => s.email === email && s.month === date.slice(0, 7));
    const pl = planFor(date, sch);
    if (pl.mode === 'leave' || (pl.requestId && pl.source === 'schedule')) {
      toast(L('اليوم ده جاي من طلب معتمد', 'This day comes from an approved request'), L('لو عايز تغيّره، ألغِ اعتماد الطلب من صفحة الموافقات.', 'To change it, revoke the request in Approvals.'), 'info');
      return;
    }
    const m = modal({
      title: `${p ? p.name : email} — ${fmtDate(date)}`, icon: 'fa-calendar-day', size: 'narrow',
      body: `<form class="form-grid" id="sf">
        <div class="field span-2"><label>${L('الخطة', 'Plan')}</label><select class="select" name="mode">${['office', 'remote', 'mission', 'off'].map(k => `<option value="${k}" ${pl.mode === k ? 'selected' : ''}>${esc(modeLabel(k))}</option>`).join('')}</select></div>
        <div class="field"><label>${L('من', 'From')}</label><input class="input" type="time" name="start" value="${esc(pl.start || policy.workStart)}"></div>
        <div class="field"><label>${L('إلى', 'To')}</label><input class="input" type="time" name="end" value="${esc(pl.end || policy.workEnd)}"></div>
        <label class="check span-2"><input type="checkbox" name="all"> ${L('طبّق على كل أيام العمل في الأسبوع ده', 'Apply to all working days this week')}</label></form>`,
      foot: `${pl.source === 'schedule' ? `<button class="btn btn-ghost" id="rst">${L('رجوع للافتراضي', 'Reset to default')}</button>` : ''}<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="ok">${L('حفظ', 'Save')}</button>`
    });
    const f = m.$('#sf');
    m.$('#ok').onclick = (e) => busy(e.currentTarget, async () => {
      const val = { mode: f.mode.value, ...(f.mode.value !== 'off' ? { start: f.start.value, end: f.end.value } : {}), by: session.email };
      const dates = f.all.checked ? Array.from({ length: 7 }, (_, i) => addDays(start, i)).filter(d => { const x = planFor(d, schedules.find(s => s.email === email && s.month === d.slice(0, 7))); return x.mode !== 'off' && x.mode !== 'holiday' && x.mode !== 'leave' && !x.requestId; }) : [date];
      try { for (const d of dates) await setScheduleDay(email, d, val); m.close(); toast(L('تم الحفظ', 'Saved')); load(); } catch (ex) { toastErr(ex); }
    });
    const r = m.$('#rst'); if (r) r.onclick = () => busy(r, async () => { try { await setScheduleDay(email, date, null); m.close(); load(); } catch (ex) { toastErr(ex); } });
  }
  root.querySelectorAll('[data-w]').forEach(b => b.onclick = () => { start = addDays(start, Number(b.dataset.w)); load(); });
  root.querySelector('#this').onclick = () => { start = weekStart(dayKey(now())); load(); };
  root.querySelector('#q').oninput = debounce(e => { term = e.target.value.trim().toLowerCase(); draw(Array.from({ length: 7 }, (_, i) => addDays(start, i))); }, 150);
  const ds = root.querySelector('#dept'); if (ds) ds.onchange = e => { dept = e.target.value; draw(Array.from({ length: 7 }, (_, i) => addDays(start, i))); };
  await load();
}
