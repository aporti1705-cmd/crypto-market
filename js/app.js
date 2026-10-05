import { $, esc, settings, sleep, isNum, money, compact, num, signed, tone, pct } from './util.js';
import * as api from './api.js';
import * as pf from './portfolio.js';
import { quickAnalyse, detailAnalyse, marketIndex, prepare, backtest, expectedMove, outlook } from './model.js';

const REFRESH_MS = 120_000;      // so alt dürfen gespeicherte Kurse sein, bevor sofort neu geladen wird
const PAGE_INTERVAL_MS = 30_000;
const RETRY_MS = 30_000;
const FNG_REFRESH_MS = 30 * 60_000;
const PAGE_SIZE = 100;
const RISK_WEIGHT = [1, 0.9, 0.75, 0.55];   // Abwertung im Ranking je Risikostufe
const CACHE_KEY = 'krypto-markt-kurse';
const CACHE_FIELDS = ['id', 'symbol', 'name', 'image', 'current_price', 'market_cap', 'market_cap_rank', 'total_volume',
  'high_24h', 'low_24h', 'ath', 'ath_change_percentage', 'circulating_supply', 'max_supply',
  'price_change_percentage_24h_in_currency', 'price_change_percentage_7d_in_currency', 'price_change_percentage_14d_in_currency',
  'price_change_percentage_30d_in_currency', 'price_change_percentage_200d_in_currency', 'price_change_percentage_1y_in_currency'];
// Token, die nur einen anderen Coin abbilden – für die Liste der stärksten Kaufsignale uninteressant
const DERIVATIVE = /wrapped|staked|staking|bridged|restaked|\busd|usd\b/i;

const state = {
  raw: new Map(), coins: [], byId: new Map(), bySymbol: new Map(), byName: new Map(),
  market: null, fng: null, rates: null,
  sort: { key: 'rank', dir: 1 }, page: 1, query: '', filter: 'all',
  gen: 0, nextPage: 1, pagesLoaded: 0, updated: null,
};

const view = $('#view');
let current = null;

// ---------- Daten ----------

function rebuild() {
  const coins = [...state.raw.values()].sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
  const btc = state.raw.get('bitcoin');
  if (btc) btc.analysis = quickAnalyse(btc);
  state.market = marketIndex(coins, state.fng);
  const regime = state.market?.regime ?? 0;
  state.bySymbol.clear(); state.byName.clear();
  for (const c of coins) {
    if (c !== btc) c.analysis = quickAnalyse(c, regime);
    // Bei doppelten Kürzeln gewinnt der Coin mit der größeren Marktkapitalisierung
    if (!state.bySymbol.has(c.symbol.toLowerCase())) state.bySymbol.set(c.symbol.toLowerCase(), c);
    if (!state.byName.has(c.name.toLowerCase())) state.byName.set(c.name.toLowerCase(), c);
  }
  state.coins = coins;
  state.byId = state.raw;
}

function setStatus(error) {
  $('#dot').className = 'dot ' + (error ? 'fail' : state.updated ? 'live' : '');
  const total = api.PAGES * 250;
  const loaded = state.coins.length < total && state.pagesLoaded < api.PAGES ? ` · ${state.coins.length} von ${total} Coins geladen` : ` · ${state.coins.length} Coins`;
  $('#updated').textContent = state.updated ? `Stand: ${state.updated.toLocaleTimeString('de-DE')}${loaded}` : 'Lade Kurse …';
  $('#error').hidden = !error;
  if (error) $('#error').textContent = error + (state.coins.length ? ' Es werden die zuletzt geladenen Kurse angezeigt.' : '');
}

// Zwischenspeicher im Browser: Die Seite zeigt nach dem Neuladen sofort Kurse und schont das Anfrage-Limit
function saveCache() {
  const coins = state.coins.map((c) => {
    const out = {};
    for (const f of CACHE_FIELDS) out[f] = c[f];
    out.sparkline_in_7d = { price: (c.sparkline_in_7d?.price || []).map((p) => Number(p.toPrecision(5))) };
    return out;
  });
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ currency: settings.currency, time: state.updated.getTime(), coins })); } catch {}
}

// Gibt das Alter der gespeicherten Kurse in Millisekunden zurück, ohne Treffer Infinity
function restoreCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (cache?.currency !== settings.currency || !Array.isArray(cache.coins)) return Infinity;
    for (const c of cache.coins) state.raw.set(c.id, c);
    state.pagesLoaded = Math.min(api.PAGES, Math.ceil(cache.coins.length / 250));
    state.updated = new Date(cache.time);
    rebuild();
    return Date.now() - cache.time;
  } catch { return Infinity; }
}

// Lädt die nächste Seite (250 Coins). Scheitert sie am Anfrage-Limit, versucht der nächste Aufruf dieselbe Seite erneut
async function loadPage(gen) {
  const page = state.nextPage;
  try {
    const list = await api.markets(settings.currency, page);
    if (gen !== state.gen) return false;
    for (const c of list) state.raw.set(c.id, c);
    state.nextPage = page % api.PAGES + 1;
    state.pagesLoaded = Math.max(state.pagesLoaded, page);
    state.updated = new Date();
    rebuild();
    setStatus(null);
    current?.update();
    if (state.nextPage === 1) saveCache();
    return true;
  } catch (err) {
    if (gen === state.gen) setStatus(err.message);
    return false;
  }
}

