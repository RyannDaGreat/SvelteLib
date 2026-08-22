/**
 * tests/html2image_autorender_test.js — the bare-node half of R7-43/R7-43a/R7-43b:
 * the STALENESS GRAMMAR and the SCHEDULER, proven without a browser.
 *
 * WHAT THIS SUITE CAN AND CANNOT ANSWER. It cannot render anything — the widget's
 * whole design is "the browser IS the renderer" — so the pixels are
 * tests/html2image_autorender_probe.js's business. What it CAN answer, and what no
 * probe answers well, is the logic that decides WHETHER and HOW OFTEN to render:
 * fingerprint totality, the loop-termination property, the debounce, and the
 * serialize-with-one-pending rule. Those are pure scheduling questions, and driving
 * them with a fake renderer makes them deterministic instead of timing-dependent.
 *
 * THE LOOP-TERMINATION TEST IS THE ONE THAT MATTERS MOST. An auto-render whose write
 * does not clear its own staleness renders forever and mints an asset file per
 * iteration. It is the worst failure this feature can have, it is invisible in a
 * screenshot, and it is one dropped leaf away at all times.
 *
 * Run: node src/demo_apps/PowerRP/tests/html2image_autorender_test.js
 */
import assert from "node:assert/strict";
import {
  CAPTURE_OF_KEY,
  NO_FINGERPRINT,
  fnv1aHex,
  isCaptureStale,
  sourceFingerprint,
  staleCaptureIds,
} from "../core/html2image_staleness.js";
import { Html2ImageAutoRender, RENDER_DEBOUNCE_MS } from "../web/html2imageAutoRender.js";
import { html2imagePlugin } from "../plugins/html2image.js";

