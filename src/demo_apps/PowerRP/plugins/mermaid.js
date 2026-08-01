/**
 * MERMAID DIAGRAM widget — a `definition` (Mermaid diagram source) renders to a
 * diagram on the canvas. `definition` is a multi-line CODE property edited as an
 * ordinary Inspector text row (exactly like codeblock's `code`) — there is NO
 * floating canvas code-editor overlay; `theme` picks a Mermaid built-in theme;
 * `preserveAspect` (default ON) letterboxes the diagram into the widget box
 * without distortion.
 *
 * ── BOX SHAPE IS A GENERIC TERM (standing manifest ruling) ────────────────────
 * A rendered diagram is a BOX exactly like an image, a PDF page, or a typeset
 * equation: it composes the SAME shared bundles (core/properties.js) —
 * positioning, the stroked-BOX slice (fill/stroke/strokeWidth/cornerRadius — a
 * framed diagram card), crop insets, and effects (shadow/bloom/blend) — so it
 * inherits every box feature for free with zero widget-specific decoration code.
 * This file is deliberately near-identical to plugins/latex.js; the only new
 * concerns are `definition`/`theme`/`preserveAspect` and the render→vector(+raster)
 * pipeline underneath (render_gpu/gpu/mermaid_raster.js + mermaid_vector.js).
 *
 * ── HOW IT REACHES THE RENDERER (TRUE VECTOR, mirroring latexVector) ──────────
 * A rendered diagram is FLATTENED to real vector: mermaid_raster renders the
 * Mermaid SVG, then mermaid_vector.flattenMermaidSvg (a getComputedStyle/
 * getScreenCTM walk that REUSES core/svg_paths.js geometry) resolves it to
 * viewBox-space vector `paths` (shapes/edges/arrowheads) + `texts` (label runs).
 * emit() builds a `mermaidVector` IR op — the exact mirror of `latexVector` — that
 * carries that vector geometry (SVG/PDF embed real vector; the GPU draws crisp at
 * any zoom, no pixelation) AND the raster `ref` (mermaidRef(def, theme, scale)) as
 * the HYBRID-RULE fallback (a mermaid UNDER a blur rasterizes like text). Until
 * the async flatten lands — or if a diagram can't be vectorized (foreignObject;
 * warned LOUDLY, never a silent fallback) — emit() degrades to a plain `image()`
 * op on the same `ref` (the raster bitmap), then re-emits the vector op on the
 * repaint once the geometry is cached (the async no-silent-placeholder contract).
 *
 * ── preserveAspect (default ON) — letterbox via core/geometry.fitBox ──────────
 * A diagram has a NATURAL aspect once laid out (mermaid_raster.mermaidAspect).
 * With preserveAspect ON, emit() uses fitBox to place the diagram UNIFORM-scaled
 * and CENTERED inside the widget box (letterboxed over the box fill) — never
 * squashed. OFF stretches it to the box. A cropped diagram (edge-crop insets)
 * stretches the cropped sub-rect (letterboxing a partial crop is ambiguous) —
 * the same faithful choice latex makes for a cropped equation.
 *
 * ── ERRORS REPORT LOUDLY IN-WIDGET (task requirement) ─────────────────────────
 * A bad Mermaid definition is not silent and never a blank widget: once the
 * async render runs Mermaid's parser (mermaid.parse), mermaidErrorFor(def)
 * returns the message and emit() switches to a LOUD red error affordance (a
 * red-bordered box + the parser message) — unmissable, in-canvas, in every
 * backend.
 *
 * ── CONDITIONAL GHOST ─────────────────────────────────────────────────────────
 * An EMPTY definition renders nothing and is a GHOST (isGhost → mermaidIsEmpty),
 * granting the dashed-outline/findable-when-Show-Ghosts affordance, exactly like
 * empty text/latex. The ONE canonical predicate drives both the ghost hook and
 * emit()'s short-circuit.
 *
 * ── ASYNC (the round-12 async rule) ───────────────────────────────────────────
 * Render+raster are async; emit() is sync and near-pure (same state → same op).
 * The compositor draws NOTHING for a (def, theme, scale) whose bitmap hasn't
 * landed yet and repaints when it does (image_registry.onImageLoad —
 * mermaid_raster registers into that SAME registry). A render INFRA failure is
 * reported loudly by mermaid_raster (console.error), never swallowed.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder, fitBox } from "../core/geometry.js";
import { partKey, partRef } from "../core/shatter.js";
import { connectorPathAnchors } from "../core/endpoints.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { image, mermaidVector, rect, text } from "../render_gpu/ir.js";
import { decorateStrokedBox, cropInsetsToSource } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import {
  ensureMermaidRendered, mermaidRef, mermaidAspect, mermaidErrorFor, mermaidIsEmpty,
  mermaidVectorGeom, MERMAID_THEMES, DEFAULT_MERMAID_THEME,
} from "../render_gpu/gpu/mermaid_raster.js";

/** The default diagram for a freshly added widget — a tiny flowchart that
 * exercises nodes, an edge, and a decision branch, so a fresh widget visibly
 * demonstrates what a Mermaid definition looks like (and it is a FLOWCHART, the
 * diagram type htmlLabels:false renders most faithfully). Replaced the instant
 * the user edits the `definition` field. */
export const DEFAULT_DEFINITION = "flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]";

/** The KITCHEN-SINK showcase — a rich flowchart exercising "a little of
 * everything" Mermaid can do AT A GLANCE: eight distinct node shapes (stadium,
 * parallelogram, rhombus, subroutine, hexagon, cylinder, circle, flag), a
 * `subgraph` with its own `direction`, `classDef` + `:::` styled classes, edge
 * labels, and a `click` link. Curated to stay LEGIBLE (not a wall of nodes) and
 * to render well on the htmlLabels:false native-text path. Offered as a
 * selectable TEMPLATE, not the fresh-insert default (that stays the small
 * DEFAULT_DEFINITION above). */
export const KITCHEN_SINK_DEFINITION = [
  "flowchart TB",
  "  Start([Start]) --> Input[/User input/]",
  "  Input --> Check{Valid?}",
  "  Check -->|yes| Job[[Process data]]",
  "  Check -->|no| Warn>Log warning]",
  "  subgraph Pipeline [Processing Pipeline]",
  "    direction LR",
  "    Job --> Xform{{Transform}}",
  "    Xform --> Store[(Database)]",
  "  end",
  "  Store --> Done((Done))",
  "  Warn --> Done",
  "  Job:::hot",
  "  Store:::cool",
  "  classDef hot fill:#ffd9d9,stroke:#c0392b,stroke-width:2px,color:#7a1210;",
  "  classDef cool fill:#d9ecff,stroke:#2d6cdf,stroke-width:2px,color:#123a7a;",
  '  click Store href "https://mermaid.js.org" "Mermaid docs"',
].join("\n");

/**
 * The built-in EXAMPLE TEMPLATES the code editor's template picker offers — a
 * curated tour of Mermaid's range so the widget "does a little of everything".
 * Each `{ name, definition }` is a self-contained, legible diagram of a distinct
 * type. Flowchart + sequence render most faithfully on the htmlLabels:false
 * native-text path; class/state are included for breadth. Data-only (no logic),
 * so no doctest — the values ARE the documentation.
 */
