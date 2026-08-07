/**
 * gen.mjs — TURN A `.axo` INTO A RUNNABLE C++ PROGRAM, WITHOUT RETYPING ITS DSP.
 *
 * The whole point of the A/B harness is that the reference side is not a
 * transcription. So this module lifts `<code.declaration>`, `<code.init>`,
 * `<code.krate>` and `<code.srate>` out of the XML as OPAQUE TEXT and drops
 * them into the same scaffolding Axoloti's own Java code generator builds
 * (`src/main/java/axoloti/codegen/patch/object/AxoObjectInstanceCodegenView.java`):
 *
 *   - a struct whose members are `<code.declaration>` verbatim,
 *   - `init()` = `<code.init>` verbatim,
 *   - `dsp(inlets…, outlets&…, params…)` = `<code.krate>` verbatim, followed by
 *     `for(buffer_index=0; buffer_index<BUFSIZE; buffer_index++) { <code.srate> }`
 *     with every `frac32buffer` inlet/outlet name rewritten to `name[buffer_index]`
 *     — that rewrite is theirs, copied from `generateSRateCodePlusPlus`.
 *
 * Params reach the code as `param_<name>`, computed at generation time by the
 * SAME pfunction the object's parameter type selects (`parameter_functions.h`),
 * applied to `raw = (int)(dial * 2^21)` (`ValueFrac32.getRaw`). Attributes are
 * textual substitution, exactly as `s.replaceAll(p.getCName(), p.CValue())`.
 *
 * The generated program's I/O is deliberately dumb: read `in.bin`, write
 * `out.bin`, both little-endian int32, one record per 16-sample buffer.
 */

import { readFileSync } from "node:fs";

/** Datatypes whose CType is a 16-sample buffer, per `Frac32buffer.CType()`. */
const BUFFER_TYPES = new Set(["frac32buffer", "frac32buffer.bipolar", "frac32buffer.positive"]);

/**
 * The parameter-type -> pfunction map, read off the `getPFunction()` overrides
 * in `src/main/java/axoloti/object/parameter/*.java` and their `extends` chain.
 * A type absent here has no pfunction (`Parameter.getPFunction()` returns null),
 * which for our purposes means the raw value passes through.
 */
const PFUNCTION_BY_PARAM_TYPE = Object.freeze({
  "frac32.s.map": "signed_clamp",
  "frac32.s.map.pitch": "signed_clamp",
  "frac32.s.map.kpitch": "signed_clamp",
  "frac32.s.map.lfopitch": "signed_clamp",
  "frac32.s.map.ratio": "signed_clamp",
  "frac32.s.map.klineartime.exp": "signed_clamp",
  "frac32.s.map.klineartime.exp2": "kexpltime",
  "frac32.s.mapvsl": "signed_clamp",
  "frac32.u.map": "unsigned_clamp",
  "frac32.u.map.freq": "unsigned_clamp",
  "frac32.u.map.filterq": "unsigned_clamp",
  "frac32.u.map.ratio": "unsigned_clamp",
  "frac32.u.map.kdecaytime": "unsigned_clamp",
  "frac32.u.map.kdecaytime.reverse": "unsigned_clamp",
  "frac32.u.map.klineartime.reverse": "unsigned_clamp",
  "frac32.u.mapvsl": "unsigned_clamp",
  "frac32.u.map.gain": "unsigned_clamp_fullrange",
  "frac32.u.map.gain16": "signed_clamp_fullrange",
  "frac32.u.map.squaregain": "signed_clamp_fullrange_squarelaw",
});

/**
 * A `<params>` ENTRY MAY OVERRIDE ITS OWN ELEMENT NAME with a `class=` attribute
 * naming a legacy Java parameter class, and that class's pfunction WINS.
 *
 * FOUND THE HARD WAY, 2026-08-07. `env/d`, `env/adsr`'s d and r, and five other
 * factory objects are written `<frac32.s.map class="…ParameterFrac32SMapKDTimeExp">`.
 * Reading the element name alone gives `pf_signed_clamp`, and with it the C
 * reference's decay envelope collapsed to ZERO in one control tick — which the
 * harness then reported as "our envelope is 291x too slow". The real pfunction
 * is `pf_kexpdtime`, `0x7FFFFFFF - (mtof(-v) >> 2)`, i.e. a per-tick RETENTION
 * factor. Seven objects in the factory tree carry a `class=`; all seven are this
 * one class, and an UNKNOWN class throws rather than falling back, because a
 * silent fallback here manufactures exactly the false failure above.
 */
