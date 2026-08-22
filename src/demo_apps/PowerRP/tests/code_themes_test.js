/**
 * core/code_themes.js — the code block's vendored VS Code colour themes (R7-41).
 *
 * WHAT THIS SUITE IS FOR. The palettes are DATA, and wrong data is the failure
 * mode nothing else here can see: a mistyped hex still renders a perfectly nice
 * picture, just not the theme it claims to be. (The blue-noise tile is the
 * standing precedent — a confident docblock over bytes that were something else,
 * caught by the user's eye rather than by a green suite.) So these tests pin the
 * things a render test cannot: that every theme covers every token class the
 * TOKENIZER actually emits, that the two legacy palettes are frozen to the exact
 * hexes every saved deck already renders with, and that distinct themes really do
 * produce distinct pixels rather than sixteen names for one look.
 *
 * THE CLASS LIST IS DERIVED, NEVER TRANSCRIBED. It comes from codeHighlight's
 * KINDS export, so a NEW token kind fails every theme here on the day it is added
 * instead of silently falling back to `plain` in sixteen palettes at once. This
 * is the BUNDLES.effects lesson applied to a colour table.
 *
 * Run: node src/demo_apps/PowerRP/tests/code_themes_test.js
 */

import assert from "node:assert/strict";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, litSetDistance } from "./imageDistinctness.js";
import { fitRectView } from "../core/view.js";
import { KINDS } from "../core/codeHighlight.js";
import { parseColor } from "../render_gpu/ir.js";
import {
  CODE_PALETTES, CODE_THEME_IDS, CODE_THEME_LABELS, THEME_LICENSES,
  DEFAULT_CODE_THEME, codeTheme, codeThemeProps, kindColor,
} from "../core/code_themes.js";
import { codeblockPlugin } from "../plugins/codeblock.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

/** The palette fields a theme must define: every tokenizer KIND, plus the two
 *  chrome colours the layout draws (box background and line-number gutter). */
const REQUIRED_FIELDS = [...KINDS, "bg", "gutter"];
const HEX = /^#[0-9a-f]{6}$/;

/** The ids vendored from upstream themes — everything except the two legacy ones,
 *  derived so a new theme joins this set automatically. */
const LEGACY_IDS = ["dark", "light"];
const VENDORED_IDS = CODE_THEME_IDS.filter((id) => !LEGACY_IDS.includes(id));

// ── the table's shape ─────────────────────────────────────────────────────────

test(`the roster carries ${CODE_THEME_IDS.length} themes, legacy first`, () => {
  assert.ok(CODE_THEME_IDS.length >= 15,
    `only ${CODE_THEME_IDS.length} themes — the R7-41 roster is the two legacy palettes plus the vendored VS Code set`);
  assert.deepEqual(CODE_THEME_IDS.slice(0, 2), LEGACY_IDS,
    "the two legacy ids must stay first in the table (dropdown order)");
  assert.equal(DEFAULT_CODE_THEME, "dark", "the default theme id must remain the legacy dark palette");
});

test("every theme defines every token class the TOKENIZER emits, plus bg and gutter", () => {
  for (const id of CODE_THEME_IDS)
    for (const field of REQUIRED_FIELDS)
      assert.ok(CODE_PALETTES[id][field],
        `theme "${id}" has no "${field}" — KINDS grew or a palette row is incomplete; an undefined class silently falls back to plain`);
});

test("every colour is an opaque 6-digit lowercase hex (published alpha is composited, not carried)", () => {
  for (const id of CODE_THEME_IDS)
    for (const field of REQUIRED_FIELDS)
      assert.match(CODE_PALETTES[id][field], HEX,
        `theme "${id}" field "${field}" is "${CODE_PALETTES[id][field]}" — an 8-digit or 3-digit hex must be normalized/composited before it lands in the table`);
});

test("every theme has a display label and every vendored theme has its MIT notice", () => {
  for (const id of CODE_THEME_IDS)
    assert.ok(CODE_THEME_LABELS[id], `theme "${id}" has no display label — the dropdown would show a raw key`);
  for (const id of VENDORED_IDS)
    assert.ok(THEME_LICENSES[id]?.includes("MIT"),
      `vendored theme "${id}" carries no MIT notice — reproducing it is the licence's actual requirement`);
});

