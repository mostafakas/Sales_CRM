// Requests engine: one flow for every request type, staged approvals, and the effects of
// final approval (balance ledger, schedule days, advances, attendance corrections).
import {
  db, doc, col, addDoc, updateDoc, setDoc, getDoc, runTransaction, serverTimestamp, arrayUnion, list, query, where, read, watch, toMs
} from '../core/fb.js';
import { session, now, isHR } from '../core/session.js';
import {
  policy, leaveType, leaveTypes, stagesFor, firstStatus, nextStatus, planFor, typeLabel, statusLabel
} from '../core/policy.js';
import { L, dateRange, normEmail, ymd, cairoMs, uid } from '../core/utils.js';
import { userError } from '../core/ui.js';
import { notify, notifyMany } from './notify.js';
import { activePeople, person, nameOf } from './directory.js';
import { correctDay } from './attendance.js';

// ---------- balances ----------
export const balanceId = (email, year) => `${email}_${year}`;
export function emptyBalance(email, year) {
  const types = {};
  leaveTypes.forEach(t => { types[t.id] = { entitled: Number(t.days) || 0, used: 0, adjust: 0 }; });
  return { email, year: Number(year), types };
}
export function normalizeBalance(b, email, year) {
  const base = emptyBalance(email, year);
  if (!b) return base;
  const types = { ...base.types };
  Object.keys(b.types || {}).forEach(k => { types[k] = { ...types[k], ...b.types[k] }; });
  return { ...base, ...b, types };
}
export const remaining = (t) => (Number(t.entitled) || 0) + (Number(t.adjust) || 0) - (Number(t.used) || 0);
export async function getBalance(email, year = new Date().getFullYear()) {
  const b = await read('balances', balanceId(email, year)).catch(() => null);
  return normalizeBalance(b, email, year);
}
export function watchBalance(email, year, cb) {
  return watch(doc(db, 'balances', balanceId(email, year)), (b) => cb(normalizeBalance(b, email, year)));
}
/** HR manual adjustment with ledger entry */
export async function adjustBalance(email, year, typeId, { entitled, adjustDelta = 0, note = '' }) {
  const id = balanceId(email, year);
  await runTransaction(db, async (tx) => {
    const r = doc(db, 'balances', id);
    const cur = normalizeBalance((await tx.get(r)).data(), email, year);
    const t = cur.types[typeId] || { entitled: 0, used: 0, adjust: 0 };
    if (entitled !== undefined && entitled !== null) t.entitled = Number(entitled);
    t.adjust = (Number(t.adjust) || 0) + Number(adjustDelta || 0);
    cur.types[typeId] = t;
    tx.set(r, { ...cur, updatedAt: serverTimestamp() });
    tx.set(doc(col('balance_ledger')), { email, year: Number(year), type: typeId, delta: Number(adjustDelta || 0), entitled: t.entitled, reason: note || 'manual', by: session.email, at: serverTimestamp() });
  });
}

// ---------- schedules ----------
export const scheduleId = (email, ymStr) => `${email}_${ymStr}`;
export const getSchedule = (email, ymStr) => read('schedules', scheduleId(email, ymStr)).catch(() => null);
export async function setScheduleDay(email, date, value) {
  const id = scheduleId(email, date.slice(0, 7));
  const r = doc(db, 'schedules', id);
  const snap = await getDoc(r);
  const days = { ...((snap.exists() && snap.data().days) || {}) };
  if (value) days[date] = value; else delete days[date];
  const p = person(email) || {};
  await setDoc(r, { email, month: date.slice(0, 7), leaderEmail: p.leaderEmail || '', days, updatedAt: serverTimestamp() });
}

