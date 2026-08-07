/**
 * THE A/B GATE. Runs every case and prints a markdown report.
 *
 *   node harness/run.mjs [--filter=substring] [--md=out.md] [--json=out.json]
 *
 * A case that THROWS is a harness failure (missing checkout, compile error) and
 * is reported as ERROR in its own section, never as a passing or failing node —
 * conflating the two is how a broken harness gets read as a green codebase.
 */

import { writeFileSync } from "node:fs";
import { loadCases, runCase } from "./lib/runner.mjs";
import { harmonicsDbString } from "./lib/metrics.mjs";

/** Thresholds that decide the verdict column. Chosen, not measured — see README. */
const VERDICT = Object.freeze({
  /** A float32 wire carries ~7 decimal digits; anything at or below this is round-off. */
  EXACT_MAX_ABS: 1e-6,
  /** 1 cent. Below the just-noticeable difference for a sustained tone. */
  TUNING_SEMITONES: 0.01,
  /** 1 dB on any of the first 8 harmonics. Audible as timbre, but not as a different waveform. */
  HARMONIC_DB: 1.0,
  /** Below this the two signals are not the same sound at all. */
  MIN_NCC: 0.999,
});

/**
 * Pure function. One channel's verdict: PASS, CLOSE, or FAIL, with the reason.
 *
 * PASS means indistinguishable within float32 round-off. CLOSE means the sound
 * is right but the samples are not bit-identical — the honest verdict for a
 * port that took a documented deviation. FAIL names the first thing that is
 * musically wrong, in the order tuning > waveform > correlation, because a
 * semitone of detune makes the other two moot.
 *
 * @param {object} ch - a channel row from runner.compareChannel
 * @returns {{verdict: string, why: string}}
 *
 * @example verdictFor({maxAbsError: 0, ncc: 1, kind: "wave"}) // {verdict: "PASS", why: "bit-exact"}
 * @example verdictFor({maxAbsError: 2, ncc: 0.5, kind: "wave"}).verdict // "FAIL"
 */
export function verdictFor(ch) {
  if (ch.maxAbsError <= VERDICT.EXACT_MAX_ABS) return { verdict: "PASS", why: "bit-exact" };
  if (ch.kind === "tone") {
    const cents = Math.abs(ch.semitoneError) * 100;
    if (Math.abs(ch.semitoneError) > VERDICT.TUNING_SEMITONES) {
      return { verdict: "FAIL", why: `${cents.toFixed(1)} cents out of tune` };
    }
    if (ch.harmonicMaxDbError > VERDICT.HARMONIC_DB) {
      return { verdict: "FAIL", why: `harmonic level off by ${ch.harmonicMaxDbError.toFixed(1)} dB` };
    }
  }
  if (ch.kind === "impulse") {
    const co = ch.cornerOurs;
    const ct = ch.cornerTheirs;
    if (ct > 0 && Math.abs(co - ct) / ct > 0.02) {
      return { verdict: "FAIL", why: `corner ${co.toFixed(0)} Hz vs ${ct.toFixed(0)} Hz` };
    }
    if (Math.abs(ch.peakDbOurs - ch.peakDbTheirs) > VERDICT.HARMONIC_DB) {
      return { verdict: "FAIL", why: `resonance off by ${(ch.peakDbOurs - ch.peakDbTheirs).toFixed(1)} dB` };
    }
  }
  if (ch.ncc < VERDICT.MIN_NCC) return { verdict: "FAIL", why: `correlation ${ch.ncc.toFixed(4)}` };
  const relative = ch.rmsTheirs > 0 ? ch.maxAbsError / ch.rmsTheirs : Infinity;
  return { verdict: "CLOSE", why: `max |Δ| ${ch.maxAbsError.toExponential(2)} (${(100 * relative).toFixed(2)}% of RMS)` };
}

