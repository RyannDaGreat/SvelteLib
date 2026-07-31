/**
 * THE WEBGPU-ABSENCE CONSOLE LINE, in ONE place, because eight probes were red
 * for this single environment fact and each had to be told about it separately.
 *
 * WHAT IT IS. `plugins/demo/video_v7.js` asks for a WebGPU adapter through
 * `web/videoV7Gpu.js`. Headless Chromium on SwiftShader has none — the app proper
 * deliberately avoids `navigator.gpu` (CLAUDE.md: the Skia backend uses WebGL2 so
 * PowerRP works on plain HTTP, since WebGPU needs a secure context) and only the
 * videoV7 EXPERIMENT touches it. So videoV7Gpu.js catches the failure and REPORTS
 * the 2D fallback it took rather than dying quietly.
 *
 * WHY IGNORING IT IS RIGHT, AND NOT A WEAKENED ASSERTION. That console.error is
 * the CORRECT behaviour of a component reporting a degraded environment: loud
 * about a real limitation, exactly as the house rule demands. The probes that
 * tripped on it were not testing WebGPU at all — rotated_resize_probe checks
 * similarity-transform math, glass_probe checks backdrop CSS, upload_progress
 * checks byte counters. Every one of them PASSED its own subject matter and
 * failed only on this line leaking into a blanket "no console errors" check.
 * Treating an environment report as a defect in unrelated code is what made ~8
 * reds that said nothing about the code under test.
 *
 * WHY IT IS A SINGLE SENTENCE AND NOT /WebGPU/. A broad pattern would also
 * swallow a genuine WebGPU regression — a shader that fails to compile, an
 * adapter lost mid-run — in every probe that imported it. This matches only the
 * one line emitted when there is no adapter to begin with, so a NEW WebGPU error
 * still turns the gate red. Narrowness is the whole point: the goal is a gate
 * whose reds all mean something, not a quieter gate.
 *
 * Precedent for the pattern (each had rolled its own): creation_flows_probe.js,
 * keyframe_freeze_probe.js, panel_visibility_probe.js, bento_bind_probe.js,
 * boolean_uniformity_probe.js, paste_parity_probe.js, browser_render_harness.js.
 */

/** The exact line web/videoV7Gpu.js logs when the box has no WebGPU adapter. */
export const WEBGPU_ABSENT_NOISE = /VideoV7: WebGPU init failed — using 2D drawImage fallback/;

/**
 * Pure function. Is this console/page-error text the WebGPU-absence report?
 *
 * @param {string} text The captured console.error / pageerror message.
 * @returns {boolean}
 *
 * @example isWebGpuAbsenceNoise("console.error: VideoV7: WebGPU init failed — using 2D drawImage fallback: Error: VideoV7: no WebGPU adapter")
 * // true — the environment report every SwiftShader box emits
 * @example isWebGpuAbsenceNoise("console.error: VideoV7: shader compile failed")
 * // false — a REAL WebGPU defect still counts, which is why this is not /WebGPU/
 * @example isWebGpuAbsenceNoise("console.error: TypeError: x is undefined")
 * // false
 */
export function isWebGpuAbsenceNoise(text) {
  return WEBGPU_ABSENT_NOISE.test(String(text ?? ""));
}
