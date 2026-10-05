const API = 'https://api.coingecko.com/api/v3/coins/markets';
const REFRESH_MS = 60_000;
const CACHE_KEY = 'krypto-markt-cache';

const state = { currency: 'eur', coins: [], query: '', filter: 'all', open: null, updated: null };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// ---------- Formatierung ----------

function money(v) {
  if (!Number.isFinite(v)) return '–';
  const digits = v >= 1000 ? 0 : v >= 1 ? 2 : v >= 0.01 ? 4 : 8;
  return new Intl.NumberFormat('de-DE', {
    style: 'currency', currency: state.currency.toUpperCase(),
    minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits,
  }).format(v);
}

function compact(v) {
  if (!Number.isFinite(v)) return '–';
  return new Intl.NumberFormat('de-DE', {
    style: 'currency', currency: state.currency.toUpperCase(),
    notation: 'compact', maximumFractionDigits: 2,
  }).format(v);
}

function pct(v) {
  if (!Number.isFinite(v)) return '<span class="muted">–</span>';
  const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'muted';
  const txt = (v > 0 ? '+' : '') + v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' %';
  return `<span class="${cls}">${txt}</span>`;
}

const num1 = (v) => v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// ---------- Analyse ----------

const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// RSI nach Wilder
function rsi(prices, period = 14) {
  if (prices.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function analyse(coin) {
  const prices = (coin.sparkline_in_7d?.price || []).filter(Number.isFinite);
  const none = (label, text) => ({ signal: 'none', label, outlook: label, text, reasons: [], score: null });
  if (prices.length < 60) return none('Keine Daten', 'Zu wenig Kursdaten für eine Auswertung.');

  const last = prices[prices.length - 1];
  const min = Math.min(...prices), max = Math.max(...prices);
  if ((max - min) / last < 0.02) return none('Stablecoin', 'Kurs ist an einen festen Wert gebunden – kein Signal.');

  // Stundenkurse auf 4-Stunden-Kerzen ausdünnen, damit der RSI weniger rauscht
  const fourHour = prices.filter((_, i) => (prices.length - 1 - i) % 4 === 0);
  const r = rsi(fourHour);
  const trend = (avg(prices.slice(-24)) / avg(prices) - 1) * 100;
  const d1 = coin.price_change_percentage_24h_in_currency;
  const d30 = coin.price_change_percentage_30d_in_currency;

  const reasons = [];
  const add = (pts, text) => reasons.push({ pts, text });

  if (r !== null) {
    const v = `RSI ${num1(r)}`;
    if (r < 30) add(2, `${v} – stark überverkauft, Erholung wahrscheinlicher`);
    else if (r < 40) add(1, `${v} – eher überverkauft`);
    else if (r > 70) add(-2, `${v} – stark überkauft, Rücksetzer wahrscheinlicher`);
    else if (r > 60) add(-1, `${v} – eher überkauft`);
    else add(0, `${v} – neutral`);
  }

  if (trend > 1.5) add(1.5, `Aufwärtstrend: 24-h-Schnitt ${num1(trend)} % über dem 7-Tage-Schnitt`);
  else if (trend < -1.5) add(-1.5, `Abwärtstrend: 24-h-Schnitt ${num1(-trend)} % unter dem 7-Tage-Schnitt`);
  else add(0, 'Seitwärtstrend: 24-h-Schnitt nahe am 7-Tage-Schnitt');

  if (Number.isFinite(d30)) {
    if (d30 > 15) add(1, `Starkes Momentum: +${num1(d30)} % in 30 Tagen`);
    else if (d30 < -15) add(-1, `Schwaches Momentum: ${num1(d30)} % in 30 Tagen`);
    else add(0, `30-Tage-Veränderung unauffällig (${num1(d30)} %)`);
  }

  if (Number.isFinite(d1)) {
    if (d1 > 5) add(0.5, `Kräftiger Tagesanstieg (+${num1(d1)} %)`);
    else if (d1 < -5) add(-0.5, `Kräftiger Tagesverlust (${num1(d1)} %)`);
  }

  const score = reasons.reduce((s, x) => s + x.pts, 0);
  let signal, label, outlook;
  if (score >= 3) [signal, label, outlook] = ['buy', 'Kaufen', 'Positiv'];
  else if (score >= 1.5) [signal, label, outlook] = ['buy', 'Eher kaufen', 'Leicht positiv'];
  else if (score <= -3) [signal, label, outlook] = ['sell', 'Verkaufen', 'Negativ'];
  else if (score <= -1.5) [signal, label, outlook] = ['sell', 'Eher verkaufen', 'Leicht negativ'];
  else [signal, label, outlook] = ['hold', 'Halten', 'Neutral'];

  // Der stärkste Einzelfaktor wird als Kurzbegründung angezeigt
  const main = [...reasons].sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))[0];
  return { signal, label, outlook, text: main.text, reasons, score, rsi: r, trend };
}