// ---------- queries ----------
export function watchMyRequests(cb) {
  return watch(query(col('requests'), where('email', '==', session.email)), rows => cb(sortReq(rows)));
}
export const sortReq = (rows) => rows.sort((a, b) => (toMs(b.createdAt) || b.createdMs || 0) - (toMs(a.createdAt) || a.createdMs || 0));
/** Requests waiting for me */
export function watchInbox(cb) {
  const lists = {};
  const emit = () => {
    const map = new Map();
    Object.values(lists).flat().forEach(r => map.set(r.id, r));
    cb(sortReq([...map.values()]).filter(r => r.email !== session.email || isHR()));
  };
  const unsubs = [];
  unsubs.push(watch(query(col('requests'), where('leaderEmail', '==', session.email), where('status', '==', 'pending_leader')), rows => { lists.leader = rows; emit(); }));
  if (isHR()) unsubs.push(watch(query(col('requests'), where('status', '==', 'pending_hr')), rows => { lists.hr = rows; emit(); }));
  if (isFinanceUser()) unsubs.push(watch(query(col('requests'), where('status', '==', 'pending_finance')), rows => { lists.fin = rows; emit(); }));
  return () => unsubs.forEach(u => u && u());
}
function isFinanceUser() {
  const p = session.profile || {};
  return session.role === 'finance' || session.role === 'admin' || !!(p.permissions && p.permissions.payroll);
}
/** History for managers: requests of my team (leader) or everyone (HR) in a date window */
export function watchManaged(fromYmd, cb) {
  const f = [where('startDate', '>=', fromYmd)];
  const q = isHR() ? query(col('requests'), ...f) : query(col('requests'), where('leaderEmail', '==', session.email), ...f);
  return watch(q, rows => cb(sortReq(rows)));
}
export function requestsInRange(from, to, email, leaderEmail) {
  const f = [where('startDate', '<=', to)];
  if (email) f.unshift(where('email', '==', email));
  if (leaderEmail) f.unshift(where('leaderEmail', '==', leaderEmail));
  return list(query(col('requests'), ...f)).then(rows => rows.filter(r => (r.endDate || r.startDate) >= from));
}

// ---------- approvers ----------
export function approversFor(stage, req) {
  if (stage === 'leader') return req.leaderEmail ? [req.leaderEmail] : [];
  if (stage === 'hr') return activePeople().filter(p => p.role === 'hr' || p.role === 'supervisor' || p.role === 'admin').map(p => p.email);
  if (stage === 'finance') return activePeople().filter(p => p.role === 'finance' || p.role === 'admin' || (p.permissions && p.permissions.payroll)).map(p => p.email);
  return [];
}

// ---------- submit ----------
async function schedulesFor(email, from, to) {
  const months = [...new Set(dateRange(from, to).map(d => d.slice(0, 7)))];
  const out = {};
  await Promise.all(months.map(async m => { out[m] = await getSchedule(email, m); }));
  return out;
}
export async function countWorkingDays(email, from, to) {
  const sch = await schedulesFor(email, from, to);
  return dateRange(from, to).filter(d => { const p = planFor(d, sch[d.slice(0, 7)]); return p.mode !== 'off' && p.mode !== 'holiday'; }).length;
}
async function overlapping(email, from, to, types) {
  const mine = await list(query(col('requests'), where('email', '==', email)));
  return mine.filter(r => types.includes(r.type) && !['rejected', 'cancelled'].includes(r.status) && (r.startDate <= to) && ((r.endDate || r.startDate) >= from));
}

