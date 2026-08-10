/**
 * OPC (Open Packaging Conventions) LAYER — parts, `[Content_Types].xml` and
 * `.rels` relationship resolution. This is the layer between "a bag of zip
 * member paths" (core/pptx/zip.js) and "the presentation's own object graph"
 * (theme.js, inherit.js, shapes.js, deck.js): it knows what a PART is, what a
 * RELATIONSHIP is, and how to resolve one part's relative reference into
 * another part's absolute archive path — but nothing about what a `p:sld` or
 * `p:transition` MEANS.
 *
 * THREE THINGS THIS LAYER OWNS:
 *   1. Content-type lookup ([Content_Types].xml Default + Override entries) —
 *      answers "what MIME type does PowerPoint consider this part to be",
 *      needed because a media file's on-disk extension is not always trustworthy
 *      (research_08: "needed to pick a correct MIME type... since the file
 *      extension alone isn't always reliable").
 *   2. Relationship files (`_rels/<name>.xml.rels` sitting beside each part) —
 *      each relationship has an Id, a Type (a URI identifying its ROLE — slide,
 *      image, video, slideLayout, etc.) and a Target, which is either a
 *      package-relative path (resolved against the SOURCE part's own
 *      directory, per OPC §9.3) or an external URI when `TargetMode="External"`.
 *   3. `[Content_Types].xml` + `.rels` files are BOTH themselves ordinary parts
 *      parsed with core/pptx/xml.js — no special-casing beyond knowing their
 *      well-known archive paths.
 *
 * PART-PATH NORMALIZATION (OPC §9.3, ECMA-376 Part 2): a relationship Target
 * is resolved relative to the directory of the part whose `_rels` file names
 * it — `ppt/slides/_rels/slide2.xml.rels`'s `Target="../media/media1.mp4"`
 * resolves against `ppt/slides/`, giving `ppt/media/media1.mp4`. This module's
 * `resolvePartPath` is the one place that arithmetic happens.
 */

import { parseXml, xmlChildren, xmlAttr } from "./xml.js";
import { decodeXmlBytes, requirePart } from "./zip.js";

const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

/**
 * Pure function. Resolve a relationship Target against the directory of the
 * part that declared it (OPC §9.3 relative-reference resolution) into a
 * normalized archive path — no leading slash, `.`/`..` segments collapsed.
 * A Target starting with "/" is already package-absolute and is normalized as
 * given (leading slash stripped), not joined to `fromDir`.
 *
 * @param {string} fromDir - directory of the SOURCE part, e.g. "ppt/slides" ("" for package root)
 * @param {string} target - the relationship's Target attribute
 * @returns {string}
 *
 * @example resolvePartPath("ppt/slides", "../media/media1.mp4") // "ppt/media/media1.mp4"
 * @example resolvePartPath("ppt/slides", "slide1.xml") // "ppt/slides/slide1.xml"
 * @example resolvePartPath("", "/ppt/presentation.xml") // "ppt/presentation.xml"
 */
export function resolvePartPath(fromDir, target) {
  if (target.startsWith("/")) {
    return normalizeSegments(target.slice(1).split("/"));
  }
  const base = fromDir ? fromDir.split("/") : [];
  const rel = target.split("/");
  return normalizeSegments([...base, ...rel]);
}

function normalizeSegments(segments) {
  const out = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) throw new Error(`relationship target escapes the package root: ${segments.join("/")}`);
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/**
 * Pure function. The `_rels` file path that would hold relationships FOR a
 * given part path (OPC convention: sibling `_rels/<basename>.rels` in the
 * same directory), e.g. `ppt/slides/slide2.xml` -> `ppt/slides/_rels/slide2.xml.rels`.
 * For the package root itself (part path `""`), the convention is `_rels/.rels`.
 *
 * @param {string} partPath
 * @returns {string}
 *
 * @example relsPathFor("ppt/slides/slide2.xml") // "ppt/slides/_rels/slide2.xml.rels"
 * @example relsPathFor("") // "_rels/.rels"
 */
export function relsPathFor(partPath) {
  if (partPath === "") return "_rels/.rels";
  const slash = partPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : partPath.slice(0, slash);
  const base = slash === -1 ? partPath : partPath.slice(slash + 1);
  return dir ? `${dir}/_rels/${base}.rels` : `_rels/${base}.rels`;
}

/**
 * Pure function. Parse a `.rels` XML document into a map of relationship Id ->
 * `{id, type, target, targetMode, resolvedPath}`. `resolvedPath` is null for
 * `TargetMode="External"` relationships (the Target is a URI/path OUTSIDE the
 * package, e.g. a linked video — research_08 §1's `r:link` with an external
 * TargetMode) — callers must check `targetMode` before treating `target` as an
 * archive path.
 *
 * @param {string} relsXmlText - the `.rels` part's decoded XML text
 * @param {string} sourcePartDir - directory of the part these relationships belong to
 * @returns {Map<string, {id: string, type: string, target: string, targetMode: "Internal"|"External", resolvedPath: string|null}>}
 *
 * @example
 * >>> const rels = parseRelationships('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="t" Target="../media/a.mp4"/></Relationships>', "ppt/slides");
 * >>> rels.get("rId1").resolvedPath
 * "ppt/media/a.mp4"
 */