/** Pure function. A markdown table row for one channel. */
function row(result, ch) {
  const { verdict, why } = verdictFor(ch);
  const tuning = ch.kind === "tone"
    ? `${ch.f0Ours.toFixed(3)} / ${ch.f0Theirs.toFixed(3)} Hz (${(ch.semitoneError * 100).toFixed(2)}¢)`
    : ch.kind === "impulse"
      ? `${ch.cornerOurs.toFixed(1)} / ${ch.cornerTheirs.toFixed(1)} Hz`
      : "—";
  const spectrum = ch.kind === "tone" ? `${ch.harmonicMaxDbError.toFixed(2)} dB` : "—";
  const name = result.channels.length > 1 ? `${result.name} · ${ch.channel}` : result.name;
  return `| ${name} | ${verdict} | ${ch.maxAbsError.toExponential(2)} | ${ch.ncc.toFixed(6)} | ${tuning} | ${spectrum} | ${why} |`;
}

async function main() {
  const args = process.argv.slice(2);
  const filter = args.find((a) => a.startsWith("--filter="))?.slice(9);
  const mdPath = args.find((a) => a.startsWith("--md="))?.slice(5);
  const jsonPath = args.find((a) => a.startsWith("--json="))?.slice(7);

  const { cases, loadErrors } = await loadCases(filter);
  const results = [];
  const errors = [...loadErrors];
  for (const e of loadErrors) process.stderr.write(`ERROR ${e.name}: ${e.error}\n`);
  for (const c of cases) {
    try {
      const r = await runCase(c);
      results.push(r);
      const worst = r.channels.map(verdictFor).map((v) => v.verdict);
      const tag = worst.includes("FAIL") ? "FAIL" : worst.includes("CLOSE") ? "CLOSE" : "PASS";
      process.stderr.write(`${tag.padEnd(5)} ${c.name}\n`);
    } catch (e) {
      // Keep only the first line that looks like a diagnostic, not the whole
      // g++ command line — a wall of repeated flags buries the one sentence
      // that says what is actually missing.
      const text = String(e.message ?? e);
      const diag = text.split("\n").find((l) => /error|Error|missing|expected/.test(l) && !l.startsWith("Command failed")) ?? text.split("\n")[0];
      errors.push({ name: c.name, error: diag.trim().slice(0, 300) });
      process.stderr.write(`ERROR ${c.name}: ${diag.trim().slice(0, 200)}\n`);
    }
  }

  const lines = [];
  lines.push("| node | verdict | max abs Δ | NCC | f0 ours/theirs (or corner) | worst harmonic Δ | note |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of results) for (const ch of r.channels) lines.push(row(r, ch));
  if (errors.length) {
    lines.push("");
    lines.push("### Harness errors (NOT node verdicts)");
    lines.push("");
    lines.push("| case | error |");
    lines.push("|---|---|");
    for (const e of errors) lines.push(`| ${e.name} | ${e.error.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  lines.push("### Harmonic profiles (dB relative to the fundamental, harmonics 1..8)");
  lines.push("");
  lines.push("| node | ours | upstream |");
  lines.push("|---|---|---|");
  for (const r of results) {
    for (const ch of r.channels) {
      if (ch.kind !== "tone") continue;
      const name = r.channels.length > 1 ? `${r.name} · ${ch.channel}` : r.name;
      lines.push(`| ${name} | \`${harmonicsDbString(ch.harmonicsOurs)}\` | \`${harmonicsDbString(ch.harmonicsTheirs)}\` |`);
    }
  }
  const md = lines.join("\n");
  if (mdPath) writeFileSync(mdPath, md + "\n");
  else process.stdout.write(md + "\n");
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify({ results, errors }, null, 2));

  const failed = results.filter((r) => r.channels.some((ch) => verdictFor(ch).verdict === "FAIL"));
  process.stderr.write(`\n${results.length} case(s) measured, ${failed.length} FAIL, ${errors.length} harness error(s)\n`);
}

await main();
