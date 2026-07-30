/**
 * WIDGET UI-HANDLER MIGRATION gate — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/activation_migration_test.js
 *
 * WHY THIS EXISTS. web/widget_handlers.js replaced an if-chain of known type names
 * inside the canvas with a registry a widget names by string. While the migration
 * was in flight the registry ALSO carried per-handler `claims(plugin)` predicates
 * that `handlerFor` fell back on, so a widget that had not yet been migrated still
 * resolved — a documented bridge, but a bridge that would have let the if-chain
 * quietly live on forever inside the registry.
 *
 * Those fallbacks are gone. Resolution is now the DECLARATION and nothing else,
 * which means a widget that ships a behaviour's CONTENT descriptor (`primaryAsset`,
 * `inlineTextEdit`, `floatingToolbar`, `interiorView`) but forgets the one-line
 * `activate` string does not misbehave — it silently has no behaviour at all, which
 * is the failure mode of exactly the class the sibling report flagged (a new media
 * widget that never repaints because nobody added it to a list). So the predicates
 * survive for ONE reader, `migrationPlan`, and this suite is the ratchet:
 *
 *   (1) THE GATE — migrationPlan(roster) is EMPTY. Delete any single
 *       `activate:` line and this fails, naming the widget and the one-line fix.
 *   (2) THE TEN — every widget that used to be resolved by a legacy claim now
 *       resolves by its OWN declaration, to the SAME handler it had before.
 *   (3) THE BRIDGE IS REALLY GONE — a synthetic plugin carrying a content
 *       descriptor and no declaration resolves to NULL (it would have resolved
 *       through a claim), while migrationPlan reports it. Both halves matter: the
 *       first is what makes the abstraction real, the second is what makes
 *       forgetting it loud.
 *   (4) A TYPO THROWS — an unknown handler id is a loud error, not a disabled
 *       widget (the getMaterial precedent).
 *   (5) CREATION — filmstrip's "place a box, then ask for the video" is a
 *       DECLARED creation gesture, not a `type === "filmstrip"` branch in addItem.
 *   (6) THE MANDELBROT'S INTERIOR VIEW — the two pure functions the explore-mode
 *       handler asks it, including the split-centre rule that a pan at
 *       fineExponent > 0 writes the FINE slots and leaves the coarse digits alone.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
// builtinRoster(), NOT allPlugins: this file SWEEPS "every shipped widget", and
// allPlugins is only the SOURCE-MODULE half of the roster — the five batch-1 widgets
// (donut, progress_bar, number, both clocks) moved to the built-in plugin-asset
// library and silently left every such sweep. See plugins/index.js builtinRoster.
import { builtinRoster, registerPlugins } from "../plugins/index.js";

const roster = builtinRoster();
import { createRegistry } from "../core/registry.js";
import {
  canvasModes, getHandler, handlerFor, handlerIds, migrationPlan, phaseNames,
} from "../web/widget_handlers.js";
import { approxCentre, mandelbrotPlugin } from "../plugins/demo/mandelbrot.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const registry = createRegistry();
registerPlugins(registry); // BOTH halves of the roster: source modules + the built-in plugin-asset library
const registered = registry.all();
const pluginOf = (type) => {
  const p = registered.find((x) => x.type === type);
  assert.ok(p, `no registered plugin "${type}" — update this test's roster`);
  return p;
};

/**
 * THE TEN. Every widget the migration covered, with the handler it resolved to
 * through a legacy claim BEFORE the claims were deleted. Written out literally
 * rather than derived, because the whole point is that the behaviour is UNCHANGED:
 * a derived expectation would move with the code it is meant to pin.
 */
const MIGRATED = {
  text: "rich_text_edit",
  plaintext: "inline_text_edit",
  latex: "latex_edit",
  cursor: "overlay_palette",
  image: "asset_picker",
  video: "asset_picker",
  video_scrub: "asset_picker",
  pdf_page: "asset_picker",
  video_v5: "asset_picker",
  video_v5_scrub: "asset_picker",
};

