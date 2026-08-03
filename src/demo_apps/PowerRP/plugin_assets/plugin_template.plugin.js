// ============================================================================
// PLUGIN ASSET TEMPLATE — hand this file to your Claude (or edit it yourself).
// ============================================================================
//
// WHAT THIS IS. PowerRP widgets are normally source files in plugins/, which
// means adding one needs a checkout and a rebuild. A PLUGIN ASSET is the same
// widget delivered as a FILE IN YOUR PROJECT'S ASSETS FOLDER, named
// `something.plugin.js`. Drop it in (Asset Explorer, drag-and-drop, or the
// project zip) and the widget exists in that project — no build, no deploy, and
// it TRAVELS WITH THE DECK, so whoever you share the project with gets the
// widget too.
//
// HOW TO USE THIS FILE
//   1. Copy it to `<your thing>.plugin.js`.
//   2. Change `type` to a unique lower_snake_case name. It must not collide with
//      a built-in (the loader REFUSES a collision rather than shadowing — see
//      "REFUSALS" below), and `defaults.type` must be the SAME string.
//   3. Write your geometry as pure helper functions above the `return`.
//   4. Declare your knobs in `customProps([...])` and draw with them in `emit`.
//   5. Upload it as a project asset. Reopen the project; the widget is there.
//
// ── THE SHAPE OF THE FILE ────────────────────────────────────────────────────
// This file is a FUNCTION BODY, not an ES module. Two consequences:
//   - `return { … }` is how you hand back your plugin. There is exactly one.
//   - there are NO `import` statements, and `import(...)` is refused. Everything
//     you may use is listed under "WHAT YOU CAN USE" below — the host injects it.
//
// ── THE SANDBOX (please read this part) ──────────────────────────────────────
// Your plugin runs in the browser of everyone who opens the deck. They agreed to
// look at slides, not to run your code against their session — so the loader
// (core/plugin_assets.js) runs this file in a JAIL. Unavailable, by design:
//
//   window, document, globalThis, navigator      — no DOM, no host object
//   fetch, XMLHttpRequest, WebSocket             — no network
//   Date, performance                            — no wall clock (see DETERMINISM)
//   Math.random                                  — no unseeded randomness
//   setTimeout, setInterval, queueMicrotask      — no scheduling
//   eval, Function, `import()`, require          — no runtime code loading
//   Object.getPrototypeOf / defineProperty / …   — no prototype reflection
//
// These are not style rules; they are enforced, and a plugin that reaches for one
// fails LOUDLY at load rather than half-working. If you find yourself needing one
// of them, the widget you are writing is probably not a widget — a widget
// DESCRIBES a picture from its own state, and nothing else.
//
// ── DETERMINISM: THE ONE RULE THAT WILL BITE YOU ─────────────────────────────
// The same document must always produce the same picture. That is what makes CLI
// stills, server-side video export, and sharded rendering (frame 200 rendered on
// a different machine than frame 199) possible at all. So:
//
//   * NEVER read a clock. `Date` is blocked; for animation, read the presentation
//     time through an `= time`-based equation on one of your own knobs instead.
//     Then your widget animates AND exports correctly, for free.
//   * NEVER use unseeded randomness. `Math.random` is blocked. If you want
//     scattered dots, take a `seed` knob and call `random(seed)` (a seeded
//     generator the host provides) — the same seed gives the same scatter on
//     every machine and every frame.
//   * NEVER remember anything between calls. `emit` must be a pure function of
//     the state it is handed. If you accumulate (a physics sim), frame 200 stops
//     being renderable without frame 199 and export breaks.
//
// ── WHAT YOU CAN USE (the host injects all of these) ─────────────────────────
//
// PROPERTY REGISTRY — how you compose Inspector rows and defaults:
//   props("fill", "stroke", "strokeWidth", "opacity")  → standard rows
//   bundle("transform") / bundle("strokedBox") / bundle("effects")
//   defaults("opacity", "cornerRadius")                → their default values
//   bundleNestedDefaults("effects")                    → a bundle's defaults
//   customProps([{name, kind, default, min?, max?, step?, help?}])
//                                                      → YOUR OWN knobs, as
//                                                        {rows, defaults}
//   STROKE_TRIM_KEYS                                   → draw-on / dash rows
//
// DRAWING (the display list — your emit returns an array of these):
//   rect({x, y, w, h, cornerRadius, fill, stroke, strokeWidth, opacity})
//   ellipse({cx, cy, rx, ry, fill, stroke, strokeWidth, opacity})
//   path({d, fill, stroke, strokeWidth, fillRule, opacity})   ← "d" is SVG path
//   polygon({points, fill, opacity})   polyline({points, width, color})
//   text({text, x, y, size, color, bold, opacity})
//   ir                                → the whole IR module, if you need more
//   applyEffects(ops, state, world, bounds)  ← ONLY if you declare bundle("effects")
//   effectsCullMargin                        ← the matching cullMargin hook
//
// GEOMETRY & MATH:
//   Math (without random)   random(seed)   standardBBoxAnchors
//   T (transform module)    G (geometry module)    shapes (shape library)
//   JSON, Object (reduced), Array, String, Number, Boolean, Map, Set,
//   isNaN, isFinite, parseFloat, parseInt, Error, console
//
// ── COORDINATES ──────────────────────────────────────────────────────────────
// `emit` works in LOCAL box coordinates: (0,0) is your widget's top-left and
// (state.w, state.h) is its bottom-right. Position, rotation, scale and flipping
// are applied by the engine AFTER you draw, so you never handle them. You will
// also never see a negative w or h — a flip is resolved before your hook is
// called, so write `s.w / 2` freely.
//
// ── REFUSALS (each one is loud, and names this file) ──────────────────────────
//   * `type` collides with a built-in or another asset → REFUSED, not shadowed.
//   * `emit` missing or not a function → refused.
//   * `defaults.type` differs from `type` → refused (it would create wrong items).
//   * `commands: [...]` declared → refused. A palette command's run(app) receives
//     the live editor, which is the one capability the sandbox withholds. The app
//     surfaces asset widgets in its own insert menu instead.
//   * anything in the blocked list above → throws where it is used.
// A broken plugin asset does NOT stop the others in the project from loading; its
// reason is reported, and only it is skipped.
//
// ── WORKED EXAMPLES SHIPPED BESIDE THIS FILE ─────────────────────────────────
//   superellipse.plugin.js  — a parameterized shape (Lamé exponent), with a
//                             draggable handle that writes the exponent.
//   gear.plugin.js          — an integer knob (tooth count), an evenodd hub hole,
//                             an exact per-tooth hitTest, two handles.
//   demo_showcase_asset.plugin.js — a built-in widget ported verbatim, kept as
//                             the proof that this format is the same API.
//
// The full hook list (localBounds, hitTest, canSkip, snapFeatures, editPoints,
// presets, …) is documented in core/registry.js's docblock — that file is the
// widget contract, and everything in it works here.
// ============================================================================

