/**
 * RELATIVE-REF CLI RENDER test — bare node, drives cli/render.js as a subprocess.
 * Run: node src/demo_apps/PowerRP/tests/relative_ref_cli_test.js
 *
 * WHAT IS UNDER TEST: that the relative-ref grammar (core/asset_ref.js) is resolved
 * on the BARE-NODE still path too — `cli/render.js`, which has no browser, no Vite
 * and no origin to fetch against.
 *
 * WHY THIS PATH NEEDS ITS OWN TEST rather than inheriting the seam test's coverage.
 * The CLI reaches paint through the same `web/cameraFrame.js` recipe the editor
 * does, so threading the project ONCE there covers it — but "covers it" is a claim
 * about wiring, and the wiring is exactly what a unit test of the pure resolver
 * cannot check. It also has a second, independent resolver underneath it:
 * `render_gpu/gpu/svg_source_registry.js` reads `/asset/<Project>/<file>` STRAIGHT
 * OFF DISK (from projects/<Project>/assets/<file>), synchronously, and THROWS on any
 * url that is not in that exact absolute shape. So if the seam failed to resolve,
 * this path would not draw a blank — it would raise "bare node can only load
 * /asset/<Project>/<file> svg urls, got icons/database.svg", naming the unresolved
 * string. Both outcomes are asserted below.
 *
 * THE FIXTURE IS A NESTED RELATIVE REF ("icons/database.svg") on purpose. It is the
 * case that catches the encoding trap the grammar splits `assetRef` and
 * `assetRefPath` over: resolving it as a single segment yields
 * "/asset/Imitations/icons%2Fdatabase.svg", which names a file that does not exist.
 * On disk that is a read error the registry reports loudly, so the assertion is
 * simply that nothing was reported at all.
 *
 * PIXELS ARE NOT ASSERTED — the CLI's own header lists what it cannot draw, and its
 * omission counter is the thing that would flag a hole. What is asserted is that
 * RESOLUTION HAPPENED: the render exits 0, reports no svg-source failure, and writes
 * a PNG. That is the claim this file is responsible for.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = dirname(HERE);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** The PNG magic number — what proves a file is an actual image and not an empty
 *  placeholder the renderer wrote before failing. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * Pure function. A one-slide document whose only content is an SVG widget reading
 * `svgUrl`, owned by project `name`. `meta.name` IS the owning project — that is
 * what cameraFrameIR threads to the resolution seam.
 */
function svgDoc(name, svgUrl) {
  return {
    meta: { name, slideW: 320, slideH: 180, script: "" },
    slides: [{
      id: "s1",
      name: "Slide 1",
      transition: { type: "cut", seconds: 0, curve: "smooth", sound: null },
      delta: {
        items: {
          cam: { type: "camera", active: true, x: 0, y: 0, w: 320, h: 180, rotation: 0, scale: 1, background: "#ffffff" },
          ico: { type: "svg", active: true, x: 40, y: 20, w: 120, h: 120, rotation: 0, scale: 1, svgSource: "url", svgUrl },
        },
      },
    }],
  };
}

/** Command. Render `doc` through cli/render.js in a temp dir → {status, out, png}. */
function render(doc) {
  const dir = mkdtempSync(join(tmpdir(), "powerrp_relref_cli_"));
  const docPath = join(dir, "deck.powerrp.json");
  const pngPath = join(dir, "out.png");
  writeFileSync(docPath, JSON.stringify(doc));
  const res = spawnSync(process.execPath, [join(APP, "cli", "render.js"), docPath, pngPath, "--width", "320", "--height", "180"],
    { encoding: "utf8" });
  const png = res.status === 0 ? readFileSync(pngPath) : null;
  rmSync(dir, { recursive: true, force: true });
  return { status: res.status, out: `${res.stdout}${res.stderr}`, png };
}

// "Imitations" is a real project in this repo and icons/database.svg a real nested
// asset in it — the fixture must exist on disk for the disk-reading registry to have
// anything to resolve.
test("cli/render.js resolves a NESTED relative ref against the document's project", () => {
  const { status, out, png } = render(svgDoc("Imitations", "icons/database.svg"));
  assert.equal(status, 0, `render exited ${status}:\n${out}`);
  assert.ok(png && png.subarray(0, 4).equals(PNG_MAGIC), "no PNG was written");
  // The unresolved-ref failure is LOUD by construction (svg_source_registry throws
  // on a non-/asset/ url in bare node), so its absence is the proof of resolution.
  assert.ok(!/bare node can only load/.test(out), `the ref reached the registry UNRESOLVED:\n${out}`);
  assert.ok(!/svg_source_registry: failed to load/.test(out), `the resolved ref did not read off disk:\n${out}`);
  // Specifically NOT the single-segment encoding, which would name a missing file.
  assert.ok(!/icons%2Fdatabase\.svg/.test(out), `the nested path was encoded as ONE segment:\n${out}`);
});

test("cli/render.js still renders the ABSOLUTE form byte-for-byte as before", () => {
  // No migration: the form every pre-existing deck holds must keep working on this
  // path exactly as it did, so the two renders agree.
  const relative = render(svgDoc("Imitations", "icons/database.svg"));
  const absolute = render(svgDoc("Imitations", "/asset/Imitations/icons/database.svg"));
  assert.equal(absolute.status, 0, absolute.out);
  assert.ok(absolute.png.equals(relative.png),
    "the relative and absolute spellings of the SAME asset rendered DIFFERENT pixels");
});

test("cli/render.js reports a relative ref that names no such asset — never a silent blank", () => {
  // The failure mode this whole change exists to kill is a silently missing picture.
  // A ref that resolves correctly but points at nothing must still be reported.
  const { status, out } = render(svgDoc("Imitations", "icons/there_is_no_such_icon.svg"));
  assert.equal(status, 0, `a missing asset must not abort the render: ${out}`);
  assert.ok(/there_is_no_such_icon\.svg/.test(out), `the missing asset was NOT named:\n${out}`);
  // And it was looked for in the right place — i.e. resolution ran before the lookup.
  assert.ok(!/bare node can only load/.test(out), `it failed as an UNRESOLVED ref, not a missing file:\n${out}`);
});

console.log(`\n${passed} relative-ref CLI tests passed.`);
