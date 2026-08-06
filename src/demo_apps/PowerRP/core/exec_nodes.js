/**
 * EXEC NODES — the one shape every trigger widget is built from.
 *
 * core/nodeflow.js owns the exec WIRE, core/exec_flow.js owns the PROGRAM, and this
 * module owns the WIDGET: the card, the beads, the Inspector sections, the palette
 * command, the ink bounds. It is the same trade `core/audio_nodes.js` and
 * `core/control_nodes.js` make for their families, and for the stated reason — six
 * near-identical plugins would otherwise be six copies of the same forty lines, and
 * the seventh would differ from them in a way nobody noticed.
 *
 * ── WHAT AN EXEC PLUGIN DECLARES, AND NOTHING MORE ──────────────────────────
 *   ports        its data AND exec pins, one list (an exec pin is an ordinary
 *                PORT_TYPES entry — see core/nodeflow.js's EXEC WIRES)
 *   execEvent    (ctx) => boolean   — an EVENT's predicate. Position only.
 *   execEffect   (ctx) => [[path, value]] — SET pairs. There is no other verb.
 *   execNext     (ctx) => string[]  — override the default "every exec out, in
 *                order", which is what makes a BRANCH a branch
 *   execLatent   (ctx) => number    — declare it and the node is LATENT: it
 *                schedules its continuation that many boundaries ahead
 *   readout      (s) => string      — the one line the card prints
 *
 * IT NEVER DECLARES WHERE ANYTHING GOES. `nodeCard` / `nodeValueText` / `portBeads`
 * place themselves against the resolved box, per R7-10's unbypassable-layout rule,
 * and there is deliberately no override hatch (core/audio_nodes.js:305-312 is the
 * precedent, and the Bespoke Synth measurement behind it: 191 of ~265 modules
 * override an OPTIONAL auto-layout).
 *
 * ── THE INSPECTOR SECTIONS ARE DERIVED, NOT WRITTEN ─────────────────────────
 * `nodeInputRows` and `execOutputRows` are spread here, so a widget that grows a
 * pin grows its row, and NO JSON-ONLY PROPERTIES holds without any plugin author
 * remembering it. Exec INPUTS get no row on purpose — they store nothing; the wire
 * into them lives on the firing node's side, where its row is.
 */

import { EPHEMERAL } from "./ephemeral.js";
import { standardBBoxAnchors } from "./derive.js";
import { bundle, bundleNestedDefaults, props } from "./properties.js";
import { EXEC_ITEM_REFS, EXEC_KEY, NODE_ITEM_REFS, execOutputRows, minimumNodeHeight, nodeCardRim, nodeInkBounds, nodeInputRows } from "./nodeflow.js";
import { NODE_PAD, NODE_VALUE_SIZE, nodeBox, nodeCard, nodeRim, nodeValueText, portBeads } from "./node_chrome.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import * as T from "./transform.js";

/** The Inspector category an exec node's own knobs file under. One id for the
 *  family, so a Set Property node's target and a Delay's wait read as the same
 *  kind of section rather than as two widgets' private inventions. */
export const EXEC_NODE_CAT = "trigger";

/** The palette / command-menu group every exec node's insert command files under. */
export const EXEC_COMMAND_CATEGORY = "Trigger Nodes";

/** Default card width. Wider than a control node's dial because these cards print a
 *  SENTENCE-ish readout ("x → 100") rather than a number, and a card that has to
 *  shrink its own readout on insertion is a card that was born too small. */
export const EXEC_NODE_W = 170;

/**
 * Approximate advance of one glyph as a fraction of the font size, used ONLY to
 * decide where to put an ellipsis.
 *
 * ── WHY AN ESTIMATE IS THE RIGHT TOOL HERE, WHICH IS NOT USUALLY TRUE ───────
 * `nodeValueText` shrinks a line against the card's HEIGHT and hands the renderer a
 * finite `boxW`, so a long string does not run off the side — IT WRAPS, and the
 * second line then falls outside the one-line band the value text reserved. Measured
 * on a rendered still: a Set Property node pointed at `particleSeed` printed
 * "particleSeed →" over "wire", with the second line across its bottom rim. Every
 * existing caller of nodeValueText passes a NUMBER, which is why nothing had hit it.
 *
 * The honest fix is to keep the readout to one line's worth, and that needs a width
 * budget — but bare node has no font metrics (cli/render.js and the layout sweep both
 * run there), so a real measurement is not available at the seam that has to decide.
 * An estimate is sound BECAUSE OF WHAT IT DECIDES: being wrong costs a couple of
 * characters of headroom or a slightly early ellipsis, never a wrong picture. That is
 * the opposite of the geometry rules elsewhere in the node chrome, which is why this
 * is the only estimated number in the family.
 */
