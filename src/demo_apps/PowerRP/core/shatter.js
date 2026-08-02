/**
 * SHATTER — turning ONE widget into a GROUP of the editable widgets it was
 * drawing all along.
 *
 * THE USER'S REQUEST (2026-08-01, about the mermaid diagram): "turn that one
 * solid diagram into an equivalent set of widgets. It would turn the current
 * widget into a GROUP (change the type), then add a bunch of other widgets whose
 * names indicate they are children of that group. Then I could edit that diagram
 * by hand: all the arrows and stuff would be properly anchored, the text would be
 * properly anchored to the boxes that contain them."
 *
 * ── IT IS A CAPABILITY, NOT A MERMAID FEATURE (user, same day) ───────────────
 * "Shatter should probably exist for other widgets too, like graph bars. What
 * other widgets can we shatter? Can we shatter an SVG reliably? … That way,
 * Shatter as a tool becomes more useful and worth memorizing." That last clause
 * is the design argument: a tool that works on one widget is not worth learning.
 *
 * So a plugin DECLARES `shatter(state, ctx)` and supplies only its own
 * decomposition; the command, the gate, the naming, the id plumbing and the undo
 * semantics are written ONCE, here. Nothing in this file names a widget type —
 * core/registry.js's docblock bans dispatching on `type`, and a capability is how
 * this codebase already says "this widget can do X" (`capabilities.bbox`,
 * `foldsSubtree`, `codeEditor`, `naturalSize`). Mermaid is the FIRST CONSUMER.
 *
 * ── THE TWO NUMBERS, AND WHY FIDELITY ALONE WOULD BE THE WRONG ONE ──────────
 * An IMAGE widget is always available as a floor, so any shatter can reach ~100%
 * visual fidelity by dumping a region to a raster. That makes fidelity nearly
 * free and therefore nearly uninformative: a shatter that emits one big image is
 * perfectly faithful and completely useless. The real tradeoff is fidelity
 * versus EDITABILITY.
 *
 * So a plan reports BOTH:
 *   - visual fidelity — measured by the gate, from pixels, not from here.
 *   - VECTOR RECOVERY — `vectorRecovery` below: the fraction of parts that came
 *     back as editable native widgets rather than raster. This is the number
 *     that says whether shatter did its job, and gating it stops a future change
 *     from quietly widening the raster fallback and looking like an improvement.
 *
 * ── WHAT SURVIVES, AND WHY NOTHING HAD TO BE INVENTED FOR IT ────────────────
 * The host item BECOMES the group: same itemId, so every equation elsewhere in
 * the document that referenced it still resolves, and its name, z and other-slide
 * keyframes are untouched. That is core/retype.js's whole contract, so this reuses
 * `retypedItem` rather than hand-writing a type keyframe:
 *   RULE 1 fills the group's own keys (members/bind/effects/crop) like an insert.
 *   RULE 3 leaves keys only the OLD type declared DORMANT and untouched — which
 *          is how THE SOURCE SURVIVES. A shattered mermaid's `definition` is
 *          still sitting on the group, unread by the group plugin, exactly as
 *          R6-6.7 requires ("leaving them makes the retype REVERSIBLE").
 * Note `retypeEligible` refuses `group` as a menu target because "retyping
 * something INTO one would invent a parent with no membership". That reason does
 * not apply here and is the one thing shatter adds: it supplies the membership in
 * the same write. The menu stays closed; this door is a different door.
 *
 * ── CROSS-REFERENCES BETWEEN PARTS ──────────────────────────────────────────
 * A part's whole value is that it is ANCHORED to its siblings — a label bound to
 * the box that contains it, an arrow bound to the two boxes it joins. But the
 * siblings have no itemIds until they are written. So a plugin refers to a
 * sibling by its own PART KEY, and this module resolves those keys to minted ids
 * through `core/document.js clonedItemStates` — the existing subgraph-clone
 * rewriter that already remaps both `@id` equation references AND `plugin.itemRefs`
 * id-valued slots. A second rewriter here would be a second dialect for a
 * problem that is already solved.
 */

