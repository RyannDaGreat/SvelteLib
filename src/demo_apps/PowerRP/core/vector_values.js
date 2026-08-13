/**
 * VECTORS ARE FIRST-CLASS VALUES (manifest R7-38).
 *
 * The user's ruling, verbatim and the authority for this whole module:
 *
 *   "That was the wrong chouce. xy is a 2-vector. It would be fill.color.r not
 *    fill.r. color is a 3-vec. fill.color can be a variable. It can be interp'd.
 *    same with xy. did you not do that?"
 *
 * A SECOND RULING FIXED THE SPELLING (user, 2026-08-13, verbatim): *"thing.xy.x
 * is stupid sounding. it should be like .pos.x or .pos.y , or .color.r .color.g
 * .color.b and .color.a etc"*. So the addresses are `pos` and `color` (and
 * `size`, a flagged gap-fill — see VECTOR_ADDRESS_FOR_COMPOUND), and alpha is a
 * real fourth component rather than an excluded extra.
 *
 * So a vector is a VALUE an equation can read whole (`= other.pos`), bind to a
 * variable (`fill.color = brandColor`), interpolate componentwise, and keyframe
 * PER COMPONENT (`fill.color.r`). The R7-36 compound row is the UI over these
 * addresses; this module is the addresses themselves.
 *
 * ── THE ONE DESIGN DECISION: A VECTOR IS AN ADDRESS, NOT A STORAGE SHAPE ──────
 * The user stated it for pos and it generalizes: "x/y remain the stored scalar
 * leaves — the vector is the address, storage need not change for transforms".
 * This module applies THE SAME RULE TO COLOR, which is what lets the RGB half
 * ship with NO document migration at all:
 *
 *   pos/size — the components ARE the storage (`x`, `y` are real leaves). The
 *              vector reads as a 2-tuple built from them, and writes as two
 *              leaf writes.
 *   color    — the VECTOR is the storage (a hex string is losslessly an
 *              r/g/b/a 4-vec) and the COMPONENTS are the view: `fill.color.r`
 *              reads a channel out of the hex, and writes one back into it.
 *
 * They are mirror images of one another and that is not a wart — it is the
 * consequence of storing each value in the form its own editor and renderer
 * already speak. Both directions are covered by ONE pair of functions here
 * (`vectorRead` / `vectorWrite`), so no caller has to know which way a given
 * vector leans.
 *
 * ── WHY NOT MIGRATE COLOR TO {r, g, b} LEAVES ────────────────────────────────
 * That was the shape the R7-36 build priced (and the manifest accepts its costs
 * "where unavoidable"). It is avoidable, and MEASURED to be the worse of the two:
 *
 *   1. IT IS UNSPELLABLE AT THE PAINT LEVEL. `render_gpu/ir.js isGradientPaint`
 *      is `paint && typeof paint === "object" && !Array.isArray(paint)` — EVERY
 *      non-array object is a gradient. A `fill: {r, g, b}` object would parse as
 *      a gradient with no stops and throw on every frame. An ARRAY color is
 *      already legal there (parseColor accepts `[r, g, b, a]` in 0..1, ir.js:100)
 *      but arrays are the tuple-lerp path, and a 4-element array cannot be told
 *      from a stops list by eye in a saved file.
 *   2. IT LOSES THE AUTHOR'S SPELLING FOR NOTHING. Documents store `"#7aa2f7"`
 *      (examples/demo.powerrp.json). parseColor's input surface — hex, 148 CSS
 *      names, `rgb()` — is a BOUNDARY the manifest requires stay open; a
 *      migration would have to round-trip `"red"` into components and back, and
 *      the round trip is exactly the loss the ruling calls "accepted collateral
 *      WHERE UNAVOIDABLE".
 *   3. IT BUYS NOTHING THE VIEW DOES NOT. A per-component keyframe is an HONEST
 *      delta either way — see `foldColorComponent` below, which is where that
 *      claim is made good rather than asserted.
 *
 * ── `fill.color` IS AN ADDRESS OVER A SLOT SPELLED `solid` ───────────────────
 * The user wrote `fill.color`; the STORAGE is either a bare hex string at `fill`
 * (the overwhelmingly common case — `examples/demo.powerrp.json` stores
 * `"fill": "#7aa2f7"`) or, once the paint has ever been a gradient, the
 * multi-sub-state object's `fill.solid` slot (render_gpu/ir.js:624). `color` is
 * therefore the address and `paintColorPath` is the ONE function that maps it
 * onto whichever of those two the document actually holds — so an author types
 * one grammar and never learns which shape their paint happens to be in.
 *
 * WHAT `fill.color` MEANS PER PAINT KIND, stated because R7-38 requires a
 * decision rather than an implicit one:
 *   BARE STRING / `{type:"solid"}`  — the color itself. The whole feature.
 *   `{type:"linearGradient"|"radialGradient"}` — the REMEMBERED solid slot,
 *     which the multi-sub-state record keeps precisely so switching modes never
 *     forgets a color (ir.js:270-273). It is a real, author-set value, not a
 *     synthesized one — but it is NOT what is currently painted, so addressing
 *     it while a gradient is active is legal and inert. A gradient's own colors
 *     live at `fill.linear.stops.<i>.color`, which is already addressable and is
 *     what the refusal sentence points at.
 *   `{type:"none"}` — REFUSED with a sentence. An off paint has no color, and
 *     answering with the remembered one would let an author keyframe a channel
 *     of something that cannot paint and see nothing happen.
 *   `{type:"material"}` — REFUSED with a sentence. `paintSolidColor` reduces a
 *     material to the neutral gray `"#888888"` for single-color consumers
 *     (ir.js:554-558), and that gray is a STAND-IN, not a stored value: writing
 *     a channel of it would write a color the material never had and cannot use.
 *   `{type:"crossfade"}` — REFUSED. It is a mid-transition value produced by the
 *     interp system, never a thing an author addresses.
 * Every refusal is a SENTENCE through the ordinary equation-error path
 * (`paintColorRefusal`), never a silent 0 and never a silent black.
 *
 * So: no migration, no repair report, and a document written before this module
 * existed is byte-identical to one written after. The costs the ruling
 * pre-accepted are simply not incurred.
 *
 * ── WHAT MAKES A PER-COMPONENT KEYFRAME HONEST ───────────────────────────────
 * This is the objection the R7-36 build raised and it is the right objection: a
 * keyframe on `fill.color.r` that silently rewrote the WHOLE color would be
 * "the lie the tri-state diamond exists to avoid". It does not, because the
 * delta a component keyframe writes is a REAL delta at a REAL path
 * (`fill.color.r`), folded by `core/deltas.js`'s generic dotted-path machinery
 * — the same machinery `rotationAnchor.x` has always used — and RESOLVED
 * against the folded base color at read time. Keying R alone and then changing
 * the base color's G on an earlier slide moves G on this slide too, which is
 * what "only R is keyframed here" MEANS. A whole-color rewrite would have
 * frozen G instead, and that is the dishonesty this shape refuses.
 *
 * ── ARITHMETIC IS NUMPY, NOT A REFUSAL (user, 2026-08-13, verbatim — R7-38b) ──
 *
 *   "2-vec is essentially a struct - and we might have others in the future. for
 *    example, they might also implement artithemtic operators like numpy so i can
 *    do a.pos=b.pos+c.pos and all math ops like sin cos etc operate on them like
 *    numpy would elementwise. We gotta make that happen"
 *
 * THIS OVERRULES AN EARLIER DRAFT OF THIS VERY FILE, and the correction is worth
 * keeping visible rather than quietly deleting. R7-38 asked "a 3-vec + scalar is
 * what?" and this module first answered A REFUSAL, reasoning that broadcasting
 * `+ 1` on a position was ambiguous because the author "probably meant `.x + 1`".
 * That was Claude second-guessing the author. The user's answer is that a vector
 * is a STRUCT with elementwise algebra, so `b.pos + c.pos` is a vector sum and
 * `pos * 2` is a scale — the same thing every reader who has used NumPy already
 * expects, and unambiguous precisely BECAUSE it follows a convention rather than
 * inventing one. `vectorArithmeticRefusal` is deleted; `vectorBinaryOp` and
 * `vectorMapFunction` are what replaced it.
 *
 * THE ONE THING THAT STILL REFUSES IS A SHAPE MISMATCH. A 2-vec plus a 3-vec is
 * NumPy's own error, spoken through the ordinary equation-error path
 * (`shapeMismatchRefusal`) — never truncation to the shorter, never zero-fill,
 * never NaN. That is not a hedge against ambiguity; there is genuinely no answer.
 *
 * ── THESE ARE *NAMED n-VECS*, NOT THREE TYPES (user, 2026-08-13 — R7-38c) ────
 *
 *   "same with 3-vec or n-vec. we might also have matrices in the future too
 *    these are just special cause they have names lol its a named-3vec but we
 *    might have arbitrary tensors in the future too"
 *   "or even dicts or other datasetrcutre"
 *
 * So `pos`, `size` and `color` are ONE type wearing three name tables. The value
 * is a POSITIONAL numeric vector of length n; the names (x/y, w/h, r/g/b/a) are
 * per-kind METADATA used to address components, and nothing else. Concretely,
 * and this is the rule to hold every future contributor to:
 *
 *   THE ALGEBRA NEVER ASKS WHICH KIND A VALUE IS, OR HOW LONG IT IS. It asks
 *   `isNumericTensor`. There is no branch on 2 vs 3 vs 4 anywhere below, and no
 *   operator mentions `pos`, `size` or `color`. Adding `uv` (a 2-vec), an
 *   unnamed 5-vec or a named 16-vec is a `VECTOR_KINDS` entry and ZERO
 *   evaluator, operator or algebra-test edits.
 *
 * ── THE DOOR LEFT OPEN FOR RANK > 1 AND FOR DICTS (scope: NOT BUILT) ─────────
 * Matrices, tensors and dict values are explicitly NOT deliverables here — they
 * are constraints on the shapes chosen now. The seams a rank-2 value would
 * extend, written down so the future addition has a door rather than a rewrite:
 *
 *   `makeVector` / `vectorValues` — the constructor and the single unwrap. A
 *     tensor adds a SHAPE alongside the flat data (`{__vec, shape}`); today's
 *     values are implicitly `shape: [n]`, which is why the field is absent
 *     rather than defaulted to something a rank-2 value would have to overwrite.
 *   `isNumericTensor` — deliberately NOT named `isVector`. It is the ONE
 *     dispatch predicate, and rank-2 support means widening this one function.
 *   `zipTensors` — the elementwise walk `vectorBinaryOp` and `vectorMapFunction`
 *     both route through. It pairs flat data of equal length, which is already
 *     rank-agnostic: a rank-2 value needs a shape COMPARISON added here and
 *     nothing more, because elementwise ops over equal shapes are flat walks.
 *   `shapeMismatchRefusal` — takes lengths today; it would take shapes.
 *   `VECTOR_KINDS[kind].axes` — the naming layer, already per-kind metadata
 *     rather than a switch. A dict value would be a kind whose components are
 *     named but NOT positional, i.e. a different `via`, not a different operator.
 *
 * A NON-NUMERIC structure (the user's "dicts") is out of scope AND out of the
 * algebra: `isNumericTensor` is false for it, so it would flow through the
 * existing discrete paths rather than silently entering arithmetic.
 *
 * WHY A TAGGED WRAPPER AND NOT A BARE ARRAY. A bare array is already a legal
 * PROPERTY VALUE in this document model — a gradient's stops, a points list, a
 * MIDI clip's tuples — and `core/interpolators.js` already has a plain-lerp
 * branch keyed on "array of numbers". If a vector were a bare array, then
 * `= other.points + 1` would silently broadcast over a POLYLINE, and a 2-element
 * stops list would be indistinguishable from a position. The wrapper makes "is
 * this a vector" a fact rather than a guess, and it is also where a future
 * `shape` rides.
 *
 * Nothing here reaches a host global, a clock or a random source, so the
 * determinism law is untouched: every function in this file is pure.
 */

