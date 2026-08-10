/**
 * MEDIA PARTS — decode a PowerRP image widget's `src` (a `data:` URI or plain
 * URL string, per plugins/image.js's own header: "self-contained... a dropped
 * image can be inlined as a data URI") into bytes + extension for a
 * `ppt/media/imageN.<ext>` part. DOM-free: no `Image`/`canvas`/`fetch` — a
 * `data:` URI's base64 payload decodes with plain `atob`-equivalent math, and
 * a bare URL (not embeddable without a network fetch this exporter does not
 * perform) is reported and skipped rather than silently dropped.
 */

const DATA_URI_RE = /^data:([^;,]+)(;base64)?,(.*)$/s;

const MIME_TO_EXT = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/**
 * Pure function. Decode a `data:` URI's base64 payload into raw bytes — a
 * tiny DOM-free base64 decoder (no `atob`, which is a browser/Node-global but
 * not guaranteed identical in every bare-node context this app targets; the
 * app's own core/pptx/zip.js precedent already avoids relying on Node-only
 * globals inside core/).
 *
 * @param {string} b64
 * @returns {Uint8Array}
 *
 * @example base64ToBytes("aGk=") // Uint8Array [104, 105] ("hi")
 */
export function base64ToBytes(b64) {
  const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = b64.replace(/=+$/, "");
  const bytes = [];
  let buffer = 0, bits = 0;
  for (const ch of clean) {
    const v = BASE64_CHARS.indexOf(ch);
    if (v === -1) continue; // whitespace/newlines inside a data URI, if any
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Pure function. Parse an image widget's `src` string into
 * `{bytes, ext} | null` — null for anything this exporter cannot embed
 * (a bare URL with no fetch step, or a MIME type this table doesn't know).
 * Never throws: an unembeddable image is the CALLER's downgrade-report
 * business (export.js), not a hard failure of the whole deck.
 *
 * @param {string} src
 * @returns {{bytes: Uint8Array, ext: string, mime: string}|null}
 *
 * @example decodeImageSrc("data:image/png;base64,aGk=").ext // "png"
 * @example decodeImageSrc("https://example.com/x.png") // null (not embeddable — no fetch step here)
 */
export function decodeImageSrc(src) {
  if (typeof src !== "string") return null;
  const m = DATA_URI_RE.exec(src);
  if (!m) return null; // a plain URL, or an unrecognized scheme
  const [, mime, isBase64, payload] = m;
  const ext = MIME_TO_EXT[mime.toLowerCase()];
  if (!ext) return null;
  const bytes = isBase64 ? base64ToBytes(payload) : new TextEncoder().encode(decodeURIComponent(payload));
  return { bytes, ext, mime };
}
