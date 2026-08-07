#!/usr/bin/env bash
# Fetch the two READ-ONLY Axoloti clones the harness measures against.
#
# They go in /tmp on purpose: this dump must stay portable, and a vendored copy
# of someone else's GPL firmware tree inside it is neither portable nor ours.
# Re-running is safe; an existing clone is left alone.
#
# The commits are PINNED because a faithfulness result is meaningless without
# saying faithful to WHAT. These are the same two the AX-2 kernel docblock
# records, so the harness and the ports are reading the same objects.
set -euo pipefail

FIRMWARE_COMMIT=46f6e4b383ce182da9dcca25b9d4b544fe20f990
FACTORY_COMMIT=78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa

clone_at() {
  local url="$1" dir="$2" commit="$3"
  if [ ! -d "$dir/.git" ]; then
    git clone "$url" "$dir"
  fi
  git -C "$dir" fetch --quiet origin "$commit" 2>/dev/null || git -C "$dir" fetch --quiet origin
  git -C "$dir" checkout --quiet "$commit"
  echo "$dir @ $(git -C "$dir" rev-parse HEAD)"
}

clone_at https://github.com/axoloti/axoloti.git         "${AXO_SRC:-/tmp/axoloti_src}"        "$FIRMWARE_COMMIT"
clone_at https://github.com/axoloti/axoloti-factory.git "${AXO_FACTORY:-/tmp/axoloti_factory}" "$FACTORY_COMMIT"
