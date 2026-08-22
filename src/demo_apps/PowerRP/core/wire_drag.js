/**
 * THE WIRE GESTURE — pure, DOM-free. The state machine behind dragging a wire
 * between two port beads, extracted from the canvas so it can be reasoned about
 * and tested in bare node.
 *
 * The canvas component owns the pointer events, the SVG and the undo call; this
 * module owns every DECISION: which bead a press grabs, what the drag currently
 * means, which targets are legal, and what a release should write. That split is
 * the same one web/canvas/dragKinds.js made for the bbox family, and for the same
 * reason — the geometry and the rules are the part that must not live inside a
 * component nobody can call from a test.
 *
 * ── THE FOUR GESTURES (blueprint §4, all from the user's own description) ────
 *
 *   1. DRAG FROM AN EMPTY BEAD → a NEW connection. A ghost wire follows the
 *      cursor; compatible beads highlight, incompatible ones dim; dropping on a
 *      compatible bead connects (ONE undo unit).
 *   2. DROP A NEW DRAG ON EMPTY SPACE → CANCEL. Nothing is written, nothing is
 *      undone. (The node-search spawn menu that could live here is wave 3.)
 *   3. GRAB AN EXISTING WIRE'S END and drop it on EMPTY SPACE → DELETE the
 *      connection. This is the user's stated delete gesture, verbatim: "you take
 *      one of the nodes you click and drag off into the outer space and the wire
 *      disappears."
 *   4. GRAB AN EXISTING WIRE'S END and drop it on ANOTHER compatible bead →
 *      REROUTE: one undo unit that clears the old input and writes the new one.
 *
 * ── WHY GRABBING AN INPUT BEAD PICKS UP ITS WIRE ────────────────────────────
 * An input holds at most one connection, so a press on a CONNECTED input bead is
 * unambiguous: there is exactly one wire there and you are grabbing its end. The
 * drag then behaves as if it had started at the SOURCE output — because that is
 * what it is: the same wire, its loose end now on your cursor. This is what makes
 * gestures 3 and 4 fall out of gesture 1 rather than being separate modes.
 *
 * A press on an OUTPUT bead never picks a wire up, even when several leave it.
 * Fan-out means "which one?" has no answer, and guessing (nearest? newest?) would
 * make an ordinary new-wire drag occasionally delete an existing connection
 * instead. Dragging from an output always MAKES a wire; to remove one, grab it at
 * the input end, which is the end that identifies it.
 *
 * ── WHY THE REFUSAL IS COMPUTED CONTINUOUSLY, NOT ONLY ON DROP ──────────────
 * `wireTargets()` runs on every pointer move and asks core/nodeflow.connectionRefusal
 * for EVERY bead, so the highlight the user sees and the decision the drop makes
 * come from ONE function. A separate "is it roughly compatible" test for the
 * highlight is how a UI ends up inviting a drop it then refuses.
 */

import { EXEC_KEY, EXEC_TYPE, PORT_BEAD_R, connectionRefusal, detachPairs, execDisconnectPairs, inputRefs, isNodeRef, wirePairsFor } from "./nodeflow.js";
import { nodePortAnchors } from "./derive.js";

/**
 * Pure function. Every port bead in the scene, in WORLD space, with the item it
 * belongs to. THE hit-testing population for a wire gesture — and it deliberately
 * covers EVERY node widget, not just the selected one, because the port bead layer
 * is ALWAYS ACTIVE (the user's founding requirement: "these can always be, even if
 * it's not selected, an area that if I click and drag it from it, can click and
 * drag to another node").
 *
 * @param {object[]} nodes - derived render nodes
 * @returns {object[]} [{item, key, type, label, side, x, y}]
 *
 * @example allPortBeads([]) // []
 * @example allPortBeads([{itemId: "n", world: {x: 0, y: 0, rotation: 0, scale: 1}, state: {w: 100, h: 80}, plugin: {ports: () => ({outputs: [{key: "o", type: "number"}]})}}])[0].item // "n"
 */
