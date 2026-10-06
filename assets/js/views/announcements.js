// Announcements page: the company board (pinned first). Writers (admin / HR) post, edit, delete, see who read
// each announcement and remind the rest. Opening the page marks what you see as read.
import { L, esc, fmtDate, fmtTime, ymd, imageToDataUrl } from '../core/utils.js';
import { toast, toastErr, avatar, empty, modal, busy, confirmDialog } from '../core/ui.js';
import { session, now } from '../core/session.js';
import { toMs } from '../core/fb.js';
import { person, departments } from '../services/directory.js';
import {
  announcements, onAnnouncements, markRead, canWriteAnnouncements, isRead, isExpired, publish, edit, remove, readersOf, remind, audienceOf, writerName
} from '../services/announcements.js';

const linkify = (text) => String(text || '').split(/(https?:\/\/[^\s<]+)/g).map((p, i) => i % 2 ? `<a href="${esc(p)}" target="_blank" rel="noopener">${esc(p)}</a>` : esc(p)).join('');
const when = (a) => { const t = toMs(a.createdAt) || now(); return ymd(t) === ymd(now()) ? `${L('النهارده', 'Today')} ${fmtTime(t)}` : `${fmtDate(ymd(t))} ${fmtTime(t)}`; };

/** The popup for an important announcement; resolves when the reader confirms */
export function importantPopup(a) {
  const m = modal({
    title: L('إعلان مهم', 'Important announcement'), icon: 'fa-bullhorn', locked: true,
    body: `<div class="ann-pop"><h3>${esc(a.title)}</h3><div class="muted small mb-8">${esc(writerName(a))} · ${esc(when(a))}</div>
      ${a.image ? `<img src="${esc(a.image)}" alt="" class="ann-img">` : ''}<div class="ann-body">${linkify(a.body)}</div></div>`,
    foot: `<button class="btn btn-primary" id="ann-ok"><i class="fas fa-check"></i> ${L('قريت الإعلان', 'I have read it')}</button>`
  });
  return new Promise(res => { m.$('#ann-ok').onclick = () => { m.close(); markRead([a]); res(); }; });
}

