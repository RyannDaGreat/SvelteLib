/**
 * surgeGui.js — Surge XT's REAL GUI (the C++ SurgeGUIEditor, compiled to
 * WebAssembly) driven onto a 2D canvas, as a PowerRP module.
 *
 * This file is the ADAPTER and nothing else. It owns the wasm module's lifecycle,
 * the Emscripten filesystem mount, the pointer/wheel/key translation, the frame
 * loop, and the parameter diff. It owns NO audio: it never constructs an
 * AudioContext, never imports `synth/**`, and never posts to an AudioWorkletNode.
 * Everything it learns about the user's intent leaves through the four callbacks
 * `createSurgeGuiSession` takes, and the audio half decides what to do with them.
 * That separation is the whole reason there are two Surge instances in the first
 * place (see WHY TWO INSTANCES below).
 *
 * ── WHY TWO SURGE INSTANCES ─────────────────────────────────────────────────
 * The upstream WebSurge project runs `surge-gui.wasm` on the MAIN thread
 * (SurgeGUIEditor + its own SurgeSynthesizer — it draws the interface and owns
 * parameter state) and `surge-engine.wasm` on the AUDIO thread (SurgeSynthesizer
 * only — it makes the sound). They cannot be one object: the GUI needs the main
 * thread (canvas, DOM events) and the DSP needs the audio thread (no jitter).
 * They are the same Surge build, so parameter INDICES line up exactly, which is
 * what makes the per-frame diff below a valid wire format between them.
 *
 * THIS MODULE IS THE MAIN-THREAD HALF ONLY. `onParam(index, value)` is the diff;
 * the audio half is expected to forward it to its own Surge. Nothing here knows
 * that the audio half exists.
 *
 * ── WHERE THE BYTES COME FROM ───────────────────────────────────────────────
 * Vendored in-tree (src/demo_apps/PowerRP/vendor/websurge/, GPL v3, 292 KB):
 *   js/surge-gui.js        the Emscripten ES6 glue (`export default createSurgeGui`)
 *   data/surge-data.json   {files:[{p,o,n}]} — path, offset, length into the archive
 *
 * Fetched from the network on FIRST USE (deliberately NOT vendored — 49 MB):
 *   surge-gui.wasm         19.8 MB, the editor itself
 *   surge-data.bin         30.5 MB, 842 packed factory patches + wavetables
 *   surge-remote.json      the 2,920-patch on-demand 3rd-party index
 *   patches_3rdparty/**.fxp fetched individually when one is picked
 *
 * The remote host sends `access-control-allow-origin: *`, so these are ordinary
 * cross-origin fetches with no proxy.
 *
 * ── THE INIT ORDER IS A HARD CONSTRAINT, NOT A STYLE ────────────────────────
 * SurgeStorage builds its patch and wavetable lists by SCANNING A DIRECTORY, in
 * its CONSTRUCTOR. A tree that appears after `sgui_init` is invisible to Surge
 * FOREVER — the patch list stays empty and the Category/Patch jog buttons
 * silently do nothing (SurgeSynthesizerIO.cpp returns early on size 0). So:
 *
 *   1. create the module          5. sgui_init(dataRoot);  0 ⟹ throw
 *   2. cwrap the 21 symbols       6. sgui_patch_count() === 0 ⟹ throw
 *   3. fetch archive + index      7. canvas 2d ctx, applyScale, malloc paramPtr
 *   4. unpack into M.FS  ← HERE   8. attach input, invalidate, start the rAF loop
 *
 * Step 6 is not defensive programming. A Surge that mounted nothing still DRAWS
 * — a complete, responsive, entirely normal-looking interface whose every patch
 * control is dead. That is the exact failure this project's "no silent failure"
 * law exists for, so it is a throw with a sentence, not a console warning.
 *
 * ── MEMFS HAS NO `mkdir -p` ─────────────────────────────────────────────────
 * Directories are created parents-first (`directoriesFor` sorts by depth), and
 * existence is TESTED rather than mkdir-and-catch-EEXIST. Emscripten only
 * populates ErrnoError's `.code`/`.message` when built with assertions on, so a
 * release build raises a bare `{errno: 20}` that no string comparison
 * recognises — a catch written against `.code` would swallow every real error
 * (a permission problem, a file where a directory should be) as if it were
 * "already exists".
 *
 * ── CACHING: A SEPARATE CACHE, DELIBERATELY OUTSIDE THE SHELL'S ATOMICITY ───
 * 49 MB per modal open is not acceptable, so the wasm and the archive are stored
 * in Cache Storage under SURGE_CACHE_NAME — a cache this module opens directly,
 * and NOTHING ELSE TOUCHES.
 *
 * IT IS NOT THE SERVICE WORKER'S SHELL CACHE AND MUST NEVER BECOME IT.
 * CLAUDE.md: "THE SERVICE WORKER'S LAW IS ATOMICITY: at no instant may a page
 * load assets from two different versions… A version's shell cache is written by
 * exactly ONE thing — install's all-or-nothing addAll — and a network response is
 * never stored in a shell cache; that write is what built the chimera." These
 * bytes are the opposite kind of thing in every respect that law cares about:
 *   • they are not PowerRP's code, so they cannot be half of a chimera with it —
 *     a mixed-version page is a page running module A against module B, and
 *     surge-gui.wasm is not in that graph at all;
 *   • they are third-party, immutable-in-practice artefacts on a foreign origin,
 *     not something a PowerRP deploy versions;
 *   • they are 49 MB, and `addAll` is all-or-nothing, so precaching them would
 *     make EVERY install of the app fail whenever the remote host hiccups —
 *     turning an optional widget's network into a total boot failure.
 * So this cache is deliberately NON-ATOMIC with the shell, and that is sound
 * precisely because it holds nothing the shell's atomicity is about. It is
 * versioned by its own name (bump `-v1` if the remote artefacts ever change
 * shape) and, being an ordinary named cache, it shows up in the debug console's
 * `caches.keys()` listing like any other.
 *
 * WHEN CACHE STORAGE IS ABSENT (a non-loopback plain-HTTP origin is not a secure
 * context, so `caches` is undefined there) the fetches still work — they are just
 * not cached, and that is reported once on the console rather than failing.
 *
 * ── ONE MODULE, MANY OPENS ──────────────────────────────────────────────────
 * `ensureSurgeModule()` is memoized at module scope. Instantiating 19.8 MB of
 * wasm and writing 842 files takes seconds, and Surge's C++ side is a SINGLETON
 * editor anyway (`sgui_init` builds the one SurgeGUIEditor), so a second modal
 * open RE-ATTACHES to the module that is already up instead of building another.
 * That also means the patch the author loaded is still loaded when they reopen
 * the dialog, which is the behaviour anyone would expect. `destroy()` therefore
 * detaches (stops the loop, drops listeners, releases held notes) WITHOUT tearing
 * the module down. A failed load clears the memo so a retry genuinely retries.
 *
 * Because the editor is a singleton, two live sessions would fight over one set
 * of pixels: a second `createSurgeGuiSession` while one is attached is REFUSED
 * with a sentence rather than quietly stealing the first one's canvas.
 */

/** The origin every remote byte comes from. Named in error messages on purpose:
 *  "fetch failed" is useless, "ryanndagreat.github.io is unreachable" is not. */
