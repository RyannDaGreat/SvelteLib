/**
 * SAVE / SAVE-AS PROBE — the two save gestures and the unsaved-work guard, end to
 * end, in a real browser.
 *
 * THE RULING UNDER TEST (user, verbatim in intent): "When we are renaming the
 * Untitled project, that should be the same as saving a new project. Untitled is
 * a special project — I shouldn't be allowed to just save it; it needs to
 * Save-As-New, just like every other editor. There should be a quick-save button.
 * Make the distinction between Save and Save-As for every modality, including
 * server and browser side." And, for the guard: "perhaps it should ask me — would
 * you like to save this current presentation before opening a new one? Same thing
 * if I drag a zip into it."
 *
 * WHAT USED TO HAPPEN: a brand-new document was silently treated as a SAVED
 * project called "Untitled". Save wrote a library entry named "Untitled" with no
 * ceremony and no collision check; Rename tried to MOVE a folder that had never
 * existed; and any open — a zip drop, a share link, a boot param — replaced live
 * unsaved work without asking. This probe walks the sequence a user actually
 * performs and asserts each of those is now impossible.
 *
 * THE SEVEN THINGS ASSERTED, in the order a user meets them:
 *   1. A FRESH DOCUMENT IS A DRAFT, and quick-Save is UNAVAILABLE with the stated
 *      reason. The load-bearing one — everything else follows from this state.
 *   2. RENAMING IT DOES NOT SAVE IT. The name lives in the working copy, the
 *      library stays empty, and quick-Save is STILL unavailable. This is the
 *      user's "renaming is the same as saving a new project" read correctly: the
 *      rename does not create the entry, Save does.
 *   3. SAVE AS… COMMITS IT under whatever name the working copy holds, and the
 *      state flips — quick-Save becomes available, the indicator reads SAVED.
 *   4. QUICK SAVE writes IN PLACE with no modal: same project, no second entry,
 *      no name prompt.
 *   5. RENAME NOW MOVES (c2e1bbf), because the project is in the library — the
 *      OPPOSITE behavior from step 2, on the same gesture, decided by one flag.
 *   6. AN IMPORTED DRAFT BEHAVES IDENTICALLY to a fresh one: same gate, same
 *      reason, same Save-As-first requirement. That is the UNIFICATION.
 *   7. THE GUARD ASKS, and Cancel actually aborts — the working copy survives an
 *      open it declined, and Discard lets it through.
 *
 * Also asserted throughout: CMD+S DISPATCHES BY STATE (Save As on a draft, quick
 * Save on a saved project), which is the one binding a user presses blind.
 *
 * Spawns its OWN isolated Vite + headless Chromium (the house probe pattern) and
 * runs FRONTEND-ONLY under ?static=1 — no backend, which makes the library
 * assertions cheap AND exercises the "browser side" half of the ruling. The
 * server side is the same code path through the projectStore seam.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { zipSync } = await import("fflate");
const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Console noise this probe ignores, each for a stated reason — never a blanket
 *  filter, since an unexpected error IS a failure signal here:
 *   · backend-absent chatter: this Vite is frontend-only on purpose.
 *   · repair reports: the fixture doc is minimal, so repairedDocument fills the
 *     rest and says so. That is the pipeline working.
 *   · the transient resolveUrl window: resolveUrl is SYNCHRONOUS by contract while
 *     primeUrls is async, so a paint can land between "the doc points at keyspace
 *     X" and "X's object URLs exist". Pre-existing and not gesture-specific —
 *     draft_open_static_probe.js documents the same window at length. */
const EXPECTED_NOISE = /Failed to load resource|thumbnail|\/api\/|WebGPU|VideoV7|PowerRP repair:|localAssetStore\.resolveUrl:|image_registry: failed to load/;

/** Pure function. Archive bytes for a minimal one-slide deck — the IMPORTED-draft
 *  fixture for step 6. Assets are beside the point here (step 6 asks about the
 *  save GATE, which draft_open_static_probe already proves carries assets), so it
 *  is deliberately the smallest valid archive. */
function buildDeckZip(name) {
  const enc = new TextEncoder();
  const doc = {
    meta: { name, slideW: 1280, slideH: 720, script: "" },
    slides: [{
      id: "s1", name: "Slide 1",
      transition: { type: "cut", seconds: 0, curve: "smooth", sound: null },
      delta: { items: { cam: { type: "camera", active: true, x: 0, y: 0, w: 1280, h: 720, rotation: 0, scale: 1, background: "#101014" } } },
    }],
  };
  return zipSync({ [`${name}/doc.json`]: enc.encode(JSON.stringify(doc, null, 2)) }, { level: 6 });
}