test("Material Theme is absent — its source was withdrawn and it carries no licence", () => {
  for (const id of CODE_THEME_IDS)
    assert.ok(!/material/i.test(id),
      `"${id}" vendors Material Theme, whose repo is now the commercial Vira Theme with no licence file — its colours are not ours to ship`);
});

// ── THE LEGACY LAW ────────────────────────────────────────────────────────────
// These are the hexes the palettes shipped with. Every saved deck stores one of
// these two ids, and render_gpu/tests/pdf_scenes.js pins `theme: "dark"` against
// a committed reference PDF. Transcribed LITERALLY on purpose: deriving them from
// the table would assert only that the table equals itself.

const FROZEN_LEGACY = {
  dark: {
    bg: "#1e222a", gutter: "#5c6370",
    plain: "#c8ccd4", keyword: "#c678dd", string: "#98c379", comment: "#7f848e",
    number: "#d19a66", function: "#61afef", property: "#e5c07b", punct: "#abb2bf",
  },
  light: {
    bg: "#fbfbfa", gutter: "#a0a1a7",
    plain: "#383a42", keyword: "#a626a4", string: "#50a14f", comment: "#a0a1a7",
    number: "#986801", function: "#4078f2", property: "#c18401", punct: "#383a42",
  },
};

test("LEGACY LAW: dark and light are byte-identical to their pre-R7-41 values", () => {
  for (const id of LEGACY_IDS)
    assert.deepEqual(CODE_PALETTES[id], FROZEN_LEGACY[id],
      `theme "${id}" changed — every existing deck stores this id and would silently restyle`);
});

test("legacy dark is NOT upstream One Dark Pro — they are separate rows, both kept", () => {
  assert.notEqual(CODE_PALETTES.dark.bg, CODE_PALETTES.oneDarkPro.bg,
    "legacy dark (#1e222a) and real One Dark Pro (#282c34) are different palettes; collapsing them would restyle old decks");
});

// ── the lookup seams ──────────────────────────────────────────────────────────

test("codeTheme resolves every id, and falls back to the default for an unknown one", () => {
  for (const id of CODE_THEME_IDS) assert.equal(codeTheme(id), CODE_PALETTES[id]);
  // A document may name a theme this build does not have: it must render readable
  // code, not throw and not vanish.
  assert.equal(codeTheme("no-such-theme"), CODE_PALETTES[DEFAULT_CODE_THEME]);
  assert.equal(codeTheme(undefined), CODE_PALETTES[DEFAULT_CODE_THEME]);
});

test("kindColor returns the class colour, and falls back to plain for an unknown kind", () => {
  assert.equal(kindColor("keyword", codeTheme("dracula")), "#ff79c6");
  assert.equal(kindColor("mystery", codeTheme("dark")), CODE_PALETTES.dark.plain);
  for (const id of CODE_THEME_IDS)
    for (const kind of KINDS)
      assert.match(kindColor(kind, codeTheme(id)), HEX, `kindColor("${kind}") is not a hex in "${id}"`);
});

test("codeThemeProps carries the theme's OWN background, so a light theme is readable", () => {
  // A stored `fill` always wins over the palette's bg in emit(), so applying a
  // theme means writing both — otherwise Solarized Light's ink lands on a dark box.
  for (const id of CODE_THEME_IDS)
    assert.deepEqual(codeThemeProps(id), { theme: id, fill: CODE_PALETTES[id].bg });
});

// ── THE ROW WRITES THE BACKGROUND (user ruling, 2026-08-12) ───────────────────
// "A VS Code theme is background + token colors; a Solarized Light pick that
// leaves the box charcoal fails the plain meaning." The theme row declares a
// `companion` hook so picking a theme stages {theme, fill} in ONE preview, and
// therefore ONE undo unit. These pin the DECLARATION and its rendered effect;
// tests/inspector_code_theme_probe.js drives the real dropdown in a browser.

test("the theme row declares a companion write, and it is the theme's own background", () => {
  const row = codeblockPlugin.inspector.find((r) => r.key === "theme");
  assert.equal(typeof row.companion, "function",
    "the theme row declares no `companion` — picking a theme would leave the box at its old fill");
  for (const id of CODE_THEME_IDS)
    assert.deepEqual(row.companion(id), [["fill", CODE_PALETTES[id].bg]],
      `the theme row's companion for "${id}" is not that theme's own background`);
});

