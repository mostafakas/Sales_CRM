// New-request dialog shared by "My day" and "My requests".
import { L, esc, ymd, addDays, imageToDataUrl, addMonths, money, fmtMonth } from '../core/utils.js';
import { modal, toast, toastErr, busy } from '../core/ui.js';
import { REQUEST_TYPES, leaveTypes, policy, typeLabel, hoursFor, activeRequestTypes } from '../core/policy.js';
import { session, now } from '../core/session.js';
import { submitRequest, getBalance, remaining, countWorkingDays, advancePlan } from '../services/requests.js';
import { play } from '../core/sounds.js';

export function openRequestForm(type = 'leave', preset = {}) {
  const today = ymd(now());
  const typeOpts = activeRequestTypes().map(k => `<option value="${k}" ${k === type ? 'selected' : ''}>${esc(typeLabel(k))}</option>`).join('');
  const m = modal({
    title: L('طلب جديد', 'New request'), icon: 'fa-paper-plane', size: '',
    body: `<form id="rq" class="col gap-16" novalidate>
      <div class="field"><label>${L('نوع الطلب', 'Request type')}</label><select class="select" name="type">${typeOpts}</select></div>
      <div id="rq-fields" class="col gap-16"></div>
      <div class="field"><label>${L('السبب / التفاصيل', 'Reason / details')}</label><textarea class="textarea" name="reason" maxlength="2000" placeholder="${L('اكتب التفاصيل اللي تساعد مديرك يوافق بسرعة', 'Add details that help your manager decide')}"></textarea></div>
      <div id="rq-info" class="alert info hidden"></div>
      <div id="rq-err" class="alert bad hidden" role="alert"></div>
    </form>`,
    foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="rq-send"><i class="fas fa-paper-plane"></i> ${L('إرسال الطلب', 'Submit request')}</button>`
  });
  const form = m.$('#rq');
  const fields = m.$('#rq-fields');
  const info = m.$('#rq-info');
  let attachment = null;

  const dateRangeFields = (s, e) => `<div class="form-grid">
      <div class="field"><label>${L('من', 'From')}</label><input class="input" type="date" name="startDate" value="${s}" required></div>
      <div class="field"><label>${L('إلى', 'To')}</label><input class="input" type="date" name="endDate" value="${e}" required></div></div>`;

  async function refreshInfo() {
    const t = form.type.value;
    info.classList.add('hidden');
    try {
      if (t === 'leave' && form.startDate && form.startDate.value && form.endDate.value) {
        const lt = form.leaveType.value;
        const [days, bal] = await Promise.all([
          countWorkingDays(session.email, form.startDate.value, form.endDate.value),
          getBalance(session.email, Number(form.startDate.value.slice(0, 4)))
        ]);
        const left = remaining(bal.types[lt] || { entitled: 0 });
        const def = leaveTypes.find(x => x.id === lt) || {};
        info.innerHTML = `<i class="fas fa-circle-info"></i><span>${L('أيام العمل في الفترة:', 'Working days in range:')} <b class="num">${days}</b>${def.unlimited || def.paid === false ? '' : ` · ${L('رصيدك المتاح:', 'Available balance:')} <b class="num">${left}</b>`}</span>`;
        info.className = `alert ${(!def.unlimited && def.paid !== false && days > left) ? 'bad' : 'info'}`;
      } else if ((t === 'remote' || t === 'mission') && form.startDate && form.startDate.value && form.endDate.value) {
        const days = await countWorkingDays(session.email, form.startDate.value, form.endDate.value);
        const quota = Number((session.profile || {}).remoteQuota ?? policy.defaultRemoteQuota);
        info.innerHTML = `<i class="fas fa-circle-info"></i><span>${L('أيام العمل:', 'Working days:')} <b class="num">${days}</b>${t === 'remote' ? ` · ${L('حصتك الشهرية:', 'Monthly quota:')} <b class="num">${quota}</b>` : ''}</span>`;
        info.className = 'alert info';
      } else if (t === 'excuse') {
        info.innerHTML = `<i class="fas fa-circle-info"></i><span>${L('الحد الشهري للأذونات:', 'Monthly permission limit:')} <b class="num">${policy.excuseHoursPerMonth}</b> ${L('ساعات', 'hours')}</span>`;
        info.className = 'alert info';
      } else if (t === 'advance' && Number(form.amount.value) > 0 && form.startMonth.value) {
        // the plan, live: monthly installment and the last month it is deducted
        const p = advancePlan(Number(form.amount.value), Math.min(24, Number(form.installments.value) || 1), form.startMonth.value);
        info.innerHTML = `<i class="fas fa-calendar-check"></i><span>${L('القسط الشهري:', 'Monthly installment:')} <b class="num">${esc(money(p.perMonth))}</b> · ${L('من', 'from')} <b>${esc(fmtMonth(p.startMonth))}</b> ${L('لحد', 'to')} <b>${esc(fmtMonth(p.endMonth))}</b></span>`;
        info.className = 'alert info';
      }
    } catch (e) { console.warn(e); }
  }

  function renderFields() {
    const t = form.type.value;
    attachment = null;
    let h = '';
    if (t === 'leave') {
      const lts = leaveTypes.filter(x => x.active !== false);
      h += `<div class="field"><label>${L('نوع الإجازة', 'Leave type')}</label><select class="select" name="leaveType">${lts.map(x => `<option value="${esc(x.id)}" ${preset.leaveType === x.id ? 'selected' : ''}>${esc(L(x.ar, x.en))}</option>`).join('')}</select></div>`;
      h += dateRangeFields(preset.startDate || addDays(today, 1), preset.endDate || addDays(today, 1));
      h += `<div class="field"><label>${L('مرفق (اختياري، إجباري للمرضي)', 'Attachment (optional; required for sick leave)')}</label>
        <label class="dropzone"><input type="file" accept="image/*" hidden name="file"><i class="fas fa-paperclip"></i> <span id="rq-file">${L('اختار صورة', 'Choose an image')}</span></label></div>`;
    } else if (t === 'remote') {
      h += dateRangeFields(preset.startDate || today, preset.endDate || preset.startDate || today);
    } else if (t === 'mission') {
      h += dateRangeFields(preset.startDate || today, preset.endDate || today);
    } else if (t === 'excuse') {
      h += `<div class="form-grid">
        <div class="field"><label>${L('النوع', 'Kind')}</label><select class="select" name="excuseKind"><option value="late">${L('إذن تأخير', 'Late arrival')}</option><option value="early">${L('انصراف مبكر', 'Early leave')}</option><option value="middle">${L('خروج أثناء اليوم', 'Mid-day exit')}</option></select></div>
        <div class="field"><label>${L('اليوم', 'Day')}</label><input class="input" type="date" name="date" value="${preset.date || today}"></div>
        <div class="field"><label>${L('من الساعة', 'From')}</label><input class="input" type="time" name="fromTime" value="${hoursFor(session.email).start}"></div>
        <div class="field"><label>${L('إلى الساعة', 'To')}</label><input class="input" type="time" name="toTime" value=""></div></div>`;
    } else if (t === 'correction') {
      h += `<div class="form-grid">
        <div class="field span-2"><label>${L('اليوم', 'Day')}</label><input class="input" type="date" name="date" value="${preset.date || addDays(today, -1)}" max="${today}"></div>
        <div class="field"><label>${L('وقت الحضور الصحيح', 'Correct check-in')}</label><input class="input" type="time" name="checkIn" value="${preset.checkIn || ''}"></div>
        <div class="field"><label>${L('وقت الانصراف الصحيح', 'Correct check-out')}</label><input class="input" type="time" name="checkOut" value="${preset.checkOut || ''}"></div>
        <div class="field span-2"><label>${L('مكان العمل', 'Work location')}</label><select class="select" name="mode"><option value="">${L('بدون تغيير', 'No change')}</option><option value="office">${L('المكتب', 'Office')}</option><option value="remote">${L('أونلاين', 'Remote')}</option></select></div></div>`;
    } else if (t === 'advance') {
      h += `<div class="form-grid">
        <div class="field"><label>${L('المبلغ (ج.م)', 'Amount (EGP)')}</label><input class="input num" type="number" min="1" step="1" name="amount"></div>
        <div class="field"><label>${L('عدد الأقساط الشهرية', 'Monthly installments')}</label><input class="input num" type="number" min="1" max="24" name="installments" value="1"></div>
        <div class="field span-2"><label>${L('أول شهر خصم من المرتب', 'First month deducted from salary')}</label><input class="input" type="month" name="startMonth" min="${today.slice(0, 7)}" value="${addMonths(today.slice(0, 7), 1)}"></div></div>
        <p class="xs muted">${L('الطلب بيروح للأدمن، وبعد الموافقة القسط بيتخصم من مرتبك كل شهر لوحده وبيظهر في قسيمة الراتب.', 'The request goes to the admin; once approved, the installment is deducted from your salary every month and shown on your payslip.')}</p>`;
    } else if (t === 'letter') {
      h += `<div class="form-grid">
        <div class="field"><label>${L('نوع الخطاب', 'Letter type')}</label><select class="select" name="letterKind"><option value="employment">${L('إثبات عمل', 'Employment letter')}</option><option value="salary">${L('شهادة مرتب', 'Salary certificate')}</option><option value="experience">${L('شهادة خبرة', 'Experience letter')}</option><option value="other">${L('أخرى', 'Other')}</option></select></div>
        <div class="field"><label>${L('موجّه إلى', 'Addressed to')}</label><input class="input" name="addressedTo" placeholder="${L('مثلاً: السفارة / البنك', 'e.g. Embassy / Bank')}"></div></div>`;
    }
    fields.innerHTML = h;
    const file = fields.querySelector('input[type=file]');
    if (file) file.onchange = async () => {
      try {
        attachment = { data: await imageToDataUrl(file.files[0], 1400, 0.72), name: file.files[0].name };
        if (attachment.data.length > 900000) { attachment = null; throw new Error('big'); }
        fields.querySelector('#rq-file').textContent = file.files[0].name;
      } catch { toast(L('الملف لازم يكون صورة وحجمها معقول', 'Attachment must be a reasonably sized image'), '', 'bad'); }
    };
    fields.querySelectorAll('input,select').forEach(el => { el.addEventListener('change', refreshInfo); if (t === 'advance') el.addEventListener('input', refreshInfo); }); // typing only recalculates the advance plan (no reads)
    refreshInfo();
  }
  form.type.onchange = renderFields;
  renderFields();

  m.$('#rq-send').onclick = (e) => busy(e.currentTarget, async () => {
    const err = m.$('#rq-err'); err.classList.add('hidden');
    const data = {};
    [...form.elements].forEach(el => { if (el.name && el.type !== 'file') data[el.name] = el.value; });
    if (attachment) { data.attachmentData = attachment.data; data.attachmentName = attachment.name; }
    try {
      await submitRequest(data);
      play('submit');
      m.close();
      toast(L('تم إرسال الطلب', 'Request submitted'), L('هيوصلك إشعار أول ما يتاخد قرار.', "You'll be notified when it's decided."));
    } catch (ex) {
      if (ex.userMessage) { err.textContent = ex.userMessage; err.classList.remove('hidden'); }
      else toastErr(ex);
    }
  });
  return m;
}
