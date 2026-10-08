import { sleep } from './util.js';

const CG = 'https://api.coingecko.com/api/v3';
const GAP_MS = 4000;        // Mindestabstand zwischen zwei CoinGecko-Anfragen (kostenloses Limit)
const RETRY_MS = 60_000;     // Nach einem Limit-Treffer eine Minute pausieren, sonst verlängert sich die Sperre
const CHART_TTL_MS = 10 * 60_000;

let queue = Promise.resolve();
let lastCall = 0;

// Alle CoinGecko-Anfragen laufen nacheinander durch eine Warteschlange
function cg(path) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      let res = null;
      try { res = await fetch(CG + path); } catch { /* Netzwerkfehler oder blockierte 429-Antwort */ }
      if (res?.ok) return res.json();
      const limited = !res || res.status === 429;
      if (limited && attempt < 1) { await sleep(RETRY_MS); continue; }
      throw new Error(limited
        ? 'CoinGecko ist gerade nicht erreichbar (vermutlich Anfrage-Limit). Nächster Versuch folgt automatisch.'
        : `CoinGecko antwortet mit Fehler ${res.status}.`);
    }
  };
  const p = queue.then(run);
  queue = p.catch(() => {});
  return p;
}

export const PAGES = 4;     // 4 × 250 = Top 1000

export function markets(currency, page) {
  return cg(`/coins/markets?vs_currency=${currency}&order=market_cap_desc&per_page=250&page=${page}` +
    '&sparkline=true&price_change_percentage=1h,24h,7d,14d,30d,200d,1y');
}

const charts = new Map();

// Tageskurse und -volumen der letzten 365 Tage
export async function chart(id, currency) {
  const key = `${id}|${currency}`;
  const hit = charts.get(key);
  if (hit && Date.now() - hit.time < CHART_TTL_MS) return hit.data;
  const raw = await cg(`/coins/${encodeURIComponent(id)}/market_chart?vs_currency=${currency}&days=365`);
  const data = {
    t: raw.prices.map((x) => x[0]),
    p: raw.prices.map((x) => x[1]),
    v: raw.prices.map((_, i) => raw.total_volumes[i]?.[1] ?? 0),
  };
  charts.set(key, { time: Date.now(), data });
  return data;
}

// Tageskurse der letzten 4 Jahre von Binance (Paar gegen USDT). Gibt null zurück, wenn der Coin dort nicht gehandelt wird.
const DAYS_4Y = 1461;
const histories = new Map();

