/**
 * NATIVE-TOOLTIP BAN guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/native_tooltip_ban_test.js
 *
 * WHY THIS EXISTS, in the user's words: "have an agent hunt down all regular
 * tooltips… make sure they only use our custom tooltips, our immediate tooltips.
 * This violates a convention."
 *
 * The convention is the manifest's: hover help in app chrome uses SvelteLib's
 * Tooltip (src/lib/Tooltip.svelte), which appears IMMEDIATELY, and never the
 * native `title` attribute, which waits about a second and cannot be styled,
 * placed or themed. The ban was already written down in three component headers
 * — and violated anyway, in the very file whose neighbour comment restates it:
 * SlideNav's double-click-to-rename span used a native title while the eye toggle
 * two lines below it used Tooltip. A rule that lives only in prose gets broken by
 * the next edit, so this is the executable copy.
 *
 * WHAT IT SCANS: every .svelte file under web/ (the app's own chrome) plus the
 * src/lib components the app MOUNTS. The library is shared with other demo apps
 * that are not bound by this ban — video_slice_annotator passes a real `title` to
 * Thumbnail on purpose — so the sweep asks which lib files this app imports rather
 * than policing all of src/lib.
 *
 * WHAT COUNTS AS A VIOLATION: a `title=` ATTRIBUTE on an HTML element. Three uses
 * are exempt because they are not tooltips at all, and each is checked by shape
 * rather than waved through by filename:
 *   (1) a `title` PROP passed to a component whose own contract renders it as
 *       visible text — `<Modal title="Save Project">` is a dialog HEADING;
 *   (2) an SVG `<title>` ELEMENT, which is the accessible name of a graphic;
 *   (3) a `title` prop DECLARED by a component in its own $props() block.
 * Anything else is a native tooltip and fails.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

// Paths resolve from THIS FILE, never process.cwd().
const powerRP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svelteLib = resolve(powerRP, "../../..");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/**
 * Pure function. Strips HTML/Svelte comments from source, so a `title=` quoted
 * inside a docblock (this app's headers discuss the ban at length) is not read as
 * code. Without this the guard would fail on the very comments that explain it.
 *
 * @param {string} src File text.
 * @returns {string} The same text with `<!-- … -->` runs blanked.
 *
 * @example stripComments('<a title="x">')
 * '<a title="x">'
 * @example stripComments('<!-- never title="x" -->\n<b>')
 * '\n<b>'
 */
export function stripComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Pure function. The component tag names a Svelte file imports — i.e. the names
 * that, when they appear as `<Name title=…>`, are a PROP and not an attribute.
 *
 * Reading the import list is what makes the exemption structural: `<Modal
 * title="Rename Project">` is exempt because Modal is a component this file
 * imported, not because "Modal" is on a hand-kept allowlist that the next
 * component would have to be added to.
 *
 * @param {string} src File text.
 * @returns {Set<string>} Imported component names (capitalised bindings).
 *
 * @example componentImports('import Modal from "../../../lib/Modal.svelte";')
 * // => Set { 'Modal' }
 * @example componentImports('import { getPath } from "./deltas.js";')
 * // => Set {}   (lowercase / named utility imports are not components)
 */
export function componentImports(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*["'][^"']+\.svelte["']/g)) {
    if (/^[A-Z]/.test(m[1])) names.add(m[1]);
  }
  return names;
}

/**
 * Pure function. The index of the `>` that CLOSES the tag opening at `open`, or
 * -1 if the tag never closes.
 *
 * A plain `indexOf(">")` is wrong here and silently defeated the whole guard on
 * its first run: a Svelte attribute value can be an expression block, and an
 * arrow function inside one contains a `>`. In
 *   `<span ondblclick={(e) => { … }} title="Double-click to rename">`
 * the first `>` belongs to `=>`, so the scan concluded the `title=` was outside
 * any tag and reported zero violations on a file that had one. So `{…}` blocks
 * (nested-brace aware) and quoted strings are skipped over.
 *
 * @param {string} src File text.
 * @param {number} open Index of the tag's `<`.
 * @returns {number} Index of the closing `>`, or -1.
 *
 * @example // a `>` inside an arrow function does not close the tag
 * tagEnd('<span onclick={(e) => f(e)} title="x">y</span>', 0)
 * // => 38
 * @example tagEnd('<div class="a">', 0)
 * 14
 * @example // an attribute value may itself contain a bare `>`
 * tagEnd('<div data-op=">">', 0)
 * 16
 * @example tagEnd('<div unclosed', 0)
 * -1
 */
