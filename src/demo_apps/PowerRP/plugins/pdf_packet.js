/**
 * PDF PACKET widget — a corner-STAPLED packet of a PDF's pages that turns like
 * physical paper. `page` is FRACTIONAL and equation-capable: page 2.3 means
 * page 2 is 30% through peeling over the staple (deterministic — a pure
 * function of the value, so it tweens/keyframes/scrubs like any property).
 *
 * Built against photo/animation reference (.frenzy/pdf_packet_refs/, agents
 * 1-10 — observations.md in each folder). The rules that shaped it:
 *   - paper is a DEVELOPABLE surface: the turning sheet is the cylinder
 *     rollback of render_gpu/page_curl.js, never a stretch or a hinge
 *   - the staple is a fixed pin: the fold sweeps toward it, everything pivots
 *     around it, and the pinned zone is only the staple's own footprint
 *   - two-layer geometry-derived shadows (soft penumbra + dark core), capped
 *     well short of black (the paperCurl op draws them from the mesh)
 *   - turned pages don't flop flat: they keep a residual bow (wide for the
 *     just-turned page, tighter for older ones) and FAN around the staple
 *   - the remaining stack reads as a stack through per-page ROTATION jitter
 *     (not translation) and edge hairlines
 *
 * RENDERING: the stack, open page, and staple are ordinary vector/image ops
 * (crisp in exports); the turning sheet and each turned page are `paperCurl`
 * ops (render_gpu/ir.js) — the ONE new op, whose Skia handler draws the mesh
 * and whose export story is the generic not-in-VECTOR_OPS raster fallback.
 * PDF pages reach the renderer exactly like plugins/pdf_page.js's camera-free
 * path: whole-page rasters via render_gpu/gpu/pdf_page_raster.js refs.
 */

import { convergesOnRefPrefixes } from "../render_gpu/gpu/settled.js";
import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import { image, rect, paperCurl, pushTransform, popTransform, SUPERSAMPLE_DENSITY } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import { reportOnce } from "../core/report.js";
import { packetPlan, turnedPose, stackJitter } from "../render_gpu/page_curl.js";
import {
  ensurePdfDoc, ensurePdfPagePointSize, ensurePdfPageRasterized,
  pdfPageCount, pdfPagePointSize, pdfPageRef, clampPage,
} from "../render_gpu/gpu/pdf_page_raster.js";

/** Device px per world unit for the page rasters (the pdf_page precedent). */
const RASTER_DENSITY = SUPERSAMPLE_DENSITY;
/** Staple default position, as fractions of w/h — inset from the corner the
 * way real packets are stapled (photo reference: ~8-15% of the short side). */
const STAPLE_FX = 0.07;
const STAPLE_FY = 0.065;
/** Staple footprint as a fraction of page width (reference: ~1/20-1/15). */
const STAPLE_LEN_F = 0.06;
/** A settled turned page: the turn is complete but the sheet keeps a residual
 * bow near the fold (reference: turned pages never lie dead flat). 0.985 keeps
 * the bump tight to the staple — 0.96 gave every turned sheet a huge lobe and
 * the packet read as a flower (user: "are we tripping on acid here"). */
const TURNED_REST_T = 0.985;
/** How many remaining-stack pages get their own jittered edge cue — past this
 * depth the lines merge into the packet's own drop shadow anyway. */
const STACK_EDGE_PAGES = 4;
/** The paper tones: sheet face, and the hairline edge/contact tint. */
const PAPER = "#fbfaf7";
const EDGE_TINT = "rgba(0,0,0,0.18)";
/** Handle geometry: the flip-angle/curl handles ride a ray from the staple at
 * this fraction of the short side; curl maps distance beyond it. */
const HANDLE_RAY_F = 0.32;
const CURL_MIN = 0.2, CURL_MAX = 3;