/** Query (in-page). Every fact the save gestures turn on, in one round trip.
 *  `saveAvailable` asks the COMMAND'S OWN `when` gate rather than re-deriving it,
 *  so this measures what the button/palette actually do — the drift a re-derived
 *  copy would hide is the entire reason the gate lives in the registry. */
const saveState = (page) => page.evaluate(async () => {
  const app = window.__powerrp_app;
  const quick = app.commands.get("save-project");
  const saveAs = app.commands.get("save-to-server");
  return {
    isDraft: app.isDraft(),
    everSaved: app.everSaved,
    draftMode: app.draftMode ? { ...app.draftMode } : null,
    projectName: app.projectName(),
    displayName: app.projectDisplayName(),
    saveState: app.saveState(),
    quickAvailable: quick.when ? quick.when(app) : true,
    quickReason: quick.requires ?? null,
    saveAsAvailable: saveAs.when ? saveAs.when(app) : true,
    projects: (await app.listProjects()).map((p) => p.name),
    title: document.querySelector(".doc-name")?.textContent?.trim() ?? null,
  };
});

/** Query (in-page). Which command Cmd+S would run right now — asked of the SAME
 *  dispatcher the keybinding invokes, by stubbing runCommand for one call, so
 *  this cannot pass while the real binding does something else. */
const cmdSTarget = (page) => page.evaluate(() => {
  const app = window.__powerrp_app;
  const real = app.runCommand.bind(app);
  let ran = null;
  app.runCommand = (id) => { ran = id; };   // capture, do not execute
  try { real("save-dispatch"); } finally { app.runCommand = real; }
  return ran;
});

/** Command (in-page). Make a real edit, so the document is genuinely dirty and
 *  the guard's "untouched blank document" exemption no longer applies.
 *
 *  A DIRECT `commit()`, NOT an insert command. The toolbar's add-* commands ARM A
 *  CROSSHAIR (`armCrosshairPlacement`) and commit nothing until the user clicks
 *  the canvas — so running one leaves the document pristine, which silently made
 *  the "an edit makes it dirty" assertion measure nothing. commit() IS the edit
 *  seam every one of those paths eventually calls, and it is what pushes the undo
 *  step the guard's untouched-document exemption reads. */
const makeEdit = async (page) => {
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const doc = structuredClone(JSON.parse(JSON.stringify(app.doc)));
    doc.meta = { ...doc.meta, notes: `edited ${Date.now()}` };
    app.commit(doc);
  });
  await sleep(400);
};

/** Command (in-page). Answer the guard dialog with a fixed reply for the duration
 *  of one open, and report whether it was actually consulted. Installs over the
 *  App.svelte hook, which is the same seam the real modal occupies. */