export const MERMAID_TEMPLATES = [
  {
    name: "Flowchart",
    definition: [
      "flowchart LR",
      "  A[Client] --> B(API Gateway)",
      "  B --> C{Auth OK?}",
      "  C -->|yes| D[Service]",
      "  C -->|no| E[Reject]",
      "  D --> F[(Database)]",
    ].join("\n"),
  },
  {
    name: "Sequence",
    definition: [
      "sequenceDiagram",
      "  autonumber",
      "  participant U as User",
      "  participant S as Server",
      "  participant DB as Database",
      "  U->>S: Login request",
      "  S->>DB: Verify credentials",
      "  DB-->>S: OK",
      "  S-->>U: Token",
      "  loop Every request",
      "    U->>S: API call (token)",
      "    S-->>U: Response",
      "  end",
    ].join("\n"),
  },
  {
    name: "Class",
    definition: [
      "classDiagram",
      "  class Animal {",
      "    +String name",
      "    +int age",
      "    +makeSound() void",
      "  }",
      "  class Dog {",
      "    +String breed",
      "    +fetch() void",
      "  }",
      "  class Cat {",
      "    +bool indoor",
      "  }",
      "  Animal <|-- Dog",
      "  Animal <|-- Cat",
    ].join("\n"),
  },
  {
    name: "State",
    definition: [
      "stateDiagram-v2",
      "  [*] --> Idle",
      "  Idle --> Loading : fetch",
      "  Loading --> Success : ok",
      "  Loading --> Error : fail",
      "  Success --> Idle : reset",
      "  Error --> Idle : retry",
      "  Success --> [*]",
    ].join("\n"),
  },
  { name: "Kitchen Sink", definition: KITCHEN_SINK_DEFINITION },
];

/**
 * DEMO PRESETS (manifest ROUND 2 #34) — a "Demo presets" Tools-area dropdown, one
 * per Mermaid diagram TYPE, populated from Mermaid's OWN official documentation
 * examples so a user can see "a little of everything" the engine draws. Each entry
 * is a ToolsPane preset (`{name, description, props}`) whose `props.definition`
 * REPLACES the widget's source — applied as ONE undo unit through
 * app.applyPreset, and hover-previewed live like every other preset row.
 *
 * SOURCE ATTRIBUTION: each `definition` is the canonical example from the cited
 * mermaid.js.org syntax page (retrieved 2026-07-28). They are chosen to render on
 * the widget's htmlLabels:false NATIVE-SVG-TEXT path (flowchart/sequence/class/
 * state/ER/gantt/pie/gitGraph/journey/quadrant render cleanly); mindmap/timeline
 * are included for breadth and are the diagram types most likely to fall back to
 * raster (the widget reports that loudly rather than shipping a hole).
 *
 * Data-only (the values ARE the documentation), so no doctest.
 */
export const MERMAID_DEMO_PRESETS = [
  {
    name: "Flowchart",
    description: "Decision flowchart with a loop (mermaid.js.org/syntax/flowchart.html)",
    props: { definition: [
      "flowchart TD",
      "    A[Start] --> B{Is it?}",
      "    B -->|Yes| C[OK]",
      "    C --> D[Rethink]",
      "    D --> B",
      "    B -->|No| E[End]",
    ].join("\n") },
  },
  {
    name: "Sequence",
    description: "Message sequence between actors (mermaid.js.org/syntax/sequenceDiagram.html)",
    props: { definition: [
      "sequenceDiagram",
      "    Alice->>John: Hello John, how are you?",
      "    John-->>Alice: Great!",
      "    Alice-)John: See you later!",
    ].join("\n") },
  },
  {
    name: "Class",
    description: "UML class diagram with inheritance (mermaid.js.org/syntax/classDiagram.html)",
    props: { definition: [
      "classDiagram",
      "    Animal <|-- Duck",
      "    Animal <|-- Fish",
      "    Animal <|-- Zebra",
      "    Animal : +int age",
      "    Animal : +String gender",
      "    Animal: +isMammal()",
      "    Animal: +mate()",
      "    class Duck{",
      "      +String beakColor",
      "      +swim()",
      "      +quack()",
      "    }",
    ].join("\n") },
  },
  {
    name: "State",
    description: "State machine with start/stop (mermaid.js.org/syntax/stateDiagram.html)",
    props: { definition: [
      "stateDiagram-v2",
      "    [*] --> Still",
      "    Still --> [*]",
      "    Still --> Moving",
      "    Moving --> Still",
      "    Moving --> Crash",
      "    Crash --> [*]",
    ].join("\n") },
  },
  {
    name: "Entity Relationship",
    description: "ER diagram with cardinalities (mermaid.js.org/syntax/entityRelationshipDiagram.html)",
    props: { definition: [
      "erDiagram",
      "    CUSTOMER ||--o{ ORDER : places",
      "    ORDER ||--|{ LINE-ITEM : contains",
      "    CUSTOMER }|..|{ DELIVERY-ADDRESS : uses",
    ].join("\n") },
  },
  {
    name: "Gantt",
    description: "Project schedule with sections (mermaid.js.org/syntax/gantt.html)",
    props: { definition: [
      "gantt",
      "    title A Gantt Diagram",
      "    dateFormat YYYY-MM-DD",
      "    section Section",
      "        A task           :a1, 2014-01-01, 30d",
      "        Another task     :after a1, 20d",
      "    section Another",
      "        Task in Anthr    :2014-01-12, 12d",
      "        another task     :24d",
    ].join("\n") },
  },
  {
    name: "Pie",
    description: "Pie chart of labelled values (mermaid.js.org/syntax/pie.html)",
    props: { definition: [
      "pie title Pets adopted by volunteers",
      '    "Dogs" : 386',
      '    "Cats" : 85',
      '    "Rats" : 15',
    ].join("\n") },
  },
  {
    name: "Git graph",
    description: "Commits, a branch and a merge (mermaid.js.org/syntax/gitgraph.html)",
    props: { definition: [
      "gitGraph",
      "   commit",
      "   commit",
      "   branch develop",
      "   checkout develop",
      "   commit",
      "   commit",
      "   checkout main",
      "   merge develop",
      "   commit",
      "   commit",
    ].join("\n") },
  },
  {
    name: "User journey",
    description: "Task satisfaction journey (mermaid.js.org/syntax/userJourney.html)",
    props: { definition: [
      "journey",
      "    title My working day",
      "    section Go to work",
      "      Make tea: 5: Me",
      "      Go upstairs: 3: Me",
      "      Do work: 1: Me, Cat",
      "    section Go home",
      "      Go downstairs: 5: Me",
      "      Sit down: 5: Me",
    ].join("\n") },
  },
  {
    name: "Quadrant",
    description: "Quadrant scatter of campaigns (mermaid.js.org/syntax/quadrantChart.html)",
    props: { definition: [
      "quadrantChart",
      "    title Reach and engagement of campaigns",
      "    x-axis Low Reach --> High Reach",
      "    y-axis Low Engagement --> High Engagement",
      "    quadrant-1 We should expand",
      "    quadrant-2 Need to promote",
      "    quadrant-3 Re-evaluate",
      "    quadrant-4 May be improved",
      "    Campaign A: [0.3, 0.6]",
      "    Campaign B: [0.45, 0.23]",
      "    Campaign C: [0.57, 0.69]",
      "    Campaign D: [0.78, 0.34]",
    ].join("\n") },
  },
  {
    name: "Mindmap",
    description: "Hierarchical mindmap (mermaid.js.org/syntax/mindmap.html)",
    props: { definition: [
      "mindmap",
      "  root((mindmap))",
      "    Origins",
      "      Long history",
      "      Popularisation",
      "    Research",
      "      On effectiveness",
      "    Tools",
      "      Pen and paper",
      "      Mermaid",
    ].join("\n") },
  },
  {
    name: "Timeline",
    description: "Chronological timeline (mermaid.js.org/syntax/timeline.html)",
    props: { definition: [
      "timeline",
      "    title History of Social Media Platform",
      "    2002 : LinkedIn",
      "    2004 : Facebook : Google",
      "    2005 : YouTube",
      "    2006 : Twitter",
    ].join("\n") },
  },
];