// ---------- Darstellung ----------

function sparkline(prices, up) {
  if (!prices || prices.length < 2) return '';
  const w = 120, h = 36, min = Math.min(...prices), max = Math.max(...prices);
  const span = max - min || 1;
  const pts = prices.map((p, i) => `${(i / (prices.length - 1) * w).toFixed(1)},${(h - 2 - (p - min) / span * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--${up ? 'up' : 'down'})" stroke-width="1.5"/></svg>`;
}

function detailRow(c) {
  const a = c.analysis;
  const cell = (label, value) => `<div><div class="label">${label}</div><div class="value">${value}</div></div>`;
  const reasons = a.reasons.length
    ? `<ul class="reasons">${a.reasons.map((r) => {
        const cls = r.pts > 0 ? 'up' : r.pts < 0 ? 'down' : 'muted';
        const pts = (r.pts > 0 ? '+' : '') + r.pts.toLocaleString('de-DE');
        return `<li><span class="pts ${cls}">${pts}</span><span>${esc(r.text)}</span></li>`;
      }).join('')}
      <li><span class="pts">${(a.score > 0 ? '+' : '') + a.score.toLocaleString('de-DE')}</span><strong>Gesamtpunktzahl → ${esc(a.label)}</strong></li></ul>`
    : `<p class="muted">${esc(a.text)}</p>`;
  return `<tr class="detail"><td colspan="10">
    <div class="detail-grid">
      ${cell('24-h-Hoch', money(c.high_24h))}
      ${cell('24-h-Tief', money(c.low_24h))}
      ${cell('Handelsvolumen 24 h', compact(c.total_volume))}
      ${cell('Marktkapitalisierung', compact(c.market_cap))}
      ${cell('Allzeithoch', money(c.ath))}
      ${cell('Abstand zum Allzeithoch', pct(c.ath_change_percentage))}
    </div>
    ${reasons}
  </td></tr>`;
}

function render() {
  const q = state.query.trim().toLowerCase();
  const list = state.coins.filter((c) =>
    (state.filter === 'all' || c.analysis.signal === state.filter) &&
    (!q || c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q)));

  $('rows').innerHTML = list.length ? list.map((c) => {
    const a = c.analysis;
    const d7 = c.price_change_percentage_7d_in_currency;
    return `<tr class="coin" data-id="${esc(c.id)}">
      <td class="num muted col-rank">${c.market_cap_rank ?? ''}</td>
      <td><div class="coin-cell"><img src="${esc(c.image)}" alt="" loading="lazy">
        <div><div class="coin-name">${esc(c.name)}</div><div class="coin-sym">${esc(c.symbol)}</div></div></div></td>
      <td class="num">${money(c.current_price)}</td>
      <td class="num">${pct(c.price_change_percentage_24h_in_currency)}</td>
      <td class="num col-7d">${pct(d7)}</td>
      <td class="num col-30d">${pct(c.price_change_percentage_30d_in_currency)}</td>
      <td class="num col-cap">${compact(c.market_cap)}</td>
      <td class="col-chart">${sparkline(c.sparkline_in_7d?.price, d7 >= 0)}</td>
      <td class="col-outlook"><strong>${esc(a.outlook)}</strong><span class="muted">${esc(a.text)}</span></td>
      <td><span class="badge ${a.signal}">${esc(a.label)}</span></td>
    </tr>${state.open === c.id ? detailRow(c) : ''}`;
  }).join('') : `<tr><td colspan="10" class="empty">${state.coins.length ? 'Keine Coins gefunden.' : 'Lade Kurse …'}</td></tr>`;

  renderSummary();
}

