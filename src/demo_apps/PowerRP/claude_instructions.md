# PowerRP — In-Repo Manifest (Materials & Stroke UX Round)

> **Provenance:** PowerRP's historical institutional memory lives in the PowerRP
> dump's `claude_instructions.md` + `concerns.md` on the Linux container (this
> repo's `CLAUDE.md` cites it, e.g. `claude_instructions.md:4612`). That file is
> NOT reachable from this Mac, so this in-repo manifest was created 2026-07-28 to
> record the user's Materials-UX requirements round. It rides the git repo and is
> the authority for the requirements below. If/when the container manifest is
> reachable again, merge this into it (semantic merge, keep both histories).

## STATUS: ALL 75 ITEMS DELIVERED (2026-07-28, all five rounds)

Rounds 3–5 (items 36–75) landed in commits 9b421cd…09cef81 on
render-rewrite-skia: the widget-preset merge (52/53), slide rename (54), the
METAL family + groove-aging stamp (55, 13+15 presets), six ornament families
(56/57, 102 geometry presets), Gears v3 with engineer-grade meshing
(58/60/62, MP4), phase-360 identity pinned (59), THE HINTBAR LAW restored
with LOCAL abolished (61), the graph* family (63–66/71, 4 widgets + 2 core
modules + 69 presets), per-widget variables (67, self.vars keyframable),
the Equation Zoo deck + catenary ball at <1px physics (68/69, MP4), the
presets mantra applied everywhere (70), the time-scrubber video widget with
the %/time grammar fixes and ffprobe self.length (72), animated materials
in the presenter (73), universal option-hover preview (74), and the
replication study with its findings (75 — codeblock palette is the one
pixel-parity gap). Engine fixes along the way: docVars injection (ce777ac),
corrupt job.json hardening (09e268b). Final battery: doctests 2831+/0, node
gate 95/0, all touched browser probes green (environmental Mac failures
excluded per the recorded baseline). concerns.md holds every lesson.

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
- **Mode selector** (user, 2026-08-01) — a property whose VALUE decides which
  SIBLING properties are applicable. Vector Pattern's `generator` is one: 33 knobs
  are flattened into one schema and each generator reads only its own, so the rest
  are inert. The material choice (vector pattern vs CRT vs metaballs) is another.
  **The rule: knobs a mode selector renders inapplicable are HIDDEN, not shown
  inert** — an inert control is a lie about its own affordance, by the same ruling
  that keeps the save dot from being a button. Implemented via the `visibleWhen`
  row aspect (`core/multiselect.js` `PRESENTATIONAL_ROW_ASPECTS`), and the
  visibility predicate must be DERIVED from the mode's own declared schema, never
  from a hand-maintained mode→properties map.
  **Distinguish from DISABLED:** inapplicable *by mode* is hidden; temporarily
  unavailable *by state* is shown disabled WITH a reason (`commandUnavailableReason`).
  Two different situations; keep them looking different.

## CONVENTIONS — THE CANONICAL REGISTRY

**USER RULING, 2026-08-01:** *"Conventions, conventions — if solidified should be listed in
the manifest in the conventions area. That's what the manifest is for, really. Well, the
manifest is for many things, but that's one of them."*

So: **a settled convention lives HERE.** This section is its permanent home and the place a
fresh session or a new agent looks first.

### The graduation path — scratch, then settled

`.frenzy/round6/CONVENTION_LEDGER.md` is the IN-FLIGHT staging area, not a rival registry.
While many agents run in parallel, an agent that needs a name, a constant or an idiom must
(1) hunt for precedent, (2) read the ledger, (3) ask the lead — who knows what every other
agent has proposed and can say whether it has been heard before. The lead records the
ruling in the ledger immediately so the next agent inherits it within minutes.

**A ruling GRADUATES from the ledger to this section once it has survived being applied.**
The ledger is a round artifact and dies with the round; this section is permanent. Anything
still only in the ledger at the end of a round is either promoted here or was never a
convention.

**DRY APPLIES TO THIS DOCUMENT TOO.** Do not restate a rule that already has a home — point
at it. A convention written twice will drift exactly like code written twice, and then the
manifest itself becomes a Tower of Babel, which is the worst possible place for one.

### Where the existing bodies of convention live (pointers, NOT copies)

- **The CLAUDE.md chain** — four nested files (`~/.claude`, `CleanCode`, `SvelteLib`,
  `PowerRP`). Docstring/CQS labelling, the no-silent-fallback law, no magic numbers, no
  trailing comma after a last argument, SymPy-only equation art, `uv run` for Python,
  dump portability. These are the FLOOR; nothing here may contradict them.
- **`core/registry.js`'s docblock** — the de-facto widget base class. BOUNDS, NEGATIVE
  EXTENTS, HANDLE CONSTRAINTS, LIST PROPERTIES. Read before adding a widget.
- **`web/app.css`'s header and inline `/* … */` rules** — app-shell styling doctrine
  (square chrome, `--a-*` tokens only, no `<style>` blocks in `web/*.svelte`). Those
  comments ARE manifest-level rules, not decoration.
- **R6-25 TIER-0 STANDARDS** (this file) — the shared conventions the preset swarm was
  blocked on. Still the authority for what it covers.
- **R6-22 CONVENTION CONFORMANCE** (this file) — the STANDING OBLIGATION on every agent to
  fix violations it passes and record them.
- **R6-24 CONVENTION SWEEP RESULT** (this file) — the measured state of drift, wave 1.

### The two laws that generate most of the rest