export async function submitRequest(input) {
  const me = session.profile || {};
  const email = session.email;
  const type = input.type;
  const req = {
    email, name: me.name || email, leaderEmail: me.leaderEmail || '', department: me.department || '',
    type, reason: (input.reason || '').slice(0, 2000), createdMs: now(), createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  };
  if (['leave', 'remote', 'mission'].includes(type)) {
    if (!input.startDate || !input.endDate) throw userError('اختار تاريخ البداية والنهاية.', 'Choose start and end dates.');
    if (input.endDate < input.startDate) throw userError('تاريخ النهاية لازم يكون بعد البداية.', 'End date must be after the start date.');
    req.startDate = input.startDate; req.endDate = input.endDate;
    req.days = await countWorkingDays(email, input.startDate, input.endDate);
    if (!req.days) throw userError('الفترة دي كلها إجازات أو عطلات.', 'This period has no working days.');
    const clash = await overlapping(email, input.startDate, input.endDate, ['leave', 'remote', 'mission']);
    if (clash.length) throw userError('عندك طلب تاني في نفس الأيام دي.', 'You already have another request on these dates.');
  }
  if (type === 'leave') {
    const lt = leaveType(input.leaveType);
    req.leaveType = lt.id;
    if (!lt.unlimited && lt.paid !== false) {
      const bal = await getBalance(email, Number(input.startDate.slice(0, 4)));
      const left = remaining(bal.types[lt.id] || { entitled: 0 });
      if (req.days > left) throw userError(`رصيدك المتاح ${left} يوم بس، والطلب ${req.days} يوم.`, `Only ${left} days available, request is ${req.days}.`);
    }
    if (lt.attachment && !input.attachmentData) throw userError('النوع ده محتاج مرفق (مثلاً تقرير طبي).', 'This leave type requires an attachment.');
  }
  if (type === 'remote') {
    const monthKey = input.startDate.slice(0, 7);
    const quota = Number(me.remoteQuota ?? policy.defaultRemoteQuota);
    const used = (await list(query(col('requests'), where('email', '==', email))))
      .filter(r => r.type === 'remote' && !['rejected', 'cancelled'].includes(r.status) && (r.startDate || '').slice(0, 7) === monthKey)
      .reduce((s, r) => s + (r.days || 0), 0);
    req.quotaWarning = used + req.days > quota;
    req.quotaUsedBefore = used; req.quota = quota;
  }
  if (type === 'excuse') {
    if (!input.date || !input.fromTime || !input.toTime) throw userError('حدد اليوم والوقت.', 'Choose the day and time.');
    const [fh, fm] = input.fromTime.split(':').map(Number), [th, tm] = input.toTime.split(':').map(Number);
    const mins = (th * 60 + tm) - (fh * 60 + fm);
    if (mins <= 0) throw userError('وقت النهاية لازم يكون بعد البداية.', 'End time must be after start time.');
    req.startDate = input.date; req.endDate = input.date; req.excuseKind = input.excuseKind || 'late';
    req.fromTime = input.fromTime; req.toTime = input.toTime; req.minutes = mins;
    const monthKey = input.date.slice(0, 7);
    const used = (await list(query(col('requests'), where('email', '==', email))))
      .filter(r => r.type === 'excuse' && !['rejected', 'cancelled'].includes(r.status) && (r.startDate || '').slice(0, 7) === monthKey)
      .reduce((s, r) => s + (r.minutes || 0), 0);
    const cap = Number(policy.excuseHoursPerMonth || 0) * 60;
    if (cap && used + mins > cap) throw userError(`تخطيت الحد الشهري للأذونات (${policy.excuseHoursPerMonth} ساعات).`, `Monthly permission limit exceeded (${policy.excuseHoursPerMonth} hours).`);
  }
  if (type === 'correction') {
    if (!input.date) throw userError('حدد اليوم.', 'Choose the day.');
    req.startDate = input.date; req.endDate = input.date;
    req.correction = { checkIn: input.checkIn || '', checkOut: input.checkOut || '', mode: input.mode || '' };
  }
  if (type === 'advance') {
    const amount = Number(input.amount);
    if (!(amount > 0)) throw userError('اكتب مبلغ صحيح.', 'Enter a valid amount.');
    req.amount = amount; req.installments = Math.max(1, Math.min(24, Number(input.installments) || 1));
    req.startDate = ymd(now());
    req.startMonth = input.startMonth || '';
  }
  if (type === 'letter') { req.letterKind = input.letterKind || 'employment'; req.addressedTo = input.addressedTo || ''; req.startDate = ymd(now()); }
  if (!req.startDate) req.startDate = ymd(now());

  req.status = firstStatus(type, me);
  req.stages = stagesFor(type, me);
  req.history = [{ at: now(), by: email, byName: req.name, action: 'submitted', note: '' }];

  const r = doc(col('requests'));
  if (input.attachmentData) {
    const aRef = doc(col('attachments'));
    await setDoc(aRef, { owner: email, leaderEmail: req.leaderEmail, requestId: r.id, name: input.attachmentName || 'file', data: input.attachmentData, createdAt: serverTimestamp() });
    req.attachmentId = aRef.id;
  }
  await setDoc(r, req);
  if (req.status === 'approved') await applyApproval(r.id);
  else {
    const stage = req.status.replace('pending_', '');
    await notifyMany(approversFor(stage, req), L(`طلب جديد: ${typeLabel(type)}`, `New request: ${typeLabel(type)}`), `${req.name}`, '#/approvals');
  }
  return r.id;
}

export async function cancelRequest(id) {
  const r = await read('requests', id);
  if (!r || !String(r.status).startsWith('pending')) throw userError('مينفعش تلغي طلب اتقفل.', 'Only pending requests can be cancelled.');
  await updateDoc(doc(db, 'requests', id), {
    status: 'cancelled', updatedAt: serverTimestamp(),
    history: arrayUnion({ at: now(), by: session.email, byName: (session.profile || {}).name || session.email, action: 'cancelled', note: '' })
  });
}

