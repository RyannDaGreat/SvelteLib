#!/usr/bin/env bash
# Internal launcher for PowerRP's Vite app + project server (live HMR, no build).
#
# Canonical dump-facing command (from the SvelteLib root):
#   bash src/demo_apps/PowerRP/run_server.sh
#
# Probes two currently free ports: one for Vite and one for the project backend.
# This is best-effort discovery, not a reservation; --strictPort makes a rare
# concurrent-start collision fail loudly. Vite proxies /api and /asset so the
# printed app URL is the only URL to open.
set -euo pipefail
cd "$(dirname "$0")"

# Repo root (where package.json + node_modules live), relative to this script so
# the dump stays portable. The frontend deps resolve from here.
# server/ is src/demo_apps/PowerRP/server → repo root is four levels up.
ROOT="$(cd ../../../.. && pwd)"
WEB="$(cd ../web && pwd)"
WORKBENCH_TLS_CERT="/etc/certs/public_web.crt"
WORKBENCH_TLS_KEY="/etc/certs/public_web.key"
BACKEND_READY_ATTEMPTS=120
BACKEND_READY_SLEEP_SECONDS=0.5
CHILD_MONITOR_SLEEP_SECONDS=0.25

# HTTPS is OPT-IN; plain HTTP on 0.0.0.0 is the DEFAULT. The editor renders via
# Skia/CanvasKit on a WebGL2 context and uses no secure-context-only browser API
# (clipboard, UUID, and EyeDropper all have plain-HTTP fallbacks), so it works
# fully over plain HTTP from any origin — including a LAN/remote machine opening
# the box by IP. HTTPS previously auto-activated on a Workbench (BD_HOSTNAME +
# host cert) to satisfy WebGPU's secure-context requirement; that requirement is
# gone, so auto-HTTPS is retired to keep remote HTTP access frictionless.
#
# Two ways to turn HTTPS back on (neither is the default):
#   1. Explicit certs: set POWERRP_TLS_CERT + POWERRP_TLS_KEY + POWERRP_PUBLIC_HOST.
#   2. Workbench convenience: set POWERRP_USE_WORKBENCH_TLS=1 to reuse the host's
#      trusted cert (/etc/certs/public_web.*) + $BD_HOSTNAME.
TLS_CERT="${POWERRP_TLS_CERT:-}"
TLS_KEY="${POWERRP_TLS_KEY:-}"
PUBLIC_HOST="${POWERRP_PUBLIC_HOST:-}"
if [ -n "$TLS_CERT" ] || [ -n "$TLS_KEY" ] || [ -n "$PUBLIC_HOST" ]; then
  if [ -z "$TLS_CERT" ] || [ -z "$TLS_KEY" ] || [ -z "$PUBLIC_HOST" ]; then
    echo "ERROR: POWERRP_TLS_CERT, POWERRP_TLS_KEY, and POWERRP_PUBLIC_HOST must be set together." >&2
    exit 1
  fi
elif [ -n "${POWERRP_USE_WORKBENCH_TLS:-}" ]; then
  # Explicitly requested the Workbench cert — its absence is a loud error, never
  # a silent fall-through to HTTP (the user asked for HTTPS on purpose).
  if [ -z "${BD_HOSTNAME:-}" ] || [ ! -r "$WORKBENCH_TLS_CERT" ] || [ ! -r "$WORKBENCH_TLS_KEY" ]; then
    echo "ERROR: POWERRP_USE_WORKBENCH_TLS is set but the Workbench TLS is unavailable" >&2
    echo "       (need \$BD_HOSTNAME plus a readable $WORKBENCH_TLS_CERT and $WORKBENCH_TLS_KEY)." >&2
    exit 1
  fi
  TLS_CERT="$WORKBENCH_TLS_CERT"
  TLS_KEY="$WORKBENCH_TLS_KEY"
  PUBLIC_HOST="$BD_HOSTNAME"
fi
if [ -n "$TLS_CERT" ]; then
  if [ ! -r "$TLS_CERT" ] || [ ! -r "$TLS_KEY" ]; then
    echo "ERROR: PowerRP TLS certificate/key must both be readable." >&2
    exit 1
  fi
  TLS_CERT="$(cd -- "$(dirname -- "$TLS_CERT")" && pwd)/$(basename -- "$TLS_CERT")"
  TLS_KEY="$(cd -- "$(dirname -- "$TLS_KEY")" && pwd)/$(basename -- "$TLS_KEY")"
fi

# Frontend deps (vite, svelte, @sveltejs/vite-plugin-svelte): a fresh — OR
# PARTIAL — node_modules breaks Vite. Install non-interactively whenever the
# local vite binary OR the svelte plugin is missing (a half-populated
# node_modules left by an aborted `npx vite` is exactly what bit the annotator).
if [ ! -x "${ROOT}/node_modules/.bin/vite" ] \
   || [ ! -d "${ROOT}/node_modules/@sveltejs/vite-plugin-svelte" ]; then
  echo "Installing frontend deps (npm install in ${ROOT}) …"
  ( cd "${ROOT}" && npm install --no-fund --no-audit )
