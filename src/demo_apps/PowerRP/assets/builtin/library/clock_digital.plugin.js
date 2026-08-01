// clock_digital.plugin.js — A BUILT-IN PLUGIN ASSET (core/builtin_plugin_assets.js).
//
// DIGITAL CLOCK widget — a bbox readout that shows a TIME (a number in SECONDS)
// as clock digits, "HH:MM:SS" or "MM:SS". It deliberately INHERITS FROM THE
// PLAINTEXT widget (plugins/plaintext.js): it composes the SAME text-style
// bundle (font / size / bold / color / align / valign, all from the shared
// property registry) and renders exactly ONE ir.js text() op — the only
// difference is that the drawn STRING is COMPUTED by formatClock(seconds, …)
// from the numeric `time` property instead of typed by the user.
//
// ── EQUATION-BINDABLE TIME (the shared time source; no engine change) ─────────
// `time` is an ordinary NUMERIC item-state leaf (default 0), so it rides the
// UNIVERSAL `=` marker (core/expressions.js) like every other numeric property:
// typing `=` in its Inspector field binds it to an equation, and the equation
// grammar exposes the deterministic host clock as the free identifier `time`
// (seconds — core/expressions.js scopeGet, reading THE app-wide presentation clock,
// render_gpu/particle_clock.particleTime, the same one the particle emitters and the
// sky read). So binding this widget's `time` to `= time` makes it TICK LIVE with the
// presentation from the ONE shared time source; binding it to `= time * 2`,
// `= time + 3600`, etc. drives it off any expression. emit() receives the
// ALREADY-resolved number in `s.time` and never touches the evaluator — the clock
// is WYSIWYG-live because emit() recomputes the string from `s.time` every frame.
//
// WHAT `= time` READS WHERE, so a frozen editor readout is not read as a bug: the
// clock has TWO REGIMES (particle_clock.js). In the EDITOR, CLI and thumbnails it is
// PAUSED at a fixed freeze time, so the widget shows a deterministic representative
// readout and the same document always renders byte-identically. It ticks in PRESENT
// mode (the live regime) and advances frame by frame in an MP4 export (which drives
// the clock explicitly). A clock that must show a fixed readout everywhere takes a
// plain number instead of an equation.
//
// ── STYLING = SHARED REGISTRY, one text() op (the plaintext inheritance) ──────
// Like plaintext.js, it composes the positioning bundle, opacity, the effects
// bundle (shadow/bloom/inner-shadow/blend), and reuses the PAINT-capable registry
// `fill` prop (relabelled "Color") for the glyph ink (solid OR a gradient, run
// through parsePaint by the text() op). emit() builds exactly ONE existing
// LEGACY single-run text() op (no `rich` payload) carrying boxStyle{align,valign}
// + boxW/boxH so the shared renderer aligns/wraps it. No new IR op.
//
// ── DEFAULT FONT = the SEVEN-SEGMENT face ─────────────────────────────────────
// The clock defaults its `font` to the SEVEN-SEGMENT font id registered in
// render_gpu/fonts.js. That id is resolved by pickSeg7FontId() from a small
// candidate list ("seg7"/"sevenSegment"/…) so this widget picks up WHICHEVER id
// the font table actually lands on, at load time. When that font is absent the
// font pipeline DEGRADES GRACEFULLY (fontDescriptor falls back to the system
// stack, no tofu, no throw), so the clock renders in a fallback face rather than
// hard-failing.
//
// ── WHY THIS IS AN ASSET, AND THE TWO THINGS THE MOVE NEEDED ──────────────────
// Everything here is one ir.text() op over the shared registry — no media, no
// shader, no DOM. Two host bindings had to be exposed for it: the font TABLE
// (`FONTS`, so pickSeg7FontId can ask what is registered), `DEFAULT_FONT` and
// `fontOptions` (the Inspector's select rows). All three are pure data/lookups;
// nothing that LOADS or rasterizes a face is in the jail, and a plugin asset only
// ever NAMES a font. Its "Add Digital Clock" palette entry moved to
// plugins/builtin_asset_commands.js (a plugin asset may not declare `commands`),
// keeping the id `add-clock-digital`.