import { pathsToSvgSrc, pathsBounds } from "./svg_paths.js"; // the SVG family's shatter measures and re-emits path pieces
import { uuid, keyframed, clonedItemStates } from "./document.js";
import { retypedItem } from "./retype.js";

/**
 * The widget type a shatter turns its host into. Named rather than inlined
 * because three things here must agree about it: the retype target, the
 * membership write, and the eligibility rule that keeps a group from being
 * shattered again.
 */
export const SHATTER_HOST_TYPE = "group";

/**
 * The separator between a shattered child's parent name and its own — "Flowchart
 * / Start". Display-only: `core/expressions.js slugify` collapses every
 * non-alphanumeric run to one `_`, so this renders as the equation slug
 * `flowchart_start` whatever glyph is chosen. That is not a coincidence to shrug
 * at — `<parent>_<child>` is the app's ONE existing parentage form
 * (`core/expressions.js anchorRefName`, `"moon_tm"`), so the slug lands on
 * precedent for free and only the display glyph was open.
 */
export const SHATTER_NAME_SEPARATOR = " / ";

/**
 * Pure function. May this widget be shattered? A PREDICATE over what the plugin
 * DECLARES, never a hand list — the same discipline core/retype.js
 * `retypeEligible` uses, and for the same reason: a new widget joins by
 * declaring `shatter`, and a hand list would silently omit it.
 *
 * A group is refused even if it somehow declared one: it IS the output shape, so
 * shattering it would ask "into what?" — the same structural argument
 * `retypeEligible` makes about `foldsSubtree`.
 *
 * @param {object} plugin - a registered plugin
 * @returns {boolean}
 *
 * @example shatterEligible({type: "mermaid", shatter: () => ({parts: []})})
 * true
 * @example shatterEligible({type: "rect"})
 * false
 * @example shatterEligible({type: "group", shatter: () => ({parts: []}), foldsSubtree: () => true})
 * false
 */
export function shatterEligible(plugin) {
  if (!plugin || typeof plugin.shatter !== "function") return false;
  if (plugin.type === SHATTER_HOST_TYPE || plugin.foldsSubtree) return false;
  return true;
}

/**
 * A part KEY stands in for an itemId until one exists, so it must survive
 * everywhere an itemId does. That turns out to mean LETTERS AND DIGITS ONLY,
 * starting with a letter — and the excluded character is UNDERSCORE, which is
 * the surprising part and was found by measurement rather than by reading.
 *
 * TWO FAILURES EARNED THIS PATTERN, and the second is the interesting one.
 *
 * 1. A first draft used a node's label verbatim, so a mermaid box reading
 *    "Do it" produced `= @Do it_tl.x + 12`. The tokenizer read `@Do`. Obvious in
 *    hindsight; a key has to tokenize.
 * 2. Replacing the space with an underscore gave `@Do_it_tl.x` — which STILL
 *    resolved to `Do`. `core/document.js withItemRefsRemapped` splits an
 *    underscored reference at its FIRST underscore, while the documented
 *    ambiguity rule (core/expressions.js's header: "split on its LAST '_'") and
 *    `resolveRef` use the LAST. Measured, both directions:
 *      "= @Do_it_tl.x"  ->  unchanged, external ["Do"]
 *      "= @Skip_tl.y"   ->  "= @BBB_tl.y", external []
 *    That inconsistency cannot bite the app today — a real itemId is
 *    `crypto.randomUUID().slice(0, 8)`, hex and hyphens, never an underscore —
 *    so shatter's synthetic keys are the first thing to reach it. Avoiding the
 *    character is a one-line fix here; correcting the remapper is a change to a
 *    seam every paste and duplicate runs through, and is handed back rather than
 *    made in passing.
 */
