/**
 * LOCAL RENDER STORE — the pure half, in bare node.
 *
 * web/localRenderStore.js is the static-mode home of a render JOB RECORD and its
 * finished .mp4. Most of it is IndexedDB and belongs to the browser probe
 * (tests/static_render_probe.js, which does a real render end to end). What is
 * testable here is the part that DECIDES things, and every one of these decisions
 * has a way of being silently wrong that a browser probe would sail past:
 *
 *   - THE KEY GRAMMAR, because the draft key contains a slash and a tilde. If
 *     `renderingKey` and the prefix range ever disagreed about how a draft's key is
 *     spelled, a draft's renders would simply not be listed — silently, with an
 *     empty pane that looks like "no renders yet".
 *   - THE VIEW SHAPE, because it must DROP the blob (a list holding ten 1080p
 *     movies in memory) and must NOT invent an outputPath (a fake filesystem path
 *     the copy-path button would put on the user's clipboard).
 *   - THE SIZE ESTIMATE and THE WARNING, because they are the only thing standing
 *     between a user and a twenty-minute render that cannot be saved — and because
 *     the warning must never escalate into a refusal.
 *   - THE MODE-AWARE SETTINGS SANITIZER, because a "server" backend or an "upload"
 *     encoder persisted by an HTTP session and reopened on the static site is the
 *     one input that can arm a submit with nothing behind it.
 */

import assert from "node:assert";
import {
  renderingKey, renderingView, estimatedRenderBytes, quotaWarning,
  ESTIMATE_BITS_PER_PIXEL, QUOTA_WARN_FRACTION,
} from "../web/localRenderStore.js";
import { sanitizeSettings } from "../web/renderCenterSettings.js";
// From browserJobView, NOT renderBackend: the latter imports the fetch layer and so
// cannot load in bare node. That split is the reason this rule lives where it does.
import { usableEncoder } from "../web/browserJobView.js";
import { humanReadableFileSize } from "../web/fileSize.js";

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

// ── The key grammar ─────────────────────────────────────────────────────────

test("renderingKey uses the assetKey grammar", () => {
  assert.strictEqual(renderingKey("RobotSim", "r-abc"), "RobotSim/r-abc");
});

test("A DRAFT's key round-trips through the prefix range that lists it", () => {
  // The reserved draft key CONTAINS A SLASH of its own, which is the interesting
  // case: the store's grammar is "<projectKey>/<jobId>", so the draft's key has two.
  // A listing built on any other split (last slash, first slash, a regex) would find
  // nothing under it — silently, showing an empty pane that reads as "no renders
  // yet" rather than as a bug. The prefix `${key}/` is the ONE thing listing uses.
  const DRAFT = "~draft/current";
  const key = renderingKey(DRAFT, "r-abc");
  assert.strictEqual(key, "~draft/current/r-abc");
  assert.ok(key.startsWith(`${DRAFT}/`), "the draft's own prefix must match its key");
});

test("A project whose NAME prefixes another's does not steal its renderings", () => {
  // IndexedDB's prefix range is a plain string bound, so "Deck" and "Deck 2" are the
  // sharp case: without the separating slash in the prefix, listing "Deck" would
  // return "Deck 2"'s movies too — a user's renders appearing under someone else's
  // project, which is the worst way this keyspace can be wrong.
  const inner = renderingKey("Deck 2", "r-1");
  assert.ok(!inner.startsWith("Deck/"), `"Deck"'s prefix must not catch ${inner}`);
  assert.ok(inner.startsWith("Deck 2/"));
});

test("Two projects' renderings cannot collide", () => {
  assert.notStrictEqual(renderingKey("A", "r-1"), renderingKey("B", "r-1"));
});

// ── The view shape ──────────────────────────────────────────────────────────

const doneRecord = {
  id: "r-1", projectKey: "Deck", name: "Take 1", backend: "client", state: "done",
  framesDone: 12, framesTotal: 12, params: { width: 320, height: 240, fps: 6 },
  output: "Take 1.mp4", bytes: 40960, durationSeconds: 2, error: null, warning: null,
  seen: false, storage: "browser", createdAt: 1769800000000, startedAt: 1769800000000,
  finishedAt: 1769800002000, blob: { size: 40960 },
};

test("renderingView DROPS the blob — a list must not pin every movie in memory", () => {
  assert.ok(!("blob" in renderingView(doneRecord)), "the view must not carry the movie");
});

test("renderingView drops the internal projectKey but keeps everything the rows read", () => {
  const v = renderingView(doneRecord);
  assert.ok(!("projectKey" in v));
  for (const field of ["id", "name", "backend", "state", "framesDone", "framesTotal", "params", "output", "bytes", "seen", "createdAt"])
    assert.ok(field in v, `the view is missing ${field}, which a row reads`);
});

test("renderingView invents NO outputPath — a fake path would reach the clipboard", () => {
  // The modal's copy-path button writes job.outputPath verbatim. A plausible-looking
  // string ("browser storage / Take 1.mp4") would be pasted into a terminal and fail
  // there instead of here, so the field must be absent and the button hidden.
  assert.strictEqual(renderingView(doneRecord).outputPath, undefined);
});

test("renderingView marks a browser rendering with storage: browser", () => {
  // The modal branches on this to mint a blob: URL instead of asking the server.
  assert.strictEqual(renderingView(doneRecord).storage, "browser");
});

// ── The size estimate ───────────────────────────────────────────────────────

test("estimatedRenderBytes is width*height*fps*seconds*bpp/8", () => {
  assert.strictEqual(
    estimatedRenderBytes({ width: 1920, height: 1080, fps: 30, durationSeconds: 10 }),
    (1920 * 1080 * 30 * 10 * ESTIMATE_BITS_PER_PIXEL) / 8,
  );
});

