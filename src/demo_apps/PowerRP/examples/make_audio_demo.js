/**
 * BUILD THE AUDIO DEMO DECK — examples/audio_demo.powerrp.json.
 * Run: node src/demo_apps/PowerRP/examples/make_audio_demo.js
 *
 * ── WHY A GENERATOR AND NOT A HAND-EDITED JSON ──────────────────────────────
 * The deck is three slides of wired audio patches — around thirty widgets and forty
 * connections. Hand-edited, it would drift from core/audio_patches.js the first time
 * a knob range or a port name changed, and the drift would be silent: the deck would
 * still load, still look right, and make no sound. Generating it from the SAME
 * blueprints the palette inserts means the deck cannot describe a patch the app
 * would not build.
 *
 * ── THE GATE THIS OUTPUT MUST PASS ──────────────────────────────────────────
 * CLAUDE.md: "Any regenerated fixture must pass repairedDocument() with zero repair
 * reports." This script CHECKS that itself and refuses to write a file that would be
 * repaired on load — a fixture that needs repairing is a fixture that is teaching a
 * stale schema, and examples/make_demo.js is in the tree as the cautionary case (it
 * still emits legacy rich-text and magnifier fields).
 *
 * examples/make_demo.js is NOT reused here for that reason; this is a separate,
 * current-schema generator for the audio deck alone.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEMO_PATCHES, PATCH_COL, buildPatchItems, patchBounds } from "../core/audio_patches.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { repairedDocument, uuid } from "../core/document.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "audio_demo.powerrp.json");

const SLIDE_W = 1920;
const SLIDE_H = 1080;

const registry = createRegistry();
registerPlugins(registry);

/**
 * Pure function. A camera item for a slide. EXACTLY ONE camera exists per document
 * and it is mandatory (`purgeable: false`) — it owns the background and every view.
 * Dark, because these are dark node cards and a white slide behind them turns a
 * patch into a wall of holes.
 */
function cameraState() {
  return { ...registry.get("camera").defaults, x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, z: 1000, active: true, background: "#0e1018" };
}

/**
 * Pure function. A title label. Uses the plaintext widget's own defaults so no key
 * is missing and nothing needs repairing.
 *
 * THE INK KEY IS `fill`, NOT `color`, and getting that wrong is invisible: an
 * unknown key is simply carried in the state and ignored by the painter, so the
 * first version of this file wrote `color: "#c8cee6"` and rendered every title in
 * the default BLACK — on a #0e1018 camera background, which is black on black. It
 * repaired clean and looked like a missing widget. Read the plugin's defaults rather
 * than guessing the key name.
 */
function titleState(text, x, y, size = 46, fill = "#c8cee6") {
  return { ...registry.get("plaintext").defaults, text, x, y, w: SLIDE_W - x * 2, h: size * 1.6, size, fill, active: true, z: 900 };
}

/**
 * Command. Places one patch and returns its item states, keyed by real id, plus the
 * group that contains it — the same construction insertDemoPatch performs, so the
 * deck and the palette produce identical documents.
 */
function placePatch(patch, origin, zBase) {
  const idFor = new Map(patch.nodes.map((n) => [n.id, uuid()]));
  const { states, order } = buildPatchItems(patch, registry, origin, (name) => idFor.get(name));
  const items = {};
  let z = zBase;
  for (const id of order) items[id] = { ...states[id], active: true, z: z++ };
  const bounds = patchBounds(patch, registry, origin);
  items[uuid()] = {
    ...registry.get("group").defaults,
    name: patch.title,
    x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h,
    rotation: 0, scale: 1,
    members: [...order],
    bind: { x: bounds.x, y: bounds.y, rotation: 0, scale: 1 },
    active: true, z: z++,
  };
  return { items, nextZ: z, bounds };
}

/**
 * Pure function. A slide record. `transition` is the current schema
 * ({type, seconds, curve, sound}); the legacy `duration` it superseded is what the
 * repair pipeline migrates loudly, so a generator must never emit it.
 */
function slide(name, items, transition = { type: "tween", seconds: 0.8, curve: "smooth", sound: null }) {
  return { id: uuid(), name, transition, delta: { items } };
}

// ── HOW A MULTI-SLIDE DECK ACTUALLY WORKS, AND THE BUG THAT TAUGHT IT ───────
// SLIDE 0'S DELTA CREATES EVERYTHING and later slides INHERIT it (the document
// model: a serialized document has no separate item table). So a slide is not an
// independent canvas. The first version of this generator wrote each slide's items
// into that slide's own delta, which reads as three separate scenes and is not —
// rendered, slide 3 showed all three patches and all six title lines stacked on top
// of one another, unreadable.
//
// The correct mechanism is the one the app itself uses: everything is created on
// slide 0, and `active` — the universal property that is exactly how an item exists
// on some slides and not others — is keyframed OFF for what a slide should not show.
// That is also what Delete does in the editor, so this deck is a document a user
// could have authored by hand.
const camera = uuid();
const created = { [camera]: cameraState() };