test("APPLYING a theme puts that theme's background in the emitted box op", () => {
  // The end of the chain the ruling is about: the companion pair reaches the
  // painter. Rendered through the real emit(), against a block whose stored fill
  // is the LEGACY dark one — i.e. exactly the "switch an existing block to
  // Solarized Light" case that used to leave a charcoal box.
  for (const id of CODE_THEME_IDS) {
    const applied = { ...codeblockPlugin.defaults, fill: CODE_PALETTES.dark.bg, ...codeThemeProps(id) };
    const [box] = codeblockPlugin.emit({ ...applied, code: "const x = 1;", w: 200, h: 60 });
    assert.deepEqual(box.fill, parseColor(CODE_PALETTES[id].bg),
      `applying "${id}" left the box at ${JSON.stringify(box.fill)} instead of the theme's ${CODE_PALETTES[id].bg}`);
  }
});

test("A MANUAL FILL AFTER a theme pick still wins (apply path only, not render precedence)", () => {
  // Ordinary property order: the companion writes `fill`, and a later edit
  // overwrites it. emit() is unchanged — it still reads `s.fill ?? palette.bg`.
  const chosen = "#123456";
  const state = { ...codeblockPlugin.defaults, ...codeThemeProps("solarizedLight"), fill: chosen };
  const [box] = codeblockPlugin.emit({ ...state, code: "x", w: 120, h: 40 });
  assert.deepEqual(box.fill, parseColor(chosen), "a fill edited after the theme pick was overridden by the palette");
});

test("A DOC THAT NEVER TOUCHES THE ROW is untouched — the ruling changed the apply path only", () => {
  // The legacy law restated at the render seam: a stored theme+fill pair renders
  // through emit() exactly as before, because emit() still prefers the stored
  // fill. Only an actual row interaction writes a companion.
  for (const id of LEGACY_IDS) {
    const legacyDoc = { ...codeblockPlugin.defaults, theme: id, fill: "#0c0e12" }; // a Terminal-preset fill
    const [box] = codeblockPlugin.emit({ ...legacyDoc, code: "x", w: 120, h: 40 });
    assert.deepEqual(box.fill, parseColor("#0c0e12"),
      `theme "${id}" on an untouched doc had its stored fill replaced — load-time precedence changed`);
  }
});

// ── distinctness: the themes are not sixteen names for one look ───────────────

test("no two themes share a background (they are visibly different rows)", () => {
  const seen = new Map();
  for (const id of CODE_THEME_IDS) {
    const bg = CODE_PALETTES[id].bg;
    assert.ok(!seen.has(bg), `themes "${seen.get(bg)}" and "${id}" share the background ${bg} — one of them is a duplicate row`);
    seen.set(bg, id);
  }
});

test("no two themes are the same palette under two names", () => {
  const seen = new Map();
  for (const id of CODE_THEME_IDS) {
    const key = JSON.stringify(CODE_PALETTES[id]);
    assert.ok(!seen.has(key), `themes "${seen.get(key)}" and "${id}" are identical palettes`);
    seen.set(key, id);
  }
});

test("every theme separates comment from plain — the one contrast that must never collapse", () => {
  // A comment the same colour as code is the single most damaging collision: the
  // reader loses the ability to tell prose from program at a glance.
  for (const id of CODE_THEME_IDS)
    assert.notEqual(CODE_PALETTES[id].comment, CODE_PALETTES[id].plain,
      `theme "${id}" paints comments in the plain ink — comments would be indistinguishable from code`);
});

// ── the plugin seam ───────────────────────────────────────────────────────────

test("the codeblock theme row offers the whole roster, derived from the table", () => {
  const row = codeblockPlugin.inspector.find((r) => r.key === "theme");
  assert.ok(row, "codeblock declares no `theme` row");
  assert.deepEqual(row.options, CODE_THEME_IDS,
    "the theme row's options are not the table's ids — the roster was transcribed instead of derived");
  assert.equal(row.optionLabels, CODE_THEME_LABELS, "the theme row does not use the table's display labels");
});