export const SURGE_REMOTE_ORIGIN = "https://ryanndagreat.github.io";
/** Base of the upstream WebSurge deployment. */
export const SURGE_REMOTE_BASE = `${SURGE_REMOTE_ORIGIN}/WebSurge/src/`;
/** The editor wasm — 19,772,078 bytes. */
export const SURGE_GUI_WASM_URL = `${SURGE_REMOTE_BASE}js/surge-gui.wasm`;
/** The packed factory archive — 30,477,332 bytes, indexed by the vendored json. */
export const SURGE_DATA_BIN_URL = `${SURGE_REMOTE_BASE}data/surge-data.bin`;
/** The on-demand 3rd-party patch manifest — a flat array of archive paths. */
export const SURGE_REMOTE_INDEX_URL = `${SURGE_REMOTE_BASE}data/surge-remote.json`;
/** Where an individual on-demand .fxp lives, relative to which paths are joined. */
export const SURGE_REMOTE_PATCH_BASE = `${SURGE_REMOTE_BASE}data/`;

/** Where Surge is told to look inside the Emscripten filesystem (its
 *  SURGE_DATA_HOME). Upstream's value; kept identical so the audio half, which
 *  mounts the same tree, and this half agree on every stored patch path. */
export const SURGE_DATA_ROOT = "/SurgeXTData";

/** THE CACHE. Named, separate, and not the service worker's — see the header. */
export const SURGE_CACHE_NAME = "powerrp-surge-remote-v1";

/** The vendored archive index (path → offset/length). `?url` rather than a JSON
 *  import so the 57 KB does not sit inside the app bundle for every user who
 *  never opens this dialog. Re-exported because it is a BUILD fact — the URL the
 *  bundler resolved this vendored file to — and the probe asserts that it really
 *  resolves rather than 404ing at the one moment it is needed. */
import SURGE_DATA_INDEX_URL from "../vendor/websurge/data/surge-data.json?url";
export { SURGE_DATA_INDEX_URL };

/** Velocity for a mouse-played piano key. Upstream's value. A real velocity
 *  needs a real controller; 100 is a firm-but-not-maximum default. */
export const MOUSE_VELOCITY = 100;

/**
 * browser KeyboardEvent.key → juce::KeyPress code, for the non-printable keys.
 *
 * TRANSCRIBED FROM upstream's `js/keycodes.js`, which is GENERATED by
 * tools/gen_keycodes.py from THE SAME TABLE as the C++ side
 * (host/surge_wasm/juce_KeyCodes_wasm.cpp), so the two cannot disagree.
 *
 * IT IS NOT upstream's OTHER table, and the difference is not cosmetic.
 * `js/gui-app.js` also carries a hand-written `juceKeyCode()` with an inline
 * `SPECIAL` map, and the two DISAGREE: gui-app says ArrowUp = 0x10000 and
 * Delete = 0x10004; the generated table says ArrowUp = 0x10002 and
 * Delete = 0x10000. Only one of them was generated from the C++ constants, and
 * that is the one copied here. (Nothing upstream ever noticed, because upstream
 * never calls `sgui_key` at all — see the KEYBOARD note on `attach`.)
 */
export const JUCE_KEY_CODES = {
  " ": 32,
  Escape: 27,
  Enter: 13,
  Tab: 9,
  Backspace: 8,
  Delete: 0x10000,
  Insert: 0x10001,
  ArrowUp: 0x10002,
  ArrowDown: 0x10003,
  ArrowLeft: 0x10004,
  ArrowRight: 0x10005,
  PageUp: 0x10006,
  PageDown: 0x10007,
  Home: 0x10008,
  End: 0x10009,
  F1: 0x1000a,
  F2: 0x1000b,
  F3: 0x1000c,
  F4: 0x1000d,
  F5: 0x1000e,
  F6: 0x1000f,
  F7: 0x10010,
  F8: 0x10011,
  F9: 0x10012,
  F10: 0x10013,
  F11: 0x10014,
  F12: 0x10015,
};

// ─────────────────────────────────────────────────────────────────────────────
// PURE FUNCTIONS — the piano layout, the filesystem plan, the patch index.
// All of these are DOM-free and dependency-free so they can be exercised
// directly (tests/surge_gui_probe.js drives every one of them through the dev
// server, which is what lets the probe assert real behaviour without a 49 MB
// download).
// ─────────────────────────────────────────────────────────────────────────────

/** Semitones within an octave that are white keys: C D E F G A B. */
const WHITE_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** The full MIDI range the piano shows: 75 white keys and 53 black. */
export const MIDI_LOW = 0;
export const MIDI_HIGH = 127;

/**
 * Pure function. Is this MIDI note a white key?
 *
 * @param {number} note MIDI note number.
 * @returns {boolean}
 *
 * @example isWhite(60) // true  (C4)
 * @example isWhite(61) // false (C#4)
 */
export function isWhite(note) {
  return WHITE_SEMITONES.includes(((note % 12) + 12) % 12);
}

/**
 * Pure function. Human-readable name for a MIDI note, with octave.
 *
 * Middle C (note 60) is C4 — the convention Surge's own keytrack display uses,
 * so a label here and a label in the wasm's pixels cannot disagree.
 *
 * @param {number} note MIDI note number.
 * @returns {string}
 *
 * @example noteName(60) // "C4"
 * @example noteName(0)  // "C-1"
 * @example noteName(61) // "C#4"
 */
