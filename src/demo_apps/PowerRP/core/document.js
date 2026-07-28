/**
 * The PowerRP document model.
 *
 * A document is ONLY:
 *   { meta: {name, slideW, slideH}, slides: [{id, name, transition, delta}] }
 *
 * `slide.transition` = {type, seconds, curve, sound} describes how the
 * presenter animates INTO this slide from its predecessor (core/transitions.js;
 * a first-class SELECTABLE thing — the navigator's between-rows slice). It
 * SUPERSEDES the old per-slide `duration` (lead ruling, Round 12); legacy
 * documents migrate LOUDLY at load (withDurationMigrated).
 *
 * There is no separate items table — EVERYTHING is deltas (slide 0's delta
 * creates the initial items). Slide N's full state = fold of deltas 0..N over
 * the empty state. An item appearing in multiple slides IS the "symlink":
 * same UUID, same object, until a delta deletes it. Slides have permanent
 * UUIDs; slide NUMBERS are display-only (indices shift on insert).
 *
 * State shape produced by folding:
 *   { items: { <itemId>: {type, x, y, z, ...plugin state} } }
 *
 * Documents are treated as IMMUTABLE — every edit returns a new document.
 * That makes the undo snapshot log and the per-document fold cache trivial
 * (WeakMap keyed on document identity).
 *
 * There is no meta.fps: presentations are always UNCAPPED (round 11 ruling —
 * frame caps don't exist; one frame per rAF tick). Legacy docs that still
 * carry meta.fps get it stripped loudly by repairedDocument().
 */

import { blendApplied, copied, copiedDeep, getPath, setPath, deletePath, leaves } from "./deltas.js";
import { defaultTransition, withDurationMigrated } from "./transitions.js";
import {
  withBindingsMigrated, withItemRefsRemapped, declaredListLeaves, isEquationValue,
} from "./expressions.js";
import { withRichTextMigrated } from "./richtext.js";
import { bundleDefaults, linearEndpointsToAngle } from "./properties.js";

/** Query (reads crypto). Random 8-char id — short but collision-safe at presentation scale. */
export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().slice(0, 8);
  return Math.floor(Math.random() * 2 ** 48).toString(36);
}

// Default slide dimensions when no meta is supplied — the historical camera
// literal (1280×720, 16:9). Named so the ONE place that defines it can't drift.
const DEFAULT_SLIDE_W = 1280;
const DEFAULT_SLIDE_H = 720;

/**
 * Pure function. THE canonical initial state of THE camera item — the ONE
 * source of truth reconciling the three literals that used to disagree
 * (newDocument, withCameraEnsured, and the camera plugin's `defaults`; the
 * plugin ones lacked name/active and hardcoded 1280×720 — cruft audit). The
 * camera is a bbox covering the slide rect; `meta` (default {slideW, slideH})
 * sizes it. `active:true` so it frames from slide 0; white background per the
 * user spec. `name` lets the picker/inspector label it.
 *
 * @example defaultCameraState() // {type: "camera", name: "Camera", x: 0, y: 0, w: 1280, h: 720, z: 1000, rotation: 0, scale: 1, active: true, background: "#ffffff", antialias: "standard", retina: true, ditherMode: "off", ditherEmphasis: 1}
 * @example defaultCameraState({slideW: 800, slideH: 600}).w // 800
 */
export function defaultCameraState(meta = {}) {
  return {
    type: "camera", name: "Camera",
    x: 0, y: 0, w: meta.slideW ?? DEFAULT_SLIDE_W, h: meta.slideH ?? DEFAULT_SLIDE_H,
    z: 1000, rotation: 0, scale: 1, active: true, background: "#ffffff",
    // Rendering bundle (AA / retina / dither) is DECLARED on the camera plugin;
    // spread its defaults so a fresh camera is born complete — otherwise
    // missingDefaults flags them every load and the repair pipeline re-injects
    // them (the pre-camera-lane regression this fixes). Spread (not literals) so
    // any future rendering prop is included automatically, never drifting.
    ...bundleDefaults("rendering"),
  };
}

/**
 * Pure function (modulo uuid randomness). A fresh single-slide document.
 *
 * @example // newDocument().slides.length === 1; newDocument().meta.slideW === 1280
 */
export function newDocument() {
  // Every document is born with THE camera (one per document, manifest spec):
  // a bbox item covering the meta slide rect, tweenable like any other item.
  const cameraId = uuid();
  const meta = { name: "Untitled", slideW: DEFAULT_SLIDE_W, slideH: DEFAULT_SLIDE_H };
  return {
    // No meta.fps: presentations are always UNCAPPED (round 11 ruling —
    // frame caps don't exist; one frame per rAF tick at any display rate).
    meta,
    slides: [{
      id: uuid(),
      name: "Slide 1",
      // Slide 0 has no predecessor, so its transition is inert, but every slide
      // carries the default tween for a uniform shape (the navigator addresses
      // the slice above each row; slide 0's is simply never animated).
      transition: defaultTransition("tween"),
      delta: {
        items: { [cameraId]: defaultCameraState(meta) },
      },
    }],
  };
}

// ── Folding (with per-document cache) ────────────────────────────────────────

const foldCache = new WeakMap(); // doc → Array<state at slide i, fully applied>

/**
 * Query (memoized on document identity). Full state at slide `index` with all
 * deltas 0..index applied at alpha 1.
 */
export function slideState(doc, index) {
  let states = foldCache.get(doc);
  if (!states) foldCache.set(doc, (states = []));
  if (states.length > index) return states[index];
  let cur = states.length ? states[states.length - 1] : {};
  for (let i = states.length; i <= index; i++) {
    // A disabled slide's delta is skipped entirely — "slides are just deltas,
    // so toggling a slide off toggles its delta out of the fold".
    cur = doc.slides[i].enabled === false ? cur : blendApplied(cur, doc.slides[i].delta, 1);
    states.push(cur);
  }
  return states[index];
}

/**
 * Pure function (uses memoized fold). State mid-transition INTO slide `index`
 * at tween strength `alpha` (0 = previous slide exactly, 1 = slide `index`).
 * This is the single evaluation point for editor, presenter, and CLI renderer.
 *
 * @example // foldState(doc, 2, 0.5) — halfway between slide 1 and slide 2
 */
export function foldState(doc, index, alpha = 1) {
  // Slide 0 has no predecessor to tween from — it is always fully applied.
  if (index === 0 || alpha >= 1) return slideState(doc, index);
  if (doc.slides[index].enabled === false) return slideState(doc, index - 1);
  return blendApplied(slideState(doc, index - 1), doc.slides[index].delta, alpha);
}

/**
 * Pure function (uses memoized folds). THE TWEEN: `foldState` plus each widget's
 * OWN declared state interpolation. This is what every (doc, slide, alpha)
 * consumer should call — the editor's pixel consumers, the presenter, the
 * exporters and the CLI all reach it through web/cameraFrame.evaluatedStateAt.
 *
 * ── WHY A PLUGIN GETS A SAY IN THE TWEEN ─────────────────────────────────────
 * `foldState` tweens LEAF BY LEAF (core/deltas.blendApplied → interpolate), which
 * is right whenever a widget's properties are independent. Some are not. The
 * deep-zoom Mandelbrot's centre and zoom are COUPLED: its `zoomExponent` is a
 * logarithm, so the frame it names shrinks EXPONENTIALLY while a linearly-tweened
 * centre walks a straight line — and the point being zoomed into then swings
 * thousands of frame-widths off screen mid-transition and snaps back at the end
 * (measured: 4170 half-widths for a whole-set → seahorse-tail pair). No
 * reparameterization of the STORED leaves can fix that under a leaf-wise lerp: the
 * correct centre path is c(a) = A + B·10^(-z(a)) with A and B determined by BOTH
 * endpoints jointly, and requiring a pointwise map to reproduce it for every
 * endpoint pair forces A constant — i.e. no anchor at all. So the law needs the
 * two endpoint STATES, which is exactly what this function has and a leaf does not.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────
 *   plugin.interpolateState(from, to, alpha) → {stateKey: value}
 * PURE, and a function of (from, to, alpha) ONLY — so RenderTree stays
 * pure(document, [[slide, alpha]]). `from` is the folded state on the previous
 * slide, `to` is this slide's state at alpha 1 (both already memoized by
 * slideState, so declaring a hook costs no extra folding). The returned keys
 * REPLACE the leaf-wise result for that item; `{}` means "the generic lerp is
 * already right". Keys must be keyframable leaves of the item's own state.
 *
 * A hook is consulted ONLY strictly between the endpoints: at alpha 0 and 1 the
 * answer IS a stored state, so this is the identity there by construction, and
 * `foldState` alone remains the exact fold it has always been.
 *
 * @param {object} doc - PowerRP document
 * @param {number} index - slide index being tweened INTO
 * @param {number} alpha - tween strength 0..1
 * @param {object} registry - plugin registry (resolves each item's type → plugin)
 * @returns {object} the folded state, with every declared coupling applied
 *
 * @example // tweenedState(doc, 1, 0.5, registry) — halfway, coupled properties honored
 */
