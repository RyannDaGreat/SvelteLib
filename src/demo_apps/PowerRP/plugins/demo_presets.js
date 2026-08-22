/**
 * DEMO PRESETS — insertable MULTI-ITEM TEMPLATES made of ORDINARY widgets whose
 * properties are pre-filled with equations (manifest R7-16, R7-20, R7-25).
 *
 * ── THE USER'S RULING, AND THE ONE THING THAT MAKES THIS FILE CORRECT ────────
 * USER, 2026-08-06, verbatim: *"these are normal basic ass vanilla widgets like the
 * double pendulum, but with pre-filled equations in their properties"*, and about
 * the pendulum: *"this widget is really not a widget, it's just like an alias for
 * creating two rectangles with the proper equations"*.
 *
 * So there is NO `pendulum` plugin, NO `three_body` plugin and NO `cursor_demo`
 * plugin, and adding one would be the mistake this file exists to prevent. A
 * preset is DATA: a list of ordinary item states, exactly what an author could have
 * typed into the Inspector by hand. Everything the physics needs is expressed in
 * the app's OWN vocabulary — item variables, `@`/`dt` simulated state, the item
 * reference grammar, and the project script.
 *
 * ── ONE MECHANISM WITH THE DEMO PATCHES, DELIBERATELY ────────────────────────
 * A demo PATCH (core/audio_patches.js) is items-plus-wiring; a demo PRESET is
 * items-plus-equations. R7-18 asked for one mechanism, so this file is that file's
 * shape: a blueprint ARRAY, a pure `build…Items` that resolves symbolic names to
 * real ids through an `idFor` minter, and palette entries GENERATED from the array
 * (web/demoInsert.js's `demoSectionChildren("preset")`, whose submenu web/App.svelte
 * spreads into the registry) so that authoring a preset is one record and its menu
 * entry follows. The two differ only where the data genuinely differs — a patch lays out
 * on a signal-flow grid and carries `wires`, a preset carries absolute geometry and
 * carries `script`.
 *
 * WHY IT LIVES IN plugins/ AND NOT core/, unlike audio_patches.js: it needs
 * `trailInsertState` (plugins/trail.js) and the cursor artwork's hotspot table, and
 * `core/` imports `plugins/` nowhere in this codebase — that edge is one-way. This
 * is not a plugin (it declares no widget type), which is the same standing
 * plugins/graph_presets.js and plugins/builtin_asset_commands.js have.
 *
 * ── ⚠ THE TRAP EVERY SIMULATED SLOT HERE IS BUILT AROUND ─────────────────────
 * `core/expressions.js fallbackFor` answers `@` ON THE FIRST STEP with the slot's
 * DECLARED DEFAULT — the plugin default for a property, and 0 for an item variable
 * (no plugin declares `vars`). Two consequences, and both shape every equation
 * below:
 *
 *   1. THE EQUATION MUST NOT BE A PLUGIN DEFAULT. If `defaults.age` were the string
 *      `"= @@ + dt"`, step one would compute `"= @@ + dt" + 0` — a string-concatenated
 *      clock, silently, with no error. plugins/trail.js records the measurement and
 *      exports `trailInsertState()` for exactly this; every trail below is built
 *      through it, never from `trailPlugin.defaults`.
 *   2. THERE IS NO AUTHORABLE INITIAL CONDITION ON A SIMULATED SLOT, so a start
 *      value is COMPOSED. `theta = theta0 + swing` where `swing = @ + dt*omega`:
 *      the ACCUMULATOR starts at the fallback 0, which is correct for an
 *      accumulator, and the constant is an ordinary authorable variable beside it.
 *      Writing `theta = @ + dt*omega` instead would start every pendulum at 0 —
 *      hanging straight down, where the acceleration is also 0, so it never moves
 *      and the demo looks broken on insert (manifest R7-16 warns of exactly this).
 *      The same split is why a body's position is `x = x0 + dx` rather than
 *      `x = @ + dt*vx`: the latter's first step reads the CIRCLE PLUGIN's default
 *      `x`, so all three bodies would start on top of each other.
 *
 * The step-one fallback is otherwise harmless because the first pass after
 * `resetSimulation()` has `dt = 0` by construction (core/simulation_history.js), so
 * everything it multiplies is discarded; what step one RECORDS is the composed
 * value, which is right. Measured, not reasoned: the pendulum's `theta` reads
 * exactly `theta0` on the frame it is inserted (tests/demo_presets_test.js).
 *
 * ── SEMI-IMPLICIT (SYMPLECTIC) INTEGRATION, AND WHERE IT SHOWS ───────────────
 * Velocity first, then position from the NEW velocity:
 *     omega = @ + dt * alpha(...)        // reads @-marked values of BOTH rods
 *     swing = @ + dt * self.vars.omega   // NOT @self.vars.omega — the new velocity
 * The two forms differ by exactly one `@`, and on a chaotic system that is the
 * difference between a demo and a divergence. MEASURED AT THE SHIPPED PARAMETERS —
 * g = 196.2, L = 170, theta0 = (2.0, 2.4), 60 fps, energy error as a fraction of the
 * motion's own SPAN (all-up to all-down), .frenzy/round7/w3d/tune_pendulum4.mjs:
 *
 *              10 s              60 s              180 s
 *   symplectic [-0.004, +0.033]  [-0.254, +0.033]  [-0.549, +0.033]
 *   explicit   [ 0.000, +0.061]  [ 0.000, +0.330]  [ 0.000, +1.896]
 *
 * The explicit column is MONOTONE GAIN and it never stops: by three minutes it has
 * added nearly two whole energy spans, which on a pendulum means both rods spinning
 * over the pivot forever. That is a divergence, not an inaccuracy.
 *
 * THE HONEST BOUND OF THE FORM WE DO SHIP, because it must not be discovered later:
 * one first-order step per frame is exact only in the limit, and the left column
 * above says so — the swing visibly CALMS DOWN over minutes. It converges properly
 * with the frame rate (over 10 s: [-0.010, +0.087] at 24 fps, [-0.004, +0.033] at
 * 60, [-0.002, +0.018] at 144, [-0.000, +0.003] at 1000), the positive excursion
 * never exceeds +0.034 at any rate measured, and a 0.1 s camera-clamped hitch every
 * five seconds does not detonate it. So the failure mode is a quieter pendulum, not
 * a rig that leaves the slide.
 *
 * ── WHY MUTUAL `@` REFERENCES ARE WELL-FOUNDED AND NOT A CYCLE ───────────────
 * Rod 2's angular acceleration reads rod 1's angle AND angular velocity, and rod 1's
 * reads rod 2's. Read at the CURRENT step that is a cycle and `requireSlot` would
 * refuse it, correctly. Read at the PREVIOUS step it is a well-founded recurrence,
 * which is exactly what `@` is for. The PHYSICAL connection is a separate matter and
 * both are required: rod 2's box also TRACKS rod 1's free end, through the ordinary
 * ink-anchor reference (`@<rod1>_bm.x`), at the CURRENT step — that direction has no
 * cycle because rod 1's geometry never reads rod 2's.
 */

