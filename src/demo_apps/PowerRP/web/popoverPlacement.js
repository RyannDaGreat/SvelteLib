/**
 * Pure placement math for VIEWPORT-ANCHORED floating surfaces (no DOM access).
 *
 * The naming and the shape follow web/videoV7Placement.js ("Pure placement math
 * … no DOM access", 68c3d7e) and web/videoV6Layout.js — the house idiom for a
 * DOM-free geometry helper that lives on the WEB side rather than in core/.
 *
 * ── WHY web/ AND NOT core/geometry.js ────────────────────────────────────────
 * core/ is DOM-free and must run in bare node, and core/geometry.js is
 * DOCUMENT-SPACE math — world coordinates, boxes a widget occupies, things a
 * headless render has an opinion about. This is SCREEN space: CSS pixels,
 * `window.innerWidth`, the physical edge of a browser viewport. A renderer has
 * no viewport, so this concept does not exist there. Putting it in core/ would
 * put a browser-only idea in the layer whose whole contract is not knowing what
 * a browser is. It is DOM-FREE (it takes numbers and returns numbers) without
 * being DOCUMENT-space, and those are different properties.
 *
 * ── WHY IT IS SHARED ─────────────────────────────────────────────────────────
 * Two real consumers today — web/GalleryPopup.svelte (which authored this math
 * and whose four @examples came with it) and web/ContextMenu.svelte, which had
 * NO clamp at all and put its menu off-screen on a right-click near the right or
 * bottom edge. A future headless Popover component is the intended THIRD
 * consumer: whoever builds it should find this and not write a third clamp. That
 * is the whole reason this file exists rather than a second copy of the formula.
 *
 * ── A GAP WORTH KNOWING, AND IT ALREADY BIT ──────────────────────────────────
 * The @examples below are NOT executed by the gate. tests/doctest_test.js scans
 * SEARCH_DIRS = ["core", "plugins", "render_gpu", "cli"] (:91) — `web/` is not in
 * it, so none of the ~23.7k lines of JS under web/ is doctested. That was already
 * true while this math lived in a .svelte file, and moving it here does not fix it.
 *
 * TWO OF THE FOUR EXAMPLES THAT CAME WITH THIS FUNCTION WERE WRONG, which is what
 * an unexecuted doctest is for. Run against the real code: the flip case claimed
 * `top: 384` and produces `390` (it subtracted VIEWPORT_MARGIN that the flip branch
 * never applies), and the hardest case claimed `top: 294` and produces `200` — its
 * PREMISE was false, asserting "NEITHER side has 500px (below: 80, above: 700)"
 * when 700 >= 500 plainly fits, so it also described a no-flip behaviour the code
 * does not have. Both are corrected below and the second is replaced by a case
 * that genuinely cannot fit (a surface taller than the viewport). The arithmetic
 * of all five is now verified against the implementation.
 * Because these are unreachable by the gate, tests/popover_placement_test.js pins
 * them as real assertions — that file, not this docblock, is the enforcement.
 */

/**
 * The gap kept between a floating surface and the viewport edge — a hairline so
 * the "never clipped" invariant has slack for sub-pixel rounding.
 *
 * ONE declaration, because this had already been written three times with the
 * same value and the same justification: src/lib/Dropdown.svelte:136 (d60ebae,
 * 2026-05-11 — the oldest, and the one GalleryPopup's comment explicitly cited as
 * "same value, same purpose"), and GalleryPopup.svelte's own copy. Dropdown is a
 * src/lib component and keeps its own by the standalone-contract rule (a library
 * component may not depend on the host app's modules); the two APP-side copies
 * collapse into this one.
 */
export const VIEWPORT_MARGIN = 6;

/**
 * Pure function. The fixed-position CSS box for a surface anchored to a rect,
 * clamped so it never spills past the viewport: below the anchor by default,
 * flipped above when there is no room below and above has more; both axes
 * clamped to keep every edge on-screen.
 *
 * A POINTER position is the degenerate case — pass a zero-size rect at the
 * cursor (`{left: x, right: x, top: y, bottom: y}`) and the same rules give
 * correct menu behaviour: open down-right of the cursor, flip up near the
 * bottom, slide left near the right edge.
 *
 * @param {{left:number, right:number, top:number, bottom:number}} anchorRect
 * @param {number} width - requested surface width
 * @param {number} height - requested surface height
 * @param {number} viewportW
 * @param {number} viewportH
 * @returns {{left:number, top:number}}
 *
 * @example popupPosition({left:100, right:120, top:50, bottom:70}, 320, 360, 1200, 800)
 * // {left: 100, top: 70} — plain case: below-left of the anchor, everything fits
 * @example popupPosition({left:1000, right:1020, top:50, bottom:70}, 320, 360, 1200, 800)
 * // {left: 874, top: 70} — right edge clamped to viewportW - VIEWPORT_MARGIN
 * @example popupPosition({left:100, right:120, top:750, bottom:770}, 320, 360, 1200, 800)
 * // {left: 100, top: 390} — no room below (800-770=30 < 360); flips above the
 * // anchor, so top = anchor.top - height = 750 - 360.
 * @example popupPosition({left:100, right:120, top:400, bottom:420}, 320, 900, 1200, 800)
 * // {left: 100, top: 6} — the surface is TALLER THAN THE VIEWPORT (900 > 800), so
 * // neither side can hold it and flipping cannot help. The vertical clamp pins it
 * // to VIEWPORT_MARGIN rather than letting the top edge run off-screen; the bottom
 * // still overflows, which is unavoidable at this size and is the honest outcome.
 * @example popupPosition({left:1190, right:1190, top:790, bottom:790}, 150, 200, 1200, 800)
 * // {left: 1044, top: 590} — a right-click in the bottom-right CORNER: the case
 * // ContextMenu had no answer for, clamped on both axes at once.
 */
export function popupPosition(anchorRect, width, height, viewportW, viewportH) {
  const spaceBelow = viewportH - anchorRect.bottom;
  const spaceAbove = anchorRect.top;
  const flipUp = spaceBelow < height && spaceAbove > spaceBelow;
  const rawTop = flipUp
    ? anchorRect.top - height
    : anchorRect.bottom;
  // VERTICAL CLAMP — the horizontal clamp's missing twin. Flipping alone only
  // picks the side with MORE room; when neither side actually holds the full
  // height (a surface taller than the viewport, or an anchor with little room on
  // either side), the un-clamped math still placed a box whose bottom edge ran
  // past viewportH — MEASURED: an anchor near mid-viewport with height=360
  // rendered a popup extending 84px past the bottom, taking its resize grips
  // off-screen where no pointer event could ever reach them (the corner grips'
  // whole reason to exist). Clamping BOTH edges is what "attempt to fill to
  // that size" (user) means for a size the viewport genuinely cannot hold.
  const top = Math.min(
    Math.max(VIEWPORT_MARGIN, rawTop),
    Math.max(VIEWPORT_MARGIN, viewportH - height - VIEWPORT_MARGIN),
  );
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, anchorRect.left),
    viewportW - width - VIEWPORT_MARGIN,
  );
  return { left, top };
}