export function tagEnd(src, open) {
  let depth = 0;
  let quote = "";
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "{") { depth++; continue; }
    if (c === "}") { depth = Math.max(0, depth - 1); continue; }
    if (c === ">" && depth === 0) return i;
  }
  return -1;
}

/**
 * Pure function. Every `title=` occurrence in `src` that is a NATIVE TOOLTIP —
 * an attribute on an HTML element — with the three exempt shapes removed.
 *
 * The opening tag that owns each `title=` is found by scanning left to the
 * nearest `<` and confirming the tag has not already closed (tagEnd); the
 * exemptions are then decided from that tag's NAME: a capitalised name is a
 * component (prop), `svg`/`title` is graphic metadata, and a lowercase HTML
 * element is a violation.
 *
 * @param {string} src File text (comments already stripped).
 * @param {Set<string>} components Component names this file imports.
 * @returns {Array<{line: number, tag: string, text: string}>} Violations found.
 *
 * @example // a native tooltip on a span — the SlideNav defect this guard was written for
 * nativeTitleAttrs('<span class="n" title="Double-click to rename">x</span>', new Set()).map((v) => v.tag)
 * // => ['span']
 * @example // the same defect WITH an event handler, which an indexOf('>') scan missed
 * nativeTitleAttrs('<span ondblclick={(e) => r(e)} title="Double-click to rename">x</span>', new Set()).map((v) => v.tag)
 * // => ['span']
 * @example // a component PROP that renders as a heading — exempt
 * nativeTitleAttrs('<Modal title="Settings">', new Set(['Modal']))
 * // => []
 * @example // a $props() declaration inside a component — exempt
 * nativeTitleAttrs('    title = "",', new Set())
 * // => []
 */
export function nativeTitleAttrs(src, components) {
  const found = [];
  for (const m of src.matchAll(/\btitle\s*=/g)) {
    const at = m.index;
    // A `$props()` default (`title = ""`) or any other assignment is script, not
    // markup: no enclosing tag is still open at that point.
    const open = src.lastIndexOf("<", at);
    if (open < 0) continue;
    const close = tagEnd(src, open);
    if (close < 0 || close < at) continue; // the `title=` is outside any tag
    const tag = src.slice(open + 1).match(/^\/?\s*([A-Za-z][\w.-]*)/)?.[1];
    if (!tag) continue;
    if (components.has(tag)) continue; // (1) component prop, e.g. <Modal title=…>
    if (tag === "svg" || tag === "title") continue; // (2) graphic metadata
    if (/^[A-Z]/.test(tag)) continue; // an un-imported component (a snippet arg, say)
    found.push({
      line: src.slice(0, at).split("\n").length,
      tag,
      text: src.slice(open, Math.min(close + 1, open + 120)),
    });
  }
  return found;
}

/** Query. Every .svelte path under `dir`, recursively, as absolute paths. */
function svelteFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") continue; // build output
      out.push(...svelteFiles(p));
    } else if (entry.name.endsWith(".svelte")) out.push(p);
  }
  return out;
}

const webFiles = svelteFiles(resolve(powerRP, "web"));

// The src/lib components the app MOUNTS — read from the app's own imports, so a
// newly mounted library component joins the sweep with no edit here.
const mountedLib = new Set();
for (const f of webFiles) {
  for (const m of readFileSync(f, "utf8").matchAll(/from\s+["'][^"']*\/lib\/([A-Za-z]+)\.svelte["']/g)) {
    mountedLib.add(resolve(svelteLib, "src/lib", `${m[1]}.svelte`));
  }
}

