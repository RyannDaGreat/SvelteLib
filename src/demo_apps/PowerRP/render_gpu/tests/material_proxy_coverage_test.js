/**
 * FUTURE-PROOFING GUARD for the materialFill proxy stand-in.
 *
 * The ROOT bug the proxy fix addresses is a CLASS bug: proxy-cheapening used to be an
 * opt-in allowlist of op names, so a new heavy `materialFill` material silently ran
 * its full per-pixel SkSL on the CPU thumbnail surface (how the lens flare's ~1.3s
 * stall slipped in). The fix makes proxy-cheapening UNIVERSAL: EVERY foreground
 * material resolves a cheap Skia stand-in through materials.resolveProxyFill — its own
 * `proxyFill` if it declares one, else defaultProxyFill (a representative flat colour).
 *
 * This test locks that in: it asserts that EVERY registered FOREGROUND material (and a
 * synthetic FUTURE one with no proxyFill) resolves a VALID proxy spec — so a material
 * added tomorrow is covered the moment it is registered and can NEVER silently blow up
 * thumbnails again. Pure JS (no CanvasKit): resolveProxyFill returns a plain spec.
 *
 * Run: node render_gpu/tests/material_proxy_coverage_test.js
 */
import assert from "node:assert/strict";
import { materialIds, getMaterial, isBackdropMaterial, isSamplerMaterial, resolveProxyFill, defaultProxyFill, PROXY_FILL_KINDS } from "../skia/materials.js";

const REGION = { cx: 0, cy: 0, halfW: 100, halfH: 100 }; // a representative local-space region

/** Pure. Asserts `spec` is a well-formed proxy-fill spec (valid kind + the fields that kind needs). */
function assertValidSpec(spec, label) {
  assert.ok(spec && PROXY_FILL_KINDS.has(spec.kind), `${label}: kind must be one of ${[...PROXY_FILL_KINDS].join(", ")}, got ${JSON.stringify(spec)}`);
  if (spec.kind === "solid") {
    assert.ok(Array.isArray(spec.color) && spec.color.length === 4, `${label}: solid needs color [r,g,b,a]`);
  } else {
    assert.ok(Array.isArray(spec.stops) && spec.stops.length >= 2, `${label}: ${spec.kind} needs >= 2 stops`);
    for (const s of spec.stops) {
      assert.ok(Number.isFinite(s.offset) && s.offset >= 0 && s.offset <= 1, `${label}: stop offset in [0,1]`);
      assert.ok(Array.isArray(s.color) && s.color.length === 4, `${label}: stop color [r,g,b,a]`);
      for (const ch of s.color) assert.ok(Number.isFinite(ch), `${label}: finite colour channel`);
    }
    // Skia requires non-decreasing gradient offsets.
    for (let i = 1; i < spec.stops.length; i++)
      assert.ok(spec.stops[i].offset >= spec.stops[i - 1].offset, `${label}: gradient stop offsets must be non-decreasing`);
  }
}

const rows = [];
let foreground = 0, specific = 0, fallback = 0;
for (const id of materialIds()) {
  const m = getMaterial(id);
  if (isSamplerMaterial(m)) { rows.push([id, "sampler", "n/a (own op)"]); continue; }
  if (isBackdropMaterial(m)) { rows.push([id, "backdrop", "n/a (materialBackdrop → PROXY_BACKDROP_OPS)"]); continue; }
  foreground++;
  const hasOwn = typeof m.proxyFill === "function";
  const spec = resolveProxyFill(m, {}, REGION); // empty params ⇒ each proxyFill's own defaults
  assertValidSpec(spec, `foreground material "${id}"`);
  if (hasOwn) { specific++; rows.push([id, "foreground", `specific proxyFill → ${spec.kind}`]); }
  else { fallback++; rows.push([id, "foreground", `default (mean-colour solid)`]); }
}

// THE future-proofing assertion: a brand-new foreground material with NO proxyFill
// still resolves — via the default — so it can never slip through as a raw SkSL fill.
const future = { id: "__future_material__" }; // no proxyFill declared
const futureSpec = resolveProxyFill(future, { someColor: "#3366cc", knob: 0.5 }, REGION);
assertValidSpec(futureSpec, "synthetic future material");
assert.equal(futureSpec.kind, "solid", "a material with no proxyFill must fall back to the flat default");

// defaultProxyFill directly: mean of the param colours; neutral grey when none.
assert.deepEqual(defaultProxyFill({ a: "#000000", b: "#ffffff" }).color, [0.5, 0.5, 0.5, 1]);
assert.deepEqual(defaultProxyFill({ speed: 1 }).color, [0.5, 0.5, 0.5, 1]);

const pad = (s, n) => String(s).padEnd(n);
console.log("── materialFill proxy coverage ─────────────────────────────────────────");
for (const [id, kind, handling] of rows) console.log(`  ${pad(id, 20)} ${pad(kind, 12)} ${handling}`);
console.log(`\n  foreground materials: ${foreground}  (specific proxyFill: ${specific}, default fallback: ${fallback})`);
console.log("\nOK material_proxy_coverage — EVERY foreground materialFill resolves a valid cheap proxy (specific or default); a future material cannot slip through");
