// Portfolio-Manager: leitet aus den Prognosen konkrete Schritte für ein Portfolio ab.
//
// Grundsätze (in dieser Reihenfolge):
//   1. Erst das Risiko: Wie viel überhaupt investiert sein soll, bestimmt die Marktphase.
//      Im Bärenmarkt bleibt der Großteil in Reserve (Stablecoins/Bargeld).
//   2. Verlierer raus: Coins mit Verkaufssignal werden verkauft, schwache zuerst reduziert.
//   3. Gewinner laufen lassen, aber Klumpen vermeiden: Obergrenze je Position, Teilverkauf
//      bei hohen Gewinnen, wenn der Trend überdehnt ist.
//   4. Wenig handeln: Jeder Kauf und Verkauf kostet Gebühr. Kleine Abweichungen werden
//      ignoriert, getauscht wird nur bei deutlich besserem Score.
// Die Regeln wurden mit Gebühren über mehrere Jahre zurückgerechnet (siehe Hinweise auf der Seite).

export const DEFAULTS = {
  fee: 0.0025,            // Gebühr je Kauf oder Verkauf
  maxPositions: 8,
  maxWeight: 0.2,         // Obergrenze je Coin, Anteil am Gesamtportfolio
  maxWeightCore: 0.4,     // Obergrenze für Bitcoin und Ethereum
  minTradeShare: 0.04,    // kleinere Abweichungen vom Ziel werden nicht gehandelt
  minTradeUsd: 20,
  swapGap: 30,            // so viele Score-Punkte muss ein neuer Coin besser sein, damit getauscht wird
  buyScore: 12,
  profitGain: 0.6,        // ab diesem Kursgewinn wird Gewinnmitnahme geprüft
  profitGainHigh: 1.5,
  trailStop: 0.25,        // Verkauf, wenn der Kurs so weit unter sein Hoch seit dem Kauf fällt
  stopLoss: null,         // Verkauf, wenn der Kurs so weit unter den Kaufpreis fällt
  pairSwaps: true,        // Verkäufe und Käufe als Tausch vorschlagen
  profitRepeat: 1.3,      // erneute Gewinnmitnahme erst, wenn der Kurs seit der letzten um 30 % gestiegen ist
};

const CORE = new Set(['bitcoin', 'ethereum']);
const RISK_WEIGHT = [1, 0.9, 0.75, 0.55];
const RISK_CAP = [1, 1, 0.75, 0.5];      // riskante Coins bekommen eine kleinere Obergrenze

// Abgewerteter Score: riskantere Coins brauchen einen höheren Score für denselben Rang
export const adjusted = (a) => (a.score ?? 0) * RISK_WEIGHT[a.risk?.level ?? 2];

// Wie viel des Portfolios investiert sein soll, abhängig von der Marktphase
export function exposureFor(regime) {
  const r = regime?.score;
  if (r === null || r === undefined) return { share: 0.6, text: 'Marktphase unbekannt – mittlere Investitionsquote.' };
  if (regime.bear) return { share: 0.15, text: 'Bärenmarkt (Bitcoin unter dem 200-Tage-Schnitt, Abwärtstrend): Großteil in Reserve halten.' };
  if (r >= 0.4) return { share: 1, text: 'Sehr starke Marktphase: voll investiert.' };
  if (r >= 0.15) return { share: 0.85, text: 'Gute Marktphase: überwiegend investiert.' };
  if (r >= -0.1) return { share: 0.6, text: 'Neutrale Marktphase: ein Teil bleibt in Reserve.' };
  if (r >= -0.3) return { share: 0.35, text: 'Schwache Marktphase: defensiv, hohe Reserve.' };
  return { share: 0.2, text: 'Sehr schwache Marktphase: nur kleine Positionen, Großteil in Reserve.' };
}

const REVIEW_DAYS = { '1–3 Monate': 14, '2–4 Wochen': 7, 'bis 1 Woche': 3 };

