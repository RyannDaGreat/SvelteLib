/**
 * THE LABEL⟷VALUE SPLIT — its key vocabulary and its drag arithmetic, in bare node.
 *
 * R6-8.1a (user ruling, 2026-08-01): a second divider governs VARIABLE PROPERTIES,
 * "the same kind of UI, not the same line" — same handle, same CSS, a DIFFERENT
 * number, because "if there was a second level that second level would not be
 * synced with the first level, because then that would make them collide
 * visually."
 *
 * §3 IS THE ONE THAT EARNS THIS FILE. The split has a failure mode that is
 * completely silent: a divider carrying a non-default `dividerKey` DRAGS and
 * PERSISTS correctly while the rows it sits over never move, because nothing
 * re-published `--a-label-frac` for that family. Nothing throws, the number in
 * localStorage is right, and the only symptom is a handle that does not do
 * anything. The two halves live in different files and neither implies the other,
 * so this asserts they agree.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LABEL_DIVIDER_KEYS, LABEL_DIVIDER_PROPERTY, LABEL_DIVIDER_VARIABLE,
  LABEL_FRAC_BOUNDS, LABEL_FRAC_DEFAULT, fractionAt, labelFracSettingKey,
} from "../web/labelFrac.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "../web");

/**
 * Pure function. Source with `//` line comments and block comments blanked,
 * LINE COUNT PRESERVED (ledger C-14: a comment-blind grep over this codebase
 * fails in both directions, and `^\s*` would eat blank lines and drift every
 * line number after it, so the line-comment rule matches horizontal space only).
 *
 * @param {string} src Source text.
 * @returns {string} The same text with comment bodies blanked.
 *
 * @example stripComments('a\n  // b\nc')
 * 'a\n\nc'
 * @example // a mount described in prose must not count as a mount
 * stripComments('  // <LabelDivider dividerKey={X} />').trim()
 * ''
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

let checks = 0;
const ok = (msg) => { checks += 1; console.log(`  ok   ${msg}`); };

// ── §1 THE KEY VOCABULARY ───────────────────────────────────────────────────
assert.deepEqual([...new Set(LABEL_DIVIDER_KEYS)], LABEL_DIVIDER_KEYS, "divider keys must be distinct");
assert.ok(LABEL_DIVIDER_KEYS.includes(LABEL_DIVIDER_PROPERTY));
assert.ok(LABEL_DIVIDER_KEYS.includes(LABEL_DIVIDER_VARIABLE));
assert.notEqual(LABEL_DIVIDER_PROPERTY, LABEL_DIVIDER_VARIABLE,
  "the two families must be different keys — sharing one is the design the ruling overturned");
ok(`${LABEL_DIVIDER_KEYS.length} distinct divider families`);

// THE PROPERTY FAMILY KEEPS THE BARE HISTORICAL localStorage KEY. Not nostalgia:
// that key holds a split real users have already dragged, and adding a suffix
// would silently reset every one of them to the default with no error anywhere.
assert.equal(labelFracSettingKey(LABEL_DIVIDER_PROPERTY), "powerrp.labelFrac",
  "the property family's stored key changed — every existing user's split silently resets");
assert.equal(labelFracSettingKey(LABEL_DIVIDER_VARIABLE), "powerrp.labelFrac.variable");
const storeKeys = LABEL_DIVIDER_KEYS.map(labelFracSettingKey);
assert.deepEqual([...new Set(storeKeys)], storeKeys, "two families must not share a localStorage key");
assert.throws(() => labelFracSettingKey("nope"), /unknown divider key/,
  "an unknown key must fail loudly rather than mint a stray localStorage entry");
ok("stored keys are stable, distinct, and refuse an unknown family");

// ── §2 THE DRAG ARITHMETIC ──────────────────────────────────────────────────
const B = LABEL_FRAC_BOUNDS;
assert.ok(B.min < LABEL_FRAC_DEFAULT && LABEL_FRAC_DEFAULT < B.max,
  "the default must lie strictly inside the clamp bounds, or a fresh divider starts pinned to an end stop");
assert.equal(fractionAt(140, 20, 400, B), 0.3);
assert.equal(fractionAt(0, 20, 400, B), B.min, "left of the block clamps to min");
assert.equal(fractionAt(1000, 20, 400, B), B.max, "right of the block clamps to max");
// A zero-width block names no fraction. This is reachable: a category is measured
// on the frame it expands, before layout has given the block a width.
assert.equal(fractionAt(140, 20, 0, B), B.min);
ok("fractionAt clamps both ends and survives a zero-width block");

// ── §3 A NON-DEFAULT FAMILY MUST BE PUBLISHED WHERE IT IS MOUNTED ───────────
// The divider positions itself from `calc(var(--a-label-frac) * 100%)` — the same
// token every row grid reads — so a nested block joins a family by RE-PUBLISHING
// that token with the family's number. Mounting with a key and forgetting to
// publish gives a handle that persists a number nothing reads; publishing without
// the key gives rows that move only when the OTHER family is dragged. Both are
// silent, so both are asserted, in both directions and per file.
// THE PROPERTY FAMILY IS THE ONE LEGITIMATE CROSS-FILE CASE and is checked
// separately: it is published ONCE on the app root, because the Property Panel and
// the Variables Panel are separate subtrees in separate panes and the round-11
// "columns line up" ruling makes their shared ancestor the only correct home. Its
// dividers therefore mount in other files with no key at all (the default). Every
// OTHER family is a nested block re-publishing the token for its own rows, so for
// those the mount and the publication are necessarily in the same file.
{
  const rootSrc = stripComments(readFileSync(resolve(WEB, "App.svelte"), "utf8"));
  assert.match(rootSrc, /class="app"[^>]*style:--a-label-frac=\{app\.labelFrac\[LABEL_DIVIDER_PROPERTY\]\}/,
    "web/App.svelte must publish the PROPERTY family on the app root — without it every unkeyed divider and every row grid falls back to app.css's static default and the drag does nothing");
  ok("the property family is published once, on the app root");

  const files = readdirSync(WEB).filter((f) => f.endsWith(".svelte"));
  let mounts = 0;
  for (const f of files) {
    const src = stripComments(readFileSync(resolve(WEB, f), "utf8"));
    const keyed = [...src.matchAll(/<LabelDivider[^>]*dividerKey=\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
    const published = [...src.matchAll(/style:--a-label-frac=\{app\.labelFrac\[([A-Za-z0-9_]+)\]\}/g)]
      .map((m) => m[1]).filter((k) => k !== "LABEL_DIVIDER_PROPERTY");
    for (const k of new Set(keyed)) {
      mounts += 1;
      assert.ok(published.includes(k),
        `web/${f} mounts a LabelDivider with dividerKey={${k}} but never publishes --a-label-frac for it — the handle would drag and persist while the rows under it never move`);
    }
    for (const k of new Set(published))
      assert.ok(keyed.includes(k),
        `web/${f} publishes --a-label-frac for ${k} but mounts no LabelDivider with that key — those rows would be un-draggable`);
    // A bare <LabelDivider {app} /> is the PROPERTY family by default and must NOT
    // sit inside a nested block that re-publishes the token, or it would write one
    // family's number and read another's.
    if (published.length > 0)
      assert.ok(!/<LabelDivider \{app\} \/>/.test(src),
        `web/${f} mixes a default-family LabelDivider with a re-published --a-label-frac — that divider would write one number and read another`);
  }
  assert.ok(mounts >= 1,
    "no keyed LabelDivider mount found anywhere — R6-8.1a's second family is not wired up, and this gate is asserting nothing");
  // `mounts` counts (file, family) BINDINGS, not <LabelDivider> tags: PaintField
  // mounts two segments on one family, which is the point of a family.
  ok(`${mounts} keyed (file, family) binding(s), each published where it is mounted`);
}

// ── §4 THE APP EXPOSES THE KEYED SEAM ───────────────────────────────────────
// web/app.svelte.js is not importable in bare node (it uses Svelte runes), so its
// shape is read as text. Narrow on purpose: only that the two commands take a KEY.
// The single-argument forms they replace would silently persist a key STRING as a
// fraction — Number("variable") is NaN, and the clamp would let it through.
{
  const app = stripComments(readFileSync(resolve(WEB, "app.svelte.js"), "utf8"));
  assert.match(app, /setLabelFrac\(key, frac\)/,
    "web/app.svelte.js setLabelFrac must take (key, frac) — the one-argument form would take the key AS the fraction");
  assert.match(app, /resetLabelFrac\(key\)/,
    "web/app.svelte.js resetLabelFrac must take a key, or a double-click resets the wrong family");
  assert.ok(!/export const LABEL_FRAC_BOUNDS/.test(app),
    "LABEL_FRAC_BOUNDS must have ONE home (web/labelFrac.js): two clamps that can drift is how a drag writes a value the store silently rewrites");
  ok("app.svelte.js exposes the keyed seam and holds no second copy of the bounds");
}

console.log(`labelFrac: ${checks} checks passed`);
