/**
 * tests/html2image_fix_test.js — the auto-renderer against a REAL DOCUMENT.
 *
 * WHY THIS SUITE EXISTS BESIDE tests/html2image_autorender_test.js. That one drives
 * the SCHEDULER (debounce, serialize, failure suppression) with a stub app that is a
 * plain items map — deliberately, because those rules are not about slides. The two
 * defects this file pins are exactly the ones that shape cannot see, because they are
 * about WHICH SLIDE:
 *
 *   1. A widget whose source is keyframed on slide 2 never rendered. `notify()` read
 *      `app.state()`, which is the CURRENT slide's fold, and `set slideIndex` wakes no
 *      document watcher — so the boot scan saw slide 1, arriving at slide 2 re-asked
 *      nothing, and the deck presented and exported the placeholder card forever.
 *   2. Purging a widget while its render was in flight committed {capture, captureOf}
 *      for an id with no `type` — a keyframe the next load reports as
 *      `dropped item "…" — no type is ever set (orphaned keyframes)` on a deck the
 *      author never hand-edited, plus an orphaned asset file.
 *
 * So the app stub here holds a REAL document and commits through the REAL
 * `keyframed()`, and every assertion is about where the picture landed.
 *
 * Run: node src/demo_apps/PowerRP/tests/html2image_fix_test.js
 */
import assert from "node:assert/strict";
import { CAPTURE_OF_KEY, isCaptureStale, staleCaptureIds } from "../core/html2image_staleness.js";
import { foldState, newDocument, uuid, withItemPurged } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { evaluateState } from "../core/expressions.js";
import { Html2ImageAutoRender, RENDER_DEBOUNCE_MS, documentHasType } from "../web/html2imageAutoRender.js";
import { html2imagePlugin } from "../plugins/html2image.js";
import { cameraPlugin } from "../plugins/camera.js"; // newDocument() always contains THE camera

const TYPE = html2imagePlugin.type;
// Two plugins is the whole registry this suite needs: the camera every document is
// born with, and the widget under test. Registering the full pool would drag the
// browser-only plugins into a bare-node run for nothing.
const registry = createRegistry();
registry.register(cameraPlugin);
registry.register(html2imagePlugin);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const AFTER_DEBOUNCE = RENDER_DEBOUNCE_MS + 120;

