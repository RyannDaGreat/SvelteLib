/**
 * THE 3D VIEWPORT RASTERIZER — the ONE place a 3D engine exists in this app.
 * It turns a `scene3d_*` widget's PROPERTIES into a bitmap in the shared image
 * registry, so the widget draws through the ordinary `image` op and needs no new
 * IR op and no backend change (the pdf_page / latex / mermaid seam, fourth
 * consumer — render_gpu/gpu/image_registry.js reserveImageSlot +
 * registerRasterizedBitmap).
 *
 * ── THE ENGINE IS CONFINED HERE, DELIBERATELY (W1-O §7.8) ─────────────────────
 * three.js and @sparkjsdev/spark are imported LAZILY, inside the first render,
 * and nowhere else in the app. Two consequences that are the point rather than a
 * side effect: (a) ~1.9 MB gzip never reaches a user with no 3D widget on any
 * slide — the same discipline pdfjs-dist / MathJax / Mermaid already follow; and
 * (b) the engine is replaceable without touching the plugin, the handler or any
 * test, because everything above this file speaks only "pose + size -> ref".
 * KEEP IT THAT WAY: no `import ... from "three"` may appear outside this module.
 * tests/scene3d_test.js greps for one and fails, so the rule is enforced rather
 * than merely written down here.
 *
 * LAZY IS NOT A SUBSTITUTE FOR DECLARED, and the inference that it is cost the
 * whole agent fleet an hour of misdiagnosis, so it is recorded rather than left
 * to be re-derived. **Vite's dependency scanner follows a dynamic `import()` of a
 * BARE SPECIFIER exactly as it follows a static one** — that is deliberate, it is
 * how the optimizer knows to pre-bundle a lazily-loaded package. So an
 * UNDECLARED package aborts `optimizeDeps` with "imported but could not be
 * resolved" whether the import is lazy or not; the dev server then serves
 * nothing, and every browser probe times out waiting for an app that was never
 * built. Worse, it does not show up in a BUILD: Rollup tree-shakes an unreached
 * module, so `vite build` passes green while `vite dev` is broken. `three` and
 * `@sparkjsdev/spark` are therefore real entries in the root package.json, and
 * the fast check after touching this file is `npx vite optimize --force` from
 * `web/`, never a build.
 *
 * ── WHY SPARK, AND WHY NOT WEBGPU (the app's HTTP tenet) ──────────────────────
 * The app's raster backend is Skia/CanvasKit on WebGL2 and deliberately avoids
 * `navigator.gpu` so it works on a plain-HTTP origin
 * (render_gpu/skia/browser_surface.js). A Gaussian-splat rasterizer is a
 * sorted-billboard GPU pipeline Skia cannot express, so this module runs its own
 * SECOND WebGL2 context and hands Skia a finished bitmap. Spark is WebGL2-only
 * with no SharedArrayBuffer requirement, which matters for the same reason
 * WebGPU is out: SAB needs `crossOriginIsolated`, which needs a secure context.
 *
 * ── ONE RENDERER, NOT ONE PER WIDGET ─────────────────────────────────────────
 * Browsers cap live WebGL contexts (commonly ~16) and the app already holds two
 * (the Skia viewport surface and gpuService's). So this module owns exactly ONE
 * canvas + renderer + SparkRenderer for the whole process and renders each 3D
 * node into it SERIALLY, keyed by ref. N widgets on a slide cost one context.
 *
 * ── DETERMINISM: MEASURED, NOT ASSUMED ───────────────────────────────────────
 * The widget must be PROPERTY STATE — same document, same pixels, forever —
 * because that is what lets cli/render_job.js shard a fly-through by strided
 * frame range. Spark's sort and LoD traversal are ASYNC, so a frame taken before
 * they converge would differ from the same frame taken after: that is the one
 * way this widget could become ephemeral. `await spark.update({scene, camera})`
 * is the seam that closes them, and every render below awaits it before reading
 * pixels. Measured first-hand on this repo's headless SwiftShader host with a
 * 786,233-splat scene: repeated renders at one pose are BYTE-IDENTICAL, a
 * `setViewOffset` sub-rect frame is byte-identical to its own repeat, and
 * `clearViewOffset` restores the original frame exactly. There is no clock and no
 * `Math.random` anywhere on this path, so Delta-t = 0 leaves the picture unchanged
 * trivially.
 *
 * ── THE REF IS THE CACHE (R6-1.7) ────────────────────────────────────────────
 * `scene3dRef` is content-addressed over (kind, source, pose, size, look), and
 * registerRasterizedBitmap documents that "the same ref always means the same
 * pixels". Unchanged scene + unchanged view therefore hits the registry and the
 * engine never runs — a cache by construction rather than a bespoke
 * "did anything change?" comparison that goes stale when a property is added.
 * A live fly-through mints a NEW ref every frame and never revisits an old pose,
 * so the cache is bounded by BYTES with an LRU eviction that never evicts what
 * the current frame needs (trimScene3dCache) — the pdf_page_raster rule, and for
 * the same measured reason: CanvasKit's wasm heap has a hard 2 GiB ceiling.
 *
 * ── THE HOLD: A CHANGING PROPERTY MUST NOT PUNCH A TRANSPARENT HOLE ──────────
 * Content-addressing has one consequence that is a defect rather than a feature:
 * a property change mints a ref that does not exist yet, `getSkiaImage` returns
 * null for it, and the compositor draws NOTHING until the render lands. One
 * change is a blink; a DRAG changes a property every frame, so the widget is
 * transparent for the whole gesture. Measured on this host before the fix, with
 * the shipped 1,566-splat fixture — the cheapest scene in the app: a single
 * `camYaw` write left 2-3 animation frames (8-19 ms) drawing nothing, and a
 * CONTINUOUS sweep of `camYaw` (what a mouse-look drag is) left **59 of 60
 * frames drawing nothing — 98%**. The user's report was "it FLICKERS when things
 * change… I can't even use this", and this is the whole of it.
 *
 * THE FIX IS THE ONE THIS CODEBASE ALREADY MADE, one widget over. render_gpu/gpu/
 * video_registry.js hit the identical failure on the video scrubber ("frame,
 * blank, frame: the FLICKER", 153 of 154 captured frames blank) and answered it
 * with a HOLD: a miss draws the source's most recently DECODED frame instead of
 * nothing, and snaps to the exact one when it lands. That vocabulary — `held`,
 * the hold KEY, a pin the evictor skips — is reused here verbatim rather than
 * renamed, because a second name for one mechanism is how a dialect starts.
 *
 * A HOLD IS KEYED ON (kind, src), NOT ON THE POSE, which is the whole point: the
 * pose is exactly what changed. Keying on the SOURCE is also what stops a stale
 * frame outliving its subject — a widget whose `src` changes asks under a
 * different key and can never be handed the previous scene's picture. A FAILED
 * source is never held either: emit() takes its red-panel branch, so a hold could
 * not be drawn even if one existed.
 *
 * AND IT IS LIVE-PATH ONLY — see scene3dDrawRef. video_registry states the reason
 * in its own words: "holding a stale frame in a deterministic path would make its
 * pixels depend on DECODE TIMING, which pure(document, slide, alpha) forbids."
 * Same law, same split.
 *
 * Browser-facing (needs WebGL2 + `createImageBitmap`), NOT part of the DOM-free
 * `core/`. Importable in bare node — the engine import is lazy and every pure
 * helper below is reachable without it, which is what lets the node suite test
 * the pose math and the ref grammar with no browser.
 */

