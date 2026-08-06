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

## 2026-08-06 — ROUND 7 opens: the audio system was built beside the invariant

Branch `powerrp_branch2` (worktree `/root/CleanCode/Dumps/RPPT/powerrpbranch2`),
per the user's instruction to do all of this round's work there. Requirements
recorded verbatim in the manifest at `## ROUND 7` before any code was touched
(commit d982519), per manifest-first.

### THE ROUND'S THESIS, IN THE USER'S WORDS

*"The audio system seems to be like it was coded by some other person on the other
side of the universe who didn't take any consideration into how this program works
in general. It ignored property states and it just completely ignored the fact that
the presentation mode should be just the same audio as editor mode."*

This is a process failure worth recording as such, not just a bug list. The audio
system was built to a brief and shipped working ON ITS OWN TERMS — the specs are
well-documented, the engine clamps are mirrored honestly, `construct: true` was
invented rather than lie about a knob. What it never did was join the app's core
invariant. **A subsystem can be internally excellent and still be wrong, if it is
excellent against its own private model.** That is the failure mode this round is
paying off, and it is the same shape as the Tower of Babel law already in the
manifest — one concept (a value the document owns) got a second expression.

### FIRST-HAND RECON FINDINGS BEFORE ANY AGENT REPORTED (lead, 2026-08-06)

Recorded now because they shape the plan, and because two of them CONTRADICT the
obvious reading of the user's complaint — which is exactly the kind of thing that
gets lost once a fix lands.

1. **The connection model is ALREADY correct, and already property state.**
   `core/nodeflow.js:27` — `state.inputs = {"<inPortKey>": {item, port}}`, a leaf of
   ordinary widget state, keyframable, with `itemRefs: [["inputs","*","item"]]` so
   duplicate remaps a patch. Its docblock even states the fan-in-1 rule structurally.
   So "the entire audio system needs to be rewritten because it's not properly using
   properties" is TRUE of the audio RUNTIME but NOT of the connection model. Whatever
   breaks the bijection is downstream of a design that is right.
2. **The Inspector's node-input row is also already backed by that same leaf**
   (`web/Inspector.svelte:2492-2548`), and this exact area has been repaired twice
   before for two DIFFERENT reasons — WORKSTREAM CC (the option list read the wrong
   object, so a connected input showed "not connected") and WORKSTREAM CH (option
   values spelled the pair with a raw NUL so they never compared equal). **Two prior
   near-miss fixes in one dropdown is itself the finding**: the row keeps breaking in
   the "reads fine, writes fine, but the two halves don't agree" direction, which is
   precisely the direction the user is complaining about a third time.
3. **The audio plugins are two-line spec wrappers** — `plugins/audio_*.js` are
   `audioNodePlugin(SPEC)` over `core/audio_specs.js`. So R7-11's ~100 ported nodes
   are mostly DATA authoring, not 100 plugin implementations. This is the single
   biggest fact for planning: the breadth work is cheap IF the spec vocabulary is
   right first, and expensive-and-wrong if it is not.
4. **There are TWO node factories plus a bespoke one** — `audioNodePlugin`
   (`core/audio_nodes.js`) and `controlNodePlugin` (`core/control_nodes.js:203`),
   with `plugins/node_keyboard.js` (27 KB) hand-written outside both. That is the
   Tower of Babel behind *"nodes don't seem to have any coherent way of where you
   place the knobs"*, and it means R7-10 is a UNIFICATION, not a new layout engine.
