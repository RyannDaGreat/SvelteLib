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
