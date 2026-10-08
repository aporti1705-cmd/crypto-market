import { $, esc, settings, sleep, isNum, money, compact, num, signed, tone, pct } from './util.js';
import * as api from './api.js';
import * as pf from './portfolio.js';
import * as auth from './auth.js';
import { plan, applyMove, adjusted, reserveAdvice, EXPOSURE_CURVES, RESERVE_BACKTEST } from './manager.js';
import { quickAnalyse, detailAnalyse, marketIndex, prepare, backtest, expectedMove, outlook, analyseNews, TRADE_SETUPS, TRADE_LIMITS } from './model.js';

const REFRESH_MS = 120_000;      // so alt dürfen gespeicherte Kurse sein, bevor sofort neu geladen wird
const PAGE_INTERVAL_MS = 30_000;
const RETRY_MS = 30_000;
const FNG_REFRESH_MS = 30 * 60_000;
const BTC_REFRESH_MS = 10 * 60_000;
const NO_REGIME = { score: null, factors: [] };
const PAGE_SIZE = 100;
// Zentral berechnete Daten (scripts/snapshot.mjs, alle 20 Minuten über GitHub Actions)
// Beim lokalen Entwickeln wird die Datei gelesen, die `node scripts/snapshot.mjs` nach out/ schreibt
const SNAPSHOT_URL = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'out/snapshot.json'
  : 'https://raw.githubusercontent.com/aporti1705-cmd/crypto-market/data/snapshot.json';
const SNAPSHOT_MAX_AGE_MS = 2 * 3_600_000;    // ältere Daten gelten als ausgefallen – dann rechnet der Browser selbst
const SNAPSHOT_REFRESH_MS = 5 * 60_000;
const LIVE_PRICE_MS = 60_000;
const STALE_MS = 15 * 60_000;
const CACHE_KEY = 'krypto-markt-kurse-usd';
const CACHE_FIELDS = ['id', 'symbol', 'name', 'image', 'current_price', 'market_cap', 'market_cap_rank', 'total_volume',
  'high_24h', 'low_24h', 'ath', 'ath_change_percentage', 'circulating_supply', 'max_supply',
  'price_change_percentage_24h_in_currency', 'price_change_percentage_7d_in_currency', 'price_change_percentage_14d_in_currency',
  'price_change_percentage_30d_in_currency', 'price_change_percentage_200d_in_currency', 'price_change_percentage_1y_in_currency'];
// Token, die nur einen anderen Coin abbilden – für die Liste der stärksten Kaufsignale uninteressant
const DERIVATIVE = /wrapped|staked|staking|bridged|restaked|\busd|usd\b/i;

const state = {
  raw: new Map(), coins: [], byId: new Map(), bySymbol: new Map(), byName: new Map(),
  market: null, fng: null, btcData: null, btcInd: null, marketNews: null,
  daily: new Map(),     // Tageskurse je Coin-ID, sobald geladen
  news: new Map(),      // ausgewertete Nachrichten je Coin-ID
  server: false,        // true: Bewertungen kommen fertig vom Server und werden hier nicht neu gerechnet
  refining: false,
  refineDone: false,    // Hintergrund-Bewertung mindestens einmal abgeschlossen
  sort: { key: 'rank', dir: 1 }, page: 1, query: '', filter: 'all',
  gen: 0, nextPage: 1, pagesLoaded: 0, updated: null,
};

const view = $('#view');
let current = null;

// ---------- Daten ----------

// Sortierte Liste und Suchtabellen neu aufbauen
function reindex(coins) {
  state.bySymbol.clear(); state.byName.clear();
  for (const c of coins) {
    // Bei doppelten Kürzeln gewinnt der Coin mit der größeren Marktkapitalisierung
    if (!state.bySymbol.has(c.symbol.toLowerCase())) state.bySymbol.set(c.symbol.toLowerCase(), c);
    if (!state.byName.has(c.name.toLowerCase())) state.byName.set(c.name.toLowerCase(), c);
  }
  state.coins = coins;
  state.byId = state.raw;
}

function rebuild() {
  if (state.server) {
    // Bewertungen stehen fest; nur die Tagesindikatoren für Diagramm und Rückblick-Test werden ergänzt
    const coins = [...state.raw.values()].sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
    for (const c of coins) {
      const daily = state.daily.get(c.id);
      c.ind = daily && isNum(c.current_price) ? prepare(daily.t, [...daily.p.slice(0, -1), c.current_price], daily.v) : null;
    }
    return reindex(coins);
  }
  // Coins, die seit mehreren Durchläufen nicht mehr geliefert wurden, sind aus den Top 1000 gefallen
  if (state.pagesLoaded >= api.PAGES) {
    for (const [id, c] of state.raw) if (c.fetched && Date.now() - c.fetched > STALE_MS) state.raw.delete(id);
  }
  const coins = [...state.raw.values()].sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
  // Marktphase immer mit dem aktuellen Bitcoin-Kurs rechnen, nicht mit dem Stand beim Laden der Tageskurse
  const btc = state.raw.get('bitcoin');
  if (state.btcData && isNum(btc?.current_price)) {
    const { t, p, v } = state.btcData;
    state.btcInd = prepare(t, [...p.slice(0, -1), btc.current_price], v);
  }
  state.market = marketIndex(coins, state.btcInd, state.fng, state.marketNews);
  if (state.market) state.market.time = new Date();
  const regime = state.market?.regime ?? NO_REGIME;
  for (const c of coins) {
    c.analysis = quickAnalyse(c, regime);
    // Sind Tageskurse geladen, gilt überall die verfeinerte Bewertung – in der Liste wie in der Detailansicht
    const daily = state.daily.get(c.id);
    c.ind = null;
    if (daily && isNum(c.current_price)) {
      c.ind = prepare(daily.t, [...daily.p.slice(0, -1), c.current_price], daily.v);
      c.analysis = detailAnalyse(c, c.ind, regime, state.news.get(c.id));
    }
  }
  reindex(coins);
}

function setStatus(error) {
  $('#dot').className = 'dot ' + (error ? 'fail' : state.updated ? 'live' : '');
  const total = api.PAGES * 250;
  const loaded = state.server ? ' · zentral berechnet' : state.coins.length < total && state.pagesLoaded < api.PAGES ? ` · ${state.coins.length} von ${total} Coins geladen` : ` · ${state.coins.length} Coins`;
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
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ time: state.updated.getTime(), coins })); } catch {}
}

// Gibt das Alter der gespeicherten Kurse in Millisekunden zurück, ohne Treffer Infinity
function restoreCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (!Array.isArray(cache?.coins)) return Infinity;
    for (const c of cache.coins) { c.fetched = Date.now(); state.raw.set(c.id, c); }
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
    const now = Date.now();
    for (const c of list) { c.fetched = now; state.raw.set(c.id, c); }
    state.nextPage = page % api.PAGES + 1;
    state.pagesLoaded = Math.max(state.pagesLoaded, page);
    state.updated = new Date();
    rebuild();
    setStatus(null);
    current?.update();
    if (state.nextPage === 1) saveCache();
    if (state.pagesLoaded >= api.PAGES) refineAll();
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
  if (age < Infinity) {
    setStatus(null); current?.update();
    // Auch mit Kursen aus dem Zwischenspeicher die Bewertungen verfeinern – sonst kämen bei gestörtem Kursabruf nie Vorschläge
    if (state.pagesLoaded >= api.PAGES) refineAll();
  }
  if (age < REFRESH_MS) await sleep(PAGE_INTERVAL_MS);
  while (gen === state.gen) {
    const ok = await loadPage(gen);
    if (!ok) await sleep(RETRY_MS);
    else if (state.pagesLoaded >= api.PAGES) await sleep(PAGE_INTERVAL_MS);
    while (document.hidden) await sleep(3000);
  }
}

// Lädt im Hintergrund die Tageskurse aller Coins, die Binance führt, damit die Liste dieselbe
// verfeinerte Bewertung zeigt wie die Detailansicht. Reihenfolge: nach Marktkapitalisierung.
const refineChecked = new Set();

