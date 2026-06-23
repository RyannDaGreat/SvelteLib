#!/usr/bin/env bash
# Start the Video Slice Annotator backend.
# uv reads the PEP-723 inline deps at the top of server.py (rp, fire) and runs
# in an isolated, cached environment — no manual venv/pip needed.
#
# Usage:
#   ./start_server.sh                         # default videos dir + port 8000
#   ./start_server.sh --videos_dir=/my/clips  # point at any flat folder of .mp4
#   ./start_server.sh --port=9000
set -euo pipefail
cd "$(dirname "$0")"
exec uv run server.py serve "$@"