// ── (1) THE GATE ─────────────────────────────────────────────────────────────
test("migrationPlan(roster) is EMPTY — every widget names its own handler", () => {
  const plan = migrationPlan(registered);
  assert.deepEqual(
    plan, [],
    `unmigrated widgets:\n${plan.map((r) => `  ${r.type}: add \`${r.edit}\` (phase "${r.phase}", handler "${r.handlerId}")`).join("\n")}`,
  );
});

test("no handler carries a `legacy` retirement note any more", () => {
  for (const phase of phaseNames())
    for (const id of handlerIds(phase)) {
      const h = getHandler(phase, id);
      assert.equal(h.legacy, undefined, `${phase}/${id} still carries a legacy note — the bridges are retired`);
    }
});

// ── (2) THE TEN resolve by their OWN declaration, to the SAME handler ────────
test("all ten migrated widgets DECLARE their activation", () => {
  for (const [type, id] of Object.entries(MIGRATED))
    assert.equal(pluginOf(type).activate, id, `${type}: declares activate "${pluginOf(type).activate}", want "${id}"`);
});

test("all ten RESOLVE to the same handler they had as an if-chain branch", () => {
  for (const [type, id] of Object.entries(MIGRATED))
    assert.equal(handlerFor("activate", pluginOf(type))?.id, id, `${type} resolves wrong`);
});

test("the CONTENT descriptors stay — they name the behaviour's content, not its trigger", () => {
  assert.equal(pluginOf("plaintext").inlineTextEdit.property, "text"); // WHICH string
  assert.equal(pluginOf("plaintext").inlineTextEdit.plain, true);      // in WHICH mode
  assert.equal(typeof pluginOf("cursor").floatingToolbar, "function"); // the palette's content
  for (const type of ["image", "video", "video_scrub", "pdf_page", "video_v5", "video_v5_scrub"])
    assert.equal(pluginOf(type).primaryAsset, "src", `${type}: primaryAsset must survive the migration`);
});

test("a widget that declares no activation still has none (a dblclick on a rect)", () => {
  assert.equal(handlerFor("activate", pluginOf("rect")), null);
  assert.equal(handlerFor("activate", pluginOf("circle")), null);
});

// ── (3) THE BRIDGE IS REALLY GONE ────────────────────────────────────────────
test("a content descriptor WITHOUT a declaration resolves to NULL (no claim fallback)", () => {
  // Each of these would have resolved through a legacy claim; now each is silent —
  // which is precisely why (1) has to be a test.
  assert.equal(handlerFor("activate", { type: "probe_asset", primaryAsset: "src" }), null);
  assert.equal(handlerFor("activate", { type: "probe_inline", inlineTextEdit: { property: "t" } }), null);
  assert.equal(handlerFor("activate", { type: "probe_palette", floatingToolbar: () => ({}) }), null);
  assert.equal(handlerFor("activate", { type: "probe_interior", interiorView: {} }), null);
  assert.equal(handlerFor("activate", { type: "latex" }), null); // the claim-by-TYPE is gone too
  assert.equal(handlerFor("activate", { type: "text" }), null);
});

test("migrationPlan REPORTS each of those, with the one-line edit that fixes it", () => {
  const rows = migrationPlan([
    { type: "probe_asset", primaryAsset: "src" },
    { type: "probe_interior", interiorView: {} },
    { type: "latex" },
  ]);
  // Rows come out in the order the plugins were handed in (the roster's order), so
  // the report reads like the file list a contributor has to go and edit.
  assert.deepEqual(rows.map((r) => [r.type, r.handlerId, r.edit]), [
    ["probe_asset", "asset_picker", 'activate: "asset_picker"'],
    ["probe_interior", "navigate_interior", 'activate: "navigate_interior"'],
    ["latex", "latex_edit", 'activate: "latex_edit"'],
  ]);
  for (const r of rows) assert.equal(r.phase, "activate");
});

// ── (4) A TYPO THROWS ────────────────────────────────────────────────────────
test("an unknown handler id throws LOUDLY, naming the field and the registered ids", () => {
  assert.throws(
    () => handlerFor("activate", { type: "typo", activate: "asset_pickr" }),
    /unknown "activate" handler "asset_pickr".*asset_picker.*`activate: "asset_pickr"`/s,
  );
  assert.throws(() => handlerFor("create", { type: "typo", placement: "bbx" }), /unknown "create" handler "bbx"/);
  assert.throws(() => handlerIds("tooling"), /unknown phase "tooling"/);
});

// ── (5) CREATION: the filmstrip's asset prompt is a DECLARED gesture ─────────
test("filmstrip declares the two-step creation gesture", () => {
  assert.equal(pluginOf("filmstrip").placement, "bbox_then_asset");
  assert.equal(handlerFor("create", pluginOf("filmstrip")).id, "bbox_then_asset");
  assert.equal(pluginOf("filmstrip").defaults.src, "", "the empty-source guard is only meaningful while the default is empty");
});

test("app.addItem names NO widget type — the branch moved to the create phase", () => {
  const appStore = readFileSync(resolve(here, "../web/app.svelte.js"), "utf8");
  const body = appStore.slice(appStore.indexOf("\n  addItem(defaults) {"));
  assert.equal(body.slice(0, body.indexOf("\n  }")).includes('type === "filmstrip"'), false,
    "addItem is reading a widget type again — a creation behaviour belongs in web/widget_handlers.js");
});

/**
 * Command (mutates and returns its own record). The minimal app surface a create
 * handler touches: addItem selects what it created, exactly as web/app.svelte.js
 * does, which is how `bbox_then_asset` learns the new item's id.
 */
function fakeApp() {
  return {
    added: [],
    selection: null,
    pendingVideoPickFor: null,
    addItem(state) {
      this.added.push(state);
      this.selection = `item${this.added.length}`;
    },
  };
}

const DRAG = { moved: true, rect: { x: 10, y: 20, w: 300, h: 40 }, startWorld: { x: 10, y: 20 } };
const CLICK = { moved: false, startWorld: { x: 500, y: 400 } };

test("bbox_then_asset places the box IDENTICALLY to bbox (one shared placement)", () => {
  // Not a text grep: the two handlers are run against the same gestures and their
  // addItem payloads compared. `bbox_then_asset` restating the placement-anchor
  // arithmetic instead of calling placeByBBox is exactly what this catches.
  const bbox = getHandler("create", "bbox");
  const thenAsset = getHandler("create", "bbox_then_asset");
  for (const plugin of [pluginOf("filmstrip"), pluginOf("cursor")]) { // cursor overrides placementAnchor
    for (const gesture of [DRAG, CLICK]) {
      const a = fakeApp(), b = fakeApp();
      bbox.place({ app: a, plugin, gesture });
      thenAsset.place({ app: b, plugin, gesture });
      assert.deepEqual(b.added, a.added, `${plugin.type}: placement differs (moved=${gesture.moved})`);
    }
  }
});

test("bbox_then_asset asks for the source of a FRESH widget, and only then", () => {
  const app = fakeApp();
  getHandler("create", "bbox_then_asset").place({ app, plugin: pluginOf("filmstrip"), gesture: DRAG });
  assert.equal(app.pendingVideoPickFor, app.selection, "a placed empty filmstrip must prompt for its video (manifest 14.3)");

  // A widget whose defaults already carry a source has nothing to ask for — the
  // removed addItem line's own `!state.src` guard.
  const sourced = fakeApp();
  const withSrc = { ...pluginOf("filmstrip"), defaults: { ...pluginOf("filmstrip").defaults, src: "clip.mp4" } };
  getHandler("create", "bbox_then_asset").place({ app: sourced, plugin: withSrc, gesture: DRAG });
  assert.equal(sourced.pendingVideoPickFor, null);

  // And the plain box placement never prompts, so declaring "bbox" is still inert.
  const plain = fakeApp();
  getHandler("create", "bbox").place({ app: plain, plugin: pluginOf("filmstrip"), gesture: DRAG });
  assert.equal(plain.pendingVideoPickFor, null);
});

test("every widget resolves SOME creation gesture (the phase has a default)", () => {
  for (const p of registered)
    assert.ok(handlerFor("create", p), `${p.type}: no creation handler resolved`);
});

// ── (6) THE MANDELBROT'S INTERIOR VIEW ───────────────────────────────────────
test("the mandelbrot declares explore mode + the interiorView contract", () => {
  assert.equal(mandelbrotPlugin.activate, "navigate_interior");
  assert.equal(handlerFor("activate", pluginOf("demo_mandelbrot")).id, "navigate_interior");
  assert.equal(typeof mandelbrotPlugin.interiorView.window, "function");
  assert.equal(typeof mandelbrotPlugin.interiorView.writes, "function");
  // The mode is registered, so the HintBar gets its inputs for free. canvasModes()
  // walks BOTH phases (a creation may take over the canvas too — the polygon's
  // click-click-click, the telescopic rig's two boxes), so the assertion is that
  // THIS mode is in the ACTIVATE half.
  //
  // IT USED TO BE `deepEqual([...activate mode ids], ["navigate_interior"])`, which
  // was a MIRROR of the registry's shape in a test whose subject is the Mandelbrot:
  // every new activate mode broke it here, in a file about a fractal, with a message
  // naming neither. Bento cell binding (web/bentoBind.js) is the second activate
  // mode and was the first to hit it. The registry's own coverage is the derived
  // kind — activations() feeds the HintBar, migrationPlan is asserted empty — so
  // this assertion is now about the ONE mode it names.
  assert.ok(canvasModes().some((m) => m.phase === "activate" && m.handlerId === "navigate_interior"));
  // INTERIOR EXPLORE declares no step sequence: a sustained wheel gesture is not a
  // sequence, and offering an empty one would put a blank chip on the bar. NOT a
  // rule about activate modes in general — a two-press activation (aim a bento cell,
  // then click the widget to bind) is a sequence and declares one, which is why the
  // step generator reads `steps` off whatever phase declares it.
  assert.deepEqual(canvasModes().find((m) => m.handlerId === "navigate_interior").steps, []);
});

test("interiorView.window: half-width 10^(-zoomExponent), half-height by box aspect", () => {
  assert.deepEqual(
    mandelbrotPlugin.interiorView.window({ centerX: 0, centerY: 0, zoomExponent: 0, w: 200, h: 100 }),
    { x: -1, y: -0.5, w: 2, h: 1 },
  );
  // The split centre is summed before the window is built: 0 + 50e-2 = 0.5.
  assert.deepEqual(
    mandelbrotPlugin.interiorView.window({ centerX: 0, centerFineX: 50, fineExponent: 2, centerY: 0, zoomExponent: 1, w: 100, h: 100 }),
    { x: 0.4, y: -0.1, w: 0.2, h: 0.2 },
  );
  // A deeper zoom is a narrower window — the property an animation tweens.
  assert.ok(mandelbrotPlugin.interiorView.window({ centerX: 0, centerY: 0, zoomExponent: 3, w: 100, h: 100 }).w
    < mandelbrotPlugin.interiorView.window({ centerX: 0, centerY: 0, zoomExponent: 2, w: 100, h: 100 }).w);
});

test("interiorView.writes: a new window becomes keyframable coarse-centre writes", () => {
  assert.deepEqual(
    mandelbrotPlugin.interiorView.writes(
      { centerX: 0, centerY: 0, zoomExponent: 0, w: 200, h: 100 },
      { x: 0.9, y: -0.05, w: 0.2, h: 0.1 },
    ),
    { zoomExponent: 1, centerX: 1, centerY: 0 },
  );
});

test("interiorView.writes: the centre delta goes to the LEAF THAT CAN HOLD IT", () => {
  // THE reason the centre is split at all: a drag must not flatten a typed 32-digit
  // coordinate to float64. What protects those digits is that only ONE leaf is
  // written — the one that can represent the delta — never both.
  const DEEP_FINE = 3.123456789012345; // 16 digits riding at 10^-16
  const s = {
    centerX: -0.7435669, centerY: 0.1314023, centerFineX: DEEP_FINE, centerFineY: 0,
    fineExponent: 16, zoomExponent: 2, w: 100, h: 100,
  };
  const win = mandelbrotPlugin.interiorView.window(s);

  // AN UNMOVED WINDOW stays in the leaf each axis is already in — which is also the
  // set equationBoundInteriorProps reads to decide whether to refuse the mode.
  const still = mandelbrotPlugin.interiorView.writes(s, win);
  assert.deepEqual(still, { zoomExponent: 2, centerFineX: DEEP_FINE, centerFineY: 0 });

  // A REAL PAN (0.01, ten thousand times the coarse leaf's own spacing) belongs to the
  // COARSE leaf: it is representable there, so storing it in the fine slot would only
  // scale it by 10^16 for nothing. The deep fine digits are left ALONE...
  const panned = mandelbrotPlugin.interiorView.writes(s, { ...win, x: win.x + 0.01 });
  assert.equal("centerFineX" in panned, false, "a 0.01 pan does not belong in a 10^-16 slot");
  assert.equal(panned.centerX, -0.7335669);
  // ...so the SUM the shader consumes is exactly the old centre plus the pan.
  const before = approxCentre(s.centerX, s.centerFineX, 16);
  const after = approxCentre(panned.centerX, s.centerFineX, 16);
  assert.ok(Math.abs((after - before) - 0.01) < 1e-15, `the pan landed at ${after - before}, not 0.01`);

  // AND A DELTA THE COARSE LEAF CANNOT HOLD goes to the fine slot — which is the
  // branch the split centre exists for, reached here by handing writes() a window the
  // float64 one could not have produced (see the writes() docstring: an interior PAN
  // is itself bounded at about 1e-16 because `window` is a float64 rect).
  const sub = mandelbrotPlugin.interiorView.writes(s, { ...win, x: win.x + 1e-20 });
  assert.equal("centerX" in sub, false, "a 1e-20 delta must not be rounded into the coarse leaf");
  assert.ok(Math.abs(sub.centerFineX - DEEP_FINE) < 1e-3, "the fine slot must carry the sub-ulp delta, not replace it");
});

test("interiorView: window/writes ROUND-TRIP (an untouched window writes the state back)", () => {
  for (const s of [
    { centerX: -0.7435669, centerY: 0.1314023, zoomExponent: 2.9416, w: 520, h: 390 },
    { centerX: -0.6, centerY: 0, zoomExponent: -0.2041, w: 400, h: 300 },
  ]) {
    const out = mandelbrotPlugin.interiorView.writes(s, mandelbrotPlugin.interiorView.window(s));
    assert.ok(Math.abs(out.centerX - s.centerX) < 1e-12, `centerX drifted: ${out.centerX} vs ${s.centerX}`);
    assert.ok(Math.abs(out.centerY - s.centerY) < 1e-12, `centerY drifted: ${out.centerY} vs ${s.centerY}`);
    assert.ok(Math.abs(out.zoomExponent - s.zoomExponent) < 1e-12, `zoomExponent drifted: ${out.zoomExponent} vs ${s.zoomExponent}`);
  }
});

test("interiorView.writes: the zoom floor is the Inspector row's own minimum", () => {
  const row = mandelbrotPlugin.inspector.find((r) => r.key === "zoomExponent");
  const out = mandelbrotPlugin.interiorView.writes(
    { centerX: 0, centerY: 0, zoomExponent: 0, w: 200, h: 100 },
    { x: -100, y: -50, w: 200, h: 100 }, // absurdly zoomed out
  );
  assert.equal(out.zoomExponent, row.min, `clamped to ${out.zoomExponent}, Inspector minimum is ${row.min}`);
});

test("EVERY write key is a real keyframable leaf of the widget's own state", () => {
  // interiorNav writes these through app.setPreview like an Inspector row edit, so a
  // key with no default would keyframe a property the widget does not have.
  for (const s of [
    { centerX: 0, centerY: 0, zoomExponent: 1, w: 100, h: 100 },
    { centerX: 0, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 16, zoomExponent: 20, w: 100, h: 100 },
  ]) {
    const win = mandelbrotPlugin.interiorView.window(s);
    for (const key of Object.keys(mandelbrotPlugin.interiorView.writes(s, win))) {
      assert.ok(key in mandelbrotPlugin.defaults, `writes() names "${key}", which is not a mandelbrot property`);
      assert.ok(mandelbrotPlugin.inspector.some((r) => r.key === key), `"${key}" has no Inspector row — it cannot be unbound by hand`);
    }
  }
});

console.log(`\n${passed} tests passed`);
