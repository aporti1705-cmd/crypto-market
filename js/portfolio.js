// Portfolio: Speicherung im Browser und CSV-Import (z. B. Export aus CoinMarketCap)

const KEY = 'krypto-markt-depot';
const LEGACY_KEY = 'krypto-markt-portfolio';   // frühere Version: nur die Liste der Positionen

export const empty = () => ({ positions: [], cash: 0 });

// Macht aus beliebigen gespeicherten Daten ein gültiges Portfolio
export function normalise(data) {
  const positions = (Array.isArray(data?.positions) ? data.positions : [])
    .filter((p) => p && Number.isFinite(p.amount) && p.amount > 0 && (p.id || p.symbol || p.name))
    .map((p) => ({ id: p.id ?? null, symbol: p.symbol ?? '', name: p.name ?? '', amount: p.amount,
      cost: Number.isFinite(p.cost) ? p.cost : null, costCur: 'usd',
      ...(Number.isFinite(p.trimPrice) ? { trimPrice: p.trimPrice } : {}),
      ...(Number.isFinite(p.since) ? { since: p.since } : {}),
      ...(Number.isFinite(p.peak) ? { peak: p.peak } : {}) }));
  return { positions, cash: Number.isFinite(data?.cash) && data.cash > 0 ? data.cash : 0 };
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
  const known = Number.isFinite(old.cost) && Number.isFinite(pos.cost) && old.costCur === pos.costCur;
  old.cost = known ? (old.cost * old.amount + pos.cost * pos.amount) / total : (old.cost ?? pos.cost ?? null);
  old.costCur = old.costCur ?? pos.costCur;
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
  else if (comma > -1) s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  return Number(s);
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const count = (ch) => first.split(ch).length;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];

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
  return rows;
}

// Mögliche Spaltennamen, in Reihenfolge der Priorität
const COLUMNS = {
  symbol: ['symbol', 'ticker', 'coinsymbol', 'asset', 'currency', 'coin', 'token', 'kuerzel'],
  name: ['name', 'coinname', 'assetname', 'cryptocurrency', 'coin'],
  amount: ['amount', 'quantity', 'holdings', 'balance', 'qty', 'units', 'anzahl', 'menge'],
  price: ['price', 'buyprice', 'avgbuyprice', 'averagebuyprice', 'pricepercoin', 'avgprice', 'costperunit', 'kaufpreis', 'preis'],
  total: ['total', 'totalspent', 'totalcost', 'costbasis', 'cost'],
  type: ['type', 'transactiontype', 'side', 'action', 'typ'],
};

function findColumns(header) {
  const norm = header.map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const cols = {};
  const used = new Set();
  for (const [field, names] of Object.entries(COLUMNS)) {
    let idx = -1;
    for (const n of names) {
      idx = norm.findIndex((h, i) => h === n && !used.has(i));
      if (idx > -1) break;
    }
    if (idx === -1) {
      for (const n of names) {
        idx = norm.findIndex((h, i) => h.includes(n) && !used.has(i));
        if (idx > -1) break;
      }
    }
    if (idx > -1) { cols[field] = idx; used.add(idx); }
  }
  return cols;
}

// Liest Bestände oder Transaktionen und fasst sie je Coin zusammen
export function parseImport(text, costCur) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('Die Datei enthält keine Datenzeilen.');
  const cols = findColumns(rows[0]);
  if (cols.amount === undefined || (cols.symbol === undefined && cols.name === undefined)) {
    throw new Error(`Spalten für Coin und Menge nicht gefunden. Erkannte Kopfzeile: ${rows[0].join(' | ')}`);
  }

  const map = new Map();
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const get = (f) => (cols[f] === undefined ? '' : (row[cols[f]] ?? '').trim());
    const symbol = get('symbol'), name = get('name');
    let amount = parseNumber(get('amount'));
    if ((!symbol && !name) || !Number.isFinite(amount) || amount === 0) { skipped++; continue; }

    const sell = amount < 0 || /sell|verkauf|out|withdraw|send/i.test(get('type'));
    amount = Math.abs(amount);
    let price = parseNumber(get('price'));
    if (!Number.isFinite(price) || price <= 0) {
      const total = parseNumber(get('total'));
      price = Number.isFinite(total) && total > 0 ? total / amount : NaN;
    }

    const key = (symbol || name).toLowerCase();
    const pos = map.get(key) ?? { symbol, name, amount: 0, cost: null, costCur, bought: 0, spent: 0 };
    if (sell) pos.amount -= amount;
    else {
      pos.amount += amount;
      if (Number.isFinite(price)) { pos.bought += amount; pos.spent += amount * price; }
    }
    map.set(key, pos);
  }

  const positions = [...map.values()].filter((p) => p.amount > 1e-12).map(({ bought, spent, ...p }) => ({
    ...p, cost: bought > 0 ? spent / bought : null,
  }));
  return { positions, rows: rows.length - 1, skipped };
}