// ---------- decide ----------
export async function decide(id, action, note = '') {
  const r = await read('requests', id);
  if (!r) throw userError('الطلب مش موجود.', 'Request not found.');
  if (!String(r.status).startsWith('pending')) throw userError('الطلب ده اتقفل بالفعل.', 'This request was already closed.');
  const stage = r.status.replace('pending_', '');
  const entry = { at: now(), by: session.email, byName: (session.profile || {}).name || session.email, action: action === 'approve' ? `approved_${stage}` : `rejected_${stage}`, note };
  if (action === 'reject') {
    await updateDoc(doc(db, 'requests', id), { status: 'rejected', updatedAt: serverTimestamp(), history: arrayUnion(entry), decidedBy: session.email });
    await notify(r.email, L(`تم رفض طلبك: ${typeLabel(r.type)}`, `Request rejected: ${typeLabel(r.type)}`), note || '', '#/requests');
    return 'rejected';
  }
  const requester = person(r.email) || { leaderEmail: r.leaderEmail };
  const next = nextStatusFromStages(r);
  if (next !== 'approved') {
    await updateDoc(doc(db, 'requests', id), { status: next, updatedAt: serverTimestamp(), history: arrayUnion(entry) });
    const nextStage = next.replace('pending_', '');
    await notifyMany(approversFor(nextStage, r), L(`طلب محتاج موافقتك: ${typeLabel(r.type)}`, `Request needs your approval: ${typeLabel(r.type)}`), r.name, '#/approvals');
    await notify(r.email, L('طلبك اتنقل للمرحلة التالية', 'Your request moved forward'), `${typeLabel(r.type)} — ${statusLabel(next)}`, '#/requests');
    return next;
  }
  await applyApproval(id, entry);
  return 'approved';
}
function nextStatusFromStages(r) {
  const stages = Array.isArray(r.stages) && r.stages.length ? r.stages : stagesFor(r.type, { leaderEmail: r.leaderEmail });
  const cur = r.status.replace('pending_', '');
  const i = stages.indexOf(cur);
  return i >= 0 && i < stages.length - 1 ? `pending_${stages[i + 1]}` : 'approved';
}

/** Final approval + its effects, atomically where it matters. */
export async function applyApproval(id, entry) {
  const r0 = await read('requests', id);
  const email = r0.email;
  const dates = r0.startDate && r0.endDate ? dateRange(r0.startDate, r0.endDate) : [];
  const months = [...new Set(dates.map(d => d.slice(0, 7)))];
  const year = Number((r0.startDate || ymd(now())).slice(0, 4));
  const owner = person(email) || {};

  await runTransaction(db, async (tx) => {
    const reqRef = doc(db, 'requests', id);
    const r = (await tx.get(reqRef)).data();
    if (!r || (r.status !== 'approved' && !String(r.status).startsWith('pending'))) throw userError('الطلب اتقفل.', 'Request already closed.');
    // reads first
    const schedSnaps = {};
    if (['leave', 'remote', 'mission'].includes(r.type)) {
      for (const m of months) schedSnaps[m] = await tx.get(doc(db, 'schedules', scheduleId(email, m)));
    }
    let balSnap = null;
    const lt = r.type === 'leave' ? leaveType(r.leaveType) : null;
    if (lt) balSnap = await tx.get(doc(db, 'balances', balanceId(email, year)));

    // effects
    if (lt) {
      const bal = normalizeBalance(balSnap.exists() ? balSnap.data() : null, email, year);
      const t = bal.types[lt.id] || { entitled: 0, used: 0, adjust: 0 };
      if (!lt.unlimited && lt.paid !== false && remaining(t) < (r.days || 0)) throw userError(`رصيد الموظف مش كفاية (${remaining(t)} يوم).`, `Insufficient balance (${remaining(t)} days).`);
      t.used = (Number(t.used) || 0) + (r.days || 0);
      bal.types[lt.id] = t;
      tx.set(doc(db, 'balances', balanceId(email, year)), { ...bal, updatedAt: serverTimestamp() });
      tx.set(doc(col('balance_ledger')), { email, year, type: lt.id, delta: -(r.days || 0), reason: 'request', requestId: id, by: session.email, at: serverTimestamp() });
    }
    if (['leave', 'remote', 'mission'].includes(r.type)) {
      const mode = r.type === 'leave' ? 'leave' : r.type;
      for (const m of months) {
        const snap = schedSnaps[m];
        const days = { ...((snap.exists() && snap.data().days) || {}) };
        dates.filter(d => d.slice(0, 7) === m).forEach(d => {
          const p = planFor(d, { days });
          if (p.mode === 'off' || p.mode === 'holiday') return;
          days[d] = { mode, requestId: id, ...(r.leaveType ? { leaveType: r.leaveType } : {}), ...(p.start ? { start: p.start, end: p.end } : {}) };
        });
        tx.set(doc(db, 'schedules', scheduleId(email, m)), { email, month: m, leaderEmail: owner.leaderEmail || r.leaderEmail || '', days, updatedAt: serverTimestamp() });
      }
    }
    if (r.type === 'advance') {
      tx.set(doc(db, 'advances', id), {
        email, name: r.name, amount: r.amount, installments: r.installments, perMonth: Math.round((r.amount / r.installments) * 100) / 100,
        startMonth: r.startMonth || ymd(now()).slice(0, 7), paid: 0, status: 'active', createdAt: serverTimestamp()
      });
    }
    const upd = { status: 'approved', updatedAt: serverTimestamp(), approvedBy: session.email, approvedAt: serverTimestamp() };
    if (entry) upd.history = arrayUnion(entry);
    tx.update(reqRef, upd);
  });

  // effects outside the transaction
  if (r0.type === 'remote' && dates.includes(ymd(now()))) {
    try {
      await setDoc(doc(db, 'attendance_days', `${email}_${ymd(now())}`), { remotePending: false, updatedAt: serverTimestamp() }, { merge: true });
      await updateDoc(doc(db, 'users', email), { remotePending: false });
    } catch (e) { console.warn('remote flag', e && e.message); }
  }
  if (r0.type === 'correction' && r0.correction) {
    const c = r0.correction;
    await correctDay(email, r0.startDate, {
      checkInMs: c.checkIn ? cairoMs(r0.startDate, c.checkIn) : undefined,
      checkOutMs: c.checkOut ? cairoMs(r0.startDate, c.checkOut) : undefined,
      workMs: c.checkIn && c.checkOut ? Math.max(0, cairoMs(r0.startDate, c.checkOut) - cairoMs(r0.startDate, c.checkIn)) : undefined,
      mode: c.mode || undefined, note: L('طلب تصحيح معتمد', 'Approved correction request') + (r0.reason ? ` — ${r0.reason}` : '')
    });
  }
  await notify(email, L(`تم اعتماد طلبك: ${typeLabel(r0.type)}`, `Request approved: ${typeLabel(r0.type)}`), r0.startDate || '', '#/requests');
}

