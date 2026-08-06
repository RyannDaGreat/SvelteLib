/**
 * ON REVEAL — the event node the user asked for by name: *"Trigger upon events from
 * widgets - like on reveal, on hide, etc."*
 *
 * It watches ONE widget's presence and fires when that changes across a slide
 * boundary. `active` is the universal property Delete keyframes (manifest: "`active:
 * false` is how items exist on some slides and not others"), so "revealed" and
 * "hidden" are not new concepts — they are the two edges of a property every widget
 * already has, which is why this needs no cooperation from the widget it watches.
 *
 * ── WATCHING NOTHING MEANS WATCHING ITSELF, AND THAT IS `BeginPlay` ─────────
 * With `watch` left empty the node watches its OWN presence. Because a trigger is an
 * ordinary widget you Delete and Show per slide, that makes "put this node on the
 * slide where you want it to fire" the whole authoring gesture — no slide index to
 * type, no slide UUID to pick, and it survives a slide being inserted before it. It
 * is Blueprint's `BeginPlay` (manifest R7-8: "`BeginPlay` ≡ `onSlideEnter`"), spelled
 * as a fact about the document rather than as a number.
 *
 * ── WHY IT IS A FUNCTION OF POSITION, WHICH IS THE ONLY REASON IT IS ALLOWED ─
 * `active` at boundary j and at boundary j−1 are both pure functions of the fold, so
 * the firing set is a pure function of the document. Nothing here reads a clock, a
 * pointer or a frame. See core/exec_flow.js's "THE ONE RULE THAT SAVES THE CORE
 * INVARIANT" — an event source that could not answer this is not buildable here.
 */

import { EXEC_NODE_CAT, execNodePlugin } from "../core/exec_nodes.js";

/** The three edges of a presence change. `both` exists because a deck that swaps two
 *  things usually wants one trigger, not two wired to the same chain. */
const MODES = ["reveal", "hide", "both"];
const MODE_LABELS = { reveal: "When it appears", hide: "When it disappears", both: "Either way" };

/** THE CARD'S readout, which is NOT the dropdown's label, and the reason is
 *  measured: `nodeValueText` shrinks a line against the card's HEIGHT but never its
 *  WIDTH, so "When it disappears" at NODE_VALUE_SIZE runs past the rim of a
 *  default-width card. A rendered still is what showed it. The panel has room for a
 *  sentence; the card has room for a word. */
const MODE_MARKS = { reveal: "appears", hide: "hides", both: "either" };

/** Is this item PRESENT on the slide `state` describes? The universal Delete
 *  semantics: absent from the fold and `active: false` are the same answer. */
const present = (state, id) => {
  const item = state?.items?.[id];
  return !!item && item.active !== false;
};

export const nodeOnRevealPlugin = execNodePlugin({
  type: "node_on_reveal",
  title: "On Reveal",
  icon: "mdi:eye-arrow-right-outline",
  itemRefs: [["watch"]],
  ports: { inputs: [], outputs: [{ key: "then", type: "exec", label: "Then" }] },
  own: { watch: "", mode: "reveal" },
  rows: [
    { key: "watch", label: "Watch", kind: "select", optionsFrom: "items", options: [], category: EXEC_NODE_CAT, help: "Which widget's appearing or disappearing this trigger listens for. Leave it empty to watch THIS node, which fires on the first slide the node itself is shown on — the deck's equivalent of \"when this slide arrives\"." },
    { key: "mode", label: "Fires", kind: "select", options: MODES, optionLabels: MODE_LABELS, category: EXEC_NODE_CAT, help: "Which edge fires the chain: the watched widget appearing, disappearing, or either. A widget is \"gone\" on a slide where it has been Deleted (hidden), not only where it has been purged." },
  ],
  readout: (s) => MODE_MARKS[s.mode] ?? MODE_MARKS.reveal,
  /**
   * Pure function. Did the watched widget's presence change into the edge this node
   * listens for, between the previous slide boundary and this one?
   *
   * `prev` is null at slide 0, and the watched widget therefore counts as ABSENT
   * before it — so a `reveal` fires on slide 0 for everything the deck opens with.
   * That is deliberate and is what makes this `BeginPlay`: the audience arriving at
   * the first slide IS the first appearance.
   *
   * @param {object} ctx - core/exec_flow.js's run context
   * @returns {boolean}
   *
   * @example // watching itself, on the first boundary: it just appeared
   * @example nodeOnRevealPlugin.execEvent({id: "a", self: {mode: "reveal"}, state: {items: {a: {}}}, prev: null}) // true
   * @example // …and on the next boundary it is still there, so nothing fires
   * @example nodeOnRevealPlugin.execEvent({id: "a", self: {mode: "reveal"}, state: {items: {a: {}}}, prev: {items: {a: {}}}}) // false
   * @example // a watched widget Deleted on this slide fires a `hide`
   * @example nodeOnRevealPlugin.execEvent({id: "a", self: {mode: "hide", watch: "b"}, state: {items: {a: {}, b: {active: false}}}, prev: {items: {a: {}, b: {}}}}) // true
   */
  execEvent(ctx) {
    const watched = ctx.self.watch || ctx.id;
    const now = present(ctx.state, watched);
    const before = ctx.prev ? present(ctx.prev, watched) : false;
    if (now === before) return false;
    return ctx.self.mode === "both" || (now ? ctx.self.mode !== "hide" : ctx.self.mode === "hide");
  },
});
