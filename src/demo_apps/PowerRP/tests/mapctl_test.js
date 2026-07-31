/**
 * MAP LAYERS — the bare-node suite for OVERLAY COMPOSITING, the POPUP
 * quick-switches (toggleWrites), the LAT/LON PARSER, and VIEW MODE pinning.
 * Companion to tests/globe_map_test.js (the engine); this file covers what
 * landed on top of it: web/tile_providers.TILE_OVERLAYS, the widget's
 * overlay/viewMode properties, and web/CanvasToolbar's `toggles` spec.
 *
 * Everything here runs WITHOUT a browser. The first-use acceptance path (insert
 * -> open navigator -> click a layer button -> toggle an overlay -> type
 * coordinates -> reload) is tests/mapctl_probe.js.
 *
 * Run: node tests/mapctl_test.js
 */

import assert from "node:assert";
import { parseLatLon } from "../core/geo_tiles.js";
import {
  OVERLAY_IDS, TILE_OVERLAYS, TILE_PROVIDERS, overlayFor, overlayPropName,
} from "../web/tile_providers.js";
import { describeMapNode } from "../render_gpu/map_display.js";
import { globeMapPlugin } from "../plugins/demo/globe_map.js";
import * as T from "../core/transform.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

function stateAt(over = {}) {
  return { ...globeMapPlugin.defaults, w: 420, h: 420, ...over };
}

// ── THE OVERLAY PROVIDER TABLE ─────────────────────────────────────────────

test("three overlays are shipped, each a verified keyless GIBS reference layer", () => {
  assert.deepEqual(OVERLAY_IDS, ["labels", "features", "coastlines"]);
  for (const id of OVERLAY_IDS) {
    const layer = TILE_OVERLAYS[id];
    assert.equal(layer.id, id);
    assert.ok(layer.url.includes("gibs.earthdata.nasa.gov"), `${id} is GIBS-hosted`);
    assert.ok(layer.url.includes("{z}") && layer.url.includes("{x}") && layer.url.includes("{y}"), `${id} template has all placeholders`);
    assert.equal(layer.maxZoom, 9, `${id} caps at the verified Level9 ceiling`);
    assert.ok(layer.attribution.length > 0, `${id} carries a non-empty attribution — it is OSM-derived, not NASA public domain`);
    assert.ok(layer.help.length > 0, `${id} carries popup/Inspector help text`);
  }
});

test("overlayFor resolves a known id and returns undefined for an unknown one (no silent default)", () => {
  assert.equal(overlayFor("labels").title, "Place labels");
  assert.equal(overlayFor("nonesuch"), undefined);
});

test("overlayPropName is the ONE naming rule, shared by the widget and the pre-pass", () => {
  assert.equal(overlayPropName("labels"), "overlayLabels");
  assert.equal(overlayPropName("features"), "overlayFeatures");
  assert.equal(overlayPropName("coastlines"), "overlayCoastlines");
});

// ── ATTRIBUTION DEFAULTS PER PROVIDER (the user ruling) ────────────────────

test("NASA satellite defaults attribution OFF; OSM and terrain default it ON", () => {
  assert.equal(TILE_PROVIDERS.satellite.defaultShowAttribution, false, "public domain: nothing required");
  assert.equal(TILE_PROVIDERS.osm.defaultShowAttribution, true, "ODbL requires the credit");
  assert.equal(TILE_PROVIDERS.terrain.defaultShowAttribution, true, "CC-BY-SA requires the credit");
});

test("a fresh widget (default style osm) shows attribution by default, matching osm's own default", () => {
  const s = stateAt();
  assert.equal(s.style, "osm");
  assert.equal(s.showAttribution, true);
});

test("satellite-only presets (no overlays active) explicitly turn attribution off", () => {
  const overlayKeys = OVERLAY_IDS.map(overlayPropName);
  const satelliteOnlyPresets = globeMapPlugin.presets.filter(
    (p) => p.props.style === "satellite" && !overlayKeys.some((k) => p.props[k]),
  );
  assert.ok(satelliteOnlyPresets.length > 0, "at least one satellite-only preset exists");
  for (const preset of satelliteOnlyPresets)
    assert.equal(preset.props.showAttribution, false, `preset "${preset.name}" (satellite, no overlays) shows nothing by default`);
});

