/**
 * BRACE — the curly `{` and the square `[`, as a THREE-POINT connector.
 *
 * User, 2026-08-02: "add a curly brace shape and brace shape … that has two
 * points on either end in the same way that an arrow does, and a third point that
 * can also be anchored. So it's a three-point thing where the points are all like
 * arrow points — individual, not exactly handles, but points that can be anchored.
 * And then the third one determines where the pointy bit of this curly bracket is,
 * and that also determines how it's flipped, and it's always orthogonal to the
 * other two, but can be shifted right or left."
 *
 * ── IT IS A CONNECTOR, NOT A BOX ─────────────────────────────────────────────
 * `capabilities.bbox: false`, no x/y/w/h, world transform identity — the arrow
 * family's shape, and for the arrow family's reason: a brace's geometry IS its
 * three world points. Which means all three get the SHARED endpoint machinery
 * (core/endpoints.js `endpointPairHooks`, whose key list has always been a
 * parameter) rather than a new handle kind: draggable, `=`-bindable, anchorable
 * to another item, and covered by the equation-lock rule that stops a drag
 * silently destroying an anchor binding.
 *
 * THERE IS NO `constrain` HERE AND THAT IS THE DESIGN, not an omission. "Always
 * orthogonal" describes how the brace is BUILT from the tip, not a restriction on
 * where the tip may go: core/brace.js reads the tip in the span's axis frame, so
 * the nub is perpendicular by construction while the point controlling it stays
 * completely free. A constrained tip could not be anchored to an arbitrary item,
 * which is exactly what the user asked for.
 *
 * ── TWO WIDGETS, ONE FACTORY ─────────────────────────────────────────────────
 * A curly brace and a square bracket are the same seven-point skeleton with
 * rounded or sharp corners, so they come from one factory differing in `curl`.
 * The precedent is plugins/shapeshifter.js — one file, one factory, an array
 * export — which core/registry.js's own docblock cites as the family shape, and
 * which plugins/corkboard.js already follows. No plugin imports another; the
 * shared geometry lives in core/brace.js, where it is bare-node testable.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { path } from "../render_gpu/ir.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import { endpointPairHooks, hitsShaft, ARROW_STROKE_WIDTH } from "../core/endpoints.js";
import { morphPayloadFromConnector, statePaint } from "../core/morph_payload.js";
import { bracePathD, braceInkRect, handleSegments, segmentT, segmentAt, clamp01 } from "../core/brace.js";

/** The three point keys, in path order. `tip` is LAST so the two ends read as a
 *  pair first — the same from/to vocabulary every other connector uses — and the
 *  new point is plainly the addition. */
const POINT_KEYS = ["from", "to", "tip"];

/**
 * THE LOOK IS TWO CONTINUOUS KNOBS, NOT A CHOICE OF THREE SHAPES.
 * User, 2026-08-02: "have handles on the brace so I can control the curve and
 * interpolate between that and a straight-liney version of the bracket and
 * another that's right angle, smoothly, all with presets."
 *
 *   curl     0 → sharp corners, 1 → fully rounded
 *   shoulder 0 → a straight chevron (each arm runs straight to the nub)
 *            1 → the classic bracket profile (arms at half the bulge)
 *
 * Every look the user named is a point in that square — curly {1,1}, right-angle
 * {0,1}, straight {·,0} — so the three INTERPOLATE by construction, keyframe like
 * any other number, and tween. Two scalars rather than one "style" enum for
 * exactly that reason: an enum cannot be halfway between two of its values.
 *
 * The per-TYPE defaults below are only where each widget starts in that square.
 */
const CURLY = 1;
const SQUARE = 0;

/**
 * THE PRESETS — the named corners of the (curl, shoulder) square, plus the two
 * useful in-between stops. Literal-valued, per R6-25.1 (an equation-valued preset
 * would be `=`-prefixed; none of these needs one).
 */
