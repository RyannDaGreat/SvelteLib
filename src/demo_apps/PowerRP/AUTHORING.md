# Authoring PowerRP decks — a guide for Claude

**This file ships with the app.** It lives in the repo beside the code, and the
desktop build vendors the whole repo into the bundle
(`Contents/Resources/repo/src/demo_apps/PowerRP/AUTHORING.md`), so whatever
install you are looking at, this copy is the one that matches the code you are
about to write against. Its file-path citations, the widget roster and the
permission policy below are all checked by a test
(`tests/authoring_doc_test.js`) precisely so this guide cannot rot silently while
the code moves under it.

**All paths in this document are relative to `src/demo_apps/PowerRP/`.**

**Who this is for.** You are an AI assistant, and someone has asked you to build
a presentation, a figure, or a diagram in PowerRP. This document assumes you know
nothing about the app. Read the whole thing once before you write anything; it is
short enough, and the model of the document is unusual enough, that skimming will
cost you more time than reading.

---

## Glossary

Read this first. Several of these words mean something specific here and
something else everywhere else.

| Term | Meaning in PowerRP |
| --- | --- |
| **document** | The whole deck, as one JSON value: `{meta, slides}`. There is no separate item table — see **delta**. |
| **slide** | One entry in `doc.slides`. Carries an `id`, a `name`, a `transition`, and a **delta**. A slide is *not* a container of items. |
| **delta** | A patch of property changes that a slide applies. Slide 0's delta *creates* everything. Later slides only record what *changes*. |
| **fold** | Applying slide deltas in order, 0..N, to get the state at slide N. `fold(doc, N) → {items, vars}`. This is how a slide's content is computed; nothing is stored per-slide except the change. |
| **item** | One thing on the canvas (a rectangle, some text, a chart). Lives in the folded state under a permanent id. |
| **widget** | The *kind* of an item — its `type`. Implemented by a **plugin**. |
| **plugin** | A declarative object describing a widget type: its defaults, its Inspector rows, and its `emit()` function. One per file in `plugins/`. |
| **plugin asset** | A plugin delivered as a *file inside a project's assets folder*, named `*.plugin.js`, instead of as a source file. This is how you add a custom widget without rebuilding the app. |
| **emit** | The plugin function that turns item state into drawing commands. `emit(state) → [ops]`. Pure. |
| **display list** / **IR** | The device-independent array of drawing commands `emit` returns (`rect`, `path`, `text`, …). Rendered identically by the GPU, PDF and SVG backends. |
| **camera** | A mandatory, undeletable item (exactly one per document) that owns the background colour and the view. |
| **anchor** | A named point on an item's box (`tl`, `cm`, `br`, …) that equations can reference. |
| **equation** | A property whose value is a *string* where a *number* was expected. Evaluated at derive time; can read other items, anchors and variables. |
| **slug** | The lower_snake_case display name of an item, derived from its `name`, used to reference it in equations you type. |
| **property state** | State computable from `[[slide, alpha]]` alone, with no history. The default and the overwhelming majority of the app. |
| **recordable state** | State that additionally depends on elapsed presentation time `t`, read through one sanctioned clock seam. |
| **alpha** | A slide transition's progress, 0..1. `alpha` partially applies a delta, which is what makes transitions tween. |
| **purge vs delete** | *Delete* keyframes `active: false` (the item still exists on earlier slides). *Purge* actually removes it from the document. |
| **repair** | `repairedDocument(doc, registry)` — the loud validator every document passes through on load. Zero reports is the bar for anything you author. |

---

## 1. The core invariant

Everything below follows from one line:

```
RenderTree = pure(document, [[slide, alpha]])
```

A rendered frame is a **pure function** of the document and a position in it.
Nothing else. No history, no wall clock, no network, no host state. If you
internalise only one thing from this guide, internalise this, because every
restriction further down is a consequence of it, and every restriction has teeth
— the app can render a deck headlessly on a server, shard a video export so that
frame 200 renders on a different machine than frame 199, and produce a
byte-identical still from the command line. All three break the moment a frame
depends on something not in the document.

## 2. The document model

A serialized document is:

```json
{
  "meta": { "name": "My Deck", "slideW": 1920, "slideH": 1080, "script": "" },
  "slides": [
    { "id": "…", "name": "Slide 1",
      "transition": {"type": "tween", "seconds": 0.5, "curve": "smooth", "sound": null},
      "delta": { "items": { "<itemId>": { …properties… } } } }
  ]
}
```

The model is defined in `core/document.js`. Read that file's header before you
write a generator.

### There is no item table

This is the part that surprises everyone. **Items are not stored anywhere except
inside slide deltas.** Slide 0's delta *creates* every item by giving it a full
property set. Every later slide's delta records **only what changes**.

To get the state at slide 3, the app *folds*: it starts from `{}`, applies slide
0's delta, then 1's, then 2's, then 3's. Consequences you must plan for:

