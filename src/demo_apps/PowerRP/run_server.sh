#!/usr/bin/env bash
# Canonical dump-portable launcher for the Vite app and project backend.
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${APP_DIR}/server/start_server.sh" "$@"