import { SUPERSAMPLE_DENSITY } from "../ir.js";
import { reportOnce } from "../../core/report.js";
import { clampSurfaceSize } from "../../core/clip.js";
import { BYTES_PER_PIXEL, registerRasterizedBitmap, releaseImage, reserveImageSlot } from "./image_registry.js";
// THE ONE VOICE FOR "no internet". Presets reference scenes by URL (the user's
// own ruling: "even if the assets don't exist in our shipped Git repository,
// surely there are some that we can just reference by URL online"), so a
// disconnected author WILL hit this — and it must read the same as every other
// offline refusal in the app rather than inventing a second phrasing.
// render_gpu importing a DOM-free web/ module has precedent in three places
// (map_display, tile_registry, browser_canvaskit).
import { isOnline, offlineMessage } from "../../web/connectivity.js";

/** Device px per canvas unit at world scale 1 — the same 2x supersample every
 *  other raster widget uses (ir.js SUPERSAMPLE_DENSITY, "the retina-dpr 2x
 *  supersample precedent"), so a 3D viewport and a LaTeX equation beside it are
 *  crisp to the same degree. */
export const SCENE3D_RASTER_DENSITY = SUPERSAMPLE_DENSITY;

/** Raster-scale quantum. A continuous resize would mint a distinct ref per pixel
 *  of drag and re-render the scene for each; rounding to a grid reuses one raster
 *  across a small change. Identical to pdf_page_raster's PDF_SCALE_STEP and
 *  latex_raster's LATEX_SCALE_STEP (0.1) — one number, three widgets. */
export const SCENE3D_SCALE_STEP = 0.1;

/** The raster-cache budget, in bytes of decoded pixels. Sized from the same
 *  measurement pdf_page_raster records: each cached raster costs its pixels TWICE
 *  (an ImageBitmap here plus a copy inside CanvasKit's wasm heap, which dies at
 *  exactly 2 GiB), and a fly-through mints one ref per frame that is never
 *  revisited. 256 MB of bitmaps is 512 MB of real cost — the same headroom
 *  PDF_REGION_CACHE_BYTES chose against the same ceiling. */
export const SCENE3D_CACHE_BYTES = 256 * 1024 * 1024;

/** Widest surface this module will ask WebGL for, on either edge. A 3D viewport
 *  under a deep zoom or a large fixed-resolution override can otherwise request a
 *  surface past the driver's MAX_TEXTURE_SIZE, where the allocation fails rather
 *  than degrading. 8192 is the conservative floor across WebGL2 implementations
 *  (SwiftShader included), and it is what core/clip.js's own surface guard
 *  defaults to. */
export const SCENE3D_MAX_RASTER_DIM = 8192;

/** ref -> {status, bytes, promise} — insertion order IS the LRU order (a hit
 *  re-inserts). `bytes` is 0 until the bitmap lands. */
const rasters = new Map();

/** src -> Promise<SplatMesh|Object3D> — one decode per source, shared by every
 *  widget and every pose. Splat scenes are tens of megabytes; decoding one per
 *  frame would dominate everything else in this file. */
const sources = new Map();

/** holdKey -> {ref, place} for the most recently COMPLETED raster of that (kind, src) —
 *  the frame scene3dDrawRef hands a LIVE consumer while a newer pose is still
 *  rendering (see the header's HOLD section). A pin is a REFERENCE into `rasters`,
 *  never a second owner: trimScene3dCache skips pinned refs so the outgoing frame
 *  stays alive until a newer render replaces it as the pin, exactly as
 *  video_registry's evictScrubFrames treats its own holds. */
const held = new Map();

/** The refs any consumer has ASKED FOR since the last trim — the keep-set,
 *  gathered at the one place that can know it (ensureScene3dRasterized) and
 *  consumed by trimScene3dCache. pdf_page_raster.requestedSinceTrim, verbatim and
 *  for the reason it gives. */
let requestedSinceTrim = new Set();

/** The single engine context, built on first use (see engine()). */
let enginePromise = null;

/**
 * Pure function. Rounds a raster scale onto the SCENE3D_SCALE_STEP grid, never
 * below one step. The quantizer that turns a continuous resize into a small set
 * of cache keys.
 *
 * @param {number} scale device px per canvas unit
 * @returns {number}
 *
 * @example roundScene3dScale(2.04) // 2
 * @example roundScene3dScale(2.06) // 2.1
 * @example roundScene3dScale(0) // 0.1
 */
export function roundScene3dScale(scale) {
  const rounded = Math.round(scale / SCENE3D_SCALE_STEP) * SCENE3D_SCALE_STEP;
  return Math.max(SCENE3D_SCALE_STEP, Number(rounded.toFixed(1)));
}

/**
 * Pure function. FNV-1a over a string, as 8 lowercase hex digits. The refs below
 * are content-addressed over a source that may be a multi-megabyte `data:` URI,
 * so the ref must summarize rather than contain it — a registry key is compared,
 * logged and held in a Map, and none of those want a megabyte.
 *
 * @param {string} text
 * @returns {string} 8 hex digits
 *
 * @example digest32("scene3d") // "d1faff4c"
 * @example digest32("") // "811c9dc5"
 */
