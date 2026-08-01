/**
 * THE HEADLESS POPOVER KIT — the three things every floating surface in this
 * library and its host apps had hand-rolled, and nothing else.
 *
 * HEADLESS means exactly what it says: this module renders no DOM of its own,
 * imposes no class, no token, no radius and no z-index. It owns PLACEMENT MATH,
 * a REPARENT action, and the WHILE-OPEN LISTENER LIFECYCLE. Presentation stays
 * with the consumer, which is why an app whose chrome is square and a library
 * component with its own rounded surface can both use it unchanged.
 *
 * ── WHY src/lib AND NOT THE HOST APP ─────────────────────────────────────────
 * This file is the promotion of PowerRP's web/popoverPlacement.js, which said in
 * its own docblock that a future headless Popover was its intended third
 * consumer. It could not be: a src/lib component may not import from a host app
 * (the standalone contract — src/lib has zero imports from any demo app), so
 * Dropdown.svelte was made to keep a duplicate VIEWPORT_MARGIN with a comment
 * saying so. Moving the math HERE is what retires that duplicate, and it is the
 * only direction that lets library and app share one answer.
 *
 * The old file's reasoning about why the math does not belong in a renderer's
 * geometry layer still holds and is worth keeping: this is SCREEN space — CSS
 * pixels, `window.innerWidth`, the physical edge of a browser viewport. A
 * headless renderer has no viewport, so the concept does not exist there. The
 * placement half is DOM-FREE (numbers in, numbers out) without being
 * DOCUMENT-space, and those are different properties.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * A `Popover.svelte` COMPONENT. Measured across the host app, the surfaces that
 * would consume one disagree on everything a component would have to fix: a
 * dropdown menu matches its trigger's width and caps its own height (so it
 * SCROLLS rather than moves), a tooltip centres on its anchor with a gap, a
 * context menu is anchored to a pointer with no trigger at all, and two pickers
 * are CSS-anchored inside their own row and never portal. A component covering
 * all of that is a configuration surface, not an abstraction. Three small seams
 * with real consumers beat one component with none.
 *
 * ── THE ENFORCEMENT ──────────────────────────────────────────────────────────
 * The @examples below are not executed by any doctest runner (PowerRP's scans
 * core/plugins/render_gpu/cli; src/lib is outside its tree entirely). That is not
 * hypothetical harm: two of the four examples this placement function originally
 * shipped with were arithmetically WRONG and read as authoritative until someone
 * ran them. So they are pinned as real assertions in the host app's
 * tests/popover_placement_test.js, and tests/popover_kit_test.js fails if any of
 * these three seams is reinvented elsewhere.
 */

/**
 * The gap kept between a floating surface and the viewport edge — a hairline so
 * the "never clipped" invariant has slack for sub-pixel rounding.
 *
 * ONE declaration. This value with this justification had been written three
 * times: Dropdown.svelte (2026-05-11, the oldest and the one the others cited),
 * GalleryPopup.svelte, and PowerRP's web/popoverPlacement.js. All three now read
 * this.
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
 * // {left: 874, top: 70} — right edge clamped to viewportW - width - VIEWPORT_MARGIN
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
 * // a pointer-anchored menu with no clamp had no answer for, clamped on both axes.
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

/**
 * Svelte action. Command — reparents `node` to `document.body` on mount and
 * removes it on destroy. Mutates the DOM and nothing else.
 *
 * WHY A SURFACE NEEDS THIS: `position: fixed` escapes an ancestor's SCROLL but
 * not its `overflow: hidden` — a fixed box inside a clipped pane is still
 * clipped at the pane edge. Reparenting to the body is the only way out that
 * does not require every ancestor to cooperate. A surface that is NOT inside a
 * clipping ancestor does not need this and should not use it: leaving the node
 * where it is keeps focus order and event bubbling intact.
 *
 * This was byte-identical in two places before it was one — Modal.svelte and a
 * host app's gallery popup, the second citing the first as precedent in a
 * comment. Both now import it.
 *
 * @param {HTMLElement} node - the element to move to document.body
 * @returns {{destroy: function}} Svelte action handle
 *
 * @example
 * // <div class="my-popup" use:portal style:left="{pos.left}px">…</div>
 * // mounts as a child of <body> however deep in the tree it is written,
 * // and is removed from <body> when the {#if} that renders it goes false
 */
export function portal(node) {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}