/** Error-affordance colors — a LOUD, unmissable red treatment (the "not silent,
 * not a blank widget" requirement). Kept literal because the error box is
 * DOM-free IR chrome (emit can't read app.css --a-* tokens). Shared palette with
 * the latex widget's affordance (same danger convention), redeclared here
 * because no plugin may import another plugin. */
const ERROR_BG = "#f6c9c4";     // saturated pink-red — unmistakably "error"
const ERROR_BORDER = "#c0392b"; // saturated danger red
const ERROR_TEXT = "#7a1210";   // deep red, legible on the pink-red fill
/** Border thickness (canvas units) of the error box — thicker than a hairline so
 * the error frame is loud. */
const ERROR_BORDER_WIDTH = 3;
/** Inset (canvas units) of the message from the box edge, and the text size as a
 * fraction of the box height — plain layout values (small padding; text ~1/5 the
 * box, capped so a tall box does not mint giant text). */
const ERROR_PADDING = 8;
const ERROR_TEXT_FRACTION = 0.18;
const ERROR_TEXT_MAX = 20;

/** Default card look — a legible diagram card out of the box: a WHITE fill so a
 * default-theme diagram (dark ink) reads on ANY canvas background, a subtle gray
 * border, and gently rounded corners (an editor-card convention, the one place
 * rounding is intentional; the user can zero any of them). */
const DEFAULT_FILL = "#ffffff";
const DEFAULT_STROKE = "#d0d5dd";
const DEFAULT_STROKE_WIDTH = 1;
const DEFAULT_CORNER_RADIUS = 8;

/**
 * Pure function. The loud in-widget ERROR affordance IR: a red-bordered filled
 * box across the widget's local bbox + the Mermaid parser message in red. Drawn
 * as VECTOR ops (rect + text) so it is crisp and shows identically in every
 * backend — never a blank widget, never console-only (the task requirement).
 *
 * Args:
 *   w, h (number): the widget's local box size
 *   message (string): the Mermaid parser error message
 *
 * Returns:
 *   object[]: IR ops (a red rect + the message text)
 *
 * @example errorAffordance(200, 60, "Parse error on line 2").length // 2
 * @example errorAffordance(200, 60, "err")[0].op // "rect"
 */
export function errorAffordance(w, h, message) {
  const box = rect({ x: 0, y: 0, w, h, cornerRadius: 0, fill: ERROR_BG, stroke: ERROR_BORDER, strokeWidth: ERROR_BORDER_WIDTH });
  const size = Math.max(1, Math.min(ERROR_TEXT_MAX, h * ERROR_TEXT_FRACTION));
  const label = text({
    text: `Mermaid error: ${message}`,
    x: ERROR_PADDING, y: ERROR_PADDING,
    size, color: ERROR_TEXT,
    boxW: Math.max(1, w - 2 * ERROR_PADDING), boxH: Math.max(1, h - 2 * ERROR_PADDING),
  });
  return [box, label];
}


// ── SHATTER (core/shatter.js's first consumer) ───────────────────────────────
//
// A rendered diagram already knows which ink belongs to which NODE and which
// EDGE — mermaid says so in its own markup, and render_gpu/gpu/mermaid_vector.js
// now carries that through the flatten as each path's and text's `origin`. So
// the decomposition below is a REGROUPING of geometry we already have, not a
// re-derivation of it, and the anchors it writes come from mermaid's semantics
// rather than from guessing which text sits inside which rectangle. Geometry
// guessing looks fine on a test diagram and falls apart on a real one.
//
// WHAT EACH ORIGIN BECOMES, and why:
//   a BOX origin (node / participant / note / cluster) → an SVG widget carrying
//     that origin's OWN paths, its viewBox set to the origin's sub-box so the
//     coordinates need no rewriting at all. Pixel-exact by construction: the same
//     `d`, the same resolved paint, the same painter. And it is a real bbox
//     widget, so it moves, resizes and has the nine standard anchors.
//   a LABEL text → a PLAINTEXT widget whose whole box IS its owner's box, by
//     equation, centred. Move or resize the box and the label follows, which is
//     the request. Its glyphs go through the SAME getTextLayout the mermaid
//     vector painter uses, so the type does not reflow.
//   an EDGE origin → an ARROW between the two boxes it joins, endpoints bound to
//     their rims by `closest` refs, so it RE-ROUTES. Where mermaid routed the
//     edge with bends this is a straight line and therefore NOT what mermaid
//     drew — declared in the notes, never silently.
//   an edge whose endpoints mermaid does not name (stateDiagram numbers its
//     edges `edge0`, `edge1` and states nothing else) → the exact path as an SVG
//     widget. Faithful, and honestly not anchored.
//   UNATTRIBUTED ink (a pie chart carries no identity at all) → one SVG widget
//     holding the remainder, so nothing is ever dropped.

/** Origin kinds that are BOX-LIKE — a thing with an interior that can contain a
 * label. Mermaid's own `data-et` vocabulary plus the unified renderer's `node`
 * (see mermaid_vector.js originOf); listed rather than derived because only a
 * consumer can know which of mermaid's kinds it intends to draw as a box. */
const SHATTER_BOX_KINDS = new Set(["node", "cluster", "participant", "note"]);
/** Origin kinds that are CONNECTOR-LIKE — a thing joining two boxes. */
const SHATTER_EDGE_KINDS = new Set(["edge", "message", "life-line"]);

/** The part key holding every path no origin claimed. One key, so the leftovers
 * are one widget the user can see, select and delete rather than confetti. */
const SHATTER_LEFTOVER_KEY = "unattributed";

/**
 * Pure function. Mermaid's composed DOM id → the id the AUTHOR wrote, or null.
 * Mermaid builds a node's id as `<diagramId>-<familyPrefix><authorId>-<counter>`
 * (measured on 11.16.0: `powerrp-mermaid-0-flowchart-A-0`,
 * `powerrp-mermaid-2-classId-Animal-0`, `powerrp-mermaid-3-state-Idle-2`), and
 * the author id is the middle segment. Recovering it matters because it is the
 * token an EDGE id is built from, so it is how an edge finds its endpoints.
 *
 * @param {string} domId - the `g.node` element id
 * @returns {string|null}
 *
 * @example authorIdOf("powerrp-mermaid-0-flowchart-A-0")
 * 'A'
 * @example authorIdOf("powerrp-mermaid-2-classId-Animal-0")
 * 'Animal'
 * @example authorIdOf("powerrp-mermaid-3-state-root_start-0")
 * 'root_start'
 * @example authorIdOf("Alice")
 * null
 */
export function authorIdOf(domId) {
  // GREEDY leading `.*`, deliberately: it backtracks to the LAST `-<word>-`,
  // which is the family segment. A lazy `.*?` matches the FIRST one instead, so
  // `powerrp-mermaid-0-flowchart-A-0` came back as `0-flowchart-A` and every
  // edge then failed to find its endpoints — the whole feature degraded to
  // unanchored paths with no error anywhere. Caught by the end-to-end probe,
  // not by these doctests, because the doctests were written from the intent.
  const m = /^.*-[A-Za-z]+-(.+)-\d+$/.exec(domId ?? "");
  return m ? m[1] : null;
}

/**
 * Pure function. The two author ids an edge joins, read off mermaid's edge id.
 * Flowchart writes `L_<src>_<tgt>_<n>` and class writes `id_<src>_<tgt>_<n>`,
 * both by plain `_` concatenation — so an author id containing `_` makes the
 * split AMBIGUOUS (`L_my_node_a_my_node_b_0` has several readings). The known
 * id set disambiguates it: only a split whose halves are both real ids counts,
 * and a tie returns null rather than a guess.
 *
 * @param {string} edgeId - mermaid's `data-id` for the edge
 * @param {Set<string>} known - every author id in the diagram
 * @returns {{from: string, to: string}|null}
 *
 * @example edgeEndpoints("L_A_B_0", new Set(["A", "B"]))
 * { from: 'A', to: 'B' }
 * @example edgeEndpoints("id_Animal_Dog_1", new Set(["Animal", "Dog", "Cat"]))
 * { from: 'Animal', to: 'Dog' }
 * @example edgeEndpoints("L_my_node_a_my_node_b_0", new Set(["my_node_a", "my_node_b"]))
 * { from: 'my_node_a', to: 'my_node_b' }
 * @example edgeEndpoints("edge0", new Set(["Idle"]))
 * null
 */
