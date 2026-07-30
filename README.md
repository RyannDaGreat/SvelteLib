# PowerRP

Hi, this is PowerRP — a presentation editor that renders like a game engine and
exports like a print shop.

**Try it in your browser:** https://ryanndagreat.github.io/SvelteLib/ — the
full editor, no install (projects live in your browser; export/import zips to
move them).

## Saving & loading

- **Browser storage** — on the web version, projects live in the browser you opened it in.
- **Server** — the installed app keeps projects in folders on disk.
- **Zip** — export a project as a `.zip`; drag one onto the page to open it.
- **`?zip=<url>`** — share a link to a zip hosted anywhere and it opens on load.
- **GitHub repo** — Save to GitHub writes `doc.json` + `assets/` to a repo; `?repo=owner/name` opens it.

A repo stays editable after you share it, which a zip does not — the files are right there.

Worked example: [PowerRP-RobotSim-Demo](https://github.com/RyannDaGreat/PowerRP-RobotSim-Demo)
→ [open it](https://ryanndagreat.github.io/SvelteLib/?repo=RyannDaGreat/PowerRP-RobotSim-Demo)

## Install

**Download the app:** grab
[`PowerRP.dmg` (latest release)](https://github.com/RyannDaGreat/SvelteLib/releases/latest/download/PowerRP.dmg),
open it, and drag PowerRP to Applications.

**Or with Homebrew:**

```
brew install --cask ryanndagreat/tap/powerrp
```

**Update:**

```
brew update && brew upgrade --cask powerrp
```

First launch does a one-time setup (downloads the app's web dependencies into
`~/Library/Application Support/PowerRP` — the app's only footprint outside
/Applications; needs network, takes a few minutes). Unsigned build for now: if
macOS balks, right-click the app → Open.
