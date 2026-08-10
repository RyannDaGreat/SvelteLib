/**
 * ZIP LAYER — unwrap .pptx bytes into a flat part map. A .pptx IS a zip (the
 * OPC/OOXML package format), so this is a thin, deliberately dumb wrapper
 * around `fflate`'s synchronous unzip — the same library `web/projectZip.js`
 * already uses for PowerRP's OWN .zip round-trip (chosen there, and here, for
 * the same reason: small, dependency-free, and it runs identically in bare
 * node and in the browser, which is this importer's hard requirement).
 *
 * This module does NOT interpret OOXML structure at all — no notion of parts,
 * relationships or content types lives here (that is core/pptx/opc.js). It
 * only answers "what files, with what bytes, are in this archive" and
 * "decode this member's bytes as UTF-8 XML text".
 */

import { unzipSync, strFromU8 } from "fflate";

/**
 * Pure function. Unzip .pptx bytes into a flat member map: archive path
 * (forward-slash, no leading slash) → raw bytes. Throws loudly on a corrupt or
 * non-zip byte stream — a bad .pptx must never present as an empty deck.
 *
 * @param {Uint8Array} bytes - the raw .pptx file contents
 * @returns {Record<string, Uint8Array>}
 *
 * @example
 * >>> const files = unzipPptx(bytes);
 * >>> "ppt/presentation.xml" in files
 * true
 */
export function unzipPptx(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error(`unzipPptx expects a Uint8Array, got ${bytes?.constructor?.name ?? typeof bytes}`);
  let files;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw new Error(`not a valid .pptx (zip) file: ${e?.message ?? e}`);
  }
  const out = {};
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) continue; // directory entry, not a part
    out[name.replace(/\\/g, "/")] = data;
  }
  if (Object.keys(out).length === 0) throw new Error("not a valid .pptx: the zip archive contains no files");
  return out;
}

/**
 * Pure function. Decode a zip member's bytes as UTF-8 text — every OOXML XML
 * part is UTF-8 per the OPC spec (ECMA-376 Part 2), so this is not a general
 * charset sniffer, just a named, honest decode step.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 *
 * @example decodeXmlBytes(new TextEncoder().encode("<a/>")) // "<a/>"
 */
export function decodeXmlBytes(bytes) {
  return strFromU8(bytes, false);
}

/**
 * Pure function. Look up a part's bytes by archive path, throwing with the
 * available-paths context if absent — callers resolving a relationship target
 * need to know INSTANTLY when a .rels file points at a part that doesn't
 * exist, rather than chase a `undefined` through three more functions.
 *
 * @param {Record<string, Uint8Array>} files - the unzipPptx() member map
 * @param {string} path - archive path, forward-slash, no leading slash
 * @returns {Uint8Array}
 *
 * @example requirePart({"ppt/presentation.xml": new Uint8Array([1])}, "ppt/presentation.xml").length // 1
 */
export function requirePart(files, path) {
  const bytes = files[path];
  if (!bytes) throw new Error(`.pptx is missing part "${path}" — archive has ${Object.keys(files).length} parts`);
  return bytes;
}
