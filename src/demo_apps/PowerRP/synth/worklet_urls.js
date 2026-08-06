/**
 * EVERY PORT BLOCK'S PROCESSOR URL — and the ONE file that may contain Vite-only syntax.
 *
 * ── WHY THIS FILE EXISTS: TWO TRUE REQUIREMENTS THAT COLLIDE ─────────────────
 * 1. **PRODUCTION NEEDS `?worker&url`.** Measured by AX-3 on this repo's vite 6.4.3: a
 *    processor named with `new URL("./w/proc.js", import.meta.url)` is emitted as a
 *    BYTE-FOR-BYTE COPY, so its own `import { … } from "../kernels.js"` survives into
 *    dist — and the kernel file **is never emitted**. The worklet fetches it, gets a
 *    404, `addModule` rejects, and there is NO AUDIO AT ALL, off a build that exited 0
 *    with no warning. Under `assetsInlineLimit` it is worse: the processor becomes a
 *    `data:` URL, and a relative specifier inside a data: URL has no base to resolve.
 *    `?worker&url` emits a bundled IIFE — imports inlined, `registerProcessor` intact,
 *    correct in dev AND build.
 * 2. **BARE NODE CANNOT PARSE `?worker&url`.** It is a Vite query suffix, so any module
 *    holding one is un-importable by `node`. `synth/modules.js` imports every block's
 *    factories, and the whole node test lane imports that — so a Vite-only specifier
 *    anywhere in that graph takes the entire bare-node gate down with it.
 *
 * ── THE RESOLUTION: ONE QUARANTINE, REACHED ONLY BY A DYNAMIC IMPORT ─────────
 * The URLs live here and nowhere else. `synth/modules_ax<N>.js` stays plain ES modules
 * that bare node can read, so the factories, the spec↔engine coverage sweep and every
 * port test keep working. **A block must NOT export its own worklet URL** — that is what
 * put a Vite specifier in the bare-node graph in the first place.
 *
 * **AND THE ONE IMPORT OF THIS FILE MUST BE `await import(…)`, NOT A STATIC IMPORT.**
 * That is the half the first attempt missed, and it cost a red the same day: `engine.js`
 * imported these names statically, and because bare node LINKS a static import before
 * running a line, `tests/audio_mute_test.js` died with
 * `SyntaxError: … does not provide an export named 'default'` merely for importing the
 * engine. Keeping the specifier out of `modules.js`'s graph is not enough when
 * `engine.js` is in the node lane too — a quarantine with a static door is not a
 * quarantine. `engine.portBlockWorkletUrls()` is that dynamic door and the only one;
 * node never opens it because node never calls `init()`. Vite bundles a dynamic import
 * and rewrites these URLs exactly as it does a static one, so nothing is given up.
 *
 * THE RULE THE TWO HALVES MAKE TOGETHER, and they are not separable: **a worklet MAY
 * statically import (module worklets take imports on this Chrome — measured), but only if
 * its URL goes through the worker pipeline.** Import without the pipeline is the silent
 * 404 above; the pipeline without the quarantine is a dead node gate.
 *
 * The ENGINE LAW is untouched: every specifier here is `./…`.
 */

/** AX-1 — arithmetic, logic, step tables. */
export { default as AX1_WORKLET_URL } from "./worklets/processors_ax1.js?worker&url";
/** AX-2 — oscillators, LFOs, noise, random. Imports `../ax2_kernels.js`, so the pipeline
 *  is load-bearing here, not cosmetic. */
export { default as AX2_WORKLET_URL } from "./worklets/processors_ax2.js?worker&url";
/** AX-3 — filters. Imports `../ax3_kernels.js`; this is the block that measured the rule. */
export { default as AX3_WORKLET_URL } from "./worklets/processors_ax3.js?worker&url";
/** VC-1 — VCV Rack / Mutable Instruments ports: Clouds, Rings, Marbles, Supercell,
 *  Branches, Blinds, Shades. Imports `../vc1_kernels.js`. */
export { default as VC1_WORKLET_URL } from "./worklets/processors_vc1.js?worker&url";
/** VC-2 — VCV Fundamental + Core: VCA, Noise, Octave, Quantizer, Delay, VCMixer,
 *  ADSR, VCF, SequentialSwitch2, LFO, Random, Compare, SEQ3, Sum, AudioInterface,
 *  Rescale. Imports `../vc2_kernels.js`. */
export { default as VC2_WORKLET_URL } from "./worklets/processors_vc2.js?worker&url";
/** VC-3a — Bogaudio part 1: FMOp, LFO, ADSR, DADSRH, AddrSeq, 8:1, Bool, Mix4, Manual.
 *  Imports `../vc3a_kernels.js`, so the worker pipeline is load-bearing here. */
export { default as VC3A_WORKLET_URL } from "./worklets/processors_vc3a.js?worker&url";
/** VC-3b — Bogaudio part 2: PEQ, VCO, VCF, SampleHold, Walk, Pressor, VCA, VCM,
 *  XFade, Offset, Switch, Stack. Imports `../vc3b_kernels.js`. */
export { default as VC3B_WORKLET_URL } from "./worklets/processors_vc3b.js?worker&url";
/** VC-5 — Valley/FrozenWasteland/other large FX: Plateau, Chronoblob2, Feline,
 *  Terrorform, JustAPhaser, SPF, rewin, reburst, XFXF35. Imports `../vc5_kernels.js`. */
export { default as VC5_WORKLET_URL } from "./worklets/processors_vc5.js?worker&url";