async function refineAll() {
  if (state.refining) return;
  // Jeden Coin nur einmal prüfen, sonst würde die Paarliste alle 30 Sekunden neu geladen
  const fresh = state.coins.filter((c) => !refineChecked.has(c.id) && !state.daily.has(c.id) && !c.analysis.stable);
  if (!fresh.length) { state.refineDone = true; return; }
  state.refining = true;
  try {
    const prices = await api.binancePrices();
    for (const c of fresh) refineChecked.add(c.id);
    const todo = fresh.filter((c) => {
      const p = prices.get(c.symbol.toUpperCase() + 'USDT');
      // Gleiches Kürzel, aber ein anderer Coin? Dann weicht der Kurs deutlich ab
      return p && Math.abs(p / c.current_price - 1) < 0.1;
    });
    let done = 0;
    const worker = async () => {
      for (let c = todo.shift(); c; c = todo.shift()) {
        try {
          const data = await api.history(c.symbol);
          if (data && !state.daily.has(c.id)) state.daily.set(c.id, { ...data, source: 'Binance' });
        } catch { /* einzelner Coin nicht ladbar – es bleibt bei der Schnellbewertung */ }
        if (++done % 20 === 0) { rebuild(); current?.update(); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    rebuild(); current?.update();
  } catch { /* Binance nicht erreichbar */ }
  state.refining = false;
  state.refineDone = true;
  current?.update();
}

// ---------- Zentral berechnete Daten ----------

// Lädt das Ergebnis der zentralen Berechnung. Gibt false zurück, wenn es fehlt oder zu alt ist.
async function loadSnapshot() {
  try {
    // Die Zeitangabe in der Adresse umgeht zu lange Zwischenspeicherung
    const res = await fetch(`${SNAPSHOT_URL}?t=${Math.floor(Date.now() / SNAPSHOT_REFRESH_MS)}`);
    if (!res.ok) return false;
    const snap = await res.json();
    if (!Array.isArray(snap.coins) || snap.coins.length < 100 || Date.now() - snap.time > SNAPSHOT_MAX_AGE_MS) return false;
    if (state.server && state.updated && snap.time <= state.updated.getTime()) return true;   // nichts Neues

    const live = new Map([...state.raw.values()].map((c) => [c.id, c.current_price]));
    state.server = true;
    state.gen++;                        // beendet eine laufende Berechnung im Browser
    state.raw = new Map();
    for (const c of snap.coins) {
      c.analysis.regime = snap.market.regime;
      c.snapshotPrice = c.current_price;
      if (state.liveSince && isNum(live.get(c.id))) c.current_price = live.get(c.id);   // Live-Kurs behalten
      state.raw.set(c.id, c);
    }
    state.market = { ...snap.market, time: new Date(snap.time) };
    if (snap.fng && !state.fng) {
      // Bis der vollständige Verlauf geladen ist, reichen heute, vor 7 und vor 30 Tagen
      const history = [];
      history[0] = { value: snap.fng.value }; history[7] = { value: snap.fng.week }; history[29] = { value: snap.fng.month };
      state.fng = { value: snap.fng.value, history, byDay: new Map() };
    }
    state.pagesLoaded = api.PAGES;
    state.refineDone = true;
    state.updated = new Date(snap.time);
    rebuild();
    setStatus(null);
    current?.update();
    return true;
  } catch { return false; }
}

// Zwischen zwei Berechnungen die Kurse aktuell halten: ein Abruf bei Binance liefert alle Paare.
// Die Bewertungen bleiben dabei unverändert.
async function livePriceLoop() {
  while (state.server) {
    try {
      const prices = await api.binancePrices();
      for (const c of state.raw.values()) {
        const p = prices.get(c.symbol.toUpperCase() + 'USDT');
        // Gleiches Kürzel, aber ein anderer Coin? Dann weicht der Kurs deutlich ab
        if (p && Math.abs(p / c.snapshotPrice - 1) < 0.2) c.current_price = p;
      }
      state.liveSince = Date.now();
      rebuild();
      current?.update();
    } catch { /* Binance nicht erreichbar – es bleiben die Kurse der letzten Berechnung */ }
    await sleep(LIVE_PRICE_MS);
    while (document.hidden) await sleep(3000);
  }
}

async function start() {
  if (await loadSnapshot()) {
    livePriceLoop();
    for (;;) {
      await sleep(SNAPSHOT_REFRESH_MS);
      while (document.hidden) await sleep(3000);
      await loadSnapshot();
    }
  }
  // Keine zentralen Daten verfügbar: Der Browser lädt und rechnet selbst
  marketLoop();
  newsLoop();
}

async function fngLoop() {
  for (;;) {
    try {
      const data = await api.fearGreed();
      state.fng = { value: data[0].value, history: data, byDay: new Map(data.map((d) => [Math.floor(d.time / 86_400_000), d.value])) };
      if (state.coins.length) { rebuild(); current?.update(); }
    } catch { /* Seite funktioniert auch ohne Fear & Greed */ }
    await sleep(FNG_REFRESH_MS);
  }
}

// Bitcoin-Tageskurse für die Marktphase; ohne sie rechnet das Modell mit einer einfacheren Ersatzgröße.
// Der letzte Tageskurs wird in rebuild() laufend durch den Live-Kurs ersetzt.
async function bitcoinLoop() {
  for (;;) {
    try {
      const data = await api.history('BTC');
      if (data) {
        state.btcData = data;
        state.btcInd = prepare(data.t, data.p, data.v);
        if (state.coins.length) { rebuild(); current?.update(); }
      }
    } catch { /* Binance nicht erreichbar */ }
    await sleep(BTC_REFRESH_MS);
  }
}

async function newsLoop() {
  for (;;) {
    try {
      state.marketNews = analyseNews(await api.marketNews());
      if (state.coins.length) { rebuild(); current?.update(); }
    } catch { /* Seite funktioniert auch ohne Nachrichten */ }
    await sleep(FNG_REFRESH_MS);
  }
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

const NOW_ANSWER = {
  'Kaufen': 'Ja – der Markt spricht im Moment klar für Käufe.',
  'Eher kaufen': 'Eher ja – das Umfeld ist im Moment günstig.',
  'Halten': 'Abwarten – im Moment kein klarer Vorteil.',
  'Eher verkaufen': 'Eher nein – das Umfeld ist im Moment ungünstig.',
  'Verkaufen': 'Nein – der Markt spricht im Moment klar gegen Käufe.',
};

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
    <section class="panel" id="cycle"></section>
    <section class="panel" id="market-forecast" hidden></section>
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
    $('#g-market').innerHTML = m ? `<div class="label">Jetzt kaufen?</div>${gauge(m.value, SELL_TO_BUY)}
        <div class="gauge-value">${m.value}<small> / 100</small></div>${badge(m, 'big')}
        <div class="hint">${NOW_ANSWER[m.label]}<br>Sicht: nächste Wochen · über 14 Tage geglättet<br>Berechnet um ${m.time.toLocaleTimeString('de-DE')} aus den aktuellen Kursen</div>`
      : '<div class="label">Jetzt kaufen?</div><p class="muted">Wird berechnet …</p>';
    const cy = m?.cycle;
    $('#cycle').hidden = !cy;
    if (cy) {
      $('#cycle').className = `panel cycle ${cy.zone}`;
      $('#cycle').innerHTML = `<div class="panel-top"><div><div class="label">Zyklus – Sicht auf 12 Monate</div><h2>${esc(cy.label)}</h2></div>
          <strong class="cycle-dd">${num(-cy.dd, 0)} %<small> unter Allzeithoch</small></strong></div>
        <p>Bitcoin liegt ${num(-cy.dd, 0)} % unter seinem Allzeithoch. Aus vergleichbaren Ständen seit 2018 stand Bitcoin ein Jahr später
          in <strong>${cy.btcUp} %</strong> der Fälle höher (mittleres Ergebnis ${signed(cy.btcMedian, 0)} %), ein durchschnittlicher Coin in
          <strong>${cy.altUp} %</strong> der Fälle (${signed(cy.altMedian, 0)} %).</p>
        <p class="hint">Antizyklisch gilt: Je tiefer unter dem Hoch, desto besser waren die Einstiege auf Jahressicht – nahe am Hoch waren sie am schlechtesten.
          Das ist die langfristige Sicht; „Jetzt kaufen?“ oben bewertet die nächsten Wochen und folgt dem Trend. Beides zusammen bestimmt den Reserve-Vorschlag.
          Grundlage sind nur zwei Marktzyklen – eine Tendenz, keine Gewissheit.</p>`;
    }
    const fc = m?.forecast;
    $('#market-forecast').hidden = !fc;
    if (fc) {
      const cell = (s) => (s ? `<td class="num"><strong class="${tone(Math.round(s.mid))}">${signed(s.mid, Math.abs(s.mid) < 10 ? 1 : 0)} %</strong>
        <div class="muted fc-range">${signed(s.low, 0)} … ${signed(s.high, 0)} %</div>${isNum(s.up) ? `<div class="muted fc-range">höher in ${s.up} %</div>` : ''}</td>` : '<td class="num muted">–</td>');
      const row = (label, hint, f) => `<tr><td><strong>${label}</strong><div class="muted fc-range">${hint}</div></td>${cell(f.short)}${cell(f.medium)}${cell(f.long)}</tr>`;
      $('#market-forecast').innerHTML = `<div class="label">Prognose für den Gesamtmarkt</div>
        <div class="table-wrap"><table class="fc-table"><thead><tr><th></th><th class="num">7 Tage</th><th class="num">30 Tage</th><th class="num">12 Monate</th></tr></thead>
          <tbody>${row('Bitcoin', 'Leitwährung', fc.btc)}${row('Mittlerer Coin', 'typischer Altcoin', fc.alt)}</tbody></table></div>
        <p class="hint">Fett: das mittlere Ergebnis nach vergleichbaren Marktlagen seit 2018. Darunter die Spanne, in der die Hälfte der Fälle lag –
          jeder vierte Fall lag darüber, jeder vierte darunter. 7 und 30 Tage hängen an der Marktphase, 12 Monate am Stand im Zyklus.
          Der mittlere Coin schnitt auf Jahressicht meist schlechter ab als Bitcoin.
          Kaufsignale bei einzelnen Coins beziehen sich auf die nächsten Wochen; ist die 12-Monats-Sicht negativ, steht das beim Coin dabei.</p>`;
    }
    const f = state.fng;
    $('#g-fng').innerHTML = f ? `<div class="label">Fear &amp; Greed Index</div>${gauge(f.value, SELL_TO_BUY)}
        <div class="gauge-value">${f.value}<small> / 100</small></div><span class="badge none big">${fngLabel(f.value)}</span>
        <div class="hint">Vor 7 Tagen: ${isNum(f.history[7]?.value) ? f.history[7].value : '–'} · vor 30 Tagen: ${isNum(f.history[29]?.value) ? f.history[29].value : '–'}</div>`
      : '<div class="label">Fear &amp; Greed Index</div><p class="muted">Wird geladen …</p>';
    $('#market-parts').innerHTML = m ? `<div class="label">So setzt sich der Markt-Index zusammen</div>
        ${factorList(m.parts)}
        <details><summary>Heutige Einzelwerte der Marktphase</summary>${factorList(m.regime.factors)}</details>
        <p class="hint">0 = klar verkaufen, 50 = neutral, 100 = klar kaufen. Der Index fließt als Marktphase in jede Coin-Prognose ein.</p>`
      : '<div class="label">Markt-Index</div><p class="muted">Wird berechnet …</p>';
  }

  function picks() {
    // Riskantere Coins brauchen einen höheren Score, um vorne zu landen
    const list = state.coins.filter((c) => c.analysis.signal === 'buy' && (c.market_cap_rank ?? 9999) <= 500 &&
      c.total_volume >= 1e6 && !DERIVATIVE.test(c.name))
      .sort((a, b) => adjusted(b.analysis) - adjusted(a.analysis)).slice(0, 8);
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
        <td class="col-chart">${sparkline(c.sparkline_in_7d?.price, !isNum(d7) || d7 >= 0)}</td>
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

const RANGES = { '7T': 7, '30T': 30, '90T': 90, '1J': 365, '4J': 1461 };

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
  const d = { range: '1J', started: false, data: null, ind: null, source: null, error: null,
    tests: null, testsWithRegime: null, news: null, newsError: null };
  view.innerHTML = `
    <a class="back" href="#/">← Zurück zur Übersicht</a>
    <div id="d-head"></div>
    <section class="panel">
      <div class="panel-top"><h2>Kursverlauf</h2>
        <div class="chips" id="ranges">${Object.keys(RANGES).map((r) => `<button class="chip ${r === d.range ? 'active' : ''}" data-range="${r}">${r}</button>`).join('')}</div></div>
      <div id="chart" class="chart"><p class="muted">Lade Kursverlauf …</p></div>
    </section>
    <div id="d-forecast"></div>
    <div id="d-news"></div>
    <div id="d-stats"></div>`;

  $('#ranges').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    d.range = btn.dataset.range;
    for (const b of $('#ranges').children) b.classList.toggle('active', b === btn);
    chart();
    update();   // Kopfzeile zeigt die Veränderung über den gewählten Zeitraum
  });

  const self = { update };

  // Tageskurse landen in state.daily, Nachrichten in state.news. rebuild() rechnet daraus die eine
  // Bewertung des Coins, die auch die Liste zeigt.
  async function loadData(c) {
    try {
      if (!state.daily.has(id)) {
        let data = null;
        try { data = await api.history(c.symbol); } catch { /* Binance nicht erreichbar */ }
        // Gleiches Kürzel, aber ein anderer Coin? Dann weicht der Kurs deutlich ab
        if (data && Math.abs(data.p[data.p.length - 1] / c.current_price - 1) > 0.1) data = null;
        const source = data ? 'Binance' : 'CoinGecko';
        if (!data) data = await api.chart(id, settings.currency);
        state.daily.set(id, { ...data, source });
        rebuild();
      }
    } catch (err) {
      d.error = err.message;
    }
    if (current !== self) return;
    update(); chart();   // update() übernimmt die geladenen Tageskurse, erst dann kann das Diagramm zeichnen
  }

  async function loadNews(c) {
    try {
      state.news.set(id, analyseNews(await api.coinNews(c.name, c.symbol)));
      rebuild();
    } catch (err) { d.newsError = err.message; }
    if (current === self) update();
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

  // Kursveränderung über den im Diagramm gewählten Zeitraum, gemessen bis zum aktuellen Kurs
  function rangeChange(c) {
    if (d.range === '7T') {
      const v = c.price_change_percentage_7d_in_currency;
      return isNum(v) ? `<div>${pct(v)} <span class="muted">in 7 Tagen</span></div>` : '';
    }
    if (!d.data) return '';
    const n = Math.min(RANGES[d.range], d.data.p.length);
    const first = d.data.p[d.data.p.length - n];
    if (!(first > 0) || !isNum(c.current_price)) return '';
    const days = Math.round((Date.now() - d.data.t[d.data.t.length - n]) / 86_400_000);
    // Reicht die Kursgeschichte nicht so weit zurück, steht die tatsächliche Spanne da
    const label = n < RANGES[d.range] ? `${days} Tagen (gesamte Kursgeschichte)` : { '30T': '30 Tagen', '90T': '90 Tagen', '1J': '1 Jahr', '4J': '4 Jahren' }[d.range];
    return `<div>${pct((c.current_price / first - 1) * 100)} <span class="muted">in ${label}</span></div>`;
  }

  function head(c, a) {
    $('#d-head').innerHTML = `<section class="panel d-head">
      <div class="d-coin"><img src="${esc(c.image)}" alt="">
        <div><h1 class="d-name">${esc(c.name)} <span class="coin-sym">${esc(c.symbol)}</span></h1>
          <div class="muted">Rang #${c.market_cap_rank ?? '–'}</div></div></div>
      <div><div class="d-price">${money(c.current_price)}</div>
        <div>${pct(c.price_change_percentage_24h_in_currency)} <span class="muted">in 24 Stunden</span></div>
        ${rangeChange(c)}</div>
      <div class="d-signal">${badge(a, 'big')}
        <dl><div><dt>Prognose-Score</dt><dd class="${tone(a.score)}">${a.score === null ? '–' : signed(a.score, 0) + ' / 100'}</dd></div>
          <div><dt>Haltedauer</dt><dd>${a.horizon}</dd></div>
          ${a.scope ? `<div><dt>Signal gilt für</dt><dd>${a.scope === 'weeks' ? 'die nächsten Wochen – nicht zum langen Halten' : 'Wochen bis Monate'}</dd></div>` : ''}
          <div><dt>Risiko</dt><dd>${riskTag(a.risk)}</dd></div>
          <div><dt>Übereinstimmung</dt><dd>${a.agreement ? `${a.agreement.agreeing} von ${a.agreement.of} Zeithorizonten` : '–'}</dd></div></dl></div>
    </section>`;
  }

  function testBox(bt) {
    if (!bt || bt.all.n < 30) return '';
    const line = (b, label, fall) => (b.n < 5 ? `<li><span class="muted">${label}: zu selten aufgetreten (${b.n} Tage)</span></li>`
      : `<li><strong>${label}</strong> an ${b.n} Tagen → ${fall
        ? `in ${num(100 - b.upRate, 0)} % der Fälle tiefer` : `in ${num(b.upRate, 0)} % der Fälle höher`}, im Schnitt ${pct(b.mean, 1)}</li>`);
    const edge = bt.buy.n >= 5 ? bt.buy.mean - bt.all.mean : null;
    const verdict = edge === null ? '' : edge > 1
      ? '<p class="up">Kaufsignale lagen über dem Durchschnitt aller Tage.</p>'
      : edge < -1 ? '<p class="down">Achtung: Kaufsignale lagen unter dem Durchschnitt – hier ist das Modell wenig verlässlich.</p>'
      : '<p class="muted">Kaufsignale brachten kaum einen Vorteil gegenüber dem Durchschnitt.</p>';
    return `<div class="panel"><h3>${bt.days} Tage später</h3><ul class="plain">
      ${line(bt.buy, 'Kaufsignal')}${line(bt.sell, 'Verkaufssignal', true)}
      <li><span class="muted">Zum Vergleich alle ${bt.all.n} Tage: in ${num(bt.all.upRate, 0)} % der Fälle höher, im Schnitt ${signed(bt.all.mean, 1)} %</span></li>
    </ul>${verdict}</div>`;
  }

  function forecast(c, a) {
    if (a.signal === 'none') { $('#d-forecast').innerHTML = `<section class="panel"><h2>Prognose</h2><p>${esc(a.notes[0])}</p></section>`; return; }
    const card = (title, span, h) => `<div class="panel h-card">
      <div class="panel-top"><div><h3>${title}</h3><div class="muted">${span}</div></div>
        <span class="outlook ${tone(h.score === null || Math.abs(h.score) <= 0.12 ? 0 : h.score)}">${outlook(h.score)}</span></div>
      ${factorList(h.factors)}</div>`;

    const fcast = a.forecast;
    const fbox = (title, s) => (s ? `<div><div class="label">${title}</div>
        <div class="value ${tone(Math.round(s.mid))}">${signed(s.mid, Math.abs(s.mid) < 10 ? 1 : 0)} %</div>
        <div class="muted">Spanne ${signed(s.low, 0)} … ${signed(s.high, 0)} %</div>
        ${isNum(s.up) ? `<div class="muted">höher in ${s.up} % der Fälle</div>` : ''}
        <div class="muted">≈ ${money(c.current_price * (1 + s.mid / 100))} (${money(c.current_price * (1 + s.low / 100))} – ${money(c.current_price * (1 + s.high / 100))})</div></div>`
      : `<div><div class="label">${title}</div><div class="value muted">–</div></div>`);
    const why = a.reasons;
    const reasonList = (list) => list.map((f) => `<li><strong class="${tone(f.points)}">${signed(f.points, 0)}</strong> ${esc(f.name)} <span class="muted">(${f.horizon})</span>: ${esc(f.text)}</li>`).join('');
    const percent = !fcast ? '' : `<section class="panel"><h2>Kursprognose in Prozent</h2>
        <div class="stat-grid">${fbox('In 7 Tagen', fcast.short)}${fbox('In 30 Tagen', fcast.medium)}${fbox('In 12 Monaten', fcast.long)}</div>
        <p class="hint">Die große Zahl ist das mittlere Ergebnis, das Coins mit diesem Score und dieser Schwankung seit 2018 erreicht haben – gemessen vom jetzigen Kurs.
          In der Spanne lag die Hälfte der Fälle; jeder vierte Fall lag darüber, jeder vierte darunter. Auf 12 Monate zählt vor allem der Stand im Zyklus,
          dort ist die Unsicherheit am größten (nur zwei Marktzyklen als Grundlage).</p>
        ${why && (why.pro.length || why.contra.length) ? `<div class="h-cards reasons">
          <div><h3>Das spricht dafür</h3>${why.pro.length ? `<ul class="plain">${reasonList(why.pro)}</ul>` : '<p class="muted">Kein Merkmal spricht derzeit deutlich für den Coin.</p>'}</div>
          <div><h3>Das spricht dagegen</h3>${why.contra.length ? `<ul class="plain">${reasonList(why.contra)}</ul>` : '<p class="muted">Kein Merkmal spricht derzeit deutlich dagegen.</p>'}</div></div>
          <p class="hint">Punkte = Beitrag des Merkmals zum Prognose-Score. Ein Kaufsignal entsteht nur, wenn die Gründe dafür klar überwiegen.</p>` : ''}
      </section>`;

    let extra = '';
    if (d.ind) {
      // Rückblick-Test nur neu rechnen, wenn die Bitcoin-Daten für die Marktphase dazugekommen sind
      if (!d.tests || d.testsWithRegime !== !!state.btcInd) {
        d.testsWithRegime = !!state.btcInd;
        d.tests = [14, 30, 90].map((days) => backtest(d.ind, state.btcInd, state.fng?.byDay, days));
      }
      const move = expectedMove(d.data.p);
      const span = (m) => `${money(c.current_price * Math.exp(-m))} bis ${money(c.current_price * Math.exp(m))}`;
      const years = d.ind.n / 365;
      extra = `<section class="panel"><h2>Übliche Schwankungsbreite</h2>
          <p class="hint">Abgeleitet aus den Tagesschwankungen der letzten 90 Tage. In etwa zwei von drei Fällen bleibt der Kurs in dieser Spanne – Ausreißer nach oben und unten sind jederzeit möglich.</p>
          ${move ? `<div class="stat-grid">
            <div><div class="label">In 7 Tagen</div><div class="value">± ${num(move.d7 * 100, 0)} %</div><div class="muted">${span(move.d7)}</div></div>
            <div><div class="label">In 30 Tagen</div><div class="value">± ${num(move.d30 * 100, 0)} %</div><div class="muted">${span(move.d30)}</div></div></div>` : ''}
        </section>
        <h2>Rückblick-Test über ${years >= 1.5 ? num(years, 1) + ' Jahre' : num(d.ind.n, 0) + ' Tage'}</h2>
        <p class="hint">Wie gut war das Modell bei diesem Coin? Es wurde für jeden Tag nur mit den damals bekannten Kursen berechnet (Datenquelle: ${d.source}) und mit der tatsächlichen Entwicklung danach verglichen. Nachrichten sind im Rückblick nicht enthalten.</p>
        <div class="h-cards">${d.tests.map(testBox).join('') || '<p class="muted">Zu wenig Kursgeschichte für einen Rückblick-Test.</p>'}</div>
        <p class="hint">Wichtig: Die Bewertungskurven wurden an den letzten 4 Jahren großer Coins ausgerichtet. Die Trefferquoten im Rückblick fallen deshalb eher zu gut aus und sind keine Zusage für die Zukunft.</p>`;
    } else if (d.error) extra = `<section class="panel"><p class="muted">${esc(d.error)}</p></section>`;

    $('#d-forecast').innerHTML = `${percent}
      <h2>Prognose nach Zeithorizont</h2>
      <p class="hint">${d.ind ? `Verfeinert mit ${num(d.ind.n, 0)} Tageskursen.` : 'Schnellbewertung – die verfeinerte Prognose wird geladen …'}
        Die Punkte je Faktor reichen von −100 (klar negativ) bis +100 (klar positiv).</p>
      ${a.notes.map((n) => `<p class="notice">${esc(n)}</p>`).join('')}
      <div class="h-cards">${card('Kurzfristig', 'bis 1 Woche', a.short)}${card('Mittelfristig', '2–4 Wochen', a.medium)}
        ${card('Langfristig', '1–3 Monate', a.long)}${card('Marktphase', 'gilt für alle Coins · Schnitt aus 14 Tagen, Einzelwerte von heute', a.regime)}</div>
      ${extra}`;
  }

  function news(a) {
    const el = $('#d-news');
    if (a.signal === 'none') { el.innerHTML = ''; return; }
    const n = d.news;
    const tag = (t) => (t > 0 ? '<span class="tag up">positiv</span>' : t < 0 ? '<span class="tag down">negativ</span>' : '<span class="tag">neutral</span>');
    const body = !n ? `<p class="muted">${esc(d.newsError ?? 'Lade Nachrichten …')}</p>` : `
      <p>${esc(n.text)}${n.score !== null && !state.server ? ` → Einfluss auf den Score: <strong class="${tone(Math.round(n.score * 10))}">${signed(n.score * 10, 0)} Punkte</strong>` : ''}</p>
      <ul class="news">${n.items.slice(0, 8).map((it) => `<li>${tag(it.tone)}
        <span>${/^https?:\/\//.test(it.link) ? `<a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title)}
        <br><span class="muted">${esc(it.source ?? '')} · ${new Date(it.time).toLocaleDateString('de-DE')}</span></span></li>`).join('')}</ul>`;
    el.innerHTML = `<section class="panel"><h2>Nachrichten</h2>
      <p class="hint">Englischsprachige Meldungen der letzten 7 Tage, automatisch nach Stichwörtern als positiv oder negativ eingestuft. Die Einstufung ist grob und kann danebenliegen. ${state.server ? 'In den Score dieses Coins fließen sie nicht ein; die allgemeine Nachrichtenlage steckt im Markt-Index.' : 'Deshalb verschieben Nachrichten den Score um höchstens 10 Punkte.'}</p>
      ${body}</section>`;
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
    d.data = state.daily.get(id) ?? null;
    d.ind = d.data ? c.ind : null;
    d.source = d.data?.source ?? null;
    d.news = state.news.get(id) ?? null;
    if (!d.started) {
      d.started = true;
      loadData(c);
      if (!c.analysis.stable && !d.news) loadNews(c);
      chart();
    } else if (d.range === '7T') chart();
    const a = c.analysis;
    head(c, a); forecast(c, a); news(a); stats(c);
  }

  return self;
}

// ---------- Portfolio: Speicherung und Konto ----------

// Das Portfolio liegt immer im Browser und, wenn angemeldet, zusätzlich im Konto
const depot = { data: pf.load(), user: null, ready: !auth.available, sync: 'local', error: null, stop: null };

function saveDepot(data) {
  depot.data = pf.normalise(data);
  pf.save(depot.data);
  if (depot.user) {
    depot.sync = 'saving';
    auth.savePortfolio(depot.user.uid, depot.data).then(
      () => { depot.sync = 'synced'; depot.error = null; },
      (err) => { depot.sync = 'error'; depot.error = err.message; },
    ).finally(() => current?.update());
  }
  current?.update();
}

function renderAccountLink() {
  const link = $('#nav-account');
  link.textContent = depot.user ? (depot.user.name || depot.user.email || 'Konto') : 'Anmelden';
  link.classList.toggle('signed-in', !!depot.user);
}

auth.onUser(async (user) => {
  depot.stop?.();
  depot.stop = null;
  const before = depot.user;
  depot.user = user;
  depot.ready = true;
  if (user) {
    depot.sync = 'saving';
    let first = true;
    try {
      depot.stop = await auth.watchPortfolio(user.uid, (cloud, pending) => {
        if (cloud) {
          // Eigene, noch nicht bestätigte Änderungen sind lokal schon da
          if (!pending) { depot.data = pf.normalise(cloud); pf.save(depot.data); }
          depot.sync = 'synced';
        } else if (first) saveDepot(depot.data);   // erstes Anmelden: Portfolio aus dem Browser ins Konto übernehmen
        first = false;
        current?.update();
      }, (err) => { depot.sync = 'error'; depot.error = err.message; current?.update(); });
    } catch (err) { depot.sync = 'error'; depot.error = err.message; }
  } else {
    // Nach dem Abmelden bleibt nichts auf dem Gerät zurück; die Daten liegen im Konto
    if (before) { depot.data = pf.empty(); pf.save(depot.data); }
    depot.sync = 'local';
  }
  renderAccountLink();
  // Das Portfolio gibt es nur angemeldet – nach An- oder Abmelden die Ansicht neu wählen
  if (/^#\/(portfolio|konto)/.test(location.hash)) route(); else current?.update();
});

const SYNC_TEXT = {
  local: 'Dein Portfolio ist nur in diesem Browser gespeichert. Mit einem Konto kannst du es von überall abrufen.',
  saving: 'Wird mit deinem Konto abgeglichen …',
  synced: 'In deinem Konto gespeichert – auf jedem Gerät abrufbar, auf dem du dich anmeldest.',
};

// ---------- Daytrading ----------

function tradingView() {
  view.innerHTML = `
    <div class="page-head"><div><h1>Daytrading</h1>
      <p class="hint">Kurzfristige Vorschläge mit Einstieg, Ziel und Stopp – nur wenn ein geprüftes Muster vorliegt. An vielen Tagen bleibt die Liste leer.</p></div></div>
    <section id="t-long"></section>
    <section id="t-short"></section>
    <section id="t-watch"></section>
    <section class="panel" id="t-rules"></section>`;

  const coinCell = (c) => `<a class="coin-cell" href="#/coin/${encodeURIComponent(c.id)}"><img src="${esc(c.image)}" alt="" loading="lazy">
      <div><div class="coin-name">${esc(c.name)}</div><div class="coin-sym">${esc(c.symbol)} · #${c.market_cap_rank ?? '–'}</div></div></a>`;
  const liquid = (c) => c.total_volume >= 2e6 && !DERIVATIVE.test(c.name);

  // Wo steht der Kurs gegenüber dem Vorschlag? Zu weit gelaufen oder unter dem Stopp gilt er nicht mehr.
  function status(c, t) {
    const p = c.current_price, done = (p - t.entry) / (t.target - t.entry);
    if (p <= t.stop) return ['down', 'Stopp erreicht – nicht mehr einsteigen'];
    if (p >= t.target) return ['up', 'Ziel erreicht – Gewinn mitnehmen'];
    if (done > 0.35) return ['', 'schon gelaufen – nicht mehr nachkaufen'];
    return ['up', 'Einstieg jetzt möglich'];
  }

  function update() {
    const list = state.coins.filter((c) => c.analysis.trade?.kind && liquid(c))
      .sort((a, b) => (a.analysis.trade.kind === b.analysis.trade.kind ? b.analysis.score - a.analysis.score : a.analysis.trade.kind === 'selloff' ? -1 : 1));
    const bear = state.market?.regime?.bear;
    $('#t-long').innerHTML = `<h2>Long – auf steigende Kurse</h2>` + (list.length ? `<div class="trades">${list.map((c) => {
      const t = c.analysis.trade, s = TRADE_SETUPS[t.kind], [cls, text] = status(c, t);
      const until = new Date(t.time + t.days * 86_400_000).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
      return `<div class="panel trade">
        <div class="panel-top">${coinCell(c)}<span class="badge buy">Long</span></div>
        <div class="trade-why">${esc(s.label)}${t.kind === 'selloff' ? ` · ${signed(t.r7, 0)} % in 7 Tagen` : ` · Score ${signed(c.analysis.score, 0)}`}</div>
        <dl class="trade-grid">
          <div><dt>Einstieg</dt><dd>${money(t.entry)}</dd><dd class="muted">jetzt ${money(c.current_price)}</dd></div>
          <div><dt>Ziel – verkaufen bei</dt><dd class="up">${money(t.target)}</dd><dd class="muted">+${num(t.targetPct, 1)} %</dd></div>
          <div><dt>Stopp – aussteigen bei</dt><dd class="down">${money(t.stop)}</dd><dd class="muted">−${num(t.stopPct, 1)} %</dd></div>
          <div><dt>Spätestens verkaufen</dt><dd>${until}</dd><dd class="muted">nach ${t.days} Tagen, egal wo der Kurs steht</dd></div></dl>
        <p class="trade-status ${cls}">${text}</p>
        <p class="hint">Rückblick: Solche Signale lagen an ${s.hit} % der Signaltage im Plus, im Mittel ${signed(s.avg, 1)} % je Handel nach Gebühren.
          Das Ziel liegt näher als der Stopp – ein Verlust wiegt also schwerer als ein Gewinn. Je Handel höchstens einen kleinen Teil des Kapitals einsetzen.</p>
      </div>`; }).join('')}</div>`
      : `<div class="panel"><p><strong>Heute kein Long-Vorschlag.</strong></p>
          <p class="muted">${state.coins.length ? `Kein Coin erfüllt im Moment eines der beiden geprüften Muster${bear ? ' – im Bärenmarkt entfällt das Ausverkaufs-Muster ganz' : ''}. Lieber kein Handel als ein unbegründeter.` : 'Lade Kurse …'}</p></div>`);

    $('#t-short').innerHTML = `<h2>Short – auf fallende Kurse</h2><div class="panel"><p><strong>Kein Short-Vorschlag.</strong></p>
      <p class="muted">Ich habe sieben Short-Muster über 8 Jahre geprüft (Verkaufs-Score, Bruch des 20-Tage-Tiefs, Coin fällt allein, starker Tages- und Wochenanstieg).
        Keines lag in beiden Prüfzeiträumen verlässlich im Plus; nach starken Anstiegen verlor ein Short im Mittel sogar 1–2 % je Handel.
        Solange kein Muster die Prüfung besteht, erscheint hier bewusst nichts.</p></div>`;

    // Beobachtungsliste: was einem Muster am nächsten kommt
    const near = state.coins.filter((c) => c.analysis.trade && !c.analysis.trade.kind && liquid(c)).map((c) => {
      const t = c.analysis.trade;
      const drop = t.r7 !== null && t.r7 <= -15 ? { gap: (TRADE_LIMITS.selloff - t.r7) / -10, text: `${signed(t.r7, 0)} % in 7 Tagen – Muster ab ${TRADE_LIMITS.selloff} %` } : null;
      const strong = c.analysis.score >= 28 ? { gap: (TRADE_LIMITS.score - c.analysis.score) / 12, text: `Score ${signed(c.analysis.score, 0)} – Muster ab +${TRADE_LIMITS.score}` } : null;
      const best = [drop, strong].filter(Boolean).sort((a, b) => a.gap - b.gap)[0];
      return best ? { c, ...best } : null;
    }).filter(Boolean).sort((a, b) => a.gap - b.gap).slice(0, 8);
    $('#t-watch').innerHTML = `<h2>Beobachtungsliste</h2><p class="hint">Noch kein Signal – diese Coins sind einem Muster am nächsten.</p>` + (near.length
      ? `<div class="table-wrap"><table><thead><tr><th class="col-coin">Coin</th><th class="num">Kurs</th><th class="num">24 h</th><th>Stand</th></tr></thead>
          <tbody>${near.map(({ c, text }) => `<tr><td class="col-coin">${coinCell(c)}</td><td class="num">${money(c.current_price)}</td>
            <td class="num">${pct(c.price_change_percentage_24h_in_currency)}</td><td>${esc(text)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="panel"><p class="muted">Im Moment ist kein Coin in der Nähe eines Musters.</p></div>');

    const row = (s, when) => `<li><strong>${esc(s.label)}:</strong> ${when} Ziel ${s.target}-fache, Stopp ${s.stop}-fache Tagesschwankung des Coins, höchstens ${s.days} Tage.
      Rückblick über ${num(s.cases, 0)} Fälle: an ${s.hit} % der Signaltage im Plus, im Mittel ${signed(s.avg, 1)} % je Handel.</li>`;
    $('#t-rules').innerHTML = `<h2>So entstehen die Vorschläge</h2>
      <ul class="plain">${row(TRADE_SETUPS.selloff, `Der Coin ist in 7 Tagen um mindestens ${-TRADE_LIMITS.selloff} % gefallen und es herrscht kein Bärenmarkt.`)}
        ${row(TRADE_SETUPS.score, `Der Prognose-Score liegt bei mindestens +${TRADE_LIMITS.score}.`)}</ul>
      <p class="hint">Geprüft an Tageskursen von 84 Coins seit 2018, mit 0,5 % Gebühren je Handel, in zwei getrennten Zeiträumen. Nur Coins mit Tageskursen von Binance und genug Handelsvolumen.
        Die Vorschläge gelten für Tage, nicht für Minuten: Für echtes Handeln im Minutentakt gibt es hier keine geprüfte Grundlage.</p>
      <p class="notice">Sicher ist kein Handel. Rund jeder dritte Vorschlag endete im Rückblick mit Verlust, und weil der Stopp weiter entfernt liegt als das Ziel, ist ein Verlust größer als ein Gewinn.
        Die Rückrechnung enthält nur Coins, die heute noch gehandelt werden – echte Ergebnisse fallen schlechter aus. Keine Anlageberatung.</p>`;
  }
  return { update };
}

// gate: Die Ansicht steht anstelle des Portfolios, solange niemand angemeldet ist
function accountView(gate = false) {
  let shown = null, message = '', busy = false;
  const key = () => (!depot.ready ? 'wait' : depot.user?.uid ?? (auth.available ? 'out' : 'off'));
  const BENEFITS = `<ul class="benefits">
      <li><div><strong>Dein Portfolio, überall</strong><span>Im Konto gespeichert und auf jedem Gerät abrufbar.</span></div></li>
      <li><div><strong>Konkrete Schritte</strong><span>Der Portfolio-Manager sagt, was du kaufen, halten oder verkaufen solltest – mit Begründung, Gebühr und Zeitrahmen.</span></div></li>
      <li><div><strong>Schutz bei fallenden Kursen</strong><span>Verkaufsempfehlung, sobald ein Coin deutlich unter sein Hoch fällt oder der Markt dreht.</span></div></li>
    </ul>`;

  function render() {
    shown = key();
    if (shown === 'wait') {
      view.innerHTML = '<section class="panel"><p class="muted">Anmeldung wird geprüft …</p></section>';
      return;
    }
    if (!auth.available) {
      view.innerHTML = `<h2>${gate ? 'Portfolio' : 'Konto'}</h2><section class="panel">
        <p>${gate ? 'Für das Portfolio brauchst du ein Konto – ' : ''}Konten sind auf dieser Seite noch nicht eingerichtet.</p>
        <p class="hint">Für Betreiber: Firebase-Projekt anlegen und die Zugangsdaten in <code>js/firebase-config.js</code> eintragen – die Schritte stehen in der README.</p>
      </section>`;
      return;
    }
    if (depot.user) {
      view.innerHTML = `<h2>Konto</h2><section class="panel">
        <p>Angemeldet als <strong>${esc(depot.user.email ?? depot.user.name ?? '')}</strong></p>
        <p class="hint" id="a-sync"></p>
        <p><a class="btn" href="#/portfolio">Zum Portfolio</a> <button class="btn ghost" id="a-logout">Abmelden</button></p>
        <p id="a-msg" class="notice" hidden></p>
      </section>`;
      $('#a-logout').addEventListener('click', () => act(() => auth.logout()));
      return;
    }
    const form = `<section class="panel account">
        <h2>Anmelden oder Konto erstellen</h2>
        <button class="btn google" id="a-google" type="button">Mit Google anmelden</button>
        <div class="or"><span>oder mit E-Mail-Adresse</span></div>
        <form id="a-form" class="form">
          <label>E-Mail-Adresse <input id="a-email" type="email" autocomplete="email" required></label>
          <label>Passwort (mindestens 6 Zeichen) <input id="a-password" type="password" autocomplete="current-password" required minlength="6"></label>
          <div class="btn-row">
            <button class="btn" type="submit" data-action="login">Anmelden</button>
            <button class="btn ghost" type="submit" data-action="register">Konto erstellen</button>
          </div>
          <button class="link" type="button" id="a-reset">Passwort vergessen?</button>
        </form>
        <p id="a-msg" class="notice" hidden></p>
      </section>`;
    view.innerHTML = `<div class="gate">
        <div>
          <h1>${gate ? 'Melde dich an, um dein Portfolio zu sehen' : 'Dein Konto bei Krypto Markt'}</h1>
          <p class="lead">Das Portfolio und der Portfolio-Manager sind an ein Konto gebunden. Kurse, Prognosen und Markt-Index bleiben ohne Anmeldung frei.</p>
          ${BENEFITS}
        </div>
        ${form}
      </div>`;
    $('#a-google').addEventListener('click', () => act(() => auth.loginGoogle(), true));
    $('#a-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = $('#a-email').value.trim(), password = $('#a-password').value;
      const register = e.submitter?.dataset.action === 'register';
      act(() => (register ? auth.register(email, password) : auth.login(email, password)), true);
    });
    $('#a-reset').addEventListener('click', () => {
      const email = $('#a-email').value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { message = 'Bitte gib oben deine E-Mail-Adresse ein und klick dann erneut auf „Passwort vergessen?“.'; return update(); }
      act(async () => { await auth.resetPassword(email); message = `Falls es ein Konto für ${email} gibt, ist eine E-Mail zum Zurücksetzen unterwegs.`; });
    });
  }

  // Führt eine Konto-Aktion aus und zeigt Fehler an; nach erfolgreicher Anmeldung geht es zum Portfolio
  async function act(fn, toPortfolio = false) {
    if (busy) return;
    busy = true; message = '';
    update();
    try {
      await fn();
      if (toPortfolio) location.hash = '#/portfolio';
    } catch (err) { message = err.message; }
    busy = false;
    if (current === self) update();
  }

  function update() {
    if (key() !== shown) render();
    const msg = $('#a-msg');
    if (msg) { msg.hidden = !message; msg.textContent = message; }
    const sync = $('#a-sync');
    if (sync) sync.textContent = depot.sync === 'error' ? `Speichern fehlgeschlagen: ${depot.error}` : SYNC_TEXT[depot.sync];
    for (const b of view.querySelectorAll('button')) b.disabled = busy;
  }

  const self = { update };
  return self;
}

// ---------- Portfolio ----------

const ALLOC_COLORS = ['var(--accent)', 'var(--violet)', 'var(--up)', '#38bdf8', 'var(--hold)', '#f472b6'];
const MOVE_LABEL = { sell: 'Verkaufen', profit: 'Gewinn mitnehmen', reduce: 'Reduzieren', swap: 'Tauschen', buy: 'Kaufen', add: 'Nachkaufen' };
const dateText = (d) => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

// Zuletzt berechnete Vorschläge. Sie bleiben stehen, bis sich das Portfolio ändert oder neu berechnet wird –
// laufende Kursänderungen verschieben sie nicht.
let advice = null;
const ADVICE_STALE_MS = 30 * 60_000;

function portfolioView() {
  let message = '';
  let imp = null;          // Import: eingelesene Tabelle und Spaltenzuordnung
  let recalc = false;
  view.innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">Mein Portfolio</h1><p class="hint" id="p-where"></p></div>
      <div class="actions">
        <button class="btn" id="p-open-add">+ Position</button>
        <button class="btn ghost" id="p-open-import">Importieren</button>
        <button class="btn ghost" id="p-open-reserve">Reserve-Ziel <b id="r-chip"></b></button>
      </div>
    </div>
    <p id="p-msg" class="notice" hidden></p>
    <div id="p-empty"></div>
    <div id="p-body">
      <section id="p-summary" class="summary"></section>
      <div id="p-alloc"></div>
      <h2>Bestand</h2>
      <div class="table-wrap"><table>
        <thead><tr><th class="col-coin">Coin</th><th class="num">Menge</th><th class="num col-7d">Kurs</th><th class="num">24 h</th><th class="num">Wert</th><th class="num col-cap">Anteil</th>
          <th class="num col-30d">Ø Kaufpreis</th><th class="num">Gewinn / Verlust</th><th class="col-score">Prognose</th><th>Signal</th><th></th></tr></thead>
        <tbody id="p-rows"></tbody>
      </table></div>
      <p class="foot-actions"><button class="link" id="p-clear" type="button">Portfolio leeren</button></p>
      <div id="p-manager"></div>
    </div>

    <dialog id="dlg-add" class="dialog">
      <form id="p-add" class="form" method="dialog">
        <div class="dialog-top"><h2>Position hinzufügen</h2><button class="icon" type="button" data-close aria-label="Schließen">✕</button></div>
        <label>Coin <input id="p-coin" list="coinlist" placeholder="z. B. Bitcoin oder BTC" required autocomplete="off"></label>
        <datalist id="coinlist"></datalist>
        <label>Menge <input id="p-amount" inputmode="decimal" placeholder="0,5" required></label>
        <label>Kaufpreis je Coin in USD (optional) <input id="p-cost" inputmode="decimal" placeholder="leer = aktueller Kurs"></label>
        <p id="p-add-msg" class="notice" hidden></p>
        <div class="btn-row"><button class="btn" type="submit">Hinzufügen</button><button class="btn ghost" type="button" data-close>Abbrechen</button></div>
      </form>
    </dialog>

    <dialog id="dlg-edit" class="dialog">
      <form id="p-edit" class="form" method="dialog">
        <div class="dialog-top"><h2 id="e-title">Position ändern</h2><button class="icon" type="button" data-close aria-label="Schließen">✕</button></div>
        <div class="chips" id="e-actions" role="group" aria-label="Was möchtest du tun?">
          <button type="button" class="chip active" data-action="swap">Tauschen</button>
          <button type="button" class="chip" data-action="sell">Verkaufen</button>
          <button type="button" class="chip" data-action="remove">Entfernen</button>
        </div>
        <p class="hint" id="e-help"></p>
        <label>Menge <span id="e-have"></span>
          <span class="input-row"><input id="e-amount" inputmode="decimal" required><button class="btn ghost small" type="button" id="e-all">Alles</button></span></label>
        <label id="e-target-row">Tauschen in <input id="e-target" list="coinlist" placeholder="z. B. Ethereum oder ETH" autocomplete="off"></label>
        <label class="check" id="e-fee-row"><input type="checkbox" id="e-fee" checked> Gebühr von 0,25 % je Kauf und Verkauf abziehen</label>
        <p id="e-preview" class="preview"></p>
        <p id="e-msg" class="notice" hidden></p>
        <div class="btn-row"><button class="btn" type="submit" id="e-submit">Tauschen</button><button class="btn ghost" type="button" data-close>Abbrechen</button></div>
      </form>
    </dialog>

    <dialog id="dlg-reserve" class="dialog">
      <div>
        <div class="dialog-top"><h2>Reserve-Ziel</h2><button class="icon" type="button" data-close aria-label="Schließen">✕</button></div>
        <p class="hint">So viel deines Portfolios <em>soll</em> als Reserve liegen (Bargeld und Stablecoins) statt in Coins. Das ist ein Ziel – die Vorschläge zeigen, wie du dorthin kommst.</p>
        <p id="r-actual"></p>
        <strong class="reserve-value" id="r-value"></strong>
        <input type="range" id="r-slider" min="0" max="100" step="5" aria-label="Gewünschte Reserve in Prozent">
        <div class="range-labels"><span>0 % · voll investiert</span><span>100 % · alles in Reserve</span></div>
        <div id="r-options" class="reserve-options"></div>
        <p class="hint" id="r-hint"></p>
        <div class="reserve-row">
          <form id="p-cash" class="inline-form">
            <label for="p-cash-value">Bargeld außerhalb der Coins (USD)</label>
            <input id="p-cash-value" inputmode="decimal" placeholder="0">
            <button class="btn ghost small" type="submit">Speichern</button>
          </form>
        </div>
        <div class="btn-row done-row"><button class="btn" type="button" data-close>Fertig</button></div>
      </div>
    </dialog>

    <dialog id="dlg-import" class="dialog wide">
      <div class="dialog-top"><h2>Portfolio importieren</h2><button class="icon" type="button" data-close aria-label="Schließen">✕</button></div>
      <div id="imp-body"></div>
    </dialog>`;

  const say = (text) => { message = text; update(); };
  const copy = () => depot.data.positions.map((p) => ({ ...p }));
  const store = (positions, extra = {}) => saveDepot({ ...depot.data, positions, ...extra });
  const find = (pos) => (pos.id && state.byId.get(pos.id))
    || state.bySymbol.get((pos.symbol || pos.name || '').toLowerCase())
    || state.byName.get((pos.name || pos.symbol || '').toLowerCase())
    || state.bySymbol.get((pos.name || '').toLowerCase());

  // ----- Dialoge -----
  for (const d of view.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  }
  $('#p-open-add').addEventListener('click', () => { $('#p-add-msg').hidden = true; $('#dlg-add').showModal(); });
  $('#p-open-reserve').addEventListener('click', () => $('#dlg-reserve').showModal());
  $('#p-open-import').addEventListener('click', () => { imp = null; renderImport(); $('#dlg-import').showModal(); });
  view.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-add]')) $('#p-open-add').click();
    if (e.target.closest('[data-open-import]')) $('#p-open-import').click();
  });

  $('#p-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const fail = (text) => { $('#p-add-msg').hidden = false; $('#p-add-msg').textContent = text; };
    const text = $('#p-coin').value.trim();
    const m = text.match(/^(.*)\(([^)]+)\)$/);
    const c = (m && state.coins.find((x) => x.name === m[1].trim() && x.symbol.toUpperCase() === m[2].trim().toUpperCase()))
      || find({ symbol: text, name: text });
    const amount = pf.parseInput($('#p-amount').value);
    const cost = pf.parseInput($('#p-cost').value);
    if (!c) return fail(`„${text}“ wurde unter den geladenen Coins nicht gefunden.`);
    if (!(amount > 0)) return fail('Bitte eine Menge größer als 0 eingeben.');
    message = `${c.name} hinzugefügt.`;
    e.target.reset();
    $('#dlg-add').close();
    store(pf.add(copy(), { id: c.id, symbol: c.symbol, name: c.name, amount, cost: cost > 0 ? cost : c.current_price, costCur: 'usd', since: Date.now(), peak: c.current_price }));
  });

  // ----- Import in zwei Schritten: Datei wählen, dann Zuordnung prüfen -----
  function renderImport(error = '') {
    const el = $('#imp-body');
    if (!imp) {
      el.innerHTML = `
        <p class="hint">Exportiere dein Portfolio bei CoinMarketCap als CSV-Datei und wähle sie hier aus. Es funktionieren auch Exporte anderer Anbieter –
          im nächsten Schritt siehst du, was erkannt wurde, und kannst die Spalten selbst zuordnen.</p>
        <div class="form">
          <label>Datei (CSV oder Text) <input type="file" id="imp-file" accept=".csv,.tsv,.txt,text/csv,text/plain"></label>
          <label>oder Inhalt hier einfügen <textarea id="imp-text" rows="4" placeholder="Kopfzeile und Zeilen aus der Datei"></textarea></label>
          ${error ? `<p class="notice">${esc(error)}</p>` : ''}
          <div class="btn-row"><button class="btn" id="imp-next" type="button">Weiter</button><button class="btn ghost" type="button" data-close>Abbrechen</button></div>
        </div>`;
      $('#imp-next').addEventListener('click', async () => {
        try {
          const file = $('#imp-file').files[0];
          const text = file ? await pf.readFile(file) : $('#imp-text').value;
          if (!text.trim()) return renderImport('Bitte eine Datei auswählen oder den Inhalt einfügen.');
          imp = pf.parseTable(text);
          renderImport();
        } catch (err) { imp = null; renderImport('Die Datei konnte nicht gelesen werden: ' + err.message); }
      });
      return;
    }

    const option = (i, sel) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(imp.header[i] || `Spalte ${i + 1}`)}</option>`;
    const result = pf.buildPositions(imp.rows, imp.columns);
    const hasCoin = imp.columns.symbol !== undefined || imp.columns.name !== undefined;
    const ok = hasCoin && imp.columns.amount !== undefined && result.positions.length > 0;
    const found = result.positions.filter((p) => find(p)).length;
    el.innerHTML = `
      <p class="hint">${imp.rows.length} Zeilen gelesen. Prüfe, ob die Spalten richtig zugeordnet sind – Coin und Menge werden gebraucht, der Rest ist freiwillig.</p>
      <div class="map-grid">${pf.ROLES.map(([role, label]) => `<label>${label}
          <select data-role="${role}"><option value="">– keine –</option>${imp.header.map((_, i) => option(i, imp.columns[role])).join('')}</select></label>`).join('')}</div>
      <h3>Erkannt</h3>
      ${ok ? `<ul class="import-list">${result.positions.slice(0, 8).map((p) => {
          const c = find(p);
          return `<li><span class="tag ${c ? 'up' : 'down'}">${c ? 'gefunden' : 'unbekannt'}</span>
            <span><strong>${esc(c?.name ?? p.name ?? p.symbol)}</strong> · ${p.amount.toLocaleString('de-DE', { maximumFractionDigits: 8 })} ${esc((c?.symbol ?? p.symbol ?? '').toUpperCase())}${p.cost ? ` · Ø ${money(p.cost)}` : ''}</span></li>`;
        }).join('')}</ul>
        <p class="hint">${result.positions.length} Positionen, davon ${found} unter den Top 1000 gefunden${result.positions.length > 8 ? ` (gezeigt: die ersten 8)` : ''}${result.skipped ? ` · ${result.skipped} Zeilen ohne Coin oder Menge übersprungen` : ''}.</p>`
        : `<p class="notice">${!hasCoin || imp.columns.amount === undefined ? 'Bitte oben die Spalten für Coin und Menge auswählen.' : 'Mit dieser Zuordnung ergeben sich keine Bestände. Stimmt die Spalte für die Menge?'}</p>`}
      <label class="check"><input type="checkbox" id="imp-replace" checked> Bestehende Positionen ersetzen</label>
      <div class="btn-row"><button class="btn" id="imp-do" type="button" ${ok ? '' : 'disabled'}>Importieren</button><button class="btn ghost" id="imp-back" type="button">Zurück</button></div>`;
    for (const sel of el.querySelectorAll('select[data-role]')) {
      sel.addEventListener('change', () => {
        if (sel.value === '') delete imp.columns[sel.dataset.role]; else imp.columns[sel.dataset.role] = Number(sel.value);
        renderImport();
      });
    }
    $('#imp-back').addEventListener('click', () => { imp = null; renderImport(); });
    $('#imp-do').addEventListener('click', () => {
      // Fehlt in der Datei ein Kaufpreis, gilt der aktuelle Kurs
      const fresh = result.positions.map((p) => { const c = find(p); return { ...p, id: c?.id ?? null, cost: p.cost ?? c?.current_price ?? null, since: Date.now() }; });
      message = `${fresh.length} Positionen importiert.`;
      const replace = $('#imp-replace').checked;
      $('#dlg-import').close();
      store(replace ? fresh : fresh.reduce(pf.add, copy()));
    });
  }

  // ----- Reserve -----
  // Reserve-Ziel: eigener Wert oder der Vorschlag der gewählten Art (ausgewogen/vorsichtig)
  const reserveTarget = () => depot.data.reservePct ?? reserveAdvice(state.market?.regime)[depot.data.reserveMode];
  $('#r-slider').addEventListener('input', (e) => { $('#r-value').textContent = `${e.target.value} %`; });
  $('#r-slider').addEventListener('change', (e) => {
    message = '';
    saveDepot({ ...depot.data, reservePct: Number(e.target.value) });
  });
  $('#r-options').addEventListener('click', (e) => {
    const mode = e.target.closest('[data-mode]')?.dataset.mode;
    if (mode) { message = ''; saveDepot({ ...depot.data, reservePct: null, reserveMode: mode }); }
  });
  $('#p-cash').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('#p-cash-value').value.trim();
    const cash = raw ? pf.parseInput(raw) : 0;
    if (!(cash >= 0)) return say('Bitte einen Betrag von 0 oder mehr eingeben.');
    message = 'Bargeld gespeichert.';
    $('#p-cash-value').blur();
    saveDepot({ ...depot.data, cash });
  });

  // ----- Position ändern: tauschen, verkaufen oder entfernen -----
  const EDIT = {
    swap: { button: 'Tauschen', help: 'Tauscht die Menge in einen anderen Coin. Der neue Coin bekommt den Gegenwert als Kaufpreis.' },
    sell: { button: 'Verkaufen', help: 'Verkauft die Menge zum aktuellen Kurs. Der Erlös wird deinem Bargeld gutgeschrieben.' },
    remove: { button: 'Entfernen', help: 'Nimmt die Menge aus dem Portfolio, ohne etwas zu verbuchen – z. B. um einen Eintrag zu korrigieren.' },
  };
  let edit = null;   // { key, action }
  const amountText = (v) => v.toLocaleString('de-DE', { maximumFractionDigits: 12, useGrouping: false });

  const resolveCoin = (text) => {
    const m = text.match(/^(.*)\(([^)]+)\)$/);
    return (m && state.coins.find((x) => x.name === m[1].trim() && x.symbol.toUpperCase() === m[2].trim().toUpperCase()))
      || find({ symbol: text, name: text });
  };

  // Rechnet aus den Eingaben, was passieren würde; error ist gesetzt, wenn noch etwas fehlt
  function editPlan() {
    const pos = depot.data.positions.find((p) => pf.keyOf(p) === edit.key);
    if (!pos) return { error: 'Diese Position gibt es nicht mehr.' };
    const c = find(pos);
    const units = pf.parseInput($('#e-amount').value);
    if (!(units > 0)) return { pos, c, error: 'Bitte eine Menge größer als 0 eingeben.' };
    if (units > pos.amount * 1.0000001) return { pos, c, error: `Du hast nur ${pos.amount.toLocaleString('de-DE', { maximumFractionDigits: 8 })}.` };
    const amount = Math.min(units, pos.amount);
    if (edit.action === 'remove') return { pos, c, amount };
    if (!c || !isNum(c.current_price)) return { pos, c, error: 'Für diesen Coin gibt es keinen Kurs – er lässt sich nur entfernen.' };
    const fee = $('#e-fee').checked ? 0.0025 : 0;
    const usd = amount * c.current_price;
    if (edit.action === 'sell') return { pos, c, amount, fee, usd, proceeds: usd * (1 - fee) };
    const text = $('#e-target').value.trim();
    if (!text) return { pos, c, amount, fee, usd, error: 'Bitte den Coin angeben, in den getauscht werden soll.' };
    const to = resolveCoin(text);
    if (!to) return { pos, c, error: `„${text}“ wurde unter den geladenen Coins nicht gefunden.` };
    if (to.id === c.id) return { pos, c, error: 'Bitte einen anderen Coin wählen.' };
    if (!isNum(to.current_price) || !(to.current_price > 0)) return { pos, c, error: `Für ${to.name} gibt es gerade keinen Kurs.` };
    return { pos, c, amount, fee, usd, to, toUnits: usd * (1 - fee) * (1 - fee) / to.current_price };
  }

  function renderEdit(showError = false) {
    const p = editPlan();
    const sym = (p.c?.symbol ?? p.pos?.symbol ?? '').toUpperCase();
    for (const b of $('#e-actions').children) b.classList.toggle('active', b.dataset.action === edit.action);
    $('#e-title').textContent = `${p.c?.name ?? p.pos?.name ?? p.pos?.symbol ?? 'Position'} ändern`;
    $('#e-help').textContent = EDIT[edit.action].help;
    $('#e-have').textContent = p.pos ? `(vorhanden: ${p.pos.amount.toLocaleString('de-DE', { maximumFractionDigits: 8 })} ${sym})` : '';
    $('#e-target-row').hidden = edit.action !== 'swap';
    $('#e-fee-row').hidden = edit.action === 'remove';
    $('#e-submit').textContent = EDIT[edit.action].button;
    const units = (v) => v.toLocaleString('de-DE', { maximumSignificantDigits: 6 });
    $('#e-preview').innerHTML = p.error ? ''
      : edit.action === 'swap' ? `${units(p.amount)} ${esc(sym)} (${money(p.usd)}) → rund <strong>${units(p.toUnits)} ${esc(p.to.symbol.toUpperCase())}</strong>${p.fee ? ` · Gebühr rund ${money(p.usd * p.fee * 2)}` : ''}`
        : edit.action === 'sell' ? `${units(p.amount)} ${esc(sym)} → <strong>${money(p.proceeds)}</strong> ins Bargeld${p.fee ? ` · Gebühr rund ${money(p.usd * p.fee)}` : ''}`
          : `${units(p.amount)} ${esc(sym)} werden entfernt${p.amount >= p.pos.amount ? ' – die Position verschwindet ganz' : ''}.`;
    $('#e-msg').hidden = !(showError && p.error);
    $('#e-msg').textContent = p.error ?? '';
    return p;
  }

  $('#p-rows').addEventListener('click', (e) => {
    const key = e.target.closest('[data-edit]')?.dataset.edit;
    if (key === undefined) return;
    const pos = depot.data.positions.find((p) => pf.keyOf(p) === key);
    if (!pos) return;
    // Ohne Kurs lässt sich nicht tauschen oder verkaufen – dann direkt „Entfernen“
    edit = { key, action: find(pos) ? 'swap' : 'remove' };
    $('#e-amount').value = amountText(pos.amount);
    $('#e-target').value = '';
    renderEdit();
    $('#dlg-edit').showModal();
  });
  $('#e-actions').addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action) { edit.action = action; renderEdit(); }
  });
  $('#e-all').addEventListener('click', () => {
    const pos = depot.data.positions.find((p) => pf.keyOf(p) === edit.key);
    if (pos) { $('#e-amount').value = amountText(pos.amount); renderEdit(); }
  });
  for (const id of ['#e-amount', '#e-target', '#e-fee']) $(id).addEventListener('input', () => renderEdit());

  $('#p-edit').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = renderEdit(true);
    if (p.error) return;
    const sym = (p.c?.symbol ?? p.pos.symbol ?? '').toUpperCase();
    const units = p.amount.toLocaleString('de-DE', { maximumSignificantDigits: 6 });
    if (edit.action === 'remove') {
      message = `${units} ${sym} entfernt.`;
      $('#dlg-edit').close();
      return store(copy().map((x) => (pf.keyOf(x) === edit.key ? { ...x, amount: x.amount - p.amount } : x)));
    }
    // Importierte Positionen kennen ihre Coin-ID noch nicht – hier wird sie ergänzt
    const withIds = copy().map((x) => ({ ...x, id: x.id ?? find(x)?.id ?? null }));
    const move = edit.action === 'sell'
      ? { type: 'sell', id: p.c.id, usd: p.usd, price: p.c.current_price }
      : { type: 'swap', id: p.c.id, usd: p.usd, price: p.c.current_price,
        toCoin: { id: p.to.id, symbol: p.to.symbol, name: p.to.name, price: p.to.current_price } };
    const result = applyMove(withIds, depot.data.cash, move, { fee: p.fee });
    if (!result) { $('#e-msg').hidden = false; $('#e-msg').textContent = 'Das hat nicht geklappt – bitte Menge prüfen.'; return; }
    message = edit.action === 'sell' ? `${units} ${sym} verkauft, ${money(p.proceeds)} ins Bargeld gebucht.`
      : `${units} ${sym} in ${p.to.name} getauscht.`;
    $('#dlg-edit').close();
    saveDepot({ ...depot.data, positions: result.positions, cash: result.cash });
  });

  $('#p-clear').addEventListener('click', () => { message = 'Portfolio geleert.'; saveDepot(pf.empty()); });

  $('#p-manager').addEventListener('click', (e) => {
    if (e.target.closest('[data-recalc]')) { recalc = true; return update(); }
    // Einen empfohlenen Schritt als ausgeführt eintragen: Mengen, Reserve und Kaufpreise werden angepasst
    const index = e.target.closest('[data-move]')?.dataset.move;
    const move = advice?.plan.moves[index];
    if (!move) return;
    // Importierte Positionen kennen ihre Coin-ID noch nicht – hier wird sie ergänzt
    const withIds = copy().map((p) => ({ ...p, id: p.id ?? find(p)?.id ?? null }));
    const stableIds = withIds.filter((p) => state.byId.get(p.id)?.analysis.stable).map((p) => p.id);
    const result = applyMove(withIds, depot.data.cash, move, { stableIds });
    if (!result) return say('Für diesen Kauf fehlt die Reserve. Trag zuerst die Verkäufe als umgesetzt ein oder erhöhe das Bargeld.');
    message = `Eingetragen: ${move.title}.`;
    saveDepot({ ...depot.data, positions: result.positions, cash: result.cash });
  });

  // Höchster Kurs seit dem Kauf: gespeicherter Wert, aktueller Kurs und – wenn vorhanden – die Tageskurse seit dem Kaufdatum
  function peakOf(pos, c) {
    if (!c || !isNum(c.current_price) || c.analysis.stable) return null;
    let peak = Math.max(pos.peak ?? 0, c.current_price);
    if (c.ind && pos.since) {
      for (let i = c.ind.n - 1; i >= 0 && c.ind.times[i] >= pos.since; i--) peak = Math.max(peak, c.ind.prices[i]);
    }
    return peak;
  }

  const self = { update };
  let optionCount = -1;

  function update() {
    const list = depot.data.positions;
    $('#p-where').textContent = depot.sync === 'error' ? `Speichern im Konto fehlgeschlagen: ${depot.error}` : SYNC_TEXT[depot.sync];
    $('#p-msg').hidden = !message; $('#p-msg').textContent = message;
    if (optionCount !== state.coins.length) {
      optionCount = state.coins.length;
      $('#coinlist').innerHTML = state.coins.map((c) => `<option value="${esc(c.name)} (${esc(c.symbol.toUpperCase())})">`).join('');
    }

    const isEmpty = !list.length && !depot.data.cash;
    $('#p-body').hidden = isEmpty;
    $('#p-empty').innerHTML = isEmpty ? `<section class="panel empty-state">
        <h2>Noch nichts im Portfolio</h2>
        <p class="muted">Füge deine Coins hinzu oder importiere dein Portfolio. Danach siehst du Wert, Gewinn und konkrete Vorschläge.</p>
        <div class="btn-row"><button class="btn" data-open-add>+ Position hinzufügen</button><button class="btn ghost" data-open-import>Importieren</button></div>
      </section>` : '';
    if (isEmpty) { advice = null; return; }

    const rows = list.map((pos) => {
      const c = find(pos);
      const value = c ? pos.amount * c.current_price : null;
      const unit = isNum(pos.cost) ? pos.cost : null;
      const paid = unit === null ? null : unit * pos.amount;
      return { pos, c, value, unit, paid, gain: value !== null && paid !== null ? value - paid : null, peak: peakOf(pos, c) };
    }).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));

    // Neues Hoch seit dem Kauf merken (Grundlage der Schutzregel) – gespeichert wird erst ab 1 % Unterschied
    if (rows.some((r) => r.peak && r.peak > (r.pos.peak ?? 0) * 1.01)) {
      return store(list.map((p) => { const r = rows.find((x) => x.pos === p); return r?.peak ? { ...p, peak: Math.max(p.peak ?? 0, r.peak) } : p; }));
    }

    const cash = depot.data.cash;
    const total = rows.reduce((s, r) => s + (r.value ?? 0), 0) + cash;
    const stableValue = rows.filter((r) => r.c?.analysis.stable).reduce((s, r) => s + r.value, 0);
    const priced = rows.filter((r) => r.gain !== null);
    const paid = priced.reduce((s, r) => s + r.paid, 0);
    const gain = priced.reduce((s, r) => s + r.gain, 0);
    const day = rows.reduce((s, r) => {
      const ch = r.c?.price_change_percentage_24h_in_currency;
      return s + (r.value !== null && isNum(ch) ? r.value - r.value / (1 + ch / 100) : 0);
    }, 0);

    const card = (label, value, sub = '', cls = '') => `<div class="card ${cls}"><div class="label">${label}</div><div class="value">${value}</div><div class="muted">${sub}</div></div>`;
    $('#p-summary').innerHTML = card('Gesamtwert', money(total), `heute ${pct(total - day > 0 ? day / (total - day) * 100 : 0)} (${money(day)})`, 'main') +
      card('Gewinn / Verlust', priced.length ? `<span class="${tone(gain)}">${money(gain)}</span>` : '–', paid ? pct(gain / paid * 100) : 'Kaufpreise fehlen') +
      card('Reserve aktuell', money(cash + stableValue), total ? `${num((cash + stableValue) / total * 100, 0)} % des Portfolios · Ziel ${reserveTarget()} %` : '');

    $('#p-rows').innerHTML = rows.length ? rows.map(({ pos, c, value, unit, paid: p, gain: g }) => {
      const a = c?.analysis;
      const name = c ? `<a class="coin-cell" href="#/coin/${encodeURIComponent(c.id)}"><img src="${esc(c.image)}" alt="" loading="lazy">
          <div><div class="coin-name">${esc(c.name)}</div><div class="coin-sym">${esc(c.symbol)}</div></div></a>`
        : `<div><div class="coin-name">${esc(pos.name || pos.symbol)}</div><div class="coin-sym">${state.pagesLoaded < api.PAGES ? 'wird geladen …' : 'nicht in den Top 1000'}</div></div>`;
      return `<tr>
        <td class="col-coin">${name}</td>
        <td class="num">${pos.amount.toLocaleString('de-DE', { maximumFractionDigits: 8 })}</td>
        <td class="num col-7d">${c ? money(c.current_price) : '–'}</td>
        <td class="num">${pct(c?.price_change_percentage_24h_in_currency)}</td>
        <td class="num">${money(value)}</td>
        <td class="num col-cap">${value !== null && total ? num(value / total * 100) + ' %' : '–'}</td>
        <td class="num col-30d">${unit === null ? '–' : money(unit)}</td>
        <td class="num">${g === null ? '–' : `<span class="${tone(g)}">${money(g)}</span><br><small>${pct(g / p * 100)}</small>`}</td>
        <td class="col-score">${a ? scoreCell(a.score) : '–'}</td>
        <td>${a ? badge(a) : '–'}</td>
        <td><button class="btn ghost small" data-edit="${esc(pf.keyOf(pos))}">Ändern</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="11" class="empty">Noch keine Coins – nur Bargeld. Mit „+ Position“ fügst du Coins hinzu.</td></tr>';

    allocation(rows, cash, total);
    reserve(cash + stableValue, total);
    manager(rows, total);
  }

  function reserve(actual, total) {
    const advice = reserveAdvice(state.market?.regime);
    const chosen = depot.data.reservePct;
    const mode = depot.data.reserveMode;
    const value = reserveTarget();
    const slider = $('#r-slider');
    if (document.activeElement !== slider) { slider.value = value; $('#r-value').textContent = `${value} %`; }
    $('#r-chip').textContent = `${value} %`;
    const share = total ? actual / total * 100 : 0;
    const gap = total * value / 100 - actual;
    $('#r-actual').innerHTML = `Aktuell liegen <strong>${money(actual)}</strong> in Reserve (${num(share, 0)} %). `
      + (Math.abs(gap) < total * 0.02 ? 'Das entspricht dem Ziel.'
        : gap > 0 ? `Für ${value} % fehlen rund <strong>${money(gap)}</strong> – dafür schlägt der Manager Verkäufe vor.`
          : `Das sind rund <strong>${money(-gap)}</strong> mehr als das Ziel – dafür schlägt der Manager Käufe vor.`);

    // Zwei berechnete Vorschläge zur Wahl; der Regler setzt einen eigenen Wert
    const option = (key, title) => `<button type="button" class="reserve-option ${chosen === null && mode === key ? 'active' : ''}" data-mode="${key}">
        <span class="label">${title}</span><strong>${advice[key]} %</strong>
        <span class="muted">Rückrechnung: rund +${RESERVE_BACKTEST[key].perYear} % pro Jahr, zwischenzeitlich bis zu −${RESERVE_BACKTEST[key].drawdown} %</span></button>`;
    $('#r-options').innerHTML = state.market ? option('balanced', 'Ausgewogen') + option('cautious', 'Vorsichtig') : '';
    const h = advice.history;
    $('#r-hint').innerHTML = !state.market ? 'Der Vorschlag wird berechnet …' : `
      ${chosen === null ? `Du folgst dem Vorschlag „${mode === 'cautious' ? 'Vorsichtig' : 'Ausgewogen'}“ – er passt sich der Marktphase an.`
        : `Du hast <strong>${chosen} %</strong> selbst eingestellt. Ein Klick auf einen Vorschlag folgt wieder der Marktphase.`}
      ${esc(advice.text)}
      ${h ? `In vergleichbaren Marktphasen seit 2018 stand der Markt 30 Tage später in <strong>${h.up} %</strong> der Fälle höher; im schlechtesten Zehntel der Fälle lag er mindestens <strong>${-h.worst} %</strong> tiefer.` : ''}
      Die Rückrechnungen enthalten nur Coins, die es heute noch gibt, und fallen deshalb zu gut aus.`;
    const cashInput = $('#p-cash-value');
    if (document.activeElement !== cashInput) cashInput.value = depot.data.cash ? String(Math.round(depot.data.cash * 100) / 100).replace('.', ',') : '';
  }

  // Verteilung des Portfolios als Balken: die größten Positionen einzeln, der Rest zusammengefasst
  function allocation(rows, cash, total) {
    const el = $('#p-alloc');
    if (!(total > 0)) { el.innerHTML = ''; return; }
    const parts = [];
    let reserveValue = cash, other = 0;
    for (const r of rows.filter((x) => x.value > 0)) {
      if (r.c.analysis.stable) reserveValue += r.value;
      else if (parts.length < 6) parts.push({ name: r.c.name, value: r.value, color: ALLOC_COLORS[parts.length] });
      else other += r.value;
    }
    if (other > 0) parts.push({ name: 'Weitere', value: other, color: 'var(--muted)' });
    if (reserveValue > 0) parts.push({ name: 'Reserve', value: reserveValue, color: 'var(--line-strong)' });
    el.innerHTML = `<section class="panel"><div class="label">Verteilung</div>
      <div class="alloc" role="img" aria-label="Verteilung des Portfolios">${parts.map((p) => `<i style="width:${(p.value / total * 100).toFixed(2)}%;background:${p.color}" title="${esc(p.name)}"></i>`).join('')}</div>
      <div class="alloc-legend">${parts.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.name)} <b>${num(p.value / total * 100, 0)} %</b></span>`).join('')}</div>
    </section>`;
  }

  function manager(rows, total) {
    const el = $('#p-manager');
    if (!(total > 0)) { advice = null; el.innerHTML = ''; return; }
    // Vorschläge erst zeigen, wenn alle Kurse und Bewertungen geladen sind – vorher würden sie sich ständig ändern
    const ready = state.pagesLoaded >= api.PAGES && state.refineDone && !!state.market;
    const key = JSON.stringify([depot.data.positions.map((p) => [pf.keyOf(p), p.amount, p.cost]), depot.data.cash, depot.data.reservePct, depot.data.reserveMode]);

    if (ready && (!advice || advice.key !== key || recalc)) {
      recalc = false;
      const known = rows.filter((r) => r.c && isNum(r.c.current_price));
      const held = new Set(known.map((r) => r.c.id));
      const candidates = state.coins.filter((c) => c.analysis.signal === 'buy' && !held.has(c.id) &&
        (c.market_cap_rank ?? 9999) <= 300 && c.total_volume >= 5e6 && !DERIVATIVE.test(c.name))
        .sort((a, b) => adjusted(b.analysis) - adjusted(a.analysis)).slice(0, 16)
        .map((c) => ({ id: c.id, name: c.name, symbol: c.symbol, price: c.current_price, analysis: c.analysis }));
      const p = plan({
        holdings: known.map((r) => ({ id: r.c.id, name: r.c.name, symbol: r.c.symbol, units: r.pos.amount, price: r.c.current_price, cost: r.unit, peak: r.peak, trimPrice: r.pos.trimPrice, analysis: r.c.analysis })),
        cash: depot.data.cash, candidates, regime: state.market.regime,
        core: ['bitcoin', 'ethereum'].map((id) => state.byId.get(id)).filter((c) => c && isNum(c.current_price))
          .map((c) => ({ id: c.id, name: c.name, symbol: c.symbol, price: c.current_price, analysis: c.analysis })),
        options: depot.data.reservePct === null ? { exposureCurve: EXPOSURE_CURVES[depot.data.reserveMode] } : { investShare: 1 - depot.data.reservePct / 100 },
      });
      advice = p ? { key, plan: p, time: new Date(), missing: rows.length - known.length } : null;
    }

    if (!advice || advice.key !== key) {
      el.innerHTML = `<section class="panel manager"><h2>Vorschläge</h2>
        <p class="loading"><span class="spinner" aria-hidden="true"></span> Die Vorschläge werden berechnet. Dafür lädt die Seite erst alle Kurse und Bewertungen – das dauert nach dem Öffnen etwa eine Minute.</p></section>`;
      return;
    }

    const p = advice.plan;
    const open = !!$('details', el)?.open;
    const stale = Date.now() - advice.time > ADVICE_STALE_MS;
    const amount = (m) => `${m.units.toLocaleString('de-DE', { maximumSignificantDigits: 4 })} ${esc(m.symbol.toUpperCase())}`;
    const cards = p.moves.map((m, i) => `<article class="move ${m.type}">
        <div class="move-top"><span class="move-type">${MOVE_LABEL[m.type]}</span><h3>${esc(m.title)}</h3><strong>${money(m.usd)}</strong></div>
        <p class="muted">${m.type === 'swap'
          ? `${amount(m)} abgeben → rund ${m.toUnits.toLocaleString('de-DE', { maximumSignificantDigits: 4 })} ${esc(m.toCoin.symbol.toUpperCase())} erhalten · Gebühr rund ${money(m.fee)} (Verkauf und Kauf)`
          : `${m.type === 'buy' || m.type === 'add' ? 'Für' : 'Etwa'} ${amount(m)} zum Kurs von ${money(m.price)} · Gebühr rund ${money(m.fee)}`}</p>
        <dl>
          <div><dt>Ziel</dt><dd>${esc(m.goal)}</dd></div>
          <div><dt>Warum</dt><dd>${esc(m.reason)}</dd></div>
          <div><dt>Zeitrahmen</dt><dd>${esc(m.horizon)} ${esc(m.reviewText ?? `Erneut prüfen am ${dateText(m.review)}.`)}</dd></div>
        </dl>
        <button class="btn small" data-move="${i}">Als umgesetzt eintragen</button>
      </article>`).join('');
    const holds = p.holds.length ? `<p><strong>Halten:</strong> ${p.holds.map((h) => `${esc(h.name)} (${signed(h.score, 0)})`).join(', ')} – hier lohnt im Moment kein Handel.</p>` : '';

    el.innerHTML = `<section class="panel manager">
      <div class="panel-top"><div><h2>Vorschläge</h2><div class="muted">Stand ${advice.time.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr${stale ? ' – älter als 30 Minuten' : ''}</div></div>
        <button class="btn ghost small" data-recalc>Neu berechnen</button></div>
      <p>${depot.data.reservePct === null
          ? `${esc(p.exposure.text)} Reserve-Ziel nach dem Vorschlag „${depot.data.reserveMode === 'cautious' ? 'Vorsichtig' : 'Ausgewogen'}“: ${num((1 - p.exposure.share) * 100, 0)} %.`
          : esc(p.exposure.text)}
        Investiert sind ${num(p.investedShare * 100, 0)} %; nach den Schritten wären es ${num(p.targetShare * 100, 0)} %.
        ${p.moves.length ? `Gebühren für alle Schritte zusammen: rund ${money(p.fees)}.` : ''}</p>
      ${advice.missing ? `<p class="notice">${advice.missing} Position(en) ohne Kurs sind nicht berücksichtigt.</p>` : ''}
      ${p.unplaced ? `<p class="notice">Rund ${money(p.unplaced.usd)} bleiben in Reserve, obwohl dein Ziel niedriger liegt: ${p.unplaced.reason === 'signals'
        ? 'Im Moment hat kein passender Coin ein Kaufsignal. In Coins ohne Kaufsignal schlägt der Manager nichts vor.'
        : 'Die Coins mit Kaufsignal sind bis zur Obergrenze je Coin gefüllt, weitere passende gibt es gerade nicht.'}</p>` : ''}
      ${cards || '<p><strong>Im Moment kein Handlungsbedarf.</strong> Dein Portfolio passt zur gewählten Reserve und zur Marktlage; jeder Handel würde nur Gebühren kosten.</p>'}
      ${holds}
      <details${open ? ' open' : ''}><summary>So arbeitet der Manager – und was er nicht kann</summary>
        <ul class="plain">
          <li><strong>Feste Vorschläge:</strong> Sie werden einmal berechnet und bleiben stehen, bis du etwas am Portfolio änderst oder „Neu berechnen“ wählst.</li>
          <li><strong>Tauschen:</strong> Passen ein Verkauf und ein Kauf zusammen, schlägt der Manager einen direkten Tausch vor. Gerechnet wird mit zweimal 0,25 % Gebühr; tauscht deine Börse direkt in einem Schritt, ist es weniger.</li>
          <li><strong>Antizyklisch im Kern:</strong> Der Reserve-Vorschlag hängt zur Hälfte am Zyklus (Abstand von Bitcoin zum Allzeithoch): tief unten wenig Reserve, nahe am Hoch viel. Liegt Bitcoin mehr als 40 % unter dem Hoch, werden Bitcoin und Ethereum auch ohne Kaufsignal aufgestockt und nicht per Stop verkauft.</li>
          <li><strong>Erst das Risiko:</strong> Die Reserve bestimmt, wie viel investiert sein soll. Der Vorschlag dafür kommt aus der Marktphase; du kannst ihn überschreiben.</li>
          <li><strong>Verkaufen, wenn Kurse fallen:</strong> Verkaufssignale werden verkauft. Fällt ein Coin 25 % unter sein Hoch seit dem Kauf, greift die Schutzregel – unabhängig vom Score.</li>
          <li><strong>Gewinner laufen lassen:</strong> Bei hohen Gewinnen wird ein Teil gesichert, wenn der Trend überdehnt ist.</li>
          <li><strong>Kein Klumpen:</strong> höchstens 20 % je Coin (Bitcoin und Ethereum 40 %, riskante Coins weniger), höchstens 8 Positionen.</li>
          <li><strong>Wenig handeln:</strong> Jeder Kauf und Verkauf kostet rund 0,25 %. Abweichungen unter 4 % des Portfolios bleiben liegen, getauscht wird nur bei mindestens 30 Punkten besserem Score.</li>
          <li><strong>Rückrechnung 2018–2026 mit Gebühren:</strong> mit der ausgewogenen Reserve rund +64 % pro Jahr bei einem größten zwischenzeitlichen Rückgang von 49 %, mit der vorsichtigen rund +53 % bei 39 %. Eine rein antizyklische Reserve brachte nur rund +29 % pro Jahr, weil sie die Anstiege nahe am Hoch verpasst. Nur jeder dritte Monat endete im Plus; Verluste lassen sich nicht ausschließen, und echte Ergebnisse werden schlechter sein.</li>
          <li>Die Seite handelt nicht selbst. Du setzt die Schritte bei deiner Börse um und trägst sie hier als umgesetzt ein.</li>
        </ul>
      </details>
    </section>`;
  }

  return self;
}

// ---------- Start ----------

function route() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const section = name === 'portfolio' ? 'portfolio' : name === 'konto' ? 'account' : name === 'daytrading' ? 'trading' : 'market';
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', a.dataset.nav === section);
  let id = arg;
  try { id = decodeURIComponent(arg ?? ''); } catch { /* fehlerhafte Adresse – unverändert verwenden */ }
  if (name === 'coin' && id) current = detailView(id);
  else if (name === 'portfolio') current = depot.user ? portfolioView() : accountView(true);
  else if (name === 'konto') current = accountView();
  else if (name === 'daytrading') current = tradingView();
  else current = marketView();
  current.update();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();
start();
fngLoop();
bitcoinLoop();
