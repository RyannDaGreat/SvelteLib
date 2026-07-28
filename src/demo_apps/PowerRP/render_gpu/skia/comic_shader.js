/**
 * The COMIC HALFTONE SkSL material — a BACKDROP material on the reusable MATERIAL
 * FRAMEWORK (render_gpu/skia/materials.js), a sibling of the CRT / rainy-window
 * materials. It reprints the composite-so-far inside a rounded-rect region as an
 * old-school COMIC / newsprint HALFTONE: the continuous tone below is separated
 * into ink channels and each channel is redrawn as a grid of Ben-Day DOTS whose
 * SIZE tracks local coverage, on its OWN rotated screen angle, over a paper base.
 *
 * ── THE LOAD-BEARING DOT LAW (area, not radius, is linear in tone) ─────────────
 * A halftone cell of side `cell` is "coverage" c full when the ink dot's AREA is
 * c·cell². For a ROUND dot of radius r that is π·r² = c·cell², but the cell is a
 * SQUARE, so a dot only starts overlapping its neighbours at r = cell/2 and only
 * fills the square's CORNERS at r = (√2/2)·cell. Using the square-area convention
 * (a dot "fills" its cell at c = 1 when it reaches the corners) gives the exact,
 * classic mapping used here:
 *
 *     r = (√2 / 2) · cell · √c          (round dots; R_ROUND below)
 *
 * The √c is ESSENTIAL: radius ∝ √coverage keeps AREA ∝ coverage, so a 50%-grey
 * tone prints as dots that visually read as 50% ink. Dropping the √ (radius ∝ c)
 * crushes the midtones — the single most common halftone bug. Square dots fill at
 * r = cell/2 (area (2r)²), so their law is r = ½·cell·√c (R_SQUARE).
 *
 * ── SCREENS, ANGLES & MISREGISTRATION ─────────────────────────────────────────
 * Each channel is screened on its OWN angle so the overlaid grids form the tight
 * "rosette" instead of an ugly moiré: the classic CMYK set is C 15° / M 75° / Y 0°
 * / K 45°. The tone for a dot is sampled at its CELL CENTRE (not per fragment), so
 * every fragment inside one dot shares ONE radius ⇒ crisp, uniform dots. A small
 * per-channel REGISTRATION offset (uReg) shifts each screen's lattice — 0 is
 * perfect print registration; cranked up it becomes the deliberate off-register /
 * RGB "3-D anaglyph" desync look.
 *
 * ── MODES (uMode) ──────────────────────────────────────────────────────────────
 *   0 CMYK    — RGB→CMYK separation (K = 1−max(r,g,b); C=(1−r−K)/(1−K), …), four
 *               subtractive ink screens overprinted on paper (classic 4-colour).
 *   1 RGB     — three ADDITIVE light-primary screens over a dark paper (coverage =
 *               the channel value: a bright red prints big red dots). The desync
 *               preset lives here.
 *   2 DUOTONE — two spot inks (uInkA for shadows, uInkB for highlights) split by
 *               luminance and overprinted (riso / 2-colour).
 *   3 MONO    — a single black screen on paper (newsprint / manga).
 * The four angle uniforms are REUSED across modes (documented at each call): RGB
 * borrows C/K/M (so its defaults 15/45/75 fall out of the CMYK defaults), duotone
 * borrows K (dark) + C (light), mono uses K.
 *
 * Optional POSTERIZE flattens the tone into bands before separation (flat comic
 * fills); an optional SOBEL edge screen inks the outlines black; a subtle static
 * paper GRAIN finishes the print. `blurredBackdrop` is declared to satisfy the
 * framework's fixed {blurred, sharp} child pair but is UNUSED — a print samples
 * only the sharp tone.
 *
 * ── THE LATTICE LIVES IN THE WIDGET'S LOCAL FRAME, NOT IN DEVICE SPACE ────────
 * `main(float2 p)` receives DEVICE px, but EVERY lattice here (the dot screens and
 * the paper grain) is built from `pl` — the fragment un-rotated and re-centred into
 * the WIDGET's local frame — never from `p`. This is load-bearing, not cosmetic.
 * A camera pan/zoom is a VIEW transform: it must change how the render maps to the
 * screen, never WHAT is rendered (`RenderTree = pure(document, [[slide, alpha]])`).
 * A lattice phased off the device origin makes the print a function of the camera:
 * the measured phase was exactly `panX / zoom` (mod pitch), so the dots swam and
 * re-registered on every pan and zoom, and an editor preview disagreed with a CLI
 * render of the same document. Anchoring in `pl` (which the packer pairs with a
 * world-locked cell, `pitch × scale`) makes the print ride the ARTWORK. Every
 * sibling material already does this — CRT's phosphor mask and scanlines, the
 * glitch bands, the rainy-window height field, the raycast-dither grain are all
 * built on `pl`; this material was the sole hold-out. The backdrop children are
 * still DEVICE-space image shaders, so a local cell centre is mapped back through
 * `localToDevice()` before it is sampled.
 *
 * DETERMINISM: pure function of (widget-local position, sampled backdrop, knobs) —
 * the grain is a fract-hash of the local grain CELL (sin-free, no Date/Math.random),
 * so the same doc ⇒ byte-identical pixels. DOM-free at import (string SkSL + a pure
 * packer), like crt_shader.js. `parseColor` (render_gpu/ir.js) is the shared
 * node-safe parser.
 */

