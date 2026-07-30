/**
 * THE WIDGET UI-HANDLER REGISTRY — how a widget OWNS its editor behaviour.
 *
 * A widget's behaviour in the editor has PHASES, and each phase used to be an
 * if-chain of known type names / known capability names inside the canvas
 * component. That made OPTING INTO an existing behaviour modular (one line in the
 * plugin) but adding a genuinely NEW KIND of behaviour a canvas edit — so the
 * canvas slowly accumulated every widget's special case. This registry inverts
 * it, exactly the way the MATERIAL FRAMEWORK (render_gpu/skia/materials.js)
 * already inverted the same problem for shaders:
 *
 *   THE HOST OWNS THE SERVICES.  THE WIDGET OWNS THE CHOICE.
 *
 *   plugins/foo.js          →  activate: "navigate_interior"   (ONE string)
 *   web/widget_handlers.js  →  id → handler descriptor          (this file)
 *   web/CanvasView.svelte   →  resolve the handler, call it with a context
 *
 * Adding a new kind of double-click behaviour, or a new creation gesture, is a
 * new descriptor here (usually in its own file, imported below) plus one string
 * in the plugin. It does NOT touch CanvasView, App.svelte, or any other widget.
 *
 * ── WHY THE PLUGIN CANNOT SIMPLY HAND OVER A COMPONENT ───────────────────────
 * `core/` and `plugins/` MUST stay DOM-free: the CLI renderer and the node test
 * suites import every plugin in bare node, and no plugin may import another. So a
 * plugin cannot carry a Svelte component, a DOM node, or an event handler. It can
 * carry a STRING. This file is in `web/`, the DOM layer, so it may carry anything
 * — components included. That asymmetry is the whole reason the indirection
 * exists, and it is the same reason a plugin names a material ("mandelbrot")
 * instead of shipping SkSL bindings.
 *
 * ── THE PHASES ───────────────────────────────────────────────────────────────
 *   "create"    — what happens when a widget is INSERTED (drag a box, drag a
 *                 from→to segment, drag a box and then prompt for an asset, and in
 *                 future: assemble a multi-item rig).
 *   "activate"  — what happens when a widget is DOUBLE-CLICKED (in-place text
 *                 editor, LaTeX editor, canvas palette, asset picker, and now
 *                 interior explore mode).
 * A third phase (TOOLING — which Tools groups a widget exposes) is being built
 * separately; if it lands as a declaration of the same shape it belongs here as
 * PHASES.tooling rather than in a parallel registry.
 *
 * Each phase declares WHICH plugin field names its handler:
 *   create   → `placement` (the field that ALREADY declares "bbox"/"endpoints" —
 *              retro-fitted rather than replaced, so no plugin changes)
 *   activate → `activate`
 *
 * ── THE CONTEXT (the services the host provides) ──────────────────────────────
 * `run(ctx)` / `place(ctx)` receive:
 *   ctx.app                    the app store — document, selection, undo, and
 *                              setPreview/commitPreview (live preview with no
 *                              undo spam, committed as ONE undo unit)
 *   ctx.plugin                 the widget's plugin
 *   ctx.node                   (activate) the hit render node {itemId, state, world, ...}
 *   ctx.pointer                (activate) {world, local, screen} of the gesture
 *   ctx.gesture                (create) {moved, startWorld, rect, endpoint}
 *   ctx.showOverlayPalette(id) mount the canvas-overlay palette for a widget
 *   ctx.enterMode()            take over canvas input with THIS handler's `mode`
 * A handler that needs none of them simply ignores them.
 *
 * ── THE MODE (a sustained takeover) ──────────────────────────────────────────
 * A descriptor in EITHER phase may declare a `mode`. While it is active the host
 * routes gestures to it, App.svelte shows the mode's `hints` in the HintBar scoped
 * to it, and Escape exits. Modes are what make multi-step behaviour expressible
 * without new host code, and there are now two shapes of them:
 *   ACTIVATE  `mode: {label, hints, steps?, onPan?, onPick?, onWheel?, overlay?}` —
 *              a sustained gesture on ONE existing item. Every handler is OPTIONAL
 *              and declaring none is legal: a mode that omits `onPan` and `onPick`
 *              leaves the plain single-pointer drag to the canvas, so the widget
 *              stays selectable and MOVABLE while the mode runs — which is exactly
 *              what interior explore (web/interiorNav.js) wants, since it drives its
 *              interior from the wheel alone (plain wheel pans, Ctrl+wheel zooms,
 *              the canvas's own vocabulary one frame down).
 *                `onPick(ctx, {node, world, local})` is the PICK primitive: the
 *              press is delivered with the widget UNDER it (`node`, null on empty
 *              canvas) and the point in both frames, and the canvas's own
 *              select/drag/band machinery never sees it. It is what an EYEDROPPER
 *              needs — "click a widget and take its reference" — and its first
 *              consumer is bento cell binding (web/bentoBind.js), which reads
 *              `local` on its aim step and `node` on its bind step. A mode
 *              declaring `onPick` OUTRANKS `onPan`: a mode cannot both consume the
 *              press as a pick and open a drag with it.
 *                `onHover(ctx, pick) → changed` and `onHoverLeave() → changed` are
 *              the HOVER half of the pick: same payload, offered on a bare
 *              pointer-move so a mode can PREVIEW what a press would do. Each
 *              returns whether the preview actually changed, and the host repaints
 *              only when it did — a hover that invalidates per pixel is a known
 *              performance defect class, and a mode's candidate normally changes
 *              only when the pointer crosses into a different thing.
 *                `cursors` is one CSS cursor NAME per step (clamped like a step
 *              index, so fewer entries than steps is legal): the pointer states
 *              which question the mode is asking. Every name must have a matching
 *              `.overlay.cursor-<name>` rule in web/app.css — MODE_CURSORS below is
 *              that list, and canvasModes() throws on anything else, so a typo is a
 *              boot failure rather than a mode with a silently default cursor.
 *                `steps` + `overlay(ctx)` are the CREATE mode's own two fields,
 *              usable here unchanged — `canvasModes()` already reads `steps` off
 *              whatever phase declares it, so an activate mode gets per-step
 *              HintBar narration for free, and the host feeds `overlay`'s
 *              `{chains, rects, dots}` through the same channel a creation preview
 *              uses. An activate mode has no `session` (its item already exists),
 *              so `overlay` receives the mode context rather than a session.
 *   CREATE    `mode: {label, steps, hints, finish, begin, step, onHover, onStep,
 *              finalize, overlay}` — a multi-gesture PLACEMENT (web/polygonDraw.js,
 *              web/telescopicRig.js). The step-sequencing contract, and why the
 *              two share this mechanism instead of being two flows, is documented
 *              in web/creationSteps.js.
 * `canvasModes()` walks BOTH phases, so a mode's hints, its per-step narration and
 * its Escape entry are generated from the declaration wherever it lives.
 */