export function tweenedState(doc, index, alpha, registry) {
  const blended = foldState(doc, index, alpha);
  if (index === 0 || alpha <= 0 || alpha >= 1) return blended;
  if (doc.slides[index].enabled === false) return blended;
  const from = slideState(doc, index - 1), to = slideState(doc, index);
  let out = blended;
  for (const [id, state] of Object.entries(blended.items ?? {})) {
    // An item created or purged BY this delta has no pair of endpoint states, so
    // there is no coupling to speak of — its appearance/disappearance is the
    // generic discrete rule's business.
    const a = from.items?.[id], b = to.items?.[id];
    if (!a || !b) continue;
    // The SAME gate deriveRenderTree applies before its own `registry.get`: an
    // item that will not be rendered has no tween to correct, and a typeless one
    // (a raw pre-repair document) has no plugin to ask.
    if (state.active === false || typeof state.type !== "string") continue;
    const hook = registry.get(state.type).interpolateState;
    if (!hook) continue;
    const over = hook(a, b, alpha);
    if (Object.keys(over).length === 0) continue;
    // Copy-on-write: `blended` may be a CACHED fold (slideState's array) at the
    // endpoints, and even mid-tween it is shared with nothing that expects it to
    // change under it. One new object per corrected item, nothing else touched.
    if (out === blended) out = { ...blended, items: { ...blended.items } };
    out.items[id] = { ...state, ...over };
  }
  return out;
}

// ── Keyframe edits (all pure: return a new document) ─────────────────────────

/** Pure function. Sets a keyframe leaf in slide `index`'s delta. */
export function keyframed(doc, index, path, value) {
  const slides = doc.slides.map((s, i) =>
    i === index ? { ...s, delta: setPath(s.delta, path, value) } : s);
  return { ...doc, slides };
}

/** Pure function. Removes a keyframe leaf from slide `index`'s delta. */
export function unkeyframed(doc, index, path) {
  const slides = doc.slides.map((s, i) =>
    i === index ? { ...s, delta: deletePath(s.delta, path) } : s);
  return { ...doc, slides };
}

/** Pure function. True if slide `index`'s delta keys this exact path. */
export function hasKeyframe(doc, index, path) {
  return getPath(doc.slides[index].delta, path) !== undefined;
}

/**
 * Pure function. Slide indices whose delta keys `path`, ascending. Powers the
 * inspector's prev/next-keyframe jumps.
 *
 * @example // keyframeIndices(doc, ["items","ab12","x"]) → [0, 3, 7]
 */
export function keyframeIndices(doc, path) {
  const out = [];
  doc.slides.forEach((s, i) => {
    if (getPath(s.delta, path) !== undefined) out.push(i);
  });
  return out;
}

// The item-subtree leaf paths (relative to items.<id>) that can change an
// item's DERIVED world, plus a group's own INFLUENCE (Round 17 ungroup bake).
// A keyframe on any of these at slide i is a "change point" where the member's
// group-influenced world may differ from slide i−1, so ungroup must re-bake
// there. (fill/opacity/etc. don't move geometry, so they're excluded — no
// redundant transform keyframes.) `members`/`bind.*` are group-only but listing
// them for the member subtree too is harmless (members never key them).
const WORLD_AFFECTING_LEAVES = [
  ["x"], ["y"], ["rotation"], ["scale"], ["w"], ["h"],
  ["rotationAnchor", "x"], ["rotationAnchor", "y"], ["active"],
  ["members"], ["bind", "x"], ["bind", "y"], ["bind", "rotation"], ["bind", "scale"],
];

/**
 * Pure function. The ascending slide indices at which ungroup must BAKE a
 * member's transform (Round 17.3): every slide where the MEMBER or its GROUP has
 * a world-affecting keyframe (WORLD_AFFECTING_LEAVES), from the member's
 * creation slide onward. Between two such slides the member's group-influenced
 * world is constant (neither the member's own transform nor the group's
 * influence changed), so a keyframe baked at each change point reproduces the
 * pre-ungroup world on EVERY slide the member exists — that is the invariant
 * "removing the group changes nothing visible, anywhere". The member's creation
 * slide (where its full initial transform is keyed) is always included; slides
 * before it are excluded (the member does not exist yet).
 *
 * @example // member created slide 0 (x/y keyed), group moved on slide 2:
 * @example ungroupBakeSlides({slides: [{delta: {items: {m: {type: "rect", x: 1, y: 1}}}}, {delta: {items: {}}}, {delta: {items: {g: {x: 5}}}}]}, "m", "g") // [0, 2]
 * @example ungroupBakeSlides({slides: [{delta: {items: {m: {type: "rect", x: 1}}}}]}, "m", "g") // [0]
 */
export function ungroupBakeSlides(doc, memberId, groupId) {
  const creation = keyframeIndices(doc, ["items", memberId, "type"])[0] ?? 0;
  const touches = (id, delta) =>
    WORLD_AFFECTING_LEAVES.some((leaf) => getPath(delta, ["items", id, ...leaf]) !== undefined);
  const out = [];
  doc.slides.forEach((s, i) => {
    if (i < creation) return;
    if (i === creation || touches(memberId, s.delta) || touches(groupId, s.delta)) out.push(i);
  });
  return out;
}

/**
 * Pure function. THE fallback display name for an unnamed item: its plugin
 * `title` plus a 4-char id prefix — "Rect (ab12)". The ONE home for this format
 * (app.displayName and the Inspector item picker both built it by hand; cruft
 * audit "displayName fallback format in two homes"). Callers pass the item's
 * own `name` first and only fall back to this when it is absent.
 *
 * @example itemFallbackName("Rect", "ab12cd34") // "Rect (ab12)"
 * @example itemFallbackName("Camera", "ff00") // "Camera (ff00)"
 */
export function itemFallbackName(title, id) {
  return `${title} (${id.slice(0, 4)})`;
}

// ── Item edits ───────────────────────────────────────────────────────────────

/** Pure function. Creates an item (full initial state) in slide `index`'s delta. Returns [doc, itemId]. */
export function withNewItem(doc, index, state) {
  const id = uuid();
  return [keyframed(doc, index, ["items", id], copied(state)), id];
}

/**
 * Pure function. Clones a SET of item states under NEW ids, rerouting every
 * reference that points INSIDE the set and leaving every reference that points
 * OUTSIDE it verbatim. THE subgraph clone — the one place copy/paste and
 * Duplicate agree on what cloning a selection means.
 *
 * ── THE INTERNAL/EXTERNAL BOUNDARY (the whole difficulty) ─────────────────────
 * Cloning {A, B} where A references B must yield A' referencing B' — otherwise
 * the pasted copy is a puppet of the original. But a reference from A to some C
 * that is NOT in the set must still point at C — otherwise pasting an arrow
 * bound to a circle you did not copy would break the arrow. `idMap`'s KEY SET is
 * therefore the definition of "inside": mapped ⇒ reroute, unmapped ⇒ verbatim.
 *
 * ── THE TWO REFERENCE SHAPES ─────────────────────────────────────────────────
 *   1. EQUATION references — `@<id>.<prop>`, `@<id>_<anchor>.x`, and bare
 *      widget arguments `f(@<id>)` — living in any EQUATION slot (isEquationValue)
 *      of the item state, INCLUDING per-element slots of a declared list (a
 *      polygon vertex bound to another widget's anchor). Rewritten TOKEN-
 *      STRUCTURALLY by expressions.withItemRefsRemapped, never by string
 *      replacement (which would also hit "@id" inside a string literal and match
 *      a PREFIX of a longer id).
 *   2. ID-VALUED slots — a plain itemId (crop box `target`) or an array of them
 *      (group `members`), which are not equations at all and so are invisible to
 *      the token rewriter. Discovered from the plugin's own `itemRefs`
 *      declaration (the `legacyKeys` seam: a declarative path list, so core
 *      hard-codes no widget type); a string value maps as one id, an array maps
 *      element-wise.
 *
 * `external` is every itemId a clone still points at from OUTSIDE the set —
 * legitimate for a document-internal edge, and the caller's cue to REPORT the
 * ones its own document does not contain (a purged item, or a cross-document
 * paste): a dangling reference must never become a silent failure.
 *
 * Args:
 *   states (object): {sourceItemId: rawItemState} — the states being cloned
 *   idMap (Map): sourceItemId → the clone's NEW itemId (the caller mints them,
 *     which is what lets A' name B' before B' has been written anywhere)
 *   registry (object): plugin registry (.get(type) → plugin with .itemRefs?)
 *
 * Returns:
 *   {states: {newItemId: clonedState}, external: string[]}
 *
 * @example clonedItemStates({a: {type: "rect", x: "@b.x"}, b: {type: "rect", x: 5}}, new Map([["a", "A"], ["b", "B"]]), reg).states.A.x // "@B.x"
 * @example clonedItemStates({a: {type: "rect", x: "@c.x"}}, new Map([["a", "A"]]), reg) // {states: {A: {type: "rect", x: "@c.x"}}, external: ["c"]}
 * @example clonedItemStates({g: {type: "group", members: ["m"]}, m: {type: "rect"}}, new Map([["g", "G"], ["m", "M"]]), reg).states.G.members // ["M"]
 */
