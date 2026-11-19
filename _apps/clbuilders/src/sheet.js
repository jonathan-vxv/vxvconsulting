// Layout of the "Payment Waterfall" tab and the pure logic for reading it. The app never writes to the sheet.
// Nothing here talks to Google; see google.js for that. Tested in test/sheet.test.js.
//
// Layout (confirmed against the sheet on 2026-11-18):
//   C3 starting bank balance, C4 incoming payment amount, C5 expected date of incoming payment
//   F2:G6 summary formulas (the page recomputes these from the rows, so they are not read)
//   Row 8 headers: A Step | B Project | C Vendor | D Date | E Amount | F Running Balance | G Check
//   Rows 9-48 data (B-E are read; A, F and G are formulas the page recomputes).
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
// Returns the non-blank rows in sheet order.
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
    });
  }
  return rows;
}

export function parseInputs(values) {
  const col = (values || []).map((r) => (r && r[0] !== undefined ? r[0] : ''));
  return { startingBalance: toNumber(col[0]), incomingAmount: toNumber(col[1]), incomingDate: String(col[2] ?? '') };
}

// Fingerprint of the cells the page shows. Any edit to the rows (or C3:C5) changes it; the page uses it
// to keep a scenario across reloads only while the sheet is unchanged.
export async function versionOf(formulas, inputs) {
  const data = new TextEncoder().encode(JSON.stringify([padGrid(formulas), inputs]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
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
