// C&L Builders payment waterfall (Cloudflare Pages, advanced mode: every request runs through here,
// so no page, script or data is served without a valid session).
//
//   GET  /            login form, or the app once signed in
//   GET  /app.js      the app's script (signed in only)
//   POST /login       form field "password" -> session cookie
//   POST /logout      clears the cookie
//   GET  /api/data    inputs + rows + version (signed in only)
//
// Read-only: the page is a scenario planner. Reordering happens in the browser and never reaches the sheet.
//
// Settings are environment variables; see ../.env.example.

import { configError, passwordMatches, createSession, clearSessionCookie, hasSession, isLocked, recordFail, clearFails } from '../src/auth.js';
import { getStore } from '../src/google.js';
import { parseRows, parseInputs, headersOk, versionOf } from '../src/sheet.js';

const SECURITY_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin', // no-referrer would make browsers send "Origin: null" on our own form posts
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const respond = (body, status, type, extra = {}) =>
  new Response(body, { status, headers: { 'Content-Type': type, ...SECURITY_HEADERS, ...extra } });
const json = (obj, status = 200) => respond(JSON.stringify(obj), status, 'application/json; charset=utf-8');
const redirect = (to, extra = {}) => respond(null, 303, 'text/plain', { Location: to, ...extra });

async function asset(env, req, path, type) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, req.url)));
  return { text: await res.text(), type };
}

async function loginPage(env, req, message = '', status = message ? 401 : 200) {
  const { text } = await asset(env, req, '/login', 'text/html');
  const safe = message.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return respond(text.replace('<!--ERR-->', safe), status, 'text/html; charset=utf-8');
}

// Reads the sheet and shapes it for the page.
async function load(store) {
  const sheet = await store.read();
  if (!headersOk(sheet.headers)) {
    const err = new Error('layout changed');
    err.code = 'layout';
    throw err;
  }
  const rows = parseRows(sheet.formulas, sheet.values);
  const inputs = parseInputs(sheet.inputs);
  const version = await versionOf(sheet.formulas, sheet.inputs);
  return { rows, inputs, version };
}

const publicData = ({ rows, inputs, version }, store) => ({
  version,
  inputs,
  rows: rows.map(({ project, vendor, date, amount, incoming }) => ({ project, vendor, date, amount, incoming })),
  demo: !!store.demo,
  fetchedAt: new Date().toISOString(),
});

function sheetError(e) {
  console.log('sheet error', String(e && e.message));
  if (e && e.code === 'layout')
    return json({ error: 'The sheet layout changed (row 8 should read Project, Vendor, Date, Amount in B-E).' }, 502);
  return json({ error: 'Could not reach the Google Sheet. Try again in a moment.' }, 502);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method === 'HEAD' ? 'GET' : req.method; // the runtime drops the body for HEAD

    if (path === '/robots.txt') return respond('User-agent: *\nDisallow: /\n', 200, 'text/plain');

    const misconfig = configError(env);
    if (misconfig) {
      console.log('misconfigured:', misconfig);
      return respond('Server not configured.', 500, 'text/plain');
    }

    // Writes must come from this site's own pages (SameSite=Strict covers this too; belt and braces).
    if (method === 'POST') {
      const origin = req.headers.get('Origin');
      const sameSite = origin === url.origin || ((!origin || origin === 'null') && req.headers.get('Sec-Fetch-Site') === 'same-origin');
      if (!sameSite) return respond('Forbidden', 403, 'text/plain');
    }

    if (path === '/login' && method === 'POST') {
      const ip = req.headers.get('CF-Connecting-IP') || 'local';
      if (await isLocked(env, ip)) return loginPage(env, req, 'Too many wrong tries. Wait 15 minutes and try again.', 429);
      let attempt = '';
      try {
        attempt = String((await req.formData()).get('password') || '');
      } catch {}
      if (!(await passwordMatches(env, attempt))) {
        await recordFail(env, ip);
        await new Promise((r) => setTimeout(r, 400)); // slows guessing a little more
        return loginPage(env, req, 'That password is not right.');
      }
      await clearFails(env, ip);
      return redirect('/', { 'Set-Cookie': await createSession(env) });
    }

    if (path === '/logout' && method === 'POST') return redirect('/', { 'Set-Cookie': clearSessionCookie() });

    const authed = await hasSession(env, req);

    if (path === '/' && method === 'GET') {
      if (!authed) return loginPage(env, req);
      const { text } = await asset(env, req, '/app', 'text/html');
      return respond(text, 200, 'text/html; charset=utf-8');
    }

    if (path === '/app.js' && method === 'GET') {
      if (!authed) return respond('Not found', 404, 'text/plain');
      const { text } = await asset(env, req, '/app.js', 'text/javascript');
      return respond(text, 200, 'text/javascript; charset=utf-8');
    }

    if (path.startsWith('/api/')) {
      if (!authed) return json({ error: 'signed out' }, 401);
      let store;
      try {
        store = getStore(env);
      } catch (e) {
        console.log('store error', String(e.message));
        return json({ error: 'Server not configured.' }, 500);
      }

      if (path === '/api/data' && method === 'GET') {
        try {
          return json(publicData(await load(store), store));
        } catch (e) {
          return sheetError(e);
        }
      }

      return json({ error: 'not found' }, 404);
    }

    return respond('Not found', 404, 'text/plain');
  },
};
