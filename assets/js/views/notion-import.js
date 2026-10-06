// "Import from Notion" (admin / project manager): files → match people → preview → import. Also the
// "people without an account" window that hands their tasks to a new account in one click.
import { L, esc, num, ymd } from '../core/utils.js';
import { toast, toastErr, modal, busy } from '../core/ui.js';
import { now } from '../core/session.js';
import { activePeople, person } from '../services/directory.js';
import { readFiles, peopleIn, plan, runImport } from '../services/notion.js';
import { pendingPeople, guessPerson, linkPending } from '../services/tasks.js';

const peopleOptions = (sel) => `<option value="">${L('— ملوش يوزر لسه (يتحفظ باسمه)', '— No account yet (keep the name)')}</option>` +
  activePeople().slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar')).map(p => `<option value="${esc(p.email)}" ${sel === p.email ? 'selected' : ''}>${esc(p.name || p.email)}${p.department ? ` — ${esc(p.department)}` : ''}</option>`).join('');

export function openNotionImport() {
  let data = null, people = [], mapping = {};
  const m = modal({ title: L('استيراد من Notion', 'Import from Notion'), icon: 'fa-file-import', size: 'wide', body: '<div id="ni"></div>', foot: '<div id="nif" class="row gap-8 grow"></div>' });
  const body = m.$('#ni'), foot = m.$('#nif');

  const stepFiles = () => {
    body.innerHTML = `<div class="ni-steps">${['الملفات', 'الأشخاص', 'المعاينة'].map((s, i) => `<span class="${i === 0 ? 'on' : ''}">${i + 1}. ${s}</span>`).join('')}</div>
      <label class="ni-drop" id="ni-drop"><i class="fas fa-cloud-arrow-up"></i><b>${L('اختار ملفات Notion', 'Choose the Notion files')}</b>
        <span class="muted small">${L('ملفات الـ zip زي ما نزلت من Notion، أو ملفات الـ CSV بتاعة العملاء والمشاريع والتاسكات. السيستم بيدوّر على الجداول التلاتة لوحده.', 'The zip files as downloaded from Notion, or the CSV files of Clients, Projects and Tasks. The three tables are found automatically.')}</span>
        <input type="file" id="ni-files" multiple accept=".zip,.csv" hidden></label>
      <div id="ni-list" class="mt-8"></div>
      <p class="xs muted mt-8"><i class="fas fa-circle-info"></i> ${L('الملفات بتتقري جوه المتصفح بس، ومش بتترفع على أي سيرفر. لو ملف المشاريع كبير قوي (فيه مرفقات)، صدّر جدول المشاريع لوحده من غير «Include subpages».', 'Files are read inside your browser only. If the projects export is very large (attachments), export the Projects table alone without "Include subpages".')}</p>`;
    foot.innerHTML = `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><span class="grow"></span><button class="btn btn-primary" id="ni-read" disabled><i class="fas fa-magnifying-glass"></i> ${L('قراءة الملفات', 'Read the files')}</button>`;
    foot.querySelector('[data-close]').onclick = () => m.close();
    let files = [];
    const fi = body.querySelector('#ni-files');
    fi.onchange = () => { files = [...fi.files]; body.querySelector('#ni-list').innerHTML = files.map(f => `<div class="ni-file"><i class="fas ${/\.zip$/i.test(f.name) ? 'fa-file-zipper' : 'fa-file-csv'}"></i><span class="grow truncate">${esc(f.name)}</span><small class="muted num">${(f.size / 1048576).toFixed(1)} MB</small></div>`).join(''); foot.querySelector('#ni-read').disabled = !files.length; };
    foot.querySelector('#ni-read').onclick = (e) => busy(e.currentTarget, async () => {
      try {
        data = await readFiles(files);
        if (!data.clients.length && !data.projects.length && !data.tasks.length) { toast(L('مالقيتش جداول العملاء أو المشاريع أو التاسكات في الملفات دي', 'No Clients, Projects or Tasks table found in these files'), '', 'bad'); return; }
        people = peopleIn(data); mapping = Object.fromEntries(people.map(p => [p.name, p.email]));
        stepPeople();
      } catch (ex) { toastErr(ex); }
    });
  };

  const stepPeople = () => {
    const matched = people.filter(p => mapping[p.name]).length;
    body.innerHTML = `<div class="ni-steps"><span class="done">1. ${L('الملفات', 'Files')}</span><span class="on">2. ${L('الأشخاص', 'People')}</span><span>3. ${L('المعاينة', 'Preview')}</span></div>
      <div class="ni-found">${[['fa-handshake', L('عملاء', 'Clients'), data.clients.length], ['fa-diagram-project', L('مشاريع', 'Projects'), data.projects.length], ['fa-list-check', L('تاسكات', 'Tasks'), data.tasks.length]].map(([i, t, n]) => `<div><i class="fas ${i}"></i><b class="num">${n}</b><small>${t}</small></div>`).join('')}</div>
      <p class="small mb-8">${L(`السيستم اتعرّف على ${matched} من ${people.length} شخص. راجع الربط، واللي ملوش يوزر سيبه — التاسكات بتاعته هتتحفظ باسمه، ولما تعمله يوزر تربطه بضغطة.`, `${matched} of ${people.length} people were matched. Review the list; anyone without an account keeps their name on the tasks and can be linked later in one click.`)}</p>
      <div class="table-wrap ni-people"><table class="table"><thead><tr><th>${L('الاسم في Notion', 'Name in Notion')}</th><th class="num">${L('تاسكات', 'Tasks')}</th><th class="num">${L('مشاريع', 'Projects')}</th><th>${L('الموظف في السيستم', 'Employee in the system')}</th></tr></thead>
        <tbody>${people.map(p => `<tr class="${mapping[p.name] ? '' : 'pending'}"><td><b>${esc(p.name)}</b></td><td class="num">${p.tasks}</td><td class="num">${p.projects}</td><td><select class="select select-sm" data-map="${esc(p.name)}">${peopleOptions(mapping[p.name])}</select></td></tr>`).join('')}</tbody></table></div>`;
    body.querySelectorAll('[data-map]').forEach(s => s.onchange = () => { mapping[s.dataset.map] = s.value; s.closest('tr').classList.toggle('pending', !s.value); });
    foot.innerHTML = `<button class="btn" id="ni-back"><i class="fas fa-arrow-right" data-flip></i> ${L('رجوع', 'Back')}</button><span class="grow"></span><button class="btn btn-primary" id="ni-next">${L('المعاينة', 'Preview')} <i class="fas fa-arrow-left" data-flip></i></button>`;
    foot.querySelector('#ni-back').onclick = stepFiles;
    foot.querySelector('#ni-next').onclick = stepPreview;
  };

  const stepPreview = () => {
    const pl = plan(data, mapping);
    const today = ymd(now());
    const nt = pl.tasks.filter(t => !t.exists);
    const cnt = (f) => nt.filter(f).length;
    const box = (icon, cls, title, n, sub) => `<div class="ni-box ${cls}"><i class="fas ${icon}"></i><div><b class="num">${num(n)}</b><span>${title}</span>${sub ? `<small>${sub}</small>` : ''}</div></div>`;
    body.innerHTML = `<div class="ni-steps"><span class="done">1. ${L('الملفات', 'Files')}</span><span class="done">2. ${L('الأشخاص', 'People')}</span><span class="on">3. ${L('المعاينة', 'Preview')}</span></div>
      <div class="ni-boxes">
        ${box('fa-handshake', '', L('عميل جديد', 'new clients'), pl.clients.filter(c => !c.exists).length, pl.clients.some(c => c.exists) ? L(`${pl.clients.filter(c => c.exists).length} موجودين قبل كده`, `${pl.clients.filter(c => c.exists).length} already there`) : '')}
        ${box('fa-diagram-project', '', L('مشروع جديد', 'new projects'), pl.projects.filter(p => !p.exists).length, pl.projects.some(p => p.exists) ? L(`${pl.projects.filter(p => p.exists).length} موجودين قبل كده`, `${pl.projects.filter(p => p.exists).length} already there`) : '')}
        ${box('fa-list-check', 'brand', L('تاسك هيتعمل', 'tasks to create'), nt.length, L(`من ${data.tasks.length} تاسك في Notion — نسخة لكل مسؤول`, `from ${data.tasks.length} Notion tasks — one copy per owner`))}
        ${box('fa-circle-check', 'ok', L('منتهي (أرشيف على يوم تسليمه)', 'finished (archived on its due day)'), cnt(t => t.status === 'done'))}
        ${box('fa-person-digging', 'warn', 'In progress', cnt(t => t.status === 'in_progress'))}
        ${box('fa-triangle-exclamation', 'bad', L('متأخر (ميعاده عدّى)', 'late (past due)'), cnt(t => t.status !== 'done' && t.due && t.due < today))}
        ${box('fa-user-clock', 'warn', L('لأشخاص ملهمش يوزر', 'for people without an account'), cnt(t => !!t.pendingAssignee), [...new Set(nt.filter(t => t.pendingAssignee).map(t => t.pendingAssignee))].join('، '))}
        ${pl.tasks.some(t => t.exists) ? box('fa-rotate', '', L('اتنقلوا قبل كده (هيتعدّوا)', 'already imported (skipped)'), pl.tasks.filter(t => t.exists).length) : ''}
      </div>
      <div class="ni-prog hidden" id="ni-prog"><div class="tk-bar big"><span style="width:0%"></span></div><small class="muted" id="ni-pt"></small></div>`;
    foot.innerHTML = `<button class="btn" id="ni-back"><i class="fas fa-arrow-right" data-flip></i> ${L('رجوع', 'Back')}</button><span class="grow"></span><button class="btn btn-primary" id="ni-go" ${nt.length || pl.clients.some(c => !c.exists) || pl.projects.some(p => !p.exists) ? '' : 'disabled'}><i class="fas fa-file-import"></i> ${L('استيراد', 'Import')}</button>`;
    foot.querySelector('#ni-back').onclick = stepPeople;
    foot.querySelector('#ni-go').onclick = (e) => busy(e.currentTarget, async () => {
      const pr = body.querySelector('#ni-prog'); pr.classList.remove('hidden');
      try {
        const r = await runImport(pl, (t, f) => { pr.querySelector('span').style.width = Math.round(f * 100) + '%'; body.querySelector('#ni-pt').textContent = t; });
        m.close();
        toast(L(`اتنقل ${r.clients} عميل و${r.projects} مشروع و${r.tasks} تاسك`, `Imported ${r.clients} clients, ${r.projects} projects and ${r.tasks} tasks`), r.pending ? L(`${r.pending} تاسك مستنيين تربط أصحابهم بيوزرات`, `${r.pending} tasks wait for their owners' accounts`) : '');
      } catch (ex) { toastErr(ex); }
    });
  };
  stepFiles();
}

