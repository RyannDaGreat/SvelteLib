#!/usr/bin/env bash
# Run the Video Slice Annotator (personal dev tool — live HMR, no build step).
#
#   ./start_server.sh                          # default videos dir
#   ./start_server.sh --videos_dir=/my/clips   # any flat folder of .mp4
#
# Picks two free ports (via rp.get_next_free_ports, so concurrent runs never
# collide): one for the Vite dev server (the app — HMR, exposed to the LAN) and
# one for the Python API/media backend. Vite proxies /api,/video,/lowres,/frame
# to the backend, so http://<host>:<APP_PORT> is the single URL to open — and it
# auto-opens. Open the APP url, not the backend (which 302-redirects to it too).
set -euo pipefail
cd "$(dirname "$0")"

# Repo root (where package.json + node_modules live), relative to this script so
# the dump stays portable. The frontend deps resolve from here.
ROOT="$(cd ../../.. && pwd)"

read -r APP_PORT BACKEND_PORT < <(uv run server.py ports)
APP_URL="http://localhost:${APP_PORT}"

# Backend in the background; clean it up when Vite exits. APP_URL lets the
# backend redirect a stray browser hit straight to the app.
APP_URL="$APP_URL" uv run server.py serve --port="$BACKEND_PORT" "$@" &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT INT TERM

printf 'Starting backend (first run resolves deps, ~15s)'
until curl -s -o /dev/null "http://localhost:${BACKEND_PORT}/api/videos" 2>/dev/null; do
  printf '.'; sleep 0.5
done
echo

# Frontend deps (vite, svelte, vite-plugin-svelte): on a fresh machine there's no
# node_modules. Install non-interactively (no npx "Ok to proceed?" prompt) BEFORE
# we advertise the URL, then run the LOCAL vite binary so it never prompts again.
if [ ! -x "${ROOT}/node_modules/.bin/vite" ]; then
  echo "Installing frontend deps (first run on this machine)…"
  npm install --prefix "${ROOT}" --no-fund --no-audit
fi

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)
echo "=================================================="
echo "  Video Slice Annotator   (live / HMR)"
echo "    Local:  ${APP_URL}"
[ -n "${LAN_IP:-}" ] && echo "    LAN:    http://${LAN_IP}:${APP_PORT}"
echo "    (API backend on :${BACKEND_PORT} — don't open it directly)"
echo "=================================================="

# Frontend with HMR, exposed to the LAN, proxying API/media to the backend.
cd web
BACKEND_URL="http://localhost:${BACKEND_PORT}" "${ROOT}/node_modules/.bin/vite" dev --port "${APP_PORT}" --strictPort
