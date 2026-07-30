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
# Self-signed TLS cache for the opt-in HTTPS mode (see below). Gitignored; delete
# it to force regeneration after a network/IP change.
TLS_DIR="$(pwd)/.tls"
TLS_CERT_DAYS=825          # widely-accepted maximum validity for a self-signed leaf
TLS_KEY_BITS=2048
BACKEND_READY_ATTEMPTS=120
BACKEND_READY_SLEEP_SECONDS=0.5
CHILD_MONITOR_SLEEP_SECONDS=0.25

# Best-effort LAN address (first non-loopback IPv4). Used for the printed remote
# URL and, in HTTPS mode, for the certificate's subjectAltName so another machine
# can open the app by IP over a secure context.
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)

# HTTPS is OPT-IN; plain HTTP on 0.0.0.0 is the DEFAULT. The editor renders via
# Skia/CanvasKit on a WebGL2 context and uses no secure-context-only browser API
# (clipboard, UUID, and EyeDropper all have plain-HTTP fallbacks), so it works
# fully over plain HTTP from any origin — including a LAN/remote machine opening
# the box by IP. Keeping HTTP the default keeps remote access frictionless.
#
# Turn HTTPS on when you need a SECURE CONTEXT — e.g. WebGPU (navigator.gpu),
# which the browser exposes only over HTTPS or on localhost. Two portable ways:
#   1. Auto self-signed: POWERRP_HTTPS=1 (or pass --https). openssl mints a local
#      self-signed cert covering localhost + this machine's LAN IP/hostname,
#      cached in .tls/. The browser shows a one-time "not private" warning;
#      accept it and the origin becomes a secure context.
#   2. Bring your own trusted cert: set POWERRP_TLS_CERT + POWERRP_TLS_KEY +
#      POWERRP_PUBLIC_HOST together (no browser warning).
WANT_HTTPS="${POWERRP_HTTPS:-}"
for arg in "$@"; do
  [ "$arg" = "--https" ] && WANT_HTTPS=1
done

# Command. Mints (once, cached in TLS_DIR) a portable self-signed cert+key whose
# subjectAltName covers localhost, 127.0.0.1, and — when discoverable — this
# machine's LAN IP and hostname, then points TLS_CERT/TLS_KEY/PUBLIC_HOST at it.
# Regenerates only when the cached cert is missing, unreadable, or expired (delete
# TLS_DIR after a network change to refresh the SAN). Fails LOUDLY if openssl is
# absent or generation fails — it never silently degrades to plain HTTP.
generate_self_signed_tls() {
  if ! command -v openssl >/dev/null 2>&1; then
    echo "ERROR: HTTPS was requested but 'openssl' is not installed." >&2
    exit 1
  fi
  mkdir -p "$TLS_DIR"
  local cert="$TLS_DIR/dev.crt"
  local key="$TLS_DIR/dev.key"
  if [ ! -r "$cert" ] || [ ! -r "$key" ] \
     || ! openssl x509 -checkend 0 -noout -in "$cert" >/dev/null 2>&1; then
    local san="DNS:localhost,IP:127.0.0.1"
    [ -n "${LAN_IP:-}" ] && san="${san},IP:${LAN_IP}"
    local host_name; host_name="$(hostname 2>/dev/null || true)"
    [ -n "$host_name" ] && san="${san},DNS:${host_name}"
    if ! openssl req -x509 -newkey "rsa:${TLS_KEY_BITS}" -nodes \
        -keyout "$key" -out "$cert" -days "$TLS_CERT_DAYS" \
        -subj "/CN=localhost" -addext "subjectAltName=${san}" >/dev/null; then
      echo "ERROR: openssl failed to generate a self-signed certificate." >&2
      exit 1
    fi
  fi
  TLS_CERT="$cert"
  TLS_KEY="$key"
  PUBLIC_HOST="${LAN_IP:-localhost}"
}