import { storedItemRef } from "../core/expressions.js";
import { CURSOR_HOTSPOTS, CURSOR_VIEWBOX } from "../render_gpu/gpu/svg_raster.js";
import { trailInsertState } from "./trail.js";

// ── The stored reference grammar, written once ───────────────────────────────
//
// A preset writes STORED equations (`@<itemId>`), not display ones (`@<slug>`) —
// core/expressions.js's own design decision, "store by itemId, display as slugs",
// so a rename needs no document rewrite. The four spellings below are the whole
// grammar these presets use, and they are functions rather than literals so that a
// blueprint can never write `@` where it means `@@`.
//
// EVERY ITEM ID GOES THROUGH `storedItemRef`, WHICH IS NOT DECORATION. A stored
// reference splits its head at the FIRST "_" to find an anchor id, so an id
// containing one silently resolves to a DIFFERENT item — that function is the one
// place that refuses it, loudly. Measured while building this file: an id of the
// form "rig_rod2" turned `@rig_rod2.vars.mass` into an anchor read and produced
// "Anchor reference must end in .x or .y", six errors deep into a rig that looked
// like a physics bug.

/** The previous-value marker in STORED form. `@` alone is the item sigil there, so
 *  the marker is doubled and ABSORBS a following sigil: `@@a1.x`, never `@@@a1.x`. */
const PREV = "@@";

/**
 * Pure function. The STORED reference to one of THIS item's own values at the
 * PREVIOUS step.
 *
 * @param {string} path - a dotted path below `self`: "vars.theta", "h", "x"
 * @returns {string} the stored token
 *
 * @example wasSelf("vars.theta") // "@@self.vars.theta"
 * @example wasSelf("h") // "@@self.h"
 */
const wasSelf = (path) => `${PREV}self.${path}`;

/**
 * Pure function. The STORED reference to ANOTHER item's value at the PREVIOUS step.
 *
 * @param {string} itemId - the target item's id
 * @param {string} path - a dotted path: "vars.mass", "h", "x"
 * @returns {string} the stored token
 *
 * @example wasItem("ab12cd34", "vars.mass") // "@@ab12cd34.vars.mass"
 * @example wasItem("ab12cd34", "h") // "@@ab12cd34.h"
 */
const wasItem = (itemId, path) => PREV + storedItemRef(itemId, `.${path}`).slice(1);

/**
 * Pure function. The STORED reference to another item's named ANCHOR at the CURRENT
 * step — the `@id_tl` convention (`@id.x` is the BOX, `@id_tl` is the INK).
 *
 * @param {string} itemId - the target item's id
 * @param {string} anchorId - "bm", "cm", "hotspot", …
 * @param {string} coord - "x" or "y"
 * @returns {string} the stored token
 *
 * @example anchorAt("ab12cd34", "bm", "x") // "@ab12cd34_bm.x"
 * @example anchorAt("ab12cd34", "hotspot", "y") // "@ab12cd34_hotspot.y"
 */
const anchorAt = (itemId, anchorId, coord) => storedItemRef(itemId, `_${anchorId}.${coord}`);

/**
 * Pure function. An item's CENTRE at the previous step, as a stored sub-expression;
 * `itemId` may be null for THIS item.
 *
 * A circle's `x`/`y` is its box's TOP-LEFT, so gravity — which is a function of the
 * separation between CENTRES — has to say so. Writing the difference in top-left
 * coordinates would be exact only while every body has the same diameter, and
 * silently wrong the moment an author resizes one.
 *
 * @param {string|null} itemId - the target item's id, or null for self
 * @param {string} coord - "x" or "y"
 * @returns {string} the stored sub-expression
 *
 * @example centreWas(null, "x") // "(@@self.x + @@self.w / 2)"
 * @example centreWas("ab12cd34", "y") // "(@@ab12cd34.y + @@ab12cd34.h / 2)"
 */
function centreWas(itemId, coord) {
  const extent = coord === "x" ? "w" : "h";
  const at = (path) => (itemId === null ? wasSelf(path) : wasItem(itemId, path));
  return `(${at(coord)} + ${at(extent)} / 2)`;
}

// ── THE DOUBLE PENDULUM (R7-16) ──────────────────────────────────────────────

/** Canvas units across a rod. Thin enough to read as a rod rather than a plank,
 *  thick enough that its ink survives a projector. */
const ROD_WIDTH = 14;
/** Canvas units along a rod, and therefore the pendulum's L. Both rods are equal,
 *  which is the textbook chaotic double pendulum. */
const ROD_LENGTH = 170;
/** Where each rod is RELEASED, in radians from hanging straight down. Both are large
 *  (115 deg and 137 deg) because a double pendulum released near the vertical is a
 *  slow regular swing, and the chaos is the demo. Neither is exactly 0 or PI, where
 *  the acceleration vanishes and the rig would sit perfectly still. */
