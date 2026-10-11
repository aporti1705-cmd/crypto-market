export const settings = { currency: 'usd' };

export const $ = (sel, root = document) => root.querySelector(sel);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const isNum = Number.isFinite;
export const clamp = (x, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, x));
export const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export function money(v, currency = settings.currency) {
  if (!isNum(v)) return '–';
  const a = Math.abs(v);
  const digits = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 8;
  return new Intl.NumberFormat('de-DE', {
    style: 'currency', currency: currency.toUpperCase(),
    minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits,
  }).format(v);
}

export function compact(v, currency = settings.currency) {
  if (!isNum(v)) return '–';
  return new Intl.NumberFormat('de-DE', {
    style: 'currency', currency: currency.toUpperCase(), notation: 'compact', maximumFractionDigits: 2,
  }).format(v);
}

// Ein Formatierer je Stellenzahl – toLocaleString legt sonst bei jedem Aufruf einen neuen an (rund 50-mal langsamer)
const formats = new Map();
const format = (d) => {
  let f = formats.get(d);
  if (!f) { f = new Intl.NumberFormat('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }); formats.set(d, f); }
  return f;
};
export const num = (v, d = 1) => (isNum(v) ? format(d).format(v) : '–');

// Vorzeichen nach dem Runden: aus -0,04 wird bei 0 Stellen „0“, nicht „-0“
export function signed(v, d = 1) {
  if (!isNum(v)) return '–';
  const r = Number(v.toFixed(d));
  return (r > 0 ? '+' : '') + num(r === 0 ? 0 : v, d);
}

export const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'muted');

export function pct(v, d = 2) {
  if (!isNum(v)) return '<span class="muted">–</span>';
  return `<span class="${tone(v)}">${signed(v, d)} %</span>`;
}