/**
 * Pure function. A similarity that rotates by `deg` ABOUT the point (px, py) —
 * the pushTransform() args for "spin around the staple". The returned
 * `rotation` is in RADIANS: core similarities store radians (degrees are a
 * DISPLAY unit — web/displayUnits.js), and passing degrees here rendered a
 * 1.2° stack jitter as 1.2 rad ≈ 69° — the giant phantom fan a preset agent
 * isolated to spreadRemaining.
 *
 * @param {number} deg - rotation, DEGREES (the callers' handle unit)
 * @param {number} px - pivot x
 * @param {number} py - pivot y
 * @returns {{x:number, y:number, rotation:number, scale:number}} rotation in RADIANS
 *
 * @example rotationAboutPoint(0, 50, 50) // {x: 0, y: 0, rotation: 0, scale: 1}
 * @example rotationAboutPoint(90, 10, 0).x // 10
 * @example rotationAboutPoint(90, 10, 0).rotation // 1.5707963267948966
 */
export function rotationAboutPoint(deg, px, py) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return { x: px - (px * c - py * s), y: py - (px * s + py * c), rotation: a, scale: 1 };
}

/**
 * Pure function. The residual curl scale of turned page k of n (0 = turned
 * first, i.e. deepest): the JUST-turned page keeps a wide loose arc, older
 * pages settle into tighter coils nested beneath it (photo reference,
 * agent 4). Monotone in k.
 *
 * @param {number} k - turned-page index, 0-based from the deepest
 * @param {number} n - how many pages are turned (≥ 1)
 * @returns {number} a curlScale for the settled paperCurl
 *
 * @example residualCurl(0, 1) // 0.75
 * @example residualCurl(0, 3) < residualCurl(2, 3) // true
 */
export function residualCurl(k, n) {
  return 0.35 + ((k + 1) / n) * 0.4;
}

/**
 * Pure function. The packet's INK bounds: the page box UNIONED with the disc
 * the turned pages occupy (they mirror across folds through the staple, so
 * they stay within the farthest-corner radius of it).
 *
 * @param {object} s - widget state ({w, h, stapleX, stapleY})
 * @returns {{x:number, y:number, w:number, h:number}}
 *
 * @example packetBounds({w: 100, h: 100, stapleX: 0, stapleY: 0}).x // -141.4213562373095
 * @example packetBounds({w: 100, h: 100, stapleX: 0.5, stapleY: 0.5}).w > 100 // true
 */
export function packetBounds(s) {
  const sx = (s.stapleX ?? STAPLE_FX) * s.w, sy = (s.stapleY ?? STAPLE_FY) * s.h;
  const reach = Math.max(
    Math.hypot(0 - sx, 0 - sy), Math.hypot(s.w - sx, 0 - sy),
    Math.hypot(0 - sx, s.h - sy), Math.hypot(s.w - sx, s.h - sy),
  );
  const x0 = Math.min(0, sx - reach), y0 = Math.min(0, sy - reach);
  const x1 = Math.max(s.w, sx + reach), y1 = Math.max(s.h, sy + reach);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Near-pure helper (kicks idempotent async rasters). The whole-page raster
 * ref for one 1-based page at this widget's world size — pdf_page's density
 * math, shared verbatim so both widgets cache-hit the same rasters, times the
 * author's own `rasterDensity` multiplier (core/properties.js has the full
 * reasoning for why it multiplies rather than naming an absolute DPI). Absent
 * ⇒ 1 ⇒ byte-identical to before this knob existed, cache key included. */
function pageRasterRef(s, page, world) {
  const density = (world?.scale ?? 1) * RASTER_DENSITY * (s.rasterDensity ?? 1);
  const point = pdfPagePointSize(s.src, page);
  ensurePdfPagePointSize(s.src, page);
  const scale = point && point.w > 0 ? (s.w * density) / point.w : density;
  ensurePdfPageRasterized(s.src, page, scale);
  return pdfPageRef(s.src, page, scale);
}

/** Query (reads state). The staple point in page-local coords. */
function staplePoint(s) {
  return { x: (s.stapleX ?? STAPLE_FX) * s.w, y: (s.stapleY ?? STAPLE_FY) * s.h };
}

/**
 * Pure function. The staple's own display-list ops: two crimped metal legs on
 * a diagonal across the corner, with a specular streak (macro reference,
 * agent 5: two short hairpin legs, bright cool metal, thin highlight).
 *
 * @param {{x:number,y:number}} at - staple center (local)
 * @param {number} len - staple length (local units)
 * @param {number} angleDeg - staple axis (≈45° across the corner)
 * @returns {Array<object>} IR ops
 *
 * @example stapleOps({x: 10, y: 10}, 12, 45).length // 5
 */