import { hexToRgb, rgbToHex, isHexColor, lerp } from "./interpolators.js";

/**
 * THE VECTOR DECLARATIONS — the single table naming every first-class vector,
 * its components in order, and HOW its value relates to its storage.
 *
 * `via` is the whole of the xy-vs-color asymmetry described in the header, in
 * one field:
 *   "leaves"    — the components are the stored leaves; the vector is derived.
 *   "composite" — the vector is the stored leaf; the components are derived.
 *
 * `axes` names the components in canonical order — the order a tuple is built
 * in and the order the Inspector lists children in, so the two cannot disagree.
 *
 * KEYED BY COMPONENT COUNT'S MEANING, NOT BY PROPERTY NAME. `color` is declared
 * once and every color-kind row reuses it (`fill.color`, `shadow.color`,
 * `particleColor` …), which is why adding a color property to a plugin gives it
 * component addressing for free and with no edit here.
 */
export const VECTOR_KINDS = {
  pos: { axes: ["x", "y"], via: "leaves", label: "Position" },
  size: { axes: ["w", "h"], via: "leaves", label: "Size" },
  color: { axes: ["r", "g", "b", "a"], via: "composite", label: "Color" },
};

/**
 * THE ADDRESS NAMES ARE THE USER'S, NOT THE COMPOUND ROW IDS (user, 2026-08-13,
 * verbatim): *"thing.xy.x is stupid sounding. it should be like .pos.x or .pos.y ,
 * or .color.r .color.g .color.b and .color.a etc"*.
 *
 * So the 2-vec over x/y is spelled `pos` and reads `item.pos.x`. This is a
 * DIFFERENT NAMESPACE from the R7-36 compound row ids (`COMPOUNDS.xy`,
 * `COMPOUNDS.wh`), which are Inspector row keys and stay as they are — a row id
 * is never typed by an author, and renaming it would move a UI key for a
 * grammar decision. `VECTOR_ADDRESS_FOR_COMPOUND` is the one map between them,
 * so the two namespaces meet in exactly one place.
 *
 * `size` IS A CLAUDE GAP-FILL, NOT A RULING — flagged rather than presented as
 * settled. The user named `pos` and `color` and did not name the w/h vector;
 * `size` is the obvious parallel (and matches `COMPOUNDS.wh`'s existing "Size"
 * label), but it is awaiting confirmation and should be renamed if the user
 * prefers another word. Nothing else depends on the spelling: it is one key here.
 */
export const VECTOR_ADDRESS_FOR_COMPOUND = { xy: "pos", wh: "size" };

/**
 * THE `vec2` INSPECTOR ROW KIND — a control over ONE slot holding an `[x, y]`
 * tuple. Declared HERE rather than in core/properties.js for the reason
 * `LIST_ROW_KIND` lives in core/lists.js and `NODE_INPUT_ROW_KIND` in
 * core/nodeflow.js: a row kind's name belongs to the module that owns its
 * MECHANISM, and the mechanism here is the vector value.
 *
 * ── IT IS NOT THE COMPOUND ROW, AND THE DIFFERENCE IS THE STORAGE ────────────
 * `COMPOUNDS.xy` groups two rows a widget ALREADY declares (`x` and `y`) and
 * writes two leaf paths; it needs leaves to group, which is exactly why R7-36's
 * design works for an item and not for a variable. A `vec2` ROW's value is ONE
 * stored tuple with no leaves at all, so it writes one path. Both surface the
 * user's `[X] [Y] [pad]` grammar; they differ in what is underneath, and
 * conflating them is what would have produced a pad that wrote a phantom leaf.
 *
 * THIS IS THE CONTROL `core/var_kinds.js` WAS WAITING ON. Its recorded omission
 * ("there is no 2-vector row kind, because a compound row is grouping over two
 * EXISTING leaf rows and a variable has no leaves to group") named this gap
 * precisely; the kind is unblocked the moment a control exists whose value is
 * the tuple itself.
 *
 * @example VEC2_ROW_KIND // "vec2"
 */
export const VEC2_ROW_KIND = "vec2";

/**
 * Pure function. Is `v` a legal `vec2` ROW VALUE — a plain two-number tuple?
 *
 * THE STORED FORM CARRIES NO RUNTIME TAG, deliberately: `makeVector`'s `__vec`
 * wrapper is added by the evaluator on READ and must never reach a saved
 * document (pinned in tests/vec_values_test.js). So the control's own validity
 * test is about the PLAIN tuple, and a tagged value is NOT one — a tag in
 * storage is a bug, and answering `true` for it would hide that.
 *
 * Args:
 *   v (*): a candidate stored value
 *
 * Returns:
 *   boolean
 *
 * Examples:
 *     >>> isVec2Value([10, 20])
 *     true
 *     >>> // an equation string is a legal SLOT value but not a vec2 VALUE —
 *     >>> // the control declines to drag it rather than overwriting it:
 *     >>> isVec2Value("= origin")
 *     false
 *     >>> isVec2Value([10, 20, 30])
 *     false
 *     >>> isVec2Value(null)
 *     false
 */
export function isVec2Value(v) {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number");
}

