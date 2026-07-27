/**
 * V8 video overlay — backend SELECTOR.
 *
 * PowerRP's HTTPS-independence tenant: the editor must work on plain HTTP, where
 * `navigator.gpu` is absent (WebGPU needs a secure context). So the overlay picks
 * its backend AT RUNTIME:
 *   - Backend A — WebGPU zero-copy (importExternalTexture): chosen when a WebGPU
 *     device actually resolves (secure context + adapter present).
 *   - Backend B — WebGL2 upload (texImage2D from the element, GPU-side): the plain
 *     HTTP fallback; always available where the Skia scene renderer runs (that is
 *     itself WebGL2).
 *
 * The choice is REPORTED, never silent: on a WebGPU failure it logs why and falls
 * back to WebGL2 (a load error is loud; a graceful capability fallback is a stated
 * decision). If BOTH fail, it throws — there is no third silent tier.
 *
 * DOM/GPU-facing (not core/).
 */

import { createVideoV8WebGPUBackend } from "./videoV8_webgpu.js";
import { createVideoV8WebGL2Backend } from "./videoV8_webgl2.js";

/**
 * Query. Is the WebGPU path even worth attempting? True only when
 * `navigator.gpu` is present (a secure context). A false here means "use WebGL2"
 * with no async probe — the common plain-HTTP case.
 *
 * @returns {boolean}
 * @example // in a plain-HTTP tab: webgpuMaybeAvailable() === false
 */
export function webgpuMaybeAvailable() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

/**
 * Command (async; creates GPU resources). Selects and builds the overlay backend
 * for `canvas`: WebGPU when a device resolves, else WebGL2. Returns the backend
 * {kind, draw, dispose}. Throws only if BOTH backends fail (no silent no-op
 * renderer).
 *
 * @param {HTMLCanvasElement} canvas the overlay canvas
 * @param {{preferWebGL2?: boolean}} [opts] preferWebGL2 forces the fallback (tests / A-B)
 * @returns {Promise<{kind: string, draw: (quads: Array) => void, dispose: () => void}>}
 */
export async function selectVideoV8Backend(canvas, { preferWebGL2 = false } = {}) {
  if (!preferWebGL2 && webgpuMaybeAvailable()) {
    try {
      const backend = await createVideoV8WebGPUBackend(canvas);
      console.info("PowerRP videoV8: using WebGPU zero-copy overlay backend");
      return backend;
    } catch (e) {
      // Reported, not swallowed: WebGPU was present but unusable (no adapter,
      // device lost, etc.) — fall back to WebGL2 and say so.
      console.warn(`PowerRP videoV8: WebGPU backend unavailable, falling back to WebGL2 — ${e?.message ?? e}`);
    }
  }
  const backend = createVideoV8WebGL2Backend(canvas);
  console.info("PowerRP videoV8: using WebGL2 upload overlay backend");
  return backend;
}
