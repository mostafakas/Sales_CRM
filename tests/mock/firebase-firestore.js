// Test double for firebase-firestore.js — an in-memory Firestore persisted to localStorage.
// Implements the subset of the modular API that the app uses.
const LS = 'mockfs';
export class Timestamp {
  constructor(seconds, nanoseconds = 0) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  static now() { return Timestamp.fromMillis(Date.now()); }
  static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)); }
  static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
  toMillis() { return this.seconds * 1000 + Math.round(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
}
const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp) && !v.__op;
function enc(v) {
  if (v instanceof Timestamp) return { __ts: v.toMillis() };
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach(k => { o[k] = enc(v[k]); }); return o; }
  return v;
}
function dec(v) {
  if (v && typeof v === 'object' && '__ts' in v && Object.keys(v).length === 1) return Timestamp.fromMillis(v.__ts);
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach(k => { o[k] = dec(v[k]); }); return o; }
  return v;
}
let store = {};
try { store = dec(JSON.parse(localStorage.getItem(LS) || '{}')); } catch { store = {}; }
const persist = () => localStorage.setItem(LS, JSON.stringify(enc(store)));
const clone = (v) => dec(enc(v));

// ---- refs ----
export function getFirestore() { return { type: 'firestore' }; }
export const initializeFirestore = getFirestore;
export const persistentLocalCache = (o) => ({ kind: 'persistent', ...(o || {}) });
export const persistentMultipleTabManager = () => ({ kind: 'multi-tab' });
const autoId = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
export function collection(base, ...segs) {
  const path = [base && base.type === 'doc' ? base.path : null, ...segs].filter(Boolean).join('/');
  return { type: 'collection', path, id: path.split('/').pop() };
}
export function doc(base, ...segs) {
  let path;
  if (base && base.type === 'collection') path = [base.path, ...(segs.length ? segs : [autoId()])].join('/');
  else path = segs.join('/');
  const parts = path.split('/');
  return { type: 'doc', path, id: parts[parts.length - 1], parentPath: parts.slice(0, -1).join('/') };
}
export const where = (field, op, value) => ({ kind: 'where', field, op, value });
export const orderBy = (field, dir = 'asc') => ({ kind: 'orderBy', field, dir });
export const limit = (n) => ({ kind: 'limit', n });
export function query(col, ...cons) { return { type: 'query', path: col.path, cons }; }

// ---- sentinels ----
export const serverTimestamp = () => ({ __op: 'ts' });
export const increment = (n) => ({ __op: 'inc', n });
export const arrayUnion = (...v) => ({ __op: 'union', v });
export const arrayRemove = (...v) => ({ __op: 'remove', v });
export const deleteField = () => ({ __op: 'del' });