import { parseColor } from "../ir.js";

// ── named constants (WHY each exists — no magic numbers) ─────────────────────
export const COMIC_SKSL = `
const float AA_COV_PX = 1.0;   // region-edge coverage antialias half-width (~1 device px)
const float AA_DOT_PX = 0.7;   // dot-edge antialias half-width (~0.7 device px) — crisp but not jagged
const float R_ROUND  = 0.70710678;  // (√2)/2: round-dot radius that fills the SQUARE cell's corners at coverage 1 (area law r = R·cell·√c)
const float R_SQUARE = 0.5;          // square-dot half-side that fills the cell at coverage 1 (area (2r)²)
const float ELLIPSE_ASPECT = 0.72;   // vertical squash of the elliptical dot (chain-dot look)
const float EPS = 1e-4;              // divide-by-zero guard in the CMYK separation
const float EDGE_STEP_PX = 1.0;      // Sobel finite-difference step (device px)
const float GRAIN_AMP = 0.10;        // max paper-grain amplitude at uGrain 1 (kept subtle)
const float3 REC709 = float3(0.2126, 0.7152, 0.0722);   // luma weights (duotone/mono split + edges)

// baked process-ink colours (subtractive multipliers for CMYK/duotone; the ink a
// dot lays down where its coverage is 1). Near, not pure, primaries read as print.
const float3 INK_CYAN    = float3(0.05, 0.62, 0.86);
const float3 INK_MAGENTA = float3(0.92, 0.06, 0.52);
const float3 INK_YELLOW  = float3(0.99, 0.92, 0.10);
const float3 INK_BLACK   = float3(0.06, 0.06, 0.09);
// additive light primaries for the RGB dot mode (summed over a dark paper)
const float3 INK_R = float3(1.00, 0.05, 0.08);
const float3 INK_G = float3(0.06, 1.00, 0.12);
const float3 INK_B = float3(0.10, 0.14, 1.00);

// per-channel registration DIRECTIONS (the widget's LOCAL frame, like the lattice
// they shift; scaled by uReg·cell). K is the registration anchor (0,0); the others
// fan out so a misregister spreads the inks.
const float2 DIR_C = float2(-0.7071, -0.7071);
const float2 DIR_M = float2( 0.7071, -0.7071);
const float2 DIR_Y = float2( 0.0,     1.0);
const float2 DIR_K = float2( 0.0,     0.0);
// RGB desync fans the three light screens onto 3 distinct axes (dramatic split)
const float2 DIR_R = float2(-1.0,  0.0);
const float2 DIR_G = float2( 0.0,  1.0);
const float2 DIR_B = float2( 1.0,  0.0);

// channel selector codes for coverageOf()
const float CH_C = 0.0; const float CH_M = 1.0; const float CH_Y = 2.0; const float CH_K = 3.0;
const float CH_R = 10.0; const float CH_G = 11.0; const float CH_B = 12.0;
const float CH_DARK = 20.0; const float CH_LIGHT = 21.0;  // duotone/mono luminance splits

// hash mixing constants (Dave Hoskins fract-hash — backend-stable, sin-free)
const float H3_ADD = 33.33;
const float3 H3_MUL = float3(0.1031, 0.1030, 0.0973);

uniform shader blurredBackdrop;  // child 0: blurred composite-so-far — UNUSED (a print reads only the sharp tone); declared to satisfy the fixed {blurred, sharp} pair
uniform shader sharpBackdrop;    // child 1: the un-blurred composite-so-far — the continuous TONE being screened
uniform float2 uCenter;          // region centre (device px)
uniform float2 uHalfSize;        // region half-extents (device px)
uniform float uCornerRadius;     // rounded-rect corner radius (device px)
uniform float uAngle;            // widget rotation (radians): rotate the SDF/tone frame so a rotated panel stays correct
// ── user-tweakable knobs (self.* custom props) ───────────────────────────────
uniform float uMode;        // 0 CMYK, 1 RGB, 2 DUOTONE, 3 MONO
uniform float uPitch;        // dot CELL size (DEVICE px) — the packer resolves world-lock/screen-lock
uniform float uDotShape;     // 0 round, 1 square, 2 ellipse
uniform float uAngleC;       // screen angle (radians) — C ; reused as R (mode 1) / duotone LIGHT (mode 2)
uniform float uAngleM;       // screen angle — M ; reused as B (mode 1)
uniform float uAngleY;       // screen angle — Y
uniform float uAngleK;       // screen angle — K ; reused as G (mode 1) / duotone DARK (mode 2) / MONO (mode 3)
uniform float uReg;          // registration/desync amount (fraction of a cell): 0 = perfect print, high = off-register
uniform float uDotGain;      // dot-gain radius bias (fraction of a cell) — ink spread on absorbent paper
uniform float uGamma;        // tone gamma applied to coverage before the dot (mid-tone weighting)
uniform float uPosterize;    // 0/1 = off; >=2 = quantize the tone into this many levels before separation
uniform float uEdgeInk;      // 0..1 strength of the black Sobel edge-ink outline
uniform float uEdgeLo;       // Sobel gradient magnitude where the edge ink starts …
uniform float uEdgeHi;       //   … and where it is full
uniform float uGrain;        // 0..1 paper grain amount
uniform float uGrainCell;    // paper-grain speckle cell size (DEVICE px) — the packer resolves world-lock/screen-lock, exactly like uPitch
uniform float3 uPaper;       // paper base colour (shows through between dots)
uniform float3 uInkA;        // duotone SHADOW ink
uniform float3 uInkB;        // duotone HIGHLIGHT ink

// Pure. Signed distance to a rounded rect (local, centered). <0 inside.
float sdRoundRect(float2 p, float2 h, float r) {
  float2 q = abs(p) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Pure. 2D fract-hash → [0,1) (Hoskins hash21). Same p ⇒ same value on a backend.
float hash21(float2 p) {
  float3 p3 = fract(float3(p.xyx) * H3_MUL);
  p3 += dot(p3, p3.yzx + H3_ADD);
  return fract((p3.x + p3.y) * p3.z);
}

// Pure. Posterize (band the tone) when enabled — flat comic fills before separation.
float3 posterize(float3 c) {
  if (uPosterize < 1.5) { return c; }
  float n = uPosterize;
  return floor(c * n + 0.5) / n;
}

// Pure. Continuous tone -> the ink COVERAGE [0,1] of one channel 'chan'.
//   CMYK: standard GCR-free separation (K=1−max; C=(1−r−K)/(1−K); …).
//   RGB : the channel VALUE (additive — a bright channel prints big light dots).
//   DARK/LIGHT: 1−luma / luma (duotone shadow/highlight, mono uses DARK).
float coverageOf(float3 c, float chan) {
  if (chan < 3.5) {
    float K = 1.0 - max(max(c.r, c.g), c.b);
    float invK = max(1.0 - K, EPS);
    if (chan < 0.5) { return (1.0 - c.r - K) / invK; }
    if (chan < 1.5) { return (1.0 - c.g - K) / invK; }
    if (chan < 2.5) { return (1.0 - c.b - K) / invK; }
    return K;
  }
  if (chan < 12.5) {
    if (chan < 10.5) { return c.r; }
    if (chan < 11.5) { return c.g; }
    return c.b;
  }
  float luma = dot(c, REC709);
  if (chan < 20.5) { return 1.0 - luma; }
  return luma;
}

// Pure. The widget's LOCAL centred frame (device-px units, un-rotated) → DEVICE px:
// the exact inverse of main()'s device → local step. The lattice is built in the
// local frame so the camera cannot re-register it, but the backdrop children are
// device-space image shaders, so anything sampled must come back through here.
float2 localToDevice(float2 v) {
  float ca = cos(uAngle), sa = sin(uAngle);
  return float2(ca * v.x - sa * v.y, sa * v.x + ca * v.y) + uCenter;
}

// Near-pure (samples sharpBackdrop). ONE rotated halftone screen. Its pl argument
// is the fragment in the WIDGET'S LOCAL centred frame — NOT the device pixel — so
// the lattice is printed on the ARTWORK and no camera pan/zoom can make it swim
// (see the file header). Rotate pl into the channel's screen frame (offset by its
// registration dir), find the cell it lands in, SAMPLE the tone at that cell's
// CENTRE (mapped back to device px for the backdrop child), map to a coverage, and
// draw the area-law dot. Returns ink amount [0,1] for this pixel.
float screen(float ang, float2 dir, float2 pl, float cell, float rMax, float chan) {
  float c = cos(ang), s = sin(ang);
  float2 off = dir * (uReg * cell);
  float2 pr = pl + off;
  float2 q = float2(c * pr.x - s * pr.y, s * pr.x + c * pr.y);   // local → screen frame
  float2 cid = floor(q / cell);
  float2 cc = (cid + 0.5) * cell;                                // cell CENTRE (screen frame)
  float2 ccLocal = float2(c * cc.x + s * cc.y, -s * cc.x + c * cc.y) - off;  // screen → local
  float3 tone = posterize(float3(sharpBackdrop.eval(localToDevice(ccLocal)).rgb));
  float cov = pow(clamp(coverageOf(tone, chan), 0.0, 1.0), uGamma);
  float2 d = q - cc;                                             // offset from centre (length preserved by rotation)
  float dist;
  if (uDotShape < 0.5) { dist = length(d); }
  else if (uDotShape < 1.5) { dist = max(abs(d.x), abs(d.y)); }
  else { dist = length(d * float2(1.0, ELLIPSE_ASPECT)); }
  float rad = rMax * cell * sqrt(cov) + uDotGain * cell;
  return 1.0 - smoothstep(rad - AA_DOT_PX, rad + AA_DOT_PX, dist);
}

// Near-pure (samples sharpBackdrop). 3×3 Sobel gradient magnitude of the tone's
// luma at pixel p — the comic outline source.
float sobelEdge(float2 p) {
  float e = EDGE_STEP_PX;
  float tl = dot(float3(sharpBackdrop.eval(p + float2(-e, -e)).rgb), REC709);
  float tm = dot(float3(sharpBackdrop.eval(p + float2( 0.0, -e)).rgb), REC709);
  float tr = dot(float3(sharpBackdrop.eval(p + float2( e, -e)).rgb), REC709);
  float ml = dot(float3(sharpBackdrop.eval(p + float2(-e, 0.0)).rgb), REC709);
  float mr = dot(float3(sharpBackdrop.eval(p + float2( e, 0.0)).rgb), REC709);
  float bl = dot(float3(sharpBackdrop.eval(p + float2(-e, e)).rgb), REC709);
  float bm = dot(float3(sharpBackdrop.eval(p + float2( 0.0, e)).rgb), REC709);
  float br = dot(float3(sharpBackdrop.eval(p + float2( e, e)).rgb), REC709);
  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (bl + 2.0 * bm + br) - (tl + 2.0 * tm + tr);
  return length(float2(gx, gy));
}

half4 main(float2 p) {
  float ca = cos(uAngle), sa = sin(uAngle);
  float2 d0 = p - uCenter;
  float2 pl = float2(ca * d0.x + sa * d0.y, -sa * d0.x + ca * d0.y); // device → local (centered)
  float rr = min(uCornerRadius, min(uHalfSize.x, uHalfSize.y));       // capsule-safe clamp
  float dRR = sdRoundRect(pl, uHalfSize, rr);
  float cov = 1.0 - smoothstep(-AA_COV_PX, AA_COV_PX, dRR);
  if (cov <= 0.0) { return half4(0.0); }

  float cell = uPitch;
  float rMax = (uDotShape > 0.5 && uDotShape < 1.5) ? R_SQUARE : R_ROUND;
  float3 col;

  if (uMode < 0.5) {
    // (0) CMYK — four subtractive screens overprinted on paper.
    float inkC = screen(uAngleC, DIR_C, pl, cell, rMax, CH_C);
    float inkM = screen(uAngleM, DIR_M, pl, cell, rMax, CH_M);
    float inkY = screen(uAngleY, DIR_Y, pl, cell, rMax, CH_Y);
    float inkK = screen(uAngleK, DIR_K, pl, cell, rMax, CH_K);
    col = uPaper;
    col *= mix(float3(1.0), INK_CYAN,    inkC);
    col *= mix(float3(1.0), INK_MAGENTA, inkM);
    col *= mix(float3(1.0), INK_YELLOW,  inkY);
    col *= mix(float3(1.0), INK_BLACK,   inkK);
  } else if (uMode < 1.5) {
    // (1) RGB — three ADDITIVE light screens over a (dark) paper. Angles reuse C/K/M.
    float inkR = screen(uAngleC, DIR_R, pl, cell, rMax, CH_R);
    float inkG = screen(uAngleK, DIR_G, pl, cell, rMax, CH_G);
    float inkB = screen(uAngleM, DIR_B, pl, cell, rMax, CH_B);
    col = uPaper + INK_R * inkR + INK_G * inkG + INK_B * inkB;
  } else if (uMode < 2.5) {
    // (2) DUOTONE — shadow ink (angle K) + highlight ink (angle C) overprinted.
    float inkDark  = screen(uAngleK, DIR_C, pl, cell, rMax, CH_DARK);
    float inkLight = screen(uAngleC, DIR_M, pl, cell, rMax, CH_LIGHT);
    col = uPaper;
    col *= mix(float3(1.0), uInkA, inkDark);
    col *= mix(float3(1.0), uInkB, inkLight);
  } else {
    // (3) MONO — a single black screen (angle K) on paper.
    float inkK = screen(uAngleK, DIR_K, pl, cell, rMax, CH_DARK);
    col = mix(uPaper, INK_BLACK, inkK);
  }

  // Comic outline: ink the strong tone gradients black.
  if (uEdgeInk > 0.0) {
    float edge = smoothstep(uEdgeLo, uEdgeHi, sobelEdge(p)) * uEdgeInk;
    col = mix(col, INK_BLACK, edge);
  }
  // Paper grain: subtle static speckle, hashed on the widget-LOCAL grain cell so
  // the paper's tooth is printed on the artwork like the dots are. (Hashing the
  // DEVICE pixel instead re-rolls the entire speckle field on every camera pan —
  // the grain boils — and is the same purity break as a device-anchored lattice.)
  if (uGrain > 0.0) {
    col += float3((hash21(floor(pl / uGrainCell)) - 0.5) * 2.0 * uGrain * GRAIN_AMP);
  }
  col = clamp(col, 0.0, 1.0);
  return half4(half3(col) * half(cov), half(cov));
}
`;