test("the codeblock default still names the legacy dark theme", () => {
  assert.equal(codeblockPlugin.defaults.theme, DEFAULT_CODE_THEME);
  assert.equal(codeblockPlugin.defaults.fill, CODE_PALETTES.dark.bg,
    "the default fill must stay the legacy dark background — a fresh block's look is frozen too");
});

// ── RENDER SMOKE: different themes really do produce different pixels ─────────
// The table could satisfy every check above and still fail to reach the painter
// (a seam that ignores `theme` would pass all of it). So this renders the SAME
// snippet under a spread of themes through the real plugin emit() and measures
// that the pictures differ. A code block paints its own opaque background, so no
// mid-grey backdrop is needed — the box covers the canvas.

const W = 360, H = 160;
const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
const SNIPPET = [
  "// count the words",
  "function tally(items) {",
  '  const seen = {};',
  "  for (const it of items) seen[it.name] = 42;",
  "  return seen;",
  "}",
].join("\n");

async function frame(themeId) {
  const state = {
    ...codeblockPlugin.defaults, ...codeThemeProps(themeId),
    code: SNIPPET, language: "javascript",
    x: 0, y: 0, w: W, h: H, fontSize: 13, padding: 10, lineNumbers: true,
  };
  return readPng(await renderToPng(codeblockPlugin.emit(state), VIEW, { width: W, height: H }));
}

const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H }));
const FRAMES = [];
for (const id of CODE_THEME_IDS) FRAMES.push({ id, png: await frame(id) });

test(`all ${CODE_THEME_IDS.length} themes render a DIFFERENT picture (${(CODE_THEME_IDS.length * (CODE_THEME_IDS.length - 1)) / 2} pairs)`, () => {
  // CALIBRATED, not guessed — the whole roster was measured before this bound was
  // written (the preset suites' convention). Over all 120 pairs the narrowest are:
  //   3.31  oneDarkPro <-> dracula     (#282c34 vs #282a36)
  //   3.56  dark       <-> catppuccinMocha (#1e222a vs #1e1e2e)
  //   3.86  monokai    <-> gruvboxDark (#272822 vs #282828)
  //   ...
  //   225.36 widest: nightOwl <-> githubLight
  // Those three narrow pairs are REAL and are being kept: nearly every dark editor
  // theme sits on the same charcoal, because that convention is what makes them
  // dark editor themes. What separates them is the TOKEN colour, which is a small
  // fraction of the pixels on a mostly-background frame — so a low mean here is
  // expected and is not evidence of a duplicate row (the exact-palette and
  // distinct-background tests above are what rule duplicates out).
  // The bound is 3 — under the narrowest shipped pair, and still triple
  // DISPLAYABLE_CODE_VALUE. A seam that ignored `theme` would render every pair
  // at 0 and fail here immediately, which is what this test is for.
  const MIN_SEPARATION = 3;
  let narrowest = null;
  for (let i = 0; i < FRAMES.length; i++)
    for (let j = i + 1; j < FRAMES.length; j++) {
      const d = litSetDistance(FRAMES[i].png, FRAMES[j].png, BLANK);
      if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: FRAMES[i].id, b: FRAMES[j].id, d };
      assert.ok(d.meanAbs >= MIN_SEPARATION,
        `themes "${FRAMES[i].id}" and "${FRAMES[j].id}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the theme is not reaching the painter, or they are the same look twice`);
    }
  console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
});

// Re-rendered BEFORE the test so the synchronous test() helper never receives an
// async fn — an async body would resolve after the harness moved on and its
// assertion would never be awaited (a test that cannot fail).
const DRACULA_AGAIN = await frame("dracula");

test("the SAME theme renders the SAME pixels twice (emit stays a pure function of state)", () => {
  // This is the determinism law measured at the theme seam.
  const d = litSetDistance(FRAMES[CODE_THEME_IDS.indexOf("dracula")].png, DRACULA_AGAIN, BLANK);
  assert.equal(d.maxAbs, 0, `the same theme rendered twice differs by ${d.maxAbs} code values — emit() is not pure in the theme path`);
});

console.log(`\n${passed} code-theme tests passed`);
