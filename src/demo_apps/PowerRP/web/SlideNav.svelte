<!--
  SlideNav — the left-hand slide navigator. Shows display NUMBERS (which
  shift on insert) while slides keep permanent UUIDs underneath.

  Between each pair of slide rows sits a TRANSITION SLICE — a small, first-class
  SELECTABLE thing (manifest Round 12): clicking it selects the transition INTO
  the lower slide, whose properties then show in the Property Panel. The slice
  above slide 1 is the first real transition (slide 0 has no predecessor).

  THE SLICE IS THE TRANSITION CHIP, ALONE, in a role="group" band that owns the
  hover state. It was briefly THREE hit targets — an insert-a-slide `+` at each
  end around the chip — and the user RETRACTED that feature the day after asking
  for it (2026-08-02): "the insert a slide here up and down buttons that we have
  near the tween line… I made a mistake that feature should never have existed we
  can get rid of that just just tween is fine we don't need those extra up and
  down add slide up and add slide down buttons on either side of tween 0.5… we
  can get rid of the up plus and down plus buttons here." The retraction is of the
  two BUTTONS; app.insertSlideAtBoundary remains available to the action layer.

  THE CHIP IS ALWAYS VISIBLE (user correction, 2026-08-02, after the first version
  hid it): "I don't see tween 0.5 seconds unless I hover over it now, which is not
  ideal… The tween thing should always be there." The band's hover surface is THE
  WHOLE GAP, not the chip — "The hover area should be the entire in between of the
  slides, not just a small subset" — and now that nothing is hover-REVEALED, that
  surface only lights the band, saying the chip is a control.

  THE RAIL ALSO OWNS FOUR GESTURES BEYOND CLICK-TO-NAVIGATE:
    · DRAG-TO-REORDER — pointer capture on a row, a BOUNDARY (gap index) as the
      drop target, one undo unit per drop, through core withSlidesMovedToBoundary
      so the appearance law holds. Never a naive splice. What it LOOKS like is
      ruled separately (user: "make it literally drag the slide"): the row travels
      with the pointer as a fixed-position ghost, its own slot goes empty, the
      others slide aside over 0.3s, and the boundary goes BOLD without the rail
      ever changing height — see the drag note in the script.
    · MULTI-SELECT of ROWS — plain / shift-range / cmd-toggle, resolved by
      app.selectSlideAt. Rendered on TWO axes: `current` keeps the border (the one
      slide the canvas shows), `selected` takes a background tint (membership).
    · MULTI-SELECT of TRANSITIONS — the same three gestures on the chips, resolved
      by app.selectTransitionAt (user: "I should be able to shift click multiple
      tweens too… It's exactly the same idea"), and rendered on the same two axes.
    · THE SLIDE CLIPBOARD — Copy/Paste/Duplicate/Delete Slide(s), registered
      commands, and the same Ctrl+C/V, Cmd+D and Backspace chords the canvas uses
      but scoped to RAIL FOCUS (core/shortcut_entries.js slideRailFocus), because
      there are two clipboards and one chord may not mean both.

  IT HAS TWO LAYOUTS, LIST AND GRID, and they are ONE component because they are
  one model: the same linear order, the same boundary-index drops, the same
  two-axis selection (current = ring, selected = tint), the same DirtyImage
  thumbnails, the same rename/clipboard/chords. What differs is where a slot is
  drawn and where the transition is drawn — see the view-mode note in the script
  for the user's problem statement ("The slides just become enormous"), and the
  spine note for why a grid tile wears its own transition on its LEFT edge.
  LIST VIEW IS UNCHANGED BY THAT WORK, deliberately and by user ruling — it
  "visually *looks* clean", so the grid was added strictly beside it, down to the
  cell wrapper being `display: contents` in list view so the rail's boxes are the
  boxes it already had.

  THE FOOTER IS FIVE BUTTONS AND OWNS NONE OF THEIR ICONS. It is a surfacing of
  the command registry like any other, so it READS `app.commands.get(id).icon`
  rather than writing glyphs of its own — see the FOOTER_COMMANDS note in the
  script for the two user rulings that shaped the set, and for the drift that
  made reading rather than copying the point. Duplicate is registered and
  chorded, but it is NOT a button here: New Slide After Current already does it.

  RENAME IS A DIALOG, NOT AN INLINE EDITOR, and the row owns the double-click that
  opens it. The reason is a real bug worth knowing before touching either gesture
  — pointer capture retargets the dblclick away from the name span — and it is
  written out at the rename note in the script.

  Thumbnails use the generic DirtyImage widget (src/lib): each renders THROUGH
  its slide's camera, at the size it's DISPLAYED (panel width × dpr) so it's
  crisp, and only when it's on screen AND dirty (scales to "5 million slides" —
  manifest: only the handful scrolled into view ever repaint).

  Editing is NON-BLOCKING and PER-SLIDE-dirty (thumbSchedule.js):
    · PER-SLIDE KEYS — each thumbnail's dirty key is the cumulative fold of
      deltas 0..i (+ enabled + meta + imageEpoch), not the whole document. Slide
      deltas fold FORWARD and are reference-stable under structural sharing, so
      editing slide N re-keys ONLY slides >= N (editing the last slide repaints
      one thumbnail; only editing slide 0 repaints all).
    · DEBOUNCED — a burst of commits coalesces into ONE render of the final
      state (published after THUMB_SETTLE_MS of quiet), never one per keystroke.
    · RATIONED — dirty renders drain at most THUMBS_PER_IDLE_TICK per idle/rAF
      tick, off the critical path, so a burst never freezes input; each tile
      keeps showing its last render until its turn.
    · GESTURE-HELD — while a gesture is in flight (thumbRenderPaused: a canvas
      drag, an Inspector scrub, a picker, a preset hover) NO thumbnail renders at
      all; the queue drains on release, so the tile is correct once the gesture
      settles. Two gates, because they cover different holes: the dirty-key
      freeze stops the gesture DIRTYING tiles, the queue hold stops an
      already-queued or scrolled-into-view render rastering mid-drag.
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import DirtyImage from "../../../lib/DirtyImage.svelte";
  import { resolveTransition, transitionType } from "../core/transitions.js";
  import { formatSeconds } from "./formatSeconds.js";
  import { renderCameraFrame } from "./gpuService.js";
  import { cameraRectAt } from "./cameraFrame.js";
  import { onImageLoad } from "../render_gpu/gpu/image_registry.js";
  import { onSvgSourceLoad } from "../render_gpu/gpu/svg_source_registry.js";
  import { onTextAssetLoad } from "../render_gpu/gpu/text_asset_registry.js"; // CSV/JSON data assets a chart widget plots (core/plugin_assets.js assetText)
  import { makeSerialSource, thumbnailDirtyKeys, makeIdleThumbScheduler, browserTickDeps, thumbRenderPaused } from "./thumbSchedule.js";
  import { browserModeSetting } from "./settings.js";

  let { app } = $props();

  // ── THE VIEW MODE: LIST OR GRID ─────────────────────────────────────────────
  // User, 2026-08-02, and the problem is stated exactly: "Sometimes, if I want to
  // view many slides, I try to make the slides panel bigger. But here's what
  // happens. The slides just become enormous. It would be nice if there was a
  // second option for viewing slides. That would make it a tiled thumbnail
  // display exactly how the asset explorer panel is working. And that could be a
  // toggle button on the bottom where it shows delete slide, move slide down,
  // move slide up."
  //
  // WHAT THE COMPLAINT IS ABOUT, precisely: in LIST view a wider panel spends
  // every extra pixel on ONE column, so widening to see MORE slides shows FEWER.
  // Grid view spends the same pixels on COLUMNS — the tile stays roughly a
  // thumbnail's natural size and the count per screen goes up with the width.
  // That is also why the grid tiles keep rendering at their DISPLAYED size
  // through the same DirtyImage machinery (this file's header): more columns is
  // more small thumbnails, which is exactly the load thumbSchedule's ration and
  // its per-slide dirty keys were built for. Nothing new is needed to scale it.
  //
  // IT IS A BROWSER PREFERENCE, NOT DOCUMENT STATE. Which way one viewer likes to
  // look at a deck is not a fact about the deck: it is not in the document, it is
  // not keyframeable, it does not travel in a share link, and two people opening
  // the same project may disagree without either being wrong. So it lives in the
  // settings repo beside minimap/grid/ruler, on the same localStorage idiom.
  //
  // COMPONENT-LOCAL, deliberately, unlike showBuiltinAssets. A setting goes on the
  // app object when something OUTSIDE its panel reads it — a command, a shortcut,
  // another component. Nothing outside this rail has any business knowing how the
  // rail is laid out, so putting it on PowerRPApp would widen the app's surface for
  // one component's private layout choice. The Asset Explorer's own toggle is
  // local for the same reason. If a command ever needs to flip the view, THAT is
  // the moment it earns an app field.
  const VIEW_SETTING = browserModeSetting("powerrp.slideNavView", ["list", "grid"]);
  let viewMode = $state(VIEW_SETTING.initial);
  let isGrid = $derived(viewMode === "grid");

  /** Command. Flips list ↔ grid and persists the choice for this browser. */
  function toggleViewMode() {
    viewMode = VIEW_SETTING.persist(VIEW_SETTING.next(viewMode));
  }

  // Thumbnail scheduling knobs (named — no magic numbers).
  // How long edits must SETTLE before thumbnails re-render: a burst of commits
  // (numeric scrub, rapid keyframing) folds into ONE render of the final state
  // instead of one render per commit. Below the ~150ms "feels instant" bar, yet
  // long enough to swallow frame-rate (16ms) commit bursts.
  const THUMB_SETTLE_MS = 120;
  // Max thumbnails to render per idle/rAF tick. Each render is a synchronous
  // CanvasKit raster + readback; rationing to a small N per tick keeps the main
  // thread responsive during a burst (the rest wait, showing their last render).
  const THUMBS_PER_IDLE_TICK = 2;

  // Media (images) decode ASYNCHRONOUSLY, AFTER the commit that added the
  // widget — so a thumbnail rendered at commit time draws the image as nothing
  // (getSkiaImage returns null until decoded). onImageLoad bumps this epoch when
  // a decode lands; it's folded into the thumbnails' dirty key below so the
  // visible ones re-render and pick the image up — the SAME async-repaint nudge
  // CanvasView uses for the main canvas. Video frames are deliberately NOT folded
  // in (a playing clip must not re-render thumbnails every frame; a video's
  // poster refreshes on the next commit).
  let imageEpoch = $state(0);
  $effect(() => onImageLoad(() => (imageEpoch += 1)));
  // URL-sourced SVG text lands the same way (svg widget, url mode) — fold it
  // into the same epoch so thumbnails pick the vector art up when it arrives.
  $effect(() => onSvgSourceLoad(() => (imageEpoch += 1)));
  // A TEXT DATA asset (the CSV behind a chart) lands the same way — same epoch, so
  // a thumbnail rendered before the data arrived is redrawn with its bars.
  $effect(() => onTextAssetLoad(() => (imageEpoch += 1)));

  // Per-type icon for the between-rows slice (iconify only — manifest rule).
  // A third type adds one entry; unknown types fall back to a generic glyph.
  const TRANSITION_ICONS = { tween: "mdi:transition", fade: "mdi:transition-masked" };

  /** Camera rect of slide `i` at full alpha (the thumbnail's view + aspect).
      Evaluated state: the camera's own properties may be equations. */
  function slideRect(i) {
    return cameraRectAt(app.doc, i, 1, app.registry);
  }

  /** Thumbnail aspect (h/w) for slide `i`, or null when the camera is degenerate
      (no positive-area rect → no thumbnail). */
  function thumbAspect(i) {
    const rect = slideRect(i);
    return rect.w > 0 && rect.h > 0 ? rect.h / rect.w : null;
  }

  /**
   * render() for slide `i`'s thumbnail: paints the committed slide state through
   * its camera at the REQUESTED device-pixel size — displayed-size × dpr, so it
   * is exactly as crisp as the panel shows it (no fixed-256px upscale). Returns
   * a canvas; DirtyImage turns it into the <img>. Renders committed state only
   * (never the live drag preview), so a drag can't trigger thumbnail repaints.
   *
   * quality:"proxy" — thumbnails are ~100px, where the dither final pass and the
   * glass/material/magnify backdrop machinery (below-content re-render + full-
   * screen blur + SkSL) are invisible yet the dominant per-thumbnail cost. Proxy
   * skips all of it for a cheap-but-faithful preview; the editor/export/presenter
   * stay full quality (default).
   */
  function renderThumb(i) {
    // Async (GPU readback) — DirtyImage awaits the promise and drops stale
    // resolutions; wPx/hPx are already device px.
    return (wPx, hPx) =>
      renderCameraFrame(app.doc, { slideIndex: i, alpha: 1, registry: app.registry, width: wPx, height: hPx, quality: "proxy", project: app.projectName() });
  }

  /** The resolved transition INTO slide `i` (i > 0), for the slice label/icon. */
  function transitionInfo(i) {
    const t = resolveTransition(app.doc, i);
    return { type: t.type, seconds: t.seconds, title: transitionType(t.type).title };
  }

  // ── THE GRID'S TRANSITION PILL: A BOOK SPINE ON THE TILE'S LEFT EDGE ────────
  // WHOSE TRANSITION IS IT — the ruling that made the grid expressible at all
  // (user, verbatim, 2026-08-02): "the tween chips where DO they go....well they
  // belong to the slide they come in with right? does that realization help?" It
  // did. `transition` is a FIELD ON THE SLIDE it enters (core/document.js), so a
  // tile can wear its OWN incoming transition and nothing has to be drawn "between"
  // two cells in a wrapping layout — the list's placement of the chip in the GAP
  // was always presentation, never where the data lived.
  //
  // WHICH EDGE (user, verbatim): "why not the left edge when in tile view?" +
  // "u can just rotate the thing 90 degrees including rotating text right". So the
  // pill is the list's chip ROTATED: writing-mode vertical, ⛓ at the top, text
  // reading downward, straddling the tile's left edge (half over the thumbnail,
  // half in the gutter). The unified rule is one sentence — THE PILL SITS ON THE
  // EDGE THE FLOW ENTERS FROM: the top edge in a vertical list, the left edge in a
  // row-major grid. Left also wins on DENSITY, which is what grid view exists for:
  // a top pill spends the vertical space the grid is trying to save, while a left
  // pill spends horizontal space the gutter already had.
  //
  // IT IS THE SAME SELECTION OBJECT, not a lookalike. Clicking a pill runs the
  // same app.selectTransitionAt(slide.id, …) the list's chip runs, with the same
  // shift/cmd multi-select, and it renders on the same two axes (.selected tint,
  // .primary text) from the same tokens. So a transition selected in grid view is
  // still selected after a toggle to list, and the Property Panel cannot tell
  // which view made the selection.
  //
  // SLIDE 1 HAS NO PILL — a bare edge, because slide 0 has no predecessor and
  // therefore no incoming transition. Same fact the list expresses by having no
  // slice above its first row.

  // CONDENSATION — how much of the pill's sentence fits, by the tile's HEIGHT
  // (the pill is vertical, so its text runs along the tile's height, and height is
  // what constrains it). Three steps, the user's own (2026-08-02): "⛓ Tween · 0.5s
  // → ⛓ 0.5s → ⛓". Thresholds are the px of tile height at which each longer form
  // stops fitting, measured against the pill's own font size.
  // ALWAYS VISIBLE AT EVERY SIZE — never hover-only, which is a STANDING ruling
  // this file already carries for the list chip ("The tween thing should always be
  // there"); condensing is how it stays visible when it cannot stay whole, and the
  // full sentence never disappears because the TOOLTIP always carries it.
  const PILL_FULL_MIN_H = 128; // ⛓ Tween · 0.5s fits above this tile height
  const PILL_SECONDS_MIN_H = 76; // ⛓ 0.5s fits above this; below it, the icon alone

  /** Measured tile height (px) — the axis the vertical pill's text runs along, so
   *  the input to the condensation above. Null until the grid has laid out. */
  let tileHeightPx = $state(null);

  /**
   * Pure function. The pill's text at a given tile height — the condensation
   * ladder, as one greppable table rather than nested ternaries in the template.
   * The ⛓ ICON is not here: it renders at every step (it is the step below the
   * shortest text), so it belongs to the markup, not to the label.
   *
   * @param {{title: string, seconds: number}} info A transitionInfo() result.
   * @param {number|null} heightPx Measured tile height; null before first layout.
   * @returns {string} The label, "" when only the icon fits.
   *
   * @example pillLabel({title: "Tween", seconds: 0.5}, 200)
   * 'Tween · 0.5s'
   * @example pillLabel({title: "Tween", seconds: 0.5}, 100)
   * '0.5s'
   * @example pillLabel({title: "Tween", seconds: 0.5}, 60)
   * ''
   * @example // Before the first measurement, assume the roomiest form.
   * @example pillLabel({title: "Fade", seconds: 1}, null)
   * 'Fade · 1s'
   * @example // Display caps at 3 decimals — the stored value stays exact.
   * @example pillLabel({title: "Tween", seconds: 2.9800000000000004}, null)
   * 'Tween · 2.98s'
   */
  function pillLabel(info, heightPx) {
    if (heightPx === null || heightPx >= PILL_FULL_MIN_H) return `${info.title} · ${formatSeconds(info.seconds)}`;
    if (heightPx >= PILL_SECONDS_MIN_H) return formatSeconds(info.seconds);
    return "";
  }

  // While a GESTURE is in flight we FREEZE the committed doc (a drag preview lives
  // in previewDelta, not app.doc — thumbnails show committed state only, never at
  // drag rate). thumbRenderPaused(app) is the ONE gesture predicate, shared with
  // the queue hold below: previewDelta alone missed the pointer-down→first-move
  // window and every preview-less gesture (band select, placement).
  // svelte-ignore state_referenced_locally — the initial value is immediately
  // reconciled by the effect below (no gesture is in flight at mount).
  let committedDoc = $state(app.doc);
  $effect(() => {
    if (!thumbRenderPaused(app)) committedDoc = app.doc;
  });

  // PER-SLIDE DIRTY KEYS. The old key was the WHOLE-document identity, so every
  // commit dirtied EVERY visible thumbnail. Instead, key each slide on the
  // cumulative fold of deltas 0..i (+ enabled flags + meta + imageEpoch): a
  // reference-stable serial per delta object means editing slide N re-keys ONLY
  // slides >= N (structural sharing — core/document.js keyframed). serialOf lives
  // for the component's life so identities stay comparable across commits.
  const serialOf = makeSerialSource();
  let liveKeys = $derived(thumbnailDirtyKeys(committedDoc, imageEpoch, serialOf));

  // DEBOUNCED PUBLICATION. Tiles see `publishedKeys`, not `liveKeys` — republished
  // only after edits SETTLE (THUMB_SETTLE_MS), so a burst of commits coalesces into
  // one render of the final state. Scroll-in renders stay prompt (they key off the
  // already-published value, not a fresh commit). Initialized to liveKeys so the
  // first paint is immediate.
  // svelte-ignore state_referenced_locally — seeded once; the effect below keeps it in sync.
  let publishedKeys = $state(liveKeys);
  let publishTimer = 0;
  $effect(() => {
    liveKeys; // subscribe to commits + image-decode epochs
    // Cleanup runs before each re-run (and on destroy), clearing the prior
    // timer — so successive commits keep pushing publication back until quiet.
    publishTimer = setTimeout(() => (publishedKeys = liveKeys), THUMB_SETTLE_MS);
    return () => clearTimeout(publishTimer);
  });

  // OFF-MAIN-THREAD RENDER RATIONING. A shared idle-batched scheduler drains at
  // most THUMBS_PER_IDLE_TICK thumbnail renders per idle/rAF tick, so publishing a
  // key (which dirties every visible tile at once) never fires N synchronous
  // CanvasKit rasters in one flush. Disposed on unmount.
  const thumbScheduler = makeIdleThumbScheduler({ ...browserTickDeps(), perTick: THUMBS_PER_IDLE_TICK });
  $effect(() => () => thumbScheduler.dispose());

  // GESTURE HOLD. The dirty-key freeze above stops a gesture from DIRTYING tiles,
  // but a run already queued when the gesture began — or a tile scrolled into view
  // mid-gesture, which is dirty on size alone — would still raster while the user
  // drags. So hold the queue itself for the whole gesture and drain on release:
  // zero thumbnail renders mid-drag, one render of the settled state after.
  $effect(() => thumbScheduler.setPaused(thumbRenderPaused(app)));

  // Dev/test seam (mirrors window.__powerrp_app). Idle-scheduled work is INVISIBLE
  // to an attached profiler — keeping the main thread busy is exactly what starves
  // requestIdleCallback — so expose the scheduler: with a profile recording, call
  // window.__powerrp_thumbs.flush() to run every pending thumbnail render
  // synchronously as ONE attributable task (it ignores the ration and the gesture
  // hold). pending() reports the queue depth. Cleared on unmount so it never
  // dangles. ZERO production effect — nothing in the app reads it.
  $effect(() => {
    window.__powerrp_thumbs = thumbScheduler;
    return () => { if (window.__powerrp_thumbs === thumbScheduler) delete window.__powerrp_thumbs; };
  });

  // ── SLIDE RENAME — A DIALOG, NOT AN INLINE EDITOR ───────────────────────────
  // User ruling, 2026-08-02: "I'm not able to rename slides. I'm double clicking
  // the name and it won't let me edit the slide name" … "when I double click a
  // slide title, it should let me edit it. In the same way that rename project
  // does when I click that. A dialog comes up pre-selected and whatever process
  // for that should be reused for this."
  //
  // WHY THE INLINE EDITOR STOPPED WORKING, recorded because the fix had to avoid
  // inheriting it. `onRowPointerDown` calls setPointerCapture on the ROW for every
  // left pointerdown (the drag gesture needs it). Pointer capture RETARGETS the
  // rest of that sequence to the capturing element, so pointerup, click and
  // dblclick all arrived with target = the row. InlineRename listens on its
  // `.inline-rename-display` wrapper, which is `display: contents` — it has no box
  // of its own and can only be reached by the event BUBBLING UP from the name
  // span, which is precisely the path retargeting removes.
  //
  // MEASURED, not surmised, and the measurement is the lesson: a synthetic
  // dblclick dispatched straight at `.name` still opened the editor, which is why
  // tests/slide_rename_probe.js stayed green for a feature that was dead in the
  // user's hands; a real two-click mouse sequence did not; stubbing
  // setPointerCapture to a no-op restored it immediately. A probe that
  // synthesizes the event it wants instead of the gesture the user makes cannot
  // see this class of bug at all.
  //
  // THE DIALOG DOES NOT INHERIT IT because it opens from the ROW's own ondblclick
  // — the element capture retargets TO — instead of from a descendant the event
  // no longer reaches. That is also why this is not merely "InlineRename with the
  // guard widened": the ruling asked for the project-rename process, and it
  // sidesteps the retargeting problem by construction rather than by exclusion.
  //
  // All this file owns is the trigger; App.svelte owns the dialog and
  // app.renameSlide owns the write (ONE undo unit, blank restores the default).

  // ── THE TRANSITION SLICE'S HOVER STATE ──────────────────────────────────────
  // The slice once had three zones, from a user request the same user RETRACTED
  // a day later — see the header's quote. Only the chip is left, so all that
  // remains here is whether the band is lit.
  //
  // THE CHIP IS NOT HOVER-REVEALED, and that is a CORRECTION of what shipped
  // (user: "I don't see tween 0.5 seconds unless I hover over it now, which is
  // not ideal. It's only those new slide here buttons that should be appearing
  // when I slide over them. The tween thing should always be there."). So the
  // chip is ALWAYS visible. The earlier reading — that the user's "unless I'm
  // hovering over it, it should stay like a flat dash" covered the chip too —
  // was wrong: that sentence was about the band's CHROME, not about hiding the
  // transition's own label.
  //
  // THE `+` ENDS THIS HOVER STATE USED TO REVEAL ARE GONE, retracted by the user
  // on 2026-08-02 ("that feature should never have existed… we can get rid of
  // the up plus and down plus buttons here"), and with them `hoverZone`/`inZone`,
  // which existed only to tint whichever end was under the pointer. What remains
  // is one flag: the band still lights its connector lines and chip text when the
  // pointer or keyboard focus is anywhere in the gap, which is what tells a
  // reader the chip is a control at all. The hot surface stays THE WHOLE GAP
  // (user: "The hover area should be the entire in between of the slides, not
  // just a small subset") — one pointerenter/leave pair on the band, plus the
  // chip's own focus/blur so a Tab-focused chip lights the same way.
  let hotSliceId = $state(null); // slideId of the gap the pointer/focus is in, or null

  /** Query. Is the pointer/focus anywhere in slice `slideId`'s GAP? Lights the
   *  band — the whole inter-slide region is the hover surface. */
  function sliceHot(slideId) {
    return hotSliceId === slideId;
  }

  // ── DRAG TO REORDER ─────────────────────────────────────────────────────────
  // User: "I should also be able to drag slides … they would slide along that
  // vertical thing. And when in this mode, when I'm clicking and dragging it, the
  // horizontal line would be entirely there and would almost open when my mouse is
  // over it. And like maybe bold a little bit my mouse is under over one of those
  // boundaries between the slides."
  //
  // THE DROP TARGET IS A BOUNDARY, NOT A ROW — a gap index in 0..slides.length,
  // which is exactly what core withSlidesMovedToBoundary takes. A row index would
  // be ambiguous once the dragged rows are lifted out ("onto slide 3" means
  // something different depending on whether 3 is a mover); a gap does not move.
  //
  // POINTER EVENTS, NOT HTML5 DRAG-AND-DROP. The rail's rows are <button>s inside
  // Tooltip wrappers with a live thumbnail canvas inside them; the native drag
  // protocol would need a draggable attribute per row, a drag image, and a
  // dragover handler on every gap, and it fires no event at all until a platform
  // threshold is crossed. A pointer capture on the row gives the boundary math
  // directly from clientY, and it is the same gesture vocabulary the canvas uses.
  // WHAT A DRAG LOOKS LIKE — a full correction of the first version (user,
  // 2026-08-02): "When I'm dragging the slides, the space between the slides gets
  // bigger. No, I didn't want that. It should just be bold." · "my cursor have a
  // closed fist icon when I'm dragging" · "make it literally drag the slide… the
  // slide thumbnail so that it looks like I'm literally dragging it. You can leave
  // the old area empty, and then when I drag it into the new area, it can just
  // push the others out of the way and then move in. You can have a 0.3 second
  // animation for that using CSS."
  //
  // So four things replace the opening rail:
  //   1. THE BOUNDARY ONLY GOES BOLD. No height growth, no margin — the rail must
  //      not reflow under the cursor, which is what the user objected to.
  //   2. THE CURSOR IS A CLOSED FIST (`cursor: grabbing`, on the rail).
  //   3. THE DRAGGED ROW FOLLOWS THE POINTER as a lifted ghost — a real copy of
  //      the row, translated to the cursor — and its ORIGINAL SLOT GOES EMPTY
  //      (`.lifted`: kept in layout so the list does not collapse, but drawn as a
  //      hole).
  //   4. THE OTHER ROWS SLIDE OUT OF THE WAY to open the target slot, animated by
  //      a CSS transform transition of DRAG_SHIFT_MS. Transform, not margin or
  //      height: it composites, and it cannot reflow the rail (which is bullet 1).
  const DRAG_THRESHOLD_PX = 4; // below this a pointerdown is a CLICK, not a drag
  // How long a non-dragged row takes to slide aside — the user's own number
  // ("You can have a 0.3 second animation for that"). Read here and published to
  // CSS as a custom property so the two cannot drift.
  const DRAG_SHIFT_MS = 300;

  // {indices, startY, pointerY, moved, boundary, height, ghostX, grabDy} | null.
  // `height` is THE LIFTED BLOCK'S SLOT PITCH — how far the rows below must shift
  // to close over its slot. NOT the sum of its row heights; see slotPitch below
  // for the measurement that distinction cost. `grabDy` is where inside the row
  // the pointer grabbed, so the ghost sits under the cursor exactly where the row
  // was picked up rather than snapping its top to it.
  let dragState = $state(null);
  let slidesEl = $state(null); // the scroll container — boundary math is relative to its rows

  // ── TOOLTIPS ARE SUPPRESSED FOR THE DURATION OF A SLIDE DRAG ────────────────
  // User, verbatim (2026-08-03): "When I'm dragging slides, the hovering tooltip
  // should not be visible, but it is right now, in grid mode. It's also visible
  // in list view, but it shouldn't be visible either when I'm dragging the
  // slides, because it blocks my view of the slides."
  //
  // KEYED OFF THE DRAG STATE ITSELF, not a pointer heuristic or a hover timer —
  // `dragState?.moved` is the SAME flag `.slidenav.dragging` already reads (the
  // template's root div, below) to swap the cursor to a fist and freeze row
  // hover, so this is not a second notion of "mid-drag": it is the one the
  // gesture already owns, read again. `moved` (not merely `dragState` truthy) is
  // deliberate — a pointerdown that never crosses DRAG_THRESHOLD_PX is a CLICK,
  // and the tooltip must behave normally for that case (the row's own dblclick
  // dialog, the eye toggle, plain selection all still want it).
  //
  // WHY THIS ALSO COVERS "passing over other slides", not only the dragged row:
  // `onRowPointerDown` sets pointer capture on the grabbed row, so every
  // subsequent pointer event of that gesture — including pointerenter/leave on
  // OTHER rows — is retargeted to the capturing row and never reaches another
  // row's own Tooltip anchor. Only the DRAGGED row's Tooltip keeps receiving
  // events (capture targets a descendant of its own anchor), which is why it was
  // the one staying up and tracking the cursor. Suppressing on `dragActive`
  // covers both: the source row's tip (which would otherwise keep tracking the
  // pointer) and any other row's tip (belt-and-suspenders — capture already
  // starves them of the hover events that would open one).
  //
  // THE MERGE CHIP AND DROP-BOUNDARY BOLD LINE ARE NOT TOOLTIPS and are UNTOUCHED
  // by this flag — they are the drag's own affordances (isMergeTarget/
  // isDropBoundary render them independent of any Tooltip component), and the
  // user's OWN prior ruling on the merge gesture ("the realtime tooltip does not
  // need to exist when I'm dragging slides") is exactly why they were built as
  // on-target chips rather than tooltips in the first place.
  let dragActive = $derived(dragState?.moved === true);

  /**
   * Query (reads the DOM). WHICH GAP the pointer is nearest, as a boundary index
   * in 0..n. Measures the rendered rows rather than assuming a row height: rows
   * differ in height (a slide whose camera is degenerate draws no thumbnail), so
   * a computed constant would drift from what is on screen.
   *
   * ONE MODEL, TWO LAYOUTS. The drop target is a BOUNDARY in both views — the
   * same gap index core withSlidesMovedToBoundary takes — because the ORDER is
   * linear in both; only where a slot is drawn differs. What changes is the
   * predicate for "the pointer is before slot i":
   *   LIST — above the row's horizontal midline. One axis, as before.
   *   GRID — row-major reading order, which is the ordering the tiles are laid
   *          out in, so the test is lexicographic: strictly ABOVE this tile's
   *          row (a whole line earlier) counts as before it, and WITHIN its row
   *          it is the vertical midline that decides. `clientY < r.bottom` is
   *          what makes "above this line" and "on this line" one comparison
   *          rather than a row-bucketing pass.
   * Returning the FIRST slot the pointer precedes is what makes both cases fall
   * out of one loop, and it is why the grid needs no separate slot geometry: a
   * cell's identity is its position in the same [data-slide-row] sequence.
   */
  function boundaryAt(clientX, clientY) {
    const rows = [...(slidesEl?.querySelectorAll("[data-slide-row]") ?? [])];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      const before = isGrid
        ? clientY < r.top || (clientY < r.bottom && clientX < r.left + r.width / 2)
        : clientY < r.top + r.height / 2;
      if (before) return i;
    }
    return rows.length;
  }

  // ── DRAG ONTO A SLIDE = MERGE ───────────────────────────────────────────────
  // User, 2026-08-02: "Or what if I can drag a slide into another slide? And then
  // it could have a realtime tooltip while I'm dragging it, say what I'm about to
  // do, which is merging. By the way, the realtime tooltip does not need to exist
  // when I'm dragging slides."
  //
  // So ONE GESTURE CARRIES TWO OPERATIONS, and the whole design problem is making
  // which one you are about to get unmistakable BEFORE you release:
  //   - THE GAPS BETWEEN SLIDES STAY REORDER TARGETS, untouched. Every existing
  //     drop still reorders exactly as it did, which is the no-regression rule.
  //   - A SLIDE'S BODY IS A MERGE TARGET, drawn differently (a selection-tint
  //     wash + a "Merge" chip ON the target) from the reorder indicator (a bold
  //     line IN the gap). Different shape, different place, different meaning.
  //   - NO FLOATING REALTIME TOOLTIP. The user's last sentence retracts it for
  //     plain reorder drags, and a tip that appears only over bodies would be a
  //     second, inconsistent explanation of the same gesture. The chip rides the
  //     TARGET, where the thing being described actually is.
  //
  // THE BODY IS THE MIDDLE OF THE ROW, NOT ALL OF IT. A merge zone spanning the
  // whole row would make the gaps unhittable — the pointer would have to land in
  // a 1px seam to reorder, and the commonest gesture in the rail would become the
  // hardest. So each row's outer MERGE_EDGE_FRACTION at each end belongs to the
  // gap it is nearest, and the middle is the merge zone.
  const MERGE_EDGE_FRACTION = 0.3; // of the row's length, at EACH end, reserved for reorder

  /**
   * Query (reads the DOM). WHICH SLIDE the pointer is over the BODY of — the
   * merge target — or `null` when it is near a gap (a reorder) or over a slide
   * that cannot be merged with what is being dragged.
   *
   * Returns null for a row that is part of the dragged block: a slide cannot
   * merge into itself, and the block's own rows are holes during the drag.
   *
   * @returns {number|null} the target row index, or null when this is a reorder
   */
  function mergeTargetAt(clientX, clientY, indices) {
    const rows = [...(slidesEl?.querySelectorAll("[data-slide-row]") ?? [])];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      // THE AXIS IS THE ONE THE GAPS LIE ALONG: vertically stacked rows in the
      // list, horizontally flowing tiles in the grid (where a gap is a vertical
      // seam between two tiles on a line). Using the wrong axis would put the
      // reorder edges where there is no gap to reorder into.
      const lo = isGrid ? r.left : r.top;
      const size = isGrid ? r.width : r.height;
      const pos = isGrid ? clientX : clientY;
      const within = isGrid ? clientY >= r.top && clientY < r.bottom : clientX >= r.left && clientX < r.right;
      if (!within || pos < lo || pos >= lo + size) continue;
      const edge = size * MERGE_EDGE_FRACTION;
      if (pos < lo + edge || pos >= lo + size - edge) return null; // near a gap → reorder
      if (indices.includes(i)) return null; // its own hole — nothing to merge into
      return i;
    }
    return null;
  }

  /** Query. Is row `i` the live MERGE target (so it wears the wash and the chip)? */
  function isMergeTarget(i) {
    return dragState?.moved === true && dragState.mergeTarget === i;
  }

  /**
   * Query. WHY the live merge would be refused, or null when it is fine — read
   * straight from the app so the chip states the SAME sentence the command layer
   * would, rather than a second guess at the rule.
   */
  function mergeBlocker() {
    const t = dragState?.mergeTarget;
    return t === null || t === undefined ? null : app.slideRunMergeBlocker(dragState.indices, t);
  }

  /**
   * Query. THE CHIP'S SENTENCE: how many slides are about to become one, and
   * WHOSE LOOK SURVIVES — the destructive half, which "Merge" alone leaves
   * unanswered.
   *
   * THE WINNER IS THE ROW BEING DRAGGED (user, 2026-08-02: "I want the one that I
   * am currently dropping onto the other one to take priority"), so with ONE
   * dragged row the chip names it and nothing has to be inferred from the
   * gesture. This used to name the LAST of the set in DECK ORDER, which is a
   * different row whenever the drag goes downward.
   *
   * WITH SEVERAL DRAGGED ROWS the winner is not one row: they all beat the
   * target, and among themselves the later one wins (app.mergeSlideRun). Naming
   * only the last of them would be true about collisions between the dragged and
   * the target but silent about the rule that decides the rest, and naming all of
   * them would not fit on a chip. So it says the honest general thing — the
   * dragged slides win — and leaves the intra-block order to the deck, which the
   * rail is already showing.
   *
   * A number, not a name: the rail shows names two pixels away, the number is
   * what says WHERE, and a long name would blow out a chip sitting on a thumbnail.
   */
  function mergeChipLabel(target) {
    const dragged = [...new Set(dragState?.indices ?? [])].filter((i) => i !== target).sort((a, b) => a - b);
    const run = [...new Set([...(dragState?.indices ?? []), target])];
    const what = run.length > 2 ? `Merge ${run.length} slides` : "Merge";
    const who = dragged.length === 1 ? `slide ${dragged[0] + 1} wins` : "dragged slides win";
    return `${what} · ${who}`;
  }

  /**
   * Query (reads the DOM). THE SLOT PITCH of the lifted block `indices` — the
   * distance a row must travel to move past it, given the rendered rows `rows`.
   *
   * THIS IS NOT THE SUM OF THE ROWS' HEIGHTS, and the difference is a bug the user
   * saw (2026-08-02): "when I'm dragging and dropping these different slides, the
   * ones that move out of the way don't move into quite the right place… You see
   * how slide 1 intersects on top of where it says tween? … Is the math off
   * anywhere?" It was. A row's SLOT in this rail is not the row: between every two
   * rows sits a TRANSITION SLICE, and the flex column puts a gap on each side of
   * it. Measured on a real rail — rows 144.31px tall, top-to-top pitch 165.31px —
   * the slot is 21px taller than its row (a 17px slice plus two 4px gaps). Shifting
   * by the row height alone therefore left every displaced row exactly 21px short,
   * which parked it on top of the chip above it: row 1 landed spanning 73→217.31
   * while chip 1 occupied 200.31→213.31. Precisely the reported overlap.
   *
   * SO MEASURE THE PITCH, don't reconstruct it. Taking the next row's top minus the
   * first lifted row's top counts whatever is actually between them — slice, gaps,
   * and anything a later design puts there — instead of re-deriving a number from
   * tokens this component would then have to keep in sync with app.css. When the
   * block is the LAST one there is no next row, so it falls back to the pitch of the
   * gap ABOVE it, which is the same slot geometry read from the other side.
   *
   * Returns px. Rows are the live `[data-slide-row]` elements, so this must be
   * called BEFORE any drag transform is applied (grab time), like its caller does.
   */
  function slotPitch(rows, indices) {
    const first = indices[0];
    const last = indices[indices.length - 1];
    const top = rows[first]?.getBoundingClientRect().top;
    if (top === undefined) return 0;
    const next = rows[last + 1]?.getBoundingClientRect().top;
    if (next !== undefined) return next - top;
    // LAST BLOCK IN THE RAIL — no row below to measure to. Its slot is its own
    // height plus the spacing that sits above it, which is the same slice+gaps
    // read from the other side. With one row and no neighbours at all (a
    // single-slide deck cannot be reordered) the spacing is simply 0.
    const block = rows[last].getBoundingClientRect().bottom - top;
    const above = rows[first - 1]?.getBoundingClientRect().bottom;
    return above === undefined ? block : block + (top - above);
  }

  /**
   * Query (reads the DOM). WHERE EVERY CELL IS, as {left, top} px per index —
   * the "F" (First) of the grid's FLIP. Captured ONCE at grab time, before any
   * transform is applied, so it is the untransformed cell geometry.
   *
   * THIS IS WHY THE GRID NEEDS NO SLOT ARITHMETIC AT ALL. In the list, a slot's
   * pitch is a single scalar and every displaced row travels the same distance,
   * so one measured number does it (slotPitch above). In a grid it is not: a tile
   * displaced ACROSS a row end travels back to the far side and down a line, so
   * its delta is nothing like its neighbour's. Reconstructing that from a column
   * count and a cell size would mean re-deriving the CSS grid's own layout in JS
   * — including how it wrapped, which is the one thing `repeat(auto-fill, …)`
   * decides and does not report.
   *
   * So don't reconstruct it: READ IT. A cell's post-drag position is simply the
   * position ANOTHER cell already occupies, because the cells are fixed and only
   * their CONTENTS renumber. dragShift below is therefore a lookup — "tile i ends
   * up in cell j, so translate by cells[j] − cells[i]" — and it is exact for any
   * wrap, any column count, and any future cell size, with no layout math.
   *
   * Returns an array parallel to `rows`. Called at grab time by its one caller.
   */
  function cellOrigins(rows) {
    return rows.map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top };
    });
  }

  /**
   * Pure function. WHICH CELL tile `i` ends up in while a block is lifted out of
   * `indices` and hovering boundary `boundary` — the "L" (Last) of the FLIP, as a
   * cell index in the same sequence cellOrigins measured.
   *
   * THE RULE IS THE LIST'S RULE, COUNTED IN SLOTS INSTEAD OF PIXELS. A tile
   * between the hole and the drop boundary shifts by the size of the lifted block
   * (`n`), toward the hole; everything outside that span stays put. It is the same
   * sentence dragShift's docblock states for the rail — only the unit changes,
   * from "the block's slot pitch in px" to "n cells in reading order", which is
   * what makes it work across a row wrap where a px offset cannot.
   *
   * Sign convention matches the list's: a tile AFTER the hole and before the
   * boundary moves EARLIER (toward index 0); one at or after the boundary and
   * before the hole moves LATER.
   *
   * @param {number} i Tile index.
   * @param {number[]} indices The lifted (contiguous-after-sort) block's indices.
   * @param {number} boundary Drop boundary, 0..n.
   * @returns {number} The cell index tile `i` should occupy (i itself when unmoved).
   *
   * @example // A 3-tile lift of [1] onto boundary 3: tile 2 slides back into cell 1.
   * @example displacedCell(2, [1], 3)
   * 1
   * @example // Dragging UP instead — [3] onto boundary 1 pushes tiles 1 and 2 later.
   * @example displacedCell(1, [3], 1)
   * 2
   * @example // Outside the span nothing moves.
   * @example displacedCell(5, [1], 3)
   * 5
   */
  function displacedCell(i, indices, boundary) {
    const n = indices.length;
    const first = indices[0];
    const last = indices[indices.length - 1];
    if (i > last && i < boundary) return i - n; // dragging DOWN: later tiles move earlier
    if (i >= boundary && i < first) return i + n; // dragging UP: earlier tiles move later
    return i;
  }

  /** Command. Begins a potential row drag. The gesture is not a drag until the
   *  pointer has moved DRAG_THRESHOLD_PX — until then it is still a click, so a
   *  plain select never has to be undone by a stray pixel of movement. */
  function onRowPointerDown(e, i) {
    if (e.button !== 0) return;
    // The eye toggle owns its own pointer; a drag started on it would swallow its
    // click. (The rename editor is no longer inside the row — it is a dialog now,
    // for the retargeting reason this file's rename note gives.)
    if (e.target.closest(".eye")) return;
    const indices = app.isSlideSelected(i) ? app.selectedSlideIndices() : [i];
    // MEASURE THE BLOCK AT GRAB TIME, once. The lifted block's SLOT PITCH is how
    // far the rows below must shift to close over it, and where inside the row
    // the pointer landed is where the ghost must hang from. Reading it per move
    // would measure rows that are already translated.
    const rows = [...(slidesEl?.querySelectorAll("[data-slide-row]") ?? [])];
    const own = e.currentTarget.getBoundingClientRect();
    const height = slotPitch(rows, indices);
    dragState = {
      indices, height,
      // WHERE EVERY CELL IS, measured once, untransformed — the grid's FLIP
      // baseline (cellOrigins). Unused by the list branch, which needs only the
      // scalar pitch, but measured unconditionally: it is one getBoundingClientRect
      // per row on a gesture that already does that, and a branch here would mean
      // the state's shape depends on the view mode.
      cells: cellOrigins(rows),
      startX: e.clientX, startY: e.clientY,
      pointerX: e.clientX, pointerY: e.clientY,
      grabDx: e.clientX - own.left, grabDy: e.clientY - own.top,
      ghostX: own.left, ghostW: own.width,
      moved: false, boundary: null,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onRowPointerMove(e) {
    if (!dragState) return;
    // THE THRESHOLD IS RADIAL IN GRID VIEW. A list drag can only be vertical, so
    // a |Δy| test is the whole gesture; a grid drag to the tile beside this one
    // is PURELY HORIZONTAL, and a Δy-only threshold would never fire for it —
    // the commonest single-step reorder in a grid would be undraggable.
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    const far = isGrid ? Math.hypot(dx, dy) : Math.abs(dy);
    if (!dragState.moved && far < DRAG_THRESHOLD_PX) return;
    // BOTH are resolved every move, and the MERGE TARGET WINS when it is set:
    // over a slide's body the drop merges, near a gap it reorders. The boundary
    // is still computed either way so that leaving a body puts the reorder
    // indicator back instantly, with no second pass.
    const mergeTarget = mergeTargetAt(e.clientX, e.clientY, dragState.indices);
    dragState = {
      ...dragState, moved: true, pointerX: e.clientX, pointerY: e.clientY,
      boundary: boundaryAt(e.clientX, e.clientY), mergeTarget,
    };
  }

  /** Command. Drops (one undo unit) or, if the pointer never really moved, lets
   *  the click through untouched. Pointer capture guarantees this fires even when
   *  the release lands outside the rail. */
  function onRowPointerUp(e) {
    const drag = dragState;
    dragState = null;
    if (!drag?.moved) return;
    e.preventDefault(); // a drop is not also a click
    // A DROP ON A BODY MERGES; a drop anywhere else reorders, exactly as before.
    // PRIORITY FOLLOWS THE DROP (user, 2026-08-02: "the one that I am currently
    // dropping onto the other one to take priority … I'm physically dropping it
    // on top"), so the DRAGGED rows win and drag.mergeTarget is not just which
    // slides — it is which one LOSES. Dragging 2 onto 5 and 5 onto 2 therefore
    // disagree, which they did not before. (These two comment lines used to
    // claim the opposite; the palette command still means deck order and still
    // goes through app.mergeSlidePair.)
    if (drag.mergeTarget !== null && drag.mergeTarget !== undefined) {
      app.mergeSlideRun(drag.indices, drag.mergeTarget);
      return;
    }
    app.moveSlidesToBoundary(drag.indices, drag.boundary ?? boundaryAt(e.clientX, e.clientY));
  }

  /** Query. Is boundary `b` the live drop target? Boundaries are drawn by the
   *  slice ABOVE slide b (and by a tail element for b === slides.length).
   *
   *  A LIVE MERGE TARGET SUPPRESSES IT. The two indicators must never show at
   *  once: they describe different outcomes for the same release, and drawing
   *  both would make the gesture ambiguous at exactly the moment the user is
   *  deciding. The merge wash wins because the merge is what would happen. */
  function isDropBoundary(b) {
    return dragState?.moved === true && dragState.mergeTarget == null && dragState.boundary === b;
  }

  /** Query. Is row `i` one of the rows being dragged (so its slot is a hole)? */
  function isLifted(i) {
    return dragState?.moved === true && dragState.indices.includes(i);
  }

  /**
   * Query. How far row `i` must translate (px) to open the drop slot — the
   * "push the others out of the way" half of the user's ruling.
   *
   * THE RULE IS ONE SENTENCE: a non-lifted row moves by the lifted block's SLOT
   * PITCH, TOWARD the hole the lifted rows left. Rows that sit between the hole and
   * the drop boundary are the ones displaced; everything outside that span stays put.
   *
   * PITCH, NOT HEIGHT — this said "height" and shipped that way, and the rows landed
   * 21px short, sitting on top of the transition chips (slotPitch has the user's
   * report and the measurement). A row's slot includes the slice below it and the
   * gaps around it; a rail of slots tiles, a rail of row heights does not.
   * Because the lifted rows are still in layout (drawn as holes, never removed),
   * the untouched rows genuinely do not move, and no reflow can occur — which is
   * the constraint bullet 1 of the drag note sets.
   *
   * Sign convention: negative is UP. A row after the hole but before the boundary
   * slides UP into it; a row at or after the boundary but before the hole slides
   * DOWN out of the way.
   *
   * IN GRID VIEW IT IS THE SAME RULE ON TWO AXES, and it is computed differently
   * for the reason cellOrigins states: a tile displaced across a row end travels
   * back across the panel and down a line, which no single pitch can express. So
   * the grid asks displacedCell WHICH cell this tile lands in and subtracts the
   * two measured cell origins. Both branches return a {x, y} px delta, which is
   * what the template writes into one `translate()`.
   */
  function dragShift(i) {
    // A LIVE MERGE TARGET CLOSES THE SLOT. The rows part to make room for an
    // INSERTION; a merge inserts nothing, so leaving them parted would promise a
    // gap that the drop is not going to fill. They glide back over DRAG_SHIFT_MS
    // (the same transition already on the transform), which reads as the rail
    // declining the reorder — the motion itself says which operation is armed.
    if (dragState?.mergeTarget != null) return { x: 0, y: 0 };
    if (!dragState?.moved || dragState.boundary === null || isLifted(i)) return { x: 0, y: 0 };
    const { indices, height, boundary, cells } = dragState;
    if (isGrid) {
      const to = displacedCell(i, indices, boundary);
      const from = cells[i];
      const dest = cells[to];
      // A destination outside the measured set cannot happen for a valid boundary
      // (the span displacedCell moves over is bounded by the block and the
      // boundary, both in range), but a missing cell would silently mean "no
      // shift" — so say nothing moved only when nothing did.
      if (!from || !dest) return { x: 0, y: 0 };
      return { x: dest.left - from.left, y: dest.top - from.top };
    }
    const first = indices[0];
    const last = indices[indices.length - 1];
    if (i > last && i < boundary) return { x: 0, y: -height }; // dragging DOWN: rows above the target rise
    if (i >= boundary && i < first) return { x: 0, y: height }; // dragging UP: rows below the target sink
    return { x: 0, y: 0 };
  }

  // THE MODIFIER KEY'S NAME ON THIS PLATFORM — "Cmd" on a Mac, "Ctrl" elsewhere.
  // The rail's toggle-click reads `metaKey || ctrlKey`, so BOTH really work; the
  // tip names the one the reader's own keyboard has rather than teaching a chord
  // they do not own. Same test (and the same `|| ""` guard for a
  // platform-less navigator) as CodeEditorModal's isMac, which is the app's
  // existing precedent for this read.
  const CMD_KEY_NAME = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "") ? "Cmd" : "Ctrl";

  /** Query. How many slides the rail commands will act on — 1 when nothing is
   *  multi-selected (an empty set means "the current slide"). Read by the bottom
   *  buttons' labels so a multi-slide Delete announces itself before it fires. */
  function selectionCount() {
    return app.selectedSlideIndices().length;
  }

  // ── THE FOOTER: FIVE BUTTONS, AND THE ICONS COME FROM THE COMMANDS ──────────
  // TWO RULINGS MEET HERE.
  //
  // (1) THE SET IS SMALLER. User, 2026-08-02: "Remember how I asked to simplify
  // the set of buttons? I still see two pluses and also a copy." The row was
  // `+ · boxed-+ · up · down · copy · trash` — SIX, with two of them pluses and a
  // third doing what one of the pluses already did. The earlier reasoning the user
  // gave is what resolves it: "duplicate slide is not really needed, because new
  // slide after current does exactly the same thing." So DUPLICATE leaves the
  // FOOTER (the command stays registered — the palette and the rail's Cmd+D chord
  // are untouched; what is retracted is a button, not an action), and the bare `+`
  // leaves because New Slide After Current now wears the copy glyph the palette
  // gave it. Five remain, and no two of them say the same thing.
  //
  // (2) THE ICONS ARE READ, NOT WRITTEN. This footer hardcoded its own glyphs, so
  // when d3a0080 changed new-slide's icon in the PALETTE entry the ruling reached
  // the palette and not this row — which is the entire reason the user was still
  // looking at a bare `+` a day later. A surface that copies a value it does not
  // own will drift from it, silently, and the drift is invisible until someone
  // reports the picture. So each button reads `app.commands.get(id).icon`: the
  // entry is the one place an icon is decided, exactly as the palette, the toolbar
  // (App.svelte's `titleIcon`) and ShapePicker already read it. `get()` is LOUD on
  // an unknown id, so a renamed command breaks this row visibly instead of
  // rendering a button with no glyph.
  //
  // THE LABELS STAY HERE, deliberately: they are not the command's title but the
  // RAIL's sentence about it, and two of them count the selection ("Delete the 3
  // selected slides") — which is rail state the entry knows nothing about.
  const FOOTER_COMMANDS = [
    { id: "new-slide", label: () => "New slide after current" },
    { id: "new-blank-slide", label: () => "New blank slide — hides every visible item" },
    { id: "move-slide-up", label: () => "Move slide up" },
    { id: "move-slide-down", label: () => "Move slide down" },
    // ONE BUTTON, TWO COMMANDS, and which one it runs is the rail selection —
    // `delete-slides` is the multi form and covers the single case too (an empty
    // slideSelection resolves to just the current slide), so this always runs the
    // multi command and the label is the only thing that varies.
    { id: "delete-slides", label: () => (selectionCount() > 1 ? `Delete the ${selectionCount()} selected slides` : "Delete slide") },
  ];

  // THE VIEW TOGGLE IS THE SIXTH FOOTER CONTROL, AND IT IS NOT A COMMAND — which
  // is why it does not join FOOTER_COMMANDS above and writes its own icon. The
  // five are surfacings of the command registry (that note explains why they READ
  // their glyphs); this one has nothing to surface. A registry entry is an ACTION
  // on the document or the app, reachable from the palette and chordable; this
  // flips how one panel draws itself, for one browser, and putting it in the
  // palette would offer "Grid View" to a user who cannot see the rail. If a
  // shortcut for it is ever asked for, that is the moment it becomes a command —
  // and then the icon must move to the entry, per the drift ruling above.
  //
  // THE ICON SHOWS THE DESTINATION, not the current state: the button offers the
  // OTHER view, and its label says so, which is the one unambiguous reading of a
  // two-state view switch (the alternative — showing what you are already looking
  // at — makes the button look like a redundant status light).
  const VIEW_TOGGLE_ICONS = { list: "mdi:view-grid-outline", grid: "mdi:view-list-outline" };

  /** Query. The view toggle's sentence — it names the view a click SWITCHES TO,
   *  and (the reason the grid exists) what that buys. */
  function viewToggleLabel() {
    return isGrid
      ? "List view — one slide per row, with its transition between the rows"
      : "Grid view — tiled thumbnails, so a wider panel shows MORE slides instead of bigger ones";
  }

  // ── MEASURING A TILE, for the pill's condensation ───────────────────────────
  // ONE OBSERVER ON THE CONTAINER, not one per tile. Every cell in a
  // `repeat(auto-fill, …)` grid is the same size, so one measurement answers for
  // all of them; N observers would deliver N identical callbacks per resize on the
  // panel whose whole point is holding many tiles.
  // WHY OBSERVE AT ALL, rather than compute from the panel width: the column count
  // is decided by the CSS grid's auto-fill, which does not report itself. The tile
  // height is downstream of that AND of the thumbnail's aspect, so it is a
  // measurement, not a formula (cellOrigins makes the same argument for the drag).
  // OBSERVE THE CONTAINER, READ A TILE. The observed element is .slides itself
  // (it always exists and never churns), and each callback measures the FIRST
  // tile — which is what actually changes. Observing a tile directly would mean
  // re-binding the observer every time the deck's first slide is replaced by an
  // insert, a delete or a reorder, all of which are ordinary operations here.
  $effect(() => {
    if (!isGrid || !slidesEl) { tileHeightPx = null; return; }
    const measure = () => {
      const first = slidesEl.querySelector("[data-slide-row]");
      tileHeightPx = first ? first.getBoundingClientRect().height : null;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(slidesEl);
    return () => ro.disconnect();
  });
</script>

<!-- --drag-shift-ms is published from the JS constant so the row-slide animation
     and the code that reasons about it cannot drift to two different numbers. -->
<div class="slidenav" class:dragging={dragState?.moved} class:grid={isGrid} style:--drag-shift-ms={`${DRAG_SHIFT_MS}ms`}>
  <div class="slides" bind:this={slidesEl}>
    {#each app.doc.slides as slide, i (slide.id)}
      <!-- THE TRANSITION SLICE IS A LIST-VIEW ELEMENT. In grid view the same
           transition is drawn by the TILE ITSELF, as the left-edge spine pill
           below — the chip-ownership ruling ("they belong to the slide they come
           in with"). It is not that the grid hides the slice: a wrapping,
           row-major layout has no single "between" to put it in, and the field
           was on the slide all along. -->
      {#if i > 0 && !isGrid}
        {@const info = transitionInfo(i)}
        <!-- THE SLICE IS THE CHIP ALONE, in a band that spans the gap. It used
             to be THREE buttons — an insert-a-slide-here `+` at each end plus the
             chip — and the user RETRACTED the ends outright (2026-08-02): "the
             insert a slide here up and down buttons that we have near the tween
             line… I made a mistake that feature should never have existed we can
             get rid of that just just tween is fine we don't need those extra up
             and down add slide up and add slide down buttons on either side of
             tween 0.5… we can get rid of the up plus and down plus buttons here."
             So the `+` ends and their hover-reveal are GONE. What survives is
             everything that was never about them: THE CHIP IS ALWAYS VISIBLE
             (user: "The tween thing should always be there"), the band still
             doubles as the DROP INDICATOR for boundary `i` during a drag, and the
             band is still the hover surface for the chip's own lighting.
             `app.insertSlideAtBoundary` stays in the app layer — the retraction
             was of these two BUTTONS, not of boundary insertion as an action. -->
        <!-- role="group": the band is a CONTAINER of the chip, not a control
             itself — it owns only the hover state. Labelled so a screen reader
             announces what it sits between. -->
        <div
          class="transition-slice"
          class:hot={sliceHot(slide.id)}
          class:drop={isDropBoundary(i)}
          role="group"
          aria-label={`Between slide ${i} and slide ${i + 1}`}
          onpointerenter={() => (hotSliceId = slide.id)}
          onpointerleave={() => (hotSliceId = null)}
        >
          <span class="tr-line"></span>
          <!-- THE CHIP'S CLICK IS THE SLICE'S CLICK RULE — plain / shift-range /
               cmd-toggle, resolved by app.selectTransitionAt, which is
               deliberately the same three-gesture shape selectSlideAt gives rows
               (user: "I should be able to shift click multiple tweens too, in the
               same way that I have multi-selection for widgets. It's exactly the
               same idea."). Like the rows, it renders on TWO axes: `.selected` is
               membership in the set, `.primary` is the one the panel is named
               after. -->
          <Tooltip disabled={dragActive} text={`Transition into slide ${i + 1}: ${info.title} · ${formatSeconds(info.seconds)} — click to edit, Shift or ${CMD_KEY_NAME}-click to select several`}>
            <button
              class="tr-chip"
              class:selected={app.isTransitionSelected(slide.id)}
              class:primary={app.selectedTransition === slide.id}
              aria-label={`Transition into slide ${i + 1}`}
              aria-pressed={app.isTransitionSelected(slide.id)}
              onfocus={() => (hotSliceId = slide.id)}
              onblur={() => (hotSliceId = null)}
              onclick={(e) => app.selectTransitionAt(slide.id, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey })}
            >
              <iconify-icon icon={TRANSITION_ICONS[info.type] ?? "mdi:transition"} width="13" height="13"></iconify-icon>
              <span class="tr-label">{info.title} · {formatSeconds(info.seconds)}</span>
            </button>
          </Tooltip>
          <span class="tr-line"></span>
        </div>
      {:else if i === 0 && !isGrid}
        <!-- THE TOP BOUNDARY has no transition slice (slide 0 has no predecessor),
             so it gets a bare drop rail of its own — otherwise dragging a slide to
             the very top would show no indicator at the one gap that most needs
             one. Zero height when idle; it only exists during a drag.
             LIST ONLY: in the grid every boundary — including 0 and n — is drawn
             on a TILE's own edge (.seam-before / .seam-after below), because a
             full-width horizontal rail in a wrapping layout would point at a whole
             line rather than at the gap between two cells. -->
        <div class="drop-rail" class:drop={isDropBoundary(0)}></div>
      {/if}
      <!-- THE ROW OWES EXPLANATION and gave none: it had no tooltip and no :hover
           rule at all, so the filmstrip's primary navigation surface read as inert.
           Three things were unreadable. (1) The NAME ellipsizes (app.css
           .slidenav .name), so a long slide name could not be read anywhere.
           (2) A DISABLED slide renders as bare opacity: 0.5 with nothing saying what
           "disabled" means — its delta is SKIPPED when the deltas are folded, so
           every later slide inherits as though it were not there. That is exactly
           the mystery-grey control the palette/Tools-pane `requires` rule exists to
           kill. (3) The incoming transition is already computed for the slice above;
           naming it here costs nothing.
           It owes NO canvas PREVIEW, deliberately: the thumbnail already IS the
           slide's preview, and swapping the main canvas on an incidental traverse of
           the rail would fight the thumbRenderPaused gesture discipline this file's
           header spends thirty lines on. -->
      <!-- THE CELL WRAPPER. In GRID view it is the tile's positioning context, so
           the spine pill can be absolutely positioned across the tile's left edge
           — the pill is a <button> and the tile is a <button>, and nesting those is
           invalid HTML, so the pill must be a SIBLING with something to be
           positioned against.

           IN LIST VIEW IT IS `display: contents` (app.css), which produces NO BOX
           AT ALL: the tile stays a direct flex child of .slides, with the same
           box, the same gaps and the same computed styles it had before this
           workstream. That is deliberate and it is pinned — the user's ruling on
           the list view is that it "visually *looks* clean", i.e. DO NOT RESTYLE
           IT, and a wrapper that laid out would have silently changed its
           geometry. -->
      <div class="slide-cell">
      <Tooltip disabled={dragActive}>
        {#snippet tip()}
          <!-- The NAME alone, not "Slide {i+1}: {name}": the number is visible in
               the row two pixels away, and default names already read "Slide N", so
               the prefixed form rendered "Slide 1: Slide 1" — a doubled echo. A
               name-only line is the Open Project card's precedent (App.svelte), and
               it is information whenever the label is ellipsized. -->
          <div>{slide.name}</div>
          {#if i > 0}{@const info = transitionInfo(i)}<div>Transition in: {info.title} · {formatSeconds(info.seconds)}</div>{/if}
          {#if slide.enabled === false}
            <div class="tool-tip-requires">Disabled — its delta is skipped, so later slides inherit as if it were not here</div>
          {/if}
          <!-- THE RENAME AFFORDANCE, hosted here because this tip already covers
               the name span (see that span's note: a nested Tooltip on it drew two
               boxes over each other). It replaces a native title= on the span —
               banned, and the reason the ban exists: it waited ~1s while the eye
               toggle beside it answered instantly.

               IT SAYS "A DIALOG", because that is now what happens. The tip used
               to promise in-place editing of the name; the gesture opens the same
               pre-selected Rename dialog the project title does (user ruling).
               A tip that describes the old behaviour is worse than none — it
               tells the user their correct gesture failed.

               STILL DOUBLE-CLICK, unlike the toolbar's project title, which is
               single-click: a slide card's SINGLE click SELECTS the slide, so
               rename must be the second gesture or it would fight navigation.
               The toolbar title has no first gesture to lose. -->
          <div class="cmd-tip-note">Double-click to rename (opens a dialog, name pre-selected)</div>
          <!-- THE TWO NEW GESTURES ON THIS ROW, taught here for the reason the
               rest of this tip exists: an affordance nobody is told about does not
               exist, and neither of these has any visual affordance of its own
               until it is already under way. Both are one line because the tip is
               already four deep on a hover target you cross incidentally. -->
          <div class="cmd-tip-note">Drag to reorder · Shift or {CMD_KEY_NAME}-click to select several</div>
        {/snippet}
        <!-- MULTI-SELECT + DRAG live on this one element. The click rule (plain /
             shift-range / cmd-toggle) is app.selectSlideAt, not spelled out here,
             so the rail and any future surfacing of it agree by construction.
             `.selected` and `.current` are two different things and both render:
             `current` is the ONE slide the canvas is showing (border color, as
             before), `selected` is membership in the multi-selection (a tint), so
             a block of five reads as a block with one of them live. -->
        <!-- `.lifted` is the HOLE the dragged row leaves behind (user: "You can
             leave the old area empty"); the row stays in layout so nothing
             reflows, and the ghost below is what the pointer actually carries.
             `--drag-shift` is how far this row slides to open the target slot,
             animated by CSS over DRAG_SHIFT_MS.

             THE DOUBLE-CLICK OPENS THE RENAME DIALOG, and it is bound HERE — on
             the row — rather than on the name span, because pointer capture
             retargets the whole sequence to this element (see the rename note in
             the script). Binding it to a descendant is exactly what broke. It
             still reads as renaming THE NAME because a dblclick that lands on the
             row's own chrome is far likelier to be aimed at its label than at
             nothing, and the tip says so. -->
        {@const shift = dragShift(i)}
        <button
          class="slide"
          class:current={i === app.slideIndex}
          class:selected={app.isSlideSelected(i)}
          class:lifted={isLifted(i)}
          class:merge-target={isMergeTarget(i)}
          class:merge-refused={isMergeTarget(i) && mergeBlocker() !== null}
          class:disabled={slide.enabled === false}
          class:seam-before={isGrid && isDropBoundary(i)}
          class:seam-after={isGrid && i === app.doc.slides.length - 1 && isDropBoundary(app.doc.slides.length)}
          style:--drag-shift-x={`${shift.x}px`}
          style:--drag-shift={`${shift.y}px`}
          data-slide-row={i}
          onpointerdown={(e) => onRowPointerDown(e, i)}
          onpointermove={onRowPointerMove}
          onpointerup={onRowPointerUp}
          onpointercancel={() => (dragState = null)}
          onclick={(e) => app.selectSlideAt(i, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey })}
          ondblclick={() => app.renameSlidePrompt(i)}
        >
          <span class="row-top">
            <span class="num">{i + 1}</span>
            <!-- A PLAIN SPAN AGAIN. It hosted InlineRename until the rename
                 became a dialog; the editor could not be opened by a real mouse
                 here, because the row's pointer capture retargets the dblclick
                 away from this span (the script's rename note has the
                 measurement). The gesture now lives on the ROW.

                 NO TOOLTIP OF ITS OWN, and no native title= either (banned —
                 manifest; tests/native_tooltip_ban_test.js enforces it). This
                 span carried a native title for exactly the reason the ban
                 exists: it predated the convention, so it waited ~1s while the
                 eye toggle beside it answered instantly. The rename hint lives in
                 the CARD's tip (above); a nested Tooltip here painted two boxes
                 over each other, because the card's tip covers this span too. -->
            <span class="name">{slide.name}</span>
            <Tooltip disabled={dragActive} text={slide.enabled === false ? "Enable slide (apply its delta)" : "Disable slide (skip its delta)"}>
              <span
                class="eye"
                role="button"
                tabindex="-1"
                onclick={(e) => { e.stopPropagation(); app.toggleSlide(i); }}
                onkeydown={(e) => { if (e.key === "Enter") { e.stopPropagation(); app.toggleSlide(i); } }}
              >
                <iconify-icon icon={slide.enabled === false ? "mdi:eye-off" : "mdi:eye"} width="14" height="14"></iconify-icon>
              </span>
            </Tooltip>
          </span>
          {#if thumbAspect(i)}
            <DirtyImage
              class="thumb"
              render={renderThumb(i)}
              dirtyKey={publishedKeys[i]}
              schedule={thumbScheduler.request}
              aspect={thumbAspect(i)}
              alt={`Slide ${i + 1} preview`}
            />
          {/if}
          <!-- ── THE MERGE CHIP ────────────────────────────────────────────────
               What the release is about to do, drawn ON the target rather than
               floating by the cursor: the user retracted the realtime tooltip
               ("the realtime tooltip does not need to exist when I'm dragging
               slides"), and a label that rides the thing it describes needs no
               tooltip machinery at all. It exists ONLY while this row is the live
               merge target, so it can never be stale.

               IT NAMES THE WINNER, not just the operation. "Merge" alone leaves
               the destructive question unanswered. Since 2026-08-02 the answer IS
               the gesture — the DRAGGED slide wins, so dragging a slide up and
               dragging one down onto the same pair now give DIFFERENT results and
               the chip is what tells you which one you are performing. (It used
               to say deck order decided, and that the two directions agreed.) The
               arrow points at the seat the survivor takes, which is this row.

               WHEN THE MERGE IS REFUSED it says why instead, in the same place —
               the sentence comes from app.slideRunMergeBlocker, the very call the
               drop would refuse on, so the chip cannot promise something the drop
               then declines. -->
          {#if isMergeTarget(i)}
            {@const refused = mergeBlocker()}
            <span class="merge-chip" class:refused>
              <iconify-icon icon={refused ? "mdi:cancel" : "mdi:call-merge"} width="12" height="12"></iconify-icon>
              <span class="merge-chip-text">{refused ? `Can't merge — needs ${refused}` : mergeChipLabel(i)}</span>
            </span>
          {/if}
        </button>
      </Tooltip>
      <!-- ── THE SPINE PILL: THIS TILE'S OWN INCOMING TRANSITION ───────────────
           Two user rulings put it here, both 2026-08-02 and both verbatim in the
           script's spine note. (1) OWNERSHIP: "the tween chips where DO they
           go....well they belong to the slide they come in with right?" — the
           transition is a FIELD on the slide it enters, so a tile can wear its own
           and a wrapping layout never needs a "between two cells" to draw in.
           (2) EDGE + ROTATION: "why not the left edge when in tile view?" and "u
           can just rotate the thing 90 degrees including rotating text right" —
           so it is the list's chip turned on its side, ⛓ at the top with the text
           reading downward, straddling the tile's left edge.

           GRID ONLY, and NOT ON DISPLAY INDEX 1. In list view this same transition
           is the slice above the row; drawing both would state it twice. Slide 1
           has no predecessor, hence no incoming transition, hence a bare edge —
           the same fact the list expresses by having no slice above its first row.

           IT IS THE SAME SELECTION, NOT A LOOKALIKE: the same
           app.selectTransitionAt with the same shift/cmd multi-select, the same
           two render axes (.selected membership tint, .primary text) and the same
           tokens as .tr-chip. So a transition selected here stays selected through
           a view toggle, and the Property Panel cannot tell which view selected it.

           THE STUBS are the list's connector lines rotated with everything else:
           a hairline runs down the seam above and below the pill, so the pill
           reads as sitting ON a line rather than floating on an edge. -->
      {#if isGrid && i > 0}
        {@const info = transitionInfo(i)}
        {@const label = pillLabel(info, tileHeightPx)}
        <span class="spine" class:dimmed={dragState?.moved} aria-hidden={dragState?.moved ? "true" : null}>
          <span class="spine-stub"></span>
          <!-- THE TOOLTIP ALWAYS CARRIES THE FULL SENTENCE, which is what lets the
               visible label condense at all: at the narrowest step the pill is the
               ⛓ alone, and the transition's type and duration are still one hover
               away. The label is never hidden — a STANDING ruling ("The tween
               thing should always be there") — it is SHORTENED. -->
          <Tooltip disabled={dragActive} text={`Transition into slide ${i + 1}: ${info.title} · ${formatSeconds(info.seconds)} — click to edit, Shift or ${CMD_KEY_NAME}-click to select several`}>
            <button
              class="spine-pill tr-chip"
              class:selected={app.isTransitionSelected(slide.id)}
              class:primary={app.selectedTransition === slide.id}
              aria-label={`Transition into slide ${i + 1}`}
              aria-pressed={app.isTransitionSelected(slide.id)}
              onclick={(e) => app.selectTransitionAt(slide.id, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey })}
            >
              <!-- THE ICON IS OUT OF FLOW (see .spine-icon's app.css note for why:
                   an iconify-icon custom element sharing normal flow with the
                   label under this pill's inherited vertical-rl is what clipped
                   the label in the first place). It is absolutely positioned at
                   the pill's block-start end and never participates in the text
                   flow the label auto-sizes from. -->
              <iconify-icon class="spine-icon" icon={TRANSITION_ICONS[info.type] ?? "mdi:transition"} width="12" height="12"></iconify-icon>
              {#if label}<span class="tr-label">{label}</span>{/if}
            </button>
          </Tooltip>
          <span class="spine-stub"></span>
        </span>
      {/if}
      </div>
    {/each}
    <!-- THE TAIL BOUNDARY (drop at the very end). Same reason the head rail
         exists: without it the last gap is the one gap with no indicator.
         LIST ONLY — the grid draws that boundary as the last tile's own
         `.seam-after` edge, for the reason the head rail's note gives. -->
    {#if !isGrid}
      <div class="drop-rail" class:drop={isDropBoundary(app.doc.slides.length)}></div>
    {/if}
  </div>
  <!-- THE DRAG GHOST — the "literally dragging it" half of the user's ruling.
       A position:fixed copy of the dragged slide's number + name + thumbnail,
       translated to the pointer, so the block visibly travels with the cursor
       while its real slot sits empty.

       FIXED, NOT ABSOLUTE, and rendered OUTSIDE the scroll container: the rail
       scrolls, and an absolutely-positioned ghost would scroll with it and drift
       away from a stationary cursor. Fixed coordinates are pointer coordinates,
       which is exactly what clientY already is — no scroll compensation, nothing
       to keep in sync.

       pointer-events:none (CSS) so it never becomes the drop target it is
       hovering, and it renders only mid-drag, so it costs nothing at rest. A
       multi-slide drag shows its FIRST row plus a count, rather than N stacked
       ghosts: the block moves as one thing and the number says how big it is.

       IN GRID VIEW IT TRACKS X TOO, and a multi-slide drag STACKS. A rail ghost
       only ever needed one axis because a list drag is vertical; a grid drag goes
       anywhere, so the ghost's left is the pointer's, offset by where inside the
       tile it was grabbed (grabDx), exactly as its top already was by grabDy. The
       STACK is `.ghost-stack` — two offset shadow layers behind the lead tile,
       which is the settled rendering of "lifted tiles collapse into a STACKED
       ghost with a count badge"; the count badge is the same `.ghost-count` the
       list already carries, so the two views say "and N more" the same way. -->
  {#if dragState?.moved}
    {@const lead = dragState.indices[0]}
    <div
      class="drag-ghost"
      class:ghost-stack={isGrid && dragState.indices.length > 1}
      aria-hidden="true"
      style:left={`${isGrid ? dragState.pointerX - dragState.grabDx : dragState.ghostX}px`}
      style:width={`${dragState.ghostW}px`}
      style:top={`${dragState.pointerY - dragState.grabDy}px`}
    >
      <span class="row-top">
        <span class="num">{lead + 1}</span>
        <span class="name">{app.doc.slides[lead]?.name}</span>
        {#if dragState.indices.length > 1}
          <span class="ghost-count">+{dragState.indices.length - 1}</span>
        {/if}
      </span>
      {#if thumbAspect(lead)}
        <DirtyImage
          class="thumb"
          render={renderThumb(lead)}
          dirtyKey={publishedKeys[lead]}
          schedule={thumbScheduler.request}
          aspect={thumbAspect(lead)}
          alt=""
        />
      {/if}
    </div>
  {/if}
  <!-- THE FOOTER IS FIVE BUTTONS, AND ITS ICONS COME FROM THE COMMAND ENTRIES.
       See the footer note in the script for both rulings and for why the icons
       are no longer written here. -->
  <div class="nav-actions">
    {#each FOOTER_COMMANDS as { id, label }}
      <Tooltip text={label()}>
        <button
          class="btn-icon"
          aria-label={label()}
          data-nav-action={id}
          onclick={() => app.runCommand(id)}
          disabled={id === "delete-slides" && app.doc.slides.length <= selectionCount()}
        >
          <iconify-icon icon={app.commands.get(id).icon} width="16" height="16"></iconify-icon>
        </button>
      </Tooltip>
    {/each}
    <!-- THE VIEW TOGGLE — the sixth control, and the user placed it here by name
         ("that could be a toggle button on the bottom where it shows delete slide,
         move slide down, move slide up. And then you would have the view option").
         It is NOT a command and writes its own icon; the script's note beside
         VIEW_TOGGLE_ICONS says why that is not a violation of the read-your-icon
         rule the five buttons beside it follow.

         SEPARATED BY A HAIRLINE (.nav-view-sep), because it is a different KIND of
         control: the five act on the document, this one changes how the panel
         draws. Grouping them without a divider would invite the reading that this
         is a sixth slide operation. -->
    <span class="nav-view-sep" aria-hidden="true"></span>
    <Tooltip text={viewToggleLabel()}>
      <button
        class="btn-icon"
        aria-label={viewToggleLabel()}
        aria-pressed={isGrid}
        data-nav-view={viewMode}
        onclick={toggleViewMode}
      >
        <iconify-icon icon={VIEW_TOGGLE_ICONS[viewMode]} width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
  </div>
</div>