const GLYPH_ADVANCE_RATIO = 0.55;

/**
 * Pure function. A readout string cut to what fits on ONE line of a card this wide,
 * with an ellipsis when it had to cut. See GLYPH_ADVANCE_RATIO for why the width is
 * estimated rather than measured.
 *
 * @param {string} str - the readout the plugin produced
 * @param {number} boxW - the card's resolved width
 * @returns {string} the string, or a cut of it ending in "…"
 *
 * @example oneLineReadout("x → 100", 170) // "x → 100"
 * @example oneLineReadout("particleSeed → wire", 170) // "particleSeed…"
 * @example // a wider card cuts less, because the budget is the card's own width
 * @example oneLineReadout("particleSeed → wire", 260) // "particleSeed → wi…"
 * @example oneLineReadout("", 170) // ""
 */
export function oneLineReadout(str, boxW) {
  const text = String(str ?? "");
  const budget = Math.max(1, Math.floor((Math.abs(boxW ?? 0) - 2 * NODE_PAD) / (NODE_VALUE_SIZE * GLYPH_ADVANCE_RATIO)));
  return text.length <= budget ? text : `${text.slice(0, Math.max(1, budget - 1)).trimEnd()}…`;
}

/**
 * Pure function. The `defaults` bag every exec node shares — the transform, the
 * effects bundle, and BOTH wire maps present-but-empty.
 *
 * `inputs: {}` AND `exec: {}` are present for the reason core/control_nodes.js
 * measured for the first of them: NODE_ITEM_REFS names a wildcard path THROUGH each
 * map, and a wildcard cannot expand over a slot that does not exist — so a node
 * missing either key would keep pointing at the ORIGINAL when it was copied. For
 * `exec` that failure is worse than for `inputs`, because a duplicated event whose
 * effect still fires at the original writes a value the author cannot see the cause
 * of.
 *
 * @param {string} type - the widget type
 * @param {number} h - default height (the ports floor; see execNodePlugin)
 * @param {object} own - the widget's own extra defaults
 * @returns {object}
 *
 * @example execNodeDefaults("node_on_reveal", 68, {mode: "reveal"}).type // "node_on_reveal"
 * @example execNodeDefaults("node_on_reveal", 68, {mode: "reveal"}).mode // "reveal"
 * @example // both wire maps, without which a copied patch stays wired to the original
 * @example JSON.stringify(execNodeDefaults("n", 68, {}).inputs) // "{}"
 * @example JSON.stringify(execNodeDefaults("n", 68, {}).exec) // "{}"
 */
export function execNodeDefaults(type, h, own) {
  return {
    type, x: 100, y: 100, w: EXEC_NODE_W, h,
    z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    inputs: {},
    [EXEC_KEY]: {},
    ...own,
    ...bundleNestedDefaults("effects"),
  };
}

/**
 * Pure function. A complete exec-node plugin from a declaration.
 *
 * @param {object} spec - {type, title, icon, ports, own, rows, readout, execEvent,
 *                         execEffect, execNext, execLatent, computeOutputs}
 * @returns {object} a plugin object for core/registry.js
 *
 * @example const p = execNodePlugin({type: "n", title: "N", icon: "mdi:flash", ports: {inputs: [{key: "run", type: "exec"}], outputs: []}, readout: () => "hi", execEffect: () => []});
 * @example p.type // "n"
 * @example p.capabilities.bbox // true
 * @example // its exec input contributes NO input row (nothing is stored there) …
 * @example p.inspector.filter((r) => r.key === "inputs.run").length // 0
 * @example // … and a node with an exec OUT gets exactly one row for it
 * @example execNodePlugin({type: "e", title: "E", ports: {inputs: [], outputs: [{key: "then", type: "exec"}]}, execEvent: () => false}).inspector.filter((r) => r.key === "exec.then").length // 1
 */