const withGuardAnswer = (page, answer, run) => page.evaluate(async (ans, fn) => {
  const app = window.__powerrp_app;
  const prior = app.confirmUnsavedWork;
  let asked = 0;
  app.confirmUnsavedWork = () => { asked++; return Promise.resolve(ans); };
  try { const result = await new Function("app", `return (${fn})(app)`)(app); return { asked, result }; }
  finally { app.confirmUnsavedWork = prior; }
}, answer, run);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !EXPECTED_NOISE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/?static=1`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // ── 1. A FRESH DOCUMENT IS A DRAFT, and quick-Save is UNAVAILABLE ──────────
  const s1 = await saveState(page);
  assert(s1.projects.length === 0, `the library starts EMPTY (found: ${JSON.stringify(s1.projects)})`);
  assert(s1.isDraft === true, "THE UNIFICATION: a brand-new document is an UNSAVED DRAFT, exactly like an imported one");
  assert(s1.everSaved === false, "nothing has passed through the library seam for this working copy");
  assert(s1.draftMode === null, "…and it is a draft WITHOUT an import marker — the fresh-document half of the unification");
  assert(s1.quickAvailable === false, "THE RULING: quick-Save is UNAVAILABLE on an unsaved document — 'I shouldn't be allowed to just save it'");
  assert(/not saved yet/i.test(s1.quickReason ?? ""), `…and it states WHY (got: ${JSON.stringify(s1.quickReason)})`);
  assert(/Save As/i.test(s1.quickReason ?? ""), "…naming the gesture that works instead");
  assert(s1.saveAsAvailable === true, "Save As… is ALWAYS available — it is the gesture that gets you out of this state");
  assert(await cmdSTarget(page) === "save-to-server", "CMD+S on a draft dispatches to SAVE AS…, never to a silent write");

  // ── 2. RENAMING A DRAFT DOES NOT SAVE IT ──────────────────────────────────
  // The subtlest half of the ruling, and the one an earlier design got wrong by
  // treating the NAME as part of the draft test: typing a title must not promote
  // a document into the library, because naming IS what Save-As does.
  await makeEdit(page);
  await page.evaluate(async () => { await window.__powerrp_app.renameProject("Draft ideas"); });
  await sleep(600);

  const s2 = await saveState(page);
  assert(s2.displayName === "Draft ideas", `the rename took effect in the WORKING COPY (got "${s2.displayName}")`);
  assert(s2.title === "Draft ideas", `…and the toolbar shows it (got "${s2.title}")`);
  assert(s2.projects.length === 0, `THE RULING: renaming created NO library entry (found: ${JSON.stringify(s2.projects)})`);
  assert(s2.isDraft === true, "a renamed-but-never-saved document is STILL A DRAFT — the name is not what makes it one");
  assert(s2.quickAvailable === false, "…so quick-Save is STILL unavailable. Renaming is not saving.");
  assert(await cmdSTarget(page) === "save-to-server", "CMD+S still dispatches to Save As… after the rename");

  // ── 3. SAVE AS… COMMITS IT, under the name the working copy holds ─────────
  await page.evaluate(async () => { await window.__powerrp_app.saveToServer("Draft ideas"); });
  await sleep(1000);

  const s3 = await saveState(page);
  assert(s3.projects.length === 1 && s3.projects[0] === "Draft ideas",
    `Save As… put it in the library ONCE, under the renamed name (found: ${JSON.stringify(s3.projects)})`);
  assert(s3.isDraft === false, "it is no longer a draft");
  assert(s3.everSaved === true, "everSaved flipped on the successful write");
  assert(s3.saveState === "saved", `the indicator reads SAVED (got "${s3.saveState}")`);
  assert(s3.quickAvailable === true, "…and quick-Save is NOW AVAILABLE — the state change the whole gate exists to express");
  assert(await cmdSTarget(page) === "save-project", "CMD+S now dispatches to QUICK SAVE — the same key, a different meaning, decided by one flag");

  // ── 4. QUICK SAVE writes IN PLACE, with no prompt and no second entry ─────
  await makeEdit(page);
  const dirty = await saveState(page);
  assert(dirty.saveState === "unsaved", "an edit makes the saved project dirty");
  assert(dirty.quickAvailable === true, "…quick-Save stays available while dirty (that is when it is FOR)");

  await page.evaluate(async () => { await window.__powerrp_app.quickSave(); });
  await sleep(1000);

  const s4 = await saveState(page);
  assert(s4.saveState === "saved", `quick-Save wrote it (indicator: "${s4.saveState}")`);
  assert(s4.projects.length === 1, `…IN PLACE: still exactly one project, no fork, no "Draft ideas 2" (found: ${JSON.stringify(s4.projects)})`);
  assert(s4.displayName === "Draft ideas", "…under the same name — quick-Save never renames");

  // The refusal is real, not decorative: bypassing the gate must throw LOUDLY
  // rather than writing under the draft key.
  const refused = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const saved = app.everSaved;
    app.everSaved = false;               // pretend the gate was bypassed
    try { await app.quickSave(); return "no error"; }
    catch (e) { return String(e.message ?? e); }
    finally { app.everSaved = saved; }
  });
  assert(/not saved yet/i.test(refused), `quickSave() on a draft REFUSES LOUDLY rather than writing (got: ${JSON.stringify(refused)})`);

  // ── 5. RENAME NOW MOVES (c2e1bbf) — the opposite of step 2 ────────────────
  await page.evaluate(async () => { await window.__powerrp_app.renameProject("Robot Talk"); });
  await sleep(1200);

  const s5 = await saveState(page);
  assert(s5.projects.length === 1, `rename MOVED rather than copied — still exactly one project (found: ${JSON.stringify(s5.projects)})`);
  assert(s5.projects[0] === "Robot Talk", `…and it is the NEW name; the old folder is gone (found: ${JSON.stringify(s5.projects)})`);
  assert(s5.displayName === "Robot Talk", "the document's name followed the folder");
  assert(s5.isDraft === false, "a renamed SAVED project is still saved");
  assert(s5.quickAvailable === true, "…and quick-Save still available");

  // ── 6. AN IMPORTED DRAFT BEHAVES IDENTICALLY — the unification ────────────
  // Same gate, same reason, same Cmd+S. If these two states ever diverged, one of
  // them would have a save gesture the other lacks, which is the bug the
  // unification removes.
  await page.evaluate(async (bytes) => {
    const app = window.__powerrp_app;
    const prior = app.confirmUnsavedWork;
    app.confirmUnsavedWork = () => Promise.resolve("discard"); // step 7 tests the asking; this step tests the state
    try {
      const file = new File([new Uint8Array(bytes)], "Imported.zip", { type: "application/zip" });
      await app.importProjectZip(file);
    } finally { app.confirmUnsavedWork = prior; }
  }, Array.from(buildDeckZip("Imported")));
  await sleep(1500);

  const s6 = await saveState(page);
  assert(s6.draftMode !== null, "the .zip opened as an IMPORTED draft");
  assert(s6.isDraft === true, "…which is a draft");
  assert(s6.quickAvailable === false, "THE UNIFICATION: an imported draft gates quick-Save exactly like a fresh document");
  assert(s6.quickReason === s1.quickReason, "…with the IDENTICAL reason — one rule, not two that happen to agree");
  assert(await cmdSTarget(page) === "save-to-server", "…and Cmd+S dispatches to Save As… for it too");
  assert(s6.projects.length === 1 && s6.projects[0] === "Robot Talk",
    `…and opening it added NOTHING to the library (found: ${JSON.stringify(s6.projects)})`);

  // ── 7. THE GUARD ASKS, and CANCEL ACTUALLY ABORTS ────────────────────────
  // "Can opening a link break my project?" — no. The working copy must survive an
  // open the user declined.
  const cancelled = await withGuardAnswer(page, "cancel", "(app) => app.newDocument()");
  await sleep(600);
  assert(cancelled.asked === 1, "opening over an unsaved draft ASKS FIRST (the guard was consulted exactly once)");
  assert(cancelled.result === false, "…guardedOpen reports the open did NOT run");

  const s7 = await saveState(page);
  assert(s7.draftMode !== null, "after CANCEL the imported draft is STILL OPEN — the open was abandoned, not half-applied");
  assert(s7.displayName === "Imported", `after CANCEL the working copy is untouched (got "${s7.displayName}")`);

  // Discard lets it through — proving Cancel's survival above was the GUARD's
  // doing and not an unrelated failure of the open itself.
  const discarded = await withGuardAnswer(page, "discard", "(app) => app.newDocument()");
  await sleep(800);
  assert(discarded.asked === 1, "DISCARD is asked for too — the dialog does not depend on the answer");
  assert(discarded.result === true, "…and the open runs");

  const s8 = await saveState(page);
  assert(s8.draftMode === null, "after DISCARD the imported draft is gone");
  assert(s8.isDraft === true, "…replaced by a fresh document, which is itself a draft (the state cycle closes)");
  assert(s8.quickAvailable === false, "…so quick-Save is unavailable again, exactly as in step 1");
  assert(s8.projects.length === 1, `…and the library still holds only the saved project (found: ${JSON.stringify(s8.projects)})`);

  // A SAVED, CLEAN working copy is NEVER asked about. This exemption is what
  // keeps the prompt meaningful — one that appears every time is one nobody reads.
  await page.evaluate(async () => { await window.__powerrp_app.loadProject("Robot Talk"); });
  await sleep(1200);
  const clean = await withGuardAnswer(page, "cancel", "(app) => app.newDocument()");
  await sleep(600);
  assert(clean.asked === 0, "a SAVED and CLEAN working copy opens with NO prompt — the exemption that keeps the dialog meaningful");
  assert(clean.result === true, "…and the open runs unimpeded");

  if (errors.length) { console.error("UNEXPECTED CONSOLE/PAGE ERRORS:\n" + errors.join("\n")); fails.push(`${errors.length} unexpected error(s)`); }
  console.log(fails.length ? `\nsave_gesture_static_probe: ${fails.length} FAILED` : "\nsave_gesture_static_probe: all checks passed");
} finally {
  await browser.close();
  await server.close();
}
process.exit(fails.length ? 1 : 0);
