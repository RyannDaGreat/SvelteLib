/**
 * ASSET DROP — the widget a dropped file becomes, and the three gates that keep
 * that answer in one place.
 *
 * THE BUG THIS PINS: the user dropped `MagickWithSupplementary.pdf` on the canvas
 * and got "nothing on the canvas can show a 'pdf' asset — it stays in the asset
 * library." That sentence was TRUE of the classifier and FALSE of the app:
 * `pdf_page` had shipped long before. The classifier asked
 * `kind === "image" || kind === "video"`, one of FIVE hand-written answers to
 * "what kind is this file / can it go on the canvas" scattered across the drop,
 * paste and upload paths. Widgets now DECLARE the dropped kind they are and
 * everything reads that.
 *
 * WHAT IS GATED HERE, and why each is a gate rather than a comment:
 *   1. The registry claim is unique and well-formed — enforced at registration.
 *   2. Every claimed kind is a kind the CLASSIFIER CAN ACTUALLY PRODUCE. A
 *      widget declaring `assetDrop: "PDF"` or `"pdfs"` would compile, register,
 *      and silently never receive a drop. Checked against assetRef's own table,
 *      not a list copied to here — a copy would be the defect being removed.
 *   3. Every claimed kind is MEASURABLE. A droppable widget with no natural-size
 *      measurer throws at the user's drop; this catches it in the suite instead.
 *
 * Run: node src/demo_apps/PowerRP/tests/asset_drop_test.js
 */
import { createRegistry, widgetForAssetKind, assetDropKindOf } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { assetDropKind } from "../web/pluginAssetLoader.js";
import { assetKindForFile, assetKindForName } from "../web/assetRef.js";
import { measurableAssetKinds } from "../web/assetNaturalSize.js";

const checks = [];
const ok = (pass, label) => checks.push([pass, label]);
const eq = (a, b, label) => ok(a === b, `${label}${a === b ? "" : ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);

const registry = createRegistry();
registerPlugins(registry);

// ── 1. THE CLAIMS ───────────────────────────────────────────────────────────
const claims = registry.all().filter((p) => assetDropKindOf(p) !== null);
const byKind = new Map();
for (const p of claims) {
  const kind = assetDropKindOf(p);
  if (!byKind.has(kind)) byKind.set(kind, []);
  byKind.get(kind).push(p.type);
}

ok(claims.length >= 3, `at least the three media widgets claim a dropped kind (found ${claims.length}: ${claims.map((p) => `${p.type}←${assetDropKindOf(p)}`).join(", ")})`);
for (const [kind, types] of byKind)
  eq(types.length, 1, `exactly one widget claims dropped "${kind}" (${types.join(", ")})`);

eq(widgetForAssetKind(registry, "pdf")?.type, "pdf_page", "A DROPPED PDF BECOMES A PDF PAGE — the user-reported bug");
eq(widgetForAssetKind(registry, "image")?.type, "image", "a dropped image still becomes an image widget");
eq(widgetForAssetKind(registry, "video")?.type, "video", "a dropped video still becomes the PLAYER, not the scrubber");
eq(widgetForAssetKind(registry, "sound"), null, "no widget claims a bare sound file — it uploads to the library and the drop is reported");

// The three PDF-accepting widgets must NOT all claim the drop: acceptance and
// drop-target are different questions, which is the whole reason the field exists.
for (const type of ["pdf_packet", "paper_peacock"])
  eq(assetDropKindOf(registry.get(type)), null, `${type} accepts a PDF but is NOT what a bare drop creates`);

// ── 2. EVERY CLAIMED KIND IS ONE THE CLASSIFIER CAN PRODUCE ─────────────────
// Driven from assetRef's table by probing it, so this cannot drift from it:
// a kind is "producible" if some filename makes assetKindForName return it.
const PROBE_NAMES = ["a.png", "a.jpg", "a.svg", "a.mp4", "a.mov", "a.wav", "a.mp3", "a.pdf", "a.ttf", "a.woff2", "a.csv", "a.json", "a.plugin.js", "a.txt", "noext"];
const producible = new Set(PROBE_NAMES.map(assetKindForName));
for (const kind of byKind.keys())
  ok(producible.has(kind), `"${kind}" is a kind the asset classifier actually produces (a misspelled claim registers fine and then silently never receives a drop)`);

// ── 3. EVERY CLAIMED KIND IS MEASURABLE ─────────────────────────────────────
const measurable = new Set(measurableAssetKinds());
for (const [kind, types] of byKind)
  ok(measurable.has(kind), `"${kind}" (claimed by ${types[0]}) has a natural-size measurer in web/assetNaturalSize.js — without one the drop throws in the user's hands`);

// ── 4. THE CLASSIFIER, END TO END ───────────────────────────────────────────
eq(assetDropKind({ name: "paper.pdf", kind: "pdf" }, registry), "media", "THE FIX: a PDF asset tile classifies as media, not the refusal");
eq(assetDropKind({ name: "logo.png", kind: "image" }, registry), "media", "an image tile still classifies as media");
eq(assetDropKind({ name: "gear.plugin.js", kind: "plugin" }, registry), "widget", "a plugin asset still beats every kind — the SUFFIX decides");
eq(assetDropKind({ name: "gear.plugin.js", kind: "image" }, registry), "widget", "…even when the listing's kind disagrees with its own filename");
eq(assetDropKind({ name: "ding.wav", kind: "sound" }, registry), "none", "a sound still reports rather than inserting");
eq(assetDropKind({}, registry), "none", "an empty payload is none, not a crash");

// ── 5. THE OS-FILE PATH, which had the SAME bug one layer down ──────────────
eq(assetKindForFile({ type: "application/pdf", name: "paper.pdf" }), "pdf", "an OS-dragged PDF with a real MIME type is a pdf");
eq(assetKindForFile({ type: "", name: "paper.pdf" }), "pdf", "…and so is one whose browser reported no MIME type at all (the common case)");
eq(assetKindForFile({ type: "image/png", name: "a.png" }), "image", "MIME prefix still wins for the three media families");
eq(assetKindForFile({ type: "", name: "Handwriting.ttf" }), "font", "fonts fall through to the extension table rather than a second hand-written list");
eq(assetKindForFile({ type: "", name: "gear.plugin.js" }), "plugin", "the compound plugin suffix survives the delegation");
eq(assetKindForFile({ type: "text/plain", name: "notes.txt" }), "other", "an unclassifiable file is still 'other'");

// ── 6. THE REGISTRATION GATES REFUSE WHAT THEY PROMISE TO ───────────────────
const stub = (type, extra) => ({ type, title: type, ephemeral: "none", capabilities: {}, defaults: { type }, emit: () => [], ...extra });
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const dup = createRegistry();
dup.register(stub("first", { assetDrop: "pdf" }));
ok((threw(() => dup.register(stub("second", { assetDrop: "pdf" }))) ?? "").includes("already does"),
  "a SECOND widget claiming one kind is refused at registration — otherwise registration order decides it silently");
ok(threw(() => createRegistry().register(stub("bad", { assetDrop: 7 }))) !== null,
  "a malformed assetDrop is refused rather than stored as a claim nothing can match");
ok(threw(() => createRegistry().register(stub("fine"))) === null,
  "a widget that claims nothing registers exactly as before — this field is opt-in");

console.log(checks.map(([p, l]) => `  ${p ? "ok  " : "FAIL"} ${l}`).join("\n"));
const failed = checks.filter(([p]) => !p);
if (failed.length) { console.error(`\n${failed.length} FAILED`); process.exit(1); }
console.log(`\n${checks.length} asset-drop checks passed`);
