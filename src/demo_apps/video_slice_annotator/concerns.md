# Concerns / bug log — Video Slice Annotator

Append-only historical record of bugs and how they were found/fixed.

## 2026-06-23 — Blank white screen (the app shell collapsed)

**Symptom:** App served, HintBar visible, but the rest was blank. DOM had the
20 thumbnails, yet `<html>/<body>/#app` measured only ~26px tall (the HintBar
height), so the split panes got 0 height.

**Root cause:** When all app CSS was centralized into `web/app.css`, the rewrite
**dropped the `html, body, #app { height: 100% }` reset** that the original
inline version had. Without it, `#app` (a flex column) shrank to content height,
the `flex:1` main area got 0px, and everything inside the splits was invisible.

**Fix:** Re-added the viewport-fill reset (`html,body,#app{height:100%}; #app{display:flex}`)
to `app.css`. Lesson: when centralizing CSS, audit for global resets, not just
component rules.

## 2026-06-23 — "MIME type text/html" / api.js served as HTML

**Symptom:** `Failed to load module script: Expected JavaScript … got text/html`.
Intermittent; the app's own `/api.js` came back as `text/html`.

**Root cause:** The Vite dev proxy keys were bare prefixes — `/api`, `/video`,
`/lowres`, `/frame`. The prefix **`/api` also matches the app's own module file
`/api.js`**, so Vite proxied that JS file to the Python backend, which answered
with its HTML hint page → wrong MIME → module load failure. Port collisions from
leftover test processes made it look intermittent.

**Fix:** Require a trailing slash in the proxy keys (`/api/`, `/video/`, …). All
real API calls use the `/api/…` form; `/api.js` no longer matches.

**Why tests missed both:** the frontend was being tested through the *root* Vite
dev server (no proxy, absolute backend URL), not the real `start_server.sh`
stack (app-Vite + proxy + Python backend). The bugs only manifest on the real
serving path. Lesson: test the actual deployment path, end to end, with the VLM.

## 2026-06-23 — base:"./" broke dev module URLs

`base: "./"` (meant for static builds) mangled dev module URLs so `main.js` fell
back to HTML. Removed it (Vite dev uses base `/`).

## 2026-06-23 — Port collisions

Hardcoded ports collided across concurrent runs. Switched to dynamic free ports
via `rp.get_next_free_ports` (the `ports` Fire subcommand; start_server.sh reads
two free ports and wires Vite + backend + proxy to them).