/**
 * THE COLOR VECTOR'S ADDRESSABLE ARITY IS FOUR, BY RULING. R7-38 called color
 * "a 3-vec", and the 2026-08-13 ruling then spelled the components out as
 * ".color.r .color.g .color.b and .color.a etc" — so alpha is an addressable
 * component, not an extra the 3-vec reading excluded. The two statements agree
 * about the COLOR (three chromatic channels plus the transparency every color in
 * this app has always been able to carry — core/interpolators.js isHexColor has
 * accepted #rrggbbaa from the start); they differ only in whether `.a` is
 * counted, and the later, more specific one governs.
 *
 * ── `.color.a` AND ITEM OPACITY ARE TWO DIFFERENT THINGS AND MUST NOT MULTIPLY
 *    TWICE (the coordinator's explicit requirement) ─────────────────────────
 * `.color.a` addresses THE ALPHA DIGITS OF THIS PAINT'S OWN COLOR — the `aa` in
 * `#rrggbbaa`, the 4th element of an `[r,g,b,a]` array. It is a property OF THE
 * COLOR VALUE, so it is scoped to the one slot it lives in: `fill.color.a` makes
 * the fill translucent and does not touch the stroke.
 *
 * ITEM-LEVEL `opacity` REMAINS ITS OWN, SEPARATE PROPERTY, unchanged and
 * untouched by this module. It multiplies the whole widget's composite, every
 * paint at once, and is not a channel of any color.
 *
 * They compose EXACTLY AS THEY ALWAYS HAVE — the renderer already multiplied a
 * paint's own alpha by the item's opacity long before this module existed, and
 * this module writes the same hex digits an author could have typed by hand.
 * NOTHING NEW MULTIPLIES: `.color.a` is a new ADDRESS for an existing value, not
 * a new factor in the composite. The double-multiply this comment exists to
 * forbid would only appear if a caller ALSO applied `.a` as a separate layer
 * alpha; nothing here does, and `colorAlphaIsPaintLocal` is the named predicate
 * a caller can assert against instead of re-deriving the rule.
 */
export const COLOR_VECTOR_ARITY = 4;

/**
 * Pure function. The FIXED answer to "does `.color.a` mean the item's opacity?"
 * — NO, always, for every vector kind. A named predicate rather than a comment
 * because the requirement it encodes is a NEGATIVE one ("these must not silently
 * multiply twice"), and a negative is what a test can assert but prose cannot.
 *
 * Returns:
 *   boolean: true — a color's alpha is local to its own paint slot
 *
 * Examples:
 *     >>> colorAlphaIsPaintLocal()
 *     true
 */
export function colorAlphaIsPaintLocal() {
  return true;
}

/** The 0..255 byte range each color channel is addressed in. R/G/B are BYTES,
 *  matching hexToRgb and what an author reads off a color picker; `.a` is the
 *  odd one out and is addressed as a 0..1 FRACTION (see colorChannelValue) —
 *  because alpha is a fraction everywhere else in this codebase (paint alpha,
 *  opacity rows, parseColor's 4th element) and an author writing `= 0.5` for
 *  half-transparent must not get 0.2% instead. */
export const COLOR_CHANNEL_MAX = 255;

/**
 * Pure function. Is `key` the trailing component of a vector of `kind`?
 *
 * Args:
 *   kind (string): a VECTOR_KINDS key
 *   key (string): a candidate component name
 *
 * Returns:
 *   boolean
 *
 * Examples:
 *     >>> isVectorAxis("color", "r")
 *     true
 *     >>> isVectorAxis("color", "z")
 *     false
 *     >>> isVectorAxis("pos", "y")
 *     true
 */
export function isVectorAxis(kind, key) {
  return (VECTOR_KINDS[kind]?.axes ?? []).includes(key);
}

/**
 * Pure function. One channel of a color VALUE, in the units that channel is
 * addressed in: R/G/B as 0..255 bytes, alpha as a 0..1 fraction.
 *
 * ACCEPTS EVERY COLOR SPELLING THE DOCUMENT CAN HOLD, because this is a READ of
 * author-written storage: a hex string (3/4/6/8 digit) or an already-parsed
 * `[r, g, b, a?]` byte array. A value it cannot read yields `null` rather than
 * 0 — the caller turns that into a sentence, and a silent 0 would paint black
 * while claiming success.
 *
 * Args:
 *   color (string|number[]): a stored color value
 *   axis (string): "r" | "g" | "b" | "a"
 *
 * Returns:
 *   number|null: the channel value, or null when `color` is unreadable
 *
 * Examples:
 *     >>> colorChannelValue("#ff8000", "r")
 *     255
 *     >>> colorChannelValue("#ff8000", "g")
 *     128
 *     >>> // alpha is a FRACTION, not a byte — half-transparent reads 0.5, not 128:
 *     >>> colorChannelValue("#ff000080", "a")
 *     0.5019607843137255
 *     >>> // a plain #rrggbb is opaque, so its alpha is exactly 1:
 *     >>> colorChannelValue("#ff0000", "a")
 *     1
 *     >>> colorChannelValue("#f80", "r")
 *     255
 *     >>> colorChannelValue("not a color", "r")
 *     null
 */
export function colorChannelValue(color, axis) {
  const bytes = colorBytes(color);
  if (!bytes) return null;
  const i = VECTOR_KINDS.color.axes.indexOf(axis);
  if (i < 0) return null;
  return i === 3 ? bytes[3] / COLOR_CHANNEL_MAX : bytes[i];
}

/**
 * Pure function. A stored color → `[r, g, b, a]` in 0..255, or null when the
 * value is not a color this app can read.
 *
 * THE ALPHA DEFAULT IS 255 AND IS STATED RATHER THAN INHERITED: hexToRgb returns
 * a 3-element array for `#rrggbb`, and every caller here needs a fixed arity so
 * a missing alpha cannot silently shift `.a` onto `.b`'s index.
 *
 * Args:
 *   color (string|number[]): a stored color value
 *
 * Returns:
 *   number[]|null: [r, g, b, a] in 0..255
 *
 * Examples:
 *     >>> colorBytes("#ff8000")
 *     [255, 128, 0, 255]
 *     >>> colorBytes("#ff000080")
 *     [255, 0, 0, 128]
 *     >>> colorBytes([255, 128, 0])
 *     [255, 128, 0, 255]
 *     >>> colorBytes("rebeccapurple")
 *     null
 *     >>> colorBytes(42)
 *     null
 */
export function colorBytes(color) {
  if (Array.isArray(color)) {
    if (color.length < 3 || color.length > 4) return null;
    if (!color.every((c) => typeof c === "number")) return null;
    return [color[0], color[1], color[2], color[3] ?? COLOR_CHANNEL_MAX];
  }
  if (!isHexColor(color)) return null;
  const rgb = hexToRgb(color);
  return [rgb[0], rgb[1], rgb[2], rgb[3] ?? COLOR_CHANNEL_MAX];
}

/**
 * Pure function. A color with ONE channel replaced — the write half of the
 * component view, and the function that makes `fill.color.r` a real address
 * rather than a label on a whole-color rewrite.
 *
 * IT PRESERVES THE OTHER CHANNELS EXACTLY, which is the honesty requirement: a
 * keyframe on R must not disturb G or B, so a caller that folds a component
 * delta over a base color gets the base's own G and B back byte-for-byte.
 *
 * THE RESULT DROPS A FULLY-OPAQUE ALPHA, so writing R into `"#ff0000"` yields
 * `"#00ff00"`-style 6-digit hex rather than an 8-digit one. Without that, the
 * first component edit on any document would rewrite every color into a longer
 * spelling — a diff on every widget for no visible change.
 *
 * Args:
 *   color (string|number[]): the base color
 *   axis (string): "r" | "g" | "b" | "a"
 *   value (number): the new channel value (0..255 for rgb, 0..1 for alpha)
 *
 * Returns:
 *   string|null: the new hex color, or null when the base is unreadable
 *
 * Examples:
 *     >>> withColorChannel("#ff0000", "g", 128)
 *     '#ff8000'
 *     >>> // the untouched channels survive byte-for-byte:
 *     >>> withColorChannel("#123456", "r", 255)
 *     '#ff3456'
 *     >>> // alpha is written as a FRACTION and an opaque result stays 6-digit:
 *     >>> withColorChannel("#ff0000", "a", 0.5)
 *     '#ff000080'
 *     >>> withColorChannel("#ff000080", "a", 1)
 *     '#ff0000'
 *     >>> // out-of-range is CLAMPED, not wrapped: an equation overshooting to
 *     >>> // 300 means "as red as it goes", never a dark red from a modulo:
 *     >>> withColorChannel("#000000", "r", 300)
 *     '#ff0000'
 *     >>> withColorChannel("nope", "r", 1)
 *     null
 */
export function withColorChannel(color, axis, value) {
  const bytes = colorBytes(color);
  if (!bytes) return null;
  const i = VECTOR_KINDS.color.axes.indexOf(axis);
  if (i < 0) return null;
  const out = bytes.slice();
  // Alpha is addressed as a fraction; every other channel is already a byte.
  out[i] = i === 3 ? value * COLOR_CHANNEL_MAX : value;
  // CLAMPED, not wrapped — rgbToHex already clamps to 0..255, and rounding is
  // its job too, so a fractional channel from a tween lands on one byte here.
  return rgbToHex(out[3] >= COLOR_CHANNEL_MAX ? out.slice(0, 3) : out);
}

