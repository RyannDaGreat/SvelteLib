/**
 * WHOLISTIC SCALING — what happens to a property that is NOT x/y/w/h when the
 * user scales a widget (user, 2026-08-12: "'w' hsould toggle 'wholistic' … taking
 * into account things such as text size and stroke widths etc - to make it perfect
 * scaling. There should be such an option for perfect scaling on a property per
 * property basis - every property should be able to activate a scaling func, which
 * determines what happens to it on a wholistic scaling operation").
 *
 * THE PROBLEM THIS SOLVES. An ordinary S-modal scale writes w/h (and x/y) and
 * NOTHING ELSE. So a text box scaled ×2 is twice as wide with the SAME glyphs, a
 * stroked rect grows with the same hairline, and a shadow keeps an offset that is
 * now half as far in relative terms. That is not what "make it bigger" means to a
 * person. The GROUP ARMATURE already does the right thing — a group's members
 * follow its similarity `scale`, and every length consumer multiplies by
 * `world.scale`, so a group scaled ×2 grows its strokes and glyphs too. Wholistic
 * mode is that behaviour for a NON-group scale gesture, achieved by WRITING
 * properties rather than by wrapping the selection in a transform. The difference
 * matters: the armature route is a transform an author can undo by ungrouping; this
 * route lands real numbers in the document, which is what the user asked for
 * ("perfect scaling ... on a property per property basis").
 *
 * ── THE CENTRAL DESIGN FACT, AND IT IS MEASURED ─────────────────────────────────
 * MOST SCALABLE PROPERTIES ARE NOT IN core/properties.js AND NEVER WILL BE. Counted
 * against the real registry on 2026-08-12 (`builtinRoster()`, 364 plugins):
 *
 *     1303 distinct `kind: "number"` inspector keys
 *      913 of them declared in EXACTLY ONE plugin
 *
 * `fontSize` — the user's own headline example — is one of them: it is declared
 * locally by plugins/latex.js and plugins/codeblock.js, and the TEXT widget does
 * not even spell it that way (plugins/text.js calls it `size`). Neither is a
 * core PROPS key. So a hardcoded core table listing "fontSize, strokeWidth,
 * cornerRadius, …" would be a table that covers a rounding error of the app while
 * LOOKING complete — and its failure mode is silent: an unlisted length simply does
 * not scale, and the author sees a slightly wrong picture with no error anywhere.
 *
 * THEREFORE THE PLUGIN DECLARATION IS THE PRIMARY SEAM, NOT THE FALLBACK. A row
 * says what it is (`scaling: "linear"` on its inspector row, or a plugin-level
 * `scaling` table entry); the core table below is the SHARED-KEY layer, and it is
 * deliberately small — it covers only keys that a great many plugins genuinely
 * share (x/y/w/h are the gesture's own business, and the universal effects bundle
 * is on all 360). Everything else is the widget's to declare, which is also the
 * only place that knows the answer: whether `taper` is a length or a ratio is a
 * fact about the widget, not about the word.
 *
 * ── WHY UNRECOGNISED MEANS "none" AND WHY THAT IS NOT A SILENT FALLBACK ─────────
 * An undeclared key scales by NOTHING, which is exactly TODAY'S behaviour for every
 * property — so an undeclared widget is unchanged rather than wrong, and wholistic
 * mode can never make a picture worse than the current one. That is the honest
 * default: the alternative (guessing "linear" for unknown keys) would multiply
 * ratios, counts, opacities, seeds and frequencies by the gesture factor and produce
 * garbage confidently. `scalingCoverage()` exists so the gap is COUNTABLE rather
 * than invisible — it reports which of a plugin's number rows have an answer, which
 * is how an author finds the rows their widget still needs to declare.
 *
 * ── THE BEHAVIOUR VOCABULARY ────────────────────────────────────────────────────
 *   "linear" — a LENGTH in canvas units: multiply by the gesture factor. Stroke
 *     widths, corner radii, font sizes, blur radii, shadow offsets. This is the
 *     whole point of the feature.
 *   "none"   — dimensionless: leave it alone. Angles (a rotated thing stays rotated
 *     at any size), opacities and other 0..1 ratios, counts, seeds, frequencies,
 *     times, z-order.
 * TWO BEHAVIOURS, NOT MORE, AND THAT IS A DELIBERATE FLOOR RATHER THAN A CEILING.
 * "area" (k²) and "inverse" (1/k) are both imaginable and NEITHER has a real
 * consumer today, so declaring them would be vocabulary with no picture behind it —
 * the same reason the manifest gives for radial gradients having no spread row.
 * `SCALING_BEHAVIORS` is the enumeration a new behaviour is added to, and
 * `scaledValue` is the ONE place a behaviour becomes arithmetic, so adding one is a
 * two-line change in one file rather than a search for multiply sites.
 *
 * DOM-free and dependency-free: this module imports NOTHING, so it runs in bare
 * node (the core/ rule) and is covered by tests/scale_wholistic_test.js and
 * tests/scaling_test.js.
 *
 * ── PROVENANCE, because `git log` on this file does not explain itself ────────────
 * The SCALE_ workstream landed scattered across three commits by a shared-tree race,
 * and NONE of their messages mention it:
 *   830d4964 "Animated GIFs are videos" — this file, tests/scale_wholistic_test.js,
 *     dragKinds' MODAL_TOGGLES/memberPivot/wholisticMemberPairs, the generated I/W
 *     shortcut entries, and App.svelte's modalToggles wiring
 *   435e92e1 "Drawing an arrow onto an anchor now BINDS it" — CanvasView's modalToggle
 *   15a7d333 "Compound property rows" — app.svelte.js's `modalToggle`
 * That matters beyond tidiness: the "Individual origins UNSATISFIABLE" boot error
 * that 7eca576d and 5726e5f0 both attributed to other agents ("BASELINE RED, NOT
 * OURS") was shipped by 830d4964 itself — the I entry's `when` needed a
 * multiSelection axis the prober lacked until c94918a2. Written here rather than
 * fixed in the log because history is immutable; this is the a314880e note in the
 * one place a reader of this file will actually find it.
 */