// Das kostenlose CoinGecko-Limit liegt bei etwa 5 Anfragen pro Minute. Beim ersten Laden kommen die
// vier Seiten direkt hintereinander, danach wird alle 30 Sekunden eine Seite aufgefrischt – so bleibt
// Luft für die Kursverläufe der Detailansicht.
async function marketLoop() {
  const gen = ++state.gen;
  const age = restoreCache();
  if (age < Infinity) { setStatus(null); current?.update(); }
  if (age < REFRESH_MS) await sleep(PAGE_INTERVAL_MS);
  while (gen === state.gen) {
    const ok = await loadPage(gen);
    if (!ok) await sleep(RETRY_MS);
    else if (state.pagesLoaded >= api.PAGES) await sleep(PAGE_INTERVAL_MS);
    while (document.hidden) await sleep(3000);
  }
}

async function fngLoop() {
  for (;;) {
    try {
      const data = await api.fearGreed();
      state.fng = { value: data[0].value, history: data };
      if (state.coins.length) { rebuild(); current?.update(); }
    } catch { /* Seite funktioniert auch ohne Fear & Greed */ }
    await sleep(FNG_REFRESH_MS);
  }
}

function setCurrency(currency) {
  if (currency === settings.currency) return;
  settings.currency = currency;
  for (const b of $('#currency').children) b.classList.toggle('active', b.dataset.currency === currency);
  state.raw = new Map(); state.coins = []; state.byId = state.raw; state.market = null;
  state.pagesLoaded = 0; state.nextPage = 1; state.updated = null;
  setStatus(null);
  current?.update();
  marketLoop();
}

// ---------- Bausteine ----------

const badge = (a, extra = '') => `<span class="badge ${a.signal} ${extra}">${esc(a.label)}</span>`;

function scoreCell(score) {
  if (score === null) return '<span class="muted">–</span>';
  const w = Math.abs(score) / 2;
  const left = score >= 0 ? 50 : 50 - w;
  return `<div class="score"><span class="score-num ${tone(score)}">${signed(score, 0)}</span>
    <span class="bar"><i class="${tone(score)}" style="left:${left}%;width:${w}%"></i></span></div>`;
}

const riskTag = (risk) => (risk.label === '–' ? '<span class="muted">–</span>' : `<span class="risk r${risk.level}">${risk.label}</span>`);