const ROD_1_START = 2.0;
const ROD_2_START = 2.4;
/** Seconds of tip history the trail keeps. Long enough to draw a recognisable
 *  chaotic path (the rig's own swing period is about 3 s), short enough that the
 *  figure does not fill in solid. */
const PENDULUM_TRAIL_SECONDS = 6;

/**
 * THE PROJECT-SCRIPT FRAGMENT the pendulum preset stamps. The two angular
 * accelerations are the classic point-mass double pendulum; they live here rather
 * than inline in a property row because inline they are a 400-character expression
 * nobody can read or check, and the project script is the app's own answer to that
 * (core/project_script.js). They are ordinary pure functions of their arguments, so
 * the determinism law is untouched.
 *
 * THE FORM IS THE PUBLISHED ONE and was verified by ENERGY CONSERVATION rather than
 * by eye: integrated symplectically, the total energy of the motion stays inside
 * 3.3% of its own span over the first ten seconds and converges to 0.8% at 1000 fps
 * (a wrong transcription does not do that — it drifts monotonically, as the explicit
 * integrator does even with the right one).
 */
export const DOUBLE_PENDULUM_SCRIPT = `// ── Double pendulum — inserted by the "Double Pendulum" demo preset ──────────
// Angular accelerations of two point masses on massless rods, with each theta
// measured from hanging straight down. Called from each rod's "omega" variable.
// GRAVITY IS IN CANVAS UNITS PER SECOND SQUARED. 196.2 is 9.81 m/s^2 at a world
// scale of 20 canvas units to the metre, which makes the 170-unit rods an 8.5 m
// pendulum: slow enough that one integration step per frame stays accurate, fast
// enough to read as motion. Change this one number to change the tempo.
const PENDULUM_GRAVITY = 196.2;

// The denominator both accelerations share.
const pendulumDenominator = (t1, t2, m1, m2, L1) =>
  L1 * (2 * m1 + m2 - m2 * Math.cos(2 * t1 - 2 * t2));

exports.pendulumAlpha1 = (t1, t2, w1, w2, m1, m2, L1, L2) => {
  const g = PENDULUM_GRAVITY;
  return (-g * (2 * m1 + m2) * Math.sin(t1)
    - m2 * g * Math.sin(t1 - 2 * t2)
    - 2 * Math.sin(t1 - t2) * m2 * (w2 * w2 * L2 + w1 * w1 * L1 * Math.cos(t1 - t2)))
    / pendulumDenominator(t1, t2, m1, m2, L1);
};

exports.pendulumAlpha2 = (t1, t2, w1, w2, m1, m2, L1, L2) => {
  const g = PENDULUM_GRAVITY;
  return (2 * Math.sin(t1 - t2) * (w1 * w1 * L1 * (m1 + m2)
    + g * (m1 + m2) * Math.cos(t1)
    + w2 * w2 * L2 * m2 * Math.cos(t1 - t2)))
    / ((L2 / L1) * pendulumDenominator(t1, t2, m1, m2, L1));
};
`;

/**
 * Pure function. One rod's item state — an ORDINARY rect whose `rotation` READS a
 * variable, which is the whole point of R7-16: *"otherwise they're not normal
 * rects"*.
 *
 * THE ROD'S LENGTH IS ITS HEIGHT, not a fourth variable. `@self.h` and `@<other>.h`
 * are what the equations of motion read for L1/L2, so dragging a rod's resize handle
 * genuinely re-tunes the physics, and there is no second spelling of one quantity to
 * drift.
 *
 * `omega` starts at 0, which is not a workaround here but the physical initial
 * condition: the classic demo RELEASES the pendulum from rest. An author who wants
 * it launched adds `omega0` and splits `omega` the way the three-body preset splits
 * its velocity.
 *
 * Args:
 *   selfName (string): "rod1" | "rod2" — which alpha this rod integrates
 *   ids (object): {rod1, rod2} real item ids
 *   geometry (object): {x, y} the rod's box origin, or equation strings for rod 2
 *
 * Returns:
 *   object: an item state (merged over the rect plugin's defaults at insert)
 *
 * @example // pendulumRod("rod1", {rod1: "a", rod2: "b"}, {x: 0, y: 0}).vars.theta
 * @example // "= self.vars.theta0 + self.vars.swing"
 * @example // pendulumRod("rod2", {rod1: "a", rod2: "b"}, {x: "= @a_bm.x", y: "= @a_bm.y"}).rotation
 * @example // "= self.vars.theta"
 */
function pendulumRod(selfName, ids, geometry) {
  const first = selfName === "rod1";
  const other = first ? ids.rod2 : ids.rod1;
  if (!other) throw new Error(`pendulumRod: no id for the other rod (asked as "${selfName}")`);
  // The arguments are in the PHYSICS order (rod 1 first), whichever rod is asking —
  // so the two equations differ only in which alpha they call, and a reader can
  // check either one against the formula without mentally re-ordering it.
  const mine = ["vars.theta", "vars.omega", "vars.mass", "h"].map(wasSelf);
  const theirs = ["vars.theta", "vars.omega", "vars.mass", "h"].map((p) => wasItem(other, p));
  const [t1, w1, m1, L1] = first ? mine : theirs;
  const [t2, w2, m2, L2] = first ? theirs : mine;
  const args = [t1, t2, w1, w2, m1, m2, L1, L2];
  return {
    type: "rect",
    name: first ? "Pendulum rod 1" : "Pendulum rod 2",
    ...geometry,
    w: ROD_WIDTH, h: ROD_LENGTH,
    // The rod turns about the pivot at its TOP edge, not about its middle — that is
    // what makes it a rod hanging from a point rather than a spinning stick.
    rotationAnchor: { x: "self.anchors.tm.x", y: "self.anchors.tm.y" },
    // THE ANGLE CONVENTION: a rect at rotation 0 points straight DOWN the screen, and
    // this app's positive rotation carries +x towards +y (screen down). So the tip
    // sits at (-L sin(theta), L cos(theta)) from the pivot, which is the textbook
    // double pendulum MIRRORED in x. Every term of the equations of motion is odd or
    // even in the angles together, so the mirrored system obeys the same formulas
    // exactly — no sign correction, and the picture is a valid double pendulum
    // released from the mirrored angles.
    rotation: "= self.vars.theta",
    cornerRadius: ROD_WIDTH / 2,
    fill: first ? "#7aa2f7" : "#bb9af7",
    vars: {
      theta0: first ? ROD_1_START : ROD_2_START,
      mass: 1,
      omega: `= @@ + dt * ${first ? "pendulumAlpha1" : "pendulumAlpha2"}(${args.join(", ")})`,
      // SYMPLECTIC: the NEW omega, so no `@` here. See the header.
      swing: "= @@ + dt * self.vars.omega",
      theta: "= self.vars.theta0 + self.vars.swing",
    },
  };
}

