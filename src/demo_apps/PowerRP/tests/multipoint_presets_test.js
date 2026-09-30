/** Data/geometry checks only. Real-solver visual acceptance is a separate gallery gate. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MULTIPOINT_PRESETS, getMultipointPreset,
} from "../core/multipoint_presets.js";
import { hermiteNodes, ellipseNodes, spiralNodes, waveNodes } from "../core/multipoint_shapes.js";
import { nodeCubic, featurePolyline } from "../core/multipoint.js";
import { evalCubic } from "../core/morph_geometry.js";
import { parsePaint, parseColor } from "../render_gpu/ir.js";

const EXPECTED_IDS = [
  // Signature
  "neon-spiral", "twin-spiral", "acid-ribbons", "chromatic-rings", "aurora-curtains", "prism-fan", "rainbow-arches", "warm-bokeh", "cool-bokeh", "lava-lagoons", "candy-vortex", "sunset-tide", "tidal-lagoon", "velvet-folds",
  // Basics · soft blends
  "peach-lilac", "pastel-quartet", "tri-tone", "sorbet-trio", "dusty-rose", "sage-sand", "pastel-dawn", "lavender-haze", "cool-greys", "apricot-rise", "slate-sidelight", "linen-halo", "teal-lumen", "amethyst-bloom", "garnet-cushion", "oat-folds", "emerald-glade", "ocean-mint", "window-light",
  // Basics · classic shapes
  "clear-sky", "side-fade", "diagonal-sweep", "diagonal-split", "conic-sweep", "center-glow", "soft-spotlight", "dark-vignette", "horizon-split", "corner-flare", "soft-band", "stage-beam", "studio-paper", "four-corners", "black-white", "blue-diamond", "green-hills", "crimson-disc", "amber-rise", "violet-halo",
  // Swirls
  "vertigo-spiral", "maelstrom-eye", "naruto-whirlpool", "fillmore-melt", "spectrum-twirl", "swirl-lollipop", "triple-spiral", "french-curl", "nightingale-nest", "rose-marble", "kowhaiwhai-koru", "liquid-light", "cataract-waves", "latte-heart", "scream-sky",
  // Abstract
  "simultaneous-disc", "rythme-pair", "moon-forms", "newton-discs", "zip-field", "unfurled-rivulets", "target-rings", "pale-bands", "skyspace-glow", "plains-light", "one-as-two", "goethe-balance", "warm-cold", "perceptual-sweep", "hue-shift-ramp", "rainbow-squiggle",
  // Wallpapers & UI
  "layered-dusk", "coastal-layers", "violet-canyon", "sunrise-rays", "midnight-silk", "glassy-aurora", "rim-orb", "porcelain-swirl", "night-ribbons", "blush-folds", "aurora-hero", "tilted-mesh", "golden-petals", "cobalt-ruffle", "magenta-swoosh", "sunset-twirl", "silk-ribbon",
  // Minerals & phenomena
  "fortress-agate", "malachite-bands", "rhodochrosite-fan", "peacock-eye", "prismatic-spring", "venus-belt", "noctilucent-night", "pool-caustics", "aurora-corona", "jewel-beetle", "bismuth-hopper", "glowing-eddy", "tiger-eye", "fire-opal", "amethyst-geode", "golden-hour", "glowing-surf",
  // Retro & eras
  "whiplash-silk", "rajah-steam", "etoile-rails", "fillmore-vortex", "neon-rose", "flower-power", "rainbow-bend", "supergraphic-serpentine", "airbrush-waves", "city-pop", "aqua-arcs", "aero-streaks", "bloom-petals", "red-fuji", "seigaiha-waves", "record-swirl", "screensaver-trails", "bondi-blobs",
  // Ornament & tile
  "girih-decagram", "isfahan-iwan-arch", "ardabil-medallion", "zellige-eight-star", "zellige-twelve-star", "iznik-saz-rosette", "talavera-puebla-plate", "kells-triskele-roundel", "galla-placidia-vault", "ravenna-gold-halo", "chartres-blue-medallion", "sainte-chapelle-lancets", "kells-double-spiral",
  // Ink, lacquer & gold
  "cloudy-mountains", "one-corner-mist", "blue-green-peaks", "wet-ink-bloom", "enso-seal", "plum-river-gold", "rain-crag-ranges", "ink-moonrise", "maki-e-ripples", "red-lacquer-tray", "rinpa-wave-gold", "maki-e-reeds", "nashiji-pear-skin", "kintsugi-black", "celadon-bisaek",
  // Ukiyo-e & shin-hanga
  "edo-dawn", "ohashi-shower", "kanbara-snow", "kameido-snow", "kajikazawa-blues", "sailing-morning", "sailing-evening", "sailing-night",
  // Old masters light
  "rembrandt-glow", "candle-flame", "vermeer-blue-room", "titian-crimson", "leonardo-sfumato", "tiepolo-heaven", "lorrain-haze", "lorrain-amber", "delft-clouds", "hand-over-flame", "verdaccio-flesh", "moon-and-campfire", "candle-hand", "newborn-warmth", "titian-drapery", "venetian-sky", "sfumato-distance", "tiepolo-oculus", "danae-gold",
  // Romantic & sublime
  "flaming-june", "rainstorm-sea", "moonlit-mist", "sodom-firestorm", "pearl-gale", "crimean-moon", "copper-tresses", "blue-rigi", "deluge-morning", "amber-evening", "chesma-night", "naples-moonlight", "snowstorm-vortex", "friedrich-dusk", "fog-wanderer", "day-of-wrath", "pandemonium-hall", "ninth-wave", "glass-surf", "proserpine-drape", "norham-dawn",
  // Marbling
  "ebru-lale", "ebru-battal", "ebru-stone-teal", "marble-curl-stone", "marble-stroom", "marble-peacock-eye", "marble-gel-git", "marble-tarakli", "marble-spanish-wave", "suminagashi-rose", "suminagashi-gilt", "marble-hatip-rings", "marble-bouquet", "marble-turkish-stone", "marble-florentine-stone", "marble-dutch-coral", "acrylic-teal-gold", "acrylic-ocean", "marble-hatip-bloom", "marble-zebra-wave", "acrylic-sunset", "acrylic-emerald", "acrylic-terracotta", "marble-bulbul-nest", "marble-whirl-indigo", "marble-get-gel", "marble-paisley-shawl", "marble-paisley-gilt",
  // Impressionism
  "sunrise-harbour-haze", "haystack-sunset-snow", "haystacks-end-of-day", "parliament-fog", "rouen-cathedral-sunset", "rouen-cathedral-blue-gold", "lilies-sunset-pond", "lilies-green-pond", "temeraire-sunset", "boulevard-night", "orchard-blossom", "pearl-and-blush",
  // Post-Impressionism
  "starry-night-rhone", "sunflowers-turquoise", "wheatfield-cypresses", "almond-blossom", "saint-tropez-harbour", "venice-salute-sails", "vision-vermilion", "yellow-christ-field", "vuillard-lamplit-room",
  // Art Nouveau & Symbolism
  "mucha-spring-bough", "mucha-zodiac-halo", "mucha-autumn-grapes", "mucha-job-whorl", "klimt-tree-of-life", "klimt-water-serpents", "klimt-birch-forest",
  // Fauvism & Expressionism
  "derain-thames", "kirchner-street", "marc-blue-horses", "munch-scream-sky", "munch-the-sun", "nolde-sea-sunset", "nolde-flower-garden", "jawlensky-head",
  // Suprematism & Constructivism
  "malevich-red-square", "malevich-airplane-flying", "lissitzky-red-wedge", "lissitzky-proun-rings", "lissitzky-proun-prism", "malevich-eight-rectangles", "malevich-supremus-bars", "malevich-trapezium-square", "malevich-yellow-quadrilateral", "rodchenko-pure-colours",
  // Hard-edge & De Stijl
  "mondrian-large-blue-plane", "mondrian-yellow-plane", "mondrian-pastel-lattice", "doesburg-counter-composition", "kelly-spectrum", "kelly-curved-fields", "albers-yellow-climate", "albers-glow", "albers-apparition",
  // World modernism
  "tarsila-morros", "kahlo-leaf-jungle", "rivera-calla-lilies", "lam-jungla", "raza-bindu", "anatsui-metal-cloth", "adnan-tamalpais", "zao-breaking-light", "chu-ultramarine-strokes", "anatsui-gold-drape", "zao-ember-depths", "chu-glaze-pools",
  // Surrealism
  "dali-desert-dusk", "dali-amber-storm", "magritte-fair-weather", "tanguy-grey-plain", "tanguy-rose-ochre", "tanguy-sea-floor", "miro-constellation", "miro-blue-field", "miro-carnival", "dechirico-empty-piazza",
  // Colour field
  "seagram-maroon", "seagram-lilac", "rust-and-blue", "orange-yellow", "chapel-plum", "white-center", "tangerine-green", "red-over-black", "veil-curtain", "pour-stripes", "noland-chevron", "bend-sinister", "still-ember", "still-ultramarine", "olitski-mist", "cathedra-blue", "magenta-green-orange", "still-crimson", "olitski-dusk",
  // Op art & spirals
  "arrest-waves", "fall-descent", "vega-expansion", "keple-hexagon", "soto-eccentric", "breathe-wedges", "physichromie-lamellae", "splendor-diamond", "magenta-squared", "bulge-stripes", "current-surge", "square-vortex", "rotorelief-tunnel", "hypno-pinwheel", "agam-accordion", "stanczak-vibration",
  // Pop & contemporary
  "hockney-pool-ripples", "warhol-flowers", "lichtenstein-ben-day-dots", "lichtenstein-comic-waves", "kusama-dot-field", "haring-radiant-rays", "murakami-smile-flower", "petermax-cosmic-rings", "petermax-rainbow-flow",
  // Murals & street colour
  "chroma-glitch-bands", "chroma-speed-stripes", "chroma-chevron-ramp", "okuda-grey-to-rainbow", "spray-fade-bloom", "chefchaouen-dado-wash", "jaipur-rose-gateway", "valparaiso-dusk-patches", "caminito-corrugated-tin",
  // World textiles
  "parang-rusak", "teal-chevron-ikat", "kumo-shibori", "adras-ikat", "arashi-shibori", "kente-zigzag", "selbu-rose",
  // Prints & patterns
  "zigzag-knit", "boteh-shawl", "tie-dye-spiral", "ombre-dip-dye", "poppy-print", "capri-silk-print", "tissu-simultane", "shibori-arashi", "ice-dye-crackle", "wine-velvet-drape", "champagne-satin", "crumple-dye", "tie-dye-bullseye",
  // Mid-century to Memphis
  "cutout-figure", "beethoven-arcs", "carlton-shelves", "prism-beam",
  // Album art
  "jazz-fjord-mist", "jazz-pale-horizon", "jazz-dusk-moor", "prog-eclipse-lake", "soul-sunburst-rings", "soul-corner-arcs", "soul-plum-halo", "shoegaze-blush", "ambient-tide", "synth-chrome-horizon", "ambient-dawn-bands", "prog-crescent-world",
  // Stage & club light
  "stage-haze-beams", "mirror-ball-glints", "jazz-club-amber", "gel-primary-blue-cyc", "gel-amber-lavender", "laser-green-fan", "velvet-curtain-red", "follow-spot-pool", "gel-magenta-cyan",
  // Picture-book illustration
  "tissue-dawn", "valley-night", "comet-sky", "meadow-wash", "winter-valley", "lily-pond-wash", "sepia-haze", "blue-tree-forest", "carnival-scallops", "gouache-dusk", "jungle-fan",
  // Animation backgrounds
  "summer-cumulus", "flare-dusk", "blue-hill-mist", "meadow-horizon", "flat-modernist-hills", "giraud-violet-dawn", "skyline-neon-dusk", "twin-suns-dunes", "anvil-thunderhead", "ringed-planet-key", "flare-ghost-sky", "cloud-break-gold", "matte-dusk-strata", "painted-cumulus",
  // Cinema grades
  "teal-orange-blockbuster", "neon-noir-rain", "pastel-symmetry", "day-for-night-blue", "magic-hour-glow", "sodium-vapour-night", "step-printed-smear", "one-point-corridor", "desert-orange-teal", "desert-planet-haze", "venetian-noir", "anamorphic-flare", "two-strip-sunset", "amber-gloom",
  // Film & print processes
  "tungsten-halation", "instant-film-fade", "cyanotype-fern", "sepia-toned-portrait", "selenium-toned-ridges", "riso-overprint-blue-pink",
  // Light art
  "weather-project", "ganzfeld-blue", "peachblow-tubes", "solid-light-cone", "wedgework-light", "crater-oculus", "mist-rainbow", "rainbow-panorama", "resonating-lamps", "particle-waterfall", "neon-coil", "neon-scrawl", "coloured-shadows", "gold-diagonal",
  // Glass & windows
  "jerusalem-yellow", "reims-blue", "cologne-window", "iridescent-lustre", "sole-spikes", "sommerso-amber", "dichroic-fusion", "rose-noon", "rose-ember", "rose-moonlit", "persian-ceiling", "dichroic-rods", "sommerso-submarine",
  // Generative art
  "fidenza-ink", "fidenza-tangerine", "molnar-nested-squares", "schotter-grid", "mohr-cube",
  // 3D gradients & renders
  "chrome-blob", "inflated-heart", "iridescent-torus", "clay-sphere", "glass-orb", "lime-jelly", "holo-blob", "water-drop", "gummy-star", "puffy-cloud", "clay-trio",
  // Architecture & light
  "barragan-pink-wall", "barragan-gilardi", "church-of-light", "sagrada-nave", "zaha-auditorium", "brasilia-crown", "hundertwasser-wall", "shoji-dusk", "itten-wheel", "unite-loggias", "ronchamp-wall", "raking-concrete", "hundertwasser-spiral",
  // Skies & atmospheres
  "clear-sunset", "blue-hour", "cirrus-dawn", "krakatoa-afterglow", "fog-bank", "double-rainbow", "sun-dog-halo", "crepuscular-rays", "anticrepuscular-rays", "mammatus-dusk", "polar-twilight", "desert-heat-haze", "aurora-crimson-crown", "steve-ribbon", "aurora-mirror-lake", "lenticular-dusk",
  // Landscape painting
  "monk-by-the-sea", "twilight-wilderness", "moonrise-sea", "tonal-dusk", "faceted-peak", "lake-reflection", "desert-streak", "cobalt-daybreak", "alpine-lake-mist", "luminist-calm", "sea-of-ice", "chalk-cliffs", "cloche-hills",
  // Gardens & petals
  "tulip-field-rows", "lavender-contours", "tulip-flame", "poppy-silk", "moth-orchid", "lotus-dawn", "coral-peony", "giverny-pond", "poppy-hillside", "momiji-scarlet", "wisteria-rain", "magnolia-wax", "hibiscus-sunrise", "rose-whorl",
  // Botanical art
  "strawberry-thief-indigo", "jimson-weed-trumpet", "redoute-white-lily", "redoute-blush-rose", "blossfeldt-acanthus-spike", "blossfeldt-horned-capsule", "blossfeldt-fern-crozier", "dutch-flamed-tulip", "poppy-close-up", "calla-lily-grey", "ruysch-cabbage-rose",
  // Microscopy & natural science
  "bz-spiral-dish", "bz-target-waves", "vitamin-c-spherulite", "citric-acid-laths", "caffeine-needles", "soap-film-drain", "chladni-sand-plate", "chladni-quatrefoil", "iron-filings-dipole", "diatom-triceratium", "confocal-dapi-gfp", "confocal-brainbow", "confocal-mitosis", "haeckel-radiolaria", "haeckel-discomedusa",
  // Deep sky
  "cosmic-cliffs", "horsehead-dark", "catseye-shells", "helix-eye", "southern-ring", "elliptical-glow", "callisto-craters", "ocean-exoplanet", "twin-suns", "red-dwarf-sky",
  // Nature
  "hillside-dawn", "sunlit-shafts", "coral-atoll", "sunlit-grove", "dune-crests", "glacier-facets", "lavender-rows", "misty-ridges", "lightning-strike", "autumn-leaves", "sakura-bloom", "frost-star", "mossy-stones", "ember-volcano", "moonlit-sea",
  // Geometric
  "bauhaus-balance", "memphis-party", "chevron-stack", "faceted-star", "tumbling-blocks", "retro-sunburst", "bold-stripes", "split-circles", "swiss-poster", "deco-fan", "triangle-mosaic", "honey-cells", "cut-diamond",
  // Fluid & materials
  "carrara-marble", "watercolor-bloom", "oil-slick", "holo-foil", "liquid-chrome", "molten-gold", "pearl-drops", "sapphire-satin", "gilded-bole", "black-opal", "smoke-wisps", "lava-lamp", "soap-bubble", "ink-marbling",
  // Planets & moons
  "jupiter-globe", "jupiter-belts", "saturn-rings", "neptune-globe", "uranus-globe", "mars-globe", "venus-globe", "earth-marble", "moon-maria", "io-volcanic", "europa-lineae", "titan-haze", "sun-disc",
  // Space & sci-fi
  "emission-nebula", "ring-nebula", "spiral-galaxy", "quasar-jet", "solar-eclipse", "solar-prominence", "event-horizon", "pulsar-beams", "synthwave-sun", "neon-skyline", "hologram-cone", "plasma-globe", "warp-tunnel", "portal-ring",
  // Mathematical
  "mandelbrot-bulb", "cup-caustic", "compass-rose", "lissajous-weave", "harmonograph-trace", "lemniscate-lobes", "superellipse-ladder", "golden-nautilus", "fermat-swirl", "involute-turbine", "spirograph-star", "fay-butterfly", "golden-pearls", "cassini-ovals", "limacon-bulb",
  // Art homages
  "rothko-field", "homage-square", "water-lilies", "starry-swirl", "great-wave", "klimt-gold", "turner-haze", "paper-cutouts", "klint-altarpiece", "rose-window", "floating-world", "several-circles", "soak-stain", "primary-grid",
  // Food & moods
  "citrus-slice", "watermelon-slice", "peach-sorbet", "strawberry-milk", "matcha-latte", "cotton-candy", "candy-cane", "pumpkin-spice", "valentine-heart", "lucky-coin", "calm-ripples", "energetic-zigzag", "foggy-lamp", "dream-crescent",
];
const ROUND_OFF = 1e-12;
const MAX_UNIT_BOX_CURVE_ERROR = 0.001; // one pixel at 1000 px, independent of solver
const MAX_RELATIVE_CIRCLE_ERROR = 0.000273; // standard four-cubic circle bound
const SAMPLES_PER_SEGMENT = 40; // includes extrema between anchors and midpoints
const MIN_BOUND = -0.3, MAX_BOUND = 1.3; // modest overscan, not remote constraints
const MAX_FEATURES = 12, MAX_NODES_PER_FEATURE = 13, MAX_NODES_PER_PAINT = 40;

/**
 * Command. Asserts two numeric vectors agree within an explicit tolerance.
 * @param {number[]} actual - Measured vector.
 * @param {number[]} expected - Reference vector.
 * @param {number} tolerance - Maximum component error.
 * @returns {void}
 * @example near([0.1 + 0.2], [0.3]) // undefined; assertion passes
 */