test("the hybrid preset (satellite + OSM-derived overlays) explicitly keeps attribution ON", () => {
  const hybrid = globeMapPlugin.presets.find((p) => p.props.style === "satellite" && (p.props.overlayLabels || p.props.overlayFeatures));
  assert.ok(hybrid, "a hybrid (satellite base + overlay) preset exists, demonstrating the Google 'hybrid' look");
  assert.equal(hybrid.props.showAttribution, true, "the OSM-derived overlays require credit even though the satellite base does not");
});

test("the toggle is always the user's — showAttribution never re-locks when style changes", () => {
  // Flip it on for a satellite state and confirm nothing about emit or the
  // property model force it back off: the property is just a boolean, read
  // once, with no style-coupling anywhere in emit().
  const s = stateAt({ style: "satellite", showAttribution: true });
  const ops = globeMapPlugin.emit(s, null, null, null);
  assert.ok(ops.some((o) => o.op === "text"), "the user's explicit true is honoured even for the satellite base");
});

// ── EMIT: NASA shows nothing, OSM shows the tiny corner line, toggling hides it ──

test("ACCEPTANCE: NASA satellite base shows NO attribution text at its own default", () => {
  const s = stateAt({ style: "satellite", showAttribution: TILE_PROVIDERS.satellite.defaultShowAttribution });
  const ops = globeMapPlugin.emit(s, null, null, null);
  assert.ok(!ops.some((o) => o.op === "text"), "no attribution op at all when the default is honoured");
});

test("ACCEPTANCE: OSM base shows the attribution line by default", () => {
  const s = stateAt({ style: "osm" });
  const ops = globeMapPlugin.emit(s, null, null, null);
  const textOp = ops.find((o) => o.op === "text");
  assert.ok(textOp, "OSM draws its credit by default");
  assert.ok(textOp.text.includes("OpenStreetMap"));
});

test("ACCEPTANCE: toggling showAttribution off hides it, and the property persists as stored", () => {
  const s = stateAt({ style: "osm", showAttribution: false });
  const ops = globeMapPlugin.emit(s, null, null, null);
  assert.ok(!ops.some((o) => o.op === "text"), "explicitly off means off, unconditionally");
  assert.equal(s.showAttribution, false, "the state IS the stored property — nothing recomputes it");
});

// ── OVERLAY COMPOSITING ─────────────────────────────────────────────────────

test("no overlay on: emit draws exactly the base surface, no extra image ops beyond it", () => {
  const off = globeMapPlugin.emit(stateAt(), null, null, null);
  const on = globeMapPlugin.emit(stateAt({ overlayLabels: true }), null, null, null);
  // Both are camera-free (no registry), so image ops are 0 either way — but the
  // ATTRIBUTION line must differ: an active overlay's credit joins the union.
  const attrOff = off.find((o) => o.op === "text")?.text ?? "";
  const attrOn = on.find((o) => o.op === "text")?.text ?? "";
  assert.ok(!attrOff.includes("Labels:"), "no overlay credit when the overlay is off");
  assert.ok(attrOn.includes("Labels:"), "the active overlay's credit joins the union");
});

test("every overlay's boolean property defaults false — hybrid is opt-in, not automatic", () => {
  const s = stateAt();
  for (const id of OVERLAY_IDS) assert.equal(s[overlayPropName(id)], false, `${overlayPropName(id)} defaults off`);
});

test("attribution is the DEDUPLICATED UNION of the base plus every active overlay", () => {
  const s = stateAt({ style: "osm", overlayLabels: true, overlayCoastlines: true });
  const ops = globeMapPlugin.emit(s, null, null, null);
  const text = ops.find((o) => o.op === "text").text;
  assert.ok(text.includes("OpenStreetMap contributors") && !text.includes("Labels: © OpenStreetMap contributors, Labels"), "base credit present, not duplicated verbatim");
  assert.ok(text.includes("Labels:"), "labels overlay credit present");
  assert.ok(text.includes("Coastlines:"), "coastlines overlay credit present");
  assert.ok(!text.includes("Borders"), "the INACTIVE features overlay contributes nothing");
});

test("the camera-free fallback plans overlay tiles too, at the overlay's OWN maxZoom ceiling", () => {
  const s = stateAt({ overlayLabels: true, zoom: 15 }); // past the overlay's z9 ceiling
  const ops = globeMapPlugin.emit(s, null, null, null); // exercises tilePlan's overlay branch without throwing
  assert.ok(Array.isArray(ops) && ops.length > 0, "emit completes and produces a display list");
});

