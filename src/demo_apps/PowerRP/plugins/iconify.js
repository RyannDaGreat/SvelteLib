/**
 * Iconify Icon — the WHOLE Iconify catalog (200k+ icons, every major set) as a
 * first-class vector widget. A thin specialization built ON the SVG widget's
 * capability WITHOUT importing it (the cursor-widget pattern, verbatim): state
 * stores only an ICON ID ("prefix:name", e.g. "tabler:database"); the icon's
 * SVG text is loaded from the Iconify API URL through the SAME
 * svg_source_registry the url-mode svg widget uses, and flattened through the
 * SAME svgToIRWithWarnings — so the SVG pipeline keeps ONE home and this file
 * is a thin curated-picker (id → url → shared flatten).
 *
 * ── WHY URLS AND NOT BUNDLED SETS ─────────────────────────────────────────────
 * The user ruling: "it loads via urls so we search thru all of iconify."
 * Bundling even one full icon set would be megabytes and always incomplete;
 * the API serves any icon of any set as a tiny SVG, and svg_source_registry
 * caches each one forever (bounded by the document's distinct icons). The
 * trade is honest: rendering an iconify widget needs NETWORK the first time
 * (like an image widget with a remote src). The bare-node cli/render.js
 * cannot fetch (its registry reads /asset/ urls off disk only) — an iconify
 * icon there draws the red error affordance and the render REPORTS it; the
 * real renderers (editor, presenter, cli/render_job.js's headless Chrome)
 * fetch it like any asset. A deck that must render fully offline should drop
 * the icon's .svg into project assets and use the svg widget's url mode
 * instead — this widget is the browse-everything convenience.
 *
 * ── THE CANVAS-TOOLBAR SEARCH PALETTE ─────────────────────────────────────────
 * Double-click opens the floating canvas toolbar (activate: "overlay_palette",
 * the cursor precedent) with a SEARCH BAR on top of a scrollable icon grid
 * (PALETTE_COLS wide): `floatingToolbar()` returns the standard `grid` spec
 * plus a `search` provider — CanvasToolbar owns the debounce and swaps the
 * grid's cells for each query's results (hover previews, click commits, the
 * same preview→commit seam as every palette). An EMPTY query shows a curated
 * starter set (DEFAULT_PALETTE) so the grid is never blank. Each result cell's
 * thumbnail is the icon's real SVG text, fetched through svg_source_registry
 * (cached, deduped, loud on failure).
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, customProps, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { decorateStrokedBox } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import { errorAffordance, warningAffordance } from "../render_gpu/affordances.js";
import { svgToIRWithWarnings } from "../render_gpu/gpu/svg_raster.js";
import { ensureSvgSource, getSvgSource, svgSourceStatus, svgSourceError } from "../render_gpu/gpu/svg_source_registry.js";

/** The Iconify API host — icon SVGs (`/<prefix>/<name>.svg`) and the search
 * endpoint (`/search?query=`) both live here. */
const ICONIFY_API = "https://api.iconify.design";

/** How many results one palette search asks for — 2 columns beyond a full
 * 5-row screen of PALETTE_COLS, so scrolling is obviously available without
 * fetching a whole set. */
const SEARCH_LIMIT = 50;

/** The palette grid's column count — the user spec: a 5-wide scrollable
 * palette under the search bar. */
const PALETTE_COLS = 5;

/** Ink for `currentColor` icons (most mono sets: tabler, mdi, lucide…) — the
 * shared INK convention (#000000). Full-color sets (logos, twemoji…) carry
 * explicit colors and ignore it. */
const ICONIFY_INK = "#000000";

/** A freshly added widget's icon — instantly recognizable, obviously an icon. */
const DEFAULT_ICON = "tabler:star";

/** The curated starter palette an EMPTY search shows (the grid must never be
 * blank). One row per theme: symbols, arrows, media, objects, tech. */
const DEFAULT_PALETTE = [
  "tabler:star", "tabler:heart", "tabler:check", "tabler:x", "tabler:alert-triangle",
  "tabler:arrow-right", "tabler:arrow-left", "tabler:arrow-up", "tabler:arrow-down", "tabler:refresh",
  "tabler:photo", "tabler:movie", "tabler:music", "tabler:video", "tabler:camera",
  "tabler:home", "tabler:user", "tabler:settings", "tabler:search", "tabler:folder",
  "tabler:database", "tabler:cpu", "tabler:cloud", "tabler:rocket", "tabler:bulb",
];

/**
 * Pure function. An Iconify icon id ("prefix:name") → the API URL serving its
 * SVG. Throws on anything that is not exactly `prefix:name` — a malformed id
 * must fail loudly at the seam, not 404 mysteriously later.
 *
 * Args:
 *   icon (string): the icon id, e.g. "tabler:database"
 *
 * Returns:
 *   string: the SVG URL
 *
 * @example iconifyIconUrl("tabler:database") // "https://api.iconify.design/tabler/database.svg"
 * @example iconifyIconUrl("mdi:robot-industrial-outline") // "https://api.iconify.design/mdi/robot-industrial-outline.svg"
 */
export function iconifyIconUrl(icon) {
  const m = typeof icon === "string" && icon.match(/^([a-z0-9-]+):([a-z0-9-]+)$/);
  if (!m) throw new Error(`iconifyIconUrl: expected "prefix:name" (lowercase, dashes), got ${JSON.stringify(icon)}`);
  return `${ICONIFY_API}/${m[1]}/${m[2]}.svg`;
}

/**
 * Command (async; network). One palette search: the Iconify search API's icon
 * ids for `query`, each with its SVG text fetched through svg_source_registry
 * (cached across searches; a failed icon fetch was reported loudly by the
 * registry and its cell is dropped). An EMPTY/whitespace query returns the
 * curated DEFAULT_PALETTE instead of hitting the API. Returns CanvasToolbar
 * grid cells: [{value, label, svg}].
 *
 * @example // await searchIconifyCells("robot") // [{value: "tabler:robot", label: "tabler:robot", svg: "<svg…"}, …]
 */
