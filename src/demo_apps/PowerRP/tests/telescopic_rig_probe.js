/**
 * Telescopic-magnifier rig probe — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/telescopic_rig_probe.js
 *
 * Builds the rig the SAME way the insertTelescopicMagnifier command does
 * (withNewItem source→lens→tangent, each = registry defaults + the pure
 * equation-override builders from plugins/tangent_lines.js), over a colorful
 * grid backdrop so the magnification is visible. Then it:
 *   (1) PROVES the `=` equations resolve — folds + evaluates every (slide,
 *       tween) and asserts evaluateState reports ZERO errors (no dangling
 *       @id refs) and that the lens/tangent slots became numbers, and
 *   (2) RENDERS t = 0 / 0.5 / 1 for BOTH circle and box shapeKinds to PNGs
 *       under .claude_vlm_checks/ via the CLI's renderDocToPng (the exact
 *       editor pipeline), for VLM inspection.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { newDocument, withNewItem, keyframed, foldState, serialize } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import {
  TELESCOPIC, telescopicSourceOverrides, telescopicLensOverrides, telescopicTangentOverrides,
} from "../plugins/tangent_lines.js";
import { renderDocToPng } from "../cli/render.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../.claude_vlm_checks");

const CELL = 40;          // backdrop grid cell (px) — fine enough that the lens zoom is obvious
const SLIDE_W = 1280, SLIDE_H = 720;
const PALETTE = ["#f7768e", "#e0af68", "#9ece6a", "#7dcfff", "#bb9af7", "#ff9e64", "#2ac3de", "#c0caf5"];

const registry = createRegistry();
registerAll(registry, createCommands());

/**
 * Command (pure over the doc value). Appends a colorful checker grid of rects
 * plus a bold origin marker to `doc` on slide 0 — the backdrop the lens
 * magnifies. Returns the new doc. The origin cluster (4 saturated dots at the
 * rig origin) proves the lens samples the ORIGIN, not its own pulled-out spot.
 */
function withBackdrop(doc) {
  let out = doc;
  let z = 1;
  for (let gy = 0; gy < Math.ceil(SLIDE_H / CELL); gy++)
    for (let gx = 0; gx < Math.ceil(SLIDE_W / CELL); gx++) {
      const color = PALETTE[(gx + gy) % PALETTE.length];
      const state = {
        ...registry.get("rect").defaults,
        x: gx * CELL, y: gy * CELL, w: CELL, h: CELL,
        fill: color, strokeWidth: 0, active: true, z: z++,
      };
      [out] = withNewItem(out, 0, state);
    }
  // Origin marker cluster: a 2×2 of tiny black/white dots centered on the origin,
  // a distinctive glyph that reads unmistakably enlarged inside the lens.
  const dot = 12;
  const spots = [[-dot, -dot, "#000000"], [dot, -dot, "#ffffff"], [-dot, dot, "#ffffff"], [dot, dot, "#000000"]];
  for (const [dx, dy, fill] of spots) {
    const state = {
      ...registry.get("circle").defaults,
      x: TELESCOPIC.ORIGIN_X + dx - dot / 2, y: TELESCOPIC.ORIGIN_Y + dy - dot / 2,
      w: dot, h: dot, fill, strokeWidth: 0, active: true, z: z++,
    };
    [out] = withNewItem(out, 0, state);
  }
  return out;
}

/**
 * Command (pure over the doc value). The rig-insertion the command performs,
 * replicated headlessly: source → lens → tangent, backward `@id` refs only.
 * Returns { doc, ids }.
 */