function renderSummary() {
  if (!state.coins.length) return;
  const count = (s) => state.coins.filter((c) => c.analysis.signal === s).length;
  const changes = state.coins.map((c) => c.price_change_percentage_24h_in_currency).filter(Number.isFinite);
  const card = (label, value) => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  $('summary').innerHTML =
    card('Marktkap. Top 50', compact(state.coins.reduce((s, c) => s + (c.market_cap || 0), 0))) +
    card('Ø Veränderung 24 h', pct(avg(changes))) +
    card('Kaufsignale', `<span class="up">${count('buy')}</span>`) +
    card('Halten', `<span style="color:var(--hold)">${count('hold')}</span>`) +
    card('Verkaufssignale', `<span class="down">${count('sell')}</span>`);
}

function setStatus(ok, message) {
  $('dot').className = 'dot ' + (ok ? 'live' : 'fail');
  if (state.updated) $('updated').textContent = 'Stand: ' + state.updated.toLocaleTimeString('de-DE');
  $('error').hidden = ok;
  if (!ok) $('error').textContent = message;
}

// ---------- Daten laden ----------

function apply(coins, updated) {
  state.coins = coins.map((c) => ({ ...c, analysis: analyse(c) }));
  state.updated = updated;
  render();
}

async function load() {
  const currency = state.currency;
  const url = `${API}?vs_currency=${currency}&order=market_cap_desc&per_page=50&page=1&sparkline=true&price_change_percentage=24h,7d,30d`;
  try {
    const res = await fetch(url);
    if (res.status === 429) throw new Error('Zu viele Anfragen an CoinGecko – nächster Versuch in einer Minute.');
    if (!res.ok) throw new Error(`CoinGecko antwortet mit Fehler ${res.status}.`);
    const coins = await res.json();
    if (currency !== state.currency) return; // Währung wurde während des Ladens gewechselt
    apply(coins, new Date());
    setStatus(true);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ currency, coins, time: Date.now() })); } catch {}
  } catch (err) {
    const msg = err instanceof TypeError ? 'Keine Verbindung zu CoinGecko.' : err.message;
    setStatus(false, msg + (state.coins.length ? ' Es werden die zuletzt geladenen Kurse angezeigt.' : ''));
  }
}

function restoreCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (cache?.currency === state.currency && Array.isArray(cache.coins)) apply(cache.coins, new Date(cache.time));
  } catch {}
}

// ---------- Bedienung ----------

$('search').addEventListener('input', (e) => { state.query = e.target.value; render(); });

$('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  for (const b of $('filters').children) b.classList.toggle('active', b === btn);
  render();
});

$('currency').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-currency]');
  if (!btn || btn.dataset.currency === state.currency) return;
  state.currency = btn.dataset.currency;
  for (const b of $('currency').children) b.classList.toggle('active', b === btn);
  state.coins = [];
  render();
  load();
});

$('rows').addEventListener('click', (e) => {
  const row = e.target.closest('tr.coin');
  if (!row) return;
  state.open = state.open === row.dataset.id ? null : row.dataset.id;
  render();
});

restoreCache();
load();
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