/**
 * Pure function. A BEAD'S IDENTITY — item, SIDE and port key.
 *
 * ── THE SIDE IS LOAD-BEARING AND WAS MISSING ────────────────────────────────
 * This composite was spelled `${item}.${key}` inline in three places, and that is not an
 * identity: a port key is unique per SIDE, not per node. A stereo effect legitimately has
 * `l` in and `l` out; Bogaudio's Bool has a `not` input and a `not` output; the Axoloti
 * poly allocator takes `note`/`gate`/`velocity` in and emits the per-voice versions of the
 * same names. Measured across the registry: 24 plugins do this, every one of them
 * faithfully naming its source module's own ports.
 *
 * Without the side those two beads collide, and Svelte's keyed `{#each}` threw
 * `each_key_duplicate` on the canvas — the user saw a console flood of
 * "duplicate key `ecb3aa60.not`". Renaming 24 modules' ports away from their sources
 * would have been the wrong repair: the port names ARE the port.
 *
 * ONE function because the three call sites must agree — the overlay keys its rows by
 * this, and `wireTargets` keys the map the overlay looks the verdict up in. Two spellings
 * of one identity is a highlight that lands on the wrong bead.
 *
 * @param {{item: string, side: string, key: string}} bead - a bead or a port reference
 * @returns {string}
 *
 * @example beadKey({item: "n1", side: "input", key: "l"}) // "n1.input.l"
 * @example // the two sides of a stereo effect no longer collide:
 * @example beadKey({item: "n1", side: "output", key: "l"}) // "n1.output.l"
 */
export function beadKey(bead) {
  return `${bead.item}.${bead.side}.${bead.key}`;
}

export function allPortBeads(nodes) {
  const beads = [];
  for (const n of nodes ?? []) {
    for (const a of nodePortAnchors(n)) beads.push({ item: n.itemId, ...a });
  }
  return beads;
}

/**
 * Pure function. The bead a WORLD point grabs, or null. Nearest wins, within the
 * bead radius scaled to world units plus `tol`.
 *
 * `scale` converts the LOCAL bead radius to world: a node scaled to 2x has a bead
 * twice as wide on screen, and its grab region must match its picture or the two
 * disagree at exactly the zoom levels where precision matters most. Passing the
 * node's own scale is the caller's job because only it knows which node the bead
 * came from — so this takes the already-scaled radius as `tol` instead, and the
 * caller adds the pointer slop.
 *
 * @param {object[]} beads - allPortBeads output
 * @param {number} wx - world x
 * @param {number} wy - world y
 * @param {number} [tol] - extra world-space grab radius (pointer slop / zoom)
 * @returns {object|null}
 *
 * @example beadAt([{item: "n", key: "o", side: "output", type: "number", x: 0, y: 0}], 2, 0, 0).key // "o"
 * @example beadAt([{item: "n", key: "o", side: "output", type: "number", x: 0, y: 0}], 40, 0, 0) // null
 */
export function beadAt(beads, wx, wy, tol = 0) {
  let best = null, bestD = Infinity;
  for (const b of beads ?? []) {
    const d = Math.hypot(b.x - wx, b.y - wy);
    if (d <= PORT_BEAD_R + tol && d < bestD) { best = b; bestD = d; }
  }
  return best;
}

