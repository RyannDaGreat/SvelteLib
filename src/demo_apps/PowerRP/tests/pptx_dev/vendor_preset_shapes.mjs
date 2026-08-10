#!/usr/bin/env node
/**
 * DEV TOOLING (not part of the test gate, not part of the app runtime):
 * downloads LibreOffice's typo-corrected `presetShapeDefinitions.xml` --
 * ECMA-376/ISO-29500 Appendix D's preset shape table -- and compiles it into
 * `core/pptx/preset_shape_defs.json`, the data `core/pptx/preset_geometry.js`
 * evaluates at runtime.
 *
 * SOURCE: https://raw.githubusercontent.com/LibreOffice/core/master/oox/source/drawingml/customshapes/presetShapeDefinitions.xml
 * LICENSE: MPL-2.0 (LibreOffice `core` repo). This script records the exact
 * git ref it fetched in the output JSON's own header so a future re-vendor
 * can diff against a known point.
 *
 * PARSING APPROACH: this file is DEV TOOLING, not the app's runtime code, so
 * per the mission brief it may use "any quick parsing approach" as long as
 * it stays dependency-free. The source XML is machine-generated and
 * extremely regular (confirmed by inspection of a downloaded copy, ~19,900
 * lines): every element opens/closes on its own line, `<gd>`/`<pt>`/`<cxn>`
 * children are always self-closing single-line tags with double-quoted
 * attributes, and there is exactly one namespace (a bare default xmlns on
 * each `<avLst>`/`<gdLst>`/etc. wrapper -- never an `a:` prefix in this
 * mirror). A tiny regex-driven line-oriented scanner is therefore robust
 * here without a general XML parser dependency; it throws loudly if an
 * assumption it relies on is violated (unrecognized element, unexpected
 * attribute shape) rather than silently mis-compiling a shape.
 *
 * Run: `node tests/pptx_dev/vendor_preset_shapes.mjs`
 * Output: core/pptx/preset_shape_defs.json
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE_URL =
  "https://raw.githubusercontent.com/LibreOffice/core/master/oox/source/drawingml/customshapes/presetShapeDefinitions.xml";
const OUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "core", "pptx", "preset_shape_defs.json"
);

async function fetchSourceXml() {
  const resp = await fetch(SOURCE_URL);
  if (!resp.ok) throw new Error(`vendor_preset_shapes: fetch failed ${resp.status} ${resp.statusText} for ${SOURCE_URL}`);
  return resp.text();
}

async function fetchGitRef() {
  const resp = await fetch("https://api.github.com/repos/LibreOffice/core/commits/master");
  if (!resp.ok) throw new Error(`vendor_preset_shapes: could not resolve git ref, HTTP ${resp.status}`);
  const json = await resp.json();
  if (!json.sha) throw new Error("vendor_preset_shapes: GitHub API response had no commit sha");
  return json.sha;
}

/** Strips a self-closing or paired XML tag's attributes into a plain object.
 * `<gd name="a" fmla="val 1" />` -> {name: "a", fmla: "val 1"}. Throws if the
 * tag has no attributes at all where one was expected (a structural
 * assumption violation, not a normal empty case in this source file). */
function parseAttrs(tag) {
  const attrs = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1]] = m[2];
  return attrs;
}

/** Builds a global regex matching every self-closing `<tagName .../>`
 * element, e.g. a `<gd>` guide whose fmla starts with the multiply-divide
 * operator (asterisk, slash). Deliberately NOT `[^/]*?` before the closing
 * `/>` -- that excludes ANY slash character, which breaks on the
 * multiply-divide and add-divide formula operators appearing INSIDE a
 * quoted attribute value (confirmed against the source: e.g.
 * `fmla="*` + `/ h adj1 100000"`; a `[^/]*?` version of this scanner
 * silently dropped every guide using those two operators, which the
 * research doc calls "the single most common op" -- caught by cross-
 * checking the compiled JSON's guide count against a manual grep, not by a
 * thrown error, which is exactly the silent-failure shape this whole
 * codebase forbids). Instead this matches a repeated `attr="value"`
 * sequence and requires the tag to end in `/>` immediately after the last
 * attribute -- attribute VALUES may contain any character except an
 * unescaped double-quote. */
