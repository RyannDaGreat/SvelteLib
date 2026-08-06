/**
 * PLACEHOLDER NODES — a node that is WIRED but NOT YET PORTED, declared as data.
 *
 * ── THE USER'S RULING THAT CREATED THIS (2026-08-06, verbatim) ──────────────
 * *"suggestion to prevent drift: determine which nodes are needed by which patch. then
 * make patches with placeholder nodes. then launch a batch swarm to implement/create
 * those nodes, while validating + making sure the patches sound right"*
 *
 * **It inverts the build order and it is the better order.** Porting nodes first and
 * assembling patches after makes the node list the LEAD'S ESTIMATE of what the patches
 * need. Building the patches first makes the node list DATA — it is exactly the set of
 * types the 20 blueprints name, computable, and it cannot quietly drift toward whatever
 * was convenient to build. That is the drift the ruling is aimed at, and this round had
 * already demonstrated it: 34 nodes shipped, zero patches, none of it VCV.
 *
 * ── WHAT A PLACEHOLDER IS, PRECISELY ────────────────────────────────────────
 * A real registered widget carrying the FINAL type name and the FINAL port names of the
 * module it stands in for. Not a generic box: a `audio_vcv_plateau` placeholder has
 * Plateau's ports, spelled as the C++ `enum InputIds`/`OutputIds` spell them. So:
 *
 *   - the blueprint that uses it TYPECHECKS TODAY, through the same
 *     `core/nodeflow.connectionRefusal` the drag gesture uses;
 *   - when the port block lands, the swap is the deletion of a declaration — the
 *     patch's `type` string and every wire already say the right thing;
 *   - two agents who independently read the same module's ports are CHECKED AGAINST EACH
 *     OTHER: their port sets UNION (a patch declares only what it wires, so subsets are
 *     normal and a superset breaks nobody), while a clash on the TYPE of a shared key is
 *     recorded in `STUB_PORT_CONFLICTS` and printed by `tests/audio_stub_test.js` for the
 *     OWNING BLOCK to settle. A placeholder is therefore also a cross-check on the port
 *     survey, not only a scaffold.
 *
 * ── IT IS LOUD. THAT IS THE WHOLE POINT, AND IT IS NOT NEGOTIABLE ───────────
 * A quiet placeholder is worse than a missing node, because a patch full of quiet
 * placeholders looks finished. So a placeholder is loud at every level a reader could
 * meet it:
 *   - ON THE CANVAS — `readout: "pending"` puts the word on the card's face, and the
 *     `help` opens by saying it is not implemented and naming the block that owes it.
 *   - IN THE TESTS — `tests/audio_stub_test.js` prints the full inventory every run,
 *     grouped by owing block, so "how much is left" is a number nobody has to estimate.
 *   - IN THE SOUND HARNESS — a patch containing ANY placeholder cannot be certified.
 *     A measured-good spectrum from a graph with a hole in it is a false negative
 *     waiting to be quoted as evidence, which is this project's most-repeated failure.
 *
 * ── A PLACEHOLDER HAS NO ENGINE MODULE AT ALL, AND THAT COSTS NOTHING ───────
 * It declares no `module`, so `audioNodePlugin` leaves its `audioModule` undefined and
 * `core/audio_mirror_diff.readAudioScene` skips it at the line that already skips every
 * non-audio widget — and, at the line that already drops wires from a non-audio source,
 * drops its wires too. **Zero new code in the mirror, none in the engine, and none in
 * `synth/`, which is the point**: the ENGINE LAW (`tests/synth_engine_test.js:511-518`)
 * forbids `synth/**` importing `core/**`, so a placeholder that DID have an engine
 * module would need its port list written a second time inside `synth/` — a
 * hand-maintained mirror of this file, which is the defect class this round has already
 * found five times.
 *
 * The consequence, stated plainly rather than discovered: **a patch is silent downstream
 * of its first placeholder.** A "splice" — treating a placeholder as a wire so audio
 * flows past it — was considered and DEFERRED, not forgotten. It is about twelve lines
 * in `readAudioScene`, but its value window is narrow: most of the 20 patches have a
 * placeholder at the SOURCE for now, and splicing past a missing oscillator produces
 * silence anyway. Revisit it only if partially-ported patches turn out to be uselessly
 * dead in practice; do not add it speculatively.
 *
 * ── THE KNOB VALUES ARE REAL DATA AND MUST NOT BE DISCARDED ─────────────────
 * A harvested patch's dial settings are the most perishable thing in it — they are what
 * makes the patch that patch rather than the same modules in a heap. So a placeholder
 * DECLARES the knobs its blueprint sets, with real AudioParams behind them
 * (`synth/modules_stub.js`), and the blueprint sets them today. Nothing is parked in a
 * comment to be reapplied later by hand; the values ride the normal knob path and the
 * real node inherits them when the type is implemented.
 *
 * ZERO DSP lives here. This is a declaration format and an aggregator.
 */