function resolve(val, prev) {
  if (val && val.__op === 'ts') return Timestamp.now();
  if (val && val.__op === 'inc') return (typeof prev === 'number' ? prev : 0) + val.n;
  if (val && val.__op === 'union') { const arr = Array.isArray(prev) ? prev.slice() : []; val.v.forEach(x => { if (!arr.some(y => JSON.stringify(enc(y)) === JSON.stringify(enc(x)))) arr.push(clone(x)); }); return arr; }
  if (val && val.__op === 'remove') { const arr = Array.isArray(prev) ? prev.slice() : []; return arr.filter(y => !val.v.some(x => JSON.stringify(enc(x)) === JSON.stringify(enc(y)))); }
  if (Array.isArray(val)) return val.map(v => resolve(v));
  if (isPlain(val)) { const o = {}; Object.keys(val).forEach(k => { const r = resolve(val[k], prev && prev[k]); if (!(val[k] && val[k].__op === 'del')) o[k] = r; }); return o; }
  if (val instanceof Timestamp) return new Timestamp(val.seconds, val.nanoseconds);
  return val;
}
function deepMerge(target, src) {
  Object.keys(src).forEach(k => {
    const v = src[k];
    if (v && v.__op === 'del') { delete target[k]; return; }
    if (isPlain(v)) { if (!isPlain(target[k])) target[k] = {}; deepMerge(target[k], v); }
    else target[k] = resolve(v, target[k]);
  });
  return target;
}
function setPath(obj, path, val) {
  const parts = path.split('.'); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (!isPlain(o[parts[i]])) o[parts[i]] = {}; o = o[parts[i]]; }
  const last = parts[parts.length - 1];
  if (val && val.__op === 'del') delete o[last]; else o[last] = resolve(val, o[last]);
}
const getPath = (obj, path) => path === '__name__' ? obj.__id : path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
function validate(data) {
  (function walk(v, p) {
    if (v === undefined) throw err('invalid-argument', 'Unsupported field value: undefined (' + p + ')');
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, p + '[' + i + ']'));
    else if (isPlain(v)) Object.keys(v).forEach(k => walk(v[k], p + '.' + k));
  })(data, '');
}
// ---- write log (used by the rules audit) ----
function logWrite(op, ref, before, after, opts) {
  try {
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    const changed = [...keys].filter(k => JSON.stringify(enc((before || {})[k])) !== JSON.stringify(enc((after || {})[k])));
    const log = JSON.parse(localStorage.getItem('mockwrites') || '[]');
    log.push({ actor: localStorage.getItem('mockauth_current'), op: before ? (op === 'delete' ? 'delete' : 'update') : 'create', path: ref.path, changed, merge: !!(opts && opts.merge) });
    localStorage.setItem('mockwrites', JSON.stringify(log.slice(-3000)));
  } catch {}
}
// ---- write primitives ----
function applySet(ref, data, opts) {
  validate(data);
  const prev = store[ref.path];
  const _before = prev ? clone(prev) : null;
  if (opts && opts.merge && prev) store[ref.path] = deepMerge(clone(prev), data);
  else store[ref.path] = deepMerge({}, data);
  logWrite('set', ref, _before, store[ref.path], opts);
}
function applyUpdate(ref, data) {
  validate(data);
  if (!store[ref.path]) throw err('not-found', 'No document to update: ' + ref.path);
  const next = clone(store[ref.path]);
  Object.keys(data).forEach(k => setPath(next, k, data[k]));
  logWrite('update', ref, store[ref.path], next);
  store[ref.path] = next;
}
function applyDelete(ref) { logWrite('delete', ref, store[ref.path] || {}, null); delete store[ref.path]; }
function commit() { persist(); notifyAll(); }

// ---- snapshots ----
function bill(n) { try { const k = 'mock_reads'; localStorage.setItem(k, String(Number(localStorage.getItem(k) || 0) + n)); } catch {} }
function docSnap(ref) {
  const d = store[ref.path];
  return { id: ref.id, ref, exists: () => !!d, data: () => (d ? clone(d) : undefined), get: (f) => d ? clone(getPath(d, f)) : undefined };
}
function cmp(a, b) {
  const va = a instanceof Timestamp ? a.toMillis() : a, vb = b instanceof Timestamp ? b.toMillis() : b;
  if (va === vb) return 0; if (va === undefined || va === null) return -1; if (vb === undefined || vb === null) return 1;
  return va < vb ? -1 : 1;
}
function runQuery(q) {
  const colPath = q.path;
  // optional: behave like a project whose composite indexes were never published
  if (localStorage.getItem('mock_strict_index') === '1') {
    const ws = (q.cons || []).filter(c => c.kind === 'where');
    const eq = ws.filter(c => c.op === '==' || c.op === 'array-contains'), rg = ws.filter(c => ['<', '<=', '>', '>='].includes(c.op));
    const ob = (q.cons || []).filter(c => c.kind === 'orderBy');
    if ((eq.length && rg.length) || (eq.length && ob.length) || (rg.length && ob.some(o => o.field !== rg[0].field)))
      throw err('failed-precondition', 'The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/x/firestore/indexes?create_composite=abc');
  }
  let rows = Object.keys(store).filter(p => { const i = p.lastIndexOf('/'); return p.slice(0, i) === colPath; })
    .map(p => ({ path: p, id: p.slice(p.lastIndexOf('/') + 1), data: store[p] }));
  const cons = q.cons || [];
  cons.filter(c => c.kind === 'where').forEach(c => {
    rows = rows.filter(r => {
      const v = c.field === '__name__' ? r.id : getPath(r.data, c.field);
      const t = c.value;
      switch (c.op) {
        case '==': return cmp(v, t) === 0 && v !== undefined;
        case '!=': return v !== undefined && cmp(v, t) !== 0;
        case '<': return v !== undefined && cmp(v, t) < 0;
        case '<=': return v !== undefined && cmp(v, t) <= 0;
        case '>': return v !== undefined && cmp(v, t) > 0;
        case '>=': return v !== undefined && cmp(v, t) >= 0;
        case 'in': return t.some(x => cmp(v, x) === 0);
        case 'array-contains': return Array.isArray(v) && v.some(x => cmp(x, t) === 0);
        default: throw err('invalid-argument', 'op ' + c.op);
      }
    });
  });
  cons.filter(c => c.kind === 'orderBy').reverse().forEach(c => {
    rows.sort((a, b) => { const r = cmp(getPath(a.data, c.field), getPath(b.data, c.field)); return c.dir === 'desc' ? -r : r; });
  });
  const lim = cons.find(c => c.kind === 'limit');
  if (lim) rows = rows.slice(0, lim.n);
  return rows.map(r => doc({ type: 'collection', path: colPath }, r.id));
}
function querySnap(q, prevIds) {
  const refs = runQuery(q.type === 'collection' ? { path: q.path, cons: [] } : q);
  const docs = refs.map(docSnap);
  const changes = [];
  const prev = prevIds || new Map();
  docs.forEach(d => {
    const j = JSON.stringify(enc(d.data()));
    if (!prev.has(d.id)) changes.push({ type: 'added', doc: d });
    else if (prev.get(d.id) !== j) changes.push({ type: 'modified', doc: d });
  });
  prev.forEach((_, id) => { if (!docs.some(d => d.id === id)) changes.push({ type: 'removed', doc: { id, data: () => ({}) } }); });
  return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f), docChanges: () => changes };
}
export async function getDoc(ref) { await tick(); bill(1); if (localStorage.getItem('mock_quota') === '1') throw err('resource-exhausted', 'Quota exceeded.'); return docSnap(ref); }
export const getDocFromServer = getDoc;
export async function getDocs(q) { await tick(); const r = querySnap(q); bill(Math.max(1, r.docs.length)); return r; } // throws like Firestore when an index is missing
export async function setDoc(ref, data, opts) { await tick(); applySet(ref, data, opts); commit(); }
export async function updateDoc(ref, data) { await tick(); applyUpdate(ref, data); commit(); }
export async function deleteDoc(ref) { await tick(); applyDelete(ref); commit(); }
export async function addDoc(col, data) { const r = doc(col); await setDoc(r, data); return r; }
const tick = () => new Promise(r => setTimeout(r, 1));