export async function history(symbol) {
  const pair = symbol.toUpperCase() + 'USDT';
  const hit = histories.get(pair);
  if (hit && Date.now() - hit.time < CHART_TTL_MS) return hit.data;
  let rows = [], end = Date.now();
  for (let k = 0; k < 2 && rows.length < DAYS_4Y; k++) {
    const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=1d&limit=1000&endTime=${end}`);
    if (!res.ok) { rows = null; break; }
    const part = await res.json();
    if (!part.length) break;
    rows = part.concat(rows);
    end = part[0][0] - 1;
    if (part.length < 1000) break;
  }
  // Wird das Paar nicht mehr gehandelt, liefert Binance alte Kerzen – die taugen nicht für eine aktuelle Bewertung
  const fresh = rows && rows.length >= 60 && Date.now() - rows[rows.length - 1][0] < 3 * 86_400_000;
  const data = fresh ? (() => {
    const cut = rows.slice(-DAYS_4Y);
    // Spalten: 0 = Tagesbeginn, 4 = Schlusskurs, 7 = Handelsvolumen in USDT
    return { t: cut.map((r) => r[0]), p: cut.map((r) => Number(r[4])), v: cut.map((r) => Number(r[7])) };
  })() : null;
  histories.set(pair, { time: Date.now(), data });
  return data;
}

// Aktuelle Kurse aller Binance-Handelspaare – zeigt, welche Coins dort eine Kursgeschichte haben
export async function binancePrices() {
  const res = await fetch('https://data-api.binance.vision/api/v3/ticker/price');
  if (!res.ok) throw new Error('Binance nicht erreichbar.');
  return new Map((await res.json()).map((x) => [x.symbol, Number(x.price)]));
}

// Aktueller Fear & Greed Index samt Verlauf (für den Rückblick-Test)
export async function fearGreed() {
  const res = await fetch('https://api.alternative.me/fng/?limit=1500');
  if (!res.ok) throw new Error('Fear & Greed Index nicht erreichbar.');
  const json = await res.json();
  return json.data.map((d) => ({ value: Number(d.value), time: Number(d.timestamp) * 1000 }));
}

// ---------- Nachrichten (cryptocurrency.cv, kostenlos, begrenzt auf wenige Suchen pro Stunde) ----------

const NEWS = 'https://cryptocurrency.cv/api';
const NEWS_TTL_MS = 60 * 60_000;
const NEWS_PER_HOUR = 15;         // der Dienst erlaubt 20 Suchen pro Stunde; wer weiterfragt, wird gesperrt
const NEWS_PAUSE_MS = 60 * 60_000;
const NEWS_LOG = 'krypto-markt-news-abrufe';
const NO_NEWS = /etherscan|tradingview|stacker|nostr|blockchain\.com/i;   // Quellen ohne redaktionelle Meldungen

const read = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

async function newsRequest(path) {
  const key = 'krypto-markt-news:' + path;
  const hit = read(key);
  if (hit && Date.now() - hit.time < NEWS_TTL_MS) return hit.items;

  // Eigene Buchführung über die Abrufe der letzten Stunde, damit das Limit gar nicht erst erreicht wird
  const log = read(NEWS_LOG) ?? { calls: [], pausedUntil: 0 };
  log.calls = log.calls.filter((t) => Date.now() - t < 3_600_000);
  const limited = new Error('Nachrichten-Limit für diese Stunde erreicht – bitte später erneut versuchen.');
  if (Date.now() < log.pausedUntil || log.calls.length >= NEWS_PER_HOUR) throw limited;
  log.calls.push(Date.now());
  write(NEWS_LOG, log);

  const res = await fetch(NEWS + path);
  if (res.status === 429 || res.status === 403) {
    write(NEWS_LOG, { ...log, pausedUntil: Date.now() + NEWS_PAUSE_MS });
    throw limited;
  }
  if (!res.ok) throw new Error('Nachrichten nicht erreichbar.');
  const json = await res.json();
  const items = (json.articles || [])
    .filter((a) => a.title && a.link && !NO_NEWS.test(`${a.source} ${a.link}`))
    .map((a) => ({ title: a.title, description: (a.description || '').slice(0, 300), link: a.link, source: a.source, time: Date.parse(a.pubDate) }))
    .filter((a) => Number.isFinite(a.time));
  // Abgelaufene Meldungen anderer Coins entfernen, damit der Browser-Speicher nicht vollläuft
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('krypto-markt-news:') && Date.now() - (read(k)?.time ?? 0) > NEWS_TTL_MS) localStorage.removeItem(k);
    }
  } catch {}
  write(key, { time: Date.now(), items });
  return items;
}

// Die allgemeine Liste liefert kostenlos nur 3 Meldungen, die Suche bis zu 30
export const marketNews = () => newsRequest('/search?q=crypto&limit=30');

// Meldungen zu einem Coin; behalten wird nur, was Name oder Kürzel wirklich nennt
export async function coinNews(name, symbol) {
  const items = await newsRequest(`/search?q=${encodeURIComponent(name)}&limit=30`);
  const escape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const byName = new RegExp(`\\b${escape(name)}\\b`, 'i');
  // Das Kürzel zählt nur in Großschreibung – sonst passt „NEAR“ auf jedes „near“
  const bySymbol = symbol.length >= 3 ? new RegExp(`\\b${escape(symbol.toUpperCase())}\\b`) : null;
  return items.filter((a) => {
    const text = `${a.title} ${a.description}`;
    return byName.test(text) || !!bySymbol?.test(text);
  });
}
