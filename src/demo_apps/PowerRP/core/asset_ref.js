/**
 * core/asset_ref.js — THE grammar of an asset reference string, and its
 * resolution rule. DOM-free, dependency-free, bare-node.
 *
 * ── THE GRAMMAR: TWO FORMS, BOTH FIRST-CLASS, FOREVER ────────────────────────
 *
 *   RELATIVE   `"Video_x.mp4"`, `"icons/logo.svg"`   — no leading "/". Names a
 *              file in the OWNING PROJECT's assets, whatever that project is
 *              called right now. This is what a writer mints from now on.
 *   ABSOLUTE   `"/asset/<project>/<path>"`           — leading "/". Names a file
 *              in a SPECIFICALLY NAMED project. Deliberate cross-project
 *              borrowing, and the form every pre-existing document holds.
 *
 * Anything else — `https://…`, `data:…`, `blob:…`, `builtin:…` — is NOT an asset
 * ref and passes through every function here untouched.
 *
 * WHY RELATIVE IS NOW THE DEFAULT, and why it is a bug fix rather than a taste
 * change. The absolute form BAKES A PROJECT NAME into every `src`, and nothing in
 * the system keeps that name equal to the project the document actually lives in.
 * An IMPORT mints the divergence (a zip adopted under a de-collided name carries
 * refs naming the name it had before — see web/assetLocalize.js's docblock), and
 * a RENAME used to mint it too, which is exactly the defect the relative form
 * retires: renaming now MOVES the project and RELATIVIZES its own absolute refs
 * first (app.renameProject), so a relative ref rides the move for free and an
 * absolute self-ref is gone before it can be stranded. Against a server the
 * divergence is INVISIBLE, because the server will
 * serve any project's assets to anyone. It becomes visible the moment there is no
 * server: the user dragged a RobotSim zip onto the STATIC GitHub Pages site, the
 * slides loaded and the assets imported into browser storage, and the video did not
 * render — the doc said `/asset/Untitled/Video_….mp4` and no project called
 * "Untitled" existed in that browser. A RELATIVE ref cannot fail that way: it has
 * no name to be wrong about, so it is rename-proof and import-proof by construction.
 *
 * NO MASS MIGRATION. Every existing document keeps its absolute refs and keeps
 * working — `repairedDocument` does NOT rewrite them, because churning every doc on
 * load to fix a defect that resolution already handles would be a large silent diff
 * for no gain. Resolution accepts both forms; only WRITERS changed.
 *
 * ── WHY THIS LIVES IN core/ WHILE web/assetRef.js DOES NOT ───────────────────
 * web/assetRef.js holds the STORAGE-FACING half of the ref vocabulary (kind
 * classification mirroring the server's asset_kind, de-collision mirroring
 * unique_asset_name, quota formatting) and is imported by the storage adapters. Its
 * docblock's sibling in web/assetLocalize.js records the rule those two obey: NO
 * core/ module imports from web/. That rule is exactly why the GRAMMAR had to move
 * down here — `core/derive.js` is THE resolution seam (see resolveStateAssetRefs
 * below) and a core module cannot reach up into web/. Forking the parser instead
 * would have given the two halves a second opinion about what a ref is, which is
 * precisely the class of bug web/assetLocalize.js exists to prevent. So: ONE parser,
 * defined here, RE-EXPORTED by web/assetRef.js so its existing importers are
 * unchanged.
 *
 * Every function here is pure. The percent-encoding matches the server's own
 * `urllib.parse.quote(name)` / `quote(fn)` (server/server.py list_assets), which is
 * why parsing decodes each segment exactly once.
 */

/** The one prefix an ABSOLUTE in-document asset reference starts with. Kept as a
 *  constant because the server mints it (`/asset/<project>/<file>`) and the
 *  client must never spell it differently. */
export const ASSET_REF_PREFIX = "/asset/";

/** The src schemes that are NOT asset refs and must survive resolution
 *  byte-identically: a remote URL, an inline payload, an object URL, and the
 *  built-in widget library's own scheme (web/builtinAssets.js BUILTIN_URL_PREFIX).
 *  Listed once here because the predicates below must agree on the answer. */
