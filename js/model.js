// Prognosemodell
//
// Jeder Coin wird auf drei Zeithorizonten bewertet (kurz: Tage, mittel: Wochen, lang: Monate).
// Jeder Horizont besteht aus gewichteten Faktoren mit Werten von -1 (negativ) bis +1 (positiv).
// Grundlage sind die am besten belegten Effekte am Kryptomarkt: Trendfolge und Momentum über
// Wochen bis Monate, Überdehnung (RSI) als Gegensignal an den Extremen und die Marktphase,
// weil Altcoins stark mit dem Gesamtmarkt laufen.

import { clamp, avg, isNum, num, signed } from './util.js';

const W_SHORT = 0.3, W_MEDIUM = 0.4, W_LONG = 0.3;
const W_REGIME = 0.15;          // Einfluss der Marktphase auf Altcoins
const BUY = 15, STRONG = 35;    // Schwellen des Gesamt-Scores (-100 … +100)
const HORIZON_MIN = 0.1;

// Positive und negative Veränderungen getrennt skalieren (ein Kurs kann höchstens 100 % fallen)
const scale = (x, up, down) => (!isNum(x) ? null : x >= 0 ? Math.min(1, x / up) : Math.max(-1, x / down));
const factor = (name, text, score, weight) => ({ name, text, score, weight });

function combine(factors) {
  let s = 0, w = 0;
  for (const f of factors) { s += f.score * f.weight; w += f.weight; }
  return w ? s / w : null;
}

const horizon = (factors) => {
  const valid = factors.filter((f) => f && f.score !== null);
  return { score: combine(valid), factors: valid };
};

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

