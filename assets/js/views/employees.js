// HR: employee directory, create/edit accounts, team assignment, salary data, balances, employee file.
import { L, esc, num, money, normEmail, debounce, fmtDate, imageToDataUrl, ymd } from '../core/utils.js';
import { toast, toastErr, modal, avatar, presenceBadge, empty, busy, bindActions, confirmDialog, loader } from '../core/ui.js';
import { session, now, isAdmin } from '../core/session.js';
import { ROLE_META, roleLabel, normRole, policy, leaveTypes } from '../core/policy.js';
import { secondaryAuth, createUserWithEmailAndPassword, signOut, db, doc, setDoc, updateDoc, getDoc, writeBatch, serverTimestamp, read, list, query, col, where } from '../core/fb.js';
import { allPeople, onDirectory, departments, person, nameOf } from '../services/directory.js';
import { getBalance, adjustBalance, remaining, emptyBalance, balanceId } from '../services/requests.js';
import { personMonthView } from './attendance.js';
import { publicConfig, toLogin, callService } from '../services/authsvc.js';
import { renameAccount, renameStepText } from '../services/rename.js';
import { forceLogout, LEADER_ROLES } from '../core/session.js';
import { balanceTable } from './profile.js';
import { requestCard, showRequestDetails } from './request-card.js';

const genPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = ''; const a = new Uint32Array(10); crypto.getRandomValues(a);
  a.forEach(x => { s += chars[x % chars.length]; });
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '#' + (a[9] % 90 + 10);
};

export default async function render(root, { params }) {
  if (params && params[0]) return renderFile(root, decodeURIComponent(params[0]));
  let term = '', dept = '', roleF = '', state = 'active';
  root.innerHTML = `
    <div class="page-head"><div><h2>${L('الموظفين', 'Employees')}</h2><p id="count" class="muted"></p></div>
      <button class="btn btn-primary" id="add"><i class="fas fa-user-plus"></i> ${L('إضافة موظف', 'Add employee')}</button></div>
    <div class="filters">
      <div class="search grow" style="max-width:300px"><i class="fas fa-search"></i><input class="input" id="q" placeholder="${L('بحث بالاسم أو الإيميل', 'Search name or email')}"></div>
      <select class="select" id="dept"></select>
      <select class="select" id="role"><option value="">${L('كل الأدوار', 'All roles')}</option>${Object.keys(ROLE_META).map(r => `<option value="${r}">${esc(roleLabel(r))}</option>`).join('')}</select>
      <div class="tabs" id="st"><button class="tab active" data-s="active">${L('نشط', 'Active')}</button><button class="tab" data-s="suspended">${L('موقوف', 'Suspended')}</button><button class="tab" data-s="all">${L('الكل', 'All')}</button></div>
    </div>
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr>
      <th>${L('الموظف', 'Employee')}</th><th>${L('القسم', 'Department')}</th><th>${L('الدور', 'Role')}</th><th>${L('المدير المباشر', 'Manager')}</th><th>${L('الحالة', 'Status')}</th><th></th>
    </tr></thead><tbody id="rows"></tbody></table></div></div>`;
  const drawDepts = () => { root.querySelector('#dept').innerHTML = `<option value="">${L('كل الأقسام', 'All departments')}</option>` + departments().map(d => `<option ${d === dept ? 'selected' : ''}>${esc(d)}</option>`).join(''); };
  function draw() {
    const rows = allPeople().filter(p => {
      if (state === 'active' && p.isSuspended) return false;
      if (state === 'suspended' && !p.isSuspended) return false;
      if (dept && p.department !== dept) return false;
      if (roleF && normRole(p.role) !== roleF) return false;
      if (term && !`${p.name} ${p.email} ${p.title}`.toLowerCase().includes(term)) return false;
      return true;
    });
    root.querySelector('#count').textContent = L(`${rows.length} موظف`, `${rows.length} employees`);
    root.querySelector('#rows').innerHTML = rows.length ? rows.map(p => `<tr>
      <td><a class="person" href="#/employees/${encodeURIComponent(p.email)}" style="color:inherit;text-decoration:none">${avatar(p, 'sm')}<div><b>${esc(p.name || p.email)}</b><span>${esc(p.title || '')}</span></div></a></td>
      <td>${esc(p.department || '—')}</td><td><span class="badge brand">${esc(roleLabel(p.role))}</span></td>
      <td>${esc(p.leaderEmail ? nameOf(p.leaderEmail) : '—')}</td>
      <td>${p.isSuspended ? `<span class="badge bad">${L('موقوف', 'Suspended')}</span>` : presenceBadge(p.dayKey && p.status)}</td>
      <td style="text-align:end"><button class="btn btn-sm" data-action="edit" data-email="${esc(p.email)}"><i class="fas fa-pen"></i> ${L('تعديل', 'Edit')}</button></td></tr>`).join('')
      : `<tr><td colspan="6">${empty('fa-users', L('مفيش نتائج', 'No results'))}</td></tr>`;
  }
  drawDepts(); draw();
  root.querySelector('#q').oninput = debounce(e => { term = e.target.value.trim().toLowerCase(); draw(); }, 150);
  root.querySelector('#dept').onchange = e => { dept = e.target.value; draw(); };
  root.querySelector('#role').onchange = e => { roleF = e.target.value; draw(); };
  root.querySelectorAll('#st .tab').forEach(b => b.onclick = () => { state = b.dataset.s; root.querySelectorAll('#st .tab').forEach(x => x.classList.toggle('active', x === b)); draw(); });
  root.querySelector('#add').onclick = () => openEditor(null);
  bindActions(root, { edit: ({ email }) => openEditor(email) });
  const off = onDirectory(() => { drawDepts(); draw(); });
  return off;
}