let passed = 0;
async function checkAsync(name, fn) {
  await fn();
  passed++;
  console.log(`  ok — ${name}`);
}
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok — ${name}`);
}

/** A widget state carrying an UNCAPTURED source — stale by isCaptureStale's second case. */
function widget(html) {
  return { ...html2imagePlugin.defaults, type: TYPE, html, x: 0, y: 0, w: 480, h: 270 };
}

/** A document of `count` slides, slide 0 being newDocument()'s (it owns THE camera). */
function deck(count) {
  const doc = newDocument();
  const slides = [...doc.slides];
  while (slides.length < count) {
    slides.push({ ...doc.slides[0], id: uuid(), name: `Slide ${slides.length + 1}`, delta: {} });
  }
  return { ...doc, slides };
}

/**
 * The app store this suite drives: a REAL document, committed through the real
 * `keyframed` inside the service. `state()` is deliberately ABSENT — the service must
 * never fall back to a single-slide read when a document is present.
 *
 * IT MIRRORS `web/app.svelte.js`'s EVALUATION INPUTS EXACTLY, all four of them, with
 * the same method names. A stub that offers three of the four does not merely test
 * less — it makes the missing one UNTESTABLE, and that is how `varKindsForEval` (the
 * fifth argument every `evaluateState` call in the app passes, and the fifth key its
 * memo compares) went missing from the service with every check here still green.
 * `varKinds` is RAW `doc.meta.varKinds`, never `?? {}`, for the reason that method
 * states: the memo compares it by reference.
 */
function docApp(doc) {
  return {
    doc,
    registry,
    projectScript: () => doc.meta.script ?? "",
    contentSizes: () => null,
    varKindsForEval: () => doc.meta?.varKinds ?? null,
    commit(next) { this.doc = next; doc = next; },
  };
}

/** Query. The raw keyframe delta written for `id` on `slide`, or undefined. */
const deltaFor = (app, slide, id) => app.doc.slides[slide].delta?.items?.[id];

console.log("html2image auto-render — the scan is the WHOLE DOCUMENT");

await checkAsync("a widget whose source lives on a LATER slide renders, and lands THERE", async () => {
  const id = "w";
  const doc = deck(3);
  doc.slides[1].delta = { items: { [id]: widget("<p>slide two only</p>") } };
  const app = docApp(doc);
  let calls = 0;
  const svc = new Html2ImageAutoRender(app, { render: async () => `shot${++calls}.png` });

  svc.notify();
  await settle(AFTER_DEBOUNCE);

  assert.equal(calls, 1, `a widget on slide 2 rendered ${calls} times, expected 1`);
  assert.equal(deltaFor(app, 1, id).capture, "shot1.png", "the picture is keyframed on the slide its source lives on");
  assert.equal(deltaFor(app, 0, id), undefined, "and NOT on the slide the editor happened to be showing");
  assert.equal(isCaptureStale(foldState(app.doc, 1).items[id]), false, "the widget is fresh on its own slide");
  assert.equal(isCaptureStale(foldState(app.doc, 2).items[id]), false, "and on every slide that folds it forward");
  svc.dispose();
});

await checkAsync("THE EARLIEST STALE SLIDE WINS: one render and ONE keyframe, not one per slide", async () => {
  const id = "w";
  const doc = deck(4);
  doc.slides[0].delta = { items: { ...doc.slides[0].delta.items, [id]: widget("<p>from the front</p>") } };
  const app = docApp(doc);
  let calls = 0;
  const svc = new Html2ImageAutoRender(app, { render: async () => `shot${++calls}.png` });

  svc.notify();
  await settle(AFTER_DEBOUNCE);
  // The fold carries the widget onto all four slides, so a naive per-slide scan would
  // have scheduled four renders and minted four assets for one picture.
  assert.equal(calls, 1, `a widget stale on four folded slides rendered ${calls} times, expected 1`);
  assert.equal(deltaFor(app, 0, id).capture, "shot1.png");
  for (let i = 1; i < 4; i++) assert.equal(deltaFor(app, i, id), undefined, `slide ${i} got a keyframe it did not need`);

  svc.notify();
  await settle(AFTER_DEBOUNCE);
  assert.equal(calls, 1, "re-scanning the whole document did NOT render again — the loop still terminates");
  svc.dispose();
});

await checkAsync("a source that CHANGES on a later slide renders again, on that slide", async () => {
  const id = "w";
  const doc = deck(3);
  doc.slides[0].delta = { items: { ...doc.slides[0].delta.items, [id]: widget("<p>first</p>") } };
  doc.slides[2].delta = { items: { [id]: { html: "<p>second</p>" } } };
  const app = docApp(doc);
  let calls = 0;
  const rendered = [];
  const svc = new Html2ImageAutoRender(app, {
    render: async (_a, req) => { rendered.push(req.html); return `shot${++calls}.png`; },
  });

  // Two passes: the front boundary first, then the one the fold no longer covers.
  for (let i = 0; i < 2; i++) { svc.notify(); await settle(AFTER_DEBOUNCE); }

  assert.equal(calls, 2, `two distinct sources rendered ${calls} times, expected 2`);
  assert.deepEqual(rendered, ["<p>first</p>", "<p>second</p>"], "each render saw its OWN slide's source");
  assert.equal(deltaFor(app, 0, id).capture, "shot1.png");
  assert.equal(deltaFor(app, 2, id).capture, "shot2.png");
  assert.equal(deltaFor(app, 1, id), undefined, "the untouched middle slide stays untouched");
  for (let i = 0; i < 3; i++)
    assert.deepEqual(staleCaptureIds({ items: foldState(app.doc, i).items }, TYPE), [], `slide ${i} settled stale`);
  svc.dispose();
});

console.log("html2image auto-render — a purge during a render writes NOTHING");

await checkAsync("purging a widget mid-render discards the picture instead of minting a typeless zombie", async () => {
  const id = "w";
  const doc = deck(2);
  doc.slides[0].delta = { items: { ...doc.slides[0].delta.items, [id]: widget("<p>doomed</p>") } };
  const app = docApp(doc);
  let release;
  const gate = new Promise((r) => { release = r; });
  const svc = new Html2ImageAutoRender(app, { render: async () => { await gate; return "orphan.png"; } });

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    svc.notify();
    await settle(AFTER_DEBOUNCE);
    assert.equal(svc.isRendering(id), true, "the render is in flight");
    app.commit(withItemPurged(app.doc, id)); // the author purges it WHILE it renders
    release();
    await settle(AFTER_DEBOUNCE);
  } finally { console.warn = realWarn; }

  assert.equal(svc.renderCount, 0, "a render whose item vanished must not count as a completed render");
  for (let i = 0; i < app.doc.slides.length; i++)
    assert.equal(deltaFor(app, i, id), undefined,
      `slide ${i} carries a keyframe for a purged item — the typeless {capture, captureOf} zombie`);
  assert.ok(warnings.some((w) => /removed while its render was in flight/.test(w)),
    "the discarded picture must be REPORTED — it left an unreferenced asset behind");
  svc.dispose();
});

console.log("html2image auto-render — the cheap gate in front of the walk");

check("documentHasType finds a type declared on ANY slide, and nothing on a deck without it", () => {
  const doc = deck(3);
  assert.equal(documentHasType(doc, TYPE), false, "a fresh deck declares no html2image item");
  doc.slides[2].delta = { items: { w: widget("<p>late</p>") } };
  assert.equal(documentHasType(doc, TYPE), true, "declared on the LAST slide — the case the current-slide scan missed");
  assert.equal(documentHasType({ slides: [] }, TYPE), false);
});

console.log("html2image auto-render — the scan evaluates with THE APP'S OWN INPUTS");

await checkAsync("the scan is a MEMO HIT, not a memo EVICTION, on the slide the editor is showing", async () => {
  // THE FIFTH ARGUMENT IS THE WHOLE TEST. evaluateState memoizes per state object on
  // {registry, script, contentSizes, varKinds} compared BY REFERENCE, and
  // repairedDocument writes `meta.varKinds` into EVERY document (an empty {} when the
  // deck declares no kinds). A scan that omitted it passed `null`, so `{} === null`
  // failed: the scan missed the memo AND overwrote the editor's entry with its own
  // null-keyed one, making the editor's very next state() miss too. The cost is
  // double evaluation of the visible slide on every commit — the exact thing
  // #evaluationInputs's docblock promises not to do.
  const doc = deck(2);
  doc.meta = { ...doc.meta, varKinds: {} }; // what repairedDocument guarantees
  doc.slides[0].delta = { items: { ...doc.slides[0].delta.items, w: widget("<p>hi</p>") } };
  const app = docApp(doc);
  const evalAppShaped = () => evaluateState(
    foldState(app.doc, 0, 1), app.registry, app.projectScript(), app.contentSizes(), app.varKindsForEval(),
  );

  const before = evalAppShaped(); // the editor's pass
  const svc = new Html2ImageAutoRender(app, { render: async () => "shot.png" });
  svc.notify();                   // the scan, which must reuse it rather than replace it
  const after = evalAppShaped();  // the editor asking again
  svc.dispose();

  assert.equal(after, before, "the scan evicted the editor's evaluation — it is not passing the app's own inputs");
});

console.log(`\nhtml2image fix suite: ${passed} checks passed`);
