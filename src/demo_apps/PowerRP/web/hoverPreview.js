/*
  hoverPreview — the shared "point at an option, see it LIVE on the canvas, leave
  and it reverts" trope (FontPicker / GradientPresetPicker), factored so every
  material UI that offers a CHOICE (the PaintField material dropdown here; the
  brush palette and material presets elsewhere) drives it the same way.

  The one contract it enforces is the manifest's hover doctrine — "the document is
  never mutated by hovering": a hover stages an app.previewDelta (the viewport
  re-renders, NO undo entry) and registers the revert as app.transientPreview, so
  any dismissal path that would otherwise COMMIT the staged value (exitCanvasMode)
  reverts instead. It is web/ListField.svelte's previewPreset/cancelPresetPreview
  pair, lifted out of that one field so it is not re-implemented per consumer.

  It deliberately owns NO Svelte effect. The effect that keys previews off "which
  option is focused" belongs to the CONSUMER (SvelteLib Dropdown already has one,
  guarded; FontPicker has its own untrack()'d one) — putting an effect here would
  hand every consumer the effect_update_depth_exceeded footgun the FontPicker
  header documents. This factory returns plain command callbacks the consumer
  wires to its own onpreview / oncancelpreview.
*/

/**
 * Command factory. Returns the {preview, cancel} callback pair a hover-preview
 * consumer wires to its option list — `preview(option)` stages the live preview
 * and arms the transient revert; `cancel()` drops both. Not pure: both callbacks
 * mutate app.previewDelta / app.transientPreview (a Command each).
 *
 * @param {object} app - the app controller (setPreview / cancelPreview / the
 *   transientPreview slot).
 * @param {(option:any) => Array} toPairs - maps the hovered option to the
 *   [path, value] pairs app.setPreview takes (the SAME write the consumer's real
 *   commit performs, staged instead of committed).
 * @returns {{preview: (option:any)=>void, cancel: ()=>void}}
 *
 * @example
 * // const h = makeHoverPreview(app, (id) => [[["items", itemId, "fill", "material", "id"], id]]);
 * // <Dropdown onpreview={h.preview} oncancelpreview={h.cancel} … />
 * // h.preview("crt") // stages fill.material.id = "crt" as a live preview
 * // h.cancel()       // reverts it; the document was never touched
 */
export function makeHoverPreview(app, toPairs) {
  return {
    preview(option) {
      app.setPreview(toPairs(option));
      app.transientPreview = () => app.cancelPreview();
    },
    cancel() {
      app.transientPreview = null;
      app.cancelPreview();
    },
  };
}
