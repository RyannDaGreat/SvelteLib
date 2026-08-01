/**
 * SHATTER end-to-end browser probe — the `shatter` command on a real document,
 * measured in pixels and in anchor behaviour.
 *
 * NAMING NOTE, because this file proposed the other name: I argued for "Convert
 * to Widgets" from PowerPoint's "Convert to Shapes" plus the app's own noun. The
 * user overruled it back to his original word, SHATTER, and the command id and
 * every user-facing string now say so ("convert to widgets" survives only as a
 * palette alias, which is the right place for a synonym). This line is the last
 * piece of prose that still described the reverted name — recorded rather than
 * quietly deleted, since a revert that leaves its doctrine standing is the exact
 * defect the manifest's CONVENTIONS section names.
 * Run: node src/demo_apps/PowerRP/tests/shatter_probe.js [http://localhost:PORT]
 *
 * ── WHAT IT PROVES, AND WHY EACH HALF IS NEEDED ─────────────────────────────
 * Shatter has two claims and they pull against each other, so a probe that
 * checks only one of them certifies a useless feature:
 *
 *   FIDELITY   the picture must not change when you convert. Measured by
 *              rendering the same slide before and after and diffing the PNGs
 *              through tests/imageDistinctness.js.
 *   ANCHORING  the parts must be RELATED, not merely placed. Measured by moving
 *              one box afterwards and checking that its label moved with it and
 *              its arrow followed — which is the entire point of the request and
 *              is exactly what a "loose shapes at baked coordinates" shatter
 *              would fail.
 *
 * An image widget is always available as a fidelity floor, so a shatter can buy
 * fidelity with editability. That is why VECTOR RECOVERY is asserted too: it is
 * the number that stops "emit one big picture" from scoring perfectly.
 *
 * ── THE ROSTER COMES FROM THE REGISTRY ──────────────────────────────────────
 * Every widget declaring `shatter` is exercised, enumerated live from
 * `app.registry`. A hardcoded list would silently exempt the next widget someone
 * gives the capability to, which is the hand-maintained-mirror defect this
 * codebase keeps finding. Today that roster is one entry; the assertion is
 * written for N.
 *
 * ── THE NUMBERS ARE A LEDGER, NOT A WALL ────────────────────────────────────
 * User ruling, 2026-08-01: "it doesn't have to be pixel perfect, it just has to
 * be as close as we possibly get." So the gate asserts that fidelity and vector
 * recovery do not REGRESS below a recorded floor, and PRINTS the measured values
 * every run. A 100% bar would admit nothing; a floor plus a printed number lets a
 * widget ship at 92% today, improve later, and still turn red if it slips.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { launchBrowser } from "./puppeteerLaunch.js";
import { readPng, imageDistance } from "./imageDistinctness.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, "..", "web", "vite.config.js");
const SHOTS = path.join(HERE, "..", ".claude_vlm_checks");

/**
 * THE RECORDED FLOORS, per widget type. Measured, not chosen: each is the value
 * this probe printed when the capability landed, rounded DOWN to leave a little
 * headroom for antialiasing jitter between runs. Raising a floor after a real
 * improvement is the intended edit; lowering one needs a reason in the commit.
 *
 * `meanAbs` is the mean absolute per-channel difference over the whole canvas in
 * 0-255 code values, so 4 means "the average channel moved by 4/255". It is the
 * right statistic here rather than maxAbs: a shatter reproduces a diagram's ink
 * through a different set of widgets, so a handful of edge pixels WILL differ by
 * a lot while the picture as a whole is the same one, and maxAbs would report
 * that single pixel as total failure.
 */
const FLOORS = {
  // MEASURED, not chosen. Four runs of the flowchart case gave meanAbs 0.21,
  // 0.21, 0.23 and 0.23 over the clipped canvas — under a quarter of one code
  // value out of 255, on under 1% of pixels — and vector recovery 100% every
  // time. The floor is set an order of magnitude above the observed spread,
  // which is loose enough that antialiasing jitter cannot trip it and tight
  // enough that a real regression (a node falling back to raster, a label
  // reflowing, an edge losing its head) moves it by far more than 10x.
  mermaid: { maxMeanAbs: 2.5, minVectorRecovery: 1 },
};