/** Create / edit employee dialog */
export async function openEditor(email) {
  const isNew = !email;
  const u = isNew ? {} : (person(email) || await read('users', email) || {});
  const priv = isNew ? {} : (await read('employees_private', email).catch(() => null) || {});
  const sal = priv.salary || {};
  const people = allPeople().filter(p => !p.isSuspended && p.email !== email);
  const deptList = departments();
  const pcfg = await publicConfig().catch(() => ({}));
  const domain = String(pcfg.loginDomain || '').replace(/^@/, '');
  const year = new Date(now()).getFullYear();
  const bal = isNew ? emptyBalance('', year) : await getBalance(email, year).catch(() => emptyBalance(email, year));
  const selfLocked = !isNew && email === session.email && !isAdmin(); // own salary/balance/access are edited by someone else
  const canReset = !isNew && email !== session.email && (normRole(u.role) !== 'admin' || isAdmin());
  const m = modal({
    title: isNew ? L('موظف جديد', 'New employee') : L('تعديل بيانات الموظف', 'Edit employee'), icon: isNew ? 'fa-user-plus' : 'fa-user-pen', size: 'wide',
    body: `<div class="tabs mb-16" id="et">
        <button class="tab active" data-p="basic">${L('البيانات الأساسية', 'Basic info')}</button>
        <button class="tab" data-p="job">${L('الوظيفة والفريق', 'Job & team')}</button>
        <button class="tab" data-p="leave">${L('الإجازات والأونلاين', 'Leave & remote')}</button>
        <button class="tab" data-p="pay">${L('الراتب والبنك', 'Salary & bank')}</button>
        <button class="tab" data-p="access">${L('الصلاحيات', 'Access')}</button></div>
      <form id="ef" autocomplete="off">
        <div data-pane="basic" class="form-grid">
          <div class="field span-2 row gap-16"><label style="cursor:pointer">${avatar(u, 'lg')}<input type="file" accept="image/*" hidden id="ph"></label><div class="xs muted">${L('اضغط على الصورة لتغييرها', 'Click the photo to change it')}</div></div>
          <div class="field"><label>${L('الاسم بالكامل', 'Full name')} *</label><input class="input" name="name" required value="${esc(u.name || '')}"></div>
          <div class="field"><label>${L('اسم المستخدم (للدخول)', 'Username (sign-in)')} *</label>
            ${isNew ? `<input class="input" name="email" dir="ltr" required autocapitalize="none" spellcheck="false" placeholder="${domain ? 'ahmed' : 'ahmed@company.com'}"><div class="xs muted mt-4" id="uhint">${domain ? L(`هيدخل بـ «الاسم» أو «الاسم@${domain}»`, `Signs in with "name" or "name@${domain}"`) : ''}</div>`
                    : `<input class="input" dir="ltr" value="${esc(email)}" disabled><div class="xs muted mt-4"><i class="fas fa-lock"></i> ${L('ثابت ومش بيتغير', 'Fixed — never changes')}</div>`}</div>
          <div class="field"><label>${L('إيميل الاستعادة (Outlook)', 'Recovery email (Outlook)')}</label><input class="input" name="contactEmail" type="email" dir="ltr" value="${esc(priv.contactEmail || '')}" placeholder="name@outlook.com" ${selfLocked ? 'disabled' : ''}>
            <div class="xs muted mt-4">${selfLocked ? L('غيّره من «حسابي».', 'Change it from "My profile".') : L('عليه بيوصل لينك «نسيت كلمة المرور» وكلمات المرور المؤقتة.', '"Forgot password" links and temporary passwords go here.')}</div></div>
          <div class="field"><label>${L('الموبايل', 'Mobile')}</label><input class="input" name="phone" dir="ltr" value="${esc(priv.phone || '')}"></div>
          <div class="field"><label>${L('النوع', 'Gender')}</label><select class="select" name="gender"><option value="male" ${u.gender !== 'female' ? 'selected' : ''}>${L('ذكر', 'Male')}</option><option value="female" ${u.gender === 'female' ? 'selected' : ''}>${L('أنثى', 'Female')}</option></select></div>
          <div class="field"><label>${L('تاريخ التعيين', 'Hire date')}</label><input class="input" type="date" name="hireDate" value="${esc(u.hireDate || '')}"></div>
          <div class="field"><label>${L('نوع التعاقد', 'Contract')}</label><select class="select" name="contract">${[['fulltime', L('دوام كامل', 'Full-time')], ['parttime', L('دوام جزئي', 'Part-time')], ['freelancer', L('فريلانسر', 'Freelancer')], ['intern', L('متدرب', 'Intern')]].map(([v, t]) => `<option value="${v}" ${(priv.contract || 'fulltime') === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
        </div>
        <div data-pane="job" class="form-grid hidden">
          <div class="field"><label>${L('المسمى الوظيفي', 'Job title')}</label><input class="input" name="title" value="${esc(u.title || '')}"></div>
          <div class="field"><label>${L('القسم', 'Department')}</label><input class="input" name="department" list="dl-dept" value="${esc(u.department || '')}"><datalist id="dl-dept">${deptList.map(d => `<option value="${esc(d)}">`).join('')}</datalist></div>
          <div class="field"><label>${L('الدور في النظام', 'System role')}</label><select class="select" name="role" ${!isNew && email === session.email && !isAdmin() ? 'disabled' : ''}>${Object.keys(ROLE_META).filter(r => isAdmin() || r === normRole(u.role) || !['admin', 'finance', 'pm'].includes(r)).map(r => `<option value="${r}" ${normRole(u.role) === r ? 'selected' : ''}>${esc(roleLabel(r))}</option>`).join('')}</select></div>
          <div class="field"><label>${L('المدير المباشر', 'Direct manager')}</label><select class="select" name="leaderEmail"><option value="">${L('بدون (يروح لـ HR)', 'None (goes to HR)')}</option>${people.map(p => `<option value="${esc(p.email)}" ${u.leaderEmail === p.email ? 'selected' : ''}>${esc(p.name || p.email)} — ${esc(roleLabel(p.role))}</option>`).join('')}</select></div>
          <div class="row between span-2"><div><b>${L('يسجّل حضور وانصراف', 'Tracks attendance')}</b><div class="xs muted">${L('اقفلها للإدارة العليا أو اللي مش مطلوب منهم تسجيل — مش هيتحسب عليهم غياب ولا هيظهروا في تقارير الحضور.', 'Turn off for executives or anyone not required to clock in — no absence, not in attendance reports.')}</div></div><label class="switch"><input type="checkbox" name="trackAttendance" ${u.trackAttendance !== false ? 'checked' : ''}><span></span></label></div>
          <div class="field"><label>${L('ميعاد الحضور', 'Starts work at')}</label><input class="input" type="time" name="workStart" value="${esc(u.workStart || '')}">
            <div class="xs muted mt-4">${L(`فاضي = ميعاد الشركة (${policy.workStart})`, `Empty = company hours (${policy.workStart})`)}</div></div>
          <div class="field"><label>${L('ميعاد الانصراف', 'Ends work at')}</label><input class="input" type="time" name="workEnd" value="${esc(u.workEnd || '')}">
            <div class="xs muted mt-4">${L(`فاضي = ميعاد الشركة (${policy.workEnd})`, `Empty = company hours (${policy.workEnd})`)}</div></div>
          <div class="field span-2" id="team-box"></div>
        </div>
        <div data-pane="leave" class="col gap-16 hidden">
          <div class="form-grid">
            <div class="field"><label>${L('أيام الأونلاين في الشهر', 'Remote days per month')}</label><input class="input num" type="number" min="0" max="31" name="remoteQuota" value="${esc(u.remoteQuota ?? policy.defaultRemoteQuota)}">
              <div class="xs muted mt-4">${L('عدد الأيام اللي يقدر يطلب فيها شغل أونلاين كل شهر. 0 = مفيش أونلاين.', 'How many days a month they may request remote work. 0 = no remote.')}</div></div>
          </div>
          <div>
            <div class="row between mb-8"><b>${L(`رصيد الإجازات ${year}`, `Leave balance ${year}`)}</b><span class="xs muted">${L('«المستخدم» بيتحسب من الطلبات المعتمدة', '"Used" comes from approved requests')}</span></div>
            <div class="table-wrap" style="border:1px solid var(--border);border-radius:12px"><table class="table bal-edit"><thead><tr>
              <th>${L('النوع', 'Type')}</th><th>${L('المستحق في السنة', 'Entitled / year')}</th><th class="num">${L('المستخدم', 'Used')}</th><th>${L('المتبقي دلوقتي', 'Remaining now')}</th></tr></thead>
              <tbody>${leaveTypes.map(t => { const b = bal.types[t.id] || { entitled: 0, used: 0, adjust: 0 }; return t.unlimited
                ? `<tr><td><b>${esc(L(t.ar, t.en))}</b></td><td colspan="3" class="muted small">${L('غير محدود', 'Unlimited')} · ${L('مستخدم', 'used')} <span class="num">${num(b.used || 0)}</span></td></tr>`
                : `<tr data-lt="${esc(t.id)}"><td><b>${esc(L(t.ar, t.en))}</b></td>
                    <td><input class="input num" type="number" step="0.5" min="0" data-ent value="${esc(b.entitled ?? 0)}" ${selfLocked ? 'disabled' : ''}></td>
                    <td class="num">${num(b.used || 0)}</td>
                    <td><input class="input num" type="number" step="0.5" data-rem value="${esc(remaining(b))}" ${selfLocked ? 'disabled' : ''}></td></tr>`; }).join('')}</tbody></table></div>
            ${selfLocked ? `<p class="xs muted mt-8"><i class="fas fa-lock"></i> ${L('رصيدك بيعدّله HR تاني أو الأدمن.', 'Your own balance is edited by another HR member or an admin.')}</p>`
              : `<div class="field mt-8"><label>${L('سبب تعديل الرصيد (بيتسجل في السجل)', 'Reason for the balance change (logged)')}</label><input class="input" name="balNote" placeholder="${L('مثلاً: رصيد افتتاحي', 'e.g. opening balance')}"></div>`}
          </div>
        </div>
        <div data-pane="pay" class="form-grid hidden">
          <div class="field"><label>${L('الراتب الأساسي (شهري)', 'Basic salary (monthly)')}</label><input class="input num" type="number" min="0" name="basic" value="${esc(sal.basic ?? '')}"></div>
          <div class="field"><label>${L('خصومات ثابتة (تأمينات...)', 'Fixed deductions (insurance…)')}</label><input class="input num" type="number" min="0" name="fixedDeductions" value="${esc(sal.fixedDeductions ?? '')}"></div>
          <div class="field span-2"><label>${L('البدلات الثابتة', 'Fixed allowances')}</label><div id="allow" class="col gap-8"></div><button type="button" class="btn btn-sm btn-soft" id="add-allow" style="align-self:flex-start"><i class="fas fa-plus"></i> ${L('إضافة بدل', 'Add allowance')}</button></div>
          <div class="field"><label>${L('رقم الحساب البنكي', 'Bank account')}</label><input class="input" name="bank" dir="ltr" value="${esc(priv.bank || '')}"></div>
          <div class="field"><label>InstaPay</label><input class="input" name="instapay" dir="ltr" value="${esc(priv.instapay || '')}"></div>
          <div class="span-2 alert info" id="paysum"></div>
          <p class="span-2 xs muted"><i class="fas fa-lock"></i> ${L('بيانات الراتب والبنك محفوظة في مكان منفصل ومحدش يشوفها غير الموظف نفسه وHR والمالية.', 'Salary and bank data are stored separately — visible only to the employee, HR and finance.')}</p>
        </div>
        <div data-pane="access" class="col gap-16 hidden">
          ${!isNew && isAdmin() ? `<div class="pw-box"><div class="row gap-12"><span class="icon-tile"><i class="fas fa-user-pen"></i></span><div class="grow"><b>${L('تغيير اسم المستخدم', 'Change username')}</b>
              <div class="xs muted">${L('بينقل كل بياناته (حضور، طلبات، أرصدة، رواتب) لاسم الدخول الجديد. كلمة المرور زي ما هي.', 'Moves all their data (attendance, requests, balances, payroll) to the new sign-in name. The password stays the same.')}</div></div></div>
              <div class="row gap-8 mt-12"><input class="input grow" id="rn-to" dir="ltr" autocapitalize="none" spellcheck="false" placeholder="name@outlook.com"><button type="button" class="btn btn-soft" id="rn"><i class="fas fa-right-left"></i> ${L('تغيير', 'Change')}</button></div>
              <div class="xs muted mt-8" id="rn-out"></div></div>` : ''}
          ${canReset ? `<div class="pw-box"><div class="row gap-12"><span class="icon-tile"><i class="fas fa-key"></i></span><div class="grow"><b>${L('كلمة المرور', 'Password')}</b>
              <div class="xs muted">${L('بيعمل كلمة مرور مؤقتة، والموظف لازم يختار كلمة جديدة أول ما يدخل. بيخرج من كل الأجهزة.', 'Creates a temporary password; they must choose a new one at sign-in. Signs them out everywhere.')}</div></div></div>
              <div class="row-wrap gap-12 mt-12"><button type="button" class="btn btn-soft" id="rp"><i class="fas fa-key"></i> ${L('ريسيت الباسورد', 'Reset password')}</button>
              <label class="check"><input type="checkbox" id="rp-mail" ${priv.contactEmail ? 'checked' : ''}> ${L('وابعته على إيميل الاستعادة كمان', 'Also email it to the recovery email')}</label></div></div><div class="divider"></div>` : ''}
          <div class="row between"><div><b>${L('صلاحية الـ CRM', 'CRM access')}</b><div class="xs muted">${L('فتح تطبيق المبيعات', 'Open the sales app')}</div></div><label class="switch"><input type="checkbox" name="crm" ${u.permissions && u.permissions.crm ? 'checked' : ''}><span></span></label></div>
          <div class="field"><label>${L('دوره في الـ CRM', 'CRM role')}</label><select class="select" name="crmRole">${['agent', 'supervisor', 'admin'].map(r => `<option value="${r}" ${((u.permissions && u.permissions.crmRole) || 'agent') === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
          <div class="row between"><div><b>${L('صلاحية الرواتب والخزينة', 'Payroll & treasury access')}</b><div class="xs muted">${L('لموظفي المالية', 'For finance staff')}</div></div><label class="switch"><input type="checkbox" name="payroll" ${u.permissions && u.permissions.payroll ? 'checked' : ''} ${isAdmin() ? '' : 'disabled'}><span></span></label></div>
          ${isAdmin() ? '' : `<p class="xs muted"><i class="fas fa-lock"></i> ${L('صلاحية الرواتب ودور «المالية» و«مدير المشروعات» بيمنحهم الأدمن بس.', 'Payroll access and the Finance and Project manager roles can only be granted by an admin.')}</p>`}
          ${isNew ? '' : `<div class="divider"></div>
          <div class="row between"><div><b style="color:var(--bad)">${L('إيقاف الحساب', 'Suspend account')}</b><div class="xs muted">${L('يمنع الدخول فوراً ويحتفظ بكل السجلات', 'Blocks sign-in immediately; keeps all records')}</div></div><label class="switch"><input type="checkbox" name="isSuspended" ${u.isSuspended ? 'checked' : ''}><span></span></label></div>`}
        </div>
        <div id="ee" class="alert bad hidden mt-16"></div>
      </form>`,
    foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="save"><i class="fas fa-floppy-disk"></i> ${isNew ? L('إنشاء الحساب', 'Create account') : L('حفظ', 'Save')}</button>`
  });
  const f = m.$('#ef');
  let photo = u.photo || '';
  m.$('#ph').onchange = async (e) => { try { photo = await imageToDataUrl(e.target.files[0], 240, 0.8); m.$('[data-pane=basic] .avatar').outerHTML = avatar({ ...u, photo }, 'lg'); } catch { toast(L('الصورة مش صالحة', 'Invalid image'), '', 'bad'); } };
  m.$$('#et .tab').forEach(b => b.onclick = () => { m.$$('#et .tab').forEach(x => x.classList.toggle('active', x === b)); m.$$('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.p)); });
  const allowBox = m.$('#allow');
  const addAllow = (a = {}) => {
    const row = document.createElement('div'); row.className = 'row gap-8';
    row.innerHTML = `<input class="input" data-an placeholder="${L('اسم البدل', 'Name')}" value="${esc(a.name || '')}"><input class="input num" data-aa type="number" min="0" placeholder="${L('المبلغ', 'Amount')}" value="${esc(a.amount ?? '')}" style="max-width:140px"><button type="button" class="btn btn-ghost btn-icon btn-sm"><i class="fas fa-trash"></i></button>`;
    row.querySelector('button').onclick = () => row.remove();
    allowBox.appendChild(row);
  };
  (sal.allowances || []).forEach(addAllow);
  m.$('#add-allow').onclick = () => { addAllow(); paySum(); };
  // what payroll will use, live
  const paySum = () => {
    const basic = Number(f.basic.value || 0), fixed = Number(f.fixedDeductions.value || 0);
    const al = [...allowBox.children].reduce((t, r) => t + Number(r.querySelector('[data-aa]').value || 0), 0);
    m.$('#paysum').innerHTML = `<i class="fas fa-calculator"></i><div>${L('في الرواتب:', 'In payroll:')} <b class="num">${esc(money(basic, false))}</b> ${L('أساسي', 'basic')} + <b class="num">${esc(money(al, false))}</b> ${L('بدلات', 'allowances')} = <b class="num">${esc(money(basic + al, false))}</b> ${L('إجمالي', 'gross')}${fixed ? ` − <b class="num">${esc(money(fixed, false))}</b> ${L('ثابتة', 'fixed')}` : ''}
      <div class="xs muted mt-4">${L('لو مسودة رواتب الشهر محسوبة قبل كده، اضغط «إعادة الحساب» في صفحة الرواتب بعد الحفظ.', 'If this month’s payroll draft was already calculated, press "Recalculate" on the Payroll page after saving.')}</div></div>`;
  };
  m.$('[data-pane=pay]').addEventListener('input', paySum);
  m.$('[data-pane=pay]').addEventListener('click', (e) => { if (e.target.closest('.btn-ghost')) setTimeout(paySum, 0); });
  paySum();
  const teamBox = m.$('#team-box');
  const drawTeam = () => {
    if (!LEADER_ROLES.includes(f.role.value) || isNew) { teamBox.innerHTML = ''; return; }
    const cands = allPeople().filter(p => !p.isSuspended && p.email !== email);
    const dept = f.department.value.trim();
    teamBox.innerHTML = `<div class="row between"><label>${L('أعضاء الفريق', 'Team members')}</label>
        ${dept ? `<button type="button" class="btn btn-sm btn-soft" id="team-dept"><i class="fas fa-users"></i> ${L(`كل قسم «${esc(dept)}»`, `All of "${esc(dept)}"`)}</button>` : ''}</div>
      <div class="grid g-2" style="gap:6px;max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:10px">${cands.map(p => `<label class="check"><input type="checkbox" data-member="${esc(p.email)}" data-dept="${esc(p.department || '')}" ${p.leaderEmail === email ? 'checked' : ''}> ${esc(p.name || p.email)}${p.department ? ` <span class="xs muted">· ${esc(p.department)}</span>` : ''}</label>`).join('')}</div>`;
    const td = teamBox.querySelector('#team-dept');
    if (td) td.onclick = () => teamBox.querySelectorAll('[data-member]').forEach(cb => { if (cb.dataset.dept === dept) cb.checked = true; });
  };
  f.role.onchange = drawTeam; f.department.onchange = drawTeam; drawTeam();
  // live balance: changing the entitlement moves "remaining" by the same amount
  m.$$('tr[data-lt] [data-ent]').forEach(inp => {
    let prev = Number(inp.value || 0);
    inp.oninput = () => { const rem = inp.closest('tr').querySelector('[data-rem]'); const v = Number(inp.value || 0); rem.value = Math.round((Number(rem.value || 0) + v - prev) * 2) / 2; prev = v; };
  });
  const uh = m.$('#uhint');
  if (uh && domain) f.email.oninput = () => { const v = toLogin(f.email.value, domain); uh.innerHTML = v ? `${L('اسم الدخول:', 'Sign-in name:')} <b dir="ltr">${esc(v)}</b>` : ''; };
  const rn = m.$('#rn');
  if (rn) rn.onclick = async () => {
    const to = toLogin(m.$('#rn-to').value, domain);
    const out = m.$('#rn-out');
    if (!to) { m.$('#rn-to').focus(); return; }
    const self = email === session.email;
    const ok = await confirmDialog({
      title: L('تغيير اسم المستخدم', 'Change username'), okText: L('تغيير', 'Change'),
      message: L(`من:  ${email}\nإلى:  ${to}\n\nكل بيانات الموظف هتتنقل للاسم الجديد، وكلمة المرور مش هتتغير.${self ? '\nده حسابك إنت، فهتخرج بعد التغيير وتدخل بالاسم الجديد.' : '\nلو هو داخل دلوقتي هيخرج ويدخل بالاسم الجديد.'}`,
        `From:  ${email}\nTo:  ${to}\n\nAll of this employee's data moves to the new name; the password does not change.${self ? '\nThis is your own account: you will be signed out and sign in with the new name.' : '\nIf they are signed in, they will be signed out and use the new name.'}`)
    });
    if (!ok) return;
    if (self) { window.__amRenaming = true; try { sessionStorage.setItem('am_prefill', to); } catch {} }
    await busy(rn, async () => {
      try {
        await renameAccount(email, to, (step, done, total) => { out.textContent = renameStepText(step) + (total ? ` ${done}/${total}` : ''); }, session.email);
        if (self) { await forceLogout('renamed'); return; }
        m.close(); toast(L('تم تغيير اسم المستخدم', 'Username changed'), to);
      } catch (ex) {
        window.__amRenaming = false;
        out.textContent = '';
        if (ex && ex.code === 'email-taken') toast(L('الاسم ده مستخدم', 'Name in use'), L('الإيميل ده عليه حساب دخول تاني بالفعل.', 'Another login already uses this email.'), 'bad');
        else toastErr(ex);
      }
    });
  };
  const rp = m.$('#rp');
  if (rp) rp.onclick = async () => {
    const notify = !!(m.$('#rp-mail') && m.$('#rp-mail').checked);
    const ok = await confirmDialog({ title: L('ريسيت الباسورد', 'Reset password'), message: L(`هيتعمل لـ ${u.name || email} كلمة مرور مؤقتة، وهيخرج من كل الأجهزة. تكمّل؟`, `${u.name || email} will get a temporary password and be signed out everywhere. Continue?`), okText: L('ريسيت', 'Reset') });
    if (!ok) return;
    await busy(rp, async () => {
      try {
        const r = await callService('reset', { target: email, notify });
        await setDoc(doc(col('audit_log')), { action: 'user.password_reset', target: email, by: session.email, at: serverTimestamp(), emailed: !!r.emailed });
        const pm = modal({
          title: L('كلمة المرور المؤقتة', 'Temporary password'), icon: 'fa-key', size: 'narrow',
          body: `<dl class="kv"><dt>${L('اسم المستخدم', 'Username')}</dt><dd dir="ltr" class="num">${esc(email)}</dd><dt>${L('كلمة المرور المؤقتة', 'Temporary password')}</dt><dd dir="ltr" class="num" style="font-size:18px;font-weight:800">${esc(r.password)}</dd></dl>
            ${r.emailed ? `<div class="alert ok mt-16"><i class="fas fa-envelope-circle-check"></i><div>${L('اتبعتت كمان على', 'Also emailed to')} <b dir="ltr">${esc(r.emailed)}</b></div></div>` : (notify ? `<div class="alert warn mt-16">${L('ما اتبعتتش بالإيميل لأن الموظف ملوش إيميل استعادة.', 'Not emailed — the employee has no recovery email.')}</div>` : '')}
            <p class="xs muted mt-16">${L('أول ما يدخل بيها هيظهرله شباك يختار فيه كلمة مرور جديدة. كلمة المرور دي مش متخزنة ومش هتظهر تاني.', 'On sign-in they will be asked to choose a new password. This password is not stored and will not be shown again.')}</p>`,
          foot: `<button class="btn" id="cp2"><i class="fas fa-copy"></i> ${L('نسخ', 'Copy')}</button><button class="btn btn-primary" data-close>${L('تمام', 'Done')}</button>`
        });
        pm.$('#cp2').onclick = async () => { try { await navigator.clipboard.writeText(`${email}\n${r.password}\n${location.origin + location.pathname.replace(/app\.html.*$/, '')}`); toast(L('اتنسخ', 'Copied')); } catch {} };
      } catch (ex) { toastErr(ex); }
    });
  };

  m.$('#save').onclick = (e) => busy(e.currentTarget, async () => {
    const err = m.$('#ee'); err.classList.add('hidden');
    const val = (n) => (f[n] ? f[n].value.trim() : '');
    const newEmail = isNew ? toLogin(val('email'), domain) : email;
    const fail = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
    if (!val('name') || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail)) return fail(domain ? L('الاسم واسم المستخدم مطلوبين.', 'Name and username are required.') : L('الاسم مطلوب، واسم المستخدم لازم يكون بالشكل name@company.com (أو حدد دومين الدخول من الإعدادات ← النظام).', 'Name is required and the username must look like name@company.com (or set a login domain in Settings → System).'));
    const contactEmail = val('contactEmail');
    if (contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) return fail(L('إيميل الاستعادة مش صحيح.', 'The recovery email is not valid.'));
    // balance edits
    const balEdits = [];
    m.$$('tr[data-lt]').forEach(tr => {
      const id = tr.dataset.lt; const t = bal.types[id] || { entitled: 0, used: 0, adjust: 0 };
      const ent = Number(tr.querySelector('[data-ent]').value || 0), rem = Number(tr.querySelector('[data-rem]').value || 0);
      const delta = Math.round((rem - (ent + (Number(t.adjust) || 0) - (Number(t.used) || 0))) * 2) / 2;
      if (ent !== Number(t.entitled || 0) || delta !== 0) balEdits.push({ id, ent, delta });
    });
    if (!selfLocked && !isNew && balEdits.length && !val('balNote')) { m.$$('#et .tab').find(x => x.dataset.p === 'leave').click(); f.balNote.focus(); return fail(L('اكتب سبب تعديل الرصيد.', 'Enter a reason for the balance change.')); }
    if (val('leaderEmail') === newEmail) { err.textContent = L('الموظف مينفعش يكون مدير نفسه.', 'An employee cannot manage themselves.'); err.classList.remove('hidden'); return; }
    if (!!val('workStart') !== !!val('workEnd')) { m.$$('#et .tab').find(x => x.dataset.p === 'job').click(); return fail(L('حدد ميعاد الحضور والانصراف الاتنين، أو سيبهم فاضيين لمواعيد الشركة.', 'Set both start and end times, or leave both empty for company hours.')); }
    if (val('workStart') && val('workEnd') <= val('workStart')) { m.$$('#et .tab').find(x => x.dataset.p === 'job').click(); return fail(L('ميعاد الانصراف لازم يكون بعد ميعاد الحضور في نفس اليوم.', 'The end time must be after the start time on the same day.')); }
    const pub = {
      name: val('name'), title: val('title'), department: val('department'), role: f.role.value, leaderEmail: val('leaderEmail'),
      gender: f.gender.value, hireDate: val('hireDate'), remoteQuota: Number(val('remoteQuota') || 0), photo, trackAttendance: f.trackAttendance.checked,
      workStart: val('workStart'), workEnd: val('workEnd'),
      permissions: { crm: f.crm.checked, crmRole: f.crmRole.value, payroll: isAdmin() ? f.payroll.checked : !!(u.permissions && u.permissions.payroll) }, updatedAt: serverTimestamp()
    };
    // a non-admin cannot change their own role, access or suspension (the rules reject it)
    if (!isNew && email === session.email && !isAdmin()) { delete pub.role; delete pub.permissions; delete pub.isSuspended; }
    if (!isNew && !(email === session.email && !isAdmin())) pub.isSuspended = !!(f.isSuspended && f.isSuspended.checked);
    const allowances = [...allowBox.children].map(r => ({ name: r.querySelector('[data-an]').value.trim(), amount: Number(r.querySelector('[data-aa]').value || 0) })).filter(a => a.name || a.amount);
    const privData = {
      email: newEmail, phone: val('phone'), bank: val('bank'), instapay: val('instapay'), contract: f.contract.value, contactEmail,
      salary: { basic: Number(val('basic') || 0), fixedDeductions: Number(val('fixedDeductions') || 0), allowances }, updatedAt: serverTimestamp()
    };
    try {
      if (isNew) {
        const exists = await read('users', newEmail).catch(() => null);
        if (exists) throw Object.assign(new Error('exists'), { userMessage: L('فيه موظف بالإيميل ده بالفعل.', 'An employee with this email already exists.') });
        let pw = genPassword();
        const sa = secondaryAuth();
        try { await createUserWithEmailAndPassword(sa, newEmail, pw); }
        catch (ex) {
          // the login already exists (old system, or a deleted profile): link a new profile to it
          if (String(ex.code).includes('email-already-in-use')) pw = '';
          else throw ex;
        } finally { try { await signOut(sa); } catch {} }
        const b = writeBatch(db);
        b.set(doc(db, 'users', newEmail), { ...pub, isSuspended: false, status: 'Offline', timeBank: { Online: 0, Break: 0, Meeting: 0 }, dayKey: '', checkedOut: true, mustChangePassword: !!pw, createdAt: serverTimestamp(), createdBy: session.email });
        b.set(doc(db, 'employees_private', newEmail), privData);
        const nb = emptyBalance(newEmail, year);
        balEdits.forEach(({ id, ent, delta }) => { nb.types[id] = { ...(nb.types[id] || { used: 0, adjust: 0 }), entitled: ent, adjust: delta }; });
        b.set(doc(db, 'balances', balanceId(newEmail, year)), { ...nb, updatedAt: serverTimestamp() });
        b.set(doc(col('audit_log')), { action: 'user.create', target: newEmail, by: session.email, at: serverTimestamp() });
        await b.commit();
        m.close();
        if (!pw) {
          modal({
            title: L('تم ربط الحساب', 'Account linked'), icon: 'fa-link', size: 'narrow',
            body: `<p>${L('الإيميل ده كان له حساب دخول قبل كده، فاتربط بيه الملف الجديد. الموظف يدخل بكلمة المرور القديمة، ولو نسيها يستخدم «نسيت كلمة المرور؟» في صفحة الدخول.', 'This email already had a login, so the new profile was linked to it. The employee signs in with their existing password, or uses "Forgot password?" on the sign-in page.')}</p>`,
            foot: `<button class="btn btn-primary" data-close>${L('تمام', 'Done')}</button>`
          });
          return;
        }
        const cm = modal({
          title: L('تم إنشاء الحساب', 'Account created'), icon: 'fa-circle-check', size: 'narrow',
          body: `<p class="mb-16">${L('ابعت البيانات دي للموظف. هيُطلب منه يغيّر كلمة المرور أول ما يدخل.', 'Send these to the employee. They must change the password at first sign-in.')}</p>
            <dl class="kv"><dt>${L('اسم المستخدم', 'Username')}</dt><dd dir="ltr" class="num">${esc(newEmail)}</dd><dt>${L('كلمة المرور المؤقتة', 'Temporary password')}</dt><dd dir="ltr" class="num" style="font-size:16px">${esc(pw)}</dd><dt>${L('الرابط', 'Link')}</dt><dd dir="ltr" class="xs">${esc(location.origin + location.pathname.replace(/app\.html.*$/, ''))}</dd></dl>
            <p class="xs muted mt-16"><i class="fas fa-eye-slash"></i> ${L('كلمة المرور دي مش متخزنة في أي مكان ومش هتظهر تاني.', 'This password is not stored anywhere and will not be shown again.')}</p>`,
          foot: `${contactEmail && pcfg.authServiceUrl ? `<button class="btn" id="mailc"><i class="fas fa-envelope"></i> ${L('ابعتها على إيميله', 'Email them')}</button>` : ''}<button class="btn" id="cp"><i class="fas fa-copy"></i> ${L('نسخ', 'Copy')}</button><button class="btn btn-primary" data-close>${L('تمام', 'Done')}</button>`
        });
        const mb = cm.$('#mailc');
        if (mb) mb.onclick = (ev) => busy(ev.currentTarget, async () => { try { const r = await callService('welcome', { target: newEmail, password: pw }); toast(L('اتبعتت', 'Sent'), r.emailed); mb.disabled = true; } catch (ex) { toastErr(ex); } });
        cm.$('#cp').onclick = async () => { try { await navigator.clipboard.writeText(`${newEmail}\n${pw}\n${location.origin + location.pathname.replace(/app\.html.*$/, '')}`); toast(L('اتنسخ', 'Copied')); } catch {} };
      } else {
        const b = writeBatch(db);
        b.update(doc(db, 'users', email), pub);
        // own salary/bank data is changed by another HR member or an admin, never by yourself
        if (email !== session.email || isAdmin()) b.set(doc(db, 'employees_private', email), privData, { merge: true });
        if (LEADER_ROLES.includes(f.role.value)) {
          m.$$('[data-member]').forEach(cb => {
            const pe = person(cb.dataset.member); if (!pe) return;
            if (cb.checked && pe.leaderEmail !== email) b.update(doc(db, 'users', pe.email), { leaderEmail: email });
            if (!cb.checked && pe.leaderEmail === email) b.update(doc(db, 'users', pe.email), { leaderEmail: '' });
          });
        }
        b.set(doc(col('audit_log')), { action: 'user.update', target: email, by: session.email, at: serverTimestamp(), suspended: !!pub.isSuspended });
        await b.commit();
        if (!selfLocked) for (const x of balEdits) await adjustBalance(email, year, x.id, { entitled: x.ent, adjustDelta: x.delta, note: val('balNote') });
        m.close();
        toast(L('تم حفظ التعديلات', 'Changes saved'));
      }
    } catch (ex) {
      if (ex.userMessage) { err.textContent = ex.userMessage; err.classList.remove('hidden'); } else toastErr(ex);
    }
  });
}

/** Employee file: attendance month, balances, requests, salary summary */
async function renderFile(root, email) {
  const u = person(email) || await read('users', email);
  if (!u) { root.innerHTML = `<div class="card">${empty('fa-user-slash', L('الموظف مش موجود', 'Employee not found'))}</div>`; return; }
  const year = new Date(now()).getFullYear();
  root.innerHTML = `
    <a href="#/employees" class="btn btn-ghost btn-sm mb-16"><i class="fas fa-arrow-right" data-flip></i> ${L('كل الموظفين', 'All employees')}</a>
    <section class="hero mb-16"><div class="row gap-16" style="flex-wrap:wrap">
      ${avatar({ ...u, email }, 'lg')}
      <div class="grow"><h2 style="font-size:22px">${esc(u.name || email)}</h2><div class="muted">${esc(u.title || '')}${u.department ? ' · ' + esc(u.department) : ''}</div>
        <div class="row-wrap mt-8"><span class="badge brand">${esc(roleLabel(u.role))}</span>${u.isSuspended ? `<span class="badge bad">${L('موقوف', 'Suspended')}</span>` : presenceBadge(u.status)}
        ${u.leaderEmail ? `<span class="badge">${L('المدير:', 'Manager:')} ${esc(nameOf(u.leaderEmail))}</span>` : ''}${u.hireDate ? `<span class="badge">${L('تعيين', 'Hired')} ${esc(fmtDate(u.hireDate))}</span>` : ''}</div></div>
      <div class="row gap-8">${isAdmin() ? `<a class="btn btn-on-navy" href="#/activity/${encodeURIComponent(email)}"><i class="fas fa-list-check"></i> ${L('نشاطه', 'Activity')}</a>` : ''}<button class="btn btn-on-navy" id="edit"><i class="fas fa-pen"></i> ${L('تعديل', 'Edit')}</button></div></div></section>
    <div class="tabs mb-16" id="ft"><button class="tab active" data-p="att">${L('الحضور', 'Attendance')}</button><button class="tab" data-p="bal">${L('الأرصدة', 'Balances')}</button><button class="tab" data-p="req">${L('الطلبات', 'Requests')}</button><button class="tab" data-p="pay">${L('الراتب', 'Salary')}</button></div>
    <div data-pane="att"></div><div data-pane="bal" class="hidden"></div><div data-pane="req" class="hidden"></div><div data-pane="pay" class="hidden"></div>`;
  root.querySelector('#edit').onclick = () => openEditor(email);
  const loaded = {};
  const panes = {
    att: (el) => personMonthView(el, email, {}),
    bal: async (el) => {
      el.innerHTML = loader();
      const draw = async () => {
        const bal = await getBalance(email, year);
        el.innerHTML = `<div class="card"><div class="card-head"><h3>${L(`أرصدة ${year}`, `Balances ${year}`)}</h3><button class="btn btn-sm btn-soft" id="adj"><i class="fas fa-sliders"></i> ${L('تعديل رصيد', 'Adjust balance')}</button></div>${balanceTable(bal)}</div>`;
        el.querySelector('#adj').onclick = () => {
          const m = modal({
            title: L('تعديل رصيد', 'Adjust balance'), icon: 'fa-scale-balanced', size: 'narrow',
            body: `<form class="col gap-16" id="af">
              <div class="field"><label>${L('نوع الإجازة', 'Leave type')}</label><select class="select" name="t">${leaveTypes.map(t => `<option value="${esc(t.id)}">${esc(L(t.ar, t.en))}</option>`).join('')}</select></div>
              <div class="field"><label>${L('المستحق السنوي (اختياري)', 'Annual entitlement (optional)')}</label><input class="input num" type="number" step="0.5" name="ent" placeholder="${L('سيبه فاضي لو مش هتغيره', 'Leave empty to keep')}"></div>
              <div class="field"><label>${L('إضافة / خصم أيام (+ أو -)', 'Add / deduct days (+ or -)')}</label><input class="input num" type="number" step="0.5" name="d" value="0"></div>
              <div class="field"><label>${L('السبب', 'Reason')} *</label><input class="input" name="n" required></div></form>`,
            foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="as">${L('حفظ', 'Save')}</button>`
          });
          m.$('#as').onclick = (e) => busy(e.currentTarget, async () => {
            const f = m.$('#af');
            if (!f.n.value.trim()) { f.n.focus(); return; }
            try { await adjustBalance(email, year, f.t.value, { entitled: f.ent.value === '' ? undefined : Number(f.ent.value), adjustDelta: Number(f.d.value || 0), note: f.n.value.trim() }); m.close(); toast(L('تم تعديل الرصيد', 'Balance updated')); draw(); } catch (ex) { toastErr(ex); }
          });
        };
      };
      await draw();
    },
    req: async (el) => {
      el.innerHTML = loader();
      const rows = (await list(query(col('requests'), where('email', '==', email)))).sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));
      el.innerHTML = rows.length ? `<div class="grid g-auto">${rows.map(r => requestCard(r)).join('')}</div>` : `<div class="card">${empty('fa-paper-plane', L('مفيش طلبات', 'No requests'))}</div>`;
      el.onclick = (e) => { const b = e.target.closest('[data-action="details"]'); if (b) { const r = rows.find(x => x.id === b.dataset.id); if (r) showRequestDetails(r); } };
    },
    pay: async (el) => {
      el.innerHTML = loader();
      const p = await read('employees_private', email).catch(() => null) || {};
      const s = p.salary || {};
      const allow = (s.allowances || []).reduce((a, x) => a + (Number(x.amount) || 0), 0);
      el.innerHTML = `<div class="card card-pad"><dl class="kv">
        <dt>${L('الأساسي', 'Basic')}</dt><dd class="num">${esc(money(s.basic || 0))}</dd>
        <dt>${L('البدلات', 'Allowances')}</dt><dd class="num">${esc(money(allow))}${(s.allowances || []).length ? ` <span class="xs muted">(${esc(s.allowances.map(a => a.name).join('، '))})</span>` : ''}</dd>
        <dt>${L('خصومات ثابتة', 'Fixed deductions')}</dt><dd class="num">${esc(money(s.fixedDeductions || 0))}</dd>
        <dt>${L('الإجمالي قبل الخصومات', 'Gross')}</dt><dd class="num"><b>${esc(money((s.basic || 0) + allow))}</b></dd>
        <dt>${L('نوع التعاقد', 'Contract')}</dt><dd>${esc(p.contract || '—')}</dd>
        <dt>${L('البنك', 'Bank')}</dt><dd dir="ltr" style="text-align:start">${esc(p.bank || '—')}</dd>
        <dt>InstaPay</dt><dd dir="ltr" style="text-align:start">${esc(p.instapay || '—')}</dd>
        <dt>${L('الموبايل', 'Mobile')}</dt><dd dir="ltr" style="text-align:start">${esc(p.phone || '—')}</dd></dl></div>`;
    }
  };
  const show = async (k) => {
    root.querySelectorAll('#ft .tab').forEach(x => x.classList.toggle('active', x.dataset.p === k));
    root.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== k));
    if (!loaded[k]) { loaded[k] = true; try { await panes[k](root.querySelector(`[data-pane="${k}"]`)); } catch (e) { toastErr(e); } }
  };
  root.querySelectorAll('#ft .tab').forEach(b => b.onclick = () => show(b.dataset.p));
  await show('att');
}