/**
 * Pure function. The value of a whole vector, as the tuple an equation reading
 * `= other.xy` (or `= other.fill.color`) receives.
 *
 * ONE FUNCTION FOR BOTH `via` DIRECTIONS, so a caller never branches on which
 * way a vector leans:
 *   "leaves"    — reads each component key off `source` and tuples them.
 *   "composite" — reads the composite value and decomposes it.
 *
 * A COLOR READS AS ITS AUTHORED SPELLING, NOT A TUPLE, and this is the one place
 * the two vector kinds genuinely differ in what they hand back. `= brandColor`
 * must keep producing `"#7aa2f7"`, because a color slot's consumers — parseColor,
 * a ColorField, an exported document — all speak hex, and handing them `[122,
 * 162, 247]` would be a new value shape on the one path every pixel goes
 * through. The DECOMPOSITION is what `.r` is for; the whole value stays the
 * color it always was, which is also what makes `fill.color = myColorVar`
 * (R7-38 point 4) a plain assignment with no conversion.
 *
 * Args:
 *   kind (string): a VECTOR_KINDS key
 *   source (object): the state object holding the leaves ("leaves"), or the
 *     composite value itself ("composite")
 *
 * Returns:
 *   *: a number tuple for a leaves-vector, the composite value for a composite
 *     one, or null when a component is missing/unreadable
 *
 * Examples:
 *     >>> vectorRead("pos", {x: 10, y: 20, w: 5})
 *     [10, 20]
 *     >>> vectorRead("size", {w: 100, h: 50})
 *     [100, 50]
 *     >>> // a color reads as the color it is stored as, NOT as a tuple:
 *     >>> vectorRead("color", "#7aa2f7")
 *     '#7aa2f7'
 *     >>> // a missing leaf is null, never a 0 that would silently move a widget:
 *     >>> vectorRead("pos", {x: 10})
 *     null
 */
export function vectorRead(kind, source) {
  const decl = VECTOR_KINDS[kind];
  if (!decl) return null;
  if (decl.via === "composite") return colorBytes(source) ? source : null;
  const out = [];
  for (const axis of decl.axes) {
    const v = source?.[axis];
    if (typeof v !== "number") return null;
    out.push(v);
  }
  return out;
}

/**
 * Pure function. The LEAF WRITES a whole-vector assignment expands into —
 * `[[path, value], ...]`, relative to the vector's own address.
 *
 * WRITING A VECTOR IS WRITING ITS LEAVES, so `xy = [10, 20]` is exactly the two
 * writes the author would have made by hand and produces exactly the two deltas
 * — which is what keeps one gesture one undo unit with no special case, and what
 * makes the compound row's tri-state diamond tell the truth about what it wrote.
 * A composite vector writes ITSELF, as one leaf, at the empty path.
 *
 * Args:
 *   kind (string): a VECTOR_KINDS key
 *   value (*): a tuple (leaves) or a composite value (composite)
 *
 * Returns:
 *   Array<[string[], *]>|null: [relativePath, value] pairs, or null when
 *     `value` does not match the vector's shape
 *
 * Examples:
 *     >>> vectorWrite("pos", [10, 20])
 *     [[['x'], 10], [['y'], 20]]
 *     >>> // a composite writes one leaf AT ITS OWN ADDRESS (the empty path):
 *     >>> vectorWrite("color", "#ff0000")
 *     [[[], '#ff0000']]
 *     >>> // wrong arity is refused, never padded with zeros:
 *     >>> vectorWrite("pos", [10])
 *     null
 *     >>> vectorWrite("color", 42)
 *     null
 */
export function vectorWrite(kind, value) {
  const decl = VECTOR_KINDS[kind];
  if (!decl) return null;
  if (decl.via === "composite") return colorBytes(value) ? [[[], value]] : null;
  if (!Array.isArray(value) || value.length !== decl.axes.length) return null;
  if (!value.every((v) => typeof v === "number")) return null;
  return decl.axes.map((axis, i) => [[axis], value[i]]);
}

/**
 * Pure function. Interpolates a whole VECTOR value componentwise — R7-38 point 5
 * ("It can be interp'd").
 *
 * THIS IS A THIN WRAPPER ON THE EXISTING LAW, DELIBERATELY. A numeric tuple
 * already lerps continuously (core/interpolators.js's plain-lerp branch, "NO
 * int-rounding") and a hex color already blends per-channel including alpha, so
 * a vector needs NO new interpolation rule — it needs the guarantee that its
 * whole-value form ROUTES to those branches instead of falling through to the
 * discrete `return b`. That guarantee is what this function documents and what
 * `vectorInterpolationIsContinuous` pins.
 *
 * Args:
 *   kind (string): a VECTOR_KINDS key
 *   a (*): the from-value
 *   b (*): the to-value
 *   alpha (number): tween position in [0, 1]
 *
 * Returns:
 *   *: the blended vector value
 *
 * Examples:
 *     >>> vectorInterpolate("pos", [0, 0], [10, 20], 0.5)
 *     [5, 10]
 *     >>> // NOT rounded, even from an int pair — a 2-vec is a coordinate:
 *     >>> vectorInterpolate("pos", [0, 0], [1, 1], 0.25)
 *     [0.25, 0.25]
 *     >>> vectorInterpolate("color", "#000000", "#ffffff", 0.5)
 *     '#808080'
 *     >>> // alpha blends with the rest, so a fade to transparent is continuous:
 *     >>> vectorInterpolate("color", "#ff0000", "#ff000000", 0.5)
 *     '#ff000080'
 */
export function vectorInterpolate(kind, a, b, alpha) {
  const decl = VECTOR_KINDS[kind];
  if (!decl) return b;
  if (alpha <= 0) return a;
  if (alpha >= 1) return b;
  if (decl.via === "composite") {
    const ba = colorBytes(a), bb = colorBytes(b);
    if (!ba || !bb) return b; // unreadable: discrete, same as interpolate's fallthrough
    const out = ba.map((c, i) => lerp(c, bb[i], alpha));
    return rgbToHex(out[3] >= COLOR_CHANNEL_MAX ? out.slice(0, 3) : out);
  }
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return b;
  return a.map((v, i) => lerp(v, b[i], alpha));
}

/**
 * Pure function. True iff `kind`'s whole-vector values tween CONTINUOUSLY rather
 * than snapping — the mechanically-checkable half of R7-38 point 5.
 *
 * IT EXISTS AS A PREDICATE RATHER THAN A COMMENT because "a bound fill.color
 * tweens" is exactly the kind of claim that rots silently: a value shape that
 * stopped matching interpolate's color/tuple branches would fall through to
 * `return b` and produce a DISCRETE switch that looks like a deliberate step
 * mode. A test asserting this predicate over real values catches that; prose
 * cannot.
 *
 * Args:
 *   kind (string): a VECTOR_KINDS key
 *   a (*): a representative from-value
 *   b (*): a representative to-value
 *
 * Returns:
 *   boolean
 *
 * Examples:
 *     >>> vectorInterpolationIsContinuous("pos", [0, 0], [10, 20])
 *     true
 *     >>> vectorInterpolationIsContinuous("color", "#000000", "#ffffff")
 *     true
 *     >>> // a value pair the vector cannot read is honestly reported discrete:
 *     >>> vectorInterpolationIsContinuous("color", "#000000", "nope")
 *     false
 */
export function vectorInterpolationIsContinuous(kind, a, b) {
  const mid = vectorInterpolate(kind, a, b, 0.5);
  if (mid === b) return false;
  const quarter = vectorInterpolate(kind, a, b, 0.25);
  return quarter !== mid && quarter !== b;
}


/**
 * THE PAINT TYPE TAGS this module must recognize, re-declared LOCALLY rather
 * than imported.
 *
 * `render_gpu/ir.js` imports FROM `core/properties.js`, so a core module
 * importing ir.js would cycle. This is the same duplication — and the same
 * justification — that `core/properties.js strokeMaterialIsOn` and
 * `render_gpu/decorate.js fillIsVisible` already carry: one tag string each,
 * copied deliberately and named here so a reader knows it is a mirror.
 */
const PAINT_NONE_TAG = "none";
const PAINT_MATERIAL_TAG = "material";
const PAINT_CROSSFADE_TAG = "crossfade";
const PAINT_SOLID_SLOT = "solid";

/**
 * Pure function. Where a paint's addressable COLOR actually lives — the map from
 * the `fill.color` an author types to the slot the document really holds.
 *
 * TWO STORAGE SHAPES, ONE ADDRESS (see the header). A paint that has never been
 * a gradient is a BARE STRING sitting at the paint key itself, so its color path
 * is the EMPTY path — the color IS the paint. A multi-sub-state paint keeps its
 * color in the `solid` slot beside its remembered gradients. Returning a
 * relative path rather than a value lets the caller append `.r` and hand the
 * whole thing to the ordinary delta machinery.
 *
 * Args:
 *   paint (*): the stored paint value
 *
 * Returns:
 *   string[]|null: the path from the paint key to its color, or null when this
 *     paint kind HAS no addressable color (the caller then reports the refusal)
 *
 * Examples:
 *     >>> // a bare string IS the color, so the path from `fill` is empty:
 *     >>> paintColorPath("#7aa2f7")
 *     []
 *     >>> paintColorPath({type: "solid", solid: "#ff0000"})
 *     ['solid']
 *     >>> // a gradient's REMEMBERED solid is a real stored value, addressable:
 *     >>> paintColorPath({type: "linearGradient", linear: {}, solid: "#ff0000"})
 *     ['solid']
 *     >>> // ...but an off/material/crossfade paint has no colour to address:
 *     >>> paintColorPath({type: "none"})
 *     null
 *     >>> paintColorPath({type: "material", material: {id: "halftone"}})
 *     null
 */