function withRig(doc, shapeKind) {
  const zs = Object.values(foldState(doc, 0, 1).items).map((it) => it.z ?? 0);
  const baseZ = (zs.length ? Math.max(...zs) : 0) + 1;
  const withDefaults = (ov, z) => ({ ...registry.get(ov.type).defaults, ...ov, active: true, z });
  let out = keyframed(doc, 0, ["vars", TELESCOPIC.TWEEN_VAR], 0);
  const sourceOv = telescopicSourceOverrides({ shapeKind, originX: TELESCOPIC.ORIGIN_X, originY: TELESCOPIC.ORIGIN_Y });
  let sourceId; [out, sourceId] = withNewItem(out, 0, withDefaults(sourceOv, baseZ + 2));
  const lensOv = telescopicLensOverrides({ sourceId, shapeKind });
  let lensId; [out, lensId] = withNewItem(out, 0, withDefaults(lensOv, baseZ));
  const tangentOv = telescopicTangentOverrides({ sourceId, lensId, shapeKind });
  let tangentId; [out, tangentId] = withNewItem(out, 0, withDefaults(tangentOv, baseZ + 1));
  return { doc: out, ids: { sourceId, lensId, tangentId } };
}

/** Command. Overwrites the shared tween var to `t` on slide 0 and serializes. */
function docAtTween(doc, t) {
  return serialize(keyframed(doc, 0, ["vars", TELESCOPIC.TWEEN_VAR], t));
}

/**
 * Query. Folds+evaluates the rig at tween `t` and asserts the equations
 * resolved: zero eval errors touching the rig ids, and the lens/tangent slots
 * are finite numbers (proves every `@id` ref found its target).
 */
function assertEquationsResolve(doc, ids, t) {
  const folded = foldState(keyframed(doc, 0, ["vars", TELESCOPIC.TWEEN_VAR], t), 0, 1);
  const { state, errors } = evaluateState(folded, registry);
  const rigErrors = [...errors.keys()].filter((k) => Object.values(ids).some((id) => k.includes(id)) || k === `vars.${TELESCOPIC.TWEEN_VAR}`);
  assert.equal(rigErrors.length, 0, `t=${t}: rig eval errors: ${rigErrors.map((k) => `${k}: ${errors.get(k)}`).join("; ")}`);
  const lens = state.items[ids.lensId];
  const tan = state.items[ids.tangentId];
  for (const [label, v] of [["lens.x", lens.x], ["lens.y", lens.y], ["lens.w", lens.w], ["lens.magnificationX", lens.magnificationX], ["lens.magnificationY", lens.magnificationY], ["tan.a.x", tan.a.x], ["tan.b.x", tan.b.x], ["tan.b.halfW", tan.b.halfW]])
    assert.ok(Number.isFinite(v), `t=${t}: ${label} did not resolve to a number (got ${JSON.stringify(v)})`);
  return { lens, tan };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const tweens = [0, 0.5, 1];
  for (const shapeKind of ["circle", "box"]) {
    const base = withBackdrop(newDocument()); // default camera is 1280×720 = SLIDE_W×SLIDE_H
    const { doc, ids } = withRig(base, shapeKind);
    console.log(`\n[${shapeKind}] ids: source=${ids.sourceId} lens=${ids.lensId} tangent=${ids.tangentId}`);
    for (const t of tweens) {
      const { lens } = assertEquationsResolve(doc, ids, t);
      const png = await renderDocToPng(docAtTween(doc, t), { slide: 0, alpha: 1, width: SLIDE_W, height: SLIDE_H });
      const outPath = resolve(OUT_DIR, `telescopic_${shapeKind}_t${String(t).replace(".", "_")}.png`);
      await writeFile(outPath, Buffer.from(png));
      console.log(`  ok  t=${t}: eqs resolve (lens: x=${lens.x.toFixed(1)} y=${lens.y.toFixed(1)} w=${lens.w.toFixed(1)} magX=${lens.magnificationX.toFixed(2)} magY=${lens.magnificationY.toFixed(2)}) -> ${outPath.split("/").slice(-2).join("/")}`);
    }
  }
  console.log("\nAll telescopic rig equations resolved; 6 PNGs written for VLM inspection.");
}

await main();