import { BENTO_BIND_HANDLER } from "./bentoBind.js";
import { NAVIGATE_INTERIOR_HANDLER } from "./interiorNav.js";
import { POLYGON_CHAIN_HANDLER } from "./polygonDraw.js";
import { PAINT_PATH_CHAIN_HANDLER } from "./paintPathDraw.js";
import { TELESCOPIC_RIG_HANDLER } from "./telescopicRig.js";

/**
 * The ONE asset property the Inspector's picker auto-open matches today
 * (web/Inspector.svelte: `autoOpen={row.key === "src" && ...}`). A widget
 * declaring any OTHER primary asset would raise the app signal and see no picker,
 * so the mismatch is REPORTED rather than silently doing nothing. Both phases'
 * picker handlers ("asset_picker", "bbox_then_asset") are gated on it. Delete this
 * when that gate reads the plugin's declared property instead of the literal.
 */
const INSPECTOR_AUTO_OPEN_PROP = "src";

/**
 * The CSS cursor names a mode may declare — exactly the set web/app.css ships an
 * `.overlay.cursor-<name>` rule for. Kept HERE, next to the validation that reads
 * it, because the failure it prevents is silent: a name with no rule leaves the
 * default cursor and the mode simply never says what it is. Adding a mode cursor is
 * one rule in app.css and one entry here.
 */
const MODE_CURSORS = Object.freeze(["cell", "alias"]);

/**
 * ACTIVATE: ADD A POINT ON THE OUTLINE where you double-clicked.
 *
 * A plugin opts in with `insertPointAt(state, localX, localY)` — a PURE function
 * returning the list property's new value as `{key, value}` where `key` is the state
 * key to write and `value` the core/lists.js LIST VALUE ({list, active}), or null
 * when there is nothing to insert on. That contract is what keeps this handler
 * widget-agnostic: it owns the GESTURE (where you clicked, selecting, previewing,
 * committing one undo unit) and the widget owns the GEOMETRY (where on its own
 * outline that lands). A future editable path or spline declares the same string and
 * the same hook, and needs nothing here.
 *
 * `ctx.pointer.local` is already the double-click in the widget's own frame (the
 * host inverted it through node.world), so the hook never reasons about rotation.
 *
 * The write goes through setPreview → commitPreview — the standard seam — so the
 * insert is exactly ONE undo unit and is keyframed on the current slide like any
 * other property edit. The companion visibility list is written only when the value
 * actually has one, so inserting into a list that never hid anything does not mint
 * an all-true companion into the document.
 */