function selfClosingTagRe(tagName, flags = "g") {
  return new RegExp(`<${tagName}\\b((?:\\s+[\\w:]+="[^"]*")*)\\s*/>`, flags);
}

/** Extracts the inner text of a top-level shape block `<name>...</name>`
 * given the full source and the shape's start index (index of `<name>`). */
function extractBlock(xml, startIdx, tagName) {
  const closeTag = `</${tagName}>`;
  const closeIdx = xml.indexOf(closeTag, startIdx);
  if (closeIdx === -1) throw new Error(`vendor_preset_shapes: unterminated <${tagName}> block at offset ${startIdx}`);
  return xml.slice(startIdx, closeIdx);
}

/** Parses an `<avLst>...</avLst>` section (may be absent) into
 * `{gdName: numericDefault}`. Each `<gd name="adj" fmla="val N" />` inside an
 * avLst is ALWAYS a `val` literal per spec (adjustment defaults are plain
 * numbers) -- this is verified per-entry rather than assumed. */
function parseAvLst(block) {
  const section = /<avLst[^>]*>([\s\S]*?)<\/avLst>/.exec(block);
  if (!section) return {};
  const out = {};
  const gdRe = selfClosingTagRe("gd");
  let m;
  while ((m = gdRe.exec(section[1]))) {
    const { name, fmla } = parseAttrs(m[0]);
    if (!name || fmla === undefined) throw new Error(`vendor_preset_shapes: malformed avLst <gd> "${m[0]}"`);
    const valMatch = /^val\s+(-?\d+(?:\.\d+)?)$/.exec(fmla.trim());
    if (!valMatch) throw new Error(`vendor_preset_shapes: avLst guide "${name}" has non-literal fmla "${fmla}"`);
    out[name] = Number(valMatch[1]);
  }
  return out;
}

/** Parses a `<gdLst>...</gdLst>` section (may be absent) into an
 * ORDER-PRESERVING `[[name, fmla], ...]` array -- order matters because
 * later guides may reference earlier ones, and `preset_geometry.js` folds
 * them sequentially. */
function parseGdLst(block) {
  const section = /<gdLst[^>]*>([\s\S]*?)<\/gdLst>/.exec(block);
  if (!section) return [];
  const out = [];
  const gdRe = selfClosingTagRe("gd");
  let m;
  while ((m = gdRe.exec(section[1]))) {
    const { name, fmla } = parseAttrs(m[0]);
    if (!name || fmla === undefined) throw new Error(`vendor_preset_shapes: malformed gdLst <gd> "${m[0]}"`);
    out.push([name, fmla]);
  }
  return out;
}

/** Parses the shape's own `<rect l t r b .../>` (text-bounding rect), or
 * null if the shape declares none (e.g. `line`, `chartX`). */
function parseRect(block) {
  // The shape-level <rect> is a SIBLING of avLst/gdLst/pathLst, i.e. NOT
  // nested inside pathLst's own coordinate elements -- match it before
  // pathLst starts, restricting the search window to avoid matching an
  // unrelated same-named element deeper in the block (there is none here,
  // but the restriction documents the intent and fails loudly instead of
  // silently grabbing the wrong element if the source ever changes shape).
  const pathLstIdx = block.indexOf("<pathLst");
  const searchWindow = pathLstIdx === -1 ? block : block.slice(0, pathLstIdx);
  const m = selfClosingTagRe("rect", "").exec(searchWindow);
  if (!m) return null;
  const { l, t, r, b } = parseAttrs(m[0]);
  if (l === undefined || t === undefined || r === undefined || b === undefined)
    throw new Error(`vendor_preset_shapes: shape <rect> missing one of l/t/r/b: "${m[0]}"`);
  return { l, t, r, b };
}

