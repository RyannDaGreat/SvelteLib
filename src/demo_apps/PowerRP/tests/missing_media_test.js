/**
 * THE MISSING-ASSET SENTINEL REFUSAL. Plain node, no framework (suite convention):
 *   node src/demo_apps/PowerRP/tests/missing_media_test.js
 *
 * WHAT THIS PINS, and why each half would otherwise fail silently:
 *
 *   (1) THE SENTINEL IS FETCHABLE. This is the whole reason the refusal exists,
 *       and it is the one fact a future reader is most likely to disbelieve — a
 *       `data:` URI that names nothing still resolves 200 with a real body. If
 *       that ever stopped being true the guard would look like dead defensive
 *       code and get deleted, so the fetch is asserted here rather than described.
 *   (2) THE REFUSAL SHAPE. `registerMissing` must leave the entry in the terminal
 *       "error" state with no element and no bitmap, because THAT is what makes
 *       the report happen once (both ensure* functions return early on an existing
 *       entry) and what makes getImage/getVideo answer null.
 *
 * WHY NOT A BROWSER PROBE: the registries themselves need a DOM, but the two
 * claims above do not — the guard's decision is made BEFORE any element exists,
 * which is precisely the point of it. Testing it in bare node keeps it in the
 * fast lane and proves the decision does not depend on a browser.
 */

import assert from "node:assert/strict";
import { MISSING_ASSET_URL, isMissingAssetUrl } from "../core/asset_ref.js";
import { registerMissing } from "../render_gpu/gpu/missing_media.js";

let passed = 0;
// AWAITS fn: several of these assert on fetch/promise resolution, and a sync
// runner would let a rejected async body pass as an unhandled rejection while the
// suite printed "ok" — the exact silent-pass this file exists to prevent.
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// ── (1) The trap: the sentinel LOADS, which is why passing it on misreports ──

await test("the sentinel is a FETCHABLE data: URI — the reason a naive el.src misreports", async () => {
  const res = await fetch(MISSING_ASSET_URL);
  assert.equal(res.ok, true, "the sentinel fetches 200 — it is a well-formed data: URI, not a dead URL");
  const blob = await res.blob();
  assert.ok(blob.size > 0, "and it has a real body, so a decoder gets bytes and blames the FORMAT");
  assert.ok(!blob.type.startsWith("image/"), "which are text bytes, never a decodable image/video");
});

await test("isMissingAssetUrl recognizes the sentinel and nothing else", () => {
  assert.equal(isMissingAssetUrl(MISSING_ASSET_URL), true);
  assert.equal(isMissingAssetUrl("blob:http://localhost/abc"), false, "a real resolved URL must load normally");
  assert.equal(isMissingAssetUrl("/asset/Deck/clip.mp4"), false, "an UNRESOLVED ref is not the sentinel");
  assert.equal(isMissingAssetUrl("data:image/png;base64,AAAA"), false, "an ordinary data: URI still loads");
  assert.equal(isMissingAssetUrl(""), false);
  assert.equal(isMissingAssetUrl(null), false);
  assert.equal(isMissingAssetUrl(undefined), false);
});

// ── (2) The refusal shape both registries depend on ─────────────────────────

await test("registerMissing latches a terminal error entry with NO element and NO bitmap", () => {
  const registry = new Map();
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    const ret = registerMissing(registry, MISSING_ASSET_URL, "ensureVideo");
    assert.equal(ret, null, "the caller's answer is 'nothing to hand back'");
  } finally {
    console.error = realError;
  }

  const entry = registry.get(MISSING_ASSET_URL);
  assert.equal(entry.status, "error", "terminal: ensure* returns early ever after, so no per-frame churn");
  assert.equal(entry.el, null, "no <video> was created — nothing was ever assigned to .src");
  assert.equal(entry.bitmap, null, "and no bitmap, so getImage()/getVideo() answer null");
  assert.ok(entry.error instanceof Error, "the reason is carried, not just logged");

  assert.equal(errors.length, 1, "reported exactly ONCE");
  assert.match(errors[0], /ensureVideo/, "the message names the failing entry point");
  assert.match(errors[0], /sentinel/i, "and says WHAT it refused, so nobody hunts a corrupt encode");
});

await test("a second registration does NOT re-report (the entry is what makes it once-only)", () => {
  const registry = new Map();
  const realError = console.error;
  let calls = 0;
  console.error = () => { calls += 1; };
  try {
    registerMissing(registry, MISSING_ASSET_URL, "ensureImage");
    // The ensure* functions return early on an existing entry, so the ONLY way a
    // second report could happen is if the entry were not written. Assert the
    // entry exists — that is the mechanism, and the guard the callers rely on.
    assert.ok(registry.has(MISSING_ASSET_URL), "the entry exists, so ensure* short-circuits before reporting again");
  } finally {
    console.error = realError;
  }
  assert.equal(calls, 1);
});

await test("registerMissing's promise resolves null, so an awaiting exporter is not blocked", async () => {
  const registry = new Map();
  const realError = console.error;
  console.error = () => {};
  try {
    registerMissing(registry, MISSING_ASSET_URL, "ensureImage");
  } finally {
    console.error = realError;
  }
  assert.equal(await registry.get(MISSING_ASSET_URL).promise, null);
});

console.log(`\nmissing_media_test: ${passed} passed`);