/**
 * Every legal scaling behaviour. A behaviour outside this list is a LOUD error at
 * the one seam that reads it (scaledValue), never a silent pass-through — a
 * misspelled `scaling: "linnear"` must not read as "none".
 *
 * @example SCALING_BEHAVIORS // ["linear", "none"]
 */
export const SCALING_BEHAVIORS = Object.freeze(["linear", "none"]);

/**
 * THE SHARED-KEY SCALING TABLE: the behaviour for property keys that MANY plugins
 * share, so those plugins need not each restate the obvious. Deliberately SMALL —
 * see this file's header for why a large one would be a lie. Every entry here is a
 * key measured to appear across a wide swathe of the registry.
 *
 * WHAT IS ABSENT AND WHY:
 *   x / y / w / h / cx / cy — the SCALE GESTURE'S OWN coordinates. The gesture
 *     already writes them through core/geometry + dragKinds' scaleMemberPairs, and
 *     writing them a second time here would double-apply the factor. Wholistic mode
 *     is strictly ADDITIVE to the geometry the gesture always wrote.
 *   rotation and every `kind: "angle"` row — an angle is dimensionless. Handled
 *     structurally by rowScaling (an angle row is "none" without an entry here), so
 *     the fact lives in the row kind rather than in a key list that could miss one.
 *
 * @example SHARED_SCALING.strokeWidth // "linear"
 * @example SHARED_SCALING.opacity // "none"
 * @example SHARED_SCALING.w // undefined (the gesture's own coordinate — see above)
 */
