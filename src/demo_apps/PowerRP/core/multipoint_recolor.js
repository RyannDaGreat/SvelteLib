/**
 * MULTIPOINT COLOUR BRAINSTORMING — the pure half of applying the 1-D RAMP LIBRARY
 * to a Multipoint fill: a GRADIENT MAP of the whole fill (every colour replaced by
 * the ramp colour at its lightness) and a RAMP ALONG ONE PATH (the ramp laid on a
 * line/curve source's arc length). Geometry is never touched — the user's reason:
 * "keep the same shape and position of all the dots, but quickly brainstorm
 * different ideas for the colors". The manifest section "Colour brainstorming from
 * the ramp library" states the design and every WHY.
 *
 * A ramp here is the library's value shape {stops: [{offset, color}], loop, space}
 * (core/ramps.js). Multipoint blends stops in premultiplied ENCODED sRGB, so an sRGB
 * clamped ramp maps verbatim and anything else is sampled through the real ramp
 * sampler (sampleRampHex) at stated offsets.
 */
import { DEFAULT_RAMP_SPACE, checkRampStops, sampleRampHex, srgbToLinear, linearSrgbToOklab } from "./ramps.js";
import { elementActive } from "./lists.js";
import { rgbToHex } from "./interpolators.js";
import { isEquationString, stopColorAt, visibleNodeIndices } from "./multipoint_edit.js";
import { parseColor } from "../render_gpu/ir.js";

/**
 * Samples PER RAMP SEGMENT when an OKLab ramp is laid on a path (Multipoint can only
 * blend encoded sRGB between stops). Samples sit at every authored stop — the ramp's
 * corners, which evenly spaced samples straddle — plus this many − 1 points inside
 * each segment. Measured over all 12 shipped OKLab ramps
 * (.scratchpad/multipoint_ramps/deltae_error.mjs, concerns.md 2026-09-30): worst OKLab
 * ΔE 0.058 at 1, 0.035 at 2, 0.030 at 3 (JND ≈ 0.02); 2 keeps the longest list at 25
 * stops, short enough to edit by hand. An sRGB ramp needs 1 (it IS sRGB-linear).
 */
export const MULTIPOINT_RAMP_SUBDIVISIONS = 2;
/** Lightness spans narrower than this are one lightness: every colour maps to the
 *  ramp's middle rather than dividing by ~0. */
const FLAT_LIGHTNESS = 1e-6;
const RAMP_MIDDLE = 0.5;
const BYTE_MAX = 255;

/**
 * Pure function. A clamped ramp re-read as a LOOP for a CLOSED path, whose ends meet:
 * its stops compressed by (n−1)/n so the synthesised wrap segment (last → first) is
 * one average segment long. A clamped ramp laid on a ring as-is would jump at the seam.
 * @param {{stops: {offset:number, color:string}[], space?: string}} ramp - Two+ stops.
 * @returns {{stops: {offset:number, color:string}[], loop: true, space: string}}
 * @example loopedForClosedPath({stops:[{offset:0,color:"#000000"},{offset:1,color:"#ffffff"}]}).stops.map((s) => s.offset) // [0, 0.5]
 * @example loopedForClosedPath({stops:[{offset:0,color:"#f00"},{offset:0.5,color:"#0f0"},{offset:1,color:"#00f"}]}).stops.map((s) => s.offset) // [0, 0.333…, 0.666…]
 */
export function loopedForClosedPath(ramp) {
  const scale = (ramp.stops.length - 1) / ramp.stops.length;
  return { stops: ramp.stops.map((s) => ({ offset: s.offset * scale, color: s.color })), loop: true, space: ramp.space ?? DEFAULT_RAMP_SPACE };
}

