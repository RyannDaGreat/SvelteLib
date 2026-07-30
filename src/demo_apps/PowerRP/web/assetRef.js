/**
 * assetRef.js — the PURE grammar of an asset reference string.
 *
 * A document stores media as `"/asset/<project>/<file>"`. That string is the
 * PORTABLE form and it is what lands in doc.json, in a .zip, and in every
 * `src` keyframe — deliberately NOT a URL that resolves anywhere. Resolving it
 * is the STORAGE ADAPTER's job (web/assetStore.js): the HTTP adapter prefixes
 * the backend origin, the IndexedDB adapter mints a blob: object URL. Because a
 * document never records the resolution, the SAME deck opens identically
 * against a server, against local browser storage, or out of an archive.
 *
 * This module is DOM-free and dependency-free so both adapters, the zip
 * round-trip, and the node test suite can share one parser. Every function here
 * is pure; the percent-encoding matches the server's own
 * `urllib.parse.quote(name)` / `quote(fn)` (server/server.py list_assets), which
 * is why parsing decodes each segment exactly once.
 */

/** The one prefix an in-document asset reference starts with. Kept as a
 *  constant because the server mints it (`/asset/<project>/<file>`) and the
 *  client must never spell it differently. */
export const ASSET_REF_PREFIX = "/asset/";

/**
 * Pure function. Build the portable in-document reference for one asset.
 * Percent-encodes each segment the way the server does, so a project or file
 * with a space or a slash-unsafe character round-trips through a URL path.
 *
 * @param {string} project - project name (unencoded)
 * @param {string} file - asset basename (unencoded)
 * @returns {string} `"/asset/<project>/<file>"`
 *
 * @example assetRef("Imitations", "logo.png")   // "/asset/Imitations/logo.png"
 * @example assetRef("My Talk", "a b.png")       // "/asset/My%20Talk/a%20b.png"
 */
export function assetRef(project, file) {
  return `${ASSET_REF_PREFIX}${encodeURIComponent(project)}/${encodeURIComponent(file)}`;
}

/**
 * Pure function. Split an in-document asset reference back into its parts, or
 * null when `ref` is not one (an absolute http(s) URL, a data: URI, a bare
 * filename, a built-in asset path). Returning null rather than throwing is the
 * point: the resolution seam asks "is this mine?" of EVERY src it sees, and a
 * non-asset src is an ordinary answer, not an error.
 *
 * Only the FIRST two segments after the prefix are taken as project and file,
 * with the remainder kept in `file` — that is how the server's thumbnail paths
 * (`/asset/<project>/.thumbs/<file>/thumb.png`) stay addressable through the
 * same grammar.
 *
 * @param {string} ref - a document `src` value
 * @returns {{project: string, file: string} | null}
 *
 * @example parseAssetRef("/asset/Imitations/logo.png")   // {project: "Imitations", file: "logo.png"}
 * @example parseAssetRef("/asset/My%20Talk/a%20b.png")    // {project: "My Talk", file: "a b.png"}
 * @example parseAssetRef("/asset/Deck/.thumbs/p.pdf/t.png") // {project: "Deck", file: ".thumbs/p.pdf/t.png"}
 * @example parseAssetRef("https://example.com/a.png")     // null
 * @example parseAssetRef("data:image/png;base64,iVBO")    // null
 */
export function parseAssetRef(ref) {
  const s = String(ref ?? "");
  if (!s.startsWith(ASSET_REF_PREFIX)) return null;
  const rest = s.slice(ASSET_REF_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null; // no project, or no file after it
  const project = decodeURIComponent(rest.slice(0, slash));
  const file = rest
    .slice(slash + 1)
    .split("/")
    .map(decodeURIComponent)
    .join("/");
  if (!project || !file) return null;
  return { project, file };
}

// Extension → asset kind. ONE table, mirroring the server's asset_kind()
// classes (server/server.py IMAGE_EXTS/VIDEO_EXTS/…), because a locally stored
// asset and a server-stored one must land in the same bucket — the Asset
// Explorer's icons, the font auto-registration (#26) and the insert affordances
// all branch on `kind`.
const KIND_EXTS = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"],
  video: ["mp4", "webm", "mov", "m4v", "mkv", "avi"],
  sound: ["wav", "mp3", "ogg", "m4a", "aac", "flac"],
  pdf: ["pdf"],
  font: ["ttf", "otf", "woff", "woff2"],
  // TABULAR DATA (server.py DATA_EXTS): the numbers a chart widget plots and the
  // asset the CSV table preview opens. Missing here until 2026-07-30, which is
  // why a .csv in browser-local (static) mode showed the generic file glyph while
  // the SAME file served by the Python backend showed the table glyph.
  data: ["csv", "tsv", "json"],
};