function sparkline(prices, up) {
  if (!prices || prices.length < 2) return '';
  const w = 110, h = 32, min = Math.min(...prices), max = Math.max(...prices), span = max - min || 1;
  const pts = prices.map((p, i) => `${(i / (prices.length - 1) * w).toFixed(1)},${(h - 2 - (p - min) / span * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--${up ? 'up' : 'down'})" stroke-width="1.5"/></svg>`;
}

function gauge(value, colors) {
  const cx = 100, cy = 100, r = 80;
  const pt = (v, rad = r) => {
    const a = Math.PI * (1 - v / 100);
    return [(cx + rad * Math.cos(a)).toFixed(1), (cy - rad * Math.sin(a)).toFixed(1)];
  };
  const step = 100 / colors.length;
  const arcs = colors.map((col, i) => {
    const [x1, y1] = pt(i * step + 0.8), [x2, y2] = pt((i + 1) * step - 0.8);
    return `<path d="M${x1} ${y1} A${r} ${r} 0 0 1 ${x2} ${y2}" stroke="${col}" stroke-width="13" fill="none"/>`;
  }).join('');
  const [nx, ny] = pt(value, r - 16);
  return `<svg class="gauge" viewBox="0 0 200 110" aria-hidden="true">${arcs}
    <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" class="needle"/><circle cx="${cx}" cy="${cy}" r="5" class="hub"/></svg>`;
}

const SELL_TO_BUY = ['var(--down)', 'var(--warn)', 'var(--hold)', 'var(--mild)', 'var(--up)'];

const fngLabel = (v) => (v <= 24 ? 'Extreme Angst' : v <= 46 ? 'Angst' : v <= 54 ? 'Neutral' : v <= 75 ? 'Gier' : 'Extreme Gier');

function factorList(factors) {
  if (!factors.length) return '<p class="muted">Keine Daten für diesen Zeitraum.</p>';
  return `<ul class="factors">${factors.map((f) => `<li>
    <span class="pts ${tone(Math.abs(f.score) < 0.05 ? 0 : f.score)}">${signed(f.score * 100, 0)}</span>
    <span><strong>${esc(f.name)}</strong><br><span class="muted">${esc(f.text)}</span></span></li>`).join('')}</ul>`;
}

// ---------- Marktübersicht ----------

const SORTS = {
  rank: (c) => c.market_cap_rank, name: (c) => c.name.toLowerCase(), price: (c) => c.current_price,
  h24: (c) => c.price_change_percentage_24h_in_currency, d7: (c) => c.price_change_percentage_7d_in_currency,
  d30: (c) => c.price_change_percentage_30d_in_currency, mcap: (c) => c.market_cap, score: (c) => c.analysis.score,
};

function marketView() {
  const th = (key, label, cls = '') => `<th class="${cls} sortable" data-sort="${key}">${label}</th>`;
  view.innerHTML = `
    <section class="hero">
      <div class="panel gauge-panel" id="g-market"></div>
      <div class="panel gauge-panel" id="g-fng"></div>
      <div class="panel" id="market-parts"></div>
    </section>
    <section>
      <h2>Stärkste Kaufsignale</h2>
      <p class="hint">Coins aus den Top 500 mit ausreichend Handelsvolumen, sortiert nach Prognose-Score – riskantere Coins werden dabei abgewertet.</p>
      <div id="picks" class="picks"></div>
    </section>
    <section class="controls">
      <input id="search" type="search" placeholder="Coin suchen (z. B. Bitcoin, ETH) …" aria-label="Coin suchen" value="${esc(state.query)}">
      <div class="chips" id="filters" role="group" aria-label="Nach Signal filtern">
        ${[['all', 'Alle'], ['buy', 'Kaufen'], ['hold', 'Halten'], ['sell', 'Verkaufen']].map(([k, l]) =>
          `<button data-filter="${k}" class="chip ${state.filter === k ? 'active' : ''}">${l}</button>`).join('')}
      </div>
    </section>
    <div class="table-wrap"><table>
      <thead><tr>
        ${th('rank', '#', 'num col-rank')}${th('name', 'Coin', 'col-coin')}${th('price', 'Kurs', 'num')}${th('h24', '24 h', 'num')}
        ${th('d7', '7 T', 'num col-7d')}${th('d30', '30 T', 'num col-30d')}${th('mcap', 'Marktkap.', 'num col-cap')}
        <th class="col-chart">7 Tage</th>${th('score', 'Prognose', 'col-score')}
        <th class="col-hold">Haltedauer</th><th class="col-risk">Risiko</th><th>Signal</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
    <div class="pager" id="pager"></div>`;

  $('#search').addEventListener('input', (e) => { state.query = e.target.value; state.page = 1; table(); });
  $('#filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    state.filter = btn.dataset.filter; state.page = 1;
    for (const b of $('#filters').children) b.classList.toggle('active', b === btn);
    table();
  });
  $('thead', view).addEventListener('click', (e) => {
    const key = e.target.closest('[data-sort]')?.dataset.sort;
    if (!key) return;
    // Zahlenspalten beginnen absteigend, Rang und Name aufsteigend
    state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === 'rank' || key === 'name' ? 1 : -1 };
    table();
  });
  $('#rows').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-id]');
    if (row) location.hash = '#/coin/' + encodeURIComponent(row.dataset.id);
  });
  $('#pager').addEventListener('click', (e) => {
    const p = Number(e.target.closest('[data-page]')?.dataset.page);
    if (!p) return;
    state.page = p; table();
    $('.table-wrap', view).scrollIntoView({ block: 'start' });
  });

  function hero() {
    const m = state.market;
    $('#g-market').innerHTML = m ? `<div class="label">Markt-Index</div>${gauge(m.value, SELL_TO_BUY)}
        <div class="gauge-value">${m.value}<small> / 100</small></div>${badge(m, 'big')}`
      : '<div class="label">Markt-Index</div><p class="muted">Wird berechnet …</p>';
    const f = state.fng;
    $('#g-fng').innerHTML = f ? `<div class="label">Fear &amp; Greed Index</div>${gauge(f.value, SELL_TO_BUY)}
        <div class="gauge-value">${f.value}<small> / 100</small></div><span class="badge none big">${fngLabel(f.value)}</span>
        <div class="hint">Vor 7 Tagen: ${f.history[7]?.value ?? '–'} · vor 30 Tagen: ${f.history[29]?.value ?? '–'}</div>`
      : '<div class="label">Fear &amp; Greed Index</div><p class="muted">Wird geladen …</p>';
    $('#market-parts').innerHTML = m ? `<div class="label">So setzt sich der Markt-Index zusammen</div>
        ${factorList(m.parts)}
        <p class="hint">0 = klar verkaufen, 50 = neutral, 100 = klar kaufen. Der Index fließt als Marktphase in jede Coin-Prognose ein.</p>`
      : '<div class="label">Markt-Index</div><p class="muted">Wird berechnet …</p>';
  }

  function picks() {
    // Riskantere Coins brauchen einen höheren Score, um vorne zu landen
    const adjusted = (c) => c.analysis.score * RISK_WEIGHT[c.analysis.risk.level];
    const list = state.coins.filter((c) => c.analysis.signal === 'buy' && (c.market_cap_rank ?? 9999) <= 500 &&
      c.total_volume >= 1e6 && !DERIVATIVE.test(c.name))
      .sort((a, b) => adjusted(b) - adjusted(a)).slice(0, 8);
    $('#picks').innerHTML = list.length ? list.map((c) => `<a class="pick panel" href="#/coin/${encodeURIComponent(c.id)}">
        <div class="coin-cell"><img src="${esc(c.image)}" alt="" loading="lazy">
          <div><div class="coin-name">${esc(c.name)}</div><div class="coin-sym">${esc(c.symbol)} · #${c.market_cap_rank}</div></div></div>
        <div class="pick-score ${tone(c.analysis.score)}">${signed(c.analysis.score, 0)}</div>
        <div class="pick-meta">${badge(c.analysis)}<span>Haltedauer: <strong>${c.analysis.horizon}</strong></span><span>Risiko: ${riskTag(c.analysis.risk)}</span></div>
      </a>`).join('')
      : `<p class="muted">${state.coins.length ? 'Aktuell erfüllt kein Coin die Kriterien für ein Kaufsignal.' : 'Lade Kurse …'}</p>`;
  }

  function table() {
    const q = state.query.trim().toLowerCase();
    const get = SORTS[state.sort.key];
    const list = state.coins.filter((c) =>
      (state.filter === 'all' || c.analysis.signal === state.filter) &&
      (!q || c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q)))
      .sort((a, b) => {
        const x = get(a), y = get(b);
        if (x == null || y == null) return (x == null) - (y == null);   // fehlende Werte ans Ende
        return (x < y ? -1 : x > y ? 1 : 0) * state.sort.dir;
      });

    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const rows = list.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);

    for (const h of view.querySelectorAll('th[data-sort]')) {
      h.classList.toggle('sorted', h.dataset.sort === state.sort.key);
      h.dataset.dir = h.dataset.sort === state.sort.key ? (state.sort.dir > 0 ? '▲' : '▼') : '';
    }

    $('#rows').innerHTML = rows.length ? rows.map((c) => {
      const a = c.analysis, d7 = c.price_change_percentage_7d_in_currency;
      return `<tr class="coin" data-id="${esc(c.id)}">
        <td class="num muted col-rank">${c.market_cap_rank ?? ''}</td>
        <td class="col-coin"><a class="coin-cell" href="#/coin/${encodeURIComponent(c.id)}"><img src="${esc(c.image)}" alt="" loading="lazy">
          <div><div class="coin-name">${esc(c.name)}</div><div class="coin-sym">${esc(c.symbol)}</div></div></a></td>
        <td class="num">${money(c.current_price)}</td>
        <td class="num">${pct(c.price_change_percentage_24h_in_currency)}</td>
        <td class="num col-7d">${pct(d7)}</td>
        <td class="num col-30d">${pct(c.price_change_percentage_30d_in_currency)}</td>
        <td class="num col-cap">${compact(c.market_cap)}</td>
        <td class="col-chart">${sparkline(c.sparkline_in_7d?.price, d7 >= 0)}</td>
        <td class="col-score">${scoreCell(a.score)}</td>
        <td class="col-hold">${a.horizon}</td>
        <td class="col-risk">${riskTag(a.risk)}</td>
        <td>${badge(a)}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="12" class="empty">${state.coins.length ? 'Keine Coins gefunden.' : 'Lade Kurse …'}</td></tr>`;

    const btn = (p, label, active) => `<button class="chip ${active ? 'active' : ''}" data-page="${p}">${label}</button>`;
    $('#pager').innerHTML = pages > 1
      ? `<div class="chips">${Array.from({ length: pages }, (_, i) => btn(i + 1, `${i * PAGE_SIZE + 1}–${Math.min((i + 1) * PAGE_SIZE, list.length)}`, state.page === i + 1)).join('')}</div>`
      : '';
  }

  return { update() { hero(); picks(); table(); } };
}

