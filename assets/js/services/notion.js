// Import from Notion: reads the exported zip files (or their CSV files), finds the Clients, Projects and Tasks
// tables by their columns, and writes them as tk_clients / tk_projects / tasks. Running it again skips what was
// already imported (each record carries a notionKey). People are matched to accounts; a person without an
// account keeps their name on the task (pendingAssignee) until the admin links it to a new account.
import { db, doc, col, writeBatch, serverTimestamp, Timestamp } from '../core/fb.js';
import { session, now, isAdmin, isPM } from '../core/session.js';
import { userError } from '../core/ui.js';
import { L, cairoMs } from '../core/utils.js';
import { person } from './directory.js';
import { allTasks, allProjects, allClients, nextNums, guessPerson } from './tasks.js';
import { track } from './activity.js';

// ---------- reading ----------
let zipLib = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!zipLib) zipLib = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = () => res(window.JSZip); s.onerror = () => rej(userError('مقدرتش أفتح ملف الـ zip. جرّب ترفع ملفات الـ CSV نفسها.', 'Could not open the zip. Try uploading the CSV files instead.'));
    document.head.appendChild(s);
  });
  return zipLib;
}
/** RFC-4180 CSV → array of objects (handles quotes, commas and new lines inside quotes, BOM) */
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const t = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim());
  return rows.filter(r => r.some(x => String(x).trim())).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}
const kindOf = (cols) => cols.includes('Client Name') ? 'clients' : (cols.includes('Project Name') ? 'projects' : (cols.includes('Task Name') && cols.includes('Owner') ? 'tasks' : null));

/** files (zip or csv) → { clients: [], projects: [], tasks: [] } (the "_all" export wins over the view export) */
export async function readFiles(files) {
  const found = { clients: null, projects: null, tasks: null };
  const consider = (name, text) => {
    const rows = parseCsv(text); if (!rows.length) return;
    const k = kindOf(Object.keys(rows[0])); if (!k) return;
    const all = /_all\.csv$/i.test(name);
    if (!found[k] || (all && !found[k].all) || (all === found[k].all && rows.length > found[k].rows.length)) found[k] = { rows, all, name };
  };
  for (const f of files) {
    if (/\.csv$/i.test(f.name)) consider(f.name, await f.text());
    else if (/\.zip$/i.test(f.name)) {
      const JSZip = await loadJSZip();
      const z = await JSZip.loadAsync(f);
      const entries = Object.values(z.files).filter(e => !e.dir && /\.csv$/i.test(e.name) && !e.name.includes('/'));
      for (const e of entries) {
        const head = (await e.async('string')).slice(0, 400);
        if (/Client Name|Project Name|Task Name/.test(head)) consider(e.name, await e.async('string'));
      }
    }
  }
  return { clients: found.clients ? found.clients.rows : [], projects: found.projects ? found.projects.rows : [], tasks: found.tasks ? found.tasks.rows : [] };
}

// ---------- values ----------
/** "Shehata (https://…), Mohey (https://…)" → ['Shehata', 'Mohey'] */
export function names(v) {
  const s = String(v || '').trim(); if (!s) return [];
  const linked = [...s.matchAll(/([^,()]+?)\s*\(https?:\/\/[^)]*\)/g)].map(m => m[1].trim()).filter(Boolean);
  return [...new Set(linked.length ? linked : s.split(',').map(x => x.trim()).filter(Boolean))];
}
const one = (v) => names(v)[0] || '';
const clean = (v) => String(v || '').replace(/\s*\(https?:\/\/[^)]*\)/g, '').trim();
/** "August 10, 2026" (or "August 10, 2026 → August 12, 2026") → "2026-08-10" */
export function day(v) {
  const s = String(v || '').split('→')[0].trim(); if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s.replace(/\s+\d{1,2}:\d{2}.*$/, ''));
  return isNaN(d) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const STATUS_MAP = { 'not started': 'new', 'to do': 'new', 'todo': 'new', 'in progress': 'in_progress', 'doing': 'in_progress', 'review': 'review', 'in review': 'review', 'on hold': 'hold', 'blocked': 'hold', 'done': 'done', 'completed': 'done', 'complete': 'done' };
const PRIO_MAP = { low: 'normal', medium: 'normal', normal: 'normal', high: 'high', urgent: 'urgent', critical: 'urgent' };
const keyOf = (...parts) => parts.map(x => String(x || '').trim().toLowerCase()).join('|').slice(0, 300);