/** The COMPOUND suffix that makes a `.js` asset a WIDGET rather than a script
 *  (core/plugin_assets.js PLUGIN_ASSET_SUFFIX, server.py's twin). Checked before
 *  the extension table because os.path.splitext / .split(".").pop() see only
 *  "js", which cannot tell a widget from any other file. Not imported from
 *  core/plugin_assets.js on purpose: this module is the DEPENDENCY-FREE grammar
 *  (its header), and the string is pinned against both twins by
 *  tests/asset_store_test.js. */
const PLUGIN_ASSET_SUFFIX = ".plugin.js";

/**
 * Pure function. Classify an asset FILENAME by extension, matching the server's
 * asset_kind() exactly. The local adapter must label an asset the same way the
 * server would, or the same file would show one icon in static mode and another
 * in server mode.
 *
 * @param {string} filename - asset basename
 * @returns {"image"|"video"|"sound"|"pdf"|"font"|"data"|"plugin"|"other"}
 *
 * @example assetKindForName("logo.PNG")        // "image"
 * @example assetKindForName("clip.mp4")        // "video"
 * @example assetKindForName("Handwriting.ttf") // "font"
 * @example assetKindForName("sales.CSV")       // "data"
 * @example assetKindForName("gear.plugin.js")  // "plugin"
 * @example assetKindForName("helper.js")       // "other"  (a bare .js is NOT a widget)
 * @example assetKindForName("notes.txt")       // "other"
 */
export function assetKindForName(filename) {
  const name = String(filename ?? "");
  if (name.toLowerCase().endsWith(PLUGIN_ASSET_SUFFIX)) return "plugin";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  for (const [kind, exts] of Object.entries(KIND_EXTS)) {
    if (exts.includes(ext)) return kind;
  }
  return "other";
}

/**
 * Pure function. A filename that does not collide with `existing` — the client
 * twin of the server's unique_asset_name(). Collisions get " 2", " 3", … before
 * the extension, so "logo.png" dropped twice becomes "logo 2.png" and the
 * de-collided name stays sortable next to its sibling.
 *
 * @param {string} filename - the wanted basename
 * @param {Iterable<string>} existing - names already taken
 * @returns {string} a name not in `existing`
 *
 * @example uniqueAssetName("logo.png", [])                       // "logo.png"
 * @example uniqueAssetName("logo.png", ["logo.png"])             // "logo 2.png"
 * @example uniqueAssetName("logo.png", ["logo.png", "logo 2.png"]) // "logo 3.png"
 * @example uniqueAssetName("README", ["README"])                 // "README 2"
 */
export function uniqueAssetName(filename, existing) {
  const taken = new Set(existing);
  if (!taken.has(filename)) return filename;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Pure function. A document as PLAIN JSON-safe data, stripped of any reactive
 * proxy wrapper.
 *
 * WHY THIS IS NECESSARY, and it is not defensive tidying: `app.doc` is a Svelte 5
 * `$state` object, i.e. a PROXY. IndexedDB stores values by the STRUCTURED CLONE
 * algorithm, and structured clone refuses a Proxy outright — the write fails with
 * `DataCloneError: #<Object> could not be cloned`. The HTTP adapter never hit
 * this because `JSON.stringify` walks a proxy happily, so the bug is specific to
 * the local adapter and appears at the very first save. (Found exactly that way
 * in the static rehearsal.)
 *
 * Round-tripping through JSON is the fix AND the right semantics: a document is
 * DEFINED as JSON (it is what doc.json holds and what a .zip carries), so
 * anything that would not survive serialization has no business being persisted.
 *
 * @param {object} doc - a document, possibly a $state proxy
 * @returns {object} a plain deep copy
 *
 * @example
 * >>> plainDoc({meta: {name: "Deck"}, slides: []})
 * {meta: {name: "Deck"}, slides: []}
 * >>> plainDoc($state({meta: {name: "Deck"}}))   // a Svelte proxy
 * {meta: {name: "Deck"}}                          // plain; structured-cloneable
 */
export function plainDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}

/**
 * Pure function. Human text for a storage-quota reading — the Asset Explorer's
 * always-visible line. Lives HERE, in the DOM-free module, so it is testable in
 * bare node. `format` is the byte formatter (web/fileSize.js
 * humanReadableFileSize), passed in rather than imported so this stays
 * dependency-free and ONE formatter rules the whole UI.
 *
 * Returns null when nothing should render — which is the HTTP-mode case, per the
 * user ruling "in HTTP mode show nothing": a server has no per-browser quota, so
 * there is no figure to be near.
 *
 * @param {{supported: boolean, usage?: number, quota?: number, error?: string}} q - a quota() reading
 * @param {(bytes: number) => string} format - byte formatter
 * @returns {string|null} the line, or null to render nothing
 *
 * @example
 * >>> quotaLine({supported: true, usage: 4823129, quota: 2147483648}, humanReadableFileSize)
 * "4.6MB of 2GB used"
 * >>> quotaLine({supported: false, reason: "server-backed storage has no per-browser quota"}, f)
 * null
 * >>> quotaLine({supported: false, error: "navigator.storage.estimate is unavailable"}, f)
 * "storage estimate unavailable"
 */