const PRESETS = [
  { name: "Curly", description: "The classic `{` — fully rounded corners over a bracket profile.", props: { curl: 1, shoulder: 1 } },
  { name: "Right Angle", description: "A square bracket `[` with a centre nub: sharp corners, same profile.", props: { curl: 0, shoulder: 1 } },
  { name: "Straight", description: "A plain chevron — each arm runs straight from its end to the point, no bracket arms at all.", props: { curl: 0, shoulder: 0 } },
  { name: "Soft Chevron", description: "A chevron with its point rounded off: straight arms, curved apex.", props: { curl: 1, shoulder: 0 } },
  { name: "Half Curl", description: "Halfway between square and curly — the corners are eased rather than rounded.", props: { curl: 0.5, shoulder: 1 } },
  { name: "Wide Shoulders", description: "Curly, but the arms hug the span more tightly before turning out to the point.", props: { curl: 1, shoulder: 0.65 } },
  { name: "Crisp Bracket", description: "Nearly square corners over an almost-full bracket profile — a bracket with just the hard edge taken off.", props: { curl: 0.25, shoulder: 0.85 } },
  { name: "Gentle Point", description: "Mostly straight arms with a softened point — closer to a chevron than a bracket, but not quite either.", props: { curl: 0.35, shoulder: 0.15 } },
  { name: "Tight Curl", description: "Rounded corners on arms that hug the span closely before angling in to the point — a curly brace drawn narrow.", props: { curl: 0.85, shoulder: 0.35 } },
  { name: "Slender Curl", description: "Fully rounded corners with the shoulders pulled way in — a thin curly point on a short bracket profile.", props: { curl: 1, shoulder: 0.15 } },
  { name: "Narrow Bracket", description: "Sharp square corners with the shoulders pulled in short — a compact bracket rather than the full-profile square brace.", props: { curl: 0, shoulder: 0.3 } },
  { name: "Balanced Blend", description: "Dead centre of the curl/shoulder square — half-rounded corners over a half-length bracket profile, evenly between every named look.", props: { curl: 0.5, shoulder: 0.5 } },
];

/**
 * Pure function. Anchors ON the drawn brace: its two ends and its nub — the three
 * places a label or another connector actually wants to attach.
 *
 * THE MIDDLE ONE IS CALLED `mid`, NOT `tip`, and the naming is deliberate. Every
 * connector in this app publishes start / mid / end (core/endpoints.js
 * CONNECTOR_PATH_ANCHORS), and tests/connector_anchors_test.js enforces it — so
 * `= @brace1.anchors.mid.x` means the same kind of thing as it does on an arrow.
 * Forking the vocabulary for one widget would buy a more evocative word and cost
 * the uniformity that makes anchor bindings learnable. On a brace, `mid` is the
 * NUB — which, unlike an arrow's, can sit anywhere along the span, since the tip
 * point slides. It is the middle anchor of the PATH, not of the straight span.
 *
 * NOT the standard nine over a bounding box, for the reason core/endpoints.js
 * `connectorPathAnchors` gives for the arrow family: a connector's bounding box is
 * mostly empty, so box anchors would publish attachment points in thin air. Not
 * `connectorPathAnchors` itself either, because that walks a POLYLINE by arc
 * length and a brace's meaningful points are named, not fractional.
 *
 * @param {object} s - the widget state
 * @returns {{id: string, x: number, y: number}[]}
 *
 * @example // braceAnchors({from: {x: 0, y: 0}, to: {x: 100, y: 0}, tip: {x: 50, y: 40}})
 * // [{id: "start", x: 0, y: 0}, {id: "mid", x: 50, y: 40}, {id: "end", x: 100, y: 0}]
 */
function braceAnchors(s) {
  return [
    { id: "start", x: s.from.x, y: s.from.y },
    { id: "mid", x: s.tip.x, y: s.tip.y },
    { id: "end", x: s.to.x, y: s.to.y },
  ];
}

/**
 * Pure function. Is a WORLD point on the brace's ink?
 *
 * Tested against the two ARMS (end→nub and nub→end) rather than the straight
 * from→to span, because that span is where the brace ISN'T — a `{` is nowhere
 * near the line joining its tips, so hit-testing it would grab empty space and
 * miss the drawn curve entirely. Two segment tests approximate the arms closely
 * enough at any curl, and reuse the shared `hitsShaft` (which carries the house's
 * grab padding) rather than restating a distance-to-segment.
 *
 * @param {object} s - the widget state
 * @param {number} wx - world x
 * @param {number} wy - world y
 * @returns {boolean}
 */