- **An item you create on slide 0 is on every subsequent slide**, until something
  says otherwise. This is a feature — an item appearing across slides *is* the
  "same object", which is what makes cross-slide animation work at all.
- **To have an item exist on some slides and not others**, set `active: false` in
  the delta of the slides where it should be absent. `active` is a universal
  property that every widget has. Deleting in the editor keyframes `active:
  false`; purging actually removes the item.
- **If you add a slide at the end of a deck, everything from earlier slides is
  still on stage.** A new slide showing one chart needs `active: false` for the
  carried-over items — see the worked example in §9, which does this
  mechanically.

### Tweening

A transition applies a delta *partially*, at `alpha` between 0 and 1. Numbers
lerp from the **current folded value** (start captured lazily, at transition
time); discrete values (strings, booleans, enums) switch at `alpha > 0`. So
animation is authored by *changing a property on the next slide*, not by writing
keyframe curves.

### Ids and names

- Slide ids and item ids are **permanent**. Displayed slide numbers shift when
  you insert; ids do not.
- An item's `name` is for humans and drives its **slug** (`"Bar Chart"` →
  `bar_chart`), which is how equations you type refer to it.
- In the stored JSON, equations reference items by id as `@<itemId>`. In the
  editor UI they display as slugs. Both forms parse, so a generator may write
  either; the editor always saves the `@id` form.

### The camera

Every document has **exactly one** camera item (`plugins/camera.js`,
`capabilities.purgeable: false`). It owns the background colour and the view.
Never create a second one, never deactivate it, never purge it. Do keyframe it —
changing `background` on one slide is a normal, expected edit, and moving the
camera is how you author a pan or zoom.

## 3. Equations and anchors

Any property whose plugin default is a **number** becomes an *equation slot* when
its value is a **string**. That single rule is the whole opt-in mechanism — no
per-plugin annotations. So `x: 100` is a number and `x: "@chart.x + 20"` is an
equation. Defined in `core/expressions.js`.

Grammar (arithmetic over references and calls):

```
expr    := term (("+" | "-") term)*
term    := factor (("*" | "/" | "%") factor)*
factor  := "-" factor | primary ("." ("x"|"y"))?
primary := NUMBER | CALL | REF | "(" expr ")"
```

Reference forms, in the display syntax a user types:

| Form | Means |
| --- | --- |
| `speed` | a document **variable** (bare names are always variables) |
| `chart.x` | another item's evaluated property |
| `chart_bm.y` | an **anchor** coordinate: item `chart`, anchor `bm` |
| `self.anchors.center.x` | this item's own anchor |
| `closest_to_rim(a, b).x` | a computed point, projected to a scalar |

The nine standard anchors (`core/derive.js standardBBoxAnchors`) are `tl tm tr`,
`ml cm mr`, `bl bm br` — top/middle/bottom crossed with left/middle/right, plus
`cm` for centre.

`closest_to_rim` comes in two arities: `closest_to_rim(widget, x, y)` gives the
point on the widget's rim nearest a point, and `closest_to_rim(a, b)` gives the
point on `a`'s rim of the nearest pair between two rims. It is what makes an
arrow between two shapes stay attached as they move. Property paths in equations
are **snake_case** in display form (`end_width`), camelCase in storage
(`endWidth`), and a wrong spelling is a **loud error**, not a silent miss.

### THE DETERMINISM LAW

State this to yourself as a law, because it is enforced, not advised:

> **A frame is a pure function of the document and the slide position. The only
> ambient input any widget or equation may read is the presentation clock `time`,
> and the only randomness available is *seeded*.**

Concretely, inside an equation or a plugin:

- `Date`, `performance`, `window`, `globalThis`, `fetch`, `XMLHttpRequest`,
  `WebSocket`, `process`, `require`, `eval`, `Function`, `import()`, `document`,
  `navigator`, `setTimeout`, `setInterval`, `queueMicrotask` and `Reflect` are
  **blocked**. They resolve to `undefined`, so touching a member throws loudly.
  The blocklist is `BLOCKED_GLOBALS` in `core/expressions.js`.
- `Math` is `SAFE_MATH` — real `Math` **without `random`**. So `Math.random` does
  not exist.
- For animation, read `time` (the presentation clock). This is the one sanctioned
  ambient input, and it is a pure function of the timeline, so it records and
  exports correctly.
- For randomness, use the **seeded** generator: `random(seed)` returns a
  generator function, and the same seed always gives the same sequence. Picking a
  seed once with real randomness and *storing it in the document* is fine and
  normal — the stored seed is property state.
- Never carry state between frames. If frame 200 needs frame 199 to have run,
  sharded export breaks.