export function noteName(note) {
  return `${NOTE_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
}

/**
 * Pure function. Geometry for all 128 keys, as FRACTIONS of the total width.
 *
 * White keys tile the full width end to end at 1/75 each. Each black key is
 * `unit * 0.62` wide and CENTRED ON THE SEAM after the white key below it, so
 * the classic uneven grouping (two blacks, gap, three blacks) falls out of the
 * note pattern instead of being hard-coded — which is also why this is worth
 * having as a pure function rather than a CSS grid.
 *
 * Fractions, not pixels, because the strip is width-responsive: the modal is
 * 90vw and the same layout has to survive every viewport.
 *
 * @returns {{white: Array<{note:number,x:number,w:number}>,
 *            black: Array<{note:number,x:number,w:number}>}} x and w in 0..1.
 *
 * @example
 * keyLayout().white.length // 75
 * @example
 * keyLayout().black.length // 53
 * @example
 * keyLayout().white[0] // { note: 0, x: 0, w: 1 / 75 }
 */
export function keyLayout() {
  const whiteNotes = [];
  for (let n = MIDI_LOW; n <= MIDI_HIGH; n++) if (isWhite(n)) whiteNotes.push(n);

  const unit = 1 / whiteNotes.length;
  const white = whiteNotes.map((note, i) => ({ note, x: i * unit, w: unit }));

  const indexOfWhite = new Map(whiteNotes.map((n, i) => [n, i]));
  const blackWidth = unit * 0.62;
  const black = [];
  for (let n = MIDI_LOW; n <= MIDI_HIGH; n++) {
    if (isWhite(n)) continue;
    const seam = indexOfWhite.get(n - 1);
    if (seam === undefined) continue; // a black key with no white below it cannot be placed
    black.push({ note: n, x: (seam + 1) * unit - blackWidth / 2, w: blackWidth });
  }
  return { white, black };
}

/**
 * Pure function. Every directory that must exist for these files, PARENTS FIRST.
 *
 * MEMFS has no `mkdir -p` and creating a child before its parent fails, so the
 * set has to be emitted shallowest-first — which is what the sort does (a path's
 * segment count is its depth; the localeCompare tiebreak only makes the order
 * deterministic, which matters for the probe).
 *
 * @param {Array<{p: string}>} files Archive entries.
 * @returns {string[]} Directory paths relative to the root, parents before children.
 *
 * @example
 * directoriesFor([{ p: "wavetables/Basic/Sine.wt" }])
 * // ["wavetables", "wavetables/Basic"]
 * @example
 * directoriesFor([{ p: "a/b/c.fxp" }, { p: "a/d.fxp" }])
 * // ["a", "a/b"]
 */
export function directoriesFor(files) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.p.split("/");
    parts.pop(); // drop the filename
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      dirs.add(acc);
    }
  }
  return [...dirs].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
}

/** Archive top-level directory → the bank label the selector shows. A path whose
 *  first segment is neither is not a patch we know how to describe, and is
 *  dropped rather than shown under a made-up heading. */
const BANKS = { patches_factory: "Factory", patches_3rdparty: "3rd Party" };

/**
 * Pure function. The browsable patch index, from both sources at once.
 *
 * `path` is ALWAYS a location in the wasm filesystem, never a URL. A remote
 * patch is written to exactly that path the moment its bytes arrive, so by the
 * time Surge is asked to load one there is no difference between the two kinds —
 * which is why `remote` is one boolean rather than two code paths downstream.
 *
 * Derived from the archive's OWN file list (not a second, independently
 * generated index) so the selector structurally cannot advertise a patch the
 * deploy does not contain — a whole class of 404-on-click bugs.
 *
 * @param {string[]} mounted Archive-relative paths already in the filesystem.
 * @param {string[]} remote Archive-relative paths fetched on demand.
 * @param {string} root The mount point.
 * @returns {Array<{name:string, category:string, bank:string, path:string,
 *                  archivePath:string, remote:boolean}>} Sorted bank, then
 *          category, then name — all case-insensitively.
 *
 * @example
 * buildPatchIndex(["patches_factory/Basses/Sub.fxp"], [], "/SurgeXTData")[0]
 * // { name: "Sub", category: "Basses", bank: "Factory", remote: false,
 * //   path: "/SurgeXTData/patches_factory/Basses/Sub.fxp",
 * //   archivePath: "patches_factory/Basses/Sub.fxp" }
 * @example
 * // Anything that is not an .fxp under a known bank is not a patch.
 * buildPatchIndex(["wavetables/Basic/Sine.wt"], [], "/d") // []
 */
export function buildPatchIndex(mounted, remote, root) {
  const patches = [];
  const add = (archivePath, isRemote) => {
    if (!archivePath.endsWith(".fxp")) return;
    const parts = archivePath.split("/");
    const bank = BANKS[parts[0]];
    if (!bank) return;
    patches.push({
      name: parts[parts.length - 1].replace(/\.fxp$/, ""),
      category: parts.slice(1, -1).join("/") || "(root)",
      bank,
      path: `${root}/${archivePath}`,
      archivePath,
      remote: isRemote,
    });
  };
  for (const p of mounted) add(p, false);
  for (const p of remote) add(p, true);
  patches.sort(
    (a, b) =>
      a.bank.localeCompare(b.bank) ||
      a.category.toLowerCase().localeCompare(b.category.toLowerCase()) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
  return patches;
}

/**
 * Pure function. The patches a bank choice and a search box select.
 *
 * Matching is case-insensitive and spans NAME, CATEGORY and BANK together, so
 * "liv bass" style narrowing works without the reader having to know which field
 * holds which word — every whitespace-separated term must appear SOMEWHERE in
 * that joined haystack.
 *
 * @param {Array<object>} patches The full index.
 * @param {string} bank "" for every bank, else an exact bank label.
 * @param {string} query Free text; blank matches everything.
 * @returns {Array<object>} A filtered view, order preserved.
 *
 * @example
 * const ps = buildPatchIndex(["patches_factory/Basses/Sub.fxp"], [], "/d");
 * filterPatches(ps, "", "sub").length // 1
 * @example
 * filterPatches(buildPatchIndex(["patches_factory/Basses/Sub.fxp"], [], "/d"),
 *               "3rd Party", "") // []
 */
export function filterPatches(patches, bank, query) {
  const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return patches.filter((p) => {
    if (bank && p.bank !== bank) return false;
    if (terms.length === 0) return true;
    const hay = `${p.name} ${p.category} ${p.bank}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/**
 * Pure function. A KeyboardEvent's juce::KeyPress code.
 *
 * Non-printables come from JUCE_KEY_CODES; a printable key is its own character
 * code (which is how juce::KeyPress represents it); anything else is 0, which
 * JUCE ignores.
 *
 * @param {{key: string}} e A KeyboardEvent, or anything with `.key`.
 * @returns {number}
 *
 * @example juceKeyCode({ key: "ArrowLeft" }) // 0x10004
 * @example juceKeyCode({ key: "a" })         // 97
 * @example juceKeyCode({ key: "Meta" })      // 0
 */
export function juceKeyCode(e) {
  const special = JUCE_KEY_CODES[e.key];
  if (special !== undefined) return special;
  if (typeof e.key === "string" && [...e.key].length === 1) return e.key.codePointAt(0);
  return 0;
}

/**
 * Pure function. The character a KeyboardEvent types, as a code point.
 *
 * Separate from the key code because juce::KeyPress carries both: the KEY that
 * was pressed and the TEXT it produced. They differ for every modified or
 * non-printable press, and Surge's in-panel text entry reads the second one.
 *
 * @param {{key: string}} e A KeyboardEvent, or anything with `.key`.
 * @returns {number} 0 when the press types nothing.
 *
 * @example juceTextChar({ key: "a" })     // 97
 * @example juceTextChar({ key: "Enter" }) // 0
 */
export function juceTextChar(e) {
  return typeof e.key === "string" && [...e.key].length === 1 ? e.key.codePointAt(0) : 0;
}

/**
 * Pure function. Patch bytes as base64, for storing one in a document.
 *
 * THIS EXISTS BECAUSE THE OBVIOUS ONE-LINER CRASHES, and it crashes on real
 * data rather than on some edge case. `btoa(String.fromCharCode(...bytes))`
 * spreads the array into ARGUMENTS, and the argument count is capped at roughly
 * 65–125k depending on the engine: it throws `RangeError: Maximum call stack size
 * exceeded`. Factory patches are ~25–80 KB and survive that; the 3rd-party bank
 * does not — "A.Liv/Basses/Amen Polska.fxp" is 291,035 bytes (measured, and
 * pinned in tests/surge_gui_probe.js). So the naive version would work for every
 * patch a developer tried and fail on the ones a user picked.
 *
 * Chunked at 32 KB, well under every engine's limit.
 *
 * @param {Uint8Array} bytes Typically `readBytes()` from an onPatch payload.
 * @returns {string} Standard base64, no line breaks.
 *
 * @example patchBytesToBase64(new Uint8Array([67, 99, 110, 75])) // "Q2NuSw=="
 * @example patchBytesToBase64(new Uint8Array(0)) // ""
 */
export function patchBytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Pure function. The sentence a failed remote fetch gets.
 *
 * A bare "Failed to fetch" tells an author nothing they can act on. This names
 * the HOST, says the bytes are a first-use download, and says what happens
 * afterwards — the three facts that turn "it's broken" into "I'm offline".
 *
 * @param {string} url The URL that failed.
 * @param {string} detail What went wrong (an HTTP status line, or an error message).
 * @returns {string}
 *
 * @example
 * remoteFailureSentence("https://h/x.wasm", "HTTP 404")
 * // 'Surge could not fetch https://h/x.wasm — HTTP 404. …'
 */
export function remoteFailureSentence(url, detail) {
  return (
    `Surge could not fetch ${url} — ${detail}. PowerRP streams Surge XT's ` +
    `19 MB editor and 30 MB factory archive from ${SURGE_REMOTE_ORIGIN} the ` +
    `first time this dialog is opened, so first use needs a working network ` +
    `connection; after that they are served from the "${SURGE_CACHE_NAME}" cache.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CACHE — see the header for why it is separate from the service worker's.
// ─────────────────────────────────────────────────────────────────────────────

/** Remembered so the "no Cache Storage here" note is printed once, not per fetch. */
let cacheAbsenceReported = false;

/**
 * Query. This module's own cache, or null where Cache Storage does not exist.
 *
 * Null is a normal outcome, not a failure: `caches` is only defined in a SECURE
 * CONTEXT, and PowerRP is explicitly usable on a plain-HTTP non-loopback origin
 * (that is why the renderer avoids WebGPU). Callers degrade to an uncached fetch.
 *
 * @returns {Promise<Cache|null>}
 */
async function openSurgeCache() {
  if (typeof caches === "undefined" || !caches?.open) {
    if (!cacheAbsenceReported) {
      cacheAbsenceReported = true;
      console.warn(
        `surgeGui: Cache Storage is unavailable on this origin (${
          typeof location === "undefined" ? "?" : location.origin
        }), which is not a secure context. Surge's 49 MB of remote assets will ` +
          `be re-downloaded every time this dialog is opened. Serve over HTTPS ` +
          `or from localhost to get the "${SURGE_CACHE_NAME}" cache.`,
      );
    }
    return null;
  }
  try {
    return await caches.open(SURGE_CACHE_NAME);
  } catch (err) {
    console.warn(`surgeGui: caches.open("${SURGE_CACHE_NAME}") failed — continuing uncached.`, err);
    return null;
  }
}