const PART_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * Pure function. A human string reduced to a legal part key: the alphanumeric
 * runs, each capitalised so the words stay legible with no separator between
 * them. Capitalising is what makes "Do it" readable as `DoIt` rather than
 * `doit`, which matters because the key is also a child's fallback display name
 * and the token an author will see inside an equation.
 *
 * @param {string} text - any human label
 * @returns {string} matching PART_KEY_PATTERN
 *
 * @example partKey("Do it")
 * 'DoIt'
 * @example partKey("Start")
 * 'Start'
 * @example partKey("Is it valid?")
 * 'IsItValid'
 * @example partKey("2nd stage")
 * 'P2ndStage'
 * @example partKey("")
 * 'part'
 */
export function partKey(text) {
  const runs = String(text ?? "").match(/[A-Za-z0-9]+/g);
  if (!runs) return "part";
  const joined = runs.map((r) => r[0].toUpperCase() + r.slice(1)).join("");
  // A key must START with a letter (a leading digit is not an identifier). "P"
  // for "part", the same word the empty case falls back to.
  return PART_KEY_PATTERN.test(joined) ? joined : `P${joined}`;
}

/**
/**
 * Pure function. Is this widget READY to be shattered right now, or the sentence
 * saying why not? A plugin MAY declare `shatterNotReady(state)` returning a
 * reason string; absent, a shatterable widget is always ready.
 *
 * WHY THIS EXISTS AS A SEPARATE, CHEAP HOOK rather than the command simply asking
 * the plugin to plan: a command's `when` is re-evaluated on every palette render
 * and availability pass, and planning a mermaid diagram regroups every path and
 * text in it. Measured — a plan-based gate ran a full decomposition many times a
 * second for a command nobody had invoked, and it slowed the app enough to break
 * a timing-sensitive probe. So readiness is a CHEAP question (mermaid's is one
 * Map lookup) and planning happens once, when the user actually runs it.
 *
 * The sentence comes from the WIDGET because only the widget knows it — "the
 * diagram has not finished rendering" is not something the command layer could
 * phrase, and a generic "not ready" would be the confident-wrong-answer shape
 * `commandUnavailableReason` exists to avoid.
 *
 * @param {object} plugin - a registered plugin
 * @param {object} state - the item's folded state
 * @returns {string|null} the reason it is not ready, or null when it is
 *
 * @example shatterNotReadyReason({shatter: () => ({parts: []})}, {})
 * null
 * @example shatterNotReadyReason({shatter: () => ({parts: []}), shatterNotReady: () => "a diagram that has finished rendering"}, {})
 * 'a diagram that has finished rendering'
 */
export function shatterNotReadyReason(plugin, state) {
  return plugin.shatterNotReady?.(state) ?? null;
}

/**
 * Pure function. The reference token a part uses to name a SIBLING part before
 * any itemId exists — the part key in the document's own stored `@id` form, so
 * it flows through the existing rewriter untouched.
 *
 * @param {string} key - the sibling's part key
 * @returns {string}
 *
 * @example partRef("nodeA")
 * '@nodeA'
 * @example `= ${partRef("nodeA")}_tl.x + 12`
 * '= @nodeA_tl.x + 12'
 */
export function partRef(key) {
  return `@${key}`;
}

/**
 * Pure function. VECTOR RECOVERY — the fraction of a plan's parts that came back
 * as editable native widgets rather than as raster fallbacks. 1 means everything
 * was recovered as vector; 0 means the shatter produced nothing but pictures.
 *
 * A COUNT, deliberately, not an ink-area share. Area would be the better physical
 * quantity and it is not measurable here: this module has no renderer, and a
 * plugin's own estimate of its ink area would be a second opinion nothing could
 * check. A count is a fact both the producer and the gate can agree on. An empty
 * plan is 1, not 0 — nothing failed to be recovered.
 *
 * @param {Array<{raster?: boolean}>} parts - the plan's parts
 * @returns {number} in [0, 1]
 *
 * @example vectorRecovery([{}, {}, {}])
 * 1
 * @example vectorRecovery([{}, {raster: true}, {}, {}])
 * 0.75
 * @example vectorRecovery([])
 * 1
 */
export function vectorRecovery(parts) {
  if (parts.length === 0) return 1;
  return parts.filter((p) => !p.raster).length / parts.length;
}

