/**
 * assetLocalize.js — WHICH ASSETS A DOCUMENT ACTUALLY NEEDS, and how to repoint them.
 *
 * THE REF GRAMMAR IS core/asset_ref.js's, and this module deals with exactly one
 * of its two forms. A `src` may be RELATIVE ("clip.mp4" — a file of whatever
 * project owns the document, resolved at core/derive.js) or ABSOLUTE
 * ("/asset/<project>/<file>" — a file of a SPECIFICALLY NAMED project). Everything
 * below is about the ABSOLUTE form, because a relative ref is already local by
 * definition: it cannot be foreign, needs no copy, and round-trips through an
 * export untouched. `parseAssetRef` returns null for one, so the walks here skip it
 * for free.
 *
 * THE PROBLEM THIS EXISTS FOR. An ABSOLUTE ref bakes a project NAME into the
 * string, and nothing keeps that name equal to the folder the document lives in.
 * Save-As is the proof: `app.renameProject` writes `doc.meta.name` and
 * `saveToServer` writes a NEW folder, while every `src` still names the OLD one.
 * The deck keeps working — the server serves any project's assets to anyone — so
 * the divergence is INVISIBLE until the project leaves the machine. Then
 * `zip_project_bytes` walks one folder, ships a doc whose refs point at a folder
 * that is not in the archive, and the import opens a deck with a hole where a video
 * was. That was the user's bug, verbatim: "the robotsim.zip references a video
 * file, but that video file is not in that zip".
 *
 * AND THE FIX HAS TWO HALVES, which is why the grammar gained a second form. This
 * module carries the FOREIGN bytes into the archive; writing the new refs in the
 * RELATIVE form (see localizationPlan) is what stops the same divergence from being
 * re-minted the moment the archive is imported under a de-collided name. Copying the
 * bytes alone left the user with a second, identical failure on the static site.
 *
 * So the export has to ask a question it never asked: WHICH refs does this
 * document contain, and which of them are FOREIGN? That question is pure, it is
 * the same question in three places (server export, client export, the Localize
 * command), and it has exactly one right answer — hence this module.
 *
 * WHY THE WALK IS BLIND (every string leaf) RATHER THAN A LIST OF KNOWN KEYS.
 * `src` is the obvious ref-bearing property, but it is nowhere near the only one:
 * `svgUrl`, a slide's `transition.sound`, a filmstrip's per-frame list, a
 * plugin asset's own properties, and any property a FUTURE widget invents. A
 * curated key list would be wrong the day someone adds a widget — silently, and
 * in the direction that loses data. The grammar is unambiguous enough to
 * recognize by itself (`parseAssetRef` returns null for anything that is not a
 * ref), so recognizing is strictly better than enumerating. Consequence worth
 * stating: an EQUATION whose text happens to contain "/asset/…" is matched only
 * if the whole string is a ref — `"= 1 + 2"` and `'"/asset/A/b.png"'` (a quoted
 * literal inside a bigger expression) are not refs and are left alone, because
 * parseAssetRef is anchored at position 0 and consumes the whole string.
 *
 * DOM-free and dependency-light on purpose: server-side parity is checked by a
 * python twin, the client export imports it directly, and the node suite tests
 * it with no browser. Every function here is pure.
 *
 * IT LIVES IN web/ RATHER THAN core/ FOR ONE REASON: it is built on
 * `web/assetRef.js`'s grammar, and NO core/ module imports from web/ (that is
 * checked — core/ must run bare with no app around it). Putting the walk in core/
 * would either invert that dependency or fork the parser, and a forked ref parser
 * is precisely the kind of second opinion this bug came from. `assetRef.js` is
 * itself DOM-free and node-testable, so nothing is lost by sitting next to it.
 */

import { parseAssetRef } from "./assetRef.js";

/**
 * Pure function. Every asset REFERENCE a document contains, in document order,
 * one entry per OCCURRENCE (the same file referenced twice yields two entries —
 * a rewrite must touch both, and a report should say "2 places").
 *
 * `path` is a JSON path INTO the document, "/"-joined, so a caller can point a
 * human at the exact leaf; `itemId` is the item the ref belongs to, or null for a
 * ref that is not inside an item state (a slide's `transition.sound`).
 *
 * @param {object} doc - a serialized document {meta, slides:[{delta:{items}}]}
 * @returns {Array<{path: string, itemId: string|null, ref: string, project: string, file: string}>}
 *
 * @example
 * >>> const doc = {slides: [{delta: {items: {vid: {type: "video", src: "/asset/Untitled/clip.mp4"}}}}]};
 * >>> documentAssetRefs(doc)
 * [{path: "slides/0/delta/items/vid/src", itemId: "vid", ref: "/asset/Untitled/clip.mp4",
 *   project: "Untitled", file: "clip.mp4"}]
 * >>> documentAssetRefs({slides: [{delta: {items: {t: {text: "= 1 + 2"}}}}]})   // an equation is not a ref
 * []
 */