export function clonedItemStates(states, idMap, registry) {
  const out = {};
  const external = new Set();
  const mapId = (id) => {
    if (typeof id !== "string") return id;
    if (idMap.has(id)) return idMap.get(id);
    external.add(id);
    return id;
  };
  for (const [sourceId, state] of Object.entries(states)) {
    const newId = idMap.get(sourceId);
    if (!newId) throw new Error(`clonedItemStates: idMap has no new id for "${sourceId}" — every cloned state needs one (a clone's own references depend on it)`);
    const plugin = registry.get(state.type);
    // copiedDeep, not copied(): the id-valued rewrite below REPLACES a `members`
    // array, and copied() shares arrays with the source state (the fold cache's
    // fast path), so a shallower clone would mutate the document being cloned.
    const clone = copiedDeep(state);
    // 1. EQUATION references — the canonical "every equation slot of one item"
    //    walk (the evaluateState / withVariableRenamed idiom: leaves() keeps
    //    arrays opaque, so declared LIST elements are walked separately).
    for (const [path, value] of [...leaves(clone), ...declaredListLeaves(clone)])
      if (isEquationValue(plugin, path, value)) {
        const remapped = withItemRefsRemapped(value, idMap);
        for (const id of remapped.external) external.add(id);
        if (remapped.src !== value) setLeaf(clone, path, remapped.src);
      }
    // 2. ID-VALUED slots (plugin.itemRefs) — a plain id or an array of ids.
    for (const path of plugin.itemRefs ?? []) {
      const value = getPath(clone, path);
      if (Array.isArray(value)) setLeaf(clone, path, value.map(mapId));
      else if (typeof value === "string") setLeaf(clone, path, mapId(value));
    }
    out[newId] = clone;
  }
  return { states: out, external: [...external] };
}

/**
 * Command (mutates `tree`). Writes `value` at `path` inside an ALREADY-CLONED
 * state tree. Every container along the way exists (the path came from walking
 * this very tree), so this only has to descend — the array-aware create-as-you-go
 * machinery deltas.setPath needs does not apply, and descending an array here is
 * safe because clonedItemStates deep-copied it.
 */
function setLeaf(tree, path, value) {
  let cur = tree;
  for (const key of path.slice(0, -1)) cur = cur[key];
  cur[path[path.length - 1]] = value;
}

/** Pure function. Removes an item FROM EXISTENCE: every keyframe of it on every slide. */
export function withItemPurged(doc, itemId) {
  let out = doc;
  for (let i = 0; i < doc.slides.length; i++) out = unkeyframed(out, i, ["items", itemId]);
  return out;
}

/**
 * Pure function. Item ids that can never render: ids referenced by any
 * slide's delta whose `type` is never set to one of `knownTypes` in ANY
 * slide's delta (enabled or disabled — a disabled creation slide is a
 * transient view state, not an orphan). The known producer: deleting an
 * item's CREATION slide leaves its later property keyframes orphaned, and
 * the fold then materializes a typeless item that crashes evaluation.
 *
 * Args:
 *   doc (object): document
 *   knownTypes (Set<string>): registered plugin type names
 *
 * Returns:
 *   {id, reason}[] (empty when the document is clean)
 *
 * @example orphanedItems({slides: [{delta: {items: {a: {x: 99}}}}]}, new Set(["rect"])) // [{id: "a", reason: "no type is ever set (orphaned keyframes)"}]
 * @example orphanedItems({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}]}, new Set(["rect"])) // []
 */
export function orphanedItems(doc, knownTypes) {
  const typeOf = new Map();
  const seen = new Set();
  for (const s of doc.slides)
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      seen.add(id);
      if (item && typeof item === "object" && typeof item.type === "string" && !typeOf.has(id))
        typeOf.set(id, item.type);
    }
  const out = [];
  for (const id of seen) {
    if (!typeOf.has(id)) out.push({ id, reason: "no type is ever set (orphaned keyframes)" });
    else if (!knownTypes.has(typeOf.get(id))) out.push({ id, reason: `unknown type "${typeOf.get(id)}"` });
  }
  return out;
}

/**
 * Pure function. Document with every orphaned item's subtree purged from
 * every slide delta, plus the report of exactly what was removed and why.
 * REPORTING IS THE CALLER'S JOB — the repair never hides anything, it hands
 * back the drop list (the app console.errors each entry; silence forbidden).
 * Idempotent; a clean document comes back unchanged with dropped = [].
 *
 * @example withOrphanedItemsDropped({slides: [{delta: {items: {a: {x: 99}}}}]}, new Set(["rect"])).dropped.length // 1
 * @example // withOrphanedItemsDropped(cleanDoc, types) → {doc: cleanDoc-equivalent, dropped: []}
 */
export function withOrphanedItemsDropped(doc, knownTypes) {
  const dropped = orphanedItems(doc, knownTypes);
  let out = doc;
  for (const { id } of dropped) out = withItemPurged(out, id);
  return { doc: out, dropped };
}

/**
 * Pure function. Default-valued leaf paths a TYPED item never writes (non-null)
 * in ANY slide delta. Such partial items fold into states missing required
 * geometry ("w: undefined"); the canvas2D painter silently drew nothing for
 * them, but the strict IR builders throw and brick the app — so they must be
 * repaired at the load boundary.
 *
 * WHEN THIS FIRES: routinely, on VERSION SKEW — whenever PowerRP's plugin
 * defaults GROW (e.g. rotationAnchor was added in round 11), every document
 * saved by an older version is missing the new keys and gets them filled on
 * load; this is how edits are preserved across versions. Exceptionally, on
 * DAMAGED or HAND-WRITTEN documents (hand-authored save files are legal) and
 * on explicit null deletes of required keys. A doc created and edited purely
 * by the current version reports nothing.
 *
 * `type` itself is exempt (that's the orphan case — see orphanedItems); a
 * null (delete-sentinel) write does NOT count as coverage, since it folds to
 * the same missing key.
 *
 * Args:
 *   doc (object): document
 *   registry (object): plugin registry (.get(type) → plugin with .defaults)
 *
 * Returns:
 *   {id, slideIndex, missing: {path: string[], value}[]}[]
 *
 * @example missingDefaults({slides: [{delta: {items: {a: {type: "rect", x: 1, y: 2}}}}]}, reg)[0].missing.some((m) => m.path.join(".") === "w") // true
 * @example // a fully-written item (normal creation) reports nothing
 */
export function missingDefaults(doc, registry) {
  const typeSlide = new Map(); // id → first slide index with a known type
  const written = new Map(); // id → Set of non-null leaf path strings
  for (let i = 0; i < doc.slides.length; i++)
    for (const [id, item] of Object.entries(doc.slides[i].delta.items ?? {})) {
      if (!(item && typeof item === "object")) continue;
      if (typeof item.type === "string" && !typeSlide.has(id)) typeSlide.set(id, i);
      if (!written.has(id)) written.set(id, new Set());
      const set = written.get(id);
      for (const [path, value] of leaves(item)) if (value !== null) set.add(path.join("."));
    }
  const out = [];
  for (const [id, slideIndex] of typeSlide) {
    let plugin;
    try {
      plugin = registry.get(doc.slides[slideIndex].delta.items[id].type);
    } catch {
      continue; // unknown type = the orphan case, repaired by orphanedItems
    }
    const set = written.get(id);
    const missing = [];
    for (const [path, value] of leaves(plugin.defaults)) {
      // COMPUTED defaults (self.-equations, e.g. rotationAnchor) are supplied
      // by the derivation stage's fallback (derive.worldTransform) — they
      // must NEVER be materialized into documents (Opus1 review finding #1:
      // injecting them contradicts the defaults-fallback migration design
      // and rewrites every pre-round-11 doc on load).
      if (typeof value === "string" && value.startsWith("self.")) continue;
      // A scalar default key is ALSO covered when the item wrote a nested OBJECT
      // there (e.g. default `background: "#fff"` but the item holds a gradient
      // PAINT object → the written set has `background.type`/`background.stops…`
      // but not bare `background`). Without this, the scalar default would be
      // keyframed OVER the gradient on load — silently wiping every gradient
      // paint (background/fill/stroke) on repair. Treat "any written descendant"
      // as coverage so paint objects survive a load/repair round-trip.
      const key = path.join(".");
      const coveredByNested = set.has(key) || [...set].some((w) => w.startsWith(key + "."));
      if (path[0] !== "type" && !coveredByNested) missing.push({ path, value });
    }
    if (missing.length) out.push({ id, slideIndex, missing });
  }
  return out;
}

/**
 * Pure function. Document with every missing default keyframed into the
 * item's CREATION slide (where its type is written), plus the fill report.
 * REPORTING IS THE CALLER'S JOB (the app console.errors each fill — silent
 * repairs are forbidden). Idempotent: a filled document reports nothing.
 *
 * @example withMissingDefaultsFilled({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}]}, reg).filled.length // 1
 */
export function withMissingDefaultsFilled(doc, registry) {
  const filled = missingDefaults(doc, registry);
  let out = doc;
  for (const { id, slideIndex, missing } of filled)
    for (const { path, value } of missing)
      out = keyframed(out, slideIndex, ["items", id, ...path], value);
  return { doc: out, filled };
}