export function execNodePlugin(spec) {
  // A PORT LIST MAY BE A FUNCTION OF STATE, which is what lets a Sequence grow its
  // outputs with its `count` (core/nodeflow.declaredPorts states that contract). The
  // default height is measured against the node's OWN defaults for the same reason:
  // a Sequence of three must be born tall enough for three beads.
  const portsFn = typeof spec.ports === "function" ? spec.ports : () => spec.ports;
  const h = minimumNodeHeight({ ports: portsFn }, spec.own ?? {});
  const plugin = {
    type: spec.type,
    ephemeral: EPHEMERAL.NONE,
    title: spec.title,
    capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
    // BOTH WIRE MAPS PLUS whatever ITEM-VALUED PROPERTIES this widget declares (a
    // watcher's `watch`, an effect's `target`). Those are itemIds in ordinary leaves,
    // so without naming them here a duplicated trigger would keep watching — or
    // keep WRITING TO — the original, which is the silent-copy defect NODE_ITEM_REFS
    // exists to prevent, in its worst form. EXEC_ITEM_REFS is spread here rather than
    // folded into NODE_ITEM_REFS because a declared ref path promises the slot exists
    // and only these widgets have an `exec` map (core/nodeflow.js records the measured
    // reason).
    itemRefs: Object.freeze([...NODE_ITEM_REFS, ...EXEC_ITEM_REFS, ...(spec.itemRefs ?? [])]),
    // THE FAMILY MARKER a sweep asks instead of keeping a type-string list, exactly
    // as core/control_nodes.js's `controlNode` does. core/exec_flow.js does NOT read
    // it — the four node KINDS are derived from the port declaration, which is the
    // stronger statement; this flag only says "this widget belongs to the trigger
    // roster", which is a palette and documentation fact.
    execNode: true,
    defaults: execNodeDefaults(spec.type, h, spec.own ?? {}),
    inspector: [
      ...bundle("transform"),
      ...nodeInputRows({ ports: portsFn }),
      ...execOutputRows({ ports: portsFn }),
      ...(spec.rows ?? []),
      ...props("opacity"),
      ...bundle("effects"),
    ],
    ports: portsFn,
    ...(spec.execEvent ? { execEvent: spec.execEvent } : {}),
    ...(spec.execEffect ? { execEffect: spec.execEffect } : {}),
    ...(spec.execNext ? { execNext: spec.execNext } : {}),
    ...(spec.execLatent ? { execLatent: spec.execLatent } : {}),
    ...(spec.computeOutputs ? { computeOutputs: spec.computeOutputs } : {}),
    /**
     * Pure function. The card, its one-line readout, the beads, the rim.
     *
     * STAYS PURE, and for a trigger node that is the whole point: the card shows
     * what the node WOULD do, never whether it fired. Whether it fired is a fact
     * about a POSITION, and the picture at a position already reflects it — the
     * effect is in the values of the widgets it wrote. A "firing" flash would be
     * state carried from frame N−1, which is the one kind this app has none of.
     */
    emit(s, _target, world) {
      const box = nodeBox(s);
      const ops = [
        ...nodeCard(s, spec.title),
        ...(spec.readout ? nodeValueText(s, oneLineReadout(spec.readout(s), box.w)) : []),
        ...portBeads(plugin, s),
        ...nodeRim(s),
      ];
      return applyEffects(ops, s, world, { x: 0, y: 0, w: box.w, h: box.h ?? 0 });
    },
    commands: [{
      id: `add-${spec.type.replace(/_/g, "-")}`,
      title: `Add ${spec.title}`,
      icon: spec.icon ?? "mdi:flash-outline",
      category: EXEC_COMMAND_CATEGORY,
      run: (app) => app.armCrosshairPlacement(plugin),
    }],
    cullMargin: effectsCullMargin,
    localBounds: (state) => nodeInkBounds(plugin, state),
    anchors: standardBBoxAnchors,
    closestAnchor(state, wx, wy, world) {
      const local = T.apply(T.invert(world), wx, wy);
      return nodeCardRim(state, local.x, local.y);
    },
  };
  return plugin;
}