export function digest32(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Pure function. THE CACHE KEY. A ref names exactly the inputs that change the
 * pixels: which member drew it, which source file, the camera pose, the look
 * knobs, and the surface size. Two renders with equal refs are the same picture,
 * which is what makes the image registry's content-addressed slot a correct
 * cache for this widget (R6-1.7) rather than an approximation of one.
 *
 * Pose numbers are rounded to POSE_DIGITS so that floating-point noise a mouse
 * drag produces (a yaw of 0.30000000000000004 after a preview round-trip) does
 * not mint a second ref for a picture the eye cannot tell apart.
 *
 * @param {object} spec the render spec (see scene3dSpec)
 * @returns {string}
 *
 * @example
 * // scene3dRef({kind: "splat", src: "a.spz", pose: {targetX: 0, targetY: 0, targetZ: 0, yaw: 0, pitch: 0, roll: 0, distance: 3, fov: 1}, look: "", w: 512, h: 384})
 * // "scene3d:splat:670d3f2f:4ed62e67:512x384"
 */
export function scene3dRef(spec) {
  const p = spec.pose;
  const posed = [p.targetX, p.targetY, p.targetZ, p.yaw, p.pitch, p.roll, p.distance, p.fov]
    .map((v) => (Number.isFinite(v) ? v.toFixed(POSE_DIGITS) : "0"))
    .join(",");
  const base = `scene3d:${spec.kind}:${digest32(`${spec.src}\u0000${spec.look ?? ""}`)}:${digest32(posed)}:${spec.w}x${spec.h}`;
  // A VIEWPORT CROP IS PART OF THE KEY, appended only when there IS one so that
  // every ref spelled before sub-frustum rendering existed still spells the same
  // string. Two crops of one pose are two different pictures; sharing one slot
  // between them would draw half of a scene where the other half belongs.
  const v = spec.viewOffset;
  return v
    ? `${base}@${digest32([v.fullW, v.fullH, v.x, v.y].map((n) => n.toFixed(VIEW_OFFSET_DIGITS)).join(","))}`
    : base;
}

/** How finely a sub-frustum's placement is keyed. The quantities are DEVICE
 *  PIXELS of the virtual full-size image, so two decimals is a hundredth of a
 *  pixel — below anything visible, and coarse enough that the float noise a pan
 *  produces does not mint a fresh ref for a view that has not actually moved. */
const VIEW_OFFSET_DIGITS = 2;

/** How many decimals of a pose scalar survive into the cache key. Six is finer
 *  than a 4K pixel subtends at any plausible camera distance, so two poses that
 *  agree here are the same picture; it is also coarse enough to absorb the
 *  float noise an accumulate-preview-commit round trip introduces. */
const POSE_DIGITS = 6;

/**
 * Pure function. The camera EYE position for an orbit pose: the target advanced
 * by `distance` along the direction (yaw, pitch). Angles are RADIANS, matching
 * every other stored angle in this app (`display: "degrees"` is a presentation
 * choice made by the Inspector row, never a storage one — the trap
 * plugins/shapeshifter.js records having already shipped once).
 *
 * The frame is three.js's: +Y up, and yaw 0 with pitch 0 puts the eye on +Z
 * looking toward -Z, which is where an untouched three.js camera already looks.
 *
 *   eye = target + distance · (cos(pitch)·sin(yaw), sin(pitch), cos(pitch)·cos(yaw))
 *
 * @param {{targetX:number,targetY:number,targetZ:number,yaw:number,pitch:number,distance:number}} pose
 * @returns {{x:number,y:number,z:number}}
 *
 * @example orbitEye({targetX: 0, targetY: 0, targetZ: 0, yaw: 0, pitch: 0, distance: 3}) // {x: 0, y: 0, z: 3}
 * @example orbitEye({targetX: 0, targetY: 0, targetZ: 0, yaw: Math.PI / 2, pitch: 0, distance: 2}) // {x: 2, y: 0, z: 1.2246467991473532e-16}
 * @example orbitEye({targetX: 1, targetY: 2, targetZ: 3, yaw: 0, pitch: Math.PI / 2, distance: 4}) // {x: 1, y: 6, z: 3.0000000000000004}
 */
export function orbitEye(pose) {
  const cp = Math.cos(pose.pitch);
  return {
    x: pose.targetX + pose.distance * cp * Math.sin(pose.yaw),
    y: pose.targetY + pose.distance * Math.sin(pose.pitch),
    z: pose.targetZ + pose.distance * cp * Math.cos(pose.yaw),
  };
}

/**
 * Pure function. The camera's UP vector for a pose: unit, PERPENDICULAR to the
 * view direction, and rolled about it by `roll`. Written out rather than left to
 * the engine so the pose model is complete and testable in bare node, and so a
 * canted shot means the same thing whichever engine renders it.
 *
 * IT IS NOT WORLD UP. World +Y is only perpendicular to the view at pitch 0; at
 * any other elevation it leans into the view direction, and feeding that to a
 * `lookAt` leaves the roll implicitly defined by whatever the engine's internal
 * orthogonalization happens to do. (A test asserting perpendicularity is what
 * caught that here — the first version of this function returned world up and was
 * off by dot = -0.479 at pitch 0.5.) The unrolled up is the NORTH direction on the
 * orbit sphere, which is world up already orthogonalized:
 *
 *   a  = (cos(pitch)·sin(yaw),  sin(pitch),  cos(pitch)·cos(yaw))   the target→eye axis
 *   u  = (-sin(pitch)·sin(yaw), cos(pitch), -sin(pitch)·cos(yaw))   north, and a·u = 0
 *
 * Rolling turns u about a, and because a·u = 0 the Rodrigues formula loses its
 * third term and reduces to `up = u·cos(roll) + (a × u)·sin(roll)`, with the
 * cross product simplifying exactly to (-cos(yaw), 0, sin(yaw)).
 *
 * @param {object} pose the same pose orbitEye takes, plus `roll`
 * @returns {{x:number,y:number,z:number}}
 *
 * @example orbitUp({targetX: 0, targetY: 0, targetZ: 0, yaw: 0, pitch: 0, distance: 1, roll: 0}).y // 1
 * @example orbitUp({targetX: 0, targetY: 0, targetZ: 0, yaw: 0, pitch: 0, distance: 1, roll: Math.PI / 2}) // {x: -1, y: 6.123233995736766e-17, z: 0}
 * @example orbitUp({targetX: 0, targetY: 0, targetZ: 0, yaw: 0, pitch: Math.PI / 4, distance: 1, roll: 0}).z // -0.7071067811865475
 */
export function orbitUp(pose) {
  const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
  const sy = Math.sin(pose.yaw), cy = Math.cos(pose.yaw);
  const u = { x: -sp * sy, y: cp, z: -sp * cy };
  const cross = { x: -cy, y: 0, z: sy }; // a × u, simplified
  const c = Math.cos(pose.roll ?? 0), s = Math.sin(pose.roll ?? 0);
  return { x: c * u.x + s * cross.x, y: c * u.y + s * cross.y, z: c * u.z + s * cross.z };
}

/**
 * Pure function. THE HOLD KEY: the identity a stale frame may be shared across.
 * Everything that changes the PICTURE but not the SUBJECT — pose, size, exposure
 * — is deliberately absent, because those are exactly what a live gesture is
 * changing. `kind` is in it because the two members load the same path through
 * different readers, and `src` is in it because a stale frame must never outlive
 * its own source (video_registry.scopedHoldKey's rule, and its wording).
 *
 * @param {string} kind the family member ("splat" / "model")
 * @param {string} src the asset URL or data URI
 * @returns {string}
 *
 * @example scene3dHoldKey("splat", "room.ply") // "splat room.ply"
 * @example scene3dHoldKey("model", "car.glb") === scene3dHoldKey("model", "van.glb") // false
 */
export function scene3dHoldKey(kind, src) {
  return `${kind} ${src}`;
}

/**
 * Query. Cache accounting for a probe to assert against — "the renderer did NOT
 * run" is a claim, and a claim with no observable is not testable. The material
 * raster cache ships `materialRasterStats()` for exactly this reason. `holds` is
 * how many draws were answered by a STALE frame, which is the observable the
 * flicker gate needs: a hold that never fires and a hole are indistinguishable
 * in pixels once the render is fast enough to hide both.
 *
 * @returns {{refs: number, ready: number, loading: number, bytes: number, renders: number, hits: number, holds: number, pins: number}}
 *
 * @example scene3dRasterStats() // {refs: 0, ready: 0, loading: 0, bytes: 0, renders: 0, hits: 0, holds: 0, pins: 0}
 */
export function scene3dRasterStats() {
  let ready = 0, loading = 0, bytes = 0;
  for (const entry of rasters.values()) {
    if (entry.status === "ready") ready++;
    else loading++;
    bytes += entry.bytes;
  }
  return {
    refs: rasters.size, ready, loading, bytes,
    renders: counters.renders, hits: counters.hits, holds: counters.holds, pins: held.size,
  };
}

/** Lifetime counters behind scene3dRasterStats — how many times the engine
 *  actually ran, how many times a ref answered instead, and how many draws a
 *  STALE frame covered for. */
const counters = { renders: 0, hits: 0, holds: 0 };

/**
 * Command. Brings the raster cache back inside SCENE3D_CACHE_BYTES by freeing
 * least-recently-used rasters — the bookkeeping AND the pixels, since
 * image_registry.releaseImage deletes the CanvasKit Image (the copy that lives in
 * the wasm heap) and closes the ImageBitmap.
 *
 * `keepRefs` names the refs the calling frame is ABOUT TO PAINT; they are never
 * evicted whatever the budget says, because a CanvasKit Image is used
 * synchronously during paint and freeing one the next paint needs draws a hole.
 * OMIT IT and the keep-set is everything ASKED FOR since the last trim, which is
 * pdf_page_raster.trimPdfRasterCache's mechanism and its stated reason: the
 * per-frame caller knows the refs IT computed but cannot know the ones a plugin's
 * emit() derived, and a pre-pass that recomputed that formula would be a
 * hand-maintained mirror of the plugin. Asking the module what it was asked for
 * needs no mirror.
 *
 * THIS FUNCTION HAD NO CALLER AT ALL until the render pre-pass arrived, so the
 * 256 MB budget it documents was never enforced and a fly-through grew the cache
 * unbounded toward CanvasKit's 2 GiB wasm ceiling. Recorded rather than quietly
 * fixed, because "the eviction exists" and "the eviction runs" read identically
 * in a diff and only one of them was true of the code that shipped.
 *
 * @param {Set<string>|string[]} [keepRefs] refs the current frame needs; omit for the asked-for set
 * @returns {number} bytes freed
 */
export function trimScene3dCache(keepRefs) {
  const keep = keepRefs instanceof Set ? keepRefs : new Set(keepRefs ?? requestedSinceTrim);
  requestedSinceTrim = new Set();
  let bytes = 0;
  for (const entry of rasters.values()) bytes += entry.bytes;
  const pinned = new Set(held.values());
  let freed = 0;
  for (const [ref, entry] of rasters) {
    if (bytes <= SCENE3D_CACHE_BYTES) break;
    // A PINNED HOLD IS NEVER EVICTED. Freeing it would delete the one frame that
    // stands between a mid-gesture property change and a transparent hole, and it
    // would do so precisely when the budget is tight — i.e. during the heavy
    // fly-through the hold exists for. At most one pin per (kind, src), so the
    // real ceiling is this budget plus the co-visible sources, which is the same
    // arithmetic video_registry's SCRUB_CACHE_CAP documents for its own pins.
    if (keep.has(ref) || pinned.has(ref) || entry.status === "loading") continue;
    rasters.delete(ref);
    releaseImage(ref);
    freed += entry.bytes;
    bytes -= entry.bytes;
  }
  if (bytes > SCENE3D_CACHE_BYTES)
    reportOnce(
      "scene3d_raster:budget",
      `PowerRP scene3d_raster: the 3D rasters ONE frame needs total ${(bytes / 1048576).toFixed(0)} MB, over the ${(SCENE3D_CACHE_BYTES / 1048576).toFixed(0)} MB budget — keeping them all (a frame must paint), but this deck is running close to CanvasKit's 2 GiB wasm heap ceiling. Reduce the number or the size of the co-visible 3D viewports, or switch one to Fixed resolution.`
    );
  return freed;
}

/**
 * Query. Can this process render a 3D scene at all? False in bare node — no DOM,
 * no WebGL context, so no engine. Exported because the honest answer to "why is
 * there a hole in this PNG" is a question the CLI should be able to ASK rather
 * than infer from a stack trace.
 *
 * @returns {boolean}
 *
 * @example scene3dAvailable() // false in bare node, true in a browser
 */
export function scene3dAvailable() {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

/**
 * Query. The load status of one ref: "unloaded", "loading", "ready" or "error".
 * Lets a probe distinguish "still rendering" from "failed".
 *
 * @param {string} ref
 * @returns {string}
 *
 * @example scene3dStatus("scene3d:splat:0:0:1x1") // "unloaded"
 */
export function scene3dStatus(ref) {
  return rasters.get(ref)?.status ?? "unloaded";
}

/**
 * Command (near-pure: idempotent). Ensures the bitmap for `spec` is rendering or
 * rendered, and returns its ref. Safe to call on EVERY emit — a ref already
 * loading or ready is a no-op and counts as a cache hit, which is exactly the
 * R6-1.7 "if neither the scene nor the view changed, reuse the last raster"
 * requirement expressed as a lookup rather than a comparison.
 *
 * Reserves the registry slot SYNCHRONOUSLY before any await, for the reason
 * image_registry.reserveImageSlot documents: a compositor frame landing between
 * "render started" and "bitmap registered" would otherwise call ensureImage on a
 * synthetic ref, fetch() it, fail, and latch the key to "error" permanently.
 *
 * A PLUGIN'S emit() MUST NOT CALL THIS DIRECTLY — call scene3dDrawRef, which
 * calls this and then decides which of the two answers ("the raster you asked
 * for" vs "the one that can be drawn right now") the caller should get. This
 * function's answer is THE TRUE REF, always: it is what `pendingImageRefs()`
 * gates the exporters on and what cli/render.js counts as omitted media, and
 * both of those must keep naming the picture the document asks for.
 *
 * @param {object} spec see scene3dSpec — {kind, src, pose, look, w, h, background}
 * @returns {string} the ref this spec's pixels will land under
 */
export function ensureScene3dRasterized(spec) {
  const ref = scene3dRef(spec);
  requestedSinceTrim.add(ref); // this frame wants it — never evict it out from under the paint
  if (!scene3dAvailable()) {
    // BARE NODE (cli/render.js, the node test lane). There is no DOM and no GL
    // context, so this cannot draw — and it must say THAT rather than let a
    // `document is not defined` escape from three.js three frames later, which
    // reads as a bug in the widget. The ref is still returned and still emitted
    // as an `image` op, which is what makes cli/render.js count it in the media
    // ops it OMITTED: a hole that announces itself is the whole point of that
    // counter (the map widget's recorded hole was a widget that emitted NOTHING).
    reportOnce(
      "scene3d_raster:no-dom",
      "PowerRP scene3d_raster: a 3D viewport cannot render here — this process has no DOM and no WebGL context, so three.js cannot be started. cli/render.js will count the missing image and report it; use cli/render_job.js (headless Chrome) for a render that includes 3D scenes."
    );
    return ref;
  }
  const existing = rasters.get(ref);
  if (existing) {
    counters.hits++;
    rasters.delete(ref); // re-insert at the LRU tail: a hit is a recent use
    rasters.set(ref, existing);
    return ref;
  }
  reserveImageSlot(ref);
  const entry = { status: "loading", bytes: 0, promise: null };
  rasters.set(ref, entry);
  counters.renders++;
  entry.promise = renderSpec(spec)
    .then((bitmap) => {
      entry.status = "ready";
      entry.bytes = bitmap.width * bitmap.height * BYTES_PER_PIXEL;
      registerRasterizedBitmap(ref, bitmap);
      // THE PIN MOVES ON COMPLETION, never on request: the hold must always name a
      // frame that can actually be drawn, so it is only ever set from inside the
      // success branch. The outgoing pin's raster is released by the ordinary LRU
      // once it is no longer pinned (trimScene3dCache), so replacing a pin leaks
      // nothing and dropping one frees a frame that is now genuinely dead.
      // THE PLACE TRAVELS WITH THE PIN, and that is not bookkeeping. Once a
      // viewport crop exists, two rasters of one scene cover DIFFERENT parts of
      // the widget, so a stale frame drawn at the CURRENT frame's rect would be
      // the whole object squeezed into a window — which does not read as "a
      // slightly old picture", it reads as a wrongly-zoomed one. Measured while
      // building the zoom gate: mid-zoom the widget showed the entire scene
      // stretched across the visible window. A raster remembers where it goes.
      held.set(scene3dHoldKey(spec.kind, spec.src), { ref, place: spec.place ?? null });
      return bitmap;
    })
    .catch((e) => {
      // LOUD, ONCE, AND LATCHED. A 3D scene that failed to load or render must
      // never look like one that is still loading, and must never look like a
      // blank widget: the failure is recorded against the SOURCE so the plugin's
      // emit() draws its red "could not load this scene" panel naming the reason.
      //
      // RECORDING A *RENDER* FAILURE HERE, NOT ONLY A *LOAD* FAILURE, IS
      // DELIBERATE AND WAS EARNED. A one-off `Can not resolve #include
      // <splatDefines>` (a stale pre-bundled dep chunk after a mid-session
      // re-optimize) reached the console but left the widget drawing NOTHING,
      // because only ensureSource recorded into sourceErrors. An empty box for a
      // file that is present and valid is exactly the silent failure this
      // codebase forbids. Latching matches image_registry's own decode-error
      // contract — reported once, never silently retried, cleared by a reload.
      entry.status = "error";
      const err = e instanceof Error ? e : new Error(String(e));
      if (!sourceErrors.has(spec.src)) sourceErrors.set(spec.src, err.message);
      console.error(`PowerRP scene3d_raster: ${spec.kind} "${truncate(spec.src)}" failed to render at ${spec.w}x${spec.h} — ${err.message}`);
      return null;
    });
  return ref;
}

/**
 * Command (near-pure: idempotent). THE ONE ENTRY POINT A PLUGIN'S emit() USES.
 * Keeps `spec`'s raster rendering (ensureScene3dRasterized, so the true ref is
 * reserved, counted and pending) and answers with the ref that should actually be
 * DRAWN this frame:
 *
 *   · the TRUE ref once it is ready — always, and always eventually;
 *   · otherwise, when `hold` is set, the most recently completed raster of the
 *     SAME (kind, src): a slightly stale picture instead of a transparent hole;
 *   · otherwise the true ref, which draws nothing until it lands (today's
 *     behaviour, unchanged).
 *
 * `hold` IS THE LIVE/ONE-SHOT SWITCH AND IT IS NOT A PERFORMANCE KNOB. Set it
 * only from a consumer that REPAINTS when the raster arrives — the editor canvas,
 * which subscribes to image_registry.onImageLoad. A one-shot pixel consumer
 * (thumbnail, PNG export, the CLI hook) must leave it false: it captures once, so
 * a stale frame would not be a brief artifact but the SHIPPED PICTURE, and one
 * that looks entirely plausible while being of the wrong pose. That is a worse
 * failure than a visible hole, and it is the same split video_registry draws
 * between getScrubFrame (live, holds) and requestScrubFrame (awaited, exact).
 * The video EXPORT path needs no such care and gets none: web/renderJobPage.js
 * waits for `pendingImageRefs()` to empty before capturing, and the true ref is in
 * that set, so by capture time the true ref is ready and the hold is unreachable.
 *
 * CONVERGENCE, WHICH IS THE PROPERTY THAT KEEPS THE CORE INVARIANT: hold the
 * document and `t` fixed and this settles, in bounded time, on a ref that is a
 * pure function of the document. The hold is a TRANSIENT of the live surface, in
 * the same category as "the raster has not landed yet" — which this path already
 * had. It adds no new dependency on history that outlives a render.
 *
 * IT RETURNS THE PLACE AS WELL AS THE REF, because a stale frame of a CROPPED
 * render covers a different part of the widget than the frame being waited for.
 * The caller draws at the returned `place`, so a held frame lands exactly where
 * its pixels belong and the swap is a change of detail rather than a lurch. When
 * the true ref is used, `place` is the caller's own — an identity pass-through.
 *
 * @param {object} spec see ensureScene3dRasterized; `place` is opaque here and is
 *   simply carried, so the raster module never learns what a local rect is
 * @param {{hold?: boolean}} [opts] hold: this consumer repaints, so prefer a stale frame to a hole
 * @returns {{ref: string, place: object|null}} the ref to draw and where to draw it
 */
export function scene3dDrawRef(spec, { hold = false } = {}) {
  const ref = ensureScene3dRasterized(spec);
  const place = spec.place ?? null;
  if (!hold || scene3dStatus(ref) === "ready") return { ref, place };
  const stale = held.get(scene3dHoldKey(spec.kind, spec.src));
  if (!stale || scene3dStatus(stale.ref) !== "ready") return { ref, place };
  counters.holds++;
  return { ref: stale.ref, place: stale.place ?? place };
}

/**
 * Query. The load error for a source, or null. The widget reads this so a broken
 * file becomes a visible in-canvas message rather than an empty box: an absent
 * picture and a failed picture must not look the same.
 *
 * @param {string} src
 * @returns {string|null}
 *
 * @example scene3dErrorFor("never-asked.spz") // null
 */
export function scene3dErrorFor(src) {
  return sourceErrors.get(src) ?? null;
}

/** src -> message, for scene3dErrorFor. Filled by BOTH the loader and the render
 *  catch (see ensureScene3dRasterized). Kept separate from `sources` so a failed
 *  promise is not re-awaited by every frame. */
const sourceErrors = new Map();

/** Pure function. Shortens a src for a log line (a data: URI is huge).
 *  @example truncate("data:model/gltf-binary;base64," + "A".repeat(80)) // "data:model/gltf-binar…(109 chars)" */
function truncate(src) {
  const s = String(src);
  return s.length > 48 ? `${s.slice(0, 21)}…(${s.length} chars)` : s;
}

/**
 * Command. Builds (once) the single WebGL2 context this module renders through:
 * an offscreen canvas, a three.js renderer, and a SparkRenderer bound to it.
 * The engine modules are imported HERE and nowhere else, which is what keeps
 * them out of the main bundle and out of bare node.
 *
 * @returns {Promise<{THREE: object, renderer: object, spark: object, scene: object, camera: object, canvas: HTMLCanvasElement}>}
 */
function engine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const [THREE, spark] = await Promise.all([import("three"), import("@sparkjsdev/spark")]);
    const canvas = document.createElement("canvas");
    // antialias OFF is Spark's own documented requirement: WebGL MSAA does not
    // improve Gaussian-splat rendering and costs a lot of fill rate. alpha ON so
    // an unfilled scene composites over whatever the slide puts behind it, the
    // way every other box widget does.
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
    // A PBR MATERIAL RENDERS BLACK WITH NO LIGHT, so a lit member needs a rig.
    // Three-point, the standard studio setup, mounted once and moved in and out
    // of the scene with the model (a splat's radiance is baked, so lights would
    // be inert on it and it never gets these). Intensities are the conventional
    // key : fill : rim ratio of roughly 1 : 0.4 : 0.6, and the whole rig is
    // parented to ONE Group so adding and removing it is one call.
    const lights = new THREE.Group();
    const key = new THREE.DirectionalLight(0xffffff, 3);
    key.position.set(1, 1.4, 1);
    const fill = new THREE.DirectionalLight(0xffffff, 1.2);
    fill.position.set(-1.4, 0.2, 0.8);
    const rim = new THREE.DirectionalLight(0xffffff, 1.8);
    rim.position.set(0, 0.6, -1.5);
    // A dim sky/ground ambient so a surface facing away from all three is dark
    // rather than pure black — the "there is a room around this" term that makes
    // an untextured metal sphere read as metal instead of a silhouette.
    lights.add(key, fill, rim, new THREE.HemisphereLight(0xbfd4ff, 0x2a2620, 0.6));
    // ACES filmic is glTF's own recommended view transform and what every
    // reference glTF viewer uses, so a Khronos sample model looks here the way it
    // looks in its own documentation.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const sparkRenderer = new spark.SparkRenderer({ renderer });
    scene.add(sparkRenderer);
    return { THREE, spark, renderer, spark3d: sparkRenderer, scene, camera, canvas, lights };
  })();
  return enginePromise;
}