const INSERT_POINT_HANDLER = {
  id: "insert_point",
  phase: "activate",
  label: "Add a point",
  /** Pure function. `insertPointAt` IS this handler's content descriptor — a widget
   * that can insert a point on its own outline wants this trigger. migrationPlan-only.
   * @example // claims({insertPointAt: () => null}) → true */
  claims: (plugin) => !!plugin.insertPointAt,
  /** Command. Selects the widget and inserts one point at the clicked position. */
  run(ctx) {
    const { app, plugin, node, pointer } = ctx;
    const inserted = plugin.insertPointAt(node.state, pointer.local.x, pointer.local.y);
    app.selection = node.itemId;
    if (!inserted) return; // no outline to insert on (a 0- or 1-point chain) — nothing to do
    const pairs = [[["items", node.itemId, inserted.key], inserted.value.list]];
    if (inserted.value.active) pairs.push([["items", node.itemId, inserted.activeKey], inserted.value.active]);
    app.setPreview(pairs);
    app.commitPreview();
  },
};

/**
 * ACTIVATE handlers. EVERY widget names its own (`activate: "…"`), so this list is
 * an unordered menu, not a dispatch chain — the order it is written in survives
 * only because `migrationPlan` walks it, and every NEW handler is APPENDED.
 *
 * THE LEGACY CLAIM-BY-TYPE BRIDGES ARE GONE. While the migration was in flight,
 * `handlerFor` fell back to a per-handler predicate so an unmigrated widget still
 * resolved; two of those predicates matched a literal TYPE NAME (`latex`, `text`),
 * which is exactly the canvas if-chain the registry replaced. Now that all ten
 * widgets declare their own activation, resolution is the declaration and NOTHING
 * else: a widget that names no handler HAS no activation, and double-clicking it
 * does nothing — the same as double-clicking a rectangle.
 *
 * `claims(plugin)` SURVIVES with a narrower job, and it is no longer part of
 * resolution. It answers "does this widget's SHAPE mean it wants me?" — the
 * CONTENT descriptor that goes with the handler (`floatingToolbar`,
 * `inlineTextEdit`, `primaryAsset`, `interiorView`). Only `migrationPlan` reads it,
 * and tests/activation_migration_test.js asserts that plan is EMPTY: a widget that
 * ships the content descriptor but forgets the one-line `activate` string fails the
 * suite instead of silently losing its behaviour.
 */
