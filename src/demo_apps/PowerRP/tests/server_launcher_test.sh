#!/usr/bin/env bash
# End-to-end lifecycle test for the canonical PowerRP server launcher.
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd -- "${APP_DIR}/../../.." && pwd)"
LOG_DIR="${REPO_ROOT}/.claude_logs"
TERM_LOG="${LOG_DIR}/server_launcher_term.log"
BACKEND_DEATH_LOG="${LOG_DIR}/server_launcher_backend_death.log"
INVALID_TLS_LOG="${LOG_DIR}/server_launcher_invalid_tls.log"
API_BODY_FILE="${LOG_DIR}/server_launcher_api.json"
PROJECTS_DIR="${LOG_DIR}/server_launcher_projects"
STARTUP_ATTEMPTS=120
STARTUP_POLL_SECONDS=0.25
SHUTDOWN_ATTEMPTS=40
SHUTDOWN_POLL_SECONDS=0.1

mkdir -p "$LOG_DIR" "$PROJECTS_DIR"
LAUNCHER_PID=""
CURRENT_LOG="$TERM_LOG"
APP_URL=""
BACKEND_PORT=""
LAUNCHER_STATUS=0

# Command. Reports a failed assertion with the captured launcher output.
fail() {
  printf 'SERVER LAUNCHER TEST FAILED: %s\n' "$1" >&2
  if [ -f "$CURRENT_LOG" ]; then
    printf '%s\n' '--- launcher log ---' >&2
    tail -n 80 "$CURRENT_LOG" >&2
  fi
  exit 1
}

# Command. Terminates a still-running test launcher after any test failure.
cleanup_test_launcher() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$LAUNCHER_PID" ] && kill -0 "$LAUNCHER_PID" 2>/dev/null; then
    kill -TERM "$LAUNCHER_PID" 2>/dev/null || true
    wait "$LAUNCHER_PID" 2>/dev/null || true
  fi
  exit "$status"
}

# Command. Starts one isolated localhost launcher and records its PID/log.
start_test_launcher() {
  CURRENT_LOG="$1"
  : >"$CURRENT_LOG"
  (
    cd "$REPO_ROOT"
    exec env -u BD_HOSTNAME \
      -u POWERRP_TLS_CERT \
      -u POWERRP_TLS_KEY \
      -u POWERRP_PUBLIC_HOST \
      NO_OPEN=1 \
      POWERRP_PROJECTS_DIR="$PROJECTS_DIR" \
      bash "$APP_DIR/run_server.sh"
  ) >"$CURRENT_LOG" 2>&1 &
  LAUNCHER_PID=$!
}

# Command. Waits for the real HTML app and JSON API, setting their addresses.
wait_for_test_ready() {
  APP_URL=""
  BACKEND_PORT=""
  for ((attempt = 1; attempt <= STARTUP_ATTEMPTS; attempt++)); do
    if ! kill -0 "$LAUNCHER_PID" 2>/dev/null; then
      fail "launcher exited before readiness"
    fi
    APP_URL="$(awk '$1 == "Local:" {url=$2} END {print url}' "$CURRENT_LOG")"
    APP_URL="${APP_URL%/}"
    BACKEND_PORT="$(awk -F: '/project backend on/ {split($2, fields, " "); port=fields[1]} END {print port}' "$CURRENT_LOG")"
    API_CONTENT_TYPE=""
    if [ -n "$APP_URL" ] && [ -n "$BACKEND_PORT" ]; then
      API_CONTENT_TYPE="$(curl --fail --silent --output "$API_BODY_FILE" \
        --write-out '%{content_type}' "${APP_URL}/api/projects/" 2>/dev/null || true)"
      if curl --fail --silent --output /dev/null "$APP_URL" \
         && [[ "$API_CONTENT_TYPE" == application/json* ]] \
         && grep --quiet '^\[' "$API_BODY_FILE"; then
        return
      fi
    fi
    sleep "$STARTUP_POLL_SECONDS"
  done
  fail "launcher did not expose a real HTML app and JSON API"
}

# Command. Waits for the launcher to exit and records its actual status.
wait_for_launcher_exit() {
  for ((attempt = 1; attempt <= SHUTDOWN_ATTEMPTS; attempt++)); do
    if ! kill -0 "$LAUNCHER_PID" 2>/dev/null; then
      break
    fi
    sleep "$SHUTDOWN_POLL_SECONDS"
  done
  if kill -0 "$LAUNCHER_PID" 2>/dev/null; then
    fail "launcher remained alive after its managed child stopped"
  fi
  if wait "$LAUNCHER_PID"; then LAUNCHER_STATUS=0; else LAUNCHER_STATUS=$?; fi
  LAUNCHER_PID=""
}

# Command. Proves both managed service ports are closed after launcher exit.
assert_service_ports_closed() {
  if curl --fail --silent --output /dev/null "$APP_URL" 2>/dev/null; then
    fail "Vite port remained reachable after launcher exit"
  fi
  if curl --fail --silent --output /dev/null \
      "http://localhost:${BACKEND_PORT}/api/projects/" 2>/dev/null; then
    fail "backend port remained reachable after launcher exit"
  fi
}

trap cleanup_test_launcher EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_test_launcher "$TERM_LOG"
wait_for_test_ready
kill -TERM "$LAUNCHER_PID"
wait_for_launcher_exit
[ "$LAUNCHER_STATUS" -eq 143 ] \
  || fail "SIGTERM exit status was ${LAUNCHER_STATUS}, expected 143"
assert_service_ports_closed

start_test_launcher "$BACKEND_DEATH_LOG"
wait_for_test_ready
BACKEND_LEADER="$(pgrep -o -P "$LAUNCHER_PID" -f 'uv run server.py serve')"
[ -n "$BACKEND_LEADER" ] || fail "could not identify the managed uv backend"
kill -KILL "$BACKEND_LEADER"
wait_for_launcher_exit
[ "$LAUNCHER_STATUS" -ne 0 ] \
  || fail "backend death produced a successful launcher exit"
assert_service_ports_closed

CURRENT_LOG="$INVALID_TLS_LOG"
if env -u BD_HOSTNAME \
    -u POWERRP_TLS_CERT \
    -u POWERRP_TLS_KEY \
    POWERRP_PUBLIC_HOST=invalid.example \
    bash "$APP_DIR/run_server.sh" >"$INVALID_TLS_LOG" 2>&1; then
  fail "hostname-only TLS override unexpectedly succeeded"
fi
grep --quiet "must be set together" "$INVALID_TLS_LOG" \
  || fail "invalid TLS override did not report the expected error"

printf '%s\n' "PowerRP server launcher: PASS"