/**
 * Pure function. The stop list (offsets = normalized arc length) that shows `ramp`
 * along a path. sRGB clamped → the authored stops verbatim; sRGB looping → its stops
 * plus the wrap colour stated at 0 and 1; OKLab → sampled at 0, 1, every authored stop
 * and MULTIPOINT_RAMP_SUBDIVISIONS − 1 points inside each segment.
 * A closed path reads a clamped ramp through loopedForClosedPath, so its first and last
 * colours are equal (no seam). `reversed` runs the ramp from the path's end.
 * @param {{stops: {offset:number, color:string}[], loop?: boolean, space?: string}} ramp - Library ramp value.
 * @param {{closed?: boolean, reversed?: boolean}} options - The path's Closed flag; direction.
 * @returns {{offset:number, color:string}[]} Non-decreasing offsets in [0,1].
 * @example rampPathStops({stops:[{offset:0,color:"#000000"},{offset:1,color:"#ffffff"}], loop:false, space:"srgb"}) // [{offset:0,color:"#000000"},{offset:1,color:"#ffffff"}]
 * @example rampPathStops({stops:[{offset:0,color:"#000000"},{offset:1,color:"#ffffff"}], loop:false, space:"srgb"}, {closed:true}) // [{offset:0,color:"#000000"},{offset:0.5,color:"#ffffff"},{offset:1,color:"#000000"}]
 * @example rampPathStops({stops:[{offset:0,color:"#ff0000"},{offset:1,color:"#0000ff"}], loop:false, space:"srgb"}, {reversed:true}) // [{offset:0,color:"#0000ff"},{offset:1,color:"#ff0000"}]
 * @example rampPathStops({stops:[{offset:0,color:"#000000"},{offset:1,color:"#ffffff"}], loop:false, space:"oklab"}).map((s) => s.offset) // [0, 0.5, 1] (resampled)
 */
export function rampPathStops(ramp, { closed = false, reversed = false } = {}) {
  checkRampStops(ramp.stops);
  const space = ramp.space ?? DEFAULT_RAMP_SPACE;
  const read = closed && !ramp.loop ? loopedForClosedPath(ramp) : { stops: ramp.stops, loop: !!ramp.loop, space };
  let stops;
  if (space === DEFAULT_RAMP_SPACE && !read.loop) {
    stops = read.stops.map((s) => ({ offset: Math.max(0, Math.min(1, s.offset)), color: s.color }));
  } else {
    const per = space === DEFAULT_RAMP_SPACE ? 1 : MULTIPOINT_RAMP_SUBDIVISIONS;
    const breaks = [...new Set([0, ...read.stops.map((s) => s.offset), 1])].filter((o) => o >= 0 && o <= 1).sort((a, b) => a - b);
    const offsets = [breaks[0]];
    for (let i = 1; i < breaks.length; i++)
      for (let j = 1; j <= per; j++) offsets.push(breaks[i - 1] + (breaks[i] - breaks[i - 1]) * j / per);
    stops = offsets.map((offset) => ({ offset, color: sampleRampHex(read.stops, offset, read) }));
  }
  return reversed ? stops.map((s) => ({ offset: 1 - s.offset, color: s.color })).reverse() : stops;
}

/**
 * Pure function. A source's new stop list with `pathStops` applied to one side or both.
 * "both" → the ramp on both sides. "color"/"rightColor" → the ramp on that side while
 * the OTHER side is re-sampled (stopColorAt) at every offset of the union, so its
 * picture does not change. The result is fully visible (the caller resets stopsActive).
 * @param {object} feature - Stored feature; its visible stops are read for the kept side.
 * @param {{offset:number, color:string}[]} pathStops - From rampPathStops.
 * @param {"both"|"color"|"rightColor"} side - Which side receives the ramp.
 * @returns {{offset:number, color:string, rightColor:string}[]}
 * @example rampAppliedStops({stops:[{offset:0,color:"#000000",rightColor:"#000000"}]}, [{offset:0,color:"#ff0000"},{offset:1,color:"#0000ff"}], "both") // [{offset:0,color:"#ff0000",rightColor:"#ff0000"},{offset:1,color:"#0000ff",rightColor:"#0000ff"}]
 * @example rampAppliedStops({stops:[{offset:0.5,color:"#00ff00",rightColor:"#ffffff"}]}, [{offset:0,color:"#000000"},{offset:1,color:"#ffffff"}], "color") // [{offset:0,color:"#000000",rightColor:"#ffffff"},{offset:0.5,color:"#808080",rightColor:"#ffffff"},{offset:1,color:"#ffffff",rightColor:"#ffffff"}]
 */