const ACTIVATE_HANDLERS = [
  {
    id: "latex_edit",
    phase: "activate",
    label: "Edit equation",
    /** Pure function. The equation editor has no separate content descriptor — the
     * `code`/source property it edits is the widget's own — so a latex widget is
     * recognised by TYPE and nothing weaker. migrationPlan-only.
     * @example // claims({type: "latex"}) → true */
    claims: (plugin) => plugin.type === "latex",
    /** Command. Opens the WYSIWYG equation editor (a DOM overlay plus canvas
     * suppression — the app-signal + controller pattern, which is why this needs
     * no service beyond `app`). */
    run(ctx) {
      ctx.app.beginLatexEdit(ctx.node.itemId);
    },
  },
  {
    id: "overlay_palette",
    phase: "activate",
    label: "Open widget palette",
    /** Pure function. `floatingToolbar(state)` is the palette's CONTENT, so a
     * widget declaring one wants this handler as its trigger. migrationPlan-only.
     * @example // claims({floatingToolbar: () => ({})}) → true */
    claims: (plugin) => !!plugin.floatingToolbar,
    /** Command. Selects the widget and mounts its canvas-overlay palette. */
    run(ctx) {
      ctx.app.selection = ctx.node.itemId;
      ctx.showOverlayPalette(ctx.node.itemId);
    },
  },
  {
    id: "inline_text_edit",
    phase: "activate",
    label: "Edit text in place",
    /** Pure function. `inlineTextEdit: {property, plain}` names WHICH string the
     * editor binds, so a widget declaring one wants this trigger. migrationPlan-only.
     * @example // claims({inlineTextEdit: {property: "text"}}) → true */
    claims: (plugin) => !!plugin.inlineTextEdit,
    /** Command. Enters the in-place editor in the mode the widget declared. */
    run(ctx) {
      ctx.app.beginTextEdit(ctx.node.itemId, ctx.plugin.inlineTextEdit);
    },
  },
  {
    id: "asset_picker",
    phase: "activate",
    label: "Choose source",
    /** Pure function. `primaryAsset: "src"` names WHICH property the picker fills,
     * so a widget declaring one wants this trigger. migrationPlan-only.
     * @example // claims({primaryAsset: "src"}) → true */
    claims: (plugin) => !!plugin.primaryAsset,
    /**
     * Command. Selects the item and raises the app's pending-asset-pick signal —
     * "double-click a video/image and choose its Source", the media widget's
     * primary edit action.
     *
     * ROUTED THROUGH THE APP LAYER: `app.pendingVideoPickFor` already exists for
     * exactly this (a freshly placed filmstrip pops its picker), the Inspector's
     * AssetField reads it and clears it on pick OR cancel. So this adds no second
     * picker mechanism.
     *
     * KNOWN BOUND (inherited, not introduced): the AssetField only exists while
     * its Inspector category is expanded, so with the category collapsed the
     * signal has no reader and nothing opens.
     */
    run(ctx) {
      if (ctx.plugin.primaryAsset !== INSPECTOR_AUTO_OPEN_PROP) {
        console.error(`Activation "asset_picker": "${ctx.plugin.type}" declares primaryAsset "${ctx.plugin.primaryAsset}", but the Inspector's picker auto-open only matches the "${INSPECTOR_AUTO_OPEN_PROP}" row — no picker will open. Widen web/Inspector.svelte's autoOpen gate to the plugin's declared property.`);
        return;
      }
      ctx.app.selection = ctx.node.itemId;
      ctx.app.pendingVideoPickFor = ctx.node.itemId;
    },
  },
  {
    id: "rich_text_edit",
    phase: "activate",
    label: "Edit text in place",
    /** Pure function. Rich text edits the widget's OWN {runs, paras} value, so like
     * latex there is no separate content descriptor to recognise — only the type.
     * Distinct from `inline_text_edit` because it edits runs with the format
     * toolbar, not one plain string. migrationPlan-only.
     * @example // claims({type: "text"}) → true */
    claims: (plugin) => plugin.type === "text",
    /** Command. Enters the Skia-owned in-place rich-text editor. */
    run(ctx) {
      ctx.app.beginTextEdit(ctx.node.itemId);
    },
  },
  {
    id: "code_modal",
    phase: "activate",
    label: "Edit source in code editor",
    /** Pure function. `codeEditor: {property, language, title}` names WHICH string
     * the reusable Monaco modal edits and in what language, so a widget declaring
     * one wants this trigger (ROUND 2 #32/#33). migrationPlan-only.
     * @example // claims({codeEditor: {property: "definition"}}) → true */
    claims: (plugin) => !!plugin.codeEditor,
    /** Command. Opens the full-screen Monaco editor on the widget's declared code
     * property (app-signal + CodeEditorModal, so it needs no service beyond `app`).
     * Save commits ONE undo unit through app.commitCodeModal. */
    run(ctx) {
      const ce = ctx.plugin.codeEditor;
      ctx.app.openCodeModal(ctx.node.itemId, ce.property, { language: ce.language, title: ce.title });
    },
  },
  NAVIGATE_INTERIOR_HANDLER,
  INSERT_POINT_HANDLER,
  BENTO_BIND_HANDLER,
];

/**
 * CREATE handlers. `placement` — the field arrow-family plugins ALREADY declare —
 * is the creation-phase declaration, so "bbox" and "endpoints" ARE its existing
 * values. A plugin that declares nothing gets "bbox", which has been the default
 * creation gesture since crosshair placement landed.
 *
 * The "bbox"/"endpoints" bodies are the canvas's previous placement branches,
 * moved verbatim: the gesture GEOMETRY (snapping, Shift/Cmd modifiers,
 * click-vs-drag slop) stays in the host, because it is the same for every widget;
 * only what the widget DOES with the finished gesture lives here. "bbox_then_asset"
 * is the first handler that is a MULTI-STEP creation rather than a gesture shape —
 * the phase was built for exactly that, and it arrived as one plugin string.
 */