/** names waiting for an account → pick the account → everything moves to it */
export function openPendingPeople() {
  const m = modal({ title: L('أشخاص ملهمش يوزر', 'People without an account'), icon: 'fa-user-clock', body: '<div id="pp"></div>', foot: `<button class="btn btn-primary" data-close>${L('تمام', 'Done')}</button>` });
  const draw = () => {
    const rows = pendingPeople();
    m.$('#pp').innerHTML = rows.length ? `<p class="small muted mb-8">${L('اعمل يوزر للشخص من «الموظفين» الأول، وبعدين اختاره هنا ودوس «ربط» — كل تاسكاته بتتنقل له على طول ويوصله إشعار.', 'Create the account under "Employees" first, then pick it here and press "Link" — all their tasks move to it at once and they get notified.')}</p>
      <div class="chat-members">${rows.map(r => { const g = guessPerson(r.name); return `<div class="chat-member pp-row"><span class="avatar sm chat-gav"><i class="fas fa-user-clock"></i></span><span class="grow min0"><b>${esc(r.name)}</b><small>${L(`${r.count} تاسك مستني`, `${r.count} tasks waiting`)}</small></span>
        <select class="select select-sm" data-pp="${esc(r.name)}">${peopleOptions(g ? g.email : '')}</select><button class="btn btn-primary btn-sm" data-link="${esc(r.name)}">${L('ربط', 'Link')}</button></div>`; }).join('')}</div>`
      : `<p class="muted">${L('كل الأشخاص متربطين بيوزرات 👌', 'Everyone is linked to an account 👌')}</p>`;
    m.$$('[data-link]').forEach(b => b.onclick = () => busy(b, async () => {
      const email = m.$(`[data-pp="${CSS.escape(b.dataset.link)}"]`).value;
      if (!email) { toast(L('اختار الموظف الأول', 'Pick the employee first'), '', 'warn'); return; }
      try { const n = await linkPending(b.dataset.link, email); toast(L(`اتنقل ${n} تاسك لـ ${(person(email) || {}).name || email}`, `${n} tasks moved to ${(person(email) || {}).name || email}`)); draw(); } catch (ex) { toastErr(ex); }
    }));
  };
  draw();
}
