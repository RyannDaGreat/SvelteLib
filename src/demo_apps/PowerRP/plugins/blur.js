/**
 * Blur layer — backdrop sampler with NO bbox and NO transform: it blurs
 * everything painted below its z. Exists partly to prove the architecture
 * holds for non-bbox widgets (select it via the inspector's item list; a
 * magnifier above it magnifies the blurred result).
 */

import { blurBackdrop } from "../render_gpu/ir.js";
import { props } from "../core/properties.js";

export const blurPlugin = {
  type: "blur",
  title: "Blur Layer",
  // backdrop:true also makes this widget uncullable — the renderer never
  // skips a backdrop sampler (it may read pixels anywhere on the canvas), so
  // blur needs no canSkip hook of its own (see core/view.js canSkipNode).
  //
  // NO `localBounds` HOOK, DELIBERATELY: this is the ONE widget that is honestly
  // UNBOUNDABLE (core/view.js localBoundsOf → null). A full-canvas backdrop blur
  // has no geometry whatsoever — there is genuinely no rect that describes where
  // it is, which is exactly why null means "can't prove it invisible, never cull"
  // and "nothing to enclose, not band-selectable". Every OTHER hookless widget in
  // the tree has a box; every two-point widget declares its endpoint hull. If a
  // future backdrop gains a region, it declares localBounds and joins the rest.
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: true },
  defaults: { type: "blur", z: 50, blur: 6, opacity: 1 },
  // Rows: the plugin-specific `blur` radius row (its own category), then the
  // shared registry `opacity` + `z` rows — so opacity/z stay in sync with every
  // other widget (labels, bounds, help, scrub) from the ONE registry.
  inspector: [
    { key: "blur", label: "Blur (world px)", kind: "number", min: 0, category: "blur", help: "How far the backdrop is blurred, in canvas units. Everything drawn below this layer is softened by this radius." },
    ...props("opacity"),
    ...props("z"),
  ],
  /** Pure function. A backdrop-blur op (no geometry — blurs the composite below this z). */
  emit(s) {
    if ((s.blur ?? 0) <= 0) return [];
    return [blurBackdrop({ radius: s.blur, opacity: s.opacity ?? 1 })];
  },
  commands: [
    { id: "add-blur", title: "Add Blur Layer", icon: "mdi:blur", run: (app) => app.addItem(blurPlugin.defaults) },
  ],
};