// holdings: [{ id, name, symbol, units, price, cost (je Einheit, optional), analysis }]
//   – Stablecoins (analysis.stable) zählen als Reserve.
// cash: zusätzliches Guthaben in USD
// candidates: Coins mit Kaufsignal, die noch nicht im Portfolio sind, gleiche Form ohne units/cost
// regime: Marktphase aus dem Markt-Index
export function plan({ holdings, cash = 0, candidates = [], regime, options = {}, now = Date.now() }) {
  const o = { ...DEFAULTS, ...options };
  const stable = holdings.filter((h) => h.analysis?.stable);
  const coins = holdings.filter((h) => !h.analysis?.stable).map((h) => ({ ...h, value: h.units * h.price, held: true }));
  const reserve = cash + stable.reduce((s, h) => s + h.units * h.price, 0);
  const invested = coins.reduce((s, c) => s + c.value, 0);
  const total = reserve + invested;
  if (!(total > 0)) return null;

  // Vorschlag aus der Marktphase; eine selbst gewählte Reserve hat Vorrang
  const suggested = exposureFor(regime);
  const exposure = Number.isFinite(o.investShare)
    ? { share: Math.min(1, Math.max(0, o.investShare)), custom: true,
      text: `Du hast eine Reserve von ${Math.round((1 - o.investShare) * 100)} % gewählt (Vorschlag: ${Math.round((1 - suggested.share) * 100)} %).` }
    : suggested;
  const budget = total * exposure.share;
  const cap = (c) => total * (CORE.has(c.id) ? o.maxWeightCore : o.maxWeight * RISK_CAP[c.analysis?.risk?.level ?? 2]);
  const minTrade = Math.max(o.minTradeUsd, total * o.minTradeShare);
  const score = (c) => c.analysis?.score ?? 0;
  const signal = (c) => c.analysis?.signal ?? 'hold';

  // 1. Was vom Bestand bleibt: Verkaufssignal → nichts, sonst höchstens bis zur Obergrenze
  for (const c of coins) {
    c.adj = adjusted(c.analysis ?? {});
    c.target = signal(c) === 'sell' ? 0 : Math.min(c.value, cap(c));
    c.why = signal(c) === 'sell' ? 'signal' : c.value > cap(c) + minTrade ? 'cap' : null;
  }

  // 1b. Schutz bei fallenden Kursen: Fällt ein Coin deutlich unter sein Hoch seit dem Kauf oder unter den
  // Kaufpreis, wird verkauft – unabhängig vom Score
  for (const c of coins) {
    if (c.target === 0) continue;
    const fromPeak = c.peak ? c.price / c.peak - 1 : null;
    const fromCost = c.cost ? c.price / c.cost - 1 : null;
    if (o.trailStop && fromPeak !== null && fromPeak <= -o.trailStop) { c.target = 0; c.why = 'stop'; c.drop = fromPeak; c.dropFrom = 'seinem Hoch seit dem Kauf'; }
    else if (o.stopLoss && fromCost !== null && fromCost <= -o.stopLoss) { c.target = 0; c.why = 'stop'; c.drop = fromCost; c.dropFrom = 'dem Kaufpreis'; }
  }

  // 2. Gewinne teilweise sichern, wenn der Kurs weit gelaufen und der Trend überdehnt oder das Signal weg ist
  for (const c of coins) {
    if (!c.cost || c.target === 0) continue;
    if (c.trimPrice && c.price < c.trimPrice * o.profitRepeat) continue;   // Gewinn wurde vor Kurzem schon gesichert
    const gain = c.price / c.cost - 1;
    const tired = signal(c) !== 'buy' || (c.analysis?.long?.score ?? 0) < -0.15;
    const keep = gain >= o.profitGainHigh && tired ? 0.5 : gain >= o.profitGain && tired ? 0.67 : 1;
    if (keep < 1 && c.value * keep < c.target) { c.target = c.value * keep; c.why = 'profit'; c.gain = gain; }
  }

  // 3. Ist mehr investiert, als die Marktphase erlaubt, werden die schwächsten Positionen zuerst gekürzt
  let excess = coins.reduce((s, c) => s + c.target, 0) - budget;
  if (excess > minTrade) {
    for (const c of [...coins].sort((a, b) => a.adj - b.adj)) {
      if (excess <= 0) break;
      const cut = Math.min(c.target, excess);
      if (cut > 0) { c.target -= cut; excess -= cut; c.cutForExposure = true; c.why = c.why ?? 'exposure'; }
    }
  }

  // 4. Freies Budget auf Coins mit Kaufsignal verteilen – Bestand und neue Kandidaten
  const fresh = candidates.filter((c) => signal(c) === 'buy' && !coins.some((h) => h.id === c.id))
    .map((c) => ({ ...c, units: 0, value: 0, target: 0, held: false, adj: adjusted(c.analysis ?? {}) }))
    .sort((a, b) => b.adj - a.adj);
  const kept = coins.filter((c) => c.target > 0);
  // Neue Positionen nur, wenn jede mindestens rund 8 % des Portfolios groß werden kann – sonst fressen Gebühren den Nutzen
  const freeNow = budget - coins.reduce((s, c) => s + c.target, 0);
  const slots = Math.min(Math.max(0, o.maxPositions - kept.length), Math.floor(freeNow / (total * 0.08)));
  const entries = fresh.slice(0, Math.max(0, slots));

  // Tauschen: Kein Platz mehr, aber ein Kandidat ist deutlich besser als die schwächste gehaltene Position
  const swaps = [];
  if (!regime?.bear) {
    const weakest = kept.filter((c) => signal(c) !== 'buy' && c.why !== 'profit').sort((a, b) => a.adj - b.adj);
    for (const cand of fresh.slice(entries.length)) {
      const out = weakest.shift();
      if (!out || cand.adj - out.adj < o.swapGap) break;
      swaps.push({ from: out, to: cand });
      out.target = 0; out.why = 'swap'; out.swapTo = cand;
      cand.swapFrom = out;
      entries.push(cand);
    }
  }

  const buyers = [...kept.filter((c) => signal(c) === 'buy' && c.target > 0 && !c.why), ...entries];
  let free = budget - coins.reduce((s, c) => s + c.target, 0);
  // Verteilung nach Score; was über die Obergrenze hinausginge, fließt an die übrigen
  for (let round = 0; round < 4 && free > minTrade && buyers.length; round++) {
    const open = buyers.filter((c) => cap(c) - c.target > 1);
    const weight = open.reduce((s, c) => s + Math.max(c.adj, 5), 0);
    if (!weight) break;
    let used = 0;
    for (const c of open) {
      const add = Math.min(free * Math.max(c.adj, 5) / weight, cap(c) - c.target);
      c.target += add; used += add;
    }
    free -= used;
    if (used < 1) break;
  }

  // 5. Aus Zielwerten werden Schritte – kleine Abweichungen bleiben liegen
  const moves = [];
  const review = (days) => new Date(now + days * 86_400_000);
  const all = [...coins, ...entries];
  for (const c of all) {
    const diff = c.target - c.value;
    const exit = c.target === 0 && c.value >= o.minTradeUsd;
    if (!exit && Math.abs(diff) < minTrade) { c.target = c.value; continue; }
    if (diff === 0) continue;
    const usd = Math.abs(diff);
    const a = c.analysis ?? {};
    const base = { id: c.id, name: c.name, symbol: c.symbol, usd, units: usd / c.price, fee: usd * o.fee, score: score(c), price: c.price };
    if (diff < 0) {
      const part = c.target > 0;
      if (c.why === 'signal') moves.push({ ...base, type: 'sell', title: `${c.name} verkaufen`,
        goal: 'Verluste begrenzen und Kapital für bessere Chancen frei machen.',
        reason: `Verkaufssignal (Score ${fmt(score(c))}). ${factorHint(a)}`,
        horizon: 'In den nächsten Tagen umsetzen.', review: review(14),
        reviewText: 'Wieder einsteigen erst, wenn das Signal auf „Kaufen“ dreht.' });
      else if (c.why === 'stop') moves.push({ ...base, type: 'sell', title: `${c.name} verkaufen`,
        goal: 'Verlust begrenzen, bevor aus einem Rückgang ein großer Verlust wird.',
        reason: `Der Kurs liegt ${Math.round(-c.drop * 100)} % unter ${c.dropFrom}. Ab dieser Schwelle greift die Schutzregel.`,
        horizon: 'Zeitnah umsetzen.', review: review(14),
        reviewText: 'Wieder einsteigen erst, wenn ein neues Kaufsignal steht und der Kurs sich gefangen hat.' });
      else if (c.why === 'profit') moves.push({ ...base, type: 'profit', title: `${c.name}: Gewinn teilweise mitnehmen`,
        goal: 'Einen Teil des Gewinns sichern, den Rest weiterlaufen lassen.',
        reason: `Die Position liegt ${fmt(c.gain * 100)} % im Plus, und ${signal(c) !== 'buy' ? 'das Kaufsignal ist nicht mehr da' : 'der langfristige Trend ist überdehnt'}.${c.cutForExposure ? ' Zusätzlich verlangt die Marktphase eine höhere Reserve.' : ''}`,
        horizon: 'In den nächsten Tagen umsetzen.', review: review(14), reviewText: 'Restposition in 2 Wochen erneut prüfen.' });
      else if (c.why === 'swap') moves.push({ ...base, type: 'sell', title: `${c.name} verkaufen`,
        goal: 'Kapital aus einer schwachen in eine deutlich stärkere Position umschichten.',
        reason: `${c.name} hat kein Kaufsignal mehr (Score ${fmt(score(c))}), ${c.swapTo.name} steht bei ${fmt(score(c.swapTo))} – der Abstand ist groß genug, um die doppelte Gebühr zu rechtfertigen.`,
        horizon: 'In den nächsten Tagen umsetzen.', review: review(7) });
      else if (c.why === 'cap') moves.push({ ...base, type: 'reduce', title: `${c.name} reduzieren`,
        goal: 'Klumpenrisiko senken: Keine einzelne Position soll das Portfolio dominieren.',
        reason: `${c.name} macht ${Math.round(c.value / total * 100)} % des Portfolios aus, die Obergrenze liegt bei ${Math.round(cap(c) / total * 100)} %.`,
        horizon: 'Ohne Zeitdruck, innerhalb von 1–2 Wochen.', review: review(30), reviewText: 'Gewichtung in einem Monat erneut prüfen.' });
      else moves.push({ ...base, type: part ? 'reduce' : 'sell', title: `${c.name} ${part ? 'reduzieren' : 'verkaufen'}`,
        goal: 'Investitionsquote an die Marktphase anpassen und Reserve aufbauen.',
        reason: `${exposure.text} Gekürzt wird zuerst, was den schwächsten Score hat (${fmt(score(c))}).`,
        horizon: 'In den nächsten Tagen umsetzen.', review: review(7), reviewText: 'In einer Woche prüfen, ob sich die Marktphase gebessert hat.' });
    } else {
      moves.push({ ...base, type: c.held ? 'add' : 'buy', title: c.held ? `${c.name} nachkaufen` : `${c.name} kaufen`,
        goal: c.held ? 'Eine starke Position ausbauen, solange das Kaufsignal steht.' : 'Freie Reserve in einen Coin mit starkem Signal investieren.',
        reason: `Kaufsignal (Score ${fmt(score(c))}, Risiko ${a.risk?.label ?? 'unbekannt'}). ${factorHint(a)}`,
        horizon: `Haltedauer: ${a.horizon ?? '2–4 Wochen'}.`, review: review(REVIEW_DAYS[a.horizon] ?? 7) });
    }
  }
  // Verkäufe und Käufe zu Tauschvorschlägen paaren: Der Erlös eines Verkaufs fließt direkt in einen Kauf.
  // Was übrig bleibt, geht in die Reserve (Verkauf) oder kommt aus der Reserve (Kauf).
  if (o.pairSwaps) {
    const sells = moves.filter((m) => m.usd > 0 && (m.type === 'sell' || m.type === 'reduce' || m.type === 'profit')).sort((x, y) => y.usd - x.usd);
    const buys = moves.filter((m) => m.type === 'buy' || m.type === 'add').sort((x, y) => y.score - x.score);
    for (const sell of sells) {
      for (const buy of buys) {
        if (sell.usd < minTrade / 2 || buy.usd < minTrade / 2) continue;
        let usd = Math.min(sell.usd, buy.usd);
        // Kleine Reste nicht als eigenen Schritt stehen lassen
        if (sell.usd - usd < minTrade / 2) usd = sell.usd;
        const part = usd / sell.usd;
        moves.push({ id: sell.id, name: sell.name, symbol: sell.symbol, price: sell.price, score: sell.score,
          usd, units: usd / sell.price, fee: usd * o.fee * 2, type: 'swap', from: sell.type, to: buy.id,
          toCoin: { id: buy.id, symbol: buy.symbol, name: buy.name, price: buy.price },
          toUnits: usd * (1 - o.fee) * (1 - o.fee) / buy.price,
          title: `${sell.name} in ${buy.name} tauschen`,
          goal: `${sell.goal} Der Erlös geht direkt in ${buy.name}.`,
          reason: `${sell.name}: ${sell.reason} ${buy.name}: ${buy.reason}`,
          horizon: buy.horizon, review: buy.review, reviewText: buy.reviewText });
        sell.usd -= usd; sell.units -= sell.units * part; sell.fee = sell.usd * o.fee;
        buy.usd = Math.max(0, buy.usd - usd); buy.units = buy.usd / buy.price; buy.fee = buy.usd * o.fee;
      }
    }
    for (let k = moves.length - 1; k >= 0; k--) {
      const m = moves[k];
      const rest = m.type !== 'swap' && m.usd < minTrade / 2;
      // Reste eines vollständigen Ausstiegs bleiben als Verkauf stehen, sonst bliebe ein Krümel im Bestand
      if (rest && !(m.usd >= o.minTradeUsd && (m.type === 'sell'))) moves.splice(k, 1);
    }
  }
  moves.sort((x, y) => ORDER[x.type] - ORDER[y.type] || y.usd - x.usd);

  const fees = moves.reduce((s, m) => s + m.fee, 0);
  const targetInvested = all.reduce((s, c) => s + c.target, 0);
  return {
    total, reserve, invested, exposure, suggested, minTrade,
    investedShare: invested / total, targetShare: targetInvested / total,
    moves, fees, targets: all.map((c) => ({ id: c.id, target: c.target, value: c.value })),
    holds: coins.filter((c) => c.target === c.value && c.value > 0).map((c) => ({ id: c.id, name: c.name, score: score(c), signal: signal(c) })),
  };
}