/**
 * THE DOUBLE PENDULUM PRESET (manifest R7-16). Two rects and a trail.
 *
 * @example // DOUBLE_PENDULUM.items({id: (n) => n, centre: {x: 640, y: 360}}).length // 3
 */
export const DOUBLE_PENDULUM = {
  id: "double-pendulum",
  title: "Double Pendulum",
  icon: "mdi:pendulum",
  help: "Two ordinary rectangles that swing as a chaotic double pendulum, with a trail on the free end. The physics is entirely in their item variables: each rod integrates the other's previous angle and angular velocity with = @ + dt, and rod 2's box tracks rod 1's free end through an ordinary anchor reference. The equations of motion are stamped into the project script, where you can read and edit them.",
  script: DOUBLE_PENDULUM_SCRIPT,
  items({ id, centre }) {
    const ids = { rod1: id("rod1"), rod2: id("rod2") };
    // THE PIVOT GOES ON THE VIEW CENTRE, so the rig has room in every direction — a
    // pendulum hung from the TOP of the slide would spend most of its swing below it.
    // The free tip reaches L1 + L2 = 340 units, which is inside a 1280x720 slide's
    // 360-unit half-height, so the whole sweep stays on the slide.
    const pivotX = centre.x;
    const pivotY = centre.y;
    return [
      // THE TRAIL IS FIRST so the insert path gives it the LOWEST z — the streamer
      // belongs behind the rods, not painted over them.
      {
        name: "trail",
        state: trailInsertState({
          name: "Pendulum trail",
          x: `= ${anchorAt(ids.rod2, "bm", "x")}`,
          y: `= ${anchorAt(ids.rod2, "bm", "y")}`,
          seconds: PENDULUM_TRAIL_SECONDS,
          width: 9,
          color: "#f7768e",
          tailColor: "#7aa2f7",
        }),
      },
      { name: "rod1", state: pendulumRod("rod1", ids, { x: pivotX - ROD_WIDTH / 2, y: pivotY }) },
      {
        name: "rod2",
        state: pendulumRod("rod2", ids, {
          // PHYSICAL CONNECTION, separate from the dynamical coupling and equally
          // required: rod 2 hangs off rod 1's free end. `_bm` is rod 1's bottom-middle
          // INK anchor, which already accounts for its rotation, so there is no
          // trigonometry duplicated here. Half the rod's own width puts its PIVOT —
          // the top-middle — on that point rather than its corner.
          x: `= ${anchorAt(ids.rod1, "bm", "x")} - self.w / 2`,
          y: `= ${anchorAt(ids.rod1, "bm", "y")}`,
        }),
      },
    ];
  },
};

// ── THE THREE-BODY PROBLEM (R7-20) ───────────────────────────────────────────

/** Canvas units across every body. Equal by default so the picture reads as three
 *  bodies rather than three sizes; MASS is the variable, and the equations read
 *  centres explicitly (centreWas) so resizing one stays correct. */
const BODY_DIAMETER = 34;
/** The softening radius, in canvas units — ⚠ NOT OPTIONAL. Newtonian gravity is
 *  1/r^2, so a close pass produces an unbounded acceleration and the bodies leave the
 *  slide for good. The camera's max-timestep clamp does not save it: that bounds dt,
 *  not a. 20 is comfortably below the rig's measured minimum separation (40 units
 *  over ten minutes), so it softens the singularity without distorting the orbits
 *  that actually occur. */
const BODY_SOFTENING = 20;

/**
 * THE STARTING STATE, as [mass, centre x, centre y, vx, vy] relative to the rig's
 * centre — canvas units and canvas units per second.
 *
 * FOUND BY SEARCH, NOT BY TASTE, and the search is why these numbers look arbitrary:
 * 4000 random zero-net-momentum triples were integrated for four minutes with the
 * SAME semi-implicit step the app takes, and 25 stayed bounded without a near
 * collision. This is the one among them with the strongest sensitivity to initial
 * conditions — a 0.01-unit nudge grows to 3.2 units in 40 s, an amplification of
 * about 320, which is what "chaotic" means operationally — while also being the most
 * compact (every body stays within 411 units of the barycentre for ten minutes).
 *
 * ⚠ IT IS DELIBERATELY NOT THE FIGURE-EIGHT. That solution needs exact initial
 * conditions and a properly symplectic integrator; velocity-Verlet is not expressible
 * here (it needs the acceleration at the NEW position, i.e. a second evaluation pass
 * per frame, and we advance once per frame by construction), so under semi-implicit
 * Euler it visibly drifts apart and reads as a bug.
 *
 * THE MASSES ARE UNEQUAL because the user asked for *"3 circles with variable
 * masses"* and because equal masses make the three bodies interchangeable, which
 * wastes the one thing a three-body picture has to say.
 */