TLS_CERT="${POWERRP_TLS_CERT:-}"
TLS_KEY="${POWERRP_TLS_KEY:-}"
PUBLIC_HOST="${POWERRP_PUBLIC_HOST:-}"
if [ -n "$TLS_CERT" ] || [ -n "$TLS_KEY" ] || [ -n "$PUBLIC_HOST" ]; then
  if [ -z "$TLS_CERT" ] || [ -z "$TLS_KEY" ] || [ -z "$PUBLIC_HOST" ]; then
    echo "ERROR: POWERRP_TLS_CERT, POWERRP_TLS_KEY, and POWERRP_PUBLIC_HOST must be set together." >&2
    exit 1
  fi
elif [ -n "$WANT_HTTPS" ]; then
  generate_self_signed_tls
fi
if [ -n "$TLS_CERT" ]; then
  if [ ! -r "$TLS_CERT" ] || [ ! -r "$TLS_KEY" ]; then
    echo "ERROR: PowerRP TLS certificate/key must both be readable." >&2
    exit 1
  fi
  TLS_CERT="$(cd -- "$(dirname -- "$TLS_CERT")" && pwd)/$(basename -- "$TLS_CERT")"
  TLS_KEY="$(cd -- "$(dirname -- "$TLS_KEY")" && pwd)/$(basename -- "$TLS_KEY")"
fi

# Frontend deps: a fresh — OR PARTIAL, OR STALE — node_modules breaks Vite with
# per-module "Failed to resolve import" errors. This has bitten twice: a
# half-populated node_modules from an aborted `npx vite` (the annotator), and a
# node_modules predating six newer package.json deps (qrcode/monaco/canvaskit/…,
# 2026-07-29). A two-package spot check missed the second one, so the gate is now
# exhaustive: EVERY package.json dependency must be installed, plus the vite
# binary itself. Any gap → announce it and npm install non-interactively.
MISSING_DEPS="$(cd "${ROOT}" && node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const missing = deps.filter((d) => !fs.existsSync(`node_modules/${d}/package.json`));
  process.stdout.write(missing.join(" "));
')"
if [ ! -x "${ROOT}/node_modules/.bin/vite" ] || [ -n "$MISSING_DEPS" ]; then
  [ -n "$MISSING_DEPS" ] && echo "node_modules is missing: ${MISSING_DEPS}"
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

echo "=================================================="
echo "  PowerRP   (live / HMR + project server)"
if [ -n "$TLS_CERT" ]; then
  echo "    Secure: ${APP_URL}"
  [ "$PUBLIC_HOST" != "localhost" ] && echo "            https://localhost:${APP_PORT}"
  echo "    (self-signed → accept the browser's one-time warning; enables WebGPU)"
else
  echo "    Local:  ${APP_URL}"
  # Plain HTTP is fully supported (Skia/WebGL2 needs no secure context), so the
  # LAN URL below is a FIRST-CLASS entry point — open it from any other machine
  # on the network by IP.
  [ -n "${LAN_IP:-}" ] && echo "    LAN:    http://${LAN_IP}:${APP_PORT}   (open from another machine by IP)"
fi
echo "    (project backend on :${BACKEND_PORT} — don't open it directly)"
echo "=================================================="

# Open the app in the DEFAULT browser (vite's own opener is disabled in
# vite.config.js — its macOS AppleScript preferred any RUNNING Chrome over the
# actual default). `open`/xdg-open ask the OS, which answers with the browser
# the user chose. NO_OPEN suppresses (the Electron shell shows its own window).
if [ -z "${NO_OPEN:-}" ]; then
  ( sleep 2  # give vite a beat to start listening; a too-early open shows a connection error
    case "$(uname -s)" in
      Darwin) open "$APP_URL" ;;
      *) command -v xdg-open >/dev/null && xdg-open "$APP_URL" ;;
    esac ) &
fi

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