function hitsBrace(s, wx, wy) {
  const radius = s.strokeWidth ?? ARROW_STROKE_WIDTH;
  // Each arm as a two-point pseudo-state, so hitsShaft's keys parameter does the work.
  const arm1 = { a: s.from, b: s.tip };
  const arm2 = { a: s.tip, b: s.to };
  return hitsShaft(arm1, wx, wy, radius, ["a", "b"]) || hitsShaft(arm2, wx, wy, radius, ["a", "b"]);
}

/**
 * Pure function. Builds one brace widget.
 *
 * @param {{type: string, title: string, curl: number, icon: string, commandId: string, commandTitle: string, defaultTip: object}} spec
 * @returns {object} a registry-ready plugin
 */
function braceWidget(spec) {
  const plugin = {
    type: spec.type,
    // NONE: pure vector, correct on the very first frame — no async source, no
    // cheap tier to converge from (core/ephemeral.js).
    ephemeral: EPHEMERAL.NONE,
    title: spec.title,
    capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
    // A PRESET IDENTICAL TO THE WIDGET'S OWN DEFAULT IS A ROW THAT DOES NOTHING,
    // and tests/arrow_presets_test.js catches it by RENDERING every preset and
    // requiring each to differ visually from the default — which is how the curly
    // widget's "Curly" entry was caught. Each type therefore drops the one entry
    // that is its own starting point. DERIVED from the defaults rather than two
    // hand-written lists, so a change to either default keeps them consistent.
    presets: PRESETS.filter((pre) => !(pre.props.curl === spec.curl && pre.props.shoulder === 1)),
    defaults: {
      type: spec.type, z: 1,
      from: { x: 200, y: 260 }, to: { x: 200, y: 420 },
      tip: spec.defaultTip,
      curl: spec.curl, shoulder: 1,
      stroke: "#000000", strokeWidth: ARROW_STROKE_WIDTH, opacity: 1,
      ...bundleNestedDefaults("effects"),
    },
    inspector: [
      // The endpoints bundle gives from/to/z as equation-aware nested fields; the
      // tip needs the same treatment, declared here because the bundle is a PAIR.
      ...bundle("endpoints"),
      ...props("tip.x", "tip.y"),
      ...props("curl", "shoulder"),
      ...props("stroke", "strokeWidth"),
      ...props("opacity"),
      ...bundle("effects"),
    ],
    /**
     * Pure function. State → display-list commands. The three points are already
     * world coordinates (identity transform), so core/brace.js's path is emitted
     * directly. STROKED, never filled: a brace is a rule, not a region.
     */
    emit(s, _targetWorldIR, world) {
      const d = bracePathD(s.from, s.to, s.tip, s.curl ?? spec.curl, s.shoulder ?? 1);
      if (!d) return []; // degenerate span — draw nothing rather than an invalid op
      const op = path({
        d,
        stroke: s.stroke,
        strokeWidth: s.strokeWidth ?? ARROW_STROKE_WIDTH,
        fill: null,
        opacity: s.opacity ?? 1,
      });
      // Effects wrap the finished op over the widget's OWN ink rect — the same
      // rect localBounds reports, so the effect region and the cull bounds can
      // never disagree about where this widget is (the arrow's rule).
      return applyEffects([op], s, world, braceInkRect(s));
    },
    /**
     * Pure function. THE MORPH OUTLINE (core/registry.js's `morphPaths`
     * protocol): the brace's own `d` — the SAME `bracePathD` emit() draws — as
     * ONE OPEN subpath, in the ink rect's frame.
     *
     * CENTERLINE, and here the widget's own emit() says so in as many words:
     * "STROKED, never filled: a brace is a rule, not a region". There is no
     * silhouette to reuse because the ink has no interior — the `d` IS the curve
     * the painter expands to a width. Reusing it verbatim means the morph traces
     * the brace's serifs, shoulders and nub exactly as drawn, at whatever `curl`
     * and `shoulder` the state carries, with the weight riding in
     * `paint.strokeWidth`.
     *
     * The path stays OPEN: a brace's two arms genuinely do not meet, and the
     * engine morphs open subpaths natively (a closed target's `Z` steps in at
     * alpha > 0 under the open↔closed policy). A degenerate span yields an EMPTY
     * payload, sharing emit()'s own guard rather than restating it.
     */
    morphPaths(s) {
      const d = bracePathD(s.from, s.to, s.tip, s.curl ?? spec.curl, s.shoulder ?? 1);
      return morphPayloadFromConnector(
        d ? [{ d, paint: statePaint({ ...s, fill: null }) }] : [],
        braceInkRect(s),
      );
    },
    /** Pure function. Why this brace cannot morph YET, or null. Shares emit()'s
     * degenerate-span guard, so the gate cannot disagree with what is drawable. */
    morphNotReady(s) {
      return bracePathD(s.from, s.to, s.tip, s.curl ?? spec.curl, s.shoulder ?? 1)
        ? null : "a non-zero span (this one collapses and draws nothing)";
    },
    // THE BOUNDS PROTOCOL: the hull of the three points, like the arrow's
    // endpoint hull — so a brace culls and band-selects despite having no w/h.
    localBounds: braceInkRect,
    anchors: braceAnchors,
    cullMargin: effectsCullMargin,
    hitTestWorld: (node, wx, wy) => hitsBrace(node.state, wx, wy),
    /**
     * THE TWO LOOK HANDLES (the "PPT yellow squares"), distinct from the three
     * POINTS above. The points say WHERE the brace is and are anchorable; these
     * say WHAT IT LOOKS LIKE and each writes ONE number. `constrain` does real
     * work here — unlike the tip, which is deliberately free — because each
     * handle's whole meaning is a position ALONG one segment.
     *
     * Both are the same two lines because both are `segmentT`/`segmentAt` over a
     * segment core/brace.js computes: the drawn position and the value read back
     * cannot disagree, since one is the other's inverse.
     *
     * ABSENT WHEN THERE IS NOTHING TO SHAPE — a degenerate span or a tip sitting
     * on the axis has no corner and no arm, so offering handles there would be
     * two controls that do nothing.
     */
    modifierPoints(s) {
      const seg = handleSegments(s);
      if (!seg) return [];
      return [
        { id: "shoulder", ...segmentAt(...seg.shoulder, s.shoulder ?? 1),
          stem: seg.shoulder[0],
          constrain: (st, p) => segmentAt(...handleSegments(st).shoulder, segmentT(...handleSegments(st).shoulder, p)),
          apply: (st, p) => ({ shoulder: segmentT(...handleSegments(st).shoulder, p) }) },
        { id: "curl", ...segmentAt(...seg.curl, s.curl ?? 1),
          stem: seg.curl[0],
          constrain: (st, p) => segmentAt(...handleSegments(st).curl, segmentT(...handleSegments(st).curl, p)),
          apply: (st, p) => ({ curl: segmentT(...handleSegments(st).curl, p) }) },
      ];
    },
    // THREE draggable, anchorable points from the shared two-point machinery —
    // its key list was always a parameter, so this needed no new capability.
    ...endpointPairHooks(POINT_KEYS),
    // Placement lays the SPAN by click-drag (from→to), exactly like an arrow; the
    // tip takes its default offset from that span and is then draggable.
    placement: "endpoints",
    commands: [
      { id: spec.commandId, title: spec.commandTitle, icon: spec.icon, run: (app) => app.armCrosshairPlacement(plugin) },
    ],
  };
  return plugin;
}

export const braceCurlyPlugin = braceWidget({
  type: "brace_curly",
  title: "Curly Brace",
  curl: CURLY,
  icon: "mdi:code-braces",
  commandId: "add-brace-curly",
  commandTitle: "Add Curly Brace",
  // Default nub: halfway along a 160-tall span, 44 out to the left — a readable
  // `{` the moment it is placed, rather than a straight line the user must
  // discover a third handle to fix.
  defaultTip: { x: 156, y: 340 },
});

export const braceSquarePlugin = braceWidget({
  type: "brace_square",
  title: "Square Brace",
  curl: SQUARE,
  icon: "mdi:code-brackets",
  commandId: "add-brace-square",
  commandTitle: "Add Square Brace",
  defaultTip: { x: 156, y: 340 },
});

/** THE FAMILY, as one array export — the shapeshifter/corkboard registration
 *  precedent, so plugins/index.js spreads it and a third member needs no edit
 *  at the call site. */
export const bracePlugins = [braceCurlyPlugin, braceSquarePlugin];
