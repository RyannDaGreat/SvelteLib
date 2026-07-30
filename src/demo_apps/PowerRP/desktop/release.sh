#!/usr/bin/env bash
# Command. Cuts a desktop release end to end:
#   bash desktop/release.sh 0.3.0
# bump version → commit → tag → push → wait for the GitHub Actions build →
# sha256 the released dmg → bump the Homebrew cask → push the tap.
# After it finishes, users update with:  brew upgrade --cask powerrp
# (Installed apps do NOT self-update yet — electron-updater is future work.)
set -euo pipefail
VERSION="${1:?usage: release.sh <version, e.g. 0.3.0>}"
cd "$(dirname "$0")"
REPO_ROOT="$(cd ../../../.. && pwd)"
TAP_REPO="RyannDaGreat/homebrew-tap"
DL="https://github.com/RyannDaGreat/SvelteLib/releases/download"

node -e "const f='package.json',d=require('./'+f);d.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(d,null,2)+'\n')"
git -C "$REPO_ROOT" add src/demo_apps/PowerRP/desktop/package.json
git -C "$REPO_ROOT" commit -m "[C] Desktop $VERSION"
git -C "$REPO_ROOT" push origin HEAD
git -C "$REPO_ROOT" tag "v$VERSION"
git -C "$REPO_ROOT" push origin "v$VERSION"

echo "waiting for the release-app workflow…"
sleep 15
RUN_ID=$(gh run list --workflow=release-app.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status

TMP=$(mktemp -d)
curl -fsSL -o "$TMP/app.dmg" "$DL/v$VERSION/PowerRP-$VERSION-arm64.dmg"
SHA=$(shasum -a 256 "$TMP/app.dmg" | cut -d' ' -f1)
gh repo clone "$TAP_REPO" "$TMP/tap" -- --quiet
/usr/bin/sed -i '' -e "s/version \"[^\"]*\"/version \"$VERSION\"/" -e "s/sha256 \"[^\"]*\"/sha256 \"$SHA\"/" "$TMP/tap/Casks/powerrp.rb"
git -C "$TMP/tap" commit -am "[C] powerrp cask $VERSION"
# The tap push reuses the origin remote's embedded token (gh's helper 403s here).
TOKEN=$(git -C "$REPO_ROOT" remote get-url origin | sed -E 's|https://api:([^@]+)@.*|\1|')
git -C "$TMP/tap" push "https://api:${TOKEN}@github.com/${TAP_REPO}.git" HEAD:main 2>&1 | sed 's/ghp_[A-Za-z0-9]*/TOKEN/g'
rm -rf "$TMP"
echo "released v$VERSION — users update with: brew upgrade --cask powerrp"