// Uniform slot count — asserted by the packer so a shader edit that changes the
// uniform block is caught loudly instead of packing a mis-sized array.
// geometry 6 (uCenter2 uHalfSize2 uCornerRadius1 uAngle1) + 16 scalar knobs + 9
// colour floats (uPaper3 uInkA3 uInkB3) = 31.
const COMIC_UNIFORM_FLOATS = 31;

// A halftone cell smaller than this (device px) aliases to mud; clamp so a tiny
// LPI at low zoom never collapses the dots.
const MIN_CELL_PX = 2.0;

// The paper's tooth: one speckle per WORLD px. This is the density the old
// per-device-pixel hash happened to produce at zoom 1, kept as the reference now
// that the grain is printed on the artwork instead of on the screen.
const GRAIN_WORLD_PX = 1.0;

// A speckle finer than one device pixel cannot be resolved and turns into a
// shimmer; clamp so a zoomed-out print keeps a 1-device-px grain.
const MIN_GRAIN_PX = 1.0;

/** Pure. Asserts `v` is a finite number (a NaN uniform silently blackens the whole
 * region — fail loudly instead). Returns `v`. */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`packComicUniforms: "${name}" must be a finite number, got ${v}`);
  return v;
}

/** Pure. A colour knob (string / rgba array / paint) → its rgb triple [r, g, b] via
 * the shared node-safe parseColor. Alpha is dropped (an ink/paper colour is opaque). */
