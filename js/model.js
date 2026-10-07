// Prognosemodell (Version 2)
//
// Die Bewertungskurven unten stammen aus einer Auswertung von 4 Jahren Tageskursen (Okt. 2022 – Okt. 2026)
// von 38 großen Coins: Für jeden Indikator wurde gemessen, wie sich der Kurs 7, 14, 30 und 90 Tage später
// entwickelt hat. Die wichtigsten Ergebnisse:
//   1. Die Marktphase (Bitcoin) erklärt am meisten: Ist Bitcoin stark, steigen die meisten Coins mit.
//   2. Überdehnung ist langfristig negativ: Coins weit über ihrem 200-Tage-Schnitt fielen danach meist.
//      Am besten liefen frühe, noch nicht überhitzte Aufwärtstrends.
//   3. Nach einem Ausverkauf (RSI unter 30, mehr als 20 % Wochenverlust) folgte kurzfristig oft eine Erholung.
//   4. Momentum über 2–4 Wochen und steigendes Handelsvolumen helfen mittelfristig.
// Jeder Faktor liefert einen Wert von -1 (negativ) bis +1 (positiv). Vier Jahre sind nur ein Marktzyklus –
// die Kurven beschreiben, was in dieser Zeit funktioniert hat, und sind keine Garantie für die Zukunft.

import { clamp, avg, isNum, num, signed } from './util.js';

// Gewichte nach Gegenprüfung an 2018–2022 und an 48 weiteren Coins: Die Marktphase trägt auch außerhalb des
// Anpassungszeitraums am besten, der langfristige Baustein am schlechtesten.
const W_SHORT = 0.2, W_MEDIUM = 0.25, W_LONG = 0.1, W_REGIME = 0.45;
const BEAR_CAP = 0.11;          // im Bärenmarkt gibt es kein Kaufsignal
const W_NEWS = 0.1;             // Nachrichten verschieben den Score um höchstens ±10 Punkte
const BUY = 12, STRONG = 28;    // Schwellen des Gesamt-Scores (-100 … +100)
const HORIZON_MIN = 0.1;

const factor = (name, text, score, weight) => ({ name, text, score, weight });

// Stückweise lineare Kurve durch Stützpunkte [x, y]
function curve(x, pts) {
  if (!isNum(x)) return null;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

// Bewertungskurven: [Indikatorwert, Bewertung]
const C = {
  // kurzfristig (Kurs 7 Tage später)
  rsiRebound: [[20, 1], [30, 0.7], [38, 0], [100, 0]],
  ret7: [[-25, 0.9], [-15, 0.3], [-8, 0], [10, 0], [25, 0.4], [45, 0.6]],
  sma20: [[-25, 0.9], [-15, 0.3], [-8, -0.1], [0, -0.1], [10, 0.2], [25, 0.5], [40, 0.8]],
  // mittelfristig (14–30 Tage später)
  rsiMomentum: [[20, 0.4], [30, 0.3], [38, 0], [45, -0.2], [55, -0.1], [62, 0.5], [75, 0.8], [90, 0.6]],
  sma50: [[-35, -0.2], [-20, -0.3], [-5, 0], [5, 0], [15, 0.3], [25, 0.7], [40, 0.4], [60, 0]],
  ret30: [[-35, -0.6], [-20, -0.3], [-5, 0], [5, 0.2], [20, 0.6], [45, 0.3], [70, -0.3]],
  ret14: [[-30, -0.4], [-15, -0.3], [-4, 0], [4, 0.1], [18, 0.5], [35, 0.5], [60, 0.1]],
  // langfristig (30–90 Tage später)
  sma200: [[-50, -0.2], [-30, 0], [-12, -0.1], [0, 0.6], [12, 0.6], [30, 0.2], [45, -0.6], [80, -0.9]],
  cross: [[-40, -0.3], [-22, 0.3], [-10, 0.2], [0, 0.7], [10, 0.2], [22, -0.5], [45, -1]],
  ret90: [[-60, -0.2], [-40, -0.4], [-20, 0.3], [0, 0.5], [20, 0.1], [45, -0.2], [90, -0.6], [150, -1]],
  high: [[-90, -0.7], [-75, -0.3], [-55, 0.2], [-35, 0.1], [-20, -0.2], [-5, 0.3]],
  ret200: [[-70, 0.1], [-50, 0.4], [-25, 0.3], [0, 0.1], [50, 0], [100, -0.5], [200, -0.8]],
  ret365: [[-80, -0.6], [-60, -0.3], [-35, 0], [-10, 0.5], [25, 0.5], [75, 0.1], [150, -0.2], [300, -0.7]],
  // Marktphase (Bitcoin)
  btcRsi: [[25, -0.8], [35, -0.6], [45, -0.2], [60, 0], [68, 0.6], [78, 1]],
  btcRet30: [[-20, -0.8], [-10, -0.7], [-3, -0.3], [0, 0.2], [8, 0.3], [15, 0.1], [22, 0.9], [35, 1]],
  btcSma50: [[-15, -0.8], [-8, -0.5], [-3, -0.1], [5, 0], [10, 0.6], [18, 1]],
  btcSma200: [[-25, 0], [-15, -0.6], [-5, 0.8], [5, 0.6], [15, 0.1], [35, 0], [50, -0.6], [60, -1]],
  fng: [[20, 0], [50, 0], [62, 0.4], [72, 0], [80, -0.6], [90, -1]],
};

function combine(factors) {
  let s = 0, w = 0;
  for (const f of factors) { s += f.score * f.weight; w += f.weight; }
  return w ? s / w : null;
}

const horizon = (factors) => {
  const valid = factors.filter((f) => f && f.score !== null);
  return { score: combine(valid), factors: valid };
};

const side = (x) => `${num(Math.abs(x))} % ${x >= 0 ? 'über' : 'unter'}`;
const verdict = (s, good, bad, neutral = 'neutral') => (s > 0.15 ? good : s < -0.15 ? bad : neutral);

// ---------- Indikatoren ----------

function rolling(a, w) {
  const out = new Array(a.length).fill(null);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= w) s -= a[i - w];
    if (i >= w - 1) out[i] = s / w;
  }
  return out;
}

