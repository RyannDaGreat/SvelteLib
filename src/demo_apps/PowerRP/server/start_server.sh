#!/usr/bin/env bash
# Run PowerRP with its project server (personal dev tool — live HMR, no build).
#
#   ./start_server.sh
#
# Picks two free ports (via rp.get_next_free_ports, so concurrent runs never
# collide): one for the Vite dev server (the app — HMR, exposed to the LAN) and
# one for the Python project-storage backend. Vite proxies /api and /asset to
# the backend, so http://<host>:<APP_PORT> is the single URL to open — and it
# auto-opens. Open the APP url, not the backend (which 302-redirects to it too).
set -euo pipefail
cd "$(dirname "$0")"

# Repo root (where package.json + node_modules live), relative to this script so
# the dump stays portable. The frontend deps resolve from here.
# server/ is src/demo_apps/PowerRP/server → repo root is four levels up.
ROOT="$(cd ../../../.. && pwd)"
WEB="$(cd ../web && pwd)"

read -r APP_PORT BACKEND_PORT < <(uv run server.py ports)
APP_URL="http://localhost:${APP_PORT}"

# Backend in the background; clean it up when Vite exits. APP_URL lets the
# backend redirect a stray browser hit straight to the app.
APP_URL="$APP_URL" uv run server.py serve --port="$BACKEND_PORT" &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT INT TERM

printf 'Starting backend (first run resolves deps, ~15s)'
until curl -s -o /dev/null "http://localhost:${BACKEND_PORT}/api/projects/" 2>/dev/null; do
  printf '.'; sleep 0.5
done
echo

# Frontend deps (vite, svelte, @sveltejs/vite-plugin-svelte): a fresh — OR
# PARTIAL — node_modules breaks Vite. Install non-interactively whenever the
# local vite binary OR the svelte plugin is missing (a half-populated
# node_modules left by an aborted `npx vite` is exactly what bit the annotator).
if [ ! -x "${ROOT}/node_modules/.bin/vite" ] \
   || [ ! -d "${ROOT}/node_modules/@sveltejs/vite-plugin-svelte" ]; then
  echo "Installing frontend deps (npm install in ${ROOT}) …"
  ( cd "${ROOT}" && npm install --no-fund --no-audit )
fi

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)
echo "=================================================="
echo "  PowerRP   (live / HMR + project server)"
echo "    Local:  ${APP_URL}"
[ -n "${LAN_IP:-}" ] && echo "    LAN:    http://${LAN_IP}:${APP_PORT}"
echo "    (project backend on :${BACKEND_PORT} — don't open it directly)"
echo "=================================================="

# Frontend with HMR, exposed to the LAN, proxying /api + /asset to the backend.
cd "$WEB"
BACKEND_URL="http://localhost:${BACKEND_PORT}" "${ROOT}/node_modules/.bin/vite" dev --port "${APP_PORT}" --strictPort