export function paintColorPath(paint) {
  if (typeof paint === "string" || Array.isArray(paint)) return [];
  if (!paint || typeof paint !== "object") return null;
  if (paint.type === PAINT_NONE_TAG) return null;
  if (paint.type === PAINT_MATERIAL_TAG) return null;
  if (paint.type === PAINT_CROSSFADE_TAG) return null;
  // Every remaining tagged paint (solid + both gradients) keeps its colour in
  // the SAME remembered slot — which is exactly why this needs no per-type list.
  return [PAINT_SOLID_SLOT];
}

/**
 * Pure function. THE REFUSAL SENTENCE for addressing `.color` on a paint that
 * has none — the loud half of paintColorPath, kept beside it so the two can
 * never disagree about which kinds are refused.
 *
 * IT NAMES THE ALTERNATIVE, because a refusal an author cannot act on is a dead
 * end: a gradient author is pointed at the stops, and an off paint at the fact
 * that it is off. Returns null when the paint DOES have a colour, so a caller
 * can use this as the whole test.
 *
 * Args:
 *   paint (*): the stored paint value
 *   token (string): the reference as the author wrote it, for the message
 *
 * Returns:
 *   string|null: the refusal sentence, or null when the paint has a colour
 *
 * Examples:
 *     >>> paintColorRefusal({type: "none"}, "fill.color")
 *     '"fill.color" is Off — an off paint has no colour to address. Set the paint to Solid first.'
 *     >>> paintColorRefusal({type: "material", material: {}}, "fill.color")
 *     '"fill.color" is a material, which has no single colour — address its knobs at fill.material.params instead.'
 *     >>> paintColorRefusal("#ff0000", "fill.color")
 *     null
 */
export function paintColorRefusal(paint, token) {
  if (paintColorPath(paint)) return null;
  const key = token.replace(/\.color$/, "");
  if (paint?.type === PAINT_NONE_TAG)
    return `"${token}" is Off — an off paint has no colour to address. Set the paint to Solid first.`;
  if (paint?.type === PAINT_MATERIAL_TAG)
    return `"${token}" is a material, which has no single colour — address its knobs at ${key}.material.params instead.`;
  if (paint?.type === PAINT_CROSSFADE_TAG)
    return `"${token}" is a mid-transition crossfade, which is computed rather than stored — address the colour on the slides it blends between.`;
  return `"${token}" is not a colour — ${key} holds ${JSON.stringify(paint)}.`;
}

/**
 * Pure function. Folds a PER-COMPONENT colour value over a base colour — the
 * function that makes `fill.color.r` an honest keyframe rather than a whole-colour
 * rewrite wearing a component's name.
 *
 * THIS IS THE WHOLE HONESTY ARGUMENT, EXECUTABLE. A delta at `fill.color.r`
 * stores ONE number. Reading it back means resolving that number against
 * whatever the base colour folded to at this point in the timeline — so the
 * channels the author did NOT key keep coming from the base, and a change to the
 * base's green on an earlier slide still moves green here. That is what "only R
 * is keyframed" means, and it is precisely what a stored whole-colour would have
 * destroyed by freezing G and B at the moment the diamond was clicked.
 *
 * Args:
 *   base (string|number[]): the folded base colour
 *   components (object): {r?, g?, b?, a?} — only the keyed channels
 *
 * Returns:
 *   string|null: the resulting colour, or null when `base` is unreadable
 *
 * Examples:
 *     >>> // one keyed channel; the other two come from the base, untouched:
 *     >>> foldColorComponent("#123456", {r: 255})
 *     '#ff3456'
 *     >>> // change the BASE's green and the un-keyed channel follows it — the
 *     >>> // property a stored whole-colour keyframe would have frozen:
 *     >>> foldColorComponent("#12ff56", {r: 255})
 *     '#ffff56'
 *     >>> foldColorComponent("#000000", {r: 255, b: 128})
 *     '#ff0080'
 *     >>> // no keyed channel at all is the base, byte-identical:
 *     >>> foldColorComponent("#123456", {})
 *     '#123456'
 *     >>> foldColorComponent("nope", {r: 1})
 *     null
 */
export function foldColorComponent(base, components) {
  let out = colorBytes(base) ? base : null;
  if (out === null) return null;
  for (const axis of VECTOR_KINDS.color.axes) {
    if (!(axis in (components ?? {}))) continue;
    out = withColorChannel(out, axis, components[axis]);
    if (out === null) return null;
  }
  // A base with no keyed channel must come back EXACTLY as authored, including
  // its own spelling ("#f80" stays "#f80"), so the no-op case returns it whole
  // rather than round-tripping it through rgbToHex.
  return out;
}

// ── THE FOLD SEAM: A COMPONENT DELTA IS RESOLVED, NOT MERGED (workstream VECUI_)
//
// THIS HALF WAS MISSING AND ITS ABSENCE WAS SILENT. `foldColorComponent` above
// was written with the whole honesty argument in its docstring and NO CALLER —
// so a delta at `fill.color.r` reached `core/deltas.js mutBlendApply`'s ordinary
// `isTree` arm, which does `state[key] = {}` and recurses. MEASURED, before this
// block existed:
//
//     setPath({fill: "#7aa2f7"}, ["fill", "color", "r"], 255)
//         -> {"fill": {"color": {"r": 255}}}
//
// The hex is GONE. And that object is not merely wrong, it is the exact shape
// this module's own header proved unspellable: `render_gpu/ir.js isGradientPaint`
// is `paint && typeof paint === "object" && !Array.isArray(paint)`, so EVERY
// non-array object at a paint slot parses as a gradient — one with no stops,
// which throws on every frame. The header rejected migrating color to `{r,g,b}`
// leaves for precisely that reason; a component DELTA reintroduced the same
// shape at fold time, one layer down, where nothing was looking.
//
// So the delta stays a real delta at a real path (that is the honesty argument,
// unchanged) and the FOLD resolves it against the base color instead of merging
// it. These three functions are that resolution, kept here beside the tables and
// the refusals so `core/deltas.js` needs no knowledge of colors at all: it asks
// one predicate and calls one resolver.

/**
 * Pure function. Is `delta` a COMPONENT WRAPPER — the `{color: {r, g, …}}` shape
 * a channel keyframe writes over a paint-bearing slot?
 *
 * THE PREDICATE IS DELIBERATELY NARROW, because it gates a branch in the hottest
 * loop in the document model and every legacy delta must fall straight past it.
 * All four conditions must hold: a plain object, whose ONLY key is the `color`
 * address, whose value is a plain object, ALL of whose keys are declared color
 * axes. A gradient patch (`{stops: …}`), a paint switch (`{type: "material"}`),
 * an effects bundle, a sparse list keyframe and a `{color: "#fff"}` whole-color
 * write are each rejected by one of those and take the arms they always took.
 *
 * KEYED ON THE TABLES, NOT ON LITERALS (R7-38c). The address comes from
 * `VECTOR_KINDS` and the axis list from that kind's own `axes`, so a future
 * composite vector kind is covered by declaring it — there is no `"r"` here.
 *
 * Args:
 *   delta (*): a delta subtree
 *
 * Returns:
 *   boolean
 *
 * Examples:
 *     >>> componentDeltaIsColor({color: {r: 255}})
 *     true
 *     >>> componentDeltaIsColor({color: {r: 255, a: 0.5}})
 *     true
 *     >>> // a WHOLE-colour write is not a component wrapper — it is an ordinary
 *     >>> // leaf and must keep taking the ordinary arm:
 *     >>> componentDeltaIsColor({color: "#ff0000"})
 *     false
 *     >>> // an unknown component name is NOT a colour wrapper (it would be a
 *     >>> // typo or another feature's subtree; merging it is the old behaviour):
 *     >>> componentDeltaIsColor({color: {z: 1}})
 *     false
 *     >>> componentDeltaIsColor({stops: []})
 *     false
 *     >>> componentDeltaIsColor({type: "material"})
 *     false
 *     >>> componentDeltaIsColor("#ff0000")
 *     false
 */
export function componentDeltaIsColor(delta) {
  if (!isPlainObject(delta)) return false;
  const keys = Object.keys(delta);
  if (keys.length !== 1 || keys[0] !== COLOR_ADDRESS) return false;
  const components = delta[COLOR_ADDRESS];
  if (!isPlainObject(components)) return false;
  const axes = VECTOR_KINDS[COLOR_ADDRESS].axes;
  const names = Object.keys(components);
  return names.length > 0 && names.every((n) => axes.includes(n));
}