/**
 * Command. Deletes this module's cache.
 *
 * Exported because a 49 MB cache someone cannot find the switch for is a bad
 * citizen, and because the ONLY correct fix for a corrupt entry is to drop it.
 * Not wired to any UI here; the debug console already lists it by name.
 *
 * @returns {Promise<boolean>} True if a cache was actually deleted.
 */
export async function clearSurgeCache() {
  if (typeof caches === "undefined" || !caches?.delete) return false;
  return caches.delete(SURGE_CACHE_NAME);
}

/**
 * Query. Drains a Response, reporting progress as the bytes arrive.
 *
 * `response.arrayBuffer()` cannot report progress, and 30 MB with nothing on
 * screen reads as a hang, so the body is read a chunk at a time instead. Falls
 * back to `arrayBuffer()` where streams are unavailable — the download still
 * works, it just cannot be shown as a bar.
 *
 * @param {Response} response
 * @param {(loaded: number, total: number) => void} [onChunk] `total` is 0 when
 *        the server declares no Content-Length.
 * @returns {Promise<Uint8Array>}
 */
async function readWithProgress(response, onChunk) {
  const total = Number(response.headers.get("Content-Length")) || 0;
  if (!onChunk || !response.body?.getReader) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onChunk(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Query. Bytes for a URL, from SURGE_CACHE_NAME if they are there and from the
 * network (into that cache) if they are not.
 *
 * The cached copy is a Response THIS MODULE BUILDS from the drained bytes rather
 * than a `res.clone()`, for one measured reason: cloning holds the whole 30 MB
 * body a second time while both branches are consumed, and the buffer we already
 * have is the same bytes. A `cache.put` that fails (quota) is reported and
 * ignored — a cache is an optimisation, and a full disk must not break a
 * download that already succeeded.
 *
 * @param {string} url
 * @param {(p: {loaded: number, total: number, cached: boolean}) => void} [onChunk]
 * @returns {Promise<Uint8Array>}
 * @throws {Error} With `remoteFailureSentence` on any network or HTTP failure.
 */
async function cachedBytes(url, onChunk) {
  const cache = await openSurgeCache();
  if (cache) {
    let hit = null;
    try {
      hit = await cache.match(url);
    } catch (err) {
      console.warn(`surgeGui: cache.match(${url}) failed — refetching.`, err);
    }
    if (hit) {
      return readWithProgress(hit, (loaded, total) => onChunk?.({ loaded, total, cached: true }));
    }
  }

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(remoteFailureSentence(url, err?.message || String(err)), { cause: err });
  }
  if (!res.ok) throw new Error(remoteFailureSentence(url, `HTTP ${res.status} ${res.statusText}`));

  const bytes = await readWithProgress(res, (loaded, total) =>
    onChunk?.({ loaded, total, cached: false }),
  );
  if (cache) {
    try {
      await cache.put(url, new Response(bytes, { headers: { "content-length": String(bytes.length) } }));
    } catch (err) {
      console.warn(
        `surgeGui: could not cache ${url} (${bytes.length} bytes) — it will be ` +
          `re-downloaded next time. Usually a storage quota limit.`,
        err,
      );
    }
  }
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FILESYSTEM MOUNT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Command. Creates `dir` and nothing else — its parent must already exist.
 *
 * Existence is TESTED, never mkdir-and-catch: see the MEMFS note in the header
 * for why a catch here would swallow real errors in a release build.
 *
 * @param {object} FS The Emscripten filesystem.
 * @param {string} dir Absolute directory path.
 */
function makeDir(FS, dir) {
  if (FS.analyzePath(dir).exists) return;
  FS.mkdir(dir);
}

/**
 * Command. Writes the archive into an Emscripten filesystem under `root`.
 *
 * @param {object} FS The module's FS object.
 * @param {Array<{p: string, o: number, n: number}>} files The index.
 * @param {Uint8Array} bytes The packed blob.
 * @param {string} [root] Mount point.
 * @param {(written: number, total: number) => void} [onFile] Progress, per file.
 * @returns {number} How many files were written.
 */
function unpackInto(FS, files, bytes, root = SURGE_DATA_ROOT, onFile) {
  makeDir(FS, root);
  for (const dir of directoriesFor(files)) makeDir(FS, `${root}/${dir}`);
  let i = 0;
  for (const f of files) {
    FS.writeFile(`${root}/${f.p}`, bytes.subarray(f.o, f.o + f.n));
    i += 1;
    // Reporting every file would be 842 layout-invalidating state writes; every
    // 64th is smooth at any frame rate and costs nothing.
    if (onFile && (i % 64 === 0 || i === files.length)) onFile(i, files.length);
  }
  return files.length;
}

/**
 * Command. Writes ONE file that arrived after the mount (an on-demand patch),
 * creating its parent directories.
 *
 * @param {object} FS The module's FS object.
 * @param {string} archivePath Path relative to the root.
 * @param {Uint8Array} bytes
 * @param {string} [root] Mount point.
 */
function writeFileInto(FS, archivePath, bytes, root = SURGE_DATA_ROOT) {
  const parts = archivePath.split("/");
  parts.pop(); // the filename
  let acc = root;
  makeDir(FS, acc);
  for (const part of parts) {
    acc += `/${part}`;
    makeDir(FS, acc);
  }
  FS.writeFile(`${root}/${archivePath}`, bytes);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE MODULE — memoized; one Surge for the life of the page.
// ─────────────────────────────────────────────────────────────────────────────

/** The in-flight or settled boot. Cleared on rejection so a retry retries. */
let surgeModulePromise = null;
/** The one attached session, or null. Guards against two canvases, one editor. */
let attachedSession = null;

/**
 * Query. Reports progress without letting a caller's throw abort the boot.
 *
 * A progress callback is decoration; a decoration that can kill a 49 MB download
 * is worse than no decoration.
 *
 * @param {Function|undefined} onProgress
 * @param {object} payload
 */
function report(onProgress, payload) {
  try {
    onProgress?.(payload);
  } catch (err) {
    console.warn("surgeGui: an onProgress handler threw; ignoring it.", err);
  }
}

/**
 * Query. The booted, mounted, initialised Surge module — building it exactly once.
 *
 * Performs steps 1–6 of the init order in the header. Everything canvas-shaped
 * (7–8) belongs to a SESSION, because a canvas comes and goes with the modal
 * while this does not.
 *
 * @param {(p: object) => void} [onProgress] Phase reports; see the module header
 *        of SurgeGuiModal for how they are rendered.
 * @returns {Promise<object>} `{M, sg, paramCount, paramPtr, patches, remotePaths}`.
 */
function ensureSurgeModule(onProgress) {
  if (surgeModulePromise) {
    // A second opener still deserves to see where the first one has got to; it
    // just cannot start a second boot.
    report(onProgress, { phase: "joining", loaded: 0, total: 0 });
    return surgeModulePromise;
  }
  surgeModulePromise = bootSurgeModule(onProgress).catch((err) => {
    surgeModulePromise = null; // a failed boot must not be remembered as the boot
    throw err;
  });
  return surgeModulePromise;
}

/**
 * Query. Builds the Surge module. Call through `ensureSurgeModule` only.
 *
 * @param {(p: object) => void} [onProgress]
 * @returns {Promise<object>}
 */
async function bootSurgeModule(onProgress) {
  report(onProgress, { phase: "glue", loaded: 0, total: 0 });

  // 1 — CREATE THE MODULE. Dynamic import so 108 KB of Emscripten glue is not in
  // the boot bundle of an app most of whose users never open this dialog.
  const { default: createSurgeGui } = await import("../vendor/websurge/js/surge-gui.js");

  // THE WASM BYTES COME FROM US, NOT FROM THE GLUE. `locateFile` is the documented
  // way to point the glue at the remote .wasm and it is still supplied (so a build
  // that somehow bypasses `wasmBinary` still finds the file rather than 404ing on a
  // relative path) — but the glue would then `fetch` it ITSELF, and a fetch this
  // module does not make is a fetch this module cannot cache. There is no service
  // worker in that path by law (see the header), so passing the bytes in is the
  // ONLY way the 19.8 MB download happens once. The cost is losing
  // `instantiateStreaming`'s compile-while-downloading; the benefit is not paying
  // for the download at all after the first time.
  //
  // EXPECT ONE BUILD WARNING FROM THIS, AND DO NOT "FIX" IT. The glue's
  // `findWasmBinary()` ends in `new URL("surge-gui.wasm", import.meta.url)`, so
  // vite prints: `new URL("surge-gui.wasm",import.meta.url) doesn't exist at build
  // time, it will remain unchanged to be resolved at runtime.` That branch is
  // UNREACHABLE here — it is the fallback for when `Module.locateFile` is absent,
  // and we always pass one — and the fetch never happens at all because
  // `wasmBinary` is already set. Vendoring a 19.8 MB .wasm next to the glue to
  // silence the warning would put the whole thing in the repo and in every build.
  report(onProgress, { phase: "wasm", loaded: 0, total: 0 });
  const wasmBytes = await cachedBytes(SURGE_GUI_WASM_URL, ({ loaded, total, cached }) =>
    report(onProgress, { phase: "wasm", loaded, total, cached }),
  );

  const M = await createSurgeGui({
    wasmBinary: wasmBytes.buffer,
    locateFile: (p) => (p.endsWith(".wasm") ? SURGE_GUI_WASM_URL : p),
  });

  // 2 — CWRAP. All 21 symbols, named exactly as the C++ exports them.
  const c = (n, r, a) => M.cwrap(n, r, a);
  const N = "number";
  const sg = {
    init: c("sgui_init", N, ["string"]),
    width: c("sgui_width", N, []),
    height: c("sgui_height", N, []),
    canvasWidth: c("sgui_canvas_width", N, []),
    canvasHeight: c("sgui_canvas_height", N, []),
    render: c("sgui_render", N, []),
    pixels: c("sgui_pixels", N, []),
    invalidate: c("sgui_invalidate", null, []),
    mouse: c("sgui_mouse", null, [N, N, N, N, N, N, N]),
    wheel: c("sgui_wheel", null, [N, N, N, N, N, N, N]),
    key: c("sgui_key", N, [N, N, N, N, N, N]),
    focus: c("sgui_focus", null, [N]),
    paramCount: c("sgui_param_count", N, []),
    readParams: c("sgui_read_params", null, [N]),
    loadPatch: c("sgui_load_patch_path", N, ["string", "string"]),
    setScale: c("sgui_set_scale", null, [N]),
    getScale: c("sgui_get_scale", N, []),
    patchCount: c("sgui_patch_count", N, []),
    wtCount: c("sgui_wt_count", N, []),
  };

  // 3 — THE ARCHIVE AND THE TWO INDEXES, in parallel. The 30 MB blob dominates,
  // so the two small JSON fetches are free alongside it.
  report(onProgress, { phase: "archive", loaded: 0, total: 0 });
  const [index, archiveBytes, remotePaths] = await Promise.all([
    fetchArchiveIndex(),
    cachedBytes(SURGE_DATA_BIN_URL, ({ loaded, total, cached }) =>
      report(onProgress, { phase: "archive", loaded, total, cached }),
    ),
    fetchRemoteIndex(),
  ]);

  // 4 — MOUNT, BEFORE INIT. The whole reason this function is ordered.
  report(onProgress, { phase: "mount", loaded: 0, total: index.files.length });
  const mounted = unpackInto(M.FS, index.files, archiveBytes, SURGE_DATA_ROOT, (w, t) =>
    report(onProgress, { phase: "mount", loaded: w, total: t }),
  );

  // 5 — INIT.
  report(onProgress, { phase: "init", loaded: 0, total: 0 });
  if (!sg.init(SURGE_DATA_ROOT)) {
    throw new Error(
      `sgui_init("${SURGE_DATA_ROOT}") returned 0 — Surge's editor was not ` +
        `created, so there is nothing to draw. ${mounted} files were mounted first.`,
    );
  }

  // 6 — SURGE'S OWN VIEW OF ITS LIBRARY. Ours saying 639 proves nothing; if this
  // is zero, Surge's browser and jog buttons are dead behind a GUI that looks fine.
  const found = sg.patchCount();
  const wts = sg.wtCount();
  if (found === 0) {
    throw new Error(
      `Surge mounted ${mounted} files under ${SURGE_DATA_ROOT} but then found 0 ` +
        `patches — SurgeStorage scans for them in its constructor, so this means ` +
        `the tree was not in place before sgui_init. Its patch browser and jog ` +
        `buttons would be dead behind a GUI that otherwise looks completely normal.`,
    );
  }
  console.info(
    `surgeGui: mounted ${mounted} files; Surge found ${found} patches and ${wts} wavetables.`,
  );

  const paramCount = sg.paramCount();
  const paramPtr = M._malloc(paramCount * 4);

  return {
    M,
    sg,
    paramCount,
    paramPtr,
    patchCount: found,
    wavetableCount: wts,
    patches: buildPatchIndex(
      index.files.map((f) => f.p),
      remotePaths,
      SURGE_DATA_ROOT,
    ),
  };
}

/**
 * Query. The vendored archive index.
 *
 * Vendored rather than fetched from the remote host because it is 57 KB and it
 * is the thing that says what the 30 MB blob CONTAINS — a deploy whose index and
 * blob disagree unpacks garbage, and a vendored index at least fails at build
 * time rather than at 3 a.m.
 *
 * @returns {Promise<{files: Array<{p:string,o:number,n:number}>}>}
 */
async function fetchArchiveIndex() {
  let res;
  try {
    res = await fetch(SURGE_DATA_INDEX_URL);
  } catch (err) {
    throw new Error(
      `Surge could not read its vendored archive index (${SURGE_DATA_INDEX_URL}): ` +
        `${err?.message || err}. This file ships with PowerRP, so this is a build ` +
        `problem, not a network one.`,
      { cause: err },
    );
  }
  if (!res.ok) {
    throw new Error(
      `Surge's vendored archive index (${SURGE_DATA_INDEX_URL}) returned HTTP ` +
        `${res.status}. This file ships with PowerRP, so this is a build problem, ` +
        `not a network one.`,
    );
  }
  const index = await res.json();
  if (!index?.files?.length) {
    throw new Error(`Surge's archive index (${SURGE_DATA_INDEX_URL}) lists no files.`);
  }
  return index;
}

/**
 * Query. Archive-relative paths of every on-demand 3rd-party patch.
 *
 * The 3rd-party bank is 2,920 patches / 241 MB, which cannot go in a startup
 * download; each .fxp is fetched when it is picked. An ABSENT manifest (404)
 * yields an empty list rather than an error — the factory library is complete
 * without it — but a manifest that exists and fails to load is loud, because
 * then the selector would silently be missing 82% of its contents.
 *
 * @returns {Promise<string[]>}
 */
async function fetchRemoteIndex() {
  let res;
  try {
    res = await fetch(SURGE_REMOTE_INDEX_URL);
  } catch (err) {
    throw new Error(remoteFailureSentence(SURGE_REMOTE_INDEX_URL, err?.message || String(err)), {
      cause: err,
    });
  }
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(remoteFailureSentence(SURGE_REMOTE_INDEX_URL, `HTTP ${res.status}`));
  }
  const index = await res.json();
  return index?.files ?? [];
}

/**
 * Query. Bytes of one on-demand patch.
 *
 * Every path segment is encoded separately: patch names contain spaces, "#",
 * "&" and "+" ("808er Than 808", "A.Liv/Basses"), and a single `encodeURI` would
 * leave "#" to truncate the URL at the fragment.
 *
 * @param {string} archivePath e.g. "patches_3rdparty/A.Liv/Basses/Amen Polska.fxp".
 * @returns {Promise<Uint8Array>}
 */
async function fetchRemotePatch(archivePath) {
  const url = SURGE_REMOTE_PATCH_BASE + archivePath.split("/").map(encodeURIComponent).join("/");
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(remoteFailureSentence(url, err?.message || String(err)), { cause: err });
  }
  if (!res.ok) throw new Error(remoteFailureSentence(url, `HTTP ${res.status}`));
  return new Uint8Array(await res.arrayBuffer());
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SESSION — one canvas, one frame loop, one set of listeners.
// ─────────────────────────────────────────────────────────────────────────────

/** How many on-demand patches keep their bytes around. Each .fxp is ~25–80 KB, so
 *  128 is a few MB — enough that re-picking a patch never refetches, bounded so
 *  that browsing the whole 2,920-patch bank cannot grow to 241 MB. */
const PATCH_BYTES_CACHE_LIMIT = 128;

/**
 * Builds a live Surge GUI on `canvas`.
 *
 * Command + query: it mounts and drives the editor (command) and returns the
 * handle used to talk to it (query). Resolving means the interface is UP — the
 * wasm booted, the archive is mounted, Surge found its patches, the canvas is
 * sized and the frame loop is running. Every failure before that point REJECTS
 * with a sentence naming what went wrong, because a Surge that quietly comes up
 * empty draws a complete, responsive, entirely dead interface.
 *
 * IT TOUCHES NO AUDIO. No AudioContext, no worklet, no `synth/**` import. The
 * callbacks are the entire outward surface.
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas Where Surge's pixels go.
 * @param {string} [opts.dataRoot] Mount point inside the wasm filesystem. Changing
 *        it desynchronises this half from the audio half's tree; there is no
 *        reason to.
 * @param {(index: number, value: number) => void} [opts.onParam] ONE changed
 *        parameter, from the per-frame diff. The first frame after attach reports
 *        ALL of them (the baseline starts as NaN), which is what a freshly
 *        connected engine needs; after that only real movement is reported.
 * @param {(p: {path: string, name: string, bytes?: ArrayBuffer, readBytes: () => Uint8Array}) => void} [opts.onPatch]
 *        A patch was loaded. `bytes` is present ONLY for on-demand remote patches
 *        — an archive patch is already in both filesystems, so there is nothing to
 *        hand over. `readBytes()` is always present and works for EITHER kind, for
 *        a caller that wants to STORE the patch in the document rather than just
 *        forward it; it is lazy so the callers that do not want ~30 KB per click
 *        do not pay for it.
 * @param {(p: {phase: string, loaded: number, total: number, cached?: boolean}) => void} [opts.onProgress]
 *        Boot progress. Phases, in order: "glue", "wasm", "archive", "mount",
 *        "init", "attach", "ready" — plus "joining" when a second opener attaches
 *        to a boot already in flight, and "patch" while an on-demand .fxp downloads.
 * @param {(err: Error) => void} [opts.onError] A failure AFTER the session is
 *        live (a patch that will not load, a frame that threw). Failures BEFORE
 *        that reject the returned promise instead, so a caller never has to
 *        handle the same thing twice.
 * @param {(n: {type: "on"|"off", note: number, velocity: number}) => void} [opts.onNote]
 *        A note the on-screen piano played. ADDITIVE to the agreed seam: the
 *        session owns the held-note set (so "release the previous note before
 *        pressing the next" and "a window that loses focus releases everything"
 *        are decided in ONE place), and this is how that set's changes leave.
 * @returns {Promise<object>} The session handle — see the returned object's own
 *          members for what it does.
 * @throws {Error} If another session is already attached (Surge's editor is a
 *         singleton; two canvases would fight over one set of pixels).
 */
export async function createSurgeGuiSession({
  canvas,
  dataRoot = SURGE_DATA_ROOT,
  onParam,
  onPatch,
  onProgress,
  onError,
  onNote,
} = {}) {
  if (!canvas) throw new Error("createSurgeGuiSession: no canvas was given.");
  if (dataRoot !== SURGE_DATA_ROOT) {
    throw new Error(
      `createSurgeGuiSession: dataRoot "${dataRoot}" is not "${SURGE_DATA_ROOT}". ` +
        `The tree is mounted once, before sgui_init, and the audio half mounts the ` +
        `same paths — a second root would be an empty directory, not a second copy.`,
    );
  }
  if (attachedSession) {
    throw new Error(
      "createSurgeGuiSession: a Surge GUI session is already attached. Surge's " +
        "editor is a single C++ instance, so two canvases would fight over one set " +
        "of pixels — destroy() the open one first.",
    );
  }

  const boot = await ensureSurgeModule(onProgress);
  const { M, sg, paramCount, paramPtr } = boot;

  report(onProgress, { phase: "attach", loaded: 0, total: 0 });

  const ctx2d = canvas.getContext("2d", { alpha: false });
  if (!ctx2d) throw new Error("createSurgeGuiSession: the canvas gave no 2d context.");

  let zoom = 1;
  let retina = true;
  let scale = 1;
  let imageData = null;
  let rafId = 0;
  let destroyed = false;
  const held = new Set();
  /** archivePath → bytes, for on-demand patches. Bounded; see the constant. */
  const patchBytes = new Map();
  /** Baseline for the parameter diff. NaN so the FIRST pass reports every
   *  parameter — a newly connected engine needs the whole block, and NaN !== NaN
   *  makes that fall out of the same comparison instead of a special case. */
  const lastParams = new Float32Array(paramCount).fill(NaN);

  /**
   * Command. Applies zoom × device-pixel-ratio and resizes the canvas.
   *
   * TWO DIFFERENT SIZES ARE IN PLAY and conflating them is the classic HiDPI bug.
   * The BACKING STORE is physical pixels — what Surge actually rasterises. The CSS
   * size is logical pixels × the user's zoom, and NOT × dpr: multiplying CSS size
   * by dpr too would make a retina display SHRINK the panel instead of sharpening
   * it. The scale goes INTO the wasm (`sgui_set_scale`) rather than being a canvas
   * transform, which is the point — Surge re-rasterises its SVG skin at that
   * density, so the result is sharp rather than an upscaled bitmap.
   */
  function applyScale() {
    const dpr = retina ? window.devicePixelRatio || 1 : 1;
    scale = zoom * dpr;
    sg.setScale(scale);

    const logicalW = sg.width();
    const logicalH = sg.height();
    const physW = sg.canvasWidth();
    const physH = sg.canvasHeight();
    if (physW <= 0 || physH <= 0) {
      throw new Error(
        `Surge's editor reported a zero size (${physW}×${physH}) at scale ${scale}. ` +
          `There is nothing to draw, so this fails here rather than presenting a ` +
          `blank canvas as if it were the interface.`,
      );
    }
    canvas.width = physW;
    canvas.height = physH;
    canvas.style.width = `${Math.round(logicalW * zoom)}px`;
    canvas.style.height = `${Math.round(logicalH * zoom)}px`;
    imageData = ctx2d.createImageData(physW, physH);
    sg.invalidate();
  }

  /**
   * Command. Mirrors parameters Surge's GUI moved out to the caller.
   *
   * DIFFED, not blasted: all 766 floats every frame would be ~3 KB/frame of pure
   * noise on whatever the caller does with them (upstream posts them to an
   * AudioWorklet's message port, where that cost is real).
   */
  function syncParams() {
    if (!onParam || !paramCount) return;
    sg.readParams(paramPtr);
    const cur = M.HEAPF32.subarray(paramPtr / 4, paramPtr / 4 + paramCount);
    for (let i = 0; i < paramCount; i++) {
      if (cur[i] !== lastParams[i]) {
        lastParams[i] = cur[i];
        onParam(i, cur[i]);
      }
    }
  }

  /**
   * Command. One animation frame: repaint if dirty, then mirror parameters.
   *
   * `sgui_render()` returning 0 means the pixels did not change, so the upload is
   * skipped entirely — Surge is idle most frames and a 913×569 putImageData is
   * not free. A throw inside the loop is reported ONCE and stops the loop rather
   * than firing sixty times a second forever.
   */
  function frame() {
    if (destroyed) return;
    try {
      if (sg.render()) {
        const ptr = sg.pixels();
        const n = canvas.width * canvas.height * 4;
        imageData.data.set(M.HEAPU8.subarray(ptr, ptr + n));
        ctx2d.putImageData(imageData, 0, 0);
      }
      syncParams();
    } catch (err) {
      destroyed = true;
      onError?.(
        err instanceof Error
          ? err
          : new Error(`Surge's frame loop threw: ${err}. The interface has stopped updating.`),
      );
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  // ── INPUT ────────────────────────────────────────────────────────────────
  // TWO-STAGE MAPPING, and both stages matter. The bounding rect converts CSS
  // pixels to CANVAS pixels (they differ whenever the canvas is laid out at
  // anything but its backing size). Dividing by the render scale then converts
  // canvas pixels — which are PHYSICAL — to the LOGICAL coordinates JUCE works
  // in. Without the second stage every hit is offset by the scale factor the
  // moment zoom or HiDPI is on, which reads as "the knobs are in the wrong place".
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const s = scale || 1;
    return [
      ((e.clientX - r.left) * (canvas.width / r.width)) / s,
      ((e.clientY - r.top) * (canvas.height / r.height)) / s,
    ];
  };
  const mods = (e) => [e.shiftKey ? 1 : 0, e.ctrlKey ? 1 : 0, e.altKey ? 1 : 0];

  const onPointerDown = (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    const [x, y] = pos(e);
    // `e.buttons` (the BITMASK of what is held), never `e.button` (which button
    // caused this event) — Surge asks what state the mouse is in.
    sg.mouse(1, x, y, e.buttons, ...mods(e));
    e.preventDefault();
    canvas.focus?.();
  };
  const onPointerMove = (e) => {
    const [x, y] = pos(e);
    sg.mouse(0, x, y, e.buttons, ...mods(e));
  };
  const onPointerUp = (e) => {
    const [x, y] = pos(e);
    sg.mouse(2, x, y, e.buttons, ...mods(e));
    canvas.releasePointerCapture?.(e.pointerId);
  };
  const onWheel = (e) => {
    const [x, y] = pos(e);
    sg.wheel(x, y, e.deltaX, e.deltaY, ...mods(e));
    e.preventDefault(); // the modal must not scroll under a knob being turned
  };
  // Surge draws its OWN context menus, in its own pixels.
  const onContextMenu = (e) => e.preventDefault();

  /**
   * THE KEYBOARD IS WIRED, WITH ONE DELIBERATE HOLE.
   *
   * `sgui_key` is fully implemented in the C++ but upstream NEVER CALLS IT — their
   * `juceKeyCode()` and `keycodes.js` are complete and dead, which is why Surge's
   * in-panel text entry does not work on the WebSurge site. It works here.
   *
   * Bound to the CANVAS, not the window, so it only fires when Surge has focus,
   * and `stopPropagation` keeps every keystroke away from PowerRP's global
   * shortcut registry — a "d" typed into Surge's patch-name field must not also
   * duplicate the selected item on the slide behind the dialog.
   *
   * THE HOLE IS ESCAPE, and it is a choice, not an oversight. The shared
   * Modal handles Escape on its panel to close the dialog; if Escape were
   * swallowed here the author would have a 90vw × 90vh dialog that ignores the
   * one key everybody presses to get out of a dialog. So Escape is neither sent
   * to Surge nor stopped — it bubbles to the panel and closes the modal. The cost
   * is that Escape cannot cancel a Surge text field; the alternative was a modal
   * that traps you whenever the canvas has focus.
   *
   * `preventDefault` only when Surge says it CONSUMED the key (a non-zero
   * return), so Tab still moves focus and browser shortcuts still work when Surge
   * did not want the key.
   */
  const onKeyDown = (e) => {
    if (e.key === "Escape") return; // see above — the Modal's to handle
    e.stopPropagation();
    const consumed = sg.key(1, juceKeyCode(e), juceTextChar(e), ...mods(e));
    if (consumed) e.preventDefault();
  };
  const onKeyUp = (e) => {
    if (e.key === "Escape") return;
    e.stopPropagation();
    sg.key(0, juceKeyCode(e), juceTextChar(e), ...mods(e));
  };

  const onWindowFocus = () => sg.focus(1);
  const onWindowBlur = () => {
    sg.focus(0);
    releaseAll(); // a pointer that left the window never delivers pointerup
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("keyup", onKeyUp);
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("blur", onWindowBlur);

  /** Command. Releases every held note. The one place a stuck note is undone. */
  function releaseAll() {
    for (const note of [...held]) {
      held.delete(note);
      onNote?.({ type: "off", note, velocity: 0 });
    }
  }

  applyScale();
  sg.focus(1);
  sg.invalidate();
  rafId = requestAnimationFrame(frame);

  const session = {
    /** How many parameters Surge exposes (766 in practice). The index in
     *  `onParam` is an index into this many. */
    paramCount,
    /** How many patches SURGE found by scanning — its number, not ours. */
    patchCount: boot.patchCount,
    /** How many wavetables Surge found. */
    wavetableCount: boot.wavetableCount,
    /** The browsable index, both banks. Shape per `buildPatchIndex`. */
    patchIndex: boot.patches,

    /** Query. Surge's logical size at the current zoom, in CSS pixels. */
    size: () => ({ width: sg.width(), height: sg.height(), scale }),

    /** Command. Sets the user zoom (1 = Surge's native 913×569) and re-lays out. */
    setZoom(z) {
      zoom = z;
      applyScale();
    },
    /** Command. Turns HiDPI rasterisation on or off and re-lays out. */
    setRetina(on) {
      retina = !!on;
      applyScale();
    },
    /** Query. The current zoom and HiDPI settings, for a UI that shows them. */
    view: () => ({ zoom, retina, scale }),

    /**
     * Command. Presses a note. The session owns the held set so that "release the
     * previous note before pressing the next" (a glissando drag) and "a window
     * that loses focus releases everything" are decided in exactly one place —
     * a stuck note is the single worst failure a soft synth has.
     *
     * There is no `sgui_note*` symbol: the GUI wasm's own synthesizer is not what
     * anybody hears, so this reports the note outward and nothing else.
     */
    noteOn(note, velocity = MOUSE_VELOCITY) {
      if (!Number.isInteger(note) || note < MIDI_LOW || note > MIDI_HIGH) return;
      if (held.has(note)) return;
      held.add(note);
      onNote?.({ type: "on", note, velocity });
    },
    /** Command. Releases a note. Silent about notes that are not held. */
    noteOff(note) {
      if (!held.has(note)) return;
      held.delete(note);
      onNote?.({ type: "off", note, velocity: 0 });
    },
    /** Command. Releases everything. Panic. */
    allNotesOff: releaseAll,
    /** Query. The notes currently held, ascending. */
    heldNotes: () => [...held].sort((a, b) => a - b),

    /**
     * Command. Loads a patch, fetching it first if it is an on-demand one.
     *
     * A remote patch is written into the wasm filesystem at the SAME path an
     * archive patch would live at, so `sgui_load_patch_path` is one call either
     * way; the only asymmetry is that the caller is handed the bytes, because the
     * audio half's filesystem does not have them yet.
     *
     * @param {object} entry An element of `patchIndex`.
     * @returns {Promise<void>}
     * @throws {Error} If the fetch fails or Surge refuses the patch.
     */
    async loadPatch(entry) {
      if (!entry?.path) throw new Error("loadPatch: not a patch entry.");
      let bytes = patchBytes.get(entry.archivePath);
      if (entry.remote && !bytes) {
        report(onProgress, { phase: "patch", loaded: 0, total: 0, name: entry.name });
        bytes = await fetchRemotePatch(entry.archivePath);
        writeFileInto(M.FS, entry.archivePath, bytes, SURGE_DATA_ROOT);
        // FIFO eviction: the oldest key a Map yields is its oldest insertion.
        if (patchBytes.size >= PATCH_BYTES_CACHE_LIMIT) {
          patchBytes.delete(patchBytes.keys().next().value);
        }
        patchBytes.set(entry.archivePath, bytes);
      }
      if (!sg.loadPatch(entry.path, entry.name)) {
        throw new Error(
          `Surge refused to load "${entry.name}" from ${entry.path} ` +
            `(sgui_load_patch_path returned 0).`,
        );
      }
      sg.invalidate();
      // `bytes` goes out ONLY for a remote patch, per the agreed seam: an archive
      // patch is already in the audio half's filesystem, so there is nothing it
      // needs sent. A fresh copy of the buffer, because the cached Uint8Array is a
      // view this module keeps using and a consumer must not be able to write
      // through it.
      //
      // `readBytes` is the answer to the OTHER question a caller has, and it is
      // why this payload is not just the two fields. A caller that wants to STORE
      // the patch in the document — so a saved deck plays the same instrument on a
      // machine that has never downloaded anything — needs the bytes for EVERY
      // patch, archive ones included. Handing those out eagerly would put ~30 KB
      // through a callback on every click for the callers that do not want them,
      // so it is a lazy accessor instead: same one call for both kinds, and by
      // this point a remote patch has already been written to `path`, so there is
      // genuinely no difference to read around.
      onPatch?.({
        path: entry.path,
        name: entry.name,
        ...(entry.remote && bytes ? { bytes: bytes.slice().buffer } : {}),
        readBytes: () => session.readPatchBytes(entry.path),
      });
    },

    /**
     * Query. The raw bytes of a patch FILE, from the wasm filesystem.
     *
     * Works for either kind: an archive patch was unpacked there before
     * `sgui_init`, and a remote one is written there before it is loaded — which
     * is the whole point of both living at the same kind of path.
     *
     * @param {string} path A path in the wasm filesystem (a patch entry's `path`).
     * @returns {Uint8Array}
     * @throws {Error} If the file is not there, naming the path — a caller
     *         storing this in a document must not get an empty array and a smile.
     */
    readPatchBytes(path) {
      if (!M.FS.analyzePath(path).exists) {
        throw new Error(
          `readPatchBytes: ${path} is not in Surge's filesystem. An archive patch ` +
            `is unpacked before sgui_init and a remote one is written before it ` +
            `loads, so a path that is missing here was never loaded.`,
        );
      }
      return M.FS.readFile(path);
    },

    /**
     * Query. Every parameter's current value, as a fresh copy.
     *
     * For a caller whose engine (re)starts AFTER this session did: the diff only
     * reports movement, so a late-connecting engine would otherwise sit at its own
     * defaults until the author happened to touch each knob.
     *
     * @returns {Float32Array} `paramCount` values.
     */
    readAllParams() {
      sg.readParams(paramPtr);
      return M.HEAPF32.slice(paramPtr / 4, paramPtr / 4 + paramCount);
    },

    /** Command. Asks Surge to repaint even though nothing it tracks changed. */
    invalidate: () => sg.invalidate(),

    /**
     * Command. Detaches this session.
     *
     * Stops the loop, drops every listener, releases held notes and hands focus
     * back. It deliberately does NOT tear down the wasm module: Surge's editor is
     * a singleton that took seconds and 49 MB to build, and reopening the dialog
     * should show the patch the author left loaded rather than a fresh boot. The
     * parameter buffer is likewise the module's, not this session's.
     */
    destroy() {
      if (destroyed && attachedSession !== session) return;
      destroyed = true;
      cancelAnimationFrame(rafId);
      releaseAll();
      try {
        sg.focus(0);
      } catch {
        // The module can be in any state by now; failing to blur it must not
        // prevent the listeners below from coming off.
      }
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
      patchBytes.clear();
      if (attachedSession === session) attachedSession = null;
    },
  };

  attachedSession = session;
  report(onProgress, { phase: "ready", loaded: 0, total: 0 });
  return session;
}

/**
 * Query. Is a Surge GUI session currently attached?
 *
 * For a caller deciding whether opening the dialog will succeed, so the refusal
 * in `createSurgeGuiSession` is something a UI can avoid walking into rather than
 * only something it has to report.
 *
 * @returns {boolean}
 */
export function surgeSessionAttached() {
  return attachedSession !== null;
}

/**
 * Query. Has the Surge module already booted (so the next open is instant)?
 *
 * @returns {boolean} True once a boot has succeeded or is in flight.
 */
export function surgeModuleBooted() {
  return surgeModulePromise !== null;
}