/**
 * Query. Every stored shadow keyframe that was INVISIBLE under the OLD shadow
 * gate but WOULD render under the NEW one (manifest 14.8) — the "dormant
 * shadow" migration set.
 *
 * WHY this exists: Round 14.8 changed the shadow render gate from
 * `blur > 0 AND opacity > 0` (the only gate ever committed — effects.js
 * ab9a675) to `opacity > 0` alone (blur 0 is now a legal HARD-edged shadow).
 * But the OLD defaults spread `{dx:3, dy:3, blur:0, color, opacity:0.5}` onto
 * every item at creation, so pre-14.8 documents carry a stored shadow with
 * opacity 0.5 and blur 0 — INVISIBLE under the old gate (blur 0), but the new
 * gate would suddenly render it. The user's ruling "existing docs keep stored
 * values" cannot mean "shadows the user never saw suddenly appear"; this
 * migration neutralizes exactly those dormant shadows (and ONLY those) to the
 * new-gate-off form (opacity 0), leaving every VISIBLE shadow untouched.
 *
 * A shadow keyframe is dormant iff, in a single slide's delta, it carries BOTH
 *   opacity > 0  (would render under the new gate) AND
 *   blur <= 0    (was invisible under the old gate: it needed blur > 0)
 * with both leaves present in that same delta (the creation-slide full-object
 * case old docs universally produce). A partial keyframe touching only blur or
 * only opacity is left alone — the old-gate-invisibility test needs both.
 *
 * Args:
 *   doc (object): document
 *
 * Returns:
 *   {id, slideIndex, opacity, blur}[]  (empty when nothing is dormant)
 *
 * @example dormantShadows({slides: [{delta: {items: {a: {type: "rect", shadow: {blur: 0, opacity: 0.5}}}}}]}) // [{id: "a", slideIndex: 0, opacity: 0.5, blur: 0}]
 * @example dormantShadows({slides: [{delta: {items: {a: {type: "rect", shadow: {blur: 4, opacity: 0.5}}}}}]}) // [] (blur > 0 = it was visible before; keep it)
 * @example dormantShadows({slides: [{delta: {items: {a: {type: "rect", shadow: {blur: 0, opacity: 0}}}}}]}) // [] (opacity 0 = already off)
 */
export function dormantShadows(doc) {
  const out = [];
  for (let i = 0; i < doc.slides.length; i++)
    for (const [id, item] of Object.entries(doc.slides[i].delta.items ?? {})) {
      const sh = item && typeof item === "object" ? item.shadow : null;
      if (!sh || typeof sh !== "object") continue;
      const opacity = sh.opacity, blur = sh.blur;
      // Both leaves must be present in THIS delta (a same-delta full shadow) so
      // the old-gate-invisibility test is well-defined; skip a partial keyframe.
      if (typeof opacity !== "number" || typeof blur !== "number") continue;
      if (opacity > 0 && blur <= 0) out.push({ id, slideIndex: i, opacity, blur });
    }
  return out;
}

/**
 * Pure function. Document with every DORMANT shadow (dormantShadows) rewritten
 * to opacity 0 — the new-gate-off form — plus the migration report. Idempotent
 * (a neutralized shadow has opacity 0, so it is no longer dormant). REPORTING IS
 * THE CALLER'S JOB (printRepairReports); this only builds the {doc, report}.
 *
 * @example withDormantShadowsNeutralized({slides: [{delta: {items: {a: {type: "rect", shadow: {blur: 0, opacity: 0.5}}}}}]}).doc.slides[0].delta.items.a.shadow.opacity // 0
 * @example withDormantShadowsNeutralized({slides: [{delta: {items: {a: {type: "rect", shadow: {blur: 0, opacity: 0.5}}}}}]}).neutralized.length // 1
 */
export function withDormantShadowsNeutralized(doc) {
  const neutralized = dormantShadows(doc);
  let out = doc;
  for (const { id, slideIndex } of neutralized)
    out = keyframed(out, slideIndex, ["items", id, "shadow", "opacity"], 0);
  return { doc: out, neutralized };
}

/**
 * Pure function. Legacy key renames the document needs: every slide-delta
 * write at items.<id>.<oldKey> where the item's plugin declares
 * `legacyKeys: {oldKey: newKey}` (a top-level-state-key rename map — the
 * declarative, no-type-special-casing seam for schema renames; first user:
 * the arrow's headSize → headLength, manifest Round 11). Runs at the load
 * boundary BEFORE withMissingDefaultsFilled — the fill would otherwise write
 * the new key's default at the creation slide and the user's legacy value
 * would then read as a stale duplicate.
 *
 * `stale: true` marks a slide where BOTH keys are written — there the new
 * key is authoritative and the legacy write is only dropped.
 *
 * Args:
 *   doc (object): document
 *   registry (object): plugin registry (.get(type) → plugin with .legacyKeys?)
 *
 * Returns:
 *   {id, slideIndex, from, to, stale}[] (empty when nothing needs renaming)
 *
 * @example legacyKeyRenames({slides: [{delta: {items: {a: {type: "arrow", headSize: 20}}}}]}, reg) // [{id: "a", slideIndex: 0, from: "headSize", to: "headLength", stale: false}]
 * @example legacyKeyRenames({slides: [{delta: {items: {a: {type: "arrow", headLength: 20}}}}]}, reg) // [] (already current)
 */
export function legacyKeyRenames(doc, registry) {
  const typeOf = new Map(); // id → first type written anywhere (creation type)
  for (const s of doc.slides)
    for (const [id, item] of Object.entries(s.delta.items ?? {}))
      if (item && typeof item === "object" && typeof item.type === "string" && !typeOf.has(id))
        typeOf.set(id, item.type);
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!(item && typeof item === "object") || !typeOf.has(id)) continue;
      let plugin;
      try {
        plugin = registry.get(typeOf.get(id));
      } catch {
        continue; // unknown type = the orphan case, repaired by orphanedItems
      }
      for (const [from, to] of Object.entries(plugin.legacyKeys ?? {}))
        if (from in item) out.push({ id, slideIndex, from, to, stale: to in item });
    }
  });
  return out;
}

/**
 * Pure function. Document with every legacy key MOVED to its current name in
 * place (same slide, same item, value verbatim — numbers, equation strings,
 * and null delete-sentinels all survive, so keyframed ANIMATIONS of a renamed
 * property survive too). Where the new key already exists on that slide the
 * legacy write is dropped (the new one is authoritative). REPORTING IS THE
 * CALLER'S JOB (console.error per entry at the load boundary — silent
 * repairs are forbidden). Idempotent: a migrated document reports nothing.
 *
 * @example withLegacyKeysRenamed({slides: [{delta: {items: {a: {type: "arrow", headSize: 20}}}}]}, reg).doc.slides[0].delta.items.a.headLength // 20
 * @example // withLegacyKeysRenamed(currentDoc, reg) → {doc: currentDoc, renamed: []}
 */
export function withLegacyKeysRenamed(doc, registry) {
  const renamed = legacyKeyRenames(doc, registry);
  let out = doc;
  for (const { id, slideIndex, from, to, stale } of renamed) {
    const value = getPath(out.slides[slideIndex].delta, ["items", id, from]);
    out = unkeyframed(out, slideIndex, ["items", id, from]);
    if (!stale) out = keyframed(out, slideIndex, ["items", id, to], value);
  }
  return { doc: out, renamed };
}

/**
 * Pure function. Fancy-arrow fill/stroke value migrations the document needs
 * (manifest Round 17.4, "fancy arrow should have both fill AND stroke"):
 * every fancy_arrow slide-delta write of `stroke` that predates the real
 * `fill` property. Historically `stroke` WAS the tapered polygon's fill color
 * (see plugins/fancy_arrow.js's header) — this is a VALUE migration, not a
 * key rename (both the old and new schema use the key name "stroke", just
 * with a different meaning), so it can't reuse the generic legacyKeys
 * mechanism (which only moves a value from one key name to another). It runs
 * AFTER withLegacyKeysRenamed (so a truly ancient `color`-keyed doc has
 * already converged on `stroke` by the time this reads it) and BEFORE
 * withMissingDefaultsFilled (so the fill-in-progress fancy_arrow items still
 * look "missing fill" to that step and get NOTHING clobbered here — the fill
 * step then supplies the untouched-old-doc's `strokeWidth` default of 0,
 * which is exactly the "no outline until the user adds one" requirement).
 *
 * A slide is a migration candidate iff it writes `stroke` on a fancy_arrow
 * item AND that same delta does not ALSO write `fill` (an item already on
 * the new schema, or one where the current slide is a later keyframe of just
 * `stroke`-the-outline-color post-migration, is left alone — idempotent).
 *
 * Args:
 *   doc (object): document
 *   registry (object): plugin registry (.get(type) → plugin)
 *
 * Returns:
 *   {id, slideIndex, value}[] (empty when nothing needs migrating)
 *
 * @example fancyArrowFillMigrations({slides: [{delta: {items: {a: {type: "fancy_arrow", stroke: "#ff0000"}}}}]}, reg) // [{id: "a", slideIndex: 0, value: "#ff0000"}]
 * @example fancyArrowFillMigrations({slides: [{delta: {items: {a: {type: "fancy_arrow", fill: "#ff0000", stroke: "#000000"}}}}]}, reg) // [] (already on the new schema)
 */