/**
 * Command. Loads one source into a three.js object, once per src. A splat file
 * becomes a SplatMesh; anything else is refused loudly rather than guessed at —
 * the mesh member of this family is not wired yet and a silent empty scene is
 * exactly the failure mode this codebase forbids.
 *
 * @param {string} src the asset URL or data URI
 * @param {string} kind the family member ("splat")
 * @returns {Promise<object>} a three.js Object3D
 */
function ensureSource(src, kind) {
  const key = `${kind}\u0000${src}`;
  const cached = sources.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const { spark, THREE } = await engine();
    if (kind === "splat") {
      const mesh = new spark.SplatMesh({ url: src });
      await mesh.initialized;
      // THE UPRIGHT TURN IS NOT APPLIED HERE ANY MORE, and the reason is a
      // correction worth keeping. This line used to read `mesh.quaternion.set(1,
      // 0, 0, 0)` — a fixed 180-degree turn about X — justified as "a property of
      // the FORMAT, not of the author's scene", because 3DGS trainers write
      // Y-DOWN (inherited from COLMAP's camera frame) while three.js is Y-UP.
      //
      // THAT IS TRUE OF MOST CAPTURES AND NOT ALL OF THEM, which the user found
      // the only way anyone finds this: "upside-down splats". A claim that a
      // format is uniform is falsified by one file that is not, and a fixed
      // correction then has no escape hatch — the widget is simply wrong and
      // nothing the author can touch will right it.
      //
      // So the turn moved to the per-render assembly, where it reads a per-item
      // `upright` property and DEFAULTS TO THE OLD BEHAVIOUR. It cannot live on
      // the mesh regardless: `sources` caches one mesh per URL and shares it
      // across every widget using that file, so baking an orientation here would
      // make two widgets of one capture fight over it.
      // NOT NORMALIZED, deliberately — see normalizeToUnitSphere. A capture's
      // floaters would blow up its bounding sphere and shrink the subject to a
      // dot; captures also carry a meaningful real-world scale that a room-scale
      // fly-through depends on.
      return mesh;
    }
    if (kind === "model") {
      const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
      const gltf = await new GLTFLoader().loadAsync(src);
      normalizeToUnitSphere(gltf.scene, THREE);
      return gltf.scene;
    }
    throw new Error(`scene3d_raster: no loader for kind "${kind}" (known: "splat", "model")`);
  })().catch((e) => {
    const err = e instanceof Error ? e : new Error(String(e));
    sourceErrors.set(src, sourceFailureMessage(src, err));
    sources.delete(key); // a later frame may legitimately retry a fixed asset
    throw err;
  });
  sources.set(key, promise);
  return promise;
}

