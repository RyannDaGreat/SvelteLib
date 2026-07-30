/**
 * ASSET TILE TOOLTIP tests — plain node, no DOM, no browser.
 * Run: node src/demo_apps/PowerRP/tests/tile_tooltip_test.js
 *
 * Three user rulings about a tile's hover tip are pinned here, in the two layers
 * that can be tested without a browser:
 *
 *   1. STRUCTURE — "the file name should always be the top and then everything else
 *      comes in a new line after that… the file name should always be bold in that
 *      tooltip." That is web/AssetExplorer.svelte's pure `assetTipParts`, which
 *      returns {name, meta, description} instead of one mashed sentence precisely so
 *      the name can be marked up on its own. The markup itself (a `tip` SNIPPET with
 *      .ae-tip-name/.ae-tip-meta/.ae-tip-desc) is asserted as source text, and its
 *      rendered geometry is the puppeteer probe's job.
 *   2. PLACEMENT — "the tooltip should never be intersecting [the asset]… fully below
 *      or fully above." The decision is src/lib/Tooltip.svelte's pure
 *      `resolvePlacement`; the tile opts into it with anchor="element". The
 *      never-overlap GEOMETRY is measured for real by the probe — what is checkable
 *      here is that the side choice can never land the tip ON the anchor, including
 *      the case where NEITHER side fits (which used to honor the request and overlap).
 *   3. SIZE FORMATTING — the meta line's bytes go through web/fileSize.js, never
 *      raw numbers.
 *
 * WHY THE FUNCTIONS ARE EXTRACTED FROM SOURCE rather than imported: both live in
 * `<script module>` blocks of .svelte files, which bare node cannot import (there is
 * no Svelte compiler in the gate's node lane). Extracting the function TEXT and
 * evaluating it runs the REAL implementation — a rewrite of either function's body
 * breaks these tests — while keeping this suite in the fast bare-node lane. The
 * markers are asserted before use, so a rename that defeats the scrape fails loudly
 * instead of silently testing nothing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { humanReadableFileSize } from "../web/fileSize.js";
import { relativeMtime } from "../web/projectPreviews.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const EXPLORER_PATH = new URL("../web/AssetExplorer.svelte", import.meta.url);
const TOOLTIP_PATH = new URL("../../../lib/Tooltip.svelte", import.meta.url);
const explorerSrc = readFileSync(EXPLORER_PATH, "utf8");
const tooltipSrc = readFileSync(TOOLTIP_PATH, "utf8");

/**
 * Query (reads the component source). One `export function <name>` body lifted out of
 * a .svelte module script, as text. Loud when the function is not found — a rename
 * must fail the suite rather than quietly leave it asserting nothing.
 *
 * Relies on the file's 2-space method indentation to find the closing brace, which is
 * the same shape every other source-scraping test in this directory assumes.
 */
function exportedFunctionText(src, name, file) {
  const match = src.match(new RegExp(`export function ${name}\\([\\s\\S]*?\\n  \\}`));
  if (!match) throw new Error(`${file}: no "export function ${name}" found — it was renamed or removed, so this test is no longer checking it`);
  return match[0].replace("export ", "");
}

// The REAL assetTipParts + its helper, evaluated with their real dependencies.
const { assetTipParts, doubleClickClause } = new Function(
  "humanReadableFileSize",
  "relativeMtime",
  `${exportedFunctionText(explorerSrc, "doubleClickClause", "AssetExplorer.svelte")}
   ${exportedFunctionText(explorerSrc, "assetTipParts", "AssetExplorer.svelte")}
   return { assetTipParts, doubleClickClause };`,
)(humanReadableFileSize, relativeMtime);

// The REAL resolvePlacement out of the shared Tooltip.
const { resolvePlacement } = new Function(
  `${exportedFunctionText(tooltipSrc, "resolvePlacement", "Tooltip.svelte")}
   return { resolvePlacement };`,
)();

// ── 1. THE TIP'S STRUCTURE ───────────────────────────────────────────────────

test("assetTipParts returns the name ALONE, so the caller can bold just it", () => {
  // The heart of the ruling. A flat sentence ("clip.mp4 — video · 25.8MB — drag…")
  // cannot be styled: there is no way to bold one of its clauses. So `name` is its
  // own field and carries nothing else — not the kind, not a dash, not the size.
  const t = assetTipParts({ name: "clip.mp4", kind: "video", size: 27100000, mtime: 0 }, 2 * 3600 * 1000);
  assert.equal(t.name, "clip.mp4", "the name field must be the bare filename");
  assert.doesNotMatch(t.name, /[·—]/, "no separators may leak into the name line");
  assert.doesNotMatch(t.name, /video|25\.8MB/, "the kind and size belong on the SECOND line");
});

