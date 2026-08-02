/**
 * THE LABEL⟷VALUE SPLIT — its keys, its bounds and its drag arithmetic, with no
 * DOM in sight (web/LabelDivider.svelte is the component that wears it).
 *
 * WHY THIS FILE EXISTS AT ALL. `fractionAt` lived in LabelDivider.svelte's
 * `<script module>`, whose own comment said it was there "so the drag arithmetic
 * is importable by a bare-node test without a DOM". That was not true and could
 * not become true: node cannot import a `.svelte` file, no test in this repo
 * does, and web/GradientStopBar.svelte was already reaching into another
 * component's module scope to borrow the function. A plain `.js` module makes
 * the sentence true and gives the keys below a home the gate can read.
 *
 * ── THE KEYS, and why there is more than one number ─────────────────────────
 *
 * USER RULING (2026-08-01). A second divider governs VARIABLE PROPERTIES
 * (gradients and the like), and it is "the same kind of UI, not the same line":
 * same handle, same CSS, same hover-to-reveal, a DIFFERENT number.
 *
 *   - "Within a level and a type of divider it will be synchronized across all
 *     of them" — which is why dragging any Property Panel category divider moves
 *     Fill Material, Stroke Material and Positioning together today.
 *   - "If there was a second level that second level would not be synced with
 *     the first level, because then that would make them collide visually."
 *
 * So THE KEY IS (NESTING LEVEL, DIVIDER TYPE), flattened here into one opaque
 * string id per divider family. Flattened deliberately, and the flattening has
 * now paid for itself: the third depth (LABEL_DIVIDER_LIST, 2026-08-02) landed
 * as ONE new entry in LABEL_DIVIDER_KEYS plus its mount, because every call site
 * already named a KEY rather than assuming one global number.
 *
 * THE 2026-08-01 SCOPING — "don't worry about nested yet" — IS SUPERSEDED, by
 * the user's 2026-08-02 ruling: "you know that line that can be dragged for
 * regular properties … Yeah, I'd like that for, well, really everything,
 * including the gradient sub-properties, too. There's no way to control that
 * width right now, and that makes it hard to edit things." So a region that
 * shows a label beside a value now gets a divider by default, and the question a
 * new region has to answer is which FAMILY it joins, not whether it gets one.
 *
 * WHY DEPTHS MUST NOT SHARE A NUMBER, measured rather than assumed. At HEAD a
 * rect with a gradient stroke mounts six dividers across three nesting depths
 * and ALL SIX land on the same client x (1252.2 px, panel [1178, +314]) — they
 * are stacked strips, so the topmost swallows the others' pointer events and the
 * hairline paints at double strength where they overlap. app.css's own divider
 * header warns about exactly that failure for the .rows/.cat-rows pair; giving
 * each family its own number is the same remedy applied between depths.
 *
 * PROPORTIONALITY IS WHAT MAKES THIS FREE (user, verbatim in substance): "they're
 * proportional so the dividing line is fine even when we have nested sections,
 * because it's just a smaller proportion, it's closer to the right of the
 * screen." A nested block is narrower, so the same fraction lands further right
 * in absolute terms with no special-casing — which is why NO new CSS is needed.
 * A nested block re-publishes `--a-label-frac` with its own family's number and
 * the cascade carries it to the grid tracks AND to the divider inside it.
 *
 * NOT DOCUMENT STATE. A divider fraction is editor chrome; in the document it
 * would keyframe, tween and appear in renders.
 */

/** The Property Panel's and Variables Panel's top-level rows — the divider that
 *  has always existed. Its stored key is unchanged, so nobody loses their split. */
export const LABEL_DIVIDER_PROPERTY = "property";

/** VARIABLE PROPERTIES — the rows nested inside a composite property editor: a
 *  gradient's geometry sub-rows and a fill/stroke material's knobs. Named for
 *  the user's own words. NOT web/VariablesPanel.svelte, whose rows are ordinary
 *  top-level rows and deliberately stay on LABEL_DIVIDER_PROPERTY: the round-11
 *  "columns line up" ruling is that the two PANELS share one boundary x. */
export const LABEL_DIVIDER_VARIABLE = "variable";

/**
 * LIST-ELEMENT FIELDS — the micro-label⟷control split inside one element row of
 * web/ListField.svelte (a gradient stop's `offset`/`color`, a polygon vertex's
 * `x`/`y`). The THIRD depth, added 2026-08-02 on the user's ruling that the
 * divider be extended to "really everything, including the gradient
 * sub-properties, too. There's no way to control that width right now, and that
 * makes it hard to edit things" — their screenshot showed a stops row's label
 * ellipsized to "off…" with no recourse.
 *
 * ITS OWN NUMBER, NOT THE PANEL'S AND NOT THE VARIABLE FAMILY'S, and the choice
 * is forced by the rule stated above rather than picked: an element row lives
 * INSIDE both of those blocks, so sharing either number would put its strip at
 * the same client x as the enclosing one, which is exactly the stacking the
 * 2026-08-01 ruling and its six-strips-at-1252.2px measurement rule out.
 *
 * The user's own justification for why the extra number costs nothing applies
 * verbatim one level further down: "they're proportional so the dividing line is
 * fine even when we have nested sections, because it's just a smaller
 * proportion". A list field's cell is narrower again, so the same fraction lands
 * further left in absolute terms and cannot collide with its parents' strips.
 *
 * ONE FAMILY FOR EVERY LIST, not one per list or per field column. A stop row's
 * `offset` cell and its `color` cell are equal-width grid tracks, so one fraction
 * puts every boundary in the block on a shared per-column x — the "multiple
 * lines, in synchronized x position" shape, repeated per column. Giving each
 * column its own number would mean dragging the offset boundary left while the
 * colour boundary stayed put, which is per-cell furniture nobody asked for.
 */