/**
 * Pure function. The sentence the widget shows when a scene will not load —
 * the app's ONE offline voice when that is the cause, and the loader's own
 * message otherwise.
 *
 * A remote preset that 404s and a laptop with no wifi are DIFFERENT problems and
 * must not read the same. `isOnline()` is deliberately only used to CHOOSE the
 * wording, never to decide whether to try: `navigator.onLine === true` is nearly
 * meaningless behind a captive portal or a dead uplink, which is exactly why
 * web/connectivity.js exists rather than a bare flag read. So the fetch is always
 * attempted, and only its FAILURE is interpreted.
 *
 * @param {string} src the asset URL
 * @param {Error} err whatever the loader threw
 * @returns {string} one sentence for the in-canvas panel
 *
 * @example // online, a dead link:  "HTTP 404 fetching https://example.com/gone.spz"
 * @example // offline:              "Offline — loading a 3D scene from the web needs the internet"
 */
function sourceFailureMessage(src, err) {
  const remote = /^https?:/i.test(String(src));
  if (remote && !isOnline()) return offlineMessage(SCENE_FETCH_CAPABILITY);
  return err.message;
}

/** The capability name offlineMessage() completes. Named here so the sentence is
 *  written once and the phrasing cannot drift between call sites. */
const SCENE_FETCH_CAPABILITY = "loading a 3D scene from the web";

