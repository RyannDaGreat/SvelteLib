# PowerRP — Concerns (append-only history)

> Created 2026-07-28 alongside the in-repo manifest (the container-side dump
> concerns.md is unreachable from this Mac — see the manifest's provenance note).
> APPEND ONLY. Never delete history.

## 2026-07-28 — The materials epic lands; the user's live review finds the gaps

### What shipped (context for the mistakes below)
f151f84 fill-material framework → 89e9658 thirteen fill conversions → d76f678
gradient handles → fd9cd07 stroke materials → 70be373 paint path widget →
b56cfa7 Mat-mode editor UI gate → 83774e2 procedural 23-archetype brush.
Gates at land time: doctests 2508/0, node 88/88, both material matrices PASS,
Mat UI probe 13/13.

### MISTAKE: built the wrong brush (procedural instead of rp's texture ribbon)
The user asked for "that Skia Paint demo… top 23 paint strokes… save those into
the repo… or reference them by URL." Research agents searched the WEB, found no
such app, and a SPEC was invented for a procedural drawAtlas brush — which
shipped. The demo was in **rp all along**:
`rp/misc/skia_trail_interactive_paint_demo.py` (thumbnail palette of
`TEXTURE_URLS`: 30 onlygfx watercolor banners + 49 onlygfx paint strokes +
extras; size start/end taper sliders; blend-mode dropdown) rendering through
`rp.skia_draw_trail` (texture ribbon swept along the contour as a triangle mesh,
per-vertex inner/outer radii, v_subdivs, 2^16 mesh cap, mipmap).
**Root cause:** nobody searched the rp package, despite the standing CLAUDE.md
rule to read rp source rather than guess. "That app" + python + Skia should have
meant `grep -rn brush $(python -c 'import rp; …')` on day one.
**Lesson:** when the user references "that app/demo I gave you", search rp FIRST
— he maintains it and demos live in `rp/misc/`.
**Silver lining:** the user likes the procedural brush; it stays as its own kind.

### MISTAKE: material knobs jammed under "Formatting", not collapsible
All Mat rows render flat inside the formatting area. CRT has 23 knobs — unusable
without collapsing. The user had asked for material sections in the GUI; the
requirement got lost between fleet agents (each converted a shader; nobody owned
the Inspector layout). → Manifest A.1.

### MISTAKE: knob rows violate three standing UI laws at once
- Arbitrary min/max clamps on knobs (jitter etc.) — violates the no-arbitrary-
  constraints principle.
- 1-per-drag-pixel scrub on fractional knobs — the SAME bug class as the
  brightness_contrast "paletteOffset shape" fix and pdf_packet's page row, both
  already in history; the lesson existed and was not applied to the new schemas.
- No live preview mid-drag: PaintField Mat rows use bare DraggableNumber with
  commit-on-release only, while ColorField (and most sliders) preview live.
**Root cause:** fleet agents copied the exemplar (comic) knob-for-knob; the
exemplar itself had these flaws, so they replicated 13×. Exemplar flaws are
FRAMEWORK flaws — review the exemplar's UX, not just its wiring, before fanning
out. → Manifest B.2–4, I.25 (audit agent running).

### MISTAKE: presets statically bound to widget type → vanished for shapes
The Tools-area presets (material demo widgets had them) don't appear when a
plain shape carries that material as a paint, because tools bind to widget type,
not to the CURRENT materials of the selection. → Manifest D.10–11.

### MISTAKE: glass never became a fill material
"Liquid glass" is the one backdrop material that didn't opt into fillParams —
the conversion fleet worked from a list that omitted it (glass was "the
groundwork", mentally filed as infrastructure, not as a material). → Manifest H.24.

### Paint path shipped without its editing UX
Curve handles landed indistinguishable from anchors, no ghost lines, no curve
on/off toggle, no context menu, auto-curving on first drag, no gray-out for
non-curve points. Draw-on trim exists on paint_path only — the user wants
trim/phase/caps as GENERAL stroke options. → Manifest E.12–15, F.16–21.

### Wavy conflates random and sine; dashes is a fixed dropdown
Seed on a material whose visible parameter is a sine frequency; dash patterns
are an enum instead of a continuous builder + presets. → Manifest G.22–23.

### INCIDENT (earlier, this same round): mid-fleet `git stash` resets
3+ agents ran `git stash`/checkout on the shared tree; work wiped twice. The one
real casualty found at reconciliation: PaintField.svelte's stroke imports + prop
declaration were stash-trapped while the slot-aware block USING them survived —
the editor would ReferenceError on any paint row, and NO gate caught it because
?cli=1 probes never mount the Inspector. Fixed; gate added (b56cfa7,
material_paint_ui_probe). Stash backups: branches stash-backup-material-fleet-0/1.
**Lessons:** (1) forbid git state commands in fleet-agent prompts (now standard);
(2) every UI seam needs at least one editor-mounting probe; (3) reconcile stashes
per-file with loss-counting (`git diff stash@{n} -- file | grep -c '^-[^-]'`),
from the REPO ROOT (subdir cwd silently zeroes the counts — paths don't resolve).

### INCIDENT: the phantom "first-render white proxy clip leak"
A fleet agent reported DEFAULT_PROXY_BACKDROP_TINT escaping the shape clip on
first render (glitch/crt/frosted fills). Disproven with byte-level evidence:
render1 vs render2 identical in fresh pages; all pure-white pixels inside the
material bbox; the tint is 14%-alpha white and cannot composite to pure 255. The
observed white was the probe underlay's #f8f9fa disc rims wobbling under the
backdrop region re-render — the same AA-rim artifact two other agents traced
independently. The probe underlay was stabilized (discs out of corner sample
zones) in 89e9658. **Lesson:** an agent's mechanism ATTRIBUTION needs the same
adversarial verification as the observation itself.

### TRAP (recorded to memory too): puppeteer × Svelte 5 $state proxies
Returning a doc/state object raw from page.evaluate silently mangles it (numbers
survive; nested objects come back empty) — JSON.stringify IN PAGE, parse
node-side. Cost an hour of phantom probe failures while the code under test was
correct.

### TRAP: CanvasKit drawAtlas colors
Plain number[] renders untinted white (ColorAsInt is signed int32, mis-marshaled)
— pass a Uint32Array. And translucent brushes can't be dense low-flow stamps
(SrcOver builds to opaque): draw opaque into a saveLayer composited at
flow×opacity (the layerFlow trait).

### Round status
User review 2026-07-28 produced the 25-requirement round in the manifest.
User then goal-locked "get all of these done" with an 8-agent Opus fleet.
Progress (same day): 7 of 8 agents landed and committed —
d2c24b7 (wavy/dashes), 4968a37 (dynamic presets), 8356a61 (liquid glass),
14eca65 (Inspector sections/live+hover preview/scrub fix), fde04ee (paint-path
handle UX), ef94899 (stroke trim/phase/caps), 5981cb4 (audit sweep).
TEXBRUSH (C.6–9) still running. User ruling mid-round: no interim chat/ntfy
updates — one report when EVERYTHING is done.

### MISTAKE (round 2 trigger): "sections" misread as "sub-folds"
Round 1's A.1 shipped a collapsible INSIDE the Fill/Stroke rows, still under
Formatting. The user meant TOP-LEVEL Inspector sections (peers of POSITIONING)
— "their own separate drop-down... I said this like 25 times." Lesson: when a
user names a UI location ("out of formatting"), the fix must MOVE the thing,
not decorate it in place; a screenshot of the intended level (POSITIONING
header) beats prose. → Manifest 26, redone by the integrator.

### FINDING (round 2): materials don't conform to the shape
Glass/CRT/corkboard on a gear read as their own rect/squircle with the clip
cutting them — the analytic rect SDF in the shaders is the silhouette for edge
effects, so non-rect outlines get a rect's rim. The clip held (probes proved
containment), but containment ≠ conformity. → Manifest 27.

### ROUND 2 COMPLETE (2026-07-28, same day)
All ten round-2 items delivered by 1 integrator pass + 3 Opus agents:
0043818 top-level sections (redo), 44875fa phase-as-angle (choo-choo),
a444a3a shape-conforming materials (silhouette EDT SDF; glass/crt/cork/
tack/metaballs conformed, frosted proven exempt), c42f3bc Monaco code modal
+ mermaid presets + code-button row, 4ad30d6 searchable dropdowns +
floating menus + scroll-hover. Final battery all green (see manifest STATUS).
Round-2 lessons: an HMR-compiled MID-EDIT component state crashed the
user's live session (addEventListener of undefined) — dev-server-on while
agents edit shared UI components is user-visible risk; the crash was gone
in the agent's final state but the experience argues for pausing HMR or
warning the user during fleet edits on web/ files. Also: an agent believed
this Mac cannot run the browser fill matrix (stale memory generalized from
the ~35-failure full-gate baseline) — the integrator re-ran it green; agents
inherit memory notes as absolutes, phrase them with their scope.

### POST-ROUND user crash report → a different real bug (2026-07-28)
User hit "material fill glass reached the painter UNRESOLVED" live, twice.
Exhaustive reproduction on the committed tree (their saved deck, their exact
paint_path item state with glass+stale-knob fill + brush stroke + trims,
fresh/autosave/backend boots, groups, tweens, hover): ZERO occurrences — both
reports coincided with their dev server compiling MID-FLEET-EDIT states of
exactly the files in the traces (first: stale dep-optimizer chunks; second:
server restarted while the SHAPE agent rewrote paint_skia/materials under
HMR). But the hunt surfaced a REAL adjacent bug the crash had been masking
from the user's view: paint_path's own trim knobs ERASED the interior fill
entirely (filled = closed && FULL && fill — "a partial fill is meaningless"),
contradicting the same-day universal law that trim cuts the stroke only.
Fixed (35a393a): trimmed+filled emits full-path fill under the windowed
stroke; pixel-pinned in a new material_fill_probe paint_path cell.
**Lessons:** (1) path-op emitters (paint_path) were a coverage hole in the
fill matrix — "4 shapes incl. custom" did not include the op class users
draw by hand; (2) a probe author calling an anomaly "orthogonal" (the
fill:null blue interior) may be looking at the masked half of a real bug;
(3) users on a live dev server DURING fleet edits will see mid-edit
compiles as crashes — twice now; pause the server or warn the user.
- The .claude_todo.md ledger was overwritten by a fleet agent AGAIN (TRIM this
  time; the gradient agent did it last round). Agents must be told the ledger is
  integrator-owned, or given per-agent ledger files.
- The audit agent could not write into .frenzy/ (harness blocks subagent writes
  there in this configuration) — returned the report in its final message; the
  integrator saved it verbatim. Plan for report-by-message.
- Two agents INDEPENDENTLY diagnosed a third's in-flight breakage (ContextMenu
  Escape vs shortcut sweep) — cross-agent gate noise is also a detection channel;
  relaying the flag to the owner mid-flight worked (PATH shipped the fix using
  the LOCAL popover-dismiss precedent).
- SCHEMAS refused two audit findings with source-level proof (sky ceilings
  physical; a hallucinated rainy_window grainSpeed twin). Audits are inputs,
  not gospel — the executor must re-verify against source.
- zsh backticks in a git commit -m double-quoted string EXECUTE (command
  substitution) and silently delete words from the message — single-quote
  commit messages or avoid backticks (one commit needed --amend).


## 2026-07-28 — Gears v3 delivered (items 58/60/62); two cosmetic nits logged
The v3 deck fixed the user's meshing complaint with actual gear math (shared
module B=11, k=0.89 half-depth pitch radius, center distance = sum of pitch
radii, slope = -N_parent/N_child cumulative along the chain, analytic tooth
phase). Coordinator verified the money shot: teeth genuinely interleave with
backlash clearance. NITS (not blockers, candidates for later polish):
1) metal radial brushing shows a faint horizontal seam band at the hub when a
gear is very large on screen (the near-centre radius clamp in metal_shader's
radial arc-length-constant brushing); 2) seg7 degree readouts can overlap or
clip near small adjacent gears in the title framing. Both visible in
.claude_vlm_checks/gears_v3/final_000018.png.


