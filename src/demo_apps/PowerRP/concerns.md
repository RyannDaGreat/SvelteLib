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

### A FRESH WORKTREE'S FIRST FULL GATE PRODUCES ~26 FAKE BROWSER REDS (2026-08-06)

**Measured, and worth knowing before anyone triages a fresh clone.** The first full gate on
this worktree read `487 pass / 26 fail`, all 26 in `[browser]`, most failing in 7–19 s. The
cause was in the boot-error list of one of them:

```
console.error: Failed to load resource: the server responded with a status of 504 (Outdated Optimize Dep)
pageerror:     Failed to fetch dynamically imported module: …/node_modules/.vite/deps/@pdf-lib_fontkit.js?v=e1002e92
```

**Vite's dependency optimizer.** `node_modules` was installed minutes earlier, so
`.vite/deps` was COLD; the gate runs browser probes at concurrency 3; each probe spins its
own Vite server and they all share one dep cache. The first to re-optimize invalidates the
`?v=<hash>` URLs the others are already serving → 504 → the app fails to boot → every
assertion after it fails. **PowerRP's own CLAUDE.md already names the mechanism** for the
render worker: *"concurrent Vite servers fight the dep optimizer"*. It applies to the test
gate too, and nothing said so.

**PROVEN, not assumed:** `activation_probe.js`, one of the 26, was re-run ALONE immediately
afterwards and passed **71/71 with zero console errors**. Only the dep cache changed.

**THE PROCEDURE FOR A FRESH TREE: warm the cache with ONE browser probe before running the
gate.** Otherwise the first run's browser phase is uninterpretable, and — the expensive part
— it looks exactly like a real regression in whatever landed most recently. This round it
briefly looked like Wave 1 had broken 26 probes.

**This is a THIRD member of a family that has now cost this project real time**, and the
family is the useful finding: a browser red can come from the HOST (a Chrome that cannot
screenshot — hence `browser_capture_preflight.mjs`), from the HARNESS (the 300 s per-suite
cap failing a suite that needs 305 s), or from the BUILD ENVIRONMENT (this). **None of the
three is the app, and all three read as the app.** Check all three before believing a
browser red.

### A GATE RUN DURING CONCURRENT WRITES IS UNINTERPRETABLE — 98 PHANTOM REDS (2026-08-06)

**The lead's own error, and worth recording because the output is spectacular and meaningless.**
A node-lane gate started while two writer agents were mid-task returned
**`212 pass / 98 fail`** — and **every one of the 98 failed at `0s`**. A 0-second failure is not
a test failing, it is a MODULE FAILING TO IMPORT: an agent's file was half-written at the
instant the child process loaded it, so every suite whose import graph reached that file died
before its first assertion.

**Proven in one command:** `node tests/ink_bounds_test.js` alone → all checks `ok`. Nothing was
wrong.

**THE PROCEDURE: DO NOT RUN THE GATE WHILE ANY WRITER AGENT IS ACTIVE.** Wait until they have
reported and committed. A partial gate over a moving tree is worse than no gate, because
`212 pass / 98 fail` looks like a catastrophe and invites 98 investigations.

**THE TELL, which makes this cheap to recognise next time: MASS FAILURE AT `0s`.** A real
regression produces failures with plausible durations and assertion text. A wall of `(0s)`
entries with no assertion text is an import-time crash, and if the count is large the cause is
almost certainly ONE file, not many bugs.

**THIS IS THE FOURTH NON-APP SOURCE OF REDS FOUND IN ONE DAY**, and the family is now the
finding rather than any member of it:

| source | signature | guard |
|---|---|---|
| **HOST** | every screenshot probe dies with a contentless `ProtocolError` | `tests/browser_capture_preflight.mjs` |
| **HARNESS** | one suite fails at exactly the cap having printed every check `ok` | cap raised to 600 s, with the 305 s measurement documented |
| **BUILD ENV** | many browser probes fail in 7–19 s; log shows `504 (Outdated Optimize Dep)` | warm the Vite dep cache with ONE probe alone |
| **CONCURRENT WRITERS** | mass failure at `0s`, no assertion text | do not run the gate while writers are active |

**None of the four is the app, and all four read as the app.** Check all four before believing
a red — and note that three of them were discovered by chasing the fourth, which is the
argument for writing the family down rather than the members.

### A BUILD TAKEN FROM A TREE UNDER CONCURRENT WRITES BRICKS THE APP, AND A SERVICE WORKER MAKES IT STICK (2026-08-06)

**The user hit this and it cost them a debugging session.** Verbatim: *"adding an audio widget
broke it even on refresh, i had to go to incognito to fix it"* / *"adding audio demo poisoned
it"* / *"all of them hang"*. Their shell history shows the cause:

    npx vite build   --config web/vite.config.js
    npx vite preview --config web/vite.config.js --host 0.0.0.0 --port 4178

**That build ran at 12:43, while FIVE writer agents had files mid-edit.**