const NON_ASSET_SCHEMES = ["http://", "https://", "data:", "blob:", "builtin:", "//"];

/**
 * Pure function. Build the ABSOLUTE in-document reference for one asset.
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
 * Pure function. `assetRef`'s SIBLING for a file part that may be a nested PATH:
 * each "/"-separated segment is encoded on its own, so the separators survive.
 *
 * WHY BOTH EXIST, since one wrapping the other would be tidier and wrong.
 * `assetRef` takes a BASENAME from an asset listing and encodes it as ONE segment
 * — that is correct and load-bearing, because encoding it whole is what makes the
 * server's `.thumbs/<file>/thumb.png` paths addressable through the same minting
 * call. `assetRefPath` takes a RELATIVE REF the author wrote, where
 * "icons/logo.svg" means a folder and a file. Feeding that to `assetRef` yields
 * "icons%2Flogo.svg" — a single segment naming a file that does not exist — which
 * is exactly the silent-miss class this module guards against (web/assetLocalize.js's
 * `refMap` docblock records the same trap from the other direction).
 *
 * @param {string} project - project name (unencoded)
 * @param {string} path - a "/"-separated relative path (unencoded segments)
 * @returns {string} `"/asset/<project>/<path>"`
 *
 * @example assetRefPath("RobotSim", "clip.mp4")       // "/asset/RobotSim/clip.mp4"
 * @example assetRefPath("RobotSim", "icons/logo.svg") // "/asset/RobotSim/icons/logo.svg"
 * @example assetRefPath("My Talk", "a b.png")         // "/asset/My%20Talk/a%20b.png"
 */
export function assetRefPath(project, path) {
  const encoded = String(path).split("/").map(encodeURIComponent).join("/");
  return `${ASSET_REF_PREFIX}${encodeURIComponent(project)}/${encoded}`;
}

/**
 * Pure function. Split an ABSOLUTE in-document asset reference back into its
 * parts, or null when `ref` is not one (a RELATIVE ref, an absolute http(s) URL,
 * a data: URI, a built-in asset path). Returning null rather than throwing is the
 * point: the resolution seam asks "is this an absolute ref?" of EVERY src it sees,
 * and a non-ref src is an ordinary answer, not an error.
 *
 * Only the FIRST segment after the prefix is taken as the project, with the whole
 * remainder kept in `file` — that is how the server's thumbnail paths
 * (`/asset/<project>/.thumbs/<file>/thumb.png`) and an author's nested folders
 * stay addressable through the same grammar.
 *
 * @param {string} ref - a document `src` value
 * @returns {{project: string, file: string} | null}
 *
 * @example parseAssetRef("/asset/Imitations/logo.png")   // {project: "Imitations", file: "logo.png"}
 * @example parseAssetRef("/asset/My%20Talk/a%20b.png")    // {project: "My Talk", file: "a b.png"}
 * @example parseAssetRef("/asset/Deck/.thumbs/p.pdf/t.png") // {project: "Deck", file: ".thumbs/p.pdf/t.png"}
 * @example parseAssetRef("clip.mp4")                      // null  (relative: no project to read)
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

/**
 * Pure function. True when `ref` is a RELATIVE asset ref — a project-relative
 * path with no leading "/" and no scheme, e.g. "clip.mp4" or "icons/logo.svg".
 *
 * This is the FIRST question the resolution seam asks, and it must be answerable
 * without knowing any project, which is why it is a grammar question rather than a
 * storage one. An empty string is NOT a ref (it is a widget with nothing authored
 * yet — the GHOST state that grants the editor's "pick a file" affordance), and a
 * path under "/" is the absolute form's business, not this one's.
 *
 * @param {*} ref - a document `src` value
 * @returns {boolean}
 *
 * @example isRelativeAssetRef("clip.mp4")             // true
 * @example isRelativeAssetRef("icons/logo.svg")       // true
 * @example isRelativeAssetRef("/asset/Deck/clip.mp4") // false  (absolute)
 * @example isRelativeAssetRef("https://x.com/a.png")  // false  (a remote URL)
 * @example isRelativeAssetRef("data:image/png;base64,iVBO") // false
 * @example isRelativeAssetRef("builtin:library/clock_analog.plugin.js") // false
 * @example isRelativeAssetRef("")                     // false  (nothing authored)
 */
