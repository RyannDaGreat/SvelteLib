/**
 * Clipboard TEXT write — ONE reusable primitive for every "copy this text"
 * affordance (the Inspector's copy-equation-path button, the queued
 * anchor-hover copy, …). It exists because the unguarded
 * `navigator.clipboard.writeText(...)` calls threw over a NON-localhost HTTP
 * origin: the async Clipboard API is defined only in a SECURE CONTEXT (https or
 * http://localhost/127.0.0.1), and the dev server serves plain HTTP by default,
 * so `navigator.clipboard` is undefined over a non-localhost origin. This module
 * owns the secure-vs-insecure branch so no call site has to.
 *
 * DOM-touching (uses navigator/document) — a web-only module, never imported by
 * the DOM-free core.
 */

// Off-screen offset for the execCommand-fallback textarea (must stay in the
// document flow + selectable, so `display:none` won't do — park it far above
// the viewport instead).
const OFFSCREEN_PX = -9999;

// FNV-1a 32-bit constants — the same offset basis + prime core/expressions.js
// stringSeed uses. A dependency-free content hash: no crypto.subtle (that is
// secure-context-only, exactly the constraint copyText already works around),
// no hashing library.
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * The app's OWN clipboard MIME type — the OWNERSHIP MARKER. Written alongside
 * the rendered PNG on every element copy; its PRESENCE on a `paste` event is
 * proof the clipboard came from this app, so Ctrl+V pastes the ELEMENT.
 *
 * WHY THIS EXISTS (measured, 2026-07-30): the original design proved ownership
 * by hashing the PNG (`png_sig`) and comparing that hash to the pasted image's
 * bytes. That premise is FALSE. The OS pasteboard RE-ENCODES an image on its
 * way through: a 581-byte PNG written by Chrome came back as 645 bytes on
 * macOS. Different bytes ⇒ different signature ⇒ the match NEVER fires for a
 * real Ctrl+V, so a copied widget pasted back as a FLATTENED IMAGE — exactly
 * the user report ("Cmd+V pasted it as an IMAGE sometimes"), and exactly why
 * the toolbar button looked correct: it never consulted the image at all.
 *
 * A custom MIME type survives that round trip because the OS carries unknown
 * flavors VERBATIM instead of transcoding them — it is a label, not a picture.
 * `web ` prefix: the Async Clipboard API only permits non-standard types when
 * they carry it, and it is what makes the write legal rather than rejected.
 */
export const POWERRP_CLIPBOARD_MIME = "web application/x-powerrp-item";

/**
 * Pure function. A short content signature for a byte buffer (FNV-1a 32-bit,
 * length-prefixed). RETAINED as a corroborating hint only — it proves an image
 * is ours when the bytes DO survive intact (same-document, some platforms), but
 * it can never DISPROVE ownership, because the OS re-encodes images (see
 * POWERRP_CLIPBOARD_MIME). The authority is the marker; this is a fallback.
 *
 * The length prefix (`<len>.<hash>`) makes two buffers of different lengths
 * never collide regardless of the 32-bit hash — cheap extra separation for a
 * signature that gates a branch. Not a cryptographic hash and not meant to be:
 * it only distinguishes "the exact PNG we just wrote" from "a different image".
 *
 * @param {Uint8Array|number[]} bytes - the buffer to sign (PNG bytes in use)
 * @returns {string} `"<lengthHex>.<fnv1aHex>"`
 *
 * @example imageSignature([]) // "0.811c9dc5"
 * @example imageSignature([1, 2, 3]) // "3.56cf37ab"
 * @example imageSignature([137, 80, 78, 71]) // "4.4e4a5c83" (PNG magic bytes)
 */
export function imageSignature(bytes) {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, FNV_PRIME);
  }
  return `${bytes.length.toString(16)}.${(hash >>> 0).toString(16)}`;
}

/**
 * Command (mutates the system clipboard; the fallback path also creates and
 * removes a transient <textarea>). Copies `text` to the system clipboard,
 * returning whether it succeeded.
 *
 * Two paths, chosen by capability — NOT a silent fallback (path A literally
 * does not exist in an insecure context):
 *   A. Secure context → navigator.clipboard.writeText (async).
 *   B. No async API   → a hidden <textarea> + document.execCommand("copy"),
 *                       which needs no secure context.
 * A genuine failure of the chosen path is reported LOUDLY (console.error with
 * the label + text) and returns false — callers gate their success feedback on
 * the boolean, and a failure is never swallowed.
 *
 * @param {string} text - the text to place on the clipboard
 * @param {string} [label] - short context label for the loud failure log
 * @returns {Promise<boolean>} true iff the write succeeded
 *
 * @example await copyText("box.x", "equation path") // true when copied; false + console.error on failure
 */
export async function copyText(text, label = "text") {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      console.error(`PowerRP clipboard: async writeText failed for ${label} "${text}":`, e?.message ?? e);
      return false;
    }
  }
  return copyViaTextarea(text, label);
}

