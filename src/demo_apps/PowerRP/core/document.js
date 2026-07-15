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

import { blendApplied, copied, getPath, setPath, deletePath, leaves } from "./deltas.js";
import { defaultTransition, withDurationMigrated } from "./transitions.js";
import { withBindingsMigrated } from "./expressions.js";
import { withRichTextMigrated } from "./richtext.js";

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
 * @example defaultCameraState() // {type: "camera", name: "Camera", x: 0, y: 0, w: 1280, h: 720, z: 1000, rotation: 0, scale: 1, active: true, background: "#ffffff"}
 * @example defaultCameraState({slideW: 800, slideH: 600}).w // 800
 */
export function defaultCameraState(meta = {}) {
  return {
    type: "camera", name: "Camera",
    x: 0, y: 0, w: meta.slideW ?? DEFAULT_SLIDE_W, h: meta.slideH ?? DEFAULT_SLIDE_H,
    z: 1000, rotation: 0, scale: 1, active: true, background: "#ffffff",
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
      if (path[0] !== "type" && !set.has(path.join("."))) missing.push({ path, value });
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
 *   3. meta.fps stripped        — frame caps are dead (round 11); meta-only, so
 *      its position among the item/slide steps is free — placed here to match
 *      the editor's long-tested sequence.
 *   4. missing defaults filled  — typed-but-partial items get plugin defaults so
 *      the strict IR builders never see w: undefined.
 *   5. duration → transition    — legacy per-slide `duration` becomes
 *      transition.seconds (round 12).
 *   6. camera ensured           — a doc predating the camera (or one whose camera
 *      was orphaned away in step 1) gets THE camera injected.
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

  let out = renamedDoc;
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

  const { doc: migratedDoc, migrated } = withDurationMigrated(filledDoc);
  for (const m of migrated)
    reports.push(`PowerRP repair: slide ${m.index} legacy "duration" (${m.seconds}s) → transition.seconds${m.stale ? " (already had a transition — stale duration dropped)" : ""}`);

  return { doc: withBindingsMigrated(withCameraEnsured(migratedDoc)), reports };
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

// ── Z-order maintenance ──────────────────────────────────────────────────────
// UI reorder ops set z to the midpoint between neighbors (bisect), then this
// renormalizes every KEYFRAMED z document-wide to 1, 2, 3... (order-preserving
// over the set of distinct stored values) so bisection never runs out of
// precision. Tweened in-between z values are ephemeral and never normalized.

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
