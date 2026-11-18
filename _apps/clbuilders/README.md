# C&L Builders payment waterfall (clbuilders.vxvconsulting.com)

Mobile page where Chris reorders vendor payments. The Google Sheet ("Payment Waterfall" tab of
`10CaKKiAvTHZ7NN9mC3DY1eZlINsZ7POAdtQhDPk3nHY`) stays the source of truth: the page reads it and writes
the new order back to **B9:E48 only** (A, F and G are formulas and are never written).

## Why a subdomain, not vxvconsulting.com/clbuilders
vxvconsulting.com is static GitHub Pages with DNS at Porkbun, so nothing can check a password on the server at a
path there. The app runs as a Cloudflare Pages project on `clbuilders.vxvconsulting.com` instead.
`vxvconsulting.com/clbuilders/` (in the main site) just forwards there and holds no data.
(A true subpath would need the domain's DNS moved to Cloudflare; not worth it for this.)

This folder starts with `_`, so GitHub Pages (Jekyll) does not publish it on vxvconsulting.com.

## Files
- `public/_worker.js`: every request goes through it: login, signed cookie, `/api/data`, `/api/order`.
- `public/login.html`, `public/app.html`, `public/app.js`: served only through the worker (app only when signed in).
- `src/sheet.js`: sheet layout and reorder logic. `src/auth.js`: password, cookie, rate limit. `src/google.js`: Sheets API.
- `test/sheet.test.js`: `npm test`.

## How it works
- Password: `SITE_PASSWORD` (or `SITE_PASSWORD_SHA256`) env var, compared as SHA-256 digests in constant time.
  Success sets `__Host-clb_session`: HMAC-signed with `SESSION_SECRET`, HttpOnly, Secure, SameSite=Strict, 4 days
  (`SESSION_DAYS`). Changing the password or the secret signs everyone out.
- Wrong guesses: 5 per IP per 15 minutes, then locked out for the rest of the window. Uses the `RATE_LIMIT` KV
  namespace if bound (recommended), otherwise per-instance memory.
- Every response: `X-Robots-Tag: noindex`, `robots.txt` disallows all, strict CSP, no caching.
- Each move saves the whole order. The server re-reads the sheet first and refuses (409) if B9:E48 or C3:C5 changed
  since the page loaded; the page then shows the sheet's current order and says so.
- Rows are read with `valueRenderOption=FORMULA` and written with `USER_ENTERED`, so the incoming row's `=C5`/`=C4`
  move with it. Blank rows between entries are closed up on the first save.
- Row 8 must still read Project, Vendor, Date, Amount in B-E, or the page refuses to save (guards against layout edits).