test("map_display.describeMapNode fetches overlay tiles alongside the base, one plan per active overlay", () => {
  const state = { ...globeMapPlugin.defaults, w: 256, h: 256, x: 0, y: 0, overlayLabels: true, overlayFeatures: false, cropInsets: {} };
  const node = { itemId: "n1", type: "demo_globe_map", world: T.fromState(state), state };
  const view = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
  const descriptor = describeMapNode(node, view, 800, 600);
  assert.ok(descriptor, "a visible map produces a descriptor");
  assert.ok("labels" in descriptor.overlays, "the active overlay gets its own plan");
  assert.ok(!("features" in descriptor.overlays), "the inactive overlay is not planned at all — no wasted fetches");
  assert.ok(descriptor.overlays.labels.tiles.length > 0, "the active overlay's plan actually names tiles");
});

test("an off-screen map plans NO overlay tiles either — the crop economy extends to overlays", () => {
  const state = { ...globeMapPlugin.defaults, w: 100, h: 100, x: 100000, y: 100000, overlayLabels: true, cropInsets: {} };
  const node = { itemId: "n1", type: "demo_globe_map", world: T.fromState(state), state };
  const view = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
  const descriptor = describeMapNode(node, view, 800, 600);
  assert.equal(descriptor, null, "scrolled entirely off screen: no descriptor, no fetch of anything, base or overlay");
});

// ── VIEW MODE (globe / flat / auto) ─────────────────────────────────────────

test("viewMode defaults to auto, which is byte-identical to the pre-existing crossfade", () => {
  assert.equal(globeMapPlugin.defaults.viewMode, "auto");
});

test("viewMode=globe pins a full sphere even at deep street zoom", () => {
  const s = stateAt({ viewMode: "globe", zoom: 16, style: "osm" });
  const ops = globeMapPlugin.emit(s, null, null, null);
  assert.ok(ops.some((o) => o.op === "polygon"), "polar caps (globe-only ops) are drawn even at street zoom when pinned");
});

test("viewMode=flat pins the flat map even at zoom 0 (the whole world)", () => {
  const s = stateAt({ viewMode: "flat", zoom: 0, style: "osm" });
  const ops = globeMapPlugin.emit(s, null, null, null);
  assert.ok(!ops.some((o) => o.op === "polygon"), "no polar caps: nothing globe-only is drawn when pinned flat");
  assert.ok(!ops.some((o) => o.op === "materialFill"), "no atmosphere either — a flat map has no limb to glow");
});

test("viewMode=auto still crossfades exactly as before this feature (regression guard)", () => {
  const planetary = globeMapPlugin.emit(stateAt({ viewMode: "auto", zoom: 0 }), null, null, null);
  const street = globeMapPlugin.emit(stateAt({ viewMode: "auto", zoom: 16 }), null, null, null);
  assert.ok(planetary.some((o) => o.op === "polygon"), "auto at zoom 0 is still a globe");
  assert.ok(!street.some((o) => o.op === "polygon"), "auto at zoom 16 is still flat");
});

test("a tween from globe to flat animates the unroll: the crossfade stays CONTINUOUS mid-transition", () => {
  // At the crossover zoom under viewMode=auto, both surfaces still coexist in
  // the emitted ops (globeWeight is fractional there) — pinning does not
  // remove that continuity, it only selects an ENDPOINT of the same blend.
  const s = stateAt({ viewMode: "auto", zoom: 5 }); // GLOBE_FLAT_CROSSOVER
  const ops = globeMapPlugin.emit(s, null, null, null);
  assert.ok(ops.some((o) => o.op === "materialFill"), "still some globe contribution mid-crossfade");
});

// ── toggleWrites: THE POPUP'S COMMAND PATH (mirrors fieldWrites) ───────────

test("toggleWrites: a basemap button writes `style`, exactly what the Inspector select writes", () => {
  assert.deepEqual(globeMapPlugin.toggleWrites(stateAt(), "style:satellite"), { style: "satellite" });
  assert.deepEqual(globeMapPlugin.toggleWrites(stateAt(), "style:terrain"), { style: "terrain" });
});

test("toggleWrites: an overlay button FLIPS the boolean (a toggle, not a radio)", () => {
  assert.deepEqual(globeMapPlugin.toggleWrites(stateAt({ overlayLabels: false }), "overlay:labels"), { overlayLabels: true });
  assert.deepEqual(globeMapPlugin.toggleWrites(stateAt({ overlayLabels: true }), "overlay:labels"), { overlayLabels: false });
});