// ---------- Detailansicht ----------

const RANGES = { '7T': 7, '30T': 30, '90T': 90, '1J': 365 };

function drawChart(el, { t, p, overlays = [], hourly }) {
  if (p.length < 2) { el.innerHTML = '<p class="muted">Keine Kursdaten für diesen Zeitraum.</p>'; return; }
  // In echten Pixeln zeichnen, damit die Beschriftung auf schmalen Bildschirmen lesbar bleibt
  const W = Math.max(el.clientWidth, 280), narrow = W < 600;
  const H = narrow ? 240 : 320, L = 10, R = narrow ? 66 : 84, T = 12, B = 26;
  const tickCount = narrow ? 2 : 4;
  const all = p.concat(...overlays.map((o) => o.values.filter((v) => v != null)));
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.06 || hi * 0.01;
  lo -= pad; hi += pad;
  const x = (i) => L + i / (p.length - 1) * (W - L - R);
  const y = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
  const path = (vals) => {
    let d = '', pen = false;
    vals.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const date = (ms) => new Date(ms).toLocaleString('de-DE', hourly
    ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' });
  const color = p[p.length - 1] >= p[0] ? 'var(--up)' : 'var(--down)';

  const grid = [0, 1, 2, 3, 4].map((k) => {
    const v = lo + (hi - lo) * k / 4;
    return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${W - R + 8}" y="${y(v) + 4}" class="axis">${esc(money(v))}</text>`;
  }).join('');
  const ticks = Array.from({ length: tickCount + 1 }, (_, k) => {
    const i = Math.round(k / tickCount * (p.length - 1));
    const anchor = k === 0 ? 'start' : k === tickCount ? 'end' : 'middle';
    return `<text x="${x(i)}" y="${H - 6}" text-anchor="${anchor}" class="axis">${date(t[i]).slice(0, hourly ? 6 : 10)}</text>`;
  }).join('');

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Kursverlauf">
      ${grid}${ticks}
      <path d="${path(p)}L${x(p.length - 1)} ${H - B}L${L} ${H - B}Z" fill="${color}" opacity=".08"/>
      ${overlays.map((o) => `<path d="${path(o.values)}" fill="none" stroke="${o.color}" stroke-width="1.5" stroke-dasharray="5 4"/>`).join('')}
      <path d="${path(p)}" fill="none" stroke="${color}" stroke-width="2"/>
      <g class="cursor" hidden><line y1="${T}" y2="${H - B}" class="cross"/><circle r="4" fill="${color}"/></g>
    </svg>
    <div class="tip" hidden></div>
    <div class="legend">${overlays.map((o) => `<span><i style="background:${o.color}"></i>${o.label}</span>`).join('')}</div>`;

  const svg = $('svg', el), cursor = $('.cursor', el), tip = $('.tip', el);
  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = (e.clientX - box.left) / box.width * W;
    const i = Math.max(0, Math.min(p.length - 1, Math.round((px - L) / (W - L - R) * (p.length - 1))));
    cursor.hidden = false;
    $('line', cursor).setAttribute('x1', x(i)); $('line', cursor).setAttribute('x2', x(i));
    $('circle', cursor).setAttribute('cx', x(i)); $('circle', cursor).setAttribute('cy', y(p[i]));
    tip.hidden = false;
    tip.innerHTML = `<strong>${esc(money(p[i]))}</strong><br>${date(t[i])}`;
    const left = x(i) / W * box.width;
    tip.style.left = `${Math.min(Math.max(left, 70), box.width - 70)}px`;
  });
  svg.addEventListener('pointerleave', () => { cursor.hidden = true; tip.hidden = true; });
}

function detailView(id) {
  const d = { range: '1J', currency: null, data: null, ind: null, error: null };
  view.innerHTML = `
    <a class="back" href="#/">← Zurück zur Übersicht</a>
    <div id="d-head"></div>
    <section class="panel">
      <div class="panel-top"><h2>Kursverlauf</h2>
        <div class="chips" id="ranges">${Object.keys(RANGES).map((r) => `<button class="chip ${r === d.range ? 'active' : ''}" data-range="${r}">${r}</button>`).join('')}</div></div>
      <div id="chart" class="chart"><p class="muted">Lade Kursverlauf …</p></div>
    </section>
    <div id="d-forecast"></div>
    <div id="d-stats"></div>`;

  $('#ranges').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    d.range = btn.dataset.range;
    for (const b of $('#ranges').children) b.classList.toggle('active', b === btn);
    chart();
  });

  const self = { update };

  async function loadChart() {
    const currency = settings.currency;
    d.currency = currency; d.data = null; d.ind = null; d.error = null;
    try {
      const data = await api.chart(id, currency);
      if (current !== self || currency !== settings.currency) return;
      d.data = data;
      d.ind = prepare(data.p, data.v);
    } catch (err) {
      if (current !== self) return;
      d.error = err.message;
    }
    chart(); update();
  }

  function chart() {
    const el = $('#chart');
    const c = state.byId.get(id);
    if (d.range === '7T') {
      const p = (c?.sparkline_in_7d?.price || []).filter(isNum);
      const now = Date.now();
      drawChart(el, { p, t: p.map((_, i) => now - (p.length - 1 - i) * 3_600_000), hourly: true });
    } else if (d.data) {
      const n = RANGES[d.range];
      drawChart(el, { t: d.data.t.slice(-n), p: d.data.p.slice(-n), overlays: [
        { label: '50-Tage-Schnitt', color: 'var(--accent)', values: d.ind.sma50.slice(-n) },
        { label: '200-Tage-Schnitt', color: 'var(--violet)', values: d.ind.sma200.slice(-n) },
      ] });
    } else el.innerHTML = `<p class="muted">${esc(d.error ?? 'Lade Kursverlauf …')}</p>`;
  }

  function head(c, a) {
    $('#d-head').innerHTML = `<section class="panel d-head">
      <div class="d-coin"><img src="${esc(c.image)}" alt="">
        <div><h1 class="d-name">${esc(c.name)} <span class="coin-sym">${esc(c.symbol)}</span></h1>
          <div class="muted">Rang #${c.market_cap_rank ?? '–'}</div></div></div>
      <div><div class="d-price">${money(c.current_price)}</div>
        <div>${pct(c.price_change_percentage_24h_in_currency)} <span class="muted">in 24 Stunden</span></div></div>
      <div class="d-signal">${badge(a, 'big')}
        <dl><div><dt>Prognose-Score</dt><dd class="${tone(a.score)}">${a.score === null ? '–' : signed(a.score, 0) + ' / 100'}</dd></div>
          <div><dt>Haltedauer</dt><dd>${a.horizon}</dd></div>
          <div><dt>Risiko</dt><dd>${riskTag(a.risk)}</dd></div>
          <div><dt>Übereinstimmung</dt><dd>${a.agreement ? `${a.agreement.agreeing} von ${a.agreement.of} Zeithorizonten` : '–'}</dd></div></dl></div>
    </section>`;
  }

  function testBox(title, bt) {
    if (!bt || bt.all.n < 30) return '';
    const line = (b, label, fall) => (b.n < 5 ? `<li><span class="muted">${label}: zu selten aufgetreten (${b.n} Tage)</span></li>`
      : `<li><strong>${label}</strong> an ${b.n} Tagen → ${bt.days} Tage später ${fall
        ? `in ${num(100 - b.upRate, 0)} % der Fälle tiefer` : `in ${num(b.upRate, 0)} % der Fälle höher`}, im Schnitt ${pct(b.mean, 1)}</li>`);
    const edge = bt.buy.n >= 5 ? bt.buy.mean - bt.all.mean : null;
    const verdict = edge === null ? '' : edge > 1
      ? '<p class="up">Nach Kaufsignalen lief dieser Coin im Rückblick besser als im Durchschnitt aller Tage.</p>'
      : edge < -1 ? '<p class="down">Achtung: Nach Kaufsignalen lief dieser Coin im Rückblick schlechter als im Durchschnitt – hier ist das Modell wenig verlässlich.</p>'
      : '<p class="muted">Kaufsignale brachten bei diesem Coin im Rückblick kaum einen Vorteil gegenüber dem Durchschnitt.</p>';
    return `<div><h3>${title}</h3><ul class="plain">
      ${line(bt.buy, 'Kaufsignal')}${line(bt.sell, 'Verkaufssignal', true)}
      <li><span class="muted">Zum Vergleich alle ${bt.all.n} Tage: in ${num(bt.all.upRate, 0)} % der Fälle höher, im Schnitt ${signed(bt.all.mean, 1)} %</span></li>
    </ul>${verdict}</div>`;
  }

  function forecast(c, a) {
    if (a.signal === 'none') { $('#d-forecast').innerHTML = `<section class="panel"><h2>Prognose</h2><p>${esc(a.notes[0])}</p></section>`; return; }
    const card = (title, span, h) => `<div class="panel h-card">
      <div class="panel-top"><div><h3>${title}</h3><div class="muted">${span}</div></div>
        <span class="outlook ${tone(h.score === null || Math.abs(h.score) <= 0.15 ? 0 : h.score)}">${outlook(h.score)}</span></div>
      ${factorList(h.factors)}</div>`;

    let extra = '';
    if (d.ind) {
      const move = expectedMove(d.data.p);
      const span = (m) => `${money(c.current_price * Math.exp(-m))} bis ${money(c.current_price * Math.exp(m))}`;
      extra = `<section class="panel"><h2>Übliche Schwankungsbreite</h2>
          <p class="hint">Abgeleitet aus den Tagesschwankungen der letzten 90 Tage. In etwa zwei von drei Fällen bleibt der Kurs in dieser Spanne – Ausreißer nach oben und unten sind jederzeit möglich.</p>
          ${move ? `<div class="stat-grid">
            <div><div class="label">In 7 Tagen</div><div class="value">± ${num(move.d7 * 100, 0)} %</div><div class="muted">${span(move.d7)}</div></div>
            <div><div class="label">In 30 Tagen</div><div class="value">± ${num(move.d30 * 100, 0)} %</div><div class="muted">${span(move.d30)}</div></div></div>` : ''}
        </section>
        <section class="panel"><h2>Rückblick-Test: Wie gut war das Modell bei diesem Coin?</h2>
          <p class="hint">Das Modell wurde für jeden Tag der letzten 12 Monate nur mit den damals bekannten Kursen berechnet und mit der tatsächlichen Entwicklung danach verglichen.</p>
          <div class="two-col">${testBox('Mittelfristig (14 Tage später)', backtest(d.ind, 'medium', 14, 50))}
            ${testBox('Langfristig (30 Tage später)', backtest(d.ind, 'long', 30, 120))}</div>
          <p class="hint">Ein Jahr und ein einzelner Coin sind eine kleine Stichprobe. Gute Trefferquoten in der Vergangenheit garantieren keine künftigen.</p>
        </section>`;
    } else if (d.error) extra = `<section class="panel"><p class="muted">${esc(d.error)}</p></section>`;

    $('#d-forecast').innerHTML = `
      <h2>Prognose nach Zeithorizont</h2>
      <p class="hint">${d.ind ? 'Verfeinert mit den Tageskursen der letzten 365 Tage.' : 'Schnellbewertung – die verfeinerte Prognose wird geladen …'}
        Die Punkte je Faktor reichen von −100 (klar negativ) bis +100 (klar positiv).</p>
      ${a.notes.map((n) => `<p class="notice">${esc(n)}</p>`).join('')}
      <div class="h-cards">${card('Kurzfristig', '1–7 Tage', a.short)}${card('Mittelfristig', '1–4 Wochen', a.medium)}${card('Langfristig', '3–12 Monate', a.long)}</div>
      ${extra}`;
  }

  function stats(c) {
    const cell = (label, value) => `<div><div class="label">${label}</div><div class="value">${value}</div></div>`;
    const coins = (v) => (isNum(v) ? `${v.toLocaleString('de-DE', { maximumFractionDigits: 0 })} ${esc(c.symbol.toUpperCase())}` : '–');
    $('#d-stats').innerHTML = `<section class="panel"><h2>Kennzahlen</h2><div class="stat-grid">
      ${cell('Marktkapitalisierung', compact(c.market_cap))}${cell('Handelsvolumen 24 h', compact(c.total_volume))}
      ${cell('24-h-Hoch', money(c.high_24h))}${cell('24-h-Tief', money(c.low_24h))}
      ${cell('7 Tage', pct(c.price_change_percentage_7d_in_currency))}${cell('30 Tage', pct(c.price_change_percentage_30d_in_currency))}
      ${cell('200 Tage', pct(c.price_change_percentage_200d_in_currency))}${cell('1 Jahr', pct(c.price_change_percentage_1y_in_currency))}
      ${cell('Allzeithoch', money(c.ath))}${cell('Abstand zum Allzeithoch', pct(c.ath_change_percentage))}
      ${cell('Umlaufmenge', coins(c.circulating_supply))}${cell('Maximale Menge', isNum(c.max_supply) ? coins(c.max_supply) : 'unbegrenzt')}
    </div></section>`;
  }

  function update() {
    const c = state.byId.get(id);
    if (!c) {
      $('#d-head').innerHTML = `<section class="panel"><p class="muted">${state.pagesLoaded >= api.PAGES
        ? 'Dieser Coin gehört aktuell nicht zu den Top 1000.' : 'Lade Kurse …'}</p></section>`;
      return;
    }
    if (d.currency !== settings.currency) { loadChart(); chart(); }
    else if (d.range === '7T') chart();
    const a = d.ind ? detailAnalyse(c, d.ind, state.market?.regime ?? 0) : c.analysis;
    head(c, a); forecast(c, a); stats(c);
  }

  return self;
}

// ---------- Portfolio ----------

function portfolioView() {
  let list = pf.load();
  let message = '';
  view.innerHTML = `
    <h2>Mein Portfolio</h2>
    <p class="hint">Dein Portfolio wird nur in diesem Browser gespeichert und nirgendwohin übertragen.</p>
    <section id="p-summary" class="summary"></section>
    <div class="table-wrap"><table>
      <thead><tr><th class="col-coin">Coin</th><th class="num">Menge</th><th class="num col-7d">Kurs</th><th class="num">Wert</th><th class="num col-cap">Anteil</th>
        <th class="num col-30d">Ø Kaufpreis</th><th class="num">Gewinn / Verlust</th><th class="col-hold">Haltedauer</th><th>Signal</th><th></th></tr></thead>
      <tbody id="p-rows"></tbody>
    </table></div>
    <section class="panel" id="p-check"></section>
    <div class="two-col">
      <section class="panel">
        <h2>Aus CoinMarketCap importieren</h2>
        <p class="hint">Exportiere dein Portfolio bei CoinMarketCap als CSV-Datei und wähle sie hier aus. Erkannt werden Bestände und
          Transaktionslisten mit Spalten für Coin (Name oder Kürzel), Menge und optional Kaufpreis und Typ (Kauf/Verkauf).</p>
        <form id="p-import" class="form">
          <label>CSV-Datei <input type="file" id="p-file" accept=".csv,.txt,text/csv" required></label>
          <label>Währung der Kaufpreise in der Datei
            <select id="p-cur"><option value="usd">USD</option><option value="eur">EUR</option><option value="chf">CHF</option></select></label>
          <label class="check"><input type="checkbox" id="p-replace" checked> Bestehende Positionen ersetzen</label>
          <button class="btn" type="submit">Importieren</button>
        </form>
      </section>
      <section class="panel">
        <h2>Position von Hand hinzufügen</h2>
        <form id="p-add" class="form">
          <label>Coin <input id="p-coin" list="coinlist" placeholder="z. B. Bitcoin oder BTC" required autocomplete="off"></label>
          <datalist id="coinlist"></datalist>
          <label>Menge <input id="p-amount" inputmode="decimal" placeholder="0,5" required></label>
          <label>Kaufpreis je Coin in <span data-cur></span> (optional) <input id="p-cost" inputmode="decimal"></label>
          <button class="btn" type="submit">Hinzufügen</button>
        </form>
      </section>
    </div>
    <p id="p-msg" class="notice" hidden></p>
    <p><button class="btn ghost" id="p-clear">Portfolio leeren</button></p>`;

  api.rates().then((r) => { state.rates = r; if (current === self) update(); }).catch(() => {});

  const say = (text) => { message = text; update(); };
  const find = (pos) => (pos.id && state.byId.get(pos.id))
    || state.bySymbol.get((pos.symbol || pos.name || '').toLowerCase())
    || state.byName.get((pos.name || pos.symbol || '').toLowerCase());

  $('#p-import').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('#p-file').files[0];
    if (!file) return;
    try {
      const res = pf.parseImport(await file.text(), $('#p-cur').value);
      if (!res.positions.length) throw new Error('In der Datei wurden keine Bestände gefunden.');
      list = $('#p-replace').checked ? res.positions : res.positions.reduce(pf.add, list);
      pf.save(list);
      e.target.reset();
      say(`${res.positions.length} Positionen aus ${res.rows} Zeilen importiert${res.skipped ? `, ${res.skipped} Zeilen übersprungen` : ''}.`);
    } catch (err) { say('Import fehlgeschlagen: ' + err.message); }
  });

  $('#p-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#p-coin').value.trim();
    const m = text.match(/^(.*)\(([^)]+)\)$/);
    const c = (m && state.coins.find((x) => x.name === m[1].trim() && x.symbol.toUpperCase() === m[2].trim().toUpperCase()))
      || find({ symbol: text, name: text });
    const amount = pf.parseNumber($('#p-amount').value);
    const cost = pf.parseNumber($('#p-cost').value);
    if (!c) return say(`„${text}“ wurde unter den geladenen Coins nicht gefunden.`);
    if (!(amount > 0)) return say('Bitte eine Menge größer als 0 eingeben.');
    list = pf.add(list, { id: c.id, symbol: c.symbol, name: c.name, amount, cost: cost > 0 ? cost : null, costCur: settings.currency });
    pf.save(list);
    e.target.reset();
    say(`${c.name} hinzugefügt.`);
  });

  $('#p-rows').addEventListener('click', (e) => {
    const key = e.target.closest('[data-remove]')?.dataset.remove;
    if (key === undefined) return;
    list = list.filter((p) => pf.keyOf(p) !== key);
    pf.save(list);
    say('Position entfernt.');
  });

  $('#p-clear').addEventListener('click', () => { list = []; pf.save(list); say('Portfolio geleert.'); });

  const self = { update };
  let optionCount = -1;

  function update() {
    const cur = settings.currency;
    view.querySelectorAll('[data-cur]').forEach((el) => { el.textContent = cur.toUpperCase(); });
    $('#p-msg').hidden = !message; $('#p-msg').textContent = message;
    $('#p-clear').hidden = !list.length;
    if (optionCount !== state.coins.length) {
      optionCount = state.coins.length;
      $('#coinlist').innerHTML = state.coins.map((c) => `<option value="${esc(c.name)} (${esc(c.symbol.toUpperCase())})">`).join('');
    }

    // Kaufpreise in die Anzeigewährung umrechnen (zum heutigen Wechselkurs)
    const convert = (cost, from) => (!isNum(cost) ? null : from === cur ? cost
      : state.rates?.[cur] && state.rates?.[from] ? cost * state.rates[cur] / state.rates[from] : null);

    const rows = list.map((pos) => {
      const c = find(pos);
      const value = c ? pos.amount * c.current_price : null;
      const unit = convert(pos.cost, pos.costCur);
      const paid = unit === null ? null : unit * pos.amount;
      return { pos, c, value, unit, paid, gain: value !== null && paid !== null ? value - paid : null };
    }).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));

    const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
    const priced = rows.filter((r) => r.gain !== null);
    const paid = priced.reduce((s, r) => s + r.paid, 0);
    const gain = priced.reduce((s, r) => s + r.gain, 0);
    const day = rows.reduce((s, r) => {
      const ch = r.c?.price_change_percentage_24h_in_currency;
      return s + (r.value !== null && isNum(ch) ? r.value - r.value / (1 + ch / 100) : 0);
    }, 0);

    const card = (label, value, sub = '') => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div><div class="muted">${sub}</div></div>`;
    $('#p-summary').innerHTML = list.length ? card('Gesamtwert', money(total)) +
      card('Veränderung 24 h', `<span class="${tone(day)}">${money(day)}</span>`, total ? pct(day / (total - day) * 100) : '') +
      card('Einsatz', priced.length ? money(paid) : '–', priced.length < rows.length ? 'nur Positionen mit Kaufpreis' : '') +
      card('Gewinn / Verlust', priced.length ? `<span class="${tone(gain)}">${money(gain)}</span>` : '–', paid ? pct(gain / paid * 100) : '') : '';

    $('#p-rows').innerHTML = rows.length ? rows.map(({ pos, c, value, unit, paid: p, gain: g }) => {
      const a = c?.analysis;
      const name = c ? `<a class="coin-cell" href="#/coin/${encodeURIComponent(c.id)}"><img src="${esc(c.image)}" alt="" loading="lazy">
          <div><div class="coin-name">${esc(c.name)}</div><div class="coin-sym">${esc(c.symbol)}</div></div></a>`
        : `<div><div class="coin-name">${esc(pos.name || pos.symbol)}</div><div class="coin-sym">${state.pagesLoaded < api.PAGES ? 'wird geladen …' : 'nicht in den Top 1000'}</div></div>`;
      return `<tr>
        <td class="col-coin">${name}</td>
        <td class="num">${pos.amount.toLocaleString('de-DE', { maximumFractionDigits: 8 })}</td>
        <td class="num col-7d">${c ? money(c.current_price) : '–'}</td>
        <td class="num">${money(value)}</td>
        <td class="num col-cap">${value !== null && total ? num(value / total * 100) + ' %' : '–'}</td>
        <td class="num col-30d">${unit === null ? '–' : money(unit)}</td>
        <td class="num">${g === null ? '–' : `<span class="${tone(g)}">${money(g)}</span><br><small>${pct(g / p * 100)}</small>`}</td>
        <td class="col-hold">${a ? a.horizon : '–'}</td>
        <td>${a ? badge(a) : '–'}</td>
        <td><button class="icon" data-remove="${esc(pf.keyOf(pos))}" title="Position entfernen" aria-label="Position entfernen">✕</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="10" class="empty">Noch keine Positionen. Importiere dein Portfolio oder füge unten eine Position hinzu.</td></tr>';

    check(rows, total);
  }

  function check(rows, total) {
    const el = $('#p-check');
    const known = rows.filter((r) => r.c && r.value !== null);
    el.hidden = !known.length || !total;
    if (el.hidden) return;
    const share = (signal) => known.filter((r) => r.c.analysis.signal === signal).reduce((s, r) => s + r.value, 0) / total * 100;
    const scored = known.filter((r) => r.c.analysis.score !== null);
    const weight = scored.reduce((s, r) => s + r.value, 0);
    const score = weight ? scored.reduce((s, r) => s + r.c.analysis.score * r.value, 0) / weight : null;

    const notes = [];
    const names = (rs) => rs.map((r) => esc(r.c.name)).join(', ');
    const sells = known.filter((r) => r.c.analysis.signal === 'sell');
    if (sells.length) notes.push(`<span class="down">Verkaufssignal</span> bei ${names(sells)} – ${num(share('sell'), 0)} % deines Portfolios.`);
    const buys = known.filter((r) => r.c.analysis.signal === 'buy');
    if (buys.length) notes.push(`<span class="up">Kaufsignal</span> bei ${names(buys)}.`);
    const big = known.find((r) => r.value / total > 0.5);
    if (big && known.length > 1) notes.push(`Klumpenrisiko: ${esc(big.c.name)} macht ${num(big.value / total * 100, 0)} % deines Portfolios aus.`);
    const risky = known.filter((r) => r.c.analysis.risk.level >= 3);
    if (risky.length) notes.push(`Sehr hohes Risiko bei ${names(risky)}.`);
    const missing = rows.length - known.length;
    if (missing && state.pagesLoaded >= api.PAGES) notes.push(`${missing} Position(en) konnten keinem Coin der Top 1000 zugeordnet werden und zählen nicht zum Gesamtwert.`);

    el.innerHTML = `<h2>Portfolio-Check</h2>
      <div class="stat-grid">
        <div><div class="label">Portfolio-Score (nach Wert gewichtet)</div><div class="value ${tone(score)}">${score === null ? '–' : signed(score, 0) + ' / 100'}</div></div>
        <div><div class="label">Anteil mit Kaufsignal</div><div class="value up">${num(share('buy'), 0)} %</div></div>
        <div><div class="label">Anteil Halten</div><div class="value">${num(share('hold') + share('none'), 0)} %</div></div>
        <div><div class="label">Anteil mit Verkaufssignal</div><div class="value down">${num(share('sell'), 0)} %</div></div>
      </div>
      ${notes.length ? `<ul class="plain">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}`;
  }

  return self;
}

// ---------- Start ----------

function route() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', a.dataset.nav === (name === 'portfolio' ? 'portfolio' : 'market'));
  if (name === 'coin' && arg) current = detailView(decodeURIComponent(arg));
  else if (name === 'portfolio') current = portfolioView();
  else current = marketView();
  current.update();
  window.scrollTo(0, 0);
}

$('#currency').addEventListener('click', (e) => {
  const c = e.target.closest('[data-currency]')?.dataset.currency;
  if (c) setCurrency(c);
});

window.addEventListener('hashchange', route);
route();
marketLoop();
fngLoop();