/**
 * The minimum share of the frame the original widget must change relative to an
 * EMPTY canvas before a fidelity comparison against it means anything. The
 * diagram plus its Inspector rows move well over a tenth of this viewport; a
 * blank widget box moves almost nothing. This is the guard that makes the
 * fidelity assertion capable of failing.
 */
const MIN_INK_FRACTION = 0.02;

/** How far the probe drags a shattered box to test that its label follows. Big
 * enough that antialiasing cannot explain the label's motion, small enough to
 * stay on canvas. */
const DRAG_WORLD_UNITS = 120;

/** A flowchart with branches, an edge label, and two node shapes — the diagram
 * type mermaid's identity markup covers best, so a failure here is ours. */
const FLOWCHART = "flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -.->|No| D[Skip]";

/** The two families that are NOT the flowchart, measured for fidelity and for
 * producing at least one anchored connector. `sequence` exercises Mermaid's
 * SECOND renderer (participants and messages, keyed by `data-et`, the one family
 * that names an edge's two ends outright); `class` exercises a compartmented box
 * whose single node carries several stacked text runs, which is the case a
 * centring label equation would silently mis-place. */
const OTHER_DIAGRAMS = {
  sequence: "sequenceDiagram\n  participant U as User\n  participant S as Server\n  U->>S: Login\n  S-->>U: Token",
  class: "classDiagram\n  Animal <|-- Dog\n  Animal <|-- Cat\n  Animal : +int age\n  class Dog{\n    +String breed\n    +fetch()\n  }",
};

const DANGER = /uncaught|paintir|is not a function|cannot read|closest.*anchor/i;

async function spinServer() {
  const { createServer } = await import("vite");
  process.env.NO_OPEN = "1";
  const server = await createServer({ configFile: CONFIG, server: { port: 0, open: false, host: "localhost" } });
  await server.listen();
  return { server, url: server.resolvedUrls.local[0].replace(/\/$/, "") };
}

let passed = 0;
const fail = (msg) => { console.error(`  FAIL  ${msg}`); process.exitCode = 1; };
const ok = (msg) => { passed++; console.log(`  ok    ${msg}`); };

const { server, url } = process.argv[2]
  ? { server: null, url: process.argv[2] }
  : await spinServer();
const browser = await launchBrowser();
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => { if (DANGER.test(m.text())) pageErrors.push(`console: ${m.text()}`); });
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__powerrp_app, { timeout: 60000 });

fs.mkdirSync(SHOTS, { recursive: true });
/**
 * Command (writes a PNG). One frame of THE CANVAS ONLY, decoded.
 *
 * Clipped to the canvas element deliberately. A full-viewport shot includes the
 * Inspector, which changes from the mermaid widget's rows to the group's rows
 * across the very operation under test — so a whole-window diff would charge the
 * shatter for a panel repaint and report a fidelity loss that is not one. The
 * claim being measured is about the PICTURE.
 */
const canvasRect = await page.evaluate(() => {
  const el = document.querySelector("canvas");
  if (!el) throw new Error("no canvas element to clip to");
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
});
const shot = async (name) => {
  const buf = await page.screenshot({ encoding: "binary", clip: canvasRect });
  fs.writeFileSync(path.join(SHOTS, `shatter_${name}.png`), buf);
  return readPng(buf);
};

// ── The roster, live from the registry ──────────────────────────────────────
const roster = await page.evaluate(() =>
  window.__powerrp_app.registry.all().filter((p) => typeof p.shatter === "function").map((p) => p.type));