// HOW FAR A BODY EVER GETS from the barycentre, MEASURED rather than guessed: 233
// canvas units over the first minute, 244 over two, 411 over ten, at 24, 60 and 144
// fps alike (.frenzy/round7/w3d/tune5.mjs, tune6.mjs). The first two fit a 1280x720
// slide's 360-unit half-height with room to spare, which is what "stays on the
// slide for minutes" means here.
const THREE_BODY_START = [
  { mass: 2.0, x: 0, y: 223, vx: 98, vy: 12, fill: "#f7768e", name: "Body 1" },
  { mass: 1.4, x: 20, y: -183, vx: -126, vy: 134, fill: "#9ece6a", name: "Body 2" },
  { mass: 1.0, x: -28, y: -191, vx: -21, vy: -211, fill: "#7dcfff", name: "Body 3" },
];

/** Seconds of history each body's trail keeps — about one full sweep of the widest
 *  orbit, which is what makes the picture read as three ORBITS rather than three
 *  dots with tails. */
const BODY_TRAIL_SECONDS = 8;

/**
 * THE PROJECT-SCRIPT FRAGMENT the three-body preset stamps: the softened Newtonian
 * pull on one body from the two others, one exported function per axis.
 *
 * ONE CALL PER AXIS rather than one per pair, because the alternative is four calls
 * in each equation each computing both components and throwing one away.
 */
export const THREE_BODY_SCRIPT = `// ── Three-body gravity — inserted by the "Three-Body Problem" demo preset ────
// The SOFTENED Newtonian acceleration on a body at (x, y) from two others. Called
// from each body's "dvx" / "dvy" variables.
//
// eps IS THE SOFTENING RADIUS AND IT IS NOT OPTIONAL. Real gravity is 1/r^2, so two
// bodies passing close produce an unbounded acceleration and the demo detonates.
// (r^2 + eps^2) bounds it. Each body carries its own eps as a variable.
//
// G IS IN CANVAS UNITS: 3.5e6 makes a body of mass 1 orbit a mass of 3 at 200 units
// in about seven seconds, which is a readable tempo on a slide.
const GRAVITY_CONSTANT = 3.5e6;

// The pull one body of mass m at (ox, oy) exerts on a body at (x, y), per axis.
const pull = (d, x, y, ox, oy, m, eps) => {
  const dx = ox - x, dy = oy - y;
  return GRAVITY_CONSTANT * m * d / Math.pow(dx * dx + dy * dy + eps * eps, 1.5);
};

exports.bodyAccelX = (x, y, x1, y1, m1, x2, y2, m2, eps) =>
  pull(x1 - x, x, y, x1, y1, m1, eps) + pull(x2 - x, x, y, x2, y2, m2, eps);

exports.bodyAccelY = (x, y, x1, y1, m1, x2, y2, m2, eps) =>
  pull(y1 - y, x, y, x1, y1, m1, eps) + pull(y2 - y, x, y, x2, y2, m2, eps);
`;

/**
 * Pure function. One body's item state — an ORDINARY circle. *"basic ass circles
 * with preset properties"* is the requirement, so `x` and `y` stay the circle's own
 * properties and the physics lives in item variables beside them.
 *
 * FOUR VARIABLES DO ONE INTEGRATION, and the split is forced by the fallback rule in
 * this file's header: `dvx` and `dx` are ACCUMULATORS, correct to start at 0, and
 * `vx0` / `x0` are the authorable initial conditions composed onto them.
 *
 * Args:
 *   index (number): which body (0, 1, 2)
 *   ids (string[]): the three real item ids, in the same order
 *   centre (object): {x, y} the rig's barycentre in world units
 *
 * Returns:
 *   object: an item state
 *
 * @example // threeBodyCircle(0, ["a", "b", "c"], {x: 0, y: 0}).x
 * @example // "= self.vars.x0 + self.vars.dx"
 * @example // threeBodyCircle(0, ["a", "b", "c"], {x: 0, y: 0}).vars.dx
 * @example // "= @@ + dt * (self.vars.vx0 + self.vars.dvx)"
 */
function threeBodyCircle(index, ids, centre) {
  const spec = THREE_BODY_START[index];
  const others = [0, 1, 2].filter((i) => i !== index).map((i) => ids[i]);
  // BOTH axes take the SAME nine arguments — the two bodies' geometry and the
  // softening — so the argument list is written once and the axis is only which
  // function it is handed to.
  const accelArgs = [
    centreWas(null, "x"), centreWas(null, "y"),
    centreWas(others[0], "x"), centreWas(others[0], "y"), wasItem(others[0], "vars.mass"),
    centreWas(others[1], "x"), centreWas(others[1], "y"), wasItem(others[1], "vars.mass"),
    "self.vars.eps",
  ].join(", ");
  return {
    type: "circle",
    name: spec.name,
    // x0/y0 are the BOX ORIGIN, so `x` needs no further correction; the gravity
    // equations convert to centres themselves (centreWas), which is what keeps them
    // right if an author resizes one body.
    x: "= self.vars.x0 + self.vars.dx",
    y: "= self.vars.y0 + self.vars.dy",
    w: BODY_DIAMETER, h: BODY_DIAMETER,
    fill: spec.fill,
    stroke: "#1a1b26",
    vars: {
      mass: spec.mass,
      eps: BODY_SOFTENING,
      x0: centre.x + spec.x - BODY_DIAMETER / 2,
      y0: centre.y + spec.y - BODY_DIAMETER / 2,
      vx0: spec.vx,
      vy0: spec.vy,
      dvx: `= @@ + dt * bodyAccelX(${accelArgs})`,
      dvy: `= @@ + dt * bodyAccelY(${accelArgs})`,
      // SYMPLECTIC: the position steps with the velocity this frame just produced —
      // `self.vars.dvx`, not `@self.vars.dvx`.
      dx: "= @@ + dt * (self.vars.vx0 + self.vars.dvx)",
      dy: "= @@ + dt * (self.vars.vy0 + self.vars.dvy)",
    },
  };
}

/**
 * THE THREE-BODY PRESET (manifest R7-20). Three circles and three trails.
 *
 * @example // THREE_BODY.items({id: (n) => n, centre: {x: 640, y: 360}}).length // 6
 */