export function quotaLine(q, format) {
  if (!q) return null;
  if (!q.supported) return q.error ? "storage estimate unavailable" : null;
  return `${format(q.usage)} of ${format(q.quota)} used`;
}

/**
 * Pure function. The Asset Explorer's LIBRARY TOTALS line — "12 assets · 187MB".
 *
 * A SIBLING OF quotaLine, NOT A DUPLICATE, and the distinction is the reason both
 * exist: quotaLine reports the BROWSER's budget for this origin, which only the
 * local (IndexedDB) adapter has, so it is null in HTTP mode. This line reports what
 * is IN THE PROJECT — a figure that is equally true in both modes and is the number a
 * user actually asked for. So it renders in HTTP mode too, where quotaLine shows
 * nothing at all.
 *
 * `format` is injected for quotaLine's reason: ONE byte formatter
 * (web/fileSize.js humanReadableFileSize) rules the whole UI, and this module stays
 * DOM-free and dependency-free so it is testable in bare node. Raw byte counts must
 * never reach the UI.
 *
 * BUILT-INS ARE EXCLUDED WHEN THEY ARE HIDDEN, which is what makes the total honest
 * rather than merely consistent. The built-in widget library ships inside the app
 * bundle: it costs the user no storage, it is identical in every project, and it
 * cannot be deleted. Counting it while the "Show built-in assets" toggle is off
 * would report assets the user cannot see; counting it while the toggle is ON is
 * right, because then the number describes the list actually on screen. Hence the
 * rule is "the totals describe the VISIBLE list", implemented by the caller passing
 * the same filtered array it renders — not by a flag this function interprets.
 *
 * A SIZELESS ASSET CONTRIBUTES 0 rather than NaN. A built-in library entry has no
 * `size` (it is bundle text, never a stored file), and one `undefined` in a sum
 * would turn the whole line into "NaN" — a formatting failure that hides the count
 * too. The count is still exact; only the byte figure omits what it cannot know.
 *
 * @param {Array<{size?: number}>} assets - the assets being listed (already filtered to what is VISIBLE)
 * @param {(bytes: number) => string} format - byte formatter (humanReadableFileSize)
 * @returns {string|null} the line, or null for an empty list (nothing to total)
 *
 * @example
 * >>> libraryTotalsLine([{size: 1024}, {size: 2048}], humanReadableFileSize)
 * "2 assets · 3KB"
 * >>> libraryTotalsLine([{size: 10000000}], humanReadableFileSize)
 * "1 asset · 9.5MB"
 * >>> libraryTotalsLine([], humanReadableFileSize)
 * null
 * >>> libraryTotalsLine([{size: 1024}, {name: "donut.plugin.js"}], humanReadableFileSize)
 * "2 assets · 1KB"
 */
export function libraryTotalsLine(assets, format) {
  const list = assets ?? [];
  if (!list.length) return null;
  const bytes = list.reduce((sum, a) => sum + (Number.isFinite(a?.size) ? a.size : 0), 0);
  return `${list.length} ${list.length === 1 ? "asset" : "assets"} · ${format(bytes)}`;
}

/**
 * Pure function. Percent of quota used (0–100, one decimal), or null when the
 * quota is unknown/zero — the caller then shows no meter rather than dividing by
 * zero. Feeds the quota line's fill bar and the nearly-full warning threshold.
 *
 * @param {{supported: boolean, usage?: number, quota?: number}} q - a quota() reading
 * @returns {number|null}
 *
 * @example quotaPercent({supported: true, usage: 1073741824, quota: 2147483648}) // 50
 * @example quotaPercent({supported: true, usage: 4823129, quota: 2147483648})    // 0.2
 * @example quotaPercent({supported: true, usage: 100, quota: 0})                 // null
 * @example quotaPercent({supported: false})                                      // null
 */
export function quotaPercent(q) {
  if (!q?.supported || !(q.quota > 0)) return null;
  return Math.round((q.usage / q.quota) * 1000) / 10;
}

/**
 * Pure function. A project name that does not collide with `existing` — the
 * client twin of the server's unique_project_name(), used by the local zip
 * import so a re-imported archive NEVER overwrites the project already open.
 *
 * @param {string} name - the wanted project name
 * @param {Iterable<string>} existing - project names already taken
 * @returns {string}
 *
 * @example uniqueProjectName("Imitations", [])              // "Imitations"
 * @example uniqueProjectName("Imitations", ["Imitations"])  // "Imitations 2"
 */
export function uniqueProjectName(name, existing) {
  const taken = new Set(existing);
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
