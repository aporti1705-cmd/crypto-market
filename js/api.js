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

// Bitcoin-Preis in mehreren Währungen – daraus ergeben sich die Wechselkurse
export async function rates() {
  const raw = await cg('/simple/price?ids=bitcoin&vs_currencies=usd,eur,chf');
  return raw.bitcoin;
}

export async function fearGreed() {
  const res = await fetch('https://api.alternative.me/fng/?limit=30');
  if (!res.ok) throw new Error('Fear & Greed Index nicht erreichbar.');
  const json = await res.json();
  return json.data.map((d) => ({ value: Number(d.value), time: Number(d.timestamp) * 1000 }));
}