/**
 * Command. THE box placement: a DRAG places the exact dragged rect; a plain CLICK
 * places the plugin's default size with its PLACEMENT ANCHOR on the click point
 * (default = the box centre; a plugin may override — a click-placed cursor drops
 * its TIP where you point). A named function because "bbox" is not the only
 * handler that places a box: `bbox_then_asset` is this placement plus one more
 * step, and duplicating the anchor arithmetic to get it would be how the two
 * silently drift apart.
 *
 * @param {object} ctx - the create context ({app, plugin, gesture})
 */
function placeByBBox(ctx) {
  const { app, plugin, gesture } = ctx;
  if (gesture.moved) {
    const r = gesture.rect;
    app.addItem({ ...plugin.defaults, x: r.x, y: r.y, w: r.w, h: r.h });
    return;
  }
  app.addItem(anchoredDefaults(plugin, gesture.startWorld));
}

/**
 * Pure function. A plugin's defaults positioned so its PLACEMENT ANCHOR lands on
 * `at` — the item state a point-placement should add.
 *
 * SPLIT OUT OF placeByBBox because a click is no longer the only way to place a
 * widget at a point: DROPPING a `*.plugin.js` asset from the Asset Explorer onto
 * the canvas does the same thing, and the user's ruling for it is explicit — "If I
 * drag and drop a widget plugin onto the canvas, it should add the widget… from the
 * asset library". A drop has a point but no gesture, so it cannot call placeByBBox;
 * duplicating these two lines to serve it is exactly how a click-placed cursor and
 * a drop-placed cursor end up landing in different spots.
 *
 * THE ANCHOR IS THE WIDGET'S BUSINESS, DEFAULTING TO THE CENTRE. Most widgets want
 * their box centred on the point; a widget whose meaningful point is elsewhere
 * declares `placementAnchor` (plugins/demo/cursor.js returns its TIP, so a
 * click- or drop-placed cursor points AT where you pointed rather than hanging
 * half a box away from it).
 *
 * @param {object} plugin - a registered plugin (reads `defaults` + optional `placementAnchor`)
 * @param {{x: number, y: number}} at - the world point the anchor should land on
 * @returns {object} the item state to add
 *
 * @example
 * // A 100×50 widget with no placementAnchor centres on the point:
 * // anchoredDefaults({defaults: {type: "rect", w: 100, h: 50}}, {x: 200, y: 300})
 * // => {type: "rect", w: 100, h: 50, x: 150, y: 275}
 * @example
 * // A widget declaring its own anchor puts THAT on the point (a cursor's tip):
 * // anchoredDefaults({defaults: {type: "cursor", w: 40, h: 40}, placementAnchor: () => ({x: 6, y: 2})}, {x: 100, y: 100})
 * // => {type: "cursor", w: 40, h: 40, x: 94, y: 98}
 * @example
 * // A widget with no w/h anchors at (0,0), landing its origin on the point:
 * // anchoredDefaults({defaults: {type: "line"}}, {x: 5, y: 7}).x // 5
 */
export function anchoredDefaults(plugin, at) {
  const w = plugin.defaults.w ?? 0, h = plugin.defaults.h ?? 0;
  const pa = plugin.placementAnchor ? plugin.placementAnchor(plugin.defaults) : { x: w / 2, y: h / 2 };
  return { ...plugin.defaults, x: at.x - pa.x, y: at.y - pa.y };
}