export const SHARED_SCALING = Object.freeze({
  // ── LENGTHS: canvas units, so they scale ──────────────────────────────────
  strokeWidth: "linear",
  cornerRadius: "linear",
  gaussianBlur: "linear",
  softEdges: "linear",
  "shadow.dx": "linear",
  "shadow.dy": "linear",
  "shadow.blur": "linear",
  "innerShadow.dx": "linear",
  "innerShadow.dy": "linear",
  "innerShadow.blur": "linear",
  "bloom.radius": "linear",
  cropTop: "linear",
  cropLeft: "linear",
  cropRight: "linear",
  cropBottom: "linear",
  // `size` is the TEXT widget's font size (plugins/text.js — it is NOT spelled
  // `fontSize` there, which is the header's point about local vocabularies), and
  // `fontSize` is latex's and codeblock's. Both are canvas units per em.
  size: "linear",
  fontSize: "linear",

  // ── DIMENSIONLESS: stated rather than omitted ─────────────────────────────
  // Present as explicit "none" so `scalingCoverage` counts them as ANSWERED. An
  // omitted key and a key declared "none" behave identically at render time and
  // differ in exactly one way: the omitted one shows up as an unanswered row an
  // author still has to think about, and these have been thought about.
  opacity: "none", // a 0..1 ratio
  "shadow.opacity": "none",
  "innerShadow.opacity": "none",
  "bloom.strength": "none",
  z: "none", // stacking order, an integer rank
  strokeStart: "none", // 0..1 fractions of the stroke's own length — they follow it
  strokeEnd: "none",
  strokeMiter: "none", // already measured in MULTIPLES of the half stroke width, so it scales with the stroke by construction
  // strokeOffset is the SAME argument as strokeMiter and used to say the opposite
  // ("linear — beyond ±1 it detaches into a parallel contour measured in canvas
  // units"). That sentence is false in BOTH regimes: render_gpu/ir.js
  // strokeInsideFraction(o) = (1−o)/2 is a fraction OF THE STROKE WIDTH, and past ±1
  // strokeDetachedNearDistance(width, o) = (|o|−1)·width/2 is again a multiple of it —
  // there is no canvas length anywhere in the formula. Since strokeWidth IS "linear",
  // the drawn offset already scales with the gesture; scaling the number too applies k
  // twice and CHANGES THE ALIGNMENT: a fully-inside stroke (o=−1) at k=2 became o=−2,
  // a detached ring floating a full width off the edge.
  strokeOffset: "none",
  "rotationAnchor.x": "none", // the gesture repositions items itself; an anchor is a bound point, not a size
  "rotationAnchor.y": "none",
});

/**
 * Pure function. THE LOOKUP, in precedence order — the ONE place "what does this
 * property do under a wholistic scale" is answered, so every consumer agrees.
 *
 * PRECEDENCE, most specific first, which is the same shape every other override in
 * this codebase uses (a plugin's own declaration beats the shared default):
 *   1. the ROW's own `scaling` field  — the finest grain: one widget, one row
 *   2. the PLUGIN's `scaling` table   — a widget-wide statement, handy when a
 *      family shares a helper that builds its rows and the rows are not hand-written
 *   3. SHARED_SCALING                 — the many-plugin keys
 *   4. the row KIND                   — an `angle` row is dimensionless, structurally
 *   5. "none"                         — the honest default (see the header)
 *
 * THE ROW BEATS THE PLUGIN TABLE rather than the other way round because the row is
 * where the property is DECLARED: a plugin that hand-writes `{key: "taper", scaling:
 * "linear"}` has said the specific thing at the specific place, and a table entry is
 * the broader statement. This is the ordinary specificity rule, not a new one.
 *
 * @param {object} row - an inspector row ({key, kind, scaling?})
 * @param {object} plugin - the declaring plugin (may carry `scaling`)
 * @returns {string} a member of SCALING_BEHAVIORS
 *
 * @example // a widget's own row wins over everything:
 * @example rowScaling({key: "opacity", kind: "number", scaling: "linear"}, {}) // "linear"
 * @example // a plugin-level table answers rows it did not hand-write:
 * @example rowScaling({key: "taper", kind: "number"}, {scaling: {taper: "linear"}}) // "linear"
 * @example // the shared table covers the keys most plugins have:
 * @example rowScaling({key: "strokeWidth", kind: "number"}, {}) // "linear"
 * @example // an ANGLE row is dimensionless with no entry anywhere — structural, not listed:
 * @example rowScaling({key: "fanAngle", kind: "angle"}, {}) // "none"
 * @example // and an undeclared number is left alone, which is today's behaviour:
 * @example rowScaling({key: "wobbleFreq", kind: "number"}, {}) // "none"
 */
export function rowScaling(row, plugin = {}) {
  return row.scaling ?? plugin.scaling?.[row.key] ?? SHARED_SCALING[row.key] ?? "none";
}

