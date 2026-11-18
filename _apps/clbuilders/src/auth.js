// Password check, signed session cookie and wrong-guess rate limiting.
//
// Env:
//   SITE_PASSWORD         the password (or set SITE_PASSWORD_SHA256 to its hex SHA-256 instead)
//   SESSION_SECRET        random string, 32+ characters, used to sign session cookies
//   SESSION_DAYS          optional, default 4
//   RATE_LIMIT (KV)       optional KV binding that holds wrong-guess counters across Cloudflare
//                         instances; without it, counters live in this instance's memory only.

const enc = new TextEncoder();
export const COOKIE = '__Host-clb_session';
const MAX_FAILS = 5;            // wrong guesses allowed per IP ...
const WINDOW_SECONDS = 15 * 60; // ... per 15 minutes

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export function configError(env) {
  if (!env.SITE_PASSWORD && !env.SITE_PASSWORD_SHA256) return 'SITE_PASSWORD is not set';
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return 'SESSION_SECRET must be 32+ characters';
  return null;
}

async function passwordHash(env) {
  if (env.SITE_PASSWORD_SHA256) return Uint8Array.from(env.SITE_PASSWORD_SHA256.toLowerCase().match(/../g), (h) => parseInt(h, 16));
  return sha256(env.SITE_PASSWORD);
}

// Constant-time: compares fixed-length SHA-256 digests with no early exit.
export async function passwordMatches(env, attempt) {
  if (typeof attempt !== 'string' || attempt.length > 200) return false;
  const [a, b] = await Promise.all([sha256(attempt), passwordHash(env)]);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const hmacKey = (env) =>
  crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

// The signature also covers a fingerprint of the password, so changing SITE_PASSWORD signs everyone out.
async function signedPart(env, payload) {
  return enc.encode(`${payload}|${hex(await passwordHash(env))}`);
}

export async function createSession(env) {
  const days = Number(env.SESSION_DAYS) > 0 ? Number(env.SESSION_DAYS) : 4;
  const exp = Math.floor(Date.now() / 1000) + Math.round(days * 86400);
  const payload = b64url(enc.encode(JSON.stringify({ v: 1, exp })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), await signedPart(env, payload));
  const value = `${payload}.${b64url(new Uint8Array(sig))}`;
  return `${COOKIE}=${value}; Path=/; Max-Age=${exp - Math.floor(Date.now() / 1000)}; HttpOnly; Secure; SameSite=Strict`;
}

export const clearSessionCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

export async function hasSession(env, req) {
  const cookie = req.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE.replace(/[-]/g, '\\-')}=([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)`));
  if (!m) return false;
  try {
    // crypto.subtle.verify compares the HMAC in constant time.
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), fromB64url(m[2]), await signedPart(env, m[1]));
    if (!ok) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(fromB64url(m[1])));
    return typeof exp === 'number' && exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

// ---- rate limiting of wrong guesses ----
const memory = new Map(); // ip -> {count, until}

async function getFails(env, ip) {
  if (env.RATE_LIMIT) {
    const v = await env.RATE_LIMIT.get(`fail:${ip}`, 'json');
    return v && v.until > Date.now() ? v : { count: 0, until: 0 };
  }
  const v = memory.get(ip);
  return v && v.until > Date.now() ? v : { count: 0, until: 0 };
}

export async function isLocked(env, ip) {
  return (await getFails(env, ip)).count >= MAX_FAILS;
}

export async function recordFail(env, ip) {
  const cur = await getFails(env, ip);
  const next = { count: cur.count + 1, until: cur.until || Date.now() + WINDOW_SECONDS * 1000 };
  if (env.RATE_LIMIT) {
    const ttl = Math.max(60, Math.ceil((next.until - Date.now()) / 1000));
    await env.RATE_LIMIT.put(`fail:${ip}`, JSON.stringify(next), { expirationTtl: ttl });
  } else {
    if (memory.size > 10000) memory.clear();
    memory.set(ip, next);
  }
}

export async function clearFails(env, ip) {
  if (env.RATE_LIMIT) await env.RATE_LIMIT.delete(`fail:${ip}`);
  else memory.delete(ip);
}