const TYPE = html2imagePlugin.type;
const W = 1280, H = 720;
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok — ${name}`);
}
async function checkAsync(name, fn) {
  await fn();
  passed++;
  console.log(`  ok — ${name}`);
}

/** A widget state carrying a capture that MATCHES its source (i.e. fresh). */
function fresh(html, extra = {}) {
  const s = { type: TYPE, html, captureW: W, captureH: H, capture: "shot.png", ...extra };
  return { ...s, [CAPTURE_OF_KEY]: sourceFingerprint(s) };
}

console.log("html2image staleness — the fingerprint grammar");

check("a fingerprint is 8 lowercase hex characters", () => {
  const fp = sourceFingerprint({ html: "<p>x</p>", captureW: W, captureH: H });
  assert.match(fp, /^[0-9a-f]{8}$/);
});

check("the same source at the same size fingerprints identically", () => {
  const a = { html: "<div>same</div>", captureW: W, captureH: H };
  assert.equal(sourceFingerprint(a), sourceFingerprint({ ...a }));
});

check("editing the source changes the fingerprint", () => {
  const a = { html: "<p>before</p>", captureW: W, captureH: H };
  const b = { html: "<p>after</p>", captureW: W, captureH: H };
  assert.notEqual(sourceFingerprint(a), sourceFingerprint(b));
});

check("the RENDER DIMENSIONS are inputs — raising them must re-render", () => {
  const base = { html: "<p>x</p>", captureW: W, captureH: H };
  assert.notEqual(sourceFingerprint(base), sourceFingerprint({ ...base, captureW: 2560 }));
  assert.notEqual(sourceFingerprint(base), sourceFingerprint({ ...base, captureH: 1440 }));
});

check("the dimension separator prevents the 12|80 vs 1|280 collision", () => {
  // Concatenating dimensions without a separator makes these two identical.
  assert.notEqual(
    sourceFingerprint({ html: "", captureW: 12, captureH: 80 }),
    sourceFingerprint({ html: "", captureW: 1, captureH: 280 }),
  );
});

check("the widget's WORLD size is not an input — resizing must not re-render", () => {
  const base = { html: "<p>x</p>", captureW: W, captureH: H };
  assert.equal(
    sourceFingerprint({ ...base, w: 480, h: 270 }),
    sourceFingerprint({ ...base, w: 1200, h: 800 }),
  );
});

check("fnv1aHex is stable and pads to width", () => {
  assert.equal(fnv1aHex(""), "811c9dc5");
  assert.equal(fnv1aHex("abc").length, 8);
  assert.equal(fnv1aHex("a"), fnv1aHex("a"));
});

console.log("html2image staleness — the predicate is TOTAL");

check("a fresh widget is not stale", () => {
  assert.equal(isCaptureStale(fresh("<p>hi</p>")), false);
});

check("an inserted widget (source, no picture) is stale", () => {
  assert.equal(isCaptureStale({ type: TYPE, html: "<p>hi</p>", captureW: W, captureH: H, capture: "" }), true);
});

check("an edited widget is stale", () => {
  const w = fresh("<p>original</p>");
  assert.equal(isCaptureStale({ ...w, html: "<p>edited</p>" }), true);
});

check("A DECK THAT ARRIVES with a picture but NO provenance is stale (R7-43a: arrival re-renders)", () => {
  const w = fresh("<p>hi</p>");
  delete w[CAPTURE_OF_KEY];
  assert.equal(isCaptureStale(w), true);
  assert.equal(isCaptureStale({ ...w, [CAPTURE_OF_KEY]: NO_FINGERPRINT }), true);
});

check("an EMPTY source is never stale — there is nothing to render", () => {
  assert.equal(isCaptureStale({ type: TYPE, html: "", captureW: W, captureH: H, capture: "" }), false);
  assert.equal(isCaptureStale({ type: TYPE, html: "   \n ", captureW: W, captureH: H, capture: "" }), false);
});

check("staleCaptureIds returns only html2image items, in document order", () => {
  const state = { items: {
    a: { type: TYPE, html: "<p>a</p>", captureW: W, captureH: H, capture: "" },
    r: { type: "rect", html: "<p>not mine</p>" },
    b: fresh("<p>b</p>"),
    c: { type: TYPE, html: "<p>c</p>", captureW: W, captureH: H, capture: "" },
  } };
  assert.deepEqual(staleCaptureIds(state, TYPE), ["a", "c"]);
});

console.log("html2image auto-render — the scheduler");

/**
 * A minimal stub app: `state()` reads a mutable items map, and setPreview /
 * commitPreview write into it exactly as the real pair does (keyframing is not this
 * suite's subject — the write REACHING the state is).
 */
function stubApp(items) {
  let preview = null;
  return {
    items,
    state: () => ({ items }),
    setPreview(pairs) { preview = pairs; },
    commitPreview() {
      for (const [path, value] of preview ?? []) items[path[1]][path[2]] = value;
      preview = null;
    },
  };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const AFTER_DEBOUNCE = RENDER_DEBOUNCE_MS + 120;

await checkAsync("THE LOOP TERMINATES: a render's own write clears its staleness", async () => {
  const items = { h: { type: TYPE, html: "<p>hi</p>", captureW: W, captureH: H, capture: "" } };
  const app = stubApp(items);
  let calls = 0;
  const svc = new Html2ImageAutoRender(app, { render: async () => { calls++; return `shot${calls}.png`; } });

  svc.notify();
  await settle(AFTER_DEBOUNCE);
  assert.equal(calls, 1, "the stale widget rendered once");
  assert.equal(items.h.capture, "shot1.png");
  assert.equal(items.h[CAPTURE_OF_KEY], sourceFingerprint(items.h), "the fingerprint matches what was rendered");

  // The write woke the watcher. THIS is the loop: a second scan must find it fresh.
  svc.notify();
  await settle(AFTER_DEBOUNCE);
  assert.equal(calls, 1, "re-scanning after the render did NOT render again");
  assert.equal(isCaptureStale(items.h), false);
  svc.dispose();
});

await checkAsync("DEBOUNCE: a burst of edits produces exactly ONE render", async () => {
  const items = { h: { type: TYPE, html: "<p>v0</p>", captureW: W, captureH: H, capture: "" } };
  const app = stubApp(items);
  let calls = 0;
  const rendered = [];
  const svc = new Html2ImageAutoRender(app, { render: async (_a, req) => { calls++; rendered.push(req.html); return `shot${calls}.png`; } });

  // Five rapid edits, each with its own notify — the Monaco-modal / spinner-drag case.
  for (let i = 1; i <= 5; i++) {
    items.h.html = `<p>v${i}</p>`;
    svc.notify();
    await settle(30);
  }
  await settle(AFTER_DEBOUNCE);
  assert.equal(calls, 1, `a settling burst rendered ${calls} times, expected 1`);
  assert.equal(rendered[0], "<p>v5</p>", "and it rendered the LAST source, not the first");
  svc.dispose();
});

await checkAsync("SERIALIZE: an edit during a render queues exactly ONE more", async () => {
  const items = { h: { type: TYPE, html: "<p>slow</p>", captureW: W, captureH: H, capture: "" } };
  const app = stubApp(items);
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const svc = new Html2ImageAutoRender(app, {
    render: async (_a, req) => {
      calls++;
      if (calls === 1) await gate; // hold the first render open
      return `shot${calls}-${req.html}`;
    },
  });

  svc.notify();
  await settle(AFTER_DEBOUNCE);
  assert.equal(calls, 1, "the first render is in flight");
  assert.equal(svc.isRendering("h"), true);

  // THREE further edits while it is in flight. They must coalesce into ONE re-run.
  for (const v of ["a", "b", "c"]) {
    items.h.html = `<p>${v}</p>`;
    svc.notify();
    await settle(10);
  }
  assert.equal(calls, 1, "no overlapping render started");

  release();
  await settle(AFTER_DEBOUNCE * 2);
  assert.equal(calls, 2, `three edits during a render produced ${calls - 1} re-runs, expected exactly 1`);
  assert.equal(items.h.html, "<p>c</p>");
  assert.equal(isCaptureStale(items.h), false, "and the widget settled FRESH on the newest source");
  svc.dispose();
});

await checkAsync("A FAILURE IS LOUD, RECORDED, AND NOT RETRIED", async () => {
  const items = { h: { type: TYPE, html: '<script src="https://cdn.test/x.js"></script>', captureW: W, captureH: H, capture: "" } };
  const app = stubApp(items);
  let calls = 0;
  const svc = new Html2ImageAutoRender(app, {
    render: async () => { calls++; throw new Error("this source loads 1 resource(s) from another origin"); },
  });
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    svc.notify();
    await settle(AFTER_DEBOUNCE);
    // A failed render leaves the widget stale; re-scanning must NOT hammer it.
    svc.notify();
    await settle(AFTER_DEBOUNCE);
  } finally { console.error = realError; }

  assert.equal(calls, 1, `a failing source was rendered ${calls} times — a retry loop`);
  assert.equal(svc.lastError?.itemId, "h");
  assert.match(svc.lastError.message, /another origin/);
  assert.ok(errors.some((e) => /automatic render failed/.test(e)), "the failure reached the console");
  svc.dispose();
});

await checkAsync("A FIXED SOURCE RE-ARMS after a failure (the suppression is keyed by fingerprint)", async () => {
  const items = { h: { type: TYPE, html: '<script src="https://cdn.test/x.js"></script>', captureW: W, captureH: H, capture: "" } };
  const app = stubApp(items);
  let calls = 0;
  const svc = new Html2ImageAutoRender(app, {
    render: async (_a, req) => {
      calls++;
      if (/cdn\.test/.test(req.html)) throw new Error("foreign subresource");
      return "fixed.png";
    },
  });
  const realError = console.error;
  console.error = () => {};
  try {
    svc.notify();
    await settle(AFTER_DEBOUNCE);
    assert.equal(calls, 1, "the broken source was attempted once");

    // The author inlines the script. A DIFFERENT fingerprint, so the suppression
    // must not apply — this is the half that makes #failed correct and not merely quiet.
    items.h.html = "<script>drawChart()</script>";
    svc.notify();
    await settle(AFTER_DEBOUNCE);
  } finally { console.error = realError; }
  assert.equal(calls, 2, "fixing the source did not re-arm the render");
  assert.equal(items.h.capture, "fixed.png");
  assert.equal(isCaptureStale(items.h), false);
  svc.dispose();
});

await checkAsync("UNDO REUSES THE OLD PICTURE: a restored source+fingerprint renders nothing", async () => {
  const original = fresh("<p>original</p>");
  const items = { h: { ...original } };
  const app = stubApp(items);
  let calls = 0;
  const svc = new Html2ImageAutoRender(app, { render: async () => { calls++; return `shot${calls}.png`; } });

  // Edit → renders. (The commit writes capture + fingerprint together.)
  items.h.html = "<p>edited</p>";
  svc.notify();
  await settle(AFTER_DEBOUNCE);
  assert.equal(calls, 1);

  // UNDO restores html, capture and fingerprint AS ONE — they were one commit.
  items.h = { ...original };
  svc.notify();
  await settle(AFTER_DEBOUNCE);
  assert.equal(calls, 1, "undo re-rendered instead of reusing the previous picture");
  assert.equal(items.h.capture, "shot.png", "the ORIGINAL asset is what the widget shows");
  svc.dispose();
});

await checkAsync("an item deleted during the debounce window is not rendered", async () => {
  const items = { h: { type: TYPE, html: "<p>doomed</p>", captureW: W, captureH: H, capture: "" } };
  const app = stubApp(items);
  let calls = 0;
  const svc = new Html2ImageAutoRender(app, { render: async () => { calls++; return "x.png"; } });
  svc.notify();
  delete items.h;
  await settle(AFTER_DEBOUNCE);
  assert.equal(calls, 0);
  svc.dispose();
});

console.log("html2image copy — R7-43b: the word \"capture\" has left the user-facing surface");

/** Every user-readable string the widget presents: row labels, help, command titles.
 * IDENTIFIERS (keys, command ids, type names) and SEARCH ALIASES are excluded — the
 * ruling is about what the user READS, and a hidden alias is what keeps anyone who
 * learned the old word able to find the command. */
function userFacingStrings(plugin) {
  const out = [];
  for (const row of plugin.inspector ?? []) {
    if (row.label) out.push([`inspector row "${row.key}" label`, row.label]);
    if (row.help) out.push([`inspector row "${row.key}" help`, row.help]);
  }
  for (const cmd of plugin.commands ?? []) {
    if (cmd.title) out.push([`command "${cmd.id}" title`, cmd.title]);
    if (typeof cmd.requires === "string") out.push([`command "${cmd.id}" requires`, cmd.requires]);
  }
  if (plugin.codeEditor?.title) out.push(["codeEditor title", plugin.codeEditor.title]);
  if (plugin.title) out.push(["plugin title", plugin.title]);
  for (const preset of plugin.presets ?? []) {
    if (preset.name) out.push([`preset "${preset.name}" name`, preset.name]);
    if (preset.description) out.push([`preset "${preset.name}" description`, preset.description]);
  }
  return out;
}

check('no user-facing string contains "capture" (R7-43b: "wtf even is \'capture\'?")', () => {
  const offenders = userFacingStrings(html2imagePlugin)
    .filter(([, text]) => /captur/i.test(text))
    .map(([where, text]) => `    ${where}: ${JSON.stringify(text.slice(0, 120))}`);
  assert.equal(
    offenders.length, 0,
    `${offenders.length} user-facing string(s) still say "capture" — the user's ruling was that the word is implementation jargon and must leave every surface he reads:\n${offenders.join("\n")}`,
  );
});

check("the manual command is a RE-RENDER nudge, and the old words survive as hidden aliases", () => {
  const cmd = (html2imagePlugin.commands ?? []).find((c) => c.id === "capture-html");
  assert.ok(cmd, "the manual re-render command still exists (R7-43a: it survives as a nudge)");
  assert.match(cmd.title, /re-?render/i, `the command title is "${cmd.title}" — it must read as a re-render`);
  const aliases = (cmd.aliases ?? []).map((a) => a.toLowerCase());
  assert.ok(aliases.includes("capture"), "\"capture\" must survive as a hidden search alias so nobody's muscle memory breaks");
});

check("the render-size rows read as RENDER width/height", () => {
  const rows = Object.fromEntries((html2imagePlugin.inspector ?? []).filter((r) => r.key).map((r) => [r.key, r]));
  assert.equal(rows.captureW?.label, "Render width", "the KEY stays captureW (no churn); the LABEL is what the user reads");
  assert.equal(rows.captureH?.label, "Render height");
});

console.log(`\nhtml2image auto-render: ${passed} checks passed`);
