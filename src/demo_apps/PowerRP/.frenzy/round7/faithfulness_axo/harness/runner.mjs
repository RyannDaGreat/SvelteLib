/**
 * runner.mjs — compile a generated object harness and drive it.
 *
 * Command throughout: it writes to `build/` and shells out to g++.
 *
 * THE FRAC32 CONVENTION, ONCE, HERE. Everything crossing this boundary is int32
 * in the object's own units; the caller works in FLOAT, where 1.0 is full scale
 * (frac32 Q27, `FRAC32_ONE = 2^27`). `toFrac32` and `fromFrac32` are the only
 * two places that conversion happens, so a factor-of-64 slip has one home.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, loadObject } from "./gen.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
export const BUILD = join(ROOT, "build");

/** Where the read-only Axoloti clones live. `clone.sh` puts them here. */
export const AXO_FACTORY = process.env.AXO_FACTORY ?? "/tmp/axoloti_factory";
export const AXO_FIRMWARE = process.env.AXO_SRC ?? "/tmp/axoloti_src";

/** frac32 is signed Q27: a dial reading 64 is 1.0, and 1.0 is 2^27. */
export const FRAC32_ONE = 2 ** 27;
/** Their audio buffer, `api/axoloti.h:BUFSIZE`. One k-rate tick per buffer. */
export const BUFSIZE = 16;
/** Their sample rate, `api/axoloti.h:SAMPLERATE`. The C side is hardwired to it. */
export const AX_SAMPLE_RATE = 48000;
/** 48000 / 16 = 3000 Hz. Eight k-rate ticks per 128-sample WebAudio quantum. */
export const AX_CONTROL_RATE = AX_SAMPLE_RATE / BUFSIZE;

/**
 * THE TWO FLAGS THAT DECIDE WHAT "THE ORIGINAL" MEANS, AND WHY THEY ARE ON.
 *
 * MEASURED 2026-08-07, and it changed a result by an OCTAVE. `osc/pwm`'s edge
 * test is `((osc_p - pwmp) > 0) && !((p - pwmp) > 0)`, and at the default pulse
 * width `pwmp` is exactly `((1<<27) + 0) << 4` == INT32_MIN. Subtracting
 * INT32_MIN from a positive int32 is signed overflow — UNDEFINED in C — so gcc
 * -O2 is entitled to fold `(x - INT32_MIN) > 0` into `x > INT32_MIN`, which is
 * true for nearly every x, and then `!(p > INT32_MIN)` is false for nearly
 * every p. The falling edge THEREFORE NEVER FIRES and the reference played a
 * square AN OCTAVE DOWN. That is a property of the host compiler's licence to
 * assume no overflow, not a property of the object.
 *
 * The ARM the object was written for wraps, two's complement, always — the
 * instruction has no other behaviour. `-fwrapv` is how you say that to gcc, and
 * with it the pw=0 case plays a 50% square at the note pitch, which is what an
 * Axoloti does. `-fno-strict-aliasing` is here for the same class of reason:
 * several objects type-pun int32/float through unions and pointers, and
 * axoloti_math.h's own `Float_t` is exactly that.
 *
 * RECORDED AS AN ASSUMPTION, because the shipping firmware Makefile uses plain
 * `-O2` with neither flag. We are therefore comparing against the MACHINE
 * semantics the author wrote for, not against a hypothetical arm-gcc build that
 * might make the same UB choice this host's gcc did.
 */
const FLAGS = ["-fwrapv", "-fno-strict-aliasing"];

/** Pure function. float (1.0 == full scale) -> int32 frac32. @example toFrac32(1) // 134217728 */
export const toFrac32 = (v) => Math.max(-2147483648, Math.min(2147483647, Math.round(v * FRAC32_ONE)));
/** Pure function. int32 frac32 -> float. @example fromFrac32(134217728) // 1 */
export const fromFrac32 = (v) => v / FRAC32_ONE;

/**
 * Command. Generate, compile and run one object case; returns its outputs.
 *
 * @param {Object} caseSpec
 *   `{id, axo, obj?, params, attribs?, buffers, inlet(name, buffer, sampleOrNull) -> int32}`
 * @returns {{obj: Object, out: Object<string, Float64Array>, raw: Object<string, Int32Array>, in: Object}}
 *   `out` holds every outlet in FLOAT frac32 units (buffer outlets at sample
 *   rate, scalar outlets one value per k-rate tick); `raw` the same in int32.
 */
