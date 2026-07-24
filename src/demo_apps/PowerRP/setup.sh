#!/usr/bin/env bash
# PowerRP system-dependency setup — idempotent, safe to re-run.
#
# The project server (server/server.py) shells out to ffmpeg/ffprobe for BOTH
# directions of video work:
#   - EXTRACT: pulling filmstrip frames out of a project video (the /api/frames route);
#   - ENCODE:  turning the client's rendered PNG frames into an H.264 MP4 (the
#              /api/export-mp4 routes — server-side MP4 export, so it works on
#              plain HTTP where the browser's WebCodecs VideoEncoder is absent).
#
# ffmpeg is therefore a SYSTEM dependency. It is detected at runtime (never a
# hardcoded path); this script only ensures it is installed. Frontend (npm) and
# Python (uv) deps are handled by the launcher (server/start_server.sh) — this
# script covers the one thing they cannot: the ffmpeg binary.
set -euo pipefail

if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  echo "ffmpeg + ffprobe already present ($(command -v ffmpeg)) — nothing to install."
  exit 0
fi

echo "Installing ffmpeg (provides ffmpeg + ffprobe) …"
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y ffmpeg
elif command -v brew >/dev/null 2>&1; then
  brew install ffmpeg
else
  echo "ERROR: no supported package manager (apt-get or brew) found." >&2
  echo "       Install ffmpeg manually so 'ffmpeg' and 'ffprobe' are on PATH." >&2
  exit 1
fi

# Verify loudly — a partial install that leaves ffprobe missing is a real error.
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "ERROR: ffmpeg install completed but ffmpeg/ffprobe are still not on PATH." >&2
  exit 1
fi
echo "ffmpeg + ffprobe installed: $(command -v ffmpeg)"