export function isRelativeAssetRef(ref) {
  const s = String(ref ?? "");
  if (!s || s.startsWith("/")) return false;
  return !NON_ASSET_SCHEMES.some((scheme) => s.toLowerCase().startsWith(scheme));
}

/**
 * Pure function. EITHER form → the ABSOLUTE form, given the project that OWNS the
 * document. This is THE resolution rule of the grammar, and the whole of it:
 *
 *   relative         → `assetRefPath(project, ref)`  (the owning project's asset)
 *   already absolute → returned UNCHANGED            (cross-project borrowing stands)
 *   not a ref        → returned UNCHANGED            (http/data/blob/builtin/"")
 *
 * IDEMPOTENT BY CONSTRUCTION: resolving an already-absolute ref is identity, so a
 * value that passes through the seam twice is unharmed. That matters because the
 * seam sits on a hot path and a caller cannot always know whether an upstream
 * caller already resolved.
 *
 * LOUD ON A MISSING PROJECT, deliberately. A relative ref is MEANINGLESS without an
 * owning project, and the failure mode this whole change exists to kill is a
 * silently blank video. So a relative ref with no project throws naming the ref,
 * rather than resolving to something plausible-looking that loads nothing.
 *
 * @param {*} ref - a document `src` value (either form, or a non-ref)
 * @param {string} project - the OWNING project's name
 * @returns {*} the absolute ref, or `ref` unchanged
 *
 * @example resolveAssetRef("clip.mp4", "RobotSim")             // "/asset/RobotSim/clip.mp4"
 * @example resolveAssetRef("icons/logo.svg", "My Talk")        // "/asset/My%20Talk/icons/logo.svg"
 * @example resolveAssetRef("/asset/Shared/bg.png", "RobotSim") // "/asset/Shared/bg.png"  (absolute stands)
 * @example resolveAssetRef("https://x.com/a.png", "RobotSim")  // "https://x.com/a.png"
 * @example resolveAssetRef("", "RobotSim")                     // ""
 */
export function resolveAssetRef(ref, project) {
  if (!isRelativeAssetRef(ref)) return ref;
  if (!project)
    throw new Error(`resolveAssetRef: "${ref}" is a project-relative asset ref, but no owning project was supplied — a relative ref has no meaning without one`);
  return assetRefPath(project, String(ref));
}

/**
 * Pure function. The ABSOLUTE form → the RELATIVE form when it belongs to
 * `project`, else unchanged. The inverse of resolveAssetRef, and what every WRITER
 * runs before storing a src: an own-project asset is stored by its path alone so
 * the document survives a rename, while a genuinely foreign ref keeps its absolute
 * spelling because that is what it means.
 *
 * @param {*} ref - a document `src` value
 * @param {string} project - the OWNING project's name
 * @returns {*} the relative ref, or `ref` unchanged
 *
 * @example relativeAssetRef("/asset/RobotSim/clip.mp4", "RobotSim")   // "clip.mp4"
 * @example relativeAssetRef("/asset/My%20Talk/a%20b.png", "My Talk")  // "a b.png"
 * @example relativeAssetRef("/asset/Shared/bg.png", "RobotSim")       // "/asset/Shared/bg.png"  (foreign: kept)
 * @example relativeAssetRef("clip.mp4", "RobotSim")                   // "clip.mp4"  (already relative)
 * @example relativeAssetRef("https://x.com/a.png", "RobotSim")        // "https://x.com/a.png"
 */
export function relativeAssetRef(ref, project) {
  const parsed = parseAssetRef(ref);
  if (!parsed || parsed.project !== project) return ref;
  return parsed.file;
}

