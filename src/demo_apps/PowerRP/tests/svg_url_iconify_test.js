/**
 * SVG url-mode + Iconify widget — bare-node guards.
 * Run: node src/demo_apps/PowerRP/tests/svg_url_iconify_test.js
 *
 * WHAT IT PROVES:
 *   (1) svg_source_registry in BARE NODE reads `/asset/<Project>/<file>` off
 *       disk SYNCHRONOUSLY (the cli/render.js path — same emit pass renders),
 *       and a missing file latches "error" LOUDLY (never a silent blank);
 *   (2) the svg widget's url mode emits real flattened ops from a disk asset,
 *       draws the red errorAffordance for a failed url, and keeps isGhost in
 *       lockstep with emit's short-circuit (empty url = ghost; pending ≠ ghost);
 *   (3) iconifyIconUrl builds/refuses ids per its docblock, and the iconify
 *       widget in bare node (no fetch target) draws the ERROR affordance — the
 *       documented honest degradation — rather than nothing;
 *   (4) both widgets' defaults survive repairedDocument with ZERO reports
 *       (the missingDefaults gate every hand-authored doc runs through).
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { svgPlugin } from "../plugins/svg.js";
import { iconifyPlugin, iconifyIconUrl } from "../plugins/iconify.js";
import { svgSourceStatus, resetSvgSourceRegistry } from "../render_gpu/gpu/svg_source_registry.js";
import { repairedDocument, uuid } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";

const IDENTITY_WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };
const BOX = 100;

// An ephemeral project folder the registry's disk reader resolves to —
// created for this run, removed at the end (ordinary short-lived test dir).
const TEST_PROJECT = "__svg_url_test__";
const PROJECT_DIR = fileURLToPath(new URL(`../projects/${TEST_PROJECT}`, import.meta.url));
const ICON_SVG = '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#f00"/></svg>';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

mkdirSync(`${PROJECT_DIR}/assets`, { recursive: true });
writeFileSync(`${PROJECT_DIR}/assets/probe.svg`, ICON_SVG);

try {
  test("svg url mode: a /asset/ url renders from disk in the SAME emit pass (bare node)", () => {
    resetSvgSourceRegistry();
    const state = { ...svgPlugin.defaults, svgSource: "url", svgUrl: `/asset/${TEST_PROJECT}/probe.svg`, x: 0, y: 0, w: BOX, h: BOX };
    const ops = svgPlugin.emit(state, null, IDENTITY_WORLD);
    assert.ok(ops.length > 0, "ops emitted");
    assert.ok(ops.some((o) => o.op === "path"), "the flattened rect became a path op");
    assert.equal(svgSourceStatus(state.svgUrl), "ready");
  });

  test("svg url mode: a MISSING asset latches error and draws the red affordance", () => {
    resetSvgSourceRegistry();
    const url = `/asset/${TEST_PROJECT}/does-not-exist.svg`;
    const state = { ...svgPlugin.defaults, svgSource: "url", svgUrl: url, x: 0, y: 0, w: BOX, h: BOX };
    const ops = svgPlugin.emit(state, null, IDENTITY_WORLD);
    assert.equal(svgSourceStatus(url), "error");
    assert.ok(ops.some((o) => o.op === "text" && String(o.text).includes("failed to load")), "error affordance names the failure");
  });

  test("svg isGhost: empty url IS a ghost; a pending/authored url is NOT", () => {
    assert.equal(svgPlugin.isGhost({ svgSource: "url", svgUrl: "" }), true);
    assert.equal(svgPlugin.isGhost({ svgSource: "url", svgUrl: "/asset/P/a.svg" }), false);
    assert.equal(svgPlugin.isGhost({ svgSrc: "" }), true, "inline mode unchanged");
  });

  test("iconifyIconUrl: builds API urls, refuses malformed ids", () => {
    assert.equal(iconifyIconUrl("tabler:database"), "https://api.iconify.design/tabler/database.svg");
    assert.throws(() => iconifyIconUrl("no-colon"), /prefix:name/);
    assert.throws(() => iconifyIconUrl("Bad:Case"), /prefix:name/);
  });

  test("iconify in bare node: no fetch target → the LOUD error affordance, not a blank", () => {
    resetSvgSourceRegistry();
    const state = { ...iconifyPlugin.defaults, x: 0, y: 0, w: BOX, h: BOX };
    const ops = iconifyPlugin.emit(state, null, IDENTITY_WORLD);
    assert.ok(ops.some((o) => o.op === "text" && String(o.text).includes("failed to load icon")), "error affordance names the icon");
  });

  test("both widgets' defaults survive repairedDocument with ZERO reports", () => {
    const registry = createRegistry();
    registerAll(registry, createCommands());
    const doc = {
      meta: { name: "t", slideW: 1280, slideH: 720 },
      slides: [{
        id: uuid(), name: "Slide 1",
        transition: { seconds: 0.5, curve: "smooth", sound: null, type: "tween" },
        delta: { items: {
          [uuid()]: { ...svgPlugin.defaults },
          [uuid()]: { ...iconifyPlugin.defaults },
        } },
      }],
    };
    const { reports } = repairedDocument(doc, registry);
    // The camera auto-ensure is the ONE expected report on a camera-less doc;
    // anything else means a defaults leaf is missing.
    const unexpected = reports.filter((r) => !/camera/i.test(String(r)));
    assert.deepEqual(unexpected, [], `unexpected repairs: ${JSON.stringify(unexpected)}`);
  });
} finally {
  rmSync(PROJECT_DIR, { recursive: true, force: true });
}

console.log(`\n${passed} svg-url + iconify tests passed.`);