/**
 * Pure function. What a press on `bead` STARTS, given the current items.
 *
 * Returns a drag record:
 *   `anchor`  — the FIXED end of the wire being dragged: the output the wire
 *               leaves from. The ghost is drawn from here to the cursor.
 *   `detach`  — the input this gesture PICKED UP, or null for a new wire. A drop
 *               on empty space DELETES this one; a drop on a bead moves it.
 *
 * A press on a bead that cannot start a gesture (an input already being asked to
 * source a wire, which is not a thing) returns null.
 *
 * @param {object} items - folded items
 * @param {object} bead - the pressed bead (from beadAt)
 * @returns {{anchor: object, detach: object|null}|null}
 *
 * @example // pressing an OUTPUT always starts a NEW wire from it:
 * @example wireDragStart({n: {}}, {item: "n", key: "o", side: "output", type: "number"}) // {anchor: {item: "n", port: "o", type: "number"}, detach: null}
 * @example // pressing an UNCONNECTED input starts a new wire that will END there:
 * @example wireDragStart({n: {}}, {item: "n", key: "i", side: "input", type: "number"}) // {anchor: {item: "n", port: "i", type: "number", isInput: true}, detach: null}
 * @example // pressing a CONNECTED input picks that wire's end up: the anchor becomes its SOURCE
 * @example wireDragStart({n: {inputs: {i: {item: "s", port: "o"}}}, s: {}}, {item: "n", key: "i", side: "input", type: "number"}) // {anchor: {item: "s", port: "o", type: "number"}, detach: {item: "n", port: "i", ref: {item: "s", port: "o"}}}
 * @example // a `multiple` input holding two wires gives up its LAST-ADDED one
 * @example wireDragStart({n: {inputs: {mix: [{item: "s", port: "o"}, {item: "t", port: "o"}]}}}, {item: "n", key: "mix", side: "input", type: "visual"}).anchor.item // "t"
 * @example // AN EXEC OUT holds its own wire, so pressing a WIRED one picks that wire up
 * @example wireDragStart({n: {exec: {then: {item: "t", port: "run"}}}}, {item: "n", key: "then", side: "output", type: "exec"}) // {anchor: {item: "n", port: "then", type: "exec"}, detach: {item: "n", port: "then", exec: true}}
 */
export function wireDragStart(items, bead) {
  if (!bead) return null;
  if (bead.side === "output") {
    // THE MIRROR OF THE CONNECTED-INPUT CASE BELOW, and it exists for the same
    // reason: the gesture must pick up the wire the user is looking at. An exec
    // wire is stored on the OUTPUT, so the output is where it is grabbed —
    // `detach` carries `exec: true` because the pairs that clear it write a
    // different map (core/nodeflow.execDisconnectPairs). Nothing changes for a
    // DATA output, which stores no wire and therefore always starts a new one.
    const held = bead.type === EXEC_TYPE ? items?.[bead.item]?.[EXEC_KEY]?.[bead.key] : null;
    return {
      anchor: { item: bead.item, port: bead.key, type: bead.type },
      detach: isNodeRef(held) ? { item: bead.item, port: bead.key, exec: true } : null,
    };
  }
  const held = inputRefs(items?.[bead.item], bead.key);
  if (held.length) {
    // GESTURE 3/4: this input already holds a wire, so the press GRABS ITS END.
    // The anchor moves to the wire's SOURCE, which is what makes "drag it off into
    // the outer space" delete the same wire the user is looking at.
    //
    // A `multiple` INPUT HOLDS SEVERAL, and the press takes the LAST-ADDED one (the
    // end of the stored array). That is a stated rule, not a guess: "nearest" or
    // "newest-looking" would make the same press pick up different wires on
    // different frames, and an output's "which one?" has no answer at all (above).
    // Repeated drags peel the wires off newest-first, and `detach.ref` names the
    // exact wire so the clear removes that one and leaves the rest.
    const existing = held[held.length - 1];
    return { anchor: { item: existing.item, port: existing.port, type: bead.type }, detach: { item: bead.item, port: bead.key, ref: existing } };
  }
  // An UNCONNECTED input starts a BACKWARD drag: the wire will end here and its
  // source is whatever output the drop lands on. Symmetric with dragging from an
  // output, because a user reaching for a socket should not have to know which end
  // the software considers the beginning.
  return { anchor: { item: bead.item, port: bead.key, type: bead.type, isInput: true }, detach: null };
}