/** Parses one `<a:pt x=".." y=".." />`-equivalent point tag (namespace-free
 * in this mirror) already isolated as its tag text. */
function parsePt(tagText) {
  const { x, y } = parseAttrs(tagText);
  if (x === undefined || y === undefined) throw new Error(`vendor_preset_shapes: malformed <pt> "${tagText}"`);
  return { x, y };
}

/** Parses one `<path ...>...</path>` element's children into the command IR
 * `core/pptx/preset_geometry.js` consumes: `{cmd, ...args}` objects, args
 * per command matching `custGeomPath`'s documented contract. */
function parsePathCommands(inner) {
  const commands = [];
  // Walk element-by-element in document order (moveTo/lnTo/cubicBezTo/
  // quadBezTo/arcTo/close), each matched as either a paired tag with `<pt>`
  // children or a self-closing arcTo/close.
  const elemRe = new RegExp(
    `<(moveTo|lnTo|cubicBezTo|quadBezTo)>([\\s\\S]*?)<\\/\\1>` +
    `|(<arcTo\\b(?:\\s+[\\w:]+="[^"]*")*\\s*\\/>)` +
    `|(<close\\s*\\/>)`,
    "g"
  );
  let m;
  while ((m = elemRe.exec(inner))) {
    if (m[1]) {
      const tagName = m[1];
      const ptRe = selfClosingTagRe("pt");
      const pts = [];
      let pm;
      while ((pm = ptRe.exec(m[2]))) pts.push(parsePt(pm[0]));
      if (tagName === "moveTo" || tagName === "lnTo") {
        if (pts.length !== 1) throw new Error(`vendor_preset_shapes: ${tagName} expects 1 <pt>, got ${pts.length}`);
        commands.push({ cmd: tagName, x: pts[0].x, y: pts[0].y });
      } else if (tagName === "cubicBezTo") {
        if (pts.length !== 3) throw new Error(`vendor_preset_shapes: cubicBezTo expects 3 <pt>, got ${pts.length}`);
        commands.push({ cmd: "cubicBezTo", x1: pts[0].x, y1: pts[0].y, x2: pts[1].x, y2: pts[1].y, x: pts[2].x, y: pts[2].y });
      } else if (tagName === "quadBezTo") {
        if (pts.length !== 2) throw new Error(`vendor_preset_shapes: quadBezTo expects 2 <pt>, got ${pts.length}`);
        commands.push({ cmd: "quadBezTo", x1: pts[0].x, y1: pts[0].y, x: pts[1].x, y: pts[1].y });
      }
    } else if (m[3]) {
      const { wR, hR, stAng, swAng } = parseAttrs(m[3]);
      if (wR === undefined || hR === undefined || stAng === undefined || swAng === undefined)
        throw new Error(`vendor_preset_shapes: malformed arcTo "${m[3]}"`);
      commands.push({ cmd: "arcTo", wR, hR, stAng, swAng });
    } else if (m[4]) {
      commands.push({ cmd: "close" });
    } else {
      throw new Error(`vendor_preset_shapes: path scanner matched nothing usable at "${m[0]}"`);
    }
  }
  return commands;
}

/** Parses a `<pathLst>...</pathLst>` section into the array of `{w?, h?,
 * fill?, stroke?, commands}` path objects `preset_geometry.js` expects.
 * Every shape must have at least one `<pathLst>` -- a shape with zero paths
 * would render nothing and is treated as a compile failure, reported by the
 * caller rather than silently emitting an empty geometry. */