## 2026-07-28 — Equation Zoo delivered (items 68–69) after one hard-failed round
Round 1 render had 4 crashed slides ("lambda is not defined") — a REAL engine
gap the deck agent surfaced: graph sources sampled in emit() never saw
document vars (fixed in ce777ac, capability-gated docVars injection, pinned by
graph_doc_vars_test). Also the deck agent's own bugs: digest 04's morph params
were degenerate at the extremes (λ=0 a 16-unit dot, λ=1 a 2850-unit blowout —
fixed by normalizing r to the spiral's own outer radius; a lesson for anyone
reusing digest 04 verbatim), and an iso_box collapse flattened Fourier to 16px.
Final deck: 14 slides, zero repairs, 30.8s 720p MP4 through render_job; the
catenary ball's document-equation RK4 matches the SymPy table to 5 decimals
and rendered pixels to <1px at release/valley/turning-point; equal-height
turning points make energy conservation visible on screen. Coordinator
eyeballed the centerpiece and the λ=1 morph frame: both pass the Manim bar.


## 2026-07-28 — Per-widget custom variables delivered (item 67)
Implemented `items.<id>.vars.<name>`, the exact structural mirror of top-level
`state.vars` one level deeper, referenced from equations as `self.vars.<name>`
(owner) / `@<id>.vars.<name>` (cross-item). The digest-09 analysis held up:
the delta fold, undo, and repair pipeline needed ZERO changes — a per-item var
tweens through the generic nested-leaf fold like any property, and back-compat
is automatic (absent `vars` is byte-identical).