/**
 * Command (mutates `object`'s transform). Centres a loaded model on the origin
 * and scales it to a UNIT bounding sphere.
 *
 * WHY THIS IS NECESSARY AND NOT A CONVENIENCE: glTF sample models span five
 * orders of magnitude of authored scale — Avocado is about 0.05 units tall,
 * ToyCar about 0.06, Fox about 100. One default camera pose cannot frame both, so
 * without this every model would need its own hand-tuned `camDistance` and every
 * preset would be a different shot of the same nothing. Normalizing means ONE
 * pose frames ANY model, which is what makes the camera presets portable across
 * sources. It is a pure function of the geometry, so it does not perturb
 * determinism.
 *
 * Applied to MESHES ONLY. A splat capture's outlier "floaters" sit far outside
 * the subject, so its bounding sphere is not its subject and normalizing would
 * shrink the thing you came to see into a speck; a capture also carries a real
 * metric scale that a room-scale fly-through depends on.
 *
 * @param {object} object a three.js Object3D
 * @param {object} THREE the three module (passed rather than imported: the engine is lazy)
 * @returns {void}
 *
 * @example // a 100-unit-tall Fox centred at (0, 50, 0) becomes a unit sphere at the origin
 */
function normalizeToUnitSphere(object, THREE) {
  const sphere = new THREE.Box3().setFromObject(object).getBoundingSphere(new THREE.Sphere());
  if (!(sphere.radius > 0) || !Number.isFinite(sphere.radius)) {
    reportOnce(
      "scene3d_raster:degenerate-bounds",
      "PowerRP scene3d_raster: a model has no finite bounding sphere (empty scene, or NaN vertex data), so it is drawn at its authored scale and may be invisible. Check the file."
    );
    return;
  }
  const s = 1 / sphere.radius;
  object.scale.setScalar(s);
  object.position.set(-sphere.center.x * s, -sphere.center.y * s, -sphere.center.z * s);
}

