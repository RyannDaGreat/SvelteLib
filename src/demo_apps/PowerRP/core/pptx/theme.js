/**
 * THEME — color scheme + font scheme resolution, including the `p:clrMap`
 * indirection and the `+mj-lt`/`+mn-lt` "theme font" tokens a run's `<a:latin
 * typeface="+mn-lt"/>` uses instead of naming a real font.
 *
 * TWO LEVELS OF COLOR INDIRECTION, BOTH REQUIRED (measured on the real deck —
 * `.frenzy/r10/primary_unzipped/ppt/slideMasters/slideMaster1.xml`'s
 * `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" .../>`):
 *   1. A `<a:schemeClr val="bg1">` in a slide/layout/master names a SLOT
 *      (`bg1`/`tx1`/`bg2`/`tx2`/`accent1..6`/`hlink`/`folHlink`), not a color
 *      directly.
 *   2. The MASTER's `p:clrMap` maps each slot to the theme's twelve named
 *      scheme colors (`dk1`/`lt1`/`dk2`/`lt2`/`accent1..6`/`hlink`/`folHlink`),
 *      which is where the actual `<a:srgbClr>`/`<a:sysClr>` hex lives.
 *   A layout MAY override the map via its own `p:clrMapOvr/p:overrideClrMapping`
 *   (not present in the primary deck, but legal per ECMA-376) — resolveThemeColor
 *   takes the EFFECTIVE map as a parameter rather than assuming the master's,
 *   so a caller that finds an override passes it through unchanged.
 *
 * COLOR TRANSFORMS (`lumMod`/`lumOff`/`shade`/`tint`/`alpha`/`satMod`/…) are
 * REAL in this deck (`shade val="50000"` on `accent1`, `lumMod val="75000"` on
 * `bg1`) but this module does NOT implement the HSL transform math — per the
 * task spec, an unimplemented color transform is RECORDED RAW rather than
 * guessed. `resolveThemeColor` returns both the flat theme hex AND the list of
 * transform elements untouched; deck.js is the seam that turns an untransformed
 * list into a clean color and a non-empty list into a `refusals` entry (the
 * base hex is still usable — it is the CORRECT color pre-transform, which is a
 * far better degraded picture than refusing the whole shape).
 *
 * `+mj-lt`/`+mn-lt` (major/minor LATIN theme font) — and their `+mj-ea`/`+mn-ea`
 * (East Asian) / `+mj-cs`/`+mn-cs` (complex script) siblings — are how a run
 * says "use the theme's title font" / "use the theme's body font" instead of a
 * literal typeface name (ECMA-376 §20.1.4.1.18, `ST_TextTypeface`).
 */

import { parseXml, xmlChild, xmlAttr } from "./xml.js";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";

/** The twelve named theme scheme-color slots, in the order ECMA-376 declares
 * them inside `<a:clrScheme>`. */
export const SCHEME_COLOR_SLOTS = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];

/** The `p:clrMap` slot names a `<a:schemeClr val="…">` may reference — distinct
 * from SCHEME_COLOR_SLOTS because these are the MAPPED names (bg1/tx1/bg2/tx2
 * plus the six accents and both hyperlink slots, which pass through the map
 * unchanged per ECMA-376's clrMap schema). */