function rgb(name, v) {
  const c = parseColor(v);
  return [num(name + ".r", c[0]), num(name + ".g", c[1]), num(name + ".b", c[2])];
}

/**
 * Pure function. Resolves a WORLD-px length to the DEVICE px the shader works in,
 * honouring the widget's `worldLocked` knob: locked (1) ⇒ the length rides the
 * ARTWORK (× `scale`, so zooming in magnifies it, like ink printed on the page);
 * unlocked (0) ⇒ the length IS device px, a fixed screen-size grid. Clamped to
 * `minPx` so a zoomed-out print never asks for a feature finer than a pixel.
 *
 * Both camera-facing lengths (the dot pitch and the paper-grain cell) go through
 * this ONE rule, so they can never drift apart into two different lock stories.
 *
 * @param {number} worldPx - the length in world px
 * @param {number} scale - world length → device px (the framework's `u.scale`)
 * @param {number} worldLocked - 1 = ride the artwork, 0 = fixed screen size
 * @param {number} minPx - device-px floor
 * @returns {number} the length in device px
 *
 * @example lockedLengthPx(11, 2, 1, 2) // 22 (world-locked: 11 world px seen at zoom 2)
 * @example lockedLengthPx(11, 2, 0, 2) // 11 (screen-locked: 11 device px at any zoom)
 * @example lockedLengthPx(1, 0.25, 1, 1) // 1 (clamped up to the device-px floor)
 */