function ema(a, w) {
  const k = 2 / (w + 1), out = [a[0]];
  for (let i = 1; i < a.length; i++) out[i] = a[i] * k + out[i - 1] * (1 - k);
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
export function prepare(prices, volumes) {
  const fast = ema(prices, 12), slow = ema(prices, 26);
  const macd = prices.map((_, i) => fast[i] - slow[i]);
  const signal = ema(macd, 9);
  return {
    n: prices.length, prices,
    sma20: rolling(prices, 20), sma50: rolling(prices, 50), sma200: rolling(prices, 200),
    hist: macd.map((m, i) => (i >= 34 ? m - signal[i] : null)),
    rsi: rsiSeries(prices),
    vol20: rolling(volumes, 20), vol90: rolling(volumes, 90),
  };
}

// ---------- Horizonte auf Tagesdaten (Detailansicht und Rückblick-Test) ----------

export function scoreAt(ind, i) {
  const p = ind.prices[i];
  const ret = (d) => (i >= d ? (p / ind.prices[i - d] - 1) * 100 : null);
  const rel = (base) => (base ? (p / base - 1) * 100 : null);
  const side = (x) => (x >= 0 ? 'über' : 'unter');

  const medium = [];
  const s20 = rel(ind.sma20[i]), s50 = rel(ind.sma50[i]);
  if (s20 !== null) medium.push(factor('Kurs zum 20-Tage-Schnitt', `${num(Math.abs(s20))} % ${side(s20)} dem 20-Tage-Schnitt`, scale(s20, 10, 10), 0.2));
  if (s50 !== null) medium.push(factor('Kurs zum 50-Tage-Schnitt', `${num(Math.abs(s50))} % ${side(s50)} dem 50-Tage-Schnitt`, scale(s50, 20, 20), 0.2));

  const h = ind.hist[i], hPrev = ind.hist[i - 1];
  if (h != null && hPrev != null) {
    const rising = h > hPrev;
    const score = h > 0 ? (rising ? 1 : 0.3) : (rising ? -0.3 : -1);
    const text = h > 0
      ? (rising ? 'Aufwärtsschwung nimmt zu' : 'Aufwärtsschwung lässt nach')
      : (rising ? 'Abwärtsschwung lässt nach' : 'Abwärtsschwung nimmt zu');
    medium.push(factor('MACD', text, score, 0.2));
  }

  const r = ind.rsi[i];
  if (r !== null) {
    let score, text;
    if (r > 80) [score, text] = [-1, 'stark überkauft – Rücksetzer wahrscheinlicher'];
    else if (r > 70) [score, text] = [-0.5, 'überkauft'];
    else if (r < 20) [score, text] = [1, 'stark überverkauft – Erholung wahrscheinlicher'];
    else if (r < 30) [score, text] = [0.5, 'überverkauft'];
    else [score, text] = [(r - 50) / 50 * 0.4, r >= 50 ? 'Käufer leicht im Vorteil' : 'Verkäufer leicht im Vorteil'];
    medium.push(factor('RSI (14 Tage)', `${num(r, 0)} – ${text}`, score, 0.15));
  }

  const m30 = ret(30);
  if (m30 !== null) medium.push(factor('Momentum 30 Tage', `${signed(m30)} % in 30 Tagen`, scale(m30, 50, 30), 0.25));

  const v20 = ind.vol20[i], v90 = ind.vol90[i], m7 = ret(7);
  if (v20 && v90 && m7 !== null && v20 / v90 > 1.3 && Math.abs(m7) > 3) {
    medium.push(factor('Handelsvolumen', `Volumen ${num((v20 / v90 - 1) * 100, 0)} % über Normal bestätigt die ${m7 > 0 ? 'Aufwärts' : 'Abwärts'}bewegung`, m7 > 0 ? 0.7 : -0.7, 0.1));
  }

  const long = [];
  const s200 = rel(ind.sma200[i]);
  if (s200 !== null) long.push(factor('Kurs zum 200-Tage-Schnitt', `${num(Math.abs(s200))} % ${side(s200)} dem 200-Tage-Schnitt`, scale(s200, 40, 30), 0.3));
  if (ind.sma50[i] && ind.sma200[i]) {
    const cross = (ind.sma50[i] / ind.sma200[i] - 1) * 100;
    long.push(factor('50- zum 200-Tage-Schnitt', cross >= 0 ? `Golden Cross: 50-Tage-Schnitt ${num(cross)} % darüber` : `Death Cross: 50-Tage-Schnitt ${num(-cross)} % darunter`, scale(cross, 20, 20), 0.25));
  }
  const m90 = ret(90);
  if (m90 !== null) long.push(factor('Momentum 90 Tage', `${signed(m90)} % in 90 Tagen`, scale(m90, 80, 45), 0.25));
  if (i >= 120) {
    let high = 0;
    for (let k = Math.max(0, i - 364); k <= i; k++) high = Math.max(high, ind.prices[k]);
    long.push(highFactor((p / high - 1) * 100, 'Jahreshoch', 0.2));
  }

  return { medium: horizon(medium), long: horizon(long) };
}

// Nähe zum Hoch gilt als Stärke, ein sehr großer Abstand als Warnzeichen
function highFactor(dist, label, weight) {
  if (!isNum(dist)) return null;
  const score = dist > -15 ? 0.5 : dist > -60 ? 0 : dist > -85 ? -0.4 : -0.8;
  return factor(`Abstand zum ${label}`, `${num(-dist, 0)} % unter dem ${label}`, score, weight);
}

// ---------- Schnellbewertung aus den Marktdaten (Liste mit 1000 Coins) ----------

function shortTerm(prices, h24) {
  if (prices.length < 60) return horizon([]);
  const f = [];

  const trend = (avg(prices.slice(-24)) / avg(prices) - 1) * 100;
  f.push(factor('Trend', `24-Stunden-Schnitt ${num(Math.abs(trend))} % ${trend >= 0 ? 'über' : 'unter'} dem 7-Tage-Schnitt`, scale(trend, 5, 5), 0.35));

  // Kursbewegung der letzten 3 Tage im Verhältnis zur üblichen Schwankung
  const recent = prices.slice(-72);
  const move = Math.log(recent[recent.length - 1] / recent[0]);
  const sd = stdev(logReturns(prices));
  if (sd > 0) {
    const z = move / (sd * Math.sqrt(recent.length - 1));
    const strength = Math.abs(z) > 1.5 ? 'deutliche' : Math.abs(z) > 0.6 ? 'moderate' : 'geringe';
    f.push(factor('Richtung 3 Tage', `${signed(move * 100)} % in 3 Tagen – ${strength} Bewegung`, clamp(z / 1.5), 0.25));
  }

  // Stundenkurse auf 4 Stunden ausdünnen, damit der RSI weniger rauscht
  const fourHour = prices.filter((_, i) => (prices.length - 1 - i) % 4 === 0);
  const r = rsiSeries(fourHour).at(-1);
  if (r !== null && r !== undefined) {
    let score, text;
    if (r < 25) [score, text] = [1, 'stark überverkauft'];
    else if (r < 35) [score, text] = [0.5, 'überverkauft'];
    else if (r > 75) [score, text] = [-1, 'stark überkauft'];
    else if (r > 65) [score, text] = [-0.5, 'überkauft'];
    else [score, text] = [0, 'neutral'];
    f.push(factor('RSI (4 Stunden)', `${num(r, 0)} – ${text}`, score, 0.25));
  }

  if (isNum(h24)) f.push(factor('Veränderung 24 Stunden', `${signed(h24)} %`, scale(h24, 10, 8), 0.15));
  return horizon(f);
}

const changes = (c) => ({
  h24: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h,
  d7: c.price_change_percentage_7d_in_currency,
  d14: c.price_change_percentage_14d_in_currency,
  d30: c.price_change_percentage_30d_in_currency,
  d200: c.price_change_percentage_200d_in_currency,
  y1: c.price_change_percentage_1y_in_currency,
});

const sparkline = (c) => (c.sparkline_in_7d?.price || []).filter(isNum);

export function isStable(c) {
  const p = sparkline(c);
  if (p.length < 60) return false;
  const d30 = c.price_change_percentage_30d_in_currency;
  return (Math.max(...p) - Math.min(...p)) / p[p.length - 1] < 0.02 && (!isNum(d30) || Math.abs(d30) < 3);
}

function none(label, text, stable = false) {
  const empty = horizon([]);
  return { signal: 'none', label, score: null, stable, short: empty, medium: empty, long: empty,
    horizon: '–', risk: { level: 0, label: '–', vol: null }, agreement: null, notes: [text] };
}

function riskOf(c, volDaily) {
  let level = !isNum(volDaily) ? 2 : volDaily < 2.5 ? 0 : volDaily < 5 ? 1 : volDaily < 9 ? 2 : 3;
  const turnover = c.market_cap ? c.total_volume / c.market_cap : 0;
  if ((c.market_cap_rank ?? 9999) > 300 || turnover < 0.005) level = Math.min(3, level + 1);
  return { level, label: ['Niedrig', 'Mittel', 'Hoch', 'Sehr hoch'][level], vol: volDaily };
}

export const outlook = (s) => (s === null ? 'Keine Daten' : s > 0.5 ? 'Sehr positiv' : s > 0.15 ? 'Positiv'
  : s < -0.5 ? 'Sehr negativ' : s < -0.15 ? 'Negativ' : 'Neutral');

function assemble(c, short, medium, long, regime, volDaily) {
  const parts = [[short, W_SHORT], [medium, W_MEDIUM], [long, W_LONG]].filter(([h]) => h.score !== null);
  if (!parts.length) return none('Keine Daten', 'Zu wenig Kursdaten für eine Prognose.');

  let raw = parts.reduce((s, [h, w]) => s + h.score * w, 0) / parts.reduce((s, [, w]) => s + w, 0);
  const notes = [];
  if (c.id !== 'bitcoin' && regime) {
    raw += W_REGIME * regime;
    if (Math.abs(regime) > 0.2) notes.push(`Die Marktphase ${regime > 0 ? 'stützt' : 'belastet'} die Bewertung (${signed(W_REGIME * regime * 100, 0)} Punkte).`);
  }
  const score = Math.round(clamp(raw) * 100);

  let signal, label;
  if (score >= STRONG) [signal, label] = ['buy', 'Kaufen'];
  else if (score >= BUY) [signal, label] = ['buy', 'Eher kaufen'];
  else if (score <= -STRONG) [signal, label] = ['sell', 'Verkaufen'];
  else if (score <= -BUY) [signal, label] = ['sell', 'Eher verkaufen'];
  else [signal, label] = ['hold', 'Halten'];

  const turnover = c.market_cap ? c.total_volume / c.market_cap : 0;
  if (signal === 'buy' && (turnover < 0.003 || c.total_volume < 50_000)) {
    [signal, label] = ['hold', 'Halten'];
    notes.push('Sehr geringes Handelsvolumen – das Kaufsignal wurde auf „Halten“ begrenzt, weil sich der Coin schwer handeln lässt.');
  }

  // Empfohlene Haltedauer: der längste Horizont, der das Signal trägt
  const pos = (h) => h.score !== null && h.score > HORIZON_MIN;
  const neg = (h) => h.score !== null && h.score < -HORIZON_MIN;
  let hold = '–';
  if (signal === 'buy') {
    hold = pos(long) && !neg(medium) ? '3–12 Monate' : pos(medium) ? '1–4 Wochen' : pos(short) ? '1–7 Tage' : '3–12 Monate';
  } else if (signal === 'hold') hold = 'Abwarten';

  const dir = Math.sign(score);
  const agreeing = parts.filter(([h]) => Math.abs(h.score) > HORIZON_MIN && Math.sign(h.score) === dir).length;
  return { signal, label, score, stable: false, short, medium, long, horizon: hold,
    risk: riskOf(c, volDaily), agreement: { agreeing, of: parts.length }, notes };
}

export function quickAnalyse(c, regime = 0) {
  if (isStable(c)) return none('Stablecoin', 'Der Kurs ist an einen festen Wert gebunden – keine Prognose nötig.', true);
  const prices = sparkline(c);
  const ch = changes(c);

  const medium = [
    isNum(ch.d7) && factor('Momentum 7 Tage', `${signed(ch.d7)} %`, scale(ch.d7, 20, 15), 0.3),
    isNum(ch.d14) && factor('Momentum 14 Tage', `${signed(ch.d14)} %`, scale(ch.d14, 30, 22), 0.3),
    isNum(ch.d30) && factor('Momentum 30 Tage', `${signed(ch.d30)} %`, scale(ch.d30, 50, 30), 0.3),
    isNum(ch.d7) && ch.d7 > 70 && factor('Überhitzung', `${signed(ch.d7, 0)} % in einer Woche – Rückschlaggefahr`, -1, 0.2),
  ];
  const long = [
    isNum(ch.d200) && factor('Momentum 200 Tage', `${signed(ch.d200)} %`, scale(ch.d200, 120, 55), 0.4),
    isNum(ch.y1) && factor('Momentum 1 Jahr', `${signed(ch.y1)} %`, scale(ch.y1, 200, 65), 0.3),
    highFactor(c.ath_change_percentage, 'Allzeithoch', 0.3),
  ];

  const volDaily = prices.length >= 60 ? stdev(logReturns(prices)) * Math.sqrt(24) * 100 : null;
  return assemble(c, shortTerm(prices, ch.h24), horizon(medium), horizon(long), regime, volDaily);
}

// Verfeinerte Bewertung mit 365 Tagen Kursdaten
export function detailAnalyse(c, ind, regime = 0) {
  const quick = c.analysis;
  if (quick.stable || ind.n < 30) return quick;
  const s = scoreAt(ind, ind.n - 1);
  return assemble(c, quick.short,
    s.medium.score !== null ? s.medium : quick.medium,
    s.long.score !== null ? s.long : quick.long,
    regime, quick.risk.vol);
}

// ---------- Marktindex ----------

export function marketIndex(coins, fng) {
  const btc = coins.find((c) => c.id === 'bitcoin');
  const top = coins.filter((c) => !isStable(c)).slice(0, 200);
  if (!btc?.analysis || btc.analysis.score === null || top.length < 20) return null;

  const share = (key) => {
    const vals = top.map((c) => c[key]).filter(isNum);
    return vals.length ? vals.filter((v) => v > 0).length / vals.length : 0.5;
  };
  const up7 = share('price_change_percentage_7d_in_currency');
  const up30 = share('price_change_percentage_30d_in_currency');
  const d14 = top.slice(0, 100).map((c) => c.price_change_percentage_14d_in_currency).filter(isNum).sort((a, b) => a - b);
  const median = d14.length ? d14[Math.floor(d14.length / 2)] : 0;

  const parts = [
    factor('Bitcoin-Trend', `Bitcoin-Score ${signed(btc.analysis.score, 0)} (${btc.analysis.label})`, btc.analysis.score / 100, 0.3),
    factor('Marktbreite', `${num(up7 * 100, 0)} % der Top 200 im Plus über 7 Tage, ${num(up30 * 100, 0)} % über 30 Tage`, clamp((up7 + up30 - 1) * 1.5), 0.3),
    factor('Momentum der Top 100', `Mittlere Veränderung in 14 Tagen: ${signed(median)} %`, scale(median, 15, 12), 0.15),
  ];
  if (fng) {
    // Gegenläufig gewertet, aber nur außerhalb der neutralen Zone: Angst war historisch eher
    // Kaufgelegenheit, Gier ein Warnzeichen
    const v = fng.value;
    const score = v >= 60 ? -Math.min(1, (v - 60) / 30) : v <= 40 ? Math.min(1, (40 - v) / 30) : 0;
    const text = v <= 25 ? 'extreme Angst, historisch eher Kaufgelegenheit' : v <= 40 ? 'Angst, eher günstige Einstiegsphase'
      : v >= 75 ? 'extreme Gier, historisch ein Warnzeichen' : v >= 60 ? 'Gier, erhöhte Rückschlaggefahr' : 'neutrale Stimmung';
    parts.push(factor('Fear & Greed', `${v} – ${text}`, score, 0.25));
  }

  const value = Math.round(50 + 50 * combine(parts));
  let signal, label;
  if (value >= 70) [signal, label] = ['buy', 'Kaufen'];
  else if (value >= 57) [signal, label] = ['buy', 'Eher kaufen'];
  else if (value <= 30) [signal, label] = ['sell', 'Verkaufen'];
  else if (value <= 43) [signal, label] = ['sell', 'Eher verkaufen'];
  else [signal, label] = ['hold', 'Halten'];
  return { value, signal, label, parts, regime: clamp((value - 50) / 50) };
}

// ---------- Rückblick-Test und erwartete Schwankung ----------

// Wie entwickelte sich der Kurs in der Vergangenheit, nachdem das Modell ein Signal zeigte?
export function backtest(ind, which, days, start) {
  const bucket = () => ({ n: 0, up: 0, sum: 0 });
  const res = { buy: bucket(), sell: bucket(), all: bucket() };
  for (let i = start; i + days < ind.n; i++) {
    const s = scoreAt(ind, i)[which].score;
    if (s === null) continue;
    const fwd = (ind.prices[i + days] / ind.prices[i] - 1) * 100;
    const targets = [res.all];
    if (s >= 0.2) targets.push(res.buy);
    if (s <= -0.2) targets.push(res.sell);
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