**NOT REPRODUCIBLE FROM HEAD.** A reproduction script drove a dev server and inserted **all
seven** audio demo patches (`demo-patch-{spacey-pad-drone,sequenced-dings,gamelan-bells,whoosh,
beach,playable-keys,button-ding}`): every one stayed responsive, the autosave reached 82 783
bytes, and the app was responsive **after a reload with that autosave restored**. So the
document is fine and the code at HEAD is fine.

**WHY THE BUILD BRICKED ANYWAY, and it is the combination that matters:**
1. **A MISSING NAMED IMPORT IS SILENT HERE** (already doctrine in `<app>/CLAUDE.md`): Rollup
   binds it to `undefined` and ships it, exit 0, no warning. A file half-written at the instant
   the bundler read it therefore produces a **green build that throws only on the path that
   touches it** — e.g. inserting an audio demo.
2. **THE BUILT APP REGISTERS A SERVICE WORKER** (`web/registerServiceWorker.js`) and
   navigations are CACHE-FIRST. So the broken bundle is then served back on **every refresh**.
   The dev server does not register one (it unregisters any it finds), which is exactly why
   this class is invisible in development.
3. **Incognito "fixed" it** by starting with no worker and no cache — not because the code
   differed.

**THE RULES, and they are the same rule twice:**
- **NEVER BUILD FROM A TREE THAT WRITER AGENTS ARE EDITING.** `git status` must be clean, or at
  least free of the files the build touches. This is the build-shaped sibling of "never run the
  gate while writers are active" — and the build one is worse, because the gate merely reports
  nonsense while the build ships it.
- **A HANG IS NOT A CRASH, so `web/index.html`'s crash handler does not catch it.** The splash
  reports throws during boot; a page that boots and then spins reports nothing.
- **RECOVERY NEEDS THE WORKER AND THE CACHES, NOT JUST `localStorage`:**
  ```js
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k);
  localStorage.removeItem("powerrp.autosave");
  ```

**A REAL GAP THIS EXPOSED, worth closing on its own merits: there is NO escape hatch from a
document that hangs at boot.** Grepped for a `?fresh` URL flag, a discard-autosave command, any
opt-out — **none exists.** `AUTOSAVE_KEY = "powerrp.autosave"` (`web/app.svelte.js:172`) is
restored before the user can act, so if a document ever *does* hang the app, it is unrecoverable
through the UI. Today's cause was the bundle rather than the document, but the hole is real
either way.

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

---

## 2026-08-06 — A COMMIT OBJECT WENT MISSING UNDER TWELVE CONCURRENT COMMITTERS

**Symptom, and it is not the one you would expect.** Every test passed and every file
was present, but `git log` died:

    error: Could not read 65faebbf70f971a088ec9950d1d3718f8782addb
    fatal: Failed to traverse parents of commit 28260ed68d71bd980ff344950f32e9f47d32e38d

So `git log`, `git blame` and `git log -S` were ALL unusable — which matters more than it
sounds, because `.frenzy/round7/BRIEF.md` tells every agent to settle unnamed conventions
by researching precedent with exactly those three commands. The tooling the stickler rule
depends on was broken for hours and the working tree looked perfect the whole time.

**Found by VC-5**, which hit it trying to attribute a build break and reported "the
repository has an unreadable object reachable from history" rather than working around it.
It could not name the author and **said so instead of guessing** — the right call.

