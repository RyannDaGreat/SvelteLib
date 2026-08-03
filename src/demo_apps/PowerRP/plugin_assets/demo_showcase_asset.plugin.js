// demo_showcase_asset.plugin.js — THE MIGRATION PROOF (dogfood test).
//
// This is plugins/demo/showcase.js, re-expressed as a PLUGIN ASSET, line for
// line. It exists to answer ONE question that no amount of new-widget authoring
// can: is the plugin-asset interface COMPLETE, or does it merely look complete
// because the two proof widgets were written to fit whatever it happened to
// offer? Porting an EXISTING built-in — chosen before the interface was frozen,
// not designed against it — is the only test that can fail honestly.
//
// WHY showcase.js. It was picked for having NO special seams: no asset refs, no
// GPU registry, no `commands`, no two-point endpoints, no material — just the
// shared property registry, the IR, `applyEffects`, and `standardBBoxAnchors`.
// If the interface cannot carry THAT, it carries nothing.
//
// WHAT THE PORT REQUIRED. Two edits, both mechanical:
//   1. the `import` lines are gone (the sandbox has no module loader; the same
//      bindings arrive from the host — see core/plugin_assets.js HOST_MODULES),
//   2. `export const demoShowcasePlugin = {…}` became `return {…}`.
// Everything else — the custom self.* prop, the defaults, the composed inspector
// rows, the emit body, cullMargin, anchors — is UNCHANGED TEXT. That is the
// result the round was after: the asset format is not a second plugin API, it is
// the same API delivered by a different route.
//
// THE ONE DELIBERATE DIFFERENCE is `type`. It must be "demo_showcase_asset", not
// "demo_showcase", because the built-in is still registered and the loader
// REFUSES a colliding type rather than shadowing it (core/plugin_assets.js
// loadPluginAsset). That refusal is a feature, not an obstacle to route around:
// silently replacing a built-in in a deck someone shared would repaint a document
// its author never saw. Having both registered side by side is also what lets
// tests/plugin_assets_test.js assert PARITY — it emits both and compares the IR.

const INSET_DEFAULT = 18; // canvas units the inner outline sits in from each edge
const CUSTOM = customProps([
  {
    name: "inset",
    kind: "number",
    default: INSET_DEFAULT,
    min: 0,
    help: "A CUSTOM self.* property this demo widget declares. Draws a second outline this many canvas units inside the box; edit it as a number or a `= self.w / 4`-style equation, and reference it elsewhere as self.inset.",
  },
]);

return {
  type: "demo_showcase_asset",
  title: "Demo Showcase (asset)",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "demo_showcase_asset", x: 140, y: 140, w: 240, h: 160, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#9ece6a", stroke: "#000000", strokeWidth: 2,
    ...defaults("cornerRadius", "opacity"), // cornerRadius:0, opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
    ...CUSTOM.defaults, // inset — the custom self.* prop
  },
  inspector: [
    ...bundle("transform"),
    ...bundle("strokedBox"),
    ...props("opacity"),
    ...CUSTOM.rows,
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → display-list commands (local space) — THE render API.
   * Byte-identical logic to plugins/demo/showcase.js's emit: the outer
   * filled+stroked box, then an inner outline inset by `inset` on every edge when
   * it still encloses a positive area.
   *
   * NOTE this one calls applyEffects ITSELF, exactly as the built-in does. That
   * is not incidental: because it declares the effects rows in its inspector,
   * core/registry.js composesEffects() sees the bundle already composed and the
   * universal injector leaves it alone — so the asset must own the render half
   * too, or its five effect rows would be inert. It is the same rule a source
   * plugin obeys, which is the point of the port.
   */
  emit(s, _targetWorldIR, world) {
    const inset = Math.max(0, s.inset ?? 0);
    const strokeW = s.strokeWidth ?? 0;
    const stroke = strokeW > 0 ? s.stroke : null;
    const cornerRadius = s.cornerRadius ?? 0;
    const opacity = s.opacity ?? 1;
    const ops = [rect({
      x: 0, y: 0, w: s.w, h: s.h,
      cornerRadius, fill: s.fill,
      stroke, strokeWidth: strokeW, opacity,
    })];
    const innerW = s.w - inset * 2, innerH = s.h - inset * 2;
    if (inset > 0 && innerW > 0 && innerH > 0) {
      ops.push(rect({
        x: inset, y: inset, w: innerW, h: innerH,
        cornerRadius: Math.max(0, cornerRadius - inset),
        fill: null, stroke, strokeWidth: strokeW, opacity,
      }));
    }
    return applyEffects(ops, s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
};
