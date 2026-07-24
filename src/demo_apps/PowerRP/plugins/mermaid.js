/**
 * MERMAID DIAGRAM widget — a `definition` (Mermaid diagram source) renders to a
 * diagram on the canvas. `definition` is a multi-line CODE property (edited via
 * the canvas CodeEditController overlay on double-click, not a single-line
 * Inspector field); `theme` picks a Mermaid built-in theme; `preserveAspect`
 * (default ON) letterboxes the diagram into the widget box without distortion.
 *
 * ── BOX SHAPE IS A GENERIC TERM (standing manifest ruling) ────────────────────
 * A rendered diagram is a BOX exactly like an image, a PDF page, or a typeset
 * equation: it composes the SAME shared bundles (core/properties.js) —
 * positioning, the stroked-BOX slice (fill/stroke/strokeWidth/cornerRadius — a
 * framed diagram card), crop insets, and effects (shadow/bloom/blend) — so it
 * inherits every box feature for free with zero widget-specific decoration code.
 * This file is deliberately near-identical to plugins/latex.js; the only new
 * concerns are `definition`/`theme`/`preserveAspect` and the render→bitmap
 * pipeline underneath (render_gpu/gpu/mermaid_raster.js).
 *
 * ── HOW IT REACHES THE RENDERER (reusing the image path, not a new IR op) ─────
 * A rendered diagram is a bitmap (Mermaid SVG → rasterized). emit() builds a
 * plain `image()` op whose `ref` is a SYNTHETIC key from mermaid_raster.js
 * (mermaidRef(def, theme, scale)) — the GPU compositor, PDF backend, and SVG
 * backend all resolve an image ref uniformly, so this widget needs ZERO new
 * backend code (the latex_raster/pdf_page precedent). v1 is RASTER; a true
 * vector flatten is deferred (see mermaid_raster's header).
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
import { image, rect, text } from "../render_gpu/ir.js";
import { decorateStrokedBox, cropInsetsToSource } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import {
  ensureMermaidRendered, mermaidRef, mermaidAspect, mermaidErrorFor, mermaidIsEmpty,
  MERMAID_THEMES, DEFAULT_MERMAID_THEME,
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
    // THE diagram source — a multi-line STRING. Uses the "text" row kind (a
    // single-line field that round-trips the whole string) for storage/undo, but
    // the PRIMARY editor is the canvas CodeEditController overlay (double-click
    // the widget) — the same reason latex/codeblock keep "text" here while adding
    // an overlay. In EQUATION mode this text property uses the normal equation
    // field; the code overlay is the LITERAL-mode interface.
    { key: "definition", label: "Definition", kind: "text", category: "text", help: "The Mermaid diagram source (e.g. 'flowchart TD\\n A-->B'). Double-click the widget on the canvas to edit it in the multi-line code editor. Invalid syntax shows a red error box with the parser message." },
    // Theme — a Mermaid built-in theme select.
    { key: "theme", label: "Theme", kind: "select", options: MERMAID_THEMES, category: "formatting", help: "Which Mermaid built-in theme to render with. 'default' is dark ink on a light card; 'dark' suits a dark fill." },
    // Aspect-preservation toggle (default ON).
    { key: "preserveAspect", label: "Preserve aspect", kind: "checkbox", category: "formatting", help: "Scale the diagram uniformly to fit the box (centered, no distortion). Turn off to stretch it to the box's exact width and height." },
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
    // preserveAspect (uncropped, aspect known) → letterbox the full diagram into
    // the box via fitBox (centered over the box fill). Otherwise stretch the
    // (possibly cropped) source into the box — a cropped sub-rect cannot be
    // cleanly letterboxed, the same faithful choice latex makes.
    let quad;
    if (preserve && !cropped && aspect && aspect.w > 0 && aspect.h > 0) {
      const fit = fitBox(aspect.w, aspect.h, c.w, c.h);
      quad = image({ ref, x: c.x + fit.offsetX, y: c.y + fit.offsetY, w: aspect.w * fit.scale, h: aspect.h * fit.scale, opacity });
    } else {
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