export const LABEL_DIVIDER_LIST = "list";

/** Every divider family, in the order a settings record iterates them. */
export const LABEL_DIVIDER_KEYS = [LABEL_DIVIDER_PROPERTY, LABEL_DIVIDER_VARIABLE, LABEL_DIVIDER_LIST];

/** The default split. 84px against a 362px default row — the fixed --a-label-w
 *  this replaced — i.e. 0.2318, rounded. The two ROW families start here: the
 *  2026-08-01 ruling asks for independent numbers, not for a different resting
 *  look, and shipping a different default would move a nested column nobody
 *  asked to move. */
export const LABEL_FRAC_DEFAULT = 0.23;

/**
 * The default for the LIST family, which is NOT the shared one and must not be.
 * A field cell is ~56px at rest (--a-list-field-w), not 362px, so 0.23 of it is
 * ~13px — under two characters, i.e. every micro-label ellipsized to "o…" by
 * default. That is worse than the flex label it replaced, and shipping it would
 * have answered the user's "there's no way to control that width" by making the
 * resting width wrong and handing them a handle to fix it with.
 *
 * 0.50 is MEASURED, not guessed: a stop row's field cell is 95.0px at the default
 * panel split, and the label track must hold the text PLUS the unconditional ƒ
 * gutter the row reserves (--a-row-chrome-w − --a-sp-1 ≈ 14px, app.css
 * .list-field-label). "offset" is ~33px at --a-font-sm, so ~47px of a 95px cell —
 * 0.50, which is inside the shared bounds with room to spare. At 0.42 the same
 * label measured 39.9px and still rendered "off…", which was the user's exact
 * complaint arriving at a slightly larger size.
 *
 * `offset` is the longest name either shipped list element has (`offset`/`color`,
 * `x`/`y`), so this fits every list today. It is still a PROPORTION, so widening
 * the panel widens the label with it, and the divider moves it anywhere in the
 * shared bounds — which is the actual answer to "there's no way to control that
 * width". The default only decides where it RESTS.
 */
export const LABEL_FRAC_LIST_DEFAULT = 0.5;

/**
 * Pure function. The resting split for one divider family.
 *
 * @param {string} key A LABEL_DIVIDER_KEYS member.
 * @returns {number} The default fraction.
 *
 * @example labelFracDefault("property")
 * 0.23
 * @example labelFracDefault("variable")
 * 0.23
 * @example labelFracDefault("list")
 * 0.42
 */
export function labelFracDefault(key) {
  if (!LABEL_DIVIDER_KEYS.includes(key)) throw new Error(`labelFracDefault: unknown divider key "${key}"`);
  return key === LABEL_DIVIDER_LIST ? LABEL_FRAC_LIST_DEFAULT : LABEL_FRAC_DEFAULT;
}

/** Clamp bounds, shared by the drag and by the persist path so the two cannot
 *  disagree (a drag writing a value the store silently rewrites is how a divider
 *  ends up sticking). 0.15 still shows a short label; 0.55 still leaves the
 *  value column wider than the labels beside it. */
export const LABEL_FRAC_BOUNDS = { min: 0.15, max: 0.55 };

/**
 * Pure function. The localStorage key one divider family persists under.
 *
 * The PROPERTY family keeps the bare historical key. This is not nostalgia: that
 * key holds a preference real users have already dragged, and a suffix would
 * silently reset every one of them to the default.
 *
 * @param {string} key A LABEL_DIVIDER_KEYS member.
 * @returns {string} The localStorage key.
 *
 * @example labelFracSettingKey("property")
 * 'powerrp.labelFrac'
 * @example labelFracSettingKey("variable")
 * 'powerrp.labelFrac.variable'
 */
export function labelFracSettingKey(key) {
  if (!LABEL_DIVIDER_KEYS.includes(key)) throw new Error(`labelFracSettingKey: unknown divider key "${key}"`);
  return key === LABEL_DIVIDER_PROPERTY ? "powerrp.labelFrac" : `powerrp.labelFrac.${key}`;
}

/**
 * Pure function. The label fraction a pointer at client-x `clientX` names, for a
 * rows block whose content box spans [left, left + width], clamped to `bounds`.
 *
 * The pointer's x is read against the ROWS BLOCK, not the panel: the block is the
 * row grid's containing box, so `calc(fraction * 100%)` resolves against exactly
 * this width. Measuring the panel instead would be off by its padding, and the
 * divider would settle a few pixels away from where it was dropped.
 *
 * @param {number} clientX Pointer x in client coordinates
 * @param {number} left Rows-block content-box left edge, client coordinates
 * @param {number} width Rows-block content-box width in px
 * @param {{min: number, max: number}} bounds Clamp bounds for the fraction
 * @returns {number} The clamped fraction
 *
 * @example fractionAt(140, 20, 400, {min: 0.15, max: 0.55})
 * 0.3
 * @example fractionAt(0, 20, 400, {min: 0.15, max: 0.55})
 * 0.15
 * @example fractionAt(1000, 20, 400, {min: 0.15, max: 0.55})
 * 0.55
 */
export function fractionAt(clientX, left, width, bounds) {
  if (!(width > 0)) return bounds.min; // a zero-width block names no fraction
  return Math.min(bounds.max, Math.max(bounds.min, (clientX - left) / width));
}