const CREATE_HANDLERS = [
  {
    id: "bbox",
    phase: "create",
    label: "Drag a box",
    /** Command. The plain box placement (placeByBBox). */
    place: placeByBBox,
  },
  {
    id: "bbox_then_asset",
    phase: "create",
    label: "Drag a box, then choose a source",
    /**
     * Command. Places the box, then raises the pending-asset-pick signal so the
     * fresh widget immediately asks for its source — "place a filmstrip and pick
     * the video", a TWO-STEP CREATION GESTURE and the first create handler that is
     * not just a gesture shape.
     *
     * THIS USED TO BE A TYPE CHECK IN THE APP: `app.addItem` carried
     * `if (state.type === "filmstrip" && !state.src)`, which fired for EVERY route
     * into addItem — including pasting or duplicating an empty filmstrip, neither
     * of which is a creation gesture and neither of which the comment there
     * claimed to cover (it named the crosshair flow and the "Add Filmstrip"
     * palette command, and that command arms the crosshair, so BOTH were this
     * phase). Declared here it fires for exactly the gesture it describes.
     *
     * The empty-source guard is the removed line's own `!state.src`: a widget
     * whose defaults already carry a source has nothing to ask for.
     */
    place(ctx) {
      placeByBBox(ctx);
      if (ctx.plugin.defaults[INSPECTOR_AUTO_OPEN_PROP]) return;
      // addItem selects what it created (it returns nothing), so this IS the id.
      ctx.app.pendingVideoPickFor = ctx.app.selection;
    },
  },
  {
    id: "endpoints",
    phase: "create",
    label: "Drag a segment",
    /**
     * Command. A DRAG lays from→to along the dragged segment; a plain CLICK
     * places a default-length segment rightward from the point, the length taken
     * from the plugin's own shipped `defaults.to.x − defaults.from.x` (a linked
     * precedent, not an invented constant).
     */
    place(ctx) {
      const { app, plugin, gesture } = ctx;
      if (gesture.moved) {
        app.addItem({ ...plugin.defaults, from: gesture.endpoint.from, to: gesture.endpoint.to });
        return;
      }
      const d = plugin.defaults;
      const len = (d.to?.x ?? 0) - (d.from?.x ?? 0);
      app.addItem({ ...d, from: { x: gesture.startWorld.x, y: gesture.startWorld.y }, to: { x: gesture.startWorld.x + len, y: gesture.startWorld.y } });
    },
  },
  // MULTI-GESTURE creations. Each declares a `mode` with a step list instead of
  // finishing on the first release; the host enters that mode on the crosshair's
  // first press and their `place` does nothing but ask for it (see either file).
  POLYGON_CHAIN_HANDLER,
  PAINT_PATH_CHAIN_HANDLER,
  TELESCOPIC_RIG_HANDLER,
];

/**
 * phase → {declares, fallback, handlers}. `declares` is the plugin field naming
 * the handler; `fallback` is the id used when the field is absent (creation
 * always has a gesture; activation may legitimately have none — a double-clicked
 * rect does nothing).
 */
const PHASES = {
  create: { declares: "placement", fallback: "bbox", handlers: CREATE_HANDLERS },
  activate: { declares: "activate", fallback: null, handlers: ACTIVATE_HANDLERS },
};

/** Pure function. The declared phases.
 * @example phaseNames() // ["create", "activate"] */
export function phaseNames() {
  return Object.keys(PHASES);
}

/** Pure function. The handler ids registered for a phase (discoverability +
 * tests; the materialIds() precedent).
 * @example handlerIds("create").slice(0, 2) // ["bbox", "bbox_then_asset"]
 * @example handlerIds("activate").includes("navigate_interior") // true */
export function handlerIds(phase) {
  return phaseOf(phase).handlers.map((h) => h.id);
}

/**
 * Query. The handler with `id` in WHATEVER phase declares it — the lookup a host
 * performs when it holds a live mode's handler id and nothing else (`app.canvasMode`
 * stores the id, not the phase, because one id means one handler). Throws LOUDLY on
 * an unknown id and on an AMBIGUOUS one: two phases sharing an id would make
 * `app.canvasMode` mean two different things, so it is a registration error, not a
 * resolution to guess at. tests/creation_modes_test.js asserts uniqueness up front
 * so the ambiguous branch is a belt on top of a proven invariant.
 *
 * @param {string} id - a handler id
 * @returns {object} the handler descriptor (its own `phase` field says which phase)
 *
 * @example findHandler("navigate_interior").phase // "activate"
 * @example findHandler("polygon_chain").phase // "create"
 */
export function findHandler(id) {
  const found = phaseNames().flatMap((p) => phaseOf(p).handlers.filter((h) => h.id === id));
  if (found.length === 0)
    throw new Error(`widget_handlers: no handler "${id}" in any phase (${phaseNames().map((p) => `${p}: ${handlerIds(p).join("/")}`).join("; ")}).`);
  if (found.length > 1)
    throw new Error(`widget_handlers: handler id "${id}" is declared in ${found.length} phases (${found.map((h) => h.phase).join(", ")}) — ids must be globally unique, because app.canvasMode stores only the id.`);
  return found[0];
}

/** Pure function. A phase's config, or a LOUD throw on an unknown phase name.
 * @example phaseOf("activate").declares // "activate" */
function phaseOf(phase) {
  const p = PHASES[phase];
  if (!p) throw new Error(`widget_handlers: unknown phase "${phase}" (known: ${Object.keys(PHASES).join(", ")})`);
  return p;
}

