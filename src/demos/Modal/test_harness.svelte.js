/**
 * Test-only harness (`.svelte.js` so it can use runes). Imported INSIDE the
 * page by the puppeteer test via a Vite-served URL, so Vite rewrites the bare
 * `svelte` specifier (browsers can't resolve bare specifiers). Re-exports the
 * mount API + component, and provides a REACTIVE open box: mounting the
 * component with `box`'s get/set makes `bind:open`-equivalent reactivity work.
 */
export { mount, unmount, tick } from "svelte";
export { default as Modal } from "../../lib/Modal.svelte";

/** Command. A reactive boolean cell backed by $state, so both the "parent"
    and the component observe changes (mimics a real `bind:open`). */
export function makeOpenBox(initial) {
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