/**
 * Pure function. For a live wire drag, EVERY bead's verdict: `ok` (a legal drop,
 * highlight it), or a refusal sentence (dim it, and say why if it is under the
 * cursor).
 *
 * Computed for every bead on every move so the HIGHLIGHT and the DROP read the
 * same answer from the same function — see the module docblock.
 *
 * The dragged wire's OWN anchor bead is excluded: a wire cannot end where it
 * begins, and offering it as a target would invite a self-connection the cycle
 * rule then refuses.
 *
 * @param {object} items - folded items
 * @param {object} registry - plugin registry
 * @param {object[]} beads - allPortBeads output
 * @param {object} drag - a wireDragStart record
 * @returns {Map<string, string|null>} "item.port" → refusal sentence, or null when legal
 *
 * @example // number output → number input is legal (null = no refusal)
 * @example wireTargets({a: {type: "s"}, b: {type: "d"}}, {get: (t) => t === "s" ? {ports: () => ({outputs: [{key: "o", type: "number"}]})} : {ports: () => ({inputs: [{key: "i", type: "number"}]})}}, [{item: "b", key: "i", side: "input", type: "number", x: 0, y: 0}], {anchor: {item: "a", port: "o", type: "number"}, detach: null}).get("b.input.i") // null
 */
export function wireTargets(items, registry, beads, drag) {
  const out = new Map();
  if (!drag) return out;
  // A drag from an INPUT is looking for an OUTPUT, and vice versa. This is the one
  // place the backward-drag symmetry is spent; everything downstream sees an
  // ordinary (output → input) pair.
  const wantSide = drag.anchor.isInput ? "output" : "input";
  for (const b of beads ?? []) {
    if (b.item === drag.anchor.item && b.key === drag.anchor.port) continue;
    const id = beadKey(b);
    if (b.side !== wantSide) { out.set(id, `an ${b.side} cannot connect to an ${wantSide === "input" ? "input" : "output"}`); continue; }
    const [from, to] = drag.anchor.isInput
      ? [{ item: b.item, port: b.key }, { item: drag.anchor.item, port: drag.anchor.port }]
      : [{ item: drag.anchor.item, port: drag.anchor.port }, { item: b.item, port: b.key }];
    out.set(id, connectionRefusal(items, registry, from, to));
  }
  return out;
}

/**
 * Pure function. What RELEASING a wire drag writes: `[path, value]` pairs for the
 * canvas's setPreview → commitPreview path (ONE undo unit), plus the reason when
 * nothing is written.
 *
 * The four outcomes of the module docblock, in one function so a release cannot
 * take a fifth:
 *   dropped on a COMPATIBLE bead → `connect` (plus the detached input's clear, if
 *     this was a reroute — both in the SAME pair list, so undo restores the wire
 *     to where it was in one step rather than two).
 *   dropped on an INCOMPATIBLE bead → nothing, with the refusal sentence.
 *   dropped on EMPTY SPACE with a detached wire → `disconnect`.
 *   dropped on EMPTY SPACE with a new wire → nothing, silently. A cancelled new
 *     wire is not an error and must not produce a message; the user simply changed
 *     their mind mid-gesture.
 *
 * @param {object} items - folded items
 * @param {object} registry - plugin registry
 * @param {object} drag - the wireDragStart record
 * @param {object|null} target - the bead under the pointer at release, or null
 * @returns {{pairs: Array, kind: string, refusal: string|null}}
 *
 * @example // cancel: a new wire dropped on empty space writes nothing and says nothing
 * @example wireDrop({}, {get: () => ({})}, {anchor: {item: "a", port: "o"}, detach: null}, null) // {pairs: [], kind: "cancel", refusal: null}
 * @example // DELETE: an existing wire's end dropped on empty space
 * @example wireDrop({}, {get: () => ({})}, {anchor: {item: "a", port: "o"}, detach: {item: "b", port: "i"}}, null) // {pairs: [[["items", "b", "inputs", "i"], null]], kind: "disconnect", refusal: null}
 */
