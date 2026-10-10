// Settings: work hours, remote & permissions, leave types, holidays, workflows, payroll rules, system tools.
import { L, esc, num, fmtDate, isAr, fmtTime } from '../core/utils.js';
import { publicConfig, savePublicConfig, callService, siteUrl } from '../services/authsvc.js';
import { toast, toastErr, busy, confirmDialog, empty, loader, modal } from '../core/ui.js';
import { isAdmin, session, now } from '../core/session.js';
import { policy, leaveTypes, holidays, savePolicy, saveLeaveTypes, saveHolidays, REQUEST_TYPES, typeLabel, DEFAULT_POLICY, activeRequestTypes } from '../core/policy.js';
import { list, query, col, orderBy, limit, read, toMs, serverTimestamp } from '../core/fb.js';
import { migrate } from '../services/migration.js';
import { allPeople, officialDepartments, addDepartment } from '../services/directory.js';
import { db, doc, writeBatch } from '../core/fb.js';
import { track } from '../services/activity.js';
import { METRICS, TEMPLATES, metricLabel, evalSettings, saveEvalSettings } from '../services/evaluations.js';

const DAYS = () => isAr ? ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FIXED_EG_HOLIDAYS = [
  ['01-07', 'عيد الميلاد المجيد'], ['01-25', 'عيد الشرطة / ثورة 25 يناير'], ['04-25', 'عيد تحرير سيناء'], ['05-01', 'عيد العمال'],
  ['06-30', 'ذكرى 30 يونيو'], ['07-23', 'عيد ثورة 23 يوليو'], ['10-06', 'عيد القوات المسلحة']
];