/**
 * Pure function. The English clause counting one kind of part — "3 Rectangles",
 * "1 Arrow". Pluralised by appending "s", which is correct for every widget
 * `title` in the roster and is checked by the gate rather than assumed; a title
 * that pluralises irregularly will fail there rather than read wrong here.
 *
 * @param {string} title - the widget's plugin title
 * @param {number} n - how many
 * @returns {string}
 *
 * @example countedTitle("Rectangle", 3)
 * '3 Rectangles'
 * @example countedTitle("Arrow", 1)
 * '1 Arrow'
 */
export function countedTitle(title, n) {
  return `${n} ${title}${n === 1 ? "" : "s"}`;
}

/**
 * Pure function. THE DISCLOSURE — one sentence naming exactly what a shatter
 * produced and what it could not recover as vector, so the user knows which
 * parts they can hand-edit before they try.
 *
 * A percentage would be worse than useless here: "94% faithful" tells an author
 * nothing they can act on, whereas "2 regions kept as images" tells them exactly
 * which two things will not respond to a handle. Counts are grouped by the
 * emitted widget's own `title`, DERIVED from the registry — no hand-maintained
 * map of type to human noun, which is the mirror defect this round has found
 * repeatedly.
 *
 * @param {Array<{state: object, raster?: boolean}>} parts - the plan's parts
 * @param {object} registry - the plugin registry (for each part's title)
 * @param {string[]} [notes] - the plugin's own caveats, appended verbatim
 * @returns {string}
 *
 * @example // #  shatterDisclosure(parts, registry)
 * @example // #  → "Recovered 14 Rectangles, 9 Plain Texts, 12 Arrows as editable
 * @example // #     widgets; 2 kept as Images. Sequence message labels carry no
 * @example // #     identity in Mermaid's output, so they are positioned but not anchored."
 * @example shatterDisclosure([], {get: () => ({title: "Rectangle"})})
 * 'Nothing to shatter — this widget draws no recoverable parts.'
 */
export function shatterDisclosure(parts, registry, notes = []) {
  if (parts.length === 0) return "Nothing to shatter — this widget draws no recoverable parts.";
  const tally = (subset) => {
    const byTitle = new Map();
    for (const p of subset) {
      const title = registry.get(p.state.type).title;
      byTitle.set(title, (byTitle.get(title) ?? 0) + 1);
    }
    return [...byTitle].map(([title, n]) => countedTitle(title, n)).join(", ");
  };
  const vector = parts.filter((p) => !p.raster);
  const raster = parts.filter((p) => p.raster);
  const head = vector.length > 0
    ? `Recovered ${tally(vector)} as editable widgets`
    : "Recovered nothing as editable widgets";
  const tail = raster.length > 0 ? `; ${tally(raster)} kept as raster` : "";
  return [`${head}${tail}.`, ...notes].join(" ");
}

/**
 * Pure function. THE SHATTER WRITE — one document in which `itemId` has BECOME a
 * group whose members are the plan's parts, all at slide `slideIndex`.
 *
 * Pure, and that is why `newIds` is an argument rather than minted inside: a
 * function that calls `uuid()` cannot be doctested and cannot be diffed against
 * an expected document. `shatterIds` below is the one-line Query that supplies
 * them, so exactly one function in this file reads the entropy source.
 *
 * NOT `withNewItem`, which every other multi-item command uses
 * (insertTelescopicMagnifier, #cloneStatesIntoSlide): it mints the id INSIDE
 * itself, and the cross-reference rewrite needs every id BEFORE any state is
 * written. `keyframed(doc, slide, ["items", id], state)` is exactly what
 * withNewItem does once the id is in hand, so this is the same creation write,
 * not a second one.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. Parts are written in the plan's own order
 * and their z rises through it, so a plugin controls stacking by emitting
 * back-to-front — the `insertTelescopicMagnifier` precedent, where creation order
 * IS reference order. The host group takes a z ABOVE every part so its outline
 * band is grabbable over its own contents.
 *
 * @param {object} doc - the document
 * @param {number} slideIndex - the slide receiving every keyframe
 * @param {string} itemId - the host item, which becomes the group
 * @param {object} folded - the host's FOLDED state on that slide
 * @param {{parts: Array<{key: string, label?: string, state: object, raster?: boolean}>}} plan
 *   `key` is a reference-safe token siblings bind to; `label` is the human name
 *   the child is displayed under, defaulting to the key.
 * @param {object} registry - the plugin registry
 * @param {string[]} newIds - one fresh itemId per part, in the plan's order
 * @param {{x: number, y: number, w: number, h: number}} box - the group's world bbox
 * @param {string} hostName - the display name children are named after
 * @returns {object} the new document
 *
 * @example // #  const ids = shatterIds(plan);
 * @example // #  const doc2 = shatteredDocument(doc, 0, "ab12", folded, plan, registry, ids, box, "Flowchart");
 * @example // #  foldState(doc2, 0).items.ab12.type      →  "group"
 * @example // #  foldState(doc2, 0).items.ab12.members   →  ids
 * @example // #  foldState(doc2, 0).items.ab12.definition→  the ORIGINAL mermaid source (dormant, RULE 3)
 */