1. **PRECEDENCE.** The manifest is supreme. Where the manifest is silent and two patterns
   compete, **the OLDER one wins** — established with `git log --follow --diff-filter=A`,
   `git blame`, `git log -S`, never by taste. A decision that feels arbitrary is a decision
   that has not been researched yet.

   **THE MIRROR, which costs one grep and was learned the expensive way (2026-08-01, three
   times in one hour — the lead, then two agents relaying the lead's error): BEFORE REPORTING
   A VIOLATION, CHECK WHETHER THE SURROUNDING FILE ALREADY ESTABLISHES THE PATTERN AS
   PRECEDENT. A "violation" that is the local majority is a MISREAD RULE, not a defect.**
   The instance: `-webkit-backdrop-filter` was called a banned vendor keyword and ordered
   removed. `web/app.css` contained sixteen `-webkit-` occurrences, fifteen predating that
   day, **ten of them that exact property**. Acting on the report would have stripped working
   cross-browser support from ten surfaces and called it conformance. The rule being applied
   was about vendor NAMING of identifiers; it was over-applied to standard CSS prefixes.
   This is the same reflex the doctrine already demands for INVENTING — look for precedent
   first — and it applies just as hard to ACCUSING.

   **REFINEMENT — "older wins" arbitrates between NAMED conventions only** (agent W3-A,
   2026-08-01, CLAUDE-ORIGINATED; the case that produced it is R6-29). **An unnamed local
   spelling is not a convention — it is an implementation, and it loses to the vocabulary
   that named the concept, regardless of age.**

   The worked example, because the mechanical reading gives the WRONG answer here and the
   next agent will hit the same shape. `doX`/`doY` axis suppression (`5d3d8c1`,
   2026-07-15) predates `constrain(state, desired) -> allowed` (`b967325`, 2026-07-28) by
   13 days. But `doX`/`doY` are two local booleans in one file: they never named a
   function, never declared a protocol, and never invited anything else to speak them.
   `constrain` named the concept — `constrain` / `desired` / `allowed` — and a named
   protocol is a claim on the future in a way two booleans are not. Decisive corroboration:
   B's OWN founding commit already describes its booleans as "axis constraints" and its
   factor as "diagonal-PROJECTED", so it was reaching for A's vocabulary before A existed.
   The two were never lexically disjoint competitors; B is an unnamed spelling of A.

   **WHY THE REFINEMENT MATTERS:** without it, "older wins" is a fossilization rule that
   would freeze every early expedient into doctrine and forbid ever naming anything. With
   it, the rule does what it was for — stopping *taste* from relitigating settled
   vocabulary — while still letting a concept be named once someone recognises it.
2. **NO TOWER OF BABEL** (user, 2026-08-01). One concept gets ONE expression. The failure
   mode is not ugliness, it is that a reader must learn which dialect applies where. Its
   commonest concrete form in this codebase — found five-plus times in Round 6 alone — is
   **a hand-maintained list, map or switch mirroring another module's shape.** Derive it;
   if it cannot be derived, gate it so drift turns something red.

### WIDGETS MAY BE MADE MORE POWERFUL — AND EVERY NEW POWER NEEDS A UI

**USER RULING, 2026-08-01, in two parts. The first removes a constraint; the second replaces
it with a harder one.**

> *"If polyline isn't powerful enough, you can just add more power to it. If the spline is not
> good enough, make the spline have more options, etc. It's okay to make widgets more
> powerful. If shatter needs it, then make the widgets better that you shatter into."*

So **a widget's current capability is NOT a bound on what we deliver.** A gap found while
building something else is a work item, not a permanent limit. This directly changes how
SHATTER (#221) treats its warning list: warnings are the INTERIM state for gaps not yet
closed, not the destination. Everything W3-N's audit classified GENUINELY MISSING (#231-233)
is buildable, not a fixed boundary.

It also relaxes the proportionality limit for this specific case: "that would mean changing
the widget" stops being a reason to refuse. Say what it costs and check in — do not
silently deliver a worse result to stay inside a smaller diff.

> *"Just one caveat though — you've got to make sure there's a coherent UI for it on both
> the properties and the canvas if we do make modifications. Everything has to be editable
> through the UI, not through a JSON file alone."*

**THE HARD CONSTRAINT: NO JSON-ONLY PROPERTIES.** Every capability added must be reachable
by a user who never opens the document file:
- a **property row** in the Inspector, and
- a **canvas affordance** (handle, modifier point, edit point) where the property is
  SPATIAL. A position, a length, an angle or an endpoint that can only be typed is
  half-built.

**THE EXISTING VIOLATION THAT PROVES THE RULE IS NEEDED: todo #239.** A group's `scale` is
the one property that actually moves its members — and it has NO INSPECTOR ROW ANYWHERE
(`core/properties.js` has no `scale` entry). Meanwhile the panel offers W and H, which are
no-ops on the members. So the only way to set it today is through the document. That is
exactly what this ruling forbids, and it predates the ruling.

> *"It has to be well established, easy to understand UI, and if you can do that, then
> you're allowed to expand it."*

**SO THE PERMISSION IS CONDITIONAL, AND THE CONDITION IS THE TEST: can the new power be
expressed in the app's EXISTING UI vocabulary?** If yes, expand — you are authorised. If it
would need a novel control the app has never had, that is a higher bar: propose it, do not
build it. "Well established" means the control already exists and the user already knows it.

The vocabulary to reach for first, all of it already shipped: a property row of an existing
KIND (number, angle-dial, colour, boolean, select, asset, list, paint) · a modifier point or
edit point on canvas · the `=` equation affordance every row already carries · hover-preview,
which is the established trope for every picker (todo #165) · a shared `src/lib` primitive
rather than a new one (todo #82 measured FOUR of five proposed primitives as unnecessary —
the app has more UI vocabulary than people assume).

**This turns "expand the widget" from a licence into a design constraint, and that is the
point.** A capability that cannot be expressed with controls the user already understands is
usually a sign the capability is shaped wrong, not that the UI is missing.

**Related and already settled, do not re-litigate:** an inapplicable-by-mode knob is HIDDEN
(the MODE SELECTOR glossary entry), and a control that looks usable but is not is a lie
about its own affordance. Adding a row is not licence to add an inert one.

### A SHARED SEAM WITHOUT A SAME-COMMIT SWEEP IS NOT A CONVENTION — IT IS ONE MORE DIALECT

**CLAUDE-ORIGINATED (agent W3-B, 2026-08-01), and MEASURED, which is what makes it a law
rather than an opinion.** Adoption rates of seams this project introduced, counted:

| seam | landed with a same-commit sweep? | adoption |
|---|---|---|
| `tests/puppeteerLaunch.js` | YES | **163 / 163** |
| `free_port.js` | YES | **8 / 8** |
| three other seams | NO | **3%, 8%, and 0%** |
| R6-25.3's pixel metric | NO | **zero adopters** |

**The seams that shipped with a sweep reached 100%. The seams that shipped without one
reached approximately nobody.** Not one of the three ever caught up, and the newest has no
users at all.

**Why, and it is not laziness:** a seam is only discoverable from where its author is
standing. Everyone else is inside a file that already does the thing some other way, and
nothing in that file mentions the new home. So the old spelling keeps being copied — not in
defiance of the convention but in ignorance of it, which no amount of documenting fixes.

**THE RULE:** introducing a shared helper, module or protocol is not done when the helper
exists. It is done when **every existing call site has been converted in the same commit,
and a gate fails if a new one appears.** If the sweep is too large for one commit, the seam
is too large to introduce yet — split it, or land the sweep first against the old spelling.

This is the same law as ledger C-10 (*deduplication without a gate is a snapshot*) seen from
the other end: C-10 says consolidating N copies without a gate regenerates them, and this
says introducing the one true home without a sweep never collects them in the first place.
**Both failures are silent, and both leave a codebase that looks unified in the docs and is
not in the code.**

### `@id.x` / `@id.w` FOR A **BOX**; `@id_tl` FOR **INK**

THE INK RULE (`e78a4ce`: the eight standard rim anchors are projected through the widget's own
closest-point-on-rim map) made anchors land on the silhouette instead of the bounding rectangle.
**That is correct, and it silently changed the meaning of every equation that was using an
anchor as a stand-in for the box.**

**It caused exactly one regression and it is the instructive one — in `plugins/mermaid.js`,
i.e. inside SHATTER, on the very shape that motivated the rule.** Labels were bound with
`@key_tl.x + dx` and sized `@key_tr.x - @key_tl.x`. Both are exact **only while anchors sit on
the bounding rectangle**. On a diamond node the label would have been shifted and shrunk. Fixed
in the same commit by reading the stored box (`@key.x` / `.y` / `.w` / `.h`) and gated.

**So the division is now load-bearing, and it is the only real cost of the ink rule:**
- **Want the BOX** — extent, span, a corner of the frame? Read `@id.x`, `@id.y`, `@id.w`,
  `@id.h`. These are stored state and mean what they always meant.
- **Want the INK** — where something should ATTACH? Read an anchor: `@id_tl`, `@id_closest`.
  These now follow the silhouette, which is the point.

Writing `@id_tr.x - @id_tl.x` to mean "width" is the trap: it is right for a rectangle and
wrong for every other shape, and it fails quietly by a few percent rather than visibly.

### WHEN A DEFECT IS A FUNCTION OF AN ENVIRONMENT YOU DO NOT HAVE, DO NOT TEST THE ENVIRONMENT — PARAMETERISE IT AND TEST THE FUNCTION

**The case that produced this (#188, `28c80e7`).** Materials vanish when they exceed a device's
uniform limit: `RuntimeEffect.Make` and `makeShader` only build Skia objects, the GL program is
compiled at DRAW time inside Ganesh, and a driver refusal DROPS THE DRAW with no exception —
so the existing `if (!shader) throw` could never fire. The obvious test is a browser probe.
**It would pass forever on a broken build**, because this host reports
`MAX_FRAGMENT_UNIFORM_VECTORS = 4096` and compiles a deliberately over-limit shader with
`COMPILE_STATUS true`. Measured baseline of the real defect on this machine: **byte-identical
pixels and zero console output.** A green probe here says nothing whatsoever about a laptop.

**The remedy is to move the environment into an argument.** The refusal became a pure function
of `(material, ceiling)`, `node_render.renderToPng` grew a two-line ceiling parameter, and the
behaviour was then proven END TO END BY PIXELS on a software Skia surface for both handlers —
on a host that cannot reproduce the bug at all. The ceiling defaults to `Infinity` (no ceiling
known = nothing refused), so node and the CLI stay byte-identical.

**The same shape had already appeared once that day** in the metaball clamp, where the fix was
to derive both the allocated surface AND the sample matrix from one fit-corrected scale rather
than trusting the size that was ASKED for. Both are "a limit the code cannot see from where it
is standing"; both became testable the moment the limit became a value rather than a fact about
the machine.

**So: if you catch yourself writing "we can't gate this, it only happens on real hardware",
that is the signal, not the conclusion.** Ask what single value the behaviour actually depends
on and thread it. The corollary matters too — **a gate that can only pass on your host is not a
gate**, and "it passed for me" about an environment-dependent defect is the same class of
non-evidence as a green build over a missing named import.

### MEASURE DISTINCTNESS OVER THE LIT SET, NEVER OVER THE WHOLE FRAME

When you compare two renders to decide whether they are meaningfully different — preset
against preset, before against after — **reduce over the LIT SET: the pixels where either
frame differs from the un-preset reference. A whole-frame mean is not a weaker version of
this; it is a different number, and for anything that does not fill its box it is
meaningless.**

**Measured, twice, and it changed a shipping decision both times.** `god_rays` first showed
the same pairs moving an order of magnitude between the two reductions, with three real
collisions visible only under the lit-set metric. Then the connector family, where a thin
arrow touches a tiny fraction of the canvas, gave the definitive numbers:

| pair | verdict | lit-set | whole-frame | dilution |
|---|---|---|---|---|
| Extension Line ↔ Hairline Pointer | real collision, CUT | 5.53 | 0.030 | **185×** |
| Flowchart Step ↔ Bidirectional Link | real distinction, KEPT | 15.14 | 0.132 | **114×** |

Under the whole-frame mean both sit below 0.14 and **no threshold separates them** — so the
agent would have shipped "Hairline Pointer", a preset whose head does not read, which makes
its own name false. Its words: *"I would never have caught this by eye."*

`litSetDistance` lives in `tests/imageDistinctness.js` — **the established seam with three
consumers. Do not write a fourth hash transcription.** `LIT_MIN_DELTA` is 1, not 2.

**CORRECTION, SAME DAY, AND IT NARROWS THE RULE I FIRST WROTE HERE.** I stated this as
"never over the whole frame", full stop. The next family to adopt it MEASURED ITS OWN
COVERAGE and found it is not the sparse case: god rays covers **96.5%** of the frame for most
pairs, so the two reductions agree within 3% and the lit-set choice buys nothing. **The
dilution is a function of COVERAGE, not of the metric being better** — and it is still real
where coverage drops (that family's low-density rows dilute 4.3×: Harbour Searchlight vs
Dusty Window is 0.886 whole-frame against 3.774 lit-set).

**So the honest rule is not "always use lit-set". It is: REPORT COVERAGE BESIDE THE MEAN, and
GATE ON `maxAbs`, which needs no reduction choice at all.** A family that adopts lit-set
without measuring its own coverage is cargo-culting a connector's problem — which is exactly
how a good measurement becomes a ritual. I generalised from one dramatic case before a second
had been taken; the agent that took it corrected me, and it was right.

**AND THE METRIC DOES NOT GET THE LAST WORD.** The same agent KEPT a pair at 15.14 — the
narrowest margin in its family, with the next at 62, a glaring outlier — because the contact
sheet showed one head versus two, which is the entire one-way/two-way semantic. Gaming the
number with a cosmetic route tweak would have been dishonest. **The number finds candidates
for your judgement; it does not replace it. When you override it, say so and say why.**

### A REVERT MUST REVERT ITS DOCTRINE, IN THE SAME COMMIT

**CLAUDE-ORIGINATED, 2026-08-01, from a measured instance.** `aba0aa9` wrote both the
"save button IS the save indicator" design AND the `CLAUDE.md` paragraph describing it.
`d595e95` reverted the CODE seven hours later — quoting the user, *"I said they share the
same state, not the same element"* — and re-pinned the tests in both directions, but never
touched the doc. For a day, `CLAUDE.md` taught a design the user had explicitly overruled,
**in the exact passage agents are pointed at for the `aria-disabled` ruling.**

**Why this failure mode is worse than an ordinary stale comment:** it is invisible from
both sides. The doc reads as settled, the code reads as correct, and nothing connects them.
Two audit agents read that paragraph this round; only the one that went to the code caught
it. Every other agent inherited a confident lie from the one file they are told to trust.

**The rule:** a commit that reverts, replaces or overrules a design updates the manifest,
`CLAUDE.md` and any docblock stating the old design **in that same commit**. Not as a
follow-up, not as a TODO. Prose that outlives its code is not documentation, it is
misinformation with a credible byline.

Corollary already earned separately: **a comment asserting a uniformity that does not exist
is worse than no comment** — it tells the next reader not to check. (`web/app.css:5463`
claims the `requires` frames are "one sentence style"; measured, there are six grammars
across six panes.)

### CLAUDE-ORIGINATED vs USER-REQUESTED

Conventions we propose are marked **CLAUDE-ORIGINATED** so the user can tell his own
requirements apart from ours (his explicit instruction, 2026-08-01: *"just make sure that
you distinguish that you were the one that came up with them"*). An unmarked convention is
one the user asked for.

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
period ≈ 4.799 s; spot-check table in the report. ADDENDUM (§9, receipts in
report): the demo needs NO new engine work — core/expressions.js compiles
full JS (IIFEs/loops explicitly supported, expressions.js:1850–1881) and
SAFE_MATH has sinh/cosh/tanh/asinh, so the RK4 loop is a legal document
equation over `time` (recordable, Δt=0-stable, shardable); `vars.ball_s`
holds the integration ONCE and ball_x/ball_y/ball_phi derive from it
(state.vars are cycle-detected equation slots, expressions.js:2139); the
curve/ball themselves are expressible with polygon/paint_path + circle/image
today — graphLine (item 63) makes it BETTER, not possible.

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

**video-unify investigation** (item 72; full risk list in
.frenzy/video_unify.md): TWO REAL PRE-EXISTING BUGS block the user's exact
wish TODAY, empirically confirmed — (1) `%` is not in the expression
grammar: OP_CHARS = "+-*/()" (expressions.js:120), so displayToStored
throws on `time % 12.5`; (2) `time` fails the UI-FACING validator
(resolveRef/displayToStored, :950–970/:1126–1158) even though the RUNTIME
evaluator resolves it fine (:2456) — this contradicts the clock plugins'
own help text telling users to type "= time" (clock_digital.js:221,
clock_analog.js:307). Both are small grammar-table fixes, not
architectural. `self.length` exists NOWHERE — scrubber `duration` is
hand-typed (video_scrub.js:85–90); the deterministic source is an
ffprobe-backed endpoint (the server.py:238–256 filmstrip precedent), which
works before any browser decode and is machine-stable. AUDIO is a real
loss, not a footnote: the scrubber is hardcoded muted (video_registry.js:
651) and the only audio precedent (PresentMode transitionAudio) is
fire-once wall-clock, nothing slaved to particleTime — no pattern to
steal. Live scrubbing is seek-latency-bound and survives via the
HOLD+COALESCE machinery (video_registry.js:477–943, built after "153 of
154 frames blank"). RECOMMENDATION (fits the user's demo-widget scope
ruling): keep the player; ship the grammar fixes on their own merit
(`%` + UI-visible `time`); add real self.length via ffprobe; the demo
widget is the scrubber-with-time-presets.

73. **ANIMATED MATERIALS FROZE IN THE PRESENTER** (user: "Why does the rainy
    window material not animate when I apply it to something?") — ROOT CAUSE,
    two layers: the editor freezes ALL animation by design (determinism); but
    in the PRESENTER, currentSlideHasVisibleAnimated only checked the
    WIDGET-state `animated` flag, and a plain shape whose FILL is an animated
    material has no such flag → the idle rAF never started → frozen at rest.
    FIXED: materials now declare `animated` on their registry entries (true
    for rainy_window/glitch/sky/raycast_dither; a params predicate for wavy —
    boil ≠ 0) and the ONE seam `paintIsAnimated(paint)` (materials.js) is read
    by PresentMode for every visible node's fill/stroke AND the camera
    background (hand-assembled, always visible). Pinned by
    tests/animated_paint_test.js including a COMPLETENESS SWEEP: any skia
    material-definition file importing particle_clock without declaring
    `animated` fails the test — the silent-freeze class is closed.

74. **UNIVERSAL OPTION-HOVER PREVIEW** (user: "this is like a recurring
    issue. We probably should have solved this with some base thing... when
    I'm mousing over the options of metal material, it does not preview").
    The Tools pane preset rows DO hover-preview (the previewDelta staging
    protocol); the gap is the INSPECTOR's dropdowns — hovering an option of a
    select row (e.g. metalType: brass/chrome/steel…) must stage a live
    preview of that value through the SAME preview(app)→revert protocol,
    reverting on pointer-leave, committing only on click. This is a BASE
    behavior of the select/dropdown row kind, not per-widget work — one
    implementation in the Inspector's dropdown wiring covers every material
    knob, every widget select, forever. FIXED (commit 6d5adf0): the base
    mechanism already existed — makeHoverPreview + the app-agnostic Dropdown
    onpreview/oncancelpreview callbacks were already powering Inspector
    selects, the Mat picker, and the texture palette; the ONE un-wired site
    was PaintField's material-param select knob. Hover now stages exactly
    what click commits (selectKnobWrite is the shared write, presetExpand
    honored), pinned by a 20/20 pixel-asserting probe (hover repaints while
    the doc stays byte-identical, close reverts to a 0.000 pixel baseline,
    click = one undo unit). Export-config dropdowns (RenderCenterModal)
    deliberately unwired — nothing on canvas to preview.

75. **THE REPLICATION STUDY** (user, 2026-07-28, with a reference screenshot):
    "make a presentation that tries to replicate this as closely as possible —
    to find shortcomings in the current widget ecosystem OR confirm we have
    everything we need. First slide = that image; second slide = a replication
    of it with widgets, properly grouped and colored precisely." The reference
    is a corporate dark deck slide ("BUILD IT" kicker, big white title, a
    syntax-highlighted Python code block, four callout cards with
    green/blue/orange/red left accent bars, a navy terminal panel with green
    CLI text). The DELIVERABLE IS THE FINDINGS as much as the deck: every
    place the ecosystem falls short (e.g. does the codeblock widget render
    real syntax colouring, per-card grouping ergonomics, precise-hex
    workflows) gets recorded; if nothing falls short, that confirmation is
    the result. Deck: projects/ReplicaStudy.
    FINDINGS (study complete; side-by-side passes at a glance, 31 widgets,
    zero repairs): (1) THE ONE REAL GAP — codeblock's syntax palette is not
    customizable: it renders REAL per-language token colors (the "Monaco is
    plaintext" worry is editor-only), but `theme` is a two-entry select over
    hardcoded CODE_PALETTES, so the reference's orange strings/cyan imports
    cannot be matched; fix = a `palette` override object in codeblock state.
    (2) Monaco editor-side highlighting still absent (known follow-up).
    (3) No per-corner radii on rect/codeblock. (4) Groups have no
    padding/auto-layout (pure geometric parent; inner offsets hand-authored;
    `bind` must equal the group's own transform or members shift). (5) No
    single-color monospace widget — used text + jetbrains-mono for CLI lines
    (fine). (6) Image widgets are blank in the bare-node CLI by design —
    full verification needs the browser path. CONFIRMED COMPLETE: rich text
    (mixed bold/gray runs, word-wrap, charSpacing tracking, valign), raw-hex
    everywhere, groups move-as-unit, camera-as-backdrop. Bottom line: the
    ecosystem reproduces a corporate slide faithfully; the codeblock palette
    is the only pixel-parity blocker.

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

## ROUND 6 (user, 2026-08-01): THE RECOVERY + PRESETS ROUND

THE CANONICAL FULL RECORD of the round. `.claude_todo.md` is the operational
tracker and holds ONLY ids + status — it points here, it does not restate this.
Ids are `R6-n` and are stable; agents cite them.

### Why this round exists

The user believed two features had been lost with an old computer: a Blender-style
modal-transform guide line, and a Gaussian-splat viewer. An eight-agent forensic
sweep (all ~85 branches, every tag/remote, 46 unreachable stash commits, 4 sibling
repos, both transcript corpora — 498 current + 1292 pre-migration snapshot files —
the complete 1759-prompt user history, all 27 recorded cwds, the filesystem, shell
history, Chrome history) established:
- **The R/rotate guide line was never built here.** `853e597` shipped G/S only, and
  its own message lists the rotation sweep as an unimplemented follow-up. No ref
  anywhere has an `R` binding, a `rotateMode`, or a `guideLine` symbol.
- **The splat viewer was never built at all.** Three splat mentions exist in the
  entire user history, two of them explicitly deferring it ("if we do splats later
  we can defer, we gonna overhaul the rendering system"). The interactive viewer the
  user remembers was a live third-party demo surfaced during renderer research
  (`https://jatentaki.github.io/portfolio/gaussian-splatting/`), plus a PowerRP
  vision doc promising the widget as future work.
- **Nothing on `nuno` is worth merging** — 2 commits: a 31-line `.gitignore` of
  scratchpad litter, and an ALTERNATIVE CRT implementation whose shader is 358 lines
  SHORTER than the one on `powerrp` (merging it would regress). `render-rewrite-skia`
  has exactly one unique commit, `a7e6964` (the takeover button).
So both are NEW CONSTRUCTION, recorded here as requirements rather than recoveries.
Full archaeology archives: `.frenzy/reqmine/agent_*.md` (1091 harvested items, 8
files) — disposable; this manifest copy is canonical.

### R6-1 GAUSSIAN SPLAT VIEWER WIDGET

- **R6-1.1** A gaussian splat scene as an insertable widget: position, rotate,
  group, keyframe, export, like any other. The user's framing: "splat viewer
  included — dropped in as widgets you position, rotate, group, keyframe, and
  export."
- **R6-1.2 DOUBLE-CLICK ENTERS MOUSE-LOOK.** Double-click the widget and you are
  inside the scene, flying with the mouse. This is the `activate` phase of
  `web/widget_handlers.js`, the same seam `latex_edit` / `inline_text_edit` /
  `rich_text_edit` / `asset_picker` / `code_modal` use. PRECEDENT TO FOLLOW:
  `plugins/demo/mandelbrot.js` already does exactly this — "DOUBLE-CLICK
  ACTIVATION (web/widget_handlers.js, phase 'activate'): INTERIOR ..." — the user
  named Mandelbrot as the model. Escape must exit, and it MUST register in the
  shortcut registry or the three existing Escape handlers will steal it (#195).
- **R6-1.3 CAMERA POSE IS PROPERTY STATE.** Position / orientation / FOV are
  ordinary keyframable properties, so a fly-through tweens across slides and
  renders deterministically in both exporters. It must NOT read a wall clock nor
  carry frame-to-frame state — that would make it ephemeral and break frame-range
  sharding (see THE THREE KINDS OF STATE in the repo CLAUDE.md).
- **R6-1.4 DO NOT WRITE OUR OWN SPLAT RASTERISER.** User ruling, verbatim: "Do not
  make your own janky little Splat viewer. We want to actually use other people's
  Splat viewers, like a real one that's very fast, and we can integrate it into our
  widget. It needs to look professional and look good." Integrate a real, fast,
  maintained library.
- **R6-1.5 PREFER A LIBRARY THAT ALSO HAS A 3D ENGINE**, so splats can be mixed
  with meshes later: "Ideally something that can have a 3D engine too, so that you
  can mix it with meshes and stuff too."
- **R6-1.6 THE RESOLUTION CONTRACT — THE CARDINAL RENDER LAW.** The widget renders
  `f(x, y, w, h)` at a GIVEN RESOLUTION: zoom into the canvas and it re-renders at
  HIGHER resolution over a SMALLER CROP, not a magnified stale raster. Any
  magnifier sitting on top of it composes the same way. THE SEAM ALREADY EXISTS:
  `core/clip.js visibleSourceRect(box, cropInsets, view, opts) ->
  {visible, deviceRect, sourceRect, scale, localRect}` (its doctests show the
  device-rect bound holding at 50x zoom — "a window, not the whole zoomed page").
  The dump manifest states the unified principle at
  `claude_instructions.md:5432`: "this three-way crop should be standard practice
  among ALL widgets where it can possibly make sense."
- **R6-1.7 CACHE WHEN NOTHING CHANGES.** If neither the scene nor the view
  changed, reuse the last raster and move on. Precedent: the static material
  raster cache (task #208).
- **R6-1.8 FIXED-RESOLUTION OVERRIDE.** An option to render at a chosen fixed
  resolution (the user's example: 720x840) REGARDLESS of the widget's on-canvas
  size, for when the scene is too slow and the author wants to bound cost
  explicitly. This is a deliberate, documented technical control, not an arbitrary
  cap (see the no-Nintendo-guardrails rule, task #71).
- **R6-1.9 REAL EXAMPLE SCENES ARE MANDATORY.** "You need to find real examples of
  Gaussian Splats, otherwise nobody can play with the demo widget." Ship at least
  one in the BUILT-IN asset library (task #68), never in the user's Asset Explorer.
- **R6-1.10 INSTRUCTIONS ON THE WIDGET.** "There needs to be instructions on the
  widget somewhere too, so people need to understand — I don't even know how to
  make Gaussian Splats. I don't even know how to upload those. Like, is there some
  standard for how people upload them?" So the research must answer, and the widget
  must SAY: what a splat file is, which formats are standard (`.ply` / `.splat` /
  `.ksplat` / `.spz`), how a person captures/trains one, and how to get one in here.
- **R6-1.11 RESEARCH FIRST, heavily.** Library survey (speed, licence, quality,
  3D-engine story, WebGL2-vs-WebGPU need), format survey, capture/training
  pipelines, and sourceable example scenes with licences.
#### R6-1.9/.10 FORMATS, ASSETS, PIPELINES — RESEARCHED (wave 1, agent W1-J; report `.frenzy/round6/W1-J.md`, 1067 lines, plus `W1-J-fmt.md`, `W1-J-lic2.md`, `W1-J-pipe2.md`)

**PRIMARY IMPORT FORMAT: the INRIA `.ply`** — the only format every producer writes AND
every viewer reads, and the only LOSSLESS one. Second: `.spz` (MIT, ~10x smaller, keeps
spherical harmonics). **`.sog` is the right DELIVERY format (measured 19.6x) but the wrong
IMPORT format.** `KHR_gaussian_splatting` is only a Khronos Release Candidate and its SPZ
companion (PR #2531) is open and unmerged, so it is not something to build on yet.

**AN IMPLEMENTATION TRAP, RECORDED BEFORE IT BITES: `f_rest` IS CHANNEL-MAJOR.** Read the
other way it produces silently WRONG view-dependent colour — no error, just wrong pixels.

**SHIPPABLE SCENES — the agent's OWN FIRST PICK WAS WRONG AND IT CAUGHT IT.** PlayCanvas's
committed `apartment.txt` claims CC-BY-4.0, but the superspl.at page THAT FILE ITSELF CITES
says **CC BY-NC 4.0**; same for `playbot/`. Both REJECTED. Corrected picks:
1. **`hornedlizard.spz`, 18,143,098 B, MIT** from `nianticlabs/spz` — the format author's
   own repository, so there is no third party whose terms can drift. Convert to `.sog`
   before committing (MIT permits it; Babylon's SOG of this same scene is 11,323,413 B).
2. **`knock-community-hall.sog`, 27,830,709 B, CC BY 4.0 confirmed against source** — the
   only clean room-scale INTERIOR found. Small alternative: `Unicorn_Stuffy.sog`,
   2,065,634 B, but on a blanket licence claim that over-reaches elsewhere, so it is the
   weaker provenance.
**Exactly ONE genuinely CC0 splat exists anywhere** (`FirePit.splat`, 16,003,424 B, and
only a bare tag). Poly Haven, AmbientCG and Sketchfab have ZERO; KHR ships no sample assets.

**SHIP IN-REPO — and this agrees with W1-O independently.** Precedent: `fonts/` already
commits ~40 MB of licensed binaries (largest single file 10,673,480 B) with a README
licence table and an explicit offline argument. The dump manifest's download-to-cache line
(`/root/CleanCode/Dumps/RPPT/claude_instructions.md:1170`) SCOPES ITSELF to the "full
palette" while stating that "small selected textures **may be committed**", and separately
rules out rp at runtime.

**SPLAT UPLOADS ALREADY WORK — CLASSIFICATION IS THE ONLY BREAKAGE.** Running `server.py`'s
own classifier: every splat extension falls to `"other"`, which makes it **invisible to
every picker** (`web/AssetField.svelte:200`). `_handle_upload` has NO allow-list and NO size
cap, so nothing blocks the bytes. Seven small edits, none of them in the upload path.
**No arbitrary-limit violation here:** the only cap is `FETCH_ZIP_MAX_BYTES` at 512 MB, and
it carries its justification in a comment.

**ON-WIDGET INSTRUCTIONS (R6-1.10): the `src` row's `help` tooltip. Precedent
`plugins/iconify.js:544`**, whose shape is grammar -> example -> gesture -> source ->
caveat. Measured: 566 help strings, median 98 chars, longest 1061
(`plugins/demo/globe_map.js:189`), so a ~780-char help string is within precedent.
**There is NO long-form prose surface in this app** — no `note` row kind, and
ghost-on-empty (`core/derive.js:548`) carries no text, so it is not a teaching surface.
Do not invent one.

**THE CAPTURE ADVICE CHANGED AFTER VERIFICATION — this is the headline for R6-1.10.** The
draft copy named Polycam and Postshot as the easy routes. Read off the vendors' own pricing
pages: **Polycam's free tier exports GLTF ONLY**, and **Postshot's free tier cannot export
a radiance field at all**. **Scaniverse is the ONLY free route.** Saying otherwise in
on-widget help would have sent the user down two dead ends.

**Two more verifications:** `mkkellogg/GaussianSplats3D` is explicitly UNMAINTAINED
(independently confirming W1-I) and it is `.ksplat`'s only reader, so that format dies with
it. And `colmap/glomap` is ARCHIVED/deprecated, folded into COLMAP's "global" mapper — so
pipeline docs naming glomap are already stale.

**CORRECTIONS TO MY OWN BRIEF:** (a) the repo does NOT carry `canvaskit.wasm` — it comes
from npm / `web/dist` and is gitignored, so **`fonts/` is the committed-binary precedent**,
not canvaskit; (b) built-in assets CAN surface in the Asset Explorer via
`showBuiltinAssets` (default `false`, widget-library only, labelled, quota-exempt), so my
"must NEVER appear there" phrasing in R6-1.9 was too absolute — the default is off, which
is the actual rule.

- **R6-1.12 OPEN DESIGN QUESTION (needs the user).** The runtime raster backend is
  Skia/CanvasKit on WebGL2, deliberately avoiding `navigator.gpu` so the app works
  on plain HTTP. A splat rasteriser is a sorted-billboard GPU pipeline Skia cannot
  express. Decide: offscreen GL/WebGPU target composited by Skia as a texture, and
  what happens in `cli/render.js` (no GL at all) and in the render-job worker
  (ANGLE, possibly SwiftShader).

### R6-2 BLENDER MODAL TRANSFORMS: R, AND THE DASHED LINE ON R AND S

- **R6-2.1** `R` enters a modal ROTATE about the selection's collective centre —
  the missing third mode. Today only `G` and `S` exist
  (`core/shortcut_entries.js:775`; `modalXform.kind` is typed `"grab"|"scale"` at
  `web/app.svelte.js:622`).
- **R6-2.2 A RED DASHED LINE FROM THE CURSOR TO THE CENTRE, ON BOTH R AND S.**
  Today there is only an axis-constraint line, drawn only after `X`/`Y`
  (`web/CanvasView.svelte:3104` computes, `:3396` paints into `guideSegs`, `:3629`
  renders), plus a bare pivot DOT for scale (`:3419`, `:3636`). The dot becomes a
  line. Blender parity.
- **R6-2.3** Wire it exactly like the existing modes: registry entries so the
  HintBar announces the mode, the modal input lock, `commitPreview` as ONE undo
  unit, `cancelPreview` on Escape. Modal geometry lives at
  `web/CanvasView.svelte:2984-3160` and `web/app.svelte.js:621-644,1425-1432`.
- **R6-2.4** Decide whether axis constraints and numeric entry (dump manifest
  `claude_instructions.md:3093-3100`) extend to rotate.

### R6-3 THE PRESETS PROGRAM — RESEARCH-DRIVEN, EVERY WIDGET

- **R6-3.1 THE THESIS.** "Presets are how we get inspiration. We need those." Each
  preset is a designed, inspiring starting point that teaches what the widget can do.
- **R6-3.2 THE GAP. DO NOT QUOTE A NUMBER FROM THIS FILE — run
  `node tests/preset_contract_test.js`, which prints the census.** This bullet has now
  been wrong TWICE with two different sets of digits ("14 of 73"; then "33 of 96, 391
  presets"), and each stale figure was re-quoted by later sections and briefed to agents
  as fact. Both were also too LOW at the time of writing, for a structural reason worth
  knowing: `builtinRoster()` includes the built-in plugin-ASSET library and
  `presetFamiliesOf` resolves `presetFamilies` as well as `presets`, so **any count taken
  by grepping for `presets:` was always an undercount** — and function-generated tables
  (mandelbrot's) are invisible to a grep entirely. The gate is the only honest source, and
  it is cheap. *(Same remedy `<app>/CLAUDE.md` applies to the test count, for the same
  reason: a pinned number in prose rots while nobody notices.)*
- **R6-3.2b THE REAL WORK IS INSTALLATION, NOT DESIGN.** `.frenzy/round6/presets/` holds
  roughly 721 DESIGNED presets across 13 family documents, key-validated against the live
  registry, of which essentially none of the non-optical ones were ever installed. A
  designed-and-shelved preset is worth nothing to the user; **prefer shipping those over
  inventing more.** Where a family doc is stale, translate it — `presets/arrows.md`'s 96
  entries write the RETIRED `headMode` and named a head-shape enum and arrow dashes as
  their two biggest blockers, both of which `b6c44cb` and `3f02a2a` have since closed, so
  its own pessimistic conclusion no longer holds.
- **R6-3.3 NOT STUPID PRESETS.** "Not just stupid presets, every single one needs
  to have sub-agents that really think it out and do tons of research." Physical
  grounding where physics applies, graphic-design/cultural grounding where it does
  not. Each preset carries a human-recognisable name and one line on what it models.
- **R6-3.4 Aperture** — model SPECIFIC REAL CAMERAS AND LENSES: blade count, blade
  curvature, resulting bokeh polygon. 6-blade, 8-blade cine prime, circular-aperture
  portrait, ~~5-blade vintage rangefinder~~ — **CORRECTED, see below.**
  - **"8-BLADE CINE PRIME" IS FLAGGED, NOT REFUTED** (W3-D, 2026-08-01). Every cine prime
    it verified carries 7 or 9 blades; 8 is characteristic of Canon's stills house iris.
    **Deliberately recorded as FLAGGED rather than refuted, applying the lesson immediately
    below** — this is the same shape of claim ("I checked and could not find one") that just
    failed for the 5-blade example, and it has not yet survived a search whose method is
    written down. Needs a manufacturer-grade source either way before the example is changed.
  - **"5-BLADE VINTAGE RANGEFINDER" IS RARE, NOT REFUTED — and this line has been WRONG
    TWICE, which is the more useful lesson.** The lead first recorded it as REFUTED on the
    strength of "every sourceable rangefinder lens has six or more blades." W3-D then
    produced a counter-example by reading raw pages with no summariser in the path
    (MediaWiki `explaintext` + `curl`): the **Jupiter-12 35mm f/2.8** (1947, M39
    Leica-thread rangefinder, a Zeiss Biogon copy) at **5 blades**, per allphotolenses
    `c_550`, corroborated indirectly by phillipreeve listing the wider Jupiters at 5 blades
    → 10 rays.
    **Standing of that evidence, stated honestly:** allphotolenses is user-maintained, so it
    is weaker than a manufacturer spec — but far stronger than "appears not to exist."
    **So the correct record is: the configuration is RARE, the manifest's original example
    was UNSOURCED, and the Jupiter-12 is a candidate awaiting a manufacturer-grade source.**
    The shipped 5-blade preset stays a TLR (the registered choice; do not re-litigate a
    landed decision on new evidence unless the evidence overturns it, and this does not).
    **THE LESSON: "I could not find one" is not "there is none."** An absence-of-evidence
    claim needs the search itself described before it can be believed, and the lead's
    version did not have one. Recorded rather than quietly fixed, because R6-3.4's whole
    premise is that each preset models a REAL instrument — the sourcing requirement caught
    the user's unsourced example AND the lead's over-strong refutation of it.
- **R6-3.5 Lens flare** — model NAMED REAL LENSES AND CONDITIONS: anamorphic
  streak, coated modern zoom's faint ghost chain, uncoated vintage veiling haze,
  sun-through-windshield. Ghost spacing/count derive from element groups.
- **R6-3.6 God rays** — atmospheric conditions: cathedral dust shafts, forest
  canopy, underwater caustics, stage haze, sunset through a cloud break.
- **R6-3.7 Arrows** — graphic-design idioms: technical-drawing leader, comic-book
  action, hand-drawn marker, presentation callout, UML relation, sketch curve.
- **R6-3.8 Shape widgets** — user was explicit that "even shape widgets could have
  presets": gear by real tooth profile/module, star by point count and inner-radius
  ratio, callout/bubble by comic-vs-corporate-vs-thought, banner/ribbon by
  heraldic-vs-sale-tag, polygon by regular-solid families.
- **R6-3.9 The rest of the 59** — text, plaintext, number, clocks, bento, line, QR,
  SVG, iconify, metaball, rainy window, corkboard family, magnifier, telescopic
  rig, progress bar, Mandelbrot (a preset IS location + palette + zoom), video
  scrub, group, camera render settings.
- **R6-3.10 MECHANICS.** Reuse the existing `presets` protocol and Tools pane
  (task #99); presets apply to the current frame. Hover-preview is the house
  default for pickers (#165), so preset hover must live-preview.
- **R6-3.12 TWO STANDING LESSONS FROM THE PRESETS SWARM** (surfaced by the metaball
  research agent; full report under `.frenzy/round6/presets/`):

  **(a) WEBFETCH'S SUMMARISER CAN FABRICATE. VERIFY VERBATIM BEFORE CITING.** An early
  summary of a Wikipedia page returned "a rich, confident account" of metaball palette-LUT
  rendering and banding. A VERBATIM re-fetch showed **that article contains the word
  "Metaballs" exactly once, in a bullet list** — the whole account was invented by the
  summarising layer, not present in the source. The agent caught it, re-verified everything,
  and marked the affected claims. **RULE: any load-bearing claim from a fetched page must be
  confirmed against verbatim text, and "canonical look" lore with no citation is to be
  treated as unsourced.** This applies to every research agent in this repo, not just
  presets.

  **(b) A PRESET SET MUST BE PRUNED BY WHAT THE KNOBS CAN ACTUALLY EXPRESS — 12 CANDIDATES
  BECAME 7.** The metaball knob set has no emission, no true opacity (`fluidColor`
  MULTIPLIES, so a blob can never be brighter than its background), no environment
  reflection, no subsurface scattering, and no thin-film interference. Consequence, stated as
  collisions rather than opinions: mercury and molten metal are **the same picture** without
  emission; liquid nitrogen is **water with every knob turned down**; oil-lens and molten
  glass sit within 0.02 of each other on refraction — and crown glass is LOW dispersion
  (Abbe up to 65), so glass cannot even claim to be "the sparkly one"; slime is tinted water
  without SSS. **Shipping near-duplicates is the failure mode the user's "not just stupid
  presets" ruling is aimed at, so the honest move is to ship 7 that are distinguishable and
  say which 5 were cut and why.** Ranked knob additions, by presets unlocked: **`emission`
  first (3-5 presets, one add in the composite)**, then a 2-band environment gradient, then
  `filmThickness`, then `translucency`, then `roughness` separate from shininess.

  **A METHOD WORTH REUSING:** that agent derived `smoothK` from **log10(Ohnesorge number)**,
  which spans six decades across these fluids and is the best available physical predictor of
  fat-and-rounded versus pinched-and-stringy merging — while stating plainly that the
  ORDERING is right but the GEOMETRY is not, because a smooth-union neck is short and fat
  where a real high-Oh fluid forms a long thin thread. That is the standard: a physically
  derived mapping, with its own limitation named.

- **R6-3.13 THE SUNSTAR PARITY LAW — PHYSICS, NOT STYLE. PROPAGATE IT.**
  (From the lens-table coordinator; the table itself is `.frenzy/round6/presets/LENS_TABLE.md`,
  33 lens/condition rows, and carries this as a standing rule.)

  **THERE IS NO SUCH THING AS AN ODD-NUMBERED SUNSTAR.** The aperture is a REAL function, so
  its Fourier transform is CENTROSYMMETRIC: diffraction rays always come in equal, opposite
  pairs, for ANY aperture shape. Therefore **N blades even -> N rays; N blades ODD -> 2N rays.
  Both outcomes are even.** Any preset, label or help string promising a "seven-point star" is
  describing something physically impossible, and must be rejected rather than tuned.

  **THE TRAP THAT FOLLOWS, AND IT IS EASY TO WALK INTO:** the flare's `blades` knob is a
  BLADE count, and the shader applies the parity doubling ITSELF
  (`render_gpu/skia/lens_flare_shader.js:379-384`). So **`blades: 9` renders EIGHTEEN rays**,
  not nine. A preset author intending a nine-ray star and typing `blades: 9` gets double.
  This is also the exact consistency R6-3.11 requires between aperture blade count and flare
  starburst rays: they must agree on BLADES, and the ray count is then derived, never
  authored twice.

  **AN EXISTING TEST ALREADY ENFORCES THE ANTI-DUPLICATE DISCIPLINE — this is the enforcement
  arm of R6-3.12(b).** `tests/lens_flare_presets_probe.js` asserts that all N preset previews
  PLUS the baseline are **PAIRWISE DIFFERENT IMAGES**. So two lenses distinguished only by
  something the 19 knobs cannot express **take that suite RED**. That converges exactly with
  the metaball agent's independent conclusion: a preset set must be pruned by what the knobs
  can actually show. Here the codebase already punishes the failure automatically, and every
  future preset family should copy that probe's shape.
  (NOTE: that probe is one of the three NUL-byte files — see R6-24.1 — so `grep` lies about
  its contents; read it with `grep -a` or the Read tool.)

  **VERIFICATION NOTE WORTH KEEPING, because it cuts the other way:** the two values most
  likely to look fabricated — a **13-blade** iris with a **violet** coating on
  "Single-Coated Classic" — turn out to describe ONE REAL LENS: the **Helios-44 (1958)**, with
  a sourced 13-blade iris and a coating recorded as violet, turning golden-yellow in the late
  1960s. Blade/ray parity checks out in all twelve shipped rows, and every finding logged
  against them was prose or sourcing, NOT a wrong number. **So do not let a later agent
  "correct" a surprising-but-sourced value.** Odd blade counts are real; the impossible thing
  is an odd RAY count.

- **R6-3.14 MATERIALS FAMILY: 64 presets, SELF-VALIDATED — and a method worth copying**
  (`.frenzy/round6/presets/materials.md`; metaball 12, rainy_window 12, raycast_dither 12,
  particles 12, demo_showcase 8, blur 8).

  **THE ANTI-DRIFT METHOD, AND IT ANSWERS THE REPO'S WORST RECURRING DEFECT.** The agent wrote
  `scratch_materials.mjs` which **imports the six real plugins and diffs every designed key
  against `Object.keys(plugin.defaults)`** — 57 distinct keys, all present, all six
  `plugin.type` values matched — and recomputed every saturation bound it quoted. That is the
  cure for the hand-maintained-mirror class (R6-24.7, and the material probe fixtures that
  "drift silently"): **a preset table should VALIDATE ITSELF against the plugin rather than
  mirror it by hand.** Every future preset family must ship such a check.

  **MEASURED SATURATION POINTS — real, undocumented, and two of them are silent:**
  - `metaball.threshold` **hard-clips above 0.6**: the region pad is 0.6 x reach, so the
    isosurface reaches the region edge and the droplet is **cut square**. Presets capped 0.45.
  - `demo_raycast_dither.zoom` **silently truncates the palette above ~0.6** — the five colour
    spots sit at fixed positions while the field spans +/-0.5/zoom, so **at 0.85 two of five
    colour knobs are DEAD**. A knob that silently disables other knobs; the tightest constraint
    in the family, and its help text says nothing.
  - `rainy_window.rain` saturates its static layer at 0.35 and runner-1 at 0.75, so above 0.75
    only one layer still moves — which is why two presets had to differ on GRANULARITY
    (columns 4 vs 14) rather than amount. `dropSize` sheets at 1.7 and clips at 4.2; `shine`
    clips near 2; `streakiness` flattens near 6.
  - `particles`: **the editor freeze clock is 2 s**, so `lifetime <= 2` or the pane shows a
    still-filling emitter.

  **`metaball.smoothK` IS PROVABLY INERT ON A LONE WIDGET** — the smin seed cancels and
  `f = d` exactly. **This matters for R6-3.12: the Ohnesorge-derived `smoothK` ladder only
  expresses anything with TWO OR MORE metaball widgets**, so that mapping needs a two-widget
  fixture to verify and cannot carry distinctness in a single-widget preview.

  **BLUR IS NOT PRESET-LESS — 8, honestly.** `handleBlurBackdrop` composites the blurred
  snapshot OVER the sharp one at `opacity`, so opacity is a partial-VEIL strength, not
  transparency: (44, 0.45) and (36, 1.0) are the same scattering scale and completely different
  pictures. Without opacity the honest count is 4 (a radius ladder). **No shipped preset writes
  `opacity` at all** — flagged for a ruling.

  **AN UNRESOLVED CONTRADICTION BETWEEN TWO OF MY OWN AGENTS — DO NOT PICK A SIDE WITHOUT
  MEASURING.** The metaball substance researcher derived `bulge` from sessile-drop height and
  concluded **small bulge = tall bead** (mercury, theta 140 deg) and **max bulge = spread film**
  (water on clean glass). The materials agent reports that `bulge`'s **help text AND its shader
  comment are BOTH backwards**, meaning **small = flat puddle, large = round dome** — the exact
  opposite convention. One of the two is wrong, and both cite reasoning rather than a rendered
  pixel. **RESOLVE BY RENDERING the widget at bulge min and max and looking at it**, then fix
  whichever of {help text, shader comment, the Ohnesorge/sessile mapping} disagrees. Recorded
  unresolved on purpose; a coin-flip here would silently invert a dozen presets.

  **Also recorded:** `demo_raycast_dither` is named for ORDERED dithering it does not implement
  (white noise, no matrix, no quantizer) — a misleading name in a shipped widget;
  `plugins/graph_presets.js` is now the divergent table on THREE counts, being also the only one
  writing an effects bundle; and `demo_showcase` is honestly a MECHANISM TOUR (eight bindings of
  its `inset` custom prop) rather than a look book, because a look library there would duplicate
  `rect`.

  **ENVIRONMENT FACT FOR ALL RESEARCH AGENTS: `WebSearch` is erroring in this environment**
  (`output_config.effort 'xhigh' not supported`) while **`WebFetch` works**. That is why one
  agent reported search "down all session". Research must go through WebFetch of specific
  pages — which is also what forced the verbatim-verification discipline in R6-3.12(a).

- **R6-3.15 INSTRUMENTS FAMILY (`.frenzy/round6/presets/instruments.md`, 2058 lines):
  `clock_digital` 12, `progress_bar` 10 + 5 timing, `magnifier` 10, `demo_magnify` 12,
  `qrcode` 10, `clock_analog` 13. Three findings outlive the presets.**

  **(a) THE MAGNIFIER MIGRATION IS RESOLVED BY GIT AGE — `plugins/magnifier.js` IS CANONICAL.**
  The repo CLAUDE.md records this migration as "partial, not done". Settled per the R6-22.3
  precedence doctrine, on three independent grounds: `magnifier` is OLDER (`9bd8261`, the
  founding commit) versus `demo_magnify` (`4663249`, ten days later); **the newer commit's own
  message says "original magnifier widget preserved"**; and `magnifier` owns the top-level
  palette command. Both keep presets, paired by name so the two stay comparable.

  **(b) A DOCTRINE COMMENT WHOSE GLOBAL CLAIM IS FALSE — AND IT INFECTED THE AGENT'S OWN FIRST
  DRAFT BEFORE IT WAS CAUGHT. LEAD-VERIFIED, AND THE AGENT'S OWN CITATIONS WERE WRONG.**
  The real location is **`plugins/demo/glass.js:234-235`** (the agent said 229-237), and the
  false sentence is verbatim: *"every preset in this codebase writes LITERALS"*.
  **FALSIFIED BY FIVE FILES, not the two cited** — `plugins/filmstrip.js`,
  **`plugins/demo/video_time_scrub.js`** (the agent gave a top-level path that does not exist),
  `plugins/demo/globe_map.js`, `plugins/demo/lens_flare.js`, `plugins/demo/god_rays.js` — and the
  dump manifest MANDATES equation presets at its item 72.
  **BUT THE COMMENT'S LOCAL REASONING IS SOUND AND MUST BE KEPT:** it argues that writing
  `= Math.min(self.w, self.h) / 2` there would "silently convert the user's radius field into an
  equation-bound one, which is a different KIND of state than a preset should install." That
  distinction is real and is exactly what makes (c) below a genuine open question rather than a
  formatting nit. **So the fix is to narrow the sentence to this one field, not to delete the
  paragraph.**
  **Two lessons, and the second is about my own agents:** a false comment in a shipped plugin
  REPRODUCES ITSELF in every agent that reads it (which is why R6-22.4 covers comments, not just
  code) — and **an agent's file:line citations must be checked before they enter this manifest,
  because two of three here were wrong while the substance was right.**

  **(c) THE TWO SHIPPED EQUATION TABLES DISAGREE ON STRING FORM, AND IT BLOCKS FUTURE WORK.**
  One writes bare stored-case, the other `=`-prefixed display-case — **on the same row kind**.
  Unresolved, and it currently leaves anyone authoring a new equation preset guessing. Needs a
  ruling before the remaining preset families write equation presets; the `=`-marker seam and
  `displayToStored` are the deciding machinery.

  **A REPRODUCED TEST DEFECT: `tests/clock_analog_test.js:376` counts HANDS as tick spokes when
  the minute track is off, scoring -4.00 on a VALID dial** — so the shipped gate would reject
  correct presets. Must be fixed before the clock presets land, or it will read as their failure.

  **VERIFICATION, and the self-validation discipline held again:** via `scratch_instruments.mjs`
  all 13 dials are complete 12-key vectors, all pass the shipped numeral/tick gate (worst 9.94
  against a 4.81 floor), none collide — and **346 `props` keys parsed out of the document itself
  were checked against live registry defaults with ZERO dead keys.** Stated honestly by the
  agent: **nothing has been RENDERED yet**; three render checks are named in-file.

  **HONEST CUTS:** Regulator, Chronograph and Marine Chronometer were judged preset-less and
  **dropped rather than faked**, because the widget has no subdials. A drafted 1-module
  quiet-zone QR preset was likewise dropped rather than ship an out-of-spec code, and "Negative"
  is labelled MARGINAL because **no numeric contrast threshold exists in any of the five sources
  reachable** — the verdicts rest only on the sourced luminance-only decoding rule. Flieger A/B,
  panda dials and the A-11 spec were unreachable and are marked `[UNSOURCED]`, with the designs
  cut so nothing depends on them.

  **A REAL CONSTRAINT ON THIS ROUND, recorded so it is not mistaken for lack of effort: ALL FIVE
  of this agent's subagent launches were REFUSED at the 20-concurrent ceiling**, so a
  2058-line family was researched single-handed. The ceiling — not willingness to spend compute —
  is the binding limit on swarm width in this session.

- **R6-3.16 PRESETS PROGRAM RESULT: 721 designed presets validated, ZERO invented keys**
  (coordinator W1-N; `.frenzy/round6/presets/PLAN.md` is the index, `topup_treatment.md` alone is
  2912 lines with 73 proof PNGs; 13 of 14 families complete, `topup_atmospheric` still running).
  The self-validation discipline of R6-3.14 held at scale: every family diffed its keys against
  the live plugin defaults, and the only residual flags were the validator's own known
  misattributions, each hand-checked.

  **(a) A SHIPPED PRESET ADVERTISES AN AXIS THE VIEWER CANNOT SEE — LEAD-VERIFIED.**
  `demo_crt`'s `sourceTVL` moves **0.62 mean code values across its ENTIRE 120->1000 range**, and
  is byte-identical above 1024 because the floor bites at **1.707 x device width** — so on a
  600px picture the knob does essentially nothing. And `plugins/demo/crt.js:89-92` ships
  **"Sony BVM"** whose description opens *"The broadcast reference Trinitron: **the sharpest tube
  (~1000 TVL)**"* with `sourceTVL: 1000`; `:76-79`'s "Sony PVM (RGB)" likewise leads with
  "sharp (~600 TVL)". **Both descriptions lead with the one axis a viewer cannot distinguish.**
  This is the FOURTH near-inert knob this round (CRT flicker/persistence R6-24.6, video
  autoplay/loop/muted R6-12, raycast_dither's zoom-kills-colour R6-3.14, now this) — enough to
  treat "is this knob observable at realistic sizes?" as a standing check when authoring presets,
  not an afterthought.

  **(b) THE DISTINCTNESS GATE MUST BE COLOUR-AWARE — THIS REFINES R6-3.13.** I recorded the
  pairwise-different-images probe as the enforcement arm of the anti-duplicate rule. It needs one
  correction: shipped "Punch" and "Punch, Hue Locked" measure **0.0000 apart on the grey axis**,
  and that is CORRECT, because their difference is chroma. **A naive pixel/grey digest therefore
  produces FALSE REDS on a correct table.** So the rule stands but the metric must compare colour,
  not luminance — flagged for `brightness_contrast_browser_probe.js`. Both halves belong together:
  the gate is right to exist AND wrong if it is colour-blind.

  **(c) A TEST PINS PRESET PROPS AND BLOCKS SIX RESEARCHED PRESETS — BUT ITS INTENT IS RIGHT, SO
  WIDEN IT, DO NOT DELETE IT.** `tests/filmstrip_test.js:460` asserts verbatim
  `assert.deepEqual(Object.keys(p.props).sort(), ["filmColor", "perfFamily"], 'preset "..." writes
  a key no preset should')`, so filmstrip cannot exceed two prop keys and six researched gauges
  are stuck behind new `core/film.js` rows. **Read the comment two lines below it:** presets must
  "differ on the axes that are REAL (gauge/type), not on manufacturer" — i.e. this pin is a
  DELIBERATE guard against exactly the fake-distinctness failure R6-3.12(b) warns about. **The
  correct move is to widen the allowed key set in the SAME commit that adds the real gauge rows,
  keeping the guard intact.** (The agent framed this as "blocked by a test"; the truer framing is
  that the test encodes a rule we agree with.)

  **(d) A COORDINATION FAILURE THE COORDINATOR CAUGHT AND RECORDED RATHER THAN ERASED.** Its
  family table double-assigned `clock_analog` to two agents. Instruments produced it (4 -> 13);
  the treatment agent read the plan critically, noticed the overlap, and **declined to author a
  competing second table rather than silently duplicating**. PLAN.md is corrected with the mistake
  kept on the record. That is the concerns.md philosophy — append the wrong turn, never delete it
  — applied by a subagent unprompted, and it is the behaviour to reward.

- **R6-3.17 CORRECTIONS FROM THE TIER-0 AGENT — THREE OF THEM ARE TO CLAIMS I MADE AS FACT.**
  (Rulings live in `### R6-25`; commits `3e1076b`, `324b00a`.)

  **(a) THE PRESET CENSUS I QUOTED REPEATEDLY WAS STALE AND WRONG.** I reported "14 of 73
  plugins declare presets, the other 59 have none", to the user, several times. The real
  figure, measured by `tests/preset_contract_test.js` discovering through `builtinRoster()` +
  `presetFamiliesOf`: **33 plugins, 391 shipped presets.** My grep counted top-level `presets:`
  keys and missed families declared through other shapes. **The gap is far smaller than I
  said.** Lesson: a census belongs in a test that discovers from the registry, not in a grep.

  **(b) MY R6-3.16(b) DIAGNOSIS OF THE DISTINCTNESS GATE WAS WRONG.** I recorded that the
  pairwise gate is grey/luminance-based and therefore produces FALSE REDS on chroma-only
  differences. Verified false: `tests/lens_flare_presets_probe.js:38,92` uses
  `createHash` — **it is a sha256 of the PNG bytes.** A chroma-only difference DOES change the
  bytes, so the feared false red cannot occur. **The real weakness is the opposite one: a byte
  digest cannot catch a NEAR-duplicate either** — it only catches exact ties. New shared helper
  `tests/imageDistinctness.js` does per-channel absolute difference (flat in `tests/`, per the
  `puppeteerLaunch.js` precedent). Only the FLOOR is derivable (1 code value; the renderer is
  deterministic so the noise floor is 0) — no global threshold is baked in; families calibrate.
  **NOT YET MEASURED: the actual Punch / Punch-Hue-Locked number** (needs a browser run).

  **(c) `bulge`: SMALL = FLAT FILM, LARGE = TALL DOME — SETTLED BY RENDERING, and ALL THREE
  earlier statements were wrong.** At `bulge` 0.05 the bead is 100% pixel-identical to the
  backdrop; the undisturbed fraction falls monotonically 100% -> 18%; dome height is exactly
  `bulge x mean ball radius`. So the help text was wrong, the shader comment was wrong, **AND
  the sessile-drop physical derivation was wrong** — two of my agents disagreed and neither had
  it right. Correction owed at `render_gpu/skia/metaballs_shader.js:123,572` (reported, not
  applied). **CONSEQUENCE: the metaball preset `bulge` ladder is INVERTED and must be flipped
  before those presets land.** This is precisely why I recorded it unresolved instead of
  coin-flipping it.

  **(d) MY OWN VERIFICATION OF R6-3.15(b) WAS ALSO WRONG.** I grepped and reported FIVE files
  whose presets contain equations, and said so confidently. **Four of the five are refuted** —
  their equations are in `defaults` or `help` text, NOT in preset `props`. And the real second
  case (`plugins/demo/mandelbrot.js`) was absent from my list because its presets are
  **GENERATED BY A FUNCTION and therefore invisible to grep.** Lesson, the same one as (a):
  grep answers "which files contain this string", never "which presets do this".

  **(e) THE EQUATION-FORM RULING, AND IT CLOSES A SILENT-FAILURE HOLE.** `=`-prefixed, always.
  Mechanism and age agree: `web/app.svelte.js:1796 applyPreset` writes `props` **RAW** (no
  `displayToStored`), so a preset's string IS the stored value; and `isEquationValue` is
  `EQ_PREFIX_RE || isNumericSlot`, meaning **the bare form is an equation only while the
  target's default happens to stay numeric, and silently stores a LITERAL on any other row.**
  `=` is also the older spelling (`3a136e8`, 2026-07-27, vs `2f9595e`, 07-28). Manifest item 72
  is prose about WHICH equation, not a format mandate. Sub-rules: preset refs are limited to
  `self.…` and evaluator keywords (a preset cannot know another document's slugs); bodies stay
  snake_case. **DEFAULTS ARE THE OPPOSITE and must keep bare `self.`** — that prefix is
  structurally what makes the slot numeric. 11 bare equations were migrated.
  **Shipped contract result: 0 invented keys, 0 missing names/descriptions, 0 duplicate
  prop-sets, 0 unparseable equations, 0 unresolved kinds.**

  **(f) OBSERVABILITY IS A PROBE OBLIGATION, NOT A CONTRACT-TEST ONE** — it is a pixel
  question, and a bare-node suite must not fake one (that is R6-24.4's whole point). The
  contract test checks only the data shadow (no two presets with identical props). Authoring
  rule: **a description may not lead with an axis its family probe cannot separate** — which is
  exactly the "Sony BVM" failure.

#### R6-27 A PARALLEL-AGENT HAZARD I CAUSED, AND THE FIX

**Agents share ONE git index, so `git commit` after someone else's `git add` sweeps up their
in-flight work.** My commit `dd19c5c` was meant to carry one file (this manifest). It actually
carried **10 files, 981 insertions**, including W2-A's `tests/widget_fill_seam_test.js`,
W2-T0's `tests/preset_contract_test.js`, and W2-B's `web/app.svelte.js` +
`web/canvas/dragKinds.js` — none of which I wrote or reviewed. W2-T0 hit the mirror image of
this and correctly declined to rewrite shared history to fix attribution.
**RULE FROM NOW ON, for the lead and every agent: commit with an explicit pathspec —
`git commit -- <paths>` — which ignores whatever else is staged. Never bare `git commit`, and
never `git add -A`, while other agents are live.** Content is intact in every case here; only
attribution is wrong, and rewriting history under concurrent writers would be worse than the
mislabel.

- **R6-3.11 CROSS-WIDGET PHYSICAL CONSISTENCY.** Aperture blade count, flare
  starburst ray count and bokeh polygon must AGREE where they describe the same
  lens. A swarm authoring independently will contradict itself unless coordinated.

### R6-4 TOOLS MASQUERADING AS PROPERTY ROWS

- **R6-4.1 THE PATTERN.** `web/Inspector.svelte` honours declarative ROW ASPECTS.
  One, `pinLight: {xKey, yKey}`, draws an eyedropper that enters a canvas picking
  mode and writes `@id.cx`/`@id.cy`. `web/lightPositionPin.js` implements it and its
  own docblock advertises the pattern as a feature.
- **R6-4.2 CONFIRMED SITES.** `plugins/demo/lens_flare.js:445` AND
  `plugins/demo/god_rays.js:235` (the same eyedropper — the user's "another element
  that does that too"); `plugins/iconify.js:546`, whose comment says "eyedropper
  would have been... opens the SAME iconify gallery UI"; `web/bentoBind.js` /
  `BENTO_BIND_HANDLER` (cited precedent, entered by double-click); the
  `asset_picker` activate handler with `assetKinds`/`assetForm`.
- **R6-4.3 FULL ROW-ASPECT VOCABULARY to audit:** `pinLight`, `gallery`, `command`,
  `paint`, `scrub`, `assetKinds`, `assetForm`, `optionsFrom`, `centerAxis`,
  `visibleWhen`, `onIcon`/`offIcon`/`onText`/`offText`, `writeKey`, `nullable`,
  `display`.
- **R6-4.4** Decide the rule: which affordances legitimately belong on a property
  row, and which are tools wearing a property's clothes. Hunt for others.
#### R6-4 AUDIT RESULT — PROVEN (wave 1, agent W1-K; full report `.frenzy/round6/W1-K.md`, 772 lines)

**THE VOCABULARY IS 40 ASPECTS, NOT 22.** Measured across 96 plugins and 3491 rows.
R6-4.3's list was less than half; 18 aspects were missing from it. Counts:
`scrub` 84, `assetKinds` 17, `display` 15, `visibleWhen` 7, Inspector
`command`/`kind:"action"` 6, `paint` 5, `pinLight` 2, `centerAxis` 2, `writeKey` 2,
`gallery` 1, and one each of `scrubMin`, `scrubMax`, `optionsFrom`, `nullable`,
`presets`, `presetAspectKeys`, `orderKey`, `elementFieldDisabled`.

**ONLY `pinLight` IS A TOOL. The other two suspects are EXONERATED — this corrects
R6-4.2, which named all three.**
- `pinLight` (`plugins/demo/lens_flare.js:452`, `plugins/demo/god_rays.js:237`) calls
  `app.enterCanvasMode` and writes a PAIR of properties. Browser-proven: entering it
  collapses the HintBar from 36 chips to 2. That is a mode. It is a tool.
- `gallery` (`plugins/iconify.js:551`) is a PER-PROPERTY PICKER, not a tool:
  `canvasMode` stays null and it writes only `row.key`. Moreover the USER HIMSELF
  asked for it in that gutter slot (`web/GalleryPopup.svelte:2-6`). Leave it.
- The six `kind:"action"` rows (`plugins/group.js:142` plus five `edit-code-source`)
  are the OLDER mechanism (2026-07-15), documented at `core/properties.js:540`, and
  the HONEST one — no diamonds, no copy-path, renders as a button. By the precedence
  doctrine the older pattern wins, so these are the reference, not the deviation.
- **THE TELL IS ALREADY MECHANICAL:** exactly two aspects carry the
  `itemMode && !multi` gate — `pinLight` and `gallery`. Nothing else needs it. That
  gate, not intuition, is how a future tool-in-a-row is detected.

**WHAT A TOOL IS, from precedent (`core/registry.js:470-563`):** a `TOOL_POOL` group
row `{kind:"command", command, help, requires, applies(plugin)}`, with `help`,
`requires` and `applies` MANDATORY at boot and `applies` a predicate over the
plugin's own declared shape; the behaviour lives in the command registry. A
mode-entering tool needs NO new machinery — roughly 60 insert commands already arm
canvas modes.

**MIGRATION (templates: `edit-code-source` and `bind-to-camera`):** add
`LIGHT_KEYS` / `lightPinnable` / `LIGHT_PIN_HELP` / `LIGHT_PIN_REQUIRES` beside
`FRAME_KEYS` in `core/registry.js`; append ONE row to the EXISTING `positioning`
pool group; register `pin-light-to-object` in `web/App.svelte` (`run` ->
`enterCanvasMode`, no `preview`). **god_rays then inherits with ZERO plugin edits** —
which is the whole point of fixing it at the tool layer. Delete the aspect, the
Inspector button, `pinLightAspect`, and the `.pin-light-btn` CSS — whose "third slot"
doctrine comment must be REWRITTEN, not merely deleted. `LIGHT_POSITION_PIN_HANDLER`
stays verbatim, and do NOT add `claims` or double-click will start pinning.

**A SERIOUS UNREGISTERED-INPUT BUG, BROWSER-PROVEN.** `web/GalleryPopup.svelte` is
portalled to `document.body` but never focuses itself, so its registered
`POPOVER_HINTS.gallery` never delivers: focus stays on `gallery-btn`, the chips never
appear, and **Escape DESELECTS THE WIDGET while the popup stays open**. `pinLight`
and bento bind are fully compliant by contrast. Also found: `GalleryPopup`'s
`role="dialog"` produces a false "Tab / Next field" chip, and `CodeEditorModal`'s
Cmd/Ctrl+Enter is registered nowhere.

**A LIVE `ReferenceError`, verified first-hand:** `web/Inspector.svelte:852` uses a
free `path`, which **breaks the ƒ (equation) button for every Tier-0 kind**. This is
adjacent to R6-7 and must be fixed with it — an equation affordance that throws is
worse than one that is merely missing.

**LEAD RULING — STOP CITING BARE TASK NUMBERS TO AGENTS.** W1-K reported that
"task #195 does not exist", having found its only dump-wide occurrence to be my own
forward reference at `claude_instructions.md:773`. The task DOES exist (harness task
list, completed: "Escape leaks past three handlers — text edit, endpoint drag, modal
dialog"), but it lives OUTSIDE the repo, so no agent can resolve it. The agent's
recommendation was therefore right for a reason it had slightly wrong. RULE FROM NOW
ON: never hand an agent a bare `#nnn`; state the SUBSTANCE and record it in this
manifest, which is the only durable, agent-visible record.

- **R6-4.5** Build the lens-flare light-position tool properly IN THE TOOLS PANEL;
  god rays inherits it at the tool layer. Remove the misplaced row eyedropper.
  User's complaint: the agent "didn't understand what tools are, even though the
  tools panel is well exposed. It jammed a stupid edge case bullshit eyedropper
  into the actual properties tab."

### R6-5 THE "CUSTOM" NAMING SWEEP

- **R6-5.1** Lens flare's "Custom" becomes "Lens Flare settings" — "These are lens
  flare settings."
- **R6-5.2** Audit EVERY widget for a "Custom" section; each becomes its own
  widget-specific name. Rationale, verbatim: "not because they could be composed
  with other widgets."
- **R6-5.3** "Custom is supposed to be reserved for what people make, or not at
  all." The variables section may become "Custom variables."

### R6-6 INSPECTOR HEADER ROWS

- **R6-6.1** Widget-selection dropdown must be SEARCHABLE.
- **R6-6.2** Type selector must be SEARCHABLE.
- **R6-6.3** Rename it "Widget type."
- **R6-6.4** Its dropdown must be "no bigger or smaller than any other property" —
  the same field as Name and Visible.
- **R6-6.5** Name is indented differently from Visible; put them at the same level.
- **R6-6.6** Order Type / Name / Visible as three ordinary properties in one
  section, since every widget has them.

#### R6-6.7 WIDGET TYPE IS A KEYFRAMEABLE PROPERTY — USER CORRECTION, 2026-08-01

**This corrects R6-6, which recorded Type only as a row placement. The user's ruling:
"It IS a keyframeable property. You may have to correct the manifest on that."**

- **THE ARCHITECTURE ALREADY ALLOWS IT.** `core/derive.js:248` resolves the plugin with
  `registry.get(itemState.type)` from **FOLDED** state, and there is no separate item table —
  items exist only through slide deltas. So `type` is already carried per-slide like any other
  key. Nothing structural forbids a rect on slide 1 and a circle on slide 3.
- **WHAT TODAY'S CODE DOES INSTEAD, and it is the ONLY thing standing in the way:**
  `web/app.svelte.js:3277` `#creationState(id)` resolves an item back to "its ORIGINAL creation
  slide (**the first slide keying its type**)" and coerces from there — i.e. it treats type as
  IDENTITY. **The fix is not new machinery; it is applying the existing plan at the CURRENT
  slide instead of the creation slide.**
- **THE COERCION MECHANISM THE USER DESCRIBED ALREADY EXISTS, and it is the exact right
  shape.** `core/retype.js` computes a PLAN:
  `Array<{path: string[], value: *, why: "fill"|"coerce"}>` — **RULE 1** carries a value when
  the two types' row kinds AGREE, **RULE 2** coerces to the new type's default when they
  DISAGREE (`:215`, `:257-260`). `retypeChoices` returns `[]` for non-retypeable items (the
  camera), which is why its Inspector header stays plain text.
- **SO THE USER'S RULE MAPS ONE-TO-ONE ONTO EXISTING OUTPUT:** a retype at slide N writes a
  `type` keyframe at slide N, **plus a keyframe at slide N for every entry in the coercion
  plan**. Verbatim: *"the new type would be keyframed, and whatever types are coerced would
  also suddenly become keyframed too. It would just do it at whatever slide we're at."*
- **AND THE WARNINGS FALL OUT OF `why` FOR FREE.** `why:"coerce"` is the LOSSY case (a value
  was discarded); `why:"fill"` is merely a new-type default being supplied. The Inspector
  already orders the menu "clean types first and coercing types last", so the lossless/lossy
  distinction is computed — it only needs surfacing. **NOTE: the user asked whether we had
  discussed coercion warnings. We had NOT; this machinery was found by reading the code, and
  the user observed he could not think of an example that would actually have a coercion
  problem.**
- **A PROPERTY THAT NEEDS NO COERCION MUST NOT BE KEYFRAMED** — that is the minimal-delta
  discipline already in force (write ONLY changed props). Consequence, and it is a nice one:
  retyping a rect to a circle keeps x/y/w/h TWEENING smoothly across the change and cuts only
  the shape.
- **PROPERTIES BELONGING ONLY TO THE OLD TYPE SHOULD BE LEFT IN PLACE, NOT DELETED.** The new
  plugin simply does not read them, and leaving them makes the retype REVERSIBLE — retype back
  and the old values are still there. Same spirit as `active:false` (hide, do not purge).
- **TWEENING IS A HARD CUT, AND THAT IS WHAT IS WANTED FIRST.** Discrete values switch at
  alpha > 0, so a keyframed type is a cut, not a morph. User: *"Morphing is something that will
  come later, but first we need to have the hard cuts."*
- **OPEN QUESTION TO SETTLE DURING IMPLEMENTATION:** `#creationState`'s definition ("the first
  slide keying its type") stops being unique once type is keyed on several slides. Decide what
  it means then — most likely the NEAREST PRECEDING type keyframe, which is what the fold
  already implies.

#### R6-26 MORPH — THE FUTURE PLAN (NOT BEING IMPLEMENTED NOW; recorded at the user's request)

User, 2026-08-01, explicitly flagged as unfinished: *"My plan is not fully realized yet. It
needs work. That's why we're not implementing that right now."* Recorded so the hard-cut work
above is built in a way that does not preclude it.

- **THE SHAPE:** a SECOND dropdown, **"morph from widget"**, plus an **alpha**, plus a **morph
  method** (fading, or true morphing).
- **`morphFrom` MAY BE AN EQUATION, and the default is `previous`.** So the common case needs no
  authoring at all.
- **THE MECHANISM the user described:** on morphing A into B, **flip the current state into the
  "prev" slot immediately, drive the alphas to zero immediately**, set the morph method, then
  **animate alpha 0 -> 1** to produce the animation. In this codebase that is a COMMAND writing
  several keyframes in one undo unit — precedent exists for multi-property keyframe commands.
- **WHY THIS IS ARCHITECTURALLY CHEAP, and worth stating:** `morphFrom`, `morphAlpha` and
  `morphMethod` are ordinary PROPERTIES. So morph keyframes, tweens, folds and renders
  deterministically like everything else — **it introduces NO new kind of state**, and needs
  nothing from the recordable/ephemeral taxonomy.
- **THIS IS THE REAL JUSTIFICATION FOR R6-8.2 (arbitrary-depth structural submenus).** The
  "from widget" dropdown is not a short list: *"all the submenus, all the properties, all the
  assets, all the fill menus, all the material menus, are going to literally be under a from
  widget."* So R6-8.2 is not tidiness — **it is a prerequisite for morph**, and it must handle
  hundreds of entries at arbitrary depth without hiccuping. It also makes R6-6's SEARCHABLE
  dropdown a hard requirement rather than a nicety: a menu that large is unusable without
  search. **R6-6, R6-8.2 and R6-26 are therefore ONE dependency chain, not three independent
  items.**
- **QUESTIONS THE LEAD FLAGS AS STILL OPEN** (the user invited fleshing-out):
  1. `previous` means the previous slide's FOLDED state of this same item — that value is
     already computed by the fold, so it is cheap; confirm that is the intended reading.
  2. A morph between types with different property sets needs the METHOD to decide: fading is
     trivial (render both, cross-dissolve), whereas true geometric morph needs an outline
     CORRESPONDENCE — which is why `core/outline.js` and `plugins/shapeshifter.js` are the
     natural substrate for it.
  3. Whether `morphAlpha` should default to an equation of slide alpha (so a morph animates
     across a transition for free) or stay independent.

### R6-7 EQUATIONS ON EVERY PROPERTY

- **R6-7.1** "Basically every property should support equations." Reproduction:
  material -> atmosphere, type `=time`, refused.
- **R6-7.2 ROOT CAUSE, TRACED.** "Atmosphere" is `ATMOSPHERE_FILL_PARAMS`
  (`render_gpu/skia/atmosphere_shader.js:163`), spread into
  `plugins/demo/globe_map.js:206`. The params are declared CORRECTLY — `kind:
  "number"` / `"angle"` / `"color"`, with min/max/step, and `lightAngle`'s help even
  says "KEYFRAME THIS". So the defect is the `fillParams` -> Inspector row BRIDGE
  not threading the `=` affordance.
- **R6-7.3 SCOPE.** A whole CLASS: every material's shader params on every material
  widget. Task #149 closed a sweep over "six field kinds" and missed this path.

#### R6-7 DIAGNOSIS — PROVEN, TWO STACKED FAILURES (wave 1, agent W1-F; report `.frenzy/round6/W1-F.md`, 669 lines)

**A CONTROL EXPERIMENT REFINES R6-7.2, WHICH NAMED THE WRONG SITE.** The IDENTICAL
`ATMOSPHERE_FILL_PARAMS`, spread into globe_map's `customProps` instead, **ACCEPTS
`=time` and evaluates it to 2 with zero errors.** So the declaration is innocent (as
R6-7.2 said) but the failing path is specifically **PaintField's material-param rows plus
`resultKindForSlot`** — not the globe_map spread that R6-7.2 pointed at.

**FAILURE 1 — THE UI NEVER OFFERS THE SEAM.** `web/Inspector.svelte:697` reads
`if (!EQUATION_KINDS.has(rowKind(row)) || row.paint) return false;` — **`equationCapable`
excludes `row.paint` outright** (lead-verified verbatim), and PaintField is one row's
CONTROL (`Inspector.svelte:1622`), so nothing inside it can reach the Tier-0 equation
seam. Inside, the knobs mount BARE widgets with no `onedit`/`ontext` and no ƒ:
`web/PaintField.svelte:797-806` mounts a bare `DraggableNumber` instead of
`NumericField`; `color` -> bare ColorField `:762`; `select` -> bare Dropdown `:776`;
`boolean` -> a native checkbox `:784`.

**FAILURE 2 — THE CORE REJECTS THE PATH.** `core/expressions.js:1655`
`resultKindForSlot` types every `<paint>.material.params.*` as `"unresolved"`, so it is
refused; and `fallbackFor` (`:2313`) then writes **0, NOT the schema default**. Browser
evidence: typing `=time` stores nothing, shows red text, and logs only
`DraggableNumber: "=time" is not a number`. Forced into the document by hand:
`stored "=time"` -> `evaluated 0`. So even the escape hatch silently yields zero.

**SCOPE MEASURED: 294 knobs across 22 materials** (16 fill + 6 stroke) on 3 paint slots;
plugin materials inherit the defect through `core/material_plugins.js:594`. Census in the
report.

**THE CLAMP QUESTION IS ANSWERED — NON-ISSUE.** `core/properties.js:43-59` plus
`web/NumericField.svelte:42-46`: equations are NEVER clamped; min/max bound the DRAG
only. Atmosphere's own bounds are mixed — `rimPower`'s floor is technical, while
`rimStrength` 3 / `haloWidth` 1 / `rimPower` 12 are taste — and should be respelled
`scrubMin`/`scrubMax`, but that is off the critical path.

**MINIMAL FIX, ALL THREE PARTS HAVE PRECEDENT:** (a) add a `materialParamKind` step to
`resultKindForSlot` — layering is fine, `expressions.js:117` already imports from
`render_gpu`, and there is exactly ONE production caller (`:2303`) which already has the
item in scope; (b) mount `NumericField` / `AngleField` / the Tier-0 control in the knob
rows, using the `value`-fallback pattern **AngleField already has** (`:233`) and that
PaintField itself already uses (`:898`), so sparse params survive; (c) a per-knob ◆
keyframe affordance.

**THE `Inspector.svelte:852` BUG IS NOW CONFIRMED BY TWO INDEPENDENT AGENTS AND BY THE
LEAD.** Verbatim: `eqDraft = equationSeed(getPath(app.state(), path));` — `path` is
undeclared, so clicking the Tier-0 ƒ throws `ReferenceError: path is not defined` on
**every** color/boolean/select/asset/text row, and because `eqOpenKey` is set first the
entry opens UNSEEDED. Fix it together with R6-7.

**OTHER EQUATION-REFUSING PATHS, RANKED** (this is the "hunt them all down" list the user
asked for): rich-text content/runs (no row AND an undeclared array — fails at both
layers); `kind:"list"` rows; non-numeric list ELEMENT fields
(`web/ListField.svelte:657-670`); **MIXED multi-select rows lose ƒ on EVERY kind**
(`:1344-1364` precede `:1365`), which contradicts the comment at `:654-658`;
`visibleWhen` drops the row entirely (`:298`); transition rows; variables are
number-only by fiat.

**Violations recorded:** native checkbox at `PaintField.svelte:784` versus
`tests/boolean_uniformity_probe.js:12-17`'s "ZERO native checkboxes" claim — so the probe
asserts something false; stale comment at `Inspector.svelte:690-693`, contradicted by
`core/properties.js:784`; an unexplained camera carve-out at
`boolean_uniformity_probe.js:232`; `kind:"stops"` sits outside `ROW_KINDS` so
`customProps` throws on it; and `app.addItem` returns `undefined` while two probes read
its return value as an id.

### R6-8 NESTED SECTIONS / SUB-DROPDOWNS

- **R6-8.1** Every sub-section gets the draggable label/value divider, identical to
  the top-level one.

#### R6-8.1a THE DIVIDER RULE, FULLY SPECIFIED BY THE USER (2026-08-01) — supersedes the one-line R6-8.1 above

**"IDENTICAL" MEANS THE SAME KIND OF UI, NOT THE SAME LINE.** Same vertical drag handle,
same CSS, same hover-to-reveal, same occlusion and hiding behaviour — but a DIFFERENT
instance controlling a DIFFERENT number. The existing one governs the regular property rows;
this one governs **VARIABLE PROPERTIES** (gradients and the like).

**THE MECHANISM ALREADY EXISTS — this is a second instance of a shipped pattern, not new
machinery.** `web/LabelDivider.svelte` is the component, and its docblock already records the
user's original wording. Its shape: **one instance per rows BLOCK, each spanning only its own
block (that is the "multiple lines"), but every instance positioned from ONE app-level
fraction** (`app.labelFrac`, published as `--a-label-frac` on the app root). Dragging any one
moves all of them **because they are readouts of one number, not N independent handles.**
Existing consumers: `web/Inspector.svelte`, `web/VariablesPanel.svelte`, `web/PaintField.svelte`.

**THE KEY IS (NESTING LEVEL, DIVIDER TYPE).** User, verbatim in substance:
- *"Within a level and a type of divider it will be synchronized across all of them"* — which
  is why dragging the regular-property divider today moves fill material, stroke and position
  together: same level, all declared the same type.
- *"If there was a second level that second level would not be synced with the first level,
  because then that would make them collide visually."* **Depths are INDEPENDENT.** The reason
  is sound and worth recording: two vertical lines a few pixels apart read as BROKEN
  ALIGNMENT rather than as two deliberate handles, so each depth needs its own number in order
  to be placed clearly apart.
- **PROPORTIONALITY IS WHAT MAKES NESTING FREE:** *"they're proportional so the dividing line
  is fine even when we have nested sections, because it's just a smaller proportion, it's
  closer to the right of the screen."* A nested block is narrower, so the same fraction lands
  further right in absolute terms with no special-casing. **Nesting therefore needs only a
  per-depth key, not new layout logic.**

**PERSISTENCE — the user hedged ("I think") and he was RIGHT; the precedent is verbatim in the
code.** `web/FontPicker.svelte`'s `<script module>` block: *"MODULE scope so it survives the
picker closing + reopening within a session … a full page reload resets it."* So: **module-level
session state. It survives clicking off a widget and back on; a browser reload resets it. NOT
localStorage, NOT the document.** A divider fraction is editor chrome — putting it in the
document would make it keyframe, tween and appear in renders.

**CORRECTION, ON IMPLEMENTATION (2026-08-01): "NOT localStorage" IS THE PART THAT WAS WRONG,
and the code is right to ignore it.** The FontPicker precedent is real, but the divider fraction
this section is about has ALWAYS been localStorage (`web/app.svelte.js:213`) — I generalised
from a neighbouring control instead of reading the one under discussion. The consequence made
the error obvious the moment it was built: the NEW keyed family would persist LESS than the old
single fraction it generalises, so the same gesture on two dividers would behave differently,
which contradicts this section's own "identical means the same kind of UI". The alternatives
were to weaken the existing divider — an unrequested regression to a control the user already
relies on — or to weaken only the new one. **Both dividers use the existing localStorage
mechanism. The document exclusion stands** (editor chrome must never keyframe or render); only
the localStorage half is retracted. If reload-reset is genuinely wanted it changes the EXISTING
divider too, and should be decided as one thing rather than arrived at by a new feature
quietly disagreeing with an old one.

**SCOPE NOTE FOR IMPLEMENTATION:** nesting is DEFERRED by the user's own instruction
("don't worry about nested yet"), so with one flat variable-property fraction the "same level"
question does not yet arise — but the fraction MUST be keyed from the start so that adding
depth later is a key change and not a rewrite.

**A LIKELY SHORTCUT, TO BE CHECKED BEFORE BUILDING:** `web/PaintField.svelte` is ALREADY a
`LabelDivider` consumer, and its comment at `:753` mentions "divider drags and their labels
truncate under the ƒ gutter". So variable properties may already be wired to the SINGLE
existing fraction — in which case this work is **SPLITTING one fraction into two keyed ones**,
not adding a mechanism, and the diff is much smaller than R6-8.1 implies. **File-ownership
warning: `web/PaintField.svelte` is held by the equations agent and `web/Inspector.svelte` by
the Inspector-UI agent, so the split must be coordinated between them rather than raced.**
- **R6-8.2** GENERALISE nested sections into ONE reusable, arbitrarily-deep
  component: "we will have many nested drop downs in the future, including for
  example having an entirely second widget in a nested drop down." Large refactor;
  must be clean.
- **R6-8.3** Properties under Atmosphere are MISALIGNED — "just tiny numbers,
  mismatched widths" instead of stretching to the right edge like every other row.
- **R6-8.4** The Atmosphere knobs have ROUNDED CORNERS — "a big no no... probably
  just X-ray CSS that could be deleted." They must inherit square styling
  (`app.css:22`: `--radius` is for `src/lib` components only; app chrome is square).

### R6-9 SKY MATERIAL

- **R6-9.1** Stars STRETCH when the sky is stretched. They need their own scale,
  controllable with respect to PIXEL SPACE, independent of the widget box.
- **R6-9.2** Galaxy textures are NOT SEAMLESS — investigate the seams. Precedent
  remedy: rainy-window v2 went fully procedural to kill seams (task #104).

### R6-10 MAP WIDGET

- **R6-10.1** QUARANTINE it — "a hot mess right now."
- **R6-10.2** Recorded symptom: renders correctly in editor and presentation, NOT
  to MP4.

### R6-11 RENDERER != EDITOR — THE RED FLAG (highest priority)

- **R6-11.1** Fancy arrow + dark drop shadow shows LINES BETWEEN ALL THE TRIANGLES,
  in the editor. Without a shadow they do not appear. Turning anti-aliasing OFF
  makes the gaps GO AWAY — so it is the GEOMETRY, not the shading.
- **R6-11.2** "Why is it triangulated like this? Doesn't Skia allow us to paint
  entire surfaces? Are we rendering individual triangles? Because I can see gaps
  between them."
- **R6-11.3 THE ACTUAL RED FLAG.** The donut shows triangles in the SLIDE
  THUMBNAILS but NOT in the editor. "Why is there a disconnect between the renderer
  there and the renderer that I see on my screen in the editor? I thought they were
  supposed to be the same back end. This is a red flag for me." Thumbnails go
  through `gpuService`'s offscreen compositor, the editor through `CanvasView`;
  both are meant to be the same Skia painter over the same display list.
- **R6-11.4** Gradients and pattern materials apply PER TRIANGLE — "It's not the
  way it's supposed to work, like I'm not supposed to know about the triangles."
- **R6-11.5** Maps render wrong to MP4 (same family as R6-10.2).
- **R6-11.6 GOVERNING PRINCIPLE:** "this should always be rendering the same way,
  wherever possible." Cf. the repo CLAUDE.md's "THE RENDERER IS ONE CODE PATH".
- **R6-11.7 HYPOTHESIS worth testing:** one root cause here may also explain R6-12.1
  (video absent from Render Center) and R6-10.2/R6-11.5 (maps wrong to MP4).

#### R6-11 DIAGNOSIS — PROVEN, WITH PIXEL MEASUREMENTS (wave 1, agent W1-A; report `.frenzy/round6/W1-A.md`, 54 PNGs in `.frenzy/round6/W1-A-shots/`)

**THE USER WAS RIGHT ON EVERY POINT, INCLUDING "IT'S THE GEOMETRY".**

- **YES, THE SHAPES ARE GENUINELY TRIANGULATED.** Donut and fancy arrow emit **one
  `polygon` IR op PER TRIANGLE** — 133 ops in the test fixture, 128 of them the donut.
  `plugins/donut.js:125-127`, `plugins/fancy_arrow.js:223-232`,
  `assets/builtin/library/donut.plugin.js:114`. Each is painted as its own `drawPath`
  with AA on at `render_gpu/skia/paint_skia.js:674-683`. Two abutting antialiased fills
  conflate to **192/255** — exactly the predicted 0.5 + 0.25 + 0.25 double-blend. That
  is the visible crack.
- **THE EDITOR/THUMBNAIL DIVERGENCE IS THE SURFACE SAMPLE COUNT, AND NOTHING ELSE.**
  Editor: `web/CanvasView.svelte:425` -> `browser_surface.js:57` context
  `antialias:1` -> `:123` `MakeOnScreenGLSurface` = **sampleCnt 4** (measured 4 at six
  sizes and across five resizes). Thumbnails, minimap, PNG export, PDF raster, slide
  fades and **EVERY MP4 FRAME**: `web/gpuService.js:113` context `antialias:0` ->
  `:160` `MakeRenderTarget` = **1 sample**. The IR is IDENTICAL: with AA off, renders
  from the two paths are **byte-identical, max diff 0**.
- **MEASURED:** same document at the same 800x450 — editor **0 seam pixels**,
  thumbnail **12,308**. Scale and DPR ruled out (editor stays clean 400x225 ->
  1920x1080). Proxy render quality ruled out (full vs proxy diff **max 0**), so
  task #83's proxy path is NOT implicated.
- **WHY A SHADOW REVEALS SEAMS IN THE EDITOR:** `shadow.opacity > 0` alone wraps the
  node in `effectSubtree` (`render_gpu/effects.js:168,217`) whose scratch surface is
  `paint_skia.js:3324` -> `MakeRenderTarget` = **1 sample**. The shadow itself is drawn
  ONCE from the composited silhouette (`:3338`, `:3381`), not per triangle — so the
  seams come from the 1-sample scratch, not from the shadow. AA off => hard coverage
  tiles exactly => 0 seams.
- **R6-11.4 PROVEN AND IT SHARES THE FIX:** `paint_skia.js:679` passes
  `pointsBounds(cmd.points)` — the **individual triangle's** bounds — as the
  gradient/material frame, whereas `drawPathOp:938-940` correctly uses whole-path
  bounds. So one change closes R6-11.1 through R6-11.4 together.
- **THE FIX IS DICTATED BY PRECEDENT, NOT CHOSEN.** The convex-only `polygon` op is a
  **FOSSIL of the retired WebGPU mesh renderer** (`5eb60d3`, 2026-07-14;
  `render_gpu/FINDINGS.md:185`). The `path` op WITH `fillRule` landed in `c0646a5`,
  2026-07-23, in all three backends. `plugins/donut.js:48` literally says *"revisit
  if/when an IR path op with fill-rule support lands"* — the condition was met and
  never actioned. `core/outline.js:678` already names the donut as the leftover,
  `plugins/shapeshifter.js:936-945` is the working template, and `ringSectorOutline`
  already returns `[outer, inner]`. MEASURED: one outline op gives **zero seams at 1
  sample at every size**. Change BOTH donut copies together and pin with a parity test.
  Gate it with a BARE-NODE test — the software surface reproduces the defect (min 192);
  precedent `tests/vector_pattern_seam_test.js`.
- **DO NOT "FIX" IT BY FLIPPING `gpuService` TO `antialias:1`.** Measured:
  `MakeRenderTarget` on an MSAA context is still 1 sample. An MSAA drop-in exists but
  only MASKS the double-blend and leaves `cli/render.js` (software, min 166) worse.

**R6-11.7 IS ANSWERED: NO. MY UNIFICATION HYPOTHESIS WAS WRONG — there are THREE
independent mechanisms, and they must be fixed separately.**
1. **Triangulation + sample count** (above) — the donut/arrow/gradient family.
2. **MAPS: `web/gpuService.js:320` calls `cameraFrameIR` with NO `view` argument**, so
   `web/cameraFrame.js:162,169` skips the tile pre-pass and **zero tiles are ever
   requested**. BONUS, PREVIOUSLY UNREPORTED: the same line also kills **PDF
   re-raster** in every one-shot pixel consumer.
3. **VIDEO: only `web/renderJobPage.js:150` has `settledFrame`.**
   `web/browserRenderJobs.js:297` and `web/app.svelte.js:5733` ship COLD frames, and a
   latched `status:"error"` **removes itself from the pending set**, so the hole is
   silent and the job exits 0 — a loud-failure violation on top of the bug.
4. Metaball (R6-15.1) **did not reproduce** — 0 of 921,600 pixels. W1-D must re-scope.

**THE REAL THEME IS BROADER AND MORE USEFUL THAN THE HYPOTHESIS:** the editor and the
one-shot pixel path are different renderers in FOUR ways — multisampling, the `view`
argument, async settling, and device bounds (the last measured at zero effect so far).
`web/cameraFrame.js:20-24` already admits "one code path" is not yet true. That is the
gap to close, and R6-11.6's principle is the standard to hold it to.

#### R6-11 FINAL RESULT — AND IT REVERSES TWO THINGS THE LEAD ASSERTED

**MEASURED, BOTH PATHS, RING INTERIOR** (`.frenzy/round6/W2-A-shots/`; `sampleCnt()` re-read
as 4 vs 1 at each size, two real surfaces):

| path | 400x225 | 800x450 | 1280x720 | 1920x1080 |
|---|---|---|---|---|
| editor (4-sample) | 0 -> **0** | 0 -> **0** | 0 -> **0** | 0 -> **0** |
| offscreen (1-sample) | 5555 -> **0** | 12308 -> **0** | 20603 -> **0** | 31876 -> **0** |

Interiors are now perfectly flat (min == max). Software surface: donut **128 ops / min 158 -> 1
op / min 255**; arrow **5 / 191 -> 1 / 255**. **R6-11.4 measured directly:** a gradient walk
along the ring went from **31 local maxima to 0**, monotone. SVG emits one `<path>` with no `A`;
PDF emits `f` only — zero `f*`, zero `B` — and stays vector. Test proven to fail pre-fix
(`2629 !== 0` at the first size with the edits stashed). **Full gate A/B on clean worktrees at
`6c38dd9^` vs `a7d51b9`: ZERO regressions**, every delta re-run individually and shown
pre-existing or a load-flake.

**`fillRule: "nonzero"` — DECIDED BY PIXELS, NOT REASONING.** `donutOutline` walks the inner rim
BACKWARD, so the rims are oppositely wound and nonzero punches the hole with NO change to the
point list. All three candidates measured 0 seam px at every size — keyhole+nonzero, two
subpaths+evenodd, and a control of two subpaths+*nonzero* which is the direct proof of the
winding — with silhouettes identical to 0 px. The tie-break was therefore option (a)'s property:
`donutRingOutline` stays ONE flat list that `emit` and `hitTest` both read. **The bridge-hairline
risk I flagged did NOT materialise — it was checked, not assumed.**

**REVERSAL 1 — THE `polygon` OP MUST NOT BE RETIRED, AND `pointsBounds` MUST NOT BE TOUCHED.**
I told the user the opposite: that retiring the op was "the step that makes it structural" and
that the per-triangle material frame would become unreachable. **Both are wrong.** There are
**13 live producers across 9 files** (arrow/curved/elbow heads, `line.js` caps, the globe polar
cap, video v7/v8 glyphs, clock hands + bezel, filmstrip), and **per-op bounds is CORRECT for the
op — one op is one shape.** The defect was ever emitting ONE SHAPE AS N OPS, so the op-count fix
closes R6-11.4 completely; changing `pointsBounds` would BREAK the arrowheads for nothing.
**THE RULE IS THEREFORE: a lone polygon per shape is fine; fan-emitting one shape as many
adjacent polygons is the sin.** That is the thing to hunt, not the op.

**REVERSAL 2 — FILMSTRIP IS NOT THE "PLAIN RECTANGLES" WART.** I called it "the least defensible
case". Measured: two perforated bands are **480 polygon ops with 1405 of 3332 partial-coverage
pixels**, and the plain-rect degenerate branch is only **299** of that.
`perforatedBandPolygons`/`cellWithHole` return triangles **BY CONTRACT**, so converting just
`:550,:600` forks that contract for a fifth of the benefit. **Correct fix, sized as a sibling
task:** return SUBPATHS (band rect + one loop per hole), emit one `evenodd` path op, delete
`cellWithHole`.

**THE STALE DOCTRINE COMMENT WAS IN FOUR PLACES, NOT TWO — and one was actively manufacturing
the bug.** Beyond both donut copies: `core/outline.js`'s `DONUT_SEGMENTS` comment they cited as
evidence, and — worst — **`core/plugin_assets.js`'s sandbox docblock was INSTRUCTING EVERY FUTURE
PLUGIN AUTHOR TO EAR-CLIP CONCAVE SHAPES.** All four fixed, plus `core/builtin_plugin_assets.js`,
`fancyArrowOutline`'s "degrades loudly" claim, `donutOutline`'s slit rationale,
`fancy_arrow.js:7`, and 8 scene comments. Two `emit`s were relabelled `Near-pure` -> `Pure`
(now true), and `DONUT_ANGLE_JITTER` labelled vestigial (removing it would move geometry for no
benefit).

**VIOLATIONS FOUND, NOT FIXED — two are gate integrity problems:**
- **`render_gpu/tests/svg_scenes.js` HAS NO IMPORTER** — dead since `67ffcd0`, so its load-time
  drift guard has NEVER RUN.
- **Three gate tests ENOENT on `projects/Imitations/assets`, a directory that does not exist** —
  i.e. **the canonical gate depends on the user's own project data.** That is a portability
  defect of the same family as R6-24.2's absolute path.
- W1-A's `seams_work.mjs` measurement harness corrupts tail renders past ~20 surfaces per page;
  its BEFORE numbers still reproduce on fresh pages.

**LEAD IMPLEMENTATION NOTES for R6-11 (written while scoping — SUPERSEDED in part by the
reversals above; kept because the geometry facts stand):**
- `donutRingOutline` is **local to `plugins/donut.js:84`**, not in `core/outline.js`, and it
  returns **ONE FLAT KEYHOLE POLYGON** — outer loop, a zero-width bridge, then the inner
  loop reversed — which is precisely why it is ear-clipped. Its doctest at `:82` confirms a
  flat point list (`[0]` is `[20, 10]`, a single point), NOT an array of subpaths. So the
  `ringSectorOutline` "already returns [outer, inner]" note does NOT apply here; that is a
  different function.
- **`hitTest` SHARES that geometry** (`plugins/donut.js:154` calls
  `pointInPolygon(donutRingOutline(...))`), so whatever is done must keep the hit test
  correct — changing the outline's return shape has a second consumer.
- **Therefore two candidate fixes, and the choice must be MEASURED, not reasoned:**
  (a) emit the EXISTING keyhole point list as ONE `path` with `fillRule:"nonzero"` — the
  inner loop is already counter-wound (that is what makes it ear-clippable), so nonzero
  should punch the hole; minimal diff, hit test untouched. RISK: the zero-width bridge's
  coincident edges can leave a hairline in some rasterizers, which is exactly the class of
  artefact being fixed, so it MUST be pixel-checked, not assumed.
  (b) return TWO subpaths (outer, inner) and use `fillRule:"evenodd"` — geometrically
  cleaner and bridge-free, but changes the outline's contract and so requires updating the
  `pointInPolygon` hit test too.
  **Decide by rendering both at 1 sample and counting seam pixels**, the same method W1-A
  used. Prefer (a) if it measures clean, because it does not disturb the hit test.
- `subpathsPathD` is NOT in `core/outline.js`; find its real home before importing it
  (`plugins/shapeshifter.js` uses it, so trace that import).

**Violations recorded:** `web/gpuService.js:111-113`'s comment asserts that coverage-AA
is equivalent to MSAA — FALSIFIED, and it is the written rationale FOR the bug;
donut's stale "no evenodd anywhere" claim in both copies; `paint_skia.js:708`
`if (!img) break;` is a silent failure in one-shot contexts where its excusing
contract does not hold; `map_display.js`'s own report misdirects blame to
`cli/render_job.js`, which has the same defect; `plugins/filmstrip.js:550,600`
triangulates plain rectangles for no reason.

#### R6-11 LANDED — DONUT + FANCY ARROW (wave 2, agent W2-A; commits `6c38dd9`, `a7d51b9`; measurement harnesses + PNGs in `.frenzy/round6/W2-A-work/` and `.frenzy/round6/W2-A-shots/`)

**CANDIDATE (a) WON, ON PIXELS.** The donut emits the EXISTING keyhole point list as
ONE `path` op with `fillRule: "nonzero"`; the fancy arrow emits its 7-point outline
the same way. Both rules were rendered and censused: (a) keyhole+nonzero, (b) two
subpaths+evenodd, and a control (two subpaths+NONZERO, which also works and is the
direct proof that donutOutline's rims are oppositely wound). All three give **zero
seam pixels at 100/200/400/600 px** and their silhouettes are **identical to 0 px**.
So the tie-break is (a)'s: `donutRingOutline` stays ONE flat point list, which
`hitTest`'s `pointInPolygon` reads unchanged — picture and hit region cannot drift.
**THE BRIDGE HAIRLINE RISK DID NOT MATERIALIZE** and was checked rather than assumed.

**BEFORE → AFTER, through `paintIR` on `CanvasKit.MakeSurface` (the software surface
`cli/render.js` uses), interior census of the solid body:**

| widget | size | ops before | min/seam before | ops after | min/seam after |
|---|---|---|---|---|---|
| donut (BOTH copies) | 100 | 128 | 163, 2 629/4 476 | 1 | 255, **0** |
| donut (BOTH copies) | 600 | 128 | 158, 29 123/203 560 | 1 | 255, **0** |
| fancy arrow | 600 | 5 | 191, 185/4 160 | 1 | 255, **0** |

**R6-11.4 MEASURED, NOT JUST ARGUED.** A donut filled with a horizontal black→white
linear gradient, walked along a chord through the ring: **before, 31 local maxima**
(the ramp restarts inside every triangle it crosses, and the endpoints read 211→114
— scrambled). **After, 0 maxima, monotone 47→209.** One op, one gradient frame.

**DO NOT TOUCH `paint_skia.js`'s `pointsBounds` — that would be the wrong fix, and
this reverses the scoping note's implication.** Per-op bounds is the CORRECT
semantics for the `polygon` op as specified: the op IS a shape. The defect was never
`pointsBounds`; it was ONE LOGICAL SHAPE EMITTED AS N OPS. For every remaining
producer the op is a whole shape and the frame is right. So the op-count fix closes
R6-11.4 completely, and a `pointsBounds` change would break the arrowheads.

**THE `polygon` OP IS NOT RETIRABLE — 13 live producers across 9 files remain**, and
12 of them are legitimate (one op = one shape): `plugins/arrow.js:123-124`,
`curved_arrow.js:127-128`, `elbow_arrow.js:135-136` (arrow heads),
`plugins/line.js:185` (caps), `plugins/demo/globe_map.js:552` (polar cap),
`plugins/demo/video_v7.js:119` + `video_v8.js:111` (play glyphs),
`assets/builtin/library/clock_analog.plugin.js:807,812` (hands + bezel). Keep the op;
retire the PATTERN of splitting a shape across it.

**THE 13TH IS `plugins/filmstrip.js:851`, AND IT IS THE SAME BUG AT A LARGER SCALE —
NOT the "plain rectangles" wart the scoping note described. MEASURED:** a default
480x90 strip's two perforated bands emit **480 `polygon` ops** and show **1 405
partial-coverage pixels out of 3 332** in the band interior; even the degenerate
SOLID branch (`:550`, `:600` — the plain rectangles) cracks at min 191 with 299
pixels, because a 2-triangle rect still has a diagonal. **LEFT ALONE DELIBERATELY,
with a reason:** `perforatedBandPolygons` and `cellWithHole` return a TRIANGLE LIST
by contract, and `cellWithHole`'s whole four-sector machinery exists only to tile the
annulus around a hole. Converting the two degenerate lines alone would fix 299 of
1 405 pixels while FORKING the return contract (some calls triangles, some IR ops).
**THE RIGHT FIX, sized for a sibling task:** return SUBPATHS — the band rect plus one
closed rounded-rect loop per hole — and emit one `path` op with `fillRule: "evenodd"`.
That deletes `cellWithHole` entirely. Touches `filmBandOps`, both generators' doctests
and `tests/filmstrip_test.js`.

**THE GATE: `tests/widget_fill_seam_test.js`** (bare node, no browser — the software
surface reproduces the defect faithfully; `tests/vector_pattern_seam_test.js`
precedent). **VERIFIED TO FAIL ON PRE-FIX CODE** (2 629 ≠ 0 at the first size). It
asserts the seam property on BOTH donut copies — the parity baseline AND the SHIPPED
asset resolved through the real registry — which is a different claim from
`tests/builtin_asset_library_test.js`'s deep-equal, not a duplicate of it. It also
asserts the shape is still RIGHT (hole empty, no spill, area within 2% of the
analytic annulus, arrow tip inked), because a blank frame passes a seam check
trivially. Its erosion margin is DERIVED, not picked: 1 px of antialiased edge +
the polygonal rim's chord sagitta `r·(1 − cos(π/segments))` + 1 px of margin.

**STALE DOCTRINE FIXED IN FOUR PLACES, not the two the scoping note listed.** The
claim "no evenodd/fillRule anywhere in render_gpu (verified)" was ALSO in
`core/outline.js`'s `DONUT_SEGMENTS` comment — which both donut copies CITED BY NAME
as their evidence — and its consequence was restated in `core/plugin_assets.js` ("the
IR's polygon op is convex-only, so any concave shape must go through `triangulated`",
in the sandbox API docblock, i.e. instructions to every future plugin author) and in
`core/builtin_plugin_assets.js`. Also corrected: `fancyArrowOutline`'s docblock said
the plugin "degrades loudly" on a self-intersecting corner (it no longer can — see
below), and `donutOutline`'s said the slit exists so `triangulated()` can ear-clip it.

**A REPORT WAS RETIRED AND THAT IS NOT A SILENCING.** `fancy_arrow.emit`'s
`try { triangulated() } catch { reportOnce(); return [] }` existed because the
ear-clipper THROWS on the generator's residual self-intersecting parameter corners,
and the widget then drew nothing. A winding rule has no such limit — a
self-intersecting outline is a well-defined figure under non-zero and all three
backends fill it identically — so the configuration STOPPED BEING A FAILURE rather
than stopping being reported. `fancyArrowOutline` returns null or exactly 7 points,
so `polygonPathD`'s `>= 3` guard is unreachable and nothing downstream can throw.
Both emits are now plainly `Pure function`, not `Near-pure`.

**`DONUT_ANGLE_JITTER` IS NOW VESTIGIAL** (`core/outline.js`) — it existed solely to
break exact collinearity for the ear-clipper. Left in place and labelled: removing it
would move every donut vertex by ~1e-5 units for no rendering benefit, and
`tests/outline_test.js` still ear-clips `donutOutline`. Retiring it belongs with
retiring that test, not with the render fix.

**PRE-EXISTING GATE FAILURES CONFIRMED NOT MINE** (each reproduced on a clean
worktree at `6c38dd9^`): `crosshair_probe.js` fails identically at baseline;
`histogram_plugin_test.mjs`, `plugin_asset_doctest_test.js` and
`relative_ref_cli_test.js` all ENOENT on `projects/Imitations/assets`, **a directory
that does not exist — three canonical-gate tests depend on user project data being
present, which is a portability defect in the gate**; `connectivity_seam_test.js`
scans `.frenzy/round6/W1-F-work/deps/.vite/deps/`, another agent's Vite cache, and
should exclude `.frenzy/`. `multiresize_place_probe.js` fails ONLY in the live
working tree (passes on clean worktrees at both `6c38dd9` and `a7d51b9`) — an
uncommitted concurrent edit, with a doubled `src/demo_apps/PowerRP/` path segment.

### R6-12 VIDEO

- **R6-12.1** The video widget DOES NOT APPEAR in Render Center output at all,
  though it looks right in preview. The scrubber does appear.
- **R6-12.2** Add a universal `reveal_time` — the time an item first became visible
  / was first rendered.
- **R6-12.3** COLLAPSE EVERY VIDEO WIDGET INTO ONE, with scrub position defaulting
  to `time - self.reveal_time`, so a video starts when revealed and plays on. The
  scrubber becomes that same widget with a different default. "Get rid of all the
  other video widgets and only have one from now on."
#### R6-12 DIAGNOSIS (wave 1, agent W1-B; report `.frenzy/round6/W1-B.md`, frames in `.frenzy/round6/W1-B-shots/`)

**R6-12.1 IS NOT REPRODUCIBLE AS WORDED on the default (server) backend.**
`plugins/video.js` was rendered through `cli/render_job.js` with data URIs, BOTH asset-ref
grammars, and the user's own 1920x528 and 2560x1408 clips — **it rendered every time**.
**AND: folding `projects/Untitled cheese/doc.json` shows every `type:"video"` item in it is
`active:false` on EVERY slide.** So at least one candidate explanation is that the items
were keyframed inactive, not dropped by the renderer. NOT concluded — the job's collected
`consoleErrors` (`cli/render_job.js:414-418`, surfaced by `server.py`) from the user's
ACTUAL failing render would settle it in one look. **ASK FOR THAT before building anything
on R6-12.1.**

**WHAT WAS PROVEN INSTEAD, each by a real render:**
- **A SILENT HOLE THAT EXITS 0 — this is the mechanism that produces the reported symptom.**
  A player whose `src` fails to load draws NOTHING and the job SUCCEEDS.
  `render_gpu/gpu/video_registry.js:356-360 pendingVideoSrcs()` selects only `"loading"`, so
  an ERRORED src is never pending; `web/renderJobPage.js:156` returns immediately, the stall
  detector at `:162` never fires, and `paint_skia.js:708 if (!img) break;` silently skips.
  Evidence `H_badplayer_hole.png`. A CLAUDE.md silent-failure violation.
- **A SCRUBBER DEADLOCK — SHOWSTOPPER.** `video_registry.js:690-713`: the scrub element's
  `error` listener NEVER resolves `entry.ready`, so `:791 await entry.ready` in
  `requestScrubFrame` never settles, and `browser_media.js:122` -> `gpuService.js:242` ->
  `renderJobPage.js:151` all block. MEASURED: **exit 124 at 150 s, zero frames.** The guard
  at `:792` is unreachable dead code.
- **A FRESH UNSOURCED SCRUBBER HITS THAT DEADLOCK.** `BLANK_SRC` is a **PNG data URI**, and a
  `<video>` REJECTS it (`MediaError code 4: Unable to load URL due to content type`). The
  docblocks at `plugins/video.js:70-76` and `plugins/video_scrub.js:106-112` claim otherwise
  and are factually wrong. So: insert a scrubber, do not pick a source, render — **it hangs
  forever.**
- **v6/v7/v8 render only a dark poster** in every Skia path, because they are overlay-based.
- **The player is NON-DETERMINISTIC server-side:** same job, same frame index, two runs ->
  different md5.
- **No settle loop** in `web/browserRenderJobs.js:297` or `web/app.svelte.js:5733` (only
  `renderJobPage.js:207` has one), and `web/videoExport.js` has ZERO media awareness.

**MINIMAL FIX: resolve `entry.ready` from the error listener — ONE LINE** — then add a
`failedMediaRefs()` that `settledFrame` THROWS on, so a hole becomes loud instead of silent.

> ### ⚠ STATUS 2026-08-02: THREE OF THE FOUR ABOVE ARE FIXED. THIS SECTION WAS STILL
> ### TEACHING THEM AS OPEN, AND THE LEAD NEARLY RE-FIXED ONE.
>
> Checked in the CODE, not from memory, during a saturation sweep — after this section
> had already caused a task (#295) to be filed for a bug that no longer exists:
>
> - **THE SCRUBBER DEADLOCK IS FIXED** — `8d5251b` "A failed video load is an ANSWER, not
>   an absence". `video_registry.js` now settles `entry.ready` from the `error` listener
>   via `settleReady()`, and the docblock at the site narrates this diagnosis, the 150 s /
>   zero-frames measurement and the MediaError-code-4 BLANK_SRC trap. The `status ===
>   "error"` guard is reachable now, not dead code.
> - **THE SILENT HOLE IS FIXED** — `14905df` "A RENDER MAY NOT SHIP A HOLE". `failedVideoSrcs()`
>   exists as the deliberate COUNTERPART of `pendingVideoSrcs()`, and its docblock states the
>   partition bug exactly: "pending" means wait longer, an errored src falls in NEITHER half,
>   so the worker wrote a holed frame and exited 0.
> - **THE TWO WRONG `BLANK_SRC` DOCBLOCKS ARE REWRITTEN.**
> - **BOTH FIXES ARE GATED** by `tests/unsourced_media_test.js` (3 checks, green), so they
>   cannot silently regress.
>
> **STILL OPEN, AND VERIFIED STILL OPEN:** the INERT autoplay / loop / muted rows.
> `ensureVideo(src, flags)` still has exactly ONE production call site
> (`video_registry.js:255`) and it still passes no flags. **This one is a DELIBERATE
> deferral, not an oversight** — `plugins/video.js:168-182` says so out loud, names the
> two-line shape that would fix it (`ir.js video()` carrying the flags as the sibling
> `videoV2` op already does, plus the read in `browser_media.sceneMedia`), and defers it
> to R6-12.3 because collapsing every video widget onto the deterministic scrubber model
> decides whether a wall-clock playback flag survives at all. Tracked as its own task.
>
> **THE LESSON IS THE ONE THIS MANIFEST ALREADY WRITES DOWN ABOUT THE SAVE DOT, and it
> has now happened twice:** *"when a commit reverts a design, the same commit must revert
> its doctrine."* The generalisation is stronger and belongs here — **A COMMIT THAT CLOSES
> A DEFECT MUST CLOSE ITS DIAGNOSIS.** A fixed bug left standing in the manifest is worse
> than an unrecorded one: it is a confident, well-evidenced, *wrong* work item, and the
> better the diagnosis, the more expensive the wasted attempt. Both fix commits wrote
> excellent docblocks at the code and left this section alone, so the code and the manifest
> disagreed for days — and the manifest is the artefact agents are pointed at first.

**SEQUENCING RULING, AND IT REVERSES THE OBVIOUS ORDER: R6-12.3's UNIFICATION SUBSUMES the
overlay and determinism problems but AMPLIFIES the first three — it turns EVERY video into
the hanging case. FIX THE DEADLOCK FIRST, then unify.**

**MAP/MP4 IS A DIFFERENT CAUSE, INDEPENDENTLY CONFIRMING W1-A:** `web/gpuService.js:320`
passes only `{project}` to `cameraFrameIR`, so `web/cameraFrame.js:162`'s `liveView` gate is
false and `mapTiles`/`pdfDisplay` are null in EVERY offscreen path; the map then falls back
to `plugins/demo/globe_map.js:230 FALLBACK_DEVICE_PER_WORLD` and renders **WRONG, not
absent**. The editor (`CanvasView.svelte:657`) and presenter (`PresentMode.svelte:215`) both
DO pass them, so `gpuService` breaks the older precedent. **R6-11.7 is false — now confirmed
twice, independently.** The same gate also kills PDF page re-raster offscreen.

**Violations recorded:** `plugins/video.js:136-140` states the registry reads playback flags
off state — **IT DOES NOT** (`ensureVideo` has ONE call site, `video_registry.js:254`,
passing no flags), so **the autoplay / loop / muted rows are INERT** — another lying control,
same class as R6-24.6; both `BLANK_SRC` docblocks are factually wrong; `gpuService.js:320`
breaks the `PresentMode`/`CanvasView` precedent; `settledFrame` is unshared across three
consumers of one renderer.

- **R6-12.4** Context: a player's current frame is NOT deterministic today
  (`gpu/video_registry.js` has no time-override seam; the `<video>` element runs on
  the browser's own clock). Unifying on the scrubber's model is what makes video
  renderable at all.

### R6-13 RICH TEXT

- **R6-13.1** Font +/- must shift every selected run BY THE SAME DELTA, preserving
  relative differences. Today it flattens everything to one size.
- **R6-13.2** The size number in the floating toolbar must be a SCRUBBABLE number
  widget, draggable like any numeric value.
- **R6-13.3** ANSWER WHERE RICH-TEXT STATE LIVES: "there's the rule that all things
  that I edit should be contained inside the properties. And yet I don't see any
  property that actually contains this rich text... huh, what the fuck is
  happening." Then reconcile it with the core invariant.
#### R6-13 ANSWER + DIAGNOSIS (wave 1, agent W1-H; report `.frenzy/round6/W1-H.md`, measurements `.frenzy/round6/W1-H-measurements.json`)

**WHERE RICH-TEXT STATE LIVES — AND THE ANSWER IS REASSURING.**
`doc.slides[i].delta.items.<id>.text = {runs, paras}`. **It is an ORDINARY PROPERTY. Nothing
is hidden and nothing is privileged.** What is missing is the Inspector **ROW**, not the
property — `plugins/text.js:113-116` omits it deliberately. The write seam is identical to
every other row: `TextEditController:199` -> `web/app.svelte.js:1839`
`setPreview(["items",id,"text"])` -> `commitPreview`. Confirmed against the user's REAL data
(`projects/Untitled cheese/doc.json`, slide 3, item `14ko31ovsn`).

**THE CORE INVARIANT IS SATISFIED.** It is property state folded generically
(`core/deltas.js:30-36` — arrays are leaves, so `runs`/`paras` are two leaves), and it
**keyframes by editing on a slide — measured**. The only things absent are the keyframe
diamond, multi-select entry, and `=`, and **all three are downstream of the missing row**,
not of the storage design. W1-F's finding is confirmed and sharpened: the deciding line is
`core/expressions.js:1798-1801`, where the refusal lives in the WALK rather than the
predicate — `isEquationValue` would happily accept a `text.runs.0.size` path, but nothing
ever generates one.

**THE DOCUMENTED TWEEN BEHAVIOUR IS FALSE, AND THE CODE IS BETTER THAN ITS DOCS.**
`core/richtext.js:32-34` and the dump manifest at `:3293` both say rich text "snaps
discretely". It does not: it **interpolates per-run, per-key** whenever run count and key
sets match — proven both bare-node and live (size 48/18 -> 54/24 at alpha 0.5). **This is a
DOC defect, not a code defect**, and both places must be corrected.

**R6-13.1 — WHY +/- FLATTENS.** `web/TextFormatToolbar.svelte:338 sizeDelta` returns ONE
ABSOLUTE `{size:N}`, and `applyRunStyle:1013` spreads it across every covered run. Measured
on a 48+18 selection, select-all, one step: the toolbar yields **one run at 38**, the
keyboard path (`TextEditController:406` — different code, different base) yields **one run at
50**. So **the two entry points disagree with each other**, and runs also MERGE, destroying
the boundary. A UNIFORM 36->38 is correct, so this is a mixed-selection-only defect.
**FIX:** add a pure `adjustRunSize(runs,start,end,delta,inherited)` to `core/richtext.js`
(precedent: every op there is a named pure primitive; there is no function-delta pattern to
imitate), route BOTH entry points through the controller's `stepSize`, and delete the
toolbar's duplicate `sizeDelta`/`SIZE_STEP`/`DEFAULT_SIZE`. On the resolved/unresolved seam:
it MUST read resolved and write explicit, which is legal here because a click is a user
choice and only selected runs get stamped.

**R6-13.2 — THE SCRUBBABLE SIZE READOUT: use the BARE `src/lib/DraggableNumber.svelte`, NOT
`NumericField`** — because `NumericField`'s `ƒ` would be **a lie**: a run size cannot hold an
equation. Precedent is explicit at `web/app.css:8346` ("a material knob's scrubber is a BARE
DraggableNumber") plus RenderCenterModal. All three hazards were measured clear: pointer-lock
`movementY` is immune to the toolbar's `scale(1/boxScale)`; `onPointerDown` already
preventDefaults and `textEditing` stays true while FontPicker's input takes focus; and the
slot fits (toolbar 516x32, readout 22x24, buttons 26x26). Step needs no declaration —
`defaultStep(36)` = 1 is already right. **It must be RELATIVE, so it builds ON the R6-13.1
fix, not before it.**

**R6-13.4 — THE DEAD DROPDOWNS: the user's claim is TRUE for his actual data, and it is SIX
rows, not two.** Pixel-diffed: a bare run -> the rows work; one styled run -> they work;
**ALL runs styled -> byte-identical output**; the user's real run -> **byte-identical**. **All
three of his decks are that case.** Worse, `Untitled cheese` shows box `36/system/#1a1a2e`
while the glyphs render `76/futura/#000000` — **the rows display a value the canvas
contradicts**. `paras` is materialised too, hence six dead rows. And R6-13.1's flatten bug
MANUFACTURES this state. **PRECEDENT-BACKED ANSWER: HIDE them via `visibleWhen`**
(`web/Inspector.svelte:281-298`), resting on the user's OWN analogous ruling at
`core/properties.js:702-708` — *"I still have stroke width options even when stroke material
is off, which is kind of dumb"* — with 7 rows already doing exactly this and pinned by
`tests/stroke_off_test.js`. **Correctly ruled OUT: `commandUnavailableReason` governs
COMMANDS, not rows — do not invent a row equivalent.** Caveat to accept: `visibleWhen` drops
the `ƒ` along with the row (the same gap R6-7 records).

**Violations recorded:** `SIZE_STEP` is mirrored in two files and **its fallback has ALREADY
DRIFTED** (38 vs 50) — the hand-maintained-mirror class again; `DEFAULT_PARA_SIZE` is `const`
not `export const` (`core/richtext.js:793`), producing **12 re-declarations, one of which
documents itself as a mirror**; stale tween doctrine in two places (above);
`core/document.js:1936` reads a `richText` capability **no plugin declares**; **three text
probes bake in the SHADOWED 11-key run they exist to catch**; magic numbers in
`TextFormatToolbar.svelte:281`'s range input; an un-actioned self-TODO at
`core/expressions.js:1487`; and pervasive `-webkit-` prefixes (15x, codebase-wide, not this
item's fault).

**Process note, to the agent's credit:** its first probe run was contaminated (reused item ids
left a stale edit session); it caught that, fixed it, and re-ran. The numbers above are from
the clean run.

- **R6-13.4** The text widget's size/font dropdowns DO NOTHING for rich text. Rich
  and plain text are fundamentally different; stop offering controls that do not apply.

### R6-14 GROUPS

- **R6-14.1** A SCALE-CHILDREN TOGGLE: whether objects in a group scale when the
  group scales. "Right now, there's no way to make that happen." USER WANTS TO
  DISCUSS THIS ONE before implementation.

### R6-15 METABALL

- **R6-15.1** SCREEN-SPACE BUG: move it toward the edge and only a fraction
  renders; looks correct in view but cuts off wrongly on render. Investigate the
  shader's screen-space assumptions.

### R6-16 EXPRESSIONS AND MATH

- **R6-16.1** Add `direction2` / angle-between so a material can aim at another
  item: "angle2 of self position, flare.x, flare.y."
- **R6-16.2** x/y AS A REAL VECTOR PRIMITIVE — `self.position.x` rather than
  `self.position_x`, anchors included. "This would be a major refactoring though,
  so it needs to be considered carefully and planned thoroughly." PLAN ONLY, no code
  until the plan is reviewed.

### R6-17 NEW WIDGETS

- **R6-17.1 APERTURE** — parameterised, with handles. Feeds R6-3.4 and must stay
  consistent with lens-flare starbursts (R6-3.11).
- **R6-17.2 2D SIDE-SCROLLER** — "ask me about it." BLOCKED on the user's
  description.

### R6-18 DUPLICATE

- **R6-18.1** Duplicating a FANCY ARROW leaves its endpoint handles at the original
  position while the arrow moves; the handles end up detached from the new copy.
  "This is not the first time this happened." Likely the endpoint-pair handle state
  not being remapped to the new item id.
- **R6-18.2** Add DUPLICATE IN PLACE — no offset.

#### R6-18 DIAGNOSIS — PROVEN (W1-A..N wave 1, agent W1-C; full report `.frenzy/round6/W1-C.md`)

MEASURED in the live editor through the real registry command: clone `from`/`to`
identical to the original, clone GAINS `x:16, y:16`, **ink moved by (16,16), handles
moved by (0,0)**.

- **ROOT CAUSE:** `web/app.svelte.js:3025` — `x: bump(clone.x ?? 0), y: bump(clone.y ?? 0)`.
  The clone home **FABRICATES x/y on a widget that has none**. `core/derive.js:273`
  then builds `world: worldTransform(state)` unconditionally, so the clone acquires a
  translate(16,16) and `render_gpu/ports.js:455` paints the ink 16px away.
  `core/endpoints.js:52` returns raw `from`/`to`, which `web/CanvasView.svelte:3332`
  hands to `worldToScreen` with NO world applied. So the HANDLES are right and the
  INK is wrong — the offset is being applied to the wrong properties.
- **MY EARLIER HYPOTHESIS WAS WRONG, and this is recorded so it is not retried:** I
  guessed the copy kept `@id` equations pointing at the original. REFUTED —
  `core/document.js:368` `clonedItemStates` rewrites `@id` refs correctly and the
  endpoints are copied byte-identical.
- **THE INVARIANT BROKEN IS ALREADY WRITTEN DOWN:** `core/registry.js:88` (editPoints
  are WORLD-space) and `core/view.js:103` ("its world is identity ... which is
  precisely why there is no second code path").
- **SCOPE IS WIDER THAN REPORTED.** All FIVE endpoint-pair widgets detach:
  `fancy_arrow`, `arrow`, `line`, `curved_arrow`, `elbow_arrow`. **PASTE has the same
  bug** via the same `#cloneStatesIntoSlide`, and paste is the OLDER entrance
  (`692101d`, 2026-07-14, predating Duplicate) — so by the precedence doctrine paste
  is the reference behaviour. `blur` also gains a phantom transform.
- **WORSE THAN THE VISIBLE SYMPTOM:** the clone's hit test resolves on the ORIGINAL
  (`hitTestAtPaintedInk:false`, `hitTestAtHandles:true`), band-select's AABB follows
  the ink so the two disagree, and the fabricated x/y has **NO Inspector row** — it is
  invisible, uneditable, and SURVIVES SAVE.
- **THE FIX IS TO STOP BYPASSING AN EXISTING RULE**, not to add a special case:
  `web/canvas/dragKinds.js:102` `translationPairs` is "the ONE translation rule" and
  already does `if (plugin.moveBy) ... else write x/y`. Drag, drag-all, modal grab and
  nudge all route through it; the clone home is the SOLE bypass. Route the clone offset
  through it, and drop the `?? 0` that invents the coordinate.
- **R6-18.2 FOLLOWS FROM 18.1:** parameterised palette commands are BANNED
  (`web/App.svelte:1006`), so "duplicate in place" is a SIBLING registry entry beside
  `duplicate` (`web/App.svelte:1496`), palette-only with no chord (`Cmd+D` itself is
  still unratified), and the offset becomes a parameter of the private clone home
  rather than a second clone path. **NAME COLLISION TO AVOID:**
  `web/App.svelte:1494` already uses "in place" to mean "no clipboard trip". Do 18.1
  first; then in-place is simply dx=dy=0.
- **TEST GAP:** only `tests/clipboard_duplicate_probe.js` covers duplicate and it uses
  a filmstrip; the string "arrow" appears in it ZERO times.

#### R6-18 ENVIRONMENT REPAIR (verified by the lead, not just reported)

`node_modules` was missing two DECLARED dependencies — `fflate@^0.8.3` and
`monaco-editor@^0.52.2` — and **the live editor on 3637 could not boot**
(`Failed to resolve import "fflate"`). Installed additively at the exact declared
versions; no app file touched, no process restarted. Lead verification: both present
at 0.8.3 / 0.52.2, `GET /` returns 200, `/main.js` resolves, `git status` clean.
LESSON: a missing declared dep presents as an app-level import crash, so check
`node_modules` against `package.json` BEFORE believing a boot failure is a regression.

#### LEAD RULING on one flagged "violation" (R6-22.4 requires a decision, not a sweep)

W1-C flagged OS/browser names in comments at `web/vite.config.js:87,100-107` and
`web/app.svelte.js:2663,2988` as vendor-keyword violations. **NOT A VIOLATION —
do not strip these.** The banned class is EMPLOYER/PLATFORM-specific vocabulary that
would make the dump non-portable or leak an internal context. Naming a browser or an
OS while explaining a REAL, REPRODUCED third-party bug (Vite's opener reusing a tab in
whichever Chromium is running, hence `open:false`) is load-bearing institutional
knowledge; deleting it would destroy the reason the setting exists and invite its
reintroduction. Agents will keep flagging this, so the ruling is recorded here.
The genuine violations from the same report ARE accepted and queued: `const OFFSET = 16`
is function-local with its justification 16 lines away and re-declared in two tests
(house precedent is module-top and exported — `core/endpoints.js:23`), and
`core/derive.js:273` ignores `capabilities.transform: false`.

### R6-19 FILE BROWSER

- **R6-19.1** Build or adopt a GENERAL FILE BROWSER for renderings, cache and
  assets across the real and front-end stores. "It is getting rather annoying how
  many things there are to keep track of."
- **R6-19.2** EXPLAIN HOW THE FRONT-END STORE ACTUALLY WORKS: "this file system,
  well it's not a file system, is it? How does it work? I don't really know."

#### R6-19 ANSWER + DESIGN (wave 1, agent W1-G; report `.frenzy/round6/W1-G.md`, 936 lines)

**THE USER'S INSTINCT IS CORRECT: IT IS NOT A FILESYSTEM.** It is **FIVE unrelated
key-value stores** — IndexedDB `powerrp` (documents + asset Blobs), `powerrp-renderings`,
`powerrp-browser-renders`, `localStorage`, and CacheStorage. The ONLY path-like thing in it
is a deliberate **ONE-LEVEL `"<keyspace>/<name>"` string convention**, chosen specifically
so that `IDBKeyRange.bound("P/","P/￿")` can stand in for a folder listing
(`web/localDb.js:19-22`). **And the absence of a real filesystem is a CONSTRAINT, not an
oversight:** OPFS — the one true browser filesystem — is secure-context gated and was
MEASURED ABSENT on the plain-HTTP origins this app is required to serve
(`web/browserJobStore.js:5-12`).

**THE FOUR CLASSES, per mode:**
- **Documents** — `docs` store keyed by name / `projects/<name>/doc.json`.
- **Assets** — `assets` store keyed `"<project>/<file>"` / `projects/<n>/assets/<file>`.
  **No content hashing: the BASENAME is the identity.** `localAssetEntry` already mints the
  server's listing shape, which is why one interface is achievable.
- **Renderings** — `powerrp-renderings` keyed `"<projectKey>/<jobId>"` with the mp4 Blob
  inside the record / `renders/<Name>.mp4` plus `renders/.jobs/<uuid4hex>/`.
- **"Cache" means THREE unrelated things** — the service-worker shell (the app itself, which
  the quota tooltip calls "website code"), `assets/.thumbs/`, and `assets/frames/`.

**TWO IDENTITIES FOR THE SAME ITEM: ONLY RENDERINGS.** Browser ids come from
`getRandomValues`, server ids from `uuid4().hex`, and the server additionally keeps a
human-named, de-collided `.mp4` filename that the browser side has no equivalent of until
download. **THE SHARPEST CONSEQUENCE: in HTTP mode the tree has TWO ROOTS** — documents and
assets are server-side, while renderings, caches, stray IndexedDB and the entire draft
keyspace are ALWAYS browser-local (`assetStoreFor`, `renderRecordStore`).

**VERDICT ON "HIJACK FROM SOME OTHER FRAMEWORK": BUILD, DON'T ADOPT — 25+ candidates
surveyed and each rejected on a checkable fact.** `@zenfs/core` is LGPL-3.0 since 2.4.0
(disqualified for a portable dump); `chonky` is React + MUI + Redux and dead since 2022;
`melt` ships `jest-axe`/MPL-2.0 as a RUNTIME dep; `svelte-file-tree` is the right shape but
47 downloads/week and declares no licence in `package.json`; `@headless-tree/core` has no
Svelte adapter. Monaco's `vs/base/browser/ui/tree` is MIT and — measured — **already in the
bundle via `editor.api`, costing +48 bytes**, but has zero public typings, is imperative
DOM, and **injects its own stylesheet with hardcoded 20px/10px radii straight past
`app.css`'s exclusive ownership**, which is a square-corners violation by construction.
**THE DECISIVE REASON, though, is not licensing: no candidate can be POINTED AT this
backend. The adapter IS the work, and `assetStore.js` + `projectApi.js` + `draftKeys.js`
already are that adapter.** Named fallback if a real tree widget is ever needed:
**`@zag-js/tree-view` + `@zag-js/svelte`** (MIT, official Svelte-5 runes adapter, zero CSS,
async `loadChildren`).

**THE INTERFACE:** a `web/storageTree.js` seam plus a DOM-free `web/storagePath.js`, split
per the existing `assetRef`/`draftKeys` precedent — and **deliberately NOT named "vfs",
because the user's own question is precisely that it is not one.** Roots `local:` /
`server:` / `builtin:` (the last reusing the scheme `builtinAssets.js` already mints), paths
`<root>:/<keyspace>/<category>/<name>`, and
`{id, label, capabilities, list(path), stat(path), read(path), remove(path), rename(path,to)}`
returning `Entry {path,name,type,assetKind,bytes|null,mtime|null,previewRef,badge,note}`.
`capabilities.unavailable` is a SENTENCE-PER-OPERATION table extending
`storageMode.UNAVAILABLE_IN_STATIC`/`refuseInStatic` — the house's existing loud-refusal
mechanism. **`list()` MUST NEVER catch into `[]`**; it returns `{entries, errors[]}`.
`Home = storageTree.homePath(app)`, which is `local:/~draft/current` for a draft in every
mode. **HONESTY ABOUT THE DIRECTORY ILLUSION:** root->keyspace and category->file are REAL
enumerations; keyspace->category is a presentation INVENTION browser-side and real
directories server-side; a fifth level is refused. Every node carries a `note` naming what
actually backs it.

**WHAT MOVES OUT OF THE ASSET EXPLORER** (generic -> shared): listing lifecycle and the
`projectName|assetsVersion` re-list guard, `filterAssets`, the search box, the quota line and
tooltip, download, preview, copy-path, delete-confirm, drop-to-upload, the tile grid, totals,
and the error/empty states. **STAYS** (widget-specific): insert-onto-canvas, the
`ASSET_DRAG_MIME` payload, `assetUsers`/`deleteTip`, plugin->Monaco and data->CsvTable
dispatch, optimistic upload tiles, font registration, the built-in toggle, PDF rasterize.
Preview reuses `assetThumbnail.assetTilePresentation` UNCHANGED — its input is already
exactly the `Entry` subset — so add `renders` to its one switch rather than writing a second
thumbnailer. **NOTE: selection does not exist today** and is genuinely new generic work that
the reveal commands depend on.

**COMMANDS:** `file-browser` (toggles a modal, like `render-center`; palette-only, no chord —
keycaps are scarce and `Cmd+D` is still unratified), plus `reveal-asset-in-file-browser` and
`reveal-render-in-file-browser`, both PARAMETERLESS reading current selection because
`web/App.svelte:1006` bans parameterised palette commands, and both with **FUNCTION**
`requires` (several disqualifying conditions — the `save-project` case), read only through
`commandUnavailableReason`.

**Violations recorded:** `web/DebugStoragePage.svelte:82,89` `.catch(()=>[])` — re-confirming
R6-24.5, and it is the exact code this design builds on; `:167,:186` catch-and-console-only
where the OLDER AssetExplorer surfaces a visible error, so **a failed download looks
identical to a success**; **THREE copies of the download logic**, one of which documents that
it is a copy; two implementations of inline preview; `PREVIEW_TEXT_BYTES` function-local
against `core/endpoints.js:23`'s module-top precedent; `reload`/`toggleCache`/`rowKey` carry
no Pure/Query/Command docstrings; `web/App.svelte:490` swallows silently but WITH a written
justification (flagged borderline, lead ruling pending); `libraryTotalsLine` hardcodes the
noun "asset". **And a NEW meta-violation: the `src/lib` Popover/FilterableList/
SelectableGrid/ScrollBar promotion backburner appears in NEITHER manifest nor either
`concerns.md`** — it existed only in the harness task list, which is exactly the failure mode
R6-4's lead ruling identified. Record it here.
- **R6-19.3** PREVIEW files in it, like the asset explorer does.
- **R6-19.4** Up a directory, down a directory, Home = the project directory.
- **R6-19.5** RE-IMPLEMENT THE ASSET EXPLORER ON TOP OF IT so there is no duplicate
  logic — or expand the asset explorer into it.
- **R6-19.6** "Open in file browser" from Renderings and from the asset panel.

#### R6-19.7 A DROPPED PDF LANDS ON THE CANVAS — and the five copies that stopped it

**THE USER'S REPORT:** "PowerRP: nothing on the canvas can show a 'pdf' asset
(MagickWithSupplementary.pdf) — it stays in the asset library." **That sentence was
TRUE of one line and FALSE of the app.** `pdf_page` shipped long ago; the classifier
simply asked `kind === "image" || kind === "video"`.

**IT WAS NOT ONE LINE — IT WAS FIVE ANSWERS TO ONE QUESTION**, which is why "add
`pdf` to the if" would have fixed a third of it:
1. `web/pluginAssetLoader.js assetDropKind` — the image-or-video test (asset tiles).
2. `web/CanvasView.svelte:958` — a ternary between two insert methods.
3. `web/app.svelte.js pasteFiles` — the same if/else again, so a PASTED PDF also died.
4. `web/CanvasView.svelte fileKind` — MIME-PREFIX ONLY, so an OS drag from Finder
   answered "other" for a PDF. **This one would have survived fixing 1-3**, and is the
   reason to hunt the pattern rather than the instance.
5. `web/app.svelte.js assetKindForFile` — a private near-duplicate of 4 whose own
   docblock admitted it: *"kept as a small local duplicate rather than a cross-file
   import"*. It also hand-listed font extensions `assetRef.js` already knew.

**THE FIX IS A DECLARATION, NOT A LIST.** A widget says which dropped kind it IS:
`assetDrop: "pdf"` on `plugins/pdf_page.js`, `"image"` on image, `"video"` on video.
`core/registry.js` gains `assetDropKindOf(plugin)` + `widgetForAssetKind(registry, kind)`,
and every consumer reads the roster. **The precedent is exact and was followed, not
invented:** `INSERT_MENUS`/`shapeInsertable` five functions up argues the identical
case — "the choice is only WHERE the declaration lives… so a new shape joins the menu
in its own file and no central list has to be remembered."

**WHY ACCEPTANCE COULD NOT BE DERIVED, which is the question a reader will ask.**
Widgets already declare `assetKinds: ["pdf"]` on their `src` row — but **THREE do**
(`pdf_page`, `pdf_packet`, `paper_peacock`), so acceptance cannot pick which one a bare
drop creates. Accepting a PDF and being what a dropped PDF BECOMES are different facts.
The test pins both non-claimants explicitly so this cannot be "simplified" later.

**REGISTRATION-TIME GATES, matching the insertMenu doctrine:** a second widget claiming
one kind is REFUSED (otherwise registration order picks the winner in silence), and a
malformed claim is refused. The kind STRING is deliberately NOT whitelisted in
`registry.js` — that whitelist would be a sixth copy of the vocabulary; instead
`tests/asset_drop_test.js` probes `assetKindForName` for which kinds are producible and
gates the claims against THAT.

**A BUG THE GATE CAUGHT IN THE FIX ITSELF, recorded because it is the good kind of
embarrassment:** `widgetForAssetKind` was first written as a bare
`find(p => p.assetDrop === kind)`. With a payload carrying no kind, `undefined ===
undefined` matches the FIRST plugin that declares no claim — so an unclassified drop
would have inserted an arbitrary widget chosen by registration order. The empty-payload
case in the new suite failed on the first run and the guard exists because of it.

**THREE THINGS ARE MEASURED, NOT ASSERTED.** `tests/pdf_drop_probe.js` (browser, no
screenshots by design — it is immune to the host capture hang) proves in a live app
that a dropped PDF becomes a `pdf_page`, CENTERED on the drop point, at **the PDF's own
page size measured by pdf.js (300x240 for the fixture), NOT the 320x414 unsourced
default** — that last one is what proves anything measured it at all. Natural size lives
in the new `web/assetNaturalSize.js`, one measurer per kind over three unrelated browser
APIs, and a droppable kind with NO measurer throws naming both sides; the node suite
gates that too, so the omission is a suite red rather than a failure in a user's hands.

**NOT DONE, AND NOT PRETENDED:** this is #276 only. #277 — intrinsic size readable FROM
EQUATIONS — is untouched and is genuinely harder, because an async-resolved value must
not reach the equation jail without going through the settled/ephemeral vocabulary
(`core/ephemeral.js`, #279). Nothing here exposes anything to equations.

### R6-20 MANIFEST MIGRATION

- **R6-20.1** Migrate everything living ONLY in the top-level dump manifest into
  THIS in-repo manifest. Sizes: dump `claude_instructions.md` 6423 lines,
  `concerns.md` 3998 lines. Rationale, verbatim: "a lot of issues stemmed working on
  my old computer because it didn't have access to the manifest on the top level and
  I didn't know that." The in-repo manifest is where everything gets recorded from
  now on.

### R6-21 HOUSEKEEPING

- **R6-21.1** DESTROY THE SPURIOUS AGENT WORKTREES — 80 under `.claude/worktrees/`,
  of which 67 carry unmerged commits and 69 have uncommitted files. BLOCKED on the
  user's call: delete directories but keep branches (recoverable — recommended), or
  delete both.
  **CENSUS CORRECTED 2026-08-02, because the lead quoted "100" and was conflating two
  numbers.** `git worktree list` reports **100**: the dump itself, the **80** above,
  **18 detached scratch checkouts under `/data/tmp/`**, and one spike worktree under
  `RPPT/worktrees/`. `git worktree prune` removes **ZERO** — nothing is stale.
  **THE 18 ARE A SEPARATE AND CHEAPER QUESTION, and were checked individually: not one
  carries a commit that is not already on `powerrp`.** They are gate A/B pairs agents
  made (`w3p_pal_fix` vs `w3p_pal_parent`, …), so deleting them loses no history — only
  untracked build output. **They are also a DUMP-ISOLATION violation**: each holds
  `gitdir: /root/CleanCode/Dumps/RPPT/SvelteLib/.git/worktrees/<name>`, an absolute path
  from OUTSIDE the dump pointing in, so moving or renaming the dump breaks 18 external
  directories — exactly what the portability rule forbids. Not deleted: R6-21.1 is
  blocked on the user and widening an unauthorised deletion is not the lead's call.
- **R6-21.2** Optional: cherry-pick `a7e6964` from `render-rewrite-skia` (the
  takeover button), the one commit that branch has and `powerrp` lacks.

### R6-25 TIER-0 STANDARDS (agent W2-T0) — the shared conventions the preset swarm was blocked on

Five rulings, each settled by PRECEDENT (R6-22.3: the manifest is supreme; where it
is silent and two patterns compete, the OLDER wins) or by MEASUREMENT. Where neither
existed, that is said out loud and the cheapest-to-reverse option is taken.

A CENSUS CORRECTION FIRST, because three sections quote the old one. **R6-3.2 says
"14 of 73 plugins declare `presets`". The registry answers 33 of 96, 391 presets.**
The gap is not new widgets alone: `builtinRoster()` includes the built-in plugin-ASSET
library, and `presetFamiliesOf` resolves `presetFamilies` as well as `presets`, so any
count taken by grepping for `presets:` was always low. Do not hand-count this again —
`tests/preset_contract_test.js` prints it.

- **R6-25.1 THE EQUATION-PRESET STRING FORM: `=`-PREFIXED, ALWAYS. Unblocks the 721.**

  **THE FIELD IS NARROWER THAN R6-3.15(c) IMPLIED, AND THE MANIFEST'S OWN CITATION LIST
  WAS WRONG.** Swept at RUNTIME through `presetFamiliesOf` + `isEquationValue` rather
  than by grep: across all 391 shipped presets there are **exactly 20 equation-valued
  props in exactly TWO files**. R6-3.15(b) named five files as falsifying glass.js's
  "every preset writes LITERALS" comment; **four of the five are REFUTED** —
  `filmstrip.js`, `globe_map.js`, `lens_flare.js` and `god_rays.js` carry equations in
  their DEFAULTS and HELP text, never in a preset's `props`. The two real ones are
  `plugins/demo/mandelbrot.js` (9, via `paletteCycles()` at `:709`) and
  `plugins/demo/video_time_scrub.js` (11, `TIME_SCRUB_PRESETS` at `:100`) — and
  mandelbrot, the OLDER of the two, **was not on the list at all**. A grep-built
  citation list missed the one case generated by a function.

  **THE DECIDING MECHANISM (`web/app.svelte.js:1796`): `applyPreset` writes RAW.**
  `Object.entries(preset.props)` → `setPreview` → `commitPreview`, with no
  `displayToStored` and no normalisation anywhere on the path; hover preview
  (`web/ToolsPane.svelte:232-237`) duplicates the same pairs. **So a preset's string IS
  the stored value.** Stored equation-ness is `core/expressions.js:1417`
  `EQ_PREFIX_RE.test(value) || isNumericSlot(plugin, path)` — the universal `=` marker,
  OR a bare string in a slot whose DEFAULT is a number. Therefore the bare form is an
  equation only for as long as that default stays numeric, and on any other row it
  **stores a silent literal**: no error, no equation, the value simply never binds.
  Measured, on a synthetic string row: bare `self.w` → `isEquationValue` false, no slot
  collected, `"self.w"` rendered verbatim. The marked form has NO silent failure mode.

  **AGE AGREES WITH MECHANISM, so this is not a close call.** `=`-prefixed:
  `3a136e8`, 2026-07-27 (mandelbrot, the equation shipped with the file). Bare:
  `2f9595e`, 2026-07-28 (video_time_scrub). Older wins, and older is also the form
  whose misuse fails loudly. **Item 72 does NOT rule against this**: it writes
  `"Loop" = time % self.length` in PROSE about which equation to use, not about how to
  spell a stored value — reading a conversational quote as a storage-format mandate
  would be over-reading it.

  **RULE, in three parts:**
  1. **MARKER — every equation-valued preset prop begins with `=`.** No exceptions, and
     specifically not "bare when the row happens to be numeric": a rule whose
     correctness depends on the target's current default TYPE is the coupling that
     produces silent drift here.
  2. **REFERENCES — `self.…`, `time` and function calls ONLY.** A preset ships with the
     plugin and is applied to a document it has never seen, and nothing rewrites its
     text, so a widget slug or a document variable is a promise about someone else's
     file. `self.…` is identity-stable by construction; `@itemId` is unknowable at
     authoring time. (Shipped presets already obey this: the only ref tokens in all 20
     are `time`, `self.length`, `self.max_iterations`.)
  3. **BODY CASE — snake_case, the DISPLAY grammar** (`self.max_iterations`, not
     `self.maxIterations`). Measured: the evaluator is BILINGUAL here — the prop read at
     `core/expressions.js:2547` runs `pathToStored(d.path)`, which is `snakeToCamel` per
     segment and idempotent on camel — so both spellings evaluate identically (verified:
     all four spellings of the mandelbrot equation return 36). Since both work, this is
     settled by the one shipped precedent (mandelbrot's snake) plus readability: the
     Inspector renders the stored value through `storedToDisplay`, which is snake, so a
     snake-cased preset's SOURCE TEXT and the field's DISPLAYED TEXT are the same string
     — which is what lets an author verify a preset by reading the field. CHEAPEST TO
     REVERSE: a mechanical per-segment map either way, and nothing depends on it.

  **TWO HONEST CAVEATS, both measured, neither fatal.**
  (a) **The marked form is not a fixed point on a numeric row.** `NumericField` commits
  `displayToStored`, which strips the marker, so the first time a user opens an
  `=`-marked numeric field and re-commits it, the stored value becomes bare. Observed
  live in `tests/video_time_scrub_probe.js` ("`= time % 2` COMMITS ... stored
  marker-stripped; got `time % 2`"). Harmless — both evaluate identically — and it is
  the app normalising a value, not a preset being wrong.
  (b) **A NAME COLLISION MAKES THE MARKER FAIL LOUDLY ON EXACTLY TWO SLOTS.**
  `resultKindForSlot` consults GLOBAL declarations by key NAME before the plugin's own
  default, and `points` is a declared LIST name (`core/lists.js`). On `ss_polygonStar`
  and `demo_magnify`, where `points` is a plain star-point COUNT, a marked equation
  types as `"list"` and a numeric result is refused. Swept: those are the only two
  numeric slots in the whole roster where the marker changes the kind. It is reported,
  not silent, and `tests/preset_contract_test.js` catches it before it ships.

  **DEFAULTS ARE NOT PRESETS — do not propagate this rule to them.** A plugin DEFAULT
  that is an equation must be **bare `self.`-prefixed**, because that prefix is
  structurally what makes the slot numeric (`isNumericSlot:1349` tests
  `def.startsWith("self.")`). Write `= self.scrub_time` as a default and the slot stops
  being numeric and the equation types as a string. Ten shipped defaults use the bare
  `self.` form correctly. The four `=`-marked defaults are `demo_lens_flare`'s
  `x/y/w/h: "= camera.x"`… — which work via the global `PROPS` rows but reference the
  camera BY SLUG, so a rename breaks them. Flagged, not fixed; out of this agent's remit.

  **MIGRATION DONE, not deferred** (R6-22.4): the 11 bare strings in
  `plugins/demo/video_time_scrub.js` now carry the marker, with the reasoning in the
  table's docblock. `tests/video_time_scrub_test.js:78` follows; the browser probe's pin
  now compares the stored value against **the preset's own declared string** instead of
  a transcribed literal, so it asserts "committed verbatim" without being a mirror.
  Re-run and green: the node suite 6/6, the browser probe 15/15. `demo_mandelbrot` needed
  no change.

- **R6-25.2 ONE SHARED PRESET CONTRACT — `tests/preset_contract_test.js`.**

  The hand-maintained-mirror defect (R6-24.7) had reproduced itself in the TOOLING: two
  agents each wrote the same "diff every key against `Object.keys(plugin.defaults)`"
  check into a disposable scratch file (`.frenzy/round6/presets/scratch_materials.mjs`,
  `scratch_instruments.mjs`), neither in the gate, so R6-3.14's "every future family must
  ship such a check" was going to be re-satisfied by hand once per family, forever. It is
  now one bare-node suite that **DISCOVERS its subjects** through `builtinRoster()` (the
  declared sweep seam) and `presetFamiliesOf` — a hardcoded roster would BE the defect,
  and would have been wrong on arrival by 19 plugins.

  Ten assertions over all 33 plugins / 391 presets: zero invented keys; non-empty props;
  non-empty name AND description; names unique within a family; the R6-25.1 marker;
  every equation parses; every equation's result kind resolves (and is `"number"` on a
  numeric-default slot — the `points` trap above); references restricted to self +
  keywords, checked with the SHIPPED `resolveRef` against an empty slug map rather than a
  transcribed keyword list; and **no two presets in a family carrying identical `props`**
  — the bare-node shadow of the pixel distinctness rule, since an identical property-set
  is provably the same picture and proving it needs no renderer.

  **RESULT ON SHIPPED PRESETS: one violation class, the 11 bare equations of R6-25.1, now
  fixed. Everything else was already clean** — 0 invented keys across 391 presets
  (the swarm's self-validation discipline held), 0 missing names or descriptions, 0
  duplicate property-sets, 0 unparseable equations, 0 unresolved result kinds. Family
  DISJOINTNESS is already proven by `tests/tool_groups_test.js` and is not repeated.

- **R6-25.3 THE DISTINCTNESS METRIC — per-channel, never grey; `tests/imageDistinctness.js`.**

  **A CORRECTION TO R6-3.16(b) THAT MATTERS: the shipped gate is not colour-blind, it is
  EXACT.** `tests/lens_flare_presets_probe.js:199-201` compares a **sha256 of the PNG
  BYTES** (`:101`), transcribed again at `tests/sky_presets_probe.js:118`. So the feared
  false red cannot come from it — but neither can a true one: any pair differing by a
  single least-significant bit passes. The 0.0000 grey measurement came from an ad-hoc
  reduction the treatment agent ran, not from the gate. **Both halves are real defects
  and neither is the one recorded**: the gate is too weak, and any luminance reduction is
  too blind. `tests/brightness_contrast_browser_probe.js` has no image comparison at all,
  so its flag means ADD one, not fix one.

  **RULING: per-channel absolute difference, alpha ignored.** Not an invention —
  per-channel mean-abs is already the repo's dominant pixel metric (six sites, incl.
  `option_hover_preview_probe.js:66`, `render_pipeline_probe.js:330`) and the
  `{maxDelta, fraction}` shape is its oldest (`render_gpu/tests/material_reach_test.js:229`,
  2026-07-27); this merges them into `{meanAbs, maxAbs, fraction}` and puts them in ONE
  place, because `pixelDiff` is currently reimplemented six times with three different
  meanings. Per-channel is inherently chroma-sensitive, which is exactly what the
  Punch / Punch-Hue-Locked pair needs (they differ in `preserveHue` alone, and the hue
  lock holds Rec.709 luma fixed BY CONSTRUCTION — `render_gpu/skia/brightness_contrast_shader.js:110`
  — so no luminance metric can ever see them apart). It needs no new dependency; if a
  PERCEPTUAL distance is ever wanted, `core/ramps.js:171-232` already ships
  `srgbToLinear` / `linearSrgbToOklab`.
  Placement follows precedent: FLAT in `tests/`, lowerCamelCase `.js`, named exports —
  `puppeteerLaunch.js` (159 importers) and `browser_render_harness.js`, not a new
  `tests/helpers/`. Neither existing probe's structure is rewritten; they gain a metric
  to share.

  **THE THRESHOLD IS DELIBERATELY NOT BAKED IN, and only one bound is derivable.** The
  renderer is deterministic at a frozen clock (the byte-digest gate depends on exactly
  that), so the noise floor is EXACTLY ZERO and no measurement margin is needed. What
  remains is a visibility bound, and only its floor follows from anything: **one 8-bit
  sRGB code value**, below which no display can show a pair apart — shipped as
  `DISPLAYABLE_CODE_VALUE` / `indistinguishable()`. "Far enough apart to be a different
  preset" is a JUDGEMENT, and inventing a global constant for it would be the arbitrary
  decision R6-22.2 forbids. **Each family calibrates its own bound in its own probe,
  against a pair certified correctly-distinct** — Punch / Punch-Hue-Locked is the
  reference pair, being the tightest known-good case. `closestPair()` exists so a probe
  reports its narrowest margin rather than a bare pass/fail, and an author can see two
  presets converging before they collide. **NOT YET MEASURED: the Punch-pair number
  itself.** It needs a browser run this agent did not make, and no family bound should be
  set until someone does.

- **R6-25.4 "IS THE KNOB OBSERVABLE?" — a PROBE obligation, not a contract-test one.**

  Five near-inert knobs are now on the record (`crt.sourceTVL` at 0.62 mean code values
  across its whole range with two presets LEADING their descriptions with it; CRT
  flicker; CRT persistence; video autoplay/loop/muted; `raycast_dither.zoom` silently
  killing two colour knobs above ~0.6). **Observability is a PIXEL property.
  `tests/preset_contract_test.js` is bare-node with no GPU and must not pretend
  otherwise** — the R6-24.4 lesson is that a check which cannot fail is worse than a
  missing one. It therefore checks only the DATA shadow: no two presets in a family may
  write identical props.

  **THE AUTHORING RULE, stated as a burden of proof on the author:** a preset's
  description **may not lead with an axis the family's own distinctness probe cannot
  separate**. To name a knob as a preset's headline you must show a measured pair
  differing on that knob ALONE, at the family's realistic preview size, exceeding the
  R6-25.3 metric's calibrated bound. A knob that moves less than `DISPLAYABLE_CODE_VALUE`
  across its entire range at that size is INERT and must be reported as such, not
  described. Cheapest form: sweep the knob min→max once, print the mean movement, and
  either keep the sentence or cut it. This is what `sourceTVL` fails and what nobody ran.
  It stays a MANUAL step because it cannot be anything else, and R6-3.13's instruction
  stands: every preset family ships a probe of the lens-flare shape, now using the shared
  metric.

- **R6-25.5 `bulge` RESOLVED BY PIXELS: SMALL = FLAT FILM, LARGE = TALL DOME. All three
  candidate statements were wrong.**

  R6-3.14 recorded the contradiction unresolved on purpose and demanded a render. Done,
  on the bare-node CLI path (software Skia; `materialBackdrop` IS drawn there, no
  omission warning) — one sphere over a mid-grey line-grid backdrop at bulge 0.05 / 0.2 /
  0.5 / 0.8 / 1.5 / 3.0; PNGs and script under `.frenzy/round6/bulge/`.

  **What the pixels show.** At **0.05 the bead is invisible**: a hairline wire ring, the
  grid dead straight through it, **100.0% of the bead pixel-identical to the bare
  backdrop**, peak luminance equal to the backdrop — no glint at all. At **0.8** it is a
  fat round dome with a broad glint and a visibly bent grid (49.2% undisturbed). At
  **1.5** the bend reaches the centre (15.8% undisturbed). Undisturbed fraction is
  monotone: 100 → 91 → 68 → 49 → 28 → 18%. Mechanism confirms it analytically:
  `domeDepth = max(uBulge*unit, 1.0)`, `omega = 1 - t/domeDepth`, and the cap's rise
  integrates to exactly `D`, so **dome height = bulge x mean ball radius** — the measured
  disturbed annulus matches `bulge*110 px` at every sample.

  **VERDICT: the help text and the shader comment are BOTH backwards, and the
  sessile-drop derivation is ALSO wrong** — so the answer was neither of the two positions
  on offer, which is precisely why the coin-flip was refused. `bulge` is not a contact
  angle; it is literally cap height as a fraction of ball radius, 1.0 ~ a hemisphere,
  above 1.0 the apex over-domes into a pinched spike. "Strong refraction" is attached to
  the wrong end too: at 0.05 refraction across the body is ZERO. Only the `small = … ;
  large = …` clause is inverted; the leading phrase "Dome thickness" and the prose at
  `render_gpu/skia/metaballs_shader.js:49` were always right.

  **CORRECTION OWED (reported, not applied — this agent does not own that file):**
  `render_gpu/skia/metaballs_shader.js:123` (the `uBulge` uniform comment) and `:572`
  (the row `help`) must be rewritten to "small = a flat spread film that barely bends the
  content beneath it; large = a tall rounded bead with a broad glint and strong
  refraction; 1.0 is a hemisphere, above 1 the apex over-domes into a pinched spike."
  **And the Ohnesorge/sessile-drop `bulge` ladder in the metaball preset designs is
  INVERTED and must be flipped before those presets land** — mercury (tall bead) wants
  LARGE bulge, a spread film wants SMALL. `.frenzy/round6/presets/materials.md:156-161`
  reached the same conclusion by reading the code; this confirms it in pixels.

### R6-24 CONVENTION SWEEP RESULT (wave 1, agent W1-M; full report `.frenzy/round6/W1-M.md`, 693 lines)

**READ THIS BEFORE ANY GREP-BASED AUDIT OF THIS REPO, EVER.**

- **R6-24.1 THREE FILES CONTAIN A RAW NUL BYTE, SO `grep` SILENTLY SKIPS THEM.**
  `core/text_transitions.js:203`, `web/DebugStoragePage.svelte:149`,
  `tests/lens_flare_presets_probe.js:192`. `grep` treats them as binary, skips them and
  exits 1 — **indistinguishable from "no match"**. Demonstrated:
  `grep -c 'process.exit' tests/lens_flare_presets_probe.js` -> 0, while `grep -ac`
  -> 1 on a file that has it at line 241. This BLINDED W1-M's own sweep; re-running
  classes 1-12 on those three with `-a` surfaced 6 further findings. **Consequence:
  every grep-based audit ever run on this codebase has been silently incomplete.** Use
  `grep -a` or `rg`. Strip the NUL bytes as the FIRST Wave-2 action.

#### R6-24 OUTCOMES — LANDED (agent W2-F; commits `3b8e0a6`, `a1764f1`, `c1a678c`)

**THE GATE'S TRUE SIZE, MEASURED AT LAST: `node tests/run_all.mjs --list` -> 347 SUITES**
— node 167, browser 168, python 11, shell 1. The repo CLAUDE.md says `--list` is the authority
and never to quote a number from a file; this is that measurement. (Host preflight OK: capture
in 52 ms.)

**R6-24.1 CORRECTED — THE NULs WERE INTENTIONAL VALUES, NOT CORRUPTION.** I framed them as raw
bytes blinding `grep`, which was true, but implied accidental damage. They were **deliberate
NUL string values**, merely spelled the dangerous way. So the fix is a RESPELLING to the escape
`\0` — which `web/draftKeys.js:94` and `tests/draft_keys_test.js:55` **already do** (the
precedent existed). Verified byte-for-byte: each literal still evaluates to codepoint 0,
length 1, so no behaviour changed. **The R6-24.1 demonstration now inverts as it should:**
`grep -c 'process.exit' tests/lens_flare_presets_probe.js` was **0** against `grep -ac`'s 1;
both are now **1**, and the two agree on every probe string in all three files. **Zero raw NULs
remain in tracked source.**

**R6-24.4 / R6-24.4a — ALL THREE PROBES NOW FAIL, EACH WITH ITS FAILURE PROVEN.**
- `rotation_probe.js`: the prescription applied verbatim — tables kept, worst-offset
  accumulated, one assert at **1e-6 px**. **And the tolerance was NOT invented after all:**
  `tests/align_mirror_probe.js:31` and `tests/crosshair_probe.js:57` (both 2026-07-15) already
  use that exact name (`EPS`) and value for geometry, so house precedent beat my derivation.
  Worst real measurement: **6.4e-14 px**. Two upgrades beyond the brief: the `[#1]` naive drift
  is now pinned to its CLOSED FORM `dx * sin(theta/2)` — which matches
  10.35 / 15.31 / 18.16 / 28.28 / 40.00 exactly — **so that section can never decay into
  comparing two zeroes**; and the `errors.size` / `[#3]` / `tm` branches are FATAL instead of
  printed-and-ignored.
- `magnify_byteid_probe.js`: KEPT with assertions rather than renamed, on a precedent worth
  recording — it was the one-shot before/after print for `86b5f0f`, and the comparison moved
  INSIDE one run because **every sha256 in this repo compares renders to each other, never to a
  stored golden** (a pinned digest would be machine-specific). Two assertions, the second of
  which closes a VACUITY hole: the first would still pass on a build that ignored the per-axis
  params entirely.
- `fontpicker_probe.js`: the guard at `:135` plus three siblings (`:141`, `:150`, `:197`) are
  now asserted before being kept as cascade suppressors — the pattern the same file already
  used elsewhere.
- **THE SHARPEST DEMONSTRATION OF THE FALSE-GREEN CLASS:** the IDENTICAL perturbation (breaking
  the `.fp-preview` selector) exited **0 pre-fix while silently losing 14 checks (93 -> 79)**,
  and exits **1 post-fix with two named failures.**

**R6-24.5 — FOUR SILENT FALLBACKS FIXED, and the reasoning confirmed at the source.**
`localAssetStore.list` -> `getAllByPrefix` and `listRenderJobs` are both prefix `getAll`s that
resolve `[]` and never reject, so `.catch(() => [])` **could only ever swallow a real fault**.
Removed; `reload()`'s existing loud handler catches them, as it already does for the page's
other five sources. Both downloads now set the pane error line as well as logging, per
`AssetExplorer.downloadAsset`. **A bonus catch: the error line moved OUT of the
`{#if loading}{:else if error}` chain, so reporting a failure no longer ERASES the inventory.**
Proved in-browser: both faults RESOLVED (swallowed) pre-fix and REJECTED post-fix, and a failed
download now names the file while all five inventory groups stay on screen.

**Also green after the work:** `core_test` 53, `expressions_test` 94, **`doctest_test` 3371**,
`debug_storage_test` 18, `debug_storage_probe` 14, `lens_flare_presets_probe` 12/12,
`fontpicker_probe` 93. `npx vite build` exit 0.

**Still open in files W2-F did not own** (reported, correctly not touched): three copies of the
download logic (one self-documented as a copy), two inline-preview implementations,
`libraryTotalsLine` hardcoding the noun "asset", and `web/App.svelte:490`'s silent swallow
(which does carry a written justification — lead ruling still pending).

- **R6-24.2 THE THEME WCAG GATE HAS NEVER RUN HERE, AND CLAIMED OTHERWISE.**
  `tests/theme_contrast_test.py:21` hardcodes an absolute path from a DIFFERENT
  machine (`/Users/ryan/CleanCode/Sandbox/...`). Running it gives `FileNotFoundError`.
  It IS collected by `run_all.mjs`, and commit `69d4b31` asserts "25 themes pass".
  This is simultaneously a dump-portability violation (only `/models/` may be
  absolute) and a FALSE GREEN in the canonical gate.

- **R6-24.3 R6-8.4's ROUNDED KNOBS — ROOT CAUSE PROVED, by CSS specificity.**
  `web/app.css:8353` `.paint-material-control .dn` is the SOLE (0,2,0) selector among
  seven `--dn`/`--dd-radius` overrides; the other six are (0,3,0). By app.css's own
  MEASURED rule at `:5869-5876` and `:2474-2481`, a (0,2,0) tie loses to Svelte's
  later-injected `.dn.svelte-hash`, so `--dn-radius` stays 4px and the knobs render
  rounded. **The rule's own comment claims the opposite.** Landed in `f8c2c3a`, whose
  message records that "both agents [were] killed by API 529 mid-verification" — i.e.
  it shipped unverified. Fix is a one-selector specificity bump; ship it WITH a probe.

- **R6-24.4a `rotation_probe.js` — LEAD INVESTIGATED, PRESCRIPTION RECORDED, NOT YET
  APPLIED.** It is not accidentally assertionless: its docblock declares it a QUANTIFIED
  REPRO instrument and states "the registry expects ~0px after the fixes". Lead ran it —
  **every invariant now measures 0.00px** across 30/45/54/90/180 degrees (preset anchor,
  circle rim, ellipse rim, rounded-rect rim, rounded+rotated rim), and the `[#1]` section
  shows the naive 10.35-40.00px drifts collapsing to 0.00 while the dragged edge still
  moves exactly 40.00. So the rotation-fix wave DID land and holds. **Therefore assertions
  here would lock in a currently-correct invariant, not paper over a bug.** PRESCRIPTION:
  keep every printed table (that is the diagnostic value), accumulate a worst-offset, and
  assert once at the end with `import assert from "node:assert/strict"` (the house pattern
  — 2 of 3 bare-node tests use `/strict`). **TOLERANCE, DERIVED NOT PICKED: 1e-6 px.**
  These are float64 ops on 100-600px magnitudes, so accumulated rounding is ~1e-12, while
  any real regression is >= 0.01px (the naive drifts are 10-40px) — so 1e-6 is six orders
  of magnitude clear of noise and still catches everything. Note `[#3]` is NOT empty; it
  reports finiteness in prose, which a filtering grep hides.

- **R6-24.4 THREE GATE PROBES CANNOT FAIL — more false greens.**
  `tests/rotation_probe.js` (191 lines, ZERO assertions), `magnify_byteid_probe.js`
  (51 lines, zero assertions, no baseline), `fontpicker_probe.js:135` (7 assertions
  behind an unasserted guard). A probe that cannot fail is worse than a missing one:
  it manufactures confidence. Each must gain assertions, be renamed out of the gate,
  or be deleted.

- **R6-24.5 SILENT FALLBACKS: 4 real, out of ~150 candidates examined.** This class is
  otherwise genuinely well kept. The worst: `web/DebugStoragePage.svelte:82,89`
  `.catch(() => [])`, whose comments describe a case that CANNOT reach the catch (a
  prefix `getAll` resolves `[]`, it never rejects), so they swallow only real faults
  and silently UNDERSTATE storage in both the Debug page and the AssetExplorer
  tooltip — defeating the caller's own correct loud-failure design.

- **R6-24.6 CRT's INERT KNOBS, and the two are NOT the same case.**
  `render_gpu/skia/crt_shader.js:647-648`. **`flicker`'s documented blocker is FALSE** —
  `particleTime()` already reaches materials (`glitch_shader.js:343,382`,
  `sky_shader.js:39`), so flicker CAN be implemented. **`persistence` CANNOT EVER
  SHIP**: it needs frame-N-1 history, which is EPHEMERAL state and forbidden outright.
  So: implement flicker, and REMOVE persistence rather than leave a control that lies.

- **R6-24.7 THE HAND-MAINTAINED-MIRROR PATTERN, AGAIN, ALREADY DRIFTED.** Error-box
  constants are copied across 5 files and `TEXT_FRACTION` has already diverged to
  0.14 / 0.16 / 0.18 / 0.22. `render_gpu/affordances.js` exports the shared version and
  only 2 of 5 use it.

- **R6-24.8 TWO DOCTRINES CONTRADICTED IN CODE.** `web/PaintField.svelte:784` uses a
  raw checkbox against `BooleanField.svelte:12-14`'s "deliberately no native
  `<input type=checkbox>` anywhere in the editor" (a doctrine live across 44 boolean
  params); `web/CodeEditController.svelte:271` uses a native `<select>` against
  `Inspector.svelte:25`'s "never the native `<select>`" — and its own comment admits
  the reason was convenience.

- **R6-24.9 LEAD RULING — THE NO-TRAILING-COMMA RULE IS PYTHON-ONLY.** The sweep found
  9 Python violations and **380 in JS**, and measured that codebase precedent runs
  **7:1 IN FAVOUR** of JS trailing commas. The rule's own justification in the user's
  global instructions is Python 3.5 syntax (`*args,` / `**kwargs,` are syntax errors
  there) — a constraint that does not exist in JS. Sweeping 380 JS sites against 7:1
  precedent would be large, risky churn with no benefit, and R6-22.3 says the older
  and dominant pattern wins where the manifest is silent. **RULING: fix the 9 Python,
  leave JS alone.** Surfaced to the user for override; if he wants JS swept too, it is
  a mechanical follow-up.

- **R6-24.10 AN HONEST GAP: the docstring class (Pure/Near-pure/Query/Command labels,
  examples, `untested` markers) HAS NO COVERAGE** — the subagent pool stayed saturated
  at the 20-concurrent ceiling. Its section in the report is thin because it was not
  done, NOT because the codebase is clean there. Must be re-run.

- **R6-24.11 Remaining counts** (see the report for file:line): 9 `var(--radius)`
  misuses plus 2 lib defaults; 8 undefined-token lines and 3 inline-style violations;
  124 icon-size literals and 19 bare `1px` (both need an `--a-icon-*` / `--a-hairline`
  decision before sweeping); 6 GUI-reinvention sites; 4 caps missing their derivations;
  1 absolute path (R6-24.2); ZERO vendor-term violations.

### R6-23 THE 3D VIEWER FAMILY — R6-1 IS ONE MEMBER, NOT THE WHOLE THING

Added by the user 2026-08-01, AFTER R6-1 was written. It SUPERSEDES R6-1.5's
"ideally a 3D engine" and makes that a HARD requirement: meshes are a first-class
sibling, not a someday.

- **R6-23.1 THE GENERALISATION.** "That Gaussian Splat viewer could maybe be more
  general. We'd like to be able to subclass that into a 3D viewer. So I'd like to be
  able to have meshes that I can preview too with variable lighting and scenes and
  stuff... So this will just be one of many. Maybe it will be the three.js widget or
  something." So: ONE 3D-viewer substrate; the splat viewer and the mesh viewer are
  members of it.
- **R6-23.2 REPRESENTATION IS AN OPEN QUESTION.** "I'm not sure the best way to
  represent that right now." So this needs a DESIGN PROPOSAL before code. The
  archetype precedent in this codebase is the `sky` family (R6-9 / task #100 — a
  prefix-shared family whose members read each other) and the corkboard family
  (task #72). Whichever is chosen must be justified from precedent, not invented
  (R6-22.2).
- **R6-23.3 MESHES WITH VARIABLE LIGHTING AND SCENES.** Lights and scene setup are
  properties, which by the core invariant makes them keyframable and tweenable —
  the same reasoning as R6-1.3 for the splat camera. A light's direction is exactly
  the kind of thing the existing `angle` property kind (task #79) already expresses.
- **R6-23.4 DEFAULT 3D OBJECTS, REAL ONES.** "You can grab some default objects you
  can find on the web so that they can be referenced by whoever uses them. You know,
  some 3D objects that will never go out of style that are real assets that are made
  by real people." So: ship a small set of canonical, permanently-recognisable
  models. The obvious candidates are the classics (Utah teapot, Stanford bunny/dragon,
  Suzanne) and the Khronos glTF sample models (Damaged Helmet, Lantern, Sponza).
  LICENCE IS A HARD GATE — the dump must stay redistributable, so record the exact
  licence and attribution for every asset shipped, and prefer CC0.
- **R6-23.5 OBJAVERSE AS A SOURCE, AND MAYBE A BROWSER.** "Maybe Objaverse is a good
  place to start. Maybe we could even have a search bar where I double click it and it
  goes through different Objaverse assets or something." Note the double-click framing
  again — the `activate` phase (see R6-1.2). RESEARCH REQUIRED: does Objaverse expose
  a usable search API, what are the per-object licences (they VARY, which is a real
  problem for shipping), and what formats does it serve? An asset browser that pulls
  from the network at author time is a different animal from a shipped library —
  decide which, and say why.
- **R6-23.6 IT MUST OBEY THE SAME CARDINAL CONTRACT** as R6-1.6/.7/.8: render
  `f(x,y,w,h)` at a given resolution via `core/clip.js visibleSourceRect`, cache when
  nothing changed, and offer the fixed-resolution override.
- **R6-23.7 CONSEQUENCE FOR THE LIBRARY CHOICE (R6-1.11).** Because meshes,
  lighting and scenes are now in scope, a splat-only renderer is DISQUALIFIED. The
  library must be a real 3D engine that also does splats.

#### R6-1/R6-23 LIBRARY SURVEY — MEASURED, NOT ARGUED (wave 1, agent W1-I; report `.frenzy/round6/W1-I.md` + `W1-I-mkkellogg.md`, `W1-I-playcanvas-babylon.md`)

**RECOMMENDATION: three.js 0.180 (MIT) + `@sparkjsdev/spark` 2.1.0 (MIT).** WebGL2-only:
no WebGPU, no SharedArrayBuffer, no separate WASM asset (its Rust wasm is base64-inlined).
Its ONLY runtime dependency is `fflate`, which is already declared in `package.json`.

- **A NEW ARCHITECTURAL CONSTRAINT, AND IT GENERALISES BEYOND SPLATS:**
  SharedArrayBuffer requires `crossOriginIsolated`, which requires a SECURE CONTEXT — so
  **on plain HTTP, SAB is unavailable for exactly the same reason WebGPU is.** That kills
  the classic splat libraries' fast sort outright. Record this beside the
  HTTPS-independence tenet; it will decide future library choices too.
- **ELIMINATED:** `@mkkellogg/GaussianSplats3D` is **abandoned by its own author** (its
  README now points at Spark). `gsplat.js` and `antimatter15/splat` are splat-only, so
  they die on R6-23.7.
- **RUNNER-UP: PlayCanvas (MIT), and the gap is NARROW, not a landslide.** It wins on
  bundle — **592 KB gzip for the whole engine vs ~1.9 MB** for three+Spark — and on
  activity (100+ commits/30d vs ~3). It loses on determinism ergonomics: `frame:ready`
  does not go false on camera-only movement, so an exporter would need a hand-rolled
  converge loop. Babylon third (Apache-2.0, experimental determinism API, largest bundle).
- **THE AGENT'S OWN CAVEAT, WHICH THE LEAD ACCEPTS: before any code, run the same three
  assertions against PlayCanvas.** Spark leads partly because it is the only one probed;
  if PlayCanvas passes determinism, its 3x size and 30x activity advantages are hard to
  argue with and the choice should flip.

**COMPOSITING — PROBED ON THIS REPO'S OWN CANVASKIT, NOT THEORISED.**
`surface.makeImageFromTextureSource(foreignWebGL2Canvas)` **works** on canvaskit 0.41.1,
**right-side-up**, and `updateTextureFromSource` refreshes in place. At 1920x1080,
hard-synced, on SwiftShader: **16.5 ms update + 4.3 ms draw**, against 30.2 ms for the
old CPU-readback path. So: TWO GL contexts, upload the canvas. Zero-copy
`Surface.makeImageFromTexture` exists but needs a shared context plus the private
`_resetContext` — speculative, no precedent, do NOT. A DOM overlay is rejected outright:
it forfeits z-order, every Skia effect, the lens, and all exporters.

**THE CARDINAL CONTRACT (R6-1.6) IS SATISFIED, AND VERIFIED IN THE SHADER.**
Mapping is `renderer.setSize(deviceRect)` + `camera.setViewOffset(deviceRect.w/sourceRect.sw, ...)`.
Verified inside Spark's own shader: `clipCenter = projectionMatrix * vec4(viewCenter,1)`
and the covariance Jacobian reads `projectionMatrix[0][0]/[1][1]`, so off-axis frusta are
correct for BOTH splat centres AND ellipse sizes — not just positions.

**END-TO-END PROOF** (three+Spark, 177k-splat scene plus a lit mesh and lights, headless
SwiftShader): repeated render at the same pose is **byte-identical** (determinism holds);
a `setViewOffset` frame differs and is **itself byte-identical**; covered pixels go
**18,375 -> 89,032**, i.e. a genuine re-render at higher density rather than a magnified
raster — which is precisely what the user asked for; `clearViewOffset` restores exactly.
`await spark.update()` is the seam that closes the async sort.

- **R6-1.8's PRECEDENT IS EXACT — COPY IT, DO NOT INVENT.** `pdf_page`'s
  `renderMode: "live"|"raster"` plus `rasterWidth`/`rasterHeight`/`rasterDPI`
  (`render_gpu/pdf_display.js:82`) IS the user's "720x840 regardless of widget size".
- **R6-1.7** maps onto the static material raster cache's `retained` rule, with loud
  `noteRasterRefusal` and `materialRasterStats()` so a probe can PROVE a cache hit.
- **`cli/render.js`: CONFIRMED IMPOSSIBLE.** Software surface, no GL, no DOM. Splats join
  its loud omission list beside images/video/PDF/LaTeX/Mermaid. `headless-gl` is WebGL1
  plus a system dependency, which would forfeit that renderer's entire reason to exist.
- **RENDER-JOB WORKER: WORKS, BUT THE COST MOVED.** Measured: the render itself is
  **0-1 ms even at 1080p**; the whole cost is `await update()` at **~2.0-2.2 s and
  RESOLUTION-INDEPENDENT** (readback + LoD traverse + sort). The agent's earlier
  fill-rate model predicted the opposite and it CORRECTED ITSELF — noted because that is
  the standard. Untested levers: `enableLod:false`, gating `update()` on a real pose
  change, and the existing `--use-angle=vulkan` flags.
- **BIGGEST RISK CHANGED: no longer determinism (that passed) but ~2 s/frame on a
  GPU-less host** — about 30 minutes per 900-frame fly-through per widget. Secondary: the
  1.9 MB must be LAZILY imported, exactly as `pdfjs-dist` / MathJax / Mermaid already are
  (`web/vite.config.js` `optimizeDeps.include` is the precedent for pre-bundling it).

**R6-23.4 LICENCE GATE — THREE MODELS THIS MANIFEST NAMED ARE FAILURES. CORRECTED HERE:**
**Sponza (Crytek EULA) and the Stanford Bunny (non-commercial) are HARD FAILS. Damaged
Helmet is UNSAFE (CC BY-NC ancestor). Duck is SCEA-licensed.** All four were listed as
candidates in R6-23.4 and must NOT be shipped. **Safe CC0:** Suzanne, SciFiHelmet,
Lantern, WaterBottle, ToyCar, plus a procedurally generated Utah teapot.

**Convention note from the survey:** canvaskit's `TextureSource` type omits
`HTMLCanvasElement` although the runtime accepts it — any module relying on that MUST say
so in its docstring, or a future reader will "fix" working code. No violations found in
app code.

#### R6-23 DESIGN — ACCEPTED (wave 1, agent W1-O; proposal `.frenzy/round6/W1-O.md`, 1096 lines)

**FAMILY REPRESENTATION: SIBLINGS OVER A SUBSTRATE.** ONE file `plugins/scene3d.js`, one
factory, array export `scene3dPlugins`; members `scene3d_model` and `scene3d_splat`.
Precedent is `plugins/shapeshifter.js` (2026-07-23, the OLDEST of the four family
precedents that actually argues this question, and the one `plugins/corkboard.js:26` cites
as its own). **The `sky` family is REJECTED for a structural reason, not a stylistic one:**
its members read siblings' **2D world centres**, and a mesh or a light inside a viewport
has no canvas position. **There is NO separate "scene" widget** — a scene is simply one
viewport's properties.

**PROPERTY STATE:** `BUNDLES.scene3dCamera` (camTargetX/Y/Z, camYaw/Pitch/Roll/Fov as
`kind:"angle" display:"degrees"`, camDistance) plus `BUNDLES.scene3dRender`
(renderMode/rasterWidth/rasterHeight/rasterDPI, copied from `plugins/pdf_page.js:205`).
**Lighting is a `core/lists.js` LIST with TWO angle rows (azimuth + elevation)** because
`ROW_KINDS` is CLOSED and there is no vector kind — and `plugins/tangent_lines.js:401,406`
is the existing two-sibling-angles precedent. `plugins/corkboard.js:200` and
`plugins/demo/glass.js:44` already spell it "Direction TO the light", so the wording is
settled too. (Note this interacts with R6-16.2: if x/y ever becomes a real vector
primitive, these rows are a customer.)

**DOUBLE-CLICK / MOUSE-LOOK:** a NEW handler `web/sceneNav.js` with descriptor
`sceneCamera{pose,writes}` and `activate:"navigate_scene"` — deliberately NOT a
generalised `interiorView`, because two shipped widgets depend on that contract's
`window(state) -> {x,y,w,h}` shape. **Mid-gesture state lives NOWHERE:** read the pose from
current (preview-inclusive) state, `app.setPreview` all keys, and let the host commit on
pointer-up or 250 ms wheel idle — ONE undo unit. It must copy interiorNav's LOUD refusal
when a pose key is `=`-bound (better: lift `equationBoundInteriorProps` rather than
duplicate it — see R6-24.7 on hand-maintained mirrors). **Escape is FREE:** declaring
`mode` feeds `canvasModes()` -> `handShortcutEntries` -> the scoped Escape entry at
`core/shortcut_entries.js:1021`, which answers the concern R6-1.2 raised. One deliberate
divergence: this mode declares `onPan` (the user's "flying with the mouse"), where
interiorNav deliberately does not. Asset picking becomes
`placement:"bbox_then_asset"`.

**THE CARDINAL CONTRACT — MAXIMUM REUSE, NO NEW IR OP.** A third pre-pass
`render_gpu/scene3d_display.js` in the `pdf_display.js:250` shape (including
`clipPolicy`). With `fullDevice = {s.w*scale, s.h*scale}`, offset `= sourceRect.sx *
fullDevice.w` and sub `= sourceRect.sw * fullDevice.w` — proved equal to `deviceRect.w`
in the proposal's section 4.2. **Pixels reach the scene as an ordinary `image` op** via
`reserveImageSlot` / `registerRasterizedBitmap`, making this the 4th consumer after
pdf/latex/mermaid — which buys `pendingRefs` export gating, missing-media refusal, CLI
omission counting and PDF/SVG export for free. **The image ref IS the R6-1.7 cache**
(content-addressed); it needs only `trimScene3dCache(keep)` and `scene3dRasterStats()` so
a probe can prove a hit.

**MODELS — MY R6-23.4 LIST WAS 4 OF 6 WRONG, AND W1-I's "SAFE" LIST IS ALSO PARTLY WRONG.**
Hard fails: DamagedHelmet (CC-BY-NC ancestor), Sponza (Crytek EULA), Stanford models
(NC + ND, and the ND is CONTAGIOUS to Khronos's Dragon), Duck (SCEA), BoxTextured
(CC-BY + trademark, not CC0). **The Utah teapot has NO LICENCE TEXT AT ALL.** And
SciFiHelmet, which W1-I called safe, is CC0 but **30,286,979 bytes with no `.glb`** —
three times the repo's largest file. Plain Suzanne likewise has no `.glb`.
**ACCEPTED SHIP LIST (Tier A+, 7,563,490 bytes total — less than one committed font):**
MetalRoughSpheresNoTextures 291 KB (an untextured lighting rig), IridescenceSuzanne
508 KB, DirectionalLight, ClearCoatCarPaint, ClearcoatWicker, GlassVaseFlowers, Fox
(CC-BY, requires credit), Spot the cow (explicit public-domain dedication inside the
archive), plus Avocado / WaterBottle / BoomBox / Lantern repacked to 1k JPEG — which takes
86.20 MB down to 10.15 MB (Avocado alone 8.11 -> 0.21). **Draco compression is worthless
here: 1.5 %, because textures dominate.** HDRI: 256x128 RGBE ~113 KB from Poly Haven
(CC0). **The teapot and a Cornell box are GENERATED, not downloaded.** Home is the
built-in library `assets/builtin/models/`, with `builtinClipart.js` as the loader template
and `fonts/README.md` as the licence-table precedent. **COMMIT them; do NOT
download-to-cache** — that is this manifest's own rule and there is ZERO
download-on-first-use precedent in the repo, so my earlier suggestion of it is withdrawn.

**OBJAVERSE: NO — R6-23.5 IS ANSWERED IN THE NEGATIVE, WITH EVIDENCE.** There is no search
API of any kind; the explorer 404s; the only usable index is 924 KB of 1,156 category
labels **with no licence field at all**; real metadata is 577 MB gzipped / 3.1 GB raw.
Licences measured across 50k objects: 87.9 % CC-BY, **0.4 % CC0**, 9.7 % NC. There is also
an open, unresolved legal complaint and an open NSFW report against the dataset.
**AND THE TEMPTING ARCHITECTURE IS REFUSED ON PRINCIPLE:** searching Sketchfab live and
then fetching the same uid from the mirror (~72 % hit rate) is CIRCUMVENTION of Sketchfab's
401, and this manifest refuses it explicitly so no future agent rediscovers it as a clever
idea. **Accepted instead:** the shipped library is primary, with an OPTIONAL author-time
browser over **Poly Haven** (CC0, keyless, CORS-friendly). Two caveats: its assets are
multi-file rather than `.glb`, and its ToS requires `Referer`/`User-Agent` headers that
browser JS cannot set — so it must be proxied through `server/`.

**TOP RISK IS NOT PERFORMANCE — IT IS A HOLE IN THE LOUD-OMISSION COUNTER.**
`cli/render.js` counts EMITTED media ops, so a 3D widget that produced no raster emits
nothing and a holed render **exits 0 silently**. The map widget already hit this exact
hole and recorded it. Fixing the counter is a prerequisite, not a nicety.

**AND AN HONEST WARNING FOR THE USER ABOUT R6-1.8:** `await update()` costs ~2.0-2.2 s per
frame and is **RESOLUTION-INDEPENDENT**, so the fixed-resolution override the user asked
for specifically to bound cost **will not reduce it**. That fact belongs in the property's
help text rather than being discovered later.

**CONVENTION FINDINGS (11, unfixed). HEADLINE: `plugins/shapeshifter.js`'s STATED
JUSTIFICATION HAS SILENTLY EXPIRED** — it asserts that per-state Inspector rows are
unsupported, but `visibleWhen` landed 2026-07-31, eight days afterwards. Its conclusion
still holds on four other grounds, but the docblock that TWO families cite now argues from
a false premise, so it must be rewritten rather than merely trusted. Also: `core/registry.js`
documents 4 of 10 in-use capability keys despite being the de-facto base class; the
pre-pass `renderCtx` is hand-wired in 3 places (record it, do not generalise this wave);
`unit:` versus `display:` on angle rows has ALREADY shipped one bug and this design adds
four more angle rows; `FRAME_KEYS` and the category titles are still duplicated (both
marked HANDBACK PENDING); and `canSkip` is documented with zero implementors.

### R6-29 UNIFY THE HANDLE-CONSTRAINT PROTOCOL — PREREQUISITE, ORDERED BEFORE R6-28

**USER RULING, 2026-08-01:** *"If there was a proper fix that needs to be done before the smaller
thing I asked, then we have to add the proper fix and devote large amounts of agent effort to
that on an earlier part of the dependency chain and then get to it after."* So this is now an
EARLIER node in the chain and R6-28 waits on it.

**WHAT IS ACTUALLY TRUE TODAY (measured, and it vindicates the earlier refactor).**
`constrain(state, desired) -> allowed` is called from ONE seam — `core/derive.js:865` and `:882`,
with `:933` defaulting it to `UNCONSTRAINED` (the identity) so every consumer may call it
unconditionally. Eight plugins implement it and all are invoked identically. **There are NOT
competing implementations.** `core/registry.js:157-168` records the original purpose verbatim:
constraints used to live imperatively inside `apply`, "so nothing could ASK where a handle was
allowed to be without also committing a write — and therefore only a mouse could drive one.
Declaring the projection makes any source of a desired point a valid driver: a drag, an equation,
or a binding to another anchor."

**THE GAP IS A SECOND HANDLE FAMILY THAT NEVER JOINED THE PROTOCOL.** The protocol is scoped to
`modifierPoints[].constrain` — the per-widget yellow squares, whose semantics only the plugin
knows. **The bbox MOVE/RESIZE handles are not modifier points at all**: their semantics are
UNIFORM across every bbox widget, so there was nothing per-plugin to override, and they live once
in `web/canvas/dragKinds.js` with their own axis machinery (`doX`/`doY` at `:346-347`; the modal's
constrained axis "pinned to 1 and its writes suppressed" at `:341`). Both designs are defensible
in isolation; the cost is that there are now TWO answers to "where may this handle go".

**THE UNIFICATION INSIGHT: AXIS SUPPRESSION *IS* A CLOSEST-TO PROJECTION.** "Height is locked"
means: project the desired `(w, h)` onto the nearest allowed point in
`{(w, h0) : any w}` — a projection onto a line. `doX`/`doY` are that same projection expressed as
booleans rather than as a function. **So the two mechanisms are the same mathematical object
written twice, and the bbox path can JOIN the protocol rather than parallel it.**

**WHY THIS MUST PRECEDE R6-28, stated honestly:** equation lock *would* work wired into two
seams. It is not blocked. But (a) the second implementation would then exist forever, and the
worst recurring defect in this repo — recorded 6+ times in this round alone — is precisely "the
same idea implemented twice, drifting"; and (b) at least THREE further constraint sources are
queued that would each need double-wiring — R6-28 equation lock, R6-14 groups scale-children, and
aspect-ratio / chain-link. One answer pays for itself immediately.

**THE FOOTPRINT IS SMALLER THAN IT SOUNDS: THE EIGHT PLUGINS ALREADY CONFORM AND DO NOT CHANGE.**
What changes is that the bbox path gains a projection. Core files only: `core/derive.js`,
`core/registry.js`, `web/canvas/dragKinds.js`.

**A CONVENTION THAT BECOMES LOAD-BEARING.** `core/registry.js:167` records that *"nearest allowed"
is a documented CONVENTION rather than an enforced law* — nothing stops a plugin returning a
non-nearest point. Once the bbox path joins, that convention carries weight it did not before, so
it needs a test rather than a comment.

**MUST NOT REGRESS:** the minimal-delta discipline (`dragKinds.js:94` — a pure-horizontal drag
writes `x` alone and leaves any equation on `y` untouched) and the modal G/S axis constraint must
come out behaviourally identical. Byte-identical drag outcomes are the bar.

**THE ACCEPTANCE CRITERION, IN THE USER'S OWN FRAME — NO TOWER OF BABEL.** *"We have to make sure
that it's universal for all widgets so that there's no Tower of Babel problem where they all speak
in different ways and do it different ways."* So the deliverable is NOT "we converted the call
sites" — it is that **a widget CANNOT have its own dialect.** That means an EXHAUSTIVE,
REGISTRY-DRIVEN test: enumerate every registered widget from the roster (never a hardcoded list —
a hardcoded list would itself be the mirror defect this round keeps finding) and assert that every
draggable affordance it exposes resolves through the ONE projection. A widget that bypasses it must
turn the gate RED, not merely be absent from a checklist. If some widget genuinely cannot conform,
that is a finding to report with its reason — not a silent exemption.

### R6-28 EQUATION LOCK ("constrained" mode) — user, 2026-08-01. **BLOCKED ON R6-29.** NEEDS FLESHING OUT BEFORE BUILD.

**THE ASK.** A toolbar toggle, in the same group as the snap magnets and the ghost-objects
toggle, with an icon meaning "constrained". While ON, **any property governed by an equation
becomes READ-ONLY FROM THE GUI** — no drag, resize or rotate may overwrite it — and the canvas
shows greyed affordances with a hover tooltip explaining WHY. Copy shape the user specified:
*"Cannot move because of [lock icon]"*, then **bold**, then a newline, then the LIST of
properties locked by equations that govern it. Partial constraint is the point:
- `y` equation-locked -> dragging moves in **x only**.
- `height` locked -> dragging a corner resizes **width only**.
- `width = height * 2` -> the two move together, *"almost like a chain link"*, so height and
  width stay constrained and the GUI respects it.
- *"Every canvas type thing, including double click areas, might have to respect that."*
- Only while the toggle is enabled. User: *"We might need to flesh this idea out a bit so that
  it's not janky feeling to use inside the UI."*

**THREE OF THE FOUR PIECES ALREADY EXIST — this is mostly a generalisation, not new machinery.**
1. **A loud refusal on equation-bound drags is already shipped**: `web/interiorNav.js:173`
   `equationBoundInteriorProps(app, node)`, consumed at `:225`. And crucially
   `web/CanvasToolbar.svelte:53` **already cites it as the precedent "for the same situation"** —
   i.e. the toolbar the user wants the button on already knows about this concept. Generalise
   that function from interior-pose keys to any property; do NOT write a second one.
2. **The projection protocol is already declared**: `core/registry.js:157` documents
   `constrain(state, desired) -> allowed`, implemented by `clock_analog`, `donut`,
   `elbow_arrow`, `curved_arrow`, `paper_peacock`. **Equation lock is a NEW INPUT to that same
   projector, not a new interaction layer** — which is the anti-jank answer: one place decides
   where a handle is allowed to land.
3. **The single translation seam exists**: `web/canvas/dragKinds.js` `translationPairs`, "the ONE
   translation rule", which drag, drag-all, modal grab and nudge all route through.

**AND ONE OF THE USER'S ASSUMPTIONS IS ALREADY HALF-TRUE, DELIBERATELY.** `dragKinds.js:94-95`
documents today's behaviour verbatim: *"pure-horizontal drag (dy === 0) writes x alone and leaves
any equation stored on y untouched. **Grabbing an axis that DID move replaces its equation**"*
with a literal. So the UNTOUCHED-axis case is already protected (that was the minimal-delta
work); the TOUCHED-axis case **silently replaces authored work with a literal, by design**.
Recorded as a design choice the user is now revising, not as a bug — but note it sits awkwardly
beside this repo's no-silent-destruction instincts, which is an argument about the DEFAULT (see
below).

**THE HARD PART, AND IT IS NOT SYMMETRIC — the chain link.** Given `width = height * 2`:
- Dragging the **height** handle is FREE: height is the independent variable, and width follows
  because it is derived rather than stored.
- Dragging the **width** handle is NOT: honouring it would require **INVERTING AN ARBITRARY
  EXPRESSION** (`height = width / 2` here, but in general unsolvable).
**THEREFORE THE HONEST RULE: a locked property may only be driven by dragging its INDEPENDENT
VARIABLE; dragging the dependent handle refuses (greyed, with the reason).** Numeric inversion
by fixed-step search would be permitted by the determinism rules, but it is a much larger
feature and can feel unpredictable — explicitly OUT of the first version.

**A DESIGN REFINEMENT THE LEAD FLAGS: GREY PER DEGREE OF FREEDOM, NOT PER HANDLE.** A corner
handle drives BOTH w and h. If only `h` is locked, that corner is **not dead** — it must still
resize width. Greying the whole corner would read as broken. So a corner with one axis locked
should render as a single-axis affordance (cursor + visual cue), not as disabled.

**THE TOOLTIP REASON MUST BE A FUNCTION, NOT A STRING** — and there is a precedent ruling for
exactly this in this manifest: `requires` MAY BE A FUNCTION because *"a gate with SEVERAL
disqualifying conditions has several true sentences, and a fixed string would be a confident
wrong answer for all but one."* Identical logic: the sentence must be computed from WHICH
properties are locked. **But do NOT reuse `commandUnavailableReason`** — that governs COMMANDS,
and R6-13.4 already ruled against inventing a row equivalent; a canvas affordance needs its own
reason function.

**SCOPE WARNING:** the user wants *every* canvas interaction to respect it, including
double-click areas. That only holds if the refusal lives at the **constraint/commit seam**
(point 2 above), because a per-handler implementation will be missed somewhere. `interiorNav` is
the existing proof that a double-click area can honour it.

**SETTLED BY THE USER, 2026-08-01:**
1. **DEFAULT: OFF.** "The protection is not on by default."
2. **ICON: THE CHAIN LINK** — he considered a grabbing-hand-plus-equation-plus-no-sign and
   converged on the chain link himself ("Actually, yeah, that's it"), which also matches the
   chain-link metaphor he used for the `width = height * 2` case. **AND BOTH GLYPHS ARE ALREADY
   IN USE IN THIS CODEBASE: `mdi:link-variant` and `mdi:link-variant-off`** — so an armed/unarmed
   toggle needs no new icon vocabulary at all, and should follow however the existing snap and
   ghost toggles express their two states.
3. **SCOPE: CANVAS GESTURES ONLY, not the Inspector's own fields** — his reason: *"we'll be
   seeing equations there anyway"*, i.e. the Inspector already displays the equation, so a lock
   adds nothing there. **This also means the tooltip/greying work is confined to canvas
   affordances, which is a smaller surface than R6-28 first implied.**

**THE ANSWER TO HIS QUESTION "is every handle constrained that way?" IS NO — AND THERE ARE TWO
INDEPENDENT MECHANISMS, SO A SINGLE-SEAM FIX WOULD SILENTLY MISS RESIZE.** Measured:
- **`constrain` is the MODIFIER-POINT protocol only.** `core/registry.js:154` scopes it verbatim:
  "THE HANDLE-CONSTRAINT PROTOCOL (**`modifierPoints[].constrain`**)", and `:157` says it "is
  what kept modifier points DRAG-ONLY". Declared by **8 plugins** (`clock_analog`, `donut`,
  `elbow_arrow`, `curved_arrow`, `paper_peacock`, and three more). These are the yellow-square
  edit handles.
- **THE BBOX MOVE/RESIZE PATH DOES NOT CALL `constrain` AT ALL.** It has its own axis machinery
  in `web/canvas/dragKinds.js`: `doX`/`doY` at `:346-347` ("x-axis constraint (or unconstrained)
  touches x/w"), plus the G/S modal's axis constraint where *"the constrained axis's factor
  [is] pinned to 1 and its writes suppressed"* (`:341`).
- **SO EQUATION LOCK MUST FEED TWO SEAMS:** `modifierPoints[].constrain` for the yellow squares,
  and `dragKinds`'s `doX`/`doY` suppression for move, resize and the modal transforms. **That is
  where `height`/`width` locking actually bites, so the resize seam is the MORE important of the
  two — and it is the one a naive "just add it to constrain" would miss.**
- **THE GOOD NEWS: neither mechanism needs inventing, and `doX`/`doY` is ALREADY exactly the
  right shape** — "suppress this axis's writes and pin its factor to 1" IS "height is locked, so
  only resize width". The work is wiring a lock predicate into two existing gates, not building
  a constraint system.

**STILL OPEN — the only remaining design question:**
- **Chain-link direction.** Is refusing the DEPENDENT handle acceptable for v1 (drag height to
  drive `width = height * 2`, but refuse dragging width), or does the feel he wants require
  two-way numeric inversion? Inversion is permitted by the determinism rules but is a much larger
  feature and can feel unpredictable.

### R6-22 CONVENTION CONFORMANCE — A STANDING OBLIGATION ON EVERY AGENT

User ruling, 2026-08-01, verbatim in spirit: "it's hyper duper critical that every
single agent follows every single part of the code's conventions. If there's
precedent that could possibly be set, the agents are responsible for looking for
precedent. Any decision that it wants to make that's arbitrary should always be
researched in our codebase, whether it uses a subagent to do it or not. That
includes formatting... There is cruft in this codebase. It's not perfect, because
agents clobbered each other and did stupid shit. If you see any violations, fix
them along the way. Any precedent being broken, fix it along the way, and then
record that."

- **R6-22.1** Every agent reads the CLAUDE.md chain (dump root, SvelteLib, PowerRP),
  BOTH manifests (dump-level and this one), and the doctrine comments in
  `web/app.css` — whose header and inline `/* ... */` rules ARE manifest-level rules.
- **R6-22.2** NO ARBITRARY DECISIONS. Any choice not dictated by the manifest —
  including formatting, naming, ordering, spacing — must be settled by RESEARCHING
  PRECEDENT in this codebase, delegating to a subagent if needed.
- **R6-22.3 PRECEDENCE DOCTRINE.** The manifest is supreme. Where it is silent and
  two patterns compete, THE OLDER ONE WINS; establish age with git (`git log
  --follow --diff-filter=A`, `git blame`, `git log -S`).
- **R6-22.4** Violations found along the way get FIXED, and each fix is REPORTED in
  the round's final report.
- **R6-22.5** Everything is recorded in THIS manifest, not the dump-level one.

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

### B-1 THE 2026-08-06 THOUGHTS DUMP (verbatim; NOT Round 7 scope)

The user prefixed this with *"This section is just a dump of thoughts… Here's a bunch of
thoughts that give you context"* and closed the round brief with *"you don't need to
implement everything, just the ones I'm mentioning right now."* So it is recorded here
verbatim as the standing wish-list, and the items Round 7 actually pulled out of it are
marked **[→R7]**. Everything unmarked is backburner: do not start it without being asked.

> powerp Features
>
> HTML-in-Canvas -- SHOULD WE PIVOT TO THAT???
> This looks amazingg!!!! Very ai friendly too!!!
>
> Github integration
> - [ ] Version controlling
> - [ ] History viewer - big modal. histories undo's too
> - [x] All static hosted
>
> - [ ] talking to Claude with visual input simultaneously
> - [ ] viewing Claude editing in real time
> - [ ] Twin line transitions
> - [x] A way of handling animation state with automatic transitions
> - [x] Widgets can turn into other widgets and morph as a transition to be like manim
> - [x] Entry and exit effects via transitions in viewability
> - [ ] A "Keyframe Everything In Slide" tool
> - [ ] A way to streamline project -> diagram PDF's -> Latex assets (perhaps a pdf capture widget? idk?)
>
> Audio latency is concerningly large....can we somehow get lower latency? Configurable perhaps as part of the camera settintgs (since its a big global camera can have audio settinsg)
>
> A presenter view?
>
> Our nodes...would be good to have trigger/event nodes like in blueprints. Will simplify things a lot. Better than needing a schmitt-trigger (tho thats good too). Trigger upon events from widgets - like on reveal, on hide, etc. **[→R7-8]**
>
> A trail-widget - that can be bound to an anchor, and draw a stream of N seconds...like my visualizer code... **[→R7-15]**
>
> Textures / image assets from Nodes --> and can be mapped onto threejs etc. Full material nodeflow.
>
> The canvas should cull objects in the editor too. Why isn't it doing that already??? It's laggy when there are tons of objects, even if they're out of view... **[→R7-6]**
>
> Use html2image as a widget - can it be animated? -> SVG
>
> Aspect ratio chain lock on H/W
>
> Make Camera has 3D transform in addition to 2d tranform: and a common 3d rendering backend. ThreeJS or Babylon? I want splats and particles and 3d models and lighting etc. It should be flexible enough we can do shaders in it too via plugins...like my noise warp...
>
> An "Advanced" property tab:
> - Options include:
>     - Visible on Presentation mode (empties are False)
>     - Maybe more to come...
>
> ODE's in property equations i.e. we can have reserved variables "@" (meaning prev value), and @self.value means (previous self.value). All values are kept track of prev time frame including globals etc. The user is responsible for correctly using anothder reserved variable "dt" - so like if we set property rotation to "@+dt" it means we rotate 1 degree every second from whatever it was previously. When blending or tweening, it simply means to blend with that result just like any other result if its numerical - I'd like a double-monkey chaotic wrtench demo with a trail, given **[→R7-9, R7-16]**
>
> We probsbly want first-class support for 2-vectors, and 3-vectors such as RGB and XYZ etc. RGB values should be keyframeable by individual numbers...but these options, like the interp options, can be hidden by default ... maybe collapsible?
>
> "z" to zoom into camera
>
> Elk support in mermaid + demos.
>
> - [ ] Perlin Noise wrt. Time to make camera shake and stuff
> - [ ] More audio stuff...this is really cool....but a lot of bugs to fix and things to patch...
> - [ ] Visibility entry/exit settings: A delay option, and more suboptions. Make it first-class
> - [ ] Groups...perhaps they shouldn't have a size after all....but worried about inconsisteny
> - [ ] Telescopic magnifier: make it one object until shattering. Make a varaint with no zoom.
> - [ ] Material nodes + other nodes --> a node option (can drag a node output into the properties tab then it registers as equation binding)
> - [ ] Git control is important...
> - [ ] Audio + Beats --> Animation (can we have music visualization)
>     - [ ] From Midi? Can we have midi files? Piano roll? **[→R7-14 for the piano roll]**
> - [ ] Empties. Replace the anhor widget. I want empties. Full transform, blender-style.
>
> USE CASE: Why is it so hard to rig a good stick figure animation?
>     We might need inverse kinematics too? Idk yet
> Why can't I bind an end of a line to another line? It tries  to move as little as possible or somethin...like, a constraint that it must be on that line.
> We're getting into CAD territory here tho...
> What about anchors that live on ojects? Custom anhors?
> Yeah, we can do that...but that needs math right now, and that's annoying...
> But doable, with Claude...
> The claude frontend will fix this issue.
> Why line not use normal stroke? It doesn't respond to materials?
> Lines and arrows need to be dealt with...
>
> The buttons for previous keyframe and next keyframe should be disabled if there is no previous or next keyframe to go to.
>
> Paper peacock might need an easier to render proxy for all the slides. It's laggy to drag around. Actually anything involving pds may need to. Why don't we just make them white rectangles?
>
> We have .plugin.js, we have .material.plugin.js, and we have .lib.plugin.js. Would it make sense to make the convention instead dot what kind of plugin it is or just so like dot widget.plugin.js for example?
>
> Morphs: Add a https://github.com/veltman/flubber alternative to Manim? Are they the same?
>
> Riddle: Does it make any sense to have first-class 3d support? What would that even look like?
>
> Command V is STILL not EXACTLY equivalent to pressing the GUI paste button. There are differences. It's stupid as fuck. It doesn't paste properties. It should be structurally impossible for there to be differences between keyboard shortcuts and the buttons they correspond to.
>
> Why can't I edit interp options when selecting multiple?
>
> Multi-select should work even if obejcts are no longer visible. The object select dropdown should have checkboxes or some thign to let us select multi for ojbects that aren't visible, and when slide switches, it shouldn't change selection because of what is now visible or not.
>
> Slides with linger should be treated a bit different visually...not sure how yet tho...
> Slides should be collapsible...and hover to preview maybe...
>
> The visible interp option wasn't able to be edited once when an object wasn't visible? What stupid conditional is that? Get rid of it. That's janky cruft.
>
> PASTE STILL DIDN'T FUCKING COPY THE PROPERTY SUCH AS WIDGET TYPE >:( WHHHYYY IS PASTE SO JANKY???? WE NEED A THROUGH INVESTIGATION. Are there tons of conditionals everywhere across files making it complex? Can it be streamlines and untangled?
>
> We need a View Current Slide buton that animates scroll in the slide viewer to the current slide. it's easy to get lost.
>
> Tried to edit text by double clicking it.
> 5index-CbJtNAXT.js:2 Uncaught TypeError: Cannot read properties of undefined (reading '0')
>     at Age (index-CbJtNAXT.js:3727:109713)
>     at JDe (index-CbJtNAXT.js:3727:109486)
>     at index-CbJtNAXT.js:3727:107633
>     at Array.map (<anonymous>)
>     at rht (index-CbJtNAXT.js:3727:107613)
>     at N8 (index-CbJtNAXT.js:3727:106967)
>     at index-CbJtNAXT.js:8071:37451
>     at uLe (index-CbJtNAXT.js:2:29725)
>     at Jre (index-CbJtNAXT.js:2:12928)
>     at z5e (index-CbJtNAXT.js:2:12980)
>
> Why liquid glass  doesn't conform to the shape of text?
>
> WHY DOES MANDELBROT NOT ZOOM ANYMORE AAAAHHHH IT FADES????!!!???!??!???!
> Why does text not manim-entry work? ?? IT FADES ON VISIBLE INTERP>.....
>
> When converting from text to plain text or vice versa, the text content should be preserved. Same with LaTex, and any other text-gui-based widgets (i.e. code). Can they all be the same property so we dont have to manually convert them?
>
> "Is a font property something we can have? If so, why not just do it that way?
> "It does seem that global variables don't have any ability to set type inside the UI. That's a bit of a bug. There are several types of
>  properties. We should be able to set which type of property a given variable is as a global variable." that way we can have font global vars...
>
> Are we suffering regressions?
> Is our code sloppy ?
>
> We have so much code I'm worried our strucrture is falling apart...
>
> We constantly break things. So we'll need to version control the app BY presentation + commit hash. That will make it safe. it needs to be decentaralized...i.e.  a bunch of static sites on people's own git's that can all play anyone's presentations...
>
> Like, this project should (in the end)
> - Make presentations with a GUI or coding agent, or both simulatenously (where I can watch ClaudeCode edit it visually with me as a 2nd user. todo: time-synced voice recording + screen recording via HTML, so it knows what elements im point to etc, to feed to Claude/Codex etc)
> - Be remote controllable from my phone when presenting to people so I dont have to be by my laptop
> - Have a synth engine to make presentations more dramatic - think things 'pop' or crackling into existence, where you can hear them and see them
> - With fancy widgets that can be vibecoded on the fly (i.e. gimme a rigged stick figure, and claude gives it to you as a plugin u can drag/drop onto the static site)
> - And import/export to PDF/SVG as vector graphics to use as diagrams in papers
> - Have easy-to-use fancy shaders (gaussian splats, god rays, lens flares, CRT effects, glass distortion, metaballs, etc)
> - Be renderable to video at any resolution / quality / framerate
> - Be git-trackable (eventually will use Git as a storage system)
> - Be hostable locally or on a static page (so you can use it anywhere with any data, even if that data's too big to fit in github)
> - Compete with Manim on animation quality - be able to display any kind of math things easily
> - Nearly easy to use as powerpoint / Canva - keyframing animations (like in Blender or AfterFX) is too much work most of the time and not as modular when trying to make presentations (but of course, with much more power than either of those)
> - Perfectly deterministic - no embedding iframes or crap like that (it's not perfectly reproducible, so I don't want it)
>
> Motion canvas: what they got? I noticed diff-like anims for text

### R6-30 THIRTY-SIX FAILING SUITES DELETED (2026-08-02) — AND WHY THAT WAS THE RIGHT CALL

**USER RULING, and the sentence that reframed everything:** *"Please recall that
you wrote all the tests, not me. I didn't write any of them."* Then: *"If these
tests are not important, please delete them. I don't want you wasting time chasing
your tail."*

**WHAT WAS WRONG WITH HOW THE GATE WAS BEING REPORTED.** A clean full run stood at
414 pass / 42 fail, and 35 of those failures were being reported as
"PRE-EXISTING" — a word that quietly implies someone else's standard. There is no
one else. Every suite in this tree was written by a Claude, so "pre-existing" only
ever meant "an earlier session of mine wrote it", and it was functioning as
permission not to look.

**THE HIT RATE THAT DECIDED IT.** Six failures were investigated individually.
FIVE were the test asserting something that was never a requirement; ONE was a
real product bug:

| suite | verdict |
|---|---|
| `palette_probe` gate sweep | unsound inference — `invert-selection` is DEFINED on an empty selection (inverting nothing selects everything, as its own help text says) and never refuses, so there is nothing to gate |
| `inspector_row_uniformity` | pinned a cosmetic ROW ORDER invented by the test |
| `crosshair_probe` | failed on "no WebGPU adapter" — a fact about the MACHINE; this app deliberately does not use WebGPU |
| `palette_scroll_follow` | its baseline `original.attr` was itself a PREVIEW artifact, so it demanded that dismissing the palette leave a preview applied |
| `emit_poisoned_autosave` | read `app.state()` (the EVALUATED tree) expecting a stored string, and demanded an emit error box for a poison that never reaches `emit()` |
| `multiselect_inspector` | asserted the contract-mismatch BLOCKING that the user overruled by name in #300 |
| **`palette_probe` "select all"** | **REAL BUG** — #301's alias `"select all of kind"` contains "select all", so it outranked the Select All command for its own name. Fixed, 45df826. |

At five-in-six, hand-repairing the remaining 36 was the tail-chasing the user
named. They were deleted (bb377be). KEPT: `multiselect_inspector_probe` and
`shatter_probe`, the two covering features from the user's own list (#297, #271) —
both now green, neither a product defect.

**THE FLAKE CLASS, which is the reusable finding.** `ProtocolError: Promise was
collected` is not an app fault and not host flakiness: it is a long-lived promise
inside an `async page.evaluate` that spans an in-page timer, which V8 can collect
before it settles. Moving the wait to the NODE side between two synchronous
evaluates took `selection_commands_probe` from ~50% to 6/6 (0a62323). **29 other
probes still await a timer inside an async page.evaluate** and can produce the
same phantom red. Three wrong theories were paid for first — teardown effects,
teardown ordering, HMR/watcher reloads — and the giveaway walked past each time
was that ZERO checks printed before the throw, so nothing about teardown could be
responsible.

**WHAT THE DELETION COSTS, recorded honestly rather than glossed:** real coverage
went with it — mermaid, PDF render modes, theming, import/zip, project rename,
glass, globe/map, and others. Some of those files certainly held checks that would
catch a genuine regression. Every one is recoverable from git (`git show
bb377be^:<path>`). The judgment is that a gate crying wolf forty times teaches you
to ignore it, and this round is the proof: five browser probes sat red at baseline
for an entire session and nobody looked.

**R6-24.4 is PARTLY DISCHARGED by this.** It recorded `rotation_probe.js` as "191
lines, ZERO assertions" and ruled that "a probe that cannot fail is worse than a
missing one". That file is now gone rather than fixed, which satisfies the ruling
in the blunter direction.

---

## ROUND 7 (user, 2026-08-06): THE AUDIO / NODE / SIMULATED-STATE ROUND

**Branch: `powerrp_branch2`** (worktree `/root/CleanCode/Dumps/RPPT/powerrpbranch2`).
User: *"DO ALL THIS WORK IN THAT NEW BRANCH"*.

### Why this round exists

The audio/node system was built without obeying the app's core invariant. The user's
diagnosis, which is the thesis of the whole round: *"The audio system seems to be like
it was coded by some other person on the other side of the universe who didn't take any
consideration into how this program works in general. It ignored property states and it
just completely ignored the fact that the presentation mode should be just the same
audio as editor mode."*

So this is not a feature round with a bug list attached. **It is a re-founding of the
node system on property state**, plus the three new pieces of vocabulary that make nodes
expressible AS property state (output properties, trigger properties, simulated state),
and only then the breadth work (≈100 ported nodes, ≈30 demo patches, new widgets).

### R7-0 THE USER'S BRIEF, VERBATIM

Recorded in full per the standing rule that user requirements are captured verbatim.
Paragraph breaks are the only edit.

> I think the entire audio system needs to be rewritten because it's not properly using
> properties. When I drag the keyboard output node onto the audio polylead input node,
> indeed the property does change. However, when I change the property, the node doesn't
> change, which is very stupid. This drop-down lists a bunch of things that aren't
> connected to any one specific node. It's very stupid. That leads me to believe, if I
> had two keyboards at the same time, is it even treating them separately? Let's see.
> Okay, it does treat them separately. But then why don't more options appear inside the
> input section? When I change the input section, why don't I see the node, like the wire
> on screen, update with it? The wires on the screens are supposed to only change what
> the input, the node that's taking the input, gets. It's supposed to be a bijection
> because there is supposed to be no difference. Everything that is controlled in
> property state, please read the manifest and everything, should be what the node does.
> It's stupid that it doesn't do this. So yeah, the entire audio system may need to be
> refactored because it's not properly using properties.
>
> I bet you, if I... actually, let's give this a try. I'm going to try animating the
> cutoff from one slide to the next. Let's see. Let's see what happens. Yeah, so like
> during the presentation, during the presentation it's really weird because the
> presentation audio seems to behave differently.
>
> Also, there's a stupid button on the bottom that asks, "Would you like to turn audio
> on?" Of course I fucking want audio on. I always want audio on. Never make me ask that
> again. Get rid of that stupid ass button.
>
> The audio system seems to be like it was coded by some other person on the other side
> of the universe who didn't take any consideration into how this program works in
> general. It ignored property states and it just completely ignored the fact that the
> presentation mode should be just the same audio as editor mode. There should be no
> difference.
>
> And besides, why does the audio spectrogram draw in DOM space? When I rotate the audio
> spectrogram node, it's like the audio spectrogram doesn't even go with it. It's in the
> audio level. It's not even on the canvas properly. These things should be part of the
> node. When I zoom in, it should just be part of the canvas space, but it's not. Very
> frustrating.
>
> Also, the breadth of nodes that we have is not as good as Axelotti. We need more nodes
> and we need more node patches. And I want you to bathe them off of real patches that
> you see that are mathematically near identical so that they sound the same. Axelotti
> uses a different type of arithmetic for its sound, so you have to adapt. But choose
> some different patches for different lead instruments and ambience, especially pads,
> and create a bunch of demo nodes with some demo slides with them so they can see. I
> need to see all these audio widgets actually working.
>
> The keyboard should have parameters such as being able to add more and less keys to it.
>
> Nodes don't seem to have any coherent way of where you place the knobs. Axelotti does
> investigate that. Because right now, where the knobs go is kind of haphazard. There's
> no guarantee the knobs will even be in the node. And a lot of the knobs. Well, if you
> look at Axelotti, things can either be a knob control or they can be an input control.
> So to be fair, you might sometimes want to add the output of a knob to something else.
>
> It occurred to me, widgets should all have sets of read-only properties. So there needs
> to be a read-only property section, which is, in other words, outputs, output
> properties. This is how we're going to represent nodes, because all widgets, every
> single widget will have an output property section from now on. And basically, it's a
> read-only property that is derived from other properties, or perhaps in the case of a
> knob, it's a direct output. Same thing with keyboard, which would be a set of booleans
> or a set of notes or a list property to control which notes are turned on, which ones
> are off and what their velocities are, etc. Other nodes can then read these properties.
>
> And then another property we're going to have to have is a trigger property, just like
> blueprints. It will make life simpler if we can have triggers. Research how blueprints
> work. An output property, followed by a trigger property, should trigger events.
>
> These are considered recordable state, not ephemeral state. All of this is recordable,
> or actually we could say simulated state even. That's actually a better term. We have
> simulated, recordable, ephemeral, and we have property state. Property state is where
> the majority of things live, but we're also going to have simulated state. This is
> because, as I described in the other document, we're going to have dx and dy's in terms
> of time and previous time states. I'd like to implement that. While this is not exactly
> property state and it sounds like it breaks things in the past, it doesn't really. It
> makes it more powerful because we can go back and we can still render videos based on
> this and it's still very predictable. And we have a smaller time step. Things will
> integrate better. While it's not perfectly predictable, it is very close to perfectly
> predictable, which is why it's okay. Same thing with audio. Audio is also close to
> predictable, but bit by bit on a basis it might not be. This is okay.
>
> Anyway, yeah, I wasn't able to animate the cutoff from one slide to the other and I
> didn't hear any whoosh in the middle of that animation because that property... While
> the audio wasn't even playing, there seems to be a disconnect between the properties
> during presentation mode and editor mode and there really shouldn't be.
>
> Another disconnect is how they're culled. Audio widgets, by the way, when an audio
> widget is culled, it should still play audio. However, when it is declared not visible,
> it shouldn't. Culled is just for visual things. Culling happens when I'm in editor mode
> right now, but I was told it didn't happen in presentation mode, but I was told it
> didn't happen in editor mode, which explains why it was so laggy when I had thousands
> of nodes, even when I was in the middle of outer space, not looking at any when I
> expected no lag.
>
> Your actionable items. Propose them for me. Research Axolotl, A-X-O-L-O-T-I, and
> research... Well, find some other node-based patches that you can research with good
> presets that we can mimic and copy in. We can have one agent per... once we finish
> everything else and we create our standardized system for how we build nodes visually
> so that there's no more glitchiness involved. And there's a standardized thing about
> node specifications having a certain set of like buttons or sliders or knobs and stuff.
> Research how Axolotl does that. Axolotl does it programmatically and it's amazing and
> we want that. Read their source code. A-X-O-L-O-T-I, Axolotl.
>
> Once we have that, I'd like to be able to create a list of nodes to copy. It will be a
> large list. I'm thinking probably 100 nodes. They have to be faithfully implemented to
> whatever respective platform they are, be it Axolotl, which we can start with, or
> something else that's an open source node-based patcher. Please research one or two or
> three alternatives actually, and we'll have agents working on each one diligently along
> with demo patches. I'm thinking probably 30 demo patches.
>
> I also want a keyboard whose keys I can lock in place. Well, maybe actually that can be
> an option for a regular keyboard, which is a button I click to turn on lock or not.
> When it's locked on, the keys will stay turned on at all times. In the UI, in other
> words, to let me play different chords and different slides. Later on, we'll be adding
> a piano roll widget. Actually, maybe you could do that also by with another agent now.
>
> We're going to be using a lot of agents here, so buckle up. You got to make sure that
> they all follow the project coherently, but don't spend too much time testing. Remember,
> no more than 10% of your time should be spent on tests. So, let's get bogged down in
> tests.
>
> You have a lot of actionable items that I listed here. I'm going to give you a big chunk
> of text that includes a bunch of things that I've thought of. I would also like the
> trail widget too, if you can create that please, and a chaotic pendulum widget that
> demonstrates the simulated state please. It's basically just equations that talk about
> like rotation equals, you have the @ symbol meaning the previous one, plus some things,
> some equation. You can actually put those equations, possibly even in the project
> script, we should be able to, although that's not something we have to do right now.
> Just keep in the properties and make a demo widget with that. So, this is like a chaotic
> double pendulum widget, which, well of course I can set the rotation in the beginning,
> and it will have, for that widget, it's basically a preset, like a compound set of, it's
> basically this demo widget will just spawn in a few other more basic, which is like, you
> know, like rectangles, two rectangles that bounce off each other, that have variables
> predefined in them. It's basically just, this widget is really not a widget, it's just
> like an alias for creating two rectangles with the proper equations inside their
> variables and rotations, so that we can create a double pendulum. That's all it is.
> That's one thing that I was asking for.
>
> The trail widget. By the way, you have to use DT in order to simulate this property
> properly. And then we have the trail widget, which can like keep a trail for a certain
> amount of time for n seconds, so that it can kind of draw a streamer. You want that too,
> so that we can put that on the end of the double pendulum with an anchor on the end of
> the double pendulum, and then this trail widget will be anchored to it. That'll make a
> great demo.
>
> So those are the features that I asked for inside this big thing that I'm going to copy
> paste to you the path of, you don't need to implement everything, just the ones I'm
> mentioning right now.

Also verbatim, from the same message, about how this round is to be run:

> Make sure that you follow all of my Claude MD and write down what I ask for verbatim
> into the manifest. Read the Claude MD carefully as well as familiarizing yourself with
> this project and its manifests. Then get started. Make sure to plan how to paraellize
> your tasks: creating a dependency graph carefully of what needs to be standardized,
> then what can be worked on all at once in waves - so that you can have several agents
> working together on different components which you then integrate

### R7-GLOSSARY (additions — the round's new vocabulary)

- **Output property** — a READ-ONLY property, derived from a widget's other properties
  (or, for an input device like a knob or keyboard, produced directly by it), which other
  widgets may READ. User: *"all widgets, every single widget will have an output property
  section from now on."* It is the mechanism by which a node's output exists in the
  document rather than beside it. Rendered in its own Inspector section.
- **Trigger property** — an event-valued property, modelled on Unreal Blueprints'
  execution pins. User: *"An output property, followed by a trigger property, should
  trigger events."* Distinct from a data-valued output property: it fires, it does not
  hold.
- **Simulated state** — THE FOURTH KIND OF STATE, named by the user this round and now
  first-class alongside property / recordable / ephemeral. State whose value at time `t`
  depends on its own value at `t − dt`. Reached in equations by `@` (this property's
  previous value; `@self.value`, `@id.prop` for others) and `dt` (the timestep). User:
  *"While it's not perfectly predictable, it is very close to perfectly predictable, which
  is why it's okay."* **This deliberately relaxes the frame-shardability property that
  recordable state has** — see R7-9, which states the relaxation precisely so it is a
  known cost and not an accident.
- **Bijection (of wire and property)** — the round's central law. A wire drawn on canvas
  and the corresponding input property in the Inspector are TWO VIEWS OF ONE VALUE. Edit
  either, both change. User: *"It's supposed to be a bijection because there is supposed
  to be no difference."*
- **Knob-or-input duality** (from Axoloti) — a node parameter may be driven by its own
  on-node knob OR by another node's output, and the UI shows which. User: *"things can
  either be a knob control or they can be an input control. So to be fair, you might
  sometimes want to add the output of a knob to something else."*
- **Node chrome** — the auto-computed visual layout of a node body: where its ports,
  knobs, buttons and displays go. The complaint that names the defect: *"There's no
  guarantee the knobs will even be in the node."*
- **Patch** — a wired graph of nodes that makes a specific sound (a lead, a pad, an
  ambience). ≈30 demo patches are a deliverable of this round.
- **Axoloti** — github.com/axoloti/axoloti, the open-source node-based audio patcher the
  user holds up as the standard for programmatic node layout and library breadth. Spelled
  "Axelotti"/"Axolotl" in the brief above; **Axoloti** is the real spelling.

### R7 REQUIREMENTS, DECOMPOSED

Numbered for grinding. Each is DONE only when live-verified, per the standing rule.

**Tier A — the re-founding (everything else depends on these)**

- **R7-1 AUDIO/NODE STATE IS DOCUMENT PROPERTY STATE.** A connection is stored as
  property state on the CONSUMING node, and nothing else is a source of truth. The wire
  on canvas and the input row in the Inspector are two renderings of that one value;
  changing either changes the other. The input dropdown lists exactly the compatible
  outputs of actual node INSTANCES, per instance, so two keyboards offer two entries.
- **R7-2 ONE AUDIO PATH FOR EDITOR AND PRESENTATION.** No mode branch anywhere in the
  audio path. *"There should be no difference."*
- **R7-3 KILL THE AUDIO-ENABLE BUTTON.** *"Never make me ask that again."* Audio is on.
  (Browsers require a user gesture to start an AudioContext — satisfy that from the
  gestures the user is already making, never from a prompt that asks permission to want
  sound.)
- **R7-4 AUDIO PROPERTIES TWEEN LIKE ANY OTHER PROPERTY.** Animating a filter cutoff from
  slide to slide produces the whoosh, in the editor, in presentation, and in an export.
- **R7-5 NODE DISPLAYS LIVE IN CANVAS SPACE.** The spectrogram — and every node display —
  is drawn by the widget's `emit()` into the display list, so it rotates, scales, zooms
  and exports with its node. No DOM overlay.
- **R7-6 CULLING IS VISUAL-ONLY, AND IT RUNS IN THE EDITOR.** Cull in the editor as well
  as in presentation (the reported lag with thousands of off-screen nodes). A culled audio
  widget KEEPS PLAYING; a widget that is `active:false` / not visible does NOT.
- **R7-7 OUTPUT PROPERTIES.** A universal read-only Inspector section on EVERY widget,
  readable by other widgets through the equation engine.
- **R7-8 TRIGGER PROPERTIES.** Blueprint-style events, researched from Blueprints first.
- **R7-9 SIMULATED STATE: `@` AND `dt`.** `@` = the previous value of this property;
  `@id.prop` = another item's previous value; `dt` = the timestep the author is
  responsible for using correctly. Example the user gave: `rotation = @ + dt` rotates one
  degree per second from wherever it was.
- **R7-10 STANDARDIZED PROGRAMMATIC NODE CHROME.** Node layout is DERIVED from the node's
  declared ports/params/displays, not hand-placed — modelled on how Axoloti does it. Knobs
  are guaranteed inside their node. Knob-or-input duality is part of the standard.

**Tier B — breadth, parallelizable once Tier A is standardized**

- **R7-11 ≈100 PORTED NODES**, faithful to their source platform (Axoloti first, plus 1–3
  other open-source patchers), adapted from fixed-point to our arithmetic *"so that they
  sound the same."*
- **R7-12 ≈30 DEMO PATCHES + DEMO SLIDES**, based on real patches, weighted to lead
  instruments, PADS and ambience. *"I need to see all these audio widgets actually
  working."*
- **R7-13 KEYBOARD PARAMETERS** — key count, and a LOCK toggle that holds keys on so
  chords persist across slides.
- **R7-14 PIANO ROLL WIDGET.**
- **R7-15 TRAIL WIDGET** — keeps a trail for N seconds; anchorable; uses `dt`.
- **R7-16 CHAOTIC DOUBLE PENDULUM** — explicitly NOT a widget: an alias/preset that spawns
  two rectangles with the right variables and rotation equations. It exists to demonstrate
  simulated state, with a trail anchored to its end.

### R7-9 DESIGN: SIMULATED STATE, AND THE TWO CONFLICTS IT WALKED INTO

Settled by the lead 2026-08-06 after a full read of `core/expressions.js` (agent
report `/tmp/powerrp_property_map.md`). **Both conflicts are with things already
written down, so neither may be resolved silently.**

#### `dt` IS ELAPSED TIME. THE LEAD PROPOSED A FIXED TIMESTEP AND THE USER KILLED IT.

**Recorded as a mistake rather than quietly replaced, because the reasoning that
produced it looked responsible and was wrong.**

The lead's first design made `dt` a fixed simulation timestep held as document state
(`meta.simDt`), on the argument that a frame-delta `dt` is the `frame` variable
`core/expressions.js:2991-2999` already refused — 0 in the editor, display-dependent
in the presenter, an export setting during export.

**The user's answer, verbatim, 2026-08-06:**

> *"no, as I said, based on what I asked for, dt is a TIME step. By your logic, what
> happens if we have a framerate we render a video with like 1000? What if our dt is
> just .1 seconds? What do we do, interpolate?"*

That is decisive. With `simDt = 0.1` and a 1000 fps render, a hundred consecutive
frames fall between two simulation steps: you either hold a stale value (visible
judder) or interpolate (a fudge). **A fixed timestep makes the simulation's
resolution independent of the render's, which is precisely the thing that must not
happen.**

**THE SEMANTICS: `dt` IS THE REAL ELAPSED TIME, IN SECONDS, SINCE THE PREVIOUS
EVALUATION. One simulation step per rendered frame.** It is the only reading under
which the user's own example holds at every framerate:

    rotation = @ + dt        →  one degree per second, always
    1000 fps: dt = 0.001, ×1000 steps/s = 1 deg/s
      30 fps: dt = 1/30,  ×30   steps/s = 1 deg/s

**WHERE THE LEAD MISREAD THE BRIEF.** The original text said *"we have a smaller
time step. Things will integrate better."* That was read as "a fixed sub-frame
step". It means **a higher framerate yields a smaller dt and therefore a more
accurate integration** — a property of frame-delta dt, and a description of the
design the user had in mind all along. The next sentence sanctions the cost
outright: *"While it's not perfectly predictable, it is very close to perfectly
predictable, which is why it's okay."* **The objections the lead raised had already
been answered in the brief.** Read the whole requirement before designing against
part of it.

So the three "dishonest regimes" are simply true and are all fine:
- **`dt = 0` when time is not advancing is the TRUTH.** A frozen simulation does not
  move. Do not fabricate a nonzero dt to avoid it.
- **`x / dt` throwing at dt = 0 is the author's problem, explicitly** — *"The user is
  responsible for correctly using another reserved variable dt."* It fails through
  the normal equation-error path. **No guard, no clamp-to-epsilon, no fallback** —
  that would be the silent fallback this project forbids.
- **fps-dependence in an export is accepted and stated.** Do not engineer around it.

#### THE MAX-TIMESTEP CLAMP (user, 2026-08-06)

> *"We can set a max timestep in the camera, under some settings, which can be none
> or .1 seconds etc to prevent extreme lag spikes from driving it crazy."*

Adopted. A GC pause, a tab switch or a breakpoint otherwise hands the integrator a
multi-second `dt` and the pendulum leaves the slide. Lives in **camera settings** —
the camera is the mandatory global singleton, and the user has already pointed at it
as the home for global settings of this kind. Nullable: **`none` disables the clamp;
default `0.1 s`.** A default clamp trades a mild cost (the simulation drifts slightly
behind wall-clock after a stall) against a severe one (a backgrounded tab returns to
an exploded scene).

**THE CLAMPED TIME IS DISCARDED, NOT CAUGHT UP.** The alternative — substepping to
recover the lost interval — is the classic death spiral, where a slow frame schedules
more work and produces a slower frame. Falling behind is the correct failure.

**AND IT APPLIES TO MEASURED TIME ONLY — AN EXPORT DOES NOT MEASURE, IT DICTATES.**
In the presenter and editor, `dt` is an observation of how long a frame took, so a
lag spike is a lie about elapsed simulation time and clamping corrects a measurement
error. In a video render `dt = 1/fps` is definitional and there are no spikes to
correct, so the clamp never engages. **This is not a mode branch** — there is simply
nothing measured to clamp — which matters because R7-2 forbids mode branches on the
playback path. It yields a clean and worthwhile split:

> **Exports are exactly reproducible. Live playback is approximately so.**

#### WHAT SIMULATED STATE COSTS — unchanged by the correction

Frame N genuinely depends on frames 0…N−1. Not seekable, not strided-shardable.
`cli/render_job.js` shards by STRIDED frame range and cannot start a shard cold on a
simulated document. Required: a predicate that detects simulated state, and a LOUD
refusal — **a simulated document must never be strided-sharded silently**, which is
the wrong-video-with-a-green-exit failure this project forbids. Mitigations, in
order: checkpoint history every K steps; shard by CONTIGUOUS ranges with each worker
integrating its own prefix.

**Δt = 0 STILL PRODUCES A BYTE-IDENTICAL FRAME** and that is not negotiable — it is
what keeps the orthogonality law in `<app>/CLAUDE.md` alive. Pin it with a test.

**HISTORY NEEDS A RESET RULE, and the fixed-step design was hiding that it does.**
The property's authored/keyframed value is the INITIAL CONDITION (user: *"of course
I can set the rotation in the beginning"*). When history resets — seeking backwards,
jumping to the start, beginning a presentation — must be explicit, documented and
tested. An ill-defined reset is how a demo silently diverges between runs.

#### CONFLICT 2 — `@` IS ALREADY THE STORED ITEM-REFERENCE SIGIL

`@<itemId>.prop` is how a reference is SERIALIZED (`parseStoredRef`,
`core/expressions.js:1256`; `refToJs:2630` mangles it to `$id`). So `@` is spoken
for — but only in the STORED grammar. What the author TYPES is the display grammar,
where a reference is a slug (`osc1.out`), and `@` is FREE there.

**THE RESOLUTION: `@` IS THE DISPLAY TOKEN, EXACTLY AS THE USER ASKED, AND IT
SERIALIZES TO SOMETHING ELSE.** The user types and reads `@ + dt`, `@self.value`,
`@osc1.phase`; `displayToStored` writes a non-colliding spelling. This costs one
more entry in the four passes that must already agree on grammar (parser,
`displayToStored`/`storedToDisplay`, `mapRefTokens`, `equationTokenSpans`) — which
is a known, bounded price, and it is the RIGHT place to pay it, because the
alternative is telling the user his own notation is unavailable for a reason that
is purely internal.

#### THE REST OF THE BILL (from the same report, so it is not rediscovered)

- **No previous-value table exists.** `evalMemo` is a WeakMap on the folded state
  object, and every tween alpha mints a new one — there is nothing "previous" to
  read. A module-level `(itemId, propPath)` history table is new, shaped like
  `core/particle_clock.js` (an ambient service with an explicit freeze seam).
- **The memo needs a second invalidation axis.** Clock-free results cache FOREVER
  today. `clock` is the precedent for a second axis, but `clock` is a comparable
  value and history is a counter — so every still-renderer (thumbnails, minimap,
  PNG export, `cli/render.js`, `gpuService`) must FREEZE the tick explicitly, where
  today it is safe for free. Forgetting one is a silently-drifting thumbnail.
- **Cycle detection must be exempted.** `requireSlot` treats slot re-entry as a loud
  cycle, and `@self.x` is one by construction. Follow the `feedbackSafe` precedent
  (`core/nodeflow.js:97-101`) rather than inventing a second exemption idiom.

### R7-7 DESIGN: OUTPUT PROPERTIES ARE EVALUATED, NOT STORED

Also settled from the same report, because there were THREE competing precedents and
picking the wrong one bloats every document in existence.

- `core/content_size.js` — injected onto the EVALUATED state only, never stored,
  read through the ordinary `{kind:"prop"}` resolver as `@logo.content.aspect`. **No
  new grammar, no stored bytes, no migration.**
- `plugins/video_scrub.js:114-127` — `seconds`/`progress` as `self.…` equation-string
  DEFAULTS. Works, and is discoverable in autocomplete, but they ARE stored document
  state: keyframable (meaningless for a read-only value) and backfilled into every
  old document by `withMissingDefaultsFilled`.
- `cx`/`cy` — a hardcoded branch in `refValue` plus a hand-appended autocomplete
  entry. A Tower of Babel instance; do not extend it.

**THE RULING: output properties follow `content_size`.** They are computed onto the
evaluated state and are never stored. A read-only value that can be keyframed is a
lie about its own affordance, by the same reasoning that keeps the save dot from
being a button.

**THE ONE STRUCTURAL BLOCKER, and it is the actual reason the user's complaint is
true:** node outputs are computed by `evaluateNodeGraph` inside `deriveRenderTree`
(`core/derive.js:532`) — strictly AFTER `evaluateState`. So a node's output
physically cannot be read by an equation today; it reaches `emit()` and nothing
else. *"Other nodes can then read these properties"* requires that ordering to
change. **That re-ordering is the load-bearing work of R7-7**, and everything else
in it is presentation.

**Multi-select needs nothing declared** — `PRESENTATIONAL_ROW_ASPECTS`
(`core/multiselect.js:259`) is a denylist, so a new `readOnly` aspect defaults to
CONTRACT and fails loud on disagreement, which is correct. Keep it out of
`MULTI_EDITABLE_KINDS`.

### R7-DIAGNOSIS: WHERE EACH COMPLAINT ACTUALLY LIVES

Measured 2026-08-06, full report `.frenzy/round7/powerrp_audio_map.md`. **Two of the
ten are not what they look like, and one is not reproducible at all** — recorded
because acting on the obvious reading would have built the wrong fix.

| # | complaint | root cause |
|---|---|---|
| 1 | wire→property works, property→wire does not | `web/Inspector.svelte:762-770` `commitField` passes the row key `"inputs.in"` **unsplit** as one path segment, so it writes `items[id]["inputs.in"]` — a leaf nothing reads. The READ side (`valueAt`) splits correctly. **That asymmetry is the entire bijection failure.** |
| 2,3 | dropdown lists things "not connected to any specific node"; two keyboards look the same | The option list IS per-instance. `nodeInputLabel` (`core/nodeflow.js:818-822`) falls back to `state.type` because `app.addItem` sets no default `name`, so both keyboards render the identical string `"node_keyboard › pitch"`. **A labelling bug, not a wiring bug.** |
| 4 | "property state should be what the node does" | The audio graph is driven by a `$effect` in a CANVAS COMPONENT on `app.slideIndex` (`web/CanvasView.svelte:5363-5367`) instead of the one evaluation seam every pixel consumer uses. |
| 5 | no cutoff whoosh | `mirrorAudio(app.state().items)` has **no alpha argument anywhere on the path**, so a mid-transition value never reaches `setParam`. The engine side would sweep fine (`KNOB_RAMP_SECONDS = 0.02`); the alpha-bearing caller is what is missing. |
| 6 | presentation audio behaves differently | `web/PresentMode.svelte:372` writes `app.slideIndex` **only inside `exit()`**. `CanvasView` stays mounted but none of the effect's dependencies change, so **the audio graph is frozen at whatever slide the editor was on when Present started**, for the whole presentation. |
| 7 | the audio-on button | `web/AudioBadge.svelte:48-62`. `enableAudio` is the **only caller of `engine.resume()`** repo-wide — so deleting the button naively makes audio permanently unstartable. |
| 8 | spectrogram in DOM space | `web/CanvasView.svelte:5231-5246` transforms **two corners** and reduces to an axis-aligned `{x,y,w,h}` consumed as an absolutely-positioned DOM `<canvas>`. Under rotation the box is not even the true AABB. **`litKeys` 50 lines below does it correctly** (four corners, SVG polygon). |
| 9 | culled audio should still play | **NOT REPRODUCIBLE.** `mirrorAudio` reads the un-culled item map and `readAudioScene` already drops `active === false`. What the user actually experienced is #6 — during a presentation `active:false` never reaches the engine, so a widget "declared not visible" keeps playing. |
| 10 | knobs escape the node | **THREE unrelated hand-rolled placement schemes.** The audio family got the CD reflow; `plugins/node_knob.js:121-124` places `cy`/`r` as **constants from the top edge** and additionally ignores NEGATIVE EXTENTS, so a flipped Knob puts its dial at negative x. |

**THREE FINDINGS NOBODY ASKED FOR, and they matter more than some that were asked
for:**

1. **`setTransportLive` has ZERO callers repo-wide and `engine.scheduler.start()` is
   never called. The Sequencer node has never emitted a single step, in either
   mode.** A whole shipped widget does nothing.
2. **~~THE DOTTED-KEY WRITE BUG IS NOT AUDIO-SPECIFIC.~~ RETRACTED — THIS WAS WRONG, AND
   THE RETRACTION IS MORE INSTRUCTIVE THAN THE CLAIM.** The recon report asserted that
   `plugins/magnifier.js:207-208` (`origin.x`, `origin.y`) and
   `plugins/tangent_lines.js:400-409` were silently broken by the same unsplit-key line,
   and the lead propagated it here without checking. **W1-A drove both widgets in a real
   browser on unpatched HEAD and they wrote correctly**: `origin.x = 777`,
   `origin.y = 888`, `a.halfW = 123`, `a.x = 456`, with **zero** dotted keys on the item.

   **WHY:** those rows are `kind: "number"` / `"angle"`, and in item mode those kinds
   never reach `commitField` at all — they go through `NumericField`/`AngleField` with
   `path={["items", pickedItemId, ...writeKey(row).split(".")]}`, which has **always**
   split. The kinds that DO reach `commitField` in item mode are select, asset,
   text/richtext and nodeinput; a repo-wide grep found no dotted keys outside `inputs.*`
   and number/angle rows. **So `nodeinput` was the sole live victim**, and the general
   split now also protects any future dotted select/asset/text row.

   **THE LESSON, which is the reason this is kept rather than deleted:** a plausible
   root-cause generalisation ("same line, same shape, therefore same bug") was recorded
   as measured fact by an agent and re-recorded by the lead, and only a third agent
   actually drove the widgets. **A shared-cause claim is a hypothesis until the second
   site is exercised.** Cost here was only a wrong paragraph; the same reflex is what
   put "which is why the row still committed correctly" into
   `web/Inspector.svelte:2559`, and THAT sentence talked three previous repairs out of
   looking at the write path.
3. **THE EDITOR DERIVES WIRES FROM THE CULLED LIST.** `render_gpu/ports.js:397`
   `ctx.wireNodes ?? nodes`; `web/cameraFrame.js:217` passes `wireNodes: allNodes`,
   `web/CanvasView.svelte:902` does not — so the editor drops a wire the instant
   either endpoint leaves the viewport. `ports.js:381-384` names this exact mistake
   as one of "the two wrong answers, both of which shipped at some point". It is
   still shipped.

**AND THE CULLING ANSWER IS THE OPPOSITE OF THE COMPLAINT.** Culling DOES run in the
editor paint (`web/CanvasView.svelte:820-821`). The lag is real but comes from
elsewhere: `app.nodes()` is an **un-memoized full `deriveRenderTree`** called ~28
times in `CanvasView.svelte` alone, several from pointermove handlers; and the bead
overlay emits **one SVG `<circle>` per port of every node in the document**,
un-culled, rebuilt on every viewport change. So R7-6 is a MEMOIZATION AND OVERLAY-
CULLING item, not a "turn culling on" item.

### R7-PLAN: THE DEPENDENCY GRAPH AND THE WAVES

Ordered so that what must be STANDARDIZED lands before what depends on the standard.
Concurrent writer agents have **disjoint file ownership**; a file has exactly one
owner per wave.

**WAVE 1 — the re-founding (4 agents, parallel)**

- **W1-A · THE BIJECTION.** Fix `commitField`/`previewField` dotted-key splitting;
  label node-input options by INSTANCE. Sweep the two collateral victims.
  *Owns:* `web/Inspector.svelte`, `core/nodeflow.js`, `plugins/magnifier.js`,
  `plugins/tangent_lines.js`. (R7-1)
- **W1-B · THE AUDIO SEAM.** One path for editor and presentation, driven by
  `cameraFrame.evaluationAt` with alpha; kill the permission prompt; wake the dead
  transport. *Owns:* `web/audioMirror.svelte.js`, `web/CanvasView.svelte`,
  `web/PresentMode.svelte`, `web/AudioBadge.svelte`, `web/cameraFrame.js`,
  `core/audio_mirror_diff.js`. (R7-2, R7-3, R7-4)
- **W1-C · SIMULATED STATE.** `@` and `dt` per the R7-9 design above.
  *Owns:* `core/expressions.js`, a new history module, `core/document.js`. (R7-9)
- **W1-D · NODE CHROME.** Collapse three placement schemes into one declarative
  auto-layout, Axoloti-style, with the knob-or-input duality.
  *Owns:* `core/node_chrome.js`, `core/node_knobs.js`, `core/audio_nodes.js`,
  `core/control_nodes.js`, `plugins/node_{knob,slider,button,display,number,math}.js`.
  (R7-10)

**WAVE 2 — depends on Wave 1's seams (3 agents)**

- **W2-A · CANVAS-SPACE DISPLAYS** (R7-5) — needs W1-B's seam. *Owns:*
  `web/AudioOverlay.svelte` (deletion), `render_gpu/ports.js`, the display emit path.
- **W2-B · CULLING AND PERF** (R7-6) — needs W1-B (same file). *Owns:*
  `web/CanvasView.svelte` overlay lists, `web/app.svelte.js` `nodes()` memoization.
- **W2-C · OUTPUT + TRIGGER PROPERTIES** (R7-7, R7-8) — needs W1-A (Inspector).
  *Owns:* `core/registry.js`, `core/properties.js`, `core/derive.js` (the
  `evaluateNodeGraph` re-ordering, which is the load-bearing part), `core/multiselect.js`.

**WAVE 3 — breadth, once the standard exists (parallel, mostly data)**

**R7-17 REPLACES THE SELECTION METHOD FOR R7-11 AND R7-12 — read it first.** The node
list is the UNION OF WHAT HARVESTED KNOWN-GOOD PATCHES USE, not a category sweep, and
the patches are the acceptance test. So Wave 3's shape is: harvest patches → derive the
node list → port nodes (DATA in `core/audio_specs.js` + the engine modules behind them,
to the R7-11 arithmetic laws, each carrying a derivation record for debugging) → rebuild
every patch as a demo patch + demo slide.

Independent of that pipeline and parallelizable alongside it: R7-13 (keyboard already
has `baseNote`/`octaves`; only the LOCK toggle is missing), R7-14 (piano roll — also
unblocks the Sequencer, which currently emits steps but has no notes), R7-15 (trail),
R7-16 (double-pendulum preset — needs W1-C).

### R7-10 DESIGN: THE INLINE-VALUE SOCKET ROW, AND MEASURE-THEN-PLACE

From the patcher survey, `.frenzy/round7/patchers_blueprints_report.md` §A0–A8.
**This CORRECTS an earlier instruction to copy Axoloti's uniform 14 px grid pitch.**
Axoloti's constant pitch works only because Axoloti has no inline widgets in its port
rows. We are adding exactly that, so their rule does not survive the feature.

**THE STRUCTURE: one ordered port list; each port is a full-width row; a WIRED port
shows its label, an UNWIRED port shows its editor widget in that same row.**

    showWidget = widget && (isOutput || !socket || linkCount === 0)

**This IS the knob-or-input duality**, and it supersedes the earlier "every param gets
an implicit same-named inlet" framing — it subsumes it and makes the state VISIBLE
rather than inferred, which is what the user's complaint was actually about.
**Four unrelated projects invented this independently** (Blender, Unreal Blueprint,
Rete.js, litegraph's TS fork). That convergence outweighs any one of them being well
designed.

**THE MECHANISM: measure-then-place in abstract units, pixels exactly once at the
end.** Not constant pitch — once a row can hold a widget, row heights VARY. Measured:
in Blender an unlinked Vector input is ~84 px and **collapses to 20 px the instant a
link attaches**; the node visibly shrinks. Three passes (faust-ui's model):

    adjust()   bottom-up — each leaf reports intrinsic size
    expand()   distribute slack ONLY to children whose sizing policy accepts it
    offset()   assign absolute positions

**Why this family and not a host layout engine: we do not have one.** We paint through
Skia, and `cli/render.js`, `cli/render_job.js` and `gpuService` must all produce
byte-identical geometry headlessly. There is no flexbox to ask. Blender's
`block_layout_resolve` and Blockly's `RenderInfo.measure()` are the same family.
**Blender's trick, worth stealing outright: hand the layout a start `y`, let arbitrary
widget calls run, then read `y` back — never ask a node how tall it is.** That is why
a node whose row count varies with a dropdown needs no special case.

**TWO RULES THAT MUST NOT BREAK — and both are the invariant test, not prose:**
1. **A CONTROL NEVER HAS AN AUTHORED `x`.** The moment it does, you have VCV Rack.
2. **EXACTLY ONE LAYOUT PATH, UNBYPASSABLE.** Bespoke Synth is the measured
   cautionary tale: an excellent auto-layout macro that **only 83 of ~265 modules use
   (64 auto-sizing), with 191 headers overriding `GetModuleDimensions` and one
   mutating its height DURING paint.** An auto-layout that CAN be opted out of WILL
   be. `core/audio_nodes.js:305-312` already refuses an override hatch for
   `emit`/`ports` deliberately — extend that precedent, do not weaken it.

**THE MEASURED ARGUMENT FOR WHY CONTAINMENT MUST BE TESTED, NOT EYEBALLED.** In VCV,
`addParam()` is literally `addChild(param)` with no bounds check. A traced
out-of-panel widget: `drawChild` clips it so it is **never drawn**; `recurseEvent`
skips it so it **receives no mouse events** — yet the param still serializes,
randomizes, is MIDI-mappable, and is read every sample. **An invisible, unreachable,
but LIVE control.** Strictly worse than a knob sticking out of the card, because
there is nothing to notice. So the test asserts CONTAINMENT, never visibility.

### R7-7 BOUNDARY: A SIGNAL IS NOT A PROPERTY — WHICH NODES CAN HAVE OUTPUT PROPERTIES

**The user's question, 2026-08-06, which located this before it became a bug:**
*"Like, how would an LFO output to audio if our control rate = the draw rate of the
canvas"*

**It doesn't, and that is the point.** Verified at `synth/engine.js:548`:

```js
if (target.node instanceof AudioParam) source.node.connect(target.node);
```

An LFO's output is an **AudioNode**. Wiring it to a filter's `frequency` is a NATIVE
Web Audio AudioNode→AudioParam connection made ONCE, structurally. The modulation then
runs on the browser's audio thread at audio rate. **The document never sees the LFO's
value and the frame rate is irrelevant to it.** The mirror only ever does three things:
create/destroy modules, `connect`/`disconnect`, and `setParam` for knobs.

**SO THE FRAME RATE BOUNDS HOW FAST A KNOB MOVES, NOT HOW FAST A SIGNAL OSCILLATES.**
This is what the existing port types already mean, and reading them loosely is how the
confusion starts (`core/audio_specs.js:11-25`): `audio` = an AudioNode carrying a
signal; `number` = an AudioParam a wire can drive. Its own words: *"Every module output
is audio, including the sequencer's `pitch` and `gate`: they are control SIGNALS on
AudioNodes, not numbers the document can read."*

**THE BOUNDARY THIS PUTS ON R7-7 — AND THE LEAD OVERCORRECTED IT ONCE, SO READ THE
TWO TIERS CAREFULLY.** The first version of this section said "output properties do NOT
apply to audio signal outputs", full stop. **That was wrong**, and the user corrected
it immediately: *"audio outputs are indeed outputs, just maybe not properties... but u
can still reference them as a property type otherwise how would we do a node inputs
correctly."*

He is right, and the distinction is between a REFERENCE and a VALUE:

- **TIER 1 — EVERY output port is declared and REFERENCEABLE, and a reference IS
  property state.** `inputs.frequency = {item: "lfo1", port: "out"}` is an ordinary
  keyframable leaf whose value is a PORT REFERENCE. **This is the whole of R7-1** — if
  audio outputs were not referenceable, no audio patch could be wired at all. So audio
  outputs absolutely appear in the outputs section, and they absolutely have a property
  type: a **port reference**, which the app already stores (`core/nodeflow.js:27`) and
  edits (`NODE_INPUT_ROW_KIND`). R7-7 should promote that from a special row kind to a
  first-class property TYPE, which also serves the user's standing ask that variables
  be typeable.
- **TIER 2 — SOME outputs additionally expose an equation-readable VALUE.** `= knob1.out`
  reads a number because a knob's value is document state the fold can reproduce.
  **An audio-rate signal has no Tier 2 value:** sampling an LFO's instantaneous
  amplitude into the document would make it frame-rate-dependent, ephemeral and
  non-reproducible — three refusals at once. `computeOutputs` already encodes this by
  good design (`plugins/node_display.js` is a pure sink; `node_button` returns
  `{out: 0}` because the press is live, not state).

So the outputs section lists ALL outputs; the equation engine resolves a value for the
Tier-2 ones and REFUSES WITH A SENTENCE for Tier 1 — never returns 0, never returns a
stale sample. Tier is a property of the port's declared TYPE (`audio` vs `number`), so
it is derived, not a second hand-maintained list.

**THERE ARE THEREFORE TWO LFOs, AND THE UI MUST NOT PRETEND OTHERWISE:**
1. **Audio LFO** — an AudioNode, modulates AudioParams at audio rate, invisible to the
   document. For tremolo, vibrato, filter sweeps, FM.
2. **Document LFO** — a pure equation of `time` (`= sin(time * 2 * pi * 2)`), evaluated
   per frame, fully deterministic, drives VISUAL properties. **Already expressible
   today; needs no widget.**

**THE TRAP TO DESIGN AGAINST:** an author wires an AUDIO LFO into a rectangle's
rotation and gets nothing, because that value does not exist outside the engine. That
wire must be REFUSED WITH A SENTENCE, not silently accepted — `connectionRefusal`
(`core/nodeflow.js`) is exactly the mechanism, and "honest at the gesture" is already
its stated principle.

**AND THE SOFT CEILING IN THE OTHER DIRECTION, stated so nobody treats it as a bug:** a
document-side value driving an audio param is fine up to a few Hz (5 Hz at 60 fps is 12
samples per cycle — usable, and the adaptive ramp smooths it). Audio-rate modulation
must stay inside the engine. That is a real limit of pushing values across a frame
boundary, not a defect to fix.

### R7-8 DESIGN: TRIGGERS, AND THE ONE RULE THAT BUYS BACK THE CORE INVARIANT

Blueprint's model, verified (same report, §B1–B6). The cardinalities are exact
mirrors, and that symmetry is the key structural fact:

    exec OUT ≤1 wire     exec IN many
    data OUT many        data IN ≤1
    event  : no exec IN, one exec OUT        pure  : no exec pins at all
    impure : has exec pins, runs per pulse   latent: registers a pending action, RETURNS

**Why exec is a separate wire kind at all:** side effects need a TOTAL order and pure
values do not. Dataflow gives only a partial order — it cannot express "do A then B
when neither reads the other", cannot express zero occurrences, and cannot branch.
**Pure nodes are not nodes in the emitted program at all**; a pure chain is a
statement template copied into the head of each impure consumer. Every observable
Blueprint behaviour follows from that one sentence.
Cardinality is enforced by honouring the new wire and **silently dropping the old
one**, not by refusing the connection — which matches our own fan-in-1 rule
(`core/nodeflow.js:29-45`), arrived at independently. Good corroboration.

**WHAT MAPS:** pure node ≡ property equation (an identity, and re-evaluate-per-read is
CORRECT for us because our expressions are genuinely pure) · data edge ≡ cross-item
reference · `BeginPlay` ≡ `onSlideEnter` · inline widget on an unconnected pin (≡ the
socket row above) · collapsible advanced pins · Timeline ≡ a keyframe track with an
exec pin.

**WHAT DOES NOT MAP, and must not be copied:** `Event Tick` with `DeltaSeconds` as a
general trigger — it breaks Δt = 0, frame-range sharding and export reproducibility
all at once. Use `onAlphaChange(alpha)`. Wall-clock `Delay` becomes
`DelayAlpha(Δalpha)`. UE's UNDEFINED multicast order must not be inherited — ours is
`topoOrder`. And Blueprint's *syntactic* purity ("no exec pin", yet `Random Integer`
is pure there) must never override our SEMANTIC definition.
*(Note the boundary: R7-9's simulated state deliberately does take an elapsed-time
input. That is a bounded, opt-in, double-buffered exception with a loud shard
refusal — not a licence for a general Tick trigger.)*

**THE RULE THAT SAVES THE INVARIANT: restrict exec sources to functions of POSITION,
and require every effect to be IDEMPOTENT — `set X to V`, never `add 1 to X`.** Then
replaying from slide 0 is cheap, correct, and identical every time, and
`RenderTree = pure(document, [[slide, alpha]])` survives having events at all. This is
the single most important sentence for whoever builds R7-8.

### R7-10 WAVE 1 RESULT — and the text-baseline bug that had defeated three fixes

**THE FINDING WORTH THE WHOLE ROUND: A TEXT OP'S `y` IS THE LINE BOX'S TOP, NOT A
BASELINE.** `render_gpu/skia/text_layout.js` draws at `layout.draw(canvas, cmd.x, cmd.y)`
and `svg_backend.js` agrees. But every node text added `size/3` "so the glyphs sit above
it" — **so every one was drawn a full line low.** Consequences that were each previously
diagnosed as their own bug: the Number node's 22 pt digit clipped by its own rim at
h=68; card titles hanging below their header strips; and **three successive documented
"fixes" to the audio readout that kept landing it on the dials — all three were tuning
the wrong quantity.** Fixed at the one seam (`textLineH`).

**A COROLLARY THAT MATTERS MORE THAN THE FIX: "three fixes that did not stick" IS A
DIAGNOSTIC.** Each of those commits looked local and reasonable. When a symptom returns
after a repair, the repair is evidence the model is wrong, not that the number needs
another nudge. Escalate to measuring the primitive.

**Also found at DEFAULT sizes, on nodes nobody had resized** — so the original complaint
("no guarantee the knobs will even be in the node") was worse than reported: **every
output port label was painted outside its own card** (`portBeads` boxed it at
`[p.x − GAP, … + w/2 − GAP]` and right-aligned, so its right edge sat half a card past
the rim), and a wrapped knob label's second line fell outside ("Resonanc/**e**").
`node_knob`'s missing `Math.abs` was shared by the slider, button and keyboard.

**WHAT LANDED:** one unbypassable layout path in `core/node_chrome.js` — `nodeBox` (the
one sign-resolving entrance), `textLineH`, `nodeBodyTop` (the one reader of port
geometry; it replaced three copies of `lastRow + PORT_BEAD_R + gap`), and `nodeFaceBand`
(CD's ladder generalized: natural top → slide up → shrink → visible clip, with rigid vs
elastic bands). Both factories route through it. **A plugin declares WHAT its control
needs and never WHERE** — `paint(s, face)` receives the rect. No override hatch, per
`core/audio_nodes.js:305-312` and the Bespoke evidence (191 of ~265 modules override an
optional auto-layout).

**THE INVARIANT TEST IS THE DELIVERABLE.** `tests/node_chrome_layout_test.js` sweeps
every registry-derived node type × 5 widths × ~11 heights down to each plugin's floor
(155 combinations), asserting CONTAINMENT not visibility (per the VCV finding). **It
found two escapes the eye missed** — `node_knob` at 400×82, and `audio_oscillator` at
80×124 where the band wraps to three rows, **so a floor is a function of WIDTH, not just
of content**. It also pins "a control never has an authored x".

**HONEST MEASUREMENT, RECORDED BECAUSE THE HABIT MATTERS MORE THAN THE NUMBER: THE
DEDUP GREW THE CODE — +107 non-comment lines (1006 → 1113), and no simplification is
claimed.** Three schemes did collapse to one and the plugin files now hold a `FACE`
declaration instead of arithmetic, but the shared functions cost more than the ~5 lines
each scheme spent, and most of the growth is capability that did not exist (the declared
floor, the duality predicate, the line-height correction, the test API).

**DELIBERATELY NOT DONE — the inline-value socket row**, and the reason is a semantic
trap Wave 3 must not walk into: **Blender and Blueprint hide a wired input's widget
because their link REPLACES the value. Our audio wire connects to an AudioParam, which
SUMS.** So hiding an audio dial hides a still-contributing offset. It is hidden anyway
(that is what the user asked to see), but the honest fix is a `combine` field — see the
spec vocabulary below. Moving knobs into port rows is a visual redesign of 24 modules and
was out of scope.

**THE SPEC VOCABULARY FOR WAVE 3 — the most consequential output of Wave 1:**

```
knob: { key, label, default, min, max, step, unit, help,
        discrete?, options?, construct?,     // existing
        combine?: "sum" | "replace",         // NEW: does a wire REPLACE the knob
                                             //  (hide the dial) or SUM with it
                                             //  (keep it as an offset)?
        modulatable?: boolean }              // NEW: derive a same-named input
```

**`modulatable` DEFAULTS FALSE TODAY AND MUST STAY SO UNTIL THE ENGINE IS QUERYABLE.**
`tests/audio_nodes_test.js` proves every declared port exists in the engine; auto-deriving
inlets for all specs would declare ports the engines lack, and the mirror would connect to
nonexistent AudioParams. Once the engine's param surface can be read from `core/`, flip
the default and Axoloti's ~70 duplicated `x` / `x m` objects never get built here.

**STILL OUTSIDE THE SINGLE PATH:** `plugins/node_keyboard.js` hand-places its face from
`NODE_HEADER_H + 10` and takes no `Math.abs`. It passes the containment sweep only
because its face floors at 0. **It needs a two-line change to call `controlFace`** — fold
into R7-13.

### R7-9 WAVE 1 RESULT — simulated state, and the integration it still needs

**PROVEN, and this is the user's own example:** `rotation = @ + dt` gives **exactly
2.000000000000 degrees after 2 s at 24, 30, 60, 144 and 1000 fps.** The framerate
independence the fixed-timestep design could not have delivered.

**THE INTEGRATOR DEMONSTRATION, which is the nicest result in the round:** for
`x'' = −(x+1)`, energy `(x+1)² + v²` (true value 1.0) over 40 s at 400 fps —

    explicit    1.0000 1.0101 1.0202 1.0305 1.0408 … 1.1052   (monotone gain)
    symplectic  1.0000 0.9988 1.0004 1.0011 0.9993 … 1.0012   (bounded orbit)

**and the two sources differ by exactly one `@`** — `@ + dt * @self.vars.v` versus
`@ + dt * self.vars.v`. The symplectic form needed no new mechanism: `self.vars.v` is an
ordinary reference, so `requireSlot` settles `v` first.

**Δt = 0 IS PINNED BOTH WAYS:** re-rendering one frame gives a byte-identical display
list, **and 28 evaluations at one instant produce ONE step** — the double-buffer earning
its place against the measured ~28 `app.nodes()` calls per frame. Cost: 40.5 ms/1000
simulated passes vs 41.2 ms/1000 plain; a document with no `@`/`dt` never touches the
table.

**INTEGRATION STILL OWED (Wave 2 — W1-C did not own these files):**
- `web/videoExport.js createFrameSampler` — `setSimulationTimestepOverride(1/(fps*samples))`
  on construction, `null` in `release()`, `resetSimulation()` on construction. **THE
  `samples` DIVISOR IS A TRAP:** with motion blur every sub-frame rolls, so a dictated
  `1/fps` runs the simulation `samples`× too fast.
- `web/PresentMode.svelte:403/:441` — `resetSimulation()` beside start/stopParticleClock.
- `web/gpuService.js:315` and `web/App.svelte:980` — wrap in `withSimulationFrozen`.
  `documentState` is the sharp one: it is deliberately the state WITHOUT the preview
  delta, i.e. a hypothetical, evaluated at the same instant as `app.state()`.
- `web/app.svelte.js` — `resetSimulation()` on document load / open / new.
- `cli/render_job.js` — `stridedShardRefusal(doc, registry)` before sharding.
- `<app>/CLAUDE.md` § "The three kinds of state" — write in the fourth kind.

**RULING ON THE EDITOR QUESTION W1-C RAISED.** In the editor a simulated widget shows its
initial condition and does not move, because presented time is frozen there. **That is
correct and it stays** — it is exactly how recordable state already behaves (a sparkler
does not animate in the editor either), and an inconsistency between the two kinds would
be worse than the inconvenience. Preview by presenting. **An editor play/scrub affordance
is a real authoring need for a pendulum and the user has not asked for one — BACKBURNER,
not this round.**

**THE ONE ERGONOMIC GAP, which R7-16's author will hit:** there is no authorable initial
condition on a simulated slot. `@` with no history is the folded value when the slot holds
a plain value, and the plugin DEFAULT when the slot holds its own equation — so an author
states a start by composing (`rotation = theta0 + theta`). Decide whether that is
acceptable when building the pendulum.

### R7-11 PORTING RULES — the fixed-point→float laws, and the traps that change the sound

From primary sources (Axoloti firmware + Java + 684 object definitions); full report
`.frenzy/round7/axoloti_research_report.md`. The user's requirement is *"mathematically
near identical so that they sound the same"* — **these are the specific things that
decide whether that is true.** Every one below was measured, not assumed.

**THE THREE LAYERS. Confusing them is the commonest way to get a port subtly wrong.**

    XML dial value (−64…64) ──×2^21──▶ raw int32 ──pfunction──▶ param_X in C ──/2^27──▶ float

- `frac32` is signed **Q27**: `real = i / 2^27`, audio full scale ±1.0 = 2^27, with
  ±16.0 of headroom above it (that headroom is why a mixer can sum before saturating).
- **A dial reading 64 IS 1.0.** Unsigned dials 0…64 step 0.5; signed −64…64 step 1.0.
- **`param_X` IS NOT THE DIAL VALUE.** Every param passes a `pfunction` first:
  `.gain` is `<<4` (rescaled to q31), `.squaregain` is `±(psat²/2^31)`,
  `.kdecaytime.exp` is `0x7FFFFFFF − MTOF(−v)>>2` — a per-tick DECAY COEFFICIENT.
  *That is why the ADSR body contains no `exp()`.* Port the pfunction, not the dial.
- Cross-type coercion: `bool32 → frac32` is **+1.0, not +1/64**; `frac32 → int32` is
  `>>21`, so **frac32 1.0 arrives as 64**; `frac32buffer → frac32` takes **sample 0,
  not an average**.

**THE PITCH LAW.** `pitch` is SEMITONES, 1 semitone = `1<<21`, and **pitch 0 = MIDI 64
= E4 = 329.6276 Hz** (not A440, not C). So `hz = 440 · 2^((p − 5)/12)`, `midi = 64 + p`.
"Frequency" in object code is a **32-bit phase increment** (`2^32·f/48000`) — hence
`Phase += freq` with `uint32_t` wraparound as the modulo. Their table is piecewise-
LINEAR between semitones (≤0.7 cents error) and hard-clamps at 24 kHz; that matters
for detuned unisons and supersaws.

**⚠ THE K-RATE BRIDGE — GET THIS WRONG AND EVERY ENVELOPE, LFO AND COEFFICIENT RUNS
8× SLOW.** Axoloti is 48 kHz with `BUFSIZE 16`, so its control rate is **exactly 3000
Hz**. In a 128-frame AudioWorklet quantum that means **8 k-rate ticks per `process()`,
each followed by 16 sample-rate samples.** Hoisting the k-rate work to once per
quantum is the obvious optimisation and it is WRONG by a factor of 8.

Also port the k→s ramp (`gain/vca` is the reference): per buffer
`step = (v − prev)/16; g = prev; prev = v`, then per sample `out = a·g; g += step`.
**Their ramp is deliberately one buffer (333 µs) LATE** — it ramps from the previous
block's value. Omit the ramp and the port sounds crunchy on every modulated gain.

**⚠ THE BIQUAD'S EXTRA `qinv`.** `filter/lp`'s numerator carries a constant-peak-gain
normalisation the textbook RBJ formula does not: `b0 = ((1−cos w0)/2)·qinv/a0`. **Omit
it and every resonant sweep is far too loud.** `biquad_bp` has NO extra qinv. Resonance
is stored as inverse-Q (`Q = 32/(64 − dial)`, a pole at 64) and passed as `1/Q` to
avoid a division.
`filter/lp1` is `alpha = 2·fc/48000` — **not** `1 − exp(...)`; its −3 dB point is
`fc/π`, which is not where the label says. Copy the recurrence, not the intent.
ADSR: **attack is LINEAR, decay and release are EXPONENTIAL.**

**FAITHFULNESS HAS A LIMIT, AND HERE IS WHERE WE DRAW IT.** `env/ad` uses `/192000`
where its siblings use `/96000` — **it runs 2× slower than its own display says.**
That is a real bug in their library. The ruling: **port the SOUND faithfully and make
the LABEL honest.** The user asked for patches that sound the same, not for a
replicated display bug; a knob whose readout contradicts its behaviour is the "lie
about its own affordance" this manifest already forbids. Note every such divergence
in the spec's `help`.
**`noise` is NOT reproducible on their hardware** (`rand_s32` reads the STM32 RNG).
Ours must use the seeded `random` — determinism is non-negotiable here and this is an
improvement, not a deviation to apologise for.

**TWO AXOLOTI CHOICES WE DELIBERATELY REJECT:**
1. **Execution order is SPATIAL there** (sorted y then x — moving a box changes the
   sound). We have `topoOrder` (`core/nodeflow.js`) and it is better. Keep ours.
2. **No automatic param/inlet duality.** Their authors declare a param and an inlet
   with the same name and add them in C; the ` m` suffix (`filter/lp` vs `filter/lp m`)
   is that convention and **it costs them ~70 duplicated objects.** Our rule instead:
   **every param implicitly gets a same-named inlet defaulting to the combine law's
   identity element (0 for summed, 1 for multiplied).** This is what delivers the
   user's *"things can either be a knob control or they can be an input control"* with
   no duplicated objects, and several of our specs already declare both by hand
   (`audio_oscillator` has knob `frequency` AND input `frequency`), so it formalises
   an existing pattern rather than inventing one.

**INVENTORY REALITY.** 519 `.axo` files but **684 object definitions** — one file holds
N `<obj.normal>` overloads (k-rate int / k-rate frac / s-rate buffer versions of the
same `id`, resolved like C++ overloads by connected type). 610 are machine-generated,
74 hand-authored. The hand-authored ones are the good ones: `osc/brds/` (40 Braids
ports) and `fx/` (13 Mutable Instruments ports) are 100% hand-written.

**THE COMMUNITY CORPUS IS FROZEN AND HALF-OFFLINE.** `community.axoloti.com` is down;
the mirror is `sebiik.github.io/community.axoloti.com.backup`, and contributed patches
live in `axoloti/axoloti-contrib` **at tag `1.0.12` only** (`master` is empty of them).
The successor project is **Ksoloti** (active). Best-of-breed pads found: `Shimmer.axp`
(two pitch-shifters inside an FDN feedback path), `EvolPad.axp` (three incommensurate
7.7 s LFOs rewriting waveform STEP LEVELS so harmonic content drifts),
`SolinaStrings.axp` (six objects, literal three-phase BBD ensemble).

### R7-17 THE LIBRARY IS CHOSEN BY PATCH, NOT BY CATEGORY (user, 2026-08-06)

> *"choose the nodes by looking at demo patches, and copy the patches you see into demo
> patches in our app and copy the nodes needed as faithfully as possible, so we know
> they sound good without even having to listen. the web is full of good patches for
> axoloti (their builtin samples) and for VCV rack (please be able to faithfully
> emulate at least 20 or so patches along with whatever nodes they need). We gonna have
> a GIANT beautiful node library! Use batch swarms when ready. This is important"*

**THIS INVERTS THE PLAN AND IT IS A BETTER PLAN. It supersedes "choose ~100 nodes by
category" in R7-11 and the earlier "50 popular VCV plugins" framing.**

**THE PIPELINE:**
1. **HARVEST KNOWN-GOOD PATCHES FIRST** — Axoloti's shipped/factory patches and the
   frozen community corpus (`axoloti-contrib` at tag `1.0.12`; the live site is down,
   mirror `sebiik.github.io/community.axoloti.com.backup`), plus **≥20 VCV Rack
   patches**. Weight toward the sounds the user named: leads, **PADS**, ambience.
2. **THE NODE LIST IS THE UNION OF WHAT THOSE PATCHES USE.** Not a category sweep.
3. **PORT THOSE NODES** to the R7-11 arithmetic laws.
4. **REBUILD EACH PATCH as a demo patch + demo slide in our app.**

**WHY THIS IS BETTER, stated because it is the whole point:** *"so we know they sound
good without even having to listen."* A category sweep produces 100 nodes and no
evidence any combination of them is musical. A patch-driven sweep produces a library
where **every node is justified by a real patch that already sounds good**, and the
patch itself is the acceptance test. Coverage follows from use rather than from a
taxonomy, and nothing gets ported that nothing needs.

**IT ALSO CHANGES WHAT "DONE" MEANS.** A ported node is done when the PATCH it was
ported for reproduces; a node with no patch behind it is unverified by construction.
Where we can render the original for comparison (VCV Rack has a headless mode; Axoloti
needs hardware and generally cannot be rendered here) a spectral/numeric diff is the
strongest available check — use it where possible, and where impossible say so rather
than implying an audio comparison happened.

**LICENCE — USER RULING, 2026-08-06.** The lead raised GPL-3 copyleft as a constraint on
porting VCV DSP source. The user overruled it twice: *"NO. we just use it. this is for
personal use. This does not apply"* and *"we copy it"*. **He is factually correct** —
GPL obligations attach on DISTRIBUTION, and the licence explicitly permits unlimited
private modification. So: **port source directly from any of these projects.** Settled;
do not re-litigate. (The one fact a future reader needs: if this repo is ever
published, that calculus changes.)

**RECORD A DERIVATION FOR EVERY PORTED NODE — AND THE REASON IS DEBUGGING, NOT
ATTRIBUTION** (user: *"it's so we can debug shit and find flaws in the emulation"*).
That purpose decides what the record must contain, and a bare licence tag is useless
for it. Each ported node's spec carries:
- **the exact source**: project, object/module name, and the version/tag/commit it was
  read at (e.g. `axoloti objects/filter/lp svf.axo @ tag 1.0.12`);
- **which code block** the recurrence came from (`code.krate` / `code.srate`, or the
  source file and function);
- **the recurrence as ported**, in float form, so a wrong sound can be diffed against
  the original line rather than re-derived from scratch;
- **every deliberate deviation, named** — the fixed-point→float rescaling, and any
  source bug we chose not to reproduce (see R7-11 on `env/ad` running 2× slow, and on
  noise being seeded here but hardware-random there).

**When a patch sounds wrong, that record is the debugging entry point.** Without it,
finding a flaw means re-reading the original library from scratch — which is exactly
the cost the user is telling us to avoid paying twice.

#### EXECUTION: A THREE-PHASE SWARM. NODES ARE ASSIGNED BEFORE ANYONE BUILDS ONE.

Runs after Tier A (a spec authored against the wrong vocabulary is worse than no spec —
§ R7-DIAGNOSIS's two-line-wrapper finding).

**USER, 2026-08-06:** *"since many patches will reuse nodes — have them coordinate ahead
of time which nodes they'll build so we dont duplicate and keep it all DRY"*.

**This replaces the earlier plan of "each agent owns a slice of patches, and the lead
arbitrates collisions as they appear." That was reactive and would have produced exactly
the duplication it was meant to catch** — with 50 patches over a shared vocabulary, the
overlap is not an edge case, it is the normal case. `filter/lp svf`, `env/adsr`,
`math/smooth` and `gain/vca` will be wanted by a dozen patches each. Two agents writing
the same node independently is the Tower of Babel failure at its most literal: not two
spellings of a concept, two implementations of one DSP recurrence, which will then
diverge and sound different in different patches.

**PHASE 1 — SURVEY. READ-ONLY, PARALLEL, NO CODE WRITTEN.**
Agents harvest candidate patches and report, per patch: its source and tag, its exact
node list (source object names), its distinct-node count, and which hard family it
exercises. Nothing is built. Output is a patch→nodes table per agent.

**PHASE 2 — THE LEAD COMPUTES THE UNION AND ASSIGNS. THIS IS THE COORDINATION POINT.**
The lead dedupes into a single **NODE REGISTRY** — `.frenzy/round7/NODE_REGISTRY.md` —
recording for every node: its source object + tag, **exactly one owning agent**, the
patches that depend on it, and its status. **OWNERSHIP IS BY NODE, NOT BY PATCH.** Also
selected here: the final 50 and the Axoloti/VCV split, checked against the difficulty and
coverage obligations above rather than against convenience.

**PHASE 3 — BUILD, PARALLEL, PIPELINED.** Each agent builds its assigned nodes first
(disjoint spec/engine files), then assembles the patches assigned to it. **A patch is
assembled only once every node it needs exists** — so patches pipeline per-patch as their
dependencies land, rather than waiting on a global barrier. An agent that needs a node it
does not own WAITS FOR IT; it does not write its own copy, and it does not "temporarily"
inline one.

**THE DRY GUARD, because a protocol nobody can check is a wish.** A node's `type` must
appear in exactly ONE spec. Extend the existing coverage assertion
(`tests/audio_nodes_test.js` already checks `plugins/audio_index.js` against
`AUDIO_SPECS`) with: no duplicate `type` across all specs, and **every node referenced by
a demo patch exists exactly once**. A duplicate must turn something RED, not be caught by
a reviewer noticing.

**⚠ THE COUNTS ARE LITERAL, AND THE LEAD UNDERSHOT THEM ONCE ALREADY.** User,
2026-08-06: *"btw the numbers of patches i asked for were not exaggerated i actually want
this many"*, then, when the lead wrote "≥20": *"ahem. I said 50."* Then the split:
*"it can be axoloti patches too"* / *"25 from each or balance it till u find a happy
mediam — 50 total tho"*.

| target | count |
|---|---|
| **DEMO PATCHES, TOTAL** | **50** — this is the hard number |
| from Axoloti (factory + contrib@1.0.12) | ~25 |
| from VCV Rack | ~25 |
| ported nodes | **~100**, and this is a FLOOR — it is the union of what the 50 patches need |

**THE 50 IS THE HARD NUMBER; THE 25/25 IS NOT.** *"balance it till u find a happy
medium"* — so shift the split toward whichever corpus actually yields better patches,
and say what the final split was and why. This SUPERSEDES R7-12's earlier "~30 demo
patches": the 30 is folded into the 50, not added to it.

**No swarm may quietly deliver a tenth of these and call it a representative sample.**
If a target cannot be met, the round says so EXPLICITLY with the shortfall named and the
reason — scaling work down is the user's call, not the agent's.
*"We gonna have a GIANT beautiful node library!"* is the requirement.

#### ⚠ SELECTION IS FOR POPULARITY AND DIFFICULTY. THIS IS THE ENTIRE MECHANISM.

**USER, 2026-08-06, verbatim:** *"dont just choose random bullshit-ass easy patches
either. choose popular, pretty challenging ones so I can impress people with my demos —
especially if that means we gotta add more emulated nodes along the way (thats kinda the
point its a way to choose which nodes to build without getting lazy and choosing the easy
ones)"*

**READ THAT TWICE BEFORE PICKING A SINGLE PATCH.** Patch-driven selection exists to
FORCE the hard nodes to get built. An agent measured against "50 patches" has a natural
incentive to pick the 50 cheapest, which would hit the number and destroy the purpose.
So:

- **A PATCH'S NODE COST IS A FEATURE, NOT A COST.** One patch that forces three new hard
  nodes is worth more than three patches that force none. `~100 nodes` is a floor
  precisely because good patches will blow through it.
- **REJECT A PATCH FOR BEING TRIVIAL. NEVER REJECT ONE FOR BEING HARD.** "It needs a
  node we do not have" is the reason to CHOOSE it. If a patch is genuinely
  unimplementable, say why in one sentence and pick another hard one — do not substitute
  an easy one.
- **AIM AT THE HAND-AUTHORED CORNERS OF THE LIBRARIES.** Measured (R7-11): of Axoloti's
  684 objects, **610 are machine-generated** boilerplate (math/logic/mux overloads) and
  **74 are hand-written — and the hand-written ones are the good ones**: `osc/brds/` (40
  Braids ports) and `fx/` (13 Mutable Instruments ports — Clouds, Rings, Elements,
  Streams, Warps) are 100% hand-authored. **Demos come from there, not from the
  generated arithmetic.** Same principle for VCV: the modules people are actually
  impressed by.
- **COVERAGE OBLIGATION.** The 50 must COLLECTIVELY exercise the hard families, not
  cluster in one: granular · FDN/plate reverb · pitch shifting · wavetable and phase
  distortion · physical modelling (string/modal) · FM · vocoder/spectral · chaotic and
  generative sequencing · polyphony with voice allocation. The pads/leads/ambience bias
  stands, and the best pads found are already hard ones — `Shimmer.axp` (two
  pitch-shifters inside an FDN feedback path), `EvolPad.axp` (three incommensurate 7.7 s
  LFOs rewriting waveform step levels), `SolinaStrings.axp` (three-phase BBD ensemble).

**THE ANTI-GAMING GUARD, because the count alone can be satisfied dishonestly.** Every
patch entry records **its distinct-node count** and **which hard family it exercises**,
and the round reports the tally. **A set of 50 patches averaging four trivial nodes each
has FAILED, even at 50/50.** The report must make that visible rather than let a number
stand in for the requirement — which is the same reason the test gate is not allowed to
quote a partial count.

### R7-18 A DEMO AUDIO PATCHES SUBMENU (user, 2026-08-06)

> *"we need a demo audio patches submenu like demo widgets btw cause we gonna have a lot
> of them"*

A direct consequence of R7-17's counts: ~30 patches cannot live in a flat insert list.
The precedent to follow is the existing **demo widgets** grouping — `plugins/demo/`
already holds 27 demo plugins that are grouped separately from the main widget set
(`plugins/index.js:65-76` marks the boundary: *"DEMO widgets (plugins/demo/) — showcase
the extensibility story"*).

**Find that grouping mechanism and REUSE it — do not invent a second one.** Whatever
surfaces `plugins/demo/` as its own section is the thing a patches submenu must also go
through, so that adding a patch means adding data, not touching a menu. If the demo
grouping turns out to be a hand-maintained list, that is a Tower of Babel instance to
DERIVE (from directory membership or a declared field) as part of this item rather than
to copy a second time.

A patch is not a widget — it is a set of items plus their `inputs` wiring — so this also
needs a decision the lead must make before Wave 3: **is a demo patch an insertable
TEMPLATE (a multi-item stamp) or a document to open?** The double-pendulum preset
(R7-16) is the same question in miniature (*"it's just like an alias for creating two
rectangles with the proper equations"*), so **the two must share one mechanism.**

### R7-RULING: THE TEST BUDGET

User, verbatim: *"don't spend too much time testing. Remember, no more than 10% of your
time should be spent on tests."* This ROUND is bounded by that. It does not repeal the
standing gate (`tests/run_all.mjs` is still what "passing" means, per PowerRP CLAUDE.md);
it forbids growing the suite as the main activity and forbids tail-chasing repairs — the
same judgment R6-30 already made from the other direction.