/**
 * Command. Installs the WHILE-OPEN listener set an anchored floating surface
 * needs, and returns the teardown. Registers nothing else and renders nothing;
 * the caller supplies every policy decision as a callback.
 *
 * The three listeners, and why each is the phase it is:
 *
 *  1. `scroll` on window, CAPTURE — a scroll event fired by an element DOES NOT
 *     BUBBLE, so a bubble-phase window listener sees only the document scrolling
 *     and is blind to every scrolling pane in the app. That is not a theory: it
 *     is why this seam exists. Dropdown.svelte wrote the reason down in a comment
 *     and used capture; a later surface twenty files away registered the same
 *     intent in bubble phase, and its follow-the-anchor behaviour — the thing its
 *     own docblock said it existed for — never fired once. Capture here makes
 *     that mistake unrepresentable.
 *  2. `resize` on window — plain, because resize only ever fires at the window.
 *  3. `pointerdown` on document, CAPTURE — an outside press must dismiss even
 *     when the thing pressed stops propagation, which handlers on a canvas or a
 *     drag surface routinely do. A bubble listener silently loses those presses
 *     and leaves the surface open over a UI the user has already moved on from.
 *
 * FOLLOW, DO NOT CLOSE, ON SCROLL. Closing on scroll is the textbook behaviour
 * and it is wrong here: opening a fixed surface can itself perturb an ancestor's
 * scroll (measured: a panel body bounced 584 → 714 → 584 px as a menu mounted),
 * and that spurious scroll is indistinguishable from a real one at the event. So
 * the surface tracks its anchor; an outside press, Escape or a pick closes it.
 *
 * @param {object} o
 * @param {() => Element|null|undefined} o.anchor - the element the surface is glued
 *   to. A getter, not an element, so a binding that resolves after this runs is
 *   still seen. Only a scroll of one of its ANCESTORS moves it.
 * @param {(target: EventTarget) => boolean} o.ownsScroll - true when a scroll
 *   event's target is the surface scrolling ITSELF (a long menu list, a tile
 *   grid). Such a scroll must not reposition anything.
 * @param {(target: EventTarget) => boolean} o.ownsPress - true when a pointerdown
 *   belongs to the surface or to its trigger, and so must not dismiss. Left to
 *   the caller because the correct set genuinely differs: an in-tree menu tests
 *   one wrapper that holds both, while a portalled surface must test the surface
 *   and its remote anchor separately.
 * @param {() => void} o.reposition - recompute and write the surface's position.
 *   Called once immediately, then on every qualifying scroll and every resize.
 * @param {() => void} o.dismiss - close the surface (an outside press happened).
 * @param {(() => void)} [o.onOwnScroll] - optional, runs when `ownsScroll` was
 *   true. A menu that previews the row under a stationary pointer needs to
 *   re-hit-test here, because a scroll fires no pointermove.
 * @returns {() => void} teardown — removes all three listeners. Call it from the
 *   cleanup of the effect that opened the surface.
 *
 * @example
 * // $effect(() => {
 * //   if (!open) return;
 * //   return trackAnchoredSurface({
 * //     anchor: () => triggerEl,
 * //     ownsScroll: (t) => menuEl?.contains(t),
 * //     ownsPress: (t) => rootEl?.contains(t),
 * //     reposition: positionMenu,
 * //     dismiss: closeMenu,
 * //     onOwnScroll: rehoverUnderPointer,
 * //   });
 * // });
 * // While open: the menu follows `triggerEl` through any pane scroll or window
 * // resize, and a press anywhere outside `rootEl` closes it. When `open` goes
 * // false the effect's cleanup runs the returned teardown and no listener
 * // outlives the menu.
 */
export function trackAnchoredSurface({
  anchor,
  ownsScroll,
  ownsPress,
  reposition,
  dismiss,
  onOwnScroll
}) {
  function onScroll(e) {
    if (ownsScroll(e.target)) {
      onOwnScroll?.();
      return;
    }
    // `document` is not an Element and has no contains(); its scrolling box is
    // the root element. Any other target is already the scrolling element.
    const scroller = e.target === document ? document.documentElement : e.target;
    if (scroller?.contains?.(anchor())) reposition();
  }
  function onPress(e) {
    if (!ownsPress(e.target)) dismiss();
  }
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", reposition);
  document.addEventListener("pointerdown", onPress, true);
  reposition();
  return () => {
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", reposition);
    document.removeEventListener("pointerdown", onPress, true);
  };
}