// Text size + alignment options, mirroring plugins/plaintext.js so a clock and a
// plaintext box read at the same size and offer the same typography controls (one
// shared convention, not a fresh per-widget number).
const DEFAULT_TEXT_SIZE = 36;
const ALIGN_OPTIONS = ["left", "center", "right", "justify"];
const ALIGN_LABELS = { left: "Left", center: "Center", right: "Right", justify: "Justify" };
const VALIGN_OPTIONS = ["top", "middle", "bottom"];
const VALIGN_LABELS = { top: "Top", middle: "Middle", bottom: "Bottom" };

// ── Clock arithmetic constants (named so the wrap math reads without a decoder) ─
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR; // 3600
const HOURS_PER_DAY = 24;
const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY;       // 86400
// A clock field (HH, MM, SS) is exactly two digits when zero-padded.
const CLOCK_FIELD_WIDTH = 2;
// 12-hour clocks map hour 0/12/24 → 12 (midnight/noon read as "12").
const HOURS_PER_HALF_DAY = 12;
// The seven-segment font id, plus the fallbacks to accept in case the font table
// registers it under a slightly different id — pickSeg7FontId picks whichever it
// finds, else the first (which degrades gracefully to the system face if absent).
const SEG7_FONT_CANDIDATES = ["seg7", "sevenSegment", "seven-segment"];

/**
 * Pure function. Resolves the DEFAULT seven-segment font id: the first candidate
 * id that is actually registered in the font table, else the first candidate.
 * When none is registered it returns the primary candidate, which the font
 * pipeline degrades gracefully to the system face (no throw).
 *
 * @param {object} fonts - the committed-font registry (id → descriptor)
 * @param {string[]} candidates - seven-segment id candidates, most-preferred first
 * @returns {string} the chosen font id
 *
 * @example pickSeg7FontId({ seg7: {} }, ["seg7", "sevenSegment"]) // "seg7"
 * @example pickSeg7FontId({ sevenSegment: {} }, ["seg7", "sevenSegment"]) // "sevenSegment"
 * @example pickSeg7FontId({ inter: {} }, ["seg7", "sevenSegment"]) // "seg7" (none present → primary; degrades to system)
 */
function pickSeg7FontId(fonts, candidates) {
  return candidates.find((id) => id in fonts) ?? candidates[0];
}

/** The resolved seven-segment font id (see pickSeg7FontId). */
const SEG7_FONT_ID = pickSeg7FontId(FONTS, SEG7_FONT_CANDIDATES);

/**
 * Pure function. Zero-pads a non-negative integer field to the clock field width
 * when `pad` is true, else returns its plain decimal string. The most-significant
 * clock field respects the leading-zero option; every following field is ALWAYS
 * padded (a real clock shows "1:05", never "1:5").
 *
 * @param {number} value - a non-negative integer field (hour, minute, or second)
 * @param {boolean} pad - whether to zero-pad to two digits
 * @returns {string}
 *
 * @example padField(5, true) // "05"
 * @example padField(5, false) // "5"
 * @example padField(42, true) // "42"
 */
function padField(value, pad) {
  const s = String(value);
  return pad ? s.padStart(CLOCK_FIELD_WIDTH, "0") : s;
}

/**
 * Pure function. Maps a 24-hour hour (0..23) to its 12-hour clock face value
 * (1..12): midnight and noon both read as 12. Meridiem (AM/PM) is intentionally
 * not appended — a bare 12-hour digit clock, matching the digital-readout look.
 *
 * @param {number} hour24 - hour in [0, 23]
 * @returns {number} hour in [1, 12]
 *
 * @example to12Hour(0) // 12
 * @example to12Hour(13) // 1
 * @example to12Hour(12) // 12
 * @example to12Hour(9) // 9
 */
function to12Hour(hour24) {
  const h = hour24 % HOURS_PER_HALF_DAY;
  return h === 0 ? HOURS_PER_HALF_DAY : h;
}

