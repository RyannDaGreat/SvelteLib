/**
 * THE COLOUR-RAMP PRESET LIBRARY — the ASSEMBLY POINT, not a data file. It holds
 * NO colours of its own: it names the families and reads each one's records from
 * wherever that family already lives, so there is exactly one home per family and
 * nothing here to keep in step with anything.
 *
 *   gradients — web/gradient_presets.js: 343 named gradients baked from the `rp`
 *               Python library at author time (a GENERATED file, untouched by this
 *               module). Absolute stop offsets in [0, 1]; they were authored as
 *               gradients, so they CLAMP (loop: false) and blend in sRGB like every
 *               other gradient in the app.
 *   cyclic    — core/ramps.js CYCLIC_RAMPS: the six palettes the Mandelbrot widget
 *               shipped as a hard-coded `select`, now ordinary ramp DATA. They carry
 *               loop: true and space: "oklab" WITH them, because those are ramp
 *               aspects and a cyclic OKLab ramp read as a clamped sRGB one is a
 *               different ramp. plugins/demo/mandelbrot.js reads its default ramp and
 *               its nine COLOUR presets from that SAME object, so a preset swatch and
 *               the preset that shares its name cannot disagree.
 *
 * WHY THIS FILE EXISTS AT ALL rather than the picker importing both: the picker is a
 * CONTROL and should not know which libraries exist — the mount point tells it. And
 * the alternative to one assembly point was a second copy of either family, which is
 * the hand-maintained-mirror defect this codebase already carries at six-plus
 * instances. There is not going to be a seventh.
 *
 * A PRESET RECORD is a whole RAMP VALUE, not merely a stop list: {name, stops,
 * loop, space}. That is what lets picking "gold" for a Mandelbrot palette land
 * cyclic and perceptual, and picking a gradient for a rect's fill land clamped —
 * from one control, with no branch anywhere (presets are DATA).
 */

import { GRADIENT_PRESETS } from "./gradient_presets.js";
import { CYCLIC_RAMPS, DEFAULT_RAMP_SPACE } from "../core/ramps.js";

/**
 * Pure function. One preset record from a baked GRADIENT preset: its stops as
 * authored, read as a CLAMPED sRGB ramp (which is what a gradient has always
 * been, so a picked gradient renders exactly as it did before ramps existed).
 *
 * @param {{name: string, stops: object[]}} preset - a GRADIENT_PRESETS entry
 * @returns {{name: string, stops: object[], loop: boolean, space: string}}
 *
 * @example gradientPresetRecord({name: "x", stops: [{offset: 0, color: "#000000"}]}).loop // false
 * @example gradientPresetRecord({name: "x", stops: [{offset: 0, color: "#000000"}]}).space // "srgb"
 * @example gradientPresetRecord({name: "sunset", stops: []}).name // "sunset"
 */
export function gradientPresetRecord(preset) {
  return { name: preset.name, stops: preset.stops, loop: false, space: DEFAULT_RAMP_SPACE };
}

/**
 * Pure function. One preset record from a named CYCLIC ramp — its label is the
 * human name the retired `palette` select showed, so the six palettes keep the
 * exact wording a user of the old widget already knew.
 *
 * @param {object} ramp - a CYCLIC_RAMPS entry
 * @returns {{name: string, stops: object[], loop: boolean, space: string}}
 *
 * @example cyclicPresetRecord({id: "gold", label: "Gold (molten metal)", stops: [], loop: true, space: "oklab"}).name // "Gold (molten metal)"
 * @example cyclicPresetRecord({id: "gold", label: "Gold", stops: [], loop: true, space: "oklab"}).loop // true
 */
export function cyclicPresetRecord(ramp) {
  return { name: ramp.label, stops: ramp.stops, loop: ramp.loop, space: ramp.space };
}

/**
 * THE FAMILIES, in the order the picker lists them. `[{id, title, presets}]` — the
 * SAME shape core/registry.js presetFamilies uses for a plugin's Tools-pane preset
 * groups, so the one already-established preset-grouping shape serves here too.
 *
 * CYCLIC FIRST, deliberately: a Mandelbrot palette MUST cycle (a clamped ramp
 * renders as one flat colour at depth), so the six ramps that do are the ones a
 * fractal user wants at the top of the grid. A gradient user scrolls past six
 * swatches to reach 343; a fractal user would otherwise scroll past 343 to reach
 * the only six that work.
 *
 * @example RAMP_PRESET_FAMILIES.map((f) => f.id) // ["cyclic", "gradients"]
 * @example RAMP_PRESET_FAMILIES[0].presets.length // 6
 */
export const RAMP_PRESET_FAMILIES = [
  {
    id: "cyclic",
    title: "Cyclic ramps (seamless, perceptual)",
    presets: Object.values(CYCLIC_RAMPS).map(cyclicPresetRecord),
  },
  {
    id: "gradients",
    title: "Gradients",
    presets: GRADIENT_PRESETS.map(gradientPresetRecord),
  },
];

/**
 * Pure function. Case-insensitive substring filter over a family's presets by
 * name, dropping families left with nothing — so a search shows only the families
 * that matched, and an empty query shows every family unchanged (by identity).
 *
 * @param {object[]} families - [{id, title, presets}]
 * @param {string} query - the search text
 * @returns {object[]} the families that still have presets
 *
 * @example filterRampFamilies([{id: "a", title: "A", presets: [{name: "sunset"}, {name: "ocean"}]}], "sun")[0].presets.length // 1
 * @example filterRampFamilies([{id: "a", title: "A", presets: [{name: "sunset"}]}], "  ")[0].presets.length // 1
 * @example filterRampFamilies([{id: "a", title: "A", presets: [{name: "sunset"}]}], "zzz") // []
 */
export function filterRampFamilies(families, query) {
  const q = query.trim().toLowerCase();
  if (!q) return families;
  return families
    .map((f) => ({ ...f, presets: f.presets.filter((p) => p.name.toLowerCase().includes(q)) }))
    .filter((f) => f.presets.length > 0);
}
