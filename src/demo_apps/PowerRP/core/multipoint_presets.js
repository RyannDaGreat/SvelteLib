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
import { PRESETS as UKIYO_E } from "./multipoint_presets/ukiyo_e.js";
import { PRESETS as MARBLING } from "./multipoint_presets/marbling.js";
import { PRESETS as IMPRESSIONISM } from "./multipoint_presets/impressionism.js";
import { PRESETS as POST_IMPRESSIONISM } from "./multipoint_presets/post_impressionism.js";
import { PRESETS as ART_NOUVEAU } from "./multipoint_presets/art_nouveau.js";
import { PRESETS as FAUVISM } from "./multipoint_presets/fauvism.js";
import { PRESETS as SUPREMATISM } from "./multipoint_presets/suprematism.js";
import { PRESETS as HARD_EDGE } from "./multipoint_presets/hard_edge.js";
import { PRESETS as SURREALISM } from "./multipoint_presets/surrealism.js";
import { PRESETS as POP_CONTEMPORARY } from "./multipoint_presets/pop_contemporary.js";
import { PRESETS as WORLD_TEXTILES } from "./multipoint_presets/world_textiles.js";
import { PRESETS as MIDCENTURY_MEMPHIS } from "./multipoint_presets/midcentury_memphis.js";
import { PRESETS as CINEMA_GRADES } from "./multipoint_presets/cinema_grades.js";
import { PRESETS as FILM_PROCESSES } from "./multipoint_presets/film_processes.js";
import { PRESETS as LIGHT_ART } from "./multipoint_presets/light_art.js";
import { PRESETS as GENERATIVE_ART } from "./multipoint_presets/generative_art.js";
import { PRESETS as RENDERS_3D } from "./multipoint_presets/renders_3d.js";
import { PRESETS as ARCHITECTURE_LIGHT } from "./multipoint_presets/architecture_light.js";
import { PRESETS as SKIES } from "./multipoint_presets/skies.js";
import { PRESETS as LANDSCAPE_PAINTING } from "./multipoint_presets/landscape_painting.js";
import { PRESETS as BOTANICAL_ART } from "./multipoint_presets/botanical_art.js";
import { PRESETS as DEEP_SKY } from "./multipoint_presets/deep_sky.js";
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
  { id: "ukiyo-e", title: "Ukiyo-e & shin-hanga", presets: UKIYO_E },
  { id: "marbling", title: "Marbling", presets: MARBLING },
  { id: "impressionism", title: "Impressionism", presets: IMPRESSIONISM },
  { id: "post-impressionism", title: "Post-Impressionism", presets: POST_IMPRESSIONISM },
  { id: "art-nouveau", title: "Art Nouveau & Symbolism", presets: ART_NOUVEAU },
  { id: "fauvism", title: "Fauvism & Expressionism", presets: FAUVISM },
  { id: "suprematism", title: "Suprematism & Constructivism", presets: SUPREMATISM },
  { id: "hard-edge", title: "Hard-edge & De Stijl", presets: HARD_EDGE },
  { id: "surrealism", title: "Surrealism", presets: SURREALISM },
  { id: "pop-contemporary", title: "Pop & contemporary", presets: POP_CONTEMPORARY },
  { id: "world-textiles", title: "World textiles", presets: WORLD_TEXTILES },
  { id: "midcentury-memphis", title: "Mid-century to Memphis", presets: MIDCENTURY_MEMPHIS },
  { id: "cinema-grades", title: "Cinema grades", presets: CINEMA_GRADES },
  { id: "film-processes", title: "Film & print processes", presets: FILM_PROCESSES },
  { id: "light-art", title: "Light art", presets: LIGHT_ART },
  { id: "generative-art", title: "Generative art", presets: GENERATIVE_ART },
  { id: "renders-3d", title: "3D gradients & renders", presets: RENDERS_3D },
  { id: "architecture-light", title: "Architecture & light", presets: ARCHITECTURE_LIGHT },
  { id: "skies", title: "Skies & atmospheres", presets: SKIES },
  { id: "landscape-painting", title: "Landscape painting", presets: LANDSCAPE_PAINTING },
  { id: "botanical-art", title: "Botanical art", presets: BOTANICAL_ART },
  { id: "deep-sky", title: "Deep sky", presets: DEEP_SKY },
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