export const THREE_BODY = {
  id: "three-body",
  title: "Three-Body Problem",
  icon: "mdi:orbit",
  help: "Three ordinary circles pulling on each other under softened Newtonian gravity, each with a trail. Position stays in the circles' own x and y; velocity, mass and the softening radius are item variables. Every body integrates the other two's previous positions with = @ + dt, which is what makes a three-way mutual dependency well-founded instead of a cycle.",
  script: THREE_BODY_SCRIPT,
  items({ id, centre }) {
    const ids = THREE_BODY_START.map((_, i) => id(`body${i}`));
    // Trails FIRST, so they take the lowest z and the bodies paint over them.
    return [
      ...ids.map((bodyId, i) => ({
        name: `trail${i}`,
        state: trailInsertState({
          name: `${THREE_BODY_START[i].name} trail`,
          x: `= ${anchorAt(bodyId, "cm", "x")}`,
          y: `= ${anchorAt(bodyId, "cm", "y")}`,
          seconds: BODY_TRAIL_SECONDS,
          width: 7,
          color: THREE_BODY_START[i].fill,
          tailColor: THREE_BODY_START[i].fill,
        }),
      })),
      ...ids.map((_, i) => ({ name: `body${i}`, state: threeBodyCircle(i, ids, centre) })),
    ];
  },
};

// ── THE MOUSE CURSOR (R7-25) ─────────────────────────────────────────────────

/** The two built-in cursor shapes the demo switches between — an OPEN hand while the
 *  button is up, a CLOSED one while it is held. Both are already in the canonical
 *  cursor list (render_gpu/gpu/svg_raster.js), so this preset needs no new art. */
const CURSOR_OPEN = "handpointing";
const CURSOR_CLOSED = "handgrabbing";
/** Canvas units across the cursor's box. The cursor widget's own default, kept so the
 *  preset does not silently disagree with a hand-inserted one. */
const CURSOR_SIZE = 96;
/** The measured pointer treatment this preset dresses the cursor in, by NAME. The
 *  numbers behind it were measured off shipping cursor artwork and are documented in
 *  plugins/demo/cursor.js; naming the preset rather than copying its values is what
 *  keeps this file from becoming a second, drifting copy of them. */
const CURSOR_PRESET_NAME = "Contact Shadow Pointer";
/** Seconds of pointer history the trail keeps. Short: a pointer trail is a gesture
 *  aid, and a long one turns into a scribble that hides the thing being pointed at. */
const CURSOR_TRAIL_SECONDS = 1.2;

/**
 * Pure function. The fraction of the cursor's BOX its hotspot — the pointing tip —
 * sits at along one axis. The cursor widget maps its hotspot through the same
 * letterbox at `preserveAspect`, and at a square box that reduces to this fraction
 * exactly, so binding `x = mouse_x - self.w * fraction` lands the TIP on the pointer
 * rather than the box corner.
 *
 * IT IS READ FROM THE ARTWORK'S OWN TABLE, never transcribed: CURSOR_HOTSPOTS is
 * what the widget itself uses, so a corrected hotspot corrects this preset too.
 *
 * @param {string} kind - a built-in cursor name
 * @param {string} coord - "x" or "y"
 * @returns {number} 0..1
 *
 * @example hotspotFraction("handpointing", "x") // 0.40625 (13 of the 32-unit viewBox)
 * @example hotspotFraction("handgrabbing", "y") // 0.5
 */
export function hotspotFraction(kind, coord) {
  const hs = CURSOR_HOTSPOTS[kind];
  if (!hs) throw new Error(`hotspotFraction: "${kind}" is not a built-in cursor — CURSOR_HOTSPOTS has no entry for it`);
  return hs[coord === "x" ? 0 : 1] / CURSOR_VIEWBOX;
}

/**
 * Pure function. The equation binding one of the cursor's box coordinates to the
 * ambient pointer, offset so the TIP lands on it — and switching offsets with the
 * button, because the open and closed hands do not point from the same place.
 *
 * @param {string} coord - "x" or "y"
 * @returns {string} a stored equation
 *
 * @example cursorFollowEquation("x") // "= mouse_x - self.w * (mouse_left ? 0.46875 : 0.40625)"
 * @example cursorFollowEquation("y") // "= mouse_y - self.h * (mouse_left ? 0.5 : 0.25)"
 */
export function cursorFollowEquation(coord) {
  const extent = coord === "x" ? "self.w" : "self.h";
  return `= mouse_${coord} - ${extent} * (mouse_left ? ${hotspotFraction(CURSOR_CLOSED, coord)} : ${hotspotFraction(CURSOR_OPEN, coord)})`;
}

/**
 * THE MOUSE-CURSOR PRESET (manifest R7-25). One cursor widget and one trail.
 *
 * THE SHAPE IS AN EQUATION ON A SELECT ROW, which R7-25 asked to VERIFY rather than
 * assume. It works: `cursorKind` declares `kind: "select"`, KIND_RESULT types that as
 * a "select" result, and `= mouse_left ? "handgrabbing" : "handpointing"` evaluates
 * and validates to the option named (measured — .frenzy/round7/w3d/probe_mechanics.mjs,
 * pinned by tests/demo_presets_test.js).
 *
 * IT IS RECORDABLE STATE, NOT SIMULATED. Nothing here reads `@` or `dt`: the pointer
 * is an ambient input read through core/pointer_input.js's seam, frozen for every
 * still consumer and overridable per frame by an exporter — so the cursor itself
 * still shards. The TRAIL beside it is simulated, and it is the trail's clock that
 * makes the rig unshardable, exactly as it would on any other deck containing one.
 *
 * @example // MOUSE_CURSOR.items({id: (n) => n, centre: {x: 640, y: 360}, registry}).length // 2
 */