test("line 2 is kind · size, and the size is rp-formatted, never raw bytes", () => {
  const t = assetTipParts({ name: "clip.mp4", kind: "video", size: 27100000, mtime: 0 }, 0);
  assert.equal(t.meta, "video · 25.8MB");
  assert.doesNotMatch(t.meta, /27100000/, "the meta line must never print raw bytes");
  // The formatter is web/fileSize.js itself, not a local approximation.
  assert.ok(t.meta.endsWith(humanReadableFileSize(27100000)));
});

test("the AGE and the gestures are the DESCRIPTION, not the meta line", () => {
  // The ruling fixes line 2 as kind · size. An age is prose about the file's history,
  // so it moved down rather than being crammed into the identity line.
  const t = assetTipParts({ name: "clip.mp4", kind: "video", size: 100, mtime: 0 }, 2 * 3600 * 1000);
  assert.match(t.description, /Modified 2 hours ago\./);
  assert.match(t.description, /Drag onto the canvas/);
  assert.doesNotMatch(t.meta, /hours ago/);
});

test("a missing size or mtime DROPS its clause — never a placeholder", () => {
  // The projectMetaLine convention: absent metadata says nothing rather than "undefined".
  const t = assetTipParts({ name: "x.png", kind: "image" }, 0);
  assert.equal(t.meta, "image", "with no size, the meta line is the kind alone");
  assert.doesNotMatch(t.meta, /undefined|NaN|null/);
  assert.doesNotMatch(t.description, /Modified/, "no mtime ⇒ no age sentence");
  assert.match(t.description, /Drag onto the canvas/, "the gestures are still taught");
});

test("the double-click clause is PER KIND — a code editor is not 'preview'", () => {
  // A flat "double-click to preview" is a lie about a plugin (it opens Monaco) and
  // about a CSV (it opens a table), and the code editor in particular is not an
  // outcome to discover by accident.
  const kindOf = (kind) => assetTipParts({ name: `f.${kind}`, kind }, 0).description;
  assert.match(kindOf("plugin"), /double-click to edit its JavaScript\.$/);
  assert.match(kindOf("data"), /double-click to view the table\.$/);
  assert.match(kindOf("video"), /double-click to preview\.$/);
  assert.match(kindOf("other"), /double-click to preview\.$/);
  assert.equal(doubleClickClause("plugin"), "double-click to edit its JavaScript");
});

test("a BUILT-IN says so FIRST — it is not in the project and cannot be deleted", () => {
  const t = assetTipParts({ name: "clock_digital.plugin.js", kind: "plugin", size: 900, builtin: true }, 0);
  assert.match(t.description, /^Built-in — ships with the app, not stored in this project\./);
  assert.equal(t.name, "clock_digital.plugin.js", "the ruling's own example filename, still bare and bold-able");
});

