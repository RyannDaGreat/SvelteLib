/** The Multipoint render-resolution leaf survives every parse path, including the
 * camera background (parsed by resolvedBackgroundFill, then re-parsed by ir.rect). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePaint, rect } from "../render_gpu/ir.js";
import { resolvedBackgroundFill } from "../render_gpu/ports.js";
import { getMultipointPreset } from "../core/multipoint_presets.js";
import { MULTIPOINT_RESOLUTIONS, MULTIPOINT_DEFAULT_RESOLUTION } from "../core/properties.js";

const withResolution = (value) => ({ ...getMultipointPreset("neon-spiral"), multipointResolution: value });

test("the default resolution is omitted, so pre-feature paints parse byte-identically", () => {
  const plain = getMultipointPreset("neon-spiral");
  assert.equal("resolution" in parsePaint(plain), false);
  assert.deepEqual(parsePaint(withResolution(MULTIPOINT_DEFAULT_RESOLUTION)), parsePaint(plain));
});

test("every non-default resolution survives a second parse (parsePaint is re-entrant)", () => {
  for (const value of MULTIPOINT_RESOLUTIONS.filter((v) => v !== MULTIPOINT_DEFAULT_RESOLUTION)) {
    const once = parsePaint(withResolution(value));
    assert.equal(once.resolution, value === "auto" ? "auto" : Number(value));
    assert.deepEqual(parsePaint(once), once, `resolution ${value} lost on re-parse`);
  }
});

test("a camera-background resolution reaches the background rect op", () => {
  // The exact seam the user hit: resolvedBackgroundFill parses, then ir.rect re-parses.
  const op = rect({ x: 0, y: 0, w: 1280, h: 720, fill: resolvedBackgroundFill(withResolution("128"), []) });
  assert.equal(op.fill.resolution, 128);
  const big = rect({ x: 0, y: 0, w: 1280, h: 720, fill: resolvedBackgroundFill(withResolution("2048"), []) });
  assert.equal(big.fill.resolution, 2048);
});

test("an invalid resolution is refused loudly, in either spelling", () => {
  assert.throws(() => parsePaint(withResolution("300")), /multipointResolution must be one of/);
  assert.throws(() => parsePaint({ ...parsePaint(withResolution("1024")), resolution: 300 }), /multipointResolution must be one of/);
});