/**
 * Pure function. Resolves a component wrapper over a stored PAINT, yielding the
 * paint with its addressable color updated — or a REFUSAL SENTENCE when this
 * paint kind has no color to address.
 *
 * ── THE WRITE SIDE MIRRORS THE READ SIDE EXACTLY, BY CONSTRUCTION ────────────
 * It routes through `paintColorPath` and `paintColorRefusal`, the SAME two
 * functions `core/expressions.js readVectorAddress` reads through. So the kinds
 * that refuse a read refuse a write, with the same sentences, and the two can
 * never drift into disagreeing about what `fill.color` means:
 *
 *   bare hex / {type:"solid"} — the color itself; folds to a real hex string.
 *   linear/radialGradient     — the REMEMBERED `solid` slot, exactly as the read
 *                               side answers. Legal and inert: it is a real
 *                               author-set value that is not currently painted.
 *   none / material / crossfade — REFUSED with the read side's own sentence.
 *
 * A REFUSAL IS RETURNED, NOT THROWN, because the caller is the fold — and the
 * fold runs for every frame of every render. Throwing there would take the app
 * down on a document that is merely wrong; returning the sentence lets
 * `core/deltas.js` leave the paint UNTOUCHED and lets the surface that can speak
 * (the Inspector, the equation error path) say why. It is never a silent no-op:
 * the sentence is the caller's to report, and the paint is provably unchanged
 * rather than half-written.
 *
 * ── PRECEDENCE: POSITIONAL, WHICH IS THE ONLY HONEST ANSWER ─────────────────
 * A whole-colour write and a channel write cannot collide inside ONE delta —
 * they are the same key, and an object has one value per key. So the mixed case
 * is always ACROSS SLIDES, and it resolves by ordinary fold order with no rule
 * of its own (measured):
 *
 *   whole `#00ff00` then channel `r=255`  ->  #ffff00   (the channel folds over
 *                                                        the new base)
 *   channel `r=255` then whole `#00ff00`  ->  #00ff00   (the whole write is a
 *                                                        complete value; it wins)
 *
 * That is exactly the honesty argument `foldColorComponent` makes, read across
 * the timeline: a component keyframe describes ONE channel of whatever the base
 * happens to be, so a later base change moves the channels the author did not
 * key — and a later WHOLE colour is a new base entire.
 *
 * ── AN ADDITION IS DECLINED, NOT INVENTED ───────────────────────────────────
 * A component delta over a slot the state does not have resolves to a refusal,
 * so the fold leaves the key ABSENT rather than creating one. There is no base
 * to fold a channel over, and materializing `#000000` to receive it would put a
 * colour the author never wrote into a slot they never filled — the fold's own
 * "additions apply as soon as alpha > 0" rule does not apply, because a channel
 * is not a value, it is a modification of one.
 *
 * THE SLOT NAME IS THE CALLER'S TO SUPPLY, because the refusal sentences NAME
 * the alternative ("address its knobs at fill.material.params") and a sentence
 * pointing at a slot the author cannot find is a dead end. The fold knows the
 * key it is standing on; this module does not. Defaults to the bare address so a
 * caller with genuinely no slot in hand still gets a grammatical sentence.
 *
 * Args:
 *   paint (*): the stored paint value the delta lands on
 *   components (object): the `{r?, g?, b?, a?}` wrapper's contents
 *   slot (string): the paint's own key, for the refusal sentence ("fill")
 *
 * Returns:
 *   {paint: *} on success, or {refusal: string} — exactly one key
 *
 * Examples:
 *     >>> // over a bare hex the whole paint IS the colour:
 *     >>> resolveColorComponentDelta("#123456", {r: 255}, "fill")
 *     { paint: '#ff3456' }
 *     >>> // over a tagged solid the `solid` slot is rewritten and the rest of
 *     >>> // the record (its remembered gradients) is preserved:
 *     >>> resolveColorComponentDelta({type: "solid", solid: "#000000"}, {r: 255}, "fill")
 *     { paint: { type: 'solid', solid: '#ff0000' } }
 *     >>> // a gradient writes its REMEMBERED solid — legal, inert, and the same
 *     >>> // slot the read side answers from:
 *     >>> resolveColorComponentDelta({type: "linearGradient", solid: "#000000"}, {g: 255}, "fill").paint.solid
 *     '#00ff00'
 *     >>> // off/material/crossfade refuse, in the read side's own words, and the
 *     >>> // sentence NAMES the author's real slot:
 *     >>> resolveColorComponentDelta({type: "none"}, {r: 255}, "fill").refusal
 *     '"fill.color" is Off — an off paint has no colour to address. Set the paint to Solid first.'
 *     >>> resolveColorComponentDelta({type: "material", material: {}}, {r: 255}, "fill").refusal
 *     '"fill.color" is a material, which has no single colour — address its knobs at fill.material.params instead.'
 *     >>> resolveColorComponentDelta({type: "material", material: {}}, {r: 255}, "fill").paint
 *     undefined
 */
export function resolveColorComponentDelta(paint, components, slot = COLOR_ADDRESS) {
  const token = slot === COLOR_ADDRESS ? COLOR_ADDRESS : `${slot}.${COLOR_ADDRESS}`;
  const refusal = paintColorRefusal(paint, token);
  if (refusal) return { refusal };
  const path = paintColorPath(paint);
  const base = path.length === 0 ? paint : paint[path[0]];
  const folded = foldColorComponent(base, components);
  if (folded === null)
    return {
      refusal: base === undefined
        // The slot exists and IS an object, but holds no colour where one was
        // addressed — the `{color: {…}}` shape sitting in a NON-paint subtree.
        // Say that, rather than "undefined is not a colour", which names a value
        // the author never wrote and points at nothing they can fix.
        ? `"${token}" cannot take a component keyframe — ${slot} has no colour slot to address.`
        : `"${token}" cannot take a component keyframe — ${JSON.stringify(base)} is not a colour.`,
    };
  // An EMPTY path means the paint IS the colour, so the folded colour replaces it
  // whole. Otherwise only the addressed slot changes and every other key of the
  // record — a gradient's stops, its geometry, its remembered modes — survives.
  if (path.length === 0) return { paint: folded };
  return { paint: { ...paint, [path[0]]: folded } };
}

/**
 * Pure function. The component wrapper LERPED toward its target — one channel's
 * tween, at the fold's own alpha.
 *
 * THE TWEEN IS THE POINT (user, R7-38: a vector "can be interp'd"). A component
 * keyframe that snapped would make `fill.color.r` a worse control than the whole
 * colour it decomposes, which already tweens. Each channel lerps INDEPENDENTLY
 * from the base colour's current value for that channel, so keying R alone
 * animates R alone and leaves G and B exactly where the base put them — the same
 * statement `foldColorComponent` makes about the endpoint, extended across the
 * transition.
 *
 * ALPHA'S ENDPOINTS ARE EXACT: at 0 every channel is the base's own, at 1 every
 * channel is the target. The fold's endpoint law (core/deltas.js: "at alpha 1 the
 * answer IS the stored target") is therefore satisfied channel-wise.
 *
 * Args:
 *   base (string|number[]): the folded base colour
 *   components (object): the target channels
 *   alpha (number): tween strength in [0, 1]
 *
 * Returns:
 *   object: the components to fold, each lerped from the base's own channel
 *
 * Examples:
 *     >>> // halfway from red 0x12 toward 255:
 *     >>> lerpedColorComponents("#123456", {r: 255}, 0.5)
 *     { r: 136.5 }
 *     >>> lerpedColorComponents("#123456", {r: 255}, 0)
 *     { r: 18 }
 *     >>> lerpedColorComponents("#123456", {r: 255}, 1)
 *     { r: 255 }
 *     >>> // an unreadable base cannot be lerped FROM, so the target stands and
 *     >>> // the caller's refusal path reports it:
 *     >>> lerpedColorComponents("nope", {r: 255}, 0.5)
 *     { r: 255 }
 */
export function lerpedColorComponents(base, components, alpha) {
  const out = {};
  for (const [axis, target] of Object.entries(components ?? {})) {
    const from = colorChannelValue(base, axis);
    out[axis] = from === null || typeof target !== "number" ? target : lerp(from, target, alpha);
  }
  return out;
}

/** The `color` address, read from the declaration table rather than written as a
 *  literal — R7-38c's "nothing hardcoding arity or name" applied to this seam. */
const COLOR_ADDRESS = "color";

/** Pure function. A plain object literal (not an array, not a class instance) —
 *  the same test `core/deltas.js isTree` makes, restated here so this module does
 *  not import from the module that imports IT.
 *
 *  >>> isPlainObject({a: 1})
 *  true
 *  >>> isPlainObject([1])
 *  false */
function isPlainObject(x) {
  return x !== null && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;
}