export function documentAssetRefs(doc) {
  const found = [];
  walkStrings(doc, [], (value, path) => {
    const parsed = parseAssetRef(value);
    if (!parsed) return;
    found.push({ path: path.join("/"), itemId: itemIdForPath(path), ref: value, ...parsed });
  });
  return found;
}

/**
 * Pure function. The document with every asset ref REPLACED by `replace(entry)`
 * — the rewrite twin of documentAssetRefs, walking the same leaves so the two can
 * never disagree about what a ref is. Returning null/undefined from `replace`
 * leaves that ref untouched, which is how a caller rewrites only the foreign
 * ones.
 *
 * A DEEP COPY is returned and the input is never mutated: the archive's doc.json
 * is rewritten while the on-disk document stays exactly as the author wrote it,
 * and the Localize command needs a new object to hand to `commit` anyway.
 *
 * @param {object} doc - a serialized document
 * @param {(entry: {path: string, itemId: string|null, ref: string, project: string, file: string}) => string|null} replace
 * @returns {object} a new document
 *
 * @example
 * >>> const doc = {slides: [{delta: {items: {v: {src: "/asset/Untitled/clip.mp4"}}}}]};
 * >>> rewriteAssetRefs(doc, (e) => (e.project === "Untitled" ? e.file : null))   // localize: → RELATIVE
 * {slides: [{delta: {items: {v: {src: "clip.mp4"}}}}]}
 * >>> rewriteAssetRefs(doc, () => null) === doc   // a copy, never the same object
 * false
 */
export function rewriteAssetRefs(doc, replace) {
  return mapStrings(doc, [], (value, path) => {
    const parsed = parseAssetRef(value);
    if (!parsed) return value;
    const next = replace({ path: path.join("/"), itemId: itemIdForPath(path), ref: value, ...parsed });
    return next ?? value;
  });
}

/**
 * Pure function. The refs from `refs` that point at a project OTHER than `project`
 * — the ones an export must carry a copy of, and the ones Localize moves.
 *
 * The comparison is EXACT, not case-folded: a project folder name is
 * case-sensitive on the filesystems we serve from, and `unique_project_name`
 * de-collides by exact match too, so folding here would call a real foreign
 * project local.
 *
 * @param {Array<{project: string}>} refs - documentAssetRefs output
 * @param {string} project - the owning project's name
 * @returns {Array<object>} the foreign subset, order preserved
 *
 * @example
 * >>> const refs = [{project: "RobotSim", file: "a.png"}, {project: "Untitled", file: "clip.mp4"}];
 * >>> foreignAssetRefs(refs, "RobotSim")
 * [{project: "Untitled", file: "clip.mp4"}]
 */
export function foreignAssetRefs(refs, project) {
  return refs.filter((r) => r.project !== project);
}

/**
 * Pure function. THE LOCALIZATION PLAN: for a document being made self-contained
 * as `project`, which foreign files must be copied in, under what LOCAL name, and
 * which ref strings map to which new ref.
 *
 * Computing the plan separately from executing it is what lets the server, the
 * client and the Localize command share ONE naming decision — a byte-format
 * difference between the two exports would make the archives non-interchangeable,
 * which the zip round-trip explicitly promises they are.
 *
 * NAMING: the foreign basename is kept when it is free, and de-collided with
 * `uniqueName` otherwise (callers pass the server's or the client's scheme, so
 * each side stays consistent with the rest of its own storage). Two refs to the
 * SAME foreign file share ONE copy — a video used on four slides is copied once,
 * not four times.
 *
 * `refMap` IS KEYED BY THE REF STRING AS THE DOCUMENT SPELLS IT, not by a
 * re-minted one, and that is load-bearing rather than incidental: `assetRef`
 * percent-encodes the file as ONE segment, so re-minting a ref whose file part
 * holds a "/" (a nested path — `parseAssetRef` keeps those in `file` so the
 * server's `.thumbs/` paths stay addressable) yields "icons%2Flogo.svg", which is
 * a DIFFERENT string from the one in the document. A rewrite keyed on that would
 * match nothing and silently leave the foreign ref in place — the exact class of
 * silent hole this whole module exists to close. A node test pins it.
 *
 * Each copy carries its own `ref` (the document's spelling) and `to` (the new ref)
 * as well as the names, so a caller that must DROP one copy — an unreadable foreign
 * asset, which the exporters report rather than throw on — removes exactly its
 * mapping instead of reverse-engineering the key from the name. `refMap` is the
 * same information flattened for `rewriteAssetRefs`.
 *
 * THE NEW REF IS RELATIVE ("clip.mp4"), NOT "/asset/<project>/clip.mp4", and that
 * is the whole point of localizing rather than merely copying bytes. A localized
 * asset is BY DEFINITION a file of the project the document is becoming, so naming
 * that project inside the ref adds nothing and costs everything: the name is not
 * stable across the archive's future. `zip_project_bytes` writes the folder under
 * whatever name the export was asked for, and the IMPORT de-collides again
 * ("RobotSim" → "RobotSim 2" when one already exists) — so an absolute ref minted
 * here is stale as soon as the zip is opened anywhere that already has that project.
 * The user proved it: a RobotSim archive dropped on the static site imported its
 * assets and still rendered no video, because the refs named a project that browser
 * had never heard of. A relative ref is rename-proof and import-proof by
 * construction (core/asset_ref.js), which makes the ARCHIVE self-contained in the
 * sense the name promises, not just byte-complete.
 *
 * An ALREADY-RELATIVE ref is never in `refs` at all — `documentAssetRefs` only
 * recognizes the absolute form — so it is not planned, not copied and not rewritten.
 * That is correct: it already points at this project, and it round-trips through an
 * export byte-identically.
 *
 * @param {Array<{ref: string, project: string, file: string}>} refs - documentAssetRefs output
 * @param {string} project - the project the document is becoming
 * @param {Iterable<string>} localNames - asset basenames already present locally
 * @param {(filename: string, taken: string[]) => string} uniqueName - de-collision scheme
 * @returns {{copies: Array<{project: string, file: string, as: string, ref: string, to: string}>, refMap: Record<string, string>}}
 *
 * @example
 * >>> const refs = documentAssetRefs({slides: [{delta: {items: {a: {src: "/asset/Untitled/clip.mp4"},
 * ...                                                            b: {src: "/asset/Untitled/clip.mp4"}}}}]});
 * >>> localizationPlan(refs, "RobotSim", [], uniqueAssetName).copies
 * [{project: "Untitled", file: "clip.mp4", as: "clip.mp4",
 *   ref: "/asset/Untitled/clip.mp4", to: "clip.mp4"}]
 * >>> localizationPlan(refs, "RobotSim", ["clip.mp4"], uniqueAssetName).copies[0].to
 * "clip 2.mp4"
 */