export const MOUSE_CURSOR = {
  id: "mouse-cursor",
  title: "Mouse Cursor",
  icon: "mdi:cursor-default-click-outline",
  help: "A cursor widget bound to the live pointer with = mouse_x and = mouse_y, switching from an open to a closed hand while the button is held, and trailing a streamer behind its tip. Ordinary widgets with pre-filled equations — the pointer is read through the same ambient seam the presentation clock uses, so a still renders it at rest rather than wherever your mouse happened to be.",
  items({ id, registry }) {
    const cursorId = id("cursor");
    const preset = registry.get("cursor").presets.find((p) => p.name === CURSOR_PRESET_NAME);
    if (!preset) throw new Error(`demo preset "mouse-cursor": the cursor widget no longer ships a "${CURSOR_PRESET_NAME}" preset — pick another rather than inventing a look`);
    return [
      {
        name: "trail",
        state: trailInsertState({
          name: "Pointer trail",
          // The cursor publishes a `hotspot` anchor at its tip, so the trail needs no
          // offset arithmetic of its own and stays exact through the hand switch.
          x: `= ${anchorAt(cursorId, "hotspot", "x")}`,
          y: `= ${anchorAt(cursorId, "hotspot", "y")}`,
          seconds: CURSOR_TRAIL_SECONDS,
          width: 12,
          color: "#e0af68",
          tailColor: "#f7768e",
        }),
      },
      {
        name: "cursor",
        state: {
          type: "cursor",
          name: "Pointer",
          ...preset.props,
          x: cursorFollowEquation("x"),
          y: cursorFollowEquation("y"),
          w: CURSOR_SIZE, h: CURSOR_SIZE,
          cursorKind: `= mouse_left ? "${CURSOR_CLOSED}" : "${CURSOR_OPEN}"`,
        },
      },
    ];
  },
};

// ── THE PER-FRAME TRIGGER CHAIN (core/exec_frame.js) ─────────────────────────

/** Column pitch for the trigger chain, in world units. Wide enough that a
 *  default-width trigger card (EXEC_NODE_W = 170) leaves a wire long enough to read
 *  as a curve rather than a butt joint — core/audio_patches.js's own criterion. */
const TRIGGER_COL = 220;
/** Row pitch, for the two nodes that hang below the chain's spine. */
const TRIGGER_ROW = 130;
/** The cycle, in seconds. `time mod PERIOD >= 1` is high for the second half of every
 *  period, so the trigger sees exactly one rising edge per period — which is the
 *  user's "increments once every 2 seconds" (2026-08-12). */
const TRIGGER_PERIOD = 2;

/**
 * THE PER-FRAME TRIGGER PRESET — the user's own chain, node for node.
 *
 * > *"A demo would be time node, going into a modulo 2 node, and an is == 0 and is==
 * > to a number==1 nodes, then feed that into a schmitt trigger, which feeds into a
 * > node that hooks into a set global var node, that sets the var to a value upon
 * > triggering, which in this case is that var node's read output connected to a ++
 * > node, so it increments once every 2 seconds, connected to a number display node.
 * > On frames where triggers fire, the wires connecting them should change color to
 * > show that something happened."* (user, 2026-08-12)
 *
 * IT IS ORDINARY WIDGETS AND ORDINARY WIRES, which is this file's whole rule — *"these
 * are normal basic ass vanilla widgets … but with pre-filled equations"*. There is no
 * `trigger_demo` plugin and adding one would be the mistake this file exists to
 * prevent. Every node here is one an author can insert from the palette and wire by
 * hand; the preset only saves them the dragging.
 *
 * ── THE ONE PLACE THE SKETCH AND THE ARCHITECTURE DISAGREE, STATED OUT LOUD ──
 * The sketch wires the variable's read output BACK into the `++` node, which is a
 * CYCLE: the var feeds `++`, `++` feeds the setter, the setter writes the var.
 * `connectionRefusal` refuses that at connect time, and it would also mean the
 * document is written once every two seconds — so a saved deck's bytes would depend
 * on how long it had been played. So the counter OWNS its tally (SIMULATED state, in
 * the simulation table) and the Set Var node is a PUBLICATION of it, which is
 * `plugins/node_counter.js`'s own argument moved to the frame axis. The chain is
 * therefore a straight line with no back edge, and it does exactly what the sketch
 * asked for: one increment every two seconds, on the display.
 * `plugins/node_increment.js`'s header carries the full reasoning.
 *
 * ── WHY `>= 1` AND NOT THE SKETCH'S TWO EQUALITY NODES ─────────────────────
 * The sketch names an `== 0` and an `== 1` node. Against a CONTINUOUS `time mod 2`,
 * exact equality is almost never true — the clock would have to land on the integer
 * to the last float — so a pair of `==` nodes would fire on a frame or two per
 * MINUTE, at random, or never. That is the trap `plugins/node_compare.js`'s header
 * documents (equality is exact and deliberately has no epsilon), and the honest
 * reading of "is it in the second half of the cycle" is `>= 1`. The Compare node
 * ships with all six comparisons, so an author who wants the literal `==` has it.
 *
 * @example // TRIGGER_CHAIN.items({id: (n) => n, centre: {x: 640, y: 360}, registry}).length // 8
 */