import { audioDisplayTitle } from "./audio_nodes.js";
// THE SHIPPED ROSTER, so a placeholder can stand down the moment its real node lands.
// Acyclic: audio_specs.js reaches audio_blocks.js and audio_nodes.js, neither of which
// knows this file exists. Checked before adding the edge, not assumed.
import { AUDIO_SPECS } from "./audio_specs.js";

// THE SEVEN SETS, imported UNCONDITIONALLY including the empty ones — the same rule
// core/audio_patch_sets.js states and for the same reason: the import list is written
// once, here, so a patch agent filling its own file never edits a shared seam.
import { BLOCK_STUBS as VCV_AMBIENT } from "./audio_stubs_vcv_ambient.js";
import { BLOCK_STUBS as VCV_GENERATIVE } from "./audio_stubs_vcv_generative.js";
import { BLOCK_STUBS as VCV_FX } from "./audio_stubs_vcv_fx.js";
import { BLOCK_STUBS as VCV_CLASSIC } from "./audio_stubs_vcv_classic.js";
import { BLOCK_STUBS as AXO_POLY } from "./audio_stubs_axo_poly.js";
import { BLOCK_STUBS as AXO_REVERB } from "./audio_stubs_axo_reverb.js";
import { BLOCK_STUBS as AXO_MACHINE } from "./audio_stubs_axo_machine.js";

/**
 * A PLACEHOLDER'S KNOB RANGE IS EFFECTIVELY UNBOUNDED, AND THAT IS THE POINT.
 *
 * ── IT USED TO BE PER CORPUS, AND THAT WAS A DEFECT ─────────────────────────
 * `vcv` was ±10 (a Rack cable's hard rail) and `axoloti` ±64 (frac32 full scale). The
 * reasoning was sound and the conclusion was wrong, because **clause 2 of R7-UNITS says a
 * `number` wire carries the REAL UNIT of its quantity** — hertz, seconds, BPM — and those
 * routinely leave any voltage rail behind. Measured by the vcv_fx agent, which could not
 * carry JustAPhaser's 256 Hz centre frequency, Plateau's pre-delay in milliseconds, or
 * SimpleClock's five tempos of 34-49 BPM — and those five differ from each other by design,
 * their incommensurability being exactly what makes P4's five micro-loopers drift apart.
 *
 * It also contradicted this file's own header, which already said a placeholder "must
 * ACCEPT the harvested value, not validate it" and that "a range narrower than the rail
 * would reject a legal patch, which is the one thing this scaffold must never do". The
 * constant said otherwise. **When a constant and the doctrine above it disagree, the
 * constant is what ships.**
 *
 * So: ONE range, wide enough that no harvested value can fall outside it. A placeholder
 * has no opinion about what is legal — the real node's spec supplies the true range on the
 * day it lands, and until then validating would only reject patches we are trying to
 * preserve.
 *
 * `corpus` STAYS in the declaration. It no longer picks a range, but it is real
 * provenance — it says which project's units the harvested value is in, which is what a
 * reader needs to convert it — and `stubSpec` still refuses an unknown one, so a typo is
 * loud rather than silently defaulting.
 */
export const STUB_RANGE = Object.freeze({ min: -1e6, max: 1e6, step: 0.001 });

/** The corpora a declaration may name. Provenance, and a spelling gate — see above. */
export const STUB_CORPORA = Object.freeze(["vcv", "axoloti"]);

/**
 * Pure function. One placeholder declaration expanded into a spec
 * `core/audio_nodes.audioNodePlugin` can build, in the shape `core/audio_specs.js` uses.
 *
 * @param {object} decl - `{type, title, family, source, block, corpus, inputs, outputs, knobs}`
 *   where `corpus` is a STUB_CORPORA entry, `inputs`/`outputs` are `[key, portType]` pairs
 *   in the module's own port order, and `knobs` is `[key, defaultValue]` pairs.
 * @returns {object} a spec record, additionally carrying `stub: true` and `stubOf`
 *
 * @example
 *   stubSpec({type: "audio_vcv_plateau", title: "VCV Plateau", family: "effect",
 *             source: "Valley/Plateau", block: "VC-5", corpus: "vcv",
 *             inputs: [["in_l", "audio"], ["size", "number"]],
 *             outputs: [["out_l", "audio"]], knobs: [["size", 0.7]]}).stub
 *   // true
 * @example // it declares NO engine module — that absence is what makes the mirror skip it
 *   stubSpec({type: "audio_vcv_x", title: "X", family: "effect", source: "P/X",
 *             block: "VC-9", corpus: "vcv", inputs: [], outputs: [], knobs: []}).module
 *   // undefined
 */
