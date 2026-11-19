# C&L Builders payment waterfall (clbuilders.vxvconsulting.com)

Mobile scenario planner for C&L's vendor payments. It reads the Google Sheet ("Payment Waterfall" tab of
`10CaKKiAvTHZ7NN9mC3DY1eZlINsZ7POAdtQhDPk3nHY`) and lets Chris try different payment orders with ▲/▼, with a
chart of the bank balance after each payment, compared against the sheet's own order.

**It never writes to the sheet.** The service account only gets read access, and the order being tried lives in the
browser (kept for that tab's session while the sheet is unchanged). The real order and amounts are still edited in
the sheet.

## Why a subdomain, not vxvconsulting.com/clbuilders
vxvconsulting.com is static GitHub Pages with DNS at Porkbun, so nothing can check a password on the server at a
path there. The app runs as a Cloudflare Pages project on `clbuilders.vxvconsulting.com` instead.
`vxvconsulting.com/clbuilders/` (in the main site) just forwards there and holds no data.
(A true subpath would need the domain's DNS moved to Cloudflare; not worth it for this.)

This folder starts with `_`, so GitHub Pages (Jekyll) does not publish it on vxvconsulting.com.

## Files
- `public/_worker.js`: every request goes through it: login, signed cookie, `/api/data`.
- `public/login.html`, `public/app.html`, `public/app.js`: served only through the worker (app only when signed in).
  The chart is plain SVG drawn in `app.js` (no chart library).
- `src/sheet.js`: sheet layout and parsing. `src/auth.js`: password, cookie, rate limit. `src/google.js`: read-only Sheets API.
- `test/sheet.test.js`: `npm test`.

## How it works
- Password: `SITE_PASSWORD` (or `SITE_PASSWORD_SHA256`) env var, compared as SHA-256 digests in constant time.
  Success sets `__Host-clb_session`: HMAC-signed with `SESSION_SECRET`, HttpOnly, Secure, SameSite=Strict, 4 days
  (`SESSION_DAYS`). Changing the password or the secret signs everyone out.
- Wrong guesses: 5 per IP per 15 minutes, then locked out for the rest of the window. Uses the `RATE_LIMIT` KV
  namespace if bound (recommended), otherwise per-instance memory.
- Every response: `X-Robots-Tag: noindex`, `robots.txt` disallows all, strict CSP, no caching.
- Rows B9:E48 and inputs C3:C5 are read; blank rows are skipped. The incoming payment row is the one whose Amount is
  `=C4` (or whose Vendor is "Pending client payment"). The page recomputes running balances and the summary itself.
- Row 8 must still read Project, Vendor, Date, Amount in B-E, or the page shows an error instead of misreading rows.
