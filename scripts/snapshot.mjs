// Berechnet alle Kurse, Bewertungen und den Markt-Index einmal zentral und schreibt sie in eine Datei.
// Läuft regelmäßig über GitHub Actions (.github/workflows/snapshot.yml). Die Website lädt nur noch
// dieses Ergebnis, statt bei jedem Besuch selbst alles nachzuladen und zu rechnen.
//
// Aufruf: node scripts/snapshot.mjs out/snapshot.json

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { quickAnalyse, detailAnalyse, marketIndex, prepare, analyseNews } from '../js/model.js';

const OUT = process.argv[2] ?? 'out/snapshot.json';
const PAGES = 4;
const DAYS_4Y = 1461;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Felder, die die Website je Coin braucht
const FIELDS = ['id', 'symbol', 'name', 'image', 'current_price', 'market_cap', 'market_cap_rank', 'total_volume',
  'high_24h', 'low_24h', 'ath', 'ath_change_percentage', 'circulating_supply', 'max_supply',
  'price_change_percentage_24h_in_currency', 'price_change_percentage_7d_in_currency', 'price_change_percentage_14d_in_currency',
  'price_change_percentage_30d_in_currency', 'price_change_percentage_200d_in_currency', 'price_change_percentage_1y_in_currency'];

async function getJson(url, { tries = 6, wait = 30_000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res = null;
    try { res = await fetch(url, { headers: { accept: 'application/json' } }); } catch { /* Netzwerkfehler */ }
    if (res?.ok) return res.json();
    if (attempt >= tries) throw new Error(`${url.split('?')[0]} antwortet nicht (${res?.status ?? 'kein Netz'})`);
    await sleep(wait);
  }
}

async function markets() {
  const coins = new Map();
  for (let page = 1; page <= PAGES; page++) {
    const list = await getJson('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc' +
      `&per_page=250&page=${page}&sparkline=true&price_change_percentage=1h,24h,7d,14d,30d,200d,1y`);
    for (const c of list) coins.set(c.id, c);
    await sleep(5000);   // kostenloses Limit: etwa 5 Anfragen pro Minute
  }
  return [...coins.values()].sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
}

