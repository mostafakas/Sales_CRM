// Leaves & balances: who's out this month, balances per person, open a new leave year.
import { L, esc, num, fmtMonth, addMonths, ym as ymOf, monthDates, fmtDate, isAr, weekday } from '../core/utils.js';
import { toast, toastErr, avatar, empty, loader, busy, confirmDialog } from '../core/ui.js';
import { now, isHR, session } from '../core/session.js';
import { leaveTypes, planFor, policy, leaveTypeLabel, modeLabel } from '../core/policy.js';
import { list, query, col, where, db, doc, writeBatch, serverTimestamp } from '../core/fb.js';
import { managedPeople } from '../services/directory.js';
import { getBalance, remaining, normalizeBalance, balanceId, emptyBalance } from '../services/requests.js';
import { exportSheet } from './export.js';

export default async function render(root) {
  let ym = ymOf(now());
  const year = new Date(now()).getFullYear();
  root.innerHTML = `
    <div class="page-head"><div><h2>${L('الإجازات والأرصدة', 'Leaves & balances')}</h2></div>
      ${isHR() ? `<button class="btn" id="newyear"><i class="fas fa-calendar-plus"></i> ${L(`فتح أرصدة ${year + 1}`, `Open ${year + 1} balances`)}</button>` : ''}</div>
    <div class="grid" style="grid-template-columns:minmax(0,1fr)">
      <section class="card"><div class="card-head"><h3>${L('مين برّه المكتب', "Who's out")}</h3>
        <div class="row gap-8"><button class="btn btn-icon btn-sm" data-m="-1"><i class="fas fa-chevron-right" data-flip></i></button><b id="ml" style="min-width:120px;text-align:center"></b><button class="btn btn-icon btn-sm" data-m="1"><i class="fas fa-chevron-left" data-flip></i></button></div></div>
        <div class="card-body" id="out">${loader()}</div></section>
      <section class="card"><div class="card-head"><h3>${L(`الأرصدة ${year}`, `Balances ${year}`)}</h3><button class="btn btn-sm" id="xls"><i class="fas fa-file-excel"></i> Excel</button></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>${L('الموظف', 'Employee')}</th>${leaveTypes.filter(t => t.active !== false && !t.unlimited).map(t => `<th class="num">${esc(L(t.ar, t.en))}</th>`).join('')}</tr></thead><tbody id="bal"><tr><td>${loader()}</td></tr></tbody></table></div></section>
    </div>`;

  async function loadOut() {
    root.querySelector('#ml').textContent = fmtMonth(ym);
    const scope = isHR() ? [] : [where('leaderEmail', '==', session.email)];
    const schedules = await list(query(col('schedules'), ...scope, where('month', '==', ym))).catch(() => []);
    const ppl = managedPeople();
    const days = monthDates(ym);
    const byDay = days.map(d => ({ d, items: ppl.map(p => ({ p, pl: planFor(d, schedules.find(s => s.email === p.email)) })).filter(x => ['leave', 'remote', 'mission'].includes(x.pl.mode) && x.pl.source === 'schedule') })).filter(x => x.items.length);
    root.querySelector('#out').innerHTML = byDay.length ? `<div class="col gap-8">${byDay.map(x => `<div class="row gap-16" style="align-items:flex-start;border-bottom:1px solid var(--border);padding-bottom:8px">
        <div style="min-width:90px"><b class="num">${+x.d.slice(8)}</b> <span class="xs muted">${esc(new Intl.DateTimeFormat(isAr ? 'ar-EG' : 'en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(x.d + 'T12:00:00Z')))}</span></div>
        <div class="row-wrap gap-4">${x.items.map(({ p, pl }) => `<span class="chip ${pl.mode === 'leave' ? 'm-leave' : (pl.mode === 'remote' ? 'm-remote' : 'm-mission')}">${esc(p.name)} · ${esc(pl.mode === 'leave' ? leaveTypeLabel(pl.leaveType) : modeLabel(pl.mode))}</span>`).join('')}</div></div>`).join('')}</div>`
      : empty('fa-umbrella-beach', L('مفيش إجازات أو أونلاين معتمد الشهر ده', 'No approved leave or remote this month'));
  }
  let balRows = [];
  async function loadBal() {
    const ppl = managedPeople();
    let bals;
    if (isHR()) {
      const all = await list(query(col('balances'), where('year', '==', year))).catch(() => []);
      bals = ppl.map(p => normalizeBalance(all.find(b => b.email === p.email), p.email, year));
    } else bals = await Promise.all(ppl.map(p => getBalance(p.email, year)));
    balRows = ppl.map((p, i) => ({ p, b: bals[i] }));
    const types = leaveTypes.filter(t => t.active !== false && !t.unlimited);
    root.querySelector('#bal').innerHTML = balRows.length ? balRows.map(({ p, b }) => `<tr>
      <td>${isHR() ? `<a class="person" href="#/employees/${encodeURIComponent(p.email)}" style="color:inherit;text-decoration:none">` : '<div class="person">'}${avatar(p, 'sm')}<div><b>${esc(p.name)}</b><span>${esc(p.department || '')}</span></div>${isHR() ? '</a>' : '</div>'}</td>
      ${types.map(t => { const x = b.types[t.id] || { entitled: 0 }; const r = remaining(x); return `<td class="num"><b style="color:${r <= 0 ? 'var(--bad)' : 'inherit'}">${num(r, 1)}</b><span class="xs muted"> / ${num((x.entitled || 0) + (x.adjust || 0), 1)}</span></td>`; }).join('')}</tr>`).join('')
      : `<tr><td colspan="9">${empty('fa-users', L('مفيش موظفين', 'No employees'))}</td></tr>`;
  }
  root.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { ym = addMonths(ym, Number(b.dataset.m)); loadOut(); });
  root.querySelector('#xls').onclick = () => exportSheet(`balances_${year}`, [{
    name: String(year),
    rows: balRows.map(({ p, b }) => {
      const o = { [L('الموظف', 'Employee')]: p.name, [L('القسم', 'Department')]: p.department || '' };
      leaveTypes.forEach(t => { const x = b.types[t.id] || {}; o[`${L(t.ar, t.en)} — ${L('متبقي', 'left')}`] = remaining(x); o[`${L(t.ar, t.en)} — ${L('مستخدم', 'used')}`] = x.used || 0; });
      return o;
    })
  }]);
  const ny = root.querySelector('#newyear');
  if (ny) ny.onclick = async () => {
    const carry = Number(policy.carryOverMax || 0);
    const ok = await confirmDialog({
      title: L(`فتح أرصدة ${year + 1}`, `Open ${year + 1} balances`),
      message: L(`هيتعمل رصيد جديد لكل موظف حسب أنواع الإجازات الحالية.${carry ? ` وهيترحّل من الاعتيادي المتبقي لحد ${carry} يوم.` : ' مفيش ترحيل للرصيد (تقدر تغيره من الإعدادات).'} الموظفين اللي عندهم رصيد للسنة الجديدة بالفعل مش هيتغيروا.`,
        `A new balance is created for each employee from the current leave types.${carry ? ` Up to ${carry} unused annual days carry over.` : ' No carry-over (change it in Settings).'} Existing ${year + 1} balances are left unchanged.`),
      okText: L('تنفيذ', 'Run')
    });
    if (!ok) return;
    await busy(ny, async () => {
      try {
        const existing = await list(query(col('balances'), where('year', '==', year + 1)));
        let n = 0; const b = writeBatch(db);
        for (const { p, b: cur } of balRows) {
          if (existing.some(x => x.email === p.email)) continue;
          const nb = emptyBalance(p.email, year + 1);
          if (carry && nb.types.annual) { const left = Math.max(0, remaining(cur.types.annual || { entitled: 0 })); nb.types.annual.adjust = Math.min(carry, left); }
          b.set(doc(db, 'balances', balanceId(p.email, year + 1)), { ...nb, openedBy: session.email, updatedAt: serverTimestamp() });
          n++;
        }
        if (n) await b.commit();
        toast(L(`اتفتح ${n} رصيد`, `${n} balances opened`));
      } catch (e) { toastErr(e); }
    });
  };
  await Promise.all([loadOut(), loadBal()]);
}
