// Birthday popups and the "Birthdays" card on My day. On someone's birthday everyone gets a celebration popup once
// a day with a box to send a wish; the birthday person gets their own popup with the wishes coming in live.
import { L, esc, fmtDate, ymd } from '../core/utils.js';
import { toast, toastErr, avatar, modal, busy, queuePopup } from '../core/ui.js';
import { session, now } from '../core/session.js';
import { nameOf, person } from '../services/directory.js';
import { todays, upcoming, sendWish, watchWishes, watchSent } from '../services/birthdays.js';

const confetti = () => `<div class="bd-confetti" aria-hidden="true">${Array.from({ length: 18 }, (_, i) => `<i style="--x:${(i * 37) % 100}%;--d:${(i % 6) * 0.25}s;--c:${['#1b1bdb', '#f79009', '#12b76a', '#f04438', '#7a5af8', '#0ba5ec'][i % 6]}"></i>`).join('')}</div>`;
const shownKey = () => `am_bday_${session.email}_${ymd(now())}`;

/** once a day, right after sign-in */
export function birthdayGreeter() {
  const people = todays();
  if (!people.length) return;
  try { if (localStorage.getItem(shownKey())) return; localStorage.setItem(shownKey(), '1'); } catch {}
  const mine = people.some(p => p.email === session.email);
  const others = people.filter(p => p.email !== session.email);
  if (mine) queuePopup(() => myBirthday());
  if (others.length) queuePopup(() => celebrate(others));
}

/** "Today is X's birthday" with a wish box per person (resolves when closed) */
export function celebrate(people) {
  let done; const closed = new Promise(r => { done = r; });
  let sent = new Set();
  const m = modal({
    title: L('عيد ميلاد سعيد 🎉', 'Happy birthday 🎉'), icon: 'fa-cake-candles', size: 'narrow',
    body: `<div class="bd-pop">${confetti()}
      ${people.map(p => `<div class="bd-person" data-p="${esc(p.email)}">${avatar(p, 'xl')}
        <h3>${L(`النهارده عيد ميلاد ${esc(p.name || p.email)}`, `Today is ${esc(p.name || p.email)}'s birthday`)}</h3>
        <div class="muted small">${esc(p.title || '')}${p.department ? ' · ' + esc(p.department) : ''}</div>
        <div class="bd-wish"><textarea class="textarea" maxlength="500" placeholder="${L('اكتب تهنئة… كل سنة وانت طيب 🎂', 'Write a wish… Happy birthday 🎂')}"></textarea>
          <button class="btn btn-primary" data-send="${esc(p.email)}"><i class="fas fa-paper-plane"></i> ${L('ابعت التهنئة', 'Send wish')}</button></div>
        <div class="bd-sent hidden"><i class="fas fa-circle-check"></i> ${L('اتبعتت تهنئتك', 'Your wish was sent')}</div></div>`).join('')}</div>`,
    foot: `<button class="btn" data-close>${L('بعدين', 'Later')}</button>`
  });
  const un = watchSent(rows => { sent = new Set(rows.map(r => r.to)); m.$$('[data-p]').forEach(el => { const done = sent.has(el.dataset.p); el.querySelector('.bd-wish').classList.toggle('hidden', done); el.querySelector('.bd-sent').classList.toggle('hidden', !done); }); });
  const close = m.close; m.close = () => { un(); close(); done(); };
  m.$$('[data-send]').forEach(b => b.onclick = () => busy(b, async () => {
    const box = b.closest('[data-p]').querySelector('textarea');
    if (!box.value.trim()) { box.focus(); return; }
    try { await sendWish(b.dataset.send, box.value); toast(L('اتبعتت التهنئة 🎉', 'Wish sent 🎉')); } catch (ex) { toastErr(ex); }
  }));
  return closed;
}

/** the birthday person's own popup: the wishes, live (resolves when closed) */
export function myBirthday() {
  let done; const closed = new Promise(r => { done = r; });
  const me = person(session.email) || { email: session.email, name: nameOf(session.email) };
  const m = modal({
    title: L('كل سنة وانت طيب 🎂', 'Happy birthday 🎂'), icon: 'fa-cake-candles', size: 'narrow',
    body: `<div class="bd-pop">${confetti()}<div class="bd-person">${avatar(me, 'xl')}<h3>${L(`كل سنة وانت طيب يا ${esc((me.name || '').split(' ')[0])}`, `Happy birthday, ${esc((me.name || '').split(' ')[0])}`)}</h3>
      <div class="muted small">${L('من كل فريق AL MASTER', 'From the whole AL MASTER team')}</div></div>
      <div class="label mb-8 mt-16">${L('التهاني', 'Wishes')} <span class="num" id="bd-n"></span></div><div class="bd-wall" id="bd-wall"><p class="muted small">${L('التهاني هتوصل هنا أول بأول…', 'Wishes will appear here as they arrive…')}</p></div></div>`,
    foot: `<button class="btn btn-primary" data-close>${L('شكراً 💙', 'Thanks 💙')}</button>`
  });
  const un = watchWishes(session.email, rows => {
    m.$('#bd-n').textContent = rows.length ? `(${rows.length})` : '';
    if (rows.length) m.$('#bd-wall').innerHTML = rows.map(w => { const p = person(w.from) || { email: w.from, name: nameOf(w.from) }; return `<div class="bd-w">${avatar(p, 'sm')}<div class="min0"><b>${esc(p.name || p.email)}</b><p>${esc(w.text)}</p></div></div>`; }).join('');
  });
  const close = m.close; m.close = () => { un(); close(); done(); };
  return closed;
}

/** "Birthdays" card on My day: today + the next 7 days. Returns an unsubscribe. */
export function mountBirthdayCard(el) {
  const draw = () => {
    const today = todays(), next = upcoming(7);
    if (!today.length && !next.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    el.innerHTML = `<div class="card-head"><h3><i class="fas fa-cake-candles" style="color:var(--warn)"></i> ${L('أعياد الميلاد', 'Birthdays')}</h3></div><div class="card-body col gap-8">
      ${today.map(p => `<div class="bd-row today">${avatar(p, 'sm')}<div class="grow min0"><b class="truncate">${esc(p.name || p.email)}</b><small>${L('النهارده 🎉', 'Today 🎉')}</small></div>
        <button class="btn btn-sm ${p.email === session.email ? 'btn-soft' : 'btn-primary'}" data-bd="${esc(p.email)}">${p.email === session.email ? L('التهاني', 'My wishes') : L('هنّيه', 'Send a wish')}</button></div>`).join('')}
      ${next.map(x => `<div class="bd-row">${avatar(x.p, 'sm')}<div class="grow min0"><b class="truncate">${esc(x.p.name || x.p.email)}</b><small>${x.inDays === 1 ? L('بكرة', 'Tomorrow') : esc(fmtDate(x.date))}</small></div></div>`).join('')}
    </div>`;
    el.querySelectorAll('[data-bd]').forEach(b => b.onclick = () => { if (b.dataset.bd === session.email) myBirthday(); else celebrate([person(b.dataset.bd)].filter(Boolean)); });
  };
  draw();
  return draw;
}
