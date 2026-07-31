/**
 * THE NEW SHAPE HANDLES, through the modifier-write protocol.
 *
 * `handle_constraints_test.js` already proves the GENERAL laws every handle obeys
 * (idempotent constrain, fixed point, round trip). This suite proves the specific
 * claims this consolidation makes about the handles it ADDED — the ones a general
 * law cannot state:
 *
 *   ss_bracket   THREE handles that write THREE DIFFERENT keys. The user's
 *                complaint was that a bracket had one thickness knob and so one
 *                handle ("the one part could be skinnier than the other"); a test
 *                that only checked "some handle moves some number" would have
 *                passed on the broken version too. So: each handle writes its own
 *                key, and dragging one leaves the other two alone.
 *   ss_cloud     bumps (a DISCRETE count read off the rim) and lobeDepth.
 *   ss_heart     cleft, the single deliberate handle.
 *   ss_callout   the tail goes ANYWHERE — it declares no `constrain` at all, and
 *                that freedom is a PROPERTY, pinned here so a later "tidy-up"
 *                cannot quietly fence a speech bubble's tail into its own box.
 */

import assert from "node:assert";
import { FAMILIES } from "../plugins/shapeshifter.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

const family = (type) => {
  const f = FAMILIES.find((x) => x.type === type);
  assert.ok(f, `family ${type} is registered`);
  return f;
};
/** Query. A family's handles at a state, keyed by handle id. */
const handlesOf = (fam, state) => {
  const out = new Map();
  for (const h of fam.modifierPoints(state)) out.set(h.id, h);
  return out;
};
/** Near-pure. Drag `id` to a local point and return the partial state it writes,
 *  routed through `constrain` exactly as core/derive.js does when one is declared. */
function drag(fam, state, id, to) {
  const h = handlesOf(fam, state).get(id);
  assert.ok(h, `handle "${id}" exists on ${fam.type}`);
  const allowed = h.constrain ? h.constrain(state, to) : to;
  return h.apply(state, allowed);
}

const BOX = { w: 200, h: 300 };

test("ss_bracket: THREE handles, THREE distinct keys (the one-knob complaint)", () => {
  const fam = family("ss_bracket");
  const state = { ...fam.defaults, ...BOX };
  const ids = [...handlesOf(fam, state).keys()].sort();
  assert.deepEqual(ids, ["armDepth", "armLength", "thickness"],
    "a bracket's spine, arm depth and arm reach each get their own handle");
});

test("ss_bracket: each handle writes ONLY its own key — dragging one cannot move another", () => {
  const fam = family("ss_bracket");
  const state = { ...fam.defaults, ...BOX };
  for (const [id, to] of [
    ["thickness", { x: 0.6 * BOX.w, y: BOX.h / 2 }],
    ["armDepth", { x: 0.22 * BOX.w, y: 0.4 * BOX.h }],
    ["armLength", { x: 0.5 * BOX.w, y: 0.06 * BOX.h }],
  ]) {
    const written = drag(fam, state, id, to);
    assert.deepEqual(Object.keys(written), [id], `${id}: writes exactly its own key, got ${JSON.stringify(written)}`);
    assert.ok(Number.isFinite(written[id]), `${id}: writes a finite number`);
  }
});

test("ss_bracket: the three knobs are INDEPENDENT — a skinny spine under deep arms is reachable", () => {
  const fam = family("ss_bracket");
  const state = { ...fam.defaults, ...BOX };
  const thin = drag(fam, state, "thickness", { x: 0.05 * BOX.w, y: BOX.h / 2 }).thickness;
  const deep = drag(fam, state, "armDepth", { x: 0.22 * BOX.w, y: 0.44 * BOX.h }).armDepth;
  assert.ok(thin < 0.1, `spine drags thin (${thin})`);
  assert.ok(deep > 0.3, `arms drag deep (${deep})`);
  // The shape that combination describes must really draw: this is the geometry
  // the single-thickness bracket could not express at all.
  const subs = fam.outline({ ...state, thickness: thin, armDepth: deep });
  assert.equal(subs.length, 1, "one closed subpath");
  for (const [x, y] of subs[0]) assert.ok(Number.isFinite(x) && Number.isFinite(y), "finite vertex");
});

test("ss_cloud: the bumps handle writes a WHOLE COUNT, floored at 3", () => {
  const fam = family("ss_cloud");
  const state = { ...fam.defaults, ...BOX };
  const seen = new Set();
  // Sweep the rim; every reading must be an integer >= 3 (a cloud cannot have 5.4
  // puffs), and the handle must be able to reach more than one value.
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
    const to = { x: BOX.w / 2 + (BOX.w / 2) * Math.cos(a), y: BOX.h / 2 + (BOX.h / 2) * Math.sin(a) };
    const { bumps } = drag(fam, state, "bumps", to);
    assert.ok(Number.isInteger(bumps), `bumps is a whole number, got ${bumps}`);
    assert.ok(bumps >= 3, `bumps floors at 3, got ${bumps}`);
    seen.add(bumps);
  }
  assert.ok(seen.size > 1, `the bumps handle reaches several counts, saw ${[...seen].join(",")}`);
});

test("ss_cloud: the lobeDepth handle stays inside its declared 0..1 domain", () => {
  const fam = family("ss_cloud");
  const state = { ...fam.defaults, ...BOX };
  for (const to of [{ x: BOX.w / 2, y: -9999 }, { x: BOX.w / 2, y: 9999 }, { x: BOX.w / 2, y: BOX.h / 2 }]) {
    const { lobeDepth } = drag(fam, state, "lobeDepth", to);
    assert.ok(lobeDepth >= 0 && lobeDepth <= 1, `lobeDepth in [0,1], got ${lobeDepth}`);
  }
});

test("ss_heart: ONE handle, and it writes cleft inside its declared domain", () => {
  const fam = family("ss_heart");
  const state = { ...fam.defaults, ...BOX };
  const ids = [...handlesOf(fam, state).keys()];
  assert.deepEqual(ids, ["cleft"], "the heart declares exactly one, deliberate handle");
  for (const to of [{ x: BOX.w / 2, y: -9999 }, { x: BOX.w / 2, y: 9999 }]) {
    const { cleft } = drag(fam, state, "cleft", to);
    assert.ok(cleft >= 0 && cleft <= 0.9, `cleft in [0,0.9], got ${cleft}`);
  }
});

test("ss_callout: the tail handle declares NO constrain — it may point anywhere", () => {
  const fam = family("ss_callout");
  const state = { ...fam.defaults, ...BOX };
  const tail = handlesOf(fam, state).get("tail");
  assert.ok(tail, "the callout has a tail handle");
  assert.equal(tail.constrain, undefined,
    "a speech bubble may point outside its own box, so this handle declares no allowed-set projection");
  // Far outside the box in every direction, the write is the dragged point itself.
  for (const to of [{ x: -800, y: -600 }, { x: 900, y: 1200 }, { x: 0, y: 5000 }]) {
    const written = tail.apply(state, to);
    assert.deepEqual(written, { tailX: to.x, tailY: to.y },
      `the tail lands exactly where it was dragged (${JSON.stringify(to)})`);
  }
});

console.log(`\n${passed} shape-handle tests passed`);
