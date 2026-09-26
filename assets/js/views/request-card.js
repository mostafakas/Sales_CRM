// Request card + details dialog, shared by "My requests", "Approvals" and HR screens.
import { L, esc, fmtDate, fmtTime, num, money, fmtMin, relTime } from '../core/utils.js';
import { modal, avatar, empty } from '../core/ui.js';
import { REQUEST_TYPES, REQUEST_STATUS, typeLabel, statusLabel, leaveTypeLabel, modeLabel } from '../core/policy.js';
import { toMs } from '../core/fb.js';
import { person, nameOf } from '../services/directory.js';
import { getAttachment } from '../services/requests.js';

const STAGE_NAME = { leader: { ar: 'المدير المباشر', en: 'Manager' }, hr: { ar: 'HR', en: 'HR' }, finance: { ar: 'المالية', en: 'Finance' } };
const ACTION_TXT = {
  submitted: ['قدّم الطلب', 'submitted'], cancelled: ['ألغى الطلب', 'cancelled'], revoked: ['ألغى الاعتماد', 'revoked approval'],
  approved_leader: ['وافق (المدير)', 'approved (manager)'], approved_hr: ['وافق (HR)', 'approved (HR)'], approved_finance: ['وافق (المالية)', 'approved (finance)'],
  rejected_leader: ['رفض (المدير)', 'rejected (manager)'], rejected_hr: ['رفض (HR)', 'rejected (HR)'], rejected_finance: ['رفض (المالية)', 'rejected (finance)']
};

