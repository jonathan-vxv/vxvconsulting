# Setup: manual steps

Commands run in PowerShell from this folder (`_apps\clbuilders`); `cd` there first. Use `npm.cmd` / `npx.cmd`:
plain `npm` is blocked by PowerShell's default script policy.

## 1. Google service account
1. https://console.cloud.google.com, signed in as jcrabtree.consulting@gmail.com (the sheet's owner). Use the
   existing "VXV Dashboard" project or a new one. APIs & Services -> Library -> **Google Sheets API** -> Enable.
2. IAM & Admin -> Service Accounts -> Create service account, name `clbuilders-waterfall`. Skip the optional
   role and access steps.
3. Open it -> Keys -> Add key -> Create new key -> JSON. A `.json` file downloads. Keep it private and out of the repo.
4. In the sheet: Share -> paste the account's `client_email` (from the JSON) -> **Viewer**. Untick "Notify people".
   Viewer is all it needs: the page is a planner and never writes to the sheet (it only asks Google for read access).

## 2. Test locally
```powershell
npm.cmd install
copy .env.example .env
```
Edit `.env`:
- `GOOGLE_SERVICE_ACCOUNT_JSON='…'`: the key file on one line, inside single quotes. Get the line with
  `node -e "console.log(JSON.stringify(require('C:/path/to/key.json')))"`.
- `SITE_PASSWORD=order`; `SESSION_SECRET=` 64 random characters
  (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
- `DEMO_DATA=0`.

Run `npm.cmd run dev`, open http://localhost:8788 and sign in with `order`. Check the starting balance, incoming
payment, summary and every row against the sheet, then try a few moves and watch the chart. Wrangler reads `.env`
only when it starts, so after editing `.env` restart it (Ctrl+C, then `npm.cmd run dev`).

No credentials yet? `DEMO_DATA=1` runs the page on built-in sample rows.

## 3. Cloudflare Pages project (same Cloudflare account as the dashboard Worker)
```powershell
npx.cmd wrangler login
npx.cmd wrangler pages project create vxv-clbuilders --production-branch main
npx.cmd wrangler kv namespace create clbuilders-rate-limit
```
Paste the printed KV `id` into `wrangler.toml` and uncomment the `[[kv_namespaces]]` block.
Set the secrets (each command prompts for the value; for the key, pipe the file in):
```powershell
Get-Content C:\path\to\key.json -Raw | npx.cmd wrangler pages secret put GOOGLE_SERVICE_ACCOUNT_JSON --project-name vxv-clbuilders
npx.cmd wrangler pages secret put SHEET_ID --project-name vxv-clbuilders
npx.cmd wrangler pages secret put SITE_PASSWORD --project-name vxv-clbuilders
npx.cmd wrangler pages secret put SESSION_SECRET --project-name vxv-clbuilders
```
Leave `DEMO_DATA` unset in production. Deploy:
```powershell
npm.cmd run deploy
```
Try it at https://vxv-clbuilders.pages.dev.

## 4. Subdomain (DNS stays at Porkbun)
1. Cloudflare dashboard -> Workers & Pages -> vxv-clbuilders -> Custom domains -> Set up a custom domain ->
   `clbuilders.vxvconsulting.com`.
2. Porkbun -> vxvconsulting.com -> DNS -> add a record: type **CNAME**, host `clbuilders`, answer
   `vxv-clbuilders.pages.dev`.
3. Wait until Cloudflare shows the domain as Active (minutes, sometimes an hour). Cloudflare issues the certificate.

## 5. Main site
Merge branch `clbuilders-waterfall` into `main` and push. That adds `vxvconsulting.com/clbuilders/`, which forwards to
the subdomain. The `_apps` folder is not published by GitHub Pages.

## Changing the password later
`npx.cmd wrangler pages secret put SITE_PASSWORD --project-name vxv-clbuilders`, then `npm.cmd run deploy` (Pages applies
changed secrets on the next deployment). Everyone currently signed in is signed out.