/** HR: revoke an approved leave/remote/mission (returns balance, clears schedule) */
export async function revokeRequest(id, note = '') {
  const r0 = await read('requests', id);
  if (!r0 || r0.status !== 'approved') throw userError('الطلب مش معتمد.', 'Request is not approved.');
  const email = r0.email;
  const dates = r0.startDate && r0.endDate ? dateRange(r0.startDate, r0.endDate) : [];
  const months = [...new Set(dates.map(d => d.slice(0, 7)))];
  const year = Number((r0.startDate || '').slice(0, 4)) || new Date().getFullYear();
  await runTransaction(db, async (tx) => {
    const schedSnaps = {};
    for (const m of months) schedSnaps[m] = await tx.get(doc(db, 'schedules', scheduleId(email, m)));
    const balRef = doc(db, 'balances', balanceId(email, year));
    const balSnap = r0.type === 'leave' ? await tx.get(balRef) : null;
    if (r0.type === 'leave') {
      const bal = normalizeBalance(balSnap.exists() ? balSnap.data() : null, email, year);
      const t = bal.types[r0.leaveType] || { entitled: 0, used: 0, adjust: 0 };
      t.used = Math.max(0, (Number(t.used) || 0) - (r0.days || 0));
      bal.types[r0.leaveType] = t;
      tx.set(balRef, { ...bal, updatedAt: serverTimestamp() });
      tx.set(doc(col('balance_ledger')), { email, year, type: r0.leaveType, delta: r0.days || 0, reason: 'revoked', requestId: id, by: session.email, at: serverTimestamp() });
    }
    for (const m of months) {
      const snap = schedSnaps[m]; if (!snap.exists()) continue;
      const days = { ...(snap.data().days || {}) };
      Object.keys(days).forEach(d => { if (days[d] && days[d].requestId === id) delete days[d]; });
      tx.set(doc(db, 'schedules', scheduleId(email, m)), { ...snap.data(), days, updatedAt: serverTimestamp() });
    }
    tx.update(doc(db, 'requests', id), {
      status: 'cancelled', updatedAt: serverTimestamp(),
      history: arrayUnion({ at: now(), by: session.email, byName: (session.profile || {}).name || session.email, action: 'revoked', note })
    });
  });
  await notify(email, L(`تم إلغاء طلب معتمد: ${typeLabel(r0.type)}`, `Approved request revoked: ${typeLabel(r0.type)}`), note, '#/requests');
}

export async function setResponse(id, text) {
  await updateDoc(doc(db, 'requests', id), { response: text, updatedAt: serverTimestamp() });
}
export const getAttachment = (id) => read('attachments', id);