function near(actual, expected, tolerance = ROUND_OFF) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= tolerance,
    `${value} != ${expected[i]} (tolerance ${tolerance})`));
}

/**
 * Command. Walks owned objects to reject shared mutable structure and check freezing.
 * @param {object} value - Catalog subtree.
 * @param {Set<object>} seen - Visited identities; mutated as this walk progresses.
 * @returns {void}
 * @example uniqueFrozenObjects(Object.freeze({nodes:Object.freeze([])}), new Set()) // undefined
 */
function uniqueFrozenObjects(value, seen) {
  assert.ok(!seen.has(value), "catalog must not share feature/node/stop objects");
  assert.ok(Object.isFrozen(value), "catalog template must be deeply frozen");
  seen.add(value);
  for (const child of Object.values(value)) if (child && typeof child === "object") uniqueFrozenObjects(child, seen);
}

/**
 * Command. Compares every open cubic with an independently evaluated analytic curve.
 * @param {number[][]} nodes - [N,6] native nodes, with uniform parameter spacing.
 * @param {function(number):number[]} analytic - Exact [x,y] position at t in [0,1].
 * @param {number} tolerance - Maximum position error per component.
 * @returns {void}
 * @example checkCurve(hermiteNodes([[0,0,1,0],[1,0,1,0]],1), t => [t,0], ROUND_OFF) // undefined
 */
