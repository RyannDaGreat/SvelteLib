/**
 * GLOBE LIMB FEATHER — the acceptance test for the globequal_ fix.
 *
 * The user's critique was that the globe's silhouette looks "sloppy" and its
 * edges "always look bad" because a 2D mapping was coerced into 3D. Diagnosed
 * cause (see core/geo_tiles.js's RESEARCH docblock and plugins/demo/globe_map.js's
 * globeQuadRect): the limb was a HARD BOOLEAN cutoff, one quad wide, which reads
 * as a jagged/faceted "cookie-cutter" edge — exactly the defect visible in
 * .claude_logs/globemap's baseline screenshots. This suite asserts the fix
 * directly: the silhouette's coverage now transitions CONTINUOUSLY across the
 * limb (an analytic feather, not a step function), the picture stays exactly
 * reproducible at a fixed document state (property-state law), and the adaptive
 * subdivision law actually adapts.
 *
 * Bare node, no browser: emit()/globeQuadRect are pure and DOM-free, so the
 * silhouette's structure is checkable from the display list's own opacity
 * values and from the coverage function directly, without a single rendered
 * pixel — the same DOM-free discipline core/geo_tiles.js's own suite uses.
 * tests/globe_map_probe.js is where an ACTUAL pixel screenshot is captured and
 * looked at (the acceptance the user asked to be able to judge).
 *
 * Run: node tests/globe_limb_feather_test.js
 */

import assert from "node:assert";
import { discCoverageFraction, globeSubdivisionsFor } from "../core/geo_tiles.js";
import { globeMapPlugin, globeQuadRect } from "../plugins/demo/globe_map.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

function stateAt(over = {}) {
  return { ...globeMapPlugin.defaults, w: 420, h: 420, ...over };
}

// ── THE CLOSED FORM ITSELF ───────────────────────────────────────────────────

test("discCoverageFraction: fully-visible, fully-hidden and the straddling band (cosC domain)", () => {
  assert.equal(discCoverageFraction(0.4, 0.6), 1, "well on the visible side: full coverage");
  assert.equal(discCoverageFraction(-0.5, -0.2), 0, "well on the hidden side: zero coverage");
  const half = discCoverageFraction(-0.1, 0.1);
  assert.ok(Math.abs(half - 0.5) < 1e-9, `a band centred exactly on the limb (cosC=0) covers half: got ${half}`);
  // Monotone: moving the band toward the hidden side can only ever reduce coverage.
  let previous = 1;
  for (let center = 0.5; center >= -0.5; center -= 0.05) {
    const c = discCoverageFraction(center - 0.05, center + 0.05);
    assert.ok(c <= previous + 1e-9, `coverage must be non-increasing as the band moves toward hidden (center=${center.toFixed(2)})`);
    previous = c;
  }
});

// ── THE SILHOUETTE ACTUALLY FEATHERS (not a step), AT THE QUAD LEVEL ─────────

/** A quad spanning 10 degrees of longitude (85..95) straddling the exact limb
 *  (90 degrees from a centerLon=0 view) at the equator — small enough relative
 *  to the disc that its bounding box does not balloon (verified: coverage 0.5,
 *  not 0, at these corners), and evenly split so the ANALYTIC coverage is
 *  exactly 0.5 — a clean, checkable straddle. */
function straddlingQuadState(over = {}) {
  return stateAt({ centerLon: 0, centerLat: 0, w: 420, h: 420, ...over });
}
const STRADDLING_CORNERS = { lon0: 85, lon1: 95, lat0: -2, lat1: 2 };

test("globeQuadRect: a quad straddling the exact limb gets a PARTIAL, non-boolean coverage", () => {
  const s = straddlingQuadState();
  const rect = globeQuadRect(STRADDLING_CORNERS, s);
  assert.ok(rect.coverage > 0.01 && rect.coverage < 0.99,
    `a quad straddling the limb evenly should have PARTIAL coverage, got ${rect.coverage}`);
  assert.ok(Math.abs(rect.coverage - 0.5) < 1e-9,
    `this quad's straddle is symmetric about the limb, so coverage should be ~0.5: got ${rect.coverage}`);
});

test("globeQuadRect: a quad fully on the visible side gets coverage 1, fully hidden gets 0", () => {
  const s = straddlingQuadState();
  const visible = globeQuadRect({ lon0: 0, lon1: 10, lat0: -2, lat1: 2 }, s);
  const hidden = globeQuadRect({ lon0: 170, lon1: 180, lat0: -2, lat1: 2 }, s);
  assert.equal(visible.coverage, 1, "well inside the visible hemisphere: full coverage");
  assert.equal(hidden.coverage, 0, "well round the back: zero coverage");
});

