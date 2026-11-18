// Google Sheets access with a service account (JWT -> OAuth token), plus an in-memory demo store.
// Both stores expose: read() -> {formulas, values, inputs, headers} and write(grid).

import { RANGES } from './sheet.js';

const enc = new TextEncoder();
const tokenCache = new Map(); // scope -> {value, exp}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function googleToken(env, scope) {
  const now = Math.floor(Date.now() / 1000);
  const hit = tokenCache.get(scope);
  if (hit && hit.exp - 60 > now) return hit.value;

  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64url(enc.encode(JSON.stringify({
    iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claim}`));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new Error(`google auth failed (${res.status})`);
  const j = await res.json();
  tokenCache.set(scope, { value: j.access_token, exp: now + j.expires_in });
  return j.access_token;
}

function sheetsStore(env) {
  const readOnly = env.READ_ONLY === '1' || env.READ_ONLY === 'true';
  // In read-only mode the token itself can't write, so a bug can't touch the sheet.
  const scope = readOnly ? 'https://www.googleapis.com/auth/spreadsheets.readonly' : 'https://www.googleapis.com/auth/spreadsheets';
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.SHEET_ID)}`;

  async function batchGet(token, ranges, valueRender) {
    const p = new URLSearchParams({ valueRenderOption: valueRender, dateTimeRenderOption: 'FORMATTED_STRING' });
    for (const r of ranges) p.append('ranges', r);
    const res = await fetch(`${base}/values:batchGet?${p}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`sheets read ${res.status}`);
    return (await res.json()).valueRanges.map((vr) => vr.values || []);
  }

  return {
    readOnly,
    async read() {
      const token = await googleToken(env, scope);
      const [[formulas], [inputs, headers, values]] = await Promise.all([
        batchGet(token, [RANGES.rows], 'FORMULA'),
        batchGet(token, [RANGES.inputs, RANGES.headers, RANGES.rows], 'UNFORMATTED_VALUE'),
      ]);
      return { formulas, values, inputs, headers: headers[0] || [] };
    },
    async write(grid) {
      if (readOnly) throw new Error('read-only');
      const token = await googleToken(env, scope);
      const url = `${base}/values/${encodeURIComponent(RANGES.rows)}?valueInputOption=USER_ENTERED`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: RANGES.rows, majorDimension: 'ROWS', values: grid }),
      });
      if (!res.ok) throw new Error(`sheets write ${res.status}`);
    },
  };
}

// DEMO_DATA=1: fake rows held in memory (per isolate), for trying the page without Google credentials.
// The formulas mimic the real sheet: the incoming row's Date and Amount are =C5 and =C4.
const demo = {
  inputs: [[150000], [200000], ['11/30/2026']],
  formulas: [
    ['Project A', 'Sample Vendor 1 - Inv 101', '', -95000],
    ['Project A', 'Sample Vendor 2 - Inv 7', '', -1200],
    ['Project A', 'Sample Vendor 3', '', -14000],
    ['Project B', 'Sample Vendor 4 - Inv 55', '', -18500],
    ['Project B', 'Sample Vendor 5', '', -33000],
    ['Project C', 'Sample Vendor 6 - Inv 9', '', -22000],
    ['Multiple', 'Sample Vendor 7 - Running', '', -17900],
    ['', 'Pending client payment', '=C5', '=C4'],
    ['Project C', 'Sample Vendor 8', '', -25500],
  ],
};
function demoStore() {
  const evalCell = (v) => (v === '=C4' ? demo.inputs[1][0] : v === '=C5' ? demo.inputs[2][0] : v);
  return {
    readOnly: false,
    demo: true,
    async read() {
      return {
        formulas: demo.formulas.map((r) => [...r]),
        values: demo.formulas.map((r) => r.map(evalCell)),
        inputs: demo.inputs,
        headers: ['Project', 'Vendor', 'Date', 'Amount'],
      };
    },
    async write(grid) {
      demo.formulas = grid.filter((r) => r.some((v) => v !== '')).map((r) => r.map((v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v)));
    },
  };
}

export function getStore(env) {
  if (env.DEMO_DATA === '1' || env.DEMO_DATA === 'true') return demoStore();
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.SHEET_ID) throw new Error('missing Google settings');
  return sheetsStore(env);
}