THE ONE LOAD-BEARING GAP was slot collection: `computeEvaluatedState` now walks
each item's `vars` dict as numeric equation slots (kind "number", always),
mirroring the top-level vars loop — without it a bare-string or "="-prefixed
per-item var sat unevaluated (UNRESOLVED kind for the "=" form, since no plugin
declares `vars` in defaults). The generic leaf loop skips `path[0]==="vars"` to
avoid re-collecting them with the wrong kind.

Also made `isEquationValue` honor the vars fiat (`path[0]==="vars" ⇒ true`),
which was NOT cosmetic: it is what lets the canonical "walk an item's equation
slots" idiom (clonedItemStates paste-remap, withVariableRenamed, the make-static
scans) reach a per-item var. This closed a real copy/paste gap — a bare-string
cross-item ref stored INSIDE a per-item var (`b.vars.k = "@a.x"`) would not have
re-pointed on duplication — and a latent withVariableRenamed gap (a per-item var
referencing a renamed global). Pinned by item_vars_test.

Rename needed a NARROW sibling `withItemVariableRenamed`, NOT a generalization of
`withVariableRenamed`: per-item refs are WHOLE dotted tokens (REF_RE matches the
dotted path), invisible to the bare-identifier rewrite — the very property that
makes per-item names collision-proof — so a global `lambda` and an item's
`lambda` never disturb each other. It moves the dict key + rewrites `self.vars.`
and `@<id>.vars.` whole tokens via mapRefTokens.

SYNERGY confirmed: the graph plugins already merged `{...docVars, ...state.vars}`
(landed for the equation zoo). Once slot collection EVALUATES the per-item vars,
a `graph_line` with `vars: {lambda: "=0.25*2"}` samples with lambda=0.5 — pinned.

Files: core/expressions.js (slot loop, isEquationValue fiat, withItemVariableRenamed),
web/app.svelte.js (add/delete/rename item-var methods), web/ItemVariablesPanel.svelte
(new; mirrors VariablesPanel), web/Inspector.svelte (collapsible "Variables"
section on the selected item). Tests: tests/item_vars_test.js (24 assertions),
tests/item_vars_probe.js (16 checks, drives the real Inspector UI end to end:
add → bind x to self.vars.lambda → scrub → keyframe across two slides →
tween=0.75 at alpha 0.5 through cameraFrame.evaluatedStateAt → undo one unit each),
plus the shortcut-sweep allowlist entry for the new add-row. Gate: 95/95 node,
hintbar_context_probe + the new probe green.