/** everyone named in the export, with a suggested account */
export function peopleIn(data) {
  const m = new Map();
  const add = (n, k) => { if (!n) return; const x = m.get(n) || { name: n, tasks: 0, projects: 0 }; x[k]++; m.set(n, x); };
  data.tasks.forEach(r => names(r.Owner).forEach(n => add(n, 'tasks')));
  data.projects.forEach(r => { names(r['Owner/PM']).forEach(n => add(n, 'projects')); names(r['Project Team']).forEach(n => add(n, 'projects')); });
  return [...m.values()].sort((a, b) => b.tasks - a.tasks || b.projects - a.projects).map(x => { const g = guessPerson(x.name); return { ...x, email: g ? g.email : '' }; });
}

/** what will be written — used for the preview and for the import itself */
export function plan(data, mapping) {
  const mapName = (n) => mapping[n] || '';
  const haveC = new Set(allClients().map(c => c.notionKey || keyOf('c', c.name)));
  const haveP = new Set(allProjects().map(p => p.notionKey || keyOf('p', p.name)));
  const haveT = new Set(allTasks().map(t => t.notionKey).filter(Boolean));
  const clients = data.clients.map(r => {
    const name = clean(r['Client Name']);
    const notes = [r['Point of Contact'] ? L(`مسؤول الحساب: ${names(r['Point of Contact']).join('، ')}`, `Account owner: ${names(r['Point of Contact']).join(', ')}`) : '', r.Satisfaction ? L(`الرضا: ${r.Satisfaction}`, `Satisfaction: ${r.Satisfaction}`) : '', r.Status ? L(`الحالة: ${r.Status}`, `Status: ${r.Status}`) : '', r.Notes || ''].filter(Boolean).join('\n');
    return { notionKey: keyOf('c', name), name, notes };
  }).filter(c => c.name);
  const projects = data.projects.map(r => {
    const name = clean(r['Project Name']);
    const leadName = one(r['Owner/PM']), team = names(r['Project Team']);
    const desc = [
      r.Type && L(`النوع: ${r.Type}`, `Type: ${r.Type}`), r['Current Phase'] && L(`المرحلة: ${r['Current Phase']}`, `Phase: ${r['Current Phase']}`), r.Health && L(`الحالة الصحية: ${clean(r.Health)}`, `Health: ${clean(r.Health)}`),
      r['Project Code'] && L(`كود المشروع: ${r['Project Code']}`, `Project code: ${r['Project Code']}`),
      r['Change Requests'] && `${L('طلبات تعديل', 'Change requests')}: ${names(r['Change Requests']).join('، ')}`, r.Risks && `${L('مخاطر', 'Risks')}: ${names(r.Risks).join('، ')}`
    ].filter(Boolean).join('\n');
    return { notionKey: keyOf('p', name), name, clientName: clean(one(r.Client)), leader: mapName(leadName), pendingLeader: leadName && !mapName(leadName) ? leadName : '',
      members: [...new Set(team.map(mapName).filter(Boolean))], pendingMembers: team.filter(n => !mapName(n)),
      start: day(r['Start Date']), end: day(r['Delivery Date']), status: /handover|closed|done|complete/i.test(r['Current Phase'] || '') ? 'done' : 'active', description: desc };
  }).filter(p => p.name);
  const tasks = [];
  data.tasks.forEach(r => {
    const title = clean(r['Task Name']); if (!title) return;
    const owners = names(r.Owner);
    const st = STATUS_MAP[String(r.Status || '').trim().toLowerCase()] || (r['Done?'] === '1' || /yes|true/i.test(r['Done?'] || '') ? 'done' : 'new');
    const extra = [
      r.Department && `${L('القسم', 'Department')}: ${r.Department}`, r.Phase && `${L('المرحلة', 'Phase')}: ${r.Phase}`, r.Week && `${L('الأسبوع', 'Week')}: ${r.Week}`,
      r.SERP && `SERP: ${r.SERP}`, r['Start Date'] && `${L('البداية', 'Start')}: ${day(r['Start Date'])}`,
      r['Review Link'] && `${L('المراجعة', 'Review')}: ${r['Review Link']}`, r.Sheets && `${L('الشيت', 'Sheet')}: ${r.Sheets}`
    ].filter(Boolean).join('\n');
    (owners.length ? owners : ['']).forEach(owner => {
      const notionKey = keyOf('t', title, one(r.Project), day(r['Due Date']), day(r['Start Date']), owner);
      tasks.push({ notionKey, title: title.slice(0, 200), owner, assignee: mapName(owner), pendingAssignee: owner && !mapName(owner) ? owner : '', status: st,
        priority: PRIO_MAP[String(r.Priority || '').trim().toLowerCase()] || 'normal', due: day(r['Due Date']), projectName: clean(one(r.Project)), details: extra, exists: haveT.has(notionKey) });
    });
  });
  return {
    clients: clients.map(c => ({ ...c, exists: haveC.has(c.notionKey) || allClients().some(x => x.name.trim() === c.name) })),
    projects: projects.map(p => ({ ...p, exists: haveP.has(p.notionKey) || allProjects().some(x => x.name.trim() === p.name) })),
    tasks
  };
}