export function fancyArrowFillMigrations(doc, registry) {
  const typeOf = new Map();
  for (const s of doc.slides)
    for (const [id, item] of Object.entries(s.delta.items ?? {}))
      if (item && typeof item === "object" && typeof item.type === "string" && !typeOf.has(id))
        typeOf.set(id, item.type);
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!(item && typeof item === "object") || typeOf.get(id) !== "fancy_arrow") continue;
      if (!("stroke" in item) || "fill" in item) continue;
      out.push({ id, slideIndex, value: item.stroke });
    }
  });
  return out;
}

/**
 * Pure function. Document with every fancy-arrow fill/stroke migration
 * (fancyArrowFillMigrations) applied: the old `stroke` value is COPIED to
 * `fill` on the same slide (preserving the exact appearance — old renders
 * were that color), and the old `stroke` write is deleted (falling back to
 * the plugin's new outline-color default; strokeWidth stays whatever the doc
 * already had, or the missing-defaults fill supplies 0 next — so an
 * un-migrated doc that never set strokeWidth draws NO outline, byte-identical
 * to before). REPORTING IS THE CALLER'S JOB. Idempotent (a migrated item has
 * `fill`, so fancyArrowFillMigrations no longer selects it).
 *
 * @example withFancyArrowFillMigrated({slides: [{delta: {items: {a: {type: "fancy_arrow", stroke: "#ff0000"}}}}]}, reg).doc.slides[0].delta.items.a.fill // "#ff0000"
 * @example withFancyArrowFillMigrated({slides: [{delta: {items: {a: {type: "fancy_arrow", stroke: "#ff0000"}}}}]}, reg).doc.slides[0].delta.items.a.stroke // undefined (falls back to the plugin default)
 */
export function withFancyArrowFillMigrated(doc, registry) {
  const migrated = fancyArrowFillMigrations(doc, registry);
  let out = doc;
  for (const { id, slideIndex, value } of migrated) {
    out = keyframed(out, slideIndex, ["items", id, "fill"], value);
    out = unkeyframed(out, slideIndex, ["items", id, "stroke"]);
  }
  return { doc: out, migrated };
}

/** Pure function. True iff `p` is an objectBoundingBox point {x, y} (finite
 * numbers) — the shape a linear gradient's from/to endpoints have. */
function isBBoxPoint(p) {
  return !!p && typeof p === "object" && typeof p.x === "number" && typeof p.y === "number"
    && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** Near-pure helper (mutates the passed `out` accumulator — its whole purpose).
 * Recursively finds every LINEAR-GRADIENT sub-state inside a slide-delta item
 * that still lacks an `angle`. A linear gradient is precisely an object with a
 * `stops` ARRAY and both `from`/`to` POINTS — that gate excludes arrow endpoints
 * (`from`/`to` with NO `stops` sibling) and radial gradients (`center`/`r`, no
 * from/to). Records {relPath, from, to} where relPath locates the gradient
 * object within the item. Recurses into plain-object children only (never into
 * the `stops` array or the {x,y} points), so nested paints (fill.linear,
 * legacy-inline fill, camera background) are all caught. */
function collectLinearGradientsMissingAngle(node, relPath, out) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  if (Array.isArray(node.stops) && isBBoxPoint(node.from) && isBBoxPoint(node.to) && !("angle" in node))
    out.push({ relPath, from: node.from, to: node.to });
  for (const [k, v] of Object.entries(node))
    if (v && typeof v === "object" && !Array.isArray(v)) collectLinearGradientsMissingAngle(v, [...relPath, k], out);
}

/**
 * Pure function. Linear-gradient DIRECTION migrations the document needs: the
 * gradient direction used to be four discrete presets that stored only
 * objectBoundingBox `from`/`to`; it is now an `angle` in DEGREES (the "angle"
 * property kind — core/properties.js). Every legacy linear gradient (a paint's
 * `linear` sub-state, a legacy-inline linearGradient, or a camera background
 * gradient) that carries from/to but no `angle` is a candidate; the angle is
 * `linearEndpointsToAngle(from, to)`. from/to are LEFT UNTOUCHED (the renderer's
 * parsePaint still reads them), so a migrated document renders byte-identically —
 * the four presets map to exact angles (→ 0°, ↓ 90°, ↘ 45°, ↗ 315°).
 *
 * Args:
 *   doc (object): document
 *
 * Returns:
 *   {id, slideIndex, relPath, angle}[] (empty when nothing needs migrating).
 *   `relPath` is the path to the gradient object WITHIN the item (e.g.
 *   ["fill", "linear"] or ["fill"] for a legacy-inline gradient).
 *
 * @example linearGradientAngleMigrations({slides: [{delta: {items: {a: {type: "rect", fill: {type: "linearGradient", linear: {stops: [{offset:0,color:"#000"},{offset:1,color:"#fff"}], from: {x:0,y:0}, to: {x:1,y:1}}}}}}}]}) // [{id: "a", slideIndex: 0, relPath: ["fill", "linear"], angle: 45}]
 * @example linearGradientAngleMigrations({slides: [{delta: {items: {a: {type: "arrow", from: {x:0,y:0}, to: {x:1,y:1}}}}}]}) // [] (arrow endpoints have no stops — not a gradient)
 */
export function linearGradientAngleMigrations(doc) {
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!item || typeof item !== "object") continue;
      const found = [];
      collectLinearGradientsMissingAngle(item, [], found);
      for (const g of found) out.push({ id, slideIndex, relPath: g.relPath, angle: linearEndpointsToAngle(g.from, g.to) });
    }
  });
  return out;
}

/**
 * Pure function. Document with an `angle` (degrees) added beside every legacy
 * linear gradient's from/to (linearGradientAngleMigrations). from/to are kept —
 * the render is byte-identical; the `angle` becomes the authoritative direction
 * the AngleField dial edits going forward. REPORTING IS THE CALLER'S JOB.
 * Idempotent (a gradient that already has `angle` is skipped).
 *
 * @example withLinearGradientAngleMigrated({slides: [{delta: {items: {a: {type: "rect", fill: {type: "linearGradient", linear: {stops: [{offset:0,color:"#000"},{offset:1,color:"#fff"}], from: {x:0,y:0}, to: {x:0,y:1}}}}}}}]}).doc.slides[0].delta.items.a.fill.linear.angle // 90
 * @example withLinearGradientAngleMigrated({slides: [{delta: {items: {a: {type: "rect", fill: {type: "linearGradient", linear: {stops: [{offset:0,color:"#000"},{offset:1,color:"#fff"}], from: {x:0,y:0}, to: {x:1,y:0}, angle: 0}}}}}}]}).migrated.length // 0 (already migrated)
 */
export function withLinearGradientAngleMigrated(doc) {
  const migrated = linearGradientAngleMigrations(doc);
  let out = doc;
  for (const { id, slideIndex, relPath, angle } of migrated)
    out = keyframed(out, slideIndex, ["items", id, ...relPath, "angle"], angle);
  return { doc: out, migrated };
}

/**
 * Pure function. Anti-aliasing BOOLEAN → SELECT migrations the document needs.
 * THE camera's `antialias` used to be a boolean (true = smooth, false = crisp
 * edges); it is now a quality/algorithm SELECT (core/properties.ANTIALIAS_MODES:
 * "off" | "standard"). Every slide-delta item that stores `antialias` as a
 * BOOLEAN is a candidate: true → "standard" (today's coverage-AA look), false →
 * "off" (crisp). Only the camera carries this property, so keying on the boolean
 * TYPE is exact and also catches an `antialias` keyframed on a non-creation slide
 * (no `type` there). A value already a string (migrated / fresh) is skipped.
 *
 * Args:
 *   doc (object): document
 *
 * Returns:
 *   {id, slideIndex, from, to}[] (empty when nothing needs migrating)
 *
 * @example antialiasSelectMigrations({slides: [{delta: {items: {c: {type: "camera", antialias: true}}}}]}) // [{id: "c", slideIndex: 0, from: true, to: "standard"}]
 * @example antialiasSelectMigrations({slides: [{delta: {items: {c: {type: "camera", antialias: false}}}}]}) // [{id: "c", slideIndex: 0, from: false, to: "off"}]
 * @example antialiasSelectMigrations({slides: [{delta: {items: {c: {type: "camera", antialias: "off"}}}}]}) // [] (already a select value)
 */
export function antialiasSelectMigrations(doc) {
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.antialias === "boolean") out.push({ id, slideIndex, from: item.antialias, to: item.antialias ? "standard" : "off" });
    }
  });
  return out;
}

/**
 * Pure function. Document with every legacy boolean `antialias` rewritten to its
 * SELECT id (antialiasSelectMigrations): true → "standard", false → "off". This
 * preserves each document's intent exactly — a doc that had AA off stays off,
 * one that had it on becomes today's "standard". REPORTING IS THE CALLER'S JOB.
 * Idempotent (a string value is left untouched).
 *
 * @example withAntialiasSelectMigrated({slides: [{delta: {items: {c: {type: "camera", antialias: false}}}}]}).doc.slides[0].delta.items.c.antialias // "off"
 * @example withAntialiasSelectMigrated({slides: [{delta: {items: {c: {type: "camera", antialias: "standard"}}}}]}).migrated.length // 0
 */