function lockedLengthPx(worldPx, scale, worldLocked, minPx) {
  return Math.max(minPx, worldLocked >= 0.5 ? worldPx * scale : worldPx);
}

/**
 * Pure function. Packs the Comic Halftone uniforms into the flat Float32Array
 * CanvasKit expects (SkSL declaration order, tight-packed: float2 = 2 slots,
 * float3 = 3). `u` is the material framework's normalized input: DEVICE-px region
 * geometry {cx, cy, halfW, halfH, cornerRadius, angle} + `scale` (world→device
 * length) + this material's own already-evaluated knobs (the op's `params`).
 *
 * The dot PITCH and the paper-GRAIN cell are the two camera-facing lengths, and
 * both are resolved to device px HERE through lockedLengthPx: `worldLocked` (1,
 * the default) prints them ON the artwork so they magnify with zoom; 0 holds them
 * at a fixed screen size. The shader phases both lattices in the widget's LOCAL
 * frame either way, so neither can swim when the camera moves.
 *
 * @param {object} u - {cx, cy, halfW, halfH, cornerRadius, angle, scale, mode,
 *   pitch, worldLocked, dotShape, angleC, angleM, angleY, angleK, reg, dotGain,
 *   gamma, posterize, edgeInk, edgeLo, edgeHi, grain, paper, inkA, inkB}
 * @returns {Float32Array} length 31, in shader-uniform order
 *
 * @example
 * packComicUniforms({cx:200,cy:150,halfW:200,halfH:150,cornerRadius:0,angle:0,
 *   scale:2,mode:0,pitch:11,worldLocked:1,dotShape:0,angleC:0.26,angleM:1.31,
 *   angleY:0,angleK:0.79,reg:0.15,dotGain:0.03,gamma:1,posterize:0,edgeInk:0,
 *   edgeLo:0.15,edgeHi:0.35,grain:0,paper:"#fbf3e0",inkA:"#ff48b0",inkB:"#0078bf"}).length // 31
 * @example
 * // worldLocked scales the pitch by `scale`; screen-locked uses pitch as device px
 * packComicUniforms({cx:0,cy:0,halfW:80,halfH:60,cornerRadius:0,angle:0,scale:3,
 *   mode:3,pitch:6,worldLocked:1,dotShape:0,angleC:0,angleM:0,angleY:0,angleK:0.79,
 *   reg:0,dotGain:0,gamma:1,posterize:0,edgeInk:0,edgeLo:0,edgeHi:1,grain:0,
 *   paper:"#ffffff",inkA:"#000000",inkB:"#000000"})[7] // 18  (6 world px × scale 3)
 */