/**
 * Command. Renders ONE spec into an ImageBitmap. Serialized behind `renderQueue`
 * because there is one context: two concurrent renders would resize the same
 * canvas under each other and each would read back the other's pixels.
 *
 * @param {object} spec see ensureScene3dRasterized
 * @returns {Promise<ImageBitmap>}
 */
function renderSpec(spec) {
  renderQueue = renderQueue.then(() => renderSpecNow(spec), () => renderSpecNow(spec));
  return renderQueue;
}

/** The serialization chain for the one context (see renderSpec). */
let renderQueue = Promise.resolve();


/**
 * Near-pure helper (allocates a Group; mutates nothing shared). The scene object
 * wrapped in whatever turn makes it stand up.
 *
 * WHY A WRAPPER AND NOT `object.rotation.x`: the object comes from the shared
 * per-URL source cache, so two widgets showing one capture would fight over its
 * orientation — one would flip the other's. The Group is per render and throwaway.
 *
 * @param {object} object - the cached mesh/scene
 * @param {{kind: string, upright?: boolean}} spec - the render spec
 * @param {object} THREE - the engine namespace
 * @returns {object} `object` itself when no turn is needed, else a Group holding it
 */
function uprightWrapper(object, spec, THREE) {
  // ONLY SPLATS. A glTF model is authored Y-up by the format's own specification,
  // so there is nothing to correct and no control is offered — the same doctrine
  // as the light rig two lines below: a node kind that cannot honour a control
  // gets nothing rather than a fake one.
  if (spec.kind !== "splat") return object;
  if (spec.upright === false) return object;
  const g = new THREE.Group();
  g.rotation.x = Math.PI; // Y-DOWN capture -> Y-UP scene
  g.add(object);
  return g;
}

