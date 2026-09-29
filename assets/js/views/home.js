// "My day": start/end the day, switch status, live timers, balances, today's log.
import { L, esc, fmtDur, fmtTime, fmtHours, fmtMin, ymd, addDays, fmtDate, num, zparts } from '../core/utils.js';
import { toast, toastErr, modal, avatar, presenceBadge, STATUS_META, busy, confirmDialog, empty } from '../core/ui.js';
import { session, now } from '../core/session.js';
import { policy, dayKey, planFor, lateness, modeLabel, MODE_META, typeLabel, statusLabel, REQUEST_STATUS, leaveTypeLabel, isWorkingPlan } from '../core/policy.js';
import { toMs, watch, query, col, where } from '../core/fb.js';
import { startDay, changeStatus, endDay, liveBank, staleDay, closeStaleDay, dayLogs, COUNTED } from '../services/attendance.js';
import { getSchedule, watchBalance, remaining, watchMyRequests } from '../services/requests.js';
import { openRequestForm } from './request-form.js';

export default async function render(root) {
  const unsubs = [];
  let schedule = null, balance = null, myReqs = [];
  const today = () => dayKey(now());

  root.innerHTML = `
    <div class="grid" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);align-items:start" id="home-grid">
      <div class="col gap-16">
        <section class="hero" id="hero"></section>
        <section class="card" id="pad-card"></section>
        <section class="grid g-3 keep-2" id="stats"></section>
      </div>
      <div class="col gap-16">
        <section class="card" id="quick"></section>
        <section class="card" id="upcoming"></section>
        <section class="card" id="log"></section>
      </div>
    </div>`;
  const mq = matchMedia('(max-width: 1100px)');
  const fit = () => { root.querySelector('#home-grid').style.gridTemplateColumns = mq.matches ? 'minmax(0,1fr)' : 'minmax(0,1.6fr) minmax(0,1fr)'; };
  fit(); mq.addEventListener('change', fit); unsubs.push(() => mq.removeEventListener('change', fit));

  const u = () => session.profile || {};
  const started = () => u().dayKey === today() && u().status && u().status !== 'Offline';
  const endedToday = () => u().dayKey === today() && u().checkedOut;

  function renderHero() {
    const p = u();
    const st = started() ? p.status : 'Offline';
    const meta = STATUS_META[st] || STATUS_META.Offline;
    const plan = planFor(today(), schedule, session.email);
    const h = zparts(now()).h;
    const greet = h < 12 ? L('صباح الخير', 'Good morning') : (h < 17 ? L('مساء الخير', 'Good afternoon') : L('مساء النور', 'Good evening'));
    const fo0 = p.dayKey === today() ? toMs(p.firstOnlineAt) : null;
    const fo = fo0 && dayKey(fo0) === today() ? fo0 : null; // ignore a check-in filed under the wrong day
    const late = fo ? lateness(fo, plan) : { late: 0 };
    root.querySelector('#hero').innerHTML = `
      <div class="row gap-16" style="align-items:center;flex-wrap:wrap">
        <div class="ring">${avatar({ ...p, email: session.email }, '')}<span class="st" style="background:${meta.color}"><i class="fas ${meta.icon}"></i></span></div>
        <div class="grow">
          <div class="muted small">${esc(greet)}</div>
          <h2 style="font-size:24px;font-weight:800">${esc(p.name || session.email)}</h2>
          <div class="muted small">${esc(p.title || '')}</div>
          <div class="row-wrap mt-8">
            ${presenceBadge(st)}
            ${p.dayKey === today() && p.workLocation ? `<span class="badge brand"><i class="fas ${p.workLocation === 'remote' ? 'fa-house-laptop' : 'fa-building'}"></i>${esc(modeLabel(p.workLocation))}</span>` : ''}
            ${p.remotePending && p.dayKey === today() ? `<span class="badge warn"><i class="fas fa-hourglass-half"></i>${L('الأونلاين مستني موافقة', 'Remote pending approval')}</span>` : ''}
            ${fo ? `<span class="badge"><i class="fas fa-right-to-bracket"></i>${L('حضور', 'In')} ${esc(fmtTime(fo))}</span>` : ''}
            ${late.late ? `<span class="badge bad"><i class="fas fa-clock"></i>${L('تأخير', 'Late')} ${esc(fmtMin(late.late))}</span>` : ''}
          </div>
        </div>
        <div class="hero-timer">
          <div class="muted small">${L('وقت الشغل النهارده', 'Work time today')}</div>
          <div class="timer-big" id="t-main">00:00:00</div>
          <div class="muted small mt-8">${esc(L('الخطة:', 'Plan:'))} ${esc(modeLabel(plan.mode))}${plan.start ? ` · ${esc(plan.start)}–${esc(plan.end)}` : ''}</div>
        </div>
      </div>`;
  }

  function renderPad() {
    const p = u();
    const card = root.querySelector('#pad-card');
    const plan = planFor(today(), schedule, session.email);
    if (!started()) {
      const stale = staleDay(p);
      const note = plan.mode === 'leave' ? `<div class="alert warn mb-16"><i class="fas fa-umbrella-beach"></i><span>${L('النهارده إجازة معتمدة ليك', 'You have approved leave today')}${plan.leaveType ? ` (${esc(leaveTypeLabel(plan.leaveType))})` : ''}.</span></div>`
        : (plan.mode === 'off' || plan.mode === 'holiday') ? `<div class="alert info mb-16"><i class="fas fa-bed"></i><span>${plan.mode === 'holiday' ? esc(L('عطلة رسمية', 'Public holiday')) + (plan.name ? ` — ${esc(plan.name)}` : '') : L('النهارده يوم راحة.', 'Today is a day off.')}</span></div>` : '';
      card.innerHTML = `<div class="card-body">
        ${note}
        ${stale ? `<div class="alert warn mb-16"><i class="fas fa-triangle-exclamation"></i><span>${L(`يوم ${fmtDate(stale)} ما اتقفلش. هيتقفل تلقائياً على ميعاد الانصراف لما تبدأ النهارده، ولو فيه خطأ قدّم طلب تصحيح.`, `Your day on ${fmtDate(stale)} was not ended. It will be closed at the planned end time when you start today; request a correction if needed.`)}</span></div>` : ''}
        <div class="row between" style="flex-wrap:wrap;gap:16px">
          <div><h3 style="font-size:17px">${endedToday() ? L('خلّصت يومك', 'Your day is ended') : L('جاهز تبدأ؟', 'Ready to start?')}</h3>
          <p class="muted small">${endedToday() ? L('لو رجعت تشتغل تاني تقدر تكمل نفس اليوم.', 'If you are back to work you can resume today.') : L('اختار هتشتغل منين النهارده.', 'Choose where you are working from today.')}</p></div>
          <button class="btn btn-grad btn-lg" id="start-btn"><i class="fas fa-play"></i> ${endedToday() ? L('كمّل اليوم', 'Resume day') : L('ابدأ يومك', 'Start your day')}</button>
        </div></div>`;
      card.querySelector('#start-btn').onclick = openStart;
      return;
    }
    const enabled = COUNTED.filter(k => (policy.statuses[k] || {}).enabled !== false);
    card.innerHTML = `<div class="card-head"><h3>${L('حالتك دلوقتي', 'Your status')}</h3>
        <button class="btn btn-danger btn-sm" id="end-btn"><i class="fas fa-flag-checkered"></i> ${L('إنهاء اليوم', 'End day')}</button></div>
      <div class="card-body">
        <div class="status-pad">${enabled.map(k => {
          const s = STATUS_META[k];
          return `<button class="status-btn s-${k} ${p.status === k ? 'active' : ''}" data-st="${k}" ${p.status === k ? 'aria-pressed="true"' : ''}>
            <i class="fas ${s.icon}"></i><span>${esc(L(s.ar, s.en))}</span><span class="num small" data-timer="${k}">00:00:00</span></button>`;
        }).join('')}</div>
        <div id="break-warn" class="alert warn mt-16 hidden"><i class="fas fa-mug-hot"></i><span>${L(`تخطيت وقت الاستراحة المسموح (${policy.breakMaxMinutes} دقيقة).`, `You exceeded the allowed break time (${policy.breakMaxMinutes} min).`)}</span></div>
        <div id="offline-warn" class="alert bad mt-16 hidden"><i class="fas fa-wifi"></i><span>${L('مفيش إنترنت — تغيير الحالة متوقف لحد ما النت يرجع.', 'Offline — status changes are paused until you reconnect.')}</span></div>
      </div>`;
    card.querySelectorAll('[data-st]').forEach(b => b.onclick = () => busy(b, async () => {
      if (!navigator.onLine) { toast(L('مفيش إنترنت', 'No internet'), '', 'bad'); return; }
      try { await changeStatus(session.email, b.dataset.st); } catch (e) { toastErr(e); }
    }));
    card.querySelector('#end-btn').onclick = async (e) => {
      const ok = await confirmDialog({ title: L('إنهاء اليوم', 'End day'), message: L('هيتسجل وقت انصرافك دلوقتي. متأكد؟', 'Your check-out will be recorded now. Continue?'), okText: L('إنهاء اليوم', 'End day'), okClass: 'btn-danger' });
      if (!ok) return;
      try { await endDay(); toast(L('يومك اتقفل. شكراً على مجهودك!', 'Day ended. Thanks for your work!')); } catch (ex) { toastErr(ex); }
    };
  }

  async function openStart() {
    const plan = planFor(today(), schedule, session.email);
    const approvedRemote = plan.mode === 'remote';
    const quota = Number(u().remoteQuota ?? policy.defaultRemoteQuota);
    const m = modal({
      title: L('هتشتغل منين النهارده؟', 'Where are you working today?'), icon: 'fa-location-dot', size: 'narrow',
      body: `<div class="col gap-16">
        <button class="btn btn-lg btn-block btn-primary" data-mode="office" style="height:64px;justify-content:flex-start"><i class="fas fa-building"></i> ${L('من المكتب', 'From the office')}</button>
        <button class="btn btn-lg btn-block" data-mode="remote" style="height:64px;justify-content:flex-start"><i class="fas fa-house-laptop"></i>
          <span class="grow" style="text-align:start">${L('أونلاين', 'Remote')}</span>
          ${approvedRemote ? `<span class="badge ok">${L('معتمد', 'Approved')}</span>` : (policy.remoteNeedsApproval && isWorkingPlan(plan) ? `<span class="badge warn">${L('محتاج موافقة', 'Needs approval')}</span>` : '')}</button>
        ${!approvedRemote && policy.remoteNeedsApproval && isWorkingPlan(plan) ? `<p class="small muted">${L(`لو اخترت أونلاين من غير طلب معتمد، هيتبعت طلب تلقائي لمديرك واليوم هيتعلّم «مستني موافقة». حصتك الشهرية ${quota} أيام.`, `Choosing remote without an approved request sends an automatic request to your manager and flags the day as pending. Your monthly quota is ${quota} days.`)}</p>` : ''}
      </div>`
    });
    m.$$('[data-mode]').forEach(b => b.onclick = () => busy(b, async () => {
      const mode = b.dataset.mode;
      try {
        const needsReq = mode === 'remote' && policy.remoteNeedsApproval && !approvedRemote && !endedToday() && isWorkingPlan(plan);
        const wasStale = !!staleDay(u());
        const res = await startDay(mode, { remoteApproved: !needsReq });
        if (needsReq) {
          const { submitRequest } = await import('../services/requests.js');
          try { await submitRequest({ type: 'remote', startDate: res.key, endDate: res.key, reason: L('طلب تلقائي عند بدء اليوم', 'Automatic request at check-in') }); }
          catch (e) { console.warn(e); toast(L('مقدرتش أبعت طلب الأونلاين تلقائياً', 'Could not send the remote request automatically'), e.userMessage || L('قدّمه من «طلباتي».', 'Submit it from My requests.'), 'warn'); }
        }
        m.close();
        toast(res.resumed ? L('كمّلت يومك', 'Day resumed') : L('يومك بدأ، بالتوفيق!', 'Your day has started. Have a great one!'), wasStale ? L('اليوم اللي فات اتقفل تلقائياً.', 'Your previous day was closed automatically.') : '');
      } catch (e) { toastErr(e); }
    }));
  }

  function renderStats() {
    const p = u();
    const annual = balance ? remaining(balance.types.annual || { entitled: 0 }) : null;
    const casual = balance ? remaining(balance.types.casual || { entitled: 0 }) : null;
    const monthKey = today().slice(0, 7);
    const remoteUsed = myReqs.filter(r => r.type === 'remote' && r.status === 'approved' && (r.startDate || '').slice(0, 7) === monthKey).reduce((s, r) => s + (r.days || 0), 0);
    const quota = Number(p.remoteQuota ?? policy.defaultRemoteQuota);
    const pending = myReqs.filter(r => String(r.status).startsWith('pending')).length;
    const tile = (icon, cls, label, value, unit, hint = '') => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value">${value}<small>${esc(unit)}</small></div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
    root.querySelector('#stats').innerHTML =
      tile('fa-umbrella-beach', '', L('رصيد الاعتيادي', 'Annual balance'), annual === null ? '—' : num(annual, 1), L('يوم', 'days')) +
      tile('fa-person-running', 'info', L('رصيد العارضة', 'Casual balance'), casual === null ? '—' : num(casual, 1), L('يوم', 'days')) +
      tile('fa-house-laptop', 'ok', L('أونلاين الشهر ده', 'Remote this month'), `${num(remoteUsed)}<small>/ ${num(quota)}</small>`, '') +
      tile('fa-hourglass-half', 'warn', L('طلبات مستنية', 'Pending requests'), num(pending), '', `<a href="#/requests">${L('عرض طلباتي', 'View my requests')}</a>`);
  }

  function renderQuick() {
    const q = [
      ['leave', 'fa-umbrella-beach', 'warn'], ['remote', 'fa-house-laptop', ''], ['excuse', 'fa-clock', 'info'],
      ['mission', 'fa-briefcase', 'ok'], ['correction', 'fa-pen-to-square', 'neutral'], ['letter', 'fa-file-signature', 'info']
    ];
    root.querySelector('#quick').innerHTML = `<div class="card-head"><h3>${L('طلب سريع', 'Quick request')}</h3></div>
      <div class="card-body"><div class="grid g-3 keep-2" style="gap:10px">${q.map(([t, i, c]) => `
        <button class="btn" data-rq="${t}" style="height:auto;padding:12px 8px;flex-direction:column;gap:6px"><span class="icon-tile ${c}"><i class="fas ${i}"></i></span><span class="small">${esc(typeLabel(t))}</span></button>`).join('')}
      </div></div>`;
    root.querySelectorAll('[data-rq]').forEach(b => b.onclick = () => openRequestForm(b.dataset.rq));
  }

  function renderUpcoming() {
    const t = today(), limitDay = addDays(t, 30);
    const up = myReqs.filter(r => ['leave', 'remote', 'mission'].includes(r.type) && !['rejected', 'cancelled'].includes(r.status) && (r.endDate || r.startDate) >= t && r.startDate <= limitDay)
      .sort((a, b) => a.startDate.localeCompare(b.startDate)).slice(0, 6);
    root.querySelector('#upcoming').innerHTML = `<div class="card-head"><h3>${L('الجاي خلال 30 يوم', 'Next 30 days')}</h3></div>
      ${up.length ? `<div class="list">${up.map(r => {
        const st = REQUEST_STATUS[r.status] || {};
        return `<div class="list-item"><span class="icon-tile ${r.type === 'leave' ? 'warn' : (r.type === 'remote' ? '' : 'ok')}"><i class="fas ${r.type === 'leave' ? 'fa-umbrella-beach' : (r.type === 'remote' ? 'fa-house-laptop' : 'fa-briefcase')}"></i></span>
          <div class="grow"><b class="small">${esc(r.type === 'leave' ? leaveTypeLabel(r.leaveType) : typeLabel(r.type))}</b><div class="xs muted">${esc(fmtDate(r.startDate))}${r.endDate && r.endDate !== r.startDate ? ' → ' + esc(fmtDate(r.endDate)) : ''} · ${num(r.days || 0)} ${L('يوم', 'd')}</div></div>
          <span class="badge ${st.cls || ''}">${esc(statusLabel(r.status))}</span></div>`;
      }).join('')}</div>` : `<div class="card-body">${empty('fa-calendar', L('مفيش حاجة مجدولة', 'Nothing scheduled'))}</div>`}`;
  }

  let logsUnsub = null, logsKey = '';
  function watchLogs() {
    const k = today();
    if (k === logsKey) return; logsKey = k;
    if (logsUnsub) logsUnsub();
    logsUnsub = watch(query(col('logs'), where('user', '==', session.email), where('dayKey', '==', k)), rows => {
      rows.sort((a, b) => (toMs(b.timestamp) || 0) - (toMs(a.timestamp) || 0));
      root.querySelector('#log').innerHTML = `<div class="card-head"><h3>${L('سجل النهارده', "Today's log")}</h3></div>
        <div class="card-body">${rows.length ? `<div class="timeline">${rows.slice(0, 12).map(l => {
          const s = STATUS_META[l.to_status] || STATUS_META.Offline;
          return `<div class="tl-item ${s.cls}"><div class="row between"><b class="small">${esc(L(s.ar, s.en))}</b><span class="xs muted num">${esc(fmtTime(toMs(l.timestamp)))}</span></div>
            <div class="xs muted">${l.duration_ms != null ? `${L('بعد', 'after')} ${esc(fmtHours(l.duration_ms))} ${esc(L((STATUS_META[l.from_status] || {}).ar || '', (STATUS_META[l.from_status] || {}).en || ''))}` : ''}${l.changed_by === 'admin' ? ` · ${L('بواسطة الإدارة', 'by management')}` : ''}</div></div>`;
        }).join('')}</div>` : empty('fa-clock-rotate-left', L('لسه مفيش نشاط النهارده', 'No activity yet today'))}</div>`;
    });
  }
  unsubs.push(() => logsUnsub && logsUnsub());

  function tick() {
    const p = u();
    const bank = p.dayKey === today() ? liveBank(p) : { Online: 0, Break: 0, Meeting: 0 };
    const main = root.querySelector('#t-main'); if (main) main.textContent = fmtDur(bank.Online);
    root.querySelectorAll('[data-timer]').forEach(el => { el.textContent = fmtDur(bank[el.dataset.timer]); });
    const bw = root.querySelector('#break-warn');
    if (bw) bw.classList.toggle('hidden', !(bank.Break > (policy.breakMaxMinutes || 0) * 60000 && policy.breakMaxMinutes));
    const ow = root.querySelector('#offline-warn'); if (ow) ow.classList.toggle('hidden', navigator.onLine);
    watchLogs();
  }

  function renderAll() { renderHero(); renderPad(); renderStats(); renderUpcoming(); tick(); }

  schedule = await getSchedule(session.email, today().slice(0, 7));
  renderQuick();
  renderAll();
  unsubs.push(watch(query(col('schedules'), where('email', '==', session.email)), rows => { schedule = rows.find(r => r.month === today().slice(0, 7)) || null; renderAll(); }));
  unsubs.push(watchBalance(session.email, Number(today().slice(0, 4)), b => { balance = b; renderStats(); }));
  unsubs.push(watchMyRequests(rows => { myReqs = rows; renderStats(); renderUpcoming(); }));
  const onProf = () => renderAll();
  window.addEventListener('am:profile', onProf); unsubs.push(() => window.removeEventListener('am:profile', onProf));
  const onNet = () => tick();
  window.addEventListener('online', onNet); window.addEventListener('offline', onNet);
  unsubs.push(() => { window.removeEventListener('online', onNet); window.removeEventListener('offline', onNet); });
  const iv = setInterval(tick, 1000); unsubs.push(() => clearInterval(iv));
  return () => unsubs.forEach(f => { try { f(); } catch {} });
}