/**
 * Command (creates + removes a hidden <textarea>, mutates the clipboard). The
 * secure-context-free copy path: select text in an off-screen textarea and run
 * document.execCommand("copy"). Reports loudly + returns false on failure.
 *
 * @param {string} text - the text to place on the clipboard
 * @param {string} label - short context label for the loud failure log
 * @returns {boolean} true iff execCommand reported success
 *
 * @example copyViaTextarea("box.x", "equation path") // true iff execCommand("copy") succeeded
 */
function copyViaTextarea(text, label) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = `${OFFSCREEN_PX}px`;
  document.body.appendChild(ta);
  try {
    ta.select();
    const ok = document.execCommand("copy");
    if (!ok) console.error(`PowerRP clipboard: execCommand("copy") reported failure for ${label} "${text}"`);
    return ok;
  } catch (e) {
    console.error(`PowerRP clipboard: execCommand copy threw for ${label} "${text}":`, e?.message ?? e);
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}

/**
 * The three answers to "what does a copy made in THIS browser actually put on
 * the OS clipboard" — the fact a paste needs in order to know what the ABSENCE
 * of POWERRP_CLIPBOARD_MIME proves.
 *
 *   "tagged"   — the marker rides beside the PNG, so every copy this browser
 *                makes is labelled. An image arriving WITHOUT the marker is
 *                therefore proof the pasteboard has been replaced since.
 *   "untagged" — image writes work but the marker type is refused (the loud
 *                retry path in app.#writeImagePngToOs). Our own render then
 *                arrives indistinguishable from a screenshot, so absence proves
 *                NOTHING and the element must keep winning.
 *   "never"    — there is no async image-write API here at all (an insecure
 *                context, which this app deliberately runs in over plain HTTP).
 *                We put nothing on the OS clipboard, so any image on it came
 *                from somewhere else.
 *
 * @example ["tagged", "untagged", "never"].includes("untagged")
 * // true
 */
export const OS_CLIPBOARD_TAGGINGS = ["tagged", "untagged", "never"];

/**
 * Query (reads browser capabilities; no side effects). Which of
 * OS_CLIPBOARD_TAGGINGS describes this browser.
 *
 * A CAPABILITY CHECK, NOT A MEMORY OF THE LAST WRITE. `ClipboardItem.supports`
 * answers the same question the write path asks and answers it BEFORE any copy
 * has happened, so a fresh tab is as well informed as one that has copied ten
 * times, and there is no per-copy flag to persist, invalidate or get wrong
 * across tabs. Measured in this repo's headless Chrome on a 127.0.0.1 origin:
 * `supports("web application/x-powerrp-item")` -> true,
 * `supports("application/x-nonsense")` -> false (the `web ` prefix is what makes
 * a custom type legal — see POWERRP_CLIPBOARD_MIME), and the whole of
 * `ClipboardItem` is undefined over a non-secure origin.
 *
 * The "never" condition MIRRORS app.#writeImagePngToOs's own early return, and
 * that is deliberate: the two must agree about whether a copy reached the OS
 * clipboard, or a paste would reason about an image we never wrote.
 *
 * A browser with `ClipboardItem` but NO `supports` static answers "untagged" —
 * the conservative arm, because an unanswerable capability question must not be
 * read as a yes.
 *
 * @returns {"tagged"|"untagged"|"never"}
 *
 * @example // In Chrome on https/localhost: "tagged"
 * @example // Over plain HTTP on a LAN address (no navigator.clipboard): "never"
 */
export function osClipboardTagging() {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return "never";
  if (typeof ClipboardItem.supports !== "function") return "untagged";
  return ClipboardItem.supports(POWERRP_CLIPBOARD_MIME) ? "tagged" : "untagged";
}