test("A zero-length timeline estimates zero bytes, not NaN", () => {
  assert.strictEqual(estimatedRenderBytes({ width: 1920, height: 1080, fps: 30, durationSeconds: 0 }), 0);
});

test("The estimate is GENEROUS against the encoder's own measurement", () => {
  // web/mp4Encoder.js measured ~1434 bytes per 1080p frame on a real deck. The
  // constant is deliberately rounded up by about an order of magnitude, because an
  // over-estimate costs a dismissible warning while an under-estimate costs the
  // render. If someone ever "corrects" it downward to match the measurement, this
  // fails and says why.
  const measuredBytesPerFrame = 1434;
  const oneFrame = estimatedRenderBytes({ width: 1920, height: 1080, fps: 1, durationSeconds: 1 });
  assert.ok(
    oneFrame > measuredBytesPerFrame * 5,
    `the estimate (${oneFrame} B/frame) must stay well above the measured ${measuredBytesPerFrame} B/frame — see ESTIMATE_BITS_PER_PIXEL`,
  );
});

// ── The warning ─────────────────────────────────────────────────────────────

const budget = (usage, quota) => ({ usage, quota, supported: true });

test("A render that comfortably fits says NOTHING", () => {
  assert.strictEqual(quotaWarning(39e6, budget(100e6, 2e9)), null);
});

test("A render larger than the free space warns, names both sizes, and does not refuse", () => {
  const text = quotaWarning(1.5e9, budget(1e9, 2e9));
  assert.ok(text, "there must be a warning");
  assert.ok(text.includes(humanReadableFileSize(1.5e9)), "the warning must name the render's estimated size");
  assert.ok(text.includes(humanReadableFileSize(1e9)), "the warning must name the free space");
  // The whole ruling, asserted as text: it warns, it never forbids.
  assert.ok(!/cannot|refus|not allowed|blocked/i.test(text), `the warning must not read as a refusal: ${text}`);
});

test("Over half the free space is a CAUTION, below it is silence — the threshold is exact", () => {
  const free = 1e9;
  const b = budget(1e9, 2e9); // quota 2e9 − usage 1e9 = 1e9 free
  assert.strictEqual(quotaWarning(free * QUOTA_WARN_FRACTION * 0.99, b), null, "just under the threshold says nothing");
  assert.ok(quotaWarning(free * QUOTA_WARN_FRACTION * 1.01, b), "just over the threshold warns");
});

test("An unsupported Storage API says the check could not be MADE, never that it passed", () => {
  const text = quotaWarning(600e6, { usage: 0, quota: 0, supported: false });
  assert.ok(text, "silence here would imply the render fits");
  assert.ok(/cannot be checked/i.test(text), `it must say the check could not be made: ${text}`);
});

test("Every warning admits the estimate can be wrong in EITHER direction", () => {
  // A number presented without its error bar gets treated as a fact, and this one is
  // a guess over content whose real rate varies by more than 10x.
  for (const [estimate, b] of [[1.5e9, budget(1e9, 2e9)], [600e6, budget(1e9, 2e9)]]) {
    const text = quotaWarning(estimate, b);
    assert.ok(/either direction/i.test(text), `the caveat is missing from: ${text}`);
  }
});

test("A quota already exceeded (usage > quota) reports zero free rather than a negative", () => {
  const text = quotaWarning(1e6, { usage: 3e9, quota: 2e9, supported: true });
  assert.ok(text, "a full origin must warn");
  assert.ok(!text.includes("-"), `free space must clamp at zero, not go negative: ${text}`);
});

// ── The mode-aware settings sanitizer ───────────────────────────────────────

test("STATIC MODE rejects a 'server' backend persisted by an HTTP session", () => {
  // The exact cross-mode input: settings written while a backend was running, then
  // the static site opened in the same browser. Before the backends list was passed
  // in, this survived and armed a submit with no server behind it.
  const out = sanitizeSettings({ backend: "server" }, { backend: "browser" }, 5, ["wasm"], ["browser"]);
  assert.strictEqual(out.backend, "browser");
});

test("HTTP MODE still keeps a 'server' backend — the static rule must not leak", () => {
  const out = sanitizeSettings({ backend: "server" }, { backend: "server" }, 5, ["upload", "wasm"], ["server", "browser"]);
  assert.strictEqual(out.backend, "server");
});

test("An omitted backends argument behaves exactly as before (both are valid)", () => {
  // Callers that predate the mode split must not change behaviour.
  assert.strictEqual(sanitizeSettings({ backend: "server" }, { backend: "browser" }, 5, []).backend, "server");
  assert.strictEqual(sanitizeSettings({ backend: "cloud" }, { backend: "server" }, 5, []).backend, "server");
});

test("STATIC MODE rejects an 'upload' encoder — it is a transport, not an option", () => {
  const out = sanitizeSettings({ browserEncoder: "upload" }, { browserEncoder: "wasm" }, 5, ["wasm"], ["browser"]);
  assert.strictEqual(out.browserEncoder, "wasm");
});

test("usableEncoder substitutes only what this mode cannot do", () => {
  assert.strictEqual(usableEncoder("upload", [{ value: "wasm" }], "wasm"), "wasm", "an absent encoder is substituted");
  assert.strictEqual(usableEncoder("wasm", [{ value: "upload" }, { value: "wasm" }], "upload"), "wasm", "an available one is left alone");
});

console.log(failures === 0 ? "\nlocal_render_store_test: all passed" : `\nlocal_render_store_test: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