export function localizationPlan(refs, project, localNames, uniqueName) {
  const taken = [...localNames];
  const copies = [];
  const refMap = {};
  for (const r of foreignAssetRefs(refs, project)) {
    if (refMap[r.ref] !== undefined) continue; // this exact ref is already planned
    // A foreign ref may name a nested path; only its BASENAME can land in a flat
    // assets/ folder, which is the layout both zip halves write.
    const as = uniqueName(r.file.split("/").pop(), taken);
    taken.push(as);
    // THE RELATIVE FORM (see the docblock): the copy lands in THIS project's
    // assets/, so its ref is the bare name — rename-proof and import-proof.
    const to = as;
    copies.push({ project: r.project, file: r.file, as, ref: r.ref, to });
    refMap[r.ref] = to;
  }
  return { copies, refMap };
}

// ── the walk, shared by both directions ──────────────────────────────────────

/**
 * Pure function. The item id a document JSON path belongs to, or null when the
 * path is not inside an item state. Reads the segment after "items", which is the
 * one place a document keys by item id (`slides/<i>/delta/items/<id>/…`).
 *
 * @param {string[]} path - path segments from the document root
 * @returns {string|null}
 *
 * @example
 * >>> itemIdForPath(["slides", "0", "delta", "items", "vid", "src"])
 * "vid"
 * >>> itemIdForPath(["slides", "0", "transition", "sound"])
 * null
 */
export function itemIdForPath(path) {
  const i = path.indexOf("items");
  return i >= 0 && i + 1 < path.length ? path[i + 1] : null;
}

/**
 * Command (calls `visit` per leaf; mutates nothing). Depth-first walk of every
 * STRING leaf of a JSON value, with its path. Arrays are walked by index, so a
 * filmstrip's frame list is covered like any other container.
 *
 * @param {*} value - any JSON value
 * @param {string[]} path - the path so far
 * @param {(value: string, path: string[]) => void} visit
 *
 * @example
 * >>> const seen = []; walkStrings({a: ["x"]}, [], (v, p) => seen.push([p.join("/"), v]));
 * >>> seen
 * [["a/0", "x"]]
 */
function walkStrings(value, path, visit) {
  if (typeof value === "string") {
    visit(value, path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => walkStrings(v, [...path, String(i)], visit));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walkStrings(v, [...path, k], visit);
  }
}

/**
 * Pure function. `walkStrings`' twin: a DEEP COPY of a JSON value with every
 * string leaf replaced by `map(value, path)`. Non-string leaves (numbers, null,
 * booleans) pass through by value.
 *
 * @param {*} value - any JSON value
 * @param {string[]} path - the path so far
 * @param {(value: string, path: string[]) => string} map
 * @returns {*} a new value
 *
 * @example
 * >>> mapStrings({a: ["x"]}, [], (v) => v.toUpperCase())
 * {a: ["X"]}
 */
function mapStrings(value, path, map) {
  if (typeof value === "string") return map(value, path);
  if (Array.isArray(value)) return value.map((v, i) => mapStrings(v, [...path, String(i)], map));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, [...path, k], map)]));
  }
  return value;
}