const PFUNCTION_BY_PARAM_CLASS = Object.freeze({
  "axoloti.parameters.ParameterFrac32SMapKDTimeExp": "kexpdtime",
});

/** Params carrying an int, not a frac32 — their raw value is the number itself. */
const INT_PARAM_TYPES = new Set(["int32", "int32.mini", "int32.hradio", "int32.vradio",
  "bool32.tgl", "bool32.mom", "bin1", "bin12", "bin16", "bin32", "int2x16"]);

/**
 * Pure function. Pull the CDATA of one `<code.*>` element out of an .axo body.
 *
 * @param {string} xml - The object element's inner XML
 * @param {string} tag - e.g. "code.srate"
 * @returns {string} the block's text, or "" when the object has no such block
 *
 * @example codeBlock('<code.init><![CDATA[Phase = 0;]]></code.init>', 'code.init')
 *          // "Phase = 0;"
 */
export function codeBlock(xml, tag) {
  const m = xml.match(new RegExp(`<${tag.replace(".", "\\.")}>([\\s\\S]*?)</${tag.replace(".", "\\.")}>`));
  if (!m) return "";
  const cd = m[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return cd ? cd[1] : decodeEntities(m[1]);
}

/**
 * Pure function. Axoloti's own identifier escape, `CharEscape.charEscape`
 * (src/main/java/.../CharEscape.java), which every inlet, outlet, parameter and
 * attribute C name goes through.
 *
 * THE UNDERSCORE DOUBLING IS THE ONE THAT BITES: an inlet named `bus_in` is
 * `inlet_bus__in` in the object's C, and reading the XML name literally makes
 * `mix/mix N` — the whole mixer family — fail to compile.
 *
 * @param {string} s - the port/param/attribute name as written in the XML
 * @returns {string} the identifier fragment the object code uses
 *
 * @example charEscape('bus_in')   // 'bus__in'
 * @example charEscape('pitch')    // 'pitch'
 * @example charEscape('a*b')      // 'a_star_b'
 */
export function charEscape(s) {
  return s.replace(/_/g, "__").replace(/ /g, "_space_").replace(/\*/g, "_star_")
    .replace(/\//g, "_slash_").replace(/-/g, "_dash_").replace(/\+/g, "_plus_")
    .replace(/~/g, "_tilde_").replace(/%/g, "_pct_").replace(/@/g, "_at_")
    .replace(/!/g, "_excl_").replace(/#/g, "_cross_").replace(/\$/g, "_dollar_")
    .replace(/&/g, "_amp_").replace(/\(/g, "_bo_").replace(/\)/g, "_bc_")
    .replace(/>/g, "_gt_").replace(/</g, "_lt_").replace(/=/g, "_eq_")
    .replace(/:/g, "_colon_").replace(/\./g, "_dot_");
}

/** Pure function. The five XML predefined entities, decoded. */
function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/**
 * Pure function. Parse the `<inlets>`, `<outlets>`, `<params>` or `<attribs>`
 * section into `{type, name, attrs}` records, in document order.
 *
 * @param {string} xml - The object element's inner XML
 * @param {string} section - "inlets" | "outlets" | "params" | "attribs"
 * @returns {Array<{type: string, name: string, attrs: Object}>}
 *
 * @example ports('<inlets><frac32.bipolar name="pitch"/></inlets>', 'inlets')
 *          // [{type: 'frac32.bipolar', name: 'pitch', attrs: {name: 'pitch'}}]
 */
export function ports(xml, section) {
  const m = xml.match(new RegExp(`<${section}>([\\s\\S]*?)</${section}>`));
  if (!m) return [];
  const out = [];
  const re = /<([A-Za-z0-9_.]+)((?:\s+[A-Za-z0-9_]+="[^"]*")*)\s*(\/?)>/g;
  let e;
  while ((e = re.exec(m[1])) !== null) {
    const attrs = {};
    for (const a of e[2].matchAll(/([A-Za-z0-9_]+)="([^"]*)"/g)) attrs[a[1]] = decodeEntities(a[2]);
    if (!attrs.name) continue; // nested element (MenuEntries/CEntries) — not a port
    out.push({ type: e[1], name: attrs.name, cname: charEscape(attrs.name), attrs, selfClosing: e[3] === "/" });
  }
  return out;
}

/**
 * Query. Read one object out of a `.axo` file.
 *
 * @param {string} path - Absolute path to the .axo
 * @param {string} [id] - Object id when the file holds several; else the first
 * @returns {Object} `{id, xml, inlets, outlets, params, attribs, decl, init, krate, srate}`
 */
export function loadObject(path, id) {
  const file = readFileSync(path, "utf8");
  const objs = [...file.matchAll(/<obj\.normal\s+id="([^"]*)"[\s\S]*?<\/obj\.normal>/g)];
  if (objs.length === 0) throw new Error(`No <obj.normal> in ${path}`);
  const chosen = id ? objs.find((o) => o[1] === id) : objs[0];
  if (!chosen) throw new Error(`No object id ${id} in ${path} (have ${objs.map((o) => o[1]).join(", ")})`);
  const xml = chosen[0];
  return {
    id: chosen[1],
    path,
    xml,
    inlets: ports(xml, "inlets"),
    outlets: ports(xml, "outlets"),
    params: ports(xml, "params"),
    attribs: ports(xml, "attribs"),
    decl: codeBlock(xml, "code.declaration"),
    init: codeBlock(xml, "code.init"),
    krate: codeBlock(xml, "code.krate"),
    srate: codeBlock(xml, "code.srate"),
  };
}

/**
 * Pure function. Apply an object's parameter pfunction to a DIAL value, in the
 * same arithmetic the firmware uses, so the harness can bake `param_x` as a
 * literal instead of shipping the parameter subsystem.
 *
 * `raw = (int)(dial * 2^21)` is `ValueFrac32.getRaw()`; the pfunctions are
 * `parameter_functions.h`. Mirrors `axo_shim.h`'s C copies — the two are
 * cross-checked by `harness/pfunction_parity.c`.
 *
 * @param {string} type - The param's XML type, e.g. "frac32.u.map.gain"
 * @param {number} dial - Dial reading, -64..64 for frac32 (64 == 1.0)
 * @returns {number} the int32 the object code sees as `param_<name>`
 *
 * @example paramValue('frac32.s.map.pitch', 12)   // 25165824  (12 semitones)
 * @example paramValue('frac32.u.map', 64)         // 134217727 (clamped to 1.0-1lsb)
 * @example paramValue('int32', 3)                 // 3
 */
export function paramValue(type, dial, legacyClass) {
  if (INT_PARAM_TYPES.has(type)) return dial | 0;
  const raw = Math.trunc(dial * (1 << 21)) | 0;
  const smmul = (a, b) => Number(BigInt.asIntN(64, BigInt(a) * BigInt(b)) >> 32n) | 0;
  const ssat = (x, n) => { const hi = (1 << (n - 1)) - 1; return Math.min(hi, Math.max(-hi - 1, x)); };
  const usat = (x, n) => Math.min((1 << n) - 1, Math.max(0, x));
  switch (pfunctionFor(type, legacyClass)) {
    case "signed_clamp": return ssat(raw, 28);
    case "unsigned_clamp": return usat(raw, 27);
    case "signed_clamp_fullrange": return ssat(raw, 28) << 4;
    case "unsigned_clamp_fullrange": return usat(raw, 27) << 4;
    case "signed_clamp_fullrange_squarelaw": {
      const p = ssat(raw, 28) << 4;
      return p > 0 ? smmul(p, p) << 1 : (-smmul(p, p)) << 1;
    }
    case "kexpltime": case "kexpdtime":
      // needs mtof — the C side computes these; see `pfunctionExpr`
      return null;
    case undefined: return raw;
    default: throw new Error(`gen.mjs has no JS copy of pfunction for param type ${type}`);
  }
}

/**
 * Pure function. Which pfunction a param entry resolves to. The `class=`
 * override beats the element name; an unrecognised override is LOUD.
 *
 * @example pfunctionFor('frac32.s.map', undefined) // 'signed_clamp'
 * @example pfunctionFor('frac32.s.map', 'axoloti.parameters.ParameterFrac32SMapKDTimeExp') // 'kexpdtime'
 */
export function pfunctionFor(type, legacyClass) {
  if (legacyClass) {
    const fn = PFUNCTION_BY_PARAM_CLASS[legacyClass];
    if (!fn) throw new Error(`gen.mjs does not know legacy param class ${legacyClass}`);
    return fn;
  }
  return PFUNCTION_BY_PARAM_TYPE[type];
}

/** Pure function. The C expression for `param_x`, used when JS cannot do it. */
function pfunctionExpr(type, dial, legacyClass) {
  const raw = Math.trunc(dial * (1 << 21)) | 0;
  const fn = pfunctionFor(type, legacyClass);
  if (fn === "kexpltime" || fn === "kexpdtime") return `pfun_inl_${fn}(${raw})`;
  const v = paramValue(type, dial, legacyClass);
  if (v === null) throw new Error(`no value for ${type}`);
  return String(v);
}

/**
 * Pure function. Rewrite `frac32buffer` port names to `name[buffer_index]` in
 * s-rate code, which is what `generateSRateCodePlusPlus` does with
 * `s.replaceAll(cName, cName + "[buffer_index]")`.
 *
 * Uses a word-boundary regex rather than Java's plain `replaceAll` so that
 * `inlet_x` inside `inlet_xy` is not clobbered — a difference that only ever
 * makes us MORE correct, and is noted because it is a deviation from theirs.
 *
 * @example indexBufferPorts('outlet_w = inlet_a;', ['inlet_a', 'outlet_w'])
 *          // 'outlet_w[buffer_index] = inlet_a[buffer_index];'
 */
export function indexBufferPorts(code, names) {
  let s = code;
  for (const n of names) s = s.replace(new RegExp(`\\b${n}\\b`, "g"), `${n}[buffer_index]`);
  return s;
}

/**
 * Pure function. Build the complete C++ source for one object + one case.
 *
 * @param {Object} obj - from `loadObject`
 * @param {Object} spec - `{params: {name: dial}, attribs: {name: cvalue}}`
 * @returns {string} C++ source, compilable with `g++ -std=gnu++11`
 */
export function generate(obj, spec = {}) {
  const paramDials = spec.params ?? {};
  const attribValues = spec.attribs ?? {};

  const bufferInlets = obj.inlets.filter((p) => BUFFER_TYPES.has(p.type));
  const bufferOutlets = obj.outlets.filter((p) => BUFFER_TYPES.has(p.type));
  const scalarInlets = obj.inlets.filter((p) => !BUFFER_TYPES.has(p.type));
  const scalarOutlets = obj.outlets.filter((p) => !BUFFER_TYPES.has(p.type));

  // Attribute substitution, applied to every code block exactly as Java does.
  const substitute = (code) => {
    let s = code;
    for (const a of obj.attribs) {
      const value = attribValues[a.name];
      if (value === undefined) {
        throw new Error(`Object ${obj.id} has attribute "${a.name}" (${a.type}); the case must give a C value for it`);
      }
      s = s.split(`attr_${a.cname}`).join(String(value));
    }
    return s.split("attr_name").join(`inst_${obj.id.replace(/[^A-Za-z0-9_]/g, "_")}`)
            .split("attr_legal_name").join(obj.id.replace(/[^A-Za-z0-9_]/g, "_"));
  };

  const bufNames = [...bufferInlets.map((p) => `inlet_${p.cname}`), ...bufferOutlets.map((p) => `outlet_${p.cname}`)];
  const srate = obj.srate ? indexBufferPorts(substitute(obj.srate), bufNames) : "";

  const args = [
    ...obj.inlets.map((p) => BUFFER_TYPES.has(p.type)
      ? `const int32_t inlet_${p.cname}[BUFSIZE]` : `const int32_t inlet_${p.cname}`),
    ...obj.outlets.map((p) => BUFFER_TYPES.has(p.type)
      ? `int32_t outlet_${p.cname}[BUFSIZE]` : `int32_t& outlet_${p.cname}`),
    ...obj.params.map((p) => `int32_t param_${p.cname}`),
  ];

  const paramInit = obj.params.map((p) => {
    if (!(p.name in paramDials)) {
      throw new Error(`Object ${obj.id} has param "${p.name}" (${p.type}); the case must give a dial value`);
    }
    return `  const int32_t param_${p.cname} = ${pfunctionExpr(p.type, paramDials[p.name], p.attrs.class)};`;
  }).join("\n");

  const readRecord = [
    ...scalarInlets.map((p) => `    rd(&inlet_${p.cname}, 1);`),
    ...bufferInlets.map((p) => `    rd(inlet_${p.cname}, BUFSIZE);`),
  ].join("\n");
  const writeRecord = [
    ...scalarOutlets.map((p) => `    wr(&outlet_${p.cname}, 1);`),
    ...bufferOutlets.map((p) => `    wr(outlet_${p.cname}, BUFSIZE);`),
  ].join("\n");

  return `/* GENERATED by harness/gen.mjs from ${obj.path} (object "${obj.id}").
 * DSP text is verbatim from that file; do not edit here. */
#include "../harness/axo_shim.h"
${(spec.includes ?? []).map((h) => `#include ${h.startsWith("<") ? h : `"${h}"`}`).join("\n")}

struct Obj {
${substitute(obj.decl)}

  void init() {
${substitute(obj.init)}
  }

  void dsp(${args.join(",\n          ")}) {
${substitute(obj.krate)}
${srate ? `    int buffer_index;\n    for (buffer_index = 0; buffer_index < BUFSIZE; buffer_index++) {\n${srate}\n    }` : ""}
  }
};

static Obj obj;
static FILE* fin;
static FILE* fout;
static void rd(int32_t* p, int n) {
  if ((int)fread(p, sizeof(int32_t), n, fin) != n) { fprintf(stderr, "harness: short read\\n"); exit(2); }
}
static void wr(const int32_t* p, int n) { fwrite(p, sizeof(int32_t), n, fout); }

int main(int argc, char** argv) {
  if (argc < 4) { fprintf(stderr, "usage: %s in.bin out.bin nbuffers\\n", argv[0]); return 2; }
  axoloti_math_init();
  if (axo_shim_selftest() != 0) { fprintf(stderr, "harness: shim selftest failed, refusing to run\\n"); return 3; }
  fin = fopen(argv[1], "rb");
  fout = fopen(argv[2], "wb");
  if (!fin || !fout) { fprintf(stderr, "harness: cannot open io\\n"); return 2; }
  const int nbuffers = atoi(argv[3]);

${paramInit}
${obj.inlets.map((p) => BUFFER_TYPES.has(p.type)
    ? `  int32_t inlet_${p.cname}[BUFSIZE] = {0};` : `  int32_t inlet_${p.cname} = 0;`).join("\n")}
${obj.outlets.map((p) => BUFFER_TYPES.has(p.type)
    ? `  int32_t outlet_${p.cname}[BUFSIZE] = {0};` : `  int32_t outlet_${p.cname} = 0;`).join("\n")}

  obj.init();
  for (int b = 0; b < nbuffers; b++) {
${readRecord}
    obj.dsp(${[...obj.inlets.map((p) => `inlet_${p.cname}`), ...obj.outlets.map((p) => `outlet_${p.cname}`),
              ...obj.params.map((p) => `param_${p.cname}`)].join(", ")});
${writeRecord}
  }
  fclose(fin); fclose(fout);
  return 0;
}
`;
}