// Tageskurse der letzten 4 Jahre von Binance; null, wenn das Paar nicht existiert
async function history(symbol) {
  let rows = [], end = Date.now();
  for (let k = 0; k < 2 && rows.length < DAYS_4Y; k++) {
    const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol)}USDT&interval=1d&limit=1000&endTime=${end}`);
    if (!res.ok) return null;
    const part = await res.json();
    if (!part.length) break;
    rows = part.concat(rows);
    end = part[0][0] - 1;
    if (part.length < 1000) break;
  }
  // Wird das Paar nicht mehr gehandelt, liefert Binance alte Kerzen – die taugen nicht für eine aktuelle Bewertung
  if (rows.length < 60 || Date.now() - rows[rows.length - 1][0] > 3 * 86_400_000) return null;
  const cut = rows.slice(-DAYS_4Y);
  return { t: cut.map((r) => r[0]), p: cut.map((r) => Number(r[4])), v: cut.map((r) => Number(r[7])) };
}

async function optional(label, fn) {
  try { return await fn(); } catch (err) { console.warn(`${label} nicht verfügbar: ${err.message}`); return null; }
}

const started = Date.now();
const coins = await markets();
console.log(`${coins.length} Coins geladen`);

// 150 Tage Verlauf: Das Modell braucht, wie lange der Index schon in einer Zone steht (bis zu 60 Tage zurück)
const fngData = await optional('Fear & Greed', async () => (await getJson('https://api.alternative.me/fng/?limit=150', { tries: 2, wait: 5000 })).data);
const fng = fngData ? { value: Number(fngData[0].value), week: Number(fngData[7]?.value), month: Number(fngData[29]?.value),
  values: fngData.map((d) => Number(d.value)),
  byDay: new Map(fngData.map((d) => [Math.floor(Number(d.timestamp) / 86400), Number(d.value)])) } : null;

// Fear & Greed Index von CoinMarketCap, nur zur Anzeige und nur mit eigenem API-Schlüssel (Umgebungsvariable CMC_API_KEY).
// Gerechnet wird mit dem Index von alternative.me: Er liegt seit 2018 vor und ist damit prüfbar, der von CoinMarketCap
// erst seit Mitte 2023. Beide laufen zu rund 90 % gleich, lösen die Regeln aber an teils anderen Tagen aus.
const cmc = process.env.CMC_API_KEY ? await optional('Fear & Greed von CoinMarketCap', async () => {
  const res = await fetch('https://pro-api.coinmarketcap.com/v3/fear-and-greed/latest',
    { headers: { 'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY, accept: 'application/json' } });
  if (!res.ok) throw new Error(`Antwort ${res.status}`);
  const d = (await res.json()).data;
  if (!Number.isFinite(Number(d?.value))) throw new Error('unerwartete Antwort');
  return { value: Math.round(Number(d.value)), label: String(d.value_classification ?? '') };
}) : null;

const news = await optional('Nachrichten', async () => {
  const json = await getJson('https://cryptocurrency.cv/api/search?q=crypto&limit=30', { tries: 1 });
  return analyseNews((json.articles || []).filter((a) => a.title && a.pubDate)
    .map((a) => ({ title: a.title, description: (a.description || '').slice(0, 300), time: Date.parse(a.pubDate) })));
});

const btcData = await optional('Bitcoin-Kursgeschichte', () => history('BTC'));
const btc = coins.find((c) => c.id === 'bitcoin');
const btcInd = btcData && btc ? prepare(btcData.t, [...btcData.p.slice(0, -1), btc.current_price], btcData.v) : null;
const market = marketIndex(coins, btcInd, fng, news && news.score !== null ? news : null);
if (!market) throw new Error('Markt-Index nicht berechenbar');
const regime = market.regime;

// Welche Coins führt Binance? Gleiches Kürzel mit stark abweichendem Kurs ist ein anderer Coin.
const prices = await optional('Binance-Kurse', async () =>
  new Map((await getJson('https://data-api.binance.vision/api/v3/ticker/price', { tries: 2, wait: 5000 })).map((x) => [x.symbol, Number(x.price)])));

let refined = 0;
const queue = [...coins];
async function worker() {
  for (let c = queue.shift(); c; c = queue.shift()) {
    c.analysis = quickAnalyse(c, regime);
    const p = prices?.get(c.symbol.toUpperCase() + 'USDT');
    if (c.analysis.signal === 'none' || !p || !(Math.abs(p / c.current_price - 1) < 0.1)) continue;
    const daily = c.id === 'bitcoin' ? btcData : await optional(c.symbol, () => history(c.symbol.toUpperCase()));
    if (!daily) continue;
    c.analysis = detailAnalyse(c, prepare(daily.t, [...daily.p.slice(0, -1), c.current_price], daily.v), regime);
    refined++;
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
console.log(`${refined} Coins mit Tageskursen verfeinert`);

const snapshot = {
  version: 1,
  time: Date.now(),
  market: { value: market.value, signal: market.signal, label: market.label, parts: market.parts, regime, cycle: market.cycle, forecast: market.forecast },
  fng: fng ? { value: fng.value, week: fng.week, month: fng.month, cmc } : null,
  coins: coins.map((c) => {
    const out = {};
    for (const f of FIELDS) out[f] = c[f];
    out.sparkline_in_7d = { price: (c.sparkline_in_7d?.price || []).filter(Number.isFinite).map((x) => Number(x.toPrecision(5))) };
    // Die Marktphase ist für alle Coins gleich und steht einmal unter market.regime
    const { regime: _shared, ...analysis } = c.analysis;
    out.analysis = analysis;
    return out;
  }),
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(snapshot));
console.log(`Geschrieben: ${OUT} (${(JSON.stringify(snapshot).length / 1e6).toFixed(1)} MB, ${Math.round((Date.now() - started) / 1000)} s) · Markt-Index ${market.value} ${market.label}`);
