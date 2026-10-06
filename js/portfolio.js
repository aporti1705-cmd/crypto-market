// Portfolio: Speicherung im Browser und Import aus Tabellen-Dateien (z. B. Export aus CoinMarketCap)

const KEY = 'krypto-markt-depot';
const LEGACY_KEY = 'krypto-markt-portfolio';   // frühere Version: nur die Liste der Positionen

export const empty = () => ({ positions: [], cash: 0, reservePct: null, reserveMode: 'balanced' });

// Macht aus beliebigen gespeicherten Daten ein gültiges Portfolio
export function normalise(data) {
  const positions = (Array.isArray(data?.positions) ? data.positions : [])
    .filter((p) => p && Number.isFinite(p.amount) && p.amount > 0 && (p.id || p.symbol || p.name))
    .map((p) => ({ id: p.id ?? null, symbol: p.symbol ?? '', name: p.name ?? '', amount: p.amount,
      cost: Number.isFinite(p.cost) ? p.cost : null, costCur: 'usd',
      ...(Number.isFinite(p.trimPrice) ? { trimPrice: p.trimPrice } : {}),
      ...(Number.isFinite(p.since) ? { since: p.since } : {}),
      ...(Number.isFinite(p.peak) ? { peak: p.peak } : {}) }));
  const pct = data?.reservePct;
  return { positions, cash: Number.isFinite(data?.cash) && data.cash > 0 ? data.cash : 0,
    // Gewünschte Reserve in Prozent; null bedeutet: dem Vorschlag der Seite folgen
    reservePct: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null,
    // Welchem Vorschlag gefolgt wird, solange kein eigener Wert gesetzt ist
    reserveMode: data?.reserveMode === 'cautious' ? 'cautious' : 'balanced' };
}

export function load() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY));
    if (data) return normalise(data);
    const old = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (Array.isArray(old)) return normalise({ positions: old });
  } catch {}
  return empty();
}

export function save(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
}

export const keyOf = (pos) => String(pos.id || pos.symbol || pos.name).toLowerCase();

// Position hinzufügen; bei vorhandenem Coin Menge addieren und Kaufpreis mitteln
export function add(list, pos) {
  const old = list.find((p) => keyOf(p) === keyOf(pos));
  if (!old) return [...list, pos];
  const total = old.amount + pos.amount;
  const known = Number.isFinite(old.cost) && Number.isFinite(pos.cost);
  old.cost = known ? (old.cost * old.amount + pos.cost * pos.amount) / total : (old.cost ?? pos.cost ?? null);
  old.amount = total;
  if (Number.isFinite(pos.peak)) old.peak = Math.max(old.peak ?? 0, pos.peak);
  old.since = Math.min(old.since ?? Infinity, pos.since ?? Infinity);
  if (!Number.isFinite(old.since)) delete old.since;
  return list;
}

// Zahlen in deutscher und englischer Schreibweise lesen ("1.234,56" und "1,234.56")
export function parseNumber(value) {
  let s = String(value ?? '').replace(/[^\d.,\-eE]/g, '');
  if (!s) return NaN;
  const comma = s.lastIndexOf(','), dot = s.lastIndexOf('.');
  if (comma > -1 && dot > -1) s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  // Nur Kommas: Tausendertrennung, wenn es danach aussieht ("1,234,567") – "0,029" ist immer eine Dezimalzahl
  else if (comma > -1) s = /^-?[1-9]\d{0,2}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  return Number(s);
}

// Eingaben auf der Seite sind deutsch geschrieben: Das Komma ist immer das Dezimalzeichen ("1,234" = 1,234),
// Punkte davor sind Tausendertrennung. Ohne Komma gilt der Punkt als Dezimalzeichen ("0.5"),
// außer er steht eindeutig als Tausendertrennung ("5.000").
export function parseInput(value) {
  const s = String(value ?? '').replace(/[^\d.,\-]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) return Number(s.replace(/\./g, '').replace(',', '.'));
  // "5.000" oder "1.250.000" meint Tausender, "0.5" eine Dezimalzahl
  return Number(/^-?[1-9]\d{0,2}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s);
}

// ---------- Import ----------

// Liest eine Datei als Text. Manche Exporte sind UTF-16 statt UTF-8 kodiert.
export async function readFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const utf16le = bytes[0] === 0xff && bytes[1] === 0xfe, utf16be = bytes[0] === 0xfe && bytes[1] === 0xff;
  // Ohne Kennung: viele Nullbytes an jeder zweiten Stelle sprechen für UTF-16
  const zeros = bytes.slice(0, 200).filter((b, i) => i % 2 === 1 && b === 0).length;
  const encoding = utf16be ? 'utf-16be' : utf16le || zeros > 40 ? 'utf-16le' : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const sample = text.split(/\r?\n/).slice(0, 10).join('\n');
  const count = (ch) => sample.split(ch).length;
  const delim = [',', ';', '\t', '|'].sort((a, b) => count(b) - count(a))[0];

  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

