#!/usr/bin/env bash
# Copy the COMMITTED plugin assets into a project's assets/ folder.
#
# WHY THIS SCRIPT EXISTS. The proof plugin assets must be committed, but
# `projects/*` is gitignored (.gitignore: "Project storage is USER DATA, not
# source") — a project folder is a user's deck, not part of the repo. So the
# source of truth is this directory, and a project gets a COPY. Without a script
# the copy would be an undocumented manual step that a fresh clone silently
# lacks, and the plugin-asset feature would look broken in the Imitations deck
# for reasons nothing recorded.
#
# The copy direction is one-way on purpose: edit the file HERE and re-run, never
# edit the copy inside projects/ (that one is not under version control).
#
# Usage:  bash plugin_assets/seed_into_project.sh [ProjectName]   (default: Imitations)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_root="$(dirname "$here")"
project="${1:-Imitations}"
dest="$app_root/projects/$project/assets"

if [ ! -d "$app_root/projects/$project" ]; then
  echo "seed_into_project.sh: no such project: $app_root/projects/$project" >&2
  echo "  (create it by saving a project of that name in the editor first)" >&2
  exit 1
fi

mkdir -p "$dest"
for f in "$here"/*.plugin.js; do
  echo "  -> $(basename "$f")"
  cp -v "$f" "$dest/"
done
# COMPANION DATA FILES. csv_bar_graph.plugin.js plots a CSV project asset, so the
# widget alone is not a working demo -- the file it points at has to travel with
# it, or the chart seeded into a project renders its (correct, loud) "could not
# read" error box and looks broken for a reason nothing recorded.
for f in "$here"/*.csv; do
  [ -e "$f" ] || continue
  echo "  -> $(basename "$f")  (data for csv_bar_graph)"
  cp -v "$f" "$dest/"
done
echo "Seeded $(ls -1 "$here"/*.plugin.js | wc -l | tr -d ' ') plugin assets into project \"$project\"."
echo "Reopen the project in the editor; the widgets register on load."
