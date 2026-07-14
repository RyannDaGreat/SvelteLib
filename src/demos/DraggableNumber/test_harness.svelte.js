/**
 * Test-only harness (`.svelte.js` so it can use runes). Imported INSIDE the
 * page by the puppeteer test via a Vite-served URL, so Vite rewrites the bare
 * `svelte` specifier (browsers can't resolve bare specifiers). Re-exports the
 * mount API + component, and provides a REACTIVE value box: mounting the
 * component with `box`'s get/set makes `bind:value`-equivalent reactivity work,
 * so the component's own derived display re-renders on internal assignment.
 */
export { mount, unmount, tick } from "svelte";
export { default as DraggableNumber } from "../../lib/DraggableNumber.svelte";

/** Command. A reactive value cell backed by $state, so both the parent and the
    component observe changes (mimics a real `bind:value`). */
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
