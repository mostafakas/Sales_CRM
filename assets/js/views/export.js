// Excel export (SheetJS loaded on demand) with CSV fallback.
import { downloadText, isAr, L } from '../core/utils.js';
import { toast } from '../core/ui.js';

let loading = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!loading) loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('xlsx')));
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return loading;
}
function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '﻿' + [cols.map(q).join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\n');
}
/** sheets: [{ name, rows: [{col: value}] }] */
export async function exportSheet(filename, sheets) {
  try {
    const X = await loadXLSX();
    const wb = X.utils.book_new();
    sheets.forEach(s => X.utils.book_append_sheet(wb, X.utils.json_to_sheet(s.rows.length ? s.rows : [{}]), String(s.name).slice(0, 30)));
    if (isAr) wb.Workbook = { Views: [{ RTL: true }] };
    X.writeFile(wb, `${filename}.xlsx`);
  } catch (e) {
    console.warn('xlsx unavailable, CSV fallback', e);
    downloadText(`${filename}.csv`, toCSV(sheets[0] ? sheets[0].rows : []), 'text/csv;charset=utf-8');
    toast(L('اتنزل كملف CSV', 'Downloaded as CSV'), '', 'info');
  }
}
