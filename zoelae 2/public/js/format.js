// Small formatting helpers, carried over from the v1 prototype.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

export const money = (n, currency = 'EUR') => {
  if (n === null || n === undefined || n === '') return '—';
  const symbol = { EUR: '€', GBP: '£', USD: '$' }[currency] || '';
  return symbol + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 });
};

export const initials = (name) => (name || '')
  .trim().split(/\s+/).slice(0, 2).map(p => p[0] ? p[0].toUpperCase() : '').join('') || '·';

export const thisYear = new Date().getFullYear();

export function ageLabel(year) {
  if (year == null) return '';
  const age = thisYear - year;
  return age <= 0 ? 'this year' : age + (age === 1 ? ' yr old' : ' yrs old');
}

/** A piece can be owned without its year being known, so every year display goes through these. */
export const yearLabel = (year) => (year == null ? 'Year unknown' : String(year));

export const yearAndAge = (year) => (year == null ? 'Year unknown' : `${year} · ${ageLabel(year)}`);

export const byline = (artist, year) => (year == null ? artist : `${artist}, ${year}`);

export const dateLabel = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

export const shortDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const dateTimeLabel = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const fileSize = (bytes) => {
  if (!bytes) return '';
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
};

export const STATUS_LABEL = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
  limit_reached: 'View limit reached'
};

export const DOC_KIND_LABEL = {
  certificate: 'Certificate of authenticity',
  appraisal: 'Appraisal',
  invoice: 'Invoice',
  condition_report: 'Condition report',
  other: 'Document'
};
