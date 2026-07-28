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
  commands: [
    { id: "add-mermaid", title: "Add Mermaid Diagram", icon: "mdi:sitemap-outline", run: (app) => app.armCrosshairPlacement(mermaidPlugin) },
  ],
};