/**
 * Query. Resolves a handler id within a phase. Throws LOUDLY on an unknown id —
 * a typo in a plugin's declaration must not silently disable its behaviour (the
 * getMaterial precedent).
 *
 * @param {string} phase - "create" | "activate"
 * @param {string} id - the handler id a plugin declared
 * @returns {object} the handler descriptor
 *
 * @example getHandler("create", "endpoints").label // "Drag a segment"
 */
export function getHandler(phase, id) {
  const p = phaseOf(phase);
  const h = p.handlers.find((x) => x.id === id);
  if (!h) throw new Error(`widget_handlers: unknown "${phase}" handler "${id}" (registered: ${p.handlers.map((x) => x.id).join(", ")}). A plugin declares it as \`${p.declares}: "${id}"\` — fix the string or register the handler.`);
  return h;
}

/**
 * Query. THE resolution a host performs: the handler `plugin` DECLARES for `phase`,
 * or null when it declares none (a double-clicked rectangle does nothing — that is
 * correct, not a failure).
 *
 * The declaration is the whole resolution. There is no capability sniffing and no
 * claim fallback: an unmigrated widget resolves to NOTHING rather than to a
 * plausible guess, and a typo in the string throws instead of silently disabling
 * the behaviour. Creation still has a phase fallback ("bbox"), because a widget
 * being inserted always had a gesture and there is exactly one sensible default.
 *
 * @param {string} phase - "create" | "activate"
 * @param {object} plugin - a widget plugin
 * @returns {object|null}
 *
 * @example handlerFor("create", {type: "arrow", placement: "endpoints"}).id // "endpoints"
 * @example handlerFor("create", {type: "rect"}).id // "bbox" (the phase fallback)
 * @example handlerFor("activate", {type: "image", activate: "asset_picker"}).id // "asset_picker"
 * @example handlerFor("activate", {type: "rect"}) // null
 */
export function handlerFor(phase, plugin) {
  const p = phaseOf(phase);
  const declared = plugin[p.declares] ?? p.fallback;
  return typeof declared === "string" ? getHandler(phase, declared) : null;
}

/**
 * Pure function. Every ACTIVATE handler as `[{handlerId, label}]` — the
 * DOUBLE-CLICK behaviours a widget may declare, and the words for them.
 *
 * THE POINT: this is the ONE table both readers use. A plugin's `activate` string
 * resolves THROUGH this list (handlerFor → getHandler) to the behaviour
 * web/CanvasView.svelte runs, and core/shortcut_entries.js GENERATES the
 * double-click HintBar entries from the same list — exactly the "one table, two
 * readers" construction that fixed the multiresize defect (DRAG_KIND_MODIFIERS) and
 * that `canvasModes()` uses for a mode's inputs. So a new activation cannot have a
 * behaviour without a chip or a chip without a behaviour, and adding one is still
 * one descriptor here plus one string in the plugin.
 *
 * `label` is what the bar SAYS ("Add a point", "Edit equation"). It was already on
 * every descriptor and read by NOTHING — written for a surface that did not exist
 * yet — which is why announcing double-click needed no new wording invented.
 *
 * @returns {{handlerId: string, label: string}[]}
 *
 * @example activations().find((a) => a.handlerId === "insert_point").label // "Add a point"
 * @example activations().map((a) => a.handlerId).includes("latex_edit") // true
 */
export function activations() {
  return phaseOf("activate").handlers.map((h) => ({ handlerId: h.id, label: h.label }));
}

/**
 * Pure function. Every handler in ANY phase that declares a sustained MODE, as
 * `[{handlerId, phase, label, hints, steps, finish, finishGesture}]` — what
 * core/shortcut_entries.js turns into HintBar + dispatch entries scoped to that mode.
 * Reading it off the registry is what makes a new mode arrive with its shortcuts
 * already registered.
 *
 * `steps` is `[]` for an activate mode (a sustained gesture has no sequence) and the
 * declared step list for a creation mode, whose per-step `hint` is what narrates a
 * multi-step placement. `finish` is the mode's own finalize KEY, or null;
 * `finishGesture` is its finalize POINTER GESTURE (a double-click), or null. The two
 * are separate fields because they are delivered by different machinery — the key
 * through the registry's own dispatch, the gesture by CanvasView's dblclick handler,
 * which CONSULTS this declaration rather than finalizing unconditionally. That is
 * what keeps the gesture and its chip from drifting: a mode that does not declare
 * one neither announces nor performs it.
 *
 * @returns {{handlerId: string, phase: string, label: string, hints: object[], steps: object[], finish: object|null, finishGesture: object|null}[]}
 *
 * @example canvasModes().map((m) => m.handlerId) // ["polygon_chain", "telescopic_rig", "navigate_interior"]
 * @example canvasModes().find((m) => m.handlerId === "navigate_interior").hints.length // 3 (wheel pans, Ctrl+wheel zooms, a plain drag still moves the widget)
 * @example canvasModes().find((m) => m.handlerId === "telescopic_rig").steps.length // 2 (drag the source box, then the lens box)
 * @example canvasModes().find((m) => m.handlerId === "telescopic_rig").finishGesture // null (a FIXED-length sequence finalizes itself)
 */