/** Command. Registers a titled patch scene and returns the ids that belong to it, so
 *  a later slide can switch the whole scene off in one sweep. */
function scene(title, subtitle, patches) {
  const ids = [];
  const add = (state) => { const id = uuid(); created[id] = state; ids.push(id); return id; };
  add(titleState(title, 120, 90));
  add(titleState(subtitle, 120, 156, 22, "#8f97b8"));
  let z = 10;
  let y = 300;
  for (const patch of patches) {
    const placed = placePatch(patch, { x: 120, y }, z);
    for (const [id, state] of Object.entries(placed.items)) { created[id] = state; ids.push(id); }
    z = placed.nextZ;
    y = placed.bounds.y + placed.bounds.h + PATCH_COL / 2;
  }
  return ids;
}

// SCENE 1 — THE AMBIENCE BED. One patch, large and legible: the first thing a viewer
// sees should be ONE chain they can read end to end, not a wall.
const ambience = scene(
  "Spacey Pad Drone",
  "pad → filter (swept by an LFO) → deep-space reverb → meter → spectrum → out",
  [DEMO_PATCHES[0]],
);

// SCENE 2 — RHYTHM. A clock, an edge detector and a struck bell. On its own slide
// because the point is TIMING, and a drone underneath would bury it.
const rhythm = scene(
  "Sequenced Dings",
  "a clock's square wave through an edge detector strikes an FM bell — then delay and plate reverb",
  [DEMO_PATCHES[1]],
);

// SCENE 3 — TWO PATCHES AT ONCE, which is the ADDENDUM 10 ruling made visible:
// "If we have multiple audio outputs by the way, we'll just add them all together."
// Whoosh and Beach each keep their OWN output module, and the engine sums them.
const twoOutputs = scene(
  "Two patches, two outputs — they sum",
  "Whoosh over Beach. Multiple output modules coexist; the engine adds them.",
  [DEMO_PATCHES[2], DEMO_PATCHES[3]],
);

/**
 * Pure function. `{id: {active: <state>}}` for every id — the delta a LATER slide
 * uses to switch a scene on or off. The camera is never in one: exactly one exists,
 * it is `purgeable: false`, and it owns the background on every slide.
 *
 * ONLY VALID ON SLIDES AFTER 0. On slide 0 an item's delta is what CREATES it, so a
 * bare `{active: false}` there is not "created but hidden" — it is a keyframe on an
 * item that is never given a type, which repairedDocument correctly drops as an
 * orphan. The first version of this file spread `off()` over `created` on slide 0
 * and lost 34 items exactly that way. The gate below caught it before it shipped,
 * which is the entire reason this script refuses to write rather than trusting a
 * later run of the deck test.
 */
const activeDelta = (ids, value) => Object.fromEntries(ids.map((id) => [id, { active: value }]));

/** Pure function. Slide 0's map: everything CREATED, with the scenes it does not
 *  show born inactive. MERGED into each item's own state rather than replacing it —
 *  that is the whole distinction the orphan bug turned on. */
function bornInactive(all, hiddenIds) {
  const hidden = new Set(hiddenIds);
  return Object.fromEntries(Object.entries(all).map(([id, state]) =>
    [id, hidden.has(id) ? { ...state, active: false } : state]));
}

const doc = {
  meta: { name: "PowerRP Audio Demo", slideW: SLIDE_W, slideH: SLIDE_H, script: "" },
  slides: [
    // Slide 0 creates EVERYTHING; the two scenes it does not show are born inactive.
    slide("Ambience", bornInactive(created, [...rhythm, ...twoOutputs])),
    slide("Rhythm", { ...activeDelta(ambience, false), ...activeDelta(rhythm, true) }),
    slide("Two Outputs", { ...activeDelta(rhythm, false), ...activeDelta(twoOutputs, true) }),
  ],
};

// ── THE GATE, ENFORCED HERE RATHER THAN DISCOVERED LATER ────────────────────
const { reports } = repairedDocument(doc, registry);
if (reports.length) {
  console.error(`REFUSING TO WRITE: the generated deck would be REPAIRED on load (${reports.length} report(s)):`);
  for (const r of reports) console.error(`  ${JSON.stringify(r)}`);
  process.exit(1);
}

writeFileSync(OUT, JSON.stringify(doc, null, 2));
const itemCount = doc.slides.reduce((n, s) => n + Object.keys(s.delta.items).length, 0);
console.log(`wrote ${OUT}`);
console.log(`  ${doc.slides.length} slides, ${itemCount} items, 0 repair reports`);
