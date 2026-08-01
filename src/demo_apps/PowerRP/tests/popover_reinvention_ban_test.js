/**
 * POPOVER-REINVENTION BAN guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/popover_reinvention_ban_test.js
 *
 * WHY THIS EXISTS. Three separate floating surfaces independently hand-rolled the
 * same three things, and the copies were not merely redundant — one of them was
 * WRONG in a way nothing could see. The kit (src/lib/popover.js) collapsed them;
 * this is the executable half, because the manifest's own measurement is that a
 * shared seam WITHOUT enforcement drifts back (a deduplication that ships no gate
 * has fixed today and nothing else — a tenth copy of one helper appeared during
 * the commit that removed the other nine).
 *
 * THE THREE BANS, and the real defect each one would have caught:
 *
 *  1. A SECOND REPARENT-TO-BODY ACTION. `portal` was byte-identical in
 *     src/lib/Modal.svelte and web/GalleryPopup.svelte, the second citing the
 *     first as precedent in a comment while copying it anyway. Detected BY SHAPE
 *     (an appendChild-to-body paired with a `destroy`), not by the name `portal`,
 *     so renaming the copy does not evade it. Download links and offscreen
 *     measurement hosts also append to the body and are NOT actions — they have
 *     no destroy — so they pass, which is why the shape test is the right one.
 *
 *  2. A SECOND VIEWPORT-EDGE MARGIN. `VIEWPORT_MARGIN = 6`, with the same
 *     justification, had been written three times.
 *
 *  3. A BUBBLE-PHASE `scroll` LISTENER ON window/document — the bug worth the
 *     whole exercise. A scroll event fired by an ELEMENT does not bubble
 *     (measured in-browser: one inner pane scroll gives a bubble-phase window
 *     listener 0 hits and a capture-phase one 1 hit). So a bubble listener sees
 *     only the DOCUMENT scrolling, and this app scrolls PANES, not the document.
 *     web/GalleryPopup.svelte registered its follow-the-anchor handler as
 *     `<svelte:window onscroll={…}>`, which Svelte compiles to
 *     `window.addEventListener("scroll", h)` with no capture option. The handler
 *     never fired once for the case its own docblock said it existed for — while
 *     src/lib/Dropdown.svelte, the file it was copied FROM, had written the reason
 *     for capture phase down in a comment twenty files away.
 *     A listener on an ELEMENT (`<ul onscroll={…}>`, `<div onscroll={…}>`) is a
 *     different and correct thing: that element IS the scroller. Only window and
 *     document are banned.
 *
 * WHAT IT SCANS: every .svelte and .js under the app's web/ AND all of src/lib.
 * Unlike tests/native_tooltip_ban_test.js — which scopes to the lib components
 * THIS app mounts, because that ban is an app style rule other demo apps are not
 * bound by — these three are correctness rules for any consumer. A second portal
 * or a bubble-phase scroll listener is wrong in the library too.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

// Paths resolve from THIS FILE, never process.cwd().
const powerRP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svelteLib = resolve(powerRP, "../../..");

/** The one home. Every ban below exempts exactly this file and nothing else. */
const KIT = resolve(svelteLib, "src/lib/popover.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/**
 * Pure function. Blanks HTML/Svelte and JavaScript comments, PRESERVING every
 * newline so reported line numbers stay exact.
 *
 * Both halves matter here. Comment-blindness breaks a grep gate in BOTH
 * directions — a codebase that explains itself in prose will have a gate call a
 * commented mention a definition (so a real rename still passes) and call a
 * commented example a copy (so a clean tree fails). This file's own docblock
 * quotes `window.addEventListener("scroll", h)` as the bug it bans; without
 * stripping, the guard would fail on its own explanation. And the newline
 * preservation is not cosmetic: a stripper that collapses a comment to "" shifts
 * every subsequent line number, and a sweep that cites the wrong line costs the
 * reader more than the finding saves.
 *
 * @param {string} src File text.
 * @returns {string} The same text, same length in lines, comments blanked.
 *
 * @example stripComments('<!-- never title="x" -->\nconst a = 1;')
 * '                        \nconst a = 1;'
 * @example // a line comment becomes trailing blanks; the code before it survives
 * stripComments('const gap = 6; // the edge margin').trimEnd()
 * 'const gap = 6;'
 * @example // and the line is exactly as long as it was, so columns do not shift
 * stripComments('const gap = 6; // the edge margin').length
 * 33
 * @example // a URL is not a line comment
 * stripComments('const u = "https://x.dev/a";')
 * 'const u = "https://x.dev/a";'
 * @example // block comments keep their newlines, so line numbers do not drift
 * stripComments('a\n/* two\n   lines *\/\nb').split('\n').length
 * 4
 */
export function stripComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

/**
 * Pure function. Every REPARENT-TO-BODY SVELTE ACTION in `src`, found by shape:
 * an `appendChild` onto `document.body` whose enclosing function also promises a
 * `destroy`. That pairing is what makes it an action rather than a one-shot DOM
 * append, and it is the whole reason this is not a search for the word "portal".
 *
 * @param {string} src File text (comments already stripped).
 * @returns {Array<{line: number, arg: string}>} One entry per action found.
 *
 * @example // the duplicated action, whatever it is called
 * portalActions('function reparent(el) {\n  document.body.appendChild(el);\n  return { destroy() { el.remove(); } };\n}')
 * // => [{ line: 2, arg: 'el' }]
 * @example // a download link is appended and clicked, never destroyed — not an action
 * portalActions('const link = document.createElement("a");\ndocument.body.appendChild(link);\nlink.click();')
 * // => []
 */
export function portalActions(src) {
  // How far after the append a `destroy` may sit and still belong to the same
  // action: the whole idiom is four lines, so a couple of hundred characters is
  // generous. Larger would start catching an unrelated destroy further down.
  const ACTION_TAIL_CHARS = 220;
  const found = [];
  for (const m of src.matchAll(/document\.body\.appendChild\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const tail = src.slice(m.index, m.index + ACTION_TAIL_CHARS);
    if (!/\bdestroy\b/.test(tail)) continue;
    found.push({ line: src.slice(0, m.index).split("\n").length, arg: m[1] });
  }
  return found;
}

/**
 * Pure function. Every BUBBLE-PHASE `scroll` listener on window or document in
 * `src` — the ones that cannot see a pane scroll and so silently do nothing.
 *
 * Two spellings reach the same wrong place. `<svelte:window onscroll={…}>`
 * compiles to `window.addEventListener("scroll", h)` with no options object, so
 * it is ALWAYS bubble phase and is banned outright; there is no capture spelling
 * of it. An explicit `addEventListener` is fine as long as it passes capture.
 *
 * A listener on a real element is untouched: that element is the scroller and its
 * own scroll event is exactly what it wants.
 *
 * @param {string} src File text (comments already stripped).
 * @returns {Array<{line: number, text: string}>} One entry per offender.
 *
 * @example // the dead handler this ban was written for
 * bubbleScrollListeners('<svelte:window onscroll={onWindowScroll} onresize={r} />')
 * // => [{ line: 1, text: '<svelte:window onscroll=' }]
 * @example // capture phase is the correct form and passes
 * bubbleScrollListeners('window.addEventListener("scroll", place, true);')
 * // => []
 * @example // an element scrolling itself is not this bug
 * bubbleScrollListeners('<ul class="dd-list" onscroll={onListScroll}>')
 * // => []
 */
export function bubbleScrollListeners(src) {
  const found = [];
  const at = (i, text) => found.push({ line: src.slice(0, i).split("\n").length, text });
  for (const m of src.matchAll(/<svelte:window\b[^>]*?\bonscroll\s*=/g)) {
    at(m.index, "<svelte:window onscroll=");
  }
  for (const m of src.matchAll(/\b(?:window|document)\.addEventListener\(\s*["']scroll["']\s*,([^;]*?)\)\s*;/g)) {
    if (/\btrue\b|capture\s*:\s*true/.test(m[1])) continue;
    at(m.index, m[0].replace(/\s+/g, " ").slice(0, 90));
  }
  return found;
}

/** Query. Every .svelte/.js path under `dir`, recursively, as absolute paths. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") continue; // build output
      out.push(...sourceFiles(p));
    } else if (entry.name.endsWith(".svelte") || entry.name.endsWith(".js")) {
      out.push(p);
    }
  }
  return out;
}

const scanned = [...sourceFiles(resolve(powerRP, "web")), ...sourceFiles(resolve(svelteLib, "src/lib"))];
const show = (f) => relative(svelteLib, f);

// The sweep must actually be looking at something. A path typo would otherwise
// make every ban below pass on an empty set — a gate that cannot fail.
assert.ok(scanned.length > 40, `scanned only ${scanned.length} files — the walk broke, not the app`);
assert.ok(scanned.includes(KIT), "the kit itself is not in the scan set — the exemption below would be meaningless");

test("exactly one reparent-to-body action exists, and it is the kit's", () => {
  const offenders = [];
  for (const f of scanned) {
    if (f === KIT) continue;
    for (const v of portalActions(stripComments(readFileSync(f, "utf8")))) {
      offenders.push(`${show(f)}:${v.line}  document.body.appendChild(${v.arg}) + destroy`);
    }
  }
  assert.deepEqual(
    offenders, [],
    "a second portal action was written. There is one:\n" +
    '  import { portal } from "<path to>/src/lib/popover.js";\n' +
    "and it is used as `use:portal` on the surface's root element:\n  " + offenders.join("\n  ")
  );
});

test("exactly one viewport-edge margin is declared, and it is the kit's", () => {
  const offenders = [];
  for (const f of scanned) {
    if (f === KIT) continue;
    const src = stripComments(readFileSync(f, "utf8"));
    for (const m of src.matchAll(/\b(?:const|let|var)\s+VIEWPORT_MARGIN\s*=/g)) {
      offenders.push(`${show(f)}:${src.slice(0, m.index).split("\n").length}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    "VIEWPORT_MARGIN is declared outside the kit. It had been written three times with " +
    "the same value and the same reason; import it instead:\n" +
    '  import { VIEWPORT_MARGIN } from "<path to>/src/lib/popover.js";\n  ' + offenders.join("\n  ")
  );
});

test("no bubble-phase scroll listener on window or document exists anywhere", () => {
  const offenders = [];
  for (const f of scanned) {
    for (const v of bubbleScrollListeners(stripComments(readFileSync(f, "utf8")))) {
      offenders.push(`${show(f)}:${v.line}  ${v.text}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    "a scroll listener on window/document was registered in BUBBLE phase, where it cannot " +
    "see any element scrolling — scroll events do not bubble. If it is meant to follow an " +
    "anchor through a scrolling pane, use the kit, which registers all three while-open " +
    "listeners in the right phases:\n" +
    '  import { trackAnchoredSurface } from "<path to>/src/lib/popover.js";\n' +
    "If you genuinely want only the DOCUMENT's own scroll, say so with an explicit " +
    'window.addEventListener("scroll", h, true) and a target check.\n  ' + offenders.join("\n  ")
  );
});

test("the kit's three seams each have at least two real consumers", () => {
  // Ledger C-1: a shared module is born with two or more real consumers, or it is
  // speculative generality — a dialect with no speakers. This asserts the kit did
  // not merely EXIST but was ADOPTED, which is the half that historically decayed:
  // seams landed with a same-commit sweep reached full adoption, seams landed
  // without one reached 3%, 8% and 0%, and none ever caught up.
  const importers = new Map(); // symbol -> [file]
  for (const f of scanned) {
    if (f === KIT) continue;
    const src = stripComments(readFileSync(f, "utf8"));
    const m = src.match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*\/popover\.js["']/);
    if (!m) continue;
    for (const sym of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!importers.has(sym)) importers.set(sym, []);
      importers.get(sym).push(show(f));
    }
  }
  for (const sym of ["popupPosition", "portal", "trackAnchoredSurface"]) {
    const users = importers.get(sym) ?? [];
    assert.ok(
      users.length >= 2,
      `${sym} has ${users.length} consumer(s) (${users.join(", ") || "none"}). The kit exists ` +
      "because each seam had two or more real hand-rolled copies; if a seam is down to one " +
      "consumer it should move back into that consumer, not sit in the library as a dialect."
    );
  }
});

console.log(`\n${passed} popover-reinvention-ban tests passed`);