export const TRIGGER_CHAIN = {
  id: "trigger-chain",
  title: "Per-Frame Trigger Chain",
  icon: "mdi:flash-triangle-outline",
  help: "The per-frame trigger demo: a clock through a modulo and a comparison into a Schmitt trigger, which pulses a counter once every two seconds and publishes the tally to a display. Ordinary node widgets wired by hand — the Schmitt trigger and the counter carry state between frames (SIMULATED), so the deck renders in contiguous frame ranges. Present it and watch the exec wires flash white on the frames the trigger fires.",
  items({ id, centre }) {
    // The chain lays out left to right in SIGNAL ORDER — the Reaktor convention
    // core/audio_patches.js states — centred on the insertion point.
    const x0 = centre.x - TRIGGER_COL * 3;
    const y0 = centre.y - TRIGGER_ROW / 2;
    const at = (col, row = 0) => ({ x: x0 + col * TRIGGER_COL, y: y0 + row * TRIGGER_ROW });
    const wire = (name, port) => ({ item: id(name), port });
    return [
      { name: "clock", state: { type: "node_time", name: "Clock", ...at(0), rate: 1, offset: 0, inputs: {} } },
      // The modulo's divisor as an ordinary Number node, so the "2" in "every 2
      // seconds" is a knob on the canvas rather than a constant buried in a wire.
      { name: "period", state: { type: "node_number", name: "Period", ...at(0, 1), value: TRIGGER_PERIOD, inputs: {} } },
      {
        name: "mod",
        state: {
          type: "node_math", name: "Modulo", ...at(1), op: "mod",
          inputs: { a: wire("clock", "out"), b: wire("period", "out") },
        },
      },
      {
        name: "compare",
        state: {
          type: "node_compare", name: "Second half?", ...at(2), op: "ge", b: 1,
          inputs: { a: wire("mod", "out") },
        },
      },
      {
        name: "trigger",
        state: {
          type: "node_schmitt", name: "Schmitt", ...at(3),
          // A ZERO-WIDTH BAND, because the input is already a clean 0/1 from the
          // Compare node and there is no noise to debounce. The hysteresis is there
          // for a continuous input; wiring `mod` straight in and widening the band
          // is the variation worth trying, and is why both thresholds are rows.
          low: 0.5, high: 0.5, mode: "rise", level: 0,
          inputs: { in: wire("compare", "out") },
          exec: { then: wire("count", "run") },
        },
      },
      {
        name: "count",
        state: {
          type: "node_increment", name: "Counter", ...at(4), start: 0, step: 1,
          inputs: {},
          exec: { then: wire("publish", "run") },
        },
      },
      {
        name: "publish",
        state: {
          type: "node_set_var", name: "Published", ...at(5), initial: 0, value: 0,
          inputs: { value: wire("count", "out") },
          exec: {},
        },
      },
      {
        name: "display",
        state: {
          type: "node_display", name: "Ticks", ...at(6), decimals: 0,
          inputs: { in: wire("publish", "out") },
        },
      },
    ];
  },
};

/**
 * THE DEMO PRESET ROSTER — the ONE array both consumers read, and both live in
 * web/demoInsert.js: `presetTemplate` turns each record into an insertable template
 * (surfaced by `demoSectionChildren("preset")`), and `insertDemoTemplate` looks one up
 * by the `demo-preset-<id>` command id. `id` is therefore an API and `title` is
 * display, the same split DEMO_PATCHES states: renaming the display cannot break a
 * palette binding.
 * Authoring a preset is one record here and nothing else,
 * which is the same rule DEMO_PATCHES follows and for the same reason: a preset that
 * exists in the data and not in the menu is a feature nobody can find.
 */
export const DEMO_PRESETS = [DOUBLE_PENDULUM, THREE_BODY, MOUSE_CURSOR, TRIGGER_CHAIN];

/**
 * Pure function. A preset's items as `{id → state}` in creation order, with every
 * symbolic name resolved to the real item id the caller minted.
 *
 * Kept pure and separate from the app's insert command so the whole construction can
 * be checked in bare node — that every type is registered, every equation parses,
 * and the physics actually integrates — with no app, no document and no browser.
 *
 * @param {object} preset - a record from DEMO_PRESETS
 * @param {object} registry - the plugin registry
 * @param {{x: number, y: number}} centre - where the rig CENTRES itself, in world units
 * @param {function} idFor - symbolic name → the real item id (must be memoized: it is
 *   called several times per name, once per reference)
 * @returns {{states: object, order: string[]}} item states keyed by REAL id
 *
 * @example // buildPresetItems(DOUBLE_PENDULUM, registry, {x: 640, y: 360}, (n) => n).order
 * @example // ["trail", "rod1", "rod2"]
 */
export function buildPresetItems(preset, registry, centre, idFor) {
  const states = {};
  const order = [];
  for (const node of preset.items({ id: idFor, centre, registry })) {
    const id = idFor(node.name);
    if (states[id]) throw new Error(`demo preset "${preset.id}": two items named "${node.name}"`);
    states[id] = { ...registry.get(node.state.type).defaults, ...node.state };
    order.push(id);
  }
  return { states, order };
}

/**
 * Pure function. The project script a document should hold after a preset that
 * carries `fragment` is stamped into it — the existing script with the fragment
 * APPENDED, or unchanged when it is already there.
 *
 * APPENDED, NEVER REPLACED: `meta.script` is the author's own library, and a preset
 * that overwrote it would destroy work the author cannot get back from an insert.
 * IDEMPOTENT BY EXACT TEXT: inserting the same preset twice must not leave two copies
 * of one function, and two pendulums genuinely SHOULD share one set of helpers. The
 * test is exact-substring rather than clever, so an author who EDITS the stamped
 * fragment (retuning gravity, say) gets a second copy on the next insert — visible,
 * and better than silently deciding their edit was the same thing.
 *
 * @param {string} existing - doc.meta.script (may be absent)
 * @param {string} fragment - the preset's script, or "" / undefined for none
 * @returns {string} the script to store
 *
 * @example withPresetScript("", "exports.f = () => 1;\n") // "exports.f = () => 1;\n"
 * @example withPresetScript("exports.a = 1;", "") // "exports.a = 1;"
 * @example withPresetScript("exports.a = 1;", "exports.b = 2;") // "exports.a = 1;\n\nexports.b = 2;"
 * @example withPresetScript("exports.b = 2;", "exports.b = 2;") // "exports.b = 2;" (already stamped)
 */
export function withPresetScript(existing, fragment) {
  const src = typeof existing === "string" ? existing : "";
  if (!fragment) return src;
  if (src.includes(fragment)) return src;
  return src.trim() === "" ? fragment : `${src.replace(/\s+$/, "")}\n\n${fragment}`;
}
