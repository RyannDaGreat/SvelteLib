/**
 * MODAL TOGGLES END TO END — the I (individual origins) and W (wholistic scale)
 * keys inside a LIVE Blender-style S modal, driven through the real keyboard.
 *
 * ── WHY THIS PROBE EXISTS ────────────────────────────────────────────────────
 * The toggles shipped with their feature half wired (CanvasView's modalToggle,
 * the App.svelte announcement) and their REGISTRATION half reporting an
 * UNSATISFIABLE `when` at every boot: `hintProbeContexts` had no `multiSelection`
 * axis, so the I entry's predicate — which requires one, because with a single
 * item "each about its own centre" and "all about the collective centre" are the
 * same transform — could not be true in ANY of the ~80k probed contexts. The boot
 * tripwire therefore named a predicate that was perfectly correct, and the node
 * satisfiability gate could not contradict it because tests/shortcut_registry_test.js
 * omitted `modalToggles` from its handShortcutEntries call and the parameter
 * defaulted to `{}` — the entries were simply absent from the population.
 *
 * Both halves are now pinned in bare node (tests/shortcut_registry_test.js). What
 * NODE CANNOT SEE is the other end of the chain: that a real keydown on a real
 * page reaches CanvasView's handler, changes the gesture's behaviour, and shows
 * its chip. A registry entry can be perfectly satisfiable and still dispatch
 * nowhere — that is precisely the class of defect the registry doctrine exists to
 * prevent ("a shortcut that isn't registered does not exist" has a converse:
 * registered is not the same as delivered). So this probe asserts the WHOLE path,
 * key to pixels-worth-of-state, for each declared toggle.
 *
 * DERIVED FROM MODAL_TOGGLES, not hand-written per key: a third toggle gets
 * covered here the day it is declared, which is the rule its shortcut entries,
 * its announcement and its applicability predicate already follow.
 *
 * No screenshots — every assertion is a state read, so this is immune to the host
 * Chrome capture hang (CLAUDE.md's preflight note).
 *
 * Run: node src/demo_apps/PowerRP/tests/modal_toggle_probe.js
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODAL_TOGGLES } from "../web/canvas/dragKinds.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const checks = [];
const ok = (pass, label) => checks.push([pass, label]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { createServer } = await import("vite");
  // HMR and the watcher OFF for the reason tests/selection_commands_probe.js
  // states at length: a stray full reload mid-probe destroys the execution context
  // and surfaces as a puppeteer ProtocolError with no assertion text.
  const server = await createServer({ configFile: path.resolve(HERE, "../web/vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
  await server.listen();
  const { launchBrowser } = await import("./puppeteerLaunch.js");
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    const errors = [];
    const IGNORE = /Failed to load resource|thumbnail|\/api\/|listAssets|could not list project assets|500 |ECONNREFUSED|crypto\.randomUUID|VideoV7|WebGPU/i;
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle2", timeout: 180000 });
    await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 60000 });
    await wait(800);

    // ── (0) THE BOOT SURFACE ────────────────────────────────────────────────
    // Captured after load and BEFORE any gesture, so it is attributable to the
    // boot alone. THE UNSATISFIABLE REPORT IS ASSERTED ABSENT BY NAME rather than
    // baselined away: this workstream's whole defect was that line, and a probe
    // that tolerated it would let it return silently.
    const bootErrors = errors.slice();
    const unsat = bootErrors.filter((e) => /UNSATISFIABLE/.test(e));
    ok(unsat.length === 0, `no shortcut reports an UNSATISFIABLE \`when\` at boot${unsat.length ? ` — ${unsat.join(" | ")}` : ""}`);

    // ── THE FIXTURE: two rects, both selected ───────────────────────────────
    // TWO, because `individual` is soloSuppressed — on a single item the toggle is
    // withheld by declaration, so a one-item fixture could not exercise it at all.
    await page.evaluate(() => {
      const app = window.__powerrp_app;
      const ids = [app.registry.get("rect").defaults, app.registry.get("rect").defaults].map((d) => { app.addItem(d); return app.selection; });
      // Push them apart so an "each about its own centre" scale and a collective
      // one are geometrically DIFFERENT — with coincident centres the toggle would
      // be a no-op and the behavioural assertion below would be vacuous. Written
      // through setPreview/commitPreview, which is the app's ONE property-write
      // seam (one undo unit), not a per-item setter.
      app.setPreview([[["items", ids[0], "x"], -200], [["items", ids[1], "x"], 200]]);
      app.commitPreview();
      app.selectMany(ids);
      window.__probe_ids = ids;
    });
    await wait(300);

    /** Query. The live modal's public state plus what the HintBar is showing. */
    const modalState = () => page.evaluate(() => {
      const app = window.__powerrp_app;
      return {
        kind: app.modalXform?.kind ?? null,
        toggles: { ...(app.modalXform?.toggles ?? {}) },
        // The bar's FIRST chip is the modal announcement (App.svelte leads with it
        // while a transform is live), and each active toggle contributes a segment.
        announcement: document.querySelector(".hintbar .hint .label")?.textContent ?? "",
        chips: [...document.querySelectorAll(".hintbar .hint")].map((el) => ({
          keys: [...el.querySelectorAll(".keys *")].map((k) => k.textContent.trim()).join("+") || el.querySelector(".keys")?.textContent?.trim() || "",
          label: el.querySelector(".label")?.textContent?.trim() ?? "",
        })),
        // The world x of each item — what a scale about individual vs collective
        // origins actually differs on.
        xs: (window.__probe_ids ?? []).map((id) => app.state().items[id]?.x ?? null),
      };
    });

    /** Command. Presses one key at the document, the way a user does. */
    const press = async (key) => { await page.keyboard.press(key); await wait(160); };

    // ── (1) START A LIVE MODAL, AND CHECK EACH TOGGLE'S CHIP + EFFECT ───────
    for (const [id, t] of Object.entries(MODAL_TOGGLES)) {
      // Every declared toggle applies to at least one kind; use its FIRST, and
      // start that gesture with the kind's own key so the whole registry path
      // (keydown → shortcut entry → app.beginModalTransform) is exercised too.
      const kind = t.kinds[0];
      const startKey = kind === "scale" ? "s" : kind === "rotate" ? "r" : "g";
      await page.evaluate(() => window.__powerrp_app.selectMany(window.__probe_ids));
      await page.mouse.move(700, 450);
      await press(startKey);
      const live = await modalState();
      ok(live.kind === kind, `${t.label}: the ${startKey.toUpperCase()} key starts a live "${kind}" modal (got ${JSON.stringify(live.kind)})`);

      // THE CHIP IS OFFERED MID-GESTURE. This is the half that only a live page can
      // answer: the entry is satisfiable in node, but the bar is fed by the SAME
      // registry the dispatcher reads, so a chip missing here would mean the
      // context the app actually builds does not match the one the prober models.
      const chip = live.chips.find((c) => c.label === t.label);
      ok(!!chip, `${t.label}: its chip SHOWS during the live gesture (bar had ${JSON.stringify(live.chips.map((c) => c.label).slice(0, 12))})`);
      ok(chip?.keys?.toUpperCase().includes(t.key), `${t.label}: …on the "${t.key}" key it declares (chip keys ${JSON.stringify(chip?.keys)})`);

      // THE KEY ACTS. Pressing it flips the gesture's own toggle record.
      await press(t.key.toLowerCase());
      const on = await modalState();
      ok(on.toggles[id] === true, `${t.label}: pressing "${t.key}" turns the toggle ON (toggles ${JSON.stringify(on.toggles)})`);
      // …and SAYS SO. A toggle that changes what the gesture means and announces
      // nothing is a mode the user cannot see they are in (App.svelte's own rule).
      ok(on.announcement.includes(t.mark), `${t.label}: the modal announcement carries "${t.mark}" (got ${JSON.stringify(on.announcement)})`);

      // …and it is a TOGGLE, not a latch: the same key turns it back off.
      await press(t.key.toLowerCase());
      const off = await modalState();
      ok(!off.toggles[id], `${t.label}: pressing "${t.key}" again turns it OFF (toggles ${JSON.stringify(off.toggles)})`);
      ok(!off.announcement.includes(t.mark), `${t.label}: …and the announcement drops "${t.mark}" (got ${JSON.stringify(off.announcement)})`);

      await press("Escape");
      const cancelled = await modalState();
      ok(cancelled.kind === null, `${t.label}: Escape ends the modal (got ${JSON.stringify(cancelled.kind)})`);
    }

    // ── (2) THE TOGGLE CHANGES THE PICTURE, not just a flag ─────────────────
    // `individual` scales each item about ITS OWN centre, so two items 400 apart
    // keep their positions; the collective scale moves them apart. Asserting the
    // GEOMETRY is what makes this more than a state-echo test — a modalToggle that
    // set the flag and forgot to re-derive the preview would pass everything above.
    const geom = await page.evaluate(async () => {
      const app = window.__powerrp_app;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const xs = () => window.__probe_ids.map((id) => app.state().items[id].x);
      const before = xs();
      // Collective scale by an exact typed factor — no mouse geometry involved, so
      // the comparison is deterministic.
      app.beginModalTransform("scale");
      await sleep(120);
      app.modalAppendBuffer("2");
      await sleep(120);
      const collective = xs();
      app.modalToggle("individual");
      await sleep(120);
      const individual = xs();
      app.modalCancel();
      await sleep(120);
      return { before, collective, individual, restored: xs() };
    });
    const spread = (a) => Math.abs(a[1] - a[0]);
    ok(spread(geom.collective) > spread(geom.before) + 1,
      `a COLLECTIVE scale pushes the two items apart (${spread(geom.before).toFixed(1)} → ${spread(geom.collective).toFixed(1)})`);
    ok(Math.abs(spread(geom.individual) - spread(geom.before)) < 1,
      `…and INDIVIDUAL ORIGINS holds each item where it is (${spread(geom.individual).toFixed(1)}, want ≈${spread(geom.before).toFixed(1)}) — the toggle re-derives the preview, it does not merely set a flag`);
    ok(Math.abs(spread(geom.restored) - spread(geom.before)) < 1, "Escape restores the original geometry");

    const raised = errors.slice(bootErrors.length);
    ok(raised.length === 0, `no page errors from the gestures this probe drives${raised.length ? ` — ${raised.slice(0, 3).join(" | ")}` : ""}`);
    if (bootErrors.length) console.log(`  (boot errors, none of them UNSATISFIABLE: ${bootErrors.map((e) => e.slice(0, 90)).join(" | ")})`);

    console.log(checks.map(([p, l]) => `  ${p ? "ok  " : "FAIL"} ${l}`).join("\n"));
    const failed = checks.filter(([p]) => !p);
    if (failed.length) { console.error(`\n${failed.length} FAILED`); process.exitCode = 1; }
    else console.log(`\n${checks.length} modal-toggle checks passed`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main();