/**
 * Pure function. Formats a TIME in SECONDS as a digital-clock string, wrapping
 * like a real clock. In "MM:SS" mode the top field is minutes wrapping at 60 (the
 * seconds within one hour); in "HH:MM:SS" mode the whole time wraps at 24h. The
 * seconds and minutes fields always wrap at 60. Negative inputs are clamped to 0
 * (a clock never shows negative time) and fractional seconds floor to whole
 * seconds. `leadingZero` pads the MOST-SIGNIFICANT field to two digits (every
 * following field is always two digits); `showSeconds` drops the trailing seconds
 * field; `showHours` prepends the hours field; `hour12` renders the hour on a
 * 12-hour face; `separator` joins the fields.
 *
 * Args:
 *   seconds (number): the time in seconds (may be fractional or negative)
 *   options (object): {showHours=false, showSeconds=true, separator=":",
 *     leadingZero=true, hour12=false}
 *
 * Returns:
 *   string: the clock readout (e.g. "01:05", "01:01:01")
 *
 * @example formatClock(65, {}) // "01:05"
 * @example formatClock(3661, { showHours: true }) // "01:01:01"
 * @example formatClock(-5, {}) // "00:00" (negative guard → 0)
 * @example formatClock(90000, { showHours: true }) // "01:00:00" (wraps at 24h)
 * @example formatClock(3600, {}) // "00:00" (MM:SS wraps at 60 min)
 * @example formatClock(3661, { showHours: true, leadingZero: false }) // "1:01:01"
 * @example formatClock(125, { separator: "." }) // "02.05"
 * @example formatClock(3661, { showHours: true, showSeconds: false }) // "01:01"
 * @example formatClock(45296, { showHours: true, hour12: true }) // "12:34:56"
 */