console.log(`\nshatter roster (live from the registry): ${JSON.stringify(roster)}`);
if (roster.length === 0) fail("no widget declares `shatter` — the capability has no consumers");
else ok(`${roster.length} widget type(s) declare the shatter capability`);
for (const type of roster)
  if (!FLOORS[type]) fail(`"${type}" declares shatter but has no recorded floor in this probe — add one with its measured value`);

// ── Mermaid: place, render, measure before/after ────────────────────────────
// An EMPTY-CANVAS baseline first. Without it the fidelity comparison cannot
// fail: the first draft screenshotted "before" while the diagram had not yet
// painted, so it diffed a blank box against the shattered diagram, measured
// meanAbs 1.80, and PASSED a floor of 12. A gate that compares two blank frames
// reports perfect fidelity for a shatter that draws nothing at all.
const baseline = await shot("0_baseline");

await page.evaluate((def) => {
  const app = window.__powerrp_app;
  // Inside the default 1280x720 camera and at a NON-ZERO origin. Non-zero is
  // load-bearing: a group's influence is current-composed-with-inverse-bind, so
  // a diagram authored at the origin makes a WRONG bind indistinguishable from a
  // right one, and every member would teleport by the group's position for any
  // real document while the test stayed green.
  app.addItem({ ...app.registry.get("mermaid").defaults, x: 260, y: 90, w: 420, h: 540, definition: def });
  app.runCommand("reset-view"); // Zoom to Fit Camera — the diagram must be ON SCREEN or the pixel diff compares two blank regions
}, FLOWCHART);