export default async function render(root) {
  const writer = canWriteAnnouncements();
  root.innerHTML = `<div class="page-head"><div><h2>${L('الإعلانات', 'Announcements')}</h2><p>${L('أخبار وقرارات الشركة', 'Company news and decisions')}</p></div>
      ${writer ? `<button class="btn btn-primary" id="new"><i class="fas fa-plus"></i> ${L('إعلان جديد', 'New announcement')}</button>` : ''}</div>
    <div class="ann-list" id="list"></div>`;
  const draw = () => {
    const rows = announcements();
    const el = root.querySelector('#list');
    if (!rows.length) { el.innerHTML = `<div class="card">${empty('fa-bullhorn', L('مفيش إعلانات لسه', 'No announcements yet'), writer ? L('اضغط «إعلان جديد» عشان تكتب أول إعلان.', 'Click "New announcement" to post the first one.') : '')}</div>`; return; }
    el.innerHTML = rows.map(a => {
      const w = person(a.createdBy) || { email: a.createdBy, name: writerName(a) };
      const aud = audienceOf(a).length, rc = Math.min(aud, Number(a.readCount) || 0);
      return `<article class="card ann ${a.pinned ? 'pinned' : ''} ${a.important ? 'important' : ''} ${isRead(a) ? '' : 'unread'} ${isExpired(a) ? 'expired' : ''}">
        <div class="ann-head">${avatar(w, 'sm')}<div class="grow min0"><b>${esc(w.name || w.email)}</b><div class="xs muted">${esc(when(a))} · ${a.departments && a.departments.length ? esc(a.departments.join('، ')) : L('للكل', 'Everyone')}</div></div>
          <div class="row gap-4 wrap">${a.pinned ? `<span class="badge brand"><i class="fas fa-thumbtack"></i>${L('مثبت', 'Pinned')}</span>` : ''}${a.important ? `<span class="badge bad"><i class="fas fa-circle-exclamation"></i>${L('مهم', 'Important')}</span>` : ''}${!isRead(a) ? `<span class="badge warn">${L('جديد', 'New')}</span>` : ''}${isExpired(a) ? `<span class="badge">${L('منتهي', 'Expired')}</span>` : ''}</div></div>
        <h3 class="ann-title">${esc(a.title)}</h3>
        ${a.image ? `<img src="${esc(a.image)}" alt="" class="ann-img">` : ''}
        ${a.body ? `<div class="ann-body">${linkify(a.body)}</div>` : ''}
        ${writer ? `<div class="ann-foot"><button class="btn btn-soft btn-sm" data-readers="${esc(a.id)}"><i class="fas fa-eye"></i> ${L(`قراه ${rc} من ${aud}`, `Read by ${rc} of ${aud}`)}</button>
          <div class="ann-meter"><span style="width:${aud ? Math.round(rc / aud * 100) : 0}%"></span></div>
          <button class="btn btn-ghost btn-sm" data-edit="${esc(a.id)}"><i class="fas fa-pen"></i> ${L('تعديل', 'Edit')}</button>
          <button class="btn btn-ghost btn-sm" data-del="${esc(a.id)}" style="color:var(--bad)"><i class="fas fa-trash"></i></button></div>` : ''}
      </article>`;
    }).join('');
    // seeing the board = reading it (important ones too)
    markRead(rows.filter(a => !isExpired(a)));
  };
  const off = onAnnouncements(draw);

  root.addEventListener('click', async (e) => {
    const find = (id) => announcements().find(a => a.id === id);
    const rd = e.target.closest('[data-readers]'); if (rd) { const a = find(rd.dataset.readers); if (a) readersDialog(a); return; }
    const ed = e.target.closest('[data-edit]'); if (ed) { const a = find(ed.dataset.edit); if (a) editor(a); return; }
    const dl = e.target.closest('[data-del]');
    if (dl) {
      const a = find(dl.dataset.del); if (!a) return;
      const ok = await confirmDialog({ title: L('حذف الإعلان', 'Delete announcement'), message: a.title, okText: L('حذف', 'Delete'), okClass: 'btn-danger' });
      if (ok) { try { await remove(a); toast(L('اتمسح', 'Deleted')); } catch (ex) { toastErr(ex); } }
    }
    if (e.target.closest('#new')) editor(null);
  });

  function editor(a) {
    let image = (a && a.image) || '';
    const deps = new Set((a && a.departments) || []);
    const m = modal({
      title: a ? L('تعديل الإعلان', 'Edit announcement') : L('إعلان جديد', 'New announcement'), icon: 'fa-bullhorn',
      body: `<div class="col gap-12">
        <div class="field"><label>${L('العنوان', 'Title')} *</label><input class="input" id="at" maxlength="150" value="${esc(a ? a.title : '')}"></div>
        <div class="field"><label>${L('نص الإعلان', 'Text')}</label><textarea class="textarea" id="ab" maxlength="5000" style="min-height:140px">${esc(a ? a.body : '')}</textarea></div>
        <div class="field"><label>${L('صورة (اختياري)', 'Image (optional)')}</label>
          <div class="row gap-8"><label class="btn btn-sm"><i class="fas fa-image"></i> ${L('اختار صورة', 'Choose image')}<input type="file" accept="image/*" hidden id="ai"></label><button class="btn btn-ghost btn-sm ${image ? '' : 'hidden'}" id="ai-x" type="button">${L('شيل الصورة', 'Remove')}</button></div>
          <img id="ai-p" class="ann-img ${image ? '' : 'hidden'}" src="${esc(image)}" alt="" style="margin-top:8px;max-height:160px"></div>
        <div class="field"><label>${L('الإعلان لمين؟', 'Who is it for?')}</label>
          <div class="row-wrap" id="ad"><label class="chip-check"><input type="checkbox" value="" ${deps.size ? '' : 'checked'} data-all> ${L('الكل', 'Everyone')}</label>
          ${departments().map(d => `<label class="chip-check"><input type="checkbox" value="${esc(d)}" ${deps.has(d) ? 'checked' : ''}> ${esc(d)}</label>`).join('')}</div></div>
        <div class="form-grid">
          <label class="row gap-8" style="cursor:pointer"><span class="switch"><input type="checkbox" id="ap" ${a && a.pinned ? 'checked' : ''}><span></span></span><span><b>${L('تثبيت فوق', 'Pin to top')}</b></span></label>
          <label class="row gap-8" style="cursor:pointer"><span class="switch"><input type="checkbox" id="aimp" ${a && a.important ? 'checked' : ''}><span></span></span><span><b>${L('إعلان مهم', 'Important')}</b><div class="xs muted">${L('يظهر بوب أب عند الكل لحد ما يدوسوا «قريت».', 'Pops up for everyone until they confirm.')}</div></span></label>
        </div>
        <div class="field"><label>${L('ينتهي يوم (اختياري)', 'Expires on (optional)')}</label><input class="input" type="date" id="ae" min="${ymd(now())}" value="${esc(a ? a.expiresOn || '' : '')}"></div>
      </div>`,
      foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="as"><i class="fas fa-paper-plane"></i> ${a ? L('حفظ', 'Save') : L('نشر الإعلان', 'Publish')}</button>`
    });
    const box = m.$('#ad');
    box.onchange = (e) => {
      if (e.target.dataset.all !== undefined) { if (e.target.checked) box.querySelectorAll('input:not([data-all])').forEach(x => { x.checked = false; }); }
      else box.querySelector('[data-all]').checked = ![...box.querySelectorAll('input:not([data-all])')].some(x => x.checked);
    };
    m.$('#ai').onchange = async (e) => { try { image = await imageToDataUrl(e.target.files[0], 1200, 0.8); m.$('#ai-p').src = image; m.$('#ai-p').classList.remove('hidden'); m.$('#ai-x').classList.remove('hidden'); } catch { toast(L('الصورة مش صالحة', 'Invalid image'), '', 'bad'); } };
    m.$('#ai-x').onclick = () => { image = ''; m.$('#ai-p').classList.add('hidden'); m.$('#ai-x').classList.add('hidden'); };
    m.$('#as').onclick = (e) => busy(e.currentTarget, async () => {
      const data = { title: m.$('#at').value, body: m.$('#ab').value, image, pinned: m.$('#ap').checked, important: m.$('#aimp').checked, expiresOn: m.$('#ae').value,
        departments: [...box.querySelectorAll('input:not([data-all]):checked')].map(x => x.value) };
      if (!data.title.trim()) { m.$('#at').focus(); return; }
      if (image.length > 900000) { toast(L('الصورة كبيرة، اختار صورة أصغر.', 'The image is too large, choose a smaller one.'), '', 'bad'); return; }
      try { if (a) await edit(a, data); else await publish(data); m.close(); toast(a ? L('اتحفظ', 'Saved') : L('اتنشر الإعلان ووصل إشعار للكل', 'Published — everyone was notified')); } catch (ex) { toastErr(ex); }
    });
  }

  async function readersDialog(a) {
    const m = modal({ title: a.title, icon: 'fa-eye', size: 'narrow', body: `<div class="muted">${L('بيحمّل…', 'Loading…')}</div>`, foot: `<button class="btn" data-close>${L('إغلاق', 'Close')}</button>` });
    try {
      const { read, unread } = await readersOf(a);
      const row = (p, at) => `<div class="chat-member">${avatar(p, 'sm')}<span class="grow min0"><b class="truncate">${esc(p.name || p.email)}</b><small class="truncate">${esc(p.department || '')}</small></span>${at ? `<small class="num muted">${esc(ymd(at) === ymd(now()) ? fmtTime(at) : fmtDate(ymd(at)))}</small>` : ''}</div>`;
      m.el.querySelector('.modal-body').innerHTML = `
        <div class="label mb-8">${L('قروه', 'Read')} (${read.length})</div><div class="chat-members">${read.map(x => row(x.p, x.at)).join('') || `<p class="muted small">${L('لسه محدش', 'Nobody yet')}</p>`}</div>
        <div class="label mb-8 mt-16">${L('لسه', 'Not yet')} (${unread.length})</div><div class="chat-members">${unread.map(p => row(p)).join('') || `<p class="muted small">${L('الكل قراه 👌', 'Everyone read it 👌')}</p>`}</div>`;
      if (unread.length) {
        m.el.querySelector('.modal-foot').insertAdjacentHTML('afterbegin', `<button class="btn btn-primary" id="rm"><i class="fas fa-bell"></i> ${L(`تذكير للي لسه (${unread.length})`, `Remind the rest (${unread.length})`)}</button>`);
        m.$('#rm').onclick = () => { remind(a, unread.map(p => p.email)); m.close(); toast(L('اتبعت تذكير', 'Reminder sent')); };
      }
    } catch (ex) { toastErr(ex); m.close(); }
  }

  return () => off();
}