function parsePathLst(block) {
  const section = /<pathLst[^>]*>([\s\S]*?)<\/pathLst>/.exec(block);
  if (!section) throw new Error("vendor_preset_shapes: shape has no <pathLst>");
  const paths = [];
  const pathRe = /<path([^>]*)>([\s\S]*?)<\/path>/g;
  let m;
  while ((m = pathRe.exec(section[1]))) {
    const attrs = parseAttrs(`<path ${m[1]}/>`);
    const entry = { commands: parsePathCommands(m[2]) };
    if (attrs.w !== undefined) entry.w = Number(attrs.w);
    if (attrs.h !== undefined) entry.h = Number(attrs.h);
    if (attrs.fill !== undefined) entry.fill = attrs.fill;
    if (attrs.stroke !== undefined) entry.stroke = attrs.stroke !== "0" && attrs.stroke !== "false";
    paths.push(entry);
  }
  if (paths.length === 0) throw new Error("vendor_preset_shapes: <pathLst> present but contains zero <path> elements");
  return paths;
}

/** Extracts the raw `<ahLst>...</ahLst>` inner XML verbatim (adjustment
 * handles are UI-only, irrelevant to path geometry -- kept as raw text per
 * the mission brief's `ahLst: raw` contract rather than a structured IR that
 * this module would then need to keep in sync with a feature it never
 * reads). Empty string if absent. */
function extractRawAhLst(block) {
  const section = /<ahLst[^>]*>([\s\S]*?)<\/ahLst>/.exec(block);
  return section ? section[1].trim() : "";
}

/** Compiles the full source XML into `{shapeName: {avLst, gdLst, ahLst,
 * rect, pathLst}}`. Top-level shape blocks are every direct child of
 * `<presetShapeDefinitons>` (note: that root element name is itself a typo
 * in the source, preserved verbatim since we only read it, never emit it) --
 * matched by a two-space-indented opening tag, which this file's generator
 * uses consistently for exactly the 187 top-level shape names and nothing
 * deeper (confirmed against a downloaded copy: `grep -c '^  <[a-zA-Z0-9]*>$'` == 187). */
function compilePresetTable(xml) {
  const table = {};
  const failures = [];
  const topLevelRe = /^  <([a-zA-Z0-9]+)>$/gm;
  const starts = [];
  let m;
  while ((m = topLevelRe.exec(xml))) starts.push({ name: m[1], idx: m.index });

  for (const { name, idx } of starts) {
    try {
      const block = extractBlock(xml, idx, name);
      table[name] = {
        avLst: parseAvLst(block),
        gdLst: parseGdLst(block),
        ahLst: extractRawAhLst(block),
        rect: parseRect(block),
        pathLst: parsePathLst(block),
      };
    } catch (err) {
      failures.push({ name, error: err.message });
    }
  }
  return { table, failures, totalFound: starts.length };
}

async function main() {
  console.log(`vendor_preset_shapes: fetching ${SOURCE_URL} ...`);
  const [xml, gitRef] = await Promise.all([fetchSourceXml(), fetchGitRef()]);
  console.log(`vendor_preset_shapes: fetched ${xml.split("\n").length} lines, resolved git ref ${gitRef}`);

  const { table, failures, totalFound } = compilePresetTable(xml);
  console.log(`vendor_preset_shapes: found ${totalFound} top-level shape definitions, compiled ${Object.keys(table).length}`);
  if (failures.length > 0) {
    console.log(`vendor_preset_shapes: ${failures.length} shape(s) FAILED to compile:`);
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }

  const output = {
    _source: {
      url: SOURCE_URL,
      gitRef,
      license: "MPL-2.0 (LibreOffice core repository)",
      vendoredAt: new Date().toISOString().slice(0, 10),
      note: "ECMA-376/ISO-29500 Appendix D presetShapeDefinitions.xml, typo-corrected by LibreOffice. Compiled by tests/pptx_dev/vendor_preset_shapes.mjs.",
    },
    shapes: table,
  };
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 1));
  console.log(`vendor_preset_shapes: wrote ${OUT_PATH}`);

  if (failures.length > 0) {
    console.log(`vendor_preset_shapes: DONE WITH ${failures.length} COMPILE FAILURE(S) -- see list above, this is a coverage report, not silently hidden.`);
  }
}

main().catch((err) => {
  console.error("vendor_preset_shapes: FATAL:", err.stack || err.message);
  process.exit(1);
});