// The flatten is ASYNC, so the wait is against the app's own observable rather
// than a sleep: `shatterBlocker` asks the plugin to plan, and the plugin refuses
// until its vector geometry has landed. One condition, no polling of internals.
const ready = await page.waitForFunction(() => {
  const app = window.__powerrp_app;
  const id = app.selection;
  return id && app.shatterBlocker() === null;
}, { timeout: 60000 }).then(() => true).catch(() => false);
if (!ready) {
  fail(`the mermaid widget never became shatterable: ${await page.evaluate(() => window.__powerrp_app.shatterBlocker())}`);
} else {
  ok("a rendered mermaid widget reports itself shatterable (its vector geometry landed)");

  // Let the repaint land before capturing — `reset-view` changes the world
  // scale, and a frame captured in the same tick can still be the pre-paint one.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const before = await shot("1_before");
  const drawn = imageDistance(baseline, before);
  console.log(`  the diagram is ON SCREEN: meanAbs ${drawn.meanAbs.toFixed(2)} vs the empty canvas, ${(drawn.fraction * 100).toFixed(1)}% of pixels differ`);
  if (drawn.fraction > MIN_INK_FRACTION) ok(`the original diagram is actually drawn (${(drawn.fraction * 100).toFixed(1)}% of pixels differ from an empty canvas)`);
  else fail(`the original diagram did not paint (only ${(drawn.fraction * 100).toFixed(1)}% of pixels differ from an empty canvas) — any fidelity number measured against this frame would be meaningless`);

  const report = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const id = app.selection;
    app.shatterSelection();
    const st = app.state().items;
    // STORED state, not app.state(): app.state() is EVALUATED (evalInfo().state),
    // so every equation there has already collapsed to a number and "is this
    // child anchored?" would always answer no. The children were written into
    // THIS slide's delta as whole items, so the delta is where the equations are.
    const stored = app.doc.slides[app.slideIndex].delta.items ?? {};
    const members = [...(st[id].members ?? [])]; // copied out of the state proxy
    return {
      hostType: st[id].type,
      members,
      definitionSurvived: typeof st[id].definition === "string" && st[id].definition.length > 0,
      disclosure: app.shatterReport,
      childTypes: members.map((m) => st[m].type),
      childNames: members.map((m) => st[m].name),
      arrowChildren: members.filter((m) => st[m].type === "arrow").length,
      heads: members.filter((m) => st[m].type === "arrow").map((m) => `${st[m].headStart}->${st[m].headEnd}`),
      dashedArrows: members.filter((m) => st[m].type === "arrow" && st[m].dashed === true).length,
      midBoundLabels: members.filter((m) => st[m].type === "plaintext" && /_mid\./.test(JSON.stringify(stored[m] ?? {}))).length,
      equationChildren: members.filter((m) => JSON.stringify(stored[m] ?? {}).includes("= @")).length,
      errors: [...(app.evalInfo?.().errors?.keys?.() ?? [])].slice(0, 6),
    };
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const after = await shot("2_after");

  console.log(`  disclosure: ${report.disclosure}`);
  console.log(`  child types: ${JSON.stringify(report.childTypes)}`);
  console.log(`  child names: ${JSON.stringify(report.childNames.slice(0, 6))}…`);

  if (report.hostType === "group") ok("the widget BECAME a group (same itemId — every equation referencing it survives)");
  else fail(`the host is "${report.hostType}", not a group`);

  if (report.members.length > 0) ok(`the group has ${report.members.length} members`);
  else fail("the group has no members");

  if (report.definitionSurvived) ok("the Mermaid SOURCE survived on the group as a dormant key (retype RULE 3) — nothing is lost");
  else fail("the mermaid `definition` was destroyed by the conversion — that is a data-loss trap");

  if (report.childNames.every((n) => typeof n === "string" && n.includes("/")))
    ok("every child's name states its parentage");
  else fail(`some children are unnamed or unparented: ${JSON.stringify(report.childNames.filter((n) => !n || !n.includes("/")))}`);

  if (report.equationChildren > 0) ok(`${report.equationChildren} children are ANCHORED by equations, not placed at baked coordinates`);
  else fail("no child carries an equation — this is a loose-shapes shatter, which is the half that misses the point");

  // A FLOWCHART's edges all carry endpoint identity, so every one of them must
  // come back as a rim-bound arrow. Asserting the COUNT rather than "at least
  // one" is what catches a silent degradation to unanchored paths — which is
  // exactly what a bad authorIdOf produced, with no error anywhere.
  const FLOWCHART_EDGES = 3;
  if (report.arrowChildren === FLOWCHART_EDGES) ok(`all ${FLOWCHART_EDGES} flowchart edges came back as rim-bound arrows`);
  else fail(`${report.arrowChildren} of ${FLOWCHART_EDGES} flowchart edges became arrows — the rest silently degraded to unanchored paths`);

  console.log(`  heads: ${JSON.stringify(report.heads)}  dashed: ${report.dashedArrows}  mid-bound labels: ${report.midBoundLabels}`);
  // #231: mermaid's marker ids become real head SHAPES, not one filled triangle.
  if (report.heads.every((h) => h === "none->triangle")) ok("every flowchart edge carries a real head shape read from Mermaid's marker id");
  else fail(`unexpected head shapes: ${JSON.stringify(report.heads)}`);
  // #232: `-.->` becomes a real dash, not a solid line.
  if (report.dashedArrows === 1) ok("the `-.->` edge came back DASHED, not silently solidified");
  else fail(`${report.dashedArrows} dashed arrows, expected 1 (the diagram has one \`-.->\`)`);
  // #233: an edge label rides its connector's own arc-length midpoint.
  if (report.midBoundLabels >= 2) ok(`${report.midBoundLabels} edge labels are bound to their edge's \`mid\` anchor`);
  else fail(`only ${report.midBoundLabels} edge labels bound to \`mid\` — they are back to baked coordinates`);

  if (report.errors.length === 0) ok("no equation errors after the conversion");
  else fail(`equation errors after the conversion: ${JSON.stringify(report.errors)}`);

  // FIDELITY
  const d = imageDistance(before, after);
  const floor = FLOORS.mermaid;
  console.log(`  FIDELITY  meanAbs=${d.meanAbs.toFixed(2)} maxAbs=${d.maxAbs} fraction=${(d.fraction * 100).toFixed(1)}%  (floor meanAbs <= ${floor.maxMeanAbs})`);
  if (d.meanAbs <= floor.maxMeanAbs) ok(`the picture is preserved within the recorded floor (meanAbs ${d.meanAbs.toFixed(2)} <= ${floor.maxMeanAbs})`);
  else fail(`fidelity REGRESSED: meanAbs ${d.meanAbs.toFixed(2)} exceeds the recorded floor ${floor.maxMeanAbs}`);

  // VECTOR RECOVERY — parsed from the disclosure the command itself produced, so
  // the number the user reads and the number the gate checks cannot disagree.
  const pct = Number(/(\d+)% recovered as vector/.exec(report.disclosure ?? "")?.[1] ?? NaN);
  console.log(`  VECTOR RECOVERY  ${pct}%  (floor ${floor.minVectorRecovery * 100}%)`);
  if (pct / 100 >= floor.minVectorRecovery) ok(`vector recovery holds at ${pct}%`);
  else fail(`vector recovery REGRESSED to ${pct}% (floor ${floor.minVectorRecovery * 100}%) — something widened the raster fallback`);

  // ANCHORING — move a box and prove its label came with it.
  const moved = await page.evaluate((dx) => {
    const app = window.__powerrp_app;
    const st = app.state().items;
    const stored = app.doc.slides[app.slideIndex].delta.items ?? {};
    const groupId = app.selection;
    const members = [...(st[groupId].members ?? [])];
    // The first SVG child is a node box; the plaintext whose x equation names it
    // is its label. Found by reading the equation, not by geometry — the same
    // discipline the decomposition itself follows.
    const boxId = members.find((m) => st[m].type === "svg");
    if (!boxId) return { error: "no svg box child to drag" };
    // Read the STORED equation, not the evaluated number.
    const labelId = members.find((m) => st[m].type === "plaintext" && String(stored[m]?.x ?? "").includes(`@${boxId}`));
    if (!labelId) return { error: "no label bound to that box" };
    const arrowId = members.find((m) => st[m].type === "arrow" && JSON.stringify(stored[m]?.from ?? {}).includes(`@${boxId}`));
    const evaluated = () => {
      const nodes = app.nodes();
      const at = (id) => { const n = nodes.find((q) => q.itemId === id); return n ? { x: n.world.x, y: n.world.y } : null; };
      const a = app.state().items[arrowId];
      return { box: at(boxId), label: at(labelId), arrowFrom: arrowId ? { ...app.state().items[arrowId].from } : null };
    };
    const was = evaluated();
    app.commit(app.doc); // no-op guard: keep the undo log honest before the move
    const s0 = app.state().items[boxId];
    app.setPreview([[["items", boxId, "x"], (s0.x ?? 0) + dx]]);
    app.commitPreview();
    return { was, now: evaluated(), boxId, labelId, arrowId };
  }, DRAG_WORLD_UNITS);

  if (moved.error) {
    fail(`anchoring not measurable: ${moved.error}`);
  } else {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await shot("3_box_moved");
    const boxDx = moved.now.box.x - moved.was.box.x;
    const labelDx = moved.now.label.x - moved.was.label.x;
    console.log(`  ANCHORING  box moved ${boxDx.toFixed(1)}, its label moved ${labelDx.toFixed(1)}`);
    if (Math.abs(boxDx - DRAG_WORLD_UNITS) < 1) ok(`the box moved by the ${DRAG_WORLD_UNITS} units it was dragged`);
    else fail(`the box moved ${boxDx.toFixed(1)}, expected ${DRAG_WORLD_UNITS}`);
    if (Math.abs(labelDx - boxDx) < 1) ok("THE LABEL FOLLOWED ITS BOX — the anchor is real, not baked coordinates");
    else fail(`the label moved ${labelDx.toFixed(1)} while its box moved ${boxDx.toFixed(1)} — the anchor did not hold`);
    if (moved.arrowId) {
      const fromDx = moved.now.arrowFrom.x - moved.was.arrowFrom.x;
      console.log(`  ANCHORING  the arrow bound to that box re-solved its tail by ${fromDx.toFixed(1)}`);
      if (Math.abs(fromDx) > 1) ok("THE ARROW RE-ROUTED — its endpoint re-solved against the box's new rim");
      else fail("the arrow's endpoint did not move — it is not bound to the box's rim");
    } else {
      console.log("  ANCHORING  no arrow is bound to the dragged box; re-routing not exercised on this diagram");
    }
  }
}

