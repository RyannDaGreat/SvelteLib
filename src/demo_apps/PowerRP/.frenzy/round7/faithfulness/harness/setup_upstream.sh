#!/usr/bin/env bash
# Clone every upstream VCV plugin this harness compares against, pinned to the
# commit the corresponding spec names.
#
# THE CHECKOUTS GO IN /tmp, NEVER IN THE DUMP. They are ~200 MB of third-party
# C++ under half a dozen licences; committing them would make the dump
# non-portable and would be redistributing someone else's source.
#
# Idempotent: an existing checkout is fetched and re-pinned rather than recloned.
set -euo pipefail

ROOT=/tmp/vcvsrc
mkdir -p "$ROOT"

# name url commit  ("HEAD" = no spec pins this one; recorded as unpinned in the report)
REPOS=(
  "bogaudio     https://github.com/bogaudio/BogaudioModules      656eaae458e045602dc974bae82e15a11e104958"
  "countmodula  https://github.com/countmodula/VCVRackPlugins    30b3c6c46fc0589f5e0ece7ad79abbe0293e70fd"
  "impromptu    https://github.com/MarcBoule/ImpromptuModular    cf87c918875e502043cabe3deaa2e52adda7cecd"
  "squinky      https://github.com/squinkylabs/SquinkyVCV-main   8b0411e2d1b5a11ffa11280cca00253813212dc7"
  "fundamental  https://github.com/VCVRack/Fundamental           10dd0160c664770910e5584b7b00498cc48d9ddd"
  "rack         https://github.com/VCVRack/Rack                  061ccf63c1758599396ac1bb10d47345d9d34076"
  "mutable      https://github.com/pichenettes/eurorack          HEAD"
  "audible      https://github.com/VCVRack/AudibleInstruments    HEAD"
  "befaco       https://github.com/VCVRack/Befaco                HEAD"
  "valley       https://github.com/ValleyAudio/ValleyRackFree    HEAD"
)

for entry in "${REPOS[@]}"; do
  read -r name url commit <<<"$entry"
  dir="$ROOT/$name"
  if [ ! -d "$dir/.git" ]; then
    echo "cloning $name"
    git clone --quiet --filter=blob:none "$url" "$dir"
  fi
  if [ "$commit" != "HEAD" ]; then
    git -C "$dir" fetch --quiet origin "$commit" 2>/dev/null || true
    git -C "$dir" checkout --quiet "$commit"
  fi
  echo "$name @ $(git -C "$dir" rev-parse --short HEAD)"
done

# Bogaudio vendors ffft as a submodule; dsp/analyzer.hpp will not compile without it.
git -C "$ROOT/bogaudio" submodule update --init --quiet lib/ffft 2>/dev/null || true
test -f "$ROOT/bogaudio/lib/ffft/FFTReal.h" || echo "WARNING: bogaudio lib/ffft is missing — dsp/table.cpp will not compile"