// Mögliche Spaltennamen je Rolle, in Reihenfolge der Priorität
const COLUMNS = {
  symbol: ['symbol', 'ticker', 'coinsymbol', 'tokensymbol', 'asset', 'token', 'tokens', 'currency', 'coin', 'base', 'pair', 'market', 'kuerzel', 'waehrung'],
  name: ['name', 'coinname', 'tokenname', 'assetname', 'cryptocurrency', 'crypto', 'coin', 'token'],
  amount: ['amount', 'quantity', 'holdings', 'balance', 'qty', 'units', 'size', 'tokenamount', 'coinamount', 'anzahl', 'menge', 'bestand'],
  price: ['price', 'buyprice', 'avgbuyprice', 'averagebuyprice', 'pricepercoin', 'avgprice', 'costperunit', 'unitprice', 'rate', 'kaufpreis', 'preis', 'kurs'],
  total: ['total', 'totalspent', 'totalcost', 'totalvalue', 'costbasis', 'cost', 'spent', 'gesamt'],
  type: ['type', 'transactiontype', 'side', 'action', 'direction', 'typ', 'art'],
};

export const ROLES = [
  ['symbol', 'Coin (Kürzel)'], ['name', 'Coin (Name)'], ['amount', 'Menge'],
  ['price', 'Kaufpreis je Coin (USD)'], ['total', 'Gesamtbetrag (USD)'], ['type', 'Typ (Kauf/Verkauf)'],
];

const norm = (h) => h.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/\(.*?\)/g, '').replace(/[^a-z]/g, '');

function guessColumns(header) {
  const names = header.map(norm);
  const cols = {};
  const used = new Set();
  for (const [role, candidates] of Object.entries(COLUMNS)) {
    let idx = -1;
    for (const n of candidates) { idx = names.findIndex((h, i) => h === n && !used.has(i)); if (idx > -1) break; }
    if (idx === -1) {
      for (const n of candidates) { idx = names.findIndex((h, i) => h.includes(n) && !used.has(i)); if (idx > -1) break; }
    }
    if (idx > -1) { cols[role] = idx; used.add(idx); }
  }
  return cols;
}

// Zerlegt den Text in Kopfzeile und Datenzeilen. Die Kopfzeile ist die erste Zeile (unter den ersten 15),
// in der sich Spalten für Coin und Menge erkennen lassen – manche Exporte beginnen mit Titelzeilen.
export function parseTable(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('Die Datei enthält keine Datenzeilen.');
  let head = 0, best = -1;
  rows.slice(0, 15).forEach((r, i) => {
    const g = guessColumns(r);
    const score = Object.keys(g).length + (g.amount !== undefined && (g.symbol !== undefined || g.name !== undefined) ? 10 : 0);
    if (score > best) { best = score; head = i; }
  });
  return { header: rows[head], rows: rows.slice(head + 1), columns: guessColumns(rows[head]) };
}

// "Bitcoin (BTC)" → Name und Kürzel; "BTC/USDT" oder "BTC-USD" → BTC
function splitCoin(text) {
  const m = text.match(/^(.+?)\s*\(([A-Za-z0-9$.]{1,12})\)$/);
  if (m) return { name: m[1].trim(), symbol: m[2].trim() };
  const pair = text.match(/^([A-Za-z0-9$.]{1,12})\s*[/\-_]\s*(USDT|USDC|USD|EUR|BUSD|BTC|ETH)$/i);
  return pair ? { symbol: pair[1] } : null;
}

// Fasst Bestände oder Transaktionen je Coin zusammen. columns: { rolle: spaltenindex }
export function buildPositions(rows, columns) {
  const map = new Map();
  let skipped = 0;
  for (const row of rows) {
    const get = (f) => (columns[f] === undefined || columns[f] === null ? '' : (row[columns[f]] ?? '').trim());
    let symbol = get('symbol'), name = get('name');
    const split = splitCoin(symbol) ?? splitCoin(name);
    if (split) { symbol = split.symbol ?? symbol; name = split.name ?? name; }
    let amount = parseNumber(get('amount'));
    if ((!symbol && !name) || !Number.isFinite(amount) || amount === 0) { skipped++; continue; }

    const sell = amount < 0 || /sell|sold|verkauf|out|withdraw|send|sent/i.test(get('type'));
    amount = Math.abs(amount);
    let price = parseNumber(get('price'));
    if (!Number.isFinite(price) || price <= 0) {
      const total = Math.abs(parseNumber(get('total')));
      price = Number.isFinite(total) && total > 0 ? total / amount : NaN;
    }

    const key = (symbol || name).toLowerCase();
    const pos = map.get(key) ?? { symbol, name, amount: 0, bought: 0, spent: 0 };
    if (sell) pos.amount -= amount;
    else {
      pos.amount += amount;
      if (Number.isFinite(price)) { pos.bought += amount; pos.spent += amount * price; }
    }
    map.set(key, pos);
  }
  const positions = [...map.values()].filter((p) => p.amount > 1e-12).map(({ bought, spent, ...p }) => ({
    ...p, cost: bought > 0 ? spent / bought : null, costCur: 'usd',
  }));
  return { positions, rows: rows.length, skipped };
}