**Diagnosis.** `28260ed6` (a patch agent's Incanta commit) named a parent whose object was
never in the store. The reflog shows the shape exactly: entries run `@{1}` = 28260ed6 then
jump to `@{3}` — `@{2}` WAS the lost commit, sitting between `3acbdb83` and the Incanta
commit. So a ref update landed for a commit whose object was lost, and the next commit
built on it.

**Cause, as far as it can be established: git's AUTO-GC racing a commit.** Around a dozen
agents were committing to one worktree within the same minutes. Auto-gc triggers on loose
object count, and a `gc --prune` that runs while another process has written an object but
not yet referenced it can collect it. Nothing else in the session touched git plumbing, no
agent ran `gc`, `prune`, `reset` or `stash`, and the branch rules forbid all of those.

**Repair — non-destructive, and nothing was lost.**

    git replace --graft 28260ed6 3acbdb83

Traversal restored: 1379 commits reachable, `git log -- <path>` works again. **No file
content was lost.** The lost commit's TREE survives inside every commit after it, because
28260ed6 was built on top of it; what is gone is only that one commit's own message and its
standalone diff. Its changes still appear, folded into 28260ed6's diff against 3acbdb83.
The graft is reversible with `git replace -d 28260ed6`.

**Prevention, applied:** `git config gc.auto 0` in this worktree. Turn it back on when the
swarm is done and run one explicit `git gc` then.

**THE LESSON THAT GENERALISES.** A dozen agents committing to one shared worktree is a
concurrency regime git is not being asked to handle every day, and its failure mode here
was SILENT and REMOTE from the cause: no commit failed, no test failed, no file changed,
and the damage surfaced only when somebody tried to read history. **Before running a large
swarm against one worktree again, disable auto-gc FIRST** — and treat "git log suddenly
does not work" as a corruption symptom rather than as a bad command.

---

## 2026-08-07 — THE DOCTEST GATE HAS NEVER SEEN `synth/`, WHICH IS WHERE THE ARITHMETIC IS

`tests/doctest_test.js:116` is `const SEARCH_DIRS = ["core", "plugins", "render_gpu",
"cli", "web"]`. **`synth` is not in it.** Measured 2026-08-07: **964 `@example` lines live
in `synth/`** against 6128 in the scanned directories — so ~14% of the project's doctests
have never been executed by the gate, and they are the ones on the DSP kernels, where
every ported recurrence lives. CLAUDE.md says "doctests are the specification"; for the
kernels there has been no specification, only prose that looked like one.

**THIS IS THE SAME DEFECT THE FILE ALREADY RECORDS SURVIVING ONCE.** Its own header, line
15: *"`web/` — the app shell, ~24k lines — was outside SEARCH_DIRS entirely."* A
hand-maintained directory list lost `web/`, was fixed by adding one string, and then lost
`synth/` the moment a new top-level directory started carrying doctests. Adding a second
string fixes today and loses the next one. **The list should be derived** — the
directories that exist and hold JS, minus a named exclusion set — so a new one is scanned
the day it appears.

**FOUND BY A PORT AGENT** that ran the harness by hand over its own block, noticed its
examples had never been in the gate, and confirmed the cause at the source line rather
than reporting a suspicion.

**WHAT IS BEHIND THE HOLE, measured before flipping it:** 6 value failures
(`ax2_kernels.js:580` and `:779`, `vc1_kernels.js:337`, `vc5_kernels.js:228`,
`vc10_kernels.js:869` and `:2747`) and **3 UNPARSEABLE** examples — `vc5_kernels.js:253`
and `:254` (`Unexpected token 'const'`) and `voices.js:65` (`Unexpected token 'try'`) —
statements where the harness wants an expression, which specify nothing today. The harness
exits 1 on `syntaxBroken` as well as on failures, so **both sets must be clear before the
switch is flipped**, and `MIN_EXECUTED` needs raising (floor 3800 against a measured 3961;
`synth` adds ~886 executed).

**SEQUENCING, and why it was not fixed on the spot:** four port blocks were being written
at that moment and the gate is the signal those agents work against. Turning it red on
nine failures in files they were mid-edit on would have cost more than it bought. The
switch is flipped once the blocks land — recorded here so it cannot be quietly dropped,
which is exactly how `web/` stayed outside for as long as it did.

**AND A SECOND-ORDER LESSON, worth more than the hole itself.** One of the stale doctests
had propagated into user-facing prose: `core/audio_specs_vc8.js`'s `panLaw` knob `help`
repeated the same pre-rewrite claim, and unlike a doctest that sentence is read by authors
in the Inspector. **When a doctest goes stale, grep the prose that quoted its reasoning.**

## 2026-08-08 — ryohey/signal replaces the lookalike; two audio gaps written down before they evaporated

### Two OPEN questions handed to this workstream that belonged to nobody's file

Both arrived as prose in a briefing, were true, and were **written down nowhere in
the repo** — which is exactly how a measured finding stops existing. Neither is in
this workstream's area (both sit in `synth/` + `web/audioMirror.svelte.js`, owned by
the Surge patch-restore workstream at the time), so neither was touched. They are
recorded here so the next agent inherits them as facts rather than as folklore.

1. **THE RENDERED-WAV ENERGY DOES NOT MATCH THE PHRASE.** Per-window energy of the
   rendered WAV does not cleanly correspond to the notes: the SECOND EIGHTH comes
   out roughly **13 dB down**, and dry chains sustain past their release. **The voice
   pool has been RULED OUT.** The untested hypothesis is **the default patch's own
   amp release** — i.e. the deck is correct and the instrument is ringing. That is
   testable without touching the scheduler: render the same phrase against a patch
   with a known-short amp release and see whether the window energies line up. Until
   someone does, an energy-vs-phrase assertion is measuring the patch, not the code.

2. **THE PUMP-START ON THE PRESS SIDE IS UNTESTED DEFENCE-IN-DEPTH.** `mirrorAudioFrame`
   ALSO arms it, so removing the press-side start shows NO TEETH — a test written
   against it would pass either way and would be a test of nothing. This is worth
   stating rather than deleting the code: the belt is untested because the braces
   work, which is a different situation from dead code, and a future agent who
   "cleans it up" after a green run will have proved nothing about whether it was
   load-bearing under a different arrival order.

### What DID ship here (for the record)