export function shatteredDocument(doc, slideIndex, itemId, folded, plan, registry, newIds, box, hostName) {
  const { parts } = plan;
  if (newIds.length !== parts.length)
    throw new Error(`shatteredDocument: ${parts.length} parts but ${newIds.length} ids — the caller must mint one per part`);
  // Resolve sibling PART KEYS to the minted ids through the existing subgraph
  // rewriter, which handles both `@key` equation refs and `itemRefs` id slots.
  for (const p of parts)
    if (!PART_KEY_PATTERN.test(p.key))
      throw new Error(`shatteredDocument: part key ${JSON.stringify(p.key)} is not a legal reference token (letters and digits, starting with a letter) — run it through partKey(); a sibling reference to it would silently mis-parse`);
  const byKey = Object.fromEntries(parts.map((p) => [p.key, p.state]));
  const idMap = new Map(parts.map((p, i) => [p.key, newIds[i]]));
  const { states, external } = clonedItemStates(byKey, idMap, registry);
  if (external.length > 0)
    throw new Error(`shatteredDocument: parts reference unknown keys ${JSON.stringify(external)} — a part may only reference a sibling part key or an item already in the document`);
  // The host BECOMES the group first, so the parts' z can be read against it.
  let out = retypedItem(doc, slideIndex, itemId, SHATTER_HOST_TYPE, folded, registry);
  const baseZ = folded.z ?? 0;
  parts.forEach((p, i) => {
    // The plugin's registry DEFAULTS first, then its own overrides — the
    // insertTelescopicMagnifier `withDefaults` precedent. It is done HERE rather
    // than in the producing plugin because no plugin may import another, so a
    // mermaid shatter cannot reach the svg widget's defaults; the universal
    // writer can, and doing it once means every consumer gets it right.
    const declared = states[newIds[i]];
    const state = {
      ...registry.get(declared.type).defaults, ...declared,
      active: true, z: baseZ + i, name: `${hostName}${SHATTER_NAME_SEPARATOR}${p.label ?? p.key}`,
    };
    out = keyframed(out, slideIndex, ["items", newIds[i]], state);
  });
  // The group's own geometry: the parts' collective box, its BIND POSE captured
  // there so its influence starts as the identity (plugins/group.js "re-pose
  // invariance"), and its members. z above every part.
  for (const [key, value] of [
    ["x", box.x], ["y", box.y], ["w", box.w], ["h", box.h],
    ["rotation", 0], ["scale", 1],
    ["bind", { x: box.x, y: box.y, rotation: 0, scale: 1 }],
    ["members", newIds],
    ["z", baseZ + parts.length],
  ]) out = keyframed(out, slideIndex, ["items", itemId, key], value);
  return out;
}

/**
 * Query (reads crypto). One fresh itemId per part of a plan — the single
 * entropy-reading line, kept apart so `shatteredDocument` stays pure.
 *
 * @param {{parts: Array<object>}} plan
 * @returns {string[]}
 */