export function stapleOps(at, len, angleDeg) {
  const legW = len * 0.16, gap = len * 0.12;
  const half = len / 2;
  return [
    pushTransform(rotationAboutPoint(angleDeg, at.x, at.y)),
    // Two legs with a crimp gap between them.
    rect({ x: at.x - half, y: at.y - legW / 2, w: half - gap / 2, h: legW, cornerRadius: legW / 2, fill: "#a9adb6" }),
    rect({ x: at.x + gap / 2, y: at.y - legW / 2, w: half - gap / 2, h: legW, cornerRadius: legW / 2, fill: "#a9adb6" }),
    // The specular streak: a thinner bright line riding the top of both legs.
    rect({ x: at.x - half, y: at.y - legW / 2, w: len, h: legW * 0.35, cornerRadius: legW * 0.2, fill: "#e9ebef" }),
    popTransform(),
  ];
}

export const pdfPacketPlugin = {
  type: "pdf_packet",
  // CONVERGES: it draws async rasters (one per visible page). BY NAMESPACE, not by
  // exact ref: pageRasterRef() folds in the live `world.scale`, which a
  // settled(state) predicate never sees — see convergesOnRefPrefixes for the
  // measured defect this replaces (`s.__pdfRef` was never assigned by anything,
  // so this widget declared itself permanently settled).
  ephemeral: convergesOnRefPrefixes(["pdfpage:"]),
  title: "PDF Packet",
  capabilities: { bbox: true, transform: true, resizable: true },
  defaults: {
    type: "pdf_packet", x: 100, y: 100, w: 320, h: 414, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: "",
    // THE fractional page: 2.3 = page 2 is 30% through its turn. An equation
    // slot like every numeric default — bind `= t` and scrub the deck.
    page: 1,
    stapleX: STAPLE_FX,
    stapleY: STAPLE_FY,
    // The direction the free corner travels, degrees (0 = +x). ~52° points
    // from a top-left staple toward the bottom-right corner of a portrait page.
    flipAngle: 52,
    // Curl-radius multiplier (the roll's looseness), turned-fan degrees per
    // page, and the remaining stack's resting jitter.
    curl: 1,
    spreadTurned: 7,
    spreadRemaining: 1.2,
    paper: PAPER,
    shadowOpacity: 0.45,
    ...defaults("rasterDensity", "opacity"), // rasterDensity:1 (= today's automatic density)
    ...bundleNestedDefaults("effects"),
  },
  inspector: [
    ...bundle("positioning"),
    ...props("src", { src: { label: "PDF", assetKinds: ["pdf"], help: "The PDF whose pages this packet holds — the whole document, stapled at the corner." } }),
    // `scrub` (drag units per pixel), not just `step`: resolveScrub can't infer
    // fractionality here (integer min, integer default, no max), so without it
    // the DRAG coefficient fell back to a whole page per pixel — the step grid
    // was 0.01 but every pixel of drag skipped to the next integer (user
    // report). 0.01/px = one full page turn per 100px of drag.
    { key: "page", label: "Page", kind: "number", min: 1, step: 0.01, scrub: 0.01, category: "formatting", help: "FRACTIONAL: 2.3 means page 2 is 30% through peeling over the staple. Tween or bind it (= t) to animate reading through the packet." },
    { key: "flipAngle", label: "Flip angle", kind: "number", min: 0, max: 360, step: 1, category: "formatting", help: "The direction the turning page's free corner travels, in degrees. Also draggable as the on-canvas handle riding the ray from the staple." },
    // NO knob cap: page_curl.turnPose floors the curl radius with Math.max(reach*0.04, …),
    // so any curl / fan value is sane bounded geometry — the old CURL_MIN..CURL_MAX and the
    // 20 / 5 fan ceilings were taste. CURL_MIN/CURL_MAX still bound the ON-CANVAS handle below
    // (a physical screen-reach limit on the draggable ray), which is a different constraint.
    { key: "curl", label: "Curl", kind: "number", min: 0, step: 0.05, category: "formatting", help: "How loosely the turning sheet rolls — the loopity-loop knob. Small = tight scroll, large = wide belly (no upper cap; the roll radius is floored so 0 is a tight scroll, never degenerate)." },
    { key: "spreadTurned", label: "Turned fan", kind: "number", min: 0, step: 0.5, category: "formatting", help: "Degrees between successive already-turned pages fanned around the staple (no upper cap)." },
    { key: "spreadRemaining", label: "Stack fan", kind: "number", min: 0, step: 0.1, category: "formatting", help: "The remaining stack's resting jitter — 0 is a machine-perfect stack, higher looks handled (no upper cap)." },
    { key: "stapleX", label: "Staple X", kind: "number", min: 0, max: 1, step: 0.01, category: "formatting", help: "Staple position across the page width (fraction). Also draggable on canvas." },
    { key: "stapleY", label: "Staple Y", kind: "number", min: 0, max: 1, step: 0.01, category: "formatting", help: "Staple position down the page height (fraction)." },
    { key: "paper", label: "Paper", kind: "color", category: "formatting", help: "The sheet color — the back of every turned page, and the stack edges." },
    { key: "shadowOpacity", label: "Page shadow", kind: "number", min: 0, max: 1, step: 0.05, category: "formatting", help: "Strength of the geometry-derived shadow the lifted sheet casts on the pile." },
    ...props("rasterDensity"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Command-free query. State → display list, bottom to top: remaining-stack
   * edge cues → the open page → the turned fan (deepest first) → the turning
   * sheet → the staple. Pure of the camera (whole-page rasters at own-size
   * density — the pdf_page precedent); async rasters draw as shaded blank
   * paper until they land (the paperCurl op's media contract).
   */
  emit(s, _targetWorldIR, world) {
    if (typeof s.src !== "string" || s.src.length === 0) return [];
    if (!(s.w > 0) || !(s.h > 0)) return [];
    ensurePdfDoc(s.src);
    const pageCount = pdfPageCount(s.src);
    // Until the doc opens, assume just enough pages that the requested turn
    // still animates; the count self-corrects the emit after it resolves.
    const count = pageCount ?? Math.max(Math.ceil(s.page ?? 1) + 1, 2);
    const requested = s.page ?? 1;
    let page = Number.isFinite(requested) ? requested : 1;
    if (pageCount != null) {
      const clamped = clampPage(requested, pageCount);
      if (clamped.outOfRange) {
        reportOnce(
          `pdf_packet:range:${s.src}:${requested}`,
          `PowerRP pdf_packet: page ${requested} is out of range for "${s.src}" (${pageCount} pages) — clamping.`,
        );
      }
      page = Math.min(Math.max(requested, 1), pageCount);
    }
    const plan = packetPlan(page, count);
    const staple = staplePoint(s);
    const angle = s.flipAngle ?? 52;
    const curl = s.curl ?? 1;
    const shadow = s.shadowOpacity ?? 0.45;
    const paper = s.paper ?? PAPER;
    const opacity = s.opacity ?? 1;
    const ops = [];

    // (1) the remaining stack beneath the open page: jittered sheets, deepest
    // first — rotation jitter about the staple, a paper fill and an edge
    // hairline each (stack reference, agent 9: rotation not translation).
    const remaining = Math.min(Math.max(count - plan.openPage, 0), STACK_EDGE_PAGES);
    for (let k = remaining; k >= 1; k--) {
      const j = stackJitter(k, s.spreadRemaining ?? 1.2);
      ops.push(pushTransform(rotationAboutPoint(j.rotationDeg, staple.x, staple.y)));
      ops.push(rect({ x: j.dx, y: j.dy, w: s.w, h: s.h, fill: paper, stroke: EDGE_TINT, strokeWidth: 1, opacity }));
      ops.push(popTransform());
    }

    // (2) the OPEN page (what the packet currently shows), with a crisp
    // trailing-edge hairline (agent 9's "one hard line sells the loose sheet").
    ops.push(rect({ x: 0, y: 0, w: s.w, h: s.h, fill: paper, opacity }));
    ops.push(image({ ref: pageRasterRef(s, plan.openPage, world), x: 0, y: 0, w: s.w, h: s.h, opacity }));
    ops.push(rect({ x: 0, y: 0, w: s.w, h: s.h, fill: null, stroke: EDGE_TINT, strokeWidth: 1, opacity }));

    // (3) already-turned pages, deepest (first-turned) first: settled paperCurl
    // sheets fanned about the staple, each keeping a residual bow (agent 4's
    // nested arcs — never flat rotated rects). They carry their PAGE RASTERS
    // (user ruling: "non-dominant pages can be made from raster but shouldn't
    // be blank") — the mirrored geometry shows the content read-from-behind,
    // the peacock-figure look, rather than dead white sheets.
    for (let k = 0; k < plan.turnedCount; k++) {
      const pose = turnedPose(k, plan.turnedCount, angle, s.spreadTurned ?? 7);
      ops.push(pushTransform(rotationAboutPoint(pose.rotationDeg, staple.x, staple.y)));
      ops.push(paperCurl({
        ref: pageRasterRef(s, k + 1, world), x: 0, y: 0, w: s.w, h: s.h, staple, angleDeg: angle,
        t: TURNED_REST_T, curlScale: residualCurl(k, plan.turnedCount) * curl,
        paper, shadowOpacity: shadow * 0.5, opacity,
      }));
      ops.push(popTransform());
    }

    // (4) the TURNING sheet — the fractional page mid-peel.
    if (plan.turningPage != null) {
      ops.push(paperCurl({
        ref: pageRasterRef(s, plan.turningPage, world), x: 0, y: 0, w: s.w, h: s.h,
        staple, angleDeg: angle, t: plan.t, curlScale: curl,
        paper, shadowOpacity: shadow, opacity,
      }));
    }

    // (5) the staple, pinned on top of everything it holds.
    ops.push(...stapleOps(staple, Math.max(6, s.w * STAPLE_LEN_F), 45));

    return applyEffects(ops, s, world, { x: 0, y: 0, w: s.w, h: s.h });
  },
  anchors(s) {
    const staple = staplePoint(s);
    return [...standardBBoxAnchors(s), { id: "staple", x: staple.x, y: staple.y }];
  },
  localBounds(s) {
    return packetBounds(s);
  },
  cullMargin(s) {
    return effectsCullMargin(s);
  },
  /**
   * Query. The packet's yellow handles — every one of the user's knobs is
   * draggable on canvas: the staple, the flip direction (a bead riding a ray
   * from the staple), the curl (further out the same ray), the turned fan
   * (a bead on the mirrored side), and the stack fan (a bead along the
   * bottom edge). Each constrain projects to its allowed set; each apply
   * writes exactly one parameter (the donut protocol).
   */
  modifierPoints(s) {
    const staple = staplePoint(s);
    const R = HANDLE_RAY_F * Math.min(s.w, s.h);
    const a = ((s.flipAngle ?? 52) * Math.PI) / 180;
    const dir = { x: Math.cos(a), y: Math.sin(a) };
    const onRay = (dist) => ({ x: staple.x + dir.x * dist, y: staple.y + dir.y * dist });
    const curlDist = R * (1 + 0.5 * (s.curl ?? 1));
    const fanBearing = a + Math.PI + ((s.spreadTurned ?? 7) * 4 * Math.PI) / 180;
    return [
      {
        id: "staple",
        x: staple.x, y: staple.y,
        constrain(state, desired) {
          return { x: Math.min(Math.max(desired.x, 0), state.w), y: Math.min(Math.max(desired.y, 0), state.h) };
        },
        apply(state, allowed) {
          if (!(state.w > 0) || !(state.h > 0)) return {};
          return { stapleX: allowed.x / state.w, stapleY: allowed.y / state.h };
        },
      },
      {
        id: "flipAngle",
        ...onRay(R),
        constrain(state, desired) {
          const sp = staplePoint(state);
          const d = Math.hypot(desired.x - sp.x, desired.y - sp.y) || 1;
          const r = HANDLE_RAY_F * Math.min(state.w, state.h);
          return { x: sp.x + ((desired.x - sp.x) / d) * r, y: sp.y + ((desired.y - sp.y) / d) * r };
        },
        apply(state, allowed) {
          const sp = staplePoint(state);
          return { flipAngle: (Math.atan2(allowed.y - sp.y, allowed.x - sp.x) * 180) / Math.PI };
        },
      },
      {
        id: "curl",
        ...onRay(curlDist),
        constrain(state, desired) {
          const sp = staplePoint(state);
          const aa = ((state.flipAngle ?? 52) * Math.PI) / 180;
          const dx = Math.cos(aa), dy = Math.sin(aa);
          const r = HANDLE_RAY_F * Math.min(state.w, state.h);
          const along = (desired.x - sp.x) * dx + (desired.y - sp.y) * dy;
          const d = Math.min(Math.max(along, r * (1 + 0.5 * CURL_MIN)), r * (1 + 0.5 * CURL_MAX));
          return { x: sp.x + dx * d, y: sp.y + dy * d };
        },
        apply(state, allowed) {
          const sp = staplePoint(state);
          const r = HANDLE_RAY_F * Math.min(state.w, state.h);
          const d = Math.hypot(allowed.x - sp.x, allowed.y - sp.y);
          return { curl: Math.min(Math.max((d / r - 1) / 0.5, CURL_MIN), CURL_MAX) };
        },
      },
      {
        id: "spreadTurned",
        x: staple.x + Math.cos(fanBearing) * R, y: staple.y + Math.sin(fanBearing) * R,
        // Constrain to the ARC the fan can actually express (bearing flip+180°
        // … +80° past it, i.e. spread 0..20 at 4°/unit), not just the circle —
        // the allowed SET and apply's range must agree exactly or the handle
        // round-trip breaks (the sweep test's contract).
        constrain(state, desired) {
          const sp = staplePoint(state);
          const r = HANDLE_RAY_F * Math.min(state.w, state.h);
          const aa = ((state.flipAngle ?? 52) * Math.PI) / 180;
          let rel = Math.atan2(desired.y - sp.y, desired.x - sp.x) - aa - Math.PI;
          while (rel < -Math.PI) rel += 2 * Math.PI;
          while (rel > Math.PI) rel -= 2 * Math.PI;
          const relMax = (20 * 4 * Math.PI) / 180;
          const clamped = Math.min(Math.max(rel, 0), relMax);
          const b = aa + Math.PI + clamped;
          return { x: sp.x + Math.cos(b) * r, y: sp.y + Math.sin(b) * r };
        },
        apply(state, allowed) {
          const sp = staplePoint(state);
          const aa = ((state.flipAngle ?? 52) * Math.PI) / 180;
          let rel = Math.atan2(allowed.y - sp.y, allowed.x - sp.x) - aa - Math.PI;
          while (rel < -Math.PI) rel += 2 * Math.PI;
          while (rel > Math.PI) rel -= 2 * Math.PI;
          return { spreadTurned: Math.min(Math.max(((rel * 180) / Math.PI) / 4, 0), 20) };
        },
      },
      {
        id: "spreadRemaining",
        x: s.w * (0.55 + 0.08 * (s.spreadRemaining ?? 1.2)), y: s.h - 6,
        constrain(state, desired) {
          return { x: Math.min(Math.max(desired.x, state.w * 0.55), state.w * 0.95), y: state.h - 6 };
        },
        apply(state, allowed) {
          return { spreadRemaining: Math.min(Math.max((allowed.x / state.w - 0.55) / 0.08, 0), 5) };
        },
      },
    ];
  },
  // TEN PRESETS, each authored by its own agent against real renders of a real
  // PDF and vision-checked against its concept (.frenzy/packet_presets/
  // agent_N/ holds every probe, iteration and screenshot). Ordered as a
  // reading arc: the first lift → riffling → drama → work → order → chaos →
  // memory → done. Names/descriptions/props are each artisan's own.
  presets: [
    { name: "First Peek", description: "The instant before you start reading: page one's corner has just barely lifted off the pile, a tight little curl and nothing else disturbed.", props: { page: 1.12, flipAngle: 52, curl: 0.2, spreadTurned: 7, spreadRemaining: 0, stapleX: 0.07, stapleY: 0.065, paper: "#fbfaf7", shadowOpacity: 0.32 } },
    { name: "Thumb-through", description: "Skimming, not reading. Caught mid-riffle — the sheet still rising off the staple with a springy, wide curl and a bouncy little fan of the few pages already flicked past. Kinetic energy held in a still frame.", props: { page: 4.25, flipAngle: 52, curl: 1.6, spreadTurned: 9, spreadRemaining: 2, shadowOpacity: 0.5 } },
    { name: "Grand Reveal", description: "The dramatic apex of a turn: a wide, generous sail-like belly with a strong cast shadow, staged as maximum theater while the sheet still reads as real paper.", props: { flipAngle: 55, curl: 0.6, spreadTurned: 9, spreadRemaining: 1.6, stapleX: 0.07, stapleY: 0.065, paper: "#fdfbf6", shadowOpacity: 0.75 } },
    { name: "Showstopper", description: "The loopity-loopiest legal roll: curl pushed near maximum, one page mid-peel arcing overhead like a wave about to break, a confident fan of already-turned pages banked beneath it, and deep contact shadows. The hero shot for a title slide.", props: { page: 3.87, flipAngle: 50, curl: 2.85, spreadTurned: 13, spreadRemaining: 2.1, stapleX: 0.07, stapleY: 0.065, paper: "#f7f2e6", shadowOpacity: 0.78 } },
    { name: "The Auditor", description: "Deep into a long document, hour three of due diligence — many pages already turned and coiled tight behind the staple, the working page mid-turn with a businesslike curl.", props: { page: 7.3, flipAngle: 50, curl: 0.5, spreadTurned: 6, spreadRemaining: 0.4, stapleX: 0.07, stapleY: 0.065, paper: "#f2f0ea", shadowOpacity: 0.5 } },
    { name: "Legal Brief", description: "A meticulous paralegal's stapled packet: a machine-square resting stack with virtually no jitter, a small tidy fan when pages are turned back, a tight restrained curl on each settled sheet, and a crisp but modest cast shadow. Order and precision over drama.", props: { page: 1, flipAngle: 52, curl: 0.2, spreadTurned: 0.7, spreadRemaining: 0.3, stapleX: 0.07, stapleY: 0.065, paper: "#f7f6f1", shadowOpacity: 0.35 } },
    { name: "Drafting Table", description: "An engineer's packet: cool-white paper with the faintest blue cast, a staple pinned exactly at the corner, a low resting fan, and a clean, deliberate mid-turn with moderate curl and sharp, well-defined shadows. Reads technical and exact rather than casual.", props: { page: 2.5, flipAngle: 45, curl: 1.1, spreadTurned: 2, spreadRemaining: 0.2, stapleX: 0.055, stapleY: 0.05, paper: "#f3f6fa", shadowOpacity: 0.7 } },
    { name: "Windy Desk", description: "A gust just came through the open window: pages fan out wide behind the staple, the stack itself sits crooked and unruly, and the turning sheet keeps a loose floppy belly as it peels. Chaotic-looking but every sheet still reads as real paper, not a paper explosion.", props: { flipAngle: 70, curl: 2.4, spreadTurned: 11, spreadRemaining: 4, stapleX: 0.07, stapleY: 0.065, paper: "#f6f2e9", shadowOpacity: 0.65 } },
    { name: "Archive Copy", description: "A packet that's been in a folder since 2009: warm aged-ivory paper, soft low-contrast shadows, a gently disheveled stack, and a slow careful page turn. Quiet nostalgia, not sepia soup.", props: { flipAngle: 50, curl: 1.15, spreadTurned: 5, spreadRemaining: 1.4, stapleX: 0.07, stapleY: 0.065, paper: "#f0e4c8", shadowOpacity: 0.26 } },
    { name: "The Last Page", description: "Nearly every page of the packet has been coiled into a thick wedge behind the staple; the second-to-last page is caught mid-turn near the end of its arc, settling down toward the final page beneath it — the satisfying feeling of finishing. (Tuned for a long document; page clamps loudly on shorter ones.)", props: { page: 21.85, flipAngle: 50, curl: 1.6, spreadTurned: 1.6, spreadRemaining: 1.0, stapleX: 0.065, stapleY: 0.06, paper: "#f7f2e6", shadowOpacity: 0.5 } },
  ],
  commands: [
    { id: "add-pdf-packet", title: "Add PDF Packet", icon: "mdi:file-document-multiple-outline", aliases: ["stapled packet", "page turn", "paper packet"], run: (app) => app.armCrosshairPlacement(pdfPacketPlugin) },
  ],
};