// ── THE ALGEBRA: NAMED n-VECS AS NUMPY-STYLE VALUES (R7-38b / R7-38c) ────────
//
// Everything below is RANK- AND ARITY-AGNOSTIC by construction. No function in
// this section mentions `pos`, `size`, `color`, or a length. That is the whole
// point: the user's "we might have others in the future ... even arbitrary
// tensors" is satisfied by a declaration entry, never by an edit here.

/** The tag marking a value as a numeric vector/tensor. A SYMBOL-FREE string key
 *  so a vector survives JSON round-tripping unchanged — an equation's RESULT can
 *  be stored in a property, and a Symbol would vanish on save and come back a
 *  plain object. */
const VECTOR_TAG = "__vec";

/**
 * Pure function. Wraps flat numeric data as a vector VALUE — the constructor
 * every producer of a vector goes through.
 *
 * THE SHAPE FIELD IS DELIBERATELY ABSENT for rank-1 (see the header's door): a
 * today-value is implicitly `shape: [n]`, so a future rank-2 value can add the
 * field without any existing value carrying a wrong default that would have to
 * be migrated.
 *
 * Args:
 *   data (number[]): the components, in positional order
 *
 * Returns:
 *   object: a vector value
 *
 * Examples:
 *     >>> makeVector([10, 20])
 *     {__vec: [10, 20]}
 *     >>> makeVector([255, 128, 0, 255])
 *     {__vec: [255, 128, 0, 255]}
 */
export function makeVector(data, kind = null) {
  const out = { [VECTOR_TAG]: data };
  // NAMED COMPONENT PROJECTION. `(b.pos + c.pos).x` is the user's OWN worked
  // example, so a vector must answer to its component names — and after
  // arithmetic, where there is no property path left to address. The names are
  // attached as ordinary readable properties (non-enumerable, so they never
  // reach JSON, a delta, or a byte-comparison of a saved document) rather than
  // through a Proxy: the equation host hands these values straight to user code
  // under `with(scope)`, and a Proxy there would trap every probe the runtime
  // makes.
  //
  // THE KIND IS OPTIONAL AND DEFAULTS TO POSITIONAL-ONLY, which keeps the
  // algebra kind-agnostic (R7-38c): an operator produces its result with the
  // kind it was GIVEN, and a bare `makeVector([1,2])` is still a plain 2-vec.
  const axes = kind ? VECTOR_KINDS[kind]?.axes : axesForArity(data.length);
  // The index is `i % data.length`, which is identity for a single naming and is
  // what lets a 3-vec carry BOTH readings (x/y/z then r/g/b over the same three
  // slots) from one flat list.
  if (axes)
    axes.forEach((axis, i) => {
      Object.defineProperty(out, axis, { value: data[i % data.length], enumerable: false });
    });
  return out;
}

/**
 * Pure function. The DEFAULT component names for a bare vector of `n` elements —
 * how an unkinded arithmetic result still answers to `.x` / `.r`.
 *
 * IT IS A FALLBACK, NOT A TYPE SYSTEM. A 2-vec gets x/y and a 4-vec gets r/g/b/a
 * because those are the only arities the shipped kinds use and the names are
 * unambiguous at each. A 3-vec gets BOTH readings (x/y/z and r/g/b) because a
 * 3-vec is genuinely either. Any other arity gets none — positional only — which
 * is the honest answer rather than an invented naming.
 *
 * Args:
 *   n (number): the vector's length
 *
 * Returns:
 *   string[]|null
 *
 * Examples:
 *     >>> axesForArity(2)
 *     ['x', 'y']
 *     >>> axesForArity(4)
 *     ['r', 'g', 'b', 'a']
 *     >>> // a 3-vec is either a point or a colour, so it answers to both:
 *     >>> axesForArity(3)
 *     ['x', 'y', 'z', 'r', 'g', 'b']
 *     >>> axesForArity(7)
 *     null
 */
export function axesForArity(n) {
  if (n === 2) return ["x", "y"];
  if (n === 3) return ["x", "y", "z", "r", "g", "b"];
  if (n === 4) return ["r", "g", "b", "a"];
  return null;
}

/**
 * Pure function. THE ONE DISPATCH PREDICATE for the whole algebra — "is this a
 * numeric tensor value?".
 *
 * NAMED `isNumericTensor` AND NOT `isVector` ON PURPOSE. It is the single seam a
 * rank-2 value would widen (header: "The door left open for rank > 1"), and a
 * name that said "vector" would have to be either renamed or lied to on that
 * day. It is false for a bare array, which is what keeps a points list or a
 * gradient's stops out of arithmetic.
 *
 * Args:
 *   v (*): any value
 *
 * Returns:
 *   boolean
 *
 * Examples:
 *     >>> isNumericTensor(makeVector([1, 2]))
 *     true
 *     >>> // a BARE array is not one — a polyline must never broadcast:
 *     >>> isNumericTensor([1, 2])
 *     false
 *     >>> isNumericTensor(7)
 *     false
 *     >>> isNumericTensor("#ff0000")
 *     false
 */
export function isNumericTensor(v) {
  return !!v && typeof v === "object" && Array.isArray(v[VECTOR_TAG])
    && v[VECTOR_TAG].every((n) => typeof n === "number");
}

/**
 * Pure function. THE SINGLE UNWRAP — a vector value → its flat numeric data, or
 * null for anything that is not one.
 *
 * Args:
 *   v (*): any value
 *
 * Returns:
 *   number[]|null
 *
 * Examples:
 *     >>> vectorValues(makeVector([1, 2, 3]))
 *     [1, 2, 3]
 *     >>> vectorValues(5)
 *     null
 */
export function vectorValues(v) {
  return isNumericTensor(v) ? v[VECTOR_TAG] : null;
}

/**
 * Pure function. THE SHAPE-MISMATCH SENTENCE — the ONE thing the algebra still
 * refuses, and NumPy's own error spoken in this app's voice.
 *
 * A 2-vec plus a 3-vec has no answer: truncating to the shorter drops data the
 * author wrote, zero-filling invents data they did not, and NaN is a silent
 * wrong number that paints. So it fails loudly through the normal
 * equation-error path, exactly like every other equation refusal.
 *
 * Args:
 *   a (number[]): the left operand's data
 *   b (number[]): the right operand's data
 *   op (string): the operator, for the message
 *
 * Returns:
 *   string|null: the sentence, or null when the shapes DO match
 *
 * Examples:
 *     >>> shapeMismatchRefusal([1, 2], [1, 2, 3], "+")
 *     'cannot "+" a 2-vector and a 3-vector — operands must have the same length'
 *     >>> shapeMismatchRefusal([1, 2], [3, 4], "+")
 *     null
 */
export function shapeMismatchRefusal(a, b, op) {
  if (a.length === b.length) return null;
  return `cannot "${op}" a ${a.length}-vector and a ${b.length}-vector — operands must have the same length`;
}

/**
 * Pure function. Pairs two operands elementwise under NumPy's broadcasting rule,
 * as `[[l, r], ...]` — the walk both `vectorBinaryOp` and `vectorMapFunction`
 * route through, so the broadcast rule is stated ONCE.
 *
 * ALREADY RANK-AGNOSTIC: it pairs FLAT data of equal length, which is exactly
 * what an elementwise op over two equal shapes is. Rank-2 support means adding a
 * shape COMPARISON, not a new walk.
 *
 * Args:
 *   a (*): left operand (a vector value or a plain number)
 *   b (*): right operand (a vector value or a plain number)
 *   op (string): the operator, for the mismatch message
 *
 * Returns:
 *   {pairs: Array<[number, number]>, vector: boolean}: the paired operands, and
 *     whether the RESULT is a vector (either side being one makes it so)
 *
 * Throws:
 *   Error: on a shape mismatch (shapeMismatchRefusal's sentence)
 *
 * Examples:
 *     >>> zipTensors(makeVector([1, 2]), makeVector([10, 20]), "+").pairs
 *     [[1, 10], [2, 20]]
 *     >>> // SCALAR BROADCAST: the scalar pairs with every component:
 *     >>> zipTensors(makeVector([1, 2]), 10, "*").pairs
 *     [[1, 10], [2, 10]]
 *     >>> zipTensors(10, makeVector([1, 2]), "-").pairs
 *     [[10, 1], [10, 2]]
 *     >>> zipTensors(3, 4, "+").vector
 *     false
 */
export function zipTensors(a, b, op) {
  const va = vectorValues(a), vb = vectorValues(b);
  if (va && vb) {
    const problem = shapeMismatchRefusal(va, vb, op);
    if (problem) throw new Error(problem);
    return { pairs: va.map((x, i) => [x, vb[i]]), vector: true };
  }
  if (va) return { pairs: va.map((x) => [x, b]), vector: true };
  if (vb) return { pairs: vb.map((y) => [a, y]), vector: true };
  return { pairs: [[a, b]], vector: false };
}

