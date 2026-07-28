#!/usr/bin/env bash
# PowerRP system-dependency setup — idempotent, safe to re-run.
#
# TWO system dependencies, neither of which npm or uv can provide:
#
# 1. ffmpeg / ffprobe. The project server (server/server.py) shells out to them for
#    BOTH directions of video work:
#      - EXTRACT: pulling filmstrip frames out of a project video (/api/frames);
#      - ENCODE:  turning rendered PNG frames into an H.264 MP4 (the export and
#                 render-job routes — server-side, so it works on plain HTTP where
#                 the browser's WebCodecs VideoEncoder is absent).
#
# 2. Chrome's shared libraries. A HEADLESS BROWSER IS NOW LOAD-BEARING, not merely a
#    test tool: cli/render_job.js renders every server-side video frame by booting
#    the real editor in headless Chrome (user ruling — the backend must run the
#    frontend's code, not a second renderer), and ~85 test files launch Chrome too.
#    `npm install` downloads the Chrome BINARY; it cannot install the ~30 system
#    .so files that binary links against. Without them Chrome fails to start and
#    every browser test — and every server-side render — dies. That was a LATENT BUG
#    in this script: a fresh Linux clone could not run the test suite at all.
#
# Both are detected at runtime by the code that uses them (never a hardcoded path);
# this script only ensures they are installed. Frontend (npm) and Python (uv) deps
# are handled by the launcher, server/start_server.sh.
set -euo pipefail
cd "$(dirname "$0")"

# The SvelteLib checkout root, where package.json + node_modules live. Relative to
# this script so the dump stays portable.
REPO_ROOT="$(cd ../../.. && pwd)"

# Command. Installs apt/brew packages, reporting which manager it used. Deliberately
# NOT a gate: package names drift between distro releases, so a name that does not
# exist here is REPORTED and then superseded by the library check below, which tests
# the real binary instead of trusting a package list.
install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y
    sudo apt-get install -y "$@" || echo "WARNING: apt-get could not install every package (names differ across distro versions) — the library check below is the real gate." >&2
  elif command -v brew >/dev/null 2>&1; then
    brew install "$@" || echo "WARNING: brew could not install every formula — the library check below is the real gate." >&2
  else
    echo "ERROR: no supported package manager (apt-get or brew) found." >&2
    echo "       Install these manually: $*" >&2
    exit 1
  fi
}

# ── 1. ffmpeg ────────────────────────────────────────────────────────────────
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  echo "ffmpeg + ffprobe already present ($(command -v ffmpeg))."
else
  echo "Installing ffmpeg (provides ffmpeg + ffprobe) …"
  install_packages ffmpeg
  # Verify loudly — a partial install that leaves ffprobe missing is a real error.
  if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
    echo "ERROR: ffmpeg install completed but ffmpeg/ffprobe are still not on PATH." >&2
    exit 1
  fi
  echo "ffmpeg + ffprobe installed: $(command -v ffmpeg)"
fi

# ── 2. Chrome's shared libraries ─────────────────────────────────────────────
# macOS Chrome for Testing is an .app bundle carrying its own frameworks, so there
# is nothing to install and nothing to check.
if [ "$(uname -s)" = "Darwin" ]; then
  echo "macOS: Chrome for Testing bundles its own frameworks — no system libraries needed."
  echo "Setup complete."
  exit 0
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: node and npm are required — puppeteer downloads the Chrome this project renders with." >&2
  exit 1
fi

# Chrome arrives with `npm install` (puppeteer's postinstall fetches it), and its
# dependency manifest cannot be read before it exists — so install if absent. Same
# non-interactive install the launcher runs.
if [ ! -d "${REPO_ROOT}/node_modules/puppeteer" ]; then
  echo "Installing frontend deps (npm install in ${REPO_ROOT}) — this is what downloads Chrome …"
  ( cd "${REPO_ROOT}" && npm install --no-fund --no-audit )
fi

# Ask puppeteer where its Chrome is. NEVER hardcode that path: it carries a version
# number that changes with every puppeteer bump.
CHROME="$(cd "${REPO_ROOT}" && node -e 'import("puppeteer").then((m) => console.log(m.default.executablePath()))')"
if [ ! -x "$CHROME" ]; then
  echo "ERROR: puppeteer reports its Chrome at '${CHROME}', which is not an executable." >&2
  echo "       Run 'npx puppeteer browsers install chrome' in ${REPO_ROOT}." >&2
  exit 1
fi
echo "Chrome: ${CHROME}"

# THE PACKAGE LIST IS GOOGLE'S OWN, not one maintained here. Every Chrome for
# Testing download ships `deb.deps` beside the binary — the exact Debian
# dependencies of that exact build. Parsing it means the list cannot rot when Chrome
# adds a dependency, and it beats an ldd-derived list because ldd sees only
# link-time deps and misses what Chrome dlopens. `(>= 1.2)` version constraints are
# dropped; `a | b` alternatives collapse to the first.
DEPS_FILE="$(dirname "$CHROME")/deb.deps"
if [ ! -r "$DEPS_FILE" ]; then
  echo "ERROR: this Chrome download has no readable deb.deps beside it (${DEPS_FILE}), so its" >&2
  echo "       system dependencies cannot be determined. Re-download Chrome:" >&2
  echo "         npx puppeteer browsers install chrome" >&2
  exit 1
fi
CHROME_PACKAGES=()
while IFS= read -r pkg; do
  CHROME_PACKAGES+=("$pkg")
done < <(sed -e 's/([^)]*)//g' -e 's/|.*//' "$DEPS_FILE" | tr -d ' \t' | grep -v '^$')

# Idempotent: only touch the package manager when something is actually missing.
MISSING=()
for pkg in "${CHROME_PACKAGES[@]}"; do
  if ! dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed"; then
    MISSING+=("$pkg")
  fi
done
if [ "${#MISSING[@]}" -eq 0 ]; then
  echo "Chrome's ${#CHROME_PACKAGES[@]} system packages are already installed."
else
  echo "Installing ${#MISSING[@]} of Chrome's ${#CHROME_PACKAGES[@]} system packages: ${MISSING[*]} …"
  install_packages "${MISSING[@]}"
fi

# THE GATE. The contract is not "apt said yes" — it is "the dynamic linker can
# resolve everything Chrome needs". ldd answers that about the real binary, and about
# the bundled ANGLE / SwiftShader libraries the renderer actually draws through.
UNRESOLVED="$(
  for lib in "$CHROME" "$(dirname "$CHROME")"/*.so; do
    [ -e "$lib" ] || continue
    ldd "$lib" 2>/dev/null | awk '/not found/ {print $1}' || true
  done | sort -u
)"
if [ -n "$UNRESOLVED" ]; then
  echo "ERROR: Chrome cannot resolve these shared libraries, so headless rendering and" >&2
  echo "       every browser test will fail:" >&2
  printf '         %s\n' $UNRESOLVED >&2
  echo "       Install the packages providing them on this distro, then re-run." >&2
  exit 1
fi
echo "Chrome's shared libraries all resolve ($(printf '%s\n' "${CHROME_PACKAGES[@]}" | wc -l | tr -d ' ') packages checked)."
echo "Setup complete."
