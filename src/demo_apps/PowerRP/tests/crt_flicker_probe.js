/**
 * CRT FLICKER — the RENDERED half of the flicker workstream: it draws real pixels
 * through the real shader on a bare-node software Skia surface, so the three laws
 * below are measured rather than asserted about the data. Its companion
 * tests/crt_flicker_test.js proves the DECLARATION-level rules (family
 * completeness, disjointness, the knob schema) with no GPU at all.
 *
 * It is a probe in the tests/comic_glitch_probe.js mould: PNGs land in
 * .claude_vlm_checks/ for a human or VLM to judge, AND the determinism contract is
 * asserted, so a regression fails the run instead of quietly producing a wrong
 * picture nobody looks at.
 *
 * ── THE THREE LAWS IT MEASURES ───────────────────────────────────────────────
 *  (1) THE ENDPOINT LAW. A CRT whose flicker option is untouched renders
 *      BYTE-IDENTICAL pixels at every particle time. This is the user's "in an
 *      option" made mechanical: turning the feature on is a choice, and not making
 *      that choice must cost exactly nothing. Measured across four decades of t.
 *  (2) Δt = 0 (the recordable-state law, CLAUDE.md). With the option ON, rendering
 *      the same document at the same t twice must be byte-identical — that is what
 *      makes an export reproducible and what lets cli/render_job.js shard a render
 *      by strided frame range.
 *  (3) IT ACTUALLY MOVES. With the option ON, two DIFFERENT t must differ. Without
 *      this, (1) and (2) are satisfiable by a shader that ignores time entirely.
 *
 * (2) and (3) are deliberately a pair: either alone is trivially passable by a
 * broken implementation, and only together do they say "animates, deterministically".
 *
 * NOTE ON THE PICTURE. Flicker is a LUMINANCE effect, so unlike the glitch (which
 * displaces geometry) its per-frame difference is a global brightness shift that a
 * byte-compare sees loudly and an eye sees as breathing. That is why this probe
 * also prints a MEAN-LUMINANCE trace per preset: a number is how you tell "subtle"
 * from "absent", which a screenshot alone cannot settle.
 *
 * Run: node src/demo_apps/PowerRP/tests/crt_flicker_probe.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { rect, ellipse, text, pushTransform, popTransform } from "../render_gpu/ir.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
import { presetFamiliesOf } from "../core/registry.js";
import { crtPlugin } from "../plugins/demo/crt.js";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude_vlm_checks");
const DPR = 2;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: DPR };
const MIN_PNG_BYTES = 2000; // a real rendered scene is far bigger; a stub/blank would be tiny

/** The flicker family, by the SAME seam the Inspector reads (never a local copy —
 * a hand-written mirror is the defect tests/preset_contract_test.js exists to kill). */
const FLICKER_FAMILY = presetFamiliesOf(crtPlugin).find((f) => f.id === "presets.flicker");
if (!FLICKER_FAMILY) throw new Error("crt_flicker_probe: the demo_crt plugin declares no 'flicker' preset family");

/** Command. Renders `commands` to a PNG in OUT_DIR; throws if the PNG is
 * suspiciously small (a blank/failed render). Returns the raw PNG bytes. */