export function rampAppliedStops(feature, pathStops, side) {
  if (side === "both") return pathStops.map((s) => ({ offset: s.offset, color: s.color, rightColor: s.color }));
  if (side !== "color" && side !== "rightColor") throw new Error(`rampAppliedStops: unknown side "${side}"`);
  const kept = side === "color" ? "rightColor" : "color";
  const ramp = { stops: pathStops };
  const existing = feature.stops
    .filter((s, i) => elementActive(feature.stopsActive, i) && Number.isFinite(s?.offset))
    .map((s) => Math.max(0, Math.min(1, s.offset)))
    .filter((o) => !pathStops.some((p) => p.offset === o));
  const rows = [...pathStops.map((p) => ({ offset: p.offset, applied: p.color })),
    ...existing.map((offset) => ({ offset, applied: stopColorAt(ramp, offset, "color") }))]
    .sort((a, b) => a.offset - b.offset); // stable: coincident ramp stops keep their order
  return rows.map(({ offset, applied }) => ({ offset, [side]: applied, [kept]: stopColorAt(feature, offset, kept) }))
    .map((s) => ({ offset: s.offset, color: s.color, rightColor: s.rightColor }));
}

/**
 * Pure function. Perceptual lightness of a colour: OKLab L of its sRGB value (alpha
 * ignored), in [0,1]. OKLab rather than luma so "same lightness" means what it looks.
 * @param {string} color - Any colour parseColor accepts.
 * @returns {number}
 * @example colorLightness("#000000") // 0
 * @example +colorLightness("#ffffff").toFixed(4) // 1
 * @example colorLightness("#ffff00") > colorLightness("#0000ff") // true (yellow reads far lighter than blue)
 */
export function colorLightness(color) {
  const [r, g, b] = parseColor(color);
  return linearSrgbToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b))[0];
}

/**
 * Pure function. The colour sides that SHOW in a stored multipoint sub-state: visible
 * sources, their visible stops, the right side only on a two-sided path, a point's
 * first visible colour only. These set the gradient map's lightness range.
 * @param {{features: object[], featuresActive?: *}} multipoint - Stored sub-state.
 * @returns {string[]} Literal colours (equations excluded).
 * @example effectiveColors({features:[{nodes:[[0,0,0,0,0,0]], stops:[{offset:0,color:"#111111",rightColor:"#eeeeee"}]}]}) // ["#111111"]
 */
export function effectiveColors(multipoint) {
  const out = [];
  multipoint.features.forEach((f, fi) => {
    if (!elementActive(multipoint.featuresActive, fi) || !Array.isArray(f?.stops) || !Array.isArray(f?.nodes)) return;
    const visible = f.stops.map((_, i) => i).filter((i) => elementActive(f.stopsActive, i));
    const isPoint = visibleNodeIndices(f).length === 1;
    for (const i of isPoint ? visible.slice(0, 1) : visible) {
      const sides = !isPoint && f.twoSided === true ? ["color", "rightColor"] : ["color"];
      for (const side of sides) {
        const c = f.stops[i]?.[side];
        if (typeof c === "string" && !isEquationString(c)) out.push(c);
      }
    }
  });
  return out;
}

