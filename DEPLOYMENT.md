# GitHub Pages + Render

These files prepare deployment; no service has been created or published.
The repository root must be the Torfilms directory (package.json and render.yaml).

## Backend on Render

Create a Blueprint from `render.yaml`. It uses Render's **free** web service;
there is no persistent disk and Docker installs FFmpeg. HTTP and WebSockets share
Render's PORT. Health: `/healthz`.
Set `TORFILMS_ALLOWED_ORIGINS=https://YOUR-ACCOUNT.github.io` (origin only, no
repository path or trailing slash). Multiple exact origins are comma-separated.
For a custom domain, use that domain instead. Never use `*`.

Set `DATABASE_URL` to the pooled connection string from a free Neon Postgres
project. The backend creates the `torfilms_catalog` table automatically. The
catalog, magnet links, `.torrent` metadata and editorial changes then survive
Render restarts; video pieces and RAM caches never enter the database.
The image deliberately excludes local data, private tracker credentials, TLS
keys, logs and environment files. Do not commit these to GitHub.
`TORFILMS_CATALOG_READONLY=1` prevents public catalog edits. CORS is not user
authentication: do not disable read-only mode on a public deployment without
adding authentication. Streaming endpoints are public and can consume bandwidth;
configure upstream access/rate limits before opening to a large audience.

Defaults: one torrent worker, 128 MB piece cache, native server WebRTC disabled.
Browsers receive original verified pieces over HTTPS and can share with other
WebRTC viewers. Render exposes a public HTTP/WebSocket port, not arbitrary inbound
TCP/UDP torrent ports. NAT, outbound connectivity, seed availability and hosting
policies still affect peer connectivity; this is not a guarantee of full hybrid
connectivity or high-bitrate playback. Increase RAM/worker limits only after
measuring total memory including Node and FFmpeg. Do not scale multiple replicas
without shared catalog/state and sticky torrent routing.

## Frontend on GitHub Pages

In repository Settings → Pages select GitHub Actions. Add repository variables:

- `TORFILMS_BACKEND_URL`: actual HTTPS origin, e.g. `https://YOUR-SERVICE.onrender.com`.
- `TORFILMS_PAGES_BASE`: `/YOUR-REPOSITORY/`; use `/` for a user site/custom domain.

Run **Publish frontend to GitHub Pages** manually in Actions. The workflow is
manual-only and publishes only `dist-pages`, never the project data directory.
Equivalent local build: set those two environment variables, then run
`npm ci --ignore-scripts`, `npm run build:p2p`, `npm run build:pages`.

## Importing the current home catalog

Create the Neon project, copy its pooled `DATABASE_URL` into the environment,
then run from the Torfilms directory:

```powershell
$env:DATABASE_URL = 'postgresql://...'
npm run migrate:catalog
```

The migration reads the existing local `data/catalog.json`; it does not upload
video files. Do not put `DATABASE_URL` in GitHub, `render.yaml`, or a frontend
configuration file.
The build changes only dist-pages, not the running home application's config.

Pages uses URLs like `/YOUR-REPOSITORY/?film=tt2359704&season=1`, so refreshing or
opening a shared IMDb link does not require a server rewrite/404 workaround.
Service Worker, workers and static assets remain on the frontend origin. APIs,
subtitle requests, HTTP pieces and server media streams use backendUrl; trackers
use the corresponding ws/wss URL. Viewer cookies remain on the frontend origin
and do not migrate automatically from the home address.

## Existing home installation

`public/p2p/runtime-config.js` defaults to an empty backendUrl: requests remain
same-origin, existing /film/tt… links continue working. To split a different static
frontend manually, edit this public configuration's backendUrl and configure
the backend allowlist. No secret belongs in this file.
Server-side CORS changes require a normal restart of the home Node services;
this implementation does not restart the active player or supervisor.

## Free home bridge through Cloudflare Quick Tunnel

When a permanent domain is not available, the home bridge can be exposed for
testing without opening router ports or configuring a DNS zone. `cloudflared`
is kept outside Git in `.runtime/` and the helper downloads the current Windows
binary on first run:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-cloudflare-quick-tunnel.ps1
```

The script maps the public temporary HTTPS address to
`http://127.0.0.1:18183`. Keep the window open, copy the printed
`trycloudflare.com` URL into the GitHub Actions variable
`TORFILMS_BACKEND_URL`, then run the Pages workflow manually. The temporary
address changes after the tunnel restarts. Quick Tunnels are for testing, not
production; a stable hostname requires a Cloudflare-managed domain and a named
tunnel. The home PC and its upload bandwidth remain the streaming origin.

## Verification before publication

Run `npm test`. Check actual Pages → Render OPTIONS, catalog loading, Range 206,
tracker WebSocket, original MKV, external audio, subtitles and mobile seek.
Cloud deployment and Android cross-origin playback have not been tested here.

Official platform documentation:
- https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- https://render.com/docs/web-services
- https://render.com/docs/websocket