export function runCase(caseSpec) {
  if (!existsSync(BUILD)) mkdirSync(BUILD, { recursive: true });
  const axoPath = join(AXO_FACTORY, "objects", caseSpec.axo);
  const obj = loadObject(axoPath, caseSpec.obj);

  const src = join(BUILD, `${caseSpec.id}.cpp`);
  const bin = join(BUILD, caseSpec.id);
  writeFileSync(src, generate(obj, caseSpec));
  // -fpermissive: some factory objects assign int to pointer-typed table refs;
  // that is their code, not ours, and refusing it would shrink coverage for no
  // gain in fidelity. Warnings stay on so nothing is hidden.
  // Include paths, in the order a real Axoloti build sees them:
  //  1. `harness/stubinc` — `axoloti.h` / `axoloti_math.h` redirected to the shim,
  //     so `api/axoloti_filters.h` and friends compile UNMODIFIED from the clone.
  //  2. the firmware `api/` tree, for those unmodified headers.
  //  3. the object's OWN directory, which is where its private headers live
  //     (`osc/bltable.h`, `filter/filters.h`, …).
  const includes = ["-I", HERE, "-I", join(HERE, "stubinc"), "-I", join(AXO_FIRMWARE, "api"),
                    "-I", join(AXO_FIRMWARE, "firmware"), "-I", dirname(axoPath)];
  // PREDEFINING THEIR INCLUDE GUARDS is how `api/axoloti_filters.h` and
  // `firmware/axoloti_oscs.c` compile UNMODIFIED. Both `#include "axoloti_math.h"`
  // with quotes, which C resolves against the INCLUDING FILE's own directory
  // first — so no -I ordering can shadow it, and that header is solid ARM asm.
  // Defining its guard makes the real one expand to nothing while the shim,
  // already included above it, supplies every name it would have declared.
  const guards = ["-DAPI_AXOLOTI_MATH_H", "-DAPI_AXOLOTI_H"];
  const extras = (caseSpec.extraSources ?? []).map((f) => join(AXO_FIRMWARE, f));
  const preInclude = extras.length ? ["-include", join(HERE, "axo_shim.h")] : [];
  try {
    execFileSync("g++", ["-O2", "-std=gnu++11", "-fpermissive", "-w", ...FLAGS, ...guards, ...includes,
                         "-o", bin, src, ...extras, "-lm"], { stdio: "pipe" });
  } catch (e) {
    // Re-raised with the compiler's own diagnostics attached. Swallowing them
    // is how a coverage gap gets mistaken for a fidelity result.
    throw new Error(`${caseSpec.id}: g++ failed\n${e.stderr?.toString() ?? ""}`);
  }

  const isBuf = (p) => p.type.startsWith("frac32buffer");
  const scalarIn = obj.inlets.filter((p) => !isBuf(p));
  const bufIn = obj.inlets.filter(isBuf);
  const scalarOut = obj.outlets.filter((p) => !isBuf(p));
  const bufOut = obj.outlets.filter(isBuf);

  const n = caseSpec.buffers;
  const recordIn = scalarIn.length + bufIn.length * BUFSIZE;
  const inBuf = new Int32Array(n * recordIn);
  const inputTrace = {};
  for (const p of scalarIn) inputTrace[p.name] = new Int32Array(n);
  for (const p of bufIn) inputTrace[p.name] = new Int32Array(n * BUFSIZE);

  let w = 0;
  for (let b = 0; b < n; b++) {
    for (const p of scalarIn) {
      const v = caseSpec.inlet(p.name, b, null) | 0;
      inBuf[w++] = v; inputTrace[p.name][b] = v;
    }
    for (const p of bufIn) {
      for (let s = 0; s < BUFSIZE; s++) {
        const v = caseSpec.inlet(p.name, b, s) | 0;
        inBuf[w++] = v; inputTrace[p.name][b * BUFSIZE + s] = v;
      }
    }
  }
  const inPath = join(BUILD, `${caseSpec.id}.in.bin`);
  const outPath = join(BUILD, `${caseSpec.id}.out.bin`);
  writeFileSync(inPath, Buffer.from(inBuf.buffer, inBuf.byteOffset, inBuf.byteLength));
  execFileSync(bin, [inPath, outPath, String(n)], { stdio: ["ignore", "ignore", "pipe"] });

  const outBytes = readFileSync(outPath);
  const outI32 = new Int32Array(outBytes.buffer, outBytes.byteOffset, outBytes.byteLength / 4);
  const recordOut = scalarOut.length + bufOut.length * BUFSIZE;
  if (outI32.length !== n * recordOut) {
    throw new Error(`${caseSpec.id}: expected ${n * recordOut} int32 out, got ${outI32.length}`);
  }
  const raw = {}, out = {};
  for (const p of scalarOut) raw[p.name] = new Int32Array(n);
  for (const p of bufOut) raw[p.name] = new Int32Array(n * BUFSIZE);
  let r = 0;
  for (let b = 0; b < n; b++) {
    for (const p of scalarOut) raw[p.name][b] = outI32[r++];
    for (const p of bufOut) for (let s = 0; s < BUFSIZE; s++) raw[p.name][b * BUFSIZE + s] = outI32[r++];
  }
  // SCALE BY THE OUTLET'S DECLARED TYPE, NOT BY ASSUMPTION.
  // `lfo/square`'s outlet is `bool32`: its high level is the INTEGER 1, not
  // 2^27. Dividing it by 2^27 like a frac32 made the reference a 7.45e-9 blip
  // and our correct 0/1 output look 134-million-fold too loud — a full-scale
  // "max |Δ| 1.0" that was entirely this line. A bool32 or int32 outlet crosses
  // unscaled.
  for (const p of [...scalarOut, ...bufOut]) {
    const scale = p.type.startsWith("frac32") ? fromFrac32 : (v) => v;
    out[p.name] = Float64Array.from(raw[p.name], scale);
  }
  return { obj, out, raw, inputTrace };
}

/**
 * Pure function. Upsample a k-rate scalar trace (one value per 16 samples) to
 * sample rate by HOLD, so it can be compared against a sample-rate signal.
 *
 * @example holdToSampleRate(Float64Array.from([1, 2]))  // [1 x16, 2 x16]
 */
export function holdToSampleRate(kRate) {
  const out = new Float64Array(kRate.length * BUFSIZE);
  for (let i = 0; i < kRate.length; i++) out.fill(kRate[i], i * BUFSIZE, (i + 1) * BUFSIZE);
  return out;
}