// ── THE OTHER DIAGRAM FAMILIES ──────────────────────────────────────────────
// One diagram type is a toy. Mermaid has two renderers with materially different
// markup — the unified one (flowchart, class, state, ER) keys nodes by a composed
// `id`, while sequence keys participants and messages by `data-et` and is the ONLY
// family that names an edge's two ends outright. A shatter that works on a
// flowchart says nothing about either the second renderer or the compartmented
// class box, so both are measured here.
for (const [name, def] of Object.entries(OTHER_DIAGRAMS)) {
  const p2 = await browser.newPage();
  await p2.setViewport({ width: 1400, height: 900 });
  p2.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  await p2.goto(url, { waitUntil: "domcontentloaded" });
  await p2.waitForFunction(() => window.__powerrp_app, { timeout: 60000 });
  const clip = await p2.evaluate(() => {
    const r = document.querySelector("canvas").getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  await p2.evaluate((d) => {
    const a = window.__powerrp_app;
    a.addItem({ ...a.registry.get("mermaid").defaults, x: 260, y: 90, w: 420, h: 540, definition: d });
    a.runCommand("reset-view");
  }, def);
  const up = await p2.waitForFunction(() => window.__powerrp_app.shatterBlocker() === null, { timeout: 60000 }).then(() => true).catch(() => false);
  if (!up) { fail(`${name}: never became shatterable`); await p2.close(); continue; }
  await p2.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const b = readPng(await p2.screenshot({ encoding: "binary", clip }));
  const r2 = await p2.evaluate(() => {
    const a = window.__powerrp_app;
    const id = a.selection;
    a.shatterSelection();
    const st = a.state().items;
    const m = [...(st[id].members ?? [])];
    return { n: m.length, anchored: m.filter((x) => st[x].type === "arrow").length, errs: [...(a.evalInfo?.().errors?.keys?.() ?? [])].slice(0, 3) };
  });
  await p2.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const a2 = readPng(await p2.screenshot({ encoding: "binary", clip }));
  const d2 = imageDistance(b, a2);
  console.log(`  ${name}: ${r2.n} children, ${r2.anchored} rim-bound arrows, fidelity meanAbs=${d2.meanAbs.toFixed(2)}`);
  if (r2.n > 0) ok(`${name} decomposes into ${r2.n} widgets`); else fail(`${name} produced no widgets`);
  if (r2.anchored > 0) ok(`${name} produced ${r2.anchored} rim-bound arrows`); else fail(`${name} produced no anchored connector`);
  if (d2.meanAbs <= FLOORS.mermaid.maxMeanAbs) ok(`${name} holds fidelity (meanAbs ${d2.meanAbs.toFixed(2)})`);
  else fail(`${name} fidelity REGRESSED: meanAbs ${d2.meanAbs.toFixed(2)} exceeds ${FLOORS.mermaid.maxMeanAbs}`);
  if (r2.errs.length === 0) ok(`${name} produced no equation errors`); else fail(`${name} equation errors: ${JSON.stringify(r2.errs)}`);
  await p2.close();
}

if (pageErrors.length > 0) fail(`page errors: ${JSON.stringify(pageErrors.slice(0, 4))}`);
else ok("no page errors or dangerous console output");

await browser.close();
if (server) await server.close();
console.log(`\n${passed} passed${process.exitCode ? ", FAILURES ABOVE" : ""}`);