test("web/ chrome uses the immediate Tooltip, never a native title= attribute", () => {
  const offenders = [];
  for (const f of webFiles) {
    const raw = readFileSync(f, "utf8");
    const src = stripComments(raw);
    for (const v of nativeTitleAttrs(src, componentImports(raw))) {
      offenders.push(`${relative(svelteLib, f)}:${v.line}  <${v.tag} …>  ${v.text.replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    "native title= tooltips found in app chrome (banned — manifest). Wrap the element in " +
    "SvelteLib's Tooltip (src/lib/Tooltip.svelte) with the same text instead; it appears " +
    "immediately and is themed:\n  " + offenders.join("\n  ")
  );
});

test("the src/lib components the app mounts carry no native title= either", () => {
  // Scoped to what THIS app mounts on purpose: src/lib is shared with other demo
  // apps that are not bound by this ban (video_slice_annotator passes a real
  // `title` to Thumbnail), so a lib file only has to comply once PowerRP renders
  // it. Thumbnail is the live example — it still spreads `{title}` onto its root,
  // and PowerRP complies by not passing one (web/AssetThumb.svelte says so).
  assert.ok(mountedLib.size > 0, "read no /lib/*.svelte imports out of web/ — the scrape broke, not the app");
  const offenders = [];
  for (const f of mountedLib) {
    const raw = readFileSync(f, "utf8");
    const src = stripComments(raw);
    for (const v of nativeTitleAttrs(src, componentImports(raw))) {
      // A lib component may DECLARE a `title` prop and spread it; what this app
      // must not do is PASS one. `{title}` shorthand is not a `title=` match, so
      // only an explicit hardcoded attribute reaches here.
      offenders.push(`${relative(svelteLib, f)}:${v.line}  <${v.tag} …>  ${v.text.replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    "a library component the app mounts hardcodes a native title= attribute:\n  " + offenders.join("\n  ")
  );
});

test("SlideNav still TEACHES double-click rename, in the card's own tip", () => {
  // A REGRESSION PIN, not a restatement of test 1. Test 1 proves the native
  // attribute is gone; this proves the INFORMATION it carried was not simply
  // deleted along with it — the easiest way to make a tooltip-ban test pass is to
  // drop the hint, which would silently un-teach the gesture.
  //
  // It lives in the CARD's tip, not a Tooltip on the name span: the card's tip
  // already covers that span, so a nested one fired both and painted two boxes
  // over each other (see the span's note in SlideNav).
  const src = stripComments(readFileSync(resolve(powerRP, "web/SlideNav.svelte"), "utf8"));
  assert.match(
    src, /Double-click the name to rename/,
    "SlideNav must still say how to rename a slide. Slides keep DOUBLE-click rename " +
    "(the user reaffirmed that convention — a slide's single click selects it); only " +
    "the toolbar's project title became single-click."
  );
  // And the gesture itself is still wired — now DELEGATED to the shared
  // InlineRename component (SvelteLib), whose default trigger is dblclick.
  // Asserting both halves: SlideNav mounts it for the name, and the component
  // actually wires the double-click on its display element.
  assert.match(src, /<InlineRename\b/, "the slide name must delegate rename to the shared InlineRename component");
  const inlineRename = stripComments(readFileSync(resolve(powerRP, "../../lib/InlineRename.svelte"), "utf8"));
  assert.match(inlineRename, /ondblclick=\{trigger === "dblclick"/, "InlineRename must start the editor on double-click when so triggered");
});

test("the toolbar's project title says CLICK to rename, and renames on one click", () => {
  // The user's question: "why does the name have to be double-click to rename?
  // Why not single-click?" Both halves are pinned because either alone is a lie:
  // an onclick with a stale "Double-click" tip, or a corrected tip still wired to
  // ondblclick.
  const raw = readFileSync(resolve(powerRP, "web/Toolbar.svelte"), "utf8");
  const src = stripComments(raw);
  const docName = src.slice(src.indexOf('<Tooltip text="Click to rename">'), src.indexOf("</Tooltip>", src.indexOf('class="doc-name"')));
  assert.ok(docName.length > 0, 'web/Toolbar.svelte: no <Tooltip text="Click to rename"> around the .doc-name span');
  assert.match(docName, /onclick=\{\(\) => app\.renamePresentation\(\)\}/, "the project title must rename on a SINGLE click");
  assert.doesNotMatch(docName, /ondblclick/, "the project title must no longer require a double-click");
});

console.log(`\n${passed} native-tooltip-ban tests passed`);