export function withAntialiasSelectMigrated(doc) {
  const migrated = antialiasSelectMigrations(doc);
  let out = doc;
  for (const { id, slideIndex, to } of migrated)
    out = keyframed(out, slideIndex, ["items", id, "antialias"], to);
  return { doc: out, migrated };
}

/** The filmstrip state keys that existed ONLY to serve the removed server frame-
 *  extraction endpoint: the fetched still URLs, and the per-frame extraction
 *  resolution that keyed its cache. Nothing reads them now. */
const DEAD_FILMSTRIP_KEYS = ["frameUrls", "frameH", "frameW"];

/**
 * Pure function. The filmstrip FRAMES migrations a document needs. `frames` used to
 * be a COUNT (a number) that a server endpoint turned into N extracted stills; it is
 * now the frames THEMSELVES — a LIST whose one field per element is a TIME in the clip
 * (core/properties.js PROPS.frames, core/lists.js). A numeric `frames` is therefore a
 * legacy value that must become a list of that same LENGTH, so a migrated strip keeps
 * showing the number of frames its author chose.
 *
 * `buildList(n)` is injected rather than imported so this stays in core/ without
 * reaching into a plugin (the default-equation text is the FILMSTRIP's declaration —
 * plugins/filmstrip.defaultFrameList — and repairedDocument passes it through the
 * registry). A filmstrip with no such plugin registered yields no migration rather
 * than an invented list.
 *
 * Also reports the DEAD server-era keys (frameUrls / frameH / frameW) present on the
 * item, so their removal is LOUD rather than a silently ignored leftover.
 *
 * Args:
 *   doc (object): document
 *   buildList (fn): (n) → the n-element default frame list
 *
 * Returns:
 *   {id, slideIndex, count, list, dead}[] (empty when nothing needs migrating)
 *
 * @example filmstripFramesMigrations({slides: [{delta: {items: {f: {type: "filmstrip", frames: 3}}}}]}, (n) => [[n]]) // [{id: "f", slideIndex: 0, count: 3, list: [[3]], dead: []}]
 * @example filmstripFramesMigrations({slides: [{delta: {items: {f: {type: "filmstrip", frames: [[0]]}}}}]}, (n) => [[n]]) // [] (already a list)
 * @example filmstripFramesMigrations({slides: [{delta: {items: {f: {type: "filmstrip", frames: 2, frameUrls: ["a"]}}}}]}, (n) => [[n]])[0].dead // ["frameUrls"]
 */
export function filmstripFramesMigrations(doc, buildList) {
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!item || typeof item !== "object") continue;
      const dead = DEAD_FILMSTRIP_KEYS.filter((k) => k in item);
      if (typeof item.frames !== "number") {
        // A slide that only carries dead keys still deserves the report.
        if (dead.length) out.push({ id, slideIndex, count: null, list: null, dead });
        continue;
      }
      const count = Math.max(1, Math.round(item.frames));
      out.push({ id, slideIndex, count, list: buildList(count), dead });
    }
  });
  return out;
}

/**
 * Pure function. Document with every legacy NUMERIC filmstrip `frames` rewritten to
 * the equivalent-length frame LIST (filmstripFramesMigrations), and the dead
 * server-era keys (frameUrls / frameH / frameW) DELETED from each slide delta.
 * REPORTING IS THE CALLER'S JOB. Idempotent (a list value is left untouched).
 *
 * The dead keys are removed rather than left in place because they are not merely
 * unread: `frameUrls` was the widget's old "do I have frames" signal, so a stale copy
 * riding along in a saved document is a trap for anyone reading it later.
 *
 * @example withFilmstripFramesMigrated({slides: [{delta: {items: {f: {type: "filmstrip", frames: 2}}}}]}, (n) => [[n]]).doc.slides[0].delta.items.f.frames // [[2]]
 * @example withFilmstripFramesMigrated({slides: [{delta: {items: {f: {type: "filmstrip", frames: 2, frameW: 320}}}}]}, (n) => [[n]]).doc.slides[0].delta.items.f.frameW // undefined
 * @example withFilmstripFramesMigrated({slides: [{delta: {items: {f: {type: "filmstrip", frames: [[0]]}}}}]}, (n) => [[n]]).migrated.length // 0
 */
export function withFilmstripFramesMigrated(doc, buildList) {
  const migrated = filmstripFramesMigrations(doc, buildList);
  if (migrated.length === 0) return { doc, migrated };
  let out = doc;
  for (const { id, slideIndex, list } of migrated)
    if (list) out = keyframed(out, slideIndex, ["items", id, "frames"], list);
  // The dead keys are DELETED, which keyframed() cannot express (it writes values),
  // so this rebuilds the affected slide deltas without them.
  const byId = new Map(migrated.filter((m) => m.dead.length).map((m) => [`${m.slideIndex}|${m.id}`, m.dead]));
  if (byId.size === 0) return { doc: out, migrated };
  out = {
    ...out,
    slides: out.slides.map((s, slideIndex) => {
      const items = s.delta?.items;
      if (!items) return s;
      let touched = false;
      const next = {};
      for (const [id, item] of Object.entries(items)) {
        const dead = byId.get(`${slideIndex}|${id}`);
        if (!dead) { next[id] = item; continue; }
        touched = true;
        next[id] = Object.fromEntries(Object.entries(item).filter(([k]) => !dead.includes(k)));
      }
      return touched ? { ...s, delta: { ...s.delta, items: next } } : s;
    }),
  };
  return { doc: out, migrated };
}

// ── The load-boundary repair pipeline (ONE home) ─────────────────────────────
// Both consumers of load-time repair — the editor (app.repaired via loadFile /
// loadAutosave / loadProject / deleteSlide) and the CLI render hook
// (web/main.js) — went through hand-copied chains that DRIFTED (the editor
// stripped legacy meta.fps, the CLI did not — cruft audit 2a). This is the
// single orchestrator; both callers consume {doc, reports} and print with
// printRepairReports so the console.error FORMAT strings live in exactly one
// place. Every step is a pure repair function already covered by repair_test.js;
// this composes them in the ORDER-CRITICAL sequence and collects the report.

/**
 * Pure function. The full load-boundary repair of `doc` against the plugin
 * `registry`, plus the human-readable report of everything it changed
 * (REPORTING IS THE CALLER'S JOB — this never touches console; printRepairReports
 * does). Returns {doc, reports: string[]}. Idempotent: a current document comes
 * back unchanged with reports = [].
 *
 * ORDER (every step is order-critical — do not reshuffle):
 *   1. orphaned items dropped   — a typeless/unknown item must go before any
 *      later step reads its (missing) type; keeps the fold renderable.
 *   2. legacy key renames       — MUST precede defaults-fill: filling first
 *      writes the new key's default at the creation slide and the rename then
 *      drops the user's legacy value as stale (data loss — repair_test.js
 *      "legacy rename ORDER").
 *  2b. fancy-arrow fill migrated — MUST run AFTER legacy key renames (a
 *      `color`-keyed ancient doc needs to have already converged on `stroke`)
 *      and BEFORE defaults-fill (same hazard class as rich text below: fill
 *      first and the old `stroke`-as-fill value would already be gone,
 *      replaced by the fill default, before this step could read it).
 *  2c. antialias boolean→select — the camera's `antialias` boolean became a
 *      quality SELECT (true→"standard", false→"off"). A VALUE migration; the key
 *      is present either way so its order vs defaults-fill is not load-bearing.
 *   3. meta.fps stripped        — frame caps are dead (round 11); meta-only, so
 *      its position among the item/slide steps is free — placed here to match
 *      the editor's long-tested sequence.
 *   4. missing defaults filled  — typed-but-partial items get plugin defaults so
 *      the strict IR builders never see w: undefined.
 *  4b. dormant shadows off      — AFTER defaults-fill: a stored old-default
 *      shadow (opacity 0.5, blur 0) was invisible under the old gate but the
 *      14.8 opacity-only gate would resurrect it; neutralize to opacity 0
 *      (only shadows that were already invisible — visible shadows untouched).
 *   5. duration → transition    — legacy per-slide `duration` becomes
 *      transition.seconds (round 12).
 *   6. camera ensured + deduped — a doc predating the camera (or one whose
 *      camera was orphaned away in step 1) gets THE camera injected; then any
 *      EXTRA cameras (hand-authored/damaged docs) are loud-dropped so exactly
 *      one survives (the camera invariant is exactly one — THE CAMERA).
 *  6b. gradient direction → angle — legacy linear gradients (4-preset from/to)
 *      get an `angle` (degrees) added beside their from/to; from/to untouched
 *      (byte-identical render). AFTER camera dedup so a camera-background
 *      gradient on the surviving camera is migrated too.
 *   7. bindings migrated        — legacy {item, anchor} arrow bindings become
 *      equation pairs (THE UNIFICATION); runs LAST, on the now-clean doc.
 *
 * @example // repairedDocument(newDocument(), registry) → {doc: <equivalent>, reports: []}
 * @example // a doc with meta.fps → reports includes "PowerRP repair: removed legacy meta.fps — presentations are always uncapped"
 */