// RSI nach Wilder
function rsiSeries(a, period = 14) {
  const out = new Array(a.length).fill(null);
  if (a.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = a[i] - a[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  const value = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = value();
  for (let i = period + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

function stdev(a) {
  if (a.length < 2) return NaN;
  const m = avg(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

const logReturns = (p) => p.slice(1).map((x, i) => Math.log(x / p[i]));

// Alle Tagesindikatoren einmal berechnen. Jeder Wert an Stelle i nutzt nur Daten bis i,
// damit der Rückblick-Test nicht in die Zukunft schaut.
export function prepare(times, prices, volumes) {
  return {
    n: prices.length, times, prices,
    days: times.map((t) => Math.floor(t / 86_400_000)),
    sma20: rolling(prices, 20), sma50: rolling(prices, 50), sma200: rolling(prices, 200),
    rsi: rsiSeries(prices),
    vol20: rolling(volumes, 20), vol90: rolling(volumes, 90),
  };
}

const retAt = (ind, i, d) => (i >= d ? (ind.prices[i] / ind.prices[i - d] - 1) * 100 : null);
const relAt = (ind, i, key) => (ind[key][i] ? (ind.prices[i] / ind[key][i] - 1) * 100 : null);

// ---------- Horizonte auf Tagesdaten (Detailansicht und Rückblick-Test) ----------

export function scoreAt(ind, i) {
  const r = ind.rsi[i];
  const s20 = relAt(ind, i, 'sma20'), s50 = relAt(ind, i, 'sma50'), s200 = relAt(ind, i, 'sma200');
  const m7 = retAt(ind, i, 7), m14 = retAt(ind, i, 14), m30 = retAt(ind, i, 30), m90 = retAt(ind, i, 90);
  const add = (list, name, value, text, pts, weight) => {
    const score = curve(value, pts);
    if (score !== null) list.push(factor(name, text(score), score, weight));
  };

  const short = [];
  add(short, 'RSI (14 Tage)', r, (s) => `${num(r, 0)} – ${s > 0.15 ? 'überverkauft, Erholung wahrscheinlicher' : 'kein Ausverkauf'}`, C.rsiRebound, 0.35);
  add(short, 'Veränderung 7 Tage', m7, (s) => `${signed(m7)} % – ${m7 < -8 ? verdict(s, 'Ausverkauf, oft folgt eine Gegenbewegung', '', 'Schwäche') : verdict(s, 'starker Schwung', '', 'unauffällig')}`, C.ret7, 0.3);
  add(short, 'Kurs zum 20-Tage-Schnitt', s20, () => `${side(s20)} dem 20-Tage-Schnitt`, C.sma20, 0.35);

  const medium = [];
  add(medium, 'RSI-Momentum', r, (s) => `${num(r, 0)} – ${verdict(s, r < 40 ? 'überverkauft' : 'Käufer klar im Vorteil', 'kein Schwung', 'neutral')}`, C.rsiMomentum, 0.2);
  add(medium, 'Kurs zum 50-Tage-Schnitt', s50, () => `${side(s50)} dem 50-Tage-Schnitt`, C.sma50, 0.2);
  add(medium, 'Momentum 30 Tage', m30, (s) => `${signed(m30)} % – ${m30 > 55 ? 'überhitzt' : verdict(s, 'gesunder Aufwärtstrend', 'Abwärtstrend', 'unauffällig')}`, C.ret30, 0.25);
  add(medium, 'Momentum 14 Tage', m14, () => `${signed(m14)} %`, C.ret14, 0.15);
  const v20 = ind.vol20[i], v90 = ind.vol90[i];
  if (v20 && v90 && m7 !== null && v20 / v90 >= 1.3 && Math.abs(m7) > 3) {
    medium.push(factor('Handelsvolumen', `${num((v20 / v90 - 1) * 100, 0)} % über Normal bei ${m7 > 0 ? 'steigendem' : 'fallendem'} Kurs`, m7 > 0 ? 0.8 : -0.5, 0.2));
  }

  const long = [];
  add(long, 'Kurs zum 200-Tage-Schnitt', s200, (s) => `${side(s200)} dem 200-Tage-Schnitt – ${s200 > 40 ? 'überdehnt' : verdict(s, 'früher Aufwärtstrend', 'schwach')}`, C.sma200, 0.3);
  if (ind.sma50[i] && ind.sma200[i]) {
    const x = (ind.sma50[i] / ind.sma200[i] - 1) * 100;
    add(long, '50- zum 200-Tage-Schnitt', x, (s) => `50-Tage-Schnitt ${side(x)} dem 200-Tage-Schnitt – ${x > 18 ? 'Trend weit fortgeschritten' : verdict(s, 'Trendwende oder junger Trend', 'schwach')}`, C.cross, 0.3);
  }
  add(long, 'Momentum 90 Tage', m90, (s) => `${signed(m90)} % – ${m90 > 45 ? 'stark gelaufen, Rückschlaggefahr' : verdict(s, 'Raum nach oben', m90 > 0 ? 'schon weit gelaufen' : 'anhaltende Schwäche')}`, C.ret90, 0.25);
  if (i >= 120) {
    let high = 0;
    for (let k = Math.max(0, i - 364); k <= i; k++) high = Math.max(high, ind.prices[k]);
    const dist = (ind.prices[i] / high - 1) * 100;
    add(long, 'Abstand zum Jahreshoch', dist, () => `${num(-dist, 0)} % unter dem Jahreshoch`, C.high, 0.15);
  }

  return { short: horizon(short), medium: horizon(medium), long: horizon(long) };
}

// ---------- Marktphase ----------

// Bewertung der Marktphase aus den Bitcoin-Tageskursen an Stelle j, optional mit Fear & Greed
export function regimeAt(btc, j, fng) {
  const f = [];
  const r = btc.rsi[j], m30 = retAt(btc, j, 30), s50 = relAt(btc, j, 'sma50'), s200 = relAt(btc, j, 'sma200');
  const add = (name, value, text, pts, weight) => {
    const score = curve(value, pts);
    if (score !== null) f.push(factor(name, text(score), score, weight));
  };
  add('Bitcoin RSI (14 Tage)', r, (s) => `${num(r, 0)} – ${verdict(s, 'starker Markt', 'schwacher Markt')}`, C.btcRsi, 0.3);
  add('Bitcoin Momentum 30 Tage', m30, (s) => `${signed(m30)} % – ${verdict(s, 'Rückenwind', 'Gegenwind')}`, C.btcRet30, 0.25);
  add('Bitcoin zum 50-Tage-Schnitt', s50, () => `${side(s50)} dem 50-Tage-Schnitt`, C.btcSma50, 0.2);
  add('Bitcoin zum 200-Tage-Schnitt', s200, (s) => `${side(s200)} dem 200-Tage-Schnitt – ${s200 > 45 ? 'Markt überhitzt' : verdict(s, 'günstige Zyklusphase', 'ungünstige Zyklusphase')}`, C.btcSma200, 0.15);
  if (isNum(fng)) {
    add('Fear & Greed', fng, (s) => `${fng} – ${fng >= 78 ? 'extreme Gier, historisch ein Warnzeichen' : verdict(s, 'Zuversicht ohne Übertreibung', 'Gier')}`, C.fng, 0.1);
  }
  // Bärenmarkt: Bitcoin unter dem 200-Tage-Schnitt und der 50-Tage-Schnitt darunter. In solchen Phasen
  // (z. B. 2022) lagen Kaufsignale in der Gegenprüfung überwiegend falsch.
  const bear = s200 !== null && s200 < 0 && btc.sma50[j] < btc.sma200[j];
  return { ...horizon(f), bear };
}

// Geglättete Marktphase: Mittel der letzten Tage. Ein einzelner schwacher Tag verschiebt die Bewertung
// dadurch nur wenig. Die angezeigten Einzelfaktoren sind die von heute; fngAt(tag) liefert Fear & Greed je Tag.
export function regimeSmooth(btc, j, fngAt = () => undefined, days = 7) {
  const today = regimeAt(btc, j, fngAt(btc.days[j]));
  if (today.score === null) return today;
  let sum = today.score, n = 1;
  for (let k = 1; k < days && j - k >= 0; k++) {
    const r = regimeAt(btc, j - k, fngAt(btc.days[j - k]));
    if (r.score !== null) { sum += r.score; n++; }
  }
  return { ...today, score: sum / n, today: today.score };
}

export const REGIME_DAYS = 14;

// Was nach vergleichbaren Zyklus-Ständen in 12 Monaten geschah (2018–2026):
// [Abstand zum Allzeithoch bis %, Bitcoin höher in % der Fälle, Bitcoin Median %, mittlerer Coin höher in %, mittlerer Coin Median %]
const CYCLE_HISTORY = [[-70, 100, 95, 48, -7], [-55, 96, 109, 71, 26], [-40, 67, 97, 64, 24], [-25, 40, -30, 37, -58], [-10, 51, 11, 12, -43], [Infinity, 37, -17, 14, -61]];

// Einordnung des Zyklus – die langfristige, antizyklische Sicht neben der kurzfristigen Marktphase
export function cycleInfo(dd) {
  const row = CYCLE_HISTORY.find(([limit]) => dd < limit) ?? CYCLE_HISTORY[CYCLE_HISTORY.length - 1];
  const zone = dd <= -55 ? 'deep' : dd <= -40 ? 'low' : dd <= -10 ? 'mid' : 'high';
  const label = { deep: 'Tief im Zyklus – antizyklische Kaufzone', low: 'Unteres Drittel des Zyklus', mid: 'Mitte des Zyklus', high: 'Nahe am Allzeithoch – Gewinne sichern' }[zone];
  return { dd, zone, label, btcUp: row[1], btcMedian: row[2], altUp: row[3], altMedian: row[4] };
}

// Ersatz, falls keine Bitcoin-Tageskurse geladen werden konnten
function regimeFromMarket(btc) {
  const d30 = btc?.price_change_percentage_30d_in_currency;
  const score = curve(d30, C.btcRet30);
  return horizon(score === null ? [] : [factor('Bitcoin Momentum 30 Tage', `${signed(d30)} %`, score, 1)]);
}

// ---------- Schnellbewertung aus den Marktdaten (Liste mit 1000 Coins) ----------

const changes = (c) => ({
  d7: c.price_change_percentage_7d_in_currency,
  d14: c.price_change_percentage_14d_in_currency,
  d30: c.price_change_percentage_30d_in_currency,
  d200: c.price_change_percentage_200d_in_currency,
  y1: c.price_change_percentage_1y_in_currency,
});

const sparkline = (c) => (c.sparkline_in_7d?.price || []).filter(isNum);

export function isStable(c) {
  const p = sparkline(c);
  const d30 = c.price_change_percentage_30d_in_currency;
  if (p.length < 60) {
    // Ohne Stundenkurse: Kurs nahe 1 $ und praktisch keine Bewegung über 7 und 30 Tage
    const d7 = c.price_change_percentage_7d_in_currency;
    return Math.abs(c.current_price - 1) < 0.02 && isNum(d7) && Math.abs(d7) < 1 && isNum(d30) && Math.abs(d30) < 2;
  }
  return (Math.max(...p) - Math.min(...p)) / p[p.length - 1] < 0.02 && (!isNum(d30) || Math.abs(d30) < 3);
}

function none(label, text, stable = false) {
  const empty = horizon([]);
  return { signal: 'none', label, score: null, stable, short: empty, medium: empty, long: empty, regime: empty,
    news: null, horizon: '–', risk: { level: 0, label: '–', vol: null }, agreement: null, notes: [text] };
}

function riskOf(c, volDaily) {
  let level = !isNum(volDaily) ? 2 : volDaily < 2.5 ? 0 : volDaily < 5 ? 1 : volDaily < 9 ? 2 : 3;
  const turnover = c.market_cap ? c.total_volume / c.market_cap : 0;
  if ((c.market_cap_rank ?? 9999) > 300 || turnover < 0.005) level = Math.min(3, level + 1);
  return { level, label: ['Niedrig', 'Mittel', 'Hoch', 'Sehr hoch'][level], vol: volDaily };
}

export const outlook = (s) => (s === null ? 'Keine Daten' : s > 0.4 ? 'Sehr positiv' : s > 0.12 ? 'Positiv'
  : s < -0.4 ? 'Sehr negativ' : s < -0.12 ? 'Negativ' : 'Neutral');

// Gesamt-Score aus den drei Horizonten und der Marktphase, als Wert von -1 bis +1
export function totalScore(short, medium, long, regime) {
  const parts = [[short, W_SHORT], [medium, W_MEDIUM], [long, W_LONG], [regime, W_REGIME]]
    .filter(([h]) => h && h.score !== null);
  // Ohne eigene Kursdaten des Coins gibt es keine Prognose
  if (!parts.some(([h]) => h !== regime)) return null;
  const raw = parts.reduce((s, [h, w]) => s + h.score * w, 0) / parts.reduce((s, [, w]) => s + w, 0);
  return regime?.bear ? Math.min(raw, BEAR_CAP) : raw;
}

export const signalOf = (score) => (score >= STRONG ? ['buy', 'Kaufen'] : score >= BUY ? ['buy', 'Eher kaufen']
  : score <= -STRONG ? ['sell', 'Verkaufen'] : score <= -BUY ? ['sell', 'Eher verkaufen'] : ['hold', 'Halten']);

function assemble(c, short, medium, long, regime, volDaily, news) {
  let raw = totalScore(short, medium, long, regime);
  if (raw === null) return none('Keine Daten', 'Zu wenig Kursdaten für eine Prognose.');
  const notes = [];
  if (news && news.score !== null) raw += W_NEWS * news.score;
  if (regime.bear) {
    raw = Math.min(raw, BEAR_CAP);
    notes.push('Bärenmarkt-Filter aktiv: Bitcoin liegt unter seinem 200-Tage-Schnitt im Abwärtstrend. In solchen Phasen gibt das Modell keine Kaufsignale.');
  }
  const score = Math.round(clamp(raw) * 100);
  let [signal, label] = signalOf(score);

  const turnover = c.market_cap ? c.total_volume / c.market_cap : 0;
  if (signal === 'buy' && (turnover < 0.003 || c.total_volume < 50_000)) {
    [signal, label] = ['hold', 'Halten'];
    notes.push('Sehr geringes Handelsvolumen – das Kaufsignal wurde auf „Halten“ begrenzt, weil sich der Coin schwer handeln lässt.');
  }
  if (regime.score !== null && Math.abs(regime.score) > 0.25) {
    notes.push(`Die Marktphase ${regime.score > 0 ? 'stützt' : 'belastet'} die Bewertung deutlich (${signed(regime.score * W_REGIME * 100, 0)} Punkte).`);
  }

  // Empfohlene Haltedauer: der längste Horizont, der das Signal trägt
  const pos = (h) => h.score !== null && h.score > HORIZON_MIN;
  const neg = (h) => h.score !== null && h.score < -HORIZON_MIN;
  let hold = '–';
  if (signal === 'buy') hold = pos(long) && !neg(medium) ? '1–3 Monate' : pos(medium) ? '2–4 Wochen' : pos(short) ? 'bis 1 Woche' : '2–4 Wochen';
  else if (signal === 'hold') hold = 'Abwarten';

  const own = [short, medium, long].filter((h) => h.score !== null);
  const dir = Math.sign(score);
  const agreeing = own.filter((h) => Math.abs(h.score) > HORIZON_MIN && Math.sign(h.score) === dir).length;
  return { signal, label, score, stable: false, short, medium, long, regime, news: news ?? null, horizon: hold,
    risk: riskOf(c, volDaily), agreement: { agreeing, of: own.length }, notes };
}

// Starker Tagesrückgang. Auswertung 2018–2026: Fiel ein Coin an einem Tag um mehr als 20 %, stand er 3 Tage
// später in 69 % der Fälle höher (bei 12–20 %: 58 %, bei weniger als 8 %: kein Vorteil). Das galt nur, wenn der
// ganze Markt mitfiel – fiel ein Coin allein, ging es meist weiter abwärts (nach 7 Tagen nur in rund 40 % höher).
const DIP = [[-25, 1], [-20, 0.9], [-12, 0.4], [-8, 0.1], [-5, 0], [100, 0]];
const DIP_ALONE = -10;     // so viel schlechter als der Markt gilt als Absturz aus eigenem Grund
const DIP_WEIGHT = 0.5;

function dipFactor(c, marketDay) {
  const h24 = c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h;
  if (!isNum(h24) || h24 > -8) return null;
  const market = isNum(marketDay) ? marketDay : null;
  if (market !== null && h24 - market <= DIP_ALONE) {
    return factor('Tagesrückgang', `${signed(h24)} % an einem Tag, der Gesamtmarkt nur ${signed(market)} % – fällt ein Coin allein, steckt oft eine schlechte Nachricht dahinter`, -0.4, DIP_WEIGHT);
  }
  const score = curve(h24, DIP);
  return score > 0 ? factor('Tagesrückgang', `${signed(h24)} % an einem Tag${market !== null ? ` (Gesamtmarkt ${signed(market)} %)` : ''} – nach solchen Ausverkäufen folgte in den nächsten Tagen oft eine Gegenbewegung`, score, DIP_WEIGHT) : null;
}

// Kurzfristiger Baustein samt Tagesrückgang, falls einer vorliegt
const withDip = (short, c, regime) => {
  const dip = dipFactor(c, regime?.marketDay);
  return dip ? horizon([...short.factors, dip]) : short;
};

export function quickAnalyse(c, regime) {
  if (isStable(c)) return none('Stablecoin', 'Der Kurs ist an einen festen Wert gebunden – keine Prognose nötig.', true);
  const prices = sparkline(c);
  const ch = changes(c);
  const f = (name, value, pts, weight, text) => {
    const score = curve(value, pts);
    return score === null ? null : factor(name, text ?? `${signed(value)} %`, score, weight);
  };

  // Stundenkurse auf 4 Stunden ausdünnen, damit der RSI weniger rauscht
  const fourHour = prices.filter((_, i) => (prices.length - 1 - i) % 4 === 0);
  const r = prices.length >= 60 ? rsiSeries(fourHour).at(-1) : null;
  const short = [
    f('Veränderung 7 Tage', ch.d7, C.ret7, 0.5),
    isNum(r) ? factor('RSI (4 Stunden)', `${num(r, 0)} – ${r < 30 ? 'überverkauft' : 'kein Ausverkauf'}`, curve(r, C.rsiRebound), 0.5) : null,
  ];
  const medium = [
    f('Momentum 30 Tage', ch.d30, C.ret30, 0.6),
    f('Momentum 14 Tage', ch.d14, C.ret14, 0.4),
  ];
  const long = [
    f('Momentum 200 Tage', ch.d200, C.ret200, 0.4, isNum(ch.d200) ? `${signed(ch.d200)} %${ch.d200 > 80 ? ' – stark gelaufen, Rückschlaggefahr' : ''}` : null),
    f('Momentum 1 Jahr', ch.y1, C.ret365, 0.35),
    f('Abstand zum Allzeithoch', c.ath_change_percentage, C.high, 0.25, isNum(c.ath_change_percentage) ? `${num(-c.ath_change_percentage, 0)} % unter dem Allzeithoch` : null),
  ];

  const volDaily = prices.length >= 60 ? stdev(logReturns(prices)) * Math.sqrt(24) * 100 : null;
  return assemble(c, withDip(horizon(short), c, regime), horizon(medium), horizon(long), regime, volDaily);
}

// Verfeinerte Bewertung mit Tageskursen (bis zu 4 Jahre) und Nachrichten
export function detailAnalyse(c, ind, regime, news) {
  const quick = c.analysis;
  if (quick.stable || ind.n < 30) return quick;
  const s = scoreAt(ind, ind.n - 1);
  const pick = (a, b) => (a.score !== null ? a : b);
  // quick.short enthält den Tagesrückgang schon; der Baustein aus Tageskursen bekommt ihn hier dazu
  const short = s.short.score !== null ? withDip(s.short, c, regime) : quick.short;
  return assemble(c, short, pick(s.medium, quick.medium), pick(s.long, quick.long), regime, quick.risk.vol, news);
}

// ---------- Marktindex ----------

export function marketIndex(coins, btcInd, fng, news) {
  const btc = coins.find((c) => c.id === 'bitcoin');
  const top = coins.filter((c) => !isStable(c)).slice(0, 200);
  if (!btc || top.length < 20) return null;

  // Marktphase über 14 Tage geglättet, damit ein einzelner schwacher Tag nicht alle Bewertungen kippt
  const lastDay = btcInd ? btcInd.days[btcInd.n - 1] : null;
  const fngAt = (d) => fng?.byDay?.get(d) ?? (d === lastDay ? fng?.value : undefined);
  const regime = btcInd ? regimeSmooth(btcInd, btcInd.n - 1, fngAt, REGIME_DAYS) : regimeFromMarket(btc);
  // Stand im Zyklus: Abstand von Bitcoin zu seinem Allzeithoch
  const cycle = isNum(btc.ath_change_percentage) ? cycleInfo(btc.ath_change_percentage) : null;
  regime.cycle = cycle ? { dd: cycle.dd } : null;
  // Tagesbewegung des Gesamtmarkts: mittlere 24-Stunden-Veränderung der größten Coins
  const day = top.map((c) => c.price_change_percentage_24h_in_currency).filter(isNum).sort((a, b) => a - b);
  regime.marketDay = day.length ? day[Math.floor(day.length / 2)] : null;
  const share = (key) => {
    const vals = top.map((c) => c[key]).filter(isNum);
    return vals.length ? vals.filter((v) => v > 0).length / vals.length : 0.5;
  };
  const up7 = share('price_change_percentage_7d_in_currency');
  const up30 = share('price_change_percentage_30d_in_currency');

  // Der Index rechnet mit der geglätteten Marktphase (70 %), der Marktbreite (20 %) und der Nachrichtenlage (10 %)
  const smoothed = isNum(regime.today)
    ? `Schnitt der letzten ${REGIME_DAYS} Tage; der heutige Tag allein läge bei ${signed(regime.today * 100, 0)}`
    : 'aus der Bitcoin-Veränderung über 30 Tage';
  const parts = regime.score === null ? [] : [factor('Marktphase (Bitcoin)', smoothed, regime.score, 0.7)];
  parts.push(factor('Marktbreite', `${num(up7 * 100, 0)} % der Top 200 im Plus über 7 Tage, ${num(up30 * 100, 0)} % über 30 Tage`, clamp((up7 + up30 - 1) * 1.5), 0.2));
  if (news && news.score !== null) parts.push(factor('Nachrichtenlage', news.text, news.score, 0.1));

  const value = Math.round(50 + 50 * combine(parts));
  let signal, label;
  if (value >= 68) [signal, label] = ['buy', 'Kaufen'];
  else if (value >= 57) [signal, label] = ['buy', 'Eher kaufen'];
  else if (value <= 32) [signal, label] = ['sell', 'Verkaufen'];
  else if (value <= 43) [signal, label] = ['sell', 'Eher verkaufen'];
  else [signal, label] = ['hold', 'Halten'];
  return { value, signal, label, parts, regime, cycle };
}

// ---------- Nachrichten ----------

const POSITIVE = /\b(surg\w*|soar\w*|rall(y|ies|ied)|jump\w*|climb\w*|gains?|record high|all[- ]time high|bullish|breakout|approv\w*|inflows?|adopt\w*|partner\w*|integrat\w*|launch\w*|upgrade\w*|mainnet|listing|listed|accumulat\w*|buys?|bought|purchas\w*|invest\w*|funding|raises?|raised|reclaim\w*|rebound\w*|recover\w*|outperform\w*|milestone|expand\w*|wins?|boost\w*|rises?|rose|tops?|strong\w*|optimis\w*)\b/gi;
const NEGATIVE = /\b(hack\w*|exploit\w*|breach\w*|stolen|theft|drain\w*|rug ?pull|scam\w*|fraud\w*|lawsuit|sue[sd]?|charges?|charged|indict\w*|investigat\w*|probe|bans?|banned|crackdown|delist\w*|bankrupt\w*|insolven\w*|collaps\w*|crash\w*|plung\w*|plummet\w*|tumbl\w*|slump\w*|sell[- ]?off|liquidat\w*|outage|halt\w*|depeg\w*|vulnerab\w*|dump\w*|bearish|warn\w*|fears?|loss(es)?|declin\w*|drops?|dropped|falls?|fell|sinks?|sank|outflows?|sanction\w*|reject\w*|slides?|slid|weak\w*|risks?|concerns?|struggl\w*|down|shut\w*|worr(y|ied|ies)|wobbl\w*|uncertain\w*)\b/gi;
const NEWS_WINDOW_MS = 7 * 86_400_000;

// Einfache Stichwort-Auswertung der Schlagzeilen. Erkennt keine Ironie und keinen Zusammenhang –
// deshalb fließt das Ergebnis nur mit kleinem Gewicht in die Prognose ein.
export function analyseNews(articles, now = Date.now()) {
  const items = articles.filter((a) => now - a.time < NEWS_WINDOW_MS).map((a) => {
    const text = `${a.title}. ${a.description ?? ''}`;
    const pos = (text.match(POSITIVE) || []).length, neg = (text.match(NEGATIVE) || []).length;
    return { ...a, tone: pos > neg ? 1 : neg > pos ? -1 : 0 };
  });
  if (items.length < 3) return { score: null, items, text: 'Zu wenige aktuelle Meldungen für eine Auswertung.' };
  // Neuere Meldungen zählen stärker
  let s = 0, w = 0;
  for (const it of items) {
    const weight = 1 / (1 + (now - it.time) / 86_400_000);
    s += it.tone * weight; w += weight;
  }
  const pos = items.filter((i) => i.tone > 0).length, neg = items.filter((i) => i.tone < 0).length;
  return { score: clamp(s / w * 1.5), items,
    text: `${items.length} Meldungen der letzten 7 Tage: ${pos} positiv, ${neg} negativ, ${items.length - pos - neg} neutral` };
}

// ---------- Rückblick-Test und erwartete Schwankung ----------

// Wie entwickelte sich der Kurs in der Vergangenheit, nachdem das Modell ein Signal zeigte?
// Bewertet wird der Gesamt-Score aus Tagesdaten und Marktphase; Nachrichten und Stundenkurse
// gibt es für die Vergangenheit nicht.
export function backtest(ind, btcInd, fngByDay, days) {
  const btcIndex = btcInd ? new Map(btcInd.days.map((d, j) => [d, j])) : null;
  const bucket = () => ({ n: 0, up: 0, sum: 0 });
  const res = { buy: bucket(), sell: bucket(), all: bucket() };
  // Die ersten 200 Tage dienen als Vorlauf für den 200-Tage-Schnitt, bei kurzer Historie weniger
  for (let i = Math.min(200, Math.floor(ind.n / 3)); i + days < ind.n; i++) {
    const j = btcIndex?.get(ind.days[i]);
    if (btcIndex && j === undefined) continue;
    const s = scoreAt(ind, i);
    const regime = btcInd ? regimeSmooth(btcInd, j, (d) => fngByDay?.get(d), REGIME_DAYS) : horizon([]);
    const raw = totalScore(s.short, s.medium, s.long, regime);
    if (raw === null) continue;
    const [signal] = signalOf(Math.round(raw * 100));
    const fwd = (ind.prices[i + days] / ind.prices[i] - 1) * 100;
    const targets = [res.all];
    if (signal === 'buy') targets.push(res.buy);
    if (signal === 'sell') targets.push(res.sell);
    for (const b of targets) { b.n++; b.sum += fwd; if (fwd > 0) b.up++; }
  }
  const done = (b) => ({ n: b.n, upRate: b.n ? b.up / b.n * 100 : null, mean: b.n ? b.sum / b.n : null });
  return { days, buy: done(res.buy), sell: done(res.sell), all: done(res.all) };
}

// Übliche Schwankungsbreite (eine Standardabweichung) aus den letzten 90 Tagen
export function expectedMove(prices) {
  const sd = stdev(logReturns(prices.slice(-91)));
  if (!isNum(sd)) return null;
  return { d7: sd * Math.sqrt(7), d30: sd * Math.sqrt(30) };
}