/** write the plan; onProgress(text, 0..1) */
export async function runImport(pl, onProgress = () => {}) {
  if (!(isAdmin() || isPM())) throw userError('الاستيراد للأدمن ومدير المشروعات.', 'Only admins and project managers can import.');
  const cByName = new Map(allClients().map(c => [c.name.trim(), c]));
  const pByName = new Map(allProjects().map(p => [p.name.trim(), p]));
  const res = { clients: 0, projects: 0, tasks: 0, pending: 0 };
  // clients
  let b = writeBatch(db);
  for (const c of pl.clients.filter(x => !x.exists)) {
    const ref = doc(col('tk_clients'));
    const d = { name: c.name, company: '', contact: '', phone: '', email: '', notes: c.notes, notionKey: c.notionKey, createdBy: session.email, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    b.set(ref, d); cByName.set(c.name, { id: ref.id, ...d }); res.clients++;
  }
  await b.commit(); onProgress(L('العملاء', 'Clients'), 0.1);
  // projects
  b = writeBatch(db);
  for (const p of pl.projects.filter(x => !x.exists)) {
    const c = cByName.get(p.clientName);
    const ref = doc(col('tk_projects'));
    const d = { name: p.name, clientId: c ? c.id : '', clientName: c ? c.name : p.clientName, leader: p.leader, pendingLeader: p.pendingLeader, members: p.members, pendingMembers: p.pendingMembers,
      start: p.start, end: p.end, status: p.status, description: p.description, color: '#1b1bdb', notionKey: p.notionKey, createdBy: session.email, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    b.set(ref, d); pByName.set(p.name, { id: ref.id, ...d }); res.projects++;
  }
  await b.commit(); onProgress(L('المشاريع', 'Projects'), 0.2);
  // tasks
  const todo = pl.tasks.filter(t => !t.exists);
  if (todo.length) {
    const nums = await nextNums(todo.length);
    for (let i = 0; i < todo.length; i += 400) {
      b = writeBatch(db);
      todo.slice(i, i + 400).forEach((t, k) => {
        const pr = pByName.get(t.projectName);
        const leader = t.assignee ? ((person(t.assignee) || {}).leaderEmail || '') : '';
        const doneMs = t.status === 'done' ? (t.due ? cairoMs(t.due, '12:00') : now()) : null;     // finished → archived on its due day
        const hist = [{ by: session.email, from: '', to: 'new', at: now(), note: L('استيراد من Notion', 'Imported from Notion') }];
        if (t.status !== 'new') hist.push({ by: session.email, from: 'new', to: t.status, at: doneMs || now(), note: 'Notion' });
        b.set(doc(col('tasks')), {
          num: nums[i + k], title: t.title, details: t.details, priority: t.priority, due: t.due, status: t.status,
          assignee: t.assignee, pendingAssignee: t.pendingAssignee, leader, createdBy: session.email,
          projectId: pr ? pr.id : '', projectName: pr ? pr.name : t.projectName, clientId: pr ? pr.clientId || '' : '', clientName: pr ? pr.clientName || '' : '',
          checklist: [], commentsCount: 0, doneAt: doneMs ? Timestamp.fromMillis(doneMs) : null, doneNote: '', returnReason: '', holdReason: '',
          history: hist, notionKey: t.notionKey, source: 'notion', createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
        res.tasks++; if (t.pendingAssignee) res.pending++;
      });
      await b.commit();
      onProgress(L('التاسكات', 'Tasks'), 0.2 + 0.8 * Math.min(1, (i + 400) / todo.length));
    }
  }
  track('notion.import', { detail: `${res.clients} / ${res.projects} / ${res.tasks}` });
  return res;
}