The hand-rolled piano roll is DELETED — `web/PianoRollModal.svelte`,
`core/piano_roll.js`, `web/pianoRollEdit.js` and both its suites — and replaced by
ryohey's `signal`, vendored and framed. The user's ruling was standing and had been
stated three times ("USE IT dont imitate it"); the lookalike had already drawn
"this little chicken shit 'midi clip' temu-quality 'we have signal at home' widget".
**The doctrine went in the same commit as the code**, per this project's own rule
that a revert leaving its prose standing installs a confident lie.

**THE AUTHORING SEAM IS AN SMF, WHICH IS THE FINDING WORTH KEEPING.** signal's
bundle exposes no store handle, so the parent cannot read its song object — but its
`localStorage["signal_autosave"]` value is `{midiData: <base64>, timestamp}` where
`midiData` is a complete **format-1 Standard MIDI File** written by signal's own
exporter. So the coupling is to **SMF, a frozen 1996 grammar**, and NOT to a
minified third-party object model: a signal upgrade that renames every symbol cannot
break the import. The three alternatives were each measured and refused, and each
refusal is recorded in `core/signal_song.js`'s header.

**THE PRE-EXISTING REDS THE VENDORING CREATED WERE FIXED, NOT INHERITED.** Three ban
suites (`one_ranking_ban_test`, `popover_reinvention_ban_test`,
`connectivity_seam_test`) went red at the vendoring commit because they sweep `web/`
and met a 2.35 MB minified third-party bundle under `web/public/`. Confirmed
pre-existing by stashing. They now skip `public/` for the same stated reason they
already skip `dist/` — Vite's `public/` is BY DEFINITION copied verbatim and is
never source we author.

## 2026-08-21 — ROUND 8: the visual node (progress log)

- Built `core/visual_node.js` + `plugins/visual_node.js`, the `visual` port type,
  per-port `color`, the `multiple` input protocol, `placePorts` and
  `dynamicInspector` hooks, the ListField `text` field, and the TextEditController
  `ink`/`box` descriptor fields. Details in the manifest's ROUND 8.
- **MISTAKE — doctrine in the wrong file.** The round's paragraph went into
  CLAUDE.md; the user: "That does not go in claudeMD … Claudemd needs to have
  guiding rules - not specifics unless they're critical hazards." Moved to the
  manifest; CLAUDE.md kept one hazard rule (connection slots have two shapes).
  Lesson: CLAUDE.md = rules; the manifest = the project.
- **MISTAKE — three hand-computed doctest expectations were wrong** (diamond bead
  x 72.5 → 86.25, an ambiguous centre-of-diamond rim query, ellipse inscribed width
  50.7 → 70.7). Caught by `doctest_test.js`. Lesson: run the doctest gate before
  believing an `@example` you wrote from arithmetic in your head; pick queries with
  one nearest edge, not ties.
- **MISTAKE — a test forgot the plugin's DEFAULT `cornerRadius` (10)**, so the
  diamond it measured was rounded and the bead sat at 195.5, not 200. The geometry
  was right; the fixture was under-specified. Lesson: state every knob a geometry
  test depends on.
- **Pre-existing reds, confirmed at HEAD via a worktree with node_modules linked**
  (not by stashing): `audio_patches_test.js` (vcv-ambient-drone: `vessek` has no
  `p1`/`i3`, `caudal.speed` out of range), `doctest_test.js` (pptx_translate
  `resolveLine` strokeWidth 1 vs 1.333, `projectApi.pptxDisplayName`, an
  unparseable `@example` in `core/pptx_translate/translate.js:88`). Untouched here.
- Node suite: 340 pass / 2 fail (the two above). `visual_node_probe.js`: all
  checks pass. A PowerRP `vite build` (the app's OWN config) exits 0.
- **MISTAKE — the caption pushed the text down.** On a labelled non-card shape the
  text box lost the caption's line at its top, so middle-aligned text centred in
  the remainder and sat visibly below the shape's centre (user screenshot: a
  chamfered "Block" with its text low). Fixed: the text box IS the content box;
  the caption sits at its top edge. Lesson: "centred" means centred on the thing
  the author sees, not on a box they cannot.
- **A reroute back onto the same `multiple` socket was refused as a duplicate**
  because `wireTargets`/`wireDrop` judged the drop against items that still
  stored the picked-up wire. Fixed by judging every verdict against the detached
  view (`detachedBase`). Caught by `tests/visual_node_test.js`.
- The user committed the in-flight tree as `bff6e7c6 visualnodetest` mid-round
  (no `[C]`); the remaining fixes and the doc move land in the follow-up commit.