/**
 * Pure function. ONE item's state with every RELATIVE asset ref resolved against
 * `project`. Returns the SAME OBJECT when nothing needed resolving, which is not a
 * micro-optimization but a contract: `core/derive.js` uses object identity to mean
 * "unchanged" (`unsignedState` does the same for the flip), the evaluation memo is
 * keyed on state identity, and a fresh copy per frame for the overwhelmingly common
 * all-absolute document would defeat both.
 *
 * ONLY TOP-LEVEL STRING PROPERTIES ARE CONSIDERED, and that bound is deliberate.
 * A ref lives in a widget's own property slot (`src`, `svgUrl`, a plugin asset's
 * declared property); the nested structures below an item are lists of numbers,
 * paint stacks and rich-text runs, where a bare filename-shaped string is far more
 * likely to be a LABEL than a ref. Resolving those would rewrite a user's text.
 * The FILMSTRIP's per-frame list is the one nested case that carries real refs, and
 * it is handled by the plugin declaring `assetRefProps` (see below) rather than by
 * guessing. This is the mirror image of web/assetLocalize.js's blind walk, and the
 * asymmetry is correct: THAT walk only recognizes the unambiguous ABSOLUTE form, so
 * it can afford to look everywhere; a RELATIVE ref is just a string, so it must be
 * resolved only where a schema says one belongs.
 *
 * WHICH PROPERTIES HOLD REFS comes from the plugin, never from a hard-coded key
 * list: `plugin.assetRefProps` (an array of property names) when it declares one,
 * else the property rows whose `kind` is "asset". A curated central list would be
 * wrong the day someone adds a widget, silently and in the direction that loses the
 * picture.
 *
 * @param {object} state - one item's folded+evaluated state
 * @param {string[]} refProps - the property names that hold asset refs
 * @param {string|function} project - the OWNING project's name, OR a
 *   `(ref) => url` resolver (see refResolver)
 * @returns {object} the state, resolved (the SAME object when nothing changed)
 *
 * @example
 * >>> resolveStateAssetRefs({type: "video", src: "clip.mp4"}, ["src"], "RobotSim")
 * {type: "video", src: "/asset/RobotSim/clip.mp4"}
 * >>> resolveStateAssetRefs({type: "video", src: "/asset/Shared/b.mp4"}, ["src"], "RobotSim")
 * {type: "video", src: "/asset/Shared/b.mp4"}    // absolute stands, SAME object
 * >>> resolveStateAssetRefs({type: "rect", w: 10}, [], "RobotSim")
 * {type: "rect", w: 10}                          // SAME object: nothing to resolve
 * >>> resolveStateAssetRefs({type: "video", src: "clip.mp4"}, ["src"], () => "blob:x")
 * {type: "video", src: "blob:x"}                 // a RESOLVER gets the last word
 * >>> resolveStateAssetRefs({type: "video", src: "/asset/D/b.mp4"}, ["src"], () => "blob:x")
 * {type: "video", src: "blob:x"}                 // …on the ABSOLUTE form too
 */
export function resolveStateAssetRefs(state, refProps, project) {
  const resolve = refResolver(project);
  let out = state;
  for (const key of refProps) {
    const value = state[key];
    // A REAL RESOLVER sees BOTH ref forms; the plain-grammar default only ever
    // rewrites the RELATIVE one (an absolute ref is already its own answer under
    // a server). That asymmetry is the whole static-mode fix: in a browser-local
    // deck an own-project ABSOLUTE ref — every document written before the
    // relative grammar, and half of the user's real RobotSim deck — must ALSO
    // become a blob: URL, because no server will ever answer "/asset/…".
    //
    // THE GUARD KEYS ON THE RESOLVER, NOT ON THIS FUNCTION'S ARGUMENT SHAPE, and
    // that distinction is the entire bug this line was written to fix and got
    // wrong on the first pass. Asking `typeof project === "function"` describes
    // how THIS call was spelled, but every one of the six production callers
    // spells it with a project NAME (`app.projectName()`) and gets its resolver
    // from the installed hook — so the narrow branch ran, an absolute ref was
    // skipped before the static resolver was ever consulted, and the canvas kept
    // the dead "/asset/…" path that the browser reports as "MediaError code 4:
    // Format error". `refResolver` is the one thing that knows whether a real
    // resolver is in play, so it answers the question.
    if (resolve.resolvesAbsolute ? !isAssetRef(value) : !isRelativeAssetRef(value)) continue;
    const resolved = resolve(value);
    if (resolved === value) continue; // resolver declined: keep node identity
    if (out === state) out = { ...state };
    out[key] = resolved;
  }
  return out;
}