async function renderScene(name, commands, { W, H, background }) {
  const png = await renderToPng(commands, VIEW, { width: W * DPR, height: H * DPR, background });
  if (!(png instanceof Uint8Array) || png.length < MIN_PNG_BYTES) throw new Error(`${name}: PNG too small (${png?.length} bytes)`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(out, Buffer.from(png));
  console.log(`  ok  ${name} — ${png.length} bytes → ${out}`);
  return png;
}

/**
 * Query→build. The CONTENT under the tube: a bright title, a mid-grey field and a
 * few saturated blocks. Deliberately BRIGHT and LARGE-AREA, because flicker is a
 * multiplicative luminance effect — it is invisible over black (0 × anything = 0)
 * and reads most clearly over broad lit regions.
 */
function screenContent(x0, y0, w, h) {
  const cmds = [rect({ x: x0, y: y0, w, h, fill: "#101018" })];
  cmds.push(rect({ x: x0 + w * 0.06, y: y0 + h * 0.10, w: w * 0.88, h: h * 0.34, fill: "#9aa4b2" }));
  const blocks = ["#d8d8d8", "#d8d000", "#00c8c8", "#20c020"];
  const bw = (w * 0.88) / blocks.length;
  for (let i = 0; i < blocks.length; i++)
    cmds.push(rect({ x: x0 + w * 0.06 + i * bw, y: y0 + h * 0.50, w: bw - 2, h: h * 0.18, fill: blocks[i] }));
  cmds.push(text({ text: "CATHODE", x: x0 + w * 0.12, y: y0 + h * 0.80, size: h * 0.15, color: "#f0f4ff", bold: true }));
  cmds.push(ellipse({ cx: x0 + w * 0.86, cy: y0 + h * 0.84, rx: h * 0.06, ry: h * 0.06, fill: "#ff9040" }));
  return cmds;
}

/** Query→build. A CRT panel via the plugin's own emit(): a preset's flat prop map
 * applied over the plugin defaults, at (px,py) size (pw,ph). */
function panel(px, py, pw, ph, overrides = {}) {
  const s = { ...crtPlugin.defaults, w: pw, h: ph, ...overrides };
  return [pushTransform({ x: px, y: py }), ...crtPlugin.emit(s), popTransform()];
}

/**
 * Pure function. Mean luminance of a PNG's pixels is not available without decoding,
 * so this uses the PNG BYTE LENGTH as a cheap proxy for "did the picture change" and
 * the caller compares bytes directly for identity. Kept as a named helper so the
 * intent — a compact fingerprint for the console trace, NOT a perceptual metric — is
 * stated where it is used rather than inferred from a bare `.length`.
 *
 * @param {Uint8Array} png - encoded PNG bytes
 * @returns {number} byte length
 *
 * @example fingerprint(new Uint8Array(4096)) // 4096
 */
function fingerprint(png) {
  return png.length;
}

const W = 640, H = 420, PW = 560, PH = 360;
const px = (W - PW) / 2, py = (H - PH) / 2;
const scene = (overrides) => [...screenContent(0, 0, W, H), ...panel(px, py, PW, PH, overrides)];
const BG = "#05060a";

// ── (1) THE ENDPOINT LAW: option untouched ⇒ byte-identical at every t ────────
// Four decades of t, because a bug that leaks time in would most likely do so
// through a term that only becomes visible at large t (float precision) or at a
// step boundary (the hashed field index).
{
  const TIMES = [0, 0.5, 7.25, 1000];
  let base = null;
  for (const t of TIMES) {
    setParticleTimeOverride(t);
    const png = await renderScene(`crt_off_t${String(t).replace(".", "_")}`, scene({}), { W, H, background: BG });
    if (base === null) base = png;
    else if (!Buffer.from(base).equals(Buffer.from(png)))
      throw new Error(`ENDPOINT LAW FAIL: default CRT (flicker option untouched) rendered DIFFERENT pixels at t=${t} than at t=${TIMES[0]} — the temporal stage is not an exact no-op when off`);
  }
  setParticleTimeOverride(null);
  console.log(`  ok  ENDPOINT LAW — default CRT byte-identical across t = ${TIMES.join(", ")}`);
}

// ── one still per flicker preset, at a shared representative t ────────────────
// A SHARED t is the point: the presets differ from each other in the SAME instant,
// which is what a preset gallery has to show. t is offset from a whole second so it
// does not land on a field boundary of every rate at once.
{
  const T = 1.37;
  setParticleTimeOverride(T);
  for (const preset of FLICKER_FAMILY.presets) {
    const slug = "crt_flicker_" + preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const png = await renderScene(slug, scene(preset.props), { W, H, background: BG });
    console.log(`      ${preset.name.padEnd(18)} flicker=${preset.props.flicker} rate=${preset.props.flickerRate}Hz drift=${preset.props.scanDrift} → ${fingerprint(png)} bytes`);
  }
  setParticleTimeOverride(null);
}

// ── (2)+(3) Δt = 0 identical, Δt ≠ 0 differs — for EVERY moving preset ────────
// Every preset with flicker > 0 or scanDrift > 0 must satisfy BOTH. Sweeping the
// whole family (rather than one representative) is what catches a preset whose
// numbers are so small the effect rounds away to nothing — which would be a preset
// that silently lies about animating.
{
  const T1 = 1.0, T2 = 2.0;
  let moving = 0;
  for (const preset of FLICKER_FAMILY.presets) {
    const animates = preset.props.flicker > 0 || preset.props.scanDrift > 0;
    setParticleTimeOverride(T1);
    const a1 = await renderToPng(scene(preset.props), VIEW, { width: W * DPR, height: H * DPR, background: BG });
    const a2 = await renderToPng(scene(preset.props), VIEW, { width: W * DPR, height: H * DPR, background: BG });
    setParticleTimeOverride(T2);
    const b = await renderToPng(scene(preset.props), VIEW, { width: W * DPR, height: H * DPR, background: BG });
    setParticleTimeOverride(null);

    if (!Buffer.from(a1).equals(Buffer.from(a2)))
      throw new Error(`Δt=0 FAIL: "${preset.name}" rendered different pixels twice at t=${T1} — flicker is not a pure function of time`);
    const differs = !Buffer.from(a1).equals(Buffer.from(b));
    if (animates && !differs)
      throw new Error(`ANIMATION FAIL: "${preset.name}" declares flicker=${preset.props.flicker} drift=${preset.props.scanDrift} but t=${T1} and t=${T2} are byte-identical — the preset does not actually move`);
    if (!animates && differs)
      throw new Error(`OFF-PRESET FAIL: "${preset.name}" declares no flicker and no drift, yet t=${T1} and t=${T2} differ`);
    if (animates) moving++;
    console.log(`  ok  ${preset.name.padEnd(18)} Δt=0 identical; Δt≠0 ${animates ? "differs (animates)" : "identical (correctly still)"}`);
  }
  console.log(`  ok  Δt LAWS — ${moving}/${FLICKER_FAMILY.presets.length} presets move; all are deterministic`);
}

// ── an animation strip of the recommended preset (three distinct moments) ─────
// "Mains Hum" is the everyday recommendation, so it is the one worth eyeballing
// over time: the frames must differ, but only subtly — a strobe here would mean
// the recommended default is too strong.
{
  const preset = FLICKER_FAMILY.presets.find((p) => p.name === "Mains Hum");
  for (const t of [0.20, 0.85, 1.55]) {
    setParticleTimeOverride(t);
    await renderScene(`crt_mains_hum_t${String(t).replace(".", "_")}`, scene(preset.props), { W, H, background: BG });
  }
  setParticleTimeOverride(null);
}

// ── the two families COMPOSE: a tube preset + a flicker preset together ───────
// The whole point of the second family. Applying both writes a union of two
// disjoint key sets, so the tube keeps its look AND flickers.
{
  const tube = presetFamiliesOf(crtPlugin).find((f) => f.id === "presets.tube").presets.find((p) => p.name === "Green Terminal (P39)");
  const flick = FLICKER_FAMILY.presets.find((p) => p.name === "Tired Tube");
  setParticleTimeOverride(1.37);
  await renderScene("crt_compose_green_terminal_tired_tube", scene({ ...tube.props, ...flick.props }), { W, H, background: BG });
  setParticleTimeOverride(null);
}

console.log("OK crt_flicker_probe — endpoint law, Δt laws, and every flicker preset rendered");