export function edgeEndpoints(edgeId, known) {
  const m = /^(?:L|id)_(.+)_\d+$/.exec(edgeId ?? "");
  if (!m) return null;
  const body = m[1];
  const hits = [];
  for (let i = 1; i < body.length; i++) {
    const from = body.slice(0, i), to = body.slice(i + 1);
    if (body[i] === "_" && known.has(from) && known.has(to)) hits.push({ from, to });
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Pure function. A stable, human PART KEY for one origin — what the shattered
 * child is called under its parent ("Flowchart / Start"). Prefers the origin's
 * own LABEL, because that is the word the author recognises on the canvas; falls
 * back to the author id, then the raw dom id. De-collided against `taken` with
 * the `_2` suffix core/expressions.js already uses for slug collisions, so two
 * boxes reading "Start" do not fight over one name.
 *
 * @param {string} label - the origin's label text ("" when it has none)
 * @param {string} id - the origin's dom id
 * @param {Set<string>} taken - keys already issued (MUTATED: the new key is added)
 * @returns {string}
 *
 * @example partKeyFor("Start", "powerrp-mermaid-0-flowchart-A-0", new Set())
 * 'Start'
 * @example partKeyFor("", "powerrp-mermaid-0-flowchart-A-0", new Set())
 * 'A'
 * @example partKeyFor("Start", "x-flowchart-B-1", new Set(["Start"]))
 * 'Start2'
 * @example partKeyFor("Do it", "x-flowchart-C-3", new Set())
 * 'DoIt'
 */
export function partKeyFor(label, id, taken) {
  const base = partKey((label || "").trim() || authorIdOf(id) || id || "part");
  let key = base;
  // De-collided WITHOUT an underscore (see core/shatter.js PART_KEY_PATTERN):
  // `Start2`, not `Start_2`, because an underscored key mis-resolves in the
  // shared reference remapper.
  for (let n = 2; taken.has(key); n++) key = `${base}${n}`;
  taken.add(key);
  return key;
}

/**
 * Pure function. One SVG document string carrying a set of flattened paths,
 * framed by `viewBox` — the `svgSrc` an svg widget renders.
 *
 * The paths keep their DIAGRAM-space `d` verbatim and the viewBox is set to the
 * sub-rect they occupy, so no coordinate is ever rewritten and no rounding is
 * introduced. That is what makes the ink identical rather than merely close.
 *
 * @param {Array<object>} paths - flattened paths ({d, fill, stroke, strokeWidth, fillRule, opacity})
 * @param {{x: number, y: number, w: number, h: number}} viewBox - the sub-rect to frame
 * @returns {string}
 *
 * @example pathsToSvgSrc([{d: "M0 0L10 0", stroke: "#333", strokeWidth: 2, fill: null}], {x: 0, y: 0, w: 10, h: 10})
 * '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L10 0" fill="none" stroke="#333" stroke-width="2"/></svg>'
 */
export function pathsToSvgSrc(paths, viewBox) {
  const body = paths.map((p) => {
    const attrs = [`d="${p.d}"`, `fill="${p.fill ?? "none"}"`];
    if (p.stroke && p.strokeWidth > 0) attrs.push(`stroke="${p.stroke}"`, `stroke-width="${p.strokeWidth}"`);
    if (p.fillRule === "evenodd") attrs.push('fill-rule="evenodd"');
    if ((p.opacity ?? 1) !== 1) attrs.push(`opacity="${p.opacity}"`);
    return `<path ${attrs.join(" ")}/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}">${body}</svg>`;
}

/**
 * Pure function. The bounding rect of a set of flattened paths, measured from
 * their baked `d` coordinates. Used to frame a connector or the leftover ink,
 * which — unlike a node — has no owning element with a box.
 *
 * A COORDINATE HULL, not a true path hull: it takes every numeric pair in the
 * `d` as a point, so an off-curve bezier control point can push the rect
 * slightly past the ink. That over-estimates and never under-estimates, which is
 * the safe direction — the widget's box is a frame, and a frame that is a little
 * large clips nothing.
 *
 * @param {Array<{d: string}>} paths
 * @returns {{x: number, y: number, w: number, h: number}|null} null when empty
 *
 * @example pathsBounds([{d: "M10 20L30 60"}])
 * { x: 10, y: 20, w: 20, h: 40 }
 * @example pathsBounds([{d: "M0 0L10 0"}, {d: "M-5 3L2 9"}])
 * { x: -5, y: 0, w: 15, h: 9 }
 * @example pathsBounds([])
 * null
 */
export function pathsBounds(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths)
    for (const pt of pathPoints(p.d)) {
      minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
      minY = Math.min(minY, pt.y); maxY = Math.max(maxY, pt.y);
    }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Pure function. The viewBox→WORLD map a shatter must reproduce exactly, because
 * every part is placed through it and the picture only survives if it matches
 * what emit() drew. Returns the same {scale, offsetX, offsetY} letterbox
 * drawMermaidVector applies, or the non-uniform stretch when preserveAspect is
 * off — one formula, read by both, so they cannot drift.
 *
 * @param {{minX, minY, w, h}} viewBox - the diagram's viewBox
 * @param {{x, y, w, h}} box - the widget's world box
 * @param {boolean} preserve - the widget's preserveAspect
 * @returns {{sx: number, sy: number, ox: number, oy: number}} world = (v - min) * s + o
 *
 * @example mermaidViewToWorld({minX: 0, minY: 0, w: 100, h: 100}, {x: 10, y: 20, w: 200, h: 200}, true)
 * { sx: 2, sy: 2, ox: 10, oy: 20 }
 * @example mermaidViewToWorld({minX: 0, minY: 0, w: 100, h: 50}, {x: 0, y: 0, w: 100, h: 100}, true)
 * { sx: 1, sy: 1, ox: 0, oy: 25 }
 * @example mermaidViewToWorld({minX: 0, minY: 0, w: 100, h: 50}, {x: 0, y: 0, w: 100, h: 100}, false)
 * { sx: 1, sy: 2, ox: 0, oy: 0 }
 */
export function mermaidViewToWorld(viewBox, box, preserve) {
  if (preserve) {
    const f = fitBox(viewBox.w, viewBox.h, box.w, box.h);
    return { sx: f.scale, sy: f.scale, ox: box.x + f.offsetX, oy: box.y + f.offsetY };
  }
  return { sx: box.w / viewBox.w, sy: box.h / viewBox.h, ox: box.x, oy: box.y };
}


/** A free-standing text run's box height, as a multiple of its font size. Only
 * has to exceed one line so the run never wraps (wrapping would change the
 * picture); a line box is conventionally a little over its em size. */
const TEXT_PART_LINE_FACTOR = 1.5;

/** The stroke a shattered edge falls back to when its flattened path reported
 * none. Mermaid's own default link colour in the `default` theme. */
const DEFAULT_EDGE_STROKE = "#333333";

/**
 * Pure function. Two decimal places. Diagram coordinates are sub-pixel, and a
 * raw float would put fifteen digits into an equation field a human has to read.
 *
 * @example round2(12.3456)
 * 12.35
 * @example round2(40)
 * 40
 */
function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * Pure function. One flattened text run to a PLAINTEXT part's state. `geometry`
 * is the anchoring equation set when the run belongs to a box, or null for a
 * free-standing run (an edge label), which is placed at its measured world point
 * instead because nothing declares anchors for it to bind to.
 *
 * align/valign are LEFT/TOP deliberately: the flatten reports each run's
 * top-left glyph-box corner and drawMermaidVector draws from exactly there, so
 * left/top is the alignment that reproduces Mermaid's own layout. Centring would
 * look tidier on a one-line node and would move the type on a three-compartment
 * class box, which is the wrong trade under a fidelity bar.
 *
 * @param {object} t - a flattened text ({text, x, y, size, color, bold, font})
 * @param {object|null} geometry - x/y/w/h overrides (equations), or null
 * @param {(r: object) => object} toWorld - diagram rect to world rect
 * @param {{sx: number}} map - the viewBox-to-world map (also scales the font)
 * @returns {object} a partial plaintext state
 *
 * @example // #  textPartState({text: "Start", x: 10, y: 4, size: 16, color: "#111", bold: false, font: "inter"},
 * @example // #                null, toWorld, {sx: 2})
 * @example // #  -> {type: "plaintext", text: "Start", size: 32, fill: "#111", align: "left", valign: "top", x, y, w, h}
 */
function textPartState(t, geometry, toWorld, map) {
  const base = {
    type: "plaintext", text: t.text, size: t.size * map.sx,
    fill: t.color, bold: !!t.bold, font: t.font,
    align: "left", valign: "top",
  };
  if (geometry) return { ...base, ...geometry };
  const w = toWorld({ x: t.x, y: t.y, w: 0, h: 0 });
  // A free run has no owner to size against, so its box is its own line. The
  // width is deliberately generous: at align "left" a text box wider than its
  // glyphs draws identically, while one too narrow would WRAP and change the
  // picture, so erring wide is the only safe direction.
  return { ...base, x: w.x, y: w.y, w: t.text.length * t.size * map.sx, h: t.size * map.sx * TEXT_PART_LINE_FACTOR };
}

/** Pure function. The human name of an edge part — its own label where it has
 * one, else a description of what it joins, else its Mermaid id. Kept apart from
 * the KEY because a key must tokenize and a name only has to read.
 *
 * @example edgeLabelFor({origin: {id: "L_A_B_0"}, texts: [{text: "Yes"}]})
 * 'Yes edge'
 * @example edgeLabelFor({origin: {id: "L_A_B_0"}, texts: []})
 * 'L_A_B_0 edge'
 */
function edgeLabelFor(bucket) {
  const own = bucket.texts.length > 0 ? bucket.texts[0].text : "";
  return `${own || bucket.origin.id} edge`;
}

/**
 * MERMAID'S MARKER VOCABULARY → THE CONNECTOR HEAD SHAPES (core/endpoints.js
 * HEAD_SHAPES). Mermaid names each marker after the glyph it means, so its own
 * id is a statement of INTENT — which is why the flatten carries the id rather
 * than the shatter trying to recognise a hollow triangle from baked geometry.
 *
 * Keyed by the marker's BASE name with mermaid's diagram prefix and its
 * Start/End suffix stripped (`markerBaseName`), so one entry covers
 * `flowchart-pointEnd`, `flowchart-v2-pointStart` and any future prefix. The
 * mapping is W4-G's, from the audit that built these shapes against the pinned
 * mermaid build (.frenzy/round6/W4-G.md); it is transcribed here rather than
 * derived because only a human can say that UML `extension` MEANS a hollow
 * triangle.
 *
 * A marker absent from this table is NOT silently dropped: shatterHeadShape
 * returns null and the caller counts it and names it in the disclosure.
 *
 * THIS IS A HAND-MAINTAINED MIRROR of core/endpoints.js HEAD_SHAPES and cannot be
 * derived — only a human knows that UML `extension` means a hollow triangle. So
 * it gets the treatment a non-derivable mirror is owed: tests/shatter_test.js
 * fails if any value here stops being a real head shape. The gate lives in the
 * test rather than at import scope deliberately (ledger C-19): a module that
 * refuses to load takes every suite that transitively reaches paint_skia with it.
 */
export const MERMAID_MARKER_HEADS = {
  point: "triangle",
  barb: "dart",
  dependency: "dart",
  extension: "triangleOpen",
  composition: "diamond",
  aggregation: "diamondOpen",
  circle: "circleOpen",
  lollipop: "circleOpen",
  cross: "cross",
  requirement_arrow: "open",
  requirement_contains: "crossedCircle",
  onlyOne: "onlyOne",
  zeroOrOne: "zeroOrOne",
  oneOrMore: "oneOrMore",
  zeroOrMore: "zeroOrMore",
};

/**
 * Pure function. A mermaid marker id reduced to the base glyph name the head
 * table is keyed by: the diagram prefix and the Start/End suffix removed.
 *
 * @param {string} markerId - e.g. "flowchart-pointEnd"
 * @returns {string} e.g. "point"
 *
 * @example markerBaseName("flowchart-pointEnd")
 * 'point'
 * @example markerBaseName("classDiagram-extensionStart")
 * 'extension'
 * @example markerBaseName("erDiagram-zeroOrMoreEnd")
 * 'zeroOrMore'
 * @example markerBaseName("requirementDiagram-requirement_containsStart")
 * 'requirement_contains'
 * @example markerBaseName("")
 * ''
 */
export function markerBaseName(markerId) {
  const afterPrefix = String(markerId ?? "").split("-").pop();
  return afterPrefix.replace(/(?:Start|End)$/, "");
}

/**
 * Pure function. The connector head shape a mermaid marker means, or null when
 * this build emits a marker the table does not know.
 *
 * NULL IS A REAL ANSWER AND MUST STAY ONE. Defaulting an unknown marker to a
 * filled triangle would draw a plausible arrow with the wrong meaning — a UML
 * aggregation silently becoming a plain arrow is exactly the "looks fine, says
 * something else" failure the no-silent-fallback rule exists for. The caller
 * counts these and names them.
 *
 * @param {string|undefined} markerId - the marker id from the flatten, if any
 * @returns {string|null} a HEAD_SHAPES value, or null
 *
 * @example shatterHeadShape("flowchart-pointEnd")
 * 'triangle'
 * @example shatterHeadShape("classDiagram-aggregationStart")
 * 'diamondOpen'
 * @example shatterHeadShape(undefined)
 * null
 * @example shatterHeadShape("flowchart-somethingNewEnd")
 * null
 */
export function shatterHeadShape(markerId) {
  if (!markerId) return null;
  const shape = MERMAID_MARKER_HEADS[markerBaseName(markerId)];
  return shape ?? null;
}

/**
 * Pure function. Every coordinate PAIR in a path `d`, as points — the polyline
 * reading of a baked path.
 *
 * An APPROXIMATION for curves, deliberately and knowingly: a cubic's control
 * points are read as vertices, so a curved route's polyline bulges toward its
 * handles. Both consumers here tolerate that — a bounding rect only has to
 * contain the ink, and a label offset only has to be near the route's middle —
 * and the alternative is a full path flattener for two callers that do not need
 * one.
 *
 * @param {string} d - an SVG path data string
 * @returns {Array<{x: number, y: number}>}
 *
 * @example pathPoints("M10 20L30 60")
 * [ { x: 10, y: 20 }, { x: 30, y: 60 } ]
 * @example pathPoints("M0,0 L10,0 L10,10").length
 * 3
 * @example pathPoints("")
 * []
 */
export function pathPoints(d) {
  const nums = (String(d ?? "").match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push({ x: nums[i], y: nums[i + 1] });
  return out;
}

export const mermaidPlugin = {
  type: "mermaid",
  title: "Mermaid Diagram",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): open the
  // reusable full-screen Monaco code editor on the `definition` (ROUND 2 #32) —
  // "double-clicking a mermaid diagram opens a 90%×90% VS-Code-style editor".
  activate: "code_modal",
  // THE code-editor descriptor the "code_modal" activation AND the "edit-code-source"
  // command both read (ROUND 2 #33): WHICH multi-line string is the code source, in
  // what Monaco language, and the modal's title. Declaring this — plus surfacing the
  // command as the Inspector "</>" action row below — is ALL a code-ish widget needs
  // to get the shared editor (no per-widget UI).
  codeEditor: { property: "definition", language: "mermaid", title: "Edit Mermaid Diagram" },
  // DEMO PRESETS (ROUND 2 #34): a "Demo presets" Tools-area dropdown, one preset per
  // Mermaid diagram type, from Mermaid's own docs examples (MERMAID_DEMO_PRESETS).
  // presetFamilies (not presets) so the group is titled "Demo presets" specifically;
  // each preset writes `definition` as one undo unit via app.applyPreset.
  presetFamilies: [{ id: "demos", title: "Demo presets", presets: MERMAID_DEMO_PRESETS }],
  /**
   * Pure function. Is this diagram currently a GHOST? STATE-dependent — a mermaid
   * widget is a ghost only while its definition is empty (mermaidIsEmpty is the
   * canonical predicate, shared with emit()'s short-circuit).
   *
   * @example mermaidPlugin.isGhost({ definition: "" })
   * true
   * @example mermaidPlugin.isGhost({ definition: "flowchart TD\n A-->B" })
   * false
   */
  isGhost(state) {
    return mermaidIsEmpty(state.definition);
  },
  // defaults + rows COMPOSE from the SHARED PROPERTY REGISTRY — positioning,
  // stroked BOX (fill/stroke/strokeWidth/cornerRadius — a framed diagram card),
  // crop insets, effects are inherited. Only `definition`/`theme`/`preserveAspect`
  // are widget-specific.
  defaults: {
    type: "mermaid", x: 100, y: 100, w: 360, h: 260, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center. Absent on old
    // docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    definition: DEFAULT_DEFINITION,
    theme: DEFAULT_MERMAID_THEME,
    // PRESERVE ASPECT (default ON): the diagram UNIFORM-scales to FIT the box
    // (centered/letterboxed over the fill), never squashing. OFF stretches it to
    // the box aspect.
    preserveAspect: true,
    // A legible card look by default (see the DEFAULT_* consts). fill paints
    // behind the diagram raster (which is transparent), so a default-theme
    // diagram reads on any canvas background.
    fill: DEFAULT_FILL, stroke: DEFAULT_STROKE,
    ...defaults("strokeWidth", "cornerRadius", "opacity"),
    strokeWidth: DEFAULT_STROKE_WIDTH, cornerRadius: DEFAULT_CORNER_RADIUS,
    ...defaults("cropTop", "cropLeft", "cropRight", "cropBottom"), // all 0 → no crop
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  inspector: [
    ...bundle("positioning"),
    // THE diagram source — a multi-line STRING. Uses the "text" row kind (which
    // round-trips the whole string) for storage/undo, edited directly in the
    // Inspector — identical to how codeblock's `code` is edited (no floating
    // canvas overlay). In EQUATION mode this text property uses the normal
    // equation field; otherwise it is the LITERAL Mermaid source.
    { key: "definition", label: "Definition", kind: "text", category: "text", help: "The Mermaid diagram source (e.g. 'flowchart TD\\n A-->B'), edited here inline OR — for a real multi-line edit — in the code editor via the button below. Invalid syntax shows a red error box with the parser message." },
    // THE CODE BUTTON (ROUND 2 #35): "a code button next to the flowchart text …
    // so I don't have to know to double-click." An `action` row (the existing
    // command-trigger row kind) surfacing the widget-agnostic `edit-code-source`
    // command, which reads this plugin's `codeEditor` descriptor and opens the
    // full-screen Monaco editor on `definition`. Sits right under the Definition
    // field, in the same "text" category.
    { key: "__editdefinition", label: "Edit in code editor…", kind: "action", command: "edit-code-source", category: "text", help: "Opens the full-screen VS-Code-style editor (syntax highlighting, autocomplete, minimap) on the diagram source — the same editor double-clicking the diagram opens." },
    // Theme — a Mermaid built-in theme select.
    { key: "theme", label: "Theme", kind: "select", options: MERMAID_THEMES, category: "formatting", help: "Which Mermaid built-in theme to render with. 'default' is dark ink on a light card; 'dark' suits a dark fill." },
    // Aspect-preservation toggle (default ON).
    { key: "preserveAspect", label: "Preserve aspect", kind: "boolean", category: "formatting", help: "Scale the diagram uniformly to fit the box (centered, no distortion). Turn off to stretch it to the box's exact width and height." },
    // The stroked-BOX bundle (fill + border + rounding — a framed diagram card).
    ...bundle("strokedBox"),
    // EDGE-CROP INSETS — trim the rendered diagram from each side.
    ...bundle("cropInsets"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Near-pure function (kicks idempotent async render/raster as a side effect;
   * the RETURNED IR is a pure function of state). State → display-list commands
   * (local space).
   *
   * GHOST short-circuit: an empty definition draws NOTHING (returns []).
   * ERROR short-circuit: once rendered, if the definition failed to parse
   * (mermaidErrorFor non-null), draw the LOUD vector error affordance.
   * SCALE: the item's own world.scale bucket (mermaid_raster keys + supersamples
   * on it) — a zoom/resize into a new bucket re-renders; within one bucket the
   * cached bitmap is reused.
   */
  emit(s, _targetWorldIR, world) {
    const def = s.definition;
    if (mermaidIsEmpty(def)) return []; // GHOST — draws nothing
    const c = cropInsetsToSource(s.w ?? 0, s.h ?? 0, s);
    if (c.w <= 0 || c.h <= 0) return []; // fully cropped away

    const worldScale = world?.scale ?? 1;
    const theme = s.theme ?? DEFAULT_MERMAID_THEME;
    ensureMermaidRendered(def, theme, worldScale); // idempotent; safe every emit()

    const style = {
      x: c.x, y: c.y, w: c.w, h: c.h,
      fill: s.fill, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0,
    };

    // ERROR AFFORDANCE: once the render ran Mermaid's parser and it rejected,
    // draw the loud red box+message (vector) rather than the (empty) raster.
    // Before the render lands mermaidErrorFor is null → we optimistically emit
    // the image op (draws nothing until the bitmap or the error affordance
    // arrives on the repaint), so an error is NEVER shown as a blank widget.
    const errMsg = mermaidErrorFor(def);
    if (errMsg) {
      const shifted = errorAffordance(c.w, c.h, errMsg).map((op) => ({ ...op, x: op.x + c.x, y: op.y + c.y }));
      return applyEffects(decorateStrokedBox(shifted, style, world), s, world, { x: c.x, y: c.y, w: c.w, h: c.h });
    }

    const ref = mermaidRef(def, theme, worldScale);
    const opacity = s.opacity ?? 1;
    const preserve = s.preserveAspect !== false;
    const cropped = c.sw < 1 || c.sh < 1 || c.sx > 0 || c.sy > 0;
    const aspect = mermaidAspect(def, theme);
    // TRUE VECTOR (crisp at any zoom): once the flatten lands (browser-side,
    // async — null until then, OR when the diagram can't be vectorized, in which
    // case mermaid_raster already warned LOUDLY), emit a mermaidVector op that
    // draws the flattened shapes+text as real VECTOR (SVG/PDF embed vector; the
    // GPU draws crisp at any zoom) AND carries the raster `ref` for the HYBRID
    // RULE fallback (a mermaid UNDER a blur rasterizes like text). Before it lands
    // — or when unflattenable — degrade to the plain raster `image` op (draws the
    // bitmap; a repaint re-emits the vector op once the geometry is cached), the
    // async no-silent-placeholder contract identical to latex. The vector op does
    // its OWN preserveAspect letterbox (viewBox→box fitBox), mirroring latexVector.
    // A CROPPED diagram (edge-crop shrinks the source) stays RASTER: the vector op
    // maps all geometry into the box with no source-sub-rect clip, so it can't
    // represent a partial crop — rasterizing (which honors sx/sy/sw/sh) is the
    // faithful, no-divergence choice, exactly latex's hybrid rule.
    const geom = cropped ? null : mermaidVectorGeom(def, theme);
    let quad;
    if (geom) {
      quad = mermaidVector({
        ref, x: c.x, y: c.y, w: c.w, h: c.h, opacity,
        paths: geom.paths, texts: geom.texts, viewBox: geom.viewBox,
        preserveAspect: preserve,
      });
    } else if (preserve && !cropped && aspect && aspect.w > 0 && aspect.h > 0) {
      // RASTER fallback, letterboxed: uniform-scale the full diagram into the box
      // via fitBox (centered over the box fill), the same faithful choice latex
      // makes. Used only until the vector flatten lands (or if it can't).
      const fit = fitBox(aspect.w, aspect.h, c.w, c.h);
      quad = image({ ref, x: c.x + fit.offsetX, y: c.y + fit.offsetY, w: aspect.w * fit.scale, h: aspect.h * fit.scale, opacity });
    } else {
      // RASTER fallback, stretched: a cropped sub-rect cannot be cleanly
      // letterboxed, so stretch the (possibly cropped) source into the box.
      quad = image({ ref, x: c.x, y: c.y, w: c.w, h: c.h, opacity, sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh });
    }
    // Effects wrap OUTSIDE the border decoration (effects.js order rule).
    return applyEffects(decorateStrokedBox([quad], style, world), s, world, { x: c.x, y: c.y, w: c.w, h: c.h });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  // The natural-aspect hook: the app can call this after a render lands to fit
  // the widget to the diagram's aspect (the image.js native-size-insert seam).
  // Returns null until the aspect is measured.
  naturalSize(state) {
    return mermaidAspect(state.definition, state.theme ?? DEFAULT_MERMAID_THEME);
  },
  /**
   * Query (reads the flatten cache; mutates nothing). THE DECOMPOSITION - this
   * diagram as a set of editable widgets wired to each other by equations.
   * core/shatter.js owns everything else: the type change, the id plumbing, the
   * naming and the one undo unit.
   *
   * Refuses LOUDLY when there is no vector geometry. Both causes are real and
   * expected - the render is async, and a foreignObject diagram is
   * unflattenable - and both mean there is nothing to decompose. Shattering into
   * nothing while reporting success is the silent failure this codebase forbids,
   * so the command gates on the same condition and this throws if called anyway.
   *
   * @param {object} s - the item's evaluated state
   * @param {{box: {x, y, w, h}}} ctx - the host's WORLD box; parts are placed in it
   * @returns {{parts: Array<{key: string, state: object, raster?: boolean}>, notes: string[]}}
   */
  /**
   * Pure function (one Map lookup). Why this diagram cannot be shattered YET, or
   * null. The flatten is ASYNC — `mermaidVectorGeom` is null until the render
   * lands, and stays null for a diagram that could not be vectorized at all
   * (a foreignObject diagram; mermaid_raster warned about it loudly at the time).
   * Cheap because it is a command GATE: see core/shatter.js shatterNotReadyReason.
   *
   * @example mermaidPlugin.shatterNotReady({definition: "flowchart TD\n A-->B"})
   * 'a diagram that has finished rendering (this one has no vector geometry yet, or could not be vectorized)'
   */
  shatterNotReady(s) {
    return mermaidVectorGeom(s.definition, s.theme ?? DEFAULT_MERMAID_THEME)
      ? null
      : "a diagram that has finished rendering (this one has no vector geometry yet, or could not be vectorized)";
  },
  shatter(s, ctx) {
    const theme = s.theme ?? DEFAULT_MERMAID_THEME;
    const geom = mermaidVectorGeom(s.definition, theme);
    if (!geom)
      throw new Error("Mermaid: no vector geometry to shatter - the diagram has not finished rendering, or it could not be vectorized (its render warnings say which).");
    const vb = geom.viewBox;
    const map = mermaidViewToWorld(vb, ctx.box, s.preserveAspect !== false);
    /** Pure. A diagram-space rect to its world rect under the widget's own map. */
    const toWorld = (r) => ({
      x: (r.x - vb.minX) * map.sx + map.ox, y: (r.y - vb.minY) * map.sy + map.oy,
      w: r.w * map.sx, h: r.h * map.sy,
    });

    // 1. BUCKET every path and text by the origin claiming it. An origin without
    //    an id is as unusable as no origin, so both fall through to leftovers.
    const buckets = new Map();
    const leftovers = [];
    for (const collection of [geom.paths, geom.texts])
      for (const e of collection) {
        const k = e.origin && e.origin.id ? `${e.origin.kind} ${e.origin.id}` : null;
        if (k === null) { if (e.d) leftovers.push(e); continue; }
        if (!buckets.has(k)) buckets.set(k, { origin: e.origin, paths: [], texts: [] });
        buckets.get(k)[e.d ? "paths" : "texts"].push(e);
      }

    // 2. NAME EVERY BOX FIRST, so an edge written afterwards has something to
    //    reference. Both the part key (the child's display name) and the map
    //    from Mermaid's author id to that key are built here, once.
    const taken = new Set();
    const keyByBucket = new Map();
    const keyByAuthorId = new Map();
    const boxes = [...buckets].filter(([, b]) => SHATTER_BOX_KINDS.has(b.origin.kind) && b.origin.box);
    for (const [bk, b] of boxes) {
      const key = partKeyFor(b.texts.length > 0 ? b.texts[0].text : "", b.origin.id, taken);
      keyByBucket.set(bk, key);
      keyByAuthorId.set(authorIdOf(b.origin.id) ?? b.origin.id, key);
    }
    const knownAuthorIds = new Set(keyByAuthorId.keys());

    const parts = [];
    const notes = [];
    let straightened = 0;
    let unanchored = 0;
    let boundEdgeLabels = 0;
    let truncatedDashes = 0;
    const unknownHeads = new Set();
    const anchoredEdgeKeys = new Set();

    // 3. EDGES FIRST so their z lands UNDER the boxes - Mermaid draws them that
    //    way, and core/shatter.js writes parts in order with rising z.
    for (const [, b] of buckets) {
      if (!SHATTER_EDGE_KINDS.has(b.origin.kind)) continue;
      const named = b.origin.from && b.origin.to
        ? { from: b.origin.from, to: b.origin.to }
        : edgeEndpoints(b.origin.id, knownAuthorIds);
      const fromKey = named ? keyByAuthorId.get(named.from) : undefined;
      const toKey = named ? keyByAuthorId.get(named.to) : undefined;
      const key = partKeyFor(b.texts.length > 0 ? `${b.texts[0].text} edge` : "", b.origin.id, taken);
      if (fromKey && toKey) {
        // ANCHORED. Both endpoints ride the rim solver, so moving either box
        // re-routes the arrow - the point of the whole feature. Mermaid may have
        // routed this edge with bends; a straight shaft between the same two
        // rims is the closest thing that still re-routes, and the note says so.
        // The box parts are SVG widgets, which declare closestAnchor - a bare
        // text widget does not, and a `closest` ref against one throws.
        const shaft = b.paths.find((p) => !p.marker) ?? b.paths[0];
        straightened++;
        // HEADS, PER END, from mermaid's own marker ids (#231). `none` where
        // mermaid declared no marker; an UNKNOWN marker keeps `none` and is
        // counted, because drawing a plausible-but-wrong glyph is worse than
        // drawing none and saying so.
        const headStart = shatterHeadShape(shaft?.markerStart);
        const headEnd = shatterHeadShape(shaft?.markerEnd);
        for (const [id, shape] of [[shaft?.markerStart, headStart], [shaft?.markerEnd, headEnd]])
          if (id && !shape) unknownHeads.add(markerBaseName(id));
        // DASH (#232), in world units. mermaid's `-.->`, a class `..>`
        // dependency and an ER `..` are all just this.
        const dash = shaft?.dash;
        if (shaft?.dashTruncated) truncatedDashes++;
        parts.push({ key, label: edgeLabelFor(b), state: {
          type: "arrow",
          from: { x: `= ${partRef(fromKey)}_closest.x`, y: `= ${partRef(fromKey)}_closest.y` },
          to: { x: `= ${partRef(toKey)}_closest.x`, y: `= ${partRef(toKey)}_closest.y` },
          stroke: shaft && shaft.stroke ? shaft.stroke : DEFAULT_EDGE_STROKE,
          strokeWidth: (shaft && shaft.strokeWidth > 0 ? shaft.strokeWidth : 1) * map.sx,
          headStart: headStart ?? "none",
          headEnd: headEnd ?? "none",
          ...(dash ? { dashed: true, dashLength: dash[0] * map.sx, dashGap: dash[1] * map.sx } : {}),
        } });
        anchoredEdgeKeys.add(key);
      } else {
        // NOT ANCHORED. Mermaid named this edge only by index (stateDiagram's
        // `edge0`), so there is nothing to bind to. Keep its exact path.
        const bounds = pathsBounds(b.paths);
        if (!bounds) continue;
        unanchored++;
        parts.push({ key, label: edgeLabelFor(b), state: { type: "svg", ...toWorld(bounds), svgSrc: pathsToSvgSrc(b.paths, bounds), preserveAspect: false } });
      }
      // AN EDGE LABEL NOW BINDS TO ITS EDGE (#233). All five connectors publish
      // start/mid/end on the DRAWN path, so a label rides the connector's own
      // arc-length midpoint and travels with it when either box moves.
      //
      // OFFSET FROM `mid`, NOT PLACED ON IT. Mermaid does not centre a label on
      // its route midpoint — it lifts it clear of the line — so the offset is
      // measured from mermaid's own geometry and preserved. `mid` is read
      // through core/endpoints.js connectorPathAnchors, the SAME function the
      // arrow's `anchors` hook uses, so the two cannot disagree about what the
      // midpoint of a path is.
      //
      // Only an ANCHORED edge gets this: an unanchored one is an svg widget,
      // which publishes bbox anchors, not path anchors, and `_mid` on it would
      // be an equation error rather than a label.
      const routeMid = anchoredEdgeKeys.has(key)
        ? connectorPathAnchors(pathPoints((b.paths.find((p) => !p.marker) ?? b.paths[0])?.d ?? "")).find((a) => a.id === "mid")
        : null;
      for (const t of b.texts) {
        const geometry = routeMid ? (() => {
          const w = toWorld({ x: t.x, y: t.y, w: 0, h: 0 });
          const midW = toWorld({ x: routeMid.x, y: routeMid.y, w: 0, h: 0 });
          return { x: `= ${partRef(key)}_mid.x + ${round2(w.x - midW.x)}`, y: `= ${partRef(key)}_mid.y + ${round2(w.y - midW.y)}` };
        })() : null;
        parts.push({ key: partKeyFor(`${t.text} label`, b.origin.id, taken), label: `${t.text} label`,
          state: { ...textPartState(t, null, toWorld, map), ...(geometry ?? {}) } });
        if (geometry) boundEdgeLabels++;
      }
    }

    // 4. BOXES, then the labels bound to them.
    for (const [bk, b] of boxes) {
      const key = keyByBucket.get(bk);
      const w = toWorld(b.origin.box);
      parts.push({ key, label: (b.texts.length > 0 ? b.texts[0].text : "") || key, state: { type: "svg", ...w, svgSrc: pathsToSvgSrc(b.paths, b.origin.box), preserveAspect: false } });
      for (const t of b.texts) {
        const tw = toWorld({ x: t.x, y: t.y, w: 0, h: 0 });
        // AN OFFSET FROM THE BOX'S TOP-LEFT, not a centring equation. The offset
        // reproduces Mermaid's own layout exactly - which centring could not do
        // for a class box's three stacked compartments - and it still tracks the
        // box when the box moves, which is what was asked for.
        parts.push({ key: partKeyFor(`${t.text} label`, b.origin.id, taken), label: `${t.text} label`, state: textPartState(t, {
          x: `= ${partRef(key)}_tl.x + ${round2(tw.x - w.x)}`,
          y: `= ${partRef(key)}_tl.y + ${round2(tw.y - w.y)}`,
          w: `= ${partRef(key)}_tr.x - ${partRef(key)}_tl.x`,
          h: `= ${partRef(key)}_bl.y - ${partRef(key)}_tl.y`,
        }, toWorld, map) });
      }
    }

    // 5. WHATEVER NOTHING CLAIMED, as ONE widget - visible, selectable and
    //    deletable, rather than confetti the user has to clean up.
    if (leftovers.length > 0) {
      const bounds = pathsBounds(leftovers);
      if (bounds)
        parts.push({ key: SHATTER_LEFTOVER_KEY, state: { type: "svg", ...toWorld(bounds), svgSrc: pathsToSvgSrc(leftovers, bounds), preserveAspect: false } });
    }

    // THE DISCLOSURE. Counts, not adjectives: an author can act on "3 edges are
    // not anchored" and can do nothing at all with "approximate".
    const plural = (n) => (n === 1 ? "" : "s");
    if (straightened > 0)
      notes.push(`${straightened} edge${plural(straightened)} became arrows bound to the boxes' rims, so they re-route when a box moves; where Mermaid routed an edge with bends, those bends are not reproduced.`);
    if (boundEdgeLabels > 0)
      notes.push(`${boundEdgeLabels} edge label${plural(boundEdgeLabels)} ${boundEdgeLabels === 1 ? "is" : "are"} bound to ${boundEdgeLabels === 1 ? "its" : "their"} edge's midpoint, so ${boundEdgeLabels === 1 ? "it travels" : "they travel"} with the edge.`);
    if (unknownHeads.size > 0)
      notes.push(`${unknownHeads.size} arrowhead${plural(unknownHeads.size)} (${[...unknownHeads].join(", ")}) ${unknownHeads.size === 1 ? "is" : "are"} not in this build's head vocabulary, so ${unknownHeads.size === 1 ? "that end was" : "those ends were"} left bare rather than given a plausible wrong glyph.`);
    if (truncatedDashes > 0)
      notes.push(`${truncatedDashes} edge${plural(truncatedDashes)} used a dash pattern with more than two lengths; only the first drawn/gap pair is reproduced.`);
    if (unanchored > 0)
      notes.push(`${unanchored} edge${plural(unanchored)} kept Mermaid's exact path and ${unanchored === 1 ? "is" : "are"} NOT anchored: Mermaid names ${unanchored === 1 ? "it" : "them"} only by index, so there is nothing to bind to.`);
    if (leftovers.length > 0)
      notes.push(`${leftovers.length} shape${plural(leftovers.length)} carry no identity in Mermaid's output (pie and gantt carry none at all) and were kept together as one SVG.`);
    if (geom.warnings && geom.warnings.length > 0) notes.push(...geom.warnings);
    return { parts, notes };
  },
  commands: [
    { id: "add-mermaid", title: "Add Mermaid Diagram", icon: "mdi:sitemap-outline", run: (app) => app.armCrosshairPlacement(mermaidPlugin) },
  ],
};