/**
 * Pure function. Where on the ramp a colour lands in a gradient map: its lightness
 * normalised over [lo, hi] (a flat range maps to the middle), reversed on request,
 * clamped (hidden colours may lie outside the visible range).
 * @param {number} lightness - colorLightness of the colour.
 * @param {number} lo - Darkest effective lightness.
 * @param {number} hi - Lightest effective lightness.
 * @param {boolean} reversed - Map dark to the ramp's END.
 * @returns {number} In [0,1].
 * @example gradientMapPosition(0.25, 0, 0.5, false) // 0.5
 * @example gradientMapPosition(0.25, 0, 0.5, true) // 0.5
 * @example gradientMapPosition(0.1, 0.3, 0.3, false) // 0.5 (one lightness: the middle)
 */
export function gradientMapPosition(lightness, lo, hi, reversed) {
  const t = hi - lo < FLAT_LIGHTNESS ? RAMP_MIDDLE : Math.max(0, Math.min(1, (lightness - lo) / (hi - lo)));
  return reversed ? 1 - t : t;
}

/**
 * Pure function. THE GRADIENT MAP: the writes that replace every literal colour of a
 * stored multipoint sub-state with the ramp colour at its normalised lightness, alpha
 * kept (times the ramp's). A looping ramp is read from its first to its last stop (its
 * wrap would make darkest and lightest identical). Equation colours and equation-bound
 * stop lists are skipped and named. Only colours that change are written.
 * @param {{features: object[], featuresActive?: *}} multipoint - Stored sub-state (committed).
 * @param {{stops: {offset:number, color:string}[], loop?: boolean, space?: string}} ramp - Library ramp value.
 * @param {{reversed?: boolean}} options - Direction.
 * @returns {{writes: Array<[Array, string]>, skipped: string[]}} Paths relative to `multipoint`.
 * @example gradientMapWrites({features:[{nodes:[[0,0,0,0,0,0]],stops:[{offset:0,color:"#000000"}]},{nodes:[[1,1,0,0,0,0]],stops:[{offset:0,color:"#ffffff"}]}]}, {stops:[{offset:0,color:"#ff0000"},{offset:1,color:"#0000ff"}], loop:false, space:"srgb"}).writes // [[["features",0,"stops",0,"color"],"#ff0000"],[["features",1,"stops",0,"color"],"#0000ff"]]
 */
export function gradientMapWrites(multipoint, ramp, { reversed = false } = {}) {
  checkRampStops(ramp.stops);
  if (!Array.isArray(multipoint?.features)) return { writes: [], skipped: ["the source list is an equation"] };
  const read = { stops: ramp.stops, loop: !!ramp.loop, space: ramp.space ?? DEFAULT_RAMP_SPACE };
  const span = read.loop ? ramp.stops.at(-1).offset - ramp.stops[0].offset : 1;
  const start = read.loop ? ramp.stops[0].offset : 0;
  const lightness = effectiveColors(multipoint).map(colorLightness);
  const lo = Math.min(...lightness), hi = Math.max(...lightness);
  const writes = [], skipped = [];
  multipoint.features.forEach((f, fi) => {
    if (!Array.isArray(f?.stops)) return void skipped.push(`source ${fi + 1}'s colour list is an equation`);
    f.stops.forEach((stop, si) => {
      for (const side of ["color", "rightColor"]) {
        const c = stop?.[side];
        if (c === undefined) continue;
        if (typeof c !== "string" || isEquationString(c)) { skipped.push(`source ${fi + 1} colour ${si + 1} is an equation`); continue; }
        const t = gradientMapPosition(colorLightness(c), lo, hi, reversed);
        const [r, g, b, a] = parseColor(sampleRampHex(read.stops, start + t * span, read));
        const alpha = a * parseColor(c)[3];
        const bytes = [r, g, b].map((v) => v * BYTE_MAX);
        const hex = rgbToHex(Math.round(alpha * BYTE_MAX) >= BYTE_MAX ? bytes : [...bytes, alpha * BYTE_MAX]);
        if (hex !== c) writes.push([["features", fi, "stops", si, side], hex]);
      }
    });
  });
  return { writes, skipped: [...new Set(skipped)] };
}
