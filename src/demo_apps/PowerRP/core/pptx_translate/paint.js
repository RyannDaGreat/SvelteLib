/**
 * PAINT — DeckIR's unresolved fill/line descriptors -> PowerRP paint objects
 * (mapping spec §1/§2, verdicts DIRECT). Theme colors (`{kind:"scheme", slot,
 * transforms}`) are resolved to literal hex here, at import time, per the
 * mapping spec's "importer-side math, not a PowerRP feature" verdict — a
 * `lumMod`/`lumOff`/`shade`/`tint` transform this module cannot fold is
 * reported as a refusal rather than silently dropped (core/pptx's own
 * resolveThemeColor already resolves the common `lumMod`/`lumOff` pair and
 * returns any leftover transform unapplied — see its own docs).
 *
 * "No fill" maps to `{type:"none"}`, NEVER `null` — `null` is the delta
 * delete sentinel (core/deltas.js NONE), so writing it into a fresh item's
 * creation state would be a structural bug, not an empty paint.
 */

import { resolveColorDescriptor } from "../pptx/text.js";
import { emuToPx } from "./units.js";

/** PowerRP's off-paint sentinel (render_gpu/ir.js PAINT_NONE_TYPE). Never the
 * bare `null` delta-delete sentinel — see this file's header. */
export const PAINT_NONE = { type: "none" };

/** The color a `schemeClr` falls back to when this translator has no theme
 * table to resolve it against (see resolveColorHex) — the stock Office
 * theme's own accent1, a plausible visible color rather than invisible
 * black-on-black, so a genuinely-unresolvable theme reference is at least
 * SEEN on render, not hidden. */
const UNRESOLVED_SCHEME_FALLBACK_HEX = "#4472c4";

/**
 * Pure function. A DeckIR color descriptor (`{kind:"srgb", hex}` or
 * `{kind:"scheme", slot, transforms}`) -> a `"#rrggbb"` string, PLUS any
 * transform this resolver could not fold (empty when fully resolved) AND
 * whether the theme lookup itself was skipped (`themeUnresolved`).
 * `resolveColorDescriptor` (core/pptx/text.js) already folds `lumMod`/
 * `lumOff` via theme.resolveThemeColor; what it returns unconsumed is a
 * transform kind this translator does not (yet) understand.
 *
 * A `scheme` descriptor needs `colorScheme` to carry its `slot` — and DeckIR
 * v1 (stage 1, committed, read-only) does not expose the deck's theme
 * tables at the deck level at all (measured directly: `Object.keys(
 * parsePptx(...))` has no `theme`/`colorMap` field — every run/fill color
 * descriptor already arrives pre-carrying an UNRESOLVED `{kind:"scheme",
 * slot}` with nothing upstream of this translator left to resolve it
 * against). This is a REAL stage-1/stage-2 contract gap, not a translator
 * bug — checked for HERE (a known, expected condition, not ignorance of
 * `resolveThemeColor`'s own contract) and reported LOUDLY via
 * `themeUnresolved` rather than calling into a resolver that would throw.
 *
 * @param {{kind:string, hex?:string, slot?:string, transforms?:object[]}} descriptor
 * @param {Record<string,string>} colorMap
 * @param {Record<string,string>} colorScheme
 * @returns {{hex: string, unresolvedTransforms: object[], themeUnresolved: boolean}}
 *
 * @example resolveColorHex({kind:"srgb", hex:"FF0000"}, {}, {}) // {hex: "#ff0000", unresolvedTransforms: [], themeUnresolved: false}
 * @example resolveColorHex({kind:"scheme", slot:"accent1", transforms:[]}, {}, {}).themeUnresolved // true (no theme tables supplied)
 */
export function resolveColorHex(descriptor, colorMap, colorScheme) {
  if (descriptor.kind === "scheme" && !(descriptor.slot in colorScheme || colorMap[descriptor.slot] in colorScheme))
    return { hex: UNRESOLVED_SCHEME_FALLBACK_HEX, unresolvedTransforms: [], themeUnresolved: true };
  const resolved = resolveColorDescriptor(descriptor, colorMap, colorScheme);
  if (!resolved) return { hex: "#000000", unresolvedTransforms: [{ name: "unsupported-color-kind", val: descriptor.kind }], themeUnresolved: false };
  return { hex: `#${resolved.hex.toLowerCase()}`, unresolvedTransforms: resolved.transforms, themeUnresolved: false };
}