If you want the full taxonomy, `CLAUDE.md` in this directory has it: the app
distinguishes **property state** (the default; a function of `[[slide, alpha]]`),
**recordable state** (additionally a function of elapsed `t`, read only through
`render_gpu/particle_clock.js`), and **ephemeral state** (untrackable — the app
deliberately has none). The mechanical test for recordable state is
`Δt = 0 ⟹ unchanged`.

### The project script

`meta.script` is one per-document JavaScript library. Assign to a provided
`exports` object and every property equation in the document can call it:

```js
exports.ease = (t) => t * t * (3 - 2 * t);
```

then `= ease(0.5)` works in any widget. It compiles in the same jail equations
do, so the law above holds unchanged. Implemented in `core/project_script.js`.
Reading `time` or `random` at the script's **top level** is refused (the compile
is memoized, so such a value would freeze forever) — read them inside an exported
function. Built-ins and the equation function library cannot be shadowed; a
colliding export is a loud compile error.

## 4. The widget roster — use these first

Survey of `plugins/`. Prefer one of these before writing your own; see §5 for
when writing your own is the right call. Each is one file, and the file is the
documentation — open it to see its exact knobs.

**Text**

- `plaintext` — Plain Text. A single styled string in a box. The workhorse; use
  this for titles, labels and captions.
- `text` — Text. The rich-text variant (spans, inline styling).
- `codeblock` — Code Block. Syntax-highlighted source, with a language picker.
- `latex` — LaTeX Equation. Rendered by MathJax. *Not* drawable by the bare-node
  CLI still renderer (needs a DOM).
- `number` — Number. A formatted numeric readout; bind it to an equation for a
  live counter.

**Shapes**

- `rect` — Rectangle. Corner radius, stroke, fill, gradients.
- `circle` — Circle.
- `labeled_circle` — Labeled Circle. A disc with a rim and one centred label
  (the numbered callout of a figure).
- `polygon` — Polygon. N-sided regular polygon.
- `shape` — Shape. The parametric shape family (stars, arcs, sectors, …).
- `donut` — Donut. A ring/annulus with an angular sweep.
- `paint_path` — Paint Path. Freehand/brush strokes.
- `ss_frame` — Radial Sweep (`plugins/shapeshifter.js`).
- `paper_peacock` — Paper Peacock. A decorative fan.
- `bento` — Bento Grid. A grid of panels.

**Arrows and lines**

- `line` — Line. Two endpoints.
- `arrow` — Arrow. Two endpoints with a head; bind either endpoint to an anchor
  or to `closest_to_rim` and it stays attached.
- `fancy_arrow` — Fancy Arrow. Tapered/curved body with more head styles.
- `curved_arrow` — Curved Arrow.
- `elbow_arrow` — Elbow Arrow. Right-angled routing.
- `tangent_lines` — Tangent Lines. Lines tangent to two circles.

**Graphs and data**

- `graph_grid` — Graph Grid. The axes/grid substrate.
- `graph_line` — Graph Line. A function plot from an **equation**.
- `graph_bars` — Graph Bars. Bars from an **equation**, with Riemann sums, axis
  scaling, presets and lagged grow-up animation. If your data fits a formula,
  this is a better tool than a custom widget.
- `graph_tick_marks` — Graph Ticks.
- `progress_bar` — Progress Bar.

**Media**

- `image` — Image. A project asset (or URL).
- `video` — Video. A player. Its playback position is *not* document state, so it
  is not reproducible in an export — see `video_scrub` if you need determinism.
- `video_scrub` — Video Scrubber. Frame chosen by tweened state, so it *is*
  deterministic and exports correctly.
- `filmstrip` — Filmstrip. A strip of frames from a video.
- `image_stack` — Image Stack. The same sampled frames as `filmstrip`, piled up
  and fading back. It shares the filmstrip's whole source declaration
  (`core/video_sampling.js`), so retyping between the two keeps the clip, the
  sampled window and every frame time.
- `svg` — SVG. A vector asset, drawn as vectors.
- `iconify` — Iconify Icon. An icon by name from the Iconify set.
- `pdf_page` — PDF Page. One page of a PDF asset.
- `pdf_packet` — PDF Packet. A multi-page spread.
- `qrcode` — QR Code.
- `mermaid` — Mermaid Diagram. Declarative diagrams from Mermaid source.

**Structure and effects**

- `camera` — Camera. Mandatory, one per document (§2).
- `group` — Group. Flat-membership derivation parent; composites as a subtree when
  its effects bundle is active.