/**
 * Pure function. True when `ref` is an asset reference in EITHER form — the
 * question a mode-aware resolver asks, as opposed to `isRelativeAssetRef`'s
 * narrower one. A non-ref src (http/data/blob/builtin/"") is false, so a
 * resolver never sees a URL that is already an answer.
 *
 * @param {*} ref - a document `src` value
 * @returns {boolean}
 *
 * @example isAssetRef("clip.mp4")               // true   (relative)
 * @example isAssetRef("/asset/Deck/clip.mp4")   // true   (absolute)
 * @example isAssetRef("blob:http://x/1234")     // false  (already resolved)
 * @example isAssetRef("https://x.com/a.png")    // false
 * @example isAssetRef("")                       // false  (nothing authored)
 */
export function isAssetRef(ref) {
  return isRelativeAssetRef(ref) || parseAssetRef(ref) !== null;
}

/**
 * Pure function. THE normalizer for the `project | resolver` argument that
 * `deriveRenderTree` and `resolveStateAssetRefs` both take: a string becomes
 * `(ref) => resolveAssetRef(ref, project)`, a function is returned as-is.
 *
 * ONE FUNCTION, TWO SHAPES, so the string form stays the DEFAULT and stays
 * EXACTLY what it always was. That equivalence is not a convenience — it is what
 * makes the generalization provably non-breaking for cli/render.js and every
 * bare-node caller, and it is pinned by a test rather than asserted here.
 *
 * @param {string|function} project - the owning project's name, or a resolver
 * @returns {function} `(ref) => url`
 *
 * ── `resolvesAbsolute`: WHICH REF FORMS THE RESULT WANTS TO SEE ──────────────
 * The returned function carries this flag, and `resolveStateAssetRefs` reads it
 * to decide whether an ABSOLUTE ref is also its business. It is true for a REAL
 * resolver (an explicit function, or one from the installed hook) and false for
 * the plain-grammar default, whose answer for an absolute ref is that ref itself.
 * The flag exists because the caller cannot tell the two apart: every production
 * caller passes a project NAME, so branching on the argument's type answers a
 * different question than the one being asked (see resolveStateAssetRefs).
 *
 * @param {string|function} project - the owning project's name, or a resolver
 * @returns {function} `(ref) => url`, tagged with `resolvesAbsolute`
 *
 * @example refResolver("RobotSim")("clip.mp4")        // "/asset/RobotSim/clip.mp4"
 * @example refResolver("RobotSim").resolvesAbsolute   // false (plain grammar)
 * @example refResolver((r) => `blob:${r}`)("clip.mp4") // "blob:clip.mp4"
 * @example refResolver((r) => r).resolvesAbsolute      // true  (a real resolver)
 */
export function refResolver(project) {
  if (typeof project === "function") return tagResolver(project, true);
  if (projectNameResolver) return tagResolver(projectNameResolver(project), true);
  return tagResolver((ref) => resolveAssetRef(ref, project), false);
}

/** Pure function. Tag a resolver with the ref forms it wants (see refResolver).
 *  Assigns rather than wraps so an already-correct tag costs nothing and a
 *  resolver stays the identical function object across calls.
 *
 *  @example tagResolver((r) => r, true).resolvesAbsolute  // true */
function tagResolver(fn, resolvesAbsolute) {
  if (fn.resolvesAbsolute !== resolvesAbsolute) fn.resolvesAbsolute = resolvesAbsolute;
  return fn;
}

/** The installed PROJECT-NAME resolver factory (`(project) => (ref) => url`), or
 *  null for the plain grammar default. See setProjectNameResolver. */
let projectNameResolver = null;

