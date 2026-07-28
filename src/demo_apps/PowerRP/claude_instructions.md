# PowerRP — In-Repo Manifest (Materials & Stroke UX Round)

> **Provenance:** PowerRP's historical institutional memory lives in the PowerRP
> dump's `claude_instructions.md` + `concerns.md` on the Linux container (this
> repo's `CLAUDE.md` cites it, e.g. `claude_instructions.md:4612`). That file is
> NOT reachable from this Mac, so this in-repo manifest was created 2026-07-28 to
> record the user's Materials-UX requirements round. It rides the git repo and is
> the authority for the requirements below. If/when the container manifest is
> reachable again, merge this into it (semantic merge, keep both histories).

## STATUS: ALL 35 ITEMS DELIVERED (2026-07-28)

Round 1 (items 1–25) and Round 2 (items 26–35) are complete, committed
(d2c24b7 … 4ad30d6 on render-rewrite-skia), and gated: doctests 2624/0, node
suite 89/89, and ten browser probes green on this Mac (fill matrix ×14 incl.
glass, stroke matrix ×6 incl. both brushes, texture brush, Mat UI 38/38,
searchable dropdown 20/20, material presets 13/13, paint-path UI 13/13, stroke
trim, code modal 19/19, colorfield 25/25). Per-material shape-conformity
declarations live in the "materials conform" commit (a444a3a). concerns.md
holds the round's full mistake/lesson record.

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

## ROUND 3 (user live narration, 2026-07-28 — after the camera-background freeze fix)