- `cropbox` — Crop Box.
- `blur` — Blur Layer.
- `magnifier` — Magnifier.
- `empty` — Empty. A blender-style empty: a full transform (position, rotation, scale) with no geometry, drawn as an axis cross in the editor only and referencable by equations through its `pt` centre anchor and its `plusx`/`minusx`/`plusy`/`minusy` axis tips. The tips are spelled in words because an equation reference has no `+`/`-` — `my_empty.plusx.x` reads, `my_empty.+x.x` does not tokenize at all. Its `Display size` row is ONE number (blender's `empty_display_size`), used as the arm span on both axes. Replaces the retired `anchor_point`, which is migrated to it loudly on load with its `pt` anchor id unchanged.
- `particles` — Particles. A deterministic, seeded emitter (recordable state).
- `clock_analog` / `clock_digital` — Analog / Digital Clock.

**Demo and material widgets** (`plugins/demo/`) are a large extra family —
shaders and effects like `demo_glass`, `demo_crt`, `demo_glitch`,
`demo_lens_flare`, `demo_comic`, `sky`, `corkboard`, `demo_mandelbrot`,
`demo_rainy_window`, `demo_raycast_dither`, `demo_metaballs` (type `sphere`),
`cursor`, `demo_magnify`, `demo_text_type`. Open `plugins/demo/` and look before
assuming an effect does not exist.

Every widget also gets the **universal property bundles** (`core/properties.js`):
`transform` (x/y/w/h/rotation/scale/rotationAnchor), `opacity`, and `effects`
(shadow, inner shadow, bloom, blend mode, soft edges). And a stored `w`/`h` **may
be negative** — that is a flip, resolved in one place, and no plugin ever sees it.

## 5. Custom widgets: you are allowed to write them

Here is the user's ruling on this, verbatim:

> "we need to create instructions for Claude, for Claude that creates
> presentations. It needs to know the lay of the land, and it needs to know that
> it's allowed to create custom widgets if the current widgets are not
> sufficient. It should try to use current widgets, but if it's cleaner to make
> its own, it is welcome to do so. Custom widgets are OK. For example… maybe you
> can make a bar graph that reads some CSV assets, as an example of a demo
> widget."

So: **try the existing widgets first.** If one fits, use it — you get its
Inspector rows, its export parity across all three backends, and its tests for
free. But if composing a picture out of built-ins would be contorted, or if the
thing the user wants is genuinely a new kind of object, **write a custom widget.
That is a supported, first-class path, not a workaround.**

### Plugin assets: how a custom widget ships

A plugin normally lives in `plugins/` — a source file, needing a checkout and a
rebuild. That is closed to you when a user is running an installed or
statically-hosted app. So there is a second delivery route with the *same*
format: a **plugin asset**.

- It is a file named `something.plugin.js` in the project's **assets** folder.
- It registers when the project loads. No build, no deploy.
- It **travels with the project** — the zip round-trip carries `assets/`, so
  whoever the deck is shared with gets the widget too.
- One widget per file. Its `type` must be unique; a collision with a built-in is
  **refused**, not shadowed, so it can never repaint someone else's rectangles.
- Drop one into the Asset Explorer (or drag it in from Finder) to instantiate it.

The loader is `core/plugin_assets.js`. **The template you should start from is
`plugin_assets/plugin_template.plugin.js`** — it is written to be handed to you,
with the whole injected API enumerated in comments. Copy it and edit.

### The shape of the file

A plugin asset's source is a **function body**, not a module. Two consequences:

```js
const R = 8;                     // ordinary statements are fine

return {                         // exactly one return, yielding the plugin
  type: "my_squircle",
  title: "Squircle",
  capabilities: {bbox: true, transform: true, resizable: true},
  defaults: {type: "my_squircle", x: 0, y: 0, w: 100, h: 100, /* … */},
  inspector: [...bundle("transform"), ...props("fill")],
  emit(s) { return [rect({x: 0, y: 0, w: s.w, h: s.h, fill: s.fill})]; },
  anchors: standardBBoxAnchors,
};
```

There are **no `import` statements** and `import()` is refused. Everything you
may use is injected by the host. The authoritative list is `HOST_MODULES` and
`SAFE_BUILTINS` in `core/plugin_assets.js`; the template enumerates them in prose.

The plugin object is exactly the one a file in `plugins/` exports — same fields,
nothing added, nothing withheld. So the widget base class documentation applies
verbatim: **read the docblock at the top of `core/registry.js` before writing
one.** It is the de-facto base class and it defines the protocols (`BOUNDS`,
`NEGATIVE EXTENTS`, `HANDLE CONSTRAINTS`, `LIST PROPERTIES`).

### The jail, and why it is not negotiable

Your plugin runs **in the browser of everyone who opens the deck**, on their
origin, with their cookies. They consented to look at slides, not to run a
stranger's code against their session. So the source is evaluated in a sandbox
(`core/plugin_assets.js`): the host globals in §3's determinism law are all
unreachable, the `Function` constructor is blocked on all four of its intrinsics
(including the async and generator ones, reached via any value's prototype
chain), dynamic `import()` is refused before compilation, prototype reflection is
withheld, and the block travels with your `emit`/`anchors`/`hitTest` hooks so a
deferred escape inside `emit` fails too.

You will not run into this if you write an ordinary widget. A widget *describes a
picture from its own state*; if you find yourself needing the network or a clock,
the thing you are building is probably not a widget.

One capability is deliberately withheld even from a well-behaved asset:
`commands` is **refused**, because a palette command's `run(app)` receives the
live app. A plugin asset declares a widget; it does not drive the editor.

### Coordinates

`emit` works in **local box coordinates**: `(0, 0)` is your widget's top-left and
`(state.w, state.h)` its bottom-right. Position, rotation, scale and flip are
applied by the engine *after* you draw, so you never handle them. Return an array
of display-list ops: `rect`, `ellipse`, `polygon`, `polyline`, `path` (SVG `d`),
`text`. If you declare `bundle("effects")`, wrap your ops in
`applyEffects(ops, state, world, bounds)` and declare `cullMargin:
effectsCullMargin`.

## 6. Tutorial: the CSV bar-graph widget, line by line

The worked example is `plugin_assets/csv_bar_graph.plugin.js`. It is a bar chart
whose numbers come from a **CSV file in the project's assets** rather than from
the widget's own knobs. Read it alongside this section; it is heavily commented
and this walkthrough follows its four numbered parts.

It exists as the tutorial because it is the first plugin asset whose picture
depends on something *outside itself*, which is what a "vibe-coded custom widget"
usually actually is — somebody has a spreadsheet and wants it on a slide.

### Part 1 — pure parsing helpers

The file opens with plain pure functions, above the `return`: `parseCsv`,
`parseCsvLine`, `columnIndex`, `csvSeries`. They have no host access, no state,
and doctests. **Put your logic here.** A widget whose geometry is computed by
named pure functions and whose `emit` merely arranges them is the shape to aim
for — it is testable, and the reasoning is separable from the drawing.

Two decisions in this part are worth copying as habits:

- `parseCsvLine` honours **double-quoted fields**, because a label column is
  exactly where `"Portland, OR"` shows up, and a naive `split(",")` silently
  misaligns every value after it.
- `csvSeries` returns `{rows, error}` where exactly one is meaningful. **A row
  whose value is not a number fails the whole chart, naming the row.** The
  tempting alternative — skip it, or plot it as zero — is the silent fallback that
  makes a chart *lie*: a column picked one to the left would render as a full row
  of plausible zero-height bars.

### Part 2 — scaling and layout

`axisSpan`, `barRect`, `barColorFor`, `centeredTextX`, `formatValue`, `errorBox`.
Still pure. `axisSpan` always includes zero, because a bar chart measures length
from a baseline and an axis starting at 9.8 turns a 10-vs-11 difference into a
visual doubling. `barRect` hangs the bar from the **zero line**, so a negative
value draws downward from it.

Note `centeredTextX`: a plugin asset has no DOM, so it **cannot measure text**.
Centring is estimated from a per-glyph advance ratio, deliberately. If you need
text metrics, you need a built-in widget, not an asset.

### Part 3 — the data seam, and the three states

This is the part unique to a data widget. The read is:

```js
const asset = assetText(s.csvUrl);   // {text, status, error}
```

`assetText(url)` (`core/plugin_assets.js`) is **the one way** a plugin asset may
read data from outside its own state: the text of a project asset. It reads through
`render_gpu/gpu/text_asset_registry.js`, and it is handed an ALREADY-RESOLVED url
(`/asset/<Project>/sales.csv`) — a relative `csvUrl` in the widget's state was
turned into that by the derive seam before `emit()` ran (§7), so a plugin never has
to know which form the author wrote.

It is **not** a hole in the jail. `fetch` stays blocked; a plugin cannot name a
URL this does not resolve. What it reaches is the same text the app already served
the browser for an asset *of the project the viewer opened*. It is read-only and
one-way — there is no POST, and nothing can send what it read anywhere.

It is **deterministic**, which is why it is allowed at all: a project asset
travels *with* the document, so its bytes are document state, not host state.
Δt = 0 leaves it byte-identical, and so does re-rendering on another machine.

It returns a **status, never a bare string**, because the three cases a data
widget must distinguish cannot be expressed by one:

| status | what your `emit` must do |
| --- | --- |
| `"ready"` | Draw the chart. |
| `"loading"` | Draw **nothing** this frame. A repaint follows the load (`web/CanvasView.svelte` subscribes to `onTextAssetLoad`), and the headless video worker refuses to write a frame while anything is pending (`web/renderJobPage.js`). |
| `"error"` | Draw a **loud** affordance naming the error. |

That last row is the one that matters, and it is the general rule in this
codebase: **wrong art must never look correct.** A typo'd filename, a missing
column or a column of words where numbers were expected would each otherwise
render as a chart with no bars — which an author reads as "my data is empty" and
then debugs in entirely the wrong place. So the widget draws a red-bordered box
with the message wrapped inside it.

There is one deliberate exception: with **no file chosen yet**, the widget draws
nothing rather than an error. A freshly inserted widget is not broken, it is
unconfigured.

### Part 4 — the knobs and the plugin object

Knobs are declared with `customProps([...])`, which returns `{rows, defaults}`.
Each entry becomes an Inspector row and is keyframable and `=`-bindable for free.
Conventions to follow:

- Use a real `kind` from `ROW_KINDS` (`number`, `angle`, `color`, `boolean`,
  `select`, `asset`, `text`, `action`, list). An invented kind ("toggle", "bool")
  is **rejected at declaration** rather than silently rendering as a text box.
- Every entry needs a `default`, and a `help` string. Write the help for a user
  who has never seen the widget.
- The data binding is the interesting row:

  ```js
  {name: "csvUrl", kind: "asset", assetKinds: ["data"], assetForm: "url", default: "", …}
  ```

  `kind: "asset"` gives you the standard asset field — a picker over the
  project's assets, an upload button, and drag-and-drop from the Asset Explorer
  or from Finder. `assetKinds: ["data"]` filters that picker to CSV/TSV/JSON.
  `assetForm: "url"` makes it write the served path, which is exactly what
  `assetText()` takes.
- Give animation a knob rather than a clock. The `reveal` knob (0..1, how far the
  bars have grown from the baseline) is property state, so keyframing it 0 on one
  slide and 1 on the next produces a grow-in that animates in the editor **and**
  exports correctly. This is the pattern to reach for whenever you want motion.

Then the plugin object itself declares `type`, `title`, `capabilities`,
`defaults` (spreading `bundleNestedDefaults("effects")` and the custom
defaults), `inspector` (spreading `bundle("transform")`, the custom rows,
`props("opacity")`, `bundle("effects")`), `emit`, `localBounds`, `cullMargin` and
`anchors`.

`localBounds` matters more than it looks: it is the **local rect your ink
occupies**, and it is what culling, band-select and the copy/export capture rect
all read. Get it wrong and your widget vanishes when scrolled, or exports with
clipped edges.

### Seeing it work

Slide 5 of the `Imitations` project ("CSV Bar Graph (plugin asset)") is this
widget plotting a `sample_data.csv` in that project's own assets folder. Both the
widget and its data are project assets. `examples/add_csv_chart_slide.mjs` is the
generator that built that slide — it seeds both files out of `plugin_assets/` and
then authors the slide — and it is worth reading as a companion to §9.

## 7. Assets

Project assets live in `projects/<Project>/assets/`. Images, videos, SVGs, PDFs,
fonts, data files (`.csv`, `.tsv`, `.json`) and plugin assets (`*.plugin.js`) all
live there together; the server classifies them by extension
(`server/server.py`). Assets travel with the project in the zip round-trip, which
is what makes a deck portable and a data-driven chart deterministic.

### How to reference one: relative, unless you mean another project

A `src` (or `svgUrl`, or any `kind: "asset"` property) takes one of **two forms**,
and both are first-class forever:

| form | looks like | means |
| --- | --- | --- |
| **relative** — write this | `"clip.mp4"`, `"icons/logo.svg"` | a file in **this project's** assets, whatever the project is called right now |
| **absolute** | `"/asset/Shared/bg.png"` | a file in the **specifically named** project — deliberate cross-project borrowing |

**Write the relative form.** It is shorter, and more importantly it is
*rename-proof*: nothing in the system guarantees a project keeps the name that was
baked into an absolute ref. Save-As changes the folder while every `src` keeps
naming the old one, and importing a `.zip` de-collides (`RobotSim` → `RobotSim 2`)
so the archive lands under a name it was never told. Against a server that never
shows, because the server serves any project's assets to anyone. It shows the
moment there is no server:

> A `RobotSim.zip` dragged onto the **static** site imported its assets and still
> rendered no video — the document said `/asset/Untitled/Video_….mp4` and no
> project called `Untitled` existed in that browser.

A relative ref has no name to be wrong about. Reach for the absolute form only when
you actually mean *that other project's* copy.

```js
{ ...video.defaults, src: "clip.mp4" }                    // this project's — do this
{ ...svg.defaults, svgSource: "url", svgUrl: "icons/logo.svg" }  // nested paths work
{ ...image.defaults, src: "/asset/Shared/bg.png" }        // another project's, on purpose
```

`http(s):`, `data:`, `blob:` and `builtin:` sources are not asset refs and pass
through untouched.

**Existing decks are not migrated.** Every absolute ref keeps working exactly as
written — resolution accepts both forms, and repair rewrites nothing. Only what
*writers* mint changed: the Asset Explorer's copy-path button, the Inspector's
asset picker, drag-and-drop, upload, and the zip export's localization all now
produce the relative form for an own-project asset.

**Resolution happens at one seam.** `core/derive.js` turns a relative ref into
`/asset/<owning project>/<path>` before any plugin's `emit()` runs, so every
consumer — the canvas, the presenter, thumbnails, PNG/PDF/SVG export, the bare-node
CLI and the headless render worker — sees the same resolved string. The grammar
itself is `core/asset_ref.js`. An unresolvable ref fails **loudly** (a named error,
or the missing-asset affordance), never as a silent blank.

## 8. Validating what you author

Do not hand back a deck you have not validated. Two cheap checks catch almost
everything.

### Repair must report nothing

`repairedDocument(doc, registry)` from `core/document.js` is the loud validator
every document passes through on load. It returns `{doc, reports}`. **Require
`reports` to be empty.**

```js
const { doc: repaired, reports } = repairedDocument(doc, registry);
if (reports.length) {
  for (const r of reports) console.error("  -", r);
  process.exit(1);
}
```

A non-empty report means the app had to *change something* to make your document
loadable — a missing property, a legacy field, an item whose type nothing claims.
It is not a warning to skim; it is the difference between a document you wrote and
a document the app rewrote.

Note the **order**: plugin assets must be registered *before* you repair, because
repair drops items whose type nothing claims. Register, then repair.

### Render a still

`cli/render.js` renders one still, in bare Node, with no browser and no Vite:

```
node src/demo_apps/PowerRP/cli/render.js <doc.json> <out.png> \
  [--slide N] [--alpha A] [--width W] [--height H]
```

`--slide` is **0-indexed**. It is fast (~0.1 s for a light 1080p vector slide),
which makes it the right loop for iterating on layout.

Know its bounds, or you will misread its output: running on a software Skia
surface with no GL context and no DOM, it **cannot draw** image, video, PDF or
filmstrip content (no `createImageBitmap`), LaTeX (MathJax needs a DOM), Mermaid,
or motion blur. It **counts these omissions and reports them loudly** — read that
report, because the renderer used to produce holed pictures while exiting 0. It
is *not* the video path; server-side video goes through `cli/render_job.js`, which
drives the real editor in headless Chrome.

A CSV chart *is* drawable by the CLI still renderer, because the text-asset
registry reads `/asset/…` URLs straight off disk synchronously in bare Node.

### The test gate

The repository's definition of "passing" is:

```
node src/demo_apps/PowerRP/tests/run_all.mjs
```

which collects bare-node tests, browser probes, python and shell suites from both
`tests/` and `render_gpu/tests/`. Use `--only=node` or `--filter=<substring>`
while iterating. `--list` is the authority on what exists — never quote a count.

If you add a widget, add a bare-node test for it. `tests/csv_bar_graph_test.js` is
the model: it loads the committed asset **through the real jail**, seeds a fixed
CSV string into the registry with `seedTextAsset`, and pins `emit` against
hand-computed geometry — no filesystem, no network, no golden blob.

## 9. Worked patterns for a generator

The reliable way to author a deck programmatically is a small Node script that
builds the document from the **live registry** and validates before writing.
`examples/add_csv_chart_slide.mjs` is a complete, working instance of everything
below.

### Boot the registry the way the app does

```js
const registry = createRegistry();
registerAll(registry, createCommands());
const { loaded, reports } = registerPluginAssets(registry, [
  { name: "csv_bar_graph.plugin.js", source: readFileSync(`${ASSETS}/csv_bar_graph.plugin.js`, "utf8") },
]);
if (reports.length) throw new Error(`plugin asset refused: ${reports.join("; ")}`);
```

Register plugin assets **before** repairing (see §8).

### Pattern: spread the plugin's defaults

Build every item by spreading the registered plugin's own `defaults`, then
override only what the slide actually authors:

```js
const chart = registry.get("csv_bar_graph");

csvchart: {
  ...chart.defaults,
  name: "CSV Bar Graph",
  x: 260, y: 300, w: 1400, h: 560, z: 20,
  csvUrl: "sample_data.csv",   // relative to THIS project (§7) — rename-proof
  labelColumn: "stage",
  valueColumn: "seconds",
  colorMode: "alternate",
}
```

**This is why the result repairs with zero reports**: a missing property is
impossible when the plugin's defaults are the base. Hand-writing a full property
set instead is how you get repair reports, and it goes stale the moment a widget
gains a knob.

### Pattern: anchor-bound layout

Bind dependent items to the item they belong to, instead of computing absolute
positions twice:

```js
csvcap: {
  ...plaintext.defaults,
  x: "@csvchart.x",            // tracks the chart's left edge
  y: "@csvchart_bm.y + 24",    // 24 units under the chart's bottom-middle anchor
  w: "@csvchart.w",            // matches the chart's width
  h: 44,
  text: "The widget is a project asset; the numbers are a project asset too.",
}
```

Now moving or resizing the chart moves the caption, with nothing to keep in sync
by hand. Prefer this over duplicated literals whenever one item is positioned
*relative to* another — it is also self-documenting about intent.

The same idea drives arrows: bind an endpoint to an anchor, or to
`closest_to_rim(box_a, box_b)`, and the arrow follows both shapes as they move.

### Pattern: read ids out of the document, do not hardcode them

```js
const cameraId = Object.entries(doc.slides[0].delta.items)
  .find(([, v]) => v.type === "camera")[0];
```

### Pattern: clear the stage on a new slide

Deltas fold, so a slide appended to a finished deck still has every earlier item
on stage. Deactivate the carried-over items — and **exempt the camera**, which
owns the view:

```js
const carriedOver = new Set();
for (const slide of doc.slides)
  for (const [id, patch] of Object.entries(slide.delta?.items ?? {}))
    if (patch && id !== cameraId) carriedOver.add(id);
for (const id of carriedOver) if (!(id in items)) items[id] = { active: false };
```

`active: false` keyframes visibility rather than deleting, so the earlier slides
are untouched.

### Pattern: idempotent re-runs

Give your slide a stable id and filter it out before appending, so re-running the
generator updates rather than duplicates:

```js
const SLIDE_ID = "s5csvbar";
doc.slides = doc.slides.filter((s) => s.id !== SLIDE_ID);
```

### Pattern: keep paths relative

Resolve paths relative to your script, never absolutely — this directory is a
portable dump that may be renamed or moved:

```js
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
```

## 10. House rules you are expected to follow

These are the maintainer's standing requirements. They apply to plugin assets and
generator scripts as much as to app source.

- **No silent fallbacks. Ever.** No `try`/`catch` that swallows. If it fails, it
  must fail loudly, naming what failed and where. Silent *success* is fine;
  silent *failure* is never fine. A caught exception must be re-raised or
  reported.
- **No `try`/`catch` to paper over ignorance.** If you do not know why code might
  fail, fix your understanding instead of catching.
- **Wrong art must not look correct.** A broken widget draws a visible error, not
  an empty picture.
- **Docstrings with `@example`.** Every pure function gets one, showing realistic
  input and what it returns — not a trivial null case. Single-line, or 3+ lines
  with nothing after the opening `/**`.
- **Classify your functions** when it is not obvious from the name: pure
  function, near-pure (say why), query (reads external state), command (mutates —
  say what).
- **No magic numbers.** The test: could a reader understand *why* this value
  without reading the surrounding code? `width / 2` is fine; `sleep(1.5)` and
  `if (count > 240)` are not. Name it, at a scope matching its lifetime.
- **CSS uses `--a-*` tokens only.** All app styling lives in `web/app.css` as
  custom properties; app components carry no `<style>` blocks and no bare `px`
  values. This is the annotator convention and it is enforced.
- **Small, well-named, functional code.** Pure helpers that are mathematically
  general and reusable; thin domain-specific glue. The maintainer is a solo
  maintainer keeping this for years.
- **No plugin may import another plugin.** Composition happens through
  capabilities and document state.
- **Do not run git commands.** Leave committing to the person driving the session.

## 11. Reference index

Read these when you need the authoritative answer.

| Question | File |
| --- | --- |
| What can a widget declare? (the base class) | `core/registry.js` — read its docblock first |
| How does the document model work? | `core/document.js` |
| Equations, the jail, `BLOCKED_GLOBALS`, `SAFE_MATH` | `core/expressions.js` |
| The project script (`meta.script`) | `core/project_script.js` |
| Plugin assets: the loader, the jail, `assetText` | `core/plugin_assets.js` |
| **The template to copy for a new widget** | `plugin_assets/plugin_template.plugin.js` |
| The data-driven tutorial widget | `plugin_assets/csv_bar_graph.plugin.js` |
| Other proof assets (pure shapes) | `plugin_assets/superellipse.plugin.js`, `plugin_assets/gear.plugin.js` |
| Inspector rows, bundles, `customProps`, `ROW_KINDS` | `core/properties.js` |
| Anchors, derivation, `standardBBoxAnchors` | `core/derive.js` |
| The display-list IR (drawing ops) | `render_gpu/ir.js` |
| Universal effects (`applyEffects`) | `render_gpu/effects.js` |
| Text/data asset loading | `render_gpu/gpu/text_asset_registry.js` |
| Geometry helpers, negative extents | `core/geometry.js` |
| Parametric outline geometry, triangulation | `core/outline.js` |
| List properties (per-element equations) | `core/lists.js` |
| The presentation clock (recordable state) | `render_gpu/particle_clock.js` |
| CLI still renderer, and its documented bounds | `cli/render.js` |
| Server-side video renderer | `cli/render_job.js`, `web/renderJobPage.js` |
| A complete worked generator | `examples/add_csv_chart_slide.mjs` |
| A model bare-node widget test | `tests/csv_bar_graph_test.js` |
| Plugin-asset jail tests (the escape battery) | `tests/plugin_assets_test.js` |
| The test gate | `tests/run_all.mjs` |
| Asset classification, project API | `server/server.py` |
| Contributor-facing architecture notes | `CLAUDE.md` |