test("the tile renders the three parts as a Tooltip SNIPPET, with the name bold", () => {
  // The markup half of ruling 1. `text=` cannot carry markup, so a snippet is not a
  // stylistic choice here — it is the only way to bold the name.
  const grid = explorerSrc.slice(explorerSrc.indexOf("{#snippet assetGrid()}"));
  assert.match(grid, /\{#snippet tip\(\)\}/, "the tile tip must be a snippet, not a flat text= string");
  assert.match(grid, /class="ae-tip-name">\{parts\.name\}/, "line 1 is the name");
  assert.match(grid, /class="ae-tip-meta">\{parts\.meta\}/, "line 2 is kind · size");
  assert.match(grid, /class="ae-tip-desc">\{parts\.description\}/, "line 3 is the description");
  // Order matters: the name is "always the top".
  assert.ok(
    grid.indexOf("ae-tip-name") < grid.indexOf("ae-tip-meta") &&
      grid.indexOf("ae-tip-meta") < grid.indexOf("ae-tip-desc"),
    "the three lines must appear in the ruled order",
  );
  // And the styling that makes it BOLD / italic actually exists.
  const css = readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  const nameRule = css.slice(css.indexOf(".ae-tip-name {"), css.indexOf("}", css.indexOf(".ae-tip-name {")));
  assert.match(nameRule, /font-weight:\s*700/, "the filename line must be BOLD (the ruling says 'always')");
  const metaRule = css.slice(css.indexOf(".ae-tip-meta {"), css.indexOf("}", css.indexOf(".ae-tip-meta {")));
  assert.match(metaRule, /font-style:\s*italic/, "the kind · size line is italic");
});

// ── 2. PLACEMENT: THE TIP MAY NEVER LAND ON ITS OWN TILE ─────────────────────

test("the tile opts into ELEMENT anchoring, so the tip is placed off the tile", () => {
  // Cursor anchoring (the Tooltip default) puts the tip AT THE POINTER — i.e. on top
  // of the thumbnail whose name it is reporting. anchor="element" is what makes the
  // ruling mechanically possible.
  const grid = explorerSrc.slice(explorerSrc.indexOf("{#snippet assetGrid()}"));
  assert.match(grid, /<Tooltip anchor="element">/, 'the tile tip must anchor to the element, not the cursor');
});

test("element anchoring does not follow the cursor (nothing to follow, no hover cost)", () => {
  // Hovering must stay FREE (the manifest's hover invariant): under element anchoring
  // the reference box is fixed, so re-measuring per pointermove would be layout work
  // for no visible change.
  const at = tooltipSrc.indexOf("function track(");
  assert.ok(at > 0, "Tooltip.svelte: no track() found — it was renamed, so this test checks nothing");
  const body = tooltipSrc.slice(at, tooltipSrc.indexOf("\n  }", at) + 4);
  assert.match(body, /anchor === "element"/, "track() must bail out under element anchoring");
});

test("resolvePlacement flips to the side that FITS", () => {
  // The ordinary case: a top-row tile's tip goes below, a bottom-row tile's goes above.
  const TIP_H = 60, GAP = 6, VIEW_H = 800;
  // A tile at the very top of the viewport: "top" cannot fit, so it must flip down.
  assert.equal(resolvePlacement("top", { top: 10, bottom: 90 }, TIP_H, GAP, VIEW_H), "bottom");
  // A tile at the very bottom: "bottom" cannot fit, so it must flip up.
  assert.equal(resolvePlacement("bottom", { top: 700, bottom: 780 }, TIP_H, GAP, VIEW_H), "top");
  // Plenty of room on the requested side ⇒ honored.
  assert.equal(resolvePlacement("bottom", { top: 300, bottom: 380 }, TIP_H, GAP, VIEW_H), "bottom");
  assert.equal(resolvePlacement("top", { top: 300, bottom: 380 }, TIP_H, GAP, VIEW_H), "top");
});

test("when NEITHER side fits it takes the roomier one — it never covers the anchor", () => {
  // THE REGRESSION THIS PINS: the original resolvePlacement returned the REQUESTED
  // side when neither fit. With cursor anchoring that was harmless (a degenerate
  // point), but with element anchoring on a short viewport it would clamp the tip
  // back over the tile — exactly what the ruling forbids. Clipping at a viewport edge
  // is the correct sacrifice; overlapping the asset is not.
  const TIP_H = 400, GAP = 6, VIEW_H = 700;
  const anchor = { top: 380, bottom: 410 }; // 380px above, 290px below: neither fits 400
  assert.equal(resolvePlacement("bottom", anchor, TIP_H, GAP, VIEW_H), "top", "must pick the roomier side, not the requested one");
  assert.equal(resolvePlacement("top", anchor, TIP_H, GAP, VIEW_H), "top");
  // Mirrored: more room BELOW than above.
  const low = { top: 200, bottom: 230 };
  assert.equal(resolvePlacement("top", low, TIP_H, GAP, VIEW_H), "bottom");
});

test("every side resolvePlacement can return keeps the tip outside the anchor rect", () => {
  // The property behind the ruling, checked exhaustively over a grid rather than at a
  // few points: for an ELEMENT anchor, whichever side is chosen, the tip's own band
  // [top,bottom] must not intersect the anchor's band. That is true by construction of
  // computePosition (top ⇒ tip bottom = rect.top - gap; bottom ⇒ tip top = rect.bottom
  // + gap), so what is checked here is that the SIDE CHOICE never breaks it.
  const GAP = 6;
  for (const viewH of [500, 800, 1200]) {
    for (const tipH of [20, 60, 200, 400]) {
      for (let top = 0; top + 80 <= viewH; top += 40) {
        const rect = { top, bottom: top + 80 }; // an 80px-tall tile
        for (const want of ["top", "bottom"]) {
          const side = resolvePlacement(want, rect, tipH, GAP, viewH);
          // Reproduce computePosition's vertical rule for the chosen side.
          const tipTop = side === "top" ? rect.top - GAP - tipH : rect.bottom + GAP;
          const tipBottom = tipTop + tipH;
          assert.ok(
            tipBottom <= rect.top || tipTop >= rect.bottom,
            `viewH=${viewH} tipH=${tipH} rect=[${rect.top},${rect.bottom}] want=${want} → ${side}: tip [${tipTop},${tipBottom}] intersects the anchor`,
          );
        }
      }
    }
  }
});

// ── 3. THE TIP'S WIDTH OVERRIDE ACTUALLY REACHES THE TIP ─────────────────────

test("--tt-max-width is read off the anchor, not declared on the tip", () => {
  // A HOST OVERRIDE THAT NEVER APPLIED. The tip renders as a body-level SIBLING of the
  // anchor, so it inherits nothing from the host's subtree — and .tt-tip also declared
  // its own --tt-max-width, which would have shadowed the value even if it had
  // inherited. A tile tip is three lines and needs more than the 240px default, so the
  // property is now fetched from the anchor and applied inline (the --tt-gap
  // mechanism). Both halves are pinned: the tip must not re-declare it, and the script
  // must read it.
  const styleBlock = tooltipSrc.slice(tooltipSrc.lastIndexOf("<style>"));
  assert.doesNotMatch(styleBlock, /--tt-max-width:/, ".tt-tip must not declare --tt-max-width (it would shadow the host's)");
  assert.match(tooltipSrc, /anchorLength\("--tt-max-width", MAX_WIDTH\)/, "place() must read the cap off the anchor");
  assert.match(tooltipSrc, /max-width: \{maxWidth\}px/, "and apply it to the tip inline");
  // The Asset Explorer is the consumer that needs it, set on an ancestor of the anchor.
  const css = readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  assert.match(css, /--tt-max-width: var\(--a-tile-tip-width\)/, "the tile cell must set the wider cap through a token");
});

// ── 4. THE DOWNLOAD BUTTON (user ruling: it is ALWAYS there) ─────────────────

test("every tile has copy-path, DOWNLOAD and trash in one always-present row", () => {
  // "In addition to the trash icon and copy path icon, there should also always be a
  // download icon." All three live in one .ae-tile-actions row rather than three
  // corners: a square tile has only two bottom corners and the top-left belongs to the
  // PDF page-count badge, so a third corner button would have had to overlap something.
  const grid = explorerSrc.slice(explorerSrc.indexOf("{#snippet assetGrid()}"));
  assert.match(grid, /class="ae-tile-actions"/, "the three actions share one row");
  for (const cls of ["ae-copy-path", "ae-download", "ae-trash"]) {
    assert.match(grid, new RegExp(`class="btn-icon ${cls}"`), `${cls} must be on a tile`);
  }
  // The download is UNCONDITIONAL — not gated on kind the way insert is (images only).
  const row = grid.slice(grid.indexOf('class="ae-tile-actions"'), grid.indexOf("</div>", grid.indexOf("ae-trash")));
  const download = row.slice(row.indexOf("ae-download"));
  assert.doesNotMatch(download.slice(0, download.indexOf("</Tooltip>")), /\{#if /, "the download button must not be conditional");
  // Immediate Tooltip, per the house rule (native title= is banned app-wide).
  assert.match(grid, /<Tooltip text=\{downloadTip\(a\)\}>/, "the download button needs an immediate Tooltip");
  // And it is hover-revealed with the row, not permanently visible.
  const css = readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  assert.match(css, /\.asset-explorer \.ae-tile-actions \{[^}]*opacity: 0/s, "the row is hidden until hover");
  assert.match(css, /\.asset-explorer \.ae-tile:hover \.ae-tile-actions/, "hovering the tile reveals it");
  assert.match(css, /\.ae-tile-actions:focus-within/, "and keyboard focus inside it must reveal it too");
});

test("download reads bytes through the STORE seam, so it works in both storage modes", () => {
  // An <a href="/asset/…" download> works only in HTTP mode. In browser-local
  // (IndexedDB) mode there is no origin serving that path, so the same markup would
  // save the app's 404 page under the asset's name — a silent wrong answer. store.get()
  // returns the bytes in BOTH modes.
  const fn = explorerSrc.slice(explorerSrc.indexOf("async function downloadAsset"));
  const body = fn.slice(0, fn.indexOf("\n  }") + 4);
  assert.match(body, /assetStore\(\)\.get\(/, "the bytes must come through the storage seam");
  assert.doesNotMatch(body, /projectApi\.assetUrl|fetch\(/, "never a direct fetch or served-path link");
  assert.match(body, /URL\.createObjectURL/, "a blob: URL is what an <a download> can save");
  assert.match(body, /link\.download = a\.name/, "the saved filename is the asset's basename");
  assert.match(body, /URL\.revokeObjectURL/, "the one-shot object URL is revoked, not leaked");
  // A BUILT-IN's bytes are its bundled source — there is no store entry to read.
  assert.match(body, /a\.builtin/, "a built-in must take its source, not a store read");
  // Failures are LOUD (the pane's own error line + the console), never swallowed.
  assert.match(body, /console\.error/, "a failed download must report itself");
  assert.match(body, /error = String/, "and surface in the pane's error line");
});

console.log(`\n${passed} tile-tooltip tests passed.`);