fi

read -r APP_PORT BACKEND_PORT < <(uv run server.py ports)
if [ -n "$TLS_CERT" ]; then
  export POWERRP_TLS_CERT="$TLS_CERT"
  export POWERRP_TLS_KEY="$TLS_KEY"
  export POWERRP_PUBLIC_HOST="$PUBLIC_HOST"
  export POWERRP_APP_PORT="$APP_PORT"
  APP_URL="https://${PUBLIC_HOST}:${APP_PORT}"
else
  unset POWERRP_TLS_CERT POWERRP_TLS_KEY POWERRP_PUBLIC_HOST POWERRP_APP_PORT
  APP_URL="http://localhost:${APP_PORT}"
fi

BACKEND_PID=""
VITE_PID=""

# Command. Terminates and reaps the two managed process groups on every exit.
cleanup_children() {
  status=$?
  trap - EXIT INT TERM
  for pid in "$VITE_PID" "$BACKEND_PID"; do
    if [ -n "$pid" ]; then
      kill -TERM -- "-$pid" 2>/dev/null || true
    fi
  done
  for pid in "$VITE_PID" "$BACKEND_PID"; do
    if [ -n "$pid" ]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
  exit "$status"
}

# Command. Converts Ctrl-C into the conventional shell interrupt status.
handle_interrupt() { exit 130; }

# Command. Converts SIGTERM into the conventional terminated status.
handle_terminate() { exit 143; }

# Monitor mode gives each background child its own process group. Killing the
# group also reaches uv's Python child and any Vite subprocesses.
set -m
trap cleanup_children EXIT
trap handle_interrupt INT
trap handle_terminate TERM

# APP_URL lets a direct backend visit redirect to the served app.
APP_URL="$APP_URL" uv run server.py serve --port="$BACKEND_PORT" &
BACKEND_PID=$!

printf 'Starting backend'
BACKEND_READY=0
for ((attempt = 1; attempt <= BACKEND_READY_ATTEMPTS; attempt++)); do
  if curl --fail --silent --output /dev/null \
      "http://localhost:${BACKEND_PORT}/api/projects/" 2>/dev/null; then
    BACKEND_READY=1
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    if wait "$BACKEND_PID"; then BACKEND_STATUS=1; else BACKEND_STATUS=$?; fi
    echo
    echo "ERROR: PowerRP backend exited before becoming ready." >&2
    exit "$BACKEND_STATUS"
  fi
  printf '.'
  sleep "$BACKEND_READY_SLEEP_SECONDS"
done
echo
if [ "$BACKEND_READY" -ne 1 ]; then
  echo "ERROR: PowerRP backend did not become ready within $((BACKEND_READY_ATTEMPTS / 2)) seconds." >&2
  exit 1
fi

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)
echo "=================================================="
echo "  PowerRP   (live / HMR + project server)"
if [ -n "$TLS_CERT" ]; then
  echo "    Secure: ${APP_URL}"
else
  echo "    Local:  ${APP_URL}"
  # Plain HTTP is fully supported (Skia/WebGL2 needs no secure context), so the
  # LAN/remote URLs below are FIRST-CLASS entry points — open either from any
  # other machine on the network by IP or by the box's hostname.
  [ -n "${LAN_IP:-}" ] && echo "    LAN:    http://${LAN_IP}:${APP_PORT}   (open from another machine by IP)"
  [ -n "${BD_HOSTNAME:-}" ] && echo "    Host:   http://${BD_HOSTNAME}:${APP_PORT}"
fi
echo "    (project backend on :${BACKEND_PORT} — don't open it directly)"
echo "=================================================="

# Frontend with HMR, exposed to the LAN, proxying /api + /asset to the backend.
cd "$WEB"
BACKEND_URL="http://localhost:${BACKEND_PORT}" \
  "${ROOT}/node_modules/.bin/vite" dev --port "${APP_PORT}" --strictPort &
VITE_PID=$!

while true; do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    if wait "$BACKEND_PID"; then BACKEND_STATUS=1; else BACKEND_STATUS=$?; fi
    echo "ERROR: PowerRP backend exited while Vite was running." >&2
    exit "$BACKEND_STATUS"
  fi
  if ! kill -0 "$VITE_PID" 2>/dev/null; then
    if wait "$VITE_PID"; then VITE_STATUS=0; else VITE_STATUS=$?; fi
    exit "$VITE_STATUS"
  fi
  sleep "$CHILD_MONITOR_SLEEP_SECONDS"
done
