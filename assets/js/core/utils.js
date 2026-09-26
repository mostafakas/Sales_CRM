// Shared helpers: language, escaping, Cairo-time dates, formatting.

// ---------- language ----------
const LS_LANG = 'am_lang';
export const lang = (() => { try { return localStorage.getItem(LS_LANG) || 'ar'; } catch { return 'ar'; } })();
export const isAr = lang === 'ar';
/** Bilingual string: L('عربي', 'English') */
export const L = (ar, en) => (isAr ? ar : (en ?? ar));
export function setLang(l) { try { localStorage.setItem(LS_LANG, l); } catch {} location.reload(); }
export function applyDocLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = isAr ? 'rtl' : 'ltr';
}
// ---------- theme ----------
const LS_THEME = 'am_theme';
export function applyTheme() {
  let t = null; try { t = localStorage.getItem(LS_THEME); } catch {}
  if (!t) t = matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  return t;
}
export function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(LS_THEME, t); } catch {}
  return t;
}

// ---------- escaping (every user-provided value goes through esc before innerHTML) ----------
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"'`=\/]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;', '/': '&#47;' }[c]));
}
/** tagged template that escapes interpolations unless wrapped with raw() */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      if (v && v.__raw) out += v.v;
      else if (Array.isArray(v)) out += v.map(x => (x && x.__raw) ? x.v : esc(x)).join('');
      else out += esc(v);
    }
  });
  return { __raw: true, v: out, toString() { return out; } };
}
export const raw = (v) => ({ __raw: true, v: String(v ?? ''), toString() { return this.v; } });

// ---------- time (company timezone) ----------
export const TZ = 'Africa/Cairo';
export const pad = (n) => String(n).padStart(2, '0');
const _dtf = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
export function zparts(ms) {
  const p = {};
  _dtf.formatToParts(new Date(ms)).forEach(x => { if (x.type !== 'literal') p[x.type] = x.value; });
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { y: +p.year, mo: +p.month, d: +p.day, h: p.hour === '24' ? 0 : +p.hour, mi: +p.minute, s: +p.second, wd };
}
export const ymd = (ms) => { const p = zparts(ms); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };
export const ym = (ms) => ymd(ms).slice(0, 7);
export const minutesOfDay = (ms) => { const p = zparts(ms); return p.h * 60 + p.mi + p.s / 60; };
export const hmToMin = (hm) => { if (!hm) return 0; const [h, m] = String(hm).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
export const minToHm = (m) => `${pad(Math.floor(m / 60))}:${pad(Math.round(m % 60))}`;

/** Epoch ms for a Cairo wall-clock date + 'HH:MM' (handles DST). */
export function cairoMs(dateStr, hm = '00:00') {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = String(hm).split(':').map(Number);
  const target = Date.UTC(y, m - 1, d, h || 0, mi || 0);
  let guess = target - 2 * 3600000;
  for (let i = 0; i < 3; i++) {
    const p = zparts(guess);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    const diff = target - asUtc;
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

/** Plain calendar helpers on 'YYYY-MM-DD' strings (timezone-free) */
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export function weekday(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
export function daysInMonth(ymStr) { const [y, m] = ymStr.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
export function monthDates(ymStr) { const n = daysInMonth(ymStr); return Array.from({ length: n }, (_, i) => `${ymStr}-${pad(i + 1)}`); }
export function dateRange(from, to) { const out = []; if (!from || !to || to < from) return out; let d = from; while (d <= to && out.length < 400) { out.push(d); d = addDays(d, 1); } return out; }
export function addMonths(ymStr, n) { const [y, m] = ymStr.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`; }

// ---------- formatting ----------
const locale = () => (isAr ? 'ar-EG-u-nu-latn' : 'en-GB');
export function fmtDate(v, opts) {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v + 'T12:00:00Z') : new Date(v);
  return new Intl.DateTimeFormat(locale(), { timeZone: typeof v === 'string' ? 'UTC' : TZ, day: 'numeric', month: 'short', year: 'numeric', ...(opts || {}) }).format(d);
}
export const fmtDay = (v) => fmtDate(v, { weekday: 'long', day: 'numeric', month: 'long', year: undefined });
export const fmtLongDate = (ms) => new Intl.DateTimeFormat(locale(), { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(ms));
export function fmtTime(ms, sec) {
  if (!ms) return '—';
  return new Intl.DateTimeFormat(locale(), { timeZone: TZ, hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}), hour12: true }).format(new Date(ms));
}
export function fmtMonth(ymStr) {
  const [y, m] = ymStr.split('-').map(Number);
  return new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, 15)));
}
export function fmtDur(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
export function fmtHours(ms) {
  const m = Math.round((ms || 0) / 60000);
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r}${L('د', 'm')}`;
  return `${h}${L('س', 'h')} ${r ? r + L('د', 'm') : ''}`.trim();
}
export function fmtMin(min) { return fmtHours((min || 0) * 60000); }
export function money(n, cur = true) {
  const v = Number(n || 0);
  const s = new Intl.NumberFormat(isAr ? 'ar-EG-u-nu-latn' : 'en-US', { maximumFractionDigits: 2 }).format(v);
  return cur ? `${s} ${L('ج.م', 'EGP')}` : s;
}
export const num = (n, d = 0) => new Intl.NumberFormat(isAr ? 'ar-EG-u-nu-latn' : 'en-US', { maximumFractionDigits: d }).format(Number(n || 0));
export function relTime(ms) {
  if (!ms) return '';
  const diff = (Date.now() - ms) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (diff < 60) return rtf.format(-Math.round(diff), 'second');
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  return rtf.format(-Math.round(diff / 86400), 'day');
}

// ---------- misc ----------
export const byId = (id) => document.getElementById(id);
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
export const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const sum = (arr, f = (x) => x) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
export const normEmail = (e) => String(e || '').trim().toLowerCase();
export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type }); const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
/** Resize an image file to a JPEG data URL (keeps Firestore docs small). */
export function imageToDataUrl(file, maxSide = 256, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) { reject(new Error('not-image')); return; }
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject; img.src = r.result;
    };
    r.onerror = reject; r.readAsDataURL(file);
  });
}