/**
 * Pure function. Given that the app DOES hold a pasteable in-app payload, does
 * this paste event nevertheless carry something FOREIGN that should win?
 *
 * ── THE BUG THIS RULE REPLACES (user, 2026-08-21) ────────────────────────────
 * "why can't i copy and paste images into birdseye anymore i have to drag +
 *  drop an external image. it refuses to recognize when I have an image in my
 *  clipboard that's different from the image copied from copying nodes."
 *
 * The previous rule called a bare `image/png` AMBIGUOUS whenever anything was on
 * the in-app clipboard and resolved it toward the element, on the stated theory
 * that a user who wants the screenshot waits until "the widget copy is stale, or
 * pastes into a slide where no internal copy exists". NEITHER ESCAPE HATCH
 * EXISTS: the in-app clipboard is a `localStorage` mirror plus a server session
 * that are never cleared and are not scoped to a slide. So the FIRST widget copy
 * a browser ever made disabled system-image paste permanently — there was no
 * gesture, anywhere, that pasted a screenshot again.
 *
 * ── THE AMBIGUITY IS NOT REAL WHERE OUR COPIES ARE TAGGED ────────────────────
 * A copy writes POWERRP_CLIPBOARD_MIME and the PNG as ONE ClipboardItem, and a
 * screenshot REPLACES the pasteboard whole rather than adding to it. So on a
 * "tagged" browser an image with NO marker cannot be the one we wrote. That is
 * evidence, not a preference, and it does not overturn the standing ruling
 * (R3 #36 / d39e13f0, "the internal widget payload must win over the clipboard's
 * image flavor") — it removes the case that ruling was about. Where the evidence
 * is genuinely unavailable ("untagged"), the element still wins exactly as
 * before, and `untaggedCopyNotice` says so out loud.
 *
 * The order, first match wins:
 *   1. No files at all            -> not foreign (a plain in-app paste).
 *   2. Our marker on the event    -> not foreign, whatever else is there.
 *   3. Any NON-image file         -> foreign. Our copy only ever writes an image.
 *   4. Image, no marker, "tagged" -> FOREIGN: the pasteboard is no longer ours.
 *   5. Image, no marker, "never"  -> FOREIGN: we never wrote one to begin with.
 *   6. Image, no marker,"untagged"-> not foreign: indistinguishable, element wins.
 *
 * @param {File[]} files - the paste event's clipboardData.files
 * @param {string[]} types - the paste event's clipboardData.types
 * @param {"tagged"|"untagged"|"never"} tagging - osClipboardTagging()'s answer
 * @returns {boolean} true iff the OS clipboard's contents should win
 *
 * @example foreignImagePaste([], [], "tagged")
 * // false   (nothing foreign on the clipboard at all)
 * @example foreignImagePaste([{type: "image/png"}], ["Files"], "tagged")
 * // true    (a screenshot: our copies carry the marker, and this one does not)
 * @example foreignImagePaste([{type: "image/png"}], ["web application/x-powerrp-item", "Files"], "tagged")
 * // false   (our own copy coming back — paste the ELEMENT, not the bitmap)
 * @example foreignImagePaste([{type: "image/png"}], ["Files"], "untagged")
 * // false   (this browser refuses the marker, so an untagged PNG may be ours)
 * @example foreignImagePaste([{type: "application/pdf"}], ["Files"], "untagged")
 * // true    (a non-image file can never be one of our copies)
 * @example foreignImagePaste([{type: "image/png"}], ["Files"], "never")
 * // true    (no image-write API here, so we never put an image on the clipboard)
 */
export function foreignImagePaste(files, types, tagging) {
  if (!files.length) return false;
  if (types.includes(POWERRP_CLIPBOARD_MIME)) return false;
  if (files.some((f) => !f.type.startsWith("image/"))) return true;
  return tagging !== "untagged";
}

/**
 * Pure function. The sentence for the ONE case where a system-clipboard image
 * loses and the user has no way to make it win — or null when that is not what
 * is happening.
 *
 * WHY IT MUST BE SAID. On an "untagged" browser the two candidate meanings of a
 * bare PNG are genuinely indistinguishable, so the element wins and the user's
 * screenshot silently does not appear. Silence there is the same failure the
 * report above describes; the difference between a bound and a bug is whether
 * the bound is stated. It names the working gesture (drag and drop), because a
 * refusal that does not say what to do instead is half a refusal.
 *
 * It fires only when all of "we hold a payload", "an image is on the OS
 * clipboard", "no marker" and "untagged" hold at once — never on an ordinary
 * in-app paste, and never at all on a browser that carries the marker.
 *
 * @param {File[]} files - the paste event's clipboardData.files
 * @param {string[]} types - the paste event's clipboardData.types
 * @param {"tagged"|"untagged"|"never"} tagging - osClipboardTagging()'s answer
 * @returns {string|null} the warning to log, or null
 *
 * @example untaggedCopyNotice([{type: "image/png"}], ["Files"], "tagged")
 * // null    (the marker settles it — nothing was shadowed)
 * @example untaggedCopyNotice([], [], "untagged")
 * // null    (no image on the clipboard to shadow)
 * @example untaggedCopyNotice([{type: "image/png"}], ["Files"], "untagged").startsWith("Paste: ")
 * // true
 */
export function untaggedCopyNotice(files, types, tagging) {
  if (tagging !== "untagged") return null;
  if (!files.length || types.includes(POWERRP_CLIPBOARD_MIME)) return null;
  if (files.some((f) => !f.type.startsWith("image/"))) return null;
  return "Paste: an image is on your system clipboard, but this browser will not carry PowerRP's " +
    `ownership marker (${POWERRP_CLIPBOARD_MIME}), so that image cannot be told apart from the PNG ` +
    "your own last Copy left there — the copied widget was pasted instead. Drag the image file onto " +
    "the canvas to insert it, or use a browser that supports web custom clipboard formats.";
}
