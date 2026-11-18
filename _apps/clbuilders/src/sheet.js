// Layout of the "Payment Waterfall" tab and the pure logic for reading and reordering it.
// Nothing here talks to Google; see google.js for that. Tested in test/sheet.test.js.
//
// Layout (confirmed against the sheet on 2026-11-18):
//   C3 starting bank balance, C4 incoming payment amount, C5 expected date of incoming payment
//   F2:G6 summary formulas (the page recomputes these from the rows, so they are not read)
//   Row 8 headers: A Step | B Project | C Vendor | D Date | E Amount | F Running Balance | G Check
//   Rows 9-48 data. Only B-E are inputs; A, F and G are formulas and are never written.
//   A49 onward holds the "How to use" notes, which are outside every range used here.

export const TAB = 'Payment Waterfall';
export const FIRST_ROW = 9;
export const LAST_ROW = 48;
export const ROW_COUNT = LAST_ROW - FIRST_ROW + 1; // 40
export const EXPECTED_HEADERS = ['project', 'vendor', 'date', 'amount'];

const q = (tab) => `'${tab.replace(/'/g, "''")}'`;
export const RANGES = {
  inputs: `${q(TAB)}!C3:C5`,
  headers: `${q(TAB)}!B8:E8`,
  rows: `${q(TAB)}!B${FIRST_ROW}:E${LAST_ROW}`,
};

const isBlank = (v) => v === undefined || v === null || v === '';

// Pads a ragged Sheets values array to exactly ROW_COUNT x 4.
export function padGrid(grid) {
  const out = [];
  for (let r = 0; r < ROW_COUNT; r++) {
    const row = (grid && grid[r]) || [];
    out.push([0, 1, 2, 3].map((c) => (isBlank(row[c]) ? '' : row[c])));
  }
  return out;
}

export function headersOk(headerRow) {
  const h = (headerRow || []).map((v) => String(v ?? '').trim().toLowerCase());
  return EXPECTED_HEADERS.every((want, i) => h[i] === want);
}

export function toNumber(v) {
  if (typeof v === 'number') return v;
  if (isBlank(v)) return 0;
  const s = String(v).trim();
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
}

// formulas: B9:E48 read with valueRenderOption=FORMULA (formulas as "=C4", plain values as typed).
// values:   B9:E48 read with UNFORMATTED_VALUE (what the formulas evaluate to).
// Returns the non-blank rows in sheet order. `raw` is kept server-side only for the rewrite.
export function parseRows(formulas, values) {
  const f = padGrid(formulas), v = padGrid(values);
  const rows = [];
  for (let r = 0; r < ROW_COUNT; r++) {
    if (f[r].every(isBlank)) continue;
    const amount = toNumber(v[r][3]);
    const refsIncoming = typeof f[r][3] === 'string' && /^=\s*\$?C\$?4(?![0-9])/i.test(f[r][3]);
    rows.push({
      project: String(v[r][0] ?? ''),
      vendor: String(v[r][1] ?? ''),
      date: String(v[r][2] ?? ''),
      amount,
      incoming: refsIncoming || /pending client payment/i.test(String(v[r][1] ?? '')),
      raw: f[r],
    });
  }
  return rows;
}

export function parseInputs(values) {
  const col = (values || []).map((r) => (r && r[0] !== undefined ? r[0] : ''));
  return { startingBalance: toNumber(col[0]), incomingAmount: toNumber(col[1]), incomingDate: String(col[2] ?? '') };
}

// Fingerprint of the input cells the page depends on. Any edit to the rows (or C3:C5) changes it.
export async function versionOf(formulas, inputs) {
  const data = new TextEncoder().encode(JSON.stringify([padGrid(formulas), inputs]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

// True when `order` is a permutation of 0..n-1.
export function isPermutation(order, n) {
  if (!Array.isArray(order) || order.length !== n) return false;
  const seen = new Set();
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= n || seen.has(i)) return false;
    seen.add(i);
  }
  return true;
}

// Text in Project/Vendor that USER_ENTERED would turn into a number, date or boolean gets a leading
// apostrophe so it stays text. Formulas ("=...") pass through so they stay formulas.
function safeText(v) {
  if (typeof v !== 'string' || v === '' || v.startsWith('=')) return v;
  if (/^[\s\d.,$%()+\-\/:]+$/.test(v) || /^(true|false)$/i.test(v) || v.startsWith("'")) return `'${v}`;
  return v;
}

// The 40x4 block to write to B9:E48 with valueInputOption=USER_ENTERED: the rows in the new order,
// then blanks to clear whatever was below. Date (D) and Amount (E) are written exactly as read with
// FORMULA rendering (dates as formatted strings), so formulas such as =C5 and =C4 survive the move.
export function buildWrite(rows, order) {
  const out = order.map((i) => {
    const [b, c, d, e] = rows[i].raw;
    return [safeText(b), safeText(c), d, e];
  });
  while (out.length < ROW_COUNT) out.push(['', '', '', '']);
  return out;
}

// Summary the page shows; mirrors the sheet's F2:G6 formulas.
export function summarize(startingBalance, amounts) {
  let bal = startingBalance, lowest = amounts.length ? Infinity : startingBalance, owed = 0, cashIn = 0;
  const running = amounts.map((a) => {
    if (a < 0) owed += -a; else cashIn += a;
    bal += a;
    if (bal < lowest) lowest = bal; // lowest running balance (like MIN of column F)
    return bal;
  });
  return { running, totalOwed: owed, cashIn, endingBalance: bal, lowest, shortfall: lowest < 0 ? -lowest : 0, ok: lowest >= 0 };
}