// ── 1. YOUR GEOMETRY. Pure functions: same input, same output, no outside world.
//       Keep the math here and keep `emit` thin — it is easier to reason about,
//       and these helpers are the part worth testing.

/** How finely a curve is sampled. Named because a bare 64 explains nothing. */
const OUTLINE_SAMPLES = 64;

/**
 * Pure function. An example outline: a rounded N-pointed star inscribed in the
 * LOCAL box, as an SVG path string. Replace this with your own shape.
 *
 * @param {number} w - box width (local units)
 * @param {number} h - box height
 * @param {number} points - how many star points
 * @param {number} innerRatio - inner radius as a fraction of the outer (0..1)
 * @returns {string} an SVG path "d" attribute
 */
function starPath(w, h, points, innerRatio) {
  const cx = w / 2, cy = h / 2;
  const outer = Math.min(cx, cy);
  const inner = outer * Math.max(0.05, Math.min(Number(innerRatio) || 0.5, 0.95));
  const n = Math.max(3, Math.min(Math.round(Number(points) || 5), 40));
  let d = "";
  for (let i = 0; i < n * 2; i++) {
    // Start at -90° so the first point is at the top, which is what a reader
    // expects a star to look like.
    const angle = -Math.PI / 2 + (i / (n * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? outer : inner;
    const x = cx + r * Math.cos(angle), y = cy + r * Math.sin(angle);
    d += `${i === 0 ? "M" : "L"}${x.toFixed(3)} ${y.toFixed(3)}`;
  }
  return `${d}Z`;
}

// ── 2. YOUR KNOBS. Each becomes an Inspector row under "Custom", is keyframable,
//       and can be driven by an `=` equation (e.g. `= self.w / 10`, `= time * 2`)
//       with nothing extra to declare. `help` is the tooltip the user reads.

const CUSTOM = customProps([
  {
    name: "points",
    kind: "number",
    default: 5,
    min: 3,
    max: 40,
    step: 1,
    help: "How many points the star has.",
  },
  {
    name: "innerRatio",
    kind: "number",
    default: 0.5,
    min: 0.05,
    max: 0.95,
    step: 0.01,
    help: "Inner radius as a fraction of the outer radius. Small = spiky, large = chunky.",
  },
]);

// ── 3. YOUR PLUGIN. One object, returned. Every field is explained inline.

return {
  // A unique lower_snake_case id. CHANGE THIS, and change defaults.type to match.
  type: "my_star",
  // The human-readable name shown in menus and the Inspector header.
  title: "My Star",
  // What the app is allowed to do with this widget. Tools dispatch on these
  // CAPABILITIES, never on the type name — which is why the whole app needs no
  // knowledge of your widget at all.
  capabilities: {
    bbox: true,       // has x, y, w, h
    transform: true,  // has x, y (+ rotation, scale)
    resizable: true,  // resize handles allowed
    backdrop: false,  // does not sample what is painted behind it
  },
  // The state a NEW instance starts with. Anything here is keyframable and
  // equation-bindable automatically — there is no separate registration step.
  defaults: {
    type: "my_star", // MUST equal `type` above
    x: 200, y: 200, w: 180, h: 180, z: 0, rotation: 0, scale: 1,
    // Rotate about the box centre by default (an equation, evaluated per frame).
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#bb9af7", stroke: "#000000", strokeWidth: 2,
    ...defaults("opacity"),
    ...bundleNestedDefaults("effects"), // shadow / bloom / blend, all OFF
    ...CUSTOM.defaults,                 // your knobs' defaults
  },
  // The Inspector, composed from shared row sets plus your own. Order is the
  // order the user sees.
  inspector: [
    ...bundle("transform"),                    // x / y / w / h / rotation / scale
    ...props("fill", "stroke", "strokeWidth"),   // paint
    ...props("opacity"),
    ...CUSTOM.rows,                              // your knobs
    ...bundle("effects"),                        // shadow / bloom / soft edges / …
  ],
  /**
   * Pure function. THE render API: state → an array of draw commands in LOCAL
   * coordinates. Called on every frame, so keep it cheap and keep it pure.
   *
   * `applyEffects` is called here because this template declares bundle("effects")
   * in its inspector. If you DROP those rows, drop this call and the cullMargin
   * below too — the engine then applies effects for you. Declare the rows without
   * the call and your five effect controls would do nothing.
   *
   * @param {object} s - the widget's evaluated state (equations already resolved)
   * @param {*} _targetWorldIR - unused by most widgets
   * @param {object} world - this widget's world transform (applyEffects needs it)
   * @returns {Array<object>} display-list commands
   */
  emit(s, _targetWorldIR, world) {
    const ops = [path({
      d: starPath(s.w ?? 0, s.h ?? 0, s.points, s.innerRatio),
      fill: s.fill,
      // A zero stroke width means "no stroke" — pass null so the backend skips it
      // rather than drawing a hairline.
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      opacity: s.opacity ?? 1,
    })];
    return applyEffects(ops, s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  // The LOCAL rect your ink occupies. Culling, band-select and export capture all
  // read this. A star is inscribed in its box, so the box is correct here.
  localBounds: (s) => ({ x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 }),
  // The effects halo (a shadow spills outside the ink), so a widget just off
  // screen is not culled while its glow should still be visible.
  cullMargin: effectsCullMargin,
  // The nine standard anchor points (tl, tm, tr, ml, cm, mr, bl, bm, br) that
  // arrows bind to and snapping uses.
  anchors: standardBBoxAnchors,
  /**
   * OPTIONAL. Is a LOCAL point on your silhouette? Omit it and the whole box is
   * clickable, which is fine for a rectangle and wrong for a star (its empty
   * corners would select it). This one is approximate on purpose: exact
   * point-in-star is more code than the affordance is worth.
   */
  hitTest(s, lx, ly) {
    const cx = (s.w ?? 0) / 2, cy = (s.h ?? 0) / 2;
    const outer = Math.min(cx, cy);
    if (outer <= 0) return false;
    return Math.hypot(lx - cx, ly - cy) <= outer;
  },
  /**
   * OPTIONAL. Draggable "yellow square" handles, each writing ONE parameter.
   * Two separate jobs, deliberately kept apart:
   *   constrain(state, desired) → where the handle is ALLOWED to be (a projection)
   *   apply(state, allowed)     → what that position MEANS (a partial state)
   * Splitting them is what lets an equation or a binding drive the handle, not
   * just a mouse.
   */
  modifierPoints(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const cx = w / 2, cy = h / 2;
    const outer = Math.min(cx, cy);
    const ratio = Math.max(0.05, Math.min(Number(s.innerRatio) || 0.5, 0.95));
    return [{
      id: "innerRatio",
      shape: "triangle",              // a distinct glyph: it writes a parameter
      x: cx + outer * ratio,          // ride the horizontal centre line
      y: cy,
      stem: { x: cx, y: cy },         // dashed tether to what it is measured from
      constrain(state, desired) {
        const r = Math.min((state.w ?? 0) / 2, (state.h ?? 0) / 2);
        const scx = (state.w ?? 0) / 2, scy = (state.h ?? 0) / 2;
        if (r <= 0) return { x: scx, y: scy };
        const f = Math.max(0.05, Math.min((desired.x - scx) / r, 0.95));
        return { x: scx + r * f, y: scy };
      },
      apply(state, allowed) {
        const r = Math.min((state.w ?? 0) / 2, (state.h ?? 0) / 2);
        if (r <= 0) return { innerRatio: 0.5 };
        return { innerRatio: Math.max(0.05, Math.min((allowed.x - (state.w ?? 0) / 2) / r, 0.95)) };
      },
    }];
  },
  // NOTE: `commands: [...]` is NOT allowed here (see REFUSALS above).
};