/**
 * Pure function. The value a property takes when the gesture's factor is `k` —
 * THE ONE PLACE A BEHAVIOUR BECOMES ARITHMETIC.
 *
 * NON-NUMBERS PASS THROUGH UNTOUCHED, and that is the SAME rule the geometry seam
 * already applies one module over (web/canvas/dragKinds.js: "ONLY A FREE NUMBER IS
 * TRANSLATED"). A property may hold an EQUATION STRING, and multiplying one gives
 * `"= a.w" * 2` → NaN, which would destroy the binding and paint nothing. Passing it
 * through means the equation survives the gesture and keeps driving the value — the
 * author bound it precisely so it would not be written by hand.
 *
 * A BAD BEHAVIOUR THROWS. A misspelled behaviour that read as "none" would be a
 * property that silently stopped scaling, which is the quiet wrongness this codebase
 * forbids — the reader would see a slightly wrong picture and no error.
 *
 * @param {*} value - the property's current value
 * @param {string} behavior - a member of SCALING_BEHAVIORS
 * @param {number} k - the gesture's scale factor
 * @returns {*} the scaled value
 *
 * @example scaledValue(4, "linear", 2.5) // 10
 * @example scaledValue(0.8, "none", 2.5) // 0.8
 * @example // an EQUATION survives — scaling drives the equation's inputs, not its result:
 * @example scaledValue("= title.w / 4", "linear", 2) // "= title.w / 4"
 * @example scaledValue(undefined, "linear", 2) // undefined (an absent property gains nothing)
 * @example // the identity is EXACT, so a zero-travel gesture writes nothing:
 * @example scaledValue(7, "linear", 1) // 7
 */
export function scaledValue(value, behavior, k) {
  if (!SCALING_BEHAVIORS.includes(behavior))
    throw new Error(`Unknown scaling behavior ${JSON.stringify(behavior)} — declare one of: ${SCALING_BEHAVIORS.join(", ")}. (A row says this with \`scaling: "linear"\`; see core/scaling.js.)`);
  if (behavior === "none" || typeof value !== "number") return value;
  return value * k;
}

/**
 * Pure function. THE WHOLISTIC WRITE SET for one item: the [key, value] pairs a
 * scale of `k` adds BESIDE the geometry the gesture already writes.
 *
 * WHAT IS DELIBERATELY NOT HERE: x/y/w/h. Those are the gesture's own output
 * (dragKinds' scaleMemberPairs), and emitting them here too would apply `k` twice.
 * This function's whole job is the REST of the widget — which is why SHARED_SCALING
 * has no entry for them and why an author cannot accidentally add one that matters:
 * a plugin declaring `scaling: {w: "linear"}` would be answered here, so the caller
 * that merges these pairs is the place that keeps geometry authoritative.
 *
 * A KEY WHOSE VALUE DOES NOT CHANGE EMITS NO PAIR, which is the minimal-delta law
 * every other write seam in the app obeys (core/deltas.diffState): a coordinate that
 * did not move must not be written, or a stored equation is silently replaced by a
 * literal. At k === 1 this returns [] exactly, so a zero-travel wholistic gesture is
 * byte-identical to no gesture.
 *
 * @param {object} state - the item's raw stored state
 * @param {object} plugin - its plugin (inspector rows + optional `scaling` table)
 * @param {number} k - the gesture's scale factor
 * @returns {Array<[string, *]>} [key, newValue] pairs, in inspector-row order
 *
 * @example // a stroked, rounded rect scaled x2 grows its stroke and its corners:
 * @example wholisticPairs({strokeWidth: 3, cornerRadius: 8, opacity: 0.5}, {inspector: [{key: "strokeWidth", kind: "number"}, {key: "cornerRadius", kind: "number"}, {key: "opacity", kind: "number"}]}, 2) // [["strokeWidth", 6], ["cornerRadius", 16]]
 * @example // the opacity above is ABSENT from the result — dimensionless, so untouched
 * @example // a text widget's font size is `size`, and it scales:
 * @example wholisticPairs({size: 48}, {inspector: [{key: "size", kind: "number"}]}, 1.5) // [["size", 72]]
 * @example // the identity writes NOTHING, so no stored equation is disturbed:
 * @example wholisticPairs({strokeWidth: 3}, {inspector: [{key: "strokeWidth", kind: "number"}]}, 1) // []
 * @example // a widget that declares nothing scalable is unchanged — today's behaviour:
 * @example wholisticPairs({wobbleFreq: 4}, {inspector: [{key: "wobbleFreq", kind: "number"}]}, 2) // []
 */