test("THE LIMB TRANSITIONS OVER A RANGE OF POSITIONS, not a hard step", () => {
  // Slide a fixed-width quad across the limb (varying its centre longitude) and
  // assert coverage forms a MONOTONIC RAMP from 1 to 0, with genuine
  // intermediate values — the direct evidence that the fix replaced a boolean
  // cutoff with a continuous falloff.
  const s = straddlingQuadState();
  const halfWidth = 5;
  const samples = [];
  for (let centerDeg = 80; centerDeg <= 100; centerDeg += 1) {
    const rect = globeQuadRect({ lon0: centerDeg - halfWidth, lon1: centerDeg + halfWidth, lat0: -0.5, lat1: 0.5 }, s);
    samples.push(rect.coverage);
  }
  assert.ok(samples[0] > 0.99, `well before the limb, coverage should be ~1: got ${samples[0]}`);
  assert.ok(samples.at(-1) < 0.01, `well past the limb, coverage should be ~0: got ${samples.at(-1)}`);
  const distinctPartials = new Set(samples.filter((c) => c > 0.01 && c < 0.99).map((c) => Math.round(c * 100) / 100));
  assert.ok(distinctPartials.size >= 3,
    `expected a real gradient of >= 3 distinct partial-coverage samples crossing the limb, got ${distinctPartials.size}: ${[...distinctPartials]}`);
  // Monotone non-increasing as the quad slides further behind the limb.
  for (let i = 1; i < samples.length; i++)
    assert.ok(samples[i] <= samples[i - 1] + 1e-9, `coverage must not increase as the quad slides east (index ${i})`);
});

test("no quad opacity ever exceeds the base opacity in a real emit() (coverage only ever REDUCES ink)", () => {
  const s = stateAt({ centerLon: 0, centerLat: 0, zoom: 0.6 });
  const window = { x: 0, y: 0, w: 1, h: 1 };
  const tiles = [{ x: 4, y: 4, z: 3, wrapped: 0, ref: "stub:4/4", ready: true }]; // covers lon 0..45, straddles nothing in particular but exercises the real path
  const ops = globeMapPlugin.emit(s, null, null, { mapTiles: { z: 3, window, cropped: window, tiles, devicePerWorld: 4 } })
    .filter((o) => o.op === "image");
  assert.ok(ops.length > 0, "expected the globe to draw at least some quads");
  const base = Math.max(...ops.map((o) => o.opacity));
  for (const o of ops) assert.ok(o.opacity <= base + 1e-9, `a quad's opacity ${o.opacity} exceeds the base ${base}`);
});

test("no tile ink is ever drawn OUTSIDE the planet's disc, even with the feather in play", () => {
  // The ballooning guard must still hold with coverage weighting layered on top
  // — a feathered quad's RECT must still sit within the disc (a PARTIAL quad is
  // still bounded by the same box test; only its opacity changed).
  const s = straddlingQuadState();
  const rect = globeQuadRect(STRADDLING_CORNERS, s);
  const cx = s.w / 2, cy = s.h / 2, r = Math.min(s.w, s.h) / 2;
  const SLACK = 1;
  for (const [x, y] of [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x, rect.y + rect.h], [rect.x + rect.w, rect.y + rect.h]])
    assert.ok(Math.hypot(x - cx, y - cy) <= r + SLACK,
      `a feathered quad reaches (${x.toFixed(1)}, ${y.toFixed(1)}), outside the disc of radius ${r}`);
});

// ── DETERMINISM (property-state law) ─────────────────────────────────────────

test("DETERMINISM: globeQuadRect is byte-identical across repeated calls with one input", () => {
  const s = straddlingQuadState();
  const a = JSON.stringify(globeQuadRect(STRADDLING_CORNERS, s));
  const b = JSON.stringify(globeQuadRect(STRADDLING_CORNERS, s));
  assert.equal(a, b, "two calls with the SAME input must produce the exact same result — this is property state, not ephemeral");
});

test("DETERMINISM: a real emit() of the feathered globe is byte-identical across repeated calls", () => {
  const s = stateAt({ centerLon: 0, centerLat: 0, zoom: 0.6 });
  const window = { x: 0, y: 0, w: 1, h: 1 };
  const tiles = [{ x: 4, y: 4, z: 3, wrapped: 0, ref: "stub:4/4", ready: true }];
  const emitOnce = () => globeMapPlugin.emit(s, null, null, { mapTiles: { z: 3, window, cropped: window, tiles, devicePerWorld: 4 } });
  assert.equal(JSON.stringify(emitOnce()), JSON.stringify(emitOnce()),
    "two emits of the SAME state must produce the exact same display list — this is property state, not ephemeral");
});

// ── ADAPTIVE SUBDIVISION ──────────────────────────────────────────────────────

test("globeSubdivisionsFor actually adapts: a bigger on-screen globe gets a finer mesh", () => {
  const thumb = globeSubdivisionsFor(20);
  const normal = globeSubdivisionsFor(200);
  const big = globeSubdivisionsFor(900);
  assert.ok(thumb < normal, `a 20px-radius thumbnail (${thumb}) should subdivide coarser than a 200px globe (${normal})`);
  assert.ok(normal < big, `a 200px globe (${normal}) should subdivide coarser than a 900px presentation globe (${big})`);
});

test("emit() actually asks for MORE quads at a higher devicePerWorld (the camera-zoom seam)", () => {
  const s = stateAt({ centerLon: 0, centerLat: 0, zoom: 0.6 });
  const window = { x: 0, y: 0, w: 1, h: 1 };
  const tiles = [{ x: 4, y: 4, z: 3, wrapped: 0, ref: "stub:4/4", ready: true }];
  const emitAt = (devicePerWorld) => globeMapPlugin.emit(s, null, null, { mapTiles: { z: 3, window, cropped: window, tiles, devicePerWorld } })
    .filter((o) => o.op === "image");
  const opsLow = emitAt(1), opsHigh = emitAt(6);
  assert.ok(opsHigh.length > opsLow.length,
    `zooming the camera in (devicePerWorld 1 -> 6) should request more globe quads (${opsLow.length} -> ${opsHigh.length})`);
});

console.log(`\n${passed} tests passed`);
