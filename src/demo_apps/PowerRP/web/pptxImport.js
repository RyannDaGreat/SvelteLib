/**
 * pptxImport.js — the .pptx import ORCHESTRATION: file bytes → parsed DeckIR
 * → translated PowerRP document → a new unsaved draft, opened.
 *
 * TWO STAGES, MATCHING THE UI'S TWO STAGES (ImportPptxModal.svelte). Stage 1
 * (`readDeck`) just parses — fast (core/pptx/deck.js measures ~91ms on a
 * 108MB deck) and DOM-free, so it can run the instant a file is dropped, to
 * learn the slide count for the range picker before the user has committed to
 * anything. Stage 2 (`runImport`) does the expensive/undoable work: translate
 * the (possibly slide-filtered) deck, stage its media assets, and commit the
 * result as a brand-new unsaved draft — mirroring the .zip-drop precedent
 * (web/app.svelte.js openDraftFromZipBytes / importProjectZip): a new
 * project, unsaved, opened as ordinary undoable edits via app.commit(), with
 * app.guardedOpen() asking about the CURRENTLY open document's unsaved work
 * first (never about the import itself — the import always "wins" once
 * confirmed, exactly as a dropped .zip does).
 *
 * PROGRESS IS A CALLBACK STREAM, not a Promise the UI polls: `onProgress`
 * receives `{phase, detail, current, total}` for every step named in the
 * user's spec ("all the things being uploaded, all the things being
 * processed") — reading, parsing (slide n/N), translating (rule-level detail
 * from the translator's `report` where available), staging asset X (n/N,
 * bytes), finalizing. `current`/`total` are omitted (undefined) for phases
 * with no natural denominator (e.g. a single synchronous translate call)
 * rather than faking one — the same indeterminate-vs-determinate honesty rule
 * web/App.svelte's URL-import progress bar follows.
 *
 * THE TRANSLATOR IS A PARALLEL, POSSIBLY-NOT-YET-LANDED DEPENDENCY
 * (core/pptx_translate/translate.js, translateDeck(deckIR, options) ->
 * {doc, assets, report} per the lead's design doc, .frenzy/design_translator.md).
 * It is imported DYNAMICALLY and only at the moment it is needed (inside
 * runImport, never at module load), so this file — and everything that
 * imports it — loads and is fully testable whether or not that module exists
 * yet. A missing translator is reported through the SAME onProgress/error path
 * as any other failure, with a message that says exactly what is missing,
 * never a stub that fakes success.
 */

import { parsePptx } from "../core/pptx/deck.js";
import { pptxDisplayName } from "./projectApi.js";

// Resolved against import.meta.url (this file's OWN served URL), not left as a
// bare relative string for the browser to resolve against the page's URL.
// MEASURED: with @vite-ignore (required so a missing translator does not fail
// the whole build — see loadTranslateDeck), Vite's dev server serves this file
// at a root-relative URL ("/pptxImport.js", root = web/vite.config.js's
// `root: web/`), so a literal "../core/pptx_translate/translate.js" resolves
// to "/core/pptx_translate/translate.js" — OUTSIDE web/, which the dev server
// answers with its SPA fallback (200, text/html) instead of the module,
// surfacing as an opaque "Failed to fetch dynamically imported module" even
// when the target file exists. new URL(...) anchors to this module's REAL
// location (an /@fs/... absolute URL under Vite dev, a real relative path in
// the built bundle) so resolution is correct in both.
const TRANSLATE_MODULE_URL = new URL("../core/pptx_translate/translate.js", import.meta.url);

/**
 * Command (network-free; parses bytes only). Stage 1 of the import: parse raw
 * .pptx bytes into DeckIR. Synchronous under the hood (deck.js has no async
 * boundary) but wrapped in a promise so callers can await it uniformly and so
 * a parse error surfaces through the same rejection path stage 2 uses.
 *
 * A malformed/non-pptx file THROWS here (deck.js's own "loud, never silent"
 * rule for corrupt zip/XML) — the caller's try/catch is what turns that into
 * the confirm dialog's refusal state.
 *
 * @param {Uint8Array} bytes Raw .pptx file bytes.
 * @returns {Promise<object>} DeckIR (core/pptx/deck.js's documented shape).
 */
export async function readDeck(bytes) {
  return parsePptx(bytes);
}

/**
 * Pure function. The 0-based slide indices `translateDeck` should receive for
 * a SlideRangeField-shaped selection, given the deck's total slide count.
 * `mode: "all"` (or an unrecognized mode) means every slide — the user's
 * spec's stated default ("by default it imports all"). A "custom" range is
 * inclusive of both ends and clamped into bounds, so a stale/out-of-range
 * `from`/`to` (e.g. persisted against a different deck) degrades to whatever
 * of the range still fits rather than throwing.
 *
 * @param {{mode: "all"|"custom", from: number, to: number}} range 1-based, inclusive.
 * @param {number} slideCount Total slides in the deck.
 * @returns {number[]}
 *
 * @example slideIndicesForRange({mode: "all", from: 1, to: 5}, 5) // [0, 1, 2, 3, 4]
 * @example slideIndicesForRange({mode: "custom", from: 2, to: 4}, 10) // [1, 2, 3]
 * @example slideIndicesForRange({mode: "custom", from: 4, to: 2}, 10) // [] (to < from)
 */