function formatClock(seconds, { showHours = false, showSeconds = true, separator = ":", leadingZero = true, hour12 = false } = {}) {
  const total = Math.floor(Math.max(0, Number(seconds) || 0)); // negative/NaN guard + floor to whole seconds
  let fields;
  if (showHours) {
    const wrapped = total % SECONDS_PER_DAY; // time-of-day: wrap at 24h
    const hour24 = Math.floor(wrapped / SECONDS_PER_HOUR);
    const minute = Math.floor((wrapped % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    const second = wrapped % SECONDS_PER_MINUTE;
    const hour = hour12 ? to12Hour(hour24) : hour24;
    fields = showSeconds ? [hour, minute, second] : [hour, minute];
  } else {
    const wrapped = total % SECONDS_PER_HOUR; // MM:SS: minutes wrap at 60
    const minute = Math.floor(wrapped / SECONDS_PER_MINUTE);
    const second = wrapped % SECONDS_PER_MINUTE;
    fields = showSeconds ? [minute, second] : [minute];
  }
  // First field honors leadingZero; the rest are always two digits (real-clock rule).
  return fields.map((v, i) => padField(v, i === 0 ? leadingZero : true)).join(separator);
}

/**
 * THE TWELVE READOUTS, IN DISPLAY-TECHNOLOGY ORDER — one FLAT family.
 *
 * ONE FLAT `presets`, NOT `presetFamilies`. core/registry.js requires several
 * families to write DISJOINT key sets so a pick from each COMPOSES rather than
 * clobbers. These twelve are alternative WHOLE looks over the same eleven keys, so
 * any split overlaps on all eleven and the second pick would silently erase the
 * first — the case that rule exists to forbid (plugins/demo/lens_flare.js says it
 * at length).
 *
 * EVERY PRESET SETS EVERY LOOK KNOB, including where a value is inert (`hour12`
 * while `showHours` is false; `bloom.radius` at strength 0). Application is an
 * OVERLAY, so a knob one row omits keeps whatever the PREVIOUSLY hovered row left
 * there, and comparing looks by running down the list is the whole point of the
 * pane.
 *
 * THE ORDER IS THE CONTENT: emissive LED (1-2), vacuum fluorescent (3-4),
 * non-emissive LCD (5), a monochrome phosphor (6), the mechanical and matrix boards
 * a terminal hangs (7-8), and last four readouts that model no single device.
 *
 * TWO KNOBS CARRY THE PHYSICS AND THEY ARE NOT INDEPENDENT. `fill` is the EMISSION
 * colour of a named display technology — 505 nm zinc-oxide phosphor for the
 * vacuum-fluorescent green, 525 nm P1 for the terminal green, 602 nm P3 for the
 * board amber, each rendered to sRGB and pulled toward white because the emission
 * band is broad rather than monochromatic — and `bloom` is whether that technology
 * EMITS AT ALL. An LED and a phosphor bloom; an LCD segment and a painted flap
 * cannot, so their strength is 0. A preset that glowed while modelling a reflective
 * display would be wrong the way a warm-tinted uncoated lens flare is.
 *
 * NO PRESET SETS `time`. That is the READING — typically bound `= time` — and a
 * literal write would silently unbind it, which is the lens_flare `lightWorldX/Y`
 * rule applied to a readout. NO PRESET SETS `size` either, by the same
 * `flareScale` test: size says how the readout FITS the box the author dragged,
 * not what the readout looks like. Both exclusions cost something and the cost is
 * recorded in .frenzy/round6/presets/instruments.md.
 */
const PRESETS = [
  {
    name: "Bedside Alarm",
    description: "The red seven-segment clock radio: a 12-hour HH:MM readout, hour unpadded, no seconds, glowing off a dark nightstand.",
    props: {
      showHours: true, showSeconds: false, hour12: true, leadingZero: false, separator: ":",
      font: "seg7", bold: false, align: "center", valign: "middle",
      fill: "#ff2a1a", bloom: { radius: 14, strength: 0.55 },
    },
  },
  {
    name: "Scoreboard",
    description: "The stadium game clock: condensed red digits counting MM:SS with the minutes unpadded, driven hard enough to read from the back row.",
    props: {
      showHours: false, showSeconds: true, hour12: false, leadingZero: false, separator: ":",
      font: "oswald", bold: true, align: "center", valign: "middle",
      fill: "#ff3b1f", bloom: { radius: 22, strength: 0.8 },
    },
  },
  {
    name: "Car Panel",
    description: "The green vacuum-fluorescent dashboard clock: 24-hour HH:MM on the 505 nm phosphor, zero-padded, softly haloed behind its filter.",
    props: {
      showHours: true, showSeconds: false, hour12: false, leadingZero: true, separator: ":",
      font: "seg7", bold: false, align: "center", valign: "middle",
      fill: "#3af2c8", bloom: { radius: 18, strength: 0.5 },
    },
  },
  {
    name: "Blue Vacuum",
    description: "The deep-blue vacuum-fluorescent variant an instrument cluster uses: the full HH:MM:SS readout under a wide, cool halo.",
    props: {
      showHours: true, showSeconds: true, hour12: false, leadingZero: true, separator: ":",
      font: "seg7", bold: false, align: "center", valign: "middle",
      fill: "#4ab8ff", bloom: { radius: 20, strength: 0.6 },
    },
  },
  {
    name: "Kitchen Timer",
    description: "The grey-on-grey liquid-crystal panel: dark segments that emit nothing at all, counting MM:SS with the minutes unpadded.",
    props: {
      showHours: false, showSeconds: true, hour12: false, leadingZero: false, separator: ":",
      font: "seg7", bold: false, align: "center", valign: "middle",
      fill: "#2b3330", bloom: { radius: 10, strength: 0 },
    },
  },
  {
    name: "Terminal Phosphor",
    description: "The 525 nm P1 green monochrome monitor: a monospace 24-hour HH:MM:SS pinned to the left of its field, with the faint bloom of a lit phosphor.",
    props: {
      showHours: true, showSeconds: true, hour12: false, leadingZero: true, separator: ":",
      font: "jetbrains-mono", bold: false, align: "left", valign: "middle",
      fill: "#33ff66", bloom: { radius: 10, strength: 0.3 },
    },
  },
  {
    name: "Split-Flap Board",
    description: "The station departure board: painted flaps in a heavy grotesque showing 24-hour HH:MM and never seconds, reflecting light rather than making it.",
    props: {
      showHours: true, showSeconds: false, hour12: false, leadingZero: true, separator: ":",
      font: "montserrat", bold: true, align: "center", valign: "middle",
      fill: "#f2f0eb", bloom: { radius: 10, strength: 0 },
    },
  },
  {
    name: "Platform Amber",
    description: "The lit matrix board that replaced the flaps: the same 24-hour HH:MM in condensed 602 nm amber, this time with a real emitter's bloom.",
    props: {
      showHours: true, showSeconds: false, hour12: false, leadingZero: true, separator: ":",
      font: "oswald", bold: false, align: "center", valign: "middle",
      fill: "#ffb000", bloom: { radius: 12, strength: 0.35 },
    },
  },
  {
    name: "Flight Deck",
    description: "The four-digit avionics readout — ISO 8601's BASIC format, T[hh][mm] with the separator removed outright, so half past two reads 1430.",
    props: {
      showHours: true, showSeconds: false, hour12: false, leadingZero: true, separator: "",
      font: "jetbrains-mono", bold: true, align: "center", valign: "middle",
      fill: "#e8f4ff", bloom: { radius: 10, strength: 0 },
    },
  },
  {
    name: "Lap Timer",
    description: "The stopwatch face: MM:SS joined by a period instead of a colon, zero-padded, in a bold monospace that keeps the digits from shifting as they run.",
    props: {
      showHours: false, showSeconds: true, hour12: false, leadingZero: true, separator: ".",
      font: "jetbrains-mono", bold: true, align: "center", valign: "middle",
      fill: "#f5f5f5", bloom: { radius: 10, strength: 0 },
    },
  },
  {
    name: "Newsroom Bug",
    description: "The broadcast corner clock: 24-hour HH:MM set flush right and low in its box, white with just enough glow to hold against moving video.",
    props: {
      showHours: true, showSeconds: false, hour12: false, leadingZero: true, separator: ":",
      font: "roboto", bold: true, align: "right", valign: "bottom",
      fill: "#ffffff", bloom: { radius: 8, strength: 0.25 },
    },
  },
  {
    name: "Wall Clock",
    description: "Not a device at all — the time set as type: a geometric sans on a 12-hour face, hour unpadded, black ink, nothing glowing.",
    props: {
      showHours: true, showSeconds: false, hour12: true, leadingZero: false, separator: ":",
      font: "futura", bold: false, align: "center", valign: "middle",
      fill: "#111111", bloom: { radius: 10, strength: 0 },
    },
  },
];

return {
  type: "clock_digital",
  title: "Digital Clock",
  // resizable:true → the standard 8 resize handles (same machinery as plaintext);
  // w gives the centered readout room, h gives the vertical-align stack its room.
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // defaults COMPOSE from the SHARED REGISTRY (positioning + opacity + effects-off),
  // exactly like plaintext.js. `time` is a NUMERIC leaf (default 0 → a static
  // 00:00 the user can set or bind with `= time` to follow the shared clock). The
  // clock-format flags default to a plain MM:SS, zero-padded, 24-hour readout.
  // `font` defaults to the seven-segment face (SEG7_FONT_ID); ink/size mirror the
  // plaintext text-style bundle, centered (a clock reads best centered).
  defaults: {
    type: "clock_digital", x: 120, y: 80, w: 260, h: 60, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about its own center by default (an equation — the plaintext /
    // Round 11 precedent); derive falls back to center when absent on old docs.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    time: 0,
    showHours: false, showSeconds: true, separator: ":", leadingZero: true, hour12: false,
    font: SEG7_FONT_ID, size: DEFAULT_TEXT_SIZE, bold: false,
    fill: "#000000", align: "center", valign: "middle",
    ...defaults("opacity"), // opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/innerShadow/blendMode, all EFFECT-OFF
  },
  // Rows grouped into the Inspector accordion by each row's `category`. The clock's
  // own knobs live in "clock" (start-cased "Clock" by the Inspector's fallback);
  // typography in "text" (the plaintext convention); ink + opacity in "formatting";
  // position in "positioning"; the shared effects bundle last.
  inspector: [
    ...bundle("positioning"),
    // The TIME leaf. kind "number" makes it a numeric slot: a typed number OR an
    // `=` equation (bind it to the shared `time` identifier to tick live).
    { key: "time", label: "Time (seconds)", kind: "number", category: "clock", help: "The time this clock shows, in seconds. Type a fixed number, or start with '=' to bind it to an equation — e.g. '= time' to follow the presentation's playback clock." },
    { key: "showHours", label: "Show hours", kind: "boolean", category: "clock", help: "Show an hours field (HH:MM:SS). Off shows just minutes and seconds (MM:SS), with the minutes wrapping at 60." },
    { key: "showSeconds", label: "Show seconds", kind: "boolean", category: "clock", help: "Show the trailing seconds field. Off drops it (e.g. HH:MM, or just MM)." },
    { key: "hour12", label: "12-hour", kind: "boolean", category: "clock", help: "Show the hour on a 12-hour face (1-12, where midnight and noon read as 12) instead of 24-hour (0-23). Only affects the hours field." },
    { key: "leadingZero", label: "Leading zero", kind: "boolean", category: "clock", help: "Pad the first field to two digits (09:05 instead of 9:05). The following fields are always two digits, like a real clock." },
    { key: "separator", label: "Separator", kind: "text", category: "clock", help: "The character drawn between fields — a colon by default. Try '.' or a space for a different look." },
    { key: "font", label: "Font", kind: "select", options: fontOptions().map((o) => o.value), optionLabels: Object.fromEntries(fontOptions().map((o) => [o.value, o.label])), category: "text", help: "The typeface the digits are drawn in. Defaults to the seven-segment face for a classic digital-clock look." },
    { key: "size", label: "Size", kind: "number", min: 0, category: "text", help: "Digit size in canvas units. Larger is bigger on the slide." },
    { key: "bold", label: "Bold", kind: "boolean", category: "text", help: "Draw the digits in the font's bold weight." },
    { key: "align", label: "Align", kind: "select", options: ALIGN_OPTIONS, optionLabels: ALIGN_LABELS, category: "text", help: "Horizontal alignment of the readout within the box width: left, center, right, or justified." },
    { key: "valign", label: "V-Align", kind: "select", options: VALIGN_OPTIONS, optionLabels: VALIGN_LABELS, category: "text", help: "Vertical placement of the readout within the box height: top, middle, or bottom." },
    // Ink reuses the PAINT-capable registry `fill` prop (solid OR gradient),
    // relabelled "Color"; text() runs it through parsePaint so a gradient fills
    // the digits.
    ...props("fill", { fill: { label: "Color", category: "formatting", help: "The color or gradient the digits are painted with. Pick a solid color or a linear/radial gradient." } }),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  presets: PRESETS,
  /**
   * Pure function. State → ONE existing ir.js text() op (local space, top-left
   * origin) whose STRING is formatClock(s.time, …) — the plaintext single-text-op
   * emit, but with a computed clock readout instead of a typed string. No new IR
   * op, no rich payload (a LEGACY single-run op the renderer wraps + aligns via
   * boxStyle/boxW). Effects (the shared EFFECTS BUNDLE, render_gpu/effects.js)
   * wrap the op; all-off = pass-through. A clock ALWAYS has a readout (at least
   * "00:00"), so there is no ghost/empty short-circuit.
   *
   * @param {object} s - the folded, equation-evaluated item state (s.time is a number)
   * @param {*} _targetWorldIR - unused (bbox widget)
   * @param {object} world - the item's world transform (effects halo mapping)
   * @returns {object[]} display-list commands
   */
  emit(s, _targetWorldIR, world) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const readout = formatClock(s.time, {
      showHours: s.showHours ?? false,
      showSeconds: s.showSeconds ?? true,
      separator: s.separator ?? ":",
      leadingZero: s.leadingZero ?? true,
      hour12: s.hour12 ?? false,
    });
    return applyEffects([text({
      text: readout,
      x: 0, y: 0,
      size: s.size ?? DEFAULT_TEXT_SIZE,
      color: s.fill ?? "#000000",
      bold: s.bold ?? false,
      font: s.font ?? DEFAULT_FONT,
      opacity: s.opacity ?? 1,
      boxW: w > 0 ? w : Infinity, // wrap to the box width; 0/absent ⇒ no wrap
      boxH: h > 0 ? h : Infinity, // box height ⇒ vertical-align room
      boxStyle: { align: s.align ?? "center", valign: s.valign ?? "middle" },
    })], s, world, { x: 0, y: 0, w, h });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  // Anchors sit on the bbox rim (the shared standard anchors) — the plaintext /
  // text choice: a readout box's selectable frame IS its bounding box.
  anchors: standardBBoxAnchors,
  // "Add Digital Clock" lives in plugins/builtin_asset_commands.js: a plugin
  // ASSET may not declare `commands` (the jail withholds the live app).
};
