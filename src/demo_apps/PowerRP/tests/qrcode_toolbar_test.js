/**
 * QR CODE — FLOATING CANVAS TOOLBAR. Bare node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/qrcode_toolbar_test.js
 *
 * The user asked (2026-08-02) for "a canvas toolbar that lets me enter the URL
 * or whatever is inside of it" on double-click. Three things have to hold for
 * that to be true, and they are what this pins:
 *
 *   1. THE TRIGGER — `activate: "overlay_palette"`, the handler id
 *      web/widget_handlers.js runs on double-click, plus a `floatingToolbar`
 *      for that handler to mount. Either alone is a dead button.
 *   2. THE SPEC SHAPE web/CanvasToolbar.svelte renders — a `fields` array whose
 *      entries carry {id, label, value, keys, help}. `keys` naming the stored
 *      leaf is load-bearing: it is what disables the field when `data` holds an
 *      `=` equation, so committing cannot silently clobber a binding.
 *   3. THE ROUND TRIP — value out, fieldWrites back in, byte-identical, INCLUDING
 *      the empty string (a cleared code is a ghost, an expected state, not a
 *      refusal). A toolbar that could not write "" would be a one-way door out of
 *      the very state it exists to rescue you from.
 */

import assert from "node:assert/strict";
import { qrcodePlugin, qrDataIsEmpty } from "../plugins/qrcode.js";

// ── (1) THE TRIGGER ───────────────────────────────────────────────────────────
{
  assert.equal(qrcodePlugin.activate, "overlay_palette", "double-click must resolve to the overlay-palette handler");
  assert.equal(typeof qrcodePlugin.floatingToolbar, "function");
  assert.equal(typeof qrcodePlugin.fieldWrites, "function");
  console.log("OK trigger — activate:overlay_palette + floatingToolbar + fieldWrites all declared");
}

// ── (2) THE SPEC SHAPE ────────────────────────────────────────────────────────
{
  const spec = qrcodePlugin.floatingToolbar({ ...qrcodePlugin.defaults });
  assert.ok(Array.isArray(spec.fields) && spec.fields.length === 1, "one field: the payload");
  const [f] = spec.fields;
  assert.equal(f.id, "data");
  assert.equal(f.value, qrcodePlugin.defaults.data, "the field reads the STORED payload verbatim");
  assert.deepEqual(f.keys, ["data"], "keys must name the stored leaf so an =equation disables the field");
  for (const k of ["label", "help"]) assert.ok(f[k] && typeof f[k] === "string", `field needs a ${k}`);
  // The toolbar edits the SAME property the Inspector row does — one fact, two surfacings.
  assert.ok(qrcodePlugin.inspector.some((r) => r.key === "data"), "the Inspector row for `data` is the same leaf");
  console.log("OK spec — one `data` field, keyed to the stored leaf the Inspector row edits");
}

// ── (3) THE ROUND TRIP, incl. the empty/ghost case ────────────────────────────
{
  for (const data of ["https://example.org", "plain text, not a URL", "", "   "]) {
    const spec = qrcodePlugin.floatingToolbar({ ...qrcodePlugin.defaults, data });
    assert.equal(spec.fields[0].value, data, "value is the stored string, untrimmed");
    assert.deepEqual(qrcodePlugin.fieldWrites({}, "data", data), { data }, "typed text writes back verbatim");
  }
  // Clearing the field is a WRITE, not a refusal — and the result is the ghost
  // state the widget documents (qrDataIsEmpty), reachable and then escapable.
  const cleared = qrcodePlugin.fieldWrites({ data: "https://x" }, "data", "");
  assert.deepEqual(cleared, { data: "" });
  assert.equal(qrDataIsEmpty(cleared.data), true, "clearing yields the documented ghost state");
  assert.equal(qrcodePlugin.isGhost(cleared), true);
  // …and the ghost is still double-clickable: hit testing is bbox-based (the
  // plugin declares no hitTest and capabilities.bbox is true), so it never asks
  // emit() what it drew. This is the assertion behind "a cleared code is fixable
  // from the toolbar".
  assert.equal(qrcodePlugin.capabilities.bbox, true);
  assert.equal(qrcodePlugin.hitTest, undefined, "no custom hitTest → the bbox default → a ghost stays clickable");
  console.log("OK round trip — every payload survives value→fieldWrites, and \"\" is a reachable, escapable ghost");
}

// ── An unknown field id is LOUD (no silent no-op write) ───────────────────────
{
  assert.throws(() => qrcodePlugin.fieldWrites({}, "ecLevel", "H"), /unknown field/);
  console.log("OK loud — an undeclared field id throws rather than silently writing nothing");
}

console.log("\nRESULT: PASS — QR double-click toolbar edits the encoded payload, ghost state included");