export function repairedDocument(doc, registry) {
  const reports = [];
  const known = new Set(registry.all().map((p) => p.type));

  const { doc: droppedDoc, dropped } = withOrphanedItemsDropped(doc, known);
  for (const { id, reason } of dropped)
    reports.push(`PowerRP repair: dropped item "${id}" — ${reason}`);

  const { doc: renamedDoc, renamed } = withLegacyKeysRenamed(droppedDoc, registry);
  for (const r of renamed)
    reports.push(`PowerRP repair: item "${r.id}" slide ${r.slideIndex}: legacy "${r.from}" → "${r.to}"${r.stale ? " (stale copy dropped)" : ""}`);

  // Fancy-arrow fill migration (Round 17.4): `stroke` was misused as the fill
  // color — move its value to the new `fill` property so old arrows keep
  // their EXACT appearance; the new `stroke` falls back to the plugin's
  // outline-color default with strokeWidth 0 (no outline) via the fill step
  // below, so an un-migrated doc renders byte-identical.
  const { doc: fillMigratedDoc, migrated: fancyArrowFilled } = withFancyArrowFillMigrated(renamedDoc, registry);
  for (const m of fancyArrowFilled)
    reports.push(`PowerRP repair: item "${m.id}" slide ${m.slideIndex}: legacy fancy-arrow "stroke" (fill color) → "fill"; "stroke" now means outline`);

  // Anti-aliasing BOOLEAN → SELECT: the camera's `antialias` used to be a boolean
  // (true = smooth, false = crisp) and is now a quality SELECT (ANTIALIAS_MODES).
  // true → "standard", false → "off", preserving each document's exact intent.
  // A VALUE migration (like fancy-arrow fill above), so it runs here with the
  // other value migrations — the key is present either way, so its order vs the
  // defaults-fill below is not load-bearing; grouped with its peers for clarity.
  const { doc: aaMigratedDoc, migrated: antialiasMigrated } = withAntialiasSelectMigrated(fillMigratedDoc);
  for (const m of antialiasMigrated)
    reports.push(`PowerRP repair: item "${m.id}" slide ${m.slideIndex}: legacy boolean antialias (${m.from}) → "${m.to}"`);

  // Filmstrip `frames` COUNT → the frame LIST (same length), and the dead server-era
  // keys dropped. A VALUE migration, so it sits with its peers above — but it MUST
  // precede the defaults-fill below for the rich-text hazard's exact reason: filling
  // first would write the LIST default over the user's numeric count before this step
  // could read it, silently resetting every migrated strip to the default frame count.
  // The default-equation text belongs to the FILMSTRIP's own declaration, so it comes
  // from the plugin through the registry rather than being restated in core/.
  // registry.get() THROWS on an unknown type (a loud guard for a real lookup), and a
  // registry without the filmstrip is legitimate here — a focused test registers three
  // plugins, and a document with no filmstrip needs no builder — so this asks the
  // roster instead of catching.
  const framesListOf = registry.all().find((p) => p.type === "filmstrip")?.defaultFrameList ?? null;
  const { doc: framesDoc, migrated: framesMigrated } = framesListOf
    ? withFilmstripFramesMigrated(aaMigratedDoc, framesListOf)
    : { doc: aaMigratedDoc, migrated: [] };
  for (const m of framesMigrated) {
    if (m.count !== null)
      reports.push(`PowerRP repair: item "${m.id}" slide ${m.slideIndex}: legacy filmstrip frame COUNT (${m.count}) → a ${m.count}-element frame list, each frame's time an equation across Video start → Video end`);
    if (m.dead.length)
      reports.push(`PowerRP repair: item "${m.id}" slide ${m.slideIndex}: dropped dead filmstrip key(s) ${m.dead.join(", ")} — frames are decoded in the browser now, not fetched from the server frames endpoint`);
  }

  let out = framesDoc;
  if ("fps" in out.meta) {
    const meta = { ...out.meta };
    delete meta.fps;
    out = { ...out, meta };
    reports.push("PowerRP repair: removed legacy meta.fps — presentations are always uncapped");
  }

  // Rich text BEFORE defaults-fill (order-critical, Opus21's proven hazard:
  // filling first clobbers an old string-`text` to the rich DEFAULT "Text" —
  // the string must become runs while it is still the user's string).
  const { doc: richDoc, migrated: richMigrated } = withRichTextMigrated(out, (t) => registry.get(t)?.richText === true || t === "text");
  for (const m of richMigrated)
    reports.push(`PowerRP repair: item "${m.id}" slide ${m.slideIndex}: legacy string text → rich runs`);

  const { doc: filledDoc, filled } = withMissingDefaultsFilled(richDoc, registry);
  for (const { id, missing } of filled)
    reports.push(`PowerRP repair: item "${id}" was missing ${missing.map((m) => m.path.join(".")).join(", ")} — filled with plugin defaults`);

  // Dormant shadows AFTER defaults-fill (order-critical): a doc missing shadow
  // entirely gets the NEW effect-off defaults (opacity 0) from the fill above,
  // which are not dormant — so this step only neutralizes shadows that were
  // STORED with the old defaults (opacity 0.5, blur 0), invisible under the old
  // gate but resurrected by the 14.8 opacity-only gate (see dormantShadows).
  const { doc: deshadowedDoc, neutralized } = withDormantShadowsNeutralized(filledDoc);
  for (const { id, slideIndex, opacity } of neutralized)
    reports.push(`PowerRP repair: item "${id}" slide ${slideIndex}: a stored blur-0 shadow (opacity ${opacity}) was invisible under the old gate — set opacity 0 so the 14.8 gate change does not resurrect it`);

  const { doc: migratedDoc, migrated } = withDurationMigrated(deshadowedDoc);
  for (const m of migrated)
    reports.push(`PowerRP repair: slide ${m.index} legacy "duration" (${m.seconds}s) → transition.seconds${m.stale ? " (already had a transition — stale duration dropped)" : ""}`);

  // Camera invariant (THE CAMERA): ensure at least one, then drop any extras
  // loudly so exactly one survives (withCameraEnsured only ever ADDS — it never
  // dedupes a doc that already has several cameras).
  const { doc: cameraDeduped, dropped: extraCameras } = withExtraCamerasDropped(withCameraEnsured(migratedDoc));
  for (const id of extraCameras)
    reports.push(`PowerRP repair: dropped extra camera "${id}" — a document has exactly one camera (THE CAMERA); kept the first by id`);

  // Linear-gradient direction (4 presets) → an `angle` (degrees). from/to are
  // kept, so the render is byte-identical; the angle becomes the value the new
  // rotary dial edits (core/properties.js angle math; web/AngleField.svelte).
  const { doc: gradientDoc, migrated: gradientAngles } = withLinearGradientAngleMigrated(cameraDeduped);
  for (const { id, slideIndex, relPath, angle } of gradientAngles)
    reports.push(`PowerRP repair: item "${id}" slide ${slideIndex}: legacy linear-gradient direction (${relPath.join(".")}) → angle ${angle}°`);

  return { doc: withBindingsMigrated(gradientDoc), reports };
}

/**
 * Command (console side effect). console.errors each repair report line. The
 * ONE printer both repair consumers call — silent repairs are forbidden, and
 * the format strings live in repairedDocument, so this stays trivial.
 *
 * @example // printRepairReports(["PowerRP repair: dropped item \"a\" — …"]) → console.errors the one line
 */
export function printRepairReports(reports) {
  for (const line of reports) console.error(line);
}

// ── Slide edits ──────────────────────────────────────────────────────────────

/** Pure function. Inserts an empty slide after `index`. Returns [doc, newIndex].
 * The new slide gets the default tween transition (seconds = the old default
 * duration, curve "smooth") — new decks feel identical to the pre-transitions
 * era (lead ruling, Round 12). */
export function withNewSlide(doc, index) {
  const slide = { id: uuid(), name: `Slide ${doc.slides.length + 1}`, transition: defaultTransition("tween"), delta: {} };
  const slides = [...doc.slides];
  slides.splice(index + 1, 0, slide);
  return [{ ...doc, slides }, index + 1];
}

/** Pure function. Removes slide `index` (refuses to remove the last slide). */
export function withSlideDeleted(doc, index) {
  if (doc.slides.length <= 1) throw new Error("Cannot delete the only slide");
  const slides = doc.slides.filter((_, i) => i !== index);
  return { ...doc, slides };
}

/** Pure function. Toggles a slide's enabled flag (default true → false). */
export function withSlideToggled(doc, index) {
  const slides = doc.slides.map((s, i) =>
    i === index ? { ...s, enabled: s.enabled === false } : s);
  return { ...doc, slides };
}

/** Pure function. Moves slide `index` by `offset` (clamped). */
export function withSlideMoved(doc, index, offset) {
  const to = Math.max(0, Math.min(doc.slides.length - 1, index + offset));
  if (to === index) return doc;
  const slides = [...doc.slides];
  const [s] = slides.splice(index, 1);
  slides.splice(to, 0, s);
  return { ...doc, slides };
}