export function wireDrop(items, registry, drag, target) {
  if (!drag) return { pairs: [], kind: "cancel", refusal: null };
  if (!target) {
    if (drag.detach) return { pairs: clearPairs(items, drag.detach), kind: "disconnect", refusal: null };
    return { pairs: [], kind: "cancel", refusal: null };
  }
  const [from, to] = drag.anchor.isInput
    ? [{ item: target.item, port: target.key }, { item: drag.anchor.item, port: drag.anchor.port }]
    : [{ item: drag.anchor.item, port: drag.anchor.port }, { item: target.item, port: target.key }];
  const refusal = connectionRefusal(items, registry, from, to);
  if (refusal) return { pairs: [], kind: "refused", refusal };
  // A REROUTE clears the OLD end in the same pair list as it writes the new one, so
  // the whole move is one undo unit. Order matters only if the two are the same
  // slot, in which case the connect must win — hence the clear goes FIRST. For an
  // EXEC reroute the "same slot" is the SOURCE pin (that is where the wire lives),
  // which is why the identity test reads the detach against the end it was taken
  // from rather than always against `to`.
  const held = drag.detach?.exec ? from : to;
  const clear = drag.detach && !(drag.detach.item === held.item && drag.detach.port === held.port)
    ? clearPairs(items, drag.detach) : [];
  // A REROUTE ONTO THE SAME `multiple` INPUT (picked up wire A, dropped back on the
  // socket it came from) must not be an APPEND on top of the still-stored A: the
  // append reads the items as they are, so the picked-up wire is removed from the
  // view it reads first. Every other case reads the unchanged items.
  const base = drag.detach?.ref && !drag.detach.exec ? withDetached(items, drag.detach) : items;
  return { pairs: [...clear, ...wirePairsFor(base, registry, from, to)], kind: drag.detach ? "reroute" : "connect", refusal: null };
}

/** Pure function. The pairs that clear whichever end a detach names. One dispatcher
 *  so the two maps are never confused for each other — `disconnectPairs` writing an
 *  exec detach would null out a DATA input that happens to share the port key. A
 *  data detach names its exact wire (`ref`), so a `multiple` input loses that one
 *  wire and keeps the rest (core/nodeflow.detachPairs). */
function clearPairs(items, detach) {
  return detach.exec ? execDisconnectPairs(detach) : detachPairs(items, detach, detach.ref ?? null);
}

/** Pure function. The item map as it reads once `detach`'s wire is gone — the
 *  input's slot replaced by what detachPairs would write there. */
function withDetached(items, detach) {
  const [[, value]] = detachPairs(items, detach, detach.ref);
  const state = items[detach.item];
  return { ...items, [detach.item]: { ...state, inputs: { ...state.inputs, [detach.port]: value } } };
}

/**
 * THE WIRE CURVE MOVED TO core/nodeflow.js (WORKSTREAM BN, 2026-08-03) and is
 * re-exported here so this module's existing importers keep one name for it.
 *
 * WHY IT MOVED: the curve stopped being an interaction detail the day wires
 * became SCENE content. The RENDERER now needs the identical path — the user's
 * ask is that "the wires between nodes should be shown in prsentation mode and
 * pdf rener and png render etc too" — and render_gpu/ must not import an
 * interaction module that pulls in core/derive.js and the whole drag protocol.
 * core/nodeflow.js is the leaf (it imports NOTHING), so both the ghost wire the
 * pointer drags and the committed wire the painter draws now come from one
 * function, which is what makes the ghost land exactly on the curve that
 * replaces it.
 */
export { wireBezierPath, WIRE_MIN_REACH, WIRE_MAX_REACH } from "./nodeflow.js";