36. **Paste-as-image bug**: copying a gear widget and pasting produced an IMAGE
    widget instead of a widget copy ("I thought we had something in place to
    prevent something silly like that"). The internal widget payload must win
    over the clipboard's image flavor.
37. **Bilinear image sampling option**: images should offer bilinear in addition
    to the current behavior (user believes it is nearest-neighbor — verify the
    premise first).
38. **Searchable-dropdown search styling**: no box around the search input —
    a subtle color difference instead; the command palette's search is the
    suspected in-app precedent ("the same way that the palette is").
39. **Material zoom lag on shapes**: zooming into a material-filled gear
    (metaballs/CRT) is laggy, and past 4096 device px the SDF caps out with a
    conformity fallback report. Cause: the silhouette SDF cache is keyed on
    DEVICE size, so every zoom step is a miss + full-res EDT rebuild. Fix:
    build at a capped resolution and SCALE distances (zoom-invariant cache).

48. **THE GEARS PRESENTATION** (authoring proof, NO CODE): a new presentation
    ("gear emporium") built purely by driving the tool — meshed gears big/small,
    speeds LINKED by property equations (gear ratios), number widgets bound to
    each gear's degrees, a big "GEARS" title slide, camera pans down then
    gear-to-gear while everything spins, cool materials, multi-slide, ~10–20 s,
    rendered to a 720p MP4 through the real render pipeline. Sub-agent may not
    write ANY JavaScript — document JSON + existing tools only.

## ROUND 4 (user live report, 2026-07-28)

51. **Glitch FILL must distort like the glitch WIDGET.** "The digital glitch
    demo widget looks great. Why doesn't the glitch material look great? The
    CRT one distorts just fine, liquid glass works fine." Parity investigation
    + fix; pin widget-vs-fill parity in a probe.
52. **THE WIDGET'S PRESETS DETERMINE THE MATERIAL'S PRESETS** (a rule): every
    demo widget's existing preset set must appear for its material in the Tools
    (mapped through the shared schema); the newly-invented material presets may
    stay as EXTRAS ("you can add them together — I never object to more").
    The missing "sci-fi preset" on glitch material is the proof case.
53. **Liquid glass material has NO presets** — mirror the glass widget's set.

54. **Slide renaming UI**: double-click the slide's title in the navigator to
    rename it inline, plus a Name field in the slide's properties — agents can
    author names in JSON; the user must be able to from the UI.
55. **METAL MATERIALS family** (research first — a SONNET RESEARCH FRENZY, per
    the user): physically-plausible brass/copper/steel/aluminum fills — brushed
    (incl. RADIALLY brushed), shiny, lightly rusted, patina — with darker
    patinaed crevices (the silhouette SDF gives recess distance); plus a
    METAL-STAMP material that engraves/embosses into metal behind it with real
    shading. Lighting stays ANALYTIC like glass (user explicitly rejected HDRI:
    "no HDRI, it's too complicated — regular lighting the way the glass
    components have lighting").
    PRESETS demanded (user, second pass): brass, SHINY CHROME, RUSTY STEEL with
    a rust-spot count/amount knob, silver BEFORE vs AFTER polishing (crusty
    black in the crevices). And THE STAMP-CREVICE COUPLING: "when we stamp, we
    create crevices — take the derivative of this material to figure out where
    the crevices would be when we emboss, because that would result in more
    rust or less rust" — the engrave material's groove depth-field must feed the
    same crevice/patina mask the aging uses, so engraved lines patina first.

56. **Hardware shapes**: metal BOLT, SCREW, and SCREW-HEAD shapes (parameterized
    shapeshifter entries) — hex/thread/slot/Phillips knobs as appropriate.
57. **Victorian ornamental shapes**: the swirly scroll-work of wrought-iron
    fence posts / lamp posts ("swirly doodly shapes") — parameterized HEAVILY
    (scroll turns, curl radii, symmetry, stem length…) in the shape menu, ready
    to take metal materials.
58. **Gears deck v2**: add ornamental metal corner pieces FRAMING the camera on
    all four corners, BOUND to the camera edges by equations (the minimap
    precedent), using the new metal materials + ornament shapes.

59. **strokePhase cycle calibration**: the user expects 360° = one full sweep;
    reports needing "many thousands of degrees" — under empirical investigation
    (the ÷360 seam and trimSegments both check out in isolation).
60. **Gears deck v3**: lens flares + pizzazz ("use ALL the components — make it
    look really fucking cool") AND physically-plausible tooth meshing (zoom on
    the mesh; "I don't think an engineer would approve").

62. **Sophisticated machinery** (user, 2026-07-28, extends 58+60): "Once you
    have all your bolt screws and metal widgets, implement a more sophisticated
    machinery for this gear presentation." The v3 deck is not just re-skinned —
    once items 55–57 land, the composition should read as an actual MACHINE:
    bolted plates, screw heads at joints, meshed gear trains with plausible
    ratios, metal-stamped labels, Victorian scroll framing. Sequenced AFTER
    METALIMPL + ORNAMENT deliver.
61. **THE HINTBAR COMPLETENESS LAW — NOT NEW, THE ORIGINAL LAW** (user
    correction on record: "it's always been there... every single keyboard
    shortcut must always pass through that, and if it doesn't, you fucked
    up"). The codebase's own constitution says it (CLAUDE.md: the shortcut
    registry "BOTH dispatches keydowns AND feeds the bottom HintBar — a
    shortcut that isn't registered there does not exist"); the sweep test's
    accumulated LOCAL-allowlist entries are DRIFT from that precedent, not a
    doctrine. Every focused-field convention (Enter commit, Esc cancel,
    arrows…) must surface CONTEXTUALLY in the HintBar while applicable — the
    fieldFocus chip mechanism is the established vehicle; audit every LOCAL
    entry and every key handler as a VIOLATION to migrate.

## ROUND 5 (user, 2026-07-28): THE GRAPH FAMILY + EQUATION ZOO

63. **graphLine — the parameterized polygon widget**: "probably inherit from
    the polygon widget, except... instead of having a list of parameters for
    each point, it will be tStart, tEnd, number of points, interpolate between
    those." A parametric curve: sample an equation over [tStart, tEnd] at N
    points → polyline. Used for "graphs and different functions like sine
    waves and stuff that can wiggle and swiggle around the whole screen."
    NOTE: plugins may not import plugins — "inherit" means shared core helpers
    + the same capability bundles, not a literal import of polygon.

64. **Equation editor inside graphLine**: text entry AND the Monaco code modal
    (the mermaid widget's code-button pattern — user: "you just research
    mermaid, which has the code editor inside of it") "so that I can edit the
    JavaScript of it with arbitrary JavaScript functions." Presets: "some
    basic, like x times t, and others might be functions that require for
    loops or iterators, like Fibonacci of round of time." MUST stay
    deterministic (three-kinds law): no Date/Math.random/wall clock — same
    sandbox discipline as core/expressions.js; `time` (particleTime) allowed
    (recordable). A for-loop integrating 0→t each call is FINE (pure fn of t,
    seekable); carrying state frame-to-frame is NOT.

65. **THE graph* FAMILY NAMING RULE**: "All these widgets that are graph-like
    will be prefixed with graph — like graphLine, graphTickMarks, graphGrid,
    etc. That is a family of widgets."

66. **graphRuler / ticks / grid**: "a ruler widget that measures tick points
    like 0 1 2 3 4 5 on either the x, the y or both axes, that has optional
    grid options, very much like Matplotlib. Make sure you do tons of research
    to figure out all the different components and options... I want to be the
    maximalist here, tons of options so we can potentially even zoom and pan
    in it later" — but for now parameterized by equations/properties only.
    Grid must be able to "snake into existence" — draw the columns and rows in
    3Blue1Brown/Manim style (staggered draw-in; the stroke trim framework is
    the obvious mechanism).

67. **Per-widget custom variables (REFACTOR)**: "we're going to need to expose
    widget custom variables... custom variables on a per-object basis so that
    I can interpolate between them" — e.g. tween a spiral's own named
    parameters to morph logarithmic → Archimedean. The global custom-variables
    section "kind of defeated the whole point... we may need to refactor the
    whole thing." Per-item vars are PROPERTY STATE (keyframed via deltas like
    any property); expressions likely address them as self-scoped refs.

68. **THE EQUATIONS DEMO PRESENTATION ("equation zoo")**: a new demo deck
    demonstrating ALL of the above. "Teach me about math in this" — per-slide
    demos of different equations (how do you make a heart, how do you make a
    spiral, logarithmic vs another spiral), LaTeX of each equation popping up
    as it's drawn. Includes the spiral-interpolation demo (log ↔ Archimedean
    via per-widget vars). QUALITY BAR, verbatim: "if they don't look
    professional and they don't look like Manim and they don't look pretty, I
    don't care — do it over again. Do it over until it fucking looks right...
    it has to look beautiful and impressive. And correct, of course."

69. **THE CATENARY BALL — the big equation demo**: title "Catenary Curve" with
    fancy glow; the curve "drawn in from existence because we increase from t,
    like on a chalkboard"; then a textured glowy ball/orb (texture visible so
    rotation reads) ROLLS DOWN the catenary with CORRECT math: the ball's
    BOTTOM touches the curve (center offset R along the normal), rolling
    without slipping (spin = arcLength/R), and correct acceleration
    ("the acceleration of it is correct too, because you can parameterize that
    using equations") — for a rolling solid sphere a = (5/7)·g·sinθ along the
    tangent; catenary has closed-form arc length s = a·sinh(x/a).

70. **THE PRESETS MANTRA — STANDING RULE, all widgets forever** (user,
    verbatim): "For every single thing that has tons of controls, we need tons
    of presets. That's a general old mantra... probably at least 10 unique
    presets for each one. Presets give me inspiration." And the METHOD is
    specified too: "to get these unique presets, you need to come at the
    project from many different angles — you can have mini Sonnet frenzies for
    every single one of these widgets to give presets for them." So: every
    knob-rich widget ships ≥10 genuinely distinct presets, authored via a
    small diversified Sonnet frenzy (different aesthetic/mathematical angles),
    not one agent's taste. Applies to the whole graph family, the metal
    family, ornaments — everything with tons of controls, retroactively and
    going forward.

71. **graphBars — programmatic bar graph widget**: "bar graph widgets...
    programmatic — program the number of bars and like the area under the
    curve and stuff, so we can animate all the bars going up, very
    Manim-like." Bar count N + an equation valuing each bar (e.g. f(x) sampled
    per bar → Riemann-sum look, "area under the curve"); heights animatable
    (grow-up entrance via tweened properties); Manim bar-chart aesthetics.
    Part of the graph* family and subject to the presets mantra (70).

72. **UNIFY VIDEO PLAYER AND SCRUBBER via `time`** (user, 2026-07-28): "we
    shouldn't have any distinction between video scrubber and regular videos
    anymore if we can help it... a scrubber with the time just being the time
    variable modulo self.length should be equivalent, right?" In principle
    YES — a scrubber whose currentTime equation is `time % self.length` IS a
    playing video, and unlike the player it is recordable/deterministic (the
    player deliberately rides the browser's own playback clock and is the one
    non-reproducible widget; server.py already warns about it and points at
    the scrubber). Known gaps to close before the player can be retired:
    (a) `self.length` — the video's duration must be exposed to expressions
    (it currently is not document state); (b) AUDIO — the native player plays
    sound, a seek-driven scrubber does not; decide presenter-mode audio story
    or accept silence; (c) live-playback smoothness — per-frame decoder
    seeking vs native decode, must be measured in the presenter. Investigation
    agent dispatched; implementation after findings.
    SCOPE RULING (user, same day): "This is experimental right now. Do it as
    a video player scrubber DEMO WIDGET. It's just a video scrubber with some
    fancy presets that makes it dependent on time." So: do NOT retire or
    modify the player; ship a new plugins/demo/ widget = scrubber whose
    current-time carries time-driven equation presets ("Loop" = time %
    self.length, ping-pong, half/double speed, reverse, stutter/freeze-frame
    …, ≥10 per the presets mantra). self.length exposure is still required
    for the Loop preset to be writable.

### Round 5 research findings (frenzy digests — the manifest copy is canonical;
### .frenzy/graph_family/*.md are the full reports and are disposable)

**01 matplotlib/Manim axis options** (for graphRuler, item 66): knob schema
delivered in PowerRP's real ROW_KINDS vocabulary, tiered A/B/C. Structure to
mirror Manim: shared axis_config + per-axis override. v1 excludes zoom/pan,
date axes, 3D, twin axes. LOAD-BEARING TRAPS: tick labels must be generated as
integer-index × rational-step (NEVER accumulated addition — the
0.30000000000000004 bug); MaxNLocator's "nice" step set is [1, 2, 2.5, 5, 10];
minor-tick subdivision is 4-vs-5 depending on major step; log minor ticks are
non-uniform; spine positioning has three coordinate systems (points / axes
fraction / data units); no built-in label-collision avoidance anywhere —
skip-every-N is the pragmatic knob; watch negative-zero formatting.

**02 Manim aesthetics** (for the zoo's look, items 68–69): background is pure
#000000 (the assumed #0E1116 is UNCONFIRMED — flagged, don't pin it); palette
BLUE_C #58C4DD, YELLOW_C #F7D96F, RED_C #FC6255 (full ramps in report); stroke
width ≈ 1/280 of frame width at default weight; Create uses lag_ratio 1.0
path-trace, Write uses linear rate with length-keyed run_time,
DrawBorderThenFill is 2s double_smooth stroke-then-fill; base animation is 1s
smooth (sigmoid — PowerRP's cubic "smooth" curve is the stand-in; ALWAYS
smooth for draw-ins); NumberPlane grid: faded_line_ratio sub-lines dimmer than
axes, verticals→horizontals staggered ~60ms; glow = shader radial falloff
(glow_factor 2.0) or the layered fallback: 4 rings at ~35/18/9/4% opacity.

**05 parametric tool survey** (for graphLine, item 63): numPoints default 256
(point count, not step — resolution-independent; matplotlib convention
100–500; in-repo precedent tangent_lines.js CIRCLE_SAMPLES=64);
discontinuities: Tier A = screen-space jump heuristic (break polyline when
consecutive samples exceed a threshold), Tier C = Manim-style explicit
t-value list (no tool auto-detects asymptotes); DRAW-IN IS FREE — tStart/tEnd
as ordinary tweenable numbers animate through the existing delta engine, zero
widget-specific animation code; polar/explicit modes are syntactic sugar over
ONE parametric (x(t), y(t)) core (GeoGebra precedent); THE DESMOS SLIDER
TRICK: core/expressions.js already detects unknown-variable spans and has a
constant→scrubber span kind, so auto-exposing free variables as inspector
scrub rows is wiring, not new detection — this is the first consumer of the
per-widget variables refactor (item 67).

**04 equation-zoo curriculum** (item 68): 17-slide arc in 8 acts — heart/
cardioid → rose petal-parity → Maurer rose (string-art wildcard) → the spiral
trilogy → golden spiral → Fermat/phyllotaxis wildcard → catenary-vs-parabola
→ cycloids (tautochrone hook) → epicycloid/hypocycloid spirograph (gear
tie-in) → superellipse → Lissajous → harmonograph wildcard → sum-of-sines →
Fourier-epicycles finale. Each entry ships JS-ready t→(x,y), on-slide LaTeX,
tuned ranges (~700×700 centered), teaching hook, draw-in recipe. THE SPIRAL
MORPH IS PRINCIPLED, not cosmetic: Archimedean (r=a+bθ) and logarithmic
(r=ae^{bθ}) both solve dr/dθ = c·r^p at p=0 and p=1, so the closed family
r(θ) = [a^(1-p) + c(1-p)θ]^(1/(1-p)) gives ONE λ slider that morphs the
mechanism (guard the 1-p→0 singularity; p→1 recovers the exponential
exactly). Golden spiral: b = ln(φ)/(π/2) from "grows by φ per quarter turn".
Second live-slider demo: superellipse exponent n (circle→square). This λ and
n are exactly what per-widget vars (item 67) exist to tween.

**03 rolling-ball math** (item 69, SymPy-verified; full derivations + worked
table in the report, verification script preserved beside it): equation of
motion for a solid sphere rolling in the catenary valley y = a·cosh(x/a),
parameterized by arc length s (closed forms: s = a·sinh(x/a), x = a·asinh(s/a),
and the bonus y(s) = √(a² + s²) — no cosh needed at runtime):

    s̈ = −(5/7)·g·s / √(a² + s²)

THE SIGN IS THE FINDING: the coordinator's proposed "+" version was WRONG —
energy check E = (7/10)ṡ² + g·√(a²+s²) diverges under "+" (runaway ball) and
is conserved to 2e-13 under "−" (bounded nonlinear oscillator about the
valley floor). No elementary closed-form solution exists (non-elementary
quadrature), so integrate RK4 from rest each evaluation — dt ≈ 0.02 s
(~250 steps for 5 s, measured ~1000× more accurate than semi-implicit Euler);
pure function of t, seekable. Supporting laws, all verified: sinθ = tanh(x/a)
= s/√(a²+s²); sphere a = (5/7)g·sinθ (I = 2/5 mR²); no-slip iff
μ ≥ (2/7)·tanθ; unit normal N = (−tanh(x/a), sech(x/a)) (center = contact +
R·N); spin φ = −s/R + φ0 with NO left/right case split (s monotonic in x —
one formula, both directions). Worked example a=2, R=0.3, g=9.8, x0=−3:
period ≈ 4.799 s; spot-check table in the report.

**06 equation sandbox design** (item 64): THE SANDBOX ALREADY EXISTS —
core/expressions.js compiles arbitrary JS via
`new Function("scope", "with(scope){return (EXPR)}")` cached by source string
(jsFnCache), blocks Date/window/performance through BLOCKED_GLOBALS + a
has:()=>true Proxy that seals global fall-through, excises Math.random
(SAFE_MATH), seeds mulberry32, and routes `time` through particleTime(); an
IIFE with a for-loop (Fibonacci) compiles through it TODAY unmodified.
graphLine must therefore EXPORT AND REUSE compileEquationFn/toJsExpr/
SAFE_MATH/BLOCKED_GLOBALS (duplicating the block-list risks drift) but NOT
reuse the per-item slot/dependency-graph machinery (different problem: one
doc-wide equation graph vs one source sampled N times). Per-sample scope: a
plain mutable object, NOT a Proxy — measured ~17× faster and throws free
ReferenceErrors on typos. Perf is a non-issue: worst case (Proxy + with +
Fibonacci IIFE) ≈ 0.4 ms per 500-point pass ≈ 2.4% of a 60 fps frame;
compile-once caching is what matters. Sandbox symbols v1: x, t (alias), i, N,
TAU, PI, Math (sans random), random(offset) via the ORDER-INDEPENDENT
(seed,i,stream) hash from core/particles.js (not sequential mulberry32 —
sample-order independence matters), `time`, and every document var by name;
`self` deferred pending a use case (item 67 will revisit). ERRORS ARE
WHOLE-CURVE AND LOUD: compile error or first runtime throw → widget-level
red-box affordance (the mermaid convention); NO per-sample try/catch (hides
which input broke; unexplained gap indistinguishable from legit NaN). Presets
store plain source strings (the mermaid/LaTeX precedent). FLAGGED FOR UI:
`t` (plot domain) vs `time` (presentation clock) coexist with different
meanings — document loudly in Inspector/Monaco.

**07 codebase precedent map** (integration truth for the whole family):
polygon (plugins/polygon.js) stores a normalized unbounded `points` list +
`closed`, emits ONE path op, bounds via polygonInkRect, per-vertex handles
via core/lists.js — and its own header says it is NOT a shapeshifter member
BECAUSE its data is unbounded; same holds for graphLine, so the shapeshifter
factory is REJECTED for the graph family (fixed-scalar-knob assumption).
"Inherit from polygon" = extract its pure chain helpers (distToChain,
closestChainProjection, openPathD, polygon.js:366–501) into core/outline.js;
no plugin-imports-plugin. The Monaco seam is a SIX-LINE declarative
descriptor: plugin declares `codeEditor: {property, language, title}`
(mermaid.js:438) → widget_handlers → App command → CodeEditorModal — any
graph widget gets Monaco free by declaring it. Stroke trim is applied
universally at ports.js:281; a widget exposes the rows by spreading
STROKE_TRIM_KEYS in its inspector — draw-in needs ZERO new render code.
LaTeX is a mermaid near-twin needing MathJax's DOM (bare-node CLI must
REPORT the omission, existing convention). Registration = one import + one
allPlugins entry (plugins/index.js:72); core/registry.js:1–181 is the base
class. NO scale/tick/axis precedent exists anywhere — a new core
scale-mapping module is required and is the family's shared foundation.
Widget presetFamilies flow through presetFamiliesOf (registry.js:587) into
ToolsPane and the Round-4 material merge automatically.

**09 per-widget vars design** (item 67): THE FOLD ALREADY WORKS —
core/deltas.js:94–132 mutBlendApply is a generic recursive walker; nested
numeric leaves under items.<id>.vars.* tween via interpolate() today,
first-appearance is discrete-at-alpha>0, hand-traced. NO fold changes.
`self.vars.lambda` ALREADY PARSES: parseSelfRef (expressions.js:907–919)
falls through to {kind:"prop", itemId, path}. THE ONE REAL GAP is slot
collection: computeEvaluatedState only recognizes equation slots via
isEquationValue/plugin defaults — a small new loop mirroring the top-level
state.vars collection (expressions.js:2139–2141) must walk each item's vars
dict. NAMESPACE RULING: dotted `self.vars.<name>`, NOT bare identifiers —
withVariableRenamed's bare-identifier token rewrite (2605–2666) cannot touch
dotted tokens, so per-item names are collision-proof by construction and
shadowing is moot. UI: reuse the VariablesPanel pattern with item-scoped
paths (["items", id, "vars", name]) — NumericField/KeyframeControls are
path-generic; core/lists.js REJECTED for storage (index-addressed arrays,
not name-keyed dicts; mirror the top-level vars dict instead). Undo needs
zero changes (flat snapshot log). Risks: the slot-collection gap (must-fix),
rename needs a NEW narrow sibling of withVariableRenamed (not a
generalization), copy/paste ref-remap path unverified (implementer must
trace + pin with a test). Order: slots → app glue → Inspector UI → rename →
autocomplete → copy/paste test.

**08 chalk/glow inventory** (items 68–69 look): EVERYTHING CORE ALREADY
EXISTS. Chalk: stroke material "brush" has a literal `chalk` archetype
(brush_strokes.js:375) with a shipped Chalk preset (#f0efe8,
material_presets.js:144); draw-in composes with EVERY stroke material —
paint_skia.js:1342–1360 trims the path BEFORE the material's render(). Glow:
bloom.radius/strength (core/properties.js:1073) is a real Gaussian bloom in
the universal effects bundle and paint_path already composes it — the glowy
orb and glowing title need no new machinery. ROUND-2 QUESTION RESOLVED WITH
CERTAINTY: material fills DO rotate with shape rotation (world.rotation is
baked into every material's uniforms; sky_shader.js:188 and comic_shader.js
rotate the fragment SAMPLE coordinate) — so a patterned ball's rotation will
read. Gaps (smallest closures): one stroke slot = one material, so textured
chalk + wavy boil can't stack (two stacked widgets sharing equations, or add
a boil knob to brush_strokes.js — currently clock-free by design); no
ball-shaded (sphere-look) fill material yet (rotation mechanism exists
twice); no "point at strokeEnd" anchor on paint_path for a particle emitter
to ride the draw-in tip (chalk dust); no chalkboard-surface FILL material
(grain machinery is stroke-only) — plain dark solid is fine per the Manim
finding (pure #000).

**10 bar-graph research** (item 71, verified against Manim source):
BarChart defaults — bar_colors ["#003f5c","#58508d","#bc5090","#ff6361",
"#ffa600"], bar_width 0.6, fill_opacity 0.7, stroke_width 3.
get_riemann_rectangles — dx 0.1, input_sample_type left (left/right/center),
stroke 1px BLACK, color gradient (BLUE→GREEN) across the sequence,
show_signed_area, and width_scale_factor 1.001 — the >1 fudge that kills
seams between adjacent rects (steal it). Closest in-repo precedent:
plugins/progress_bar.js (one equation-bindable number driving a shape
extent). THE GROW-UP FORMULA (unifies Manim LaggedStart and D3 delay(i·k)
into ONE scrubbed variable): reveal ∈ [0,1] with per-bar smoothstep windows —
bar i's height factor = smoothstep over the window starting at
i·lagRatio/(N−1+lagRatio·(N−1))… (exact algebra in the report; lagRatio 0 →
all-at-once, 1 → strict sequence, both proven to reduce to the source
libraries' limits). 11 presets designed from distinct angles (Riemann left
sum, dx-halving refinement sequence via discrete snaps, histogram,
categorical, time-driven equalizer + traveling pulse (RECORDABLE), noise
skyline, population pyramid two-instance composition, area-under-curve
overlay, stacked comparison (flags a real export gap), minimalist
sparkbars). Traps recorded: Manim's own two APIs disagree on defaults;
barCount is DISCRETE (snaps at alpha>0, never lerps); autoscale stays OFF
(anti-jump); per-bar identity under hide-vs-purge; lagRatio×transition
length interaction; center-rule ≠ trapezoid rule.

**video-unify investigation**: agent in flight; digest AS IT LANDS
(standing instruction: "Write all of them down into the manifest").

### Round 5 open questions (user: "write them all down") — NOT yet answered
- Parametric-only (t → (x,y)) or also explicit y=f(x) mode? (Assuming
  parametric core with a y-of-x preset wrapper unless told otherwise.)
- Adaptive sampling (curvature-dense) or strictly uniform N points? (Assuming
  uniform; N is a knob; maximalist option can come later.)
- Should graph equations see per-widget custom vars AND global vars? (Assuming
  both: self vars shadow globals.)
- Does the catenary ball's time law integrate the ODE numerically in-equation
  (pure fn of t via fixed-step loop from 0) or use a closed form? (Numeric
  integration is acceptable per the determinism rule; closed form preferred if
  the research finds one.)
- graphRuler world-space vs data-space: does the ruler define a data→world
  mapping other graph widgets share (axes as a coordinate frame), or is each
  graph widget independently placed? (Design question for the research round.)

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