export function packComicUniforms(u) {
  const scale = num("scale", u.scale);
  const worldLocked = num("worldLocked", u.worldLocked);
  const cellPx = lockedLengthPx(num("pitch", u.pitch), scale, worldLocked, MIN_CELL_PX);
  const grainCellPx = lockedLengthPx(GRAIN_WORLD_PX, scale, worldLocked, MIN_GRAIN_PX);
  const paper = rgb("paper", u.paper);
  const inkA = rgb("inkA", u.inkA);
  const inkB = rgb("inkB", u.inkB);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius),
    num("angle", u.angle),
    num("mode", u.mode),
    cellPx,
    num("dotShape", u.dotShape),
    num("angleC", u.angleC), num("angleM", u.angleM), num("angleY", u.angleY), num("angleK", u.angleK),
    num("reg", u.reg),
    num("dotGain", u.dotGain),
    num("gamma", u.gamma),
    num("posterize", u.posterize),
    num("edgeInk", u.edgeInk), num("edgeLo", u.edgeLo), num("edgeHi", u.edgeHi),
    num("grain", u.grain),
    grainCellPx,
    paper[0], paper[1], paper[2],
    inkA[0], inkA[1], inkA[2],
    inkB[0], inkB[1], inkB[2],
  ]);
  if (out.length !== COMIC_UNIFORM_FLOATS)
    throw new Error(`packComicUniforms: packed ${out.length} floats, expected ${COMIC_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

/**
 * THE COMIC HALFTONE MATERIAL DESCRIPTOR — the registry entry (materials.js). `id`
 * matches the plugin's `material` op field; `sksl` is the shader; `pack` maps the
 * framework's normalized `u` to the uniform Float32Array. `backdrop: true` binds
 * the standard {blurred, sharp} children and re-renders the content beneath (the
 * same machinery CRT / rainy-window use).
 *
 * `usesBlurredBackdrop: false` — A DECLARED PERFORMANCE CAPABILITY, NOT A LOOK
 * CHANGE. A print reads only the SHARP tone (the whole point of a halftone: sample
 * the continuous image and threshold it against a dot screen), so the SkSL above
 * never evals `blurredBackdrop`; it only DECLARES it, to satisfy the framework's
 * fixed {blurred, sharp} child pair. Building that child means a full Gaussian
 * blur of the composite-so-far every frame, and it was MEASURED at ~33 of the
 * ~50 ms this widget cost per frame at 1400×900 — two thirds of the widget's
 * entire cost, for a texture nothing reads. Declaring it here lets
 * paint_skia.js handleMaterialBackdrop skip the blur and bind the (already-built,
 * free) SHARP texture into the slot instead. Output is pixel-identical.
 *
 * THE FLAG DEFAULTS TO THE SAFE VALUE: a material that declares nothing keeps its
 * blur. Only an explicit `false` opts out, and the import-time cross-check below
 * makes lying about it impossible.
 */
/**
 * THE COMIC KNOB SCHEMA — the ONE declaration of the material's look knobs, in
 * the customProps row shape. Both consumers derive from it (the end-state
 * ruling "custom properties become material properties"):
 *   - plugins/demo/comic.js spreads it into its customProps (self.* rows);
 *   - the FILL-material UI renders it as the paint's param rows, resolved
 *     sparse-over-defaults by materials.resolveMaterialPaint.
 * Geometry knobs (cornerRadius) stay widget-side — a fill's shape IS its
 * geometry.
 */
export const COMIC_FILL_PARAMS = [
  { name: "mode", kind: "select", options: ["cmyk", "rgb", "duotone", "mono"], optionLabels: { cmyk: "CMYK print", rgb: "RGB additive", duotone: "Duotone", mono: "Mono" }, default: "cmyk", help: "Which ink separation to print. CMYK = the classic 4-colour comic; RGB = additive light dots over a dark paper (the desync look); Duotone = two spot inks (riso); Mono = a single black screen (newsprint / manga)." },
  { name: "pitch", kind: "number", default: 11, min: 1, help: "Halftone CELL size in world px — the dot pitch (lower = finer, higher LPI). With World-locked on, this is the dot size ON the artwork." },
  { name: "worldLocked", kind: "boolean", default: true, help: "On (the printed look): the dots live in CANVAS space — printed ON the artwork, so zooming in magnifies them along with the content. Off: the dots hold a fixed SIZE on screen while the artwork scales under them. Either way the lattice is anchored to this panel and never swims when you pan or zoom." },
  { name: "dotShape", kind: "select", options: ["round", "square", "ellipse"], optionLabels: { round: "Round", square: "Square", ellipse: "Ellipse" }, default: "round", help: "Dot silhouette. Round is the classic Ben-Day dot; Square gives a coarse pixelly screen; Ellipse is the elongated chain-dot." },
  { name: "angleC", kind: "angle", default: 15, help: "Screen angle (degrees) for Cyan — also REUSED as Red (RGB mode) and the highlight ink (Duotone). Classic C = 15°." },
  { name: "angleM", kind: "angle", default: 75, help: "Screen angle (degrees) for Magenta — also REUSED as Blue (RGB mode). Classic M = 75°." },
  { name: "angleY", kind: "angle", default: 0, help: "Screen angle (degrees) for Yellow. Classic Y = 0°." },
  { name: "angleK", kind: "angle", default: 45, help: "Screen angle (degrees) for blacK — also REUSED as Green (RGB), the shadow ink (Duotone), and the single Mono screen. Classic K = 45°." },
  { name: "registration", kind: "number", default: 0.15, min: 0, max: 1, help: "Mis-registration / desync: how far each channel's dot grid is shifted (fraction of a cell). 0 = perfect print registration; high = the deliberate off-register / anaglyph split." },
  { name: "dotGain", kind: "number", default: 0.03, min: 0, scrub: 0.01, help: "Dot gain — extra dot radius (fraction of a cell) simulating ink spreading on absorbent paper. Fattens every dot slightly (darker print). NO UPPER CAP — the dot coverage is a smoothstep, so it saturates to SOLID ink once the fattened radius fills the cell; a large value just prints solid, never anything unbounded." },
  { name: "gamma", kind: "number", default: 1.0, min: 0.1, help: "Tone gamma applied to coverage before the dot. >1 lightens the mid-tones (smaller mid dots); <1 darkens them." },
  { name: "posterize", kind: "number", default: 0, min: 0, help: "Flatten the tone into this many levels before separation (flat comic fills). 0 or 1 = off (smooth tone); e.g. 4–6 = crisp poster bands." },
  { name: "edgeInk", kind: "number", default: 0, min: 0, max: 1, help: "Black outline ink strength: inks the strong tone edges (a Sobel gradient) black, like a comic's line art. 0 = no outlines." },
  { name: "edgeLo", kind: "number", default: 0.15, min: 0, help: "Edge threshold LOW: gradient magnitude where the outline ink starts to appear." },
  { name: "edgeHi", kind: "number", default: 0.35, min: 0, help: "Edge threshold HIGH: gradient magnitude where the outline ink is fully black." },
  { name: "grain", kind: "number", default: 0.06, min: 0, max: 1, help: "Paper grain: a subtle static speckle over the print (aged newsprint tooth). 0 = clean paper." },
  { name: "paperColor", kind: "color", default: "#fbf3e0", help: "Paper base colour — what shows through between the dots (a warm cream reads as aged newsprint; a dark colour suits the additive-RGB mode)." },
  { name: "inkA", kind: "color", default: "#ff48b0", help: "Duotone SHADOW ink (the darker-tone spot colour). Only used in Duotone mode." },
  { name: "inkB", kind: "color", default: "#0078bf", help: "Duotone HIGHLIGHT ink (the lighter-tone spot colour). Only used in Duotone mode." },
  { name: "blurRadius", kind: "number", default: 2, min: 0, help: "Gaussian blur radius (world px) of the (unused) blurred child — kept minimal; a print reads the sharp tone." },
  { name: "backdropScale", kind: "number", default: 1, min: 0.25, max: 2, help: "RESOLUTION FACTOR the content beneath is re-rendered at for the screening: 1 = screen resolution, 2 = supersample (crisper cell-centre tone, slower). The 0.25..2 bounds are a PERFORMANCE guard, not a look choice — below 0.25 the backdrop is uselessly coarse and above 2 the re-render cost balloons." },
];

/**
 * Pure function. SCHEMA params (COMIC_FILL_PARAMS names/kinds — strings,
 * booleans, degrees) → the PACKER's numeric params (mode/shape codes, 0/1
 * bools, radians, the packer's own key names). THE one mapping both consumers
 * share: the demo widget's emit() and the fill-material regionOp synthesis
 * (paint_skia handleMaterialPaintShape reads it as entry.toUniformParams).
 *
 * @param {object} p - schema-shaped params (resolved: every knob present)
 * @returns {object} packComicUniforms-shaped params
 *
 * @example comicUniformParams({mode: "rgb", pitch: 9, worldLocked: true, dotShape: "square", angleC: 15, angleM: 75, angleY: 0, angleK: 45, registration: 0.2, dotGain: 0, gamma: 1, posterize: 0, edgeInk: 0, edgeLo: 0.15, edgeHi: 0.35, grain: 0, paperColor: "#fff", inkA: "#f0f", inkB: "#0ff"}).mode // 1
 * @example comicUniformParams({mode: "cmyk", pitch: 11, worldLocked: false, dotShape: "round", angleC: 0, angleM: 0, angleY: 0, angleK: 0, registration: 0, dotGain: 0, gamma: 1, posterize: 0, edgeInk: 0, edgeLo: 0, edgeHi: 0, grain: 0, paperColor: "#fff", inkA: "#f0f", inkB: "#0ff"}).worldLocked // 0
 */
export function comicUniformParams(p) {
  const MODE_CODE = { cmyk: 0, rgb: 1, duotone: 2, mono: 3 };
  const SHAPE_CODE = { round: 0, square: 1, ellipse: 2 };
  const DEG2RAD = Math.PI / 180;
  return {
    mode: MODE_CODE[p.mode] ?? 0,
    pitch: p.pitch,
    worldLocked: p.worldLocked ? 1 : 0,
    dotShape: SHAPE_CODE[p.dotShape] ?? 0,
    angleC: p.angleC * DEG2RAD,
    angleM: p.angleM * DEG2RAD,
    angleY: p.angleY * DEG2RAD,
    angleK: p.angleK * DEG2RAD,
    reg: p.registration,
    dotGain: p.dotGain,
    gamma: p.gamma,
    posterize: p.posterize,
    edgeInk: p.edgeInk,
    edgeLo: p.edgeLo,
    edgeHi: p.edgeHi,
    grain: p.grain,
    paper: p.paperColor,
    inkA: p.inkA,
    inkB: p.inkB,
  };
}

export const COMIC_MATERIAL = {
  id: "comic",
  sksl: COMIC_SKSL,
  pack: packComicUniforms,
  uniformFloats: COMIC_UNIFORM_FLOATS,
  backdrop: true,
  usesBlurredBackdrop: false,
  fillParams: COMIC_FILL_PARAMS,
  toUniformParams: comicUniformParams,
};

// LOUD IMPORT-TIME GUARD (the render_settings.js ANTIALIAS_MODES precedent): a
// material claiming it does not sample the blurred child, whose SkSL then evals it,
// would render WRONG — an un-blurred texture silently substituted for a blurred
// one. Cross-checking the claim against the shader source at load makes that
// impossible to ship. (Generalizing this sweep to every registered material belongs
// in materials.js beside the descriptor contract; this local self-check is the same
// assertion for the one material that currently makes the claim.)
if (COMIC_MATERIAL.usesBlurredBackdrop === false && /\bblurredBackdrop\s*\.\s*eval\b/.test(COMIC_SKSL))
  throw new Error('comic_shader: COMIC_MATERIAL declares usesBlurredBackdrop:false but COMIC_SKSL evals blurredBackdrop — the handler skips building that child, so the shader would sample a SHARP texture where it expects a blurred one. Remove the flag or stop evaluating the child.');