const ORDER = { sell: 0, profit: 1, reduce: 2, swap: 3, buy: 4, add: 5 };
const fmt = (v) => (v > 0 ? '+' : '') + Math.round(v).toLocaleString('de-DE');

// Der stärkste Einzelfaktor als kurze Begründung
function factorHint(a) {
  const all = [a.short, a.medium, a.long, a.regime].flatMap((h) => h?.factors ?? []);
  if (!all.length) return '';
  const top = [...all].sort((x, y) => Math.abs(y.score * y.weight) - Math.abs(x.score * x.weight))[0];
  return `Wichtigster Grund: ${top.name} – ${top.text}.`;
}

// Bestand nach einem ausgeführten Schritt: Mengen, Reserve und Kaufpreise, jeweils mit Gebühr.
// Käufe werden aus der Reserve bezahlt – erst Bargeld, dann Stablecoins. Gibt null zurück, wenn nichts zu tun war.
export function applyMove(positions, cash, move, { fee = DEFAULTS.fee, stableIds = [] } = {}) {
  const list = positions.map((p) => ({ ...p }));
  const find = (id) => list.find((p) => p.id === id);
  const sell = (id, usd, price) => {
    const p = find(id);
    if (!p) return 0;
    const units = Math.min(p.amount, usd / price);
    p.amount -= units;
    return units * price * (1 - fee);
  };
  const pay = (usd) => {
    const fromCash = Math.min(cash, usd);
    cash -= fromCash;
    let rest = usd - fromCash;
    for (const id of stableIds) {
      const p = find(id);
      if (!p || rest <= 0.005) continue;
      const take = Math.min(p.amount, rest);
      p.amount -= take; rest -= take;
    }
    return usd - Math.max(0, rest);
  };
  const buy = (target, usd, price) => {
    const units = usd * (1 - fee) / price;
    let p = find(target.id);
    if (!p) { p = { id: target.id, symbol: target.symbol, name: target.name, amount: 0, cost: null, costCur: 'usd', since: Date.now() }; list.push(p); }
    p.peak = Math.max(p.peak ?? 0, price);
    // Durchschnittlicher Kaufpreis inklusive Gebühr
    p.cost = Number.isFinite(p.cost) && p.amount > 0 ? (p.cost * p.amount + usd) / (p.amount + units) : usd / units;
    p.amount += units;
  };
  if (move.type === 'buy' || move.type === 'add') {
    const paid = pay(move.usd);
    if (paid < 1) return null;
    buy(move, paid, move.price);
  } else if (move.type === 'swap') {
    const got = sell(move.id, move.usd, move.price);
    if (got < 1) return null;
    buy(move.toCoin, got, move.toCoin.price);
    const source = find(move.id);
    if (move.from === 'profit' && source) source.trimPrice = move.price;
  } else {
    const got = sell(move.id, move.usd, move.price);
    if (got <= 0) return null;
    cash += got;
    // Merken, bei welchem Kurs Gewinn gesichert wurde – sonst käme der Vorschlag beim nächsten Mal wieder
    const p = find(move.id);
    if (move.type === 'profit' && p) p.trimPrice = move.price;
  }
  return { positions: list.filter((p) => p.amount > 1e-12), cash };
}