/**
 * Pure function. Ensures the document has THE camera (docs saved before the
 * camera existed lack one — loading such a doc injects the default camera
 * into slide 0's delta, sized to the meta slide rect).
 *
 * @example // withCameraEnsured(preCameraDoc).slides[0].delta.items now has a camera
 */
export function withCameraEnsured(doc) {
  for (const s of doc.slides)
    for (const item of Object.values(s.delta.items ?? {}))
      if (item && item.type === "camera") return doc;
  const cameraId = uuid();
  return keyframed(doc, 0, ["items", cameraId], defaultCameraState(doc.meta));
}

/**
 * Pure function. Enforces the AT-MOST-ONE half of the camera invariant (THE
 * CAMERA — manifest: "exactly one, purgeable:false"). withCameraEnsured
 * guarantees at least one camera; this keeps the FIRST camera item (by id,
 * matching cameraRect's deterministic pick) and purges every other camera from
 * every slide, returning the deduped doc + the ids it dropped. REPORTING IS
 * THE CALLER'S JOB — the repair never hides anything (mirrors
 * withOrphanedItemsDropped). Idempotent; a normal single-camera doc comes back
 * byte-identical with dropped = [].
 *
 * An id counts as a camera if ANY slide delta sets its type to "camera" (the
 * creation keyframe on slide 0 for a well-formed doc; a hand-authored or
 * damaged doc may carry several).
 *
 * @example withExtraCamerasDropped({slides: [{delta: {items: {a: {type: "camera"}, b: {type: "camera"}}}}]}).dropped // ["b"]
 * @example // withExtraCamerasDropped(singleCameraDoc) → {doc: <unchanged>, dropped: []}
 */
export function withExtraCamerasDropped(doc) {
  const cameraIds = new Set();
  for (const s of doc.slides)
    for (const [id, item] of Object.entries(s.delta.items ?? {}))
      if (item && item.type === "camera") cameraIds.add(id);
  const dropped = [...cameraIds].sort((a, b) => (a < b ? -1 : 1)).slice(1);
  let out = doc;
  for (const id of dropped) out = withItemPurged(out, id);
  return { doc: out, dropped };
}

// ── Z-order maintenance ──────────────────────────────────────────────────────
// UI reorder ops set z to the midpoint between neighbors (bisect), then this
// renormalizes every KEYFRAMED z document-wide to 1, 2, 3... (order-preserving
// over the set of distinct stored values) so bisection never runs out of
// precision. A tweened in-between z is DERIVED, never written to the document,
// so it is never normalized (this is the "not persisted" sense of transient —
// nothing to do with the three kinds of state in CLAUDE.md).

/** Pure function. Document with all stored z keyframes renormalized to 1..N. */
export function withNormalizedZ(doc) {
  const zs = new Set();
  for (const s of doc.slides)
    for (const [path, value] of leaves(s.delta))
      if (path[path.length - 1] === "z" && typeof value === "number") zs.add(value);
  const sorted = [...zs].sort((a, b) => a - b);
  const map = new Map(sorted.map((z, i) => [z, i + 1]));
  const slides = doc.slides.map((s) => {
    let delta = s.delta;
    for (const [path, value] of leaves(s.delta))
      if (path[path.length - 1] === "z" && map.has(value)) delta = setPath(delta, path, map.get(value));
    return { ...s, delta };
  });
  return { ...doc, slides };
}

/**
 * Pure function. New z for an item moved one step forward/backward among the
 * given z-ascending [itemId, z] pairs — midpoint with the far neighbor
 * (bisect), or ±1 past the end.
 *
 * @example bisectedZ([["a",1],["b",2],["c",3]], "a", +1) // 2.5 (between b and c)
 * @example bisectedZ([["a",1],["b",2]], "b", +1) // 3 (already frontmost: past end)
 * @example bisectedZ([["a",1],["b",2],["c",3]], "c", -1) // 1.5
 */
export function bisectedZ(pairs, itemId, direction) {
  const i = pairs.findIndex(([id]) => id === itemId);
  if (i === -1) throw new Error(`bisectedZ: unknown item ${itemId}`);
  const j = i + direction;
  if (j < 0) return pairs[0][1] - 1;
  if (j >= pairs.length) return pairs[pairs.length - 1][1] + 1;
  const k = j + direction;
  if (k < 0) return pairs[0][1] - 1;
  if (k >= pairs.length) return pairs[pairs.length - 1][1] + 1;
  return (pairs[j][1] + pairs[k][1]) / 2;
}

/**
 * Pure function. New z values for a BLOCK of items moved together to the front
 * (direction +1) or back (−1) of everything else, PRESERVING the block's
 * internal relative order (manifest 15.7: "when i move a group to front or back
 * it should move all elements in it to front or back too" — a group and its
 * members travel as ONE block; members keep their relative z within it, the
 * block lands above/below every non-block item).
 *
 * The block members are ordered by their CURRENT z (ascending) so their
 * relative stacking survives the move; they are then assigned consecutive z
 * values placed entirely beyond the extreme of the NON-block items (max+1,
 * max+2, … for front; min−1, min−2, … in reverse for back, so the block's
 * TOP stays on top). withNormalizedZ re-packs the whole document to integers
 * afterward, so the fractional/large intermediate spacing is safe. Returns
 * [[itemId, newZ]] only for the block ids (unknown block ids are skipped, not
 * an error — a member absent on this slide simply isn't reassigned). An empty
 * scene (no non-block items) still returns a valid ascending block.
 *
 * @example blockZToExtreme([["g",3],["a",1],["b",2],["x",5]], ["g","a","b"], +1) // [["a",6],["b",7],["g",8]] (block ordered by z, all above x's 5)
 * @example blockZToExtreme([["g",3],["a",1],["b",2],["x",5]], ["g","a","b"], -1) // [["a",2],["b",3],["g",4]] (block all below x's 5, relative order a<b<g kept)
 */
export function blockZToExtreme(pairs, blockIds, direction) {
  const inBlock = new Set(blockIds);
  const blockPairs = pairs.filter(([id]) => inBlock.has(id));
  const otherZs = pairs.filter(([id]) => !inBlock.has(id)).map(([, z]) => z);
  // Order the block by current z so its internal stacking is preserved.
  const ordered = [...blockPairs].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  if (direction > 0) {
    const base = otherZs.length ? Math.max(...otherZs) : 0;
    // Ascending: the block's own bottom→top lands just above everything else.
    return ordered.map((id, i) => [id, base + 1 + i]);
  }
  const base = otherZs.length ? Math.min(...otherZs) : 0;
  // Descending: the block's top→bottom lands just below everything else, so the
  // block's own top item stays nearest the rest (its internal order preserved).
  return ordered.map((id, i) => [id, base - 1 - (ordered.length - 1 - i)]);
}

// ── (De)serialization ────────────────────────────────────────────────────────

/** Pure function. Document → pretty JSON (the .powerrp.json save format). */
export function serialize(doc) {
  return JSON.stringify(doc, null, 2);
}

/** Pure function. JSON → document; validates the basic shape loudly. */
export function deserialize(json) {
  const doc = JSON.parse(json);
  if (!doc.meta || !Array.isArray(doc.slides) || doc.slides.length === 0)
    throw new Error("Invalid PowerRP document: expected {meta, slides[≥1]}");
  for (const s of doc.slides)
    if (typeof s.id !== "string" || typeof s.delta !== "object")
      throw new Error(`Invalid slide: ${JSON.stringify(s).slice(0, 80)}`);
  return doc;
}

/**
 * Pure function. All keyframe leaf entries across slides, chronological —
 * the keyframe panel's data: [{slideIndex, slideId, path, value}].
 */
export function allKeyframes(doc) {
  return doc.slides.flatMap((s, slideIndex) =>
    leaves(s.delta).map(([path, value]) => ({ slideIndex, slideId: s.id, path, value })));
}

/**
 * Pure function. Every item the DOCUMENT ever keys (union across all slide
 * deltas, enabled or disabled), in first-appearance (creation) order. `type`
 * and `name` are the FIRST values any slide writes for them — creation-slide
 * semantics (names are written on the creation slide; the load-time orphan
 * repair guarantees every id has a type). Powers the item picker's "ALL
 * objects on ALL slides" listing: items with no state on the current slide
 * (not yet created / active:false) still need an identity to list.
 *
 * Args:
 *   doc (object): document
 *
 * Returns:
 *   {id, type, name}[] (name undefined when the item was never named)
 *
 * @example allDocumentItems({slides: [{delta: {items: {a: {type: "rect", name: "Box"}}}}, {delta: {items: {b: {type: "circle"}, a: {x: 5}}}}]}) // [{id: "a", type: "rect", name: "Box"}, {id: "b", type: "circle", name: undefined}]
 * @example allDocumentItems({slides: [{delta: {}}]}) // []
 */
export function allDocumentItems(doc) {
  const out = new Map(); // id → {id, type, name}; first write of each field wins
  for (const s of doc.slides)
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!(item && typeof item === "object")) continue;
      const cur = out.get(id) ?? { id, type: undefined, name: undefined };
      if (cur.type === undefined && typeof item.type === "string") cur.type = item.type;
      if (cur.name === undefined && typeof item.name === "string") cur.name = item.name;
      out.set(id, cur);
    }
  return [...out.values()];
}
