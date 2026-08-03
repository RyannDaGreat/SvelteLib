/**
 * A CONVERGES PREDICATE MUST NOT WATCH A FIELD NOTHING WRITES — plain node.
 * Run FROM THE POWERRP DIR:
 *   node render_gpu/tests/settled_prefix_test.js
 *
 * THE DEFECT THIS PINS (measured 2026-08-02). pdf_page, pdf_packet and latex each
 * declared `convergesOnRefs((s) => [s.__pdfRef])` / `[s.__latexRef]`. Grep found
 * ZERO assignments to those fields anywhere in the repo: emit() computes the real
 * ref directly (pdfPageRef/latexRef) and never round-trips it through state. So
 * `refsOf(state)` returned `[undefined]`, `refsReady` skipped a non-string as
 * "nothing requested", and the predicate answered TRUE unconditionally — three of
 * the app's slowest-loading widgets permanently declaring themselves settled.
 *
 * WHY IT IS WORTH A TEST RATHER THAN JUST A FIX: it is invisible from the outside.
 * A predicate that is always true and a widget that is genuinely fast look
 * identical until an export ships a hole, which is the failure core/ephemeral.js
 * exists to prevent. The first assertion below is the one that would have caught
 * it — a raster IN FLIGHT must make the widget unsettled.
 *
 * Bare node: image_registry's reserve/abandon/status are pure bookkeeping over a
 * Map (see abandoned_slot_test.js), so no DOM and no pdf.js.
 */

import assert from "node:assert/strict";
import { convergesOnRefPrefixes, refsReady } from "../gpu/settled.js";
import {
  reserveImageSlot, registerRasterizedBitmap, abandonImageSlot, resetImageRegistry,
} from "../gpu/image_registry.js";
import { pdfPagePlugin } from "../../plugins/pdf_page.js";
import { pdfPacketPlugin } from "../../plugins/pdf_packet.js";
import { latexPlugin } from "../../plugins/latex.js";
import { mermaidPlugin } from "../../plugins/mermaid.js";
import { paperPeacockPlugin } from "../../plugins/paper_peacock.js";

/** The five widgets that carried the never-assigned-`__*Ref` declaration. */
const ALL = [pdfPagePlugin, pdfPacketPlugin, latexPlugin, mermaidPlugin, paperPeacockPlugin];

let passed = 0;
function test(name, fn) { resetImageRegistry(); fn(); passed++; console.log(`  ok  ${name}`); }

/** A stand-in for an ImageBitmap: registerRasterizedBitmap only stores it. */
const fakeBitmap = () => ({ width: 4, height: 4, close() {} });

const PDF_REF = "pdfpage:blob:x:1:2.5";
const REGION_REF = "pdfregion:blob:x:1:0.000000,0.000000,0.500000,0.500000:3";
const LATEX_REF = "latex:x^2:#000000:1";
const MERMAID_REF = "mermaid:default:1:flowchart TD\n A-->B";

// ── The defect itself, in the abstract ───────────────────────────────────────
test("refsReady([undefined]) is TRUE — why a never-assigned field was invisible", () => {
  assert.equal(refsReady([undefined]), true,
    "a non-string ref is skipped as 'nothing requested'; that is correct in itself, " +
    "and is exactly why watching a field nothing writes silently reported READY");
});

// ── The three widgets: in flight ⟹ unsettled ─────────────────────────────────
test("pdf_page is UNSETTLED while its page raster is in flight", () => {
  reserveImageSlot(PDF_REF);
  assert.equal(pdfPagePlugin.ephemeral.settled({}), false);
});

test("pdf_page is UNSETTLED while its crisp REGION raster is in flight", () => {
  reserveImageSlot(REGION_REF);
  assert.equal(pdfPagePlugin.ephemeral.settled({}), false,
    "the display pre-pass's region raster is drawn too, so it must be waited on");
});

test("pdf_packet is UNSETTLED while a page raster is in flight", () => {
  reserveImageSlot(PDF_REF);
  assert.equal(pdfPacketPlugin.ephemeral.settled({}), false);
});

test("latex is UNSETTLED while its MathJax raster is in flight", () => {
  reserveImageSlot(LATEX_REF);
  assert.equal(latexPlugin.ephemeral.settled({}), false);
});

// mermaid and paper_peacock carried the IDENTICAL defect (`s.__mermaidRef`,
// `s.__pdfRef`) and were found by the sweep at the bottom of this file, not by the
// brief that started this work — which is the argument for the sweep existing.
test("mermaid is UNSETTLED while its diagram raster is in flight", () => {
  reserveImageSlot(MERMAID_REF);
  assert.equal(mermaidPlugin.ephemeral.settled({}), false);
});

test("paper_peacock is UNSETTLED while a sheet raster is in flight", () => {
  reserveImageSlot(PDF_REF);
  assert.equal(paperPeacockPlugin.ephemeral.settled({}), false);
});

// ── …and settled once it lands ───────────────────────────────────────────────
test("pdf_page SETTLES once the raster registers", () => {
  reserveImageSlot(PDF_REF);
  registerRasterizedBitmap(PDF_REF, fakeBitmap());
  assert.equal(pdfPagePlugin.ephemeral.settled({}), true);
});

test("latex SETTLES once the raster registers", () => {
  reserveImageSlot(LATEX_REF);
  registerRasterizedBitmap(LATEX_REF, fakeBitmap());
  assert.equal(latexPlugin.ephemeral.settled({}), true);
});

test("an empty registry is settled — nothing in flight, nothing to wait for", () => {
  for (const p of ALL)
    assert.equal(p.ephemeral.settled({}), true, `${p.type} on an empty registry`);
});

// ── Namespaces do not bleed into each other ──────────────────────────────────
test("a LaTeX raster in flight does NOT hold up a PDF widget", () => {
  reserveImageSlot(LATEX_REF);
  assert.equal(latexPlugin.ephemeral.settled({}), false);
  assert.equal(pdfPagePlugin.ephemeral.settled({}), true, "different namespace");
});

// ── The terminal states, which must never hang an export ─────────────────────
test("an ABANDONED (superseded) raster does not hang the widget", () => {
  reserveImageSlot(REGION_REF);
  abandonImageSlot(REGION_REF, "region raster superseded by a newer view");
  assert.equal(pdfPagePlugin.ephemeral.settled({}), true,
    "abandoned ≠ failed ≠ pending — see abandoned_slot_test.js; a superseded " +
    "region must not stall a settle loop that itself causes supersession");
});

// ── The declarations are well-formed CONVERGES, not accidental strings ───────
test("all five still declare CONVERGES with a real predicate", () => {
  for (const p of ALL) {
    assert.equal(p.ephemeral.kind, "converges", `${p.type} kind`);
    assert.equal(typeof p.ephemeral.settled, "function", `${p.type} predicate`);
  }
});

// ── The regression guard: no plugin may watch a field nothing assigns ────────
test("no plugin declares a `settled` over a never-written `__*Ref` field", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const roots = ["plugins", join("plugins", "demo")];
  const offenders = [];
  for (const dir of roots)
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".js")))
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // prose ABOUT the defect is not the defect
        const m = line.match(/\bs\.(__\w*[Rr]ef)\b/);
        if (m) offenders.push(`${dir}/${f}: s.${m[1]}`);
      }
  assert.deepEqual(offenders, [],
    "a `settled` predicate reading a state field that nothing ever assigns reports " +
    "READY for a frame that is not — strictly worse than declaring no predicate. " +
    "If a widget's refs are camera-derived, use convergesOnRefPrefixes.");
});

console.log(`\nsettled_prefix_test: ${passed} passed`);