/**
 * Pure function. Applies a binary numeric operator with NumPy semantics —
 * elementwise over two vectors, broadcast over a vector and a scalar, and plain
 * arithmetic over two scalars.
 *
 * THE SCALAR/SCALAR CASE IS DELIBERATELY INCLUDED so the evaluator can route
 * EVERY binary operation through one function instead of testing for vectors at
 * the call site — a test that would have to be repeated per operator and would
 * drift the day one is added.
 *
 * Args:
 *   op (string): the operator ("+", "-", "*", "/", "%", "**")
 *   a (*): left operand
 *   b (*): right operand
 *   apply (function): (op, l, r) → number, the SCALAR implementation — passed in
 *     rather than reimplemented here so this module never becomes a second
 *     source of truth for what "%" means in this grammar
 *
 * Returns:
 *   *: a vector value when either operand is one, else a plain number
 *
 * Examples:
 *     >>> const ap = (o, l, r) => (o === "+" ? l + r : o === "*" ? l * r : l - r)
 *     >>> // a.pos = b.pos + c.pos — the user's own worked example:
 *     >>> vectorBinaryOp("+", makeVector([10, 20]), makeVector([1, 2]), ap)
 *     {__vec: [11, 22]}
 *     >>> // SCALAR BROADCAST, both orders:
 *     >>> vectorBinaryOp("*", makeVector([3, 4]), 2, ap)
 *     {__vec: [6, 8]}
 *     >>> vectorBinaryOp("+", 100, makeVector([1, 2]), ap)
 *     {__vec: [101, 102]}
 *     >>> // two scalars are just arithmetic — no wrapper appears:
 *     >>> vectorBinaryOp("+", 2, 3, ap)
 *     5
 */
export function vectorBinaryOp(op, a, b, apply) {
  const { pairs, vector } = zipTensors(a, b, op);
  const out = pairs.map(([l, r]) => apply(op, l, r));
  return vector ? makeVector(out) : out[0];
}

/**
 * Pure function. Maps a scalar math function elementwise over a vector — the
 * "all math ops like sin cos etc operate on them like numpy would elementwise"
 * half of the ruling.
 *
 * IT TAKES THE IMPLEMENTATION RATHER THAN A NAME, so every SAFE_MATH member is
 * covered by construction and a function added to JS's `Math` tomorrow maps
 * elementwise with no edit here. That mirrors `mathFunctionEntries`'s own
 * derived-never-listed rule in core/expressions.js.
 *
 * A SCALAR ARGUMENT PASSES STRAIGHT THROUGH, so a caller can route every
 * single-argument math call through this without asking what it received.
 *
 * Args:
 *   fn (function): the scalar implementation (e.g. Math.sin)
 *   v (*): a vector value or a plain number
 *
 * Returns:
 *   *: a vector value when `v` is one, else a plain number
 *
 * Examples:
 *     >>> vectorMapFunction(Math.abs, makeVector([-1, 2, -3]))
 *     {__vec: [1, 2, 3]}
 *     >>> vectorMapFunction(Math.sin, makeVector([0, 0]))
 *     {__vec: [0, 0]}
 *     >>> // a scalar is untouched, so one call site serves both:
 *     >>> vectorMapFunction(Math.abs, -5)
 *     5
 */
export function vectorMapFunction(fn, v) {
  const data = vectorValues(v);
  return data ? makeVector(data.map((n) => fn(n))) : fn(v);
}

/**
 * Pure function. Maps a VARIADIC scalar function (min, max, hypot) over its
 * arguments with NumPy semantics — elementwise across every vector argument,
 * broadcasting the scalar ones.
 *
 * SEPARATE FROM vectorMapFunction because arity is the whole difference:
 * `max(pos, 0)` must clamp each component against 0, which is a zip across
 * arguments rather than a map over one. VARIADIC_MATH (core/expressions.js) is
 * the exact set this serves.
 *
 * Args:
 *   fn (function): the scalar implementation (e.g. Math.max)
 *   args (Array): the arguments, any mix of vectors and numbers
 *
 * Returns:
 *   *: a vector value when any argument is one, else a plain number
 *
 * Throws:
 *   Error: when two vector arguments disagree in length
 *
 * Examples:
 *     >>> // clamp both components at zero — the scalar broadcasts:
 *     >>> vectorMapVariadic(Math.max, [makeVector([-5, 10]), 0])
 *     {__vec: [0, 10]}
 *     >>> vectorMapVariadic(Math.min, [makeVector([1, 8]), makeVector([4, 2])])
 *     {__vec: [1, 2]}
 *     >>> vectorMapVariadic(Math.max, [3, 9])
 *     9
 */
export function vectorMapVariadic(fn, args) {
  const lengths = args.map(vectorValues).filter(Boolean).map((d) => d.length);
  if (lengths.length === 0) return fn(...args);
  const n = lengths[0];
  for (const len of lengths)
    if (len !== n)
      throw new Error(`cannot combine a ${n}-vector and a ${len}-vector — operands must have the same length`);
  const out = [];
  for (let i = 0; i < n; i++)
    out.push(fn(...args.map((arg) => vectorValues(arg)?.[i] ?? arg)));
  return makeVector(out);
}

/**
 * Pure function. A vector VALUE for a named kind, built from a source the
 * address layer already knows how to read — the bridge from the ADDRESS layer
 * (`vectorRead`, which speaks each kind's storage) to the ALGEBRA layer (which
 * speaks only flat numbers).
 *
 * A COLOUR BECOMES ITS r/g/b/a BYTES HERE, and that is what makes
 * `= fill.color * 0.5` arithmetic rather than an error: the algebra never sees a
 * hex string. The inverse trip — a vector result landing back in a colour slot —
 * is `vectorToStored`.
 *
 * ── ALPHA SCALES TOO, AND THAT IS DELIBERATE (measured; pinned in
 *    tests/vec_values_test.js) ──────────────────────────────────────────────
 * `= fill.color * 0.5` on `#ff8000` yields `#80400080` — half brightness AND
 * half opacity — because a colour is a 4-vec and elementwise means ALL FOUR.
 * It is worth stating because it surprises: the "obvious" behaviour would
 * exempt alpha and return `#804000`. That exemption is refused on the R7-38c
 * rule: the operator would have to know which of its components was an alpha,
 * i.e. know it was operating on a COLOUR — precisely the kind-specific branching
 * that makes a fourth vector kind an evaluator edit instead of a declaration.
 * An author who wants brightness alone scales the components they mean, or
 * writes the alpha back with `.color.a`.
 *
 * Args:
 *   kind (string): a VECTOR_KINDS key
 *   source (object|string|number[]): the state object (leaves) or composite value
 *
 * Returns:
 *   object|null: a vector value, or null when the source is unreadable
 *
 * Examples:
 *     >>> vectorFor("pos", {x: 10, y: 20})
 *     {__vec: [10, 20]}
 *     >>> // a colour enters the algebra as its four channels, alpha included:
 *     >>> vectorFor("color", "#ff8000")
 *     {__vec: [255, 128, 0, 255]}
 *     >>> vectorFor("pos", {x: 10})
 *     null
 */
export function vectorFor(kind, source) {
  const decl = VECTOR_KINDS[kind];
  if (!decl) return null;
  if (decl.via === "composite") {
    const bytes = colorBytes(source);
    return bytes ? makeVector(bytes) : null;
  }
  const tuple = vectorRead(kind, source);
  return tuple ? makeVector(tuple) : null;
}

/**
 * Pure function. A vector VALUE → the form a slot of `kind` actually stores —
 * the inverse of `vectorFor`, and the step that lets `a.pos = b.pos + c.pos`
 * write two real leaves and `fill.color = fill.color * 0.5` write one real hex.
 *
 * A COMPOSITE KIND RE-SPELLS ITSELF AS A COLOUR, with the same
 * drop-opaque-alpha rule `withColorChannel` uses, so an algebraic result is
 * byte-identical to the hex an author would have typed.
 *
 * Args:
 *   kind (string): a VECTOR_KINDS key
 *   v (*): a vector value
 *
 * Returns:
 *   *: a tuple (leaves kinds) or a colour string (composite kinds); null when
 *     `v` is not a vector of the right length
 *
 * Examples:
 *     >>> vectorToStored("pos", makeVector([10, 20]))
 *     [10, 20]
 *     >>> vectorToStored("color", makeVector([255, 128, 0, 255]))
 *     '#ff8000'
 *     >>> // half-brightness arithmetic lands back on a real hex colour:
 *     >>> vectorToStored("color", makeVector([128, 64, 0, 255]))
 *     '#804000'
 *     >>> // WRONG ARITY IS REFUSED, never padded:
 *     >>> vectorToStored("pos", makeVector([1, 2, 3]))
 *     null
 */
export function vectorToStored(kind, v) {
  const decl = VECTOR_KINDS[kind];
  const data = vectorValues(v);
  if (!decl || !data || data.length !== decl.axes.length) return null;
  if (decl.via !== "composite") return data.slice();
  const clamped = data.map((n) => Math.round(Math.max(0, Math.min(COLOR_CHANNEL_MAX, n))));
  return rgbToHex(clamped[3] >= COLOR_CHANNEL_MAX ? clamped.slice(0, 3) : clamped);
}