- **MISTAKE — the port lists read as two extra categories.** The list control's
  own collapse header reuses the category accordion's look, and `.list-cell` sat
  flush with the category, so "1 INPUT" / "1 OUTPUT" read as siblings of PORTS
  (user screenshot: "what a visually confusing mess... why are they not indented
  like others i.e. gradient and material etc? this looks so flat but it's not").
  Fixed with the interp strip's nested bracket (one label gutter + hairline) on
  `.inspector .row.row-list > .list-cell`, which also nests the polygon's points
  and every other top-level list row the same way. Lesson: a reused header look
  carries the reused header's RANK; nesting has to be drawn, not implied.
- **Inspector scroll reset on reselect** (user: "the properties need to stop
  scrolling back to the top each time I deselect and reselect a widget"). Cause:
  `.panel-body` is the scroller; deselecting unmounts `.rows`, the content
  collapses and the browser clamps scrollTop to 0, so the next selection mounts
  at the top. Fix: SCROLL MEMORY in `web/Inspector.svelte` — record the scroller's
  position on every scroll while an item is selected (the clamp fires with none
  selected, so it is not recorded), restore it after `tick()` when a selection
  lands. `tests/inspector_scroll_probe.js` pins deselect→reselect, A→B, and that
  a new position is the one remembered.

## 2026-08-21 — wire styles (user: "I want the BEST solution. not the cheapest.")

- A short forward bezier HOOKED (beads ~70 apart: control points at +40/−40
  crossed). Root cause: the 40-unit reach floor applied to every wire, though its
  only job is the stacked/backward case. Fix: forward wires use |dx|/2 capped (x
  is monotonic, no hook possible); the floor stays for dx ≤ 0.
- The user rejected the patch-only answer, so the feature is a CHOICE: `WIRE_STYLES`
  bezier | straight | elbow. Deck default = `wireStyle` on THE CAMERA (the
  `rendering` bundle, so `defaultCameraState` is born with it and old decks fill
  it quietly as version skew); per-port override = `wire` on a port declaration,
  resolved destination → source → camera in `deriveWires` and carried as
  `wire.style`; one dispatcher `wirePathD` for painter, exporters and the ghost.
  The visual node's port elements gained a `wire` select ("Deck default" stored
  as "inherit"), which needed a `select` field control in ListField.
- Concurrency note: derive.js changed under me (another session added `fired` on
  wires); edits were re-based on the live text rather than on my stale copy.
- **CORRECTION — scroll memory belonged in Panel, not Inspector** (user, 2026-08-22:
  "same applies to ALL panels including tool panels. It should have been done
  higher up in the class hierarchy"). The Inspector-local version is deleted;
  `web/Panel.svelte` now remembers `.panel-body`'s last user scroll (a scroll
  event landing exactly on a shrunken maximum is the browser's clamp, not the
  user, and is ignored) and restores it from a ResizeObserver on the body's
  content whenever that content's height changes. Every pane gets it with no
  opt-in. `tests/panel_scroll_probe.js` (renamed from inspector_scroll_probe)
  covers the properties panel AND the tools pane. Lesson: a fix for "the
  scroller resets" goes on the scroller.


## 2026-08-22 — the routing point, and three audit fixes I owned

- Built the routing point (manifest ROUND 9). The interesting design question was
  the PASS-THROUGH: the value evaluator handles a joint for free, but the audio
  mirror, the live-control router and the clip router each walk `inputs` themselves
  and would have seen it as a stranger — a joint dropped into an audio patch would
  have SILENCED it for a formatting edit. `resolvedWireSource` is the one walk all
  three now go through, and `passThrough` is a declaration so the next honest cable
  joint is covered the day it says so.
- **MISTAKE — a test premise that was arithmetically wrong.** `route_node_test`'s
  "a bezier is not its chord" check first sampled BOTH at t = 1/2, where they
  COINCIDE: wirePathD pushes both control points out by the same reach, so they are
  symmetric about the chord's midpoint and the curve passes through it. The check
  proved nothing until it was moved to t = 1/4. Lesson: when a test asserts two
  things differ, assert first that the fixture actually separates them.
- **The visual node's own sweep tripped on the new widget**, because it said "no
  shipped non-visual port declares `multiple` or `color`" — a claim that was really
  "these additions are opt-in". Replaced with an explicit OPTED_IN roster the sweep
  compares against, so adding a fourth widget is an edit in front of a reader
  rather than a silently widened exemption.
- Audit findings I owned: derive's SECOND simulation roll per live frame is gated
  behind `stateUsesFrameDomain` (the in-file comment already CLAIMED it cost a
  joint-free deck nothing; the argument expression was evaluated unconditionally, so
  `= @@ + dt` lost half its elapsed time — the residual for decks that DO use the
  frame domain is now stated with the real fix named, a per-rAF clock latch); the
  fired-wire set moved from a process-global cell to a WeakMap keyed on the derived
  tree, so a thumbnail's derive can no longer overwrite the canvas's flash; and the
  dynamic "closest" anchor candidate is now collected out to `anchorStickyReach(tol)`
  so it can be HELD by the hysteresis that every preset anchor already had.
- **A probe caught a bug that was not mine and not real**: `route_insert_probe`
  reported `projectComponent is not defined` from the browser while bare node was
  clean. It was a transient half-applied edit in `core/expressions.js`, which
  another agent held open at that moment. Lesson for concurrent work: re-run before
  believing a browser-only failure in a file someone else is editing.

## 2026-08-21 — A SYSTEM-CLIPBOARD IMAGE COULD NOT BE PASTED AFTER THE FIRST WIDGET COPY

**THE REPORT (user, verbatim):** *"also why can't i copy and paste images into
birdseye anymore i have to drag + drop an external image. it refuses to recognize
when I have an image in my clipboard that's different from the image copied from
copying nodes. please have the agent read thru the manifest, this is the newest bug
in an old problem."*

**THE OLD PROBLEM, and how it was solved before.** Three entries in the manifest are
the same question asked at different times. `1b7a3df8` (2026-07-27) built the
bidirectional canvas clipboard and disambiguated by HASHING the PNG (`png_sig`,
`web/clipboard.js imageSignature`). ROUND 3 #36 (`claude_instructions.md:546`) is the
user finding that broken: *"copying a gear widget and pasting produced an IMAGE
widget instead of a widget copy… The internal widget payload must win over the
clipboard's image flavor."* `d39e13f0` (2026-07-30) diagnosed why the hash could never
work — **the OS pasteboard RE-ENCODES an image in transit** (581 bytes in, 645 out,
measured on macOS) — and replaced it with a LABEL that survives verbatim:
`POWERRP_CLIPBOARD_MIME`, written beside the PNG in one `ClipboardItem`. R7-26
(`claude_instructions.md:5960`) then records that *"nothing about that behaviour may
change"* and quotes `web/app.svelte.js:4415` as where the precedence is written.

**THE OVER-CORRECTION, which is this bug.** `d39e13f0` did not use the marker as
EVIDENCE. It made the marker one of two ways to prove ownership and then made
everything else lose anyway: `#isForeignFilePaste` returns foreign only for a
NON-IMAGE file, so a bare `image/png` lost to the in-app clipboard unconditionally.
Its docblock justified that with two escape hatches — *"A user who wants the
screenshot copies it AFTER the widget copy is stale, or pastes into a slide where no
internal copy exists"* — and **BOTH ARE FICTIONAL.** The in-app clipboard is
`localStorage["powerrp.clipboardMirror"]` plus a cookie-keyed server session; nothing
anywhere clears either, and neither is scoped to a slide. So the FIRST widget copy a
browser ever makes disables system-image paste **permanently**, and drag-and-drop is
the only remaining way in — exactly what the user says. It is not a regression from
the 2026-08-21 `nug` merge (77 commits, none touching the paste decision);
`git log -L` puts the last change to that method at `514d0452`, 2026-08-02, and it was
a comment. **The bug shipped 2026-07-30 and the node work merely made people copy
often enough to meet it.**

**MEASURED, not reasoned.** `tests/paste_screenshot_precedence_probe.js` boots the real
app and pastes a synthetic `ClipboardEvent`. Empty in-app clipboard → the image becomes
a widget (case 1, green). Copy a widget first, then paste a DIFFERENT image → a CLONE of
the copied widget appears, zero uploads (case 2, RED). The two outcomes both add exactly
one item, so the assertion is on `src`, not on a count.

**THE AMBIGUITY IS NOT REAL ON A BROWSER THAT TAGS OUR COPIES**, and that is the fix.
A copy writes the marker and the PNG as ONE `ClipboardItem`; a screenshot REPLACES the
pasteboard whole. So an image arriving with NO marker is proof the clipboard is no
longer the one we wrote. `web/clipboard.js` now owns that rule as three pure/query
functions: `osClipboardTagging()` (a capability check — `ClipboardItem.supports("web
application/x-powerrp-item")`, MEASURED true in this repo's headless Chrome on a
127.0.0.1 origin and false for a non-`web ` type; the whole of `ClipboardItem` is
undefined over the plain-HTTP origins this app deliberately serves), `foreignImagePaste`,
and `untaggedCopyNotice`. Where the evidence is genuinely unavailable — a browser that
takes `image/png` but refuses the custom type — the element still wins exactly as before
AND the notice says so, because that is the one case with no gesture that reaches the
screenshot.

**WHY A CAPABILITY CHECK AND NOT A REMEMBERED WRITE.** The first design recorded the
outcome of the last OS write in `localStorage` beside the mirror. `ClipboardItem.supports`
answers the same question BEFORE any copy has happened, so a fresh tab is as well informed
as one that has copied ten times, and there is no per-copy flag to persist, invalidate, or
get wrong across tabs.

**WHAT IS NOT DONE, AND WHY.** `web/app.svelte.js` was HELD BY ANOTHER AGENT for the whole
of this work, so the call site was stated rather than edited. The probe is therefore RED at
the time of writing and its case-2 message names the four-line patch. With that patch
applied to the SERVED bytes only (a Vite `transform` plugin in a scratch script, nothing on
disk), all three cases go green — that is the proof, not an expectation.

**LESSON.** A precedence rule that resolves an ambiguity must state where the LOSING side
can still be reached, and that statement has to be checked against the code rather than
assumed. Both hatches in this docblock read as plausible and neither existed; nobody
noticed for three weeks because every test wrote the two clipboards in the order that
hides it — `tests/paste_upload_probe.js` pastes the image BEFORE it ever copies a widget.
**Test the order the user actually works in.**

- **MISTAKE — verbatim capture was partial.** ROUND 8/9 quoted only the fragments each
  design turned on, and several other asks were paraphrased or truncated (the panel
  scroll's "so annoying", the full image-paste report, the whole `multiple` dictation).
  The user: *"it looks lieke you forgot t copy my verbatim"*. Every message of the
  session is now in the manifest's USER MESSAGES, VERBATIM section, unedited. Lesson: a
  quoted fragment is my INTERPRETATION of what mattered — the record has to carry the
  whole thing so a later reader can judge for themselves.
- **MISTAKE — I wrote a second, WRONGER copy of the colour grammar.** `declaredPorts`
  refused any port `color` that was not a hex literal, "because the painter cannot
  resolve a name". `render_gpu/ir.js parseColor` accepts hex (3/4/6/8), rgb()/rgba()
  AND the 148 CSS named colours, so the claim was false — and the check THREW from a
  function the hit test, the wire derivation and the Inspector all call, so one bad
  leaf would have taken the whole canvas down instead of one op. Caught by
  `retype_sweep_test`: retyping a corkboard thumbtack (colour `rgb(210,45,45)`) into a
  routing point threw. The validation is gone; the painter owns the grammar, as it does
  for every other colour leaf in the app. Lesson: before validating a value, find the
  consumer that already decides what is valid — a stricter second opinion in core is
  not "defence in depth", it is a bug with a docblock.
- **The routing point tripped `node_chrome_unify_test`'s card census**, correctly: it
  paints one disc, not a body + strip + title + mark + rim. Added to that file's
  exemption roster (which already held `visual_node`) as a NAMED list with reasons
  rather than a predicate, so a third cardless node is a deliberate edit. It stays in
  the census for every other sweep — ports, bounds, itemRefs.

## 2026-08-22 — the audit of the 77-commit pull, and what the METHOD taught

The manifest records what was found and fixed. What belongs here is how it was found
and what went wrong along the way.

- **THE ADVERSARIAL PASS EARNED ITS COST.** Every finding faced three skeptics with
  different lenses (reproduce / design-intent / blast-radius) and survived only on a
  2-of-3 majority; 6 of 74 were refuted. The refutations were the useful part: each was
  a reviewer reading a docblock's INTENT as a promise the code had broken, when the code
  was the documented design working correctly. A single-pass review would have shipped
  those six as defects and spent a fix on each.
- **A SECOND PASS OVER THE FIXES FOUND FIXES THAT LIED.** Five of nine verifiers found
  either an incomplete fix or a NEW false claim introduced BY a fix — a fixer writing
  "all ten now draw exactly what they ask for" when one still did not, a budget comment
  claiming a sweep "visits each node once by construction" when it does not. A fix is a
  change, and a change can carry the same defect class it was sent to remove.
- **DISJOINT FILE LEASES ARE NOT ENOUGH.** Renaming the empty widget's anchor ids
  (`+x` → `plusx`, which the equation grammar can actually spell) was correct and
  in-lease, and it broke `web/CanvasView.svelte`, which still asked for `-x`/`+x` and
  would have drawn no cross at all. The lease stopped the agent from editing that file;
  nothing stopped the rename from reaching it. **A rename needs a repo-wide sweep for
  its old spelling, by whoever holds the far end** — the verifier caught it, and the
  parent applied it. Same class as CLAUDE.md's missing-named-import hazard: silent.
- **A THIRD PARTY'S HALF-EDIT LOOKS EXACTLY LIKE A BUG.** `route_insert_probe` reported
  `projectComponent is not defined` from the browser while bare node was clean — a
  transient state of `core/expressions.js` while another agent held it open. Re-run
  before believing a browser-only failure in a file someone else is editing.
- **A PROBE'S OWN SCREENSHOT SAT UNTRACKED IN `tests/`** (`surge_gui_probe.png`, 191 KB)
  in a tree three agents were committing from — one `git add -A` from being mistaken for
  a fixture. Deleted, and `tests/*.png` is now ignored with `tests/fixtures/*.png`
  exempted, so the real fixtures stay tracked.
- **THE GATE HAS A HOLE THE AUDIT WALKED THROUGH**: `doctest_test.js` executes `@example`
  records only, so every `>>>`-style example is outside it. That is why a stale one in
  `core/var_kinds.js` survived long enough for an audit to find it, and it is a gate
  defect, not a file defect.
- **THE DOCTEST GATE WENT GREEN FOR THE FIRST TIME** (6760 executed, 0 failed, 0
  unparseable) once the audit's fixes landed and three stragglers no brief covered
  were dealt with. Each was a different way for an example to be wrong:
  · `core/pptx_translate/paint.js` read a POINT value off its own input where the
    code returns PIXELS (12700 EMU = 1 pt = 1.333 px at 96 dpi). The conversion was
    right; the example had been red against correct code.
  · `core/pptx_translate/translate.js`'s `idMinter` example was written as a
    STATEMENT plus an expression (`const mint = …; [mint(), mint()]`), which the
    runner cannot parse — so it was the entire UNPARSEABLE count, sitting outside
    the gate while appearing to specify the function. Now an IIFE, one expression.
  · `web/projectApi.js` — **a real bug, not a stale example.** `/\.pptm?$/i` matches
    `.ppt` and `.pptm` and NOT `.pptx`, so a dropped deck named its project
    "Q3 Roadmap.pptx"; `isPptxFile` carried the same pattern, where it mattered more
    (a .pptx was recognised only by its MIME type, so a drop supplying no type was
    not a deck at all). `[xm]?` in both. Lesson: a red doctest is not always the
    example's fault — read the CODE before "fixing" the expectation, and here the
    red had been sitting long enough that everyone assumed it was cosmetic.
- **AND ONE OF MY OWN, THE SAME SLIP TWICE.** `core/wire_drag.js`'s `wireAt` doctest
  asserted a bezier MISSES its chord midpoint. It does not: `wirePathD` pushes both
  control points out by the same reach, so they are symmetric about that midpoint and
  the curve passes through it — the identical arithmetic error I had already caught
  and fixed in `tests/route_node_test.js` hours earlier, repeated in the docblock of
  the very function that test covers. Rewritten at the quarter point with MEASURED
  numbers. Lesson: fixing a wrong belief in one place does not fix the copies of it
  you wrote elsewhere from the same wrong belief — grep for them.
- **`sky_twinkle_trails_test.js` re-confirmed as the documented false red**: 1501 s
  and killed under the gate's x8 concurrency, PASSES standalone (10 checks). CLAUDE.md
  already records this; noting the re-measurement so the next reader does not spend
  the time again.

## 2026-08-22 — repairing the browser gate, and three defects the probes were right about

Six lanes over the browser reds the pull left. Four landed (two died on a
machine-sleep API error and were resumed); every fix was checked by a verifier whose
ONE brief was "did this pass by asserting LESS?" — none had.

- **TWO PROBES WERE NOT FAILING, THEY WERE CRASHING.** `evaluate_affordance_probe` and
  `equation_code_modal_probe` threw a TypeError after ONE check each, so ~45
  assertions had never executed — and the gate reports a crash the same way it
  reports a failure, so nobody knew the coverage was gone. Compound rows (15a7d333)
  moved X/Y into a COLLAPSED "Position" group; the probes now open it (loudly, by its
  own twisty, throwing if it is absent) and all 45 run. **A red probe may be hiding a
  much bigger hole than the one it names — count the checks that ACTUALLY RAN.**
- **TWO PROBES WERE MEASURING THE HOST.** `pdf_surface_guard_probe` and
  `pdf_zoom_crash_probe` are the only ones of ~160 that never spin their own Vite
  server: they `page.goto` a hardcoded port and fail with ERR_CONNECTION_REFUSED when
  nothing is listening. They now self-spin like their siblings.
- **`text_size_step_probe`'s expand sweep had ALWAYS been a no-op**: it selected
  `.cat-head`, a class that has never existed in this repo (`git log -S` finds no
  commit for it; the real one is `.cat-header`). It "passed" by never expanding
  anything. Fixed, and it now ASSERTS that no category or compound is left folded —
  a sweep that can silently do nothing is not a sweep.
- **THE PROBES WERE RIGHT ABOUT THREE PRODUCT DEFECTS**, and refusing to go green is
  how they said so:
  · TWO Inspector rows both labelled "Size" — the new w/h compound and text's
    long-standing FONT size row, on screen together for a text widget. The newcomer
    yields: the compound is "W × H". A label is what an author points at.
  · `.varspanel .var-kind { flex: none; width: 84px }` overlapped the ƒ affordance by
    28.84px. THE CAUSE IS TWO NUMBERS THAT ARE THE SAME NUMBER: `--a-var-kind-w` is
    84px and `LABEL_FRAC_DEFAULT` (0.23) is DERIVED from 84px against a 362px row —
    it is the fraction that makes the label cell exactly 84px. So the picker alone
    wanted the whole cell, before the name field and before the 14px ƒ gutter, and
    `flex: none` let it take it. Now `0 1 auto` + `min-width: 0`.
  · `render_gpu/gpu/pdf_page_vector.js`'s header drew a contrast between "the MAIN
    pdfjs build" used by the raster path and the legacy build used here. Both are on
    legacy (`pdf_page_raster.js:158`). The false contrast is why its own flagged
    optimization ("consolidate both onto one build") was never taken up: that task
    had nothing to do, while the real cost — a second `getDocument` parse — went
    unnamed. **A doc hazard does not merely mislead; it can retire a real task by
    describing it as already-hard and pointless.**
