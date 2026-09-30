/**
 * The native Multipoint preset catalog: editable paints, not images or material
 * shaders. Coordinates/relative handles use the unit paint box; stops address arc
 * length, independently of nodes. Each FAMILY lives in core/multipoint_presets/<file>.js
 * (its presets plus family-specific geometry); shared geometry is core/multipoint_shapes.js
 * and the feature/entry builders are core/multipoint_presets/builders.js.
 * Family order is the picker's order. Tests here verify DATA; thumbnails are rendered
 * by cli/build_multipoint_thumbnails.mjs with the real solver.
 */
import { PRESETS as SIGNATURE } from "./multipoint_presets/signature.js";
import { PRESETS as SOFT_BLENDS } from "./multipoint_presets/soft_blends.js";
import { PRESETS as CLASSIC_SHAPES } from "./multipoint_presets/classic_shapes.js";
import { PRESETS as SWIRLS } from "./multipoint_presets/swirls.js";
import { PRESETS as ABSTRACT } from "./multipoint_presets/abstract.js";
import { PRESETS as WALLPAPERS_UI } from "./multipoint_presets/wallpapers_ui.js";
import { PRESETS as MINERALS_PHENOMENA } from "./multipoint_presets/minerals_phenomena.js";
import { PRESETS as RETRO_ERAS } from "./multipoint_presets/retro_eras.js";
import { PRESETS as NATURE } from "./multipoint_presets/nature.js";
import { PRESETS as GEOMETRIC } from "./multipoint_presets/geometric.js";
import { PRESETS as FLUID_MATERIALS } from "./multipoint_presets/fluid_materials.js";
import { PRESETS as PLANETS } from "./multipoint_presets/planets.js";
import { PRESETS as SPACE } from "./multipoint_presets/space.js";
import { PRESETS as MATHEMATICAL } from "./multipoint_presets/mathematical.js";
import { PRESETS as ART_HOMAGES } from "./multipoint_presets/art_homages.js";
import { PRESETS as FOOD_MOODS } from "./multipoint_presets/food_moods.js";

/**
 * Command. Freezes this module's newly built catalog recursively, never user paint.
 * @param {object} value - Owned JSON-compatible catalog subtree.
 * @returns {object} Same subtree, frozen at every object/array level.
 * @example freezeCatalog({ids:["neon-spiral"]}).ids // ["neon-spiral"] (frozen)
 */
function freezeCatalog(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") freezeCatalog(child);
  return Object.freeze(value);
}

/** Deep-frozen [{id, title, presets}] in picker order; ids are permanent kebab-case keys. */
export const MULTIPOINT_PRESET_FAMILIES = freezeCatalog([
  { id: "signature", title: "Signature", presets: SIGNATURE },
  { id: "soft-blends", title: "Basics · soft blends", presets: SOFT_BLENDS },
  { id: "classic-shapes", title: "Basics · classic shapes", presets: CLASSIC_SHAPES },
  { id: "swirls", title: "Swirls", presets: SWIRLS },
  { id: "abstract", title: "Abstract", presets: ABSTRACT },
  { id: "wallpapers-ui", title: "Wallpapers & UI", presets: WALLPAPERS_UI },
  { id: "minerals-phenomena", title: "Minerals & phenomena", presets: MINERALS_PHENOMENA },
  { id: "retro-eras", title: "Retro & eras", presets: RETRO_ERAS },
  { id: "nature", title: "Nature", presets: NATURE },
  { id: "geometric", title: "Geometric", presets: GEOMETRIC },
  { id: "fluid-materials", title: "Fluid & materials", presets: FLUID_MATERIALS },
  { id: "planets", title: "Planets & moons", presets: PLANETS },
  { id: "space", title: "Space & sci-fi", presets: SPACE },
  { id: "mathematical", title: "Mathematical", presets: MATHEMATICAL },
  { id: "art-homages", title: "Art homages", presets: ART_HOMAGES },
  { id: "food-moods", title: "Food & moods", presets: FOOD_MOODS },
]);

/** Every preset, flattened in family order; entries are the frozen family entries. */
export const MULTIPOINT_PRESETS = Object.freeze(MULTIPOINT_PRESET_FAMILIES.flatMap((family) => family.presets));

/**
 * Pure function. Looks up a stable id and clones its immutable native paint.
 * Callers may edit every nested node/stop without touching catalog or other fills.
 * Unknown ids throw; there is no default/fallback preset.
 * @param {string} id - One of MULTIPOINT_PRESETS' permanent ids.
 * @returns {object} Fresh mutable {type:'multipointGradient',multipoint:{features}}.
 * @example getMultipointPreset("warm-bokeh").multipoint.features.length // 9
 */
export function getMultipointPreset(id) {
  const entry = MULTIPOINT_PRESETS.find((preset) => preset.id === id);
  if (!entry) throw new Error(`Unknown Multipoint preset: ${String(id)}`);
  return structuredClone(entry.paint);
}