5. **Knob placement has already been patched once for this exact symptom.**
   WORKSTREAM CD (`core/audio_nodes.js:648`, user: *"the knobs stay in place and the
   module knobs are floating"*) added band-floor-then-scale reflow. So the knobs-
   outside-the-node complaint is a REGRESSION OF A FIXED BUG or a different node
   family — most likely the control/keyboard nodes, which never got CD's reflow.
   **Do not re-fix CD; find which family lacks it.**
6. **The audio-enable button is `web/AudioBadge.svelte`.** Its docblock defends
   itself well (browsers refuse an AudioContext without a gesture; silence is
   indistinguishable from breakage) — and the user has now overruled it outright:
   *"Of course I fucking want audio on. I always want audio on."* The resolution is
   NOT to ignore the browser constraint: satisfy it from a gesture the user is
   already making, and keep a LOUD failure surface (the no-silent-failure law still
   binds). What dies is the state that ASKS PERMISSION TO WANT SOUND.

### MISTAKE (lead, 2026-08-06): designed `dt` against half the requirement

The lead specified `dt` as a FIXED simulation timestep in document state, reasoning
from an existing ruling that had refused a `frame` variable. The user overruled it
within the hour: *"By your logic, what happens if we have a framerate we render a
video with like 1000? What if our dt is just .1 seconds? What do we do,
interpolate?"* — a fixed step makes the simulation's resolution independent of the
render's, so frames land between steps.

**Root cause: the objections the lead raised had already been answered in the
brief.** The user had written *"we have a smaller time step. Things will integrate
better"* (meaning: higher fps ⇒ smaller dt ⇒ better integration — a property of
frame-delta dt) and *"it's not perfectly predictable ... which is why it's okay"*
(sanctioning the exact cost the lead was designing around). Both sentences were read
past.

**Lesson: when a design conflicts with a written ruling, re-read the WHOLE
requirement before choosing which to honour.** The user had already weighed the
trade the ruling protects; the lead re-litigated a decision that had been made.
Cost: one wrong section in the manifest and a live agent redirected mid-build. Full
corrected design and the follow-on max-timestep clamp: manifest § R7-9.

### WAVE 1 POST-MORTEM (2026-08-06) — six mistakes, four of them about EVIDENCE

Wave 1 delivered R7-1..R7-4, R7-9, R7-10 across ~32 commits with the bare-node gate at
304/0. The code results are in the manifest. **What belongs here is how nearly every
error in the round was an evidence error rather than a coding error.**

**1. MINE: "do NOT commit — leave the tree dirty" made a single `git stash` catastrophic.**
I told all four writer agents to leave work uncommitted so I could verify before merging.
One agent then ran `git stash` to compare against HEAD and swept up **15 tracked files from
all four writers**; `stash pop` then refused because another agent had rewritten one of them
in the intervening minute. **Root cause: I put four agents' simultaneous uncommitted work in
the one place a single command erases, for a benefit I never actually needed** — reviewing
commits and reverting is just as good and costs a minute. Switched mid-round to path-scoped
commits per agent (disjoint ownership makes them collision-free), and it paid for itself
within minutes: the next agent to look found three of four agents' work already safely
committed. **Lesson: in a shared worktree, uncommitted is not "pending review", it is
"one command from gone".**

**2. GREPPING A LITERAL WHERE THE CODEBASE USES A NAMED CONSTANT — twice in one hour, in
opposite directions, once by me.** An agent reported "`maxTimestep` has no Inspector row, it
does not exist as an authorable property"; the row was at `plugins/camera.js:258` under
`CAMERA_MAX_TIMESTEP_KEY`. I then told another agent `defaultCameraState` lacked the key on
the same evidence; it was at `core/document.js:170` as `[CAMERA_MAX_TIMESTEP_KEY]:` — a
COMPUTED KEY, invisible to `grep maxTimestep`. I checked the commit timestamps rather than
assume: the key landed 20 minutes before I grepped, so it was there and I missed it. **The
agent I had just corrected re-verified instead of deferring to me, and was right to.**
**Lesson: grep the CONSTANT, not the string it holds — and a lead's grep is not authority.**