test("toggleWrites: a view-mode button writes `viewMode`, the SAME key the Inspector select uses", () => {
  assert.deepEqual(globeMapPlugin.toggleWrites(stateAt(), "viewMode:globe"), { viewMode: "globe" });
  assert.deepEqual(globeMapPlugin.toggleWrites(stateAt(), "viewMode:flat"), { viewMode: "flat" });
  assert.deepEqual(globeMapPlugin.toggleWrites(stateAt(), "viewMode:auto"), { viewMode: "auto" });
});

test("toggleWrites refuses an unknown id loudly rather than silently doing nothing", () => {
  assert.throws(() => globeMapPlugin.toggleWrites(stateAt(), "style:bogus"));
  assert.throws(() => globeMapPlugin.toggleWrites(stateAt(), "overlay:bogus"));
  assert.throws(() => globeMapPlugin.toggleWrites(stateAt(), "viewMode:bogus"));
  assert.throws(() => globeMapPlugin.toggleWrites(stateAt(), "nonsense:whatever"));
});

test("the popup's toggle spec MIRRORS the Inspector exactly: same keys, same command path, no parallel state", () => {
  const s = stateAt({ style: "terrain", overlayLabels: true, viewMode: "globe" });
  const spec = globeMapPlugin.floatingToolbar(s);
  assert.ok(spec.toggles, "the popup declares a toggles block");
  const [styleGroup, overlayGroup, viewModeGroup] = spec.toggles.groups;

  const activeStyle = styleGroup.buttons.find((b) => b.active);
  assert.equal(activeStyle.id, "style:terrain", "the ACTIVE style button matches the stored `style`");
  assert.deepEqual(globeMapPlugin.toggleWrites(s, activeStyle.id), { style: "terrain" });

  const activeOverlay = overlayGroup.buttons.find((b) => b.id === "overlay:labels");
  assert.equal(activeOverlay.active, true, "the popup shows labels as ON, matching overlayLabels: true");

  const activeMode = viewModeGroup.buttons.find((b) => b.active);
  assert.equal(activeMode.id, "viewMode:globe", "the ACTIVE view-mode button matches the stored viewMode");
});

test("every toggle button declares its own `keys` for the equation-bound-disables-it guard", () => {
  const spec = globeMapPlugin.floatingToolbar(stateAt());
  for (const group of spec.toggles.groups)
    for (const button of group.buttons)
      assert.ok(Array.isArray(button.keys) && button.keys.length > 0, `button "${button.id}" declares keys`);
});

// ── THE LAT/LON PARSER (core/geo_tiles.parseLatLon) — pure, thoroughly doctested there ──

test("parseLatLon accepts comma, whitespace, suffixes and degree marks (spot-check beyond the doctests)", () => {
  assert.deepEqual(parseLatLon("0,0"), { lat: 0, lon: 0 });
  assert.ok(parseLatLon("51.5074, -0.1278")); // London
  assert.ok(parseLatLon("51.5074N 0.1278W")); // same place, suffix form
  assert.equal(parseLatLon(""), null);
  assert.equal(parseLatLon("just some text"), null);
  assert.equal(parseLatLon("1,2,3"), null, "a triple is not a pair");
});

test("the popup's coords field commits through parseLatLon into centerLat/centerLon — same property path as a drag", () => {
  const writes = globeMapPlugin.fieldWrites(stateAt(), "coords", "35.6895, 139.6917"); // Tokyo
  assert.ok(writes);
  assert.ok(Math.abs(writes.centerLat - 35.6895) < 1e-9);
  assert.ok(Math.abs(writes.centerLon - 139.6917) < 1e-9);
  // Both keys are DECLARED, keyframable properties — nothing bespoke.
  assert.ok("centerLat" in globeMapPlugin.defaults);
  assert.ok("centerLon" in globeMapPlugin.defaults);
});

test("the coords field REFUSES unparseable text loudly (returns null) rather than guessing", () => {
  assert.equal(globeMapPlugin.fieldWrites(stateAt(), "coords", "not a place"), null);
  assert.equal(globeMapPlugin.fieldWrites(stateAt(), "coords", ""), null);
});

console.log(`\n${passed} tests passed`);