export function requestTitle(r) {
  if (r.type === 'leave') return leaveTypeLabel(r.leaveType);
  if (r.type === 'excuse') return r.excuseKind === 'early' ? L('إذن انصراف مبكر', 'Early leave permission') : (r.excuseKind === 'middle' ? L('إذن خروج', 'Mid-day permission') : L('إذن تأخير', 'Late permission'));
  if (r.type === 'letter') return ({ employment: L('خطاب إثبات عمل', 'Employment letter'), salary: L('شهادة مرتب', 'Salary certificate'), experience: L('شهادة خبرة', 'Experience letter') })[r.letterKind] || typeLabel('letter');
  return typeLabel(r.type);
}
export function requestWhen(r) {
  if (r.type === 'excuse') return `${fmtDate(r.startDate)} · ${r.fromTime}–${r.toTime} (${fmtMin(r.minutes)})`;
  if (r.type === 'advance') return `${money(r.amount)} · ${num(r.installments)} ${L('قسط', 'installments')}`;
  if (r.type === 'correction') return `${fmtDate(r.startDate)}${r.correction ? ` · ${r.correction.checkIn || '—'} → ${r.correction.checkOut || '—'}` : ''}`;
  if (r.type === 'letter') return r.addressedTo ? `${L('إلى:', 'To:')} ${r.addressedTo}` : fmtDate(r.startDate);
  if (!r.startDate) return '';
  return `${fmtDate(r.startDate)}${r.endDate && r.endDate !== r.startDate ? ' → ' + fmtDate(r.endDate) : ''}${r.days ? ` · ${num(r.days)} ${L('يوم عمل', 'working days')}` : ''}`;
}
export function stageTrack(r) {
  const stages = Array.isArray(r.stages) ? r.stages : [];
  if (!stages.length) return '';
  const cur = String(r.status).replace('pending_', '');
  const doneAll = r.status === 'approved';
  const curIdx = stages.indexOf(cur);
  return `<div class="row-wrap gap-4 xs">${stages.map((s, i) => {
    const done = doneAll || (curIdx > i);
    const active = !doneAll && curIdx === i && String(r.status).startsWith('pending');
    const failed = r.status === 'rejected' && (r.history || []).some(h => h.action === `rejected_${s}`);
    const cls = failed ? 'bad' : (done ? 'ok' : (active ? 'warn' : ''));
    const icon = failed ? 'fa-xmark' : (done ? 'fa-check' : (active ? 'fa-hourglass-half' : 'fa-circle'));
    return `<span class="badge ${cls}"><i class="fas ${icon}"></i>${esc(L(STAGE_NAME[s].ar, STAGE_NAME[s].en))}</span>${i < stages.length - 1 ? '<i class="fas fa-angle-left faint" data-flip></i>' : ''}`;
  }).join('')}</div>`;
}
export function requestCard(r, { showPerson = false, actions = '' } = {}) {
  const t = REQUEST_TYPES[r.type] || { icon: 'fa-file', tile: '' };
  const st = REQUEST_STATUS[r.status] || { cls: '' };
  const p = person(r.email) || { name: r.name, email: r.email };
  return `<article class="card req-card" data-id="${esc(r.id)}">
    <div class="row gap-8">
      ${showPerson ? avatar(p, 'sm') : `<span class="icon-tile ${t.tile}"><i class="fas ${t.icon}"></i></span>`}
      <div class="grow">
        <b>${showPerson ? esc(p.name || r.name) : esc(requestTitle(r))}</b>
        <div class="xs muted">${showPerson ? esc(requestTitle(r)) + ' · ' : ''}${esc(relTime(toMs(r.createdAt) || r.createdMs))}</div>
      </div>
      <span class="badge ${st.cls}">${esc(statusLabel(r.status))}</span>
    </div>
    <div class="small"><i class="far fa-calendar faint"></i> ${esc(requestWhen(r))}</div>
    ${r.reason ? `<div class="reason">${esc(r.reason)}</div>` : ''}
    ${r.quotaWarning ? `<div class="alert warn xs"><i class="fas fa-triangle-exclamation"></i>${L(`تخطى حصة الأونلاين الشهرية (${r.quotaUsedBefore || 0}+${r.days} من ${r.quota})`, `Exceeds monthly remote quota (${r.quotaUsedBefore || 0}+${r.days} of ${r.quota})`)}</div>` : ''}
    ${r.response ? `<div class="alert info xs"><i class="fas fa-reply"></i><span>${esc(r.response)}</span></div>` : ''}
    <div class="row between" style="flex-wrap:wrap;gap:8px">
      ${stageTrack(r)}
      <div class="row gap-8">
        <button class="btn btn-ghost btn-sm" data-action="details" data-id="${esc(r.id)}"><i class="fas fa-circle-info"></i> ${L('التفاصيل', 'Details')}</button>
        ${actions}
      </div>
    </div>
  </article>`;
}
export async function showRequestDetails(r) {
  const p = person(r.email) || { name: r.name, email: r.email };
  const hist = (r.history || []).slice().sort((a, b) => (a.at || 0) - (b.at || 0));
  const m = modal({
    title: requestTitle(r), icon: (REQUEST_TYPES[r.type] || {}).icon || 'fa-file', size: '',
    body: `<div class="row gap-8 mb-16">${avatar(p)}<div class="grow"><b>${esc(p.name || r.name)}</b><div class="xs muted">${esc(p.title || '')} · ${esc(r.email)}</div></div><span class="badge ${(REQUEST_STATUS[r.status] || {}).cls || ''}">${esc(statusLabel(r.status))}</span></div>
      <dl class="kv">
        <dt>${L('النوع', 'Type')}</dt><dd>${esc(typeLabel(r.type))}</dd>
        <dt>${L('التفاصيل', 'Details')}</dt><dd>${esc(requestWhen(r))}</dd>
        ${r.correction && r.correction.mode ? `<dt>${L('مكان العمل', 'Location')}</dt><dd>${esc(modeLabel(r.correction.mode))}</dd>` : ''}
        ${r.leaderEmail ? `<dt>${L('المدير المباشر', 'Manager')}</dt><dd>${esc(nameOf(r.leaderEmail))}</dd>` : ''}
        <dt>${L('تاريخ التقديم', 'Submitted')}</dt><dd>${esc(fmtDate(toMs(r.createdAt) || r.createdMs))} ${esc(fmtTime(toMs(r.createdAt) || r.createdMs))}</dd>
      </dl>
      ${r.reason ? `<div class="mt-16"><div class="label mb-8">${L('السبب', 'Reason')}</div><div class="reason">${esc(r.reason)}</div></div>` : ''}
      ${r.response ? `<div class="mt-16"><div class="label mb-8">${L('رد HR', 'HR response')}</div><div class="reason">${esc(r.response)}</div></div>` : ''}
      <div id="att" class="mt-16"></div>
      <div class="mt-16"><div class="label mb-8">${L('مسار الطلب', 'Timeline')}</div>
        <div class="timeline">${hist.map(h => `<div class="tl-item ${String(h.action).startsWith('approved') ? 'ok' : (/rejected|revoked|cancelled/.test(h.action) ? 'bad' : '')}">
          <div class="row between"><b class="small">${esc(h.byName || h.by)} — ${esc(L(...(ACTION_TXT[h.action] || [h.action, h.action])))}</b><span class="xs muted num">${esc(fmtDate(h.at))} ${esc(fmtTime(h.at))}</span></div>
          ${h.note ? `<div class="xs muted">${esc(h.note)}</div>` : ''}</div>`).join('') || empty('fa-clock', L('مفيش سجل', 'No history'))}</div></div>`,
    foot: `<button class="btn" data-close>${L('إغلاق', 'Close')}</button>`
  });
  if (r.attachmentId) {
    m.$('#att').innerHTML = `<div class="label mb-8">${L('المرفق', 'Attachment')}</div><span class="spinner"></span>`;
    try {
      const a = await getAttachment(r.attachmentId);
      m.$('#att').innerHTML = a ? `<div class="label mb-8">${L('المرفق', 'Attachment')}</div><a href="${esc(a.data)}" target="_blank" rel="noopener" download="${esc(a.name || 'attachment.jpg')}"><img src="${esc(a.data)}" alt="" style="max-height:260px;border-radius:12px;border:1px solid var(--border)"></a>` : '';
    } catch { m.$('#att').innerHTML = `<div class="alert warn xs">${L('مش قادر أعرض المرفق', 'Could not load attachment')}</div>`; }
  }
  return m;
}