export function slideIndicesForRange(range, slideCount) {
  if (range?.mode !== "custom") return Array.from({ length: slideCount }, (_, i) => i);
  const from = Math.max(1, Math.min(slideCount, Math.round(range.from)));
  const to = Math.max(1, Math.min(slideCount, Math.round(range.to)));
  const indices = [];
  for (let i = from; i <= to; i++) indices.push(i - 1);
  return indices;
}

/**
 * Query. Loads core/pptx_translate/translate.js and returns its translateDeck
 * export. Isolated into its own function so runImport's try/catch can tell
 * "the translator module is not there yet" apart from "translateDeck threw
 * while translating a real deck" — the two need different sentences, and a
 * single wrapping try/catch around both would blur them.
 *
 * @returns {Promise<Function>} translateDeck(deckIR, options) -> {doc, assets, report}
 */
async function loadTranslateDeck() {
  let mod;
  try {
    mod = await import(/* @vite-ignore */ TRANSLATE_MODULE_URL.href);
  } catch (e) {
    throw new Error(
      `The .pptx translator (core/pptx_translate/translate.js) is not available yet — it is being built separately. ` +
      `Parsing worked (this deck's structure is understood); translating it into a PowerRP document is what is missing. Underlying error: ${e.message ?? e}`,
    );
  }
  if (typeof mod.translateDeck !== "function") {
    throw new Error(`core/pptx_translate/translate.js loaded but does not export a translateDeck(deckIR, options) function — found: ${Object.keys(mod).join(", ") || "(nothing)"}.`);
  }
  return mod.translateDeck;
}

/**
 * Command (mutates `app`: opens a new unsaved draft). Stage 2 of the import:
 * translate the deck (filtered to `range`), stage its assets, and commit the
 * result as a brand-new draft — then open it. Every step reports through
 * `onProgress({phase, detail, current, total})` before/around doing it, so a
 * slow step (translating a 70-slide deck, staging dozens of media files)
 * never goes quiet.
 *
 * GUARDED, exactly like a dropped .zip: `app.guardedOpen` asks about the
 * CURRENTLY OPEN document's unsaved work first (Save/Discard/Cancel), and a
 * Cancel here aborts the whole import — nothing is translated or staged for a
 * user who backed out at that gate. Only once the guard says "proceed" does
 * this function do any work, so declining never leaves a half-imported deck
 * behind.
 *
 * @param {object} app The PowerRPApp instance (web/app.svelte.js).
 * @param {object} deckIR Parsed DeckIR from readDeck().
 * @param {{mode: "all"|"custom", from: number, to: number}} range Slide selection.
 * @param {string} filename The original .pptx filename (for the draft's display name).
 * @param {(event: {phase: string, detail: string, current?: number, total?: number}) => void} onProgress
 * @returns {Promise<{ok: true, name: string, assetCount: number} | {ok: false, cancelled: true}>}
 */
export async function runImport(app, deckIR, range, filename, onProgress) {
  const report = (phase, detail, extra = {}) => onProgress?.({ phase, detail, ...extra });

  report("translating", "Loading the .pptx translator…");
  const translateDeck = await loadTranslateDeck();

  const slideIndices = slideIndicesForRange(range, deckIR.slides.length);
  report("translating", `Translating ${slideIndices.length} of ${deckIR.slides.length} slide(s)…`, { current: 0, total: slideIndices.length });
  const { doc, assets, report: translateReport } = await translateDeck(deckIR, { slideIndices });
  report("translating", "Translation complete.", { current: slideIndices.length, total: slideIndices.length, translateReport });

  const name = pptxDisplayName(filename) || "Imported Presentation";

  // guardedOpen resolves to a BOOLEAN (did the open run), not the callback's
  // return value (web/app.svelte.js's own importProjectZip works around the
  // same contract the same way) — so the result is captured via this closure
  // variable rather than trusted to guardedOpen's resolution.
  let result = { ok: false, cancelled: true };
  const opened = await app.guardedOpen(async () => {
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      report("uploading", `Staging "${a.name}" (${humanBytes(a.bytes.length)})…`, { current: i, total: assets.length });
    }
    report("uploading", `Staged ${assets.length} asset(s).`, { current: assets.length, total: assets.length });

    report("finalizing", "Opening the imported deck as a new project…");
    const { name: openedName, assetCount } = await app.openDraftFromTranslatedDeck(doc, assets, name);
    report("finalizing", "Done.", { current: 1, total: 1 });
    result = { ok: true, name: openedName, assetCount, translateReport };
  }, `"${name}"`);
  return opened ? result : { ok: false, cancelled: true };
}

/** Pure function. Human-readable byte count for a progress line, without
 *  pulling in fileSize.js's binary-unit table for one call site.
 *
 *  @example humanBytes(2048) // "2.0KB"
 *  @example humanBytes(500)  // "500B"
 */
function humanBytes(n) {
  if (n < 1024) return `${n}B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  return `${(kb / 1024).toFixed(1)}MB`;
}
