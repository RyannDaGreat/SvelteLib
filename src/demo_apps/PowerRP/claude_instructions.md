# PowerRP — In-Repo Manifest (Materials & Stroke UX Round)

> **Provenance:** PowerRP's historical institutional memory lives in the PowerRP
> dump's `claude_instructions.md` + `concerns.md` on the Linux container (this
> repo's `CLAUDE.md` cites it, e.g. `claude_instructions.md:4612`). That file is
> NOT reachable from this Mac, so this in-repo manifest was created 2026-07-28 to
> record the user's Materials-UX requirements round. It rides the git repo and is
> the authority for the requirements below. If/when the container manifest is
> reachable again, merge this into it (semantic merge, keep both histories).

## What this round is

The materials epic landed (commits f151f84…83774e2): 13 fill materials on any
shape, 5 stroke materials, gradient handles, the paint path widget, a 23-archetype
procedural brush. The user then reviewed it live and issued the requirements
below. **They are corrections and completions, not new ideas — several restate
standing house rules that the implementation violated.** Grind them one by one;
each is DONE only when live-verified (browser probe or vision check), not when
code exists.

## Glossary

- **Material** — a registry entry that paints a region (fill) or outline (stroke):
  fill materials in `render_gpu/skia/materials.js`, stroke materials in
  `render_gpu/skia/stroke_materials.js`. A *paint* `{type:"material", material:{id,
  params}}` stores knobs SPARSELY (nothing until written).
- **Knob** — one row of a material's `fillParams`/`strokeParams` schema
  (customProps-row shape), rendered by `web/PaintField.svelte`'s Mat mode.
- **Scrub** — how much one DRAG-PIXEL changes a numeric field. THE user-stated
  law: one on-screen pixel = one increment, and a comfortable drag is ~100–200 px,
  so a 0..1 knob wants scrub ≈0.01 or finer. `step` (arrow keys/grid) is separate.
- **Live preview** — value changes render on canvas DURING the gesture
  (previewDelta), committing ONE undo unit on release. ColorField is the exemplar.
- **Hover preview** — merely hovering an option (font, brush, preset, dropdown
  entry) previews it live; leaving reverts. FontPicker is the exemplar/trope.
- **Procedural brush** — the landed drawAtlas stamp brush (`brush_strokes.js`,
  23 archetypes, no assets). The user LIKES it; it stays, as its own kind.
- **Texture brush** — the brush the user ORIGINALLY asked for and did not get:
  rp's interactive Skia paint demo (`rp/misc/skia_trail_interactive_paint_demo.py`)
  — a TEXTURE IMAGE swept along the stroke as a ribbon mesh
  (`rp.skia_draw_trail`), chosen from a thumbnail PALETTE of real brush-stroke
  textures (the demo's `TEXTURE_URLS`).
- **skia_draw_trail** — rp's ribbon renderer (in `rp/r.py`): contour + texture →
  triangle-mesh sweep with per-vertex `inner_radius`/`outer_radius` (taper +
  wobble), `v_subdivs` rows across the thickness (mesh capped at 2^16 vertices),
  mipmap + bilinear sampling, Skia blend mode.
- **Trim** — strokeStart/strokeEnd as positions along the outline (draw-on
  animation); **phase** — rotating where position 0 sits on a CLOSED outline.
- **Ghost precedent** — list elements are hidden/disabled and grayed, never
  purged implicitly (`core/lists.js` active-list pattern).
- **Dynamic tools binding** — the Tools-area preset panel must be computed from
  the SELECTED WIDGET'S CURRENT materials, not from its widget type.
- **Manifest / Concerns** — this file / `concerns.md` (append-only history of
  mistakes + progress). "Manifest that" = record it here.

## THE REQUIREMENTS (user round, 2026-07-28 — verbatim spirit, numbered for grinding)

### A. Inspector structure
1. **Material sections, not "Formatting".** Fill material and stroke material get
   their OWN collapsible sections in the Inspector (dropdown/accordion), replacing
   the current jam-everything-under-formatting layout. Material knob lists MUST be
   collapsible — CRT's 23 knobs are the proof case.

### B. Numeric knob behavior (house-rule violations to fix)
2. **No arbitrary clamps.** Knobs like jitter must not carry invented min/max
   bounds — only physically meaningful ones (spacing > 0 is physical; jitter max
   2 is arbitrary). This violated a core principle.
3. **Fine scrub.** Material knobs increment ~0.01 (often smaller), never 1/px for
   fractional domains. One drag-pixel = one increment; a full drag ≈100–200 px
   must sweep the useful domain. An agent-audit of EVERY 1/px slider in the app
   is running (`.frenzy/slider_audit/REPORT.md`); fix from that report.
4. **Live preview on ALL sliders.** Material knobs (and any other laggard found)
   must update the canvas in REAL TIME mid-drag, like ColorField and most other
   sliders already do — preview during gesture, one undo unit on settle. The
   current Mat rows only commit on release. (User said this three times.)
5. **Hover preview everywhere in materials.** Hovering a brush archetype, a
   material in the dropdown, or a preset previews it live (FontPicker trope).
   Applies across ALL material UIs.

### C. The texture brush (the original ask, now precisely located)
6. **Build the texture brush from rp.** Source of truth:
   `rp/misc/skia_trail_interactive_paint_demo.py` + `rp.skia_draw_trail` in
   `rp/r.py`. Texture ribbon swept along the stroke; thumbnail palette of the
   demo's `TEXTURE_URLS` (30× onlygfx watercolor banners, 49× onlygfx
   paint-brush-strokes, + extras). Standing earlier ruling: "top 23 paint
   strokes… save those into the repo if they're not too big, or reference them
   by URL." The landed procedural brush STAYS as a separate kind.