function checkCurve(nodes, analytic, tolerance) {
  for (let segment = 0; segment < nodes.length - 1; segment++) {
    const cubic = nodeCubic(nodes[segment], nodes[segment + 1]);
    for (let sample = 0; sample <= SAMPLES_PER_SEGMENT; sample++) {
      const local = sample / SAMPLES_PER_SEGMENT;
      near(evalCubic(cubic, local), analytic((segment + local) / (nodes.length - 1)), tolerance);
    }
  }
}

test("catalog has pinned stable IDs, meaningful metadata and distinct native data", () => {
  assert.deepEqual(MULTIPOINT_PRESETS.map(({ id }) => id), EXPECTED_IDS);
  assert.ok(MULTIPOINT_PRESETS.length >= 12);
  assert.equal(new Set(MULTIPOINT_PRESETS.map(({ label }) => label)).size, EXPECTED_IDS.length);
  assert.equal(new Set(MULTIPOINT_PRESETS.map(({ paint }) => JSON.stringify(paint))).size, EXPECTED_IDS.length);
  // Distinct geometry, not merely a palette swap on a single recipe.
  const layouts = MULTIPOINT_PRESETS.map(({ paint }) => JSON.stringify(paint.multipoint.features.map(({ nodes, closed }) => ({ nodes, closed }))));
  assert.equal(new Set(layouts).size, EXPECTED_IDS.length);
  uniqueFrozenObjects(MULTIPOINT_PRESETS, new Set());
  for (const entry of MULTIPOINT_PRESETS) {
    assert.deepEqual(Object.keys(entry).sort(), ["description", "id", "label", "paint"]);
    assert.match(entry.id, /^[a-z]+(?:-[a-z]+)+$/);
    assert.ok(entry.label.trim() && entry.description.trim());
    assert.deepEqual(Object.keys(entry.paint).sort(), ["multipoint", "type"]);
    assert.equal(entry.paint.type, "multipointGradient");
    assert.deepEqual(Object.keys(entry.paint.multipoint), ["features"]);
  }
});

