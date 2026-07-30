#!/usr/bin/env bash
# Command. FIRST-RUN SMOKE TEST of the BUILT app — the permanent guard the
# v0.2.0 boot failure demanded ("if we upgrade it again, it shouldn't break
# again"): CI runs this between packaging and publishing, so a release that
# cannot BOOT on a fresh machine never ships. Also runnable locally.
#
#   bash smoke_test.sh [path/to/PowerRP.app]   (default: dist/mac-arm64/PowerRP.app)
#
# Launches the app binary with a CDP port against a THROWAWAY HOME (so first-run
# setup runs from nothing, like a user's machine), waits for the editor page to
# come up INSIDE the shell, asserts HTTP 200 on its URL, quits, and asserts the
# whole spawned server tree died with it.
set -euo pipefail
cd "$(dirname "$0")"
APP="${1:-dist/mac-arm64/PowerRP.app}"
BIN="$APP/Contents/MacOS/PowerRP"
[ -x "$BIN" ] || { echo "SMOKE FAIL: no binary at $BIN" >&2; exit 1; }

CDP_PORT=9777
# First run = cp -R + npm ci (registry download on a cold runner) + uv python
# bootstrap; generous but bounded.
BOOT_TIMEOUT_S=900
FAKE_HOME=$(mktemp -d)
echo "smoke: throwaway HOME=$FAKE_HOME"
# Pre-existing server processes (a dev machine's own stack) are NOT ours to
# judge — only pids that APPEAR during this run may count as orphans.
BEFORE_PIDS=$(pgrep -f 'start_server.sh|server.py serve|vite dev' || true)

HOME="$FAKE_HOME" "$BIN" --remote-debugging-port=$CDP_PORT &
APP_PID=$!
cleanup() { kill "$APP_PID" 2>/dev/null || true; rm -rf "$FAKE_HOME"; }
trap cleanup EXIT

URL=""
for ((i = 0; i < BOOT_TIMEOUT_S; i++)); do
  kill -0 "$APP_PID" 2>/dev/null || { echo "SMOKE FAIL: app exited before booting (see its error dialog / setup.log)" >&2; exit 1; }
  URL=$(curl -fs "http://127.0.0.1:$CDP_PORT/json/list" 2>/dev/null | /usr/bin/python3 -c 'import json,sys
try:
  for t in json.load(sys.stdin):
    u = t.get("url", "")
    if u.startswith("http://localhost:"):
      print(u); break
except Exception: pass' || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "SMOKE FAIL: editor page never appeared within ${BOOT_TIMEOUT_S}s" >&2; exit 1; }
echo "smoke: editor booted at $URL"
curl -fso /dev/null "$URL" || { echo "SMOKE FAIL: editor URL not answering 200" >&2; exit 1; }

kill -TERM "$APP_PID"
for ((i = 0; i < 30; i++)); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 1; done
kill -0 "$APP_PID" 2>/dev/null && { echo "SMOKE FAIL: app did not exit on SIGTERM" >&2; exit 1; }
sleep 2
AFTER_PIDS=$(pgrep -f 'start_server.sh|server.py serve|vite dev' || true)
LEFT=$(comm -13 <(echo "$BEFORE_PIDS" | sort) <(echo "$AFTER_PIDS" | sort) | tr -d ' ')
[ -z "$LEFT" ] || { echo "SMOKE FAIL: orphaned server processes after quit (new since launch): $LEFT" >&2; exit 1; }
echo "SMOKE PASS: cold boot + clean teardown"