export function shatterIds(plan) {
  return plan.parts.map(() => uuid());
}

// ── THE SVG FAMILY'S SHATTER ─────────────────────────────────────────────────

/**
 * Pure function. One shatter PART per drawable piece of a flattened SVG — the
 * shared body of "shatter this Iconify icon" and "shatter this SVG".
 *
 * User, 2026-08-02: "Shatter is not offered on Iconify icons — and can we shatter
 * shapes/SVGs to POLYGON?"
 *
 * ── WHAT A PIECE IS ──────────────────────────────────────────────────────────
 * One flattened path op. That is the SVG author's own unit of intent — an icon
 * drawn as body + eye + eye is three `<path>` elements — so the pieces come out
 * as the pieces a person would name, rather than as an arbitrary subdivision.
 *
 * ── WHY EACH PART IS AN `svg` WIDGET, NOT A `polygon` ────────────────────────
 * This is the "to POLYGON?" question, answered by the geometry rather than by
 * preference. An icon's outline is CUBICS; `polygon` stores a point list, so
 * converting means flattening every curve to a chord run. That is lossy in a way
 * that gets worse when the piece is later scaled up, and it inflates a four-point
 * `d` into dozens of stored coordinates. An `svg` part keeps the exact curve, is
 * independently movable, restylable and animatable — which is what shattering is
 * FOR — and it is the same target plugins/mermaid.js already shatters into, so
 * the two paths agree.
 *
 * A polygon conversion is a genuinely useful SEPARATE tool (it makes vertices
 * editable, at a fidelity cost the author should choose knowingly). It is not
 * this, and pretending one is the other would silently degrade every icon.
 *
 * ── EACH PART IS TIGHTLY BOXED ───────────────────────────────────────────────
 * A part's world box is its OWN ink's bounds, not the host's. Giving every piece
 * the host's full box would make three overlapping full-size selection targets
 * that are impossible to pick apart — the opposite of what shattering is for.
 *
 * @param {Array<{d: string, fill?, stroke?, strokeWidth?, fillRule?, opacity?}>} ops - flattened path specs, already in HOST-BOX coordinates
 * @param {{x: number, y: number, w: number, h: number}} box - the host's WORLD box
 * @param {string} [label] - what to call the pieces ("icon", "svg")
 * @returns {{parts: Array<{key: string, label: string, state: object}>, notes: string[]}}
 *
 * @example // svgOpsToParts([{d: "M0 0H10V10H0Z", fill: "#000"}], {x: 5, y: 5, w: 10, h: 10}, "icon").parts.length // 1
 * @example // svgOpsToParts([], {x: 0, y: 0, w: 10, h: 10}, "icon") // {parts: [], notes: [...]}
 */
export function svgOpsToParts(ops, box, label = "piece") {
  const parts = [];
  const notes = [];
  let skipped = 0;
  ops.forEach((op, i) => {
    const bounds = pathsBounds([op]);
    if (!bounds || !(bounds.w > 0) || !(bounds.h > 0)) { skipped++; return; }
    parts.push({
      key: partKey(`${label}${i + 1}`),
      label: `${label} ${i + 1}`,
      state: {
        type: "svg",
        // The op's coordinates are already in the host box's LOCAL frame (the
        // flattener scaled them to boxW/boxH), so the world position is the
        // host's origin plus the piece's own offset within it.
        x: box.x + bounds.x, y: box.y + bounds.y, w: bounds.w, h: bounds.h,
        // The viewBox is the piece's own bounds, so the path fills its widget
        // exactly and `preserveAspect: false` cannot distort it.
        svgSrc: pathsToSvgSrc([op], bounds),
        preserveAspect: false,
      },
    });
  });
  // REPORTED, NOT SWALLOWED. A zero-area op is a real thing in SVG (a hairline
  // rule, a degenerate move) and dropping it silently would make the shattered
  // group quietly unlike the icon it came from.
  if (skipped > 0) notes.push(`${skipped} piece(s) had no measurable area and were not recovered as separate widgets.`);
  return { parts, notes };
}
