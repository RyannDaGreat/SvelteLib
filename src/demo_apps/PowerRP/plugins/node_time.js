/**
 * TIME node — the presentation clock as a card. The head of the user's per-frame
 * demo (2026-08-12: *"A demo would be time node, going into a modulo 2 node"*).
 *
 * ── RECORDABLE, AND IT READS THE ONE CLOCK ──────────────────────────────────
 * `render_gpu/particle_clock.particleTime()` is the ONE presentation clock: frozen
 * in the editor and in cli/render.js (EDITOR_FREEZE_TIME), driven live by the
 * presenter, and OVERRIDDEN PER FRAME by both exporters
 * (`videoExport.createFrameSampler` calls `setParticleTimeOverride`). Reading it here
 * — rather than `Date.now()`, which the equation jail blocks but which nothing stops
 * a PLUGIN from calling — is what makes this node RECORDABLE state: a pure function
 * of elapsed `t`, so Δt = 0 leaves it unchanged and a strided render shard is still
 * legal. THIS NODE ALONE DOES NOT MAKE A DECK CONTIGUOUS-SHARD-ONLY; the SIMULATED
 * nodes downstream of it do (core/exec_frame.js).
 *
 * ── IT DUPLICATES A SPELLING THAT ALREADY WORKS, AND THAT IS THE JUSTIFICATION ─
 * `= time` already works in any equation, and core/expressions.js classifies `time`
 * as RECORDABLE and explicitly NOT a simulation keyword. So this node adds no
 * capability — it is a CARD around a keyword. It earns its place because the user's
 * demo is a PATCH: a patch whose clock has to be fetched from outside the canvas, by
 * typing an equation into an Inspector row, is not a patch. The same argument covers
 * the Compare and Set Var cards.
 *
 * ── SCALE AND OFFSET ARE KNOBS, NOT A SECOND MATH NODE ──────────────────────
 * `out = (time + offset) * rate`. Both are ordinary keyframable slots. They are here
 * rather than left to a downstream Math node because "run this patch at half speed"
 * and "start this patch two seconds in" are the two things every clock consumer
 * wants, and spending two extra cards and two wires on them would make the commonest
 * patch the ugliest one. RATE IS NOT CLAMPED: 0 freezes the chain (legitimately —
 * that is how you park a demo), and a negative rate runs it backwards, which is
 * meaningful for everything downstream that is a pure function of the number.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { NODE_ITEM_REFS, minimumNodeHeight, nodeCardRim, nodeInkBounds } from "../core/nodeflow.js";
import { formatNodeValue, nodeCard, nodeRim, nodeValueText, portBeads } from "../core/node_chrome.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import { particleTime } from "../render_gpu/particle_clock.js";
import * as T from "../core/transform.js";

const DEFAULT_W = 140;
const CAT = "node";

const PORTS = { inputs: [], outputs: [{ key: "out", type: "number", label: "out" }] };

/**
 * Pure function. The number this node publishes for a given clock reading — the
 * arithmetic, split out from the clock READ so it can be doctested and so tests can
 * drive it at any instant without touching the ambient clock.
 *
 * @param {number} t - the presentation clock, in seconds
 * @param {object} s - the folded item state (its `rate` and `offset`)
 * @returns {number} seconds
 *
 * @example timeValue(3, {}) // 3
 * @example timeValue(3, {rate: 2}) // 6
 * @example timeValue(3, {offset: 1}) // 4
 * @example timeValue(3, {rate: 0.5, offset: 1}) // 2
 * @example // rate 0 parks the whole chain downstream, which is a real authoring move
 * @example timeValue(3, {rate: 0}) // 0
 */
export function timeValue(t, s) {
  return (Number(t) + Number(s?.offset ?? 0)) * Number(s?.rate ?? 1);
}

export const nodeTimePlugin = {
  type: "node_time",
  // RECORDABLE state is EPHEMERAL.NONE: at a FIXED `t` this node is immediately
  // correct, so another frame at the same clock reading changes nothing about it.
  // core/ephemeral.js works the identical case through for particles ("they are
  // RECORDABLE state" and still declare NONE).
  ephemeral: EPHEMERAL.NONE,
  title: "Time Node",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  itemRefs: NODE_ITEM_REFS,
  defaults: {
    type: "node_time", x: 100, y: 100, w: DEFAULT_W,
    h: minimumNodeHeight({ ports: () => PORTS }, {}),
    z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    rate: 1,
    offset: 0,
    inputs: {},
    ...bundleNestedDefaults("effects"),
  },
  inspector: [
    ...bundle("transform"),
    { key: "rate", label: "Rate", kind: "number", category: CAT, help: "How fast this clock runs, as a multiplier. 1 is real time, 0.5 is half speed, 0 freezes everything downstream, and a negative rate runs the patch backwards. An ordinary keyframable slot." },
    { key: "offset", label: "Offset", kind: "number", category: CAT, help: "Seconds added to the clock before the rate is applied — how far into the patch it starts. Keyframe it to jump a running patch forwards or backwards." },
    ...props("opacity"),
    ...bundle("effects"),
  ],
  ports: () => PORTS,
  /**
   * Query (reads the ONE presentation clock; no side effects). This node's output.
   *
   * It is a QUERY and not a pure function, and the distinction is the whole point of
   * the node: `particleTime()` is ambient. It is nonetheless deterministic in every
   * regime that matters — a constant in the editor and the CLI, dictated per frame
   * by both exporters — which is exactly what RECORDABLE means.
   *
   * @param {object} s - the folded item state
   * @returns {{out: number}}
   *
   * @example // in the paused editor the clock is frozen, so this is constant across repaints
   * @example // nodeTimePlugin.computeOutputs({rate: 1, offset: 0}) // {out: EDITOR_FREEZE_TIME}
   */
  computeOutputs(s) {
    return { out: timeValue(particleTime(), s) };
  },
  /**
   * Pure function. The card, with the RATE as its readout rather than the current
   * time.
   *
   * ── WHY NOT PRINT THE CLOCK, WHICH IS THE OBVIOUS THING ────────────────────
   * Because `emit()` must stay a pure function of item state, and the clock is not
   * in it. A card that read `particleTime()` here would make the node's PICTURE
   * ambient, so two derives of one frame could paint different text — and the still
   * renderers would each have to decide what time it is. The live number is already
   * visible where it belongs: on the wire, and in whatever display is downstream.
   * `plugins/node_display.js` is the node whose job that is.
   */
  emit(s, _target, world) {
    const rate = Number(s.rate ?? 1);
    const ops = [
      ...nodeCard(s, "Time"),
      ...nodeValueText(s, rate === 1 ? "t" : `t × ${formatNodeValue(rate)}`),
      ...portBeads(nodeTimePlugin, s),
      ...nodeRim(s),
    ];
    return applyEffects(ops, s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  commands: [{ id: "add-node-time", title: "Add Time Node", icon: "mdi:clock-outline", run: (app) => app.armCrosshairPlacement(nodeTimePlugin) }],
  cullMargin: effectsCullMargin,
  localBounds: (state) => nodeInkBounds(nodeTimePlugin, state),
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return nodeCardRim(state, local.x, local.y);
  },
};