export function canvasModes() {
  return phaseNames().flatMap((phase) =>
    phaseOf(phase).handlers.filter((h) => h.mode).map((h) => ({
      handlerId: h.id,
      phase,
      label: h.mode.label,
      hints: h.mode.hints,
      steps: h.mode.steps ?? [],
      cursors: validatedModeCursors(h.id, h.mode.cursors),
      finish: h.mode.finish ?? null,
      finishGesture: h.mode.finishGesture ?? null,
    })));
}

/**
 * Pure function. A mode's declared `cursors`, or [] when it declares none — throwing
 * LOUDLY on a name web/app.css has no rule for. This is called from canvasModes(),
 * which App.svelte runs at BOOT to build the shortcut entries, so a typo'd cursor
 * fails the app rather than producing a mode whose pointer silently says nothing
 * (the getMaterial / getHandler precedent: an unknown declared name throws).
 *
 * @param {string} handlerId - the declaring handler (named in the throw)
 * @param {string[]|undefined} cursors - one CSS cursor name per step
 * @returns {string[]}
 *
 * @example validatedModeCursors("x", undefined) // []
 * @example validatedModeCursors("x", ["cell", "alias"]) // ["cell", "alias"]
 * @example // validatedModeCursors("x", ["eyedropper"]) throws: no .overlay.cursor-eyedropper rule
 */
export function validatedModeCursors(handlerId, cursors) {
  if (cursors === undefined) return [];
  if (!Array.isArray(cursors) || cursors.length === 0)
    throw new Error(`canvas mode "${handlerId}": \`cursors\` must be a non-empty array of CSS cursor names, one per step (got ${JSON.stringify(cursors)}). Omit it entirely for a mode that keeps the default pointer.`);
  for (const name of cursors)
    if (!MODE_CURSORS.includes(name))
      throw new Error(`canvas mode "${handlerId}": cursor "${name}" has no \`.overlay.cursor-${name}\` rule in web/app.css, so the pointer would silently stay default (known: ${MODE_CURSORS.join(", ")}). Add the rule AND the MODE_CURSORS entry together.`);
  return cursors;
}

/**
 * Query. Every plugin whose SHAPE asks for a handler it never named, as
 * `[{type, phase, handlerId, edit}]` — each row carrying the ONE-LINE plugin edit
 * that fixes it. Read off the registry rather than maintained by hand, so it
 * cannot go stale.
 *
 * THIS IS NOW THE GATE, not a bridge. During the migration a row meant "this
 * widget still resolves through a legacy claim"; the claims are gone, so a row
 * means "this widget ships the content descriptor (`primaryAsset`,
 * `inlineTextEdit`, `floatingToolbar`, `interiorView`) but declares no handler, so
 * its behaviour is silently absent". tests/activation_migration_test.js asserts the
 * list is EMPTY over every registered plugin — which is what makes forgetting the
 * one-line string a test failure instead of a widget that quietly does nothing when
 * you double-click it.
 *
 * A query and not a console report because the assertion belongs in the suite: the
 * app must not spend a boot line on a condition the tests already forbid.
 *
 * @param {object[]} plugins - every registered plugin
 * @returns {{type: string, phase: string, handlerId: string, edit: string}[]}
 */
export function migrationPlan(plugins) {
  const rows = [];
  for (const phase of phaseNames()) {
    const p = phaseOf(phase);
    for (const plugin of plugins) {
      if (typeof (plugin[p.declares] ?? p.fallback) === "string") continue; // already declared (or phase-defaulted)
      const h = p.handlers.find((x) => x.claims?.(plugin));
      if (h) rows.push({ type: plugin.type, phase, handlerId: h.id, edit: `${p.declares}: "${h.id}"` });
    }
  }
  return rows;
}
