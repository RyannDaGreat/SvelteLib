/**
 * SELECT INSIDE GROUP, in a real editor — the half a pure-function test cannot
 * reach: that the COMMAND exists, is gated correctly, actually moves the
 * selection, and leaves the document alone.
 *
 * That last one is the point of the feature. Its neighbour Ungroup dissolves the
 * group and writes keyframes; this must write NOTHING. The document is compared
 * byte-for-byte across the command.
 *
 * No screenshots — every assertion is a state read, so this is immune to the host
 * Chrome capture hang (CLAUDE.md's preflight note).
 *
 * Run: node src/demo_apps/PowerRP/tests/select_in_group_probe.js
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const checks = [];
const ok = (pass, label) => checks.push([pass, label]);

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({ configFile: path.resolve(HERE, "../web/vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
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
    await new Promise((r) => setTimeout(r, 800));

    const r = await page.evaluate(() => {
      const app = window.__powerrp_app;
      const cmd = app.commands.get("select-in-group");
      const out = { present: !!cmd, title: cmd?.title ?? null };

      // Build three rects and group them, through the real commands.
      const ids = [];
      for (let i = 0; i < 3; i++) {
        app.addItem(app.registry.get("rect").defaults);
        const id = app.selection;
        ids.push(id);
        app.setPreview([[["items", id, "x"], 200 + i * 150], [["items", id, "y"], 300]]);
        app.commitPreview();
      }
      app.selectMany(ids);
      out.gateBeforeGroup = app.commands.get("select-in-group").when(app); // no group yet → false
      app.groupSelection();
      const groupId = app.selection;
      out.groupedTo = app.selectedNodes().map((n) => n.type);
      out.gateWithGroup = app.commands.get("select-in-group").when(app);

      // THE DOCUMENT MUST NOT MOVE. Snapshot before, compare after.
      const before = JSON.stringify(app.doc);
      app.commands.get("select-in-group").run(app);
      out.docUnchanged = JSON.stringify(app.doc) === before;

      out.selectedIds = [...app.selectedIds()].sort();
      out.expectedMembers = [...ids].sort();
      out.groupStillExists = app.nodes().some((n) => n.itemId === groupId && n.type === "group");
      out.groupNotSelected = !app.selectedIds().includes(groupId);
      out.selectedTypes = [...new Set(app.selectedNodes().map((n) => n.type))];

      // ── AND BACK UP: select-parent-group, the inverse tool ────────────────
      const up = app.commands.get("select-parent-group");
      out.upPresent = !!up;
      out.upGateWithMembers = up.when(app); // members are selected → true
      const beforeUp = JSON.stringify(app.doc);
      up.run(app);
      out.upDocUnchanged = JSON.stringify(app.doc) === beforeUp;
      out.roundTripped = app.selectedIds().length === 1 && app.selectedIds()[0] === groupId;
      out.upGateOnGroup = up.when(app); // the group itself has no parent → false

      // ── TWO MEMBERS, TWO DIFFERENT PARENTS → BOTH BUBBLE, AS A MULTI-SELECTION
      // User, 2026-08-02: "if there are two objects which have two different
      // parent groups, then it will just bubble both of them up. The result is a
      // new multi-selection." Built here out of real widgets rather than asserted
      // on the pure function alone, because "is the RESULT a multi-selection"
      // is a fact about selectMany and the app, not about the array.
      const second = [];
      for (let i = 0; i < 2; i++) {
        app.addItem(app.registry.get("rect").defaults);
        const id = app.selection;
        second.push(id);
        app.setPreview([[["items", id, "x"], 700 + i * 120], [["items", id, "y"], 600]]);
        app.commitPreview();
      }
      app.selectMany(second);
      app.groupSelection();
      const groupB = app.selection;
      // One member out of EACH group, selected together.
      app.selectMany([ids[0], second[0]]);
      out.twoParentsGate = up.when(app);
      up.run(app);
      const raised = [...app.selectedIds()].sort();
      out.bothBubbled = raised.length === 2 && raised.join() === [groupId, groupB].sort().join();
      out.isMultiSelection = app.selectedIds().length > 1;
      out.raisedTypes = [...new Set(app.selectedNodes().map((n) => n.type))];
      return out;
    });

    ok(r.present, `the command is registered ("${r.title}")`);
    ok(r.gateBeforeGroup === false, "it is UNAVAILABLE when the selection holds no group");
    ok(r.groupedTo.join() === "group", "setup sanity: grouping three rects selected the group");
    ok(r.gateWithGroup === true, "it becomes available once a group is selected");
    ok(JSON.stringify(r.selectedIds) === JSON.stringify(r.expectedMembers),
      `THE FEATURE: the three members are now selected individually (${r.selectedIds.length} of 3)`);
    ok(r.selectedTypes.join() === "rect", `and they are the rects, not the group (types: ${r.selectedTypes.join()})`);
    ok(r.groupNotSelected, "the group itself is NOT in the selection — the Round-12B invariant");
    ok(r.groupStillExists, "THE GROUP STILL EXISTS — this is not Ungroup");
    ok(r.docUnchanged, "THE DOCUMENT IS BYTE-IDENTICAL across the command — nothing was written, so there is nothing to undo");
    ok(r.upPresent, "the INVERSE command select-parent-group is registered");
    ok(r.upGateWithMembers === true, "it is available while the members are selected");
    ok(r.roundTripped, "ROUND TRIP: going back up re-selects the group, and only the group");
    ok(r.upDocUnchanged, "it too leaves the document BYTE-IDENTICAL");
    ok(r.upGateOnGroup === false, "and it is UNAVAILABLE on a top-level group — there is no parent to rise to");
    ok(r.twoParentsGate === true, "two members of two DIFFERENT groups: the tool is available");
    ok(r.bothBubbled, "BOTH bubble up — the result is exactly the two owning groups, neither dropped");
    ok(r.isMultiSelection, "and the result is a MULTI-SELECTION, not a single pick");
    ok(r.raisedTypes.join() === "group", `both raised items are groups (types: ${r.raisedTypes.join()})`);
    ok(errors.length === 0, `no page errors${errors.length ? ` — ${errors.slice(0, 3).join(" | ")}` : ""}`);

    console.log(checks.map(([p, l]) => `  ${p ? "ok  " : "FAIL"} ${l}`).join("\n"));
    const failed = checks.filter(([p]) => !p);
    if (failed.length) { console.error(`\n${failed.length} FAILED`); process.exitCode = 1; }
    else console.log(`\n${checks.length} select-in-group probe checks passed`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((e) => { console.error("select_in_group_probe ERROR:", e); process.exit(1); });