/**
 * Command. The actual draw: size the surface, place the camera from the pose,
 * converge Spark's async sort, render, read back.
 *
 * @param {object} spec see ensureScene3dRasterized
 * @returns {Promise<ImageBitmap>}
 */
async function renderSpecNow(spec) {
  const [{ renderer, spark3d, scene, camera, canvas, lights, THREE }, object] = await Promise.all([
    engine(),
    ensureSource(spec.src, spec.kind),
  ]);
  const size = clampSurfaceSize(spec.w, spec.h, SCENE3D_MAX_RASTER_DIM);
  if (!size.safe)
    reportOnce(
      `scene3d_raster:clamp:${spec.w}x${spec.h}`,
      `PowerRP scene3d_raster: a 3D viewport asked for a ${spec.w}x${spec.h} surface, clamped to ${size.w}x${size.h} (the ${SCENE3D_MAX_RASTER_DIM} px edge limit). It will render at the clamped size and be scaled up, so it will look soft. Reduce the widget's zoom, or set an explicit Fixed resolution.`
    );

  // ONE object in the scene at a time. The scene is shared (one context), so the
  // previous widget's model must leave before this one draws, or two decks'
  // scenes composite into one picture.
  for (const child of [...scene.children]) if (child !== spark3d) scene.remove(child);
  // THE UPRIGHT TURN, applied to a per-render WRAPPER rather than to the object.
  // `object` comes from the shared per-URL cache, so rotating it directly would
  // leak one widget's orientation into every other widget showing the same file.
  // A Group costs nothing and keeps the cached mesh pristine.
  scene.add(uprightWrapper(object, spec, THREE));
  // The light rig rides with a LIT member only. A splat's radiance is baked into
  // its Gaussians, so a light would be inert on it — and the house doctrine
  // (core/registry.js effectsInjectable) is that a node kind which cannot honour
  // a control gets nothing rather than a fake one.
  if (spec.lit) scene.add(lights);
  renderer.toneMappingExposure = spec.exposure;

  renderer.setSize(size.w, size.h, false);
  camera.fov = (spec.pose.fov * 180) / Math.PI; // three takes vertical FOV in DEGREES
  // ── THE SUB-FRUSTUM (todo #257): RENDER ONLY WHAT IS ON SCREEN ─────────────
  // `viewOffset` says "this surface is the (x, y) window of a virtual fullW x
  // fullH image of the whole widget". setViewOffset shears the projection to draw
  // exactly that window, so a viewport re-renders at SCREEN resolution however far
  // the canvas is zoomed in, at a cost bounded by the screen rather than by the
  // zoom. It is the asymmetric-frustum device a tiled offline renderer uses, and
  // it is why this is a CROP OF THE RENDER rather than a crop of a finished
  // bitmap — the latter cannot add detail, which is the whole complaint.
  //
  // `aspect` MUST DESCRIBE THE FULL IMAGE, not the window: three derives the base
  // frustum width from aspect x height and THEN applies the offset, so feeding it
  // the window's aspect would distort every cropped frame. Pinned by asserting a
  // cropped render matches the corresponding REGION of the uncropped one, rather
  // than by reading three's source and believing it.
  //
  // AND THE CLEAR IS NOT OPTIONAL. One camera serves every widget in the process,
  // so a viewport left set by the previous render would silently crop the next.
  // W3-E measured that clearViewOffset restores the original frame EXACTLY.
  if (spec.viewOffset) {
    const v = spec.viewOffset;
    camera.aspect = v.fullW / v.fullH;
    camera.setViewOffset(v.fullW, v.fullH, v.x, v.y, size.w, size.h);
  } else {
    camera.clearViewOffset();
    camera.aspect = size.w / size.h;
  }
  camera.near = spec.near;
  camera.far = spec.far;
  const eye = orbitEye(spec.pose);
  const up = orbitUp(spec.pose);
  camera.position.set(eye.x, eye.y, eye.z);
  camera.up.set(up.x, up.y, up.z);
  camera.lookAt(new THREE.Vector3(spec.pose.targetX, spec.pose.targetY, spec.pose.targetZ));
  camera.updateProjectionMatrix();

  // THE DETERMINISM SEAM. Spark's splat sort and LoD traversal are async; without
  // this await the readback below can catch a partially-sorted frame, which is
  // how a "recordable" widget quietly becomes an ephemeral one (see the header).
  await spark3d.update({ scene, camera });
  renderer.render(scene, camera);
  return createImageBitmap(canvas);
}

/**
 * Command. Drops every cached raster and source and forgets the engine — for
 * tests that need a clean module, and the invalidation hook if a source ever
 * becomes mutable. Does NOT dispose the WebGL context: a context is scarce and
 * re-creating one per test would exhaust the browser's cap faster than keeping it.
 */
export function resetScene3dRaster() {
  for (const ref of rasters.keys()) releaseImage(ref);
  rasters.clear();
  held.clear();
  sources.clear();
  sourceErrors.clear();
  counters.renders = 0;
  counters.hits = 0;
  counters.holds = 0;
}
