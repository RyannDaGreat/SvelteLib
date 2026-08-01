/**
 * src/lib/popover.js — the headless popover kit's viewport clamp.
 *
 * WHY THIS FILE EXISTS RATHER THAN RELYING ON THE DOCTESTS. tests/doctest_test.js
 * scans SEARCH_DIRS = ["core", "plugins", "render_gpu", "cli"] (:91). Neither
 * `web/` nor `src/lib/` is in that list — src/lib is outside the app tree
 * entirely — so no @example on this function has ever been executed by a runner,
 * and this function proved what that costs: two of the four examples it shipped
 * with were
 * WRONG (`top: 384` for a case that yields 390, and `top: 294` for a case that
 * yields 200 and whose stated premise "NEITHER side has 500px (below: 80, above:
 * 700)" was arithmetically false). They read as authoritative for as long as they
 * existed. So the examples are pinned HERE, where the gate can fail on them.
 *
 * Uses node:assert/strict — the house pattern (2 of 3 bare-node tests use /strict,
 * recorded at manifest R6-24.4a).
 */
import assert from "node:assert/strict";
import { popupPosition, VIEWPORT_MARGIN } from "../../../lib/popover.js";

let checks = 0;
const eq = (got, exp, what) => { assert.deepEqual(got, exp, what); checks++; };

const VW = 1200, VH = 800;

// ── (1) the five documented examples, verbatim ───────────────────────────────
eq(popupPosition({ left: 100, right: 120, top: 50, bottom: 70 }, 320, 360, VW, VH),
  { left: 100, top: 70 }, "plain case: below-left of the anchor");

eq(popupPosition({ left: 1000, right: 1020, top: 50, bottom: 70 }, 320, 360, VW, VH),
  { left: 874, top: 70 }, "right edge clamped to viewportW - width - VIEWPORT_MARGIN");

eq(popupPosition({ left: 100, right: 120, top: 750, bottom: 770 }, 320, 360, VW, VH),
  { left: 100, top: 390 }, "flips ABOVE: top = anchor.top - height, with no margin subtracted");

eq(popupPosition({ left: 100, right: 120, top: 400, bottom: 420 }, 320, 900, VW, VH),
  { left: 100, top: VIEWPORT_MARGIN }, "taller than the viewport: pinned to the margin, never off the top");

eq(popupPosition({ left: 1190, right: 1190, top: 790, bottom: 790 }, 150, 200, VW, VH),
  { left: 1044, top: 590 }, "bottom-right CORNER pointer: both axes clamp at once");

// ── (2) THE REGRESSION THIS MODULE WAS EXTRACTED FOR ─────────────────────────
// web/ContextMenu.svelte had NO clamp: it wrote the raw pointer clientX/clientY
// into left/top, so a right-click near an edge put the menu off-screen. A pointer
// is the DEGENERATE anchor (a zero-size rect at the cursor); assert the invariant
// directly rather than trusting one sample, across the whole viewport edge.
const MENU_W = 150, MENU_H = 220; // ContextMenu's --cm-min-w and a ~6-entry menu
for (const x of [0, 1, 600, VW - 1, VW]) {
  for (const y of [0, 1, 400, VH - 1, VH]) {
    const p = popupPosition({ left: x, right: x, top: y, bottom: y }, MENU_W, MENU_H, VW, VH);
    assert.ok(p.left >= VIEWPORT_MARGIN, `left off-screen at pointer (${x},${y}): ${p.left}`);
    assert.ok(p.top >= VIEWPORT_MARGIN, `top off-screen at pointer (${x},${y}): ${p.top}`);
    assert.ok(p.left + MENU_W <= VW - VIEWPORT_MARGIN,
      `right edge past viewport at pointer (${x},${y}): ${p.left + MENU_W} > ${VW - VIEWPORT_MARGIN}`);
    assert.ok(p.top + MENU_H <= VH - VIEWPORT_MARGIN,
      `bottom edge past viewport at pointer (${x},${y}): ${p.top + MENU_H} > ${VH - VIEWPORT_MARGIN}`);
    checks += 4;
  }
}

// The pre-fix behaviour must be genuinely DIFFERENT, or the check above is vacuous
// (it would pass on a build that ignored the clamp entirely for small menus).
const corner = popupPosition({ left: VW, right: VW, top: VH, bottom: VH }, MENU_W, MENU_H, VW, VH);
assert.notDeepEqual(corner, { left: VW, top: VH },
  "the corner case must MOVE the menu; if it equals the raw pointer the clamp is not running");
checks++;

// ── (3) ONE MARGIN, not three ────────────────────────────────────────────────
// Dropdown.svelte (d60ebae, 2026-05-11) and GalleryPopup both declared `6` with the
// same justification; GalleryPopup's own comment cited Dropdown as precedent. The
// two app-side copies collapsed into this export. Dropdown keeps its own by the
// src/lib standalone-contract rule and is deliberately not asserted here.
assert.equal(VIEWPORT_MARGIN, 6, "the shared viewport margin");
checks++;

console.log(`popover_placement_test: ${checks} checks passed`);