export function stubSpec(decl) {
  const { type, title, family, source, block, corpus, inputs, outputs, knobs } = decl;
  if (!STUB_CORPORA.includes(corpus))
    throw new Error(`placeholder "${type}" declares corpus ${JSON.stringify(corpus)} — must be one of ${STUB_CORPORA.join(", ")}`);
  return {
    type,
    // NO `module` KEY, deliberately — see the header. Its absence is load-bearing: it is
    // what makes readAudioScene skip the item, which is what keeps every line of this
    // feature out of `synth/` and out of the ENGINE LAW's way.
    title: audioDisplayTitle(title),
    family,
    icon: "mdi:progress-wrench",
    readout: "pending",
    stub: true,
    stubOf: { source, block, corpus },
    help: `NOT YET PORTED — this node is a placeholder for ${source}, owed by port block ${block}. Its ports and its type name are already final, so the patch around it is correctly wired and the real module drops in without touching a single wire. Audio passes through at unity; a placeholder with no audio input is silent. It cannot be certified by the sound harness.`,
    inputs: inputs.map(([key, portType]) => ({ key, type: portType, label: key })),
    outputs: outputs.map(([key, portType]) => ({ key, type: portType, label: key })),
    knobs: knobs.map(([key, value]) => ({
      key, label: key, default: value, ...STUB_RANGE,
      help: `Harvested from the original patch. The placeholder holds this value but does nothing with it; ${block}'s real ${source} gives it its meaning and its true range.`,
    })),
  };
}

/**
 * Pure function. Dedupe placeholder declarations by `type`, PROVING that repeated
 * declarations agree rather than letting the last one win.
 *
 * A module used by eight patches is declared by every patch set that needs it — that
 * repetition is deliberate and is what makes this a check. Two agents reading the same
 * C++ `enum InputIds` must produce the same port list; if they do not, one of them
 * misread it, and the patch wired to the wrong spelling would fail silently at the
 * moment the real node landed.
 *
 * ── IT RECORDS RATHER THAN THROWS, AND THAT IS A CORRECTION ─────────────────
 * The first version threw at import. It caught a real disagreement within the hour —
 * Plateau's `freeze`/`clear`, declared `number` by one agent and `trigger` by another —
 * so the mechanism works. But the BLAST RADIUS was wrong: this module is imported by
 * `core/audio_specs.js`, so a throw here took down `audio_nodes_test`, `audio_patches_test`
 * and every other bare-node suite that touches the registry, none of which has anything
 * to do with placeholders. In a worktree with a dozen concurrent writers that reads as
 * "the app is broken" rather than as "two agents disagree about one port".
 *
 * So a conflict is DATA now: the first declaration wins deterministically, the
 * disagreement is appended to `STUB_PORT_CONFLICTS`, and `tests/audio_stub_test.js` fails
 * on a non-empty list and prints both readings. Still loud, still impossible to resolve by
 * ordering, and it no longer masquerades as an unrelated outage. **This is not a silent
 * fallback** — nothing is swallowed; the conflict is exported, printed and red.
 *
 * @param {object[]} decls - placeholder declarations, in set order
 * @param {object[]} [conflicts] - collector; disagreements are pushed here
 * @returns {object[]} one declaration per type, in first-seen order
 *
 * @example stubRegistry([]) // []
 * @example
 *   stubRegistry([{type: "a", inputs: [["i", "audio"]], outputs: [], knobs: []},
 *                 {type: "a", inputs: [["i", "audio"]], outputs: [], knobs: []}]).length
 *   // 1
 * @example // a disagreement is recorded, not thrown
 *   const c = [];
 *   stubRegistry([{type: "a", inputs: [["i", "audio"]], outputs: [], knobs: []},
 *                 {type: "a", inputs: [["i", "number"]], outputs: [], knobs: []}], c);
 *   c.length // 1
 */
export function stubRegistry(decls, conflicts = []) {
  const seen = new Map();
  for (const decl of decls) {
    const prior = seen.get(decl.type);
    if (!prior) { seen.set(decl.type, { ...decl, inputs: [...decl.inputs], outputs: [...decl.outputs], knobs: [...decl.knobs] }); continue; }
    // ── PORTS UNION, TYPES MUST AGREE — and the distinction is the whole fix ──
    // Two sets declaring one module differ for TWO different reasons, and only one of
    // them is a disagreement. A patch declares the ports IT WIRES, so two sets naturally
    // produce SUBSETS of the real module — P4 drives Simpliciter's SPEED input and
    // Caudal's twelfth output, which the set that declared them first had no use for.
    // First-wins threw eleven of P4's cables on the floor; a SUPERSET breaks nobody,
    // because a wire to a port that exists is fine whoever declared it.
    // A clash on the TYPE of a shared key is the real disagreement, and still recorded.
    for (const side of ["inputs", "outputs"]) {
      for (const [key, portType] of decl[side]) {
        const mine = prior[side].find(([k]) => k === key);
        if (!mine) { prior[side].push([key, portType]); continue; }
        if (mine[1] !== portType)
          conflicts.push({ type: decl.type, port: `${side.slice(0, -1)} ${key}`, first: mine[1], again: portType });
      }
    }
    // Knob sets legitimately differ too — a patch sets the dials IT uses. Union them,
    // keeping the first value seen, so every harvested dial survives onto the placeholder.
    const keys = new Set(prior.knobs.map(([k]) => k));
    for (const knob of decl.knobs) if (!keys.has(knob[0])) prior.knobs.push(knob);
  }
  return [...seen.values()];
}