export async function searchIconifyCells(query) {
  const q = (query ?? "").trim();
  let ids;
  if (!q) {
    ids = DEFAULT_PALETTE;
  } else {
    const res = await fetch(`${ICONIFY_API}/search?query=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`);
    if (!res.ok) throw new Error(`Iconify search failed: HTTP ${res.status} ${res.statusText}`);
    ids = (await res.json()).icons ?? [];
  }
  const cells = await Promise.all(ids.map(async (id) => {
    const svg = await ensureSvgSource(iconifyIconUrl(id)); // resolves null on a (loudly reported) failure
    return svg ? { value: id, label: id, svg } : null;
  }));
  return cells.filter(Boolean);
}

// The icon id — the ONE piece of iconify-specific document state. A text row
// round-trips it; the floating-toolbar search palette is the real picker.
const CUSTOM = customProps([
  {
    name: "icon",
    kind: "text",
    default: DEFAULT_ICON,
    label: "Icon",
    category: "formatting",
    help: 'The Iconify icon id, "set:name" — e.g. "tabler:database" or "logos:openai-icon". Double-click the widget for a searchable palette over the whole Iconify catalog. Loaded from api.iconify.design, so first render needs network; use an SVG widget with a project asset for fully-offline decks.',
  },
]);

export const iconifyPlugin = {
  type: "iconify",
  title: "Iconify Icon",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // Double-click mounts the canvas-overlay palette (the cursor precedent);
  // floatingToolbar() below is its content — search bar + icon grid.
  activate: "overlay_palette",
  defaults: {
    type: "iconify", x: 140, y: 140, w: 96, h: 96, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    preserveAspect: true, // an icon must keep its shape — uniform scale-to-fit
    ink: ICONIFY_INK, // currentColor resolution for the mono sets
    stroke: "#000000",
    ...defaults("strokeWidth", "cornerRadius", "opacity"), // strokeWidth:0, cornerRadius:0, opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
    ...CUSTOM.defaults, // icon
  },
  inspector: [
    ...bundle("positioning"),
    ...CUSTOM.rows, // the icon id
    { key: "ink", label: "Color", kind: "color", category: "formatting", help: "The color used wherever the icon says currentColor — which is how the monochrome sets (tabler, mdi, lucide…) are authored. Full-color sets (logos, twemoji…) ignore it." },
    { key: "preserveAspect", label: "Preserve aspect", kind: "boolean", category: "formatting", help: "Scale the icon uniformly to fit the box (keeps its shape). Off stretches it to the box's exact width and height." },
    ...bundle("strokedBorder"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Near-pure function (the RETURNED IR is a pure function of state + the
   * source registry's cache; emit kicks an idempotent load as a side effect).
   * State → display-list commands (local space): icon id → API URL →
   * svg_source_registry text → the SHARED flatten. In flight → nothing this
   * frame (onSvgSourceLoad repaints — the url-mode svg contract). Failed →
   * the loud red error affordance naming the icon. Flatten warnings keep the
   * art and gain the amber band, exactly like the svg widget.
   */
  emit(s, _targetWorldIR, world) {
    const w = s.w ?? 0, h = s.h ?? 0;
    if (w <= 0 || h <= 0) return [];
    if (!s.icon) return []; // GHOST — no icon authored
    const style = { x: 0, y: 0, w, h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
    const finish = (ops) => applyEffects(decorateStrokedBox(ops, style, world), s, world, { x: 0, y: 0, w, h });
    let url;
    try {
      url = iconifyIconUrl(s.icon);
    } catch (e) {
      return finish(errorAffordance(w, h, e instanceof Error ? e.message : String(e)));
    }
    let src = getSvgSource(url);
    if (src === null) {
      ensureSvgSource(url); // idempotent kick (sync-resolving in bare node, where it fails loudly for non-asset urls)
      src = getSvgSource(url);
    }
    if (src === null) {
      if (svgSourceStatus(url) === "error")
        return finish(errorAffordance(w, h, `failed to load icon "${s.icon}": ${svgSourceError(url)}`));
      return []; // in flight — a repaint follows the load
    }
    let ops;
    try {
      const flat = svgToIRWithWarnings(src, w, h, { ink: s.ink ?? ICONIFY_INK, preserveAspect: s.preserveAspect !== false, opacity: s.opacity ?? 1 });
      ops = flat.warnings.length ? [...flat.ops, ...warningAffordance(w, h, flat.warnings)] : flat.ops;
    } catch (e) {
      ops = errorAffordance(w, h, e instanceof Error ? e.message : String(e));
    }
    return finish(ops);
  },
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  /**
   * Pure function (a spec; the CELLS arrive asynchronously through `search.run`).
   * The declarative floating-toolbar content: the standard `grid` picker over
   * `icon`, plus a `search` provider — CanvasToolbar renders the search bar,
   * debounces input, and swaps the grid's cells for each query's results
   * (empty query → the curated starter palette). `cols` narrows the grid to
   * the user-spec 5-wide scrollable palette.
   */
  floatingToolbar(state) {
    return {
      label: "Iconify icons",
      grid: { property: "icon", value: state.icon ?? DEFAULT_ICON, cells: [], cols: PALETTE_COLS },
      search: { placeholder: "Search all of Iconify…", run: searchIconifyCells },
    };
  },
  commands: [
    { id: "add-iconify", title: "Add Iconify Icon", icon: "simple-icons:iconify", run: (app) => app.armCrosshairPlacement(iconifyPlugin) },
  ],
};