**3. A SHARED-CAUSE GENERALISATION RECORDED AS MEASURED FACT.** The recon report asserted
that the unsplit-dotted-key bug also broke `plugins/magnifier.js` and
`plugins/tangent_lines.js` ("same line, same shape"). I propagated it into the manifest and
into a user-facing summary. **Both were fine** — those rows are `number`/`angle` kinds which
never reach the broken seam. Only the third agent actually drove the widgets in a browser.
**Lesson: a shared-cause claim is a hypothesis until the SECOND site is exercised.**

**4. A TRUE OBSERVATION OF A SHARED TREE, STATED AS A STANDING FACT.** The same agent
reported twice that another's audio work "exists only in `stash@{0}`". True when observed;
false by the time I read it, because the owner had recovered and committed. Its own summary
is the best statement of the rule: *"an inference is not a finding until it's been measured
on its own terms, and if it's outside my fence I shouldn't be making it at all."*
**Lesson: report your own files; cross-agent status is the lead's to hold, because only the
lead can see all of it.**

**5. THREE FIXES THAT DID NOT STICK WERE THE DIAGNOSTIC, AND NOBODY READ IT.** Three
separate documented commits had "fixed" the audio readout landing on the dials. All three
tuned an offset. The real cause: **a text op's `y` is the line box's TOP, not a baseline**
(`render_gpu/skia/text_layout.js`), while every node text added `size/3` "so the glyphs sit
above it" — so every node text in the app drew a full line low. It also explains the clipped
Number digit and titles hanging below their header strips, each of which had been filed as
its own bug. **Lesson: when a symptom returns after a repair, the repair is evidence the
MODEL is wrong. Escalate to measuring the primitive instead of adjusting the number.**

**6. A NON-OBVIOUS COUPLING: DERIVED SIZES MUST BE INTEGRAL.** The node-chrome unification
made natural sizes derived, which produced a fractional `h` default for `node_knob` — and the
scrub resolver derives a drag coefficient from a default's DECIMAL PLACES, so dragging a Knob
node's height silently became 1.236 px per pixel. Caught by an existing sweep
(`tests/default_step_test.js`) that names `x`/`y`/`w`/`h` explicitly because "a sensitivity
regression here would be far worse than the bug this rule fixes". **Lesson: a value's
PRECISION can be load-bearing somewhere you are not looking. The existing test was the only
thing standing between this and shipping.**

**ALSO FOUND, worth recording because each was invisible:**
- **`setTransportLive` had zero callers repo-wide: the Sequencer node had never emitted a
  single step, in either mode.** A shipped widget that did nothing.
- **`camera.maxTimestep` is the first nullable ITEM row in the codebase** (all 135 widgets
  swept; the other two nullable rows are on slides). So the defaults-filler had never met a
  nullable leaf and treated a stored `null` as a delete sentinel — **the repair pipeline was
  actively destroying the author's "none" on every load and reporting their deliberate choice
  as a deletion** in the loud channel.
- **A stale `stepDt` at a dead clock baked a phantom 0.1 s simulation step into any still
  rendered after a short presentation** — deterministic, reproducible, and wrong. Found only
  because the fix was applied at the clock REGIME rather than to the discontinuity arithmetic.
- Renaming CLAUDE.md's "three kinds of state" to four left **seven** stale citations across
  the tree. Fixed. Prose remains this project's worst-measured defect class.

### RISK ON THE TABLE FOR THIS ROUND

**Simulated state (`@`, `dt`) deliberately weakens a property the app relies on.**
`<app>/CLAUDE.md` states that recordable state is SEEKABLE — "frame 200 renders
without frame 199" — and that this is what lets `cli/render_job.js` shard a render
by strided frame range. It also states outright that carrying state from frame N-1
is disqualifying. R7-9 introduces exactly that, with the user's eyes open
(*"it's very close to perfectly predictable, which is why it's okay"*). The cost is
therefore real and must be BOUNDED, not discovered later: a document containing
simulated state cannot be frame-range sharded, and the render job must detect that
and fall back to sequential rather than silently emit a wrong video.