// ---- listeners ----
const listeners = new Set();
function fire(l) {
  try {
    if (l.target.type === 'doc') {
      const s = docSnap(l.target); const j = JSON.stringify(enc(s.data() || null));
      if (j === l.last) return; l.last = j; bill(1); l.next(s);
    } else {
      const s = querySnap(l.target, l.prevIds);
      const ids = new Map(s.docs.map(d => [d.id, JSON.stringify(enc(d.data()))]));
      const j = JSON.stringify([...ids.entries()]);
      if (j === l.last) return; l.last = j; l.prevIds = ids; bill(Math.max(l.billed ? 0 : 1, s.docChanges().filter(c => c.type !== 'removed').length)); l.billed = true; l.next(s);
    }
  } catch (e) { l.error && l.error(e); }
}
function notifyAll() { listeners.forEach(l => setTimeout(() => fire(l), 0)); }
export function onSnapshot(target, next, error) {
  const l = { target, next, error, last: null, prevIds: new Map() };
  listeners.add(l);
  setTimeout(() => fire(l), 0);
  return () => listeners.delete(l);
}
// cross-tab: reload store when another tab writes
window.addEventListener('storage', (e) => { if (e.key === LS) { try { store = dec(JSON.parse(e.newValue || '{}')); notifyAll(); } catch {} } });

// ---- batch & transaction ----
export function writeBatch() {
  const ops = [];
  return {
    set(ref, data, opts) { ops.push(() => applySet(ref, data, opts)); return this; },
    update(ref, data) { ops.push(() => applyUpdate(ref, data)); return this; },
    delete(ref) { ops.push(() => applyDelete(ref)); return this; },
    async commit() {
      await tick();
      const backup = clone(store);
      try { ops.forEach(o => o()); } catch (e) { store = backup; throw e; }
      commit();
    }
  };
}
export async function runTransaction(db, fn) {
  const ops = [];
  let wrote = false;
  const tx = {
    async get(ref) { if (wrote) throw err('invalid-argument', 'reads must come before writes'); return docSnap(ref); },
    set(ref, data, opts) { wrote = true; ops.push(() => applySet(ref, data, opts)); return tx; },
    update(ref, data) { wrote = true; ops.push(() => applyUpdate(ref, data)); return tx; },
    delete(ref) { wrote = true; ops.push(() => applyDelete(ref)); return tx; }
  };
  const result = await fn(tx);
  const backup = clone(store);
  try { ops.forEach(o => o()); } catch (e) { store = backup; throw e; }
  commit();
  return result;
}
export const documentId = () => '__name__';