export const CLR_MAP_SLOTS = ["bg1", "tx1", "bg2", "tx2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];

/**
 * Pure function. Read one `<a:dk1>`/`<a:lt1>`/… scheme-color-definition
 * element's resolved hex — it wraps exactly one color child, either
 * `<a:srgbClr val="RRGGBB"/>` (a literal) or `<a:sysClr val="windowText"
 * lastClr="000000"/>` (a system color, where `lastClr` is the hex PowerPoint
 * cached at save time — the only value available without a live OS theme, and
 * what every reader including PowerPoint itself falls back to off-screen).
 *
 * @param {object} slotNode - e.g. the `<a:dk1>` element
 * @returns {string} 6-hex-digit uppercase color, no "#"
 *
 * @example readColorSlot(parseXml('<a:dk1 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:srgbClr val="112233"/></a:dk1>')) // "112233"
 */
export function readColorSlot(slotNode) {
  const srgb = xmlChild(slotNode, A, "srgbClr");
  if (srgb) {
    const val = xmlAttr(srgb, null, "val");
    if (!val) throw new Error(`<a:srgbClr> in <${slotNode.local}> has no val attribute`);
    return val.toUpperCase();
  }
  const sys = xmlChild(slotNode, A, "sysClr");
  if (sys) {
    const last = xmlAttr(sys, null, "lastClr");
    if (!last) throw new Error(`<a:sysClr> in <${slotNode.local}> has no lastClr attribute (needed since this parser has no live OS theme)`);
    return last.toUpperCase();
  }
  throw new Error(`<${slotNode.local}> has neither <a:srgbClr> nor <a:sysClr> — unrecognized color definition`);
}

/**
 * Pure function. Parse a theme part's `<a:clrScheme>` into a flat
 * slot -> hex map covering all twelve SCHEME_COLOR_SLOTS.
 *
 * @param {object} themeRoot - parseXml() result of a themeN.xml part
 * @returns {Record<string,string>}
 *
 * @example parseColorScheme(themeRoot).accent1 // "4472C4"
 */
export function parseColorScheme(themeRoot) {
  const themeElements = xmlChild(themeRoot, A, "themeElements");
  if (!themeElements) throw new Error("theme part has no <a:themeElements>");
  const clrScheme = xmlChild(themeElements, A, "clrScheme");
  if (!clrScheme) throw new Error("theme part has no <a:clrScheme>");
  const out = {};
  for (const slot of SCHEME_COLOR_SLOTS) {
    const el = xmlChild(clrScheme, A, slot);
    if (!el) throw new Error(`theme <a:clrScheme> is missing required slot <a:${slot}>`);
    out[slot] = readColorSlot(el);
  }
  return out;
}

/**
 * Pure function. Parse a `<p:clrMap ...>` element's attributes (from a
 * `slideMaster` or a layout's `p:clrMapOvr/p:overrideClrMapping`) into a flat
 * mappedSlot -> schemeSlot record.
 *
 * @param {object} clrMapNode - the `<p:clrMap>` or `<p:overrideClrMapping>` element
 * @returns {Record<string,string>}
 *
 * @example
 * >>> parseColorMap(parseXml('<p:clrMap xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>')).bg1
 * "lt1"
 */
export function parseColorMap(clrMapNode) {
  const out = {};
  for (const slot of CLR_MAP_SLOTS) {
    const mapped = xmlAttr(clrMapNode, null, slot);
    if (!mapped) throw new Error(`<${clrMapNode.local}> is missing required mapping for "${slot}"`);
    out[slot] = mapped;
  }
  return out;
}

/**
 * Pure function. Parse a theme part's `<a:fontScheme>` into
 * `{major: {latin, ea, cs}, minor: {latin, ea, cs}}` typeface name records —
 * what `+mj-lt`/`+mn-lt`/etc. resolve to. An empty `typeface=""` (legal —
 * theme1.xml's own `<a:ea typeface=""/>`) is kept as `""`, not coerced to
 * null, so a caller can tell "theme declares no East Asian font" from "this
 * field was never read".
 *
 * @param {object} themeRoot - parseXml() result of a themeN.xml part
 * @returns {{major: {latin: string, ea: string, cs: string}, minor: {latin: string, ea: string, cs: string}}}
 *
 * @example parseFontScheme(themeRoot).major.latin // "Calibri Light"
 */
export function parseFontScheme(themeRoot) {
  const themeElements = xmlChild(themeRoot, A, "themeElements");
  if (!themeElements) throw new Error("theme part has no <a:themeElements>");
  const fontScheme = xmlChild(themeElements, A, "fontScheme");
  if (!fontScheme) throw new Error("theme part has no <a:fontScheme>");
  const readSet = (tag) => {
    const setNode = xmlChild(fontScheme, A, tag);
    if (!setNode) throw new Error(`theme <a:fontScheme> is missing <a:${tag}>`);
    const readFace = (faceTag) => {
      const el = xmlChild(setNode, A, faceTag);
      if (!el) throw new Error(`theme <a:${tag}> is missing <a:${faceTag}>`);
      return xmlAttr(el, null, "typeface", "");
    };
    return { latin: readFace("latin"), ea: readFace("ea"), cs: readFace("cs") };
  };
  return { major: readSet("majorFont"), minor: readSet("minorFont") };
}

/** The theme-font token prefix each script slot uses in `<a:latin
 * typeface="+mn-lt"/>`-style references (ECMA-376 ST_TextTypeface). */
const THEME_FONT_TOKENS = { "+mj-lt": ["major", "latin"], "+mn-lt": ["minor", "latin"], "+mj-ea": ["major", "ea"], "+mn-ea": ["minor", "ea"], "+mj-cs": ["major", "cs"], "+mn-cs": ["minor", "cs"] };

/**
 * Pure function. Whether a typeface string is a theme-font token
 * (`+mj-lt`/`+mn-lt`/…) rather than a literal font name.
 *
 * @param {string} typeface
 * @returns {boolean}
 *
 * @example isThemeFontToken("+mn-lt") // true
 * @example isThemeFontToken("Calibri") // false
 */
export function isThemeFontToken(typeface) {
  return typeface in THEME_FONT_TOKENS;
}

/**
 * Pure function. Resolve a typeface string to its EFFECTIVE font family name:
 * a theme-font token resolves through `fontScheme`, a literal name passes
 * through unchanged.
 *
 * @param {string} typeface - e.g. "+mn-lt" or "Futura Medium"
 * @param {{major: {latin,ea,cs}, minor: {latin,ea,cs}}} fontScheme
 * @returns {string}
 *
 * @example resolveThemeFont("+mn-lt", {major:{latin:"Calibri Light",ea:"",cs:""}, minor:{latin:"Calibri",ea:"",cs:""}}) // "Calibri"
 * @example resolveThemeFont("Futura Medium", {major:{latin:"Calibri Light",ea:"",cs:""}, minor:{latin:"Calibri",ea:"",cs:""}}) // "Futura Medium"
 */
export function resolveThemeFont(typeface, fontScheme) {
  const token = THEME_FONT_TOKENS[typeface];
  if (!token) return typeface;
  const [set, script] = token;
  return fontScheme[set][script];
}

/**
 * Pure function. Resolve a `<a:schemeClr val="bg1">`-style element (or bare
 * slot name) all the way to a hex color plus its untransformed modifier list.
 * `slotName` is the `val` attribute (a CLR_MAP_SLOTS name); `colorMap` is the
 * effective `p:clrMap`; `scheme` is `parseColorScheme`'s output.
 *
 * COLOR TRANSFORM CHILDREN (`lumMod`/`lumOff`/`shade`/`tint`/`satMod`/`alpha`/…,
 * if any exist as children of the SOURCE `<a:schemeClr>` element) are returned
 * RAW, unapplied — see this file's header. `hex` is always the pre-transform
 * theme color, which is correct whenever `transforms` is empty and an honest
 * approximation otherwise.
 *
 * @param {string} slotName - a CLR_MAP_SLOTS name, e.g. "bg1" or "accent1"
 * @param {Record<string,string>} colorMap - parseColorMap() output (the effective clrMap)
 * @param {Record<string,string>} scheme - parseColorScheme() output
 * @param {object[]} [transformChildren] - the `<a:schemeClr>` element's child nodes (modifiers)
 * @returns {{hex: string, transforms: {name: string, val: string}[]}}
 *
 * @example
 * >>> resolveThemeColor("bg1", {bg1: "lt1"}, {lt1: "FFFFFF"}).hex
 * "FFFFFF"
 * @example
 * >>> resolveThemeColor("accent1", {accent1: "accent1"}, {accent1: "4472C4"}, [{type:"element", local:"shade", ns:"urn:a", attrs:[{ns:null,local:"val",name:"val",value:"50000"}], children:[]}]).transforms
 * [{"name": "shade", "val": "50000"}]
 */
export function resolveThemeColor(slotName, colorMap, scheme, transformChildren = []) {
  const schemeSlot = colorMap[slotName];
  if (!schemeSlot) throw new Error(`"${slotName}" is not a known color-map slot (expected one of ${CLR_MAP_SLOTS.join(", ")})`);
  const hex = scheme[schemeSlot];
  if (!hex) throw new Error(`color map slot "${slotName}" points at unknown scheme color "${schemeSlot}"`);
  const transforms = transformChildren
    .filter((c) => c.type === "element" && c.ns === A)
    .map((c) => ({ name: c.local, val: xmlAttr(c, null, "val", "") }));
  return { hex, transforms };
}

/**
 * Query (reads a package). Load and resolve a theme part into
 * `{colorScheme, fontScheme}` — the two pure lookup tables every downstream
 * color/font resolution reads.
 *
 * @param {{partText: (p:string)=>string}} pkg - an openPackage() result
 * @param {string} themePartPath - archive path to the themeN.xml part
 * @returns {{colorScheme: Record<string,string>, fontScheme: object}}
 */
export function loadTheme(pkg, themePartPath) {
  const root = parseXml(pkg.partText(themePartPath));
  return { colorScheme: parseColorScheme(root), fontScheme: parseFontScheme(root) };
}