// ── THE DECLARATIONS, ONE ARRAY PER PATCH SET ───────────────────────────────
// Each `core/audio_stubs_<set>.js` is owned by the agent that builds the matching
// `core/audio_patches_<set>.js`, and declares the placeholders THAT SET's patches name.
// Overlap between sets is expected and is the cross-check `stubRegistry` performs.
// EMPTY IS A VALID STATE: it means every node those patches want already exists.

/**
 * Disagreements between two sets' readings of one module's ports — see `stubRegistry`.
 * EMPTY IS THE ONLY ACCEPTABLE STATE; `tests/audio_stub_test.js` fails on a non-empty one
 * and prints both readings so the source can settle it.
 */
export const STUB_PORT_CONFLICTS = [];

/** Every placeholder declaration, deduped, with disagreements recorded above. */
export const STUB_DECLS = stubRegistry([
  ...VCV_AMBIENT, ...VCV_GENERATIVE, ...VCV_FX, ...VCV_CLASSIC,
  ...AXO_POLY, ...AXO_REVERB, ...AXO_MACHINE,
], STUB_PORT_CONFLICTS);

/**
 * Placeholder types whose REAL node has since landed — recorded, and then dropped.
 *
 * ── WHY IT IS AUTOMATIC AND NOT A CHORE ─────────────────────────────────────
 * A placeholder's declaration becoming redundant is the SUCCESS condition of the whole
 * scheme, not an error. Requiring the seven patch agents to delete their rows the day a
 * block lands makes the last step of every port a manual edit in a file somebody else is
 * actively writing — and until they got to it, BOTH plugins registered under one type and
 * `core/registry.register` threw `Duplicate plugin type`, taking the app down. Measured:
 * wiring VC-3a and VC-5 in superseded sixteen rows at once, across five files, mid-flight.
 *
 * So the real node wins, deterministically, and the redundant rows are listed here for
 * whoever wants to tidy them. That is strictly better than the old Law-1 assertion, which
 * only told you the collision existed AFTER registration had already thrown.
 */
export const STUB_SUPERSEDED = STUB_DECLS
  .filter((d) => AUDIO_SPECS.some((spec) => spec.type === d.type))
  .map((d) => d.type);

/** The placeholder specs — MINUS any whose real node now exists. */
export const STUB_SPECS = STUB_DECLS.filter((d) => !STUB_SUPERSEDED.includes(d.type)).map(stubSpec);

/**
 * Pure function. Placeholder types grouped by the port block that owes them — the
 * inventory `tests/audio_stub_test.js` prints, so remaining work is a number read off
 * the data rather than estimated.
 *
 * @returns {Map<string, string[]>} block id → the types it owes, sorted
 *
 * @example stubsByBlock().size === 0 // true, once every block has landed
 * @example // stubsByBlock().get("VC-5") // ["audio_vcv_chronoblob2", "audio_vcv_plateau"]
 */
export function stubsByBlock() {
  const owed = new Map();
  for (const decl of STUB_DECLS) {
    const list = owed.get(decl.block) ?? [];
    list.push(decl.type);
    owed.set(decl.block, list);
  }
  for (const list of owed.values()) list.sort();
  return owed;
}

/**
 * Pure function. Whether a patch blueprint contains any placeholder — the ONE predicate
 * the sound harness gates on, so "this patch measured good" can never be said about a
 * graph with a hole in it.
 *
 * @param {object} patch - a blueprint from core/audio_patches.js
 * @returns {string[]} the placeholder types it contains, sorted; empty means certifiable
 *
 * @example patchPlaceholders({nodes: [{type: "audio_pad"}]}) // []
 * @example // patchPlaceholders(VCV_GRANULAR_AMBIENT) // ["audio_vcv_clouds", "audio_vcv_rings"]
 */
export function patchPlaceholders(patch) {
  const stubs = new Set(STUB_SPECS.map((spec) => spec.type));
  return [...new Set(patch.nodes.map((n) => n.type).filter((t) => stubs.has(t)))].sort();
}