/**
 * Command (mutates this module's resolver hook). Install THE resolver that a bare
 * PROJECT-NAME argument means, process-wide. Injected, never imported, so core/
 * stays DOM-free and bare node keeps the pure-grammar default.
 *
 * WHY A HOOK AND NOT JUST THE EXPLICIT ARGUMENT. Threading a resolver through
 * `deriveRenderTree`'s third argument only fixes the callers that thread it, and a
 * survey found SIX production call sites that pass the bare project NAME and never
 * touch web/cameraFrame.js: `web/app.svelte.js` nodes() (which feeds the editor
 * canvas), its PDF / SVG / copy-capture exporters, `web/CanvasView.svelte`'s paint
 * path, and `web/PresentMode.svelte`. That is why the measured bug SURVIVED the
 * cameraFrame threading: the canvas never ran that code. Fixing the meaning of the
 * name itself is what makes the six agree, and it keeps the invariant that a
 * document's stored ref is resolved in exactly ONE place.
 *
 * The string→resolver equivalence still holds: with nothing installed this is
 * `(ref) => resolveAssetRef(ref, project)`, byte-for-byte what it always was.
 *
 * @param {function|null} factory - `(project) => (ref) => url`, or null to restore
 *   the pure-grammar default
 *
 * @example
 * >>> setProjectNameResolver((p) => (ref) => `blob:${p}/${ref}`)
 * >>> refResolver("RobotSim")("clip.mp4")
 * "blob:RobotSim/clip.mp4"
 * >>> setProjectNameResolver(null)   // back to "/asset/RobotSim/clip.mp4"
 */
export function setProjectNameResolver(factory) {
  projectNameResolver = factory;
}

/**
 * Query (memoized per plugin object). The property names of `plugin` that hold
 * ASSET REFS — the schema question `resolveStateAssetRefs` needs answered, asked of
 * the plugin rather than of a central table (see that function's docblock for why).
 *
 * Two sources, in order:
 *   1. `plugin.assetRefProps` — an explicit declaration. The escape hatch for a
 *      widget whose ref does not sit behind an "asset" inspector row.
 *   2. the plugin's INSPECTOR rows with `kind: "asset"` — the ordinary case, which
 *      is already how a widget says "this slot names a file" (core/registry.js
 *      ROW_KINDS; `image`/`video`/`filmstrip`/`video_scrub` declare `src`, `svg`
 *      declares `svgUrl`, and a plugin ASSET declares its own).
 *
 * MEMOIZED IN A WeakMap because this runs once per NODE per derive, i.e. on the
 * drag hot path, while a plugin's inspector rows are fixed at registration. Weak so
 * a plugin asset that is unregistered (its source edited and reloaded) does not
 * pin its old object. Returns a FROZEN shared empty array for a plugin with neither
 * source, so the common no-asset widget allocates nothing at all.
 *
 * @param {object} plugin - a registered plugin
 * @returns {string[]} property names, possibly empty
 *
 * @example pluginAssetRefProps({assetRefProps: ["frames"]})                  // ["frames"]
 * @example pluginAssetRefProps({inspector: [{key: "src", kind: "asset"}]})   // ["src"]
 * @example pluginAssetRefProps({inspector: [{key: "w", kind: "number"}]})    // []
 * @example pluginAssetRefProps({})                                           // []
 */
export function pluginAssetRefProps(plugin) {
  if (!plugin || typeof plugin !== "object") return NO_ASSET_REF_PROPS;
  const cached = refPropsByPlugin.get(plugin);
  if (cached) return cached;
  const computed = computeAssetRefProps(plugin);
  refPropsByPlugin.set(plugin, computed);
  return computed;
}

/** plugin object → its asset-ref property names (pluginAssetRefProps' memo). */
const refPropsByPlugin = new WeakMap();

/** The shared empty result of pluginAssetRefProps — frozen so a caller cannot
 *  mutate the value every ref-free plugin shares. */
const NO_ASSET_REF_PROPS = Object.freeze([]);

/** Pure function. pluginAssetRefProps' uncached core (see its docs).
 *
 *  @example computeAssetRefProps({inspector: [{key: "svgUrl", kind: "asset"}]}) // ["svgUrl"] */
function computeAssetRefProps(plugin) {
  if (Array.isArray(plugin.assetRefProps)) return plugin.assetRefProps;
  const rows = plugin.inspector;
  if (!Array.isArray(rows)) return NO_ASSET_REF_PROPS;
  const keys = rows.filter((r) => r?.kind === "asset" && typeof r.key === "string").map((r) => r.key);
  return keys.length ? Object.freeze(keys) : NO_ASSET_REF_PROPS;
}
