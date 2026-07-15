/**
 * Test-only harness (`.svelte.js` so it can use runes). Imported INSIDE the
 * page by the puppeteer test via a Vite-served URL, so Vite rewrites the bare
 * `svelte` specifier. Re-exports the mount API + component, plus the pure
 * color-math helpers (so the test can assert them directly), and a REACTIVE
 * value box so `bind:value`-equivalent reactivity works.
 */
export { mount, unmount, tick } from "svelte";
export {
  default as ColorPicker,
  hexToRgba,
  rgbaToHex,
  hsvaToRgba,
  rgbaToHsva,
  isHex,
  hexByte,
  clamp,
  trackFraction,
} from "../../lib/ColorPicker.svelte";

/** Command. A reactive value cell backed by $state, mimicking a real
    `bind:value` so both the parent and the component observe changes. */
export function makeValueBox(initial) {
  let v = $state(initial);
  return {
    get value() {
      return v;
    },
    set value(nv) {
      v = nv;
    },
  };
}