export function wholisticPairs(state, plugin, k) {
  const pairs = [];
  for (const row of plugin.inspector ?? []) {
    const before = readKey(state, row.key);
    const after = scaledValue(before, rowScaling(row, plugin), k);
    if (after !== before) pairs.push([row.key, after]);
  }
  return pairs;
}

/**
 * Pure function. The value a DOTTED inspector key names in stored state — `"shadow.
 * blur"` is stored NESTED (`{shadow: {blur: 4}}`), not under a literal dotted key.
 *
 * IT EXISTS BECAUSE THE FLAT READ WAS WRONG AND SILENTLY SO. `state["shadow.blur"]`
 * is `undefined` for every widget in the app, and `scaledValue(undefined, …)` returns
 * `undefined`, which equals the value read — so `wholisticPairs` emitted NO PAIR and
 * every shadow offset, shadow blur, inner-shadow offset and bloom radius quietly
 * failed to scale. Eleven of the shared table's fifteen lengths are dotted keys, so
 * the flat read would have disabled most of the feature while every test that used a
 * flat key still passed. Caught by writing the doctest for the dotted case.
 *
 * A local re-implementation rather than an import of core/deltas.getPath: that module
 * is about DELTAS and this needs three lines of plain traversal, so importing it
 * would couple the scaling table to the delta machinery for nothing.
 *
 * @param {object} state - the item's raw stored state
 * @param {string} key - an inspector key, possibly dotted
 * @returns {*} the stored value, or undefined
 *
 * @example readKey({strokeWidth: 3}, "strokeWidth") // 3
 * @example readKey({shadow: {blur: 4, dx: 2}}, "shadow.blur") // 4
 * @example readKey({}, "shadow.blur") // undefined (an absent branch, not a throw)
 */
function readKey(state, key) {
  let cur = state;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Pure function. WHICH OF A PLUGIN'S NUMBER ROWS HAVE AN ANSWER — the gap made
 * COUNTABLE.
 *
 * WHY THIS EXISTS. The header's measurement (913 of 1303 number keys live in one
 * plugin each) means wholistic coverage is a long tail that will be filled in over
 * many sessions, and an unanswered row is INVISIBLE by construction: it simply does
 * not scale, exactly as it does not today. This turns "which rows still need
 * declaring" from a thing nobody can see into a list. Its CALLER walks the roster;
 * this function is handed one plugin and touches nothing but that argument and the
 * module constant above, so it is pure — it was labelled "Query (reads a live
 * registry)" and this module imports NOTHING, which made the label unsatisfiable.
 *
 * ONLY NUMBER ROWS ARE COUNTED. An angle row is structurally answered (rowScaling
 * returns "none" for it with nothing declared), and a colour/boolean/select row has
 * no arithmetic to do, so counting them would inflate the denominator with rows that
 * were never a question.
 *
 * @param {object} plugin - a registered plugin
 * @returns {{answered: string[], unanswered: string[]}} number-row keys, split
 *
 * @example // every row declared, one way or another:
 * @example scalingCoverage({inspector: [{key: "strokeWidth", kind: "number"}, {key: "opacity", kind: "number"}]}) // {answered: ["strokeWidth", "opacity"], unanswered: []}
 * @example // a widget-local length nobody has classified yet shows up as a gap:
 * @example scalingCoverage({inspector: [{key: "tipLength", kind: "number"}]}) // {answered: [], unanswered: ["tipLength"]}
 * @example // and declaring it closes the gap:
 * @example scalingCoverage({inspector: [{key: "tipLength", kind: "number", scaling: "linear"}]}) // {answered: ["tipLength"], unanswered: []}
 */
export function scalingCoverage(plugin) {
  const answered = [], unanswered = [];
  for (const row of plugin.inspector ?? []) {
    if (row.kind !== "number") continue;
    const declared = row.scaling ?? plugin.scaling?.[row.key] ?? SHARED_SCALING[row.key];
    (declared === undefined ? unanswered : answered).push(row.key);
  }
  return { answered, unanswered };
}