test("every preset parses losslessly to native features with finite colors", () => {
  for (const { id, paint } of MULTIPOINT_PRESETS) {
    const before = JSON.stringify(paint);
    const parsed = parsePaint(paint);
    assert.equal(parsed.type, paint.type, id);
    assert.equal(parsed.features.length, paint.multipoint.features.length, id);
    assert.deepEqual(parsePaint(parsed), parsed, `${id}: parsed IR is reentrant`);
    assert.deepEqual(JSON.parse(before), paint, `${id}: JSON round-trip`);
    parsed.features.forEach((feature, index) => {
      const original = paint.multipoint.features[index];
      assert.deepEqual(Object.keys(original).sort(), ["closed", "nodes", "stops", "twoSided", "weight"]);
      assert.deepEqual(feature.nodes, original.nodes, id);
      assert.equal(feature.twoSided, original.twoSided, id);
      assert.equal(feature.closed, original.closed, id);
      assert.equal(original.weight, 1, id);
      assert.equal(feature.weight, 1, id);
      assert.equal(feature.stops.length, original.stops.length, id);
      original.stops.forEach((stop, i) => {
        assert.deepEqual(Object.keys(stop).sort(), ["color", "offset", "rightColor"]);
        assert.match(stop.color, /^#[0-9a-f]{6}$/);
        assert.match(stop.rightColor, /^#[0-9a-f]{6}$/);
        assert.ok(stop.offset >= 0 && stop.offset <= 1);
        if (i) assert.ok(stop.offset > original.stops[i - 1].offset);
        assert.equal(feature.stops[i].offset, stop.offset);
        assert.deepEqual(feature.stops[i].color, parseColor(stop.color));
        assert.deepEqual(feature.stops[i].rightColor, parseColor(stop.rightColor));
        assert.ok([...feature.stops[i].color, ...feature.stops[i].rightColor].every(Number.isFinite));
      });
      if (original.closed && original.stops.length > 1) {
        assert.equal(original.stops[0].color, original.stops.at(-1).color, `${id}: no accidental closed-ramp seam`);
        assert.equal(original.stops[0].rightColor, original.stops.at(-1).rightColor);
      }
      if (original.nodes.length === 1) {
        assert.equal(original.stops.length, 1);
        assert.equal(original.stops[0].offset, 0);
        assert.equal(original.twoSided, false);
        assert.equal(original.closed, false);
        assert.deepEqual(original.nodes[0].slice(2), [0, 0, 0, 0]);
      }
    });
    assert.equal(JSON.stringify(paint), before, `${id}: parsing does not mutate stored paint`);
  }
});

test("lookup returns fresh deep mutable paints; unknown IDs throw", () => {
  for (const entry of MULTIPOINT_PRESETS) {
    const a = getMultipointPreset(entry.id), b = getMultipointPreset(entry.id);
    assert.deepEqual(a, entry.paint);
    assert.deepEqual(b, a);
    assert.notEqual(a, b);
    assert.notEqual(a.multipoint, b.multipoint);
    a.multipoint.features.forEach((feature, i) => {
      assert.notEqual(feature, b.multipoint.features[i]);
      assert.notEqual(feature.nodes, b.multipoint.features[i].nodes);
      assert.notEqual(feature.stops, b.multipoint.features[i].stops);
      feature.nodes.forEach((node, j) => {
        assert.notEqual(node, b.multipoint.features[i].nodes[j]);
        node[0] += 1;
      });
      feature.stops.forEach((stop, j) => {
        assert.notEqual(stop, b.multipoint.features[i].stops[j]);
        stop.color = "#000000";
        stop.rightColor = "#ffffff";
        stop.offset = 0.375;
      });
      feature.closed = !feature.closed;
      feature.twoSided = !feature.twoSided;
      feature.weight = 2;
    });
    a.multipoint.features.pop();
    a.multipoint.featuresActive = [false];
    assert.deepEqual(b, entry.paint);
    assert.deepEqual(getMultipointPreset(entry.id), entry.paint);
  }
  for (const id of ["missing", "NEON-SPIRAL", "", "constructor", undefined, null, 0])
    assert.throws(() => getMultipointPreset(id), /Unknown Multipoint preset:/);
  assert.throws(() => { MULTIPOINT_PRESETS[0].id = "changed"; }, TypeError);
  assert.throws(() => { MULTIPOINT_PRESETS[0].paint.multipoint.features[0].nodes[0][0] = 99; }, TypeError);
});

test("Hermite conversion reproduces a cubic exactly, including scaled derivatives", () => {
  const samples = [0, 0.25, 0.5, 0.75, 1].map((t) => [t, t ** 3, 1, 3 * t ** 2]);
  const before = structuredClone(samples);
  const nodes = hermiteNodes(samples, 0.25);
  checkCurve(nodes, (t) => [t, t ** 3], ROUND_OFF);
  assert.deepEqual(samples, before);
  near(hermiteNodes([[0, 0, 1, 0], [1, 1, 1, 2]], 1)[1], [1, 1, -1 / 3, -2 / 3, 1 / 3, 2 / 3]);
  nodes[0][0] = 10;
  assert.deepEqual(samples, before, "returned anchors do not alias samples");
});

test("ellipse cubics meet circle-error bound with smooth closing seam and no duplicate node", () => {
  const cx = 0.5, cy = 0.4, rx = 0.3, ry = 0.2;
  const nodes = ellipseNodes(cx, cy, rx, ry);
  assert.equal(nodes.length, 4);
  near(nodes[0].slice(0, 2), [0.8, 0.4]);
  near(ellipseNodes(0.5, 0.5, 0.25)[0].slice(0, 2), [0.75, 0.5]);
  for (let segment = 0; segment < nodes.length; segment++) {
    const node = nodes[segment], next = nodes[(segment + 1) % nodes.length];
    near(node.slice(2, 4), node.slice(4, 6).map((v) => -v));
    for (let sample = 0; sample <= SAMPLES_PER_SEGMENT; sample++) {
      const [x, y] = evalCubic(nodeCubic(node, next), sample / SAMPLES_PER_SEGMENT);
      const radialError = Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
      assert.ok(radialError <= MAX_RELATIVE_CIRCLE_ERROR, `ellipse radial error ${radialError}`);
    }
  }
  const polyline = featurePolyline(nodes, true);
  near(polyline[0], polyline.at(-1));
  assert.notDeepEqual(nodes[0].slice(0, 2), nodes.at(-1).slice(0, 2));
});

test("spiral cubics track the analytic spiral for both traversal directions", () => {
  for (const turns of [0.75, 1, 1.25, 1.5, -1.25]) {
    const options = { cx: 0.4, cy: 0.5, startRadius: 0.06, endRadius: 0.59, turns, phase: Math.PI / 3 };
    const nodes = spiralNodes(options);
    checkCurve(nodes, (t) => {
      const r = options.startRadius + (options.endRadius - options.startRadius) * t;
      const angle = options.phase + 2 * Math.PI * turns * t;
      return [options.cx + r * Math.cos(angle), options.cy + r * Math.sin(angle)];
    }, MAX_UNIT_BOX_CURVE_ERROR);
    for (const node of nodes) near(node.slice(2, 4), node.slice(4, 6).map((v) => -v));
  }
  const example = spiralNodes({ cx: 0.5, cy: 0.5, startRadius: 0.1, endRadius: 0.4, turns: 1 });
  assert.equal(example.length, 9);
  near(example[0].slice(0, 2), [0.6, 0.5]);
  near(example.at(-1).slice(0, 2), [0.9, 0.5]);
});

test("wave cubics track sine, half-wave peaks, reversed axes and zero cycles", () => {
  for (const cycles of [0, 0.5, 0.75, 1, 1.25, -1]) {
    for (const [x0, x1] of [[-0.08, 1.08], [1, 0]]) {
      const y = 0.5, amplitude = 0.3, phase = Math.PI / 3;
      const nodes = waveNodes({ x0, x1, y, amplitude, cycles, phase });
      checkCurve(nodes, (t) => [x0 + (x1 - x0) * t, y + amplitude * Math.sin(2 * Math.PI * cycles * t + phase)], MAX_UNIT_BOX_CURVE_ERROR);
    }
  }
  near(waveNodes({ x0: 0, x1: 1, y: 0.5, amplitude: 0.2, cycles: 0.5 })[2].slice(0, 2), [0.5, 0.7]);
  assert.equal(waveNodes({ x0: 0, x1: 1, y: 0.5, amplitude: 0.2 }).length, 9);
});

test("all stored nodes and whole cubic hulls stay within modest bounds/budgets", () => {
  for (const { id, paint } of MULTIPOINT_PRESETS) {
    const features = paint.multipoint.features;
    assert.ok(features.length > 0 && features.length <= MAX_FEATURES, id);
    assert.ok(features.reduce((sum, feature) => sum + feature.nodes.length, 0) <= MAX_NODES_PER_PAINT, id);
    for (const feature of features) {
      assert.ok(feature.nodes.length > 0 && feature.nodes.length <= MAX_NODES_PER_FEATURE, id);
      assert.ok(feature.stops.length > 0 && feature.stops.length <= 4, id);
      for (const node of feature.nodes) {
        assert.equal(node.length, 6);
        assert.ok(node.every(Number.isFinite), id);
        for (const [x, y] of [[node[0], node[1]], [node[0] + node[2], node[1] + node[3]], [node[0] + node[4], node[1] + node[5]]]) {
          assert.ok(x >= MIN_BOUND && x <= MAX_BOUND && y >= MIN_BOUND && y <= MAX_BOUND, `${id}: control hull (${x},${y})`);
        }
      }
      // The adaptive helper is the backend's geometry seam, not a mock curve.
      for (const [x, y] of featurePolyline(feature.nodes, feature.closed))
        assert.ok(x >= MIN_BOUND && x <= MAX_BOUND && y >= MIN_BOUND && y <= MAX_BOUND, id);
    }
  }
});

test("bokeh centers and nested contours share geometry without shared references", () => {
  for (const id of ["warm-bokeh", "cool-bokeh"]) {
    const { features } = getMultipointPreset(id).multipoint;
    for (let i = 0; i < features.length; i += 3) {
      const [center, shoulder, rim] = features.slice(i, i + 3);
      const [cx, cy] = center.nodes[0];
      assert.equal(center.nodes.length, 1);
      for (const contour of [shoulder, rim]) {
        assert.equal(contour.closed, true);
        assert.equal(contour.twoSided, false);
        assert.equal(contour.nodes.length, 4);
        near([(contour.nodes[0][0] + contour.nodes[2][0]) / 2, (contour.nodes[1][1] + contour.nodes[3][1]) / 2], [cx, cy]);
        near([contour.nodes[0][0] - cx], [contour.nodes[1][1] - cy]);
      }
      assert.ok(shoulder.nodes[0][0] - cx < rim.nodes[0][0] - cx);
      assert.notEqual(center.stops[0].color, shoulder.stops[0].color);
      assert.notEqual(shoulder.stops[0].color, rim.stops[0].color);
    }
  }
  assert.equal(getMultipointPreset("warm-bokeh").multipoint.features.length, 9);
});

test("nonfinite geometry and corrupted presets fail loudly instead of storing NaN", () => {
  const spiral = { cx: 0.5, cy: 0.5, startRadius: 0.1, endRadius: 0.4, turns: 1, phase: 0 };
  const wave = { x0: 0, x1: 1, y: 0.5, amplitude: 0.2, cycles: 1, phase: 0 };
  for (const value of [NaN, Infinity, -Infinity]) {
    for (const key of Object.keys(spiral)) assert.throws(() => spiralNodes({ ...spiral, [key]: value }), /finite/);
    for (const key of Object.keys(wave)) assert.throws(() => waveNodes({ ...wave, [key]: value }), /finite/);
    for (let i = 0; i < 4; i++) {
      const args = [0.5, 0.5, 0.2, 0.3]; args[i] = value;
      assert.throws(() => ellipseNodes(...args), /finite/);
      const sample = [0, 0, 1, 1]; sample[i] = value;
      assert.throws(() => hermiteNodes([sample], 1), /finite/);
    }
    assert.throws(() => hermiteNodes([[0, 0, 1, 1]], value), /finite/);
    for (let component = 0; component < 6; component++) {
      const bad = getMultipointPreset("neon-spiral");
      bad.multipoint.features[0].nodes[0][component] = value;
      assert.throws(() => parsePaint(bad), /finite/);
    }
    for (const field of ["weight", "offset", "color", "rightColor"]) {
      const bad = getMultipointPreset("neon-spiral"), feature = bad.multipoint.features[0];
      if (field === "weight") feature.weight = value;
      else feature.stops[0][field] = field === "offset" ? value : [value, 0, 0, 1];
      assert.throws(() => parsePaint(bad), /finite/);
    }
  }
  assert.throws(() => ellipseNodes(0, 0, 0), /positive/);
  assert.throws(() => ellipseNodes(0, 0, 1, -1), /positive/);
  assert.throws(() => spiralNodes({ ...spiral, turns: 0 }), /nonzero/);
  assert.throws(() => spiralNodes({ ...spiral, startRadius: -1 }), /nonnegative/);
  assert.throws(() => hermiteNodes([], 1), /at least one/);
  assert.throws(() => hermiteNodes([[0, 0, 1, 1]], 0), /positive step/);
  assert.throws(() => hermiteNodes([[0, 0, 1]], 1), /tuples/);
  assert.throws(() => hermiteNodes([[0, 0, Number.MAX_VALUE, 0]], Number.MAX_VALUE), /finite/);
  assert.throws(() => ellipseNodes(Number.MAX_VALUE, 0, Number.MAX_VALUE), /finite/);
});