export default async function render(root, { params = [] } = {}) {
  const tabs = [
    ['work', L('مواعيد العمل', 'Work hours')], ['depts', L('الأقسام', 'Departments')], ['remote', L('الأونلاين والأذونات', 'Remote & permissions')], ['leave', L('أنواع الإجازات', 'Leave types')],
    ['holidays', L('العطلات الرسمية', 'Public holidays')], ['flow', L('مسارات الموافقة', 'Approval flows')], ['pay', L('قواعد الخصم', 'Deduction rules')],
    ...(isAdmin() ? [['eval', L('التقييم', 'Reviews')], ['system', L('النظام والترحيل', 'System & migration')]] : [])
  ];
  root.innerHTML = `<div class="page-head"><div><h2>${L('الإعدادات', 'Settings')}</h2><p>${L('التغييرات بتطبق على كل المستخدمين فوراً.', 'Changes apply to everyone immediately.')}</p></div></div>
    <div class="tabs mb-16" id="st">${tabs.map(([k, t], i) => `<button class="tab ${i ? '' : 'active'}" data-p="${k}">${esc(t)}</button>`).join('')}</div>
    <div id="pane"></div>`;
  const pane = root.querySelector('#pane');
  const saveBar = (id = 'save') => `<div class="card-foot"><button class="btn btn-primary" id="${id}"><i class="fas fa-floppy-disk"></i> ${L('حفظ', 'Save')}</button></div>`;
  const numField = (name, label, val, help = '', attrs = '') => `<div class="field"><label>${esc(label)}</label><input class="input num" type="number" name="${name}" value="${esc(val)}" ${attrs}>${help ? `<span class="help">${esc(help)}</span>` : ''}</div>`;
  const sw = (name, label, checked, help = '') => `<div class="row between span-2"><div><b>${esc(label)}</b>${help ? `<div class="xs muted">${esc(help)}</div>` : ''}</div><label class="switch"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><span></span></label></div>`;

  const P = {
    work() {
      pane.innerHTML = `<div class="card"><form class="card-body form-grid" id="f">
        <div class="field"><label>${L('بداية الدوام', 'Work starts')}</label><input class="input" type="time" name="workStart" value="${esc(policy.workStart)}"></div>
        <div class="field"><label>${L('نهاية الدوام', 'Work ends')}</label><input class="input" type="time" name="workEnd" value="${esc(policy.workEnd)}"></div>
        ${numField('graceMinutes', L('فترة السماح (دقيقة)', 'Grace period (min)'), policy.graceMinutes, L('التأخير أقل من كده مش بيتحسب.', 'Lateness below this is ignored.'), 'min="0" max="120"')}
        ${numField('breakMaxMinutes', L('أقصى استراحة يومية (دقيقة)', 'Max daily break (min)'), policy.breakMaxMinutes, '', 'min="0"')}
        ${numField('dayBoundaryHour', L('بداية اليوم الجديد (ساعة)', 'New day starts at (hour)'), policy.dayBoundaryHour, L('الشغل بعد نص الليل لحد الساعة دي بيتحسب على اليوم اللي قبله.', 'Work after midnight until this hour counts for the previous day.'), 'min="0" max="8"')}
        <div class="field span-2"><label>${L('أيام الإجازة الأسبوعية', 'Weekly days off')}</label><div class="row-wrap">${DAYS().map((d, i) => `<label class="check chip"><input type="checkbox" name="wd" value="${i}" ${(policy.weekend || []).includes(i) ? 'checked' : ''}> ${esc(d)}</label>`).join('')}</div></div>
        <div class="field"><label>${L('بداية حساب الحضور في النظام', 'Attendance tracked from')}</label><input class="input" type="date" name="trackingStart" value="${esc(policy.trackingStart || '')}"><span class="help">${L('الأيام قبل التاريخ ده مش بتتحسب غياب.', 'Days before this date are never counted as absent.')}</span></div>
        ${sw('singleSession', L('جلسة واحدة لكل موظف', 'One session per employee'), policy.singleSession !== false, L('الدخول من جهاز جديد بيقفل الجهاز القديم.', 'Signing in on a new device signs out the old one.'))}
      </form>${saveBar()}</div>`;
      pane.querySelector('#save').onclick = (e) => busy(e.currentTarget, async () => {
        const f = pane.querySelector('#f');
        try {
          await savePolicy({ workStart: f.workStart.value, workEnd: f.workEnd.value, graceMinutes: Number(f.graceMinutes.value) || 0, breakMaxMinutes: Number(f.breakMaxMinutes.value) || 0,
            dayBoundaryHour: Math.max(0, Math.min(8, Number(f.dayBoundaryHour.value) || 0)), weekend: [...f.querySelectorAll('[name=wd]:checked')].map(x => Number(x.value)), singleSession: f.singleSession.checked, ...(f.trackingStart.value ? { trackingStart: f.trackingStart.value } : {}) });
          toast(L('تم الحفظ', 'Saved'));
        } catch (ex) { toastErr(ex); }
      });
    },
    remote() {
      pane.innerHTML = `<div class="card"><form class="card-body form-grid" id="f">
        ${sw('remoteNeedsApproval', L('الأونلاين محتاج موافقة', 'Remote work needs approval'), policy.remoteNeedsApproval, L('لو مقفولة، الموظف يقدر يختار أونلاين في أي يوم ويتخصم من حصته.', 'If off, employees may pick remote any day; it counts against their quota.'))}
        ${numField('defaultRemoteQuota', L('حصة الأونلاين الافتراضية (أيام/شهر)', 'Default remote quota (days/month)'), policy.defaultRemoteQuota, L('تقدر تغيّرها لكل موظف من ملفه.', 'Can be overridden per employee.'), 'min="0" max="31"')}
        ${numField('excuseHoursPerMonth', L('حد الأذونات الشهري (ساعات)', 'Monthly permission limit (hours)'), policy.excuseHoursPerMonth, '', 'min="0" max="40"')}
        <div class="field"><label>${L('إيميل الموارد البشرية', 'HR email')}</label><input class="input" name="hrEmail" type="email" dir="ltr" value="${esc(policy.hrEmail || '')}"></div>
      </form>${saveBar()}</div>`;
      pane.querySelector('#save').onclick = (e) => busy(e.currentTarget, async () => {
        const f = pane.querySelector('#f');
        try { await savePolicy({ remoteNeedsApproval: f.remoteNeedsApproval.checked, defaultRemoteQuota: Number(f.defaultRemoteQuota.value) || 0, excuseHoursPerMonth: Number(f.excuseHoursPerMonth.value) || 0, hrEmail: f.hrEmail.value.trim() }); toast(L('تم الحفظ', 'Saved')); } catch (ex) { toastErr(ex); }
      });
    },
    leave() {
      let rows = leaveTypes.map(t => ({ ...t }));
      const draw = () => {
        pane.innerHTML = `<div class="card"><div class="table-wrap"><table class="table"><thead><tr>
          <th>${L('الاسم عربي', 'Arabic name')}</th><th>${L('الاسم إنجليزي', 'English name')}</th><th class="num">${L('أيام/سنة', 'Days/year')}</th><th>${L('مدفوعة', 'Paid')}</th><th>${L('مرفق إجباري', 'Attachment')}</th><th>${L('بدون حد', 'Unlimited')}</th><th>${L('مفعّلة', 'Active')}</th></tr></thead>
          <tbody>${rows.map((t, i) => `<tr data-i="${i}"><td><input class="input" data-k="ar" value="${esc(t.ar)}"></td><td><input class="input" data-k="en" value="${esc(t.en)}" dir="ltr"></td>
            <td><input class="input num" type="number" min="0" step="0.5" data-k="days" value="${esc(t.days)}" style="width:90px"></td>
            ${['paid', 'attachment', 'unlimited', 'active'].map(k => `<td><label class="switch"><input type="checkbox" data-k="${k}" ${(k === 'active' ? t.active !== false : k === 'paid' ? t.paid !== false : !!t[k]) ? 'checked' : ''}><span></span></label></td>`).join('')}</tr>`).join('')}</tbody></table></div>
          <div class="card-foot" style="justify-content:space-between"><button class="btn btn-soft" id="add"><i class="fas fa-plus"></i> ${L('نوع جديد', 'New type')}</button><button class="btn btn-primary" id="save"><i class="fas fa-floppy-disk"></i> ${L('حفظ', 'Save')}</button></div></div>
          <p class="xs muted mt-8">${L('تغيير عدد الأيام بيأثر على الأرصدة الجديدة بس. لتعديل رصيد موظف موجود استخدم «تعديل رصيد» من ملفه.', 'Changing days affects new balances only. Adjust existing balances from the employee file.')}</p>`;
        const collect = () => { pane.querySelectorAll('tr[data-i]').forEach(tr => { const t = rows[tr.dataset.i]; tr.querySelectorAll('[data-k]').forEach(inp => { const k = inp.dataset.k; t[k] = inp.type === 'checkbox' ? inp.checked : (k === 'days' ? Number(inp.value) || 0 : inp.value.trim()); }); }); };
        pane.querySelector('#add').onclick = () => { collect(); rows.push({ id: 't' + Date.now().toString(36), ar: 'نوع جديد', en: 'New type', days: 0, paid: true, attachment: false, unlimited: false, active: true }); draw(); };
        pane.querySelector('#save').onclick = (e) => busy(e.currentTarget, async () => { collect(); try { await saveLeaveTypes(rows); toast(L('تم الحفظ', 'Saved')); } catch (ex) { toastErr(ex); } });
      };
      draw();
    },
    holidays() {
      let days = { ...holidays };
      const year = new Date(now()).getFullYear();
      const draw = () => {
        const keys = Object.keys(days).sort();
        pane.innerHTML = `<div class="card"><div class="card-head"><h3>${L('العطلات الرسمية', 'Public holidays')}</h3>
            <button class="btn btn-sm btn-soft" id="tpl"><i class="fas fa-flag"></i> ${L(`إضافة العطلات الثابتة لسنة ${year}`, `Add fixed holidays for ${year}`)}</button></div>
          <div class="card-body"><form class="row-wrap" id="add"><input class="input" type="date" name="d" required style="width:180px"><input class="input grow" name="n" placeholder="${L('اسم العطلة', 'Holiday name')}" required style="min-width:200px"><button class="btn btn-primary"><i class="fas fa-plus"></i> ${L('إضافة', 'Add')}</button></form>
          <p class="xs muted mt-8">${L('العطلات الدينية (الأعياد ورأس السنة الهجرية والمولد) بتتغير كل سنة — ضيفها بعد إعلان الحكومة.', 'Religious holidays move each year — add them once announced.')}</p></div>
          ${keys.length ? `<div class="list">${keys.map(k => `<div class="list-item"><span class="icon-tile neutral"><i class="fas fa-flag"></i></span><div class="grow"><b class="small">${esc(days[k])}</b><div class="xs muted">${esc(fmtDate(k))}</div></div><button class="btn btn-ghost btn-sm btn-icon" data-del="${k}" aria-label="delete"><i class="fas fa-trash"></i></button></div>`).join('')}</div>` : empty('fa-flag', L('مفيش عطلات مضافة', 'No holidays yet'))}
          ${saveBar()}</div>`;
        pane.querySelector('#add').onsubmit = (e) => { e.preventDefault(); const f = e.target; days[f.d.value] = f.n.value.trim(); draw(); };
        pane.querySelector('#tpl').onclick = () => { FIXED_EG_HOLIDAYS.forEach(([md, n]) => { days[`${year}-${md}`] = days[`${year}-${md}`] || n; }); draw(); };
        pane.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { delete days[b.dataset.del]; draw(); });
        pane.querySelector('#save').onclick = (e) => busy(e.currentTarget, async () => { try { await saveHolidays(days); toast(L('تم الحفظ', 'Saved')); } catch (ex) { toastErr(ex); } });
      };
      draw();
    },
    flow() {
      const stages = [['leader', L('المدير المباشر', 'Manager')], ['hr', 'HR'], ['finance', L('المالية', 'Finance')]];
      pane.innerHTML = `<div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>${L('نوع الطلب', 'Request type')}</th>${stages.map(s => `<th>${esc(s[1])}</th>`).join('')}</tr></thead><tbody>
        ${activeRequestTypes().filter(t => t !== 'advance').map(t => `<tr data-t="${t}"><td><b>${esc(typeLabel(t))}</b></td>${stages.map(([s]) => { const locked = s === 'hr' && ['leave', 'correction'].includes(t); return `<td><label class="switch" ${locked ? `title="${L('إلزامي: HR بس اللي يقدر يعدّل الأرصدة والحضور', 'Required: only HR can change balances and attendance')}"` : ''}><input type="checkbox" data-s="${s}" ${locked || ((policy.workflow || {})[t] || []).includes(s) ? 'checked' : ''} ${locked ? 'disabled' : ''}><span></span></label></td>`; }).join('')}</tr>`).join('')}
        <tr><td><b>${esc(typeLabel('advance'))}</b></td><td colspan="${stages.length}"><span class="badge brand"><i class="fas fa-lock"></i>${L('الأدمن بس', 'Admin only')}</span></td></tr>
        </tbody></table></div><div class="card-body"><p class="xs muted">${L('الطلب بيعدّي على المراحل بالترتيب ده. لو الموظف ملوش مدير مباشر، مرحلة المدير بتتخطى. لو مفيش ولا مرحلة، الطلب بيروح لـ HR.', 'Requests pass the checked stages in this order. Without a manager, the manager stage is skipped. With no stages, HR decides.')}</p></div>${saveBar()}</div>`;
      pane.querySelector('#save').onclick = (e) => busy(e.currentTarget, async () => {
        const wf = {};
        pane.querySelectorAll('tr[data-t]').forEach(tr => {
          const t = tr.dataset.t;
          const st = stages.map(s => s[0]).filter(s => tr.querySelector(`[data-s="${s}"]`).checked);
          wf[t] = st;
        });
        try { await savePolicy({ workflow: wf }); toast(L('تم الحفظ', 'Saved')); } catch (ex) { toastErr(ex); }
      });
    },
    pay() {
      pane.innerHTML = `<div class="alert info mb-16"><i class="fas fa-circle-info"></i><div>${L('قواعد خصم التأخير والغياب والأونلاين المرفوض والانصراف المبكر بقت لكل موظف لوحده: الموظفين ← تعديل ← «قواعد الخصم». وهيكل الراتب (الأساسي، البدلات، الانتظام، KPI) من «الراتب والبنك».', 'Lateness, absence, rejected-remote and early-leave rules are now set per employee: Employees → Edit → "Deduction rules". The salary structure (basic, allowances, regularity, KPI) is under "Salary & bank".')}</div></div>
        <div class="card"><form class="card-body form-grid" id="f">
          ${numField('payrollDayDivisor', L('قسمة الراتب لحساب قيمة اليوم', 'Divisor for a day\'s value'), policy.payrollDayDivisor, L('قيمة اليوم من أي جزء = الجزء ÷ الرقم ده (عادة 30).', 'A day of any part = the part ÷ this number (usually 30).'), 'min="20" max="31"')}
          ${numField('carryOverMax', L('أقصى ترحيل للاعتيادي (أيام)', 'Max annual carry-over (days)'), policy.carryOverMax || 0, '', 'min="0"')}
        </form>${saveBar()}</div>`;
      pane.querySelector('#save').onclick = (e) => busy(e.currentTarget, async () => {
        const f = pane.querySelector('#f');
        try { await savePolicy({ payrollDayDivisor: Number(f.payrollDayDivisor.value) || 30, carryOverMax: Number(f.carryOverMax.value) || 0 }); toast(L('تم الحفظ', 'Saved')); } catch (ex) { toastErr(ex); }
      });
    },
    async system() {
      pane.innerHTML = loader();
      const mig = await read('settings', 'migration').catch(() => null);
      const audit = await list(query(col('audit_log'), orderBy('at', 'desc'), limit(30))).catch(() => []);
      const pub = await publicConfig(true).catch(() => ({}));
      pane.innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
        <section class="card" style="grid-column:1/-1"><div class="card-head"><h3><i class="fas fa-key" style="color:var(--brand)"></i> ${L('الدخول وكلمات المرور', 'Sign-in & passwords')}</h3><span class="badge ${pub.authServiceUrl ? 'ok' : ''}" id="svc-badge">${pub.authServiceUrl ? L('الخدمة متوصّلة', 'Service linked') : L('الخدمة مش متفعّلة', 'Service not set up')}</span></div>
          <form class="card-body form-grid" id="pubf">
            <div class="field"><label>${L('دومين الدخول', 'Login domain')}</label><input class="input" name="loginDomain" dir="ltr" placeholder="almaster.local" value="${esc(pub.loginDomain || '')}">
              <div class="xs muted mt-4">${L('لو اليوزرات شكلها ahmed@almaster.local اكتب almaster.local، والموظف يقدر يدخل بـ ahmed بس.', 'If usernames look like ahmed@almaster.local, enter almaster.local — employees can then sign in with just "ahmed".')}</div></div>
            <div class="field"><label>${L('رابط خدمة كلمات المرور (Apps Script)', 'Password service URL (Apps Script)')}</label><input class="input" name="authServiceUrl" dir="ltr" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(pub.authServiceUrl || '')}">
              <div class="xs muted mt-4">${L('بيشغّل «ريسيت الباسورد» و«نسيت كلمة المرور» على إيميل Outlook. خطوات التفعيل في tools/password-service/README.md.', 'Powers "Reset password" and "Forgot password" to Outlook. Setup steps: tools/password-service/README.md.')}</div></div>
            <div class="span-2 row gap-8"><button class="btn btn-primary" type="submit"><i class="fas fa-floppy-disk"></i> ${L('حفظ', 'Save')}</button><button class="btn" type="button" id="svc-test"><i class="fas fa-plug-circle-check"></i> ${L('اختبار الاتصال', 'Test connection')}</button><span class="small" id="svc-out"></span></div>
          </form></section>
        <section class="card" style="grid-column:1/-1"><div class="card-head"><h3><i class="fas fa-rotate" style="color:var(--brand)"></i> ${L('تحديث السيستم عند الكل', 'Update everyone')}</h3>
            ${policy.forceReloadAt ? `<span class="xs muted">${L('آخر مرة:', 'Last time:')} ${esc(fmtDate(toMs(policy.forceReloadAt)))} ${esc(fmtTime(toMs(policy.forceReloadAt)))}</span>` : ''}</div>
          <div class="card-body row between" style="flex-wrap:wrap;gap:12px"><p class="small grow">${L('بعد ما ترفع نسخة جديدة على الموقع، اضغط هنا: كل الصفحات المفتوحة عند الموظفين هتتحدّث لوحدها خلال ثواني وتشتغل بآخر نسخة. محدش بيخرج من حسابه ويومه مش بيتأثر.', 'After publishing a new version, press this: every open page reloads within seconds and runs the latest version. Nobody is signed out and running days are not affected.')}</p>
            <button class="btn btn-primary" id="reload-all"><i class="fas fa-rotate"></i> ${L('تحديث عند الكل', 'Update everyone')}</button></div></section>
        <section class="card"><div class="card-head"><h3>${L('ترحيل البيانات من النظام القديم', 'Migrate data from the old system')}</h3>${mig && mig.done ? `<span class="badge ok">${L('اتعمل', 'Done')}</span>` : ''}</div>
          <div class="card-body col gap-16">
            <p class="small">${L('بينقل الموظفين والرواتب (لمكان محمي) والأرصدة والطلبات القديمة والجداول وحركات الخزينة للنظام الجديد. البيانات القديمة مش بتتمسح، والتشغيل أكتر من مرة آمن.', 'Moves employees, salaries (to a protected place), balances, old requests, schedules and treasury movements. Old data is kept; re-running is safe.')}</p>
            ${mig && mig.report ? `<div class="alert info xs">${L('آخر تشغيل:', 'Last run:')} ${esc(fmtDate(toMs(mig.at)))} — ${esc(JSON.stringify({ ...mig.report, notes: undefined }))}</div>` : ''}
            <div class="row gap-8"><button class="btn" id="dry"><i class="fas fa-magnifying-glass"></i> ${L('معاينة', 'Preview')}</button><button class="btn btn-primary" id="run"><i class="fas fa-right-left"></i> ${L('تنفيذ الترحيل', 'Run migration')}</button></div>
            <div id="mig-out"></div></div></section>
        <section class="card"><div class="card-head"><h3>${L('سجل العمليات الإدارية', 'Admin audit log')}</h3></div>
          ${audit.length ? `<div class="list">${audit.map(a => `<div class="list-item"><div class="grow"><b class="small">${esc(a.action)}</b><div class="xs muted">${esc(a.target || '')} · ${esc(a.by || '')}</div></div><span class="xs faint">${esc(fmtDate(toMs(a.at)))}</span></div>`).join('')}</div>` : `<div class="card-body">${empty('fa-list', L('مفيش عمليات', 'No entries'))}</div>`}</section></div>`;
      const pf = pane.querySelector('#pubf');
      pf.onsubmit = (e) => { e.preventDefault(); busy(pf.querySelector('[type=submit]'), async () => {
        const url = pf.authServiceUrl.value.trim(), dom = pf.loginDomain.value.trim().replace(/^@/, '').toLowerCase();
        if (url && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) { toast(L('الرابط لازم يكون رابط Web app من Apps Script وينتهي بـ /exec', 'The URL must be an Apps Script web-app URL ending in /exec'), '', 'bad'); return; }
        try { await savePublicConfig({ loginDomain: dom, authServiceUrl: url, ...(location.protocol === 'https:' ? { siteUrl: siteUrl() } : {}) }); toast(L('تم الحفظ', 'Saved')); P.system(); } catch (ex) { toastErr(ex); }
      }); };
      pane.querySelector('#svc-test').onclick = (e) => busy(e.currentTarget, async () => {
        const o = pane.querySelector('#svc-out');
        try {
          const r = await callService('ping', {}, { signedIn: false });
          o.innerHTML = r.firebase ? `<span class="badge ok">${L('شغالة', 'Working')} · ${L('إيميلات متاحة النهارده', 'emails left today')} ${num(r.mailQuota)}</span>`
            : `<span class="badge bad">${L('الخدمة وصلت بس مفتاح Firebase مش شغال', 'Reached, but the Firebase key is not working')}</span> <span class="xs muted" dir="ltr">${esc(r.detail || (r.configured ? '' : 'SERVICE_ACCOUNT missing'))}</span>`;
        } catch (ex) { o.innerHTML = `<span class="badge bad">${esc(ex.userMessage || ex.message)}</span>`; }
      });
      pane.querySelector('#reload-all').onclick = async (e) => {
        const btn = e.currentTarget;
        const ok = await confirmDialog({ title: L('تحديث السيستم عند الكل', 'Update everyone'), message: L('كل الصفحات المفتوحة (وصفحتك كمان) هتتحدّث خلال ثواني. لو حد كان بيكتب طلب ولسه ما بعتوش هيحتاج يكتبه تاني. تكمّل؟', 'Every open page (yours too) reloads within seconds. A request someone is still typing would need to be re-entered. Continue?'), okText: L('تحديث عند الكل', 'Update everyone') });
        if (!ok) return;
        await busy(btn, async () => { try { await savePolicy({ forceReloadAt: serverTimestamp() }); toast(L('اتبعت التحديث للكل', 'Update sent to everyone')); } catch (ex) { toastErr(ex); } });
      };
      const out = pane.querySelector('#mig-out');
      const showReport = (r, dry) => {
        out.innerHTML = `<div class="alert ${dry ? 'info' : 'ok'}"><div><b>${dry ? L('معاينة — مفيش حاجة اتكتبت', 'Preview — nothing written') : L('تم الترحيل', 'Migration complete')}</b>
          <dl class="kv mt-8">${Object.entries({ [L('موظفين اتعدلوا', 'Users updated')]: r.users, [L('ملفات رواتب', 'Salary files')]: r.private, [L('أرصدة', 'Balances')]: r.balances, [L('طلبات', 'Requests')]: r.requests, [L('جداول', 'Schedules')]: r.schedules, [L('حركات خزينة', 'Treasury entries')]: r.treasury, [L('بنود رواتب قديمة', 'Legacy payroll items')]: r.payrollItems, [L('صور كبيرة اتشالت', 'Large photos removed')]: r.photosShrunk }).map(([k, v]) => `<dt>${esc(k)}</dt><dd class="num">${num(v)}</dd>`).join('')}</dl>
          ${r.notes.length ? `<details class="mt-8"><summary class="xs">${L('ملاحظات', 'Notes')} (${r.notes.length})</summary><div class="xs">${r.notes.slice(0, 50).map(esc).join('<br>')}</div></details>` : ''}</div></div>`;
      };
      pane.querySelector('#dry').onclick = (e) => busy(e.currentTarget, async () => { try { showReport(await migrate({ dry: true }), true); } catch (ex) { toastErr(ex); } });
      pane.querySelector('#run').onclick = async (e) => {
        const ok = await confirmDialog({ title: L('تنفيذ الترحيل', 'Run migration'), message: L('اعمل Export للـ Firestore من Google Cloud Console قبل التنفيذ كنسخة احتياطية. تكمّل؟', 'Export Firestore from Google Cloud Console as a backup first. Continue?'), okText: L('تنفيذ', 'Run') });
        if (!ok) return;
        await busy(e.currentTarget, async () => {
          try { const r = await migrate({ dry: false, progress: (d, t) => { out.innerHTML = `<div class="progress"><span style="width:${Math.round(d / t * 100)}%"></span></div>`; } }); showReport(r, false); toast(L('تم الترحيل', 'Migration complete')); } catch (ex) { toastErr(ex); }
        });
      };
    }
  };
  /** move everyone written under `from` to `to` (rename / tidy) */
  const moveDept = async (from, to) => {
    const ppl = allPeople().filter(p => (p.department || '') === from);
    for (let i = 0; i < ppl.length; i += 400) {
      const b = writeBatch(db);
      ppl.slice(i, i + 400).forEach(p => b.update(doc(db, 'users', p.email), { department: to }));
      await b.commit();
    }
    return ppl.length;
  };
  P.depts = () => {
    const official = officialDepartments();
    const count = (d) => allPeople().filter(p => !p.isSuspended && (p.department || '') === d).length;
    const others = [...new Set(allPeople().map(p => p.department || '').filter(d => d && !official.includes(d)))].sort();
    const noDept = allPeople().filter(p => !p.isSuspended && !p.department).length;
    pane.innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px">
      <section class="card"><div class="card-head"><h3><i class="fas fa-sitemap"></i> ${L('الأقسام', 'Departments')}</h3><button class="btn btn-primary btn-sm" id="d-add"><i class="fas fa-plus"></i> ${L('قسم جديد', 'New department')}</button></div>
        <div class="card-body"><div class="dp-list">${official.map((d, i) => `<div class="dp-row"><b class="grow">${esc(d)}</b><span class="badge">${L(`${count(d)} موظف`, `${count(d)} people`)}</span>
          <button class="btn btn-ghost btn-icon btn-sm" data-ren="${i}" title="${L('تعديل الاسم', 'Rename')}"><i class="fas fa-pen"></i></button>
          <button class="btn btn-ghost btn-icon btn-sm" data-del="${i}" title="${count(d) ? L('فيه موظفين على القسم ده', 'Has employees') : L('حذف', 'Delete')}" ${count(d) ? 'disabled' : ''} style="color:var(--bad)"><i class="fas fa-trash"></i></button></div>`).join('')}</div>
          ${noDept ? `<p class="xs muted mt-8"><i class="fas fa-circle-info"></i> ${L(`${noDept} موظف ملهمش قسم — حدّده من ملف كل واحد.`, `${noDept} people have no department — set it on their file.`)}</p>` : ''}</div></section>
      <section class="card"><div class="card-head"><h3><i class="fas fa-wand-magic-sparkles"></i> ${L('توحيد الأقسام القديمة', 'Tidy old department names')}</h3></div>
        <div class="card-body">${others.length ? `<p class="small muted mb-8">${L('الأسماء دي مكتوبة على ملفات موظفين ومش في القايمة. اختار القسم الصح لكل واحد ودوس «توحيد» — كل الموظفين اللي عليه بيتنقلوا.', 'These names are on employee files but not in the list. Pick the right department for each and press "Tidy" — everyone under it moves.')}</p>
          <div class="dp-list">${others.map((d, i) => `<div class="dp-row"><span class="grow"><b>${esc(d)}</b> <small class="muted">${L(`${allPeople().filter(p => p.department === d).length} موظف`, `${allPeople().filter(p => p.department === d).length} people`)}</small></span>
            <i class="fas fa-arrow-left muted" data-flip></i><select class="select select-sm" data-map="${i}"><option value="">${L('اختار…', 'Pick…')}</option>${official.map(o => `<option ${d.replace(/[^a-z]/gi, '').length >= 3 && o.toLowerCase().replace(/[^a-z]/g, '').slice(0, 3) === d.toLowerCase().replace(/[^a-z]/g, '').slice(0, 3) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`).join('')}</div>
          <div class="row mt-16"><button class="btn btn-primary" id="d-tidy"><i class="fas fa-wand-magic-sparkles"></i> ${L('توحيد', 'Tidy')}</button></div>`
          : empty('fa-circle-check', L('كل الموظفين على أقسام من القايمة 👌', 'Everyone is on a listed department 👌'))}</div></section></div>`;
    pane.querySelector('#d-add').onclick = async () => {
      const name = await confirmDialog({ title: L('قسم جديد', 'New department'), okText: L('إضافة', 'Add'), input: { label: L('اسم القسم', 'Department name'), required: true } });
      if (!name) return;
      try { const n = await addDepartment(name); toast(L(`اتضاف قسم ${n}`, `${n} added`)); P.depts(); } catch (ex) { toastErr(ex); }
    };
    pane.querySelectorAll('[data-ren]').forEach(b => b.onclick = async () => {
      const old = official[Number(b.dataset.ren)];
      const name = await confirmDialog({ title: L(`تعديل اسم ${old}`, `Rename ${old}`), message: L('كل الموظفين اللي على القسم ده هيتنقلوا للاسم الجديد.', 'Everyone in it moves to the new name.'), okText: L('حفظ', 'Save'), input: { label: L('الاسم الجديد', 'New name'), required: true } });
      const n = String(name || '').trim().slice(0, 60);
      if (!n || n === old) return;
      try {
        const list = officialDepartments().map(d => d === old ? n : d).filter((d, i, a) => a.indexOf(d) === i);
        await savePolicy({ departments: list }); policy.departments = list;
        const moved = await moveDept(old, n);
        track('settings.dept', { target: `${old} → ${n}`, detail: `${moved}` });
        toast(L(`اتغيّر الاسم واتنقل ${moved} موظف`, `Renamed; ${moved} people moved`)); P.depts();
      } catch (ex) { toastErr(ex); }
    });
    pane.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const d = official[Number(b.dataset.del)];
      if (!(await confirmDialog({ title: L(`حذف قسم ${d}`, `Delete ${d}`), okText: L('حذف', 'Delete'), okClass: 'btn-danger' }))) return;
      try { const list = officialDepartments().filter(x => x !== d); await savePolicy({ departments: list }); policy.departments = list; P.depts(); } catch (ex) { toastErr(ex); }
    });
    const tidy = pane.querySelector('#d-tidy');
    if (tidy) tidy.onclick = (e) => busy(e.currentTarget, async () => {
      const pairs = others.map((d, i) => [d, pane.querySelector(`[data-map="${i}"]`).value]).filter(([, to]) => to);
      if (!pairs.length) { toast(L('اختار القسم الصح الأول', 'Pick the right department first'), '', 'warn'); return; }
      try {
        let n = 0; for (const [from, to] of pairs) n += await moveDept(from, to);
        track('settings.dept', { target: pairs.map(([a, b]) => `${a} → ${b}`).join('، '), detail: `${n}` });
        toast(L(`اتوحّد ${n} موظف`, `${n} people tidied`)); P.depts();
      } catch (ex) { toastErr(ex); }
    });
  };
  // performance: the criteria of each template (name, weight, what measures it), grade bands and the salary link
  P.eval = () => {
    const e = structuredClone(evalSettings());
    const kinds = { employee: ['employee', 'both'], leader: ['leader', 'both'] };
    const sum = (t) => e.templates[t].reduce((s, c) => s + (Number(c.weight) || 0), 0);
    const sumBadge = (t) => `<span class="badge ${sum(t) === 100 ? 'ok' : 'warn'}" data-sum="${t}">${L('المجموع', 'Total')} ${sum(t)}%</span>`;
    const del = (attr, i) => `<button type="button" class="btn btn-ghost btn-icon btn-sm" ${attr}="${i}" title="${L('حذف', 'Delete')}" style="color:var(--bad)"><i class="fas fa-trash"></i></button>`;
    const tplCard = (t) => `<section class="card ev-span"><div class="card-head"><h3><i class="fas ${t === 'leader' ? 'fa-user-tie' : 'fa-user'}"></i> ${L(`معايير ${TEMPLATES[t][0]}`, `${TEMPLATES[t][1]} criteria`)}</h3>${sumBadge(t)}</div>
      <div class="card-body"><div class="ev-khead xs muted"><span class="grow">${L('المعيار', 'Criterion')}</span><span style="width:260px">${L('بيتقاس بإيه', 'Measured by')}</span><span style="width:80px">${L('الوزن', 'Weight')}</span><span style="width:32px"></span></div>
        ${e.templates[t].map((c, i) => `<div class="ev-wrow"><input class="input grow" data-t="${t}" data-i="${i}" data-f="name" value="${esc(c.name)}">
          <select class="select" data-t="${t}" data-i="${i}" data-f="source" style="width:260px">${Object.entries(METRICS).filter(([, m]) => kinds[t].includes(m.kind)).map(([k]) => `<option value="${k}" ${k === c.source ? 'selected' : ''}>${esc(metricLabel(k))}</option>`).join('')}</select>
          <input class="input num" type="number" min="0" max="100" data-t="${t}" data-i="${i}" data-f="weight" value="${esc(c.weight)}" style="width:80px">${del(`data-del-${t}`, i)}</div>`).join('')}
        <button type="button" class="btn btn-sm mt-8" data-add="${t}"><i class="fas fa-plus"></i> ${L('معيار', 'Criterion')}</button></div></section>`;
    const draw = () => {
      pane.innerHTML = `<div class="ev-set">
        <p class="small muted ev-span"><i class="fas fa-circle-info"></i> ${L('كل معيار بيتحسب من السيستم أوتوماتيك، ما عدا «تقييم المدير» اللي بيدّي فيه الليدر درجة من 5 ولازم يكتب الدليل. لو معيار ملوش داتا في الشهر بيتشال والباقي بيتوزع بنفس النسب. الليدر والسوبر فايزر وأي حد عليه فريق بيتقيّم بمعايير الليدر.', 'Every criterion is measured by the system except "Manager rating" (1–5 stars with written evidence). A criterion with no data is left out and the rest scaled. Anyone leading a team uses the leader criteria.')}</p>
        ${tplCard('employee')}${tplCard('leader')}
        <section class="card ev-span"><div class="card-head"><h3><i class="fas fa-ranking-star"></i> ${L('التقديرات وأثرها', 'Grades and their effect')}</h3><button type="button" class="btn btn-sm" id="g-add"><i class="fas fa-plus"></i> ${L('تقدير', 'Grade')}</button></div>
          <div class="card-body"><div class="ev-khead xs muted"><span style="width:180px">${L('التقدير', 'Grade')}</span><span style="width:80px">${L('من درجة', 'From')}</span><span class="grow">${L('الأثر', 'Effect')}</span><span style="width:110px">${L('% من المتغير', '% of variable')}</span><span style="width:32px"></span></div>
          ${e.grades.map((g, i) => `<div class="ev-wrow"><input class="input" data-g="${i}" data-f="name" value="${esc(g.name)}" style="width:180px"><input class="input num" type="number" min="0" max="100" data-g="${i}" data-f="min" value="${esc(g.min)}" style="width:80px">
            <input class="input grow" data-g="${i}" data-f="effect" value="${esc(g.effect || '')}"><input class="input num" type="number" min="0" max="100" data-g="${i}" data-f="variable" value="${esc(g.variable ?? 100)}" style="width:110px">${del('data-gdel', i)}</div>`).join('')}</div></section>
        <section class="card ev-span"><div class="card-head"><h3><i class="fas fa-money-check-dollar"></i> ${L('الربط بالمرتب', 'Salary link')}</h3></div>
          <div class="card-body">${sw('salaryLink', L('جزء المتغير (KPI) في المرتب يمشي على التقدير', 'Pay the variable (KPI) part by grade'), e.salaryLink, L('لما يكون شغال ويتبعت تقييم الشهر: وانت بتحسب الرواتب، جزء الـ KPI بياخد نسبة التقدير (مثلاً «تقريب من التوقعات» = 50%). لو عدّلت الـ KPI بإيدك في الراتب، تعديلك هو اللي بيمشي.', 'When on and the month\'s review is sent, the KPI part is paid at the grade\'s share. A KPI set by hand on a salary wins.'))}</div></section>
      </div>${saveBar('ev-save')}`;
    };
    const readAll = () => {
      pane.querySelectorAll('[data-t]').forEach(i => { const c = e.templates[i.dataset.t][i.dataset.i]; c[i.dataset.f] = i.dataset.f === 'weight' ? Number(i.value) || 0 : i.value; });
      pane.querySelectorAll('[data-g]').forEach(i => { e.grades[i.dataset.g][i.dataset.f] = ['min', 'variable'].includes(i.dataset.f) ? Number(i.value) || 0 : i.value; });
      const l = pane.querySelector('[name="salaryLink"]'); if (l) e.salaryLink = l.checked;
    };
    pane.oninput = (ev) => { if (ev.target.dataset.f === 'weight') { readAll(); const t = ev.target.dataset.t; pane.querySelector(`[data-sum="${t}"]`).outerHTML = sumBadge(t); } };
    pane.onclick = (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      const redo = (fn) => { readAll(); fn(); draw(); };
      if (b.dataset.add) redo(() => e.templates[b.dataset.add].push({ id: 'c' + Date.now().toString(36), name: '', weight: 0, source: 'manual' }));
      else if (b.dataset.delEmployee != null) redo(() => e.templates.employee.splice(Number(b.dataset.delEmployee), 1));
      else if (b.dataset.delLeader != null) redo(() => e.templates.leader.splice(Number(b.dataset.delLeader), 1));
      else if (b.id === 'g-add') redo(() => e.grades.push({ name: '', min: 0, effect: '', variable: 0 }));
      else if (b.dataset.gdel != null) redo(() => e.grades.splice(Number(b.dataset.gdel), 1));
      else if (b.id === 'ev-save') busy(b, async () => {
        readAll();
        const templates = {};
        for (const t of ['employee', 'leader']) {
          templates[t] = e.templates[t].filter(c => String(c.name).trim()).map(c => ({ id: c.id || 'c' + Math.random().toString(36).slice(2, 8), name: String(c.name).trim().slice(0, 80), weight: Math.max(0, Math.min(100, Number(c.weight) || 0)), source: METRICS[c.source] ? c.source : 'manual' }));
          if (!templates[t].some(c => c.weight > 0)) { toast(L('لازم معيار واحد على الأقل ليه وزن', 'At least one criterion needs a weight'), '', 'warn'); return; }
        }
        const grades = e.grades.filter(g => String(g.name).trim()).map(g => ({ name: String(g.name).trim().slice(0, 40), min: Math.max(0, Math.min(100, Number(g.min) || 0)), effect: String(g.effect || '').trim().slice(0, 120), variable: Math.max(0, Math.min(100, Number(g.variable) || 0)) })).sort((x, y) => y.min - x.min);
        if (!grades.length) { toast(L('لازم تقدير واحد على الأقل', 'Add at least one grade'), '', 'warn'); return; }
        grades[grades.length - 1].min = 0;     // the lowest grade covers everything below
        const next = { templates, grades, salaryLink: !!e.salaryLink };
        try { await saveEvalSettings(next); policy.evaluation = { ...(policy.evaluation || {}), ...next }; Object.assign(e, structuredClone(evalSettings())); toast(L('اتحفظت إعدادات التقييم', 'Review settings saved')); draw(); } catch (ex) { toastErr(ex); }
      });
    };
    draw();
  };
  const show = (k) => {
    root.querySelectorAll('#st .tab').forEach(t => t.classList.toggle('active', t.dataset.p === k));
    pane.oninput = pane.onchange = pane.onclick = null;
    P[k]();
  };
  root.querySelectorAll('#st .tab').forEach(b => b.onclick = () => show(b.dataset.p));
  show(tabs.some(([k]) => k === params[0]) ? params[0] : 'work');
}