7. **Brush palette UI** — pick from thumbnails (the demo's sidebar), not a bare
   name dropdown.
8. **Color jitter with chooseable jitter color** in the brush knobs.
9. **Real-world brush presets** — research presets people actually built for
   real vector editors; ship meaningful named presets emulating them.

### D. Presets / Tools area
10. **Dynamic preset binding.** Tools-area presets vanished for material-ized
    shapes because tools bind statically to widget type. Bind DYNAMICALLY to the
    selected widget's current fill/stroke material and offer that material's
    presets (e.g. shape with brush stroke → brush presets in Tools).
11. **Preset dropdown named for the SPECIFIC material** — "Sky material presets",
    not generic "fill material presets".

### E. Stroke framework options (general, not per-material)
12. **Cut-stroke on/off** — a toggle for stroke cutting/trimming. *(Ambiguity
    flagged to user: interpreted as the enable switch for trim below.)*
13. **strokeStart / strokeEnd as positions** on strokes generally — animatable,
    so drawing-on any stroked shape is a keyframe.
14. **strokePhase** for closed outlines — where position 0 sits; meaningful when
    start≠end, and ALSO for dashes/dots (where the pattern starts and where it
    collapses on a closed polygon).
15. **Begin/end caps: flat / round / taper.** Dashes has caps; widthProfile has
    none; unify caps as general stroke options (the rp demo's size-start/size-end
    taper is prior art).

### F. Paint path editing UX
16. **Ghost lines to curve handles** — thin dashed line linking each curve handle
    to its anchor; right now you can't tell what belongs to what.
17. **Distinct handle shapes** — curve handles are NOT default squares; use e.g.
    triangles. Handles may be non-default; show whatever geometry best
    communicates the spline type (catmull → its natural construction).
18. **Context menu on clicking a point.**
19. **Line stays a line** — a point inserted as a line, click-dragged right after
    creation, must not sprout curve handles.
20. **Floating toolbar curve toggle** — the "one selected" toolbar gains a
    checkbox/toggle making the selected point(s) curves or not (enabling their
    handle/"derivative" state).
21. **Gray non-curve handle fields** — in properties, a non-curve point's handle
    fields gray out (ghost precedent: disable, never purge).

### G. Individual stroke materials
22. **Wavy: separate random from sine.** A seed only makes sense if there is a
    random component — expose it separately from the deterministic sine
    (frequency/amplitude), and give more options generally.
23. **Dash-dot builder.** Replace the dash/dot/dash-dot dropdown with a
    CONTINUOUS parameterization (dash density, dot density, etc.) + PRESETS
    reproducing the old options (preset-type pattern).

### H. Fill materials
24. **Liquid glass must be selectable as a fill material.** The glass backdrop
    material never opted into `fillParams`; opt it in like the other 13.

### I. App-wide slider audit
25. **Audit every 1/px slider** (agent running → `.frenzy/slider_audit/REPORT.md`)
    and fix every knob whose domain is fractional. Bias to very small scrubs.

## ROUND 2 (user live-review of round 1, 2026-07-28 — numbered continuing)

26. **REDO of A.1 — the shipped version was WRONG.** User verbatim: "Why is fill
    material still under formatting? ... they need to be their own separate
    drop-down. I said this like 25 times!" Fill Material and Stroke Material are
    their OWN TOP-LEVEL Inspector sections (peers of POSITIONING), not a
    collapsible inside the Formatting rows. Round 1 delivered a sub-fold inside
    the Fill/Stroke row — a misread of "sections".
27. **Shape-conforming materials — A STANDING CODEBASE RULE** (user, repeated
    with emphasis): "If there's a material, things should generally conform to
    their shape." Corkboard is "always a square even when I give it a gear";
    liquid glass "is currently pretending that it's a square even though I gave
    it a gear shape"; CRT named too. Every future material must declare how it
    conforms (or why it is shape-independent, like sky/comic). Glass on a gear must follow the GEAR — it
    currently reads as its own squircle/rect geometry with the clip merely
    cutting it. Same concern: CRT, corkboard, "all these materials". Audit
    metaballs ("not sure it's really a true material"). EXEMPT by user ruling:
    sky (infinite texture), lens flare (accepted), comic (homogeneous),
    mandelbrot (done nicely). Framework capability: edge effects follow the
    actual silhouette (e.g. a silhouette-SDF sampler for the shader).
28. **SearchableDropdown (SvelteLib)** inheriting from Dropdown: trigger →
    search box → options; DEFAULT plain fuzzy matching, pluggable custom
    sorting/fuzzy algorithms, bold/highlight matched characters. Own agent.
29. **Sweep all dropdowns**: everything conceivably large becomes searchable
    (material picker, object select, widget/Add menus, textures, fonts...);
    small ones stay; blend mode may stay (its sections are liked).
30. **Scroll updates hover**: scrolling a list under a stationary mouse must
    re-hover/preview the item under the cursor (re-hit-test on scroll — scroll
    does not fire mousemove).
31. **No clipped menus**: an open dropdown near the pane bottom is cut off by
    the pane (screenshot on record). Open menus float above everything —
    portal/fixed or maximum z while open.

32. **Code-editor MODAL for mermaid**: double-clicking a mermaid diagram opens a
    90%-width × 90%-height modal containing a VS-Code-style editor — syntax
    highlighting, multi-line editing, autocomplete, minimap, "full VS Code
    stuff" (Monaco). Own agent.
33. **The modal is REUSABLE for anything code-like**: any component where the
    user enters lots of code (LaTeX source, expressions/code-ish widgets — sweep
    for them) opens the SAME modal component, parameterized by language.

34. **Mermaid demo presets in the Tools area**: a "Demo presets" dropdown for
    the mermaid widget, populated from mermaid's OWN website examples
    (flowchart, sequence, gantt, class, state, ER, pie, mindmap, timeline, git
    graph, ...). Grabbed from the official docs, each preset writes the diagram
    source; rendered + verified.

35. **A CODE BUTTON on the mermaid source row** (discoverability): the
    definition text is a MULTI-LINE CODE PROPERTY in the Inspector with a code
    button beside it that opens the same modal — users must not need to know
    the double-click. Generalize as a `code` row kind where natural.

## Verification strategy

- UI structure/behavior items (1, 4, 5, 7, 10, 11, 16–21): extend
  `tests/material_paint_ui_probe.js` or sibling editor-mounting probes — the
  ?cli=1 render probes CANNOT see any of this (proven: a broken PaintField
  passed 88 suites).
- Render items (6, 13–15, 22–24): matrix probes (`material_fill_probe.js`,
  `stroke_material_probe.js`) auto-grow from the registries; extend with
  trim/phase/cap cells. Texture brush needs asset plumbing in probes (URL cache
  or repo assets).
- Scrub/clamp items (2, 3, 25): fix from the audit report; pin with a node test
  reading the schemas (no browser needed for declarations).
- Puppeteer + Svelte 5: NEVER return doc/state objects raw from page.evaluate —
  JSON.stringify in page, parse node-side (see material_paint_ui_probe.js).

## Portability / WOM

Everything stays inside this repo (dump-portable, relative paths). Texture-brush
assets: small selected textures may be committed; the full palette referenced by
URL with a download-to-cache step (rp precedent: `download_urls_to_cache`) that
degrades LOUDLY offline, never silently. rp itself is a python-side reference
only — the editor must NOT depend on python at runtime.

## Backburner

(empty — items graduate here only when the user says so)