/**
 * Pure function. A DeckIR `fill`/`line.fill` descriptor -> a PowerRP paint,
 * plus a `refusal` string when the kind is one this translator does not map
 * (gradient/picture/pattern/group fills — mapping spec verdicts NEW-WIDGET,
 * not yet built; recorded, never silently dropped) — `null` refusal means
 * fully resolved.
 *
 * `null`/absent DeckIR fill (no fill element at all in the XML — a shape
 * that inherits from style/theme, which stage 1 does not resolve) is treated
 * as PAINT_NONE: deck 1's plain textboxes have no explicit fill and paint
 * nothing visible, matching PowerPoint's rendering of them (judgment call —
 * recorded in the translator's own report as an assumption, not a silent
 * guess, via the caller).
 *
 * @param {{kind:string, color?:object, raw?:object}|null} fillIR
 * @param {Record<string,string>} colorMap
 * @param {Record<string,string>} colorScheme
 * @returns {{paint: object, refusal: string|null}}
 *
 * @example resolveFillPaint({kind:"solid", color:{kind:"srgb", hex:"336699"}}, {}, {}).paint // "#336699"
 * @example resolveFillPaint(null, {}, {}).paint // {type: "none"}
 * @example resolveFillPaint({kind:"none"}, {}, {}).paint // {type: "none"}
 */
export function resolveFillPaint(fillIR, colorMap, colorScheme) {
  if (!fillIR || fillIR.kind === "none") return { paint: PAINT_NONE, refusal: null };
  if (fillIR.kind === "solid") {
    const { hex, unresolvedTransforms, themeUnresolved } = resolveColorHex(fillIR.color, colorMap, colorScheme);
    const refusal = themeUnresolved
      ? `solid fill references theme color "${fillIR.color.slot}", but DeckIR carries no resolved theme table (stage 1/stage 2 contract gap) — used a placeholder color instead`
      : unresolvedTransforms.length
        ? `solid fill color carries unresolved transform(s) ${unresolvedTransforms.map((t) => t.name).join(",")} — used the pre-transform base color`
        : null;
    return { paint: hex, refusal };
  }
  return { paint: PAINT_NONE, refusal: `fill kind "${fillIR.kind}" has no translator mapping yet (mapping spec: gradient/picture/pattern/group fills are NEW-WIDGET-tier) — rendered as no fill` };
}

/**
 * Pure function. A DeckIR `line` descriptor -> `{stroke, strokeWidth,
 * refusal}` — mapping spec §2 DIRECT verdicts for width/color; dash/cap/join
 * are TWEAK-tier gaps not yet built into PowerRP widgets, so they are
 * reported rather than silently dropped when present.
 *
 * @param {{widthEmu:number, fill:object|null, dash:string|null, cap:string|null, compound:string|null}|null} lineIR
 * @param {Record<string,string>} colorMap
 * @param {Record<string,string>} colorScheme
 * @returns {{stroke: string, strokeWidth: number, refusal: string|null}}
 *
 * @example resolveLine({widthEmu: 12700, fill: {kind:"solid", color:{kind:"srgb", hex:"000000"}}, dash: null, cap: null, compound: null}, {}, {}).strokeWidth // 1
 */
export function resolveLine(lineIR, colorMap, colorScheme) {
  if (!lineIR) return { stroke: "#000000", strokeWidth: 0, refusal: null };
  const strokeWidth = emuToPx(lineIR.widthEmu);
  const { paint: stroke, refusal: fillRefusal } = resolveFillPaint(lineIR.fill, colorMap, colorScheme);
  const gaps = [];
  if (fillRefusal) gaps.push(fillRefusal);
  if (lineIR.dash) gaps.push(`stroke dash preset "${lineIR.dash}" has no translator mapping yet (mapping spec: PowerRP has no dash pattern on closed shapes today) — rendered solid`);
  if (lineIR.compound && lineIR.compound !== "sng") gaps.push(`compound line "${lineIR.compound}" has no translator mapping yet (mapping spec: NEW-WIDGET-tier) — rendered as a single stroke`);
  return {
    stroke: stroke === PAINT_NONE || (typeof stroke === "object" && stroke.type === "none") ? "#000000" : stroke,
    strokeWidth: stroke === PAINT_NONE || (typeof stroke === "object" && stroke.type === "none") ? 0 : strokeWidth,
    refusal: gaps.length ? gaps.join("; ") : null,
  };
}