export function parseRelationships(relsXmlText, sourcePartDir) {
  const root = parseXml(relsXmlText);
  if (root.ns !== REL_NS || root.local !== "Relationships") {
    throw new Error(`not a .rels document: root element is "${root.name}", expected Relationships in ${REL_NS}`);
  }
  const out = new Map();
  for (const rel of xmlChildren(root, REL_NS, "Relationship")) {
    const id = xmlAttr(rel, null, "Id");
    const type = xmlAttr(rel, null, "Type");
    const target = xmlAttr(rel, null, "Target");
    if (!id || !type || target === undefined) throw new Error(`malformed <Relationship> missing Id/Type/Target in rels for ${sourcePartDir || "(package root)"}`);
    const targetMode = xmlAttr(rel, null, "TargetMode", "Internal");
    if (targetMode !== "Internal" && targetMode !== "External") throw new Error(`unknown TargetMode "${targetMode}" on relationship ${id}`);
    out.set(id, {
      id, type, target, targetMode,
      resolvedPath: targetMode === "External" ? null : resolvePartPath(sourcePartDir, target),
    });
  }
  return out;
}

/**
 * Pure function. Parse `[Content_Types].xml` into `{defaults: Map<extLower,
 * contentType>, overrides: Map<partPath, contentType>}` — Default entries key
 * by lowercased extension (no dot), Override entries key by exact part path
 * (leading slash stripped, matching this module's normalized part paths).
 *
 * @param {string} contentTypesXmlText
 * @returns {{defaults: Map<string,string>, overrides: Map<string,string>}}
 *
 * @example
 * >>> const ct = parseContentTypes('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="mp4" ContentType="video/mp4"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.x+xml"/></Types>');
 * >>> ct.defaults.get("mp4")
 * "video/mp4"
 * >>> ct.overrides.get("ppt/presentation.xml")
 * "application/vnd.x+xml"
 */
export function parseContentTypes(contentTypesXmlText) {
  const root = parseXml(contentTypesXmlText);
  if (root.ns !== CT_NS || root.local !== "Types") {
    throw new Error(`not a [Content_Types].xml document: root element is "${root.name}"`);
  }
  const defaults = new Map();
  const overrides = new Map();
  for (const d of xmlChildren(root, CT_NS, "Default")) {
    const ext = xmlAttr(d, null, "Extension");
    const ct = xmlAttr(d, null, "ContentType");
    if (!ext || !ct) throw new Error("malformed <Default> missing Extension/ContentType in [Content_Types].xml");
    defaults.set(ext.toLowerCase(), ct);
  }
  for (const o of xmlChildren(root, CT_NS, "Override")) {
    const partName = xmlAttr(o, null, "PartName");
    const ct = xmlAttr(o, null, "ContentType");
    if (!partName || !ct) throw new Error("malformed <Override> missing PartName/ContentType in [Content_Types].xml");
    overrides.set(partName.replace(/^\//, ""), ct);
  }
  return { defaults, overrides };
}

/**
 * Pure function. The content type for a resolved part path — Override wins
 * over Default (OPC §10.1.2.3: an Override entry supersedes the extension
 * default for that exact part), falling back to the extension's Default.
 * Throws if neither a matching Override nor a Default extension entry exists —
 * per this project's no-silent-fallback rule, an unresolvable media type must
 * be a refusal the caller records, not a guessed MIME string.
 *
 * @param {{defaults: Map<string,string>, overrides: Map<string,string>}} contentTypes
 * @param {string} partPath - normalized archive path
 * @returns {string}
 *
 * @example contentTypeFor({defaults: new Map([["png","image/png"]]), overrides: new Map()}, "ppt/media/image1.png") // "image/png"
 */
export function contentTypeFor(contentTypes, partPath) {
  const override = contentTypes.overrides.get(partPath);
  if (override) return override;
  const dot = partPath.lastIndexOf(".");
  const ext = dot === -1 ? "" : partPath.slice(dot + 1).toLowerCase();
  const def = contentTypes.defaults.get(ext);
  if (!def) throw new Error(`no content type declared for part "${partPath}" (extension ".${ext}" has no Default entry and there is no Override)`);
  return def;
}

/**
 * Query (reads the zip's part map). Build the OPC "package" view: content
 * types, and a per-part-path relationship LOADER (lazy — `.rels` files are
 * only parsed for parts a caller actually asks about, since most decks have
 * dozens of layouts/masters/media relationship files that are irrelevant to a
 * given slide walk).
 *
 * @param {Record<string, Uint8Array>} files - unzipPptx()'s member map
 * @returns {{
 *   contentTypes: {defaults: Map, overrides: Map},
 *   partText: (path: string) => string,
 *   partBytes: (path: string) => Uint8Array,
 *   hasPart: (path: string) => boolean,
 *   relationshipsFor: (partPath: string) => Map<string, object>,
 * }}
 *
 * @example
 * >>> const pkg = openPackage(unzipPptx(bytes));
 * >>> pkg.hasPart("ppt/presentation.xml")
 * true
 */
export function openPackage(files) {
  const contentTypes = parseContentTypes(decodeXmlBytes(requirePart(files, "[Content_Types].xml")));
  const relsCache = new Map();

  function partBytes(path) {
    return requirePart(files, path);
  }
  function partText(path) {
    return decodeXmlBytes(partBytes(path));
  }
  function hasPart(path) {
    return path in files;
  }
  function relationshipsFor(partPath) {
    if (relsCache.has(partPath)) return relsCache.get(partPath);
    const relsPath = relsPathFor(partPath);
    const slash = partPath.lastIndexOf("/");
    const dir = slash === -1 ? "" : partPath.slice(0, slash);
    const rels = hasPart(relsPath) ? parseRelationships(partText(relsPath), dir) : new Map();
    relsCache.set(partPath, rels);
    return rels;
  }

  return { contentTypes, partText, partBytes, hasPart, relationshipsFor };
}
