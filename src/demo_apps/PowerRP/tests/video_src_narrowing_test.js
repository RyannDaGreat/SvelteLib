/**
 * THE VIDEO `src` NARROWING IS ONE CONTRACT — a DRIFT GATE, not a dedup.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `PROPS.src` (core/properties.js) declares IMAGE assets, because the image widget
 * is its oldest consumer. Every widget that takes a CLIP therefore narrows it to
 * `assetKinds: ["video"]` — and `assetKinds` is a CONTRACT aspect
 * (core/multiselect.js rowContract), so two video widgets that narrow it differently
 * silently stop being "the same row": `core/retype.js carryVerdict` refuses to carry
 * the source across a retype between them, and core/multiselect.js drops `src` out of
 * a joint selection's Inspector. Both failures are SILENT — the value simply does not
 * arrive.
 *
 * Only TWO of the widgets that narrow it share a declaration
 * (core/video_sampling.js VIDEO_SAMPLING_ROWS, spread by filmstrip and image_stack);
 * every other one re-types the narrowing by hand. How many that is, is PRINTED by the
 * first check from the live registry rather than written here — a count in a comment
 * goes stale the day a widget is added, and this file exists precisely because
 * hand-kept knowledge about the video roster rots. MEASURED at the time of writing:
 * they all AGREE, so there is no defect to fix today. That is the situation C-7 is about
 * — *"consistent today, ungated forever" is the half you can always fix.* Unifying
 * the nine touches several agents' files and most of them are slated for deletion by
 * R6-12.3, so the unification is correctly deferred; the GATE is not.
 *
 * ── WHAT IT ASSERTS ──────────────────────────────────────────────────────────
 * Every registered plugin whose `src` row narrows to video assets must have the SAME
 * ROW CONTRACT as `core/video_sampling.videoSrcRow()`. It compares CONTRACTS rather
 * than whole rows, using the codebase's own relation, so a widget is free to call the
 * row "Source" or "Video" and to file it under its own category — `label`, `help` and
 * `category` are PRESENTATIONAL and a gate that flagged them would be noise nobody
 * would keep green.
 *
 * The subject set is DERIVED from the live registry (a plugin narrows `src` to video
 * ⟹ it is a subject), never listed here: a hand-kept roster of video widgets is the
 * hand-maintained-mirror defect this codebase's ledger calls its worst recurring one,
 * and it would pass forever while a tenth widget drifted unseen.
 *
 * Run:  node src/demo_apps/PowerRP/tests/video_src_narrowing_test.js
 */
import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { contractDifferences, sameRowContract } from "../core/multiselect.js";
import { videoSrcRow } from "../core/video_sampling.js";

let checks = 0;
function ok(label, fn) {
  fn();
  checks++;
  console.log(`PASS  ${label}`);
}

const registry = createRegistry();
registerAll(registry, createCommands());

/**
 * Pure function. Does this row narrow `src` to VIDEO assets? The declarative test —
 * what the plugin SAYS about its source — rather than anything about what its emit
 * does, so the gate answers from the same field the retype rules read.
 *
 * @param {object} row - a resolved inspector row (or undefined)
 * @returns {boolean}
 *
 * @example narrowsToVideo({key: "src", assetKinds: ["video"]}) // true
 * @example narrowsToVideo({key: "src", assetKinds: ["image"]}) // false
 * @example narrowsToVideo({key: "fill"}) // false
 * @example narrowsToVideo(undefined) // false
 */
function narrowsToVideo(row) {
  return row?.key === "src" && Array.isArray(row.assetKinds)
    && row.assetKinds.length === 1 && row.assetKinds[0] === "video";
}

/** Query. Every registered plugin declaring a video-narrowed `src` row, as
 *  `[type, row]` pairs — derived from the registry, never listed. */
function videoSrcPlugins() {
  return registry.all()
    .map((p) => [p.type, p.inspector?.find((r) => r?.key === "src")])
    .filter(([, row]) => narrowsToVideo(row));
}

const subjects = videoSrcPlugins();

ok("the registry actually yields video-src widgets (a vacuous pass is not a pass)", () => {
  // TWO is the floor that makes the comparison meaningful at all; the real number is
  // printed rather than asserted, because pinning it would make every new video
  // widget a test edit — the exact mirror-maintenance this gate exists to avoid.
  assert.ok(subjects.length >= 2, `expected at least 2 video-src widgets, found ${subjects.length}`);
  console.log(`      (${subjects.length}: ${subjects.map(([t]) => t).join(", ")})`);
});

ok("every video widget's `src` row has the SAME CONTRACT as core/video_sampling.videoSrcRow()", () => {
  const canonical = videoSrcRow();
  const offenders = subjects
    .filter(([, row]) => !sameRowContract(canonical, row))
    .map(([type, row]) => `${type} differs on: ${contractDifferences(canonical, row).join(", ")}`);
  assert.deepEqual(offenders, [],
    "these widgets' `src` rows have drifted from the shared narrowing, so retype and joint editing " +
    "will SILENTLY drop `src` between them and every other video widget:\n  " + offenders.join("\n  "));
});

ok("videoSrcRow() and the VIDEO_SAMPLING_ROWS block agree — one narrowing, two spellings", async () => {
  // The block bakes the narrowing in and the function takes a label; they are built
  // from ONE module-private constant, and this is what proves it stayed that way. A
  // second narrowing would make a sampling widget and a player widget non-retypeable
  // for `src`, which is the one thing todo #237's requirement is about.
  const { VIDEO_SAMPLING_ROWS } = await import("../core/video_sampling.js");
  const blockSrc = VIDEO_SAMPLING_ROWS.find((r) => r.key === "src");
  assert.ok(sameRowContract(videoSrcRow(), blockSrc),
    `videoSrcRow() and VIDEO_SAMPLING_ROWS' src differ on: ${contractDifferences(videoSrcRow(), blockSrc).join(", ")}`);
  assert.equal(videoSrcRow("Source").label, "Source", "the label must be the caller's");
  assert.deepEqual(videoSrcRow("Source").assetKinds, ["video"], "the narrowing must NOT be the caller's");
});

console.log(`\nvideo_src_narrowing_test: ${checks} checks passed`);
