/**
 * PowerRPApp — the headless application state (Svelte 5 runes class, same
 * pattern as src/lib/player.svelte.js). Owns the document + undo log +
 * selection + registries, and is the `app` facade that ALL commands receive:
 * palette entries, keyboard shortcuts, toolbar buttons, and (future) context
 * menus are different surfacings of the ONE command registry.
 */

import {
  newDocument, foldState, keyframed, unkeyframed, hasKeyframe, keyframeIndices,
  uuid, clonedItemStates,
  withNewItem, withItemPurged, withNewSlide, withSlideDeleted,
  withSlideToggled, withSlideRenamed, withNormalizedZ, bisectedZ, blockZToExtreme, serialize, deserialize,
  repairedDocument, printRepairReports, itemFallbackName, ungroupBakeSlides,
  itemCreationSlide, itemAnimationKeyframes, lostEquationKeyframes, withItemsMadeStatic,
  itemSlideKeyframes, slideEquationKeyframes, withSlideKeyframesRemoved,
} from "../core/document.js";
import { setPath, getPath, blendApplied } from "../core/deltas.js";
// APPEARANCE-PRESERVING slide reorder + the duplicate-keyframe simplifier that
// is its counterweight (core/slide_reorder.js states the law both obey).
import { movedSlidePreservingLook, duplicateKeyframes, simplifyDuplicateKeyframes, withSlidesMovedToBoundary, slideClipboardPayload, withSlidesPasted } from "../core/slide_reorder.js";
import { unionRect } from "../core/geometry.js";
// Arrange-into-Grid (bento) layout math — DOM-free, doctested in core/grid.js.
import { gridAssign, cellCenters, effectiveRows } from "../core/grid.js";
import { resolveTransition, retypedTransition } from "../core/transitions.js";
import { deriveRenderTree, cameraRect, groupMembership, stateXYForCenterPivotWorld, nodeModifierPoints } from "../core/derive.js";
// The LIST-ELEMENT operations the HANDLE actions route through — one mechanism for
// per-element hide and purge, shared with the Inspector's list control.
import { LIST_ROW_KIND, withElementActive, withElementPurged } from "../core/lists.js";
import { evaluateState, withVariableRenamed, withItemVariableRenamed, anchorRefName, materialParamDefaultAt } from "../core/expressions.js";
// "Which of these stored leaves hold an = equation" — ONE expression, four
// consumers (web/canvas/equationBinding.js's header names them all). This file's
// is beginTextEdit's refusal.
import { equationBoundKeys } from "./canvas/equationBinding.js";
// `compiledScriptExports` is core/project_script.js's `projectScriptExports`,
// renamed at the import so it cannot be confused with the same-named method below
// (which resolves the source and delegates here). Two identical names in one file,
// one shadowing the other inside every method body, is a reader trap even though
// JS resolves it correctly.
import { projectScriptProblem, projectScriptExports as compiledScriptExports } from "../core/project_script.js";
import { dedupeGroupSelection, expandGroupSelection, selectParentGroups } from "../core/bandselect.js";
import { retypeChoices, retypeEligible, retypedItem } from "../core/retype.js";
import { shatterEligible, shatterNotReadyReason, shatteredDocument, shatterIds, shatterDisclosure, vectorRecovery } from "../core/shatter.js";
import { rotatedBBoxAABB, effectInclusiveAABB, fitRectView, effectiveDpr } from "../core/view.js";
// INK BOUNDS (fitSelectionToInkBounds): `T` maps a widget's local ink offset
// through its own world before it is added to the stored x/y, and `reportAction`
// says so when the command has nothing to change (a refusal of ONE user act is
// never deduped — core/report.js states why).
import * as T from "../core/transform.js";
import { reportAction } from "../core/report.js";
import { bundleDefaults } from "../core/properties.js";
import { multiSelectPanel, unifyPairs, MULTISELECT_MODE } from "../core/multiselect.js";
import { sceneIR } from "../render_gpu/ports.js";
import { renderCameraFrame, rasterizeIrPng } from "./gpuService.js";
import { copyText, imageSignature, POWERRP_CLIPBOARD_MIME } from "./clipboard.js"; // canvas-clipboard ownership marker + corroborating signature + the share-link copy
import * as projectApi from "./projectApi.js";
// THE STORAGE SEAM (web/assetStore.js). Assets and documents move through
// assetStore()/projectStore(), NOT through projectApi directly, so the same
// commands work against the Python backend OR browser-local IndexedDB (static
// mode). projectApi is still imported for the calls that are inherently
// server-only (clipboard, render jobs, ffprobe duration) — those refuse loudly
// in static mode rather than fetching a URL that cannot exist.
import { assetStore, assetStoreFor, isStatic, projectStore, refuseInStatic, storageMode, storageModeReason } from "./storageMode.js";
// localAssetStore DIRECTLY (not through the storageMode seam): a DRAFT always
// stages in the browser, in both storage modes, because the server has no folder
// for a project the user has not decided to keep. See web/projectDraft.js.
import { localAssetStore } from "./assetStore.js";
import { isOnline, onConnectivityChange } from "./connectivity.js";
import { buildProjectZip, downloadBytes } from "./projectZip.js";
// Opening a project from a URL (the "?zip=" share link and the command that
// shares its pipeline) — see web/projectUrlImport.js for the fetch rules.
import { fetchZipBytes, validatedZipUrl, zipFileNameFromUrl } from "./projectUrlImport.js";
// THE WORKING-COPY MODEL: a zip or share link opens a DRAFT, not a library
// entry. web/projectDraft.js states the invariant — read it before touching
// projectName(), which is the seam the whole model turns on.
import { DRAFT_KEY, DRAFT_STATE_KEY, UNTITLED_NAME, draftFromZipBytes, draftStateFromJson, isDraftKey, isUnsavedDraft, openNeedsConfirm, shareUrl, validProjectName } from "./projectDraft.js";
// A REPO IS A TRANSPORT, exactly as a URL is: this supplies the fetch and the
// `?repo=` share-link shape, and hands `{doc, assets}` to the SAME draft
// pipeline a zip goes through (githubProject.js's header states the invariant).
import { fetchProjectFromRepo, parseRepoSlug, shareLink as repoShareLink } from "./githubProject.js";
// The ONE grammar decision behind the single "open from…" field: is this string
// a repo slug or a URL? Pure and doctested, so the routing rule is executable in
// bare node rather than only observable through a modal.
import { projectSourceKind } from "./draftKeys.js";
// Synthesizing the in-memory archive a fetched repo becomes — a repo IS a
// differently-fetched zip, so it joins the ONE draft pipeline here.
import { strToU8, zipSync } from "fflate";
// The asset-reference grammar + the foreign-ref walk behind "Localize Foreign
// Assets" and the self-contained .zip export (web/assetLocalize.js).
import { assetRef, assetKindForFile, plainDoc, relativeAssetRef, uniqueAssetName } from "./assetRef.js";
import { documentAssetRefs, foreignAssetRefs, localizationPlan, relativizedOwnRefs, rewriteAssetRefs } from "./assetLocalize.js";
import { createRegistry, widgetForAssetKind } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { createShortcuts } from "../core/shortcuts.js";
// DRAG_KINDS = the dragKind setter's allowlist. translationPairs = THE ONE
// translation rule (a drag, a drag-all, the modal grab, a nudge — and the clone
// home's offset, which used to be its sole bypass).
import { DRAG_KINDS, MODAL_KINDS, translationPairs } from "./canvas/dragKinds.js";
import { createUndo } from "../core/undo.js";
import { registerAll, registerPlugins } from "../plugins/index.js"; // registerPlugins = types only (a project switch rebuilds the plugin registry, NOT the commands)
import { loadProjectPluginAssets, printPluginAssetReports } from "./pluginAssetLoader.js"; // widgets delivered as project assets (*.plugin.js), sandboxed by core/plugin_assets.js
import { BUILTIN_PLUGIN_ASSET_TYPES } from "../core/builtin_plugin_assets.js"; // the built-in widget library's file→type map (a dropped built-in tile resolves through it)
import { anchoredDefaults } from "./widget_handlers.js"; // THE point-placement arithmetic, shared with crosshair click placement (honours placementAnchor)
import { refreshPluginWidgetCommands } from "../plugins/builtin_asset_commands.js"; // "Plugin: <name>" palette entries — rebuilt per project (the widget set is per-project)
// The plugin-asset GRAMMAR + VALIDATOR, for the code modal's "asset" scope: the
// same loadPluginAsset the loader uses, so a source the editor accepts is exactly a
// source the loader would register (a second opinion here is how a save that the
// dialog called fine becomes an orphan purge on the next open).
import {
  PLUGIN_ASSET_SUFFIX,
  isPluginAssetName,
  loadPluginAsset,
  retypedPluginSource,
  uniquePluginAssetName,
  uniquePluginType,
} from "../core/plugin_assets.js";
import { builtinWidgetAssets } from "./builtinAssets.js";
// NO PLUGIN IMPORTS FOR MEDIA INSERTS. imagePlugin/videoPlugin used to be pulled
// in here purely so two insert methods could reach their `defaults` — which is
// what made image and video the only two kinds a drop could produce. The widget
// is looked up by the kind it CLAIMS now (core/registry.js widgetForAssetKind),
// so this file names no media widget at all and a new droppable kind adds no
// import. Registration is plugins/index.js registerAll's job, never an import here.
import { assetNaturalSize } from "./assetNaturalSize.js";
import { contentSizesFor, setContentSrcResolver } from "./contentSizes.js"; // itemId → measured intrinsic size (#277)
import { flownPose, previewScenePose } from "./sceneNav.js"; // #270: the WASDQE fly step, declared beside its pose maths
import { settledFrame } from "./settledFrame.js"; // #281: an export waits for its rasters; the editor canvas does not need to
// Telescopic-magnifier rig: the pure equation-override builders + rig constants.
// The command below spreads these over the registry defaults to mint 3 wired items.
import {
  TELESCOPIC, telescopicDefaultRects,
  telescopicSourceOverrides, telescopicLensOverrides, telescopicTangentOverrides,
} from "../plugins/tangent_lines.js";
import { browserSetting, browserNumberSetting } from "./settings.js";
import { LABEL_DIVIDER_KEYS, LABEL_FRAC_BOUNDS, LABEL_FRAC_DEFAULT, labelFracSettingKey } from "./labelFrac.js";
// THE panel inventory (core/panels.js) — one declaration behind the layout, the
// per-panel visibility settings here, and the "Toggle Visibility: …" commands.
import { PANELS, panelSettingKey } from "../core/panels.js";
// Fonts-as-asset seam (#26): register an uploaded font file as a SELECTABLE
// family (render_gpu/fonts.js dynamic registry) + load it into the browser.
import { registerFontFamily, clearDynamicFonts, fontAssetId, fontDescriptor } from "../render_gpu/fonts.js";
import { loadDynamicFont } from "./fontLoader.js";
// Asset thumbnail generalization (#25): pure tile-presentation + page-count badge.
import { assetTilePresentation, pageCountBadge } from "./assetThumbnail.js";

const AUTOSAVE_KEY = "powerrp.autosave";
const THEME_KEY = "powerrp.theme";
const BAND_MODE_KEY = "powerrp.bandMode";

// The source id a LEGACY one-item clipboard payload ({powerrp_item: state} — no
// id, from before the selection became the copy unit) is normalized under, so
// the current {sourceId: state} insert path handles it unchanged. Deliberately
// not id-shaped: uuid() ids are 8 chars, so no equation can reference it and its
// clone's own references are therefore all EXTERNAL, which is exactly right —
// the payload never said which item it came from.
const LEGACY_CLIPBOARD_SOURCE_ID = "legacy-clipboard-payload";
// THIS BROWSER's mirror of the last-copied element payload — the offline half of
// the canvas clipboard (the server-side clipboard is the cross-tab authority;
// the mirror keeps ELEMENT paste working when the backend is unreachable, so a
// dead server never downgrades a widget copy into a flattened image paste).
const CLIPBOARD_MIRROR_KEY = "powerrp.clipboardMirror";

// How far a CLONE lands from the thing it was cloned from, in world px — one
// spacing step, so the copy reads as a second object instead of hiding exactly
// behind the original (the rationale in full sits on #cloneStatesIntoSlide,
// which is the one place it is applied).
//
// MODULE-TOP AND EXPORTED because its lifetime is not one function's: BOTH clone
// entrances (paste and Duplicate) land on it, and the probes that assert where a
// copy lands need the same number. It used to be `const OFFSET = 16` inside
// #cloneStatesIntoSlide with its justification 16 lines away, and two test files
// had grown their own copies of the literal — the hand-maintained-mirror shape
// this codebase keeps getting bitten by. House precedent for a value whose
// concept crosses files is module-top-and-exported with the WHY on it
// (core/endpoints.js SHAFT_GRAB_PAD), and AUTHORING.md's rule is "name it, at a
// scope matching its lifetime".
export const CLONE_OFFSET = 16;

// What the code editor tells the author when it opens a BUILT-IN widget's source:
// the buffer is read-only (those bytes are in the app bundle, not in any project),
// and Save is a COPY-INTO-THIS-PROJECT rather than a write-back. Named here rather
// than inlined because it is asserted verbatim by the browser probe — the note is
// the whole reason the read-only dialog is not a dead end, so a silent reword should
// break a test.
const BUILTIN_PLUGIN_EDIT_NOTE = "Built-in — Save copies into this project";

// Retina/HiDPI is CAMERA-ONLY (the scene-global "Rendering" bundle on THE
// camera — core/properties.js). There is deliberately NO browser-level retina
// setting: the camera prop is the single source of truth (app.dpr() reads it).
// This default only backstops app.dpr()'s degenerate-doc path (no active
// camera); sourcing it from the shared registry keeps it from drifting from
// the Inspector's Rendering → Retina default.
const CAMERA_RETINA_DEFAULT = bundleDefaults("rendering").retina;

// THE settings repo (manifest "SETTINGS TAXONOMY"): every boolean BROWSER
// setting declared ONCE here (key + default), consumed by a $state field
// (`.initial`) + a toggle method (`.persist`) below. Adding a setting = one
// line here + a field + a toggle, never four scattered edits (cruft audit).
const SETTINGS = {
  minimap: browserSetting("powerrp.minimap", true),
  panelNames: browserSetting("powerrp.panelNames", false),
  snap: browserSetting("powerrp.snap", true),
  snapSize: browserSetting("powerrp.snapSize", true),
  grid: browserSetting("powerrp.grid", false),
  ruler: browserSetting("powerrp.ruler", false),
  showGhosts: browserSetting("powerrp.showGhosts", false),
  // R6-28 EQUATION LOCK. DEFAULT OFF, by explicit user ruling ("the protection
  // is not on by default"): with it off, grabbing an axis that moved still
  // replaces its equation with a literal, which is the established body-drag
  // rule (web/canvas/dragKinds.js translationPairs). Armed, an equation-bound
  // coordinate becomes read-only to every canvas gesture.
  equationLock: browserSetting("powerrp.equationLock", false),
  fps: browserSetting("powerrp.fps", false),
  // "Show built-in assets" in the Asset Explorer. DEFAULT OFF, per the user's
  // ruling: "maybe the asset explorer could have a toggle for built-in assets. By
  // default it's turned off". Off is the right default because the Explorer answers
  // "what is in MY project" — the built-in library is the same in every project,
  // cannot be deleted, and costs the user no storage, so listing it by default would
  // bury a two-file project under the shipped set.
  showBuiltinAssets: browserSetting("powerrp.showBuiltinAssets", false),
};

// THE label/value splits, ONE PER DIVIDER FAMILY — the user's ruling that a
// nested "variable properties" divider is "the same kind of UI, not the same
// line". Derived from LABEL_DIVIDER_KEYS rather than hand-written per family,
// exactly as PANEL_SETTINGS below is derived from PANELS: a family is one entry
// in web/labelFrac.js, not four scattered edits. The default, clamps and the key
// grammar all live in that module, because they are facts about the split rather
// than about the settings repo. Kept OUT of the SETTINGS literal above for the
// same reason PANEL_SETTINGS is — that object is hand-named settings, and this
// is a derived family.
const LABEL_FRAC_SETTINGS = Object.fromEntries(
  LABEL_DIVIDER_KEYS.map((k) => [
    k,
    browserNumberSetting(labelFracSettingKey(k), LABEL_FRAC_DEFAULT, LABEL_FRAC_BOUNDS.min, LABEL_FRAC_BOUNDS.max),
  ]),
);

// PER-PANEL VISIBILITY, one descriptor per dockable panel, keyed by panel id and
// derived from core/panels.js's PANELS rather than transcribed — a new panel gets
// its setting, its command and its pane from ONE declaration. Each panel's
// default is its own `defaultVisible` (today's layout, except Global Variables,
// which the user ruled off by default). Kept OUT of SETTINGS above because that
// object is a hand-written literal of hand-named settings, and these are a
// derived family; merging them would make `SETTINGS.slides` read like a
// hand-authored key when it is not.
const PANEL_SETTINGS = Object.fromEntries(
  PANELS.map((p) => [p.id, browserSetting(panelSettingKey(p.id), p.defaultVisible)]),
);

/** THE THEME FAMILIES — viewer preference (localStorage), NOT document state.
 *
 * USER RULING (2026-07-30, verbatim): "maybe we can make every theme have a
 * twin — a sibling — a dark/light sibling with common prefix for both. That way
 * the dark/light toggle toggles between those siblings. We can structurally
 * make sure every theme has a dark/light variant."
 *
 * So a FAMILY is the unit, not a theme: one identity, expressed at two
 * luminance poles. `dark` and `light` are theme ids, each matching a
 * `:root[data-theme="…"]` block in app.css. The toggle flips between the two
 * members of whatever family you are in and changes NOTHING else — that is the
 * bug this shape exists to make unrepresentable (the old toggle hardcoded
 * graphite⟷light, so the user reported "ember: i went to it, then toggled
 * light/dark and was no longer on ember").
 *
 * WHY A FAMILY IS DATA AND NOT A NAME PREFIX. The ruling says "common prefix",
 * and the two Futuras already had one — but a prefix is a convention a reader
 * has to parse and a test cannot enforce without re-implementing the parse.
 * Making the pairing an explicit field means `siblingTheme` is a lookup rather
 * than string surgery, and lets the enforcement test (tests/theme_contrast_test.py)
 * assert three structural facts directly: every family has BOTH poles, no family
 * has two members of the same pole, and each member's slot agrees with its
 * MEASURED --bg luminance. Titles are therefore free to not share a prefix
 * where a real pair of names reads better (Nocturne/Daybreak, not
 * "Nocturne Dark"/"Nocturne Light").
 *
 * `kind` is derived from the slot, never stored per theme: a theme's kind IS
 * which side of its family it sits on, and storing it twice is how the two
 * drift. THEMES below is the flattened view every existing consumer still
 * reads (the Monaco editor picks vs-dark/vs from `kind`). */
export const THEME_FAMILIES = [
  // ── The neutrals ────────────────────────────────────────────────────────────
  // Light was always Graphite's opposite; the pairing is a marriage, not a
  // design. Graphite was ALSO the app default until 2026-08-01 — see
  // DEFAULT_THEME, which is now Nocturne. ABSORBED: `warm` and `black`, which measured
  // 2.10 and 5.16 CIELAB from Graphite with byte-identical chroma tokens — a
  // background-warmth knob and a brightness knob, not identities.
  { id: "graphite", title: "Graphite", dark: "graphite", light: "light" },
  // Slate was Graphite-with-blue-diamonds on the same neutral surfaces. Kept as
  // its own family because the STRICT neutrality plus an all-sky-blue accent
  // system is a real thesis; its light twin is the same thesis on paper.
  { id: "slate", title: "Slate", dark: "slate", light: "slate-light" },
  // ── Editor palettes ─────────────────────────────────────────────────────────
  { id: "nord", title: "Nord", dark: "nord", light: "nord-light" },
  { id: "gruvbox", title: "Gruvbox", dark: "gruvbox", light: "gruvbox-light" },
  { id: "aurora", title: "Aurora", dark: "aurora", light: "aurora-light" },
  { id: "dracula", title: "Dracula", dark: "dracula", light: "dracula-light" },
  { id: "catppuccin", title: "Catppuccin", dark: "catppuccin", light: "catppuccin-light" },
  { id: "rosepine", title: "Rosé Pine", dark: "rosepine", light: "rosepine-light" },
  { id: "monokai", title: "Monokai", dark: "monokai", light: "monokai-light" },
  { id: "synthwave", title: "Synthwave", dark: "synthwave", light: "synthwave-light" },
  // ── Material families: identity is a MATERIAL, not a hue ────────────────────
  { id: "blueprint", title: "Blueprint", dark: "blueprint", light: "blueprint-light" },
  // Sunrise's light member is the original; its dark twin is the same horizon
  // an hour the other side of the sun. Desert ABSORBED into this family? No —
  // see its own entry: mineral flatness is a different thesis from atmosphere.
  { id: "sunrise", title: "Sunrise", dark: "sunset", light: "sunrise" },
  { id: "desert", title: "Desert", dark: "desert-night", light: "desert" },
  { id: "sepia", title: "Sepia", dark: "sepia-dark", light: "sepia" },
  // THE GLASS PAIR — one material, two times of day. Daybreak is not an
  // inversion of Nocturne (a flipped light glass washes out); it re-earns each
  // of the three glass cues for a light field. See its app.css block.
  // ABSORBED: `tokyonight`, which measured 3.56 from Nocturne with IDENTICAL
  // --a-selection and --a-keyed — it was Nocturne without the glass.
  { id: "nocturne", title: "Nocturne", dark: "nocturne", light: "daybreak" },
  { id: "futura", title: "Futura", dark: "futura-dark", light: "futura-light" },
  { id: "eink", title: "E-Ink", dark: "eink-dark", light: "eink" },
  { id: "phosphor", title: "Phosphor", dark: "phosphor", light: "phosphor-light" },
  { id: "platinum", title: "Platinum", dark: "platinum-dark", light: "platinum" },
  { id: "ember", title: "Ember", dark: "ember", light: "ember-light" },
  // ── More glass, one material lever earning three more theses ────────────────
  // Each pair below is glass by the same test Nocturne/Daybreak set: it pulls
  // --a-glass-blur/-bg/-rim together, and the rim specifically encodes a real,
  // named optical property of its material rather than a generic bright edge.
  // See each theme's own app.css block for the citation and the numbers.
  { id: "verdigris", title: "Verdigris", dark: "verdigris", light: "verdigris-light" },
  { id: "cranberry", title: "Cranberry", dark: "cranberry", light: "cranberry-light" },
  // Two independent names, like Nocturne/Daybreak: obsidian and moonstone are
  // different minerals, not one material lightened, so a "-light" suffix would
  // have claimed a kinship that isn't real.
  { id: "obsidian", title: "Obsidian", dark: "obsidian", light: "moonstone" },
];

/** Saved-preference migration for theme ids this app no longer ships.
 *
 * A culled theme's id must keep RESOLVING or a returning user boots into a
 * `data-theme` with no matching CSS block — which is not a missing theme, it is
 * the :root defaults wearing the wrong name, silently. Each entry maps a dead
 * id to the surviving theme that absorbed it; `loadTheme` rewrites the stored
 * preference through this map and REPORTS the substitution (console.warn) so a
 * migration is visible rather than mysterious.
 *
 * Every cull here was measured, not eyeballed — CIELAB distance over the three
 * surfaces plus the identity chroma (tests/scratchpad_themecluster.py), with
 * the shipped screenshots checked by eye afterwards:
 *   warm       2.10 from graphite, chroma byte-identical → a warmth knob
 *   black      5.16 from graphite, chroma byte-identical → a brightness knob
 *   tokyonight 3.56 from nocturne, --a-selection AND --a-keyed identical
 * (user ruling: "many of them have super similar colors tbh — we could group
 * them together and eliminate near-duplicates that arent super creative") */
export const THEME_ALIASES = {
  warm: "graphite",
  black: "graphite",
  tokyonight: "nocturne",
};

/**
 * THE DEFAULT THEME — what a first-run user sees, and where a saved preference
 * falls back to when this build has never shipped it.
 *
 * Nocturne, by user ruling (2026-08-01): "make Nocturne the default theme, it's
 * the best looking one we have right now." It was Graphite from the start, on
 * no stronger grounds than being first.
 *
 * IT IS A CONSTANT BECAUSE IT WAS FOUR LITERALS. The string `"graphite"`
 * appeared at the `theme` state initialiser, twice in `loadTheme` (the
 * no-saved-preference path and the unknown-id path) and once more inside that
 * path's warning text — so changing the default meant finding all four, and the
 * warning could disagree with the behaviour without anything failing. Its light
 * twin needs no entry here: `siblingTheme` reads THEME_FAMILIES, where Nocturne
 * is paired with Daybreak.
 */
export const DEFAULT_THEME = "nocturne";

/**
 * Pure function. Flattens THEME_FAMILIES into the one-entry-per-theme list the
 * app's consumers read, deriving `kind` from the slot the theme occupies.
 *
 * Args:
 *     families (Array): THEME_FAMILIES-shaped entries.
 *
 * Returns:
 *     Array<{id, kind, family, title}>: `title` is the family title for a
 *     one-member-per-pole family, so the picker can show one row per family.
 *
 * Examples:
 *     >>> flattenedThemes([{ id: "f", title: "F", dark: "f-d", light: "f-l" }])
 *     [{ id: 'f-d', kind: 'dark', family: 'f', title: 'F' },
 *      { id: 'f-l', kind: 'light', family: 'f', title: 'F' }]
 */
export function flattenedThemes(families) {
  return families.flatMap((f) => [
    { id: f.dark, kind: "dark", family: f.id, title: f.title },
    { id: f.light, kind: "light", family: f.id, title: f.title },
  ]);
}

/** The flat catalog — every theme, `kind` derived from its family slot. */
export const THEMES = flattenedThemes(THEME_FAMILIES);

/**
 * Pure function. The theme on the OTHER luminance pole of `id`'s family — what
 * the top-right toggle switches to. Returns `id` itself if it is unknown, so a
 * stale preference degrades to a no-op flip rather than throwing mid-click.
 *
 * Args:
 *     id (string): a theme id (THEMES[].id).
 *     families (Array): THEME_FAMILIES-shaped entries.
 *
 * Returns:
 *     string: the sibling's theme id.
 *
 * Examples:
 *     >>> siblingTheme("ember", THEME_FAMILIES)
 *     'ember-light'
 *     >>> siblingTheme("ember-light", THEME_FAMILIES)
 *     'ember'
 *     >>> siblingTheme("graphite", THEME_FAMILIES)
 *     'light'
 *     >>> siblingTheme("no-such-theme", THEME_FAMILIES)
 *     'no-such-theme'
 */
export function siblingTheme(id, families = THEME_FAMILIES) {
  const fam = families.find((f) => f.dark === id || f.light === id);
  if (!fam) return id;
  return fam.dark === id ? fam.light : fam.dark;
}

/**
 * Pure function. THE POLARITY LOCK: the member of `id`'s family that sits on
 * `kind`'s pole. This is the rule the hover PREVIEW selects with, and it is what
 * makes browsing themes non-destructive.
 *
 * USER RULING (2026-07-30, verbatim): "When I hover over the different themes —
 * even if I'm hovering over the menu for that theme — it should preview it. If
 * we're dark, it previews as dark; if we're light, it previews as light."
 *
 * So a preview target is a FAMILY plus the pole you are already working in,
 * never the literal entry under the cursor. Two things follow, and both are the
 * ruling's "even if":
 *   - A FAMILY row (the container) is a previewable target, because a family
 *     plus the current pole names exactly one theme.
 *   - Hovering the WRONG-pole member ("Ember — Light" while dark) still previews
 *     the dark member. Skimming a list must not strobe the app between poles;
 *     which pole you sit on is the toggle's job, and a hover is not a decision.
 * The COMMIT (`run` = setTheme) is unaffected — clicking "Ember — Light" is a
 * decision, and it applies the light member exactly as it says.
 *
 * An id outside the catalog resolves to itself: a stale preference previews as
 * the no-op it already is rather than throwing mid-hover.
 *
 * Args:
 *     id (string): any theme id, or a FAMILY id (THEME_FAMILIES[].id).
 *     kind ("dark" | "light"): the pole to stay on — the CURRENT theme's.
 *     families (Array): THEME_FAMILIES-shaped entries.
 *
 * Returns:
 *     string: the theme id to apply.
 *
 * Examples:
 *     >>> familyMemberForKind("ember-light", "dark", THEME_FAMILIES)
 *     'ember'
 *     >>> familyMemberForKind("ember", "light", THEME_FAMILIES)
 *     'ember-light'
 *     >>> familyMemberForKind("ember", "dark", THEME_FAMILIES)
 *     'ember'
 *     >>> familyMemberForKind("graphite", "light", THEME_FAMILIES)
 *     'light'
 *     >>> familyMemberForKind("no-such-theme", "light", THEME_FAMILIES)
 *     'no-such-theme'
 */
export function familyMemberForKind(id, kind, families = THEME_FAMILIES) {
  const fam = families.find((f) => f.id === id || f.dark === id || f.light === id);
  if (!fam) return id;
  return kind === "light" ? fam.light : fam.dark;
}

/**
 * Pure function. Which luminance pole a theme sits on — the one lookup every
 * kind-following consumer shares (Monaco's vs-dark/vs choice, the toolbar
 * toggle's glyph). Unknown ids read as "dark", the app's default pole.
 *
 * Args:
 *     id (string): a theme id (THEMES[].id).
 *
 * Returns:
 *     "dark" | "light"
 *
 * Examples:
 *     >>> themeKind("ember")
 *     'dark'
 *     >>> themeKind("daybreak")
 *     'light'
 *     >>> themeKind("no-such-theme")
 *     'dark'
 */
export function themeKind(id) {
  return THEMES.find((t) => t.id === id)?.kind ?? "dark";
}


export class PowerRPApp {
  doc = $state(newDocument());

  // ── SERVER SAVE STATE (the toolbar's save indicator reads exactly these) ────
  // The user asked for "an indicator on the top left ... which when I hover over
  // it tells me whether or not it's saved". Three fields, because the honest
  // answer has three cases and a single boolean would have to lie about one of
  // them: a save IN FLIGHT is neither saved nor unsaved.
  //
  // WHAT "SAVED" MEANS HERE, precisely: saved TO THE SERVER (a project folder
  // under projects/<name>/). It deliberately does NOT mean the localStorage
  // autosave in commit() below — that one is crash-safety, always on, and never
  // in doubt, so an indicator for it would be a light that is always green. The
  // thing a user can actually lose is the server copy, so that is what is
  // reported. (The manifest's rule: "a project must be saved to the server
  // explicitly"; this indicator is what makes that state visible.)
  //
  // `savedDoc` is the DOCUMENT OBJECT last written to the server, not a boolean
  // and not a hash. Documents are treated as immutable values here — commit()
  // installs a NEW object every edit — so identity comparison against the saved
  // one is an exact, cheap dirty test that needs no bookkeeping at the ~40 call
  // sites that commit. Undo back to the saved state therefore correctly reads as
  // CLEAN again, which a monotonic dirty FLAG could not express.
  savedDoc = $state(null);
  /** True while a save request is in flight (the third, transient state). */
  saving = $state(false);
  /** Epoch ms of the last successful server save, for the hover text. */
  lastSavedAt = $state(null);
  /**
   * IS THIS WORKING COPY IN THE LIBRARY AT ALL — the flag behind `isDraft()`.
   *
   * FALSE means there is no library entry for it, so there is nothing for a quick
   * Save to write INTO. It is set by the only two gestures that put a working copy
   * in correspondence with a library entry, and by NOTHING else:
   *   · `loadProject(name)` — opened FROM the library. Saved before the first write.
   *   · a successful `saveToServer` / `commitDraft` / `saveProjectAsFork` — written
   *     INTO it. Set only on SUCCESS, so a failed first save leaves a draft a draft.
   * and cleared by the two that take a working copy back OUT of correspondence:
   * `clearDoc()` (a brand-new document) and `openDraftFromZipBytes` (an import).
   *
   * DISTINCT FROM `savedDoc`, which asks a narrower question. `savedDoc` is "does
   * the library's copy MATCH what is on screen" (dirty vs clean); this is "is
   * there a library copy AT ALL". A saved project with edits has everSaved true
   * and savedDoc stale; a fresh document has neither — and only the second state
   * makes quick-Save meaningless, which is why one boolean cannot answer both.
   */
  everSaved = $state(false);
  // [ROUND 15.2] Backed by a private $state through an accessor (mirrors the
  // `selection` accessor immediately below) so that ANY slide switch (~13
  // write sites: SlideNav, KeyframePanel "Go To", jumpKeyframePath, addSlide/
  // addBlankSlide/deleteSlide/moveSlide, the palette+shortcut prev/next-slide
  // commands, loadFile/clearDoc/openProject) exits WYSIWYG text edit first —
  // a slide switch mid-edit must never strand the overlay (manifest 15.2:
  // "selection change via other UI ... must all commit ... never strand the
  // overlay"). Dismisses through the SAME dismissTextEdit() the click-away
  // and selection-change guards use, so all three share one commit/cancel
  // decision (see dismissTextEdit's doc).
  #slideIndex = $state(0);
  get slideIndex() {
    return this.#slideIndex;
  }
  set slideIndex(i) {
    this.dismissEdit();
    this.exitCanvasMode(); // a widget canvas mode is bound to an item on THIS slide
    this.#slideIndex = i;
  }
  // PRIMARY selection — a single itemId or null. Kept as the primary for full
  // single-select compatibility: selectedNode(), delete/purge/copy/rename/
  // reorder/keyframe, the Inspector's single-item UI, the KeyframePanel
  // highlight, and needsSelection/needsPurgeable all read THIS. Backed by a
  // private $state through an accessor so that ANY single-select write
  // (`app.selection = x`, of which there are ~10 sites) automatically CLEARS
  // the multi-select override below — that one coupling is what keeps the two
  // coherent with zero edits to the existing write sites (least-invasive
  // design; the manifest's multi-select is a minimal SUBSTRATE, not a rewrite).
  /** VIEW STATE: does the multi-selection panel show rows every selected item
   *  has (intersection) or rows any of them has (union)? User-facing toggle at
   *  the top of that panel. Deliberately NOT document state — it is not
   *  keyframed, not serialized, and survives no reload, because it describes how
   *  you are LOOKING at a selection, not anything about the deck. */
  multiSelectMode = $state(MULTISELECT_MODE.INTERSECTION);

  #selection = $state(null);
  get selection() {
    return this.#selection;
  }
  set selection(id) {
    // [ROUND 15.2] A selection change to a DIFFERENT item than the one being
    // edited must commit+exit text edit first (manifest: "selection change
    // via other UI (outline panel etc.) ... must all commit ... never strand
    // the overlay"). Excludes the id === textEditing.itemId case on purpose:
    // beginTextEdit() itself writes `this.selection = itemId` to select the
    // item it is about to edit, and that write must NOT immediately cancel
    // the edit it is starting.
    if (this.editingItemId !== null && id !== this.editingItemId) this.dismissEdit();
    // Same rule for a widget CANVAS MODE (web/widget_handlers.js): selecting a
    // different item leaves the mode (committing its pending gesture), so the mode
    // can never outlive the item it belongs to. The handler's own `run` writes
    // `selection = itemId` BEFORE entering, when canvasMode is still null, so this
    // never cancels the mode it is about to start.
    if (this.canvasMode !== null && id !== this.canvasMode.itemId) this.exitCanvasMode();
    this.#selection = id;
    this.selectionSet = []; // single-select write drops the multi override
    // The OUTER scope owns the INNER one: handle ids belong to whichever item was
    // selected, so any item-selection change invalidates them (see handleSelection).
    this.handleSelection = [];
    if (id !== null) this.selectedTransition = null; // item and transition selection are mutually exclusive
  }
  // MULTI-select override: the FULL set of selected itemIds (band select /
  // future multi-click). Authoritative when non-empty; its FIRST element is
  // mirrored into `selection` (the primary) so single-item consumers still
  // work. Empty → selectedIds() falls back to [selection]. Populated only by
  // selectMany(); cleared by any single-select `selection` write (see above).
  selectionSet = $state([]);
  // HANDLE SELECTION — the SECOND, INNER selection scope: which of the primary
  // selected item's MODIFIER POINTS (core/derive.nodeModifierPoints — "the PPT
  // yellow squares") are selected, as an array of modifier ids. Universal, not
  // polygon-specific: every widget that declares `modifierPoints` gets it.
  //
  // THE PRECEDENCE BETWEEN THE TWO SCOPES (the design's sharpest edge, stated once
  // here so no surface has to guess):
  //   1. ITEM selection is the OUTER scope and OWNS the inner one. Handles only
  //      exist for a single selected item (CanvasView draws them only then), so a
  //      selection change of any kind invalidates them — every write to
  //      `selection`/selectMany clears this, via clearHandleSelection().
  //   2. THE INNER SCOPE WINS A CONTESTED KEY. While handles are selected, Escape
  //      clears THEM and leaves the item selected; Backspace hides THEM, not the
  //      item. Both are enforced in core/shortcut_entries.js by `when` predicates
  //      (handlesSelected vs the item entries' exclusion of it) rather than by
  //      ordering, so exactly one meaning is ever live — and therefore exactly one
  //      chip is ever on the HintBar, which is what makes the bar honest.
  //   3. NOTHING here touches the item selection. Clearing handles never deselects
  //      the item; that would make Escape destroy two things at once.
  handleSelection = $state([]);
  // TRANSITION selection — the INCOMING slide's slideId whose between-rows
  // transition slice is selected, or null (manifest Round 12: transitions are
  // first-class SELECTABLE things whose properties show in the Property Panel).
  // MUTUALLY EXCLUSIVE with item selection: setting a transition clears the item
  // selection (via selectTransition); setting an item clears this (setter above).
  // Opus10 builds the Inspector side against selectionTarget/transitionAt.
  selectedTransition = $state(null);
  mode = $state("edit"); // "edit" | "present"
  // HOVER-PREVIEW OF A SELECTION: the itemId a picker is currently hovering, or
  // null. The canvas draws its outline in a preview skin so you can SEE which
  // object a menu row means before committing to it — the item picker lists every
  // object on every slide by name, and a name is not a location.
  //
  // A SEPARATE FIELD FROM `selection`, deliberately, and separate from
  // `previewDelta` too. Hovering must not change what is SELECTED (that would
  // fire every selection-dependent effect in the app for a mouse passing over a
  // row), and it is not a property preview either — nothing about the document
  // changes, only what the overlay draws. It is the same shape as the app's other
  // hover-preview surfaces (task #165 made hover-preview the default trope for
  // pickers) but at the SELECTION layer rather than the value layer.
  hoverItemId = $state(null);
  // HOW MANY OBJECTS SIT UNDER THE LAST SELECTING CLICK (0 when none, 1 when the
  // thing you clicked is alone there). CanvasView writes it; the HintBar reads it
  // to offer click-through, because an affordance nobody is told about does not
  // exist — the shortcut registry is this app's single source of truth for inputs
  // and it BOTH dispatches and narrates. A COUNT rather than a boolean so the chip
  // could say how deep the stack is later; the predicate only asks > 1.
  clickThroughDepth = $state(0);
  anchorsVisible = $state(false);
  paletteOpen = $state(false);
  dragging = $state(false); // canvas sets this; drives HintBar context
  // Which drag gesture is live: null, or one of DRAG_KINDS (web/canvas/
  // dragKinds.js) — drives the HintBar's per-gesture modifier hints (manifest
  // "Drag/resize modifiers": auto-announce while dragging) AND the shortcut
  // registry's per-gesture contexts.
  //
  // Backed by an accessor that THROWS on an undeclared kind, the same
  // private-$state-behind-a-setter shape #slideIndex/#selection use. WHY: the
  // hint set and the reachability prober are both DERIVED from DRAG_KIND_MODIFIERS,
  // so a kind that is assigned here but missing there gets no modifier chips and
  // is never probed — which is exactly how multi-selection resize shipped reading
  // Shift/Cmd with nothing on the bar and no test able to see it. Failing loudly
  // at the assignment makes that state unreachable: you cannot introduce a drag
  // kind without declaring it, and declaring it wires the hints and the guard.
  #dragKind = $state(null);
  get dragKind() {
    return this.#dragKind;
  }
  set dragKind(kind) {
    if (kind !== null && !DRAG_KINDS.includes(kind))
      throw new Error(`app.dragKind = ${JSON.stringify(kind)} is not a declared drag kind — add it to DRAG_KIND_MODIFIERS in web/canvas/dragKinds.js (with the held modifiers it reads) so its HintBar chips and the shortcut reachability prober cover it. Legal: null, ${DRAG_KINDS.join(", ")}.`);
    this.#dragKind = kind;
  }
  // Active Blender-style MODAL transform (G grab / S scale / R rotate + axis
  // constraints + numeric entry), or null. Shape:
  // { kind: one of MODAL_KINDS, axis: null|"x"|"y", buffer: string }. The geometry
  // (start cursor, per-member start states, collective center) is captured and
  // driven entirely in CanvasView, which owns pointer/preview; this reactive
  // record is only the shared context the shortcut registry reads (to gate
  // normal edit shortcuts off mid-transform — Blender's modal lock) and the
  // HintBar reads (to announce mode · axis · typed buffer + commit/cancel keys).
  // CanvasView is the SOLE writer: beginModalTransform sets {kind, axis:null,
  // buffer:""}; the axis/buffer commands reassign it whole so the HintBar
  // $derived invalidates. (Round-2 shape addition — flagged in the report.)
  modalXform = $state(null);
  /** Canonical region name under the pointer (Panel sets it) — the substrate
   * for region-aware hints (manifest: panels are first-class). */
  hoverRegion = $state(null);
  /** Preview overlay delta shown during drags — NOT committed/undoable. */
  previewDelta = $state(null);
  /** A revert thunk set while a TRANSIENT preview — one that must NEVER be
   *  committed, e.g. the FontPicker's hover-a-font-to-see-it preview — is staged
   *  OVER a session's real value. There is exactly ONE preview slot, and an
   *  in-place text edit already occupies it for the whole session, so a hover has
   *  nowhere else to render; without this flag a dismissal landing mid-hover
   *  (click-away is a WINDOW-capture pointerdown, which always beats a picker's
   *  own document-capture close) would commit a font the user merely pointed at.
   *  Owned by whoever staged it; see dropTransientPreview. */
  transientPreview = null;
  /** ITEM ID whose asset (video) picker should AUTO-OPEN (manifest 14.3: placing
   *  a new filmstrip immediately opens the video-picker modal). Set by the widget
   *  handlers that ASK for an asset — the "bbox_then_asset" creation gesture and the
   *  "asset_picker" double-click activation (web/widget_handlers.js); the Inspector's
   *  AssetField for that item's `src` row reads it and opens its picker, then clears
   *  it (on pick OR cancel — cancel leaves the empty ghost widget, per 14.3).
   *  null = no pending auto-open. */
  pendingVideoPickFor = $state(null);
  /** TRUE IN-PLACE RICH-TEXT EDITING. While a text box is being edited in place,
   * `textEditing` = { itemId } (null otherwise). The item keeps rendering LIVE
   * through Skia (never suppressed) — the TextEditController draws only the caret
   * + selection, sourced from the SAME CanvasKit Paragraph the render draws, so
   * they are glyph-accurate across mixed runs with no browser-layout drift. Drives:
   * the controller (self-drawn caret/selection + hidden input sink for keys/IME/
   * clipboard); the floating format toolbar; and the textEditing shortcut context
   * (Ctrl/Cmd+B/I/U + Cmd±). Selection-style edits flow through the preview/commit
   * system as ONE undo unit per logical edit, exactly like the Inspector rows. */
  textEditing = $state(null);
  /** TRUE IN-PLACE LATEX EDITING (WYSIWYG equation editor). While a latex widget
   * is edited in place, `latexEditing` = { itemId } (or { itemId, closing:true }
   * during the exit crossfade), null otherwise. UNLIKE text (which is canvas-as-
   * truth — never suppressed), a MathJax equation has NO caret model, so the edit
   * is a DOM MathLive `<math-field>` OVERLAY at the widget's world pose and the
   * canvas equation is SUPPRESSED in paint() for the duration (LatexEditController
   * owns the field). Commit re-typesets through the normal emit() → latexVector
   * path (no new IR). The MathLive(KaTeX) ↔ MathJax(tex-svg) glyph-metric
   * difference is an IRREDUCIBLE small enter/exit "pop" with this overlay approach
   * (both are Computer-Modern lineage — close, not identical); the `closing`
   * crossfade (see commitLatexEdit) masks it as much as this design allows. */
  latexEditing = $state(null);
  theme = $state(DEFAULT_THEME);
  // BROWSER settings below: each = a SETTINGS descriptor's .initial (the
  // localStorage-or-default value) and a toggle*() using .persist. See the
  // SETTINGS repo above.
  minimapVisible = $state(SETTINGS.minimap.initial);
  // Whether the Asset Explorer lists the BUILT-IN asset library alongside the
  // project's own assets. Default OFF (user ruling) — see the SETTINGS entry.
  showBuiltinAssets = $state(SETTINGS.showBuiltinAssets.initial);
  // Optionally show each panel's canonical name (Slide Navigator / Property
  // Panel / Keyframe Panel) as a title bar. OFF by default (panels are not
  // first-class — manifest Round 7).
  panelNames = $state(SETTINGS.panelNames.initial);
  // PER-PANEL VISIBILITY: {panelId: boolean}, one entry per core/panels.js PANELS
  // entry, each initialised from its own localStorage key (Global Variables off by
  // default, everything else on). ONE deep-reactive record rather than six named
  // fields: the panels are a derived family, so a field per panel would be six
  // lines that must be edited together every time a panel is added — the exact
  // four-scattered-edits defect the SETTINGS repo removed for flags.
  panelVisible = $state(Object.fromEntries(PANELS.map((p) => [p.id, PANEL_SETTINGS[p.id].initial])));
  // The label⟷value splits, {dividerKey: fraction} — one number per divider
  // FAMILY (web/labelFrac.js). The PROPERTY family is published as
  // --a-label-frac on the app root (App.svelte) so the Property and Variables
  // panels read ONE number and their columns stay in x-sync across panes (the
  // round-11 "columns line up" ruling); the VARIABLE family is re-published by
  // each nested block that belongs to it. ONE deep-reactive record rather than a
  // field per family, for the same reason panelVisible below is one: the families
  // are a derived set, so a named field each would be lines that must be edited
  // together every time one is added.
  labelFrac = $state(Object.fromEntries(LABEL_DIVIDER_KEYS.map((k) => [k, LABEL_FRAC_SETTINGS[k].initial])));
  // Master snap toggle (gates ALL snapping — move AND resize) and the
  // snap-size / matching-dimension toggle. Both default ON.
  snapEnabled = $state(SETTINGS.snap.initial);
  snapSizeEnabled = $state(SETTINGS.snapSize.initial);
  // BROWSER setting (viewer-local): the DEFAULT rubber-band mode — what a
  // "regular" (unspecified-mode) band select uses, AND what an empty-space
  // drag uses directly (manifest Round 12B "DEFAULT EMPTY-SPACE DRAG = BOX
  // SELECT" — no arming needed there). Persisted like snap. Default "inner"
  // (PowerPoint's default marquee behavior — a precedent, not invented).
  bandMode = $state(localStorage.getItem(BAND_MODE_KEY) === "outer" ? "outer" : "inner");

  // ── CROSSHAIR MODE (manifest ARCHITECTURE PLAN #5: "one mechanism, two
  // skins") ───────────────────────────────────────────────────────────────
  // ONE-SHOT arming record for a gesture that starts with full-viewport
  // infinite crosshairs following the cursor, consumed by CanvasView on the
  // NEXT pointer-down and cleared (one-shot) — or by Esc, which cancels the
  // mode with no gesture at all. null = not armed.
  //   {kind: "band", mode: "inner"|"outer"}   — band-select skin (dashed,
  //     the band-select dash style); armed by the toolbar button / palette
  //     band-select commands. The toolbar's default press resolves through
  //     bandMode (armCrosshairBand("regular")); a DIRECT empty-space drag
  //     (CanvasView onPointerDown, nothing hit) does NOT go through this
  //     arm at all — it starts the SAME "band" drag kind straight from
  //     bandMode, matching the spec's "no arming required" for that path.
  //   {kind: "place", plugin}                 — placement skin (gray,
  //     --a-ghost tone); armed by Add Box / Add Text so a widget button
  //     click-drags/clicks its rect into existence instead of spawning at
  //     defaults (manifest Round 12B "Boxes": "right now it just places a
  //     box wherever the hell it wants"). `plugin` carries the widget's
  //     `.defaults` (for default-size single-click placement) and `.type` —
  //     the ENTIRE generalization surface: any future plugin opts in by
  //     arming with itself, no CanvasView changes needed.
  crosshair = $state(null);

  // ── WIDGET CANVAS MODE (web/widget_handlers.js) ────────────────────────────
  // While a widget's ACTIVATION has taken over canvas input, `canvasMode` =
  // { handlerId, itemId } (null otherwise). The handler descriptor's `mode`
  // (looked up by handlerId) owns what drags and the wheel DO; CanvasView routes
  // the gestures; the HintBar shows that mode's own registered inputs, scoped by
  // handlerId; Escape exits. This is the SAME shape as textEditing/latexEditing/
  // codeEditing — one reactive record naming what is being edited and by what —
  // except the mode's behaviour lives in the registry instead of a dedicated
  // controller component, which is what lets a NEW kind of mode ship without
  // touching this file.
  canvasMode = $state(null);
  // Editor-only Blender-style background grid and top ruler strip. Both are
  // "options" defaulting OFF (manifest: Grid + Ruler).
  gridEnabled = $state(SETTINGS.grid.initial);
  rulerEnabled = $state(SETTINGS.ruler.initial);
  // Default OFF (manifest ARCHITECTURE PLAN #2 GHOST capability): shows/hides
  // GHOST outlines (empty text, groups) on the CanvasView SVG overlay. Crop-box
  // ghost outlines are NOT gated by this — they show ALWAYS (core/derive.
  // isGhostNode + the "always" rule: a crop box is unclickable otherwise).
  showGhosts = $state(SETTINGS.showGhosts.initial);
  // R6-28 EQUATION LOCK, default OFF. While armed, any stored coordinate holding
  // an `=` equation is READ-ONLY to canvas gestures: the drag seam pins it
  // (web/canvas/equationBinding.js equationPinning composed into
  // web/canvas/dragKinds.js geometryPairs), so a lock on `y` leaves a body drag
  // free in x alone and a lock on `h` leaves a corner handle resizing width
  // alone. CANVAS GESTURES ONLY, by user ruling — the Inspector's own fields
  // stay editable, because they already SHOW the equation they would replace.
  equationLock = $state(SETTINGS.equationLock.initial);
  // Default OFF: the bottom-left FPS counter (shows in the editor AND present
  // mode — user spec, round 11).
  fpsVisible = $state(SETTINGS.fps.initial);
  // Count of REAL rendered frames (editor viewport + presenter paints bump
  // it). Deliberately NOT $state — it changes at up to display rate and its
  // only consumer (FpsCounter) polls it from its own rAF loop; reactive
  // churn at 120Hz would be pure waste.
  renderFrameCount = 0;
  // Reactive flag CanvasView raises while any snap correction is applied in the
  // current pointer-move; cleared on pointer-up. Drives the toolbar toggle
  // taking the guide color while a snap is actually engaged.
  snapEngaged = $state(false);
  // The shortcut registry is $state so App.svelte can REBUILD it after a
  // keybinding rebind (createShortcuts has no remove — see core/keybindings.js
  // scope note) and the HintBar picks up the swap reactively.
  shortcuts = $state(null);

  // Toggles: flip the reactive field, persisting through the SETTINGS repo's
  // .persist (writes "on"/"off"). One line each — the read/write logic and the
  // localStorage key live in the descriptor.
  toggleMinimap() {
    this.minimapVisible = SETTINGS.minimap.persist(!this.minimapVisible);
  }

  /** Command. Flip the Asset Explorer's "Show built-in assets" filter (default
   *  OFF — see the SETTINGS entry for why). Purely a VIEW filter: it changes what
   *  the Explorer lists, never what is registered. The built-in widget library is
   *  loaded at boot in every mode regardless, so a deck using a built-in widget
   *  renders identically whether the toggle is on or off. */
  toggleShowBuiltinAssets() {
    this.showBuiltinAssets = SETTINGS.showBuiltinAssets.persist(!this.showBuiltinAssets);
  }

  toggleFps() {
    this.fpsVisible = SETTINGS.fps.persist(!this.fpsVisible);
  }

  /** Command. Sets ONE divider family's label⟷value split fraction (clamped +
   *  persisted by that family's setting descriptor). Called live during a divider
   *  drag, so it must stay a plain assignment — no undo entry: this is a BROWSER
   *  setting, not document state. Throws on an unknown key rather than writing a
   *  stray property nothing reads. */
  setLabelFrac(key, frac) {
    if (!(key in LABEL_FRAC_SETTINGS)) throw new Error(`setLabelFrac: unknown divider key "${key}"`);
    this.labelFrac[key] = LABEL_FRAC_SETTINGS[key].persist(frac);
  }

  /** Command. Returns ONE divider family's split to its default (the divider's
   *  double-click), clearing the stored preference rather than writing the
   *  default over it — so a later change to the default reaches this user. */
  resetLabelFrac(key) {
    if (!(key in LABEL_FRAC_SETTINGS)) throw new Error(`resetLabelFrac: unknown divider key "${key}"`);
    this.labelFrac[key] = LABEL_FRAC_SETTINGS[key].reset();
  }

  togglePanelNames() {
    this.panelNames = SETTINGS.panelNames.persist(!this.panelNames);
  }

  /**
   * Command. Shows/hides one dockable panel, persisting the choice (the
   * "Toggle Visibility: … Panel" command family). Throws on an unknown id
   * rather than creating a phantom entry — a typo'd panel id would otherwise
   * persist a key nothing reads and silently toggle nothing at all.
   *
   * @param {string} id A core/panels.js PANELS entry's `id`.
   */
  togglePanel(id) {
    const setting = PANEL_SETTINGS[id];
    if (!setting) throw new Error(`togglePanel: no such panel "${id}". Known panels: ${PANELS.map((p) => p.id).join(", ")}`);
    this.panelVisible[id] = setting.persist(!this.panelVisible[id]);
  }

  toggleSnap() {
    this.snapEnabled = SETTINGS.snap.persist(!this.snapEnabled);
  }

  toggleSnapSize() {
    this.snapSizeEnabled = SETTINGS.snapSize.persist(!this.snapSizeEnabled);
  }

  toggleGrid() {
    this.gridEnabled = SETTINGS.grid.persist(!this.gridEnabled);
  }

  toggleRuler() {
    this.rulerEnabled = SETTINGS.ruler.persist(!this.rulerEnabled);
  }

  toggleGhosts() {
    this.showGhosts = SETTINGS.showGhosts.persist(!this.showGhosts);
  }

  toggleEquationLock() {
    this.equationLock = SETTINGS.equationLock.persist(!this.equationLock);
  }

  /**
   * Query. THE camera's folded item state on the current slide as {id, state},
   * or null on a degenerate pre-repair document with no active camera (the
   * CAMERA invariant guarantees exactly one otherwise). Selected by the SAME
   * deterministic rule as core/derive.cameraRect — the first active
   * `type:"camera"` by id. Reads the memoized folded+evaluated state(), so a
   * caller in a reactive scope (app.dpr() ← CanvasView's paint effect)
   * recomputes when the document or slide changes; no render-tree derivation.
   */
  cameraState() {
    const entry = Object.entries(this.state().items ?? {})
      .filter(([, s]) => s.type === "camera" && s.active !== false)
      .sort(([a], [b]) => (a < b ? -1 : 1))[0];
    return entry ? { id: entry[0], state: entry[1] } : null;
  }

  /**
   * Query. The effective devicePixelRatio for ALL raster rendering — the SOLE
   * reader of the retina setting, which is CAMERA-ONLY: THE camera's `retina`
   * prop (Inspector → Rendering → Retina) is the single source of truth.
   * REACTIVE: flipping that prop reassigns this.doc, so the folded state() this
   * reads changes and CanvasView's paint effect (a dep of app.doc) repaints and
   * resizes the canvas backing store. retina ON → the display's device pixel
   * ratio (crisp on HiDPI); OFF → 1 (1:1 CSS px, softer, faster). The
   * camera-absent / missing-prop degenerate case falls back to the registry
   * default, matching core/derive.cameraRect's `?? default` idiom.
   */
  dpr() {
    const retina = this.cameraState()?.state.retina ?? CAMERA_RETINA_DEFAULT;
    return effectiveDpr(retina, window.devicePixelRatio || 1);
  }

  constructor() {
    this.registry = createRegistry();
    this.commands = createCommands();
    this.shortcuts = createShortcuts(); // App.svelte rebuilds this from the keybinding registry
    this.undoLog = createUndo(this.snapshot(this.doc));
    this.canvasActions = null; // PanZoom actions, set by CanvasView
    // Types registered by the CURRENT project's *.plugin.js assets (see
    // reloadPluginAssets). Empty until a project is opened — a fresh document has
    // only the built-in roster.
    this.pluginAssetTypes = [];
    registerAll(this.registry, this.commands);
  }

  // ── State queries ──────────────────────────────────────────────────────────

  // Preview-blend cache: (base, previewDelta) identity pair → blended state.
  // Deliberately non-reactive (renderFrameCount precedent). WHY: during a drag
  // every reactive consumer (viewport paint, picker displayName × N items,
  // nodes(), per-row error checks, ...) reads state() on EVERY pointermove; a
  // fresh blendApplied object per CALL defeated evaluateState's state-identity
  // memo, so each consumer paid its own full O(items) equation pass per mouse
  // move — the profiled drag-lag cliff (concerns 2026-07-15, Opus4 risk (b)).
  // One stable object per (base, preview) pair = ONE evaluation per move.
  #blendCache = { base: null, preview: null, state: null };

  /**
   * Folded state of the current slide, with any live drag preview applied —
   * RAW: equation slots still hold their stored strings. The Property Panel
   * and Variables Panel read THIS to display/edit equations. IDENTITY-STABLE:
   * repeated calls return the SAME object until the fold or previewDelta
   * changes (evaluateState's memo — and thus drag latency — depends on this;
   * consumers must never mutate the returned state). setPreview reassigns
   * previewDelta wholesale each move, which is what keys the cache.
   */
  rawState() {
    const base = foldState(this.doc, this.slideIndex, 1);
    const preview = this.previewDelta;
    // ONE transient overlay: the live PREVIEW delta. A second one used to be blended
    // here — the filmstrip's fetch STATUS (processing / frameError) — and it went away
    // with the server frame-extraction round-trip that produced it: the filmstrip's
    // frames are decoded in the browser from ordinary document state now, so it has no
    // in-flight or fetch-failed condition to model outside the document at all.
    if (!preview) return base;
    const c = this.#blendCache;
    if (c.base !== base || c.preview !== preview) {
      c.base = base;
      c.preview = preview;
      c.state = blendApplied(base, preview, 1);
    }
    return c.state;
  }

  /** The derivation-stage expression pass over rawState(): {state, errors}.
   * Memoized on state identity (and script source) inside evaluateState.
   *
   * THE PROJECT SCRIPT rides along as the third argument: it lives in doc.meta, so
   * the folded state alone cannot carry it, and evaluateState keys its memo on the
   * source string for exactly that reason (a script edit leaves the fold identical,
   * so without it the canvas would keep showing the pre-edit evaluation). */
  evalInfo() {
    // CONTENT SIZES ARE THREADED HERE TOO, not only at web/cameraFrame.js's seam.
    // That seam covers every PIXEL consumer (thumbnails, export, presenter, CLI),
    // but the EDITOR reads state() through this method — so without this line a
    // content-bound height would resolve in an export and show an error on the
    // canvas the author is looking at.
    //
    // FROM THE RAW STATE, WHICH ALSO BREAKS A CIRCLE: contentSizesFor needs only
    // each item's type/src/page, all raw literals, and asking it for the EVALUATED
    // state here would call this method again and recurse forever.
    return evaluateState(this.rawState(), this.registry, this.projectScript(), this.contentSizes());
  }

  /** The PROJECT SCRIPT source — one always-present string (repairedDocument fills
   *  it), so no consumer branches on undefined. */
  projectScript() {
    return this.doc.meta.script ?? "";
  }

  /** Query. Why the CURRENTLY STORED project script does not compile, or null when
   *  it does (an empty script always does). Drives the Monaco modal's footer problem
   *  line.
   *
   *  Reads the verdict of the compile the EVALUATOR did (projectScriptProblem never
   *  compiles anything itself), so the dialog cannot report a different opinion from
   *  the one the canvas is actually running — and cannot perturb it either. A commit
   *  triggers a derivation pass, so the answer is current by the time it is read. */
  projectScriptError() {
    return projectScriptProblem(this.projectScript());
  }

  /** Query. The project script's EXPORT OBJECT — what an equation may legally
   *  reference beyond the document's own variables, items and anchors.
   *
   *  TWO consumers, both of which were wrong without it:
   *    - the equation-field HIGHLIGHTER (equationTokenSpans) painted a perfectly valid
   *      `= GUTTER * 4` entirely red, because the identifier resolves at evaluation
   *      but is not a document variable. A highlighter that contradicts the evaluator
   *      sends the author hunting a bug that does not exist.
   *    - equation AUTOCOMPLETE offered nothing, so a library was only usable by
   *      remembering every name written in a dialog that is currently closed.
   *  The OBJECT (not a name set) because the second one needs each value's TYPE to
   *  know whether to suggest `ease(` or `GUTTER`.
   *
   *  Read off the evaluator's own compile, so these are the exports the canvas is
   *  ACTUALLY running — a broken script exports nothing, its callers correctly light
   *  up red, and autocomplete correctly offers nothing. */
  projectScriptExports() {
    return compiledScriptExports(this.projectScript());
  }

  /** Folded + EVALUATED state — every numeric property is a number. All
   * geometry (canvas, snapping, anchors, hit tests) reads this. */
  state() {
    return this.evalInfo().state;
  }

  /** Expression error message for a full state path (e.g. ["items", id, "x"]
   * or ["vars", name]), or null. Drives the equation-field error affordance. */
  exprErrorAt(path) {
    return this.evalInfo().errors.get(path.join(".")) ?? null;
  }

  /** RAW stored value at a path within an item (equation string or number). */
  storedItemValue(itemId, path) {
    return getPath(this.rawState().items?.[itemId] ?? {}, path);
  }

  /** RAW stored value at a FULL state path (e.g. ["items", id, "x"] or
   * ["vars", name]) — the KeyframeControls upsert reads this to copy the
   * current value into a new keyframe (equations stay equations).
   *
   * A SPARSE slot holds nothing to copy, and MATERIAL KNOBS are the one such
   * family: they are stored only once written ("no state until written") and
   * resolve from the material's own schema at paint time. So the value a new
   * keyframe must copy there is that schema default — core/expressions.js owns
   * the lookup. Without this the knob's ◆ keyed `undefined` and read as a control
   * that does nothing, which is worse than not having one. Every non-sparse slot
   * takes the first line, byte-identically. */
  storedValueAtPath(path) {
    const raw = getPath(this.rawState(), path);
    if (raw !== undefined || path[0] !== "items") return raw;
    return materialParamDefaultAt(path.slice(2), this.rawState().items?.[path[1]]);
  }

  /** The referencable display name of an anchor ("circle_tm") — what the
   * hover tooltip shows and what equations type before .x/.y. */
  anchorName(itemId, anchorId) {
    return anchorRefName(this.rawState(), itemId, anchorId);
  }

  nodes() {
    return deriveRenderTree(this.state(), this.registry, this.projectName());
  }

  selectedNode() {
    return this.nodes().find((n) => n.itemId === this.selection) ?? null;
  }

  /** Query. The full set of selected itemIds: the multi override when non-empty,
   * else [selection] (or []). The ONE place set-aware consumers (canvas
   * outlines, the Inspector placeholder) read to know everything selected.
   * Always a FRESH plain array — never the internal $state proxy (callers
   * can't mutate selection state through it, and plain arrays survive
   * puppeteer serialization — the concerns.md proxy gotcha). */
  selectedIds() {
    return this.selectionSet.length ? [...this.selectionSet] : (this.selection !== null ? [this.selection] : []);
  }

  /** Query. Render nodes for every selected id (order = selectedIds()). */
  selectedNodes() {
    const ids = new Set(this.selectedIds());
    return this.nodes().filter((n) => ids.has(n.itemId));
  }

  // ── MULTI-SELECTION PROPERTY INTERSECTION (core/multiselect.js) ─────────────
  // The Property Panel's whole multi-selection input. All the logic is in core;
  // these two are the app-state ADAPTER (which items, whose raw state) and the
  // ONE write, kept here beside applyPreset because they use the same seam.

  /**
   * Query. The selected items as core/multiselect.js `entries`, PRIMARY FIRST —
   * {itemId, plugin, state} per selected id, with the RAW folded state (equations
   * still their stored strings, exactly as the Property Panel displays them).
   *
   * `state` is null for an item NOT ON THIS SLIDE, which core drops from the
   * intersection and reports in `skipped` rather than editing invisibly. The type
   * comes from the same raw state, so an item present here always resolves its
   * plugin; an absent one carries the plugin from its creation-fold state when one
   * exists, so a skipped item can still be NAMED.
   */
  selectionEntries() {
    const raw = this.rawState();
    return this.selectedIds().map((itemId) => {
      const state = raw.items?.[itemId] ?? null;
      const type = state?.type ?? this.#governingTypeState(itemId)?.type;
      return { itemId, plugin: type ? this.registry.get(type) : null, state };
    }).filter((e) => e.plugin !== null);
  }

  /**
   * Query. Everything the multi-selection Property Panel renders: the shared rows
   * with each one's mixed/agreed state, the reported conflicts, and the items not
   * on this slide. A pure derivation of `selectionEntries()` — see
   * core/multiselect.js for the identity relation and the mixed-value semantics.
   */
  /** Query. The intrinsic-size table for the CURRENT slide — what the
   *  bind-height-to-content command gates on, and the same table the evaluation
   *  seam threads (web/contentSizes.js). Read through the app rather than
   *  imported into App.svelte so the command layer holds no media knowledge. */
  contentSizes() {
    return contentSizesFor(this.rawState(), this.projectName());
  }

  multiSelectPanel() {
    return multiSelectPanel(this.selectionEntries(), this.multiSelectMode);
  }

  /** Command. Switches the multi-selection panel between showing rows EVERY
   *  selected item has (intersection) and rows ANY of them has (union). View
   *  state, not document state: it is not keyframed, not saved, and changing it
   *  writes nothing — so it is a plain field rather than anything the fold or an
   *  undo unit knows about. */
  setMultiSelectMode(mode) {
    if (mode !== MULTISELECT_MODE.INTERSECTION && mode !== MULTISELECT_MODE.UNION)
      throw new Error(`setMultiSelectMode: unknown mode "${mode}" — expected "${MULTISELECT_MODE.INTERSECTION}" or "${MULTISELECT_MODE.UNION}"`);
    this.multiSelectMode = mode;
  }

  /**
   * Command. UNIFIES one property across every selected item — the user's
   * "when I click them, it would have to unify them all to the same value" — as
   * EXACTLY ONE UNDO UNIT (setPreview stages the whole fan-out, commitPreview
   * walks it into a single `commit`, the same way applyPreset writes a property
   * set). Writes ONLY this key, and only on the items that do not already hold the
   * value (core/multiselect.js `unifyPairs`, the minimal-delta rule).
   *
   * NO-OP WHEN THERE IS NOTHING TO WRITE, deliberately: `keyframed` rebuilds the
   * document, so committing an empty write would push an undo entry for a change
   * nobody made (the rule the equation field's blur handler already obeys).
   *
   * @param {string} key - the property key, possibly dotted ("shadow.dx")
   * @param {*} value - the value to unify to (a literal, or an `=` equation)
   * @returns {number} how many items were written (0 = nothing committed)
   */
  unifySelection(key, value, itemIds = null) {
    // `itemIds` RESTRICTS the write to the items a row applies to. In UNION mode a
    // row may be declared by only some of the selection, and writing the key onto
    // an item whose plugin never declared it would store a property that widget
    // silently ignores — invisible junk in the document. Null (the intersection
    // case, and every pre-existing caller) means every selected item, unchanged.
    const targets = itemIds === null ? this.selectionEntries() : this.selectionEntries().filter((e) => itemIds.includes(e.itemId));
    const pairs = unifyPairs(targets, key, value);
    if (pairs.length === 0) return 0;
    this.setPreview(pairs);
    this.commitPreview();
    return pairs.length;
  }

  /**
   * Command. Sets the selection to a SET of itemIds (band select / future
   * multi-click). The primary `selection` becomes the first id (drives every
   * single-item consumer); the multi override holds the whole set. Assigning
   * #selection directly (not through the accessor) so the set is NOT cleared.
   * Empty ids → full deselect.
   */
  selectMany(ids) {
    // GROUP INVARIANT (manifest Round-12B): a group and its members can never be
    // simultaneously selected. Enforced HERE — the ONE multi-select substrate —
    // so band select, Select All, and future multi-click paths all inherit it
    // with no per-caller code (and CanvasView's band commit needs no edit): a
    // member whose group is also in the set collapses out, leaving the group as
    // the top-level handle. A lone member (no group in the set) survives, so a
    // direct member click with Show Ghosts off still selects the member.
    const filtered = dedupeGroupSelection(ids, groupMembership(this.nodes()));
    // [ROUND 15.2] #selection is written directly below (not through the
    // `selection` accessor, which would clear selectionSet) — so this entry
    // point needs its OWN text-edit dismissal, same rule as that accessor:
    // a multi-select that doesn't merely re-affirm the item being edited
    // must commit+exit first. (In practice CanvasView's click-away guard
    // already dismisses before any band-select/shift-click logic runs; this
    // is the defensive second layer for any other caller, e.g. Select All.)
    if (this.editingItemId !== null && !(filtered.length === 1 && filtered[0] === this.editingItemId)) this.dismissEdit();
    if (filtered.length === 0) {
      this.selection = null; // clears both (accessor path)
      return;
    }
    this.#selection = filtered[0];
    this.selectionSet = [...filtered];
    this.handleSelection = []; // the outer scope owns the inner one (see handleSelection)
    this.selectedTransition = null; // selecting items clears a transition selection
  }

  /**
   * Command. Toggles an itemId's MEMBERSHIP in the current selection
   * (shift-click semantics — PowerPoint/Figma): if `id` is already selected it
   * is removed, otherwise it is added. Order-preserving: an added id lands at
   * the end. Routes ENTIRELY through the existing substrate — it builds the new
   * id list from selectedIds() ± `id` and applies it via selectMany (a
   * collapse-to-one still goes through selectMany, whose first-element mirror
   * keeps `selection` coherent); removing the last id fully deselects. No second
   * selection mechanism.
   */
  toggleInSelection(id) {
    const ids = this.selectedIds();
    this.selectMany(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  }

  // ── HANDLE SELECTION (the INNER selection scope) ────────────────────────────
  // The vocabulary is deliberately the item scope's, one level down: selectHandle
  // ≙ `selection =`, toggleHandleInSelection ≙ toggleInSelection, hide/show/purge
  // ≙ deleteSelection/showSelection/purgeSelection. Copying the words is what makes
  // the two scopes one idea rather than two. See `handleSelection` for the
  // precedence rules between them.

  /** Query. The selected item's WORLD-space modifier points (all of them), or []
   * when the selection is not exactly one item — handles only exist for a single
   * selection, the same scope CanvasView draws them in.
   *
   * Always a FRESH plain array (the selectedIds() rule: never the $state proxy, so
   * a caller cannot mutate selection state through it and puppeteer can serialize
   * it). */
  handles() {
    const ids = this.selectedIds();
    if (ids.length !== 1) return [];
    const node = this.nodes().find((n) => n.itemId === ids[0]);
    return node ? nodeModifierPoints(node) : [];
  }

  /** Query. The selected handles, in the order the plugin declares them (NOT
   * selection order) — so a set operation walks the widget's own element order and
   * the toolbar's readout is stable as you add to the set. */
  selectedHandles() {
    const chosen = new Set(this.handleSelection);
    return this.handles().filter((h) => chosen.has(h.id));
  }

  /** Command. Makes `id` THE selected handle (a plain click on a handle) —
   * replacing whatever was selected, exactly as a plain item click replaces the
   * item selection. Leaves the ITEM selection alone. */
  selectHandle(id) {
    this.handleSelection = [id];
  }

  /**
   * Command. Toggles a handle's MEMBERSHIP in the handle selection — shift-click,
   * the SAME semantics `toggleInSelection` gives items (PowerPoint/Figma: shift on
   * an already-selected one REMOVES it). Order-preserving: an added id lands at the
   * end. Removing the last id leaves the handle selection empty, which is not a
   * deselect of the item — the two scopes are independent (see handleSelection).
   */
  toggleHandleInSelection(id) {
    const ids = this.handleSelection;
    this.handleSelection = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  }

  /** Command. Clears the handle selection, leaving the ITEM selection intact —
   * Escape's inner-scope meaning (see handleSelection precedence rule 2). */
  clearHandleSelection() {
    this.handleSelection = [];
  }

  /**
   * Pure function. The LIST DECLARATION (core/lists.js) behind a handle, or null
   * when the handle is not a list element: `{decl, listKey, index}`.
   *
   * The handle carries the declaration BY REFERENCE (`element.list` is the very
   * object core/properties.js owns — PROPS.points for a polygon vertex), so the
   * canvas actions, the Inspector's list control and the plugin's own geometry read
   * ONE declaration and cannot disagree about the storage form or the visibility
   * companion's name. Deliberately NOT a lookup by key: a lookup needs a table to
   * look in, and every candidate table (the plugin's inspector rows, PROPS) is a
   * place the answer could be missing or a second copy could appear — a reference
   * cannot drift from itself. A malformed declaration is a plugin bug, so it throws.
   */
  #handleElement(handle) {
    if (!handle.element) return null;
    const { list: decl, index } = handle.element;
    if (decl?.kind !== LIST_ROW_KIND || !decl.key || !decl.activeKey)
      throw new Error(`app: handle "${handle.id}" of "${this.selectedNode()?.type}" declares an \`element\` whose \`list\` is not a list declaration (need kind "${LIST_ROW_KIND}" plus key/activeKey — pass the core/properties.js PROPS entry itself, e.g. \`element: {list: props("points")[0], index: i}\`). Got: ${JSON.stringify(decl)?.slice(0, 120)}`);
    return { decl, listKey: decl.key, index };
  }

  /** Query. The selected handles that ARE list elements, grouped by list key and
   *  sorted by DESCENDING index — the order a multi-element splice must run in, so
   *  each purge cannot invalidate the indices still to come. Handles with no
   *  element (a donut's inner radius) are absent, which is what makes the list
   *  actions silently inapplicable to them rather than wrong. */
  #selectedListElements() {
    const byKey = new Map();
    for (const h of this.selectedHandles()) {
      const el = this.#handleElement(h);
      if (!el) continue;
      if (!byKey.has(el.listKey)) byKey.set(el.listKey, { decl: el.decl, indices: [] });
      byKey.get(el.listKey).indices.push(el.index);
    }
    for (const entry of byKey.values()) entry.indices.sort((a, b) => b - a);
    return byKey;
  }

  /**
   * Command. Sets every selected handle's element VISIBILITY (hide/show) as ONE
   * undo unit — the list-element form of the item eye toggle, and the same rule one
   * level down: the element stops participating (a polygon draws straight past the
   * corner) but keeps its place, so it can come back.
   *
   * INDEX-STABLE BY CONSTRUCTION: routed through core/lists.withElementActive,
   * which writes ONLY the aligned visibility COMPANION and returns the element list
   * by identity. `points.3.x` therefore still names the same vertex afterwards, and
   * every equation bound to a later element keeps its meaning. That is the whole
   * reason hide exists alongside purge.
   *
   * KEEPS the handle selection (the item-scope ruling verbatim: "you shouldn't
   * deselect something when it's not visible anymore" — a hidden handle stays
   * selected so the same button flips it back).
   */
  setHandleSelectionActive(active) {
    const groups = this.#selectedListElements();
    if (groups.size === 0) return;
    const id = this.selection;
    const state = this.state().items?.[id];
    let doc = this.doc;
    for (const [listKey, { decl, indices }] of groups) {
      let value = { list: state[listKey], active: state[decl.activeKey] };
      for (const index of indices) value = withElementActive(decl, value, index, active);
      doc = keyframed(doc, this.slideIndex, ["items", id, decl.activeKey], value.active);
    }
    this.commit(doc);
  }

  /**
   * Command. PURGES every selected handle's element — spliced out of the list for
   * good — as ONE undo unit. The list-element form of purgeSelection, and like it
   * the DESTRUCTIVE half of the pair: hide is setHandleSelectionActive and moves
   * nothing.
   *
   * IT RENUMBERS, AND THAT IS USER-VISIBLE. Purge is one of the two renumbering
   * operations (core/lists.js): every LATER element's address shifts down by one, so
   * an equation bound to `points.4.x` comes to mean what was `points.5.x`. The
   * document-wide equation rewrite that would make this safe is not built
   * (core/lists.indexAfterPurge is the remap it needs), so the consequence is
   * surfaced in the command's own title and in the toolbar's tooltip rather than
   * hidden behind a button that looks like hide.
   *
   * Indices run DESCENDING (#selectedListElements' order) so each splice cannot
   * invalidate the ones still to come. CLEARS the handle selection: those elements
   * no longer exist, exactly as purgeSelection deselects a purged item.
   */
  purgeHandleSelection() {
    const groups = this.#selectedListElements();
    if (groups.size === 0) return;
    const id = this.selection;
    const state = this.state().items?.[id];
    let doc = this.doc;
    for (const [listKey, { decl, indices }] of groups) {
      let value = { list: state[listKey], active: state[decl.activeKey] };
      for (const index of indices) value = withElementPurged(decl, value, index);
      doc = keyframed(doc, this.slideIndex, ["items", id, listKey], value.list);
      // Only write the companion when there IS one: purging from a list that never
      // hid anything must not mint an all-true companion into the document.
      if (value.active) doc = keyframed(doc, this.slideIndex, ["items", id, decl.activeKey], value.active);
    }
    this.commit(doc);
    this.handleSelection = [];
  }

  /**
   * Command. Applies a pure `transform(element, index) → element` to EVERY selected
   * handle's list element, as ONE undo unit — the generic element-EDIT substrate the
   * paint-path curve / new-subpath toggles route through, exactly as
   * setHandleSelectionActive is the substrate for the visibility eye. It knows
   * nothing about what the transform does: a widget declares the on/off pair
   * (registry `handleToggles`) and the universal HandleToolbar / point menu call
   * this with it, so no widget-specific write path is added here.
   *
   * Writes the list at each element's own list key (no renumbering — a transform
   * replaces in place, unlike purge). Keeps the handle selection: the same handles
   * still exist and stay selected so the toggle can flip back.
   */
  transformHandleSelectionElements(transform) {
    const groups = this.#selectedListElements();
    if (groups.size === 0) return;
    const id = this.selection;
    const state = this.state().items?.[id];
    let doc = this.doc;
    for (const [listKey, { indices }] of groups) {
      const chosen = new Set(indices);
      const list = state[listKey].map((el, i) => (chosen.has(i) ? transform(el, i) : el));
      doc = keyframed(doc, this.slideIndex, ["items", id, listKey], list);
    }
    this.commit(doc);
  }

  /**
   * Command. Selects every selectable item on the current slide (palette
   * "Select All" — manifest Round 12B). Excludes purgeable:false widgets (the
   * camera) — the same set-operation exclusion `deleteSelection`/
   * `purgeSelection`/`showSelection`/`addBlankSlide` already use, since the
   * camera is not a content object a user means to grab with Select All.
   * Routes through selectMany (the ONE multi-select substrate).
   */
  selectAll() {
    this.selectMany(this.selectableIds());
  }

  /**
   * Query. Every itemId Select All would take — the SELECTABLE population of this
   * slide. Extracted so invert and select-by-type cannot disagree with Select All
   * about what "everything" means; a second filter written beside it is exactly the
   * hand-maintained-mirror defect this codebase keeps rediscovering.
   */
  selectableIds() {
    return this.nodes().filter((n) => n.plugin.capabilities.purgeable !== false).map((n) => n.itemId);
  }

  /**
   * Command. INVERT THE SELECTION (#301): everything selectable on this slide that
   * is NOT currently selected.
   *
   * ON THE EMPTY SELECTION IT IS SELECT ALL, which is the honest reading of
   * "invert" and not a special case — the complement of nothing is everything.
   * On a full selection it deselects, for the same reason.
   */
  invertSelection() {
    const chosen = new Set(this.selectedIds());
    this.selectMany(this.selectableIds().filter((id) => !chosen.has(id)));
  }

  /**
   * Command. INVERT WITHIN THE OWNING GROUP (#301): the members of the selection's
   * group that are not selected, leaving everything outside that group alone.
   *
   * THE SCOPE IS THE GROUP THE SELECTION IS IN, so this is the natural partner of
   * Select Inside Group (#296) — go in, then flip which members you have. Members
   * of SEVERAL groups invert within each of them, which falls out of collecting
   * the owners rather than being a case: a selection spanning two groups plainly
   * means both.
   */
  invertSelectionInGroup() {
    const membership = groupMembership(this.nodes());
    const owners = new Set(this.selectedIds().map((id) => membership.get(id)).filter(Boolean));
    if (owners.size === 0) {
      console.warn("Invert Selection in Group: nothing selected is inside a group.");
      return;
    }
    const chosen = new Set(this.selectedIds());
    const siblings = this.nodes()
      .filter((n) => n.type === "group" && owners.has(n.itemId))
      .flatMap((n) => n.state.members ?? []);
    this.selectMany([...new Set(siblings)].filter((id) => !chosen.has(id)));
  }

  /**
   * Command. SELECT (or DESELECT) EVERY WIDGET OF ONE TYPE (#301).
   *
   * THE TYPE LIST IS DERIVED FROM THE LIVE REGISTRY at the call site, never
   * hand-listed — a roster beside a registry that already knows is this repo's
   * named recurring defect.
   *
   * @param {string} type - a widget type
   * @param {boolean} [add] - true selects them alongside the current selection, false subtracts
   */
  selectByType(type, add = true) {
    const matching = this.nodes().filter((n) => n.type === type && n.plugin.capabilities.purgeable !== false).map((n) => n.itemId);
    const chosen = new Set(this.selectedIds());
    for (const id of matching) { if (add) chosen.add(id); else chosen.delete(id); }
    this.selectMany([...chosen]);
  }

  /**
   * Query. The widget types PRESENT on this slide, with how many of each — what a
   * select-by-type submenu lists. Derived from the live nodes, so a type nobody has
   * placed is not offered and a new widget needs no edit here.
   *
   * @returns {Array<{type: string, title: string, count: number}>} sorted by title
   */
  typesOnSlide() {
    const counts = new Map();
    for (const n of this.nodes()) {
      if (n.plugin.capabilities.purgeable === false) continue;
      const e = counts.get(n.type) ?? { type: n.type, title: n.plugin.title ?? n.type, count: 0 };
      e.count++;
      counts.set(n.type, e);
    }
    return [...counts.values()].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  }

  /** Command. Clears the selection (palette "Deselect All" — manifest Round
   * 12B). Same effect as Escape's existing deselect path (needsSelection
   * `deselect` command); a separate palette entry exists because Escape is
   * also read by other contexts (modal cancel) where "Deselect All" as a
   * distinct, always-nameable command is still useful (fuzzy search, no
   * keyboard focus required). */
  deselectAll() {
    this.selection = null; // clears both selection and selectionSet (accessor path)
  }

  // ── Transition selection (the between-rows navigator slice) ─────────────────
  // A transition is selected BY the incoming slide's slideId (stable identity;
  // slide indices shift on insert). Mutually exclusive with item selection.

  /** Command. Selects the transition INTO slide `slideId` (clears item
   * selection). Passing null deselects the transition. */
  selectTransition(slideId) {
    if (slideId === null) {
      this.selectedTransition = null;
      return;
    }
    this.selection = null; // clears item selection (accessor path)
    this.selectedTransition = slideId;
  }

  /**
   * Query. The unified selection target — what the Property Panel inspects.
   * One of: {kind: "item", itemId}, {kind: "transition", slideId}, or null.
   * The ONE thing Opus10's Inspector reads to decide which UI to show; item
   * selection wins if somehow both are set (they're kept mutually exclusive).
   */
  get selectionTarget() {
    if (this.selection !== null) return { kind: "item", itemId: this.selection };
    if (this.selectedTransition !== null) return { kind: "transition", slideId: this.selectedTransition };
    return null;
  }

  /** Query. The slide index for a slideId, or -1. */
  slideIndexOf(slideId) {
    return this.doc.slides.findIndex((s) => s.id === slideId);
  }

  /**
   * Query. The EFFECTIVE transition record for slide `slideId` — stored props
   * folded with the type-registry superclass + type defaults (every property
   * present). What the Inspector's transition rows display. Returns null when
   * the slide doesn't exist.
   */
  transitionAt(slideId) {
    const i = this.slideIndexOf(slideId);
    return i === -1 ? null : resolveTransition(this.doc, i);
  }

  /**
   * Command (one undo unit). Sets one transition property (seconds/curve/sound
   * or a type extra) on slide `slideId`. Writes the FULL resolved record back
   * so a partially-stored transition becomes complete (no half-written records
   * in the document). No-op when the slide is gone.
   */
  setTransitionProp(slideId, key, value) {
    const i = this.slideIndexOf(slideId);
    if (i === -1) return;
    const transition = { ...resolveTransition(this.doc, i), [key]: value };
    const slides = this.doc.slides.map((s, j) => (j === i ? { ...s, transition } : s));
    this.commit({ ...this.doc, slides });
  }

  /**
   * Command (one undo unit). Switches slide `slideId`'s transition TYPE,
   * PRESERVING the superclass props (seconds/curve/sound survive) and re-seeding
   * the type's extras from the new type's defaults (retypedTransition). No-op
   * when the slide is gone.
   */
  setTransitionType(slideId, type) {
    const i = this.slideIndexOf(slideId);
    if (i === -1) return;
    const transition = retypedTransition(resolveTransition(this.doc, i), type);
    const slides = this.doc.slides.map((s, j) => (j === i ? { ...s, transition } : s));
    this.commit({ ...this.doc, slides });
  }

  /**
   * Command. Enters a Blender-style modal transform (one of MODAL_KINDS: "grab" |
   * "scale" | "rotate") over the current selection. No-op with nothing selected.
   * Only the KIND is stored here; CanvasView (which owns pointer + preview)
   * watches this flag, captures the start geometry (cursor, member poses,
   * collective centre), and drives the live preview. Confirm/cancel go through the
   * callbacks below, which CanvasView installs — the same seam pattern as
   * canvasActions.
   *
   * THROWS ON AN UNDECLARED KIND, exactly as the `dragKind` setter above does and
   * for the same reason: the HintBar's label, its numeric prompt, its X/Y chips
   * and the reachability prober are all DERIVED from MODAL_TRANSFORM_KINDS, so a
   * kind entered here but missing there would run with the wrong announcement and
   * never be probed. Failing at the entry point makes that state unreachable — you
   * cannot add a modal transform without declaring it.
   */
  beginModalTransform(kind) {
    if (!MODAL_KINDS.includes(kind))
      throw new Error(`app.beginModalTransform(${JSON.stringify(kind)}) is not a declared modal transform — add it to MODAL_TRANSFORM_KINDS in web/canvas/dragKinds.js (with its key, label and whether an X/Y axis constraint means anything for it) so its shortcut, its HintBar announcement and the reachability prober all cover it. Legal: ${MODAL_KINDS.join(", ")}.`);
    if (this.selectedIds().length === 0) return;
    this.modalXform = { kind, axis: null, buffer: "" };
  }

  // Confirm/cancel/constraint hooks for the active modal transform — installed
  // by CanvasView (which owns the preview) like canvasActions. The modal
  // shortcut entries (App.svelte) call these: Enter/left-click confirm, Escape
  // cancels, X/Y set the axis constraint, digit/./- keys build the numeric
  // buffer, Backspace edits it. All no-ops before the canvas mounts (and no-ops
  // outside a live transform — CanvasView guards each on a live modal record).
  modalCommit = () => {};
  modalCancel = () => {};
  modalSetAxis = () => {};
  modalAppendBuffer = () => {};
  modalBackspace = () => {};

  // NUDGE hook — installed by CanvasView (which owns translateMembers /
  // translationPairs, so a nudge and a drag translate the selection through the
  // SAME rule). (dx, dy) in world px; one undo unit per call; a no-op before
  // the canvas mounts or with nothing movable selected. The arrow-key bindings
  // (core/shortcut_entries.js) land here.
  nudgeSelection = () => {};

  // FINALIZE hook for a live multi-step CREATION mode — installed by CanvasView,
  // which holds the in-flight session (a half-drawn polygon is not document state,
  // so it cannot live here). The mode's own `finish` key routes through the shortcut
  // registry to this, exactly as the modal's Enter routes to modalCommit; CanvasView
  // guards it on a live session, so it is a no-op otherwise.
  finishCanvasMode = () => {};

  /**
   * Command (one undo unit per keypress). ONE WASDQE FLY STEP for the widget whose
   * activation currently owns the canvas — the 3D viewport's keyboard camera
   * (#270, "rollerball + WASD camera").
   *
   * IT LIVES HERE, not in web/sceneNav.js, for the same reason finishCanvasMode
   * does: the shortcut registry holds `app` and a handler module does not, so the
   * handler declares WHAT each key means (web/sceneNav.js SCENE_FLY_KEYS) and this
   * supplies the doing. Routing it through the registry rather than a private
   * keydown is what puts the keys in the HintBar — the manifest's rule is that a
   * shortcut which is not registered does not exist.
   *
   * A NO-OP RATHER THAN A THROW when nothing is flying: the entry's `when` already
   * scopes it to the mode, so reaching here without a node means the mode ended
   * between the keydown and the dispatch. That is a race, not a defect, and
   * refusing loudly would turn a stray keypress into an error dialog.
   *
   * @param {{forward?: number, right?: number, up?: number}} verb - signed unit steps
   */
  flyCanvasMode(verb) {
    const mode = this.canvasMode;
    if (!mode) return;
    const node = this.nodes().find((n) => n.itemId === mode.itemId);
    if (!node?.plugin?.sceneCamera) return;
    // COMMITTED PER KEYPRESS, not previewed: a key has no "up" that a preview
    // could commit on, and one tap is one intelligible step to undo. That is the
    // same reasoning ZOOM_GESTURE_IDLE_MS applies to the wheel, resolved the other
    // way because a discrete key genuinely is a discrete gesture.
    previewScenePose(this, node, flownPose(node.plugin.sceneCamera.pose(node.state), verb));
    this.commitPreview();
  }

  /** Command. Arms a one-shot CROSSHAIR band-select drag in `mode`
   * ("inner"|"outer"|"regular"). "regular" resolves to the default bandMode
   * setting (the toolbar button's press — manifest Round 12B "TOOLBAR BUTTON
   * for default box select"). The next canvas drag performs the rubber band;
   * CanvasView clears the arm. */
  armCrosshairBand(mode) {
    this.crosshair = { kind: "band", mode: mode === "regular" ? this.bandMode : mode };
  }

  /** Command. Arms a one-shot CROSSHAIR placement drag for `plugin` (manifest
   * ARCHITECTURE PLAN #5 "PLACEMENT rides it"): the next canvas gesture
   * click-drags the widget's rect into existence, or a plain click places it
   * at `plugin.defaults` size centered on the point (CanvasView.onPointerDown
   * / placementDrag / placementUp). Generalizes to ANY plugin — the widget
   * type itself is the only per-plugin knowledge CanvasView needs.
   *
   * A plugin whose create handler declares a MULTI-STEP mode (polygon) arms the
   * same way: the first press enters that mode instead of finishing, and the
   * crosshair stays up for the whole session (see enterCanvasMode). */
  armCrosshairPlacement(plugin) {
    this.crosshair = { kind: "place", plugin };
  }

  /**
   * Command. Arms a CROSSHAIR creation for a RIG — several items wired by `=`
   * equations, which no single plugin can declare a creation gesture for (the
   * telescopic magnifier is three items of three types). `handlerId` names the
   * create-phase handler directly (web/widget_handlers.js) and `params` is whatever
   * that handler's `finalize` needs (the telescopic rig's shapeKind).
   *
   * Deliberately a SECOND method rather than an optional argument on
   * armCrosshairPlacement: the plugin-declares-its-own-gesture rule is what keeps
   * the create phase honest for widgets, and an override channel on the widget path
   * would invite using it for widgets. Every existing caller is untouched.
   */
  armCrosshairRig(handlerId, params = {}) {
    this.crosshair = { kind: "place", handlerId, params };
  }

  // ── WIDGET CANVAS MODE lifecycle ───────────────────────────────────────────

  /**
   * Command. Enters a widget handler's sustained canvas mode: the widget owns canvas
   * input until Escape. Dismisses any in-place edit first, for the reason
   * enterPresentMode does — a takeover that leaves a stranded editor overlay has no
   * exit path.
   *
   * `itemId` is null for a CREATION mode (a multi-step placement — nothing exists
   * yet to belong to), and `step` is which of the mode's declared steps is current;
   * CanvasView advances it as gestures land and the HintBar narrates off it. A mode
   * with no sequence simply stays at 0.
   */
  enterCanvasMode(handlerId, itemId) {
    this.dismissEdit();
    this.canvasMode = { handlerId, itemId, step: 0 };
  }

  /** Command. Sets which step of a multi-step creation mode is current. Reassigns
   * the whole record so every $derived tracking `canvasMode` invalidates (the
   * syncModalXform pattern). A no-op with no mode active. */
  setCanvasModeStep(step) {
    if (!this.canvasMode) return;
    this.canvasMode = { ...this.canvasMode, step };
  }

  /**
   * Command. Leaves the canvas mode, COMMITTING any gesture still staged in the
   * preview (a wheel gesture whose idle timer had not yet fired) as ONE undo unit
   * — the dismissTextEdit ruling: an exit boundary commits, it never discards work
   * the user can see. A no-op when no mode is active, so every "something else
   * happened" gate can call it unconditionally.
   *
   * It also DISARMS the crosshair, because a CREATION mode's crosshair deliberately
   * outlives the one-shot press that started it: a multi-step placement needs the
   * placement cursor for every step, not just the first. Leaving the mode is the end
   * of that session either way (finished or abandoned), so the cursor goes with it.
   * Harmless for an activation mode, which never has one armed (entering a mode does
   * not clear an arm, but nothing arms one to enter an activation).
   */
  exitCanvasMode() {
    if (!this.canvasMode) return;
    this.canvasMode = null;
    this.crosshair = null;
    if (this.previewDelta) this.commitPreview();
  }

  /** Command. Cancels an armed-but-not-yet-gestured crosshair mode (Esc,
   * manifest ARCHITECTURE PLAN #5: "Esc cancels"). No-op once a drag has
   * actually started — CanvasView's drag record takes over at that point and
   * its own Esc-cancel (mirroring the modifier-drag pattern) applies instead. */
  cancelCrosshair() {
    this.crosshair = null;
  }

  /** Command. Sets and persists the default ("regular") band-select mode. */
  setBandMode(mode) {
    this.bandMode = mode;
    localStorage.setItem(BAND_MODE_KEY, mode);
  }

  /** Display name for an item: its `name` state, else the shared fallback
   * "<Type> (id-prefix)" (itemFallbackName — one home). */
  displayName(itemId) {
    const s = this.state().items?.[itemId];
    if (!s) return itemId;
    if (s.name) return s.name;
    return itemFallbackName(this.registry.get(s.type).title, itemId);
  }

  // ── Theme (viewer preference — not document state, not undoable) ──────────

  /** Command. Applies theme `id` VISUALLY only: the reactive `theme` field +
   * the documentElement data-attr the CSS cascade keys on. Does NOT persist —
   * the shared core of both setTheme (which adds persistence) and previewTheme
   * (which must not persist a transient hover). Mutates document.documentElement
   * + this.theme. */
  applyThemeVisual(id) {
    this.theme = id;
    document.documentElement.dataset.theme = id;
  }

  setTheme(id) {
    this.applyThemeVisual(id);
    localStorage.setItem(THEME_KEY, id);
  }

  /**
   * Command (viewer-preference preview — NOT persisted, NOT undoable). The
   * previewable-command hook the palette calls when a theme/family entry is
   * hovered or arrow-focused: applies the entry's family LIVE and returns a
   * `revert` closure restoring whatever was applied before. Unlike setTheme it
   * never writes localStorage — only a COMMITTED setTheme (the entry's `run`)
   * persists, so scrubbing leaves the saved preference untouched until the user
   * actually picks one. See the general preview protocol in
   * CommandPalette.svelte.
   *
   * POLARITY-LOCKED (see familyMemberForKind for the ruling): `id` names a
   * family, and the member actually applied is the one on the pole we are
   * ALREADY on. So `id` may be a family id or either member's theme id, and all
   * three preview the same thing.
   *
   * THE POLE IS READ FROM `prev`, NOT from this.theme mid-hover, and that is
   * load-bearing rather than incidental. The palette reverts the outgoing
   * preview BEFORE previewing the incoming one, so in normal use the two agree —
   * but if that order ever changed, reading the live field would let each hover
   * pick its pole from the PREVIOUS hover's preview and ratchet the app across
   * poles one row at a time, with nothing persisted to show where it started.
   * Anchoring to the theme this call is responsible for restoring makes a
   * preview idempotent under repetition by construction.
   */
  previewTheme(id) {
    const prev = this.theme;
    this.applyThemeVisual(familyMemberForKind(id, themeKind(prev)));
    return () => this.applyThemeVisual(prev);
  }

  /** Command (viewer preview; never persists — same revert contract as
   * previewTheme). The LITERAL twin: applies exactly `id`, no polarity
   * resolution. For entries that NAME their pole — the drilled-in member rows
   * ("Desert — Light") — where the lock previewed the pole you were already on,
   * which from the other pole is visibly no preview at all (user: "Once I click
   * the theme and I hover, they should also preview immediately"). The lock
   * exists to resolve AMBIGUOUS ids; use previewTheme for those. */
  previewThemeExact(id) {
    const prev = this.theme;
    this.applyThemeVisual(id);
    return () => this.applyThemeVisual(prev);
  }

  /** Command. Restores the saved theme, migrating a CULLED id through
   * THEME_ALIASES first — loudly, because a silent substitution is
   * indistinguishable from the app forgetting your preference. An id that is
   * neither live nor aliased falls back to the default, also loudly: it means
   * localStorage holds something this build has never shipped. */
  loadTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved == null) return this.setTheme(DEFAULT_THEME);
    if (THEMES.some((t) => t.id === saved)) return this.setTheme(saved);
    const alias = THEME_ALIASES[saved];
    if (alias) {
      console.warn(`[theme] "${saved}" was retired and is now "${alias}" — migrating your saved preference.`);
      return this.setTheme(alias);
    }
    console.warn(`[theme] saved theme "${saved}" is not in this build's catalog — falling back to ${DEFAULT_THEME}.`);
    this.setTheme(DEFAULT_THEME);
  }

  /** Command. THE dark/light toggle (toolbar + palette): flips to the sibling
   * on the other pole of the CURRENT theme's family, preserving the family.
   * See THEME_FAMILIES for why this is a lookup and not a graphite⟷light
   * special case — the hardcoded version is the reported Ember bug. */
  toggleLightDark() {
    this.setTheme(siblingTheme(this.theme));
  }

  // ── Transactions (undo units) ──────────────────────────────────────────────
  // Snapshots carry UI state too (selection, slide, viewport) — undoing a
  // purge reselects the item; undo/redo restores where you were looking.

  lastViewport = null; // kept fresh by CanvasView's onviewport

  snapshot(doc) {
    // handleSelection rides along for the SAME reason `selection` does, one scope
    // down: undoing a point hide must put you back with those points selected, so
    // the toolbar button you just pressed is still pointing at them. Without it the
    // `selection` write in applySnapshot would clear the inner scope (the
    // outer-owns-inner rule) and every point edit would silently deselect.
    //
    // selectionSet rides along for that argument applied one scope UP, which was
    // simply missed when the set was added: `selection` alone is the PRIMARY, so a
    // snapshot without the set restored a 3-item selection as a 1-item one. Undoing
    // a joint edit therefore left the Property Panel showing a SINGLE item, and the
    // next gesture silently wrote to that one item instead of the set the user could
    // still see outlined on the canvas. The manifest already required this ("undo
    // restores UI state (selection/slide/view)") — the multi-selection Inspector is
    // just the first feature whose behaviour depended on it.
    return { doc, selection: this.selection, selectionSet: this.selectionSet, handleSelection: this.handleSelection, slideIndex: this.slideIndex, viewport: this.lastViewport };
  }

  /**
   * Command. Install an undo/redo snapshot — THE one seam through which history
   * replaces the document.
   *
   * THE PROJECT NAME IS EXEMPT, and that exemption belongs HERE rather than in
   * renameProject. Renaming MOVES storage (the server folder, or the IndexedDB
   * keys), which an undo cannot reverse — so a snapshot that restored the OLD
   * meta.name would leave the title naming a folder that no longer exists and
   * every asset lookup under it finding nothing: the user's "all the assets
   * disappeared" bug, re-created in reverse and with no gesture that repairs it.
   *
   * KEEPING RENAME OUT OF `commit` IS NOT SUFFICIENT, which is why this is not
   * merely belt-and-braces. Every snapshot taken BEFORE a rename still carries the
   * old name, so undoing any earlier edit — one the user made long before renaming
   * — would restore it. The name must therefore be pinned at RESTORE time, not
   * merely omitted at commit time. (A browser probe caught exactly this: the
   * repro passed, then Undo stranded everything again.)
   *
   * The rest of the document is restored verbatim: undo still undoes edits, and it
   * is only the storage-identity field that history has no authority over.
   */
  applySnapshot(snap) {
    // The CURRENT name wins over the snapshot's: it is the folder the bytes are
    // actually in (loadProject/renameProject keep it true), and history is not
    // allowed to contradict storage.
    const name = this.doc?.meta?.name;
    this.doc = name === undefined || snap.doc.meta?.name === name
      ? snap.doc
      : { ...snap.doc, meta: { ...snap.doc.meta, name } };
    this.selection = snap.selection;
    // AFTER `selection`, never before: that setter clears BOTH the multi-selection
    // set and the handle selection. Written as the FIELD (not through selectMany,
    // which would additionally clear the handle scope and re-run the group filter on
    // a document that has just changed underneath it). Snapshots taken before either
    // field existed carry none — [] is then correct, and is also what the setter
    // just wrote, so there is nothing to special-case.
    this.selectionSet = snap.selectionSet ?? [];
    this.handleSelection = snap.handleSelection ?? [];
    this.slideIndex = Math.min(snap.slideIndex, snap.doc.slides.length - 1);
    if (snap.viewport) this.canvasActions?.setViewport(snap.viewport);
  }

  commit(doc) {
    if (doc === this.doc) return;
    this.undoLog.commit(this.snapshot(doc));
    this.doc = doc;
    try {
      localStorage.setItem(AUTOSAVE_KEY, serialize(doc));
    } catch (e) {
      console.warn("Autosave failed:", e); // quota etc. — report, keep working
    }
  }

  undo() {
    // Restore the PREVIOUS document, but the UI state captured at the moment
    // of the edit being undone — undoing a purge reselects the purged item.
    const undone = this.undoLog.doc;
    const prev = this.undoLog.undo();
    this.applySnapshot({ ...undone, doc: prev.doc });
  }

  redo() {
    this.applySnapshot(this.undoLog.redo());
  }

  // ── Preview (live drag without undo spam) ──────────────────────────────────

  setPreview(pathValuePairs) {
    let d = {};
    for (const [path, value] of pathValuePairs) d = setPath(d, path, value);
    this.previewDelta = d;
  }

  /** Commits the current preview as keyframes on the current slide (one undo unit). */
  commitPreview() {
    if (!this.previewDelta) return;
    let doc = this.doc;
    const walk = (tree, prefix) => {
      for (const [k, v] of Object.entries(tree)) {
        if (v !== null && typeof v === "object" && !Array.isArray(v)) walk(v, [...prefix, k]);
        else doc = keyframed(doc, this.slideIndex, [...prefix, k], v);
      }
    };
    walk(this.previewDelta, []);
    this.previewDelta = null;
    this.commit(doc);
  }

  cancelPreview() {
    this.previewDelta = null;
  }

  /** Command. Restores the real value sitting under any TRANSIENT preview, so
   * what the slot holds is what the user actually chose. Every path that can
   * COMMIT the slot must call this first; it is a no-op when nothing transient
   * is staged. See the `transientPreview` field for why this exists. */
  dropTransientPreview() {
    const revert = this.transientPreview;
    this.transientPreview = null;
    if (revert) revert();
  }

  // ── Presets (the generic PRESETS tool — web/ToolsPane.svelte) ─────────────

  /**
   * Command. Applies a plugin PRESET's property-set to item `itemId` as keyframed
   * writes on the CURRENT slide, in ONE undo unit — the exact Inspector-row commit
   * path (setPreview → commitPreview). `preset.props` is a flat map of item-state
   * keys (a plugin's self.* look knobs + shared props like blendMode) to values;
   * each becomes a keyframe at ["items", itemId, key] on the current frame, so a
   * preset is just "set these current-frame properties at once". No-op if itemId is
   * null. Reusable for ANY plugin that declares `presets` — nothing here is
   * lens-flare-specific.
   *
   * @param {string|null} itemId - the target item
   * @param {{props: Object}} preset - a plugin preset descriptor ({name, props, ...})
   */
  applyPreset(itemId, preset) {
    if (itemId === null || !preset?.props) return;
    const pairs = Object.entries(preset.props).map(([key, value]) => [["items", itemId, key], value]);
    this.setPreview(pairs);
    this.commitPreview();
  }

  // ── WYSIWYG rich-text editing (Round 13.4) ─────────────────────────────────

  /** Command. Enters in-place edit mode on a text item: selects it (so the
   * Inspector + toolbar reflect it) and sets `textEditing`. The item keeps
   * rendering live through Skia; the TextEditController mounts and draws the
   * caret/selection on top. A no-op if already editing this item.
   *
   * `opts.plain` selects PLAIN-STRING mode (a single-string widget like
   * plaintext, via its `inlineTextEdit` descriptor): the editor edits one plain
   * string at `opts.property` (default "text") with no runs/format toolbar, and
   * the stored leaf is a bare string rather than a {runs,paras} value. In plain
   * mode an `=` equation-bound value is REFUSED (in-place editing flattens the
   * RESOLVED value back to a literal, which would silently overwrite the
   * equation) — reported LOUDLY, then the user edits it in the Inspector (the
   * mermaid/codeblock precedent). Rich mode (no opts) is unchanged. */
  beginTextEdit(itemId, opts = {}) {
    const plain = !!opts.plain;
    const property = opts.property ?? "text";
    if (plain) {
      const plugin = this.registry.get(this.storedItemValue(itemId, ["type"]));
      if (plugin && equationBoundKeys(this, itemId, plugin, [property]).length) {
        console.warn(`beginTextEdit: "${property}" is an = equation — edit it in the Inspector (in-place editing would overwrite the equation with its value).`);
        return;
      }
    }
    if (this.textEditing?.itemId === itemId) return;
    this.selection = itemId;
    this.textEditing = { itemId, plain, property };
  }

  /** Command. Live-previews the edited text value — the viewport re-renders
   * through the overlay in real time (the house live-preview rule; the
   * Inspector-row commit path). Written as a single keyframable non-numeric leaf
   * at the editing property, EXACTLY the stored shape: a {runs,paras} value in
   * rich mode, a bare string in plain mode (the controller flattens before it
   * calls here). */
  previewTextValue(value) {
    if (!this.textEditing) return;
    this.setPreview([[["items", this.textEditing.itemId, this.textEditing.property ?? "text"], value]]);
  }

  /** Command. Commits the edit as ONE undo unit (setPreview already holds the
   * final value → commitPreview keyframes it on the current slide) and exits
   * edit mode. If there was no pending preview (no change), just exits. */
  commitTextEdit() {
    const editing = this.textEditing;
    // A hovered-but-unchosen style is staged in the SAME slot as the edit; drop
    // it first so a dismissal landing mid-hover commits the real value.
    this.dropTransientPreview();
    this.textEditing = null;
    if (!editing) return;
    if (this.previewDelta) this.commitPreview();
  }

  /** Command. Cancels the edit (reverts the live preview, no undo unit) and
   * exits edit mode. */
  cancelTextEdit() {
    this.transientPreview = null; // the whole preview is about to go; no need to revert it first
    this.textEditing = null;
    this.cancelPreview();
  }

  /**
   * [ROUND 15.2] Command. The ONE dismissal decision every "something else
   * happened mid-edit" gate calls (Esc, click-away, selectMany, the
   * slideIndex/selection accessors, mode→present, deleteSelection/
   * purgeSelection on the edited item): commit if the edited item still
   * EXISTS on the current slide (one undo unit, same as Esc — manifest:
   * "Keep the one-undo-unit commit semantics"), else cancel (nothing to
   * commit — the item is gone, e.g. purged or deactivated mid-edit). A no-op
   * when nothing is being edited, so every call site can call it
   * unconditionally without its own `if (app.textEditing)` guard.
   */
  dismissTextEdit() {
    if (!this.textEditing) return;
    const stillExists = !!this.state().items?.[this.textEditing.itemId];
    if (stillExists) this.commitTextEdit();
    else this.cancelTextEdit();
  }

  /** [ROUND 15.2] Command. Enters fullscreen presenter mode, dismissing any
   * live WYSIWYG text edit first (manifest: "presenter entry ... must all
   * commit ... never strand the overlay" — PresentMode has no canvas/overlay
   * DOM at all, so an un-dismissed edit would simply vanish with no exit
   * path). The one `mode = "present"` write site (the palette/toolbar
   * "Present" command) routes through here instead of writing `mode` bare. */
  enterPresentMode() {
    this.dismissEdit();
    this.exitCanvasMode(); // same reason: the presenter has no canvas for a mode to own
    this.mode = "present";
  }

  // ── WYSIWYG LaTeX editing (MathLive overlay) ───────────────────────────────
  // Mirrors the text lifecycle (begin/preview/commit/cancel/dismiss) but with a
  // canvas-SUPPRESSION + DOM-overlay model instead of canvas-as-truth (MathJax
  // has no caret to self-draw from — see latexEditing's doc).

  /** Command. Enters in-place edit on a latex item: selects it (Inspector
   * reflects it) and sets `latexEditing`. CanvasView suppresses the canvas
   * equation and mounts the LatexEditController `<math-field>` at its world
   * pose. No-op if already editing this item. */
  beginLatexEdit(itemId) {
    if (this.latexEditing?.itemId === itemId) return;
    this.selection = itemId;
    this.latexEditing = { itemId };
  }

  /** Command. Live-stages the edited latex string into previewDelta (so the
   * Inspector `latex` row reflects live and commit keyframes it as one undo
   * unit). The canvas equation is suppressed during edit, so this does NOT
   * re-typeset the canvas per keystroke — the visible math is the DOM field
   * itself (the no-jank rule: MathJax runs once, on commit). */
  previewLatexValue(latex) {
    if (!this.latexEditing || this.latexEditing.closing) return;
    this.setPreview([[["items", this.latexEditing.itemId, "latex"], latex]]);
  }

  /** Command. Commits the edit as ONE undo unit and enters the CLOSING phase.
   * commitPreview keyframes the final latex + clears previewDelta; setting
   * `closing:true` UN-suppresses the canvas equation (paint() stops skipping
   * it) so the freshly re-typeset MathJax render appears BENEATH the still-
   * mounted MathLive field, which the controller then fades out — a true
   * crossfade that masks the KaTeX↔tex-svg glyph pop. The un-suppress itself
   * fires the emit() → ensureLatexTypeset for the new value (no separate pre-
   * warm needed); the fade gives it time to land. finishLatexEdit unmounts. */
  commitLatexEdit() {
    const editing = this.latexEditing;
    if (!editing || editing.closing) return;
    if (this.previewDelta) this.commitPreview();
    this.latexEditing = { itemId: editing.itemId, closing: true };
  }

  /** Command. Ends the closing crossfade — unmounts the controller. Called by
   * LatexEditController when its fade-out transition completes. */
  finishLatexEdit() {
    this.latexEditing = null;
  }

  /** Command. Cancels the edit (drops the live preview, no undo unit) and exits
   * immediately (no crossfade — nothing changed on the canvas). */
  cancelLatexEdit() {
    this.latexEditing = null;
    this.cancelPreview();
  }

  /** Command. The latex twin of dismissTextEdit: the ONE decision every mid-edit
   * boundary calls — commit if the edited item still exists (one undo unit),
   * else cancel. No-op when not editing or already closing (so a second dismiss
   * during the fade is inert). */
  dismissLatexEdit() {
    if (!this.latexEditing || this.latexEditing.closing) return;
    const stillExists = !!this.state().items?.[this.latexEditing.itemId];
    if (stillExists) this.commitLatexEdit();
    else this.cancelLatexEdit();
  }

  /** Query. The itemId of whichever in-place edit (text OR latex) is active, or
   * null. The ONE thing every "selection/slide/mode changed mid-edit" guard
   * reads so it need not know which editor is open. */
  get editingItemId() {
    return this.textEditing?.itemId ?? this.latexEditing?.itemId ?? null;
  }

  /** Command. Dismisses whichever in-place edit (text or latex) is active — the
   * single gate slide-switch / selection-change / present-entry / delete /
   * purge all call. Each dismiss is a no-op when its editor isn't open, so this
   * is safe to call unconditionally. */
  dismissEdit() {
    this.dismissTextEdit();
    this.dismissLatexEdit();
  }

  // ── WYSIWYG code editing (multi-line CodeEditController overlay) ────────────
  // The code-property analog of the latex lifecycle (begin/preview/commit/
  // cancel/dismiss) — a canvas-SUPPRESSION + DOM-overlay model. `codeEditing` =
  // { itemId, property, language } (or { …, closing:true } during the exit
  // crossfade). `property` names WHICH multi-line string is edited ("definition"
  // for mermaid, "code" for codeblock); `language` drives the editor's syntax
  // highlighting. The canvas render of the item is SUPPRESSED while editing (see
  // CanvasView paint()), so the string stages into previewDelta with NO
  // per-keystroke re-render; `closing:true` un-suppresses it so the freshly
  // re-rendered content appears beneath the fading editor panel. APPENDED as a
  // self-contained section (new field + new methods; no existing method touched)
  // per the concurrent-edit constraint. dismissCodeEdit is reached from
  // App.svelte's click-away and the controller's Escape/⌘⏎.

  /** { itemId, property, language } while a widget's code string is edited in
   * place (or { …, closing:true } during the exit crossfade), else null. A
   * reactive $state field (CanvasView's codeEditNode + the paint suppression
   * both derive from it), exactly like `latexEditing`. */
  codeEditing = $state(null);

  /** Command. Enters in-place code edit on a widget's `property` string: closes
   * any other in-place edit, selects the item, and sets `codeEditing`.
   * CanvasView suppresses the item's canvas render and mounts the
   * CodeEditController. No-op if already editing this item+property. */
  beginCodeEdit(itemId, property, language = null) {
    if (this.codeEditing?.itemId === itemId && this.codeEditing?.property === property) return;
    this.dismissTextEdit();  // close any other in-place editor first (no-op if none)
    this.dismissLatexEdit();
    this.selection = itemId;
    this.codeEditing = { itemId, property, language };
  }

  /** Command. Live-stages the edited string into previewDelta (Inspector
   * reflects live; commit keyframes it as one undo unit). The canvas render is
   * suppressed during edit, so this does NOT re-render the item per keystroke —
   * it re-renders once on commit (the no-jank rule). No-op while closing. */
  previewCodeValue(value) {
    if (!this.codeEditing || this.codeEditing.closing) return;
    this.setPreview([[["items", this.codeEditing.itemId, this.codeEditing.property], value]]);
  }

  /** Command. Commits the edit as ONE undo unit and enters the CLOSING phase:
   * commitPreview keyframes the staged string; setting `closing:true`
   * un-suppresses the item's canvas render (which re-emits → re-renders the new
   * value) beneath the still-mounted editor panel, which the controller fades
   * out. finishCodeEdit unmounts. */
  commitCodeEdit() {
    const editing = this.codeEditing;
    if (!editing || editing.closing) return;
    if (this.previewDelta) this.commitPreview();
    this.codeEditing = { ...editing, closing: true };
  }

  /** Command. Ends the closing crossfade — unmounts the controller. Called by
   * CodeEditController when its fade-out transition completes. */
  finishCodeEdit() {
    this.codeEditing = null;
  }

  /** Command. Cancels the edit (drops the live preview, no undo unit) and exits
   * immediately. Also the controller's forced-unmount safety (item left the
   * slide mid-edit) so no dangling previewDelta survives. */
  cancelCodeEdit() {
    this.codeEditing = null;
    this.cancelPreview();
  }

  /** Command. The code twin of dismissLatexEdit: commit if the edited item
   * still exists (one undo unit), else cancel. No-op when not editing or already
   * closing (so a second dismiss during the fade is inert). */
  dismissCodeEdit() {
    if (!this.codeEditing || this.codeEditing.closing) return;
    const stillExists = !!this.state().items?.[this.codeEditing.itemId];
    if (stillExists) this.commitCodeEdit();
    else this.cancelCodeEdit();
  }

  // ── Full-screen code-editor MODAL (Monaco; ROUND 2 #32/#33) ────────────────
  // The REUSABLE 90vw×90vh Monaco editor for any widget property that is "a lot of
  // code" (Mermaid `definition`, LaTeX `latex`, …). Unlike the inline
  // CodeEditController overlay it needs NO node pose, NO canvas suppression and NO
  // crossfade — it covers the canvas — so this is a deliberately tiny lifecycle,
  // NOT a second copy of the codeEditing seam: open names the target, commit writes
  // it as ONE undo unit through the universal setPreview→commitPreview path, close
  // drops it.
  //
  // `codeModal` names its target in ONE of two SCOPES:
  //   { scope: "item", itemId, property, language, title }  a widget's string leaf
  //   { scope: "document", property, language, title }      a doc.meta field
  // The DOCUMENT scope exists for THE PROJECT SCRIPT (doc.meta.script — the
  // per-project JavaScript library every equation can call). It is a second SCOPE
  // rather than a second modal lifecycle on purpose: the dialog, the Monaco wiring,
  // the Escape/Cmd+Enter contract and the "one undo unit on save" rule are identical
  // in both cases, and the only thing that differs is which path the value is
  // written to. A parallel lifecycle would be two of everything above, kept in sync
  // by hand — the mirror hazard this codebase pays for wherever it appears.

  /** The open Monaco modal's target (see the SCOPES note above), else null. A
   *  reactive $state field App.svelte mounts CodeEditorModal off. */
  codeModal = $state(null);

  /** Command. Opens the full-screen code editor on an item's multi-line string
   *  property. Selects the item so the rest of the UI reflects it. No-op if that
   *  same item+property is already open.
   *  @param {string} itemId
   *  @param {string} property - which string leaf to edit ("definition", "latex", …)
   *  @param {{language?: string|null, title?: string}} opts */
  openCodeModal(itemId, property, opts = {}) {
    if (this.codeModal?.itemId === itemId && this.codeModal?.property === property) return;
    this.selection = itemId;
    this.codeModal = { scope: "item", itemId, property, language: opts.language ?? null, title: opts.title ?? "Edit code" };
  }

  /** Command. Opens the full-screen code editor on THE PROJECT SCRIPT
   *  (doc.meta.script) — the per-document JavaScript library whose exports every
   *  property equation can call (core/project_script.js). No-op when it is already
   *  open, so a second click on the toolbar icon does not reseed the buffer and
   *  discard what the user has typed.
   *
   *  Does NOT touch the selection: the script belongs to the document, not to
   *  whatever widget happened to be selected when it was opened. */
  openProjectScript() {
    if (this.codeModal?.scope === "document" && this.codeModal?.property === "script") return;
    this.codeModal = {
      scope: "document", property: "script", language: "javascript",
      title: "Project script — functions and values every equation can use",
    };
  }

  /** Query. The value the open code modal is editing (an item's string leaf, or a
   *  doc.meta field), or "" when nothing is open. The modal seeds its buffer from
   *  this ONCE; the ONE place that maps a target to its stored source, so the read
   *  and the write below cannot address different things.
   *
   *  Reads the RAW stored value (rawState / doc.meta), never the evaluated one: a
   *  code source is source, and an evaluated read would hand the editor a
   *  script's or diagram's *result* to edit. */
  codeModalValue() {
    const t = this.codeModal;
    if (!t) return "";
    // An ASSET's source is not in the document at all: openPluginAssetCode already
    // awaited the bytes and put them on the target, so the seed is a field read
    // rather than a state read. That is the whole reason the open is async.
    if (t.scope === "asset") return t.source ?? "";
    if (t.scope === "document") return this.doc.meta[t.property] ?? "";
    return this.rawState().items?.[t.itemId]?.[t.property] ?? "";
  }

  /** Command. Commits the edited source as ONE undo unit and closes the modal. An
   *  ITEM target goes through the universal setPreview→commitPreview path every
   *  property edit uses; a DOCUMENT target commits a new doc.meta straight through
   *  `commit` — so it lands in the global undo stack and marks the document dirty
   *  for the save indicator. (renameProject deliberately does NOT come through
   *  here: renaming MOVES storage, which an undo cannot reverse — see its
   *  docblock.) A no-op when nothing is open. */
  commitCodeModal(value) {
    const t = this.codeModal;
    if (!t) return;
    // An ASSET save is a FILE WRITE plus a registry rebuild, not a document commit —
    // async, and with no undo unit to make (see the scope's note). Routed here so
    // CodeEditorModal's single `onsave` serves all three scopes.
    if (t.scope === "asset") return this.commitPluginAssetCode(value);
    if (t.scope !== "document") {
      this.setPreview([[["items", t.itemId, t.property], value]]);
      this.commitPreview();
      this.codeModal = null;
      return;
    }
    this.commit({ ...this.doc, meta: { ...this.doc.meta, [t.property]: value } });
    // THE COMMIT HAPPENS EITHER WAY — a script that will not compile is still the
    // author's work, and discarding it on Save (or refusing the save) would lose it.
    // What a failure changes is whether the DIALOG closes: evalInfo() forces the
    // derivation pass that compiles the new source (it is memoized, so this is the
    // same pass the canvas is about to do, not an extra one), and if that pass has a
    // verdict against it the modal STAYS OPEN with the message in its footer. Closing
    // on a broken script would put the error only in the console, behind the dialog
    // the author was looking at — which is how a loud failure becomes a quiet one.
    this.evalInfo();
    if (!this.projectScriptError()) this.codeModal = null;
  }

  /** Command. Closes the modal WITHOUT committing (Cancel / Esc / backdrop). */
  closeCodeModal() {
    this.codeModal = null;
  }

  // ── THE THIRD SCOPE: a PLUGIN ASSET's JavaScript (user ruling: "If I double
  // click a plugin, it should let me edit the JavaScript inside of it") ────────
  // A *.plugin.js asset is a whole WIDGET TYPE delivered as a file
  // (core/plugin_assets.js). Editing it is therefore NOT a document edit at all,
  // which is the one thing that makes this scope genuinely different from the other
  // two rather than a third copy of them:
  //
  //   - THE VALUE LIVES IN THE ASSET STORE, not in doc.json. So the buffer is read
  //     ASYNCHRONOUSLY before the dialog opens (openPluginAssetCode awaits the
  //     bytes and seeds `source` into the target), and Save writes back through
  //     assetStore().put — the same adapter-blind seam pluginAssetLoader reads
  //     through, so this works identically against the Python backend and against
  //     IndexedDB in static mode. That was an explicit requirement.
  //   - THERE IS NO UNDO UNIT. The global undo stack holds documents; an asset's
  //     bytes are not in one. Save is a file write, and it says so.
  //   - SAVING RE-REGISTERS THE WIDGET. reloadPluginAssets rebuilds the registry
  //     from the built-in roster plus the project's assets, so every instance of
  //     the edited type re-renders from the new code without a page reload. Without
  //     that, the author would edit a file and see nothing change — the failure
  //     mode this ruling exists to remove.
  //   - A SOURCE THAT WILL NOT COMPILE KEEPS THE MODAL OPEN, with the reason in the
  //     footer. That is the PROJECT-SCRIPT convention, and it matters more here:
  //     a refused plugin asset does not merely fail to run, it makes every item of
  //     its type an ORPHAN that the repair pass would drop on the next load
  //     (pluginAssetLoader's header). So the check runs BEFORE the write, and a
  //     broken source is never stored at all.
  //
  // ── A BUILT-IN IS NOT A PROJECT ASSET (the 404 this pass fixed) ──────────────
  // The Asset Explorer's "show built-ins" toggle lists the shipped widget library
  // (web/builtinAssets.js) in the SAME grid as the project's own files, and every
  // method here used to resolve a tile's name against the project's asset store.
  // So double-clicking clock_digital.plugin.js threw
  //   httpAssetStore.get(RobotSim, clock_digital.plugin.js): 404
  // — the file is bundled INSIDE THE APP and has never been in any project folder.
  // A built-in tile is now a distinct ORIGIN, not a project filename:
  //
  //   READ comes from the built-in catalog (`source` is already in hand on the
  //   listing entry — no I/O at all), never from the store.
  //   THE EDITOR OPENS READ-ONLY, with a visible note saying so. Editing in place is
  //   not a thing that could work: the bytes live in the JS bundle, and the next
  //   `npm run build` would overwrite anything we pretended to save.
  //   SAVE WRITES A COPY into the current project (a collision-safe FILENAME via
  //   uniquePluginAssetName), which is the outcome the user actually wants —
  //   "start from the shipped widget and change it".
  //
  // THE COPY IS RETYPED, because a verbatim one would be DEAD ON ARRIVAL. The
  // loader's rule is explicit: "a plugin asset may not shadow a built-in widget or
  // another asset" (core/plugin_assets.loadPluginAsset). So a byte-identical copy of
  // clock_digital.plugin.js — still declaring `type: "clock_digital"` — is REFUSED at
  // registration: it would be stored, listed and thumbnailed while silently not being
  // a widget, with the reason only in a console report. A distinct FILENAME does not
  // help, because the collision is on TYPE. (Verified, not assumed: registering a
  // verbatim copy reports 'type "clock_digital" is already registered'.)
  //
  // So the copy gets a free type (`clock_digital_2`, via uniquePluginType) applied by
  // core/plugin_assets.retypedPluginSource — which WRAPS the original body rather than
  // rewriting its text, because `type:` appears at least twice in every library source
  // and also inside comments and strings. The author's code is not touched.
  // The copy is VALIDATED BEFORE IT IS WRITTEN, like every other plugin-asset save, so
  // a refusal keeps the modal open instead of leaving a dead file in the library.
  //
  // That is why `codeModal` for this scope carries `builtin` and `readOnly`: the
  // dialog must both refuse in-place editing AND explain what Save will do instead.

  /** The last plugin-asset save's refusal message (null = none). Reactive so
   *  CodeEditorModal's `problem` footer shows it the moment Save is refused. */
  pluginAssetError = $state(null);

  /** Query (pure over the bundled library). One BUILT-IN widget library entry by
   *  filename, or null when the name is not in the library. The predicate that
   *  decides "is this tile a built-in?" — kept in one place so the read, the
   *  read-only flag and the copy-on-save branch cannot disagree about it. */
  builtinPluginAsset(filename) {
    return builtinWidgetAssets().find((a) => a.name === filename) ?? null;
  }

  /** Query (asset store, EXCEPT for a built-in). Read one plugin asset's source
   *  text. A BUILT-IN's source is already in the bundled catalog entry, so it is
   *  returned directly and the store is never asked — asking it is precisely the
   *  404 this pass fixed (see the block header). A PROJECT asset goes through the
   *  storage seam as before. Separate from openPluginAssetCode so a probe/test can
   *  read the bytes without opening a dialog. */
  async pluginAssetSource(filename, project = this.projectName()) {
    const builtin = this.builtinPluginAsset(filename);
    if (builtin) return builtin.source;
    const blob = await assetStoreFor(project).get(project, filename);
    return blob.text();
  }

  /**
   * Command (async; opens the modal). Open the Monaco editor on a `*.plugin.js`
   * asset's JavaScript. Reads the bytes FIRST and only then opens, so the dialog
   * never appears around an empty buffer that later fills in and clobbers typing.
   *
   * A BUILT-IN opens READ-ONLY, with a note saying that Save copies it into this
   * project — its bytes are in the app bundle and cannot be edited in place (see
   * the block header). A PROJECT asset opens editable, exactly as before.
   *
   * Refuses a non-plugin filename loudly rather than opening a JavaScript editor
   * on a PNG. A read failure is re-thrown for the caller to surface in the pane's
   * own error line (the Asset Explorer's `error`), which is where every other
   * asset failure in that pane already appears.
   *
   * @param {string} filename - e.g. "gear.plugin.js"
   * @param {string} [project] - defaults to the current project
   */
  async openPluginAssetCode(filename, project = this.projectName()) {
    if (!isPluginAssetName(filename))
      throw new Error(`openPluginAssetCode: "${filename}" is not a plugin asset (expected a name ending in "${PLUGIN_ASSET_SUFFIX}")`);
    const builtin = !!this.builtinPluginAsset(filename);
    const source = await this.pluginAssetSource(filename, project);
    this.pluginAssetError = null;
    this.codeModal = {
      scope: "asset", property: "source", filename, project, source, builtin,
      // READ-ONLY is the built-in's whole point here: Monaco must refuse the edit
      // rather than accept keystrokes into a buffer whose Save cannot write back to
      // where they came from.
      readOnly: builtin,
      language: "javascript",
      note: builtin ? BUILTIN_PLUGIN_EDIT_NOTE : null,
      title: builtin
        ? `${filename} — built-in widget source (read-only)`
        : `${filename} — widget source (saving re-registers it live)`,
    };
  }

  /**
   * Command (async; writes an asset, rebuilds the registry). Save an edited plugin
   * asset. VALIDATES FIRST against the types registered by everything EXCEPT this
   * asset — so re-saving a plugin does not refuse itself for colliding with its own
   * already-registered type, while a rename onto `rect` still is refused.
   *
   * On a refusal: nothing is written, `pluginAssetError` carries the reason, and the
   * modal stays open (App.svelte feeds it to the footer). On success: the bytes are
   * stored, the registry is rebuilt so live instances re-render, and the dialog
   * closes.
   */
  async commitPluginAssetCode(source) {
    const t = this.codeModal;
    if (!t || t.scope !== "asset") return;
    // A BUILT-IN's Save is a COPY-INTO-THIS-PROJECT, not a write-back: its bytes
    // are in the app bundle (see the block header). Routed out first so none of the
    // replace-in-place logic below can run against a file no project owns.
    if (t.builtin) return this.copyBuiltinPluginAssetIntoProject(source);
    const taken = new Set(this.registry.all().map((p) => p.type));
    // Whatever type THIS asset currently declares is not a collision with itself.
    try {
      const current = loadPluginAsset(t.source, t.filename, new Set());
      taken.delete(current.type);
    } catch {
      // The STORED source is already broken (that is likely why it is being edited),
      // so it registered nothing and reserves no type. Not a silent swallow: the
      // only information this branch discards is "the old source was invalid too",
      // which changes nothing about validating the NEW one below — and the NEW
      // source's own verdict is reported either way.
    }
    try {
      loadPluginAsset(source, t.filename, taken);
    } catch (e) {
      this.pluginAssetError = String(e?.message ?? e);
      console.error(`commitPluginAssetCode: refused to save "${t.filename}" —`, e);
      return; // modal stays open with the reason in its footer
    }
    this.pluginAssetError = null;
    // REPLACE, NOT PUT. `put` is the add-a-file verb and DE-COLLIDES a taken name,
    // so saving an edit through it wrote "gear-2.plugin.js" and left the edited file
    // untouched: the dialog closed, the widget did not change, and the library grew a
    // numbered copy per save. `replace` overwrites in place and is LOUD if the asset
    // has gone (web/assetStore.js).
    await assetStoreFor(t.project).replace(t.project, new Blob([source], { type: "text/javascript" }), t.filename);
    // Re-register: the registry is per-project and REBUILT, never mutated in place
    // (reloadPluginAssets' header explains why), so every instance of the edited
    // type derives from the new code on the next pass.
    await this.reloadPluginAssets(t.project);
    this.assetsVersion++; // the Asset Explorer re-lists (size/mtime changed)
    this.codeModal = null;
  }

  /**
   * Command (async; writes a NEW asset, rebuilds the registry). Save-from-a-built-in:
   * write `source` into the CURRENT project as a new plugin asset and register it.
   * See the block header for why a built-in cannot be saved in place and why the copy
   * must be retyped.
   *
   * Three things are made collision-safe, in this order, because each depends on the
   * previous one being settled:
   *   1. THE FILENAME, against the project's existing assets (uniquePluginAssetName —
   *      suffix-aware, so the copy is still a `*.plugin.js`).
   *   2. THE TYPE, against every type currently registered (uniquePluginType). This is
   *      the one that actually decides whether the copy is a widget at all.
   *   3. THE SOURCE, retyped to match (retypedPluginSource).
   *
   * Then it VALIDATES before writing — same rule as an ordinary plugin-asset save: a
   * refusal leaves nothing behind and keeps the modal open with the reason in its
   * footer. On success the copy is stored, the registry is rebuilt so the new widget is
   * immediately insertable, and the dialog closes.
   */
  async copyBuiltinPluginAssetIntoProject(source) {
    const t = this.codeModal;
    const project = this.projectName();
    const existingNames = (await assetStoreFor(project).list(project)).map((a) => a.name);
    const filename = uniquePluginAssetName(t.filename, existingNames);
    const taken = new Set(this.registry.all().map((p) => p.type));
    // The built-in's own type is the BASE to number from, read from the source the
    // dialog was seeded with rather than from a name-derived guess.
    let baseType;
    try {
      baseType = loadPluginAsset(t.source, t.filename, new Set()).type;
    } catch (e) {
      // The BUILT-IN's own stored source does not load. That is an app-integrity
      // failure, not a user error, and it must not be papered over into a confusing
      // copy: report it and refuse.
      this.pluginAssetError = `the built-in "${t.filename}" does not load, so it cannot be copied: ${e?.message ?? e}`;
      console.error(`copyBuiltinPluginAssetIntoProject: built-in "${t.filename}" failed to load —`, e);
      return;
    }
    const newType = uniquePluginType(baseType, taken);
    const retyped = retypedPluginSource(source, newType);
    try {
      loadPluginAsset(retyped, filename, taken);
    } catch (e) {
      this.pluginAssetError = String(e?.message ?? e);
      console.error(`copyBuiltinPluginAssetIntoProject: refused to copy "${t.filename}" as "${filename}" —`, e);
      return; // modal stays open with the reason in its footer
    }
    this.pluginAssetError = null;
    // PUT, not replace: this is a NEW file in the library (the add-a-file verb), the
    // exact opposite of the edit-in-place case above. The name is already de-collided,
    // so put's own de-collision has nothing left to do.
    await assetStoreFor(project).put(project, new Blob([retyped], { type: "text/javascript" }), filename);
    await this.reloadPluginAssets(project);
    this.assetsVersion++; // the Asset Explorer re-lists (a new tile appears)
    this.codeModal = null;
    return { filename, type: newType };
  }

  // ── Item operations ────────────────────────────────────────────────────────

  addItem(defaults) {
    const zs = this.nodes().map((n) => n.state.z ?? 0);
    // active:true is keyframed explicitly ON the creation slide — the
    // manifest's visibility model: everything defaults invisible; creation is
    // where visibility switches on, so objects appear at their own slide.
    const state = { ...defaults, active: true, z: (zs.length ? Math.max(...zs) : 0) + 1 };
    const [doc, id] = withNewItem(this.doc, this.slideIndex, state);
    this.commit(withNormalizedZ(doc));
    this.selection = id;
    // NO WIDGET TYPE IS NAMED HERE, deliberately. The one that used to be — 14.3's
    // "a fresh empty filmstrip auto-opens its video picker" — is a CREATION
    // behaviour, so the filmstrip now declares `placement: "bbox_then_asset"` and
    // web/widget_handlers.js owns it. Reading a type name in addItem made the prompt
    // fire on every route in (paste, duplicate, a rig builder), not on the placement
    // gesture 14.3 actually described.
  }

  /**
   * Command (one undo unit). Assembles the TELESCOPIC MAGNIFIER rig — a
   * "zoom-into-this" detail-loupe callout — as THREE items wired by `=`
   * equations to a shared tween VARIABLE `t` (default 0):
   *   1. a SOURCE MARKER outline filling the `source` rect (the region magnified),
   *   2. a demo_magnify LENS that samples the source centre and, as t→1, pulls
   *      out to the `lens` rect + grows + zooms (identity at t=0), and
   *   3. a TANGENT-LINES widget whose two shapes track the source and the lens.
   * The user animates the rig by keyframing / binding the `t` variable (e.g.
   * `= time`). shapeKind ∈ {"circle","box"} proves the geometry is general.
   * Items are created source→lens→tangent so every `@id` reference is BACKWARD
   * (points at an already-created item) — no dangling refs. Each item spreads
   * its plugin's registry defaults FIRST, then the builder's equation overrides,
   * so the rig loads with zero missing-default repairs. z: lens lowest of the
   * three (so it samples only the backdrop below, not its own callout), then
   * the tangents, then the source marker on top. Selects the lens.
   *
   * THE TWO RECTS ARE THE GESTURE (#189: "I first click and drag to create the
   * first one and then I click and drag again to create the second one"), supplied
   * by the telescopic_rig creation mode. Omitting them falls back to
   * telescopicDefaultRects() — the drop-in-place geometry the constants describe —
   * so the palette entry, a script, and the gesture all go through this one command.
   *
   * @param {"circle"|"box"} shapeKind - the source/lens/tangent geometry family
   * @param {{x,y,w,h}} [source] - world rect of the region magnified
   * @param {{x,y,w,h}} [lens] - world rect the lens occupies at t = 1
   */
  insertTelescopicMagnifier(shapeKind = "circle", source = null, lens = null) {
    const rects = telescopicDefaultRects();
    const sourceRect = source ?? rects.source;
    const lensRect = lens ?? rects.lens;
    // 1. the shared tween parameter — a document variable, default 0, on the
    //    current slide. All rig motion is a function of it (bind it to = time).
    let doc = keyframed(this.doc, this.slideIndex, ["vars", TELESCOPIC.TWEEN_VAR], 0);
    const zs = this.nodes().map((n) => n.state.z ?? 0);
    const baseZ = (zs.length ? Math.max(...zs) : 0) + 1; // above all existing content
    const withDefaults = (overrides, z) => ({ ...this.registry.get(overrides.type).defaults, ...overrides, active: true, z });
    // 2. SOURCE marker (no refs) — created first so the lens/tangents can point
    //    back at it. z on TOP so the loupe never magnifies its own marker.
    const sourceOv = telescopicSourceOverrides({ shapeKind, source: sourceRect });
    let sourceId;
    [doc, sourceId] = withNewItem(doc, this.slideIndex, withDefaults(sourceOv, baseZ + 2));
    // 3. LENS (refs the source) — lowest of the three so it samples only the
    //    backdrop drawn below it.
    const lensOv = telescopicLensOverrides({ sourceId, shapeKind, source: sourceRect, lens: lensRect });
    let lensId;
    [doc, lensId] = withNewItem(doc, this.slideIndex, withDefaults(lensOv, baseZ));
    // 4. TANGENT lines (ref both) — between the lens and the marker in z.
    const tangentOv = telescopicTangentOverrides({ sourceId, lensId, shapeKind });
    [doc] = withNewItem(doc, this.slideIndex, withDefaults(tangentOv, baseZ + 1));
    this.commit(withNormalizedZ(doc));
    this.selection = lensId;
  }

  // ── INK BOUNDS: fit the property box to what is actually drawn ─────────────

  /**
   * Query. The selected items whose PROPERTY BOX disagrees with what they
   * actually occupy — i.e. the ones "Set size to ink bounds" would change. Both
   * the command's gate and its worklist, so the gate can never claim a change
   * the run would not make.
   *
   * TWO KINDS OF DISAGREEMENT, because the two kinds of widget mean different
   * things by "actual size":
   *   · A GROUP's actual size is its members' collective world AABB. A group's
   *     box goes stale the moment a member moves — nothing re-derives it, by
   *     design (a group is a flat membership parent, and its box is a captured
   *     pose, not a computed hull).
   *   · ANY OTHER BBOX WIDGET's actual size is its declared INK BOUNDS
   *     (core/view.js localBoundsOf) — for text, where the type really landed.
   *
   * @returns {object[]} [{node, rect}] — rect is the LOCAL box the node should take
   */
  #inkFitTargets() {
    return this.selectedNodes().flatMap((n) => {
      if (!n.plugin.capabilities.bbox) return [];
      const rect = n.type === "group" ? this.#groupMemberLocalAABB(n) : (n.plugin.localBounds?.(n.state) ?? null);
      if (!rect || (rect.w <= 0 && rect.h <= 0)) return []; // nothing drawn / no members: nothing to fit to
      const box = { x: 0, y: 0, w: n.state.w ?? 0, h: n.state.h ?? 0 };
      const same = rect.x === box.x && rect.y === box.y && rect.w === box.w && rect.h === box.h;
      return same ? [] : [{ node: n, rect }];
    });
  }

  /**
   * Query. A group's members' collective world AABB, expressed in the GROUP's
   * OWN LOCAL frame — the rect groupSelection would capture if you ungrouped and
   * regrouped right now (user: for a group the tool acts "like I ungrouped them
   * and then regrouped them again").
   *
   * WHY THE INVERSE TRANSFORM. groupSelection builds its box from member world
   * AABBs and then sets the group's x/y TO that origin with rotation 0, scale 1 —
   * so for a fresh group, world and local coincide and no mapping is visible. A
   * group that has since been MOVED, ROTATED or SCALED has a non-identity world,
   * and its stored w/h are local units the world then transforms. Writing a world
   * rect straight into local w/h would therefore double-count the group's own
   * transform. Mapping the world AABB's corners back through the inverse and
   * taking their AABB keeps the recapture correct at any pose — conservative
   * under rotation exactly as rotatedBBoxAABB is in the other direction.
   *
   * Null when the group has no members with bounds (an empty group has no hull).
   *
   * @param {object} groupNode - a derived node whose type is "group"
   * @returns {?{x: number, y: number, w: number, h: number}} local-frame AABB
   */
  #groupMemberLocalAABB(groupNode) {
    const ids = new Set(groupNode.state.members ?? []);
    const boxes = this.nodes().filter((n) => ids.has(n.itemId)).map(rotatedBBoxAABB).filter(Boolean);
    if (boxes.length === 0) return null;
    const minX = Math.min(...boxes.map((b) => b.x)), minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w)), maxY = Math.max(...boxes.map((b) => b.y + b.h));
    const inv = T.invert(groupNode.world);
    const corners = [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]].map(([x, y]) => T.apply(inv, x, y));
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
    const lx = Math.min(...xs), ly = Math.min(...ys);
    return { x: lx, y: ly, w: Math.max(...xs) - lx, h: Math.max(...ys) - ly };
  }

  /** Query. Would "Set size to ink bounds" change anything? The command's `when`. */
  canFitToInkBounds() {
    return this.#inkFitTargets().length > 0;
  }

  /**
   * Command (ONE undo unit). "Set size to ink bounds" — makes each selected
   * widget's PROPERTY BOX equal to what it actually occupies. The user asked for
   * a tool to "set size to. Physical boundary."
   *
   * WHAT IT WRITES, and why x/y move as well as w/h. An ink rect's ORIGIN need not
   * be the box origin, so fitting is not merely a resize: the box's local origin
   * shifts by the rect's local offset, and that shift must be mapped THROUGH the
   * node's world transform before it is added to the stored x/y, or a rotated or
   * scaled widget would jump. When the rect starts at the local origin (the text
   * case — ink grows down and right) the offset is zero and only w/h are written,
   * because unifyPairs drops any pair already holding its value.
   *
   * FOR A GROUP this is the ungroup-and-regroup the user described, and it also
   * rewrites `bind`. That is the part that would be easy to leave out and wrong to:
   * a group's influence on its members is measured as the delta from its BIND POSE
   * (core/derive.js), so re-capturing the box without re-capturing the bind would
   * make the group's own box change count as a transformation OF its members and
   * shove them across the slide. Re-binding at the new pose is exactly what makes
   * this "as if regrouped" — identity influence, members untouched, which is the
   * whole point of a recapture.
   *
   * ONE UNDO UNIT via setPreview/commitPreview, the same path unifySelection and
   * applyPreset use. No-op when nothing disagrees (reported, not silent) — an
   * empty commit would push an undo entry for a change nobody made.
   */
  fitSelectionToInkBounds() {
    const targets = this.#inkFitTargets();
    if (targets.length === 0) {
      reportAction("Set size to ink bounds: nothing selected has contents that leave its box — every selected box already matches what it holds. Nothing was changed.");
      return;
    }
    const pairs = [];
    for (const { node, rect } of targets) {
      // The box's local origin moves by (rect.x, rect.y); the STORED x/y are world
      // units, so that local offset is rotated/scaled through the node's own world
      // before it is applied. Computed ONCE — the group's bind below must land on
      // the SAME position the box does, and recomputing it would be two chances to
      // disagree. A zero offset (the text case: ink grows down and right from the
      // origin) leaves x/y exactly as they were.
      const o = T.apply(node.world, rect.x, rect.y);
      const origin = T.apply(node.world, 0, 0);
      const nx = (node.state.x ?? 0) + (o.x - origin.x);
      const ny = (node.state.y ?? 0) + (o.y - origin.y);
      pairs.push([["items", node.itemId, "x"], nx]);
      pairs.push([["items", node.itemId, "y"], ny]);
      pairs.push([["items", node.itemId, "w"], rect.w]);
      pairs.push([["items", node.itemId, "h"], rect.h]);
      // A GROUP re-binds at its new pose — see the docblock: without this the
      // recaptured box would read as a transformation of the members and shove
      // them across the slide, instead of being the no-op recapture the user
      // described ("like I ungrouped them and then regrouped them again").
      if (node.type === "group") {
        pairs.push([["items", node.itemId, "bind", "x"], nx]);
        pairs.push([["items", node.itemId, "bind", "y"], ny]);
        pairs.push([["items", node.itemId, "bind", "rotation"], node.state.rotation ?? 0]);
        pairs.push([["items", node.itemId, "bind", "scale"], node.state.scale ?? 1]);
      }
    }
    this.setPreview(pairs);
    this.commitPreview();
  }

  // ── Groups (manifest "GROUPS", rough draft — the armature-shaped parent) ────

  /**
   * Query. The itemIds that a Group Selection would make members: the current
   * selection, minus purgeable:false widgets (the camera never joins a group)
   * and minus items ALREADY in a group. Order = selection order.
   *
   * GROUPS THEMSELVES ARE NO LONGER EXCLUDED (#302). This used to carry
   * `if (type === "group") return false; // no group-of-groups (rough draft)`, so
   * selecting three groups greyed Group Selection out with nothing said. The user:
   * "i selected 3 groups. why can't i group them into a bigger group" — "make this
   * obviousness possible."
   *
   * REMOVING THE LINE ALONE WOULD HAVE SHIPPED A BROKEN PICTURE, which is why the
   * derivation was fixed first: measured with outer group O owning inner group I
   * owning a rect, moving O moved O and I and left the RECT BEHIND. core/derive.js
   * now orders groups outermost-first and reads each group's already-influenced
   * world, and memberOwnerGroups walks the chain for the expression pass.
   */
  #groupableSelection() {
    const membership = groupMembership(this.nodes());
    return this.selectedIds().filter((id) => {
      const type = this.state().items?.[id]?.type;
      if (!type) return false;
      const plugin = this.registry.get(type);
      if (plugin.capabilities.purgeable === false) return false; // camera
      if (membership.has(id)) return false; // already grouped
      return true;
    });
  }

  /** Query. Can the current selection be grouped? (≥2 groupable members — a
   * one-item group is inert, and PowerPoint requires two+ to group.) */
  canGroup() {
    return this.#groupableSelection().length >= 2;
  }

  /**
   * Command (one undo unit). "Group Selection" (manifest GROUPS): creates a
   * group widget whose bbox = the selection's collective world AABB and whose
   * `members` = the selected ids, capturing the group's creation transform as
   * its BIND POSE (bind = {x,y,rotation:0,scale:1} at the AABB origin — so the
   * group sits exactly at its bind pose the instant it is made and moves
   * nothing until the user transforms it; manifest "Bind state"). Members stay
   * STORED items (their deltas are untouched); the group's influence composes
   * onto their world transforms in the derivation stage. Selects the new group.
   * No-op (reported) with fewer than two groupable items.
   */
  groupSelection() {
    const members = this.#groupableSelection();
    if (members.length < 2) {
      console.warn("Group Selection: needs at least two groupable items (camera and already-grouped items are excluded) — nothing grouped.");
      return;
    }
    const boxes = this.selectedNodes()
      .filter((n) => members.includes(n.itemId))
      .map(rotatedBBoxAABB)
      .filter(Boolean);
    if (boxes.length === 0) {
      console.warn("Group Selection: selected items have no bounding box — nothing grouped.");
      return;
    }
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    const zs = this.nodes().map((n) => n.state.z ?? 0);
    // The group's own transform IS its bind pose at creation: x/y = AABB origin,
    // rotation 0, scale 1. Storing bind = the same params makes influence the
    // identity until the user moves the group (re-pose invariance).
    const state = {
      ...this.registry.get("group").defaults,
      x: minX, y: minY, w: maxX - minX, h: maxY - minY,
      rotation: 0, scale: 1,
      members: [...members],
      bind: { x: minX, y: minY, rotation: 0, scale: 1 },
      active: true,
      z: (zs.length ? Math.max(...zs) : 0) + 1,
    };
    const [doc, id] = withNewItem(this.doc, this.slideIndex, state);
    this.commit(withNormalizedZ(doc));
    this.selection = id;
  }

  /**
   * Command (one undo unit). "Ungroup" (manifest UNGROUP spec + Round 17.3): for
   * every SELECTED group, BAKES each member's group-influenced DERIVED world back
   * into numeric x/y/rotation/scale keyframes AT EVERY SLIDE the member exists
   * (ungroupBakeSlides — the change points where the member's own transform OR
   * the group's influence keyframes), then PURGES the group. All in one undo unit.
   * No-op (reported) when no group is selected.
   *
   * WHY PER-SLIDE (17.3, user: "when deleting a group, the things inside should
   * not move … in every place"): a member keyframed across slides, or a group
   * keyframed across slides, has a DIFFERENT influenced world per slide. Baking
   * only the CURRENT slide (the pre-17.3 behavior) left every OTHER slide with the
   * un-influenced stored transform, so members JUMPED off-current-slide. The
   * invariant: after ungroup, each member's WORLD is byte-identical to before on
   * EVERY slide. Between two consecutive change points the influenced world is
   * constant, so a keyframe at each change point reproduces it everywhere.
   *
   * Baking math (per slide i): the member's derived node.world at slide i already
   * includes the group influence at slide i. worldTransform pivots a rotated box
   * about its center, so we back-solve the stored x/y via stateXYForCenterPivotWorld
   * and write rotation/scale straight from node.world — worldTransform(baked@i)
   * then reproduces node.world@i exactly. Non-bbox members (no w/h) get x/y/rot/
   * scale written directly (their world is un-pivoted). Worlds are computed from
   * the ORIGINAL doc (group still present) BEFORE any keyframe is written, so a
   * bake never reads its own already-baked (double-counted) value.
   *
   * FLAGGED ROUGH-DRAFT LIMITATION (unchanged from the single-slide bake): the
   * back-solve assumes the member uses the default CENTER rotation pivot (the
   * `self.anchors.center` equation every normally-created item carries — the SAME
   * assumption the rotated-resize commit relies on). A member with a CUSTOM
   * NUMERIC rotationAnchor bakes with a small position drift; deferred.
   */
  /**
   * Command. SELECT INSIDE the selected group(s): replaces each selected group
   * in the selection with its own members, each selected in its own right, so
   * the Inspector's multi-selection intersection and per-member editing apply to
   * the things inside the box.
   *
   * User, 2026-08-02: "we need to select in group that will select all objects
   * that are in a group individually."
   *
   * IT CHANGES NOTHING BUT THE SELECTION, which is the whole distinction from the
   * neighbouring Ungroup: no keyframes are written, no bake happens, the group
   * still exists and still owns its members. Undo is not involved because the
   * document is untouched — pressing Escape or clicking the group re-selects it.
   *
   * ONE LEVEL PER INVOCATION and non-groups pass through untouched — see
   * core/bandselect.js expandGroupSelection for why (nested-group precedence is
   * out of scope elsewhere in the system, so flattening arbitrarily deep would
   * invent a semantics nothing else agrees to). Run it again to go deeper.
   *
   * The result goes through `selectMany`, so the group-and-members-never-both
   * invariant is enforced by the same one substrate every other multi-select
   * path uses — this method adds no second copy of that rule.
   */
  selectInsideGroup() {
    const membersOf = new Map(
      this.selectedNodes()
        .filter((n) => n.type === "group" && Array.isArray(n.state.members))
        .map((n) => [n.itemId, n.state.members]),
    );
    if (membersOf.size === 0) {
      console.warn("Select Inside Group: no group is selected — nothing to select into.");
      return;
    }
    this.selectMany(expandGroupSelection(this.selectedIds(), membersOf));
  }

  /**
   * Command. SELECT THE PARENT GROUP: replaces each selected group MEMBER with
   * the group that owns it — `selectInsideGroup`'s opposite direction.
   *
   * User, 2026-08-02: "'select parent group' should be a tool as well. It only
   * applies if it's a child of a group."
   *
   * Like its twin it writes NOTHING: only the selection changes, so there is
   * nothing to undo. A selected item with no parent group is left where it is
   * rather than dropped, so a mixed selection does not silently shrink.
   */
  /** Query. Is anything in the selection a MEMBER of a group — i.e. is there a
   *  parent to rise to? The `select-parent-group` command's gate, kept here
   *  beside `canGroup()` rather than inlined in App.svelte, because that file
   *  does not import groupMembership and a missing named import is SILENT in
   *  this build (it binds to undefined and ships). */
  canSelectParentGroup() {
    const membership = groupMembership(this.nodes());
    return this.selectedIds().some((id) => membership.has(id));
  }

  selectParentGroup() {
    const membership = groupMembership(this.nodes());
    if (!this.selectedIds().some((id) => membership.has(id))) {
      console.warn("Select Parent Group: nothing selected is inside a group.");
      return;
    }
    this.selectMany(selectParentGroups(this.selectedIds(), membership));
  }

  ungroupSelection() {
    const groups = this.selectedNodes().filter((n) => n.type === "group");
    if (groups.length === 0) {
      console.warn("Ungroup: no group is selected — nothing to ungroup.");
      return;
    }
    const origDoc = this.doc; // read every member world from the ORIGINAL (group-present) doc
    const freed = new Set();
    // 1. Compute the full bake (memberId → [{slide, x, y, rotation, scale}]) from
    //    the original doc, so no bake reads an already-written keyframe.
    const bakes = new Map();
    for (const g of groups) {
      for (const memberId of g.state.members ?? []) {
        if (bakes.has(memberId)) continue; // a member belongs to ONE group (no nested groups)
        const perSlide = [];
        for (const slide of ungroupBakeSlides(origDoc, memberId, g.itemId)) {
          const state = evaluateState(foldState(origDoc, slide, 1), this.registry, origDoc.meta.script ?? "").state;
          // THE PROJECT IS NOT OPTIONAL HERE, even though this call only wants a
          // member's WORLD TRANSFORM and never looks at a URL. deriveRenderTree's
          // third argument defaults to "", and resolveAssetRef THROWS on a
          // project-relative ref with no owning project — by design, because a
          // dead /asset/<nothing>/clip.mp4 masquerading as a corrupt file is the
          // worst possible diagnostic. So ungroup crashed outright on any group
          // holding a member with a relative asset ref (user: an mp4 named
          // Video_2026…mp4; "the group didn't seem to work"), and the geometry it
          // was actually asking for never got computed. Six of this app's seven
          // deriveRenderTree calls already passed projectName(); this was the one
          // that did not.
          const m = deriveRenderTree(state, this.registry, this.projectName()).find((n) => n.itemId === memberId);
          if (!m) continue; // member not active on this slide — nothing to bake there
          const world = m.world; // group-influenced (derivation stage) at THIS slide
          const w = m.state.w, h = m.state.h;
          const xy = (typeof w === "number" && typeof h === "number")
            ? stateXYForCenterPivotWorld(world, w, h) // undo the center-pivot re-parametrization
            : { x: world.x, y: world.y };
          perSlide.push({ slide, x: xy.x, y: xy.y, rotation: world.rotation, scale: world.scale });
        }
        bakes.set(memberId, perSlide);
        freed.add(memberId);
      }
    }
    // 2. Write every keyframe, then purge every group — one undo unit.
    let doc = origDoc;
    for (const [memberId, perSlide] of bakes)
      for (const { slide, x, y, rotation, scale } of perSlide) {
        doc = keyframed(doc, slide, ["items", memberId, "x"], x);
        doc = keyframed(doc, slide, ["items", memberId, "y"], y);
        doc = keyframed(doc, slide, ["items", memberId, "rotation"], rotation);
        doc = keyframed(doc, slide, ["items", memberId, "scale"], scale);
      }
    for (const g of groups) doc = withItemPurged(doc, g.itemId);
    this.commit(doc);
    // Select the freed members (the group is gone). Empty → deselect.
    this.selectMany([...freed]);
  }

  // ── Copy / paste / duplicate (manifest 14.10 AMENDED + 14.9) ────────────────
  // Whole-object by default; single properties via the palette submenu.
  // Clipboard payloads are tagged JSON: {powerrp_items: {sourceId: state}} or
  // {powerrp_props: {key: value}}.
  //
  // THE SELECTION IS THE UNIT (user: "i should be able to copy paste selections
  // of objects which right now I can't"). The payload carries EVERY selected
  // item's state KEYED BY ITS SOURCE ID, because the ids are what make a
  // SUBGRAPH clone possible: copying A and B where A references B must paste A'
  // referencing B', while a reference from A to some C that was NOT copied must
  // still point at C. core/document.js clonedItemStates is that boundary; the
  // source ids in this payload are its `idMap` key set. `powerrp_item`
  // (singular, one state, NO id) is the LEGACY payload shape and is still read —
  // see #readClipboardPayload.
  //
  // 14.10 AMENDED ARCHITECTURE (user verbatim: "u can copy it into the browser
  // cookie session thing in case i have two presentations open the server can
  // keep track of that. but my local clipboard, u can copy a rendered PNG of
  // that element ... pasting triggers the serverside clipboard"):
  //   COPY  → (1) the item JSON goes to the SERVER-SIDE clipboard, keyed by the
  //           browser session cookie (projectApi.setClipboard) — SHARED across
  //           two open presentations of the same browser; (2) a RENDERED PNG of
  //           the element at its pixel resolution goes to the OS clipboard.
  //   PASTE → reads the SERVER-SIDE clipboard (projectApi.getClipboard) and
  //           inserts the object. navigator.clipboard.readText is RETIRED for
  //           items — the whole permission saga (the old dead-paste bug: a
  //           silently-denied readText no-op'd the paste) is gone.
  // WHY the server, not the OS clipboard, for the item JSON: the OS clipboard
  // can't reliably carry an app's private JSON across tabs, and reading it needs
  // a permission browsers deny silently (the root cause of the paste-does-
  // nothing bug). The server keys the copy by session cookie, so a second open
  // presentation pastes it with zero permission prompts.
  //
  // DISAMBIGUATION (the canvas-clipboard round-trip): copying an element ALSO
  // puts a rendered PNG on the OS clipboard, so a plain Cmd+V's `paste` event
  // carries an image — OUR OWN render. Ctrl+V must recognize it as ours and
  // paste the ELEMENT, or a copied widget comes back as a flattened bitmap.
  //
  // HOW OWNERSHIP IS PROVEN — and the design error that was corrected here.
  // The original scheme hashed the PNG at copy time (`png_sig`) and compared
  // that hash to the pasted image's bytes. THAT PREMISE IS FALSE: the OS
  // pasteboard RE-ENCODES an image in transit (measured on macOS 2026-07-30, a
  // 581-byte PNG came back as 645 bytes), so the hashes never matched and every
  // real Ctrl+V took the "not ours → upload it" branch. That IS the user's bug
  // ("Cmd+V pasted it as an IMAGE sometimes"); the toolbar button looked correct
  // only because it never consulted the image at all.
  //
  // Ownership is therefore a LABEL, not a hash: every copy writes the custom
  // MIME POWERRP_CLIPBOARD_MIME beside the PNG, which the OS carries verbatim
  // because it transcodes pictures, not unknown flavors. A clipboard is ALSO
  // ours whenever the internal (server/mirror) clipboard simply holds a
  // pasteable payload — that disjunct is what makes Ctrl+V and the toolbar
  // button THE SAME ACTION. `png_sig` is still WRITTEN (old sessions' payloads
  // stay readable) but is no longer a gate — see pasteFromClipboard.

  /**
   * Query. The itemIds a clone (copy or Duplicate) covers: the selection,
   * expanded TRANSITIVELY through group membership so a selected group travels
   * with everything it controls. Exactly the #zOrderBlock rule (manifest 15.7,
   * "when i move a group to front or back it should move all elements in it
   * too"), applied to cloning for the same reason: a group's members ARE its
   * content, so a group cloned WITHOUT them would be a second group steering the
   * ORIGINAL items. Multi-root and cycle-safe (`seen`), matching flipTargetIds.
   *
   * Membership is read from the RAW folded state, not from derived nodes, so a
   * member that is merely HIDDEN on this slide (active: false) still travels —
   * a member left behind is exactly the double-steering case above.
   *
   * @param {string[]} ids - the roots (an id absent from this slide is dropped)
   * @returns {string[]} roots first, then the members they pulled in
   */
  #cloneSet(ids) {
    const items = this.rawState().items ?? {};
    const set = new Set();
    const visit = (id) => {
      if (set.has(id) || !items[id]) return;
      set.add(id);
      if (items[id].type === "group" && Array.isArray(items[id].members))
        for (const m of items[id].members) visit(m);
    };
    for (const id of ids) visit(id);
    return [...set];
  }

  /** Query. {sourceId: rawItemState} for `ids` — the payload body every clone
   *  path (copy, Duplicate) ships. RAW state: equations copy as equations, not
   *  their evaluated snapshots. Ids with no state on this slide drop out. */
  #cloneStates(ids) {
    const items = this.rawState().items ?? {};
    return Object.fromEntries(ids.filter((id) => items[id]).map((id) => [id, items[id]]));
  }

  /** Command (async). COPY the SELECTION (the canvas-clipboard COPY half).
   *  Renders the selection PNG FIRST so its signature can travel WITH the item
   *  JSON: writes {powerrp_items: {sourceId: rawState}, png_sig} to the SERVER-
   *  SIDE session clipboard (equations stay equations, source ids ride along so
   *  paste can reroute internal references), then writes that same PNG to the OS
   *  clipboard for pasting into other apps. A server-write failure aborts
   *  loudly (nothing to paste back); an OS-write failure is reported but not
   *  fatal (the internal paste still works). */
  async copySelection() {
    const items = this.#cloneStates(this.#cloneSet(this.selectedIds()));
    if (Object.keys(items).length === 0) return;
    // Render the OS-clipboard PNG first so its signature rides WITH the payload
    // (a camera-only selection has no bbox → null png, and no png_sig).
    const png = await this.#renderSelectionPng();
    const payload = { powerrp_items: items };
    if (png) payload.png_sig = imageSignature(png);
    const json = JSON.stringify(payload);
    // 1. An IN-BROWSER MIRROR of the payload, unconditionally. The server-side
    //    clipboard is the cross-tab authority, but with the backend down a paste
    //    used to find ONLY the OS-clipboard PNG and insert the selection as a
    //    flattened IMAGE widget (user-reported: "it pasted it as an image") —
    //    the mirror keeps the ELEMENT paste working offline. Quota/privacy-mode
    //    failures are reported, never swallowed.
    try {
      localStorage.setItem(CLIPBOARD_MIRROR_KEY, json);
    } catch (e) {
      console.error("Copy: could not write the in-browser clipboard mirror:", e.message);
    }
    // 2. Item JSON (+ signature) → the server-side session clipboard (cross-tab).
    //    Failure is loud but NOT fatal any more — the mirror covers this browser.
    //    SKIPPED ENTIRELY in static mode: there is no backend session to hold it,
    //    the mirror above already did the useful work, and a per-copy console
    //    error about an absent server would be noise, not a report. The bound is
    //    stated once by the static-mode notice (UNAVAILABLE_IN_STATIC.serverClipboard).
    if (!isStatic()) {
      try {
        await projectApi.setClipboard(json);
      } catch (e) {
        console.error("Copy: could not reach the server-side clipboard (cross-TAB paste needs the project server; this browser can still paste via the mirror):", e.message);
      }
    }
    // 3. Rendered PNG → the OS clipboard (for pasting into OTHER apps). Failure
    //    is reported, not fatal — the internal paste still works.
    if (png) await this.#writeImagePngToOs(png);
  }

  /** Command (async). Writes PNG `bytes` to the OS clipboard as image/png,
   *  PLUS the OWNERSHIP MARKER (POWERRP_CLIPBOARD_MIME) that tells a later
   *  Ctrl+V this clipboard is ours so it pastes the ELEMENT, not the bitmap.
   *  The marker — not the PNG's signature — is the authority, because the OS
   *  re-encodes images in transit and the signature therefore cannot survive
   *  (measured; see POWERRP_CLIPBOARD_MIME). Reports loudly (and no-ops) when
   *  the browser lacks the async image-write API (an insecure/older context) or
   *  when the write is denied — a copy must never fail silently, and there is no
   *  in-app fallback for a system image.
   *
   *  A browser that REJECTS the custom type (the `web ` prefix is not universally
   *  supported) must still get its PNG: the marker write is retried without it,
   *  loudly, since losing the marker only costs the fast path — the mirror and
   *  server clipboard still identify the copy. */
  async #writeImagePngToOs(bytes) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      console.warn("Copy: this browser has no Clipboard image-write API — the item is on the server clipboard (paste works), but no PNG was placed on the OS clipboard.");
      return;
    }
    const png = new Blob([bytes], { type: "image/png" });
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "image/png": png,
        // The marker's BODY is deliberately trivial: ownership is carried by the
        // TYPE's presence, so nothing here needs to survive or be parsed.
        [POWERRP_CLIPBOARD_MIME]: new Blob(["1"], { type: POWERRP_CLIPBOARD_MIME }),
      })]);
      return;
    } catch (e) {
      console.warn(`Copy: this browser refused the PowerRP ownership marker (${e.message}) — retrying with the PNG alone; Ctrl+V still pastes the element via the server clipboard / in-browser mirror.`);
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    } catch (e) {
      console.error("Copy: OS-clipboard image write was denied or failed (the item is still on the server clipboard — internal paste works):", e.message);
    }
  }

  async copyProperty(key) {
    if (!this.selection) return;
    const value = this.storedItemValue(this.selection, key.split(".")); // dotted keys = nested paths
    if (value === undefined) return;
    try {
      await projectApi.setClipboard(JSON.stringify({ powerrp_props: { [key]: value } }));
    } catch (e) {
      console.error("Copy Property: could not reach the server-side clipboard:", e.message);
    }
  }

  /** Query (async; reads the server). The parsed SERVER-SIDE clipboard payload
   *  ({powerrp_items[, png_sig]} or {powerrp_props}), or null when the clipboard
   *  is empty, unreachable, unparseable, or holds no PowerRP payload. Every
   *  failure is reported loudly; the null return distinguishes those cases for
   *  the caller (no OS-clipboard readText, no permission saga).
   *
   *  A LEGACY {powerrp_item: state} payload (one state, no source id — what a
   *  copy made before the selection became the unit, and what a session
   *  clipboard written by an older build still holds) is normalized to the
   *  current one-entry shape HERE, at the read boundary, so there is exactly ONE
   *  insert path below rather than a fork per payload era (the load-boundary
   *  migration pattern). Its synthetic key can never collide with a real
   *  reference: uuid() ids are 8 chars of hex/base36. */
  async #readClipboardPayload() {
    let raw;
    // Static mode has no server clipboard to read — go straight to this browser's
    // mirror, which is where every static-mode copy wrote. Not a fallback: it is
    // the ONLY store in this mode, and asking a nonexistent server first would
    // just log an error before doing the same thing.
    if (isStatic()) {
      raw = localStorage.getItem(CLIPBOARD_MIRROR_KEY);
      if (!raw) return null;
    } else try {
      raw = await projectApi.getClipboard();
    } catch (e) {
      // The server is the CROSS-TAB authority; unreachable, fall back to THIS
      // browser's mirror (written by every copy) so the element paste still
      // works — loudly, so the degraded mode is never invisible. Without this,
      // a paste with the backend down saw only the OS PNG and inserted the
      // selection as a flattened IMAGE widget.
      raw = localStorage.getItem(CLIPBOARD_MIRROR_KEY);
      console.error(`Paste: server-side clipboard unreachable (${e.message}) — ${raw ? "using this browser's clipboard mirror (cross-tab paste needs the project server)" : "and no in-browser mirror exists; nothing to paste internally"}.`);
      if (!raw) return null;
    }
    if (!raw) raw = localStorage.getItem(CLIPBOARD_MIRROR_KEY); // server empty (fresh session) but this browser copied before
    if (!raw) return null;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      console.error("Paste: the server clipboard held unparseable JSON:", e.message);
      return null;
    }
    if (payload?.powerrp_item && !payload.powerrp_items)
      payload = { ...payload, powerrp_items: { [LEGACY_CLIPBOARD_SOURCE_ID]: payload.powerrp_item } };
    if (!payload?.powerrp_items && !payload?.powerrp_props) {
      console.warn("Paste: the server clipboard holds no PowerRP item or property payload.");
      return null;
    }
    return payload;
  }

  /** Command (async). Paste the last-copied ELEMENT/property from the SERVER-
   *  SIDE session clipboard (the internal paste; no OS image involved). Empty
   *  clipboard is reported, never a silent no-op. Kept as its own command so
   *  the palette entry and runCommand("paste") route here directly. */
  async pasteClipboard() {
    const payload = await this.#readClipboardPayload();
    if (!payload) {
      console.warn("Paste: the server-side clipboard is empty for this browser session (nothing copied yet).");
      return;
    }
    this.#insertClipboardPayload(payload);
  }

  /**
   * Command (async). THE Ctrl+V authority (App.svelte onPaste routes here).
   *
   * CTRL+V AND THE TOOLBAR PASTE BUTTON ARE THE SAME ACTION (user ruling,
   * 2026-07-30: "Does Cmd+V do something different than the toolbar Paste
   * button? The toolbar button is always correct, but Cmd+V pasted it as an
   * IMAGE sometimes"). They diverged because the button ran the internal paste
   * unconditionally while Ctrl+V additionally saw the PNG our OWN copy had put
   * on the OS clipboard and — failing to recognize it — took the upload path.
   *
   * PRECEDENCE, in order. The first that applies wins and NOTHING else runs:
   *   1. WE OWN THIS CLIPBOARD → paste the ELEMENT. Ownership is proven by
   *      EITHER the marker MIME on the event (POWERRP_CLIPBOARD_MIME, written
   *      by every copy) OR simply by our internal clipboard holding a pasteable
   *      payload. The second disjunct is what makes this identical to the
   *      button: if there is something of ours to paste, Ctrl+V pastes it, and a
   *      PNG we ourselves wrote never diverts it into an upload.
   *   2. NO app payload and the OS carries file(s) → a genuine screenshot or
   *      copied file → upload + insert as an image/video widget.
   *   3. Nothing at all → pasteClipboard() reports the empty clipboard.
   *
   * The png_sig comparison is GONE as a gate. It could only ever return false
   * for a real Ctrl+V: the OS pasteboard re-encodes images in transit (581
   * bytes in, 645 bytes out, measured on macOS), so the hash of what comes back
   * never equals the hash of what we wrote. Keeping it as a condition is what
   * produced the bug; ownership is now a LABEL that survives the round trip.
   *
   * Exactly one insert happens per paste — no double insert (the keydown
   * binding is nativeEvent, so it does not also fire).
   *
   * @param {File[]} files - the OS clipboard's files (App.svelte passes
   *   `[...clipboardData.files]`); empty for a plain internal paste.
   * @param {string[]} [types] - the event's clipboardData.types, carrying the
   *   ownership marker when the copy came from this app.
   */
  async pasteFromClipboard(files, types = []) {
    // Read the internal clipboard FIRST: it is the same store the toolbar button
    // pastes from, and having something in it is what makes this OUR paste.
    const payload = await this.#readClipboardPayload();
    if (payload && !this.#isForeignFilePaste(payload, files, types)) {
      this.#insertClipboardPayload(payload);
      return;
    }
    if (files.length) {
      await this.pasteFiles(files); // external image/video/file → new widget
      return;
    }
    await this.pasteClipboard(); // nothing anywhere → the empty-clipboard report
  }

  /**
   * Query. Given that we DO hold an internal payload, is this paste nevertheless
   * carrying something FOREIGN that should win instead?
   *
   * The hard case: with an internal copy live, a bare `image/png` on the OS
   * clipboard is genuinely ambiguous — it is either the render our own copy
   * wrote, or a screenshot the user took afterwards. The two are
   * indistinguishable by BYTES, because the pasteboard re-encodes (that is the
   * whole bug). So we resolve it by EVIDENCE, in this order:
   *
   *   • Our marker is present → ours. Not foreign.
   *   • A NON-IMAGE file (a .pdf, .mp4, a copied file from the OS file manager)
   *     → foreign. Our copy only ever writes an image, so a non-image file
   *     cannot be ours regardless of what we hold internally.
   *   • Otherwise → NOT foreign: the element wins.
   *
   * That last line is the ruling ("if the app-internal clipboard holds a
   * pasteable widget payload … run the registry paste"), and it is deliberately
   * biased toward the element: pasting the widget when the user meant the
   * screenshot is one Ctrl+Z, whereas the old bias silently flattened a widget
   * into a bitmap and lost its editability. A user who wants the screenshot
   * copies it AFTER the widget copy is stale, or pastes into a slide where no
   * internal copy exists.
   */
  #isForeignFilePaste(payload, files, types) {
    if (!files.length) return false; // nothing foreign on the clipboard at all
    if (types.includes(POWERRP_CLIPBOARD_MIME)) return false; // our marker: ours
    // Our copy only ever writes an IMAGE, so any non-image file is foreign no
    // matter what we hold internally. An image alone is ambiguous, and the
    // ruling resolves the ambiguity toward the element.
    return files.some((f) => !f.type.startsWith("image/"));
  }

  /** Command (one undo unit). Inserts a tagged clipboard payload
   *  ({powerrp_items} or {powerrp_props}) into the current slide:
   *    - powerrp_items: routed to #cloneStatesIntoSlide (14.9's "one canonical
   *      clone home", shared with duplicateSelection).
   *    - powerrp_props: applies the property values to the current selection. */
  #insertClipboardPayload(payload) {
    if (payload.powerrp_items) {
      this.#cloneStatesIntoSlide(payload.powerrp_items);
    } else if (payload.powerrp_props && this.selection) {
      let doc = this.doc;
      for (const [key, value] of Object.entries(payload.powerrp_props))
        doc = keyframed(doc, this.slideIndex, ["items", this.selection, ...key.split(".")], value);
      this.commit(doc);
    }
  }

  /**
   * Command (ONE undo unit). THE CANONICAL CLONE HOME (14.9): drops a set of
   * {sourceId: rawItemState} into the current slide as NEW items and selects
   * them. Shared by paste and Duplicate — the difference between those two is
   * only WHERE the states came from (the server clipboard vs. the live selection),
   * never what cloning means.
   *
   * The rules, all of them pre-existing and now stated exactly once:
   *   • INTERNAL REFERENCES REROUTE, EXTERNAL ONES DO NOT (core/document.js
   *     clonedItemStates). The `states` KEY SET is the boundary, which is why the
   *     payload carries source ids at all.
   *   • ONE CAMERA PER DOCUMENT: a camera in the set keyframes its ASPECTS onto
   *     the existing camera instead of cloning (user spec). It never gets a new
   *     id, so it is not part of the reroute boundary — a reference to the camera
   *     stays a reference to THE camera, which is correct.
   *   • OFFSET one spacing step, the convention PowerPoint uses for paste-in-place
   *     collisions (precedent, not an invented constant). A uniform per-item bump
   *     IS a rigid translation, so relative positions survive. Equation-valued
   *     coordinates are left VERBATIM — offsetting a string would concatenate
   *     ("circle.x + 10" + 16); such a copy keeps its binding and lands wherever
   *     the equation says.
   *     THE OFFSET GOES THROUGH THE ONE TRANSLATION RULE (canvas/dragKinds.js
   *     translationPairs) — the same seam a body drag, a drag-all, the modal grab
   *     and an arrow-key nudge use. This was the ONE bypass of that rule, and the
   *     bypass was the bug: it wrote `x: (clone.x ?? 0) + 16`, which FABRICATES an
   *     x/y on a widget that has none. An arrow keeps its position in from/to, so
   *     the invented x/y became a non-identity `world` (core/derive.js builds one
   *     from whatever x/y is in state): the painted ink moved a step while the
   *     WORLD-space endpoint handles stayed on the original, the hit test resolved
   *     on the original, and the phantom key had no Inspector row to remove it
   *     with and survived save. Asking the plugin first (moveBy) puts the offset on
   *     the properties the position actually lives in.
   *   • z stacked above the current max, preserving relative order; active: true
   *     on the creation slide (the visibility model — creation is where an item
   *     switches on).
   * A reference that leaves the set and names an item THIS DOCUMENT DOES NOT HAVE
   * is reported: that is a dangling reference (a purged item, or a cross-document
   * paste) and it must not land silently.
   *
   * @param {object} states - {sourceItemId: rawItemState}
   * @param {number} [offset] - the spacing step each copy is moved by, on both
   *   axes. A PARAMETER rather than a second cloning path, so "Duplicate in
   *   Place" (offset 0) is this same clone with a different number.
   */
  #cloneStatesIntoSlide(states, offset = CLONE_OFFSET) {
    // ONE camera per document: partitioned out BEFORE ids are minted.
    const existingCamera = this.nodes().find((n) => n.type === "camera") ?? null;
    const cloneable = {};
    const cameras = [];
    for (const [id, s] of Object.entries(states)) {
      if (s.type === "camera" && existingCamera) cameras.push(s);
      else cloneable[id] = s;
    }
    if (Object.keys(cloneable).length === 0 && cameras.length === 0) {
      console.warn("Clone: the payload held no item states — nothing to insert.");
      return;
    }
    const idMap = new Map(Object.keys(cloneable).map((id) => [id, uuid()]));
    const { states: clones, external } = clonedItemStates(cloneable, idMap, this.registry);
    this.#reportDanglingRefs(external);
    let nextZ = (this.nodes().map((n) => n.state.z ?? 0).reduce((a, b) => Math.max(a, b), 0)) + 1;
    let doc = this.doc;
    for (const [newId, clone] of Object.entries(clones)) {
      const state = { ...clone, active: true, z: nextZ++ };
      doc = keyframed(doc, this.slideIndex, ["items", newId], state);
      // The same [path, value] pairs CanvasView hands to setPreview for a drag,
      // written straight into the delta instead — one item, one rigid translation.
      const member = { itemId: newId, plugin: this.registry.get(state.type), rawItem: state, startX: state.x, startY: state.y };
      for (const [path, value] of translationPairs(member, offset, offset))
        doc = keyframed(doc, this.slideIndex, path, value);
    }
    for (const s of cameras)
      for (const key of ["x", "y", "w", "h"])
        doc = keyframed(doc, this.slideIndex, ["items", existingCamera.itemId, key], s[key]);
    // Normalize only when items were actually ADDED — a camera-aspect merge adds
    // no z, so renumbering the whole document there would be a mutation the
    // camera-paste rule never made.
    this.commit(Object.keys(clones).length ? withNormalizedZ(doc) : doc); // ONE commit = one undo unit
    this.selectMany([...Object.keys(clones), ...(cameras.length ? [existingCamera.itemId] : [])]);
  }

  /** Command (reports). Warns for every id a clone still references that this
   *  document does not contain — a DANGLING reference: the source item was
   *  purged, or this is a cross-document paste where the reference's target
   *  simply does not exist here. The clone keeps the reference verbatim (so the
   *  user can see and repair it, the storedToDisplay ruling) and the render-time
   *  affordances report it too; this makes the paste itself say so. Ids present
   *  in the document are legitimate external edges and stay silent. */
  #reportDanglingRefs(external) {
    const known = new Set(this.doc.slides.flatMap((s) => Object.keys(s.delta.items ?? {})));
    const dangling = external.filter((id) => !known.has(id));
    if (dangling.length)
      console.warn(`Paste: the pasted items reference ${dangling.length} item(s) that do not exist in this document — those references are kept verbatim so you can repair them: ${dangling.join(", ")}`);
  }

  // ── Duplicate (manifest 14.9: "duplicate object should be a thing") ──────────
  // Duplicate = the same clone as copy+paste, but WITHOUT the clipboard round-trip
  // (local, immediate) and as ONE undo unit for the whole selection. Both routes
  // run #cloneStatesIntoSlide — the ONE canonical clone home the manifest asks
  // for — rather than a second cloning path. Multi-select duplicates every
  // duplicable member.

  /** Query. The selected itemIds that Duplicate would clone: every selected item
   *  EXCEPT non-purgeable widgets (the camera is exactly one per document — it
   *  cannot be duplicated, mirroring the paste-a-camera-merges rule). Order =
   *  selectedIds() order. */
  #duplicableSelection() {
    return this.selectedIds().filter((id) => {
      const type = this.rawState().items?.[id]?.type;
      if (!type) return false;
      return this.registry.get(type).capabilities.purgeable !== false; // exclude the camera
    });
  }

  /** Query. Can the current selection be duplicated? (at least one duplicable
   *  item — a camera-only selection cannot). Drives the command's `when`. */
  canDuplicate() {
    return this.#duplicableSelection().length > 0;
  }

  /**
   * Command (ONE undo unit). Duplicates every duplicable selected item through
   * THE canonical clone home (#cloneStatesIntoSlide): each gets a NEW UUID, the
   * SAME raw state (equations verbatim) with references INTO the duplicated set
   * rerouted to the new copies, offset one spacing step, z stacked above the
   * current max. All the new items commit together (one snapshot = one undo) and
   * become the new selection. No-op (reported) when nothing duplicable is
   * selected.
   *
   * @param {number} [offset] - how far each copy lands from its source, on both
   *   axes. The "Duplicate in Place" palette entry passes 0; that is the ONLY
   *   difference between the two entries, so they stay one behaviour with one
   *   number rather than two commands that could drift apart.
   */
  duplicateSelection(offset = CLONE_OFFSET) {
    const ids = this.#cloneSet(this.#duplicableSelection());
    if (ids.length === 0) {
      console.warn("Duplicate: nothing duplicable is selected (the camera cannot be duplicated).");
      return;
    }
    this.#cloneStatesIntoSlide(this.#cloneStates(ids), offset);
  }

  // ── Paste-to-upload (manifest 13.3): an EXTERNAL image/video/file on the OS
  // clipboard uploads through the SAME path as an OS-file drop (app.uploadAsset
  // → insertImageAsset/insertVideoAsset), landing at the camera-view center
  // (paste has no drop point, unlike a canvas drag-drop — the same "at=null"
  // fallback insertImageAsset already uses for the Asset Explorer's insert
  // button). pasteFromClipboard is the DECISION layer above this: it only calls
  // pasteFiles once it has ruled out "this image is our own copied element
  // render" (signature match), so pasteFiles no longer needs its own
  // self-render guard — by the time we get here the file is known-external.
  // Upload hash-dedup across DIFFERENT assets stays EXPLICITLY DEFERRED (13.3).

  /** Command. Uploads each File in `files` to the current project's assets
   *  (app.uploadAsset — the same upload endpoint the canvas OS-file drop and
   *  the Asset Explorer's file input use) and inserts the matching widget
   *  (image/video by MIME) at the camera-view center. Kinds with no canvas
   *  widget still upload (they land in the asset library) and are reported,
   *  never silently dropped. A failure in any step is REPORTED loudly
   *  (console.error) — a paste gesture must never fail silently. */
  async pasteFiles(files) {
    for (const file of files) {
      try {
        const up = await this.uploadAsset(file); // {ok, name, url}
        const kind = assetKindForFile(file);
        // THE THIRD COPY of the image-or-video pair used to live here, which is
        // why a pasted PDF also went nowhere. The registry answers now, so paste
        // gained PDFs for free the moment pdf_page declared itself.
        if (widgetForAssetKind(this.registry, kind)) await this.insertAssetWidget({ kind, url: up.url, name: up.name });
        else console.warn(`Paste: uploaded "${up.name}" but no canvas widget exists for kind "${kind}" — it stays in the asset library.`);
      } catch (e) {
        console.error(`Paste-to-upload failed for "${file.name}":`, e);
      }
    }
  }

  /**
   * "Delete": keyframe active:false here — identity survives (symlink-safe).
   * Multi-select falls out naturally: deactivates EVERY selected item on this
   * slide in one undo unit. purgeable:false items (the camera) are skipped
   * (the command `when` already excludes a lone camera; in a mixed set the
   * camera stays put rather than erroring).
   *
   * KEEPS the selection (user ruling, round 11: "you shouldn't deselect
   * something when it's not visible anymore, that doesn't help anybody") —
   * a hidden item stays selected so the Inspector's visibility toggle can
   * flip it right back. Purge still deselects: a purged item no longer
   * exists to be selected.
   */
  deleteSelection() {
    const ids = this.selectedIds().filter((id) => this.registry.get(this.state().items?.[id]?.type)?.capabilities.purgeable !== false);
    if (ids.length === 0) return;
    // [ROUND 15.2] deactivate keeps the item OBJECT alive (just hidden), so
    // the edited item's in-progress text is worth keeping — commit it first
    // (one undo unit, same as Esc) rather than losing it to the deactivation
    // commit() below, which writes `this.doc` directly and does not know
    // about a live previewDelta (manifest: "item deletion while editing ...
    // must all commit ... never strand the overlay").
    this.dismissEdit();
    let doc = this.doc;
    for (const id of ids) doc = keyframed(doc, this.slideIndex, ["items", id, "active"], false);
    this.commit(doc);
  }

  /**
   * Command. The inverse of deleteSelection: keyframe active:true on this
   * slide for every selected item — the "Show all" set-action (user ruling:
   * BOTH explicit buttons, never a mixed-state guessing toggle). An item NOT
   * YET CREATED on this slide follows the ratified pre-creation semantics:
   * its FOLDED CREATION-SLIDE STATE is copied here + active:true, making
   * this slide the effective creation slide (it appears looking like
   * itself). One undo unit for the whole set. Keeps the selection.
   */
  showSelection() {
    const ids = this.selectedIds().filter((id) => this.registry.get(this.rawState().items?.[id]?.type ?? this.#governingTypeState(id)?.type)?.capabilities.purgeable !== false);
    if (ids.length === 0) return;
    let doc = this.doc;
    for (const id of ids) {
      if (this.rawState().items?.[id]) {
        doc = keyframed(doc, this.slideIndex, ["items", id, "active"], true);
      } else {
        const governing = this.#governingTypeState(id);
        if (!governing) {
          console.error(`Show all: item "${id}" has no type keyframe anywhere — skipped (loudly).`);
          continue;
        }
        // Leaf-wise keyframes (the commitPreview walk pattern) — nested
        // subtrees like rotationAnchor keyframe per-leaf, never as blobs.
        const walk = (tree, prefix) => {
          for (const [k, v] of Object.entries(tree)) {
            if (v !== null && typeof v === "object" && !Array.isArray(v)) walk(v, [...prefix, k]);
            else doc = keyframed(doc, this.slideIndex, [...prefix, k], v);
          }
        };
        walk({ ...governing, active: true }, ["items", id]);
      }
    }
    this.commit(doc);
  }

  /**
   * Command (ONE undo unit). Turns the selected item into widget type
   * `newType`, keeping its id, name, z, other slides' keyframes and every
   * equation that names it — core/retype.js owns every rule about WHICH values
   * survive, and this method owns only the document plumbing.
   *
   * Writes the type keyframe plus the fills and coercions on the CURRENT slide,
   * so undo puts back both the old type AND every value the retype overwrote in
   * one press. Committing the pending edit first is deleteSelection's rule
   * (ROUND 15.2): commit() writes `this.doc` and does not know about a live
   * previewDelta, so an in-progress text edit on the retyped item would be lost.
   *
   * Refuses LOUDLY on an ineligible source or target (retypeEligible — the
   * camera, groups, scene-structural types): the dropdown never offers one, so
   * reaching here with one is a caller bug, not a user mistake.
   */
  retypeSelection(newType) {
    const id = this.selectedIds()[0];
    if (id === undefined) return;
    const folded = this.state().items?.[id];
    if (!folded) throw new Error(`retypeSelection: item "${id}" is not on slide ${this.slideIndex}`);
    if (folded.type === newType) return;
    for (const [role, type] of [["source", folded.type], ["target", newType]])
      if (!retypeEligible(this.registry.get(type)))
        throw new Error(`retypeSelection: "${type}" is not a retype ${role} — it is structurally fixed (camera/group/scene-structural)`);
    this.dismissEdit();
    this.commit(retypedItem(this.doc, this.slideIndex, id, newType, folded, this.registry));
  }


  // ── Shatter (core/shatter.js) ────────────────────────

  /**
   * Query. WHY the selection cannot be shattered, or null when it can. ONE call
   * answering both "may it run" and "why not", the `draftKeys.quickSaveBlocker`
   * shape — because a command whose gate and whose explanation are computed
   * separately will eventually disagree, and the user reads the explanation
   * precisely when the gate says no.
   *
   * Single-item, deliberately: shattering several widgets at once would produce
   * several groups and one undo entry that is hard to reason about, and no
   * existing command does it.
   *
   * CHEAP ON PURPOSE, and this was MEASURED the hard way. The first version also
   * asked the plugin to PLAN, so the gate could say "the diagram has not finished
   * rendering". But a `when` is re-evaluated on every palette render and every
   * availability pass, and planning a mermaid diagram regroups every path and
   * text in it — so the gate ran a full decomposition many times a second for a
   * command nobody had invoked. It was enough to push tests/palette_probe.js's
   * clipboard settle over its budget; a detached-worktree bisect with ONLY the
   * command registration removed went green, which is what found it.
   *
   * The plugin's own refusal did not disappear, it MOVED to run time, where it is
   * reported loudly by shatterSelection — see there. An expensive gate is not a
   * safer gate; it is the same answer, computed constantly, for nothing.
   */
  shatterBlocker() {
    const ids = this.selectedIds();
    if (ids.length === 0) return "a selected widget";
    if (ids.length > 1) return "one widget selected, not several — shatter makes one group at a time";
    const folded = this.state().items?.[ids[0]];
    if (!folded) return "a widget on this slide";
    const plugin = this.registry.get(folded.type);
    if (!shatterEligible(plugin))
      return `a widget that can be shattered — ${plugin.title} does not declare a decomposition`;
    return shatterNotReadyReason(plugin, folded);
  }

  /** Query. The plugin's decomposition of one item, or the REASON it refused as
   * a string. The plugin throws (loudly, with a sentence) when it has no
   * geometry; that sentence is the gate's explanation, so it is caught HERE and
   * nowhere else — the one place a throw is a legitimate answer rather than a
   * failure, because planning is also how the gate asks "is this possible". */
  #shatterPlan(id, folded) {
    const node = this.nodes().find((n) => n.itemId === id);
    if (!node) return "a widget that is drawn on this slide";
    const box = rotatedBBoxAABB(node);
    if (!box) return "a widget with a bounding box";
    try {
      return this.registry.get(folded.type).shatter(folded, { box });
    } catch (e) {
      return String(e?.message ?? e);
    }
  }

  /**
   * Command (one undo unit). "Shatter": the selected widget BECOMES a
   * group whose members are the editable widgets it was drawing, wired to each
   * other by equations so a label follows the box it names and an arrow
   * re-routes when either end moves.
   *
   * Reports the DISCLOSURE — what was recovered as editable widgets, what was
   * kept as raster, and every caveat the plugin raised — rather than a silent
   * success. The user cannot see from the canvas which parts will respond to a
   * handle, and guessing is worse than reading.
   */
  shatterSelection() {
    const blocker = this.shatterBlocker();
    if (blocker !== null) {
      console.warn(`Shatter: needs ${blocker} — nothing was converted.`);
      return;
    }
    const id = this.selectedIds()[0];
    const folded = this.state().items[id];
    // THE PLUGIN'S OWN REFUSAL IS ANSWERED HERE, not in the gate: planning is too
    // expensive to run on every availability pass (see shatterBlocker). A refusal
    // is reported LOUDLY and converts nothing — never a silent no-op.
    const plan = this.#shatterPlan(id, folded);
    if (typeof plan === "string") {
      this.shatterReport = `Shatter: ${plan}`;
      console.warn(this.shatterReport);
      return;
    }
    if (plan.parts.length === 0) {
      this.shatterReport = "Shatter: this widget draws no recoverable parts, so there is nothing to convert.";
      console.warn(this.shatterReport);
      return;
    }
    const node = this.nodes().find((n) => n.itemId === id);
    const box = rotatedBBoxAABB(node);
    this.dismissEdit();
    const doc = shatteredDocument(this.doc, this.slideIndex, id, folded, plan, this.registry, shatterIds(plan), box, this.displayName(id));
    this.commit(withNormalizedZ(doc));
    this.selection = id; // the group — the thing the user now has a handle on
    this.shatterReport = `${shatterDisclosure(plan.parts, this.registry, plan.notes)} (${Math.round(vectorRecovery(plan.parts) * 100)}% recovered as vector.)`;
    console.info(`Shatter: ${this.shatterReport}`);
  }

  /**
   * Query. The retype menu for the selected item — every eligible target with
   * its coercion preview computed against this item's LIVE folded state, clean
   * types first and coercing types last. Empty when nothing is selected, when
   * several things are (a retype is single-item: an intersection menu would have
   * to promise one type change means the same thing to a rect and a video), or
   * when the selected item is itself ineligible — which is how the camera's
   * Inspector header stays plain text.
   */
  retypeChoices() {
    if (this.selectedIds().length !== 1) return [];
    const folded = this.state().items?.[this.selectedIds()[0]];
    return folded ? retypeChoices(this.registry, folded) : [];
  }

  /**
   * Query. An item's folded state as of the type keyframe that GOVERNS the current
   * slide — the nearest one at or before it, which is what the fold itself already
   * computes for every other key.
   *
   * IT USED TO TAKE keyframeIndices(...)[0] — THE FIRST — AND WAS CALLED
   * `#creationState`. R6-6.7 flagged exactly this as its open question ("stops
   * being unique once type is keyed on several slides… most likely the NEAREST
   * PRECEDING type keyframe, which is what the fold already implies"), and the
   * question stopped being hypothetical when the Widget type row became keyframeable
   * (commit 634954c). retypeSelection has ALWAYS written its keyframe at the current
   * slide, so multiple type keyframes were already possible; what changed is that
   * the UI now invites them.
   *
   * THE DEFECT IT FIXES IS SILENT. A widget authored as a rect and retyped to a
   * circle on slide 5 reported its RECT-era state to every caller on every slide,
   * forever. SHOW ALL is the sharp one: it walks this state leaf-by-leaf into
   * keyframes at the current slide, so un-hiding that widget on slide 8 resurrected
   * it as a rect with rect-era properties and quietly undid the retype.
   *
   * FALLS BACK TO THE FIRST when nothing precedes — an item whose type is keyed only
   * LATER still has a definite identity, and that fallback is exactly what the old
   * code always returned, so this is never worse than what it replaced.
   *
   * RENAMED with the semantics: it is no longer "creation" state, and leaving the
   * old name would hand the next reader the same wrong mental model it gave me.
   */
  #governingTypeState(id, slideIndex = this.slideIndex) {
    const keyed = keyframeIndices(this.doc, ["items", id, "type"]);
    if (keyed.length === 0) return null;
    const at = keyed.filter((i) => i <= slideIndex).pop() ?? keyed[0];
    return foldState(this.doc, at, 1).items?.[id] ?? null;
  }

  /** True removal FROM EXISTENCE: every keyframe of each selected item on every
   * slide (multi-select falls out naturally). Skips purgeable:false (camera). */
  purgeSelection() {
    const ids = this.selectedIds().filter((id) => this.registry.get(this.state().items?.[id]?.type)?.capabilities.purgeable !== false);
    if (ids.length === 0) return;
    // [ROUND 15.2] purge is true removal, so if the edited item is IN the
    // purge set there is nothing left to commit — cancel (drop the pending
    // preview with no undo unit) rather than keyframing text onto an item
    // this very call is about to erase from every slide. An edit on some
    // OTHER item (not in `ids`) still gets the normal commit-before-mutate
    // (dismissTextEdit's existence check passes) so ITS in-progress text
    // survives an unrelated purge.
    const editId = this.editingItemId;
    if (editId !== null && ids.includes(editId)) { this.cancelTextEdit(); this.cancelLatexEdit(); }
    else this.dismissEdit();
    let doc = this.doc;
    for (const id of ids) doc = withItemPurged(doc, id);
    this.commit(doc);
    this.selection = null;
  }

  /**
   * Query. Which SELECTED items Make Static would actually change: the ones
   * carrying at least one non-`active` keyframe past the start of the stretch
   * they are visible on around this slide (core/document.js's MAKE STATIC block
   * explains the stretch and why `active` is exempt). The command's availability
   * gate AND its target list, so a greyed-out control and a silent no-op click
   * cannot disagree.
   */
  makeStaticTargets() {
    return this.selectedIds().filter((id) => itemAnimationKeyframes(this.doc, this.slideIndex, id).length > 0);
  }

  /**
   * Command (ONE undo unit, or no writes at all). MAKE THE SELECTION STATIC from
   * THIS slide: across the stretch of slides each item is visible on, it keeps only
   * its state as of here, written once where that stretch begins
   * (core/document.js withItemsMadeStatic owns the rule and the reasoning).
   * Multi-select falls out naturally — one fold, one commit for the whole set.
   *
   * KEEPS the selection: the items still exist and still look the same here,
   * so deselecting them would only hide the result (deleteSelection's ruling).
   *
   * REPORTS, NEVER REFUSES. A skipped item says why — including the one the user
   * is most likely to hit, an item HIDDEN on this slide, which has no visible
   * stretch to be static over. Every equation the collapse replaces is named; one
   * still IN FORCE here is written back verbatim, so the common bound-to-camera
   * case reports nothing.
   */
  makeSelectionStatic() {
    const ids = this.makeStaticTargets();
    if (ids.length === 0) return;
    // An in-progress text/LaTeX edit is a pending write on an item this call is
    // about to rewrite — commit it first (deleteSelection's rule, ROUND 15.2) so
    // it lands in the state being made static instead of being lost to the commit
    // below, which writes `this.doc` directly and knows nothing about previewDelta.
    this.dismissEdit();
    const lost = ids.flatMap((id) =>
      lostEquationKeyframes(this.doc, this.slideIndex, id, this.registry).map((e) => ({ id, ...e })));
    const { doc, skipped } = withItemsMadeStatic(this.doc, this.slideIndex, ids);
    for (const { id, reason } of skipped)
      console.error(`PowerRP: Make Static from Current Slide skipped item "${id}" — ${reason}.`);
    if (lost.length)
      console.error(`PowerRP: Make Static from Current Slide dropped ${lost.length} equation keyframe(s) the static state does not keep: ${lost.map((e) => `items.${e.id}.${e.path.join(".")} on slide ${e.slideIndex} (${JSON.stringify(e.value)})`).join("; ")}. Undo restores them.`);
    this.commit(doc);
  }

  /**
   * Query. Which SELECTED items "Remove Keyframes on This Slide" would actually
   * clear: the ones THIS slide keyframes that are not CREATED on it (clearing a
   * creation slide would delete the widget — core/document.js's per-slide block).
   * The command's availability gate, and DELIBERATELY NOT the same question the
   * freeze's gate asks: an item can be animated elsewhere and keyed nowhere here,
   * or keyed only here and static everywhere else.
   */
  slideKeyframeTargets() {
    return this.selectedIds().filter((id) =>
      this.slideIndex !== itemCreationSlide(this.doc, id)
      && itemSlideKeyframes(this.doc, this.slideIndex, id).length > 0);
  }

  /**
   * Command (ONE undo unit, or no writes at all). Removes THIS SLIDE's keyframes
   * for every selected item, so each one stops changing here and inherits the
   * previous slide's values (core/document.js withSlideKeyframesRemoved owns the
   * rule, the `active` reasoning and the creation-slide refusal).
   *
   * KEEPS the selection, like every other keyframe/visibility action: the items
   * still exist, and the point is to look at what changed.
   *
   * THE WHOLE SELECTION IS PASSED, not just the gate's targets, so a creation-slide
   * item picked up in a multi-selection gets its REFUSAL reported instead of being
   * dropped on the floor. Items this slide simply says nothing about are neither
   * cleared nor reported — that is "nothing to do", not a failure.
   */
  removeSlideKeyframes() {
    const targets = this.slideKeyframeTargets();
    if (targets.length === 0) return;
    // An in-progress text/LaTeX edit is a pending write on THIS slide, which is
    // exactly what this call clears — so committing it first would only create a
    // keyframe for this call to delete. Cancel it instead when the edited item is
    // one of the targets (purgeSelection's rule: nothing left to commit), and
    // commit normally when the edit belongs to some other item.
    const editId = this.editingItemId;
    if (editId !== null && targets.includes(editId)) { this.cancelTextEdit(); this.cancelLatexEdit(); }
    else this.dismissEdit();
    const { doc, cleared, refused } = withSlideKeyframesRemoved(this.doc, this.slideIndex, this.selectedIds());
    // The equation report is read off `cleared`, never off the selection: a REFUSED
    // item keeps its keyframes, so naming its equations would be a false alarm.
    // Read against `this.doc` — the pre-removal document, where they still exist.
    const lost = cleared.flatMap((id) =>
      slideEquationKeyframes(this.doc, this.slideIndex, id, this.registry).map((e) => ({ id, ...e })));
    for (const { id, reason } of refused)
      console.error(`PowerRP: Remove Keyframes on This Slide refused item "${id}" — ${reason}.`);
    if (lost.length)
      console.error(`PowerRP: Remove Keyframes on This Slide dropped ${lost.length} equation keyframe(s) on slide ${this.slideIndex}: ${lost.map((e) => `items.${e.id}.${e.path.join(".")} (${JSON.stringify(e.value)})`).join("; ")}. Undo restores them.`);
    this.commit(doc);
  }

  /**
   * Renames the selected item. Name is identity-flavored, so it's written on
   * the item's CREATION slide (first slide keying its `type`), not the
   * current one — a rename applies everywhere at once.
   */
  renameSelection(name) {
    if (!this.selection) return;
    const creation = keyframeIndices(this.doc, ["items", this.selection, "type"])[0] ?? this.slideIndex;
    this.commit(keyframed(this.doc, creation, ["items", this.selection, "name"], name));
  }

  // ── Z-order (bisect + normalize; a tweened in-between z is never STORED) ──

  zPairs() {
    return this.nodes().map((n) => [n.itemId, n.state.z ?? 0]);
  }

  /**
   * Query. The Z-ORDER BLOCK for the current selection (manifest 15.7: "when i
   * move a group to front or back it should move all elements in it too"): a
   * selected GROUP travels with EVERY member (and any members that are
   * themselves groups pull in their own members transitively) so the whole
   * cluster reorders as one; any other selection is just itself. The group's
   * members list is the derived-node membership map (present-on-this-slide
   * members only — a member absent from zPairs is simply not reassigned, per
   * blockZToExtreme). Returns the block itemIds (selection first).
   */
  #zOrderBlock() {
    if (!this.selection) return [];
    const nodes = this.nodes();
    const byId = new Map(nodes.map((n) => [n.itemId, n]));
    const block = new Set();
    const visit = (id) => {
      if (block.has(id)) return;
      block.add(id);
      const n = byId.get(id);
      if (n?.type === "group" && Array.isArray(n.state.members))
        for (const m of n.state.members) visit(m);
    };
    visit(this.selection);
    return [...block];
  }

  reorderSelection(direction) {
    if (!this.selection) return;
    const block = this.#zOrderBlock();
    // A GROUP steps as a BLOCK (front/back of everything else); a single item
    // bisects between its neighbors as before. "Forward/backward" on a block is
    // still a move to the extreme — a group has no single z to bisect around.
    if (block.length > 1) { this.#commitBlockZ(block, direction); return; }
    const z = bisectedZ(this.zPairs(), this.selection, direction);
    this.commit(withNormalizedZ(keyframed(this.doc, this.slideIndex, ["items", this.selection, "z"], z)));
  }

  /** "Put on Top"/"Put on Bottom": beyond the extremes of VISIBLE items on this
   *  slide. A GROUP sends its whole block (group + members) as one (manifest 15.7). */
  sendToExtreme(direction) {
    if (!this.selection) return;
    const block = this.#zOrderBlock();
    if (block.length > 1) { this.#commitBlockZ(block, direction); return; }
    const zs = this.zPairs().map(([, z]) => z);
    const z = direction > 0 ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
    this.commit(withNormalizedZ(keyframed(this.doc, this.slideIndex, ["items", this.selection, "z"], z)));
  }

  /** Command (one undo unit). Reassigns every block id's z to the front/back
   *  extreme, preserving the block's internal relative order (blockZToExtreme),
   *  then normalizes document-wide — ONE commit. */
  #commitBlockZ(block, direction) {
    let doc = this.doc;
    for (const [id, z] of blockZToExtreme(this.zPairs(), block, direction))
      doc = keyframed(doc, this.slideIndex, ["items", id, "z"], z);
    this.commit(withNormalizedZ(doc));
  }

  // ── Keyframe panel operations ──────────────────────────────────────────────
  // Path-based versions serve BOTH item properties (["items", id, ...keyPath],
  // dotted inspector keys like "from.x" split into path segments) and
  // variables (["vars", name]) — the Variables Panel reuses the same
  // diamond/jump controls as the Property Panel.

  hasKeyPath(path) {
    return hasKeyframe(this.doc, this.slideIndex, path);
  }

  keyframePath(path, value) {
    this.commit(keyframed(this.doc, this.slideIndex, path, value));
  }

  /** Jump to the prev/next slide holding a keyframe for a full state path. */
  jumpKeyframePath(path, direction) {
    const idxs = keyframeIndices(this.doc, path);
    const next = direction > 0 ? idxs.find((i) => i > this.slideIndex) : [...idxs].reverse().find((i) => i < this.slideIndex);
    if (next !== undefined) this.slideIndex = next;
  }

  hasKey(key) {
    return this.selection ? this.hasKeyPath(["items", this.selection, ...key.split(".")]) : false;
  }

  removeKey(slideIndex, path) {
    this.commit(unkeyframed(this.doc, slideIndex, path));
  }

  /** Jump to the prev/next slide keyframing the selected item's (dotted) key. */
  jumpKeyframe(key, direction) {
    if (!this.selection) return;
    this.jumpKeyframePath(["items", this.selection, ...key.split(".")], direction);
  }

  // ── Variables (keyframable state.vars subtree — the Variables Panel) ──────

  /** RAW variables of the current slide: {name: number | equation string}. */
  varsState() {
    return this.rawState().vars ?? {};
  }

  /** Creates a variable (value 0, keyframed on the CURRENT slide, like item
   * creation). Loud on invalid names/duplicates; returns success. */
  addVariable(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      console.error(`PowerRP: "${name}" is not a valid variable name (letters, digits, _; not starting with a digit)`);
      return false;
    }
    if (name in this.varsState()) {
      console.error(`PowerRP: a variable named "${name}" already exists`);
      return false;
    }
    this.commit(keyframed(this.doc, this.slideIndex, ["vars", name], 0));
    return true;
  }

  /** Removes a variable FROM EXISTENCE: every keyframe on every slide (the
   * variables' Purge — equations referencing it will error loudly). */
  deleteVariable(name) {
    let doc = this.doc;
    for (let i = 0; i < doc.slides.length; i++) doc = unkeyframed(doc, i, ["vars", name]);
    this.commit(doc);
  }

  /** Renames a variable document-wide, rewriting equation references (names
   * ARE variable identity — see core/expressions.js). Loud on conflicts. */
  renameVariable(oldName, newName) {
    if (newName === oldName) return true;
    try {
      this.commit(withVariableRenamed(this.doc, oldName, newName, this.registry));
      return true;
    } catch (e) {
      console.error(`PowerRP: rename variable failed: ${e.message}`);
      return false;
    }
  }

  // ── Per-item variables (manifest item 67 — the item's OWN vars subtree) ─────
  // The item-scoped mirror of the global Variables block above: same generic
  // document helpers (keyframed / unkeyframed are path-generic), one level deeper
  // at ["items", itemId, "vars", name]. A per-item var is referenced as
  // `self.vars.<name>` — disjoint from the bare-identifier global namespace, so a
  // global and a per-item var may share a name with no collision.

  /** RAW per-item vars of `itemId` on the current slide: {name: number | equation}. */
  itemVarsState(itemId) {
    return this.rawState().items?.[itemId]?.vars ?? {};
  }

  /** Creates a per-item variable on `itemId` (value 0, keyframed on the CURRENT
   * slide, like item/global-var creation). Loud on invalid names / duplicates;
   * returns success. */
  addItemVariable(itemId, name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      console.error(`PowerRP: "${name}" is not a valid variable name (letters, digits, _; not starting with a digit)`);
      return false;
    }
    if (name in this.itemVarsState(itemId)) {
      console.error(`PowerRP: item "${itemId}" already has a variable named "${name}"`);
      return false;
    }
    this.commit(keyframed(this.doc, this.slideIndex, ["items", itemId, "vars", name], 0));
    return true;
  }

  /** Removes a per-item variable FROM EXISTENCE: every keyframe on every slide
   * (the item-scoped Purge — equations referencing it will error loudly). */
  deleteItemVariable(itemId, name) {
    let doc = this.doc;
    for (let i = 0; i < doc.slides.length; i++) doc = unkeyframed(doc, i, ["items", itemId, "vars", name]);
    this.commit(doc);
  }

  /** Renames a per-item variable, rewriting its `self.vars.<name>` /
   * `@id.vars.<name>` references (core/expressions.withItemVariableRenamed — a
   * NARROW sibling of the global rename, never a generalization). Loud on
   * conflicts. */
  renameItemVariable(itemId, oldName, newName) {
    if (newName === oldName) return true;
    try {
      this.commit(withItemVariableRenamed(this.doc, itemId, oldName, newName, this.registry));
      return true;
    } catch (e) {
      console.error(`PowerRP: rename item variable failed: ${e.message}`);
      return false;
    }
  }

  // ── Slides ─────────────────────────────────────────────────────────────────

  // MULTI-SELECTED SLIDES — the slide-rail analogue of `selectionSet`, and the
  // same shape for the same reason: an ARRAY of slide IDs, authoritative when
  // non-empty, with `slideIndex` staying the PRIMARY (what the canvas shows and
  // every single-slide write targets). User request, verbatim (2026-08-02):
  // "Being able to select multiple slides at once could also be useful. And I
  // could drag all of them together, copy them all together, or delete them all
  // together."
  //
  // IDS, NOT INDICES, deliberately: slide indices shift on every insert, delete
  // and reorder — which is precisely what these commands DO — so an index-based
  // set would be stale the instant it was useful. `selectedSlideIndices()` is
  // the ONE resolution point, and it drops ids that no longer exist rather than
  // throwing, because a slide can vanish under a selection (undo, a concurrent
  // delete) and that is not an error.
  //
  // NOT DOCUMENT STATE: not keyframed, not serialized. It describes what you are
  // pointing at, not anything about the deck.
  slideSelection = $state([]);

  /**
   * Query. The selected slides as INDICES, in document order — always non-empty,
   * always including the current slide.
   *
   * The empty `slideSelection` means "just the current slide", exactly as an
   * empty `selectionSet` means "just `selection`". Callers therefore never
   * branch on multi-vs-single: every slide command reads this one list.
   */
  selectedSlideIndices() {
    const picked = this.doc.slides
      .map((s, i) => (this.slideSelection.includes(s.id) ? i : -1))
      .filter((i) => i !== -1);
    return picked.length > 0 ? picked : [this.slideIndex];
  }

  /** Query. Is slide `index` part of the live slide selection? What the rail's
   *  rows read to draw themselves selected. */
  isSlideSelected(index) {
    return this.selectedSlideIndices().includes(index);
  }

  /**
   * Command. THE RAIL'S CLICK RULE, in one place so the three gestures cannot
   * drift apart:
   *   plain      — select just this slide (and make it current)
   *   shift      — extend from the current slide to this one (a RANGE)
   *   cmd/ctrl   — toggle this slide in or out of the set
   *
   * The clicked slide always becomes the PRIMARY (`slideIndex`), including under
   * cmd — the canvas follows your last click, which is what every other rail in
   * the app does. Toggling the last remaining slide out is refused: an empty
   * selection would mean "the current slide" anyway, so the gesture would look
   * like it did nothing while actually resetting the set.
   */
  selectSlideAt(index, { shift = false, toggle = false } = {}) {
    const slides = this.doc.slides;
    if (!(index >= 0 && index < slides.length)) return;
    if (shift) {
      const [lo, hi] = index < this.slideIndex ? [index, this.slideIndex] : [this.slideIndex, index];
      this.slideSelection = slides.slice(lo, hi + 1).map((s) => s.id);
    } else if (toggle) {
      const id = slides[index].id;
      const cur = new Set(this.selectedSlideIndices().map((i) => slides[i].id));
      if (cur.has(id) && cur.size > 1) cur.delete(id);
      else cur.add(id);
      this.slideSelection = slides.filter((s) => cur.has(s.id)).map((s) => s.id);
    } else {
      this.slideSelection = [];
    }
    this.slideIndex = index;
  }

  /** Command. Drops the multi-slide selection back to "just the current slide".
   *  Called by every command that changes the deck's SHAPE (insert, delete,
   *  paste), because a set captured before the change describes rows that may no
   *  longer be what the user pointed at. */
  clearSlideSelection() {
    this.slideSelection = [];
  }

  /**
   * Command (ONE undo unit). THE DROP half of drag-to-reorder: moves the
   * selected slides (or the dragged one) to the BOUNDARY before old index
   * `beforeIndex`, preserving what every slide looks like.
   *
   * A boundary, not a destination row — see `withSlidesMovedToBoundary`. The
   * primary follows the block so the canvas keeps showing the slide you dragged.
   */
  moveSlidesToBoundary(indices, beforeIndex) {
    const moving = [...new Set(indices)].sort((a, b) => a - b);
    if (moving.length === 0) return;
    const primaryId = this.doc.slides[this.slideIndex]?.id;
    const doc = withSlidesMovedToBoundary(this.doc, moving, beforeIndex);
    if (doc === this.doc) return;
    this.commit(doc);
    const at = this.doc.slides.findIndex((s) => s.id === primaryId);
    if (at !== -1) this.slideIndex = at;
  }

  // THE SLIDE CLIPBOARD is IN-MEMORY AND SESSION-LOCAL, unlike the ITEM
  // clipboard (which goes to the server so it can cross TABS — see
  // copySelection). Two reasons, both about scope: a slide payload carries the
  // FOLD of the whole stage (every item's full state), which is orders of
  // magnitude larger than one item's; and a slide is meaningless in another
  // document, where the items it references were never created. Cross-tab slide
  // paste is therefore NOT BUILT rather than half-built — a payload that
  // silently fails to reconstitute elsewhere is worse than a command that only
  // works where it makes sense.
  slideClipboard = $state(null);

  /** Command. Captures the selected slides' FOLDED pictures + identity fields
   *  (core slideClipboardPayload). Deltas are deliberately NOT captured: a delta
   *  means something different in a different place, which is the premise of
   *  core/slide_reorder.js. */
  copySlides() {
    this.slideClipboard = slideClipboardPayload(this.doc, this.selectedSlideIndices());
  }

  /** Query. How many slides are on the slide clipboard — the paste command's
   *  gate AND the number its `requires` sentence states, from one call so the
   *  two can never disagree (the `duplicateKeyframeCount` precedent). */
  slideClipboardCount() {
    return this.slideClipboard?.slides.length ?? 0;
  }

  /**
   * Command (ONE undo unit). Pastes the slide clipboard AFTER the current slide,
   * synthesizing each pasted slide's delta from the fold at the insertion point
   * and re-deriving the slide that now follows the block, so nothing else in the
   * deck changes. Fresh UUIDs; the pasted block becomes the new selection, with
   * the FIRST pasted slide current.
   */
  pasteSlides() {
    if (!this.slideClipboard) return;
    const { document: doc, indices } = withSlidesPasted(this.doc, this.slideIndex, this.slideClipboard, uuid);
    if (indices.length === 0) return;
    this.commit(doc);
    this.slideSelection = indices.map((i) => this.doc.slides[i].id);
    this.slideIndex = indices[0];
  }

  /** Command (ONE undo unit). Duplicate = copy + paste-after, so it is exactly
   *  the paste path and cannot drift from it. It DOES overwrite the slide
   *  clipboard, which is the same thing every editor's Duplicate does and the
   *  reason it is one gesture rather than two. */
  duplicateSlides() {
    this.copySlides();
    this.pasteSlides();
  }

  /**
   * Command (ONE undo unit). Deletes every selected slide. Refuses to empty the
   * deck — a document always has at least one slide (`withSlideDeleted`'s rule,
   * enforced here for the block so the partial delete never happens).
   *
   * Repaired afterwards for the reason `deleteSlide` states: deleting a CREATION
   * slide orphans the items born there, and can orphan the camera.
   */
  deleteSlides() {
    const doomed = this.selectedSlideIndices();
    if (doomed.length === 0) return;
    if (doomed.length >= this.doc.slides.length) {
      console.error("PowerRP: refusing to delete every slide — a document always has at least one.");
      return;
    }
    const drop = new Set(doomed);
    const slides = this.doc.slides.filter((_, i) => !drop.has(i));
    this.commit(this.repaired({ ...this.doc, slides }));
    this.clearSlideSelection();
    this.slideIndex = Math.min(doomed[0], this.doc.slides.length - 1);
  }

  addSlide() {
    const [doc, idx] = withNewSlide(this.doc, this.slideIndex);
    this.commit(doc);
    this.slideIndex = idx;
  }

  /**
   * Command (ONE undo unit). Inserts an empty-delta slide AT a boundary — the
   * navigator's transition-slice `+` affordances, whose two ends mean the two
   * directions the user asked for (2026-08-02): "if I move mouse to either side
   * of it, maybe I'd see a plus symbol, which means add new slide here … on the
   * right side, it would show like a slide plus down arrow because it would add
   * it from the previous slide. And the left side would be like up plus arrow
   * that would insert slide from that direction."
   *
   * BOTH ENDS INSERT AT THE SAME GAP, and in this delta model that is not a
   * fudge: a new slide's delta is EMPTY, so it looks exactly like the slide
   * before it — an "insert from above" and an "insert from below" at one
   * boundary would produce byte-identical documents. What genuinely differs is
   * WHICH SIDE'S NEIGHBOUR the new slide inherits its transition from, and which
   * row ends up current; those are what the two ends do here. The arrows read as
   * "the slide comes from up there" / "from down here", which is the honest
   * description of the inheritance rather than of the insertion point.
   *
   * @param {number} boundary - the gap: 0 is above slide 0, n is after the last
   * @param {"above"|"below"} inheritFrom - which neighbour's transition to copy
   */
  insertSlideAtBoundary(boundary, inheritFrom = "above") {
    const n = this.doc.slides.length;
    const at = Math.max(0, Math.min(n, boundary));
    const [doc, idx] = withNewSlide(this.doc, at - 1);
    // The transition INTO the new slide: copied from whichever neighbour the
    // affordance named, so inserting inside a run of fades does not drop a lone
    // default tween into the middle of it. `withNewSlide` already seeded the
    // default; this only overrides it when there is a neighbour to copy.
    const source = inheritFrom === "below" ? this.doc.slides[at] : this.doc.slides[at - 1];
    const slides = source?.transition
      ? doc.slides.map((s, i) => (i === idx ? { ...s, transition: { ...source.transition } } : s))
      : doc.slides;
    this.commit({ ...doc, slides });
    this.clearSlideSelection();
    this.slideIndex = idx;
  }

  /**
   * Command. New FRESH slide (manifest Round 12): "everything that used to be
   * visible is no longer" — the new slide's delta keyframes active:false for
   * every item visible on the current slide (the camera is exempt: it is not
   * a visible object and must always frame the view). One undo unit.
   */
  addBlankSlide() {
    let [doc, idx] = withNewSlide(this.doc, this.slideIndex);
    for (const n of this.nodes())
      if (n.plugin.capabilities.purgeable !== false)
        doc = keyframed(doc, idx, ["items", n.itemId, "active"], false);
    this.commit(doc);
    this.slideIndex = idx;
  }

  deleteSlide() {
    // Deleting a CREATION slide orphans the items created there (their later
    // property keyframes fold into typeless items that crash evaluation) and
    // can even orphan THE camera — repair + re-ensure, loudly.
    this.commit(this.repaired(withSlideDeleted(this.doc, this.slideIndex)));
    this.slideIndex = Math.min(this.slideIndex, this.doc.slides.length - 1);
  }

  /**
   * Command (reports). The ONE load-boundary repair: orchestrated by
   * core/document.js's repairedDocument (orphans dropped → legacy renames →
   * meta.fps stripped → defaults filled → duration→transition → camera ensured
   * → bindings migrated, order-critical). This is a THIN wrapper — it runs the
   * pure pipeline and prints its report (silent repairs are forbidden; the CLI
   * hook in web/main.js consumes the SAME repairedDocument so the two can't
   * drift, which the cruft audit caught them doing). Bindings migration is now
   * INSIDE the pipeline — callers no longer wrap with withBindingsMigrated.
   */
  repaired(doc) {
    const { doc: out, reports } = repairedDocument(doc, this.registry);
    printRepairReports(reports);
    return out;
  }

  /** Toggles whether slide `index` (default: current) contributes its delta. */
  toggleSlide(index = this.slideIndex) {
    this.commit(withSlideToggled(this.doc, index));
  }

  /** Command (ONE undo unit). Renames slide `index` — the UI seam for the
   *  SlideNav double-click editor and the slide-properties Name field (Round 4
   *  #54: agents could author names in JSON; the user could not from the UI).
   *  Blank restores the positional default (core withSlideRenamed). */
  renameSlide(index, name) {
    this.commit(withSlideRenamed(this.doc, index, name));
  }

  /**
   * Command (ONE undo unit). Moves the current slide by `offset`, PRESERVING
   * WHAT EVERY SLIDE LOOKS LIKE.
   *
   * This used to be a bare array splice (`withSlideMoved`), which moves a
   * slide's DELTA rather than its PICTURE — and a delta means something
   * different in a different place, so a move rewrote the deck downstream of it
   * (user, 2026-08-02: "when I move slide up and move slide down, it does like
   * change way more than I bargained for"). `movedSlidePreservingLook` folds
   * every slide first, permutes the folded sequence, and re-derives each delta
   * as the minimal diff between neighbours, so the only thing that changes is
   * the order. core/slide_reorder.js has the law and its one exclusion
   * (disabled slides, which have no fold of their own).
   */
  moveSlide(offset) {
    this.commit(movedSlidePreservingLook(this.doc, this.slideIndex, offset));
    this.slideIndex = Math.max(0, Math.min(this.doc.slides.length - 1, this.slideIndex + offset));
  }

  /**
   * Query. How many NO-OP keyframes the document carries — leaves whose value
   * the fold already holds at that slide, so deleting them changes nothing.
   * Read by the Simplify command's gate AND by its `requires` sentence, which is
   * why it is a method rather than an inline expression: one call answers "may
   * it run" and "how many", and the two can never disagree.
   *
   * Cheap enough for the availability hot path (core/commands.js's O(cheap)
   * contract): one fold of the document, no evaluation, no render tree.
   */
  duplicateKeyframeCount() {
    return duplicateKeyframes(this.doc).length;
  }

  /**
   * Command (ONE undo unit). Deletes every no-op keyframe. Appearance-preserving
   * by construction — each removed leaf was already satisfied by the fold — and
   * the counterweight to reorder, which synthesizes deltas that can be larger
   * than the ones an author typed (user, 2026-08-02: "make that a tool of
   * simplify duplicate keyframes that would only be enabled or give some
   * indicator of how many things we simplify").
   */
  simplifyDuplicateKeyframes() {
    const { document: doc, count } = simplifyDuplicateKeyframes(this.doc);
    if (count > 0) this.commit(doc);
  }

  // ── Local-disk DOCUMENT import/export ──────────────────────────────────────
  // These two move the DOCUMENT ONLY — the {meta, slides} JSON body — between
  // the editor and a file on the user's disk. They do NOT touch the server and
  // do NOT carry assets: an asset lives in the project folder and is referenced
  // from the document as a /asset/<project>/<file> backend URL (#resolvedSrc),
  // so a .powerrp.json alone is not self-contained. That is why the commands are
  // titled "Export/Import Document … (no assets)" and why the with-assets round
  // trip is Save Project to Server / Export Project as .zip instead.

  /** Command (browser download). Write the DOCUMENT (no assets) to a
   *  <name>.powerrp.json file on the user's disk. Surfaced as "Export Document
   *  as .powerrp.json (no assets)". */
  saveFile() {
    const blob = new Blob([serialize(this.doc)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${this.projectDisplayName()}.powerrp.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** Command. Read a DOCUMENT (no assets) from a .powerrp.json file the user
   *  picks, replacing the open document. Opens the OS file picker, hence the
   *  ellipsis on its title "Import Document from .powerrp.json…". */
  async loadFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    const file = await new Promise((res) => {
      input.onchange = () => res(input.files[0]);
      input.click();
    });
    if (!file) return;
    // Legacy .powerrp.json still LOADS (manifest Round 12: on-disk is now a
    // folder, but old single-file saves migrate through the same repair path).
    // repaired() runs the full pipeline (bindings migration included).
    this.commit(this.repaired(deserialize(await file.text())));
    this.slideIndex = 0;
    this.selection = null;
  }

  // ── Project server (projects are FOLDERS: doc.json + assets/) ────────────────
  // The server (server/server.py) owns project storage. These methods are the
  // app's seam to it (thin client = web/projectApi.js). doc.meta.name is the
  // project name. The localStorage autosave (commit → AUTOSAVE_KEY) stays as
  // crash-safety and is INDEPENDENT of project storage — a project must be
  // saved to the server explicitly (Save Project to Server). Errors surface
  // loudly. A PROJECT = document + assets/; a DOCUMENT = the JSON body alone
  // (the local-disk region above) — the two nouns are different payloads, and
  // every command title says which one it moves.

  /**
   * THE OPEN DRAFT, or null when the open project is an ordinary library entry.
   * `{name, sourceUrl}` — the human name to display and the URL the zip came
   * from ("" for a dropped file, which is what gates the share link).
   *
   * A DRAFT IS A WORKING COPY THAT IS NOT IN THE LIBRARY (web/projectDraft.js
   * has the full contract). Only a zip/url import sets this; OPENING A SERVER OR
   * BROWSER-LIBRARY PROJECT LEAVES IT NULL, because that project IS the library
   * entry and is saved in place exactly as before. Every draft-aware branch
   * below is therefore inert in the ordinary case.
   */
  draftMode = $state(null);

  /**
   * Query. THE STORAGE KEY every asset read and write uses — the draft keyspace
   * while a draft is open, else the project name (doc.meta.name).
   *
   * THE INVARIANT, stated where it bites: this ONE function is what repoints the
   * whole app at a draft's staged assets. `storageMode.js` installs it into
   * `core/asset_ref`'s resolver and six production call sites derive with its
   * result, so returning the draft key here makes the canvas, thumbnails,
   * minimap, exports, the Asset Explorer and plugin assets all resolve against
   * the staging at once. A "draft" flag threaded through those readers instead
   * would have to find all six and would drift when a seventh appeared.
   *
   * IT IS NOT THE DISPLAY NAME. The draft key contains "/" and can never be a
   * real project name (server.py `_SAFE_NAME`), so it must never reach the title
   * bar or an export filename — see `projectDisplayName()`, which is what those use.
   */
  projectName() {
    if (this.draftMode) return DRAFT_KEY;
    return this.doc.meta.name || UNTITLED_NAME;
  }

  /** Query. The HUMAN project name: what the title bar shows and what every
   *  export filename (document/.zip/PNG/PDF/SVG/MP4) is stemmed from, so a
   *  downloaded file is named the thing the toolbar says. Identical to
   *  `projectName()` for a saved project; for a DRAFT it is the deck's real name
   *  ("RobotSim") while `projectName()` is the storage key ("~draft/current").
   *
   *  NAMED projectDisplayName, not displayName: `displayName(itemId)` already
   *  exists on this class and names an ITEM. Two different nouns, so two names —
   *  the collision was a real crash ("displayName has already been declared"),
   *  caught by draft_open_static_probe.js. */
  projectDisplayName() {
    return this.doc.meta.name || UNTITLED_NAME;
  }

  /**
   * Query. IS THE OPEN WORKING COPY AN UNSAVED DRAFT — not in the project library.
   *
   * THE ONE PREDICATE the four save surfaces read: the quick-Save command's `when`
   * gate, the Cmd+S dispatch, the save indicator's sentence, and the unsaved-work
   * guard. The rule itself is `draftKeys.isUnsavedDraft`, pure and doctested; this
   * is only the binding of app state to it, so the browser cannot hold an opinion
   * the bare-node gate does not execute.
   *
   * TWO STATES, ONE ANSWER (the user's unification): an IMPORTED draft (a dropped
   * .zip or a share link — `draftMode`) and a FRESH document (`everSaved` false)
   * are the same thing, "not in the library yet", and get the same ceremony. Note
   * the NAME is not consulted: renaming an unsaved document is naming it at save
   * time, not saving it — see isUnsavedDraft's ruling block.
   */
  isDraft() {
    return isUnsavedDraft(this.draftMode, this.everSaved);
  }

  /**
   * Command (async; MOVES STORAGE, NOT AN UNDO UNIT). Rename the PROJECT: move
   * projects/<old> → projects/<new> (HTTP) or re-key its IndexedDB records
   * (static), then set doc.meta.name to follow. Trims; a blank or unchanged name
   * is a no-op, so the title can never be emptied.
   *
   * THE DEFECT THIS REPLACES (user, verbatim): "as soon as I renamed the project,
   * all the assets disappeared. That's cursed." Renaming used to write
   * doc.meta.name and NOTHING ELSE, leaving every asset under the OLD folder while
   * every reader — the Asset Explorer's listing, and the resolution of every
   * relative `src` — asked under the NEW name and found nothing.
   *
   * THE USER'S RULING: "rename should not copy a project — rename should rename
   * and MOVE a project… If I rename a project it should rename the folder and
   * everything inside it is implicitly renamed." THE FOLDER IS THE IDENTITY;
   * doc.meta.name FOLLOWS it, never the reverse (loadProject stamps the folder
   * name onto whatever it reads, so a hand-run `mv` renames the project too).
   *
   * NOT UNDOABLE, AND THAT IS THE POINT. This does not go through `commit`, so it
   * makes no undo unit. A document-undo can only restore doc.meta.name; it cannot
   * move a folder back. So an undoable rename would put the title back to "Old"
   * while the bytes sat in "New" — the EXACT stranding this fixes, re-created in
   * reverse and with no gesture that repairs it. Undoing a rename is renaming
   * back, which genuinely moves back. (Undo-stack contents are otherwise
   * untouched: the document did not change, so nothing in the history is stale.)
   *
   * THE ORDER IS LOAD-BEARING — relativize+save, THEN move, THEN name — and each
   * step leaves a CONSISTENT state if the next one fails:
   *
   *   1. RELATIVIZE own-project absolute refs and SAVE, still under the OLD name.
   *      A legacy "/asset/Old/clip.mp4" would name a dead folder the instant the
   *      move happened; "clip.mp4" names no project and survives it. The rewrite
   *      is semantically a NO-OP AT THIS INSTANT (both spellings resolve to the
   *      same file while the doc still lives in "Old"), which is what makes it
   *      safe to persist BEFORE the move rather than after. FAILURE HERE: nothing
   *      has moved, the document is either its original self or its relativized
   *      equivalent — both correct under the old name. Fully working project.
   *   2. MOVE the storage. One os.rename server-side (atomic within a filesystem)
   *      or one re-key pass locally. FAILURE HERE: the move did not happen, the
   *      document is still relativized under the OLD name, and meta.name still
   *      says "Old" because step 3 has not run. Fully working project, and the
   *      user sees the refusal (a taken name) with nothing to clean up.
   *   3. SET meta.name. Only now, when the bytes are provably at the new name.
   *      This is a plain field write, not a commit.
   *
   *   The inverse order is what fails: naming first (today's bug) strands every
   *   asset for the whole window; moving before relativizing leaves legacy
   *   absolute self-refs pointing at a folder that no longer exists, and the save
   *   that would fix them would then have to be written to the NEW folder — so a
   *   crash between the two loses the repair rather than being a no-op.
   *
   * The relativize+save in step 1 is SKIPPED when the document holds no
   * own-project absolute refs (the overwhelmingly common case now that writers
   * mint relative refs): there is nothing to rewrite, so there is nothing to
   * persist, and a rename must not push an unrelated in-flight edit to storage.
   *
   * @param {string} name - the new project name
   * @returns {Promise<string|undefined>} the new name, or undefined for a no-op
   */
  async renameProject(name) {
    const trimmed = (name ?? "").trim();
    const from = this.projectName();
    if (!trimmed || trimmed === from) return;

    // A DRAFT HAS NO FOLDER TO MOVE — the rename is a WORKING-COPY EDIT, and the
    // name is held until Save commits it (user ruling: "renaming the Untitled
    // project… should be the same as saving a new project", i.e. renaming must
    // NOT be the thing that creates a library entry). The three-step move below is
    // for SAVED projects only; running it on a draft would ask storage to move
    // `~draft/current` — a key the server's name rule forbids, so it would fail
    // loudly, and if it somehow did not, it would mint the very library entry the
    // working-copy model exists to refuse. Save-As is what promotes this name into
    // the library, under whatever the working copy holds at that moment.
    if (this.isDraft()) {
      this.doc = { ...this.doc, meta: { ...this.doc.meta, name: trimmed } };
      if (this.draftMode) {
        // Keep the persisted draft marker's display name in step with the doc, so
        // a reload restores the deck under the name the user just typed.
        this.draftMode = { ...this.draftMode, name: trimmed };
        localStorage.setItem(DRAFT_STATE_KEY, JSON.stringify(this.draftMode));
      }
      return trimmed;
    }

    // STEP 1 — relativize own-project absolute refs, and persist that BEFORE the
    // move (see the ordering proof above). `plainDoc` de-proxies the $state doc so
    // the pure walk sees a plain object; the comparison against it (not against
    // the proxy) is what makes "nothing to rewrite" a reliable skip.
    const before = plainDoc(this.doc);
    const relativized = relativizedOwnRefs(before, from);
    if (JSON.stringify(relativized) !== JSON.stringify(before)) {
      this.doc = relativized;
      await this.saveToServer(from);
    }

    // STEP 2 — move the storage. Loud on a refusal (missing source, taken name);
    // meta.name has NOT been touched yet, so the project stays consistent.
    await projectStore().rename(from, trimmed);

    // STEP 3 — the name follows the folder. A field write, NOT a commit: renaming
    // is a storage operation and must not enter the document undo stack.
    this.doc = { ...this.doc, meta: { ...this.doc.meta, name: trimmed } };
    // The document at the new name IS what storage holds (step 1 persisted any
    // rewrite; step 2 moved those exact bytes), so the save indicator must not
    // report a freshly-renamed project as unsaved work.
    this.savedDoc = this.doc;
    // The project's plugin assets are keyed by project name — rebuild the registry
    // against the new one so a *.plugin.js widget keeps resolving after the move.
    await this.reloadPluginAssets(trimmed);
    return trimmed;
  }

  /** Query. Whether a project FOLDER named `name` already exists on the server —
   *  a case-sensitive exact match against the SAME list the Open modal renders
   *  (listProjects). The Save modal reads this to WARN before overwriting, so a
   *  save can never silently clobber a different project. Blank → false. */
  async projectExists(name) {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return false;
    return (await this.listProjects()).some((p) => p.name === trimmed);
  }

  /** Command. Save the current document to the server as a project FOLDER
   *  (doc.json under projects/<name>/). Creates the folder if new. Throws
   *  loudly on failure so the caller can surface it.
   *
   *  Maintains the save-indicator state around the request: `saving` is raised
   *  for the duration and lowered in a `finally` so a THROWN save cannot leave
   *  the indicator stuck mid-flight, while `savedDoc`/`lastSavedAt` advance only
   *  on success — a failed save must keep reading as UNSAVED, which is the whole
   *  point of the indicator. The doc is captured BEFORE the await so an edit
   *  made while the request is in flight still reads as dirty afterwards
   *  (marking `this.doc` on return would silently claim that edit was saved). */
  async saveToServer(name = this.projectName()) {
    const sent = this.doc;
    this.saving = true;
    try {
      await projectStore().save(name, sent);
      this.savedDoc = sent;
      this.lastSavedAt = Date.now();
      // THE WORKING COPY IS NOW IN THE LIBRARY. Set on SUCCESS only (inside the
      // try, after the await) so a save that throws leaves a draft a draft — the
      // same discipline savedDoc/lastSavedAt already follow, and for the same
      // reason: a failed first save must not hand the user a quick-Save that
      // writes to an entry which does not exist.
      this.everSaved = true;
    } finally {
      this.saving = false;
    }
    return name;
  }

  /**
   * Command (async; COPIES STORAGE). SAVE-AS = FORK: write the current document
   * to a NEW project `name` AND copy this project's assets into it, leaving the
   * ORIGINAL project completely intact and working.
   *
   * SAVE-AS IS THE OPPOSITE VERB FROM RENAME, and conflating them is what the old
   * code did wrong. Rename MOVES (one project, new identity); Save-As FORKS (two
   * projects, both complete). Save-As used to call renameProject then save, which
   * minted DIVERGENCE: the new folder got a doc.json and no assets, while every
   * relative `src` in it now resolved against a library that was not there. The
   * fork's copy is what makes the new project stand on its own.
   *
   * THE ORDER IS COPY-THEN-SAVE. The assets land first, so at no instant does a
   * doc.json exist at `name` whose refs resolve to nothing — a fork interrupted
   * after the copy is an asset folder with no document (invisible: the listing
   * shows it with slideCount null, and the next save completes it), whereas one
   * interrupted after a save-first would be exactly the broken project this
   * exists to prevent.
   *
   * The copy runs SERVER-SIDE in HTTP mode (one request; a large video never
   * transits the browser) and blob-by-blob in static mode. Existing destination
   * files are never overwritten in either mode.
   *
   * The editor then FOLLOWS the fork — the open project becomes the new one, which
   * is what "Save As" means everywhere else — by setting meta.name directly (a
   * field write, not a commit: like rename, this is a storage operation, and an
   * undo cannot un-write a folder).
   *
   * @param {string} name - the NEW project's name
   * @returns {Promise<{name: string, copied: string[], skipped: string[]}>}
   */
  async saveProjectAsFork(name) {
    const trimmed = (name ?? "").trim();
    const from = this.projectName();
    if (!trimmed) throw new Error("saveProjectAsFork: a fork needs a name");
    if (trimmed === from) throw new Error(`saveProjectAsFork(${trimmed}): that is the project already open — use Save, not Save As`);
    const copy = await projectStore().copyAssets(from, trimmed);
    this.doc = { ...this.doc, meta: { ...this.doc.meta, name: trimmed } };
    await this.saveToServer(trimmed);
    // Plugin assets are keyed by project name; the fork has its own copies now.
    await this.reloadPluginAssets(trimmed);
    if (copy.skipped?.length)
      console.warn(`Save As "${trimmed}": ${copy.skipped.length} asset(s) already existed in the destination and were NOT overwritten: ${copy.skipped.join(", ")}`);
    return { name: trimmed, copied: copy.copied ?? [], skipped: copy.skipped ?? [] };
  }

  /** Query. The save indicator's state: "saving" while a request is in flight,
   *  "saved" when the current document IS the one last written to the server,
   *  else "unsaved". Identity, not deep equality — see `savedDoc`.
   *
   *  A never-saved document reads "unsaved", which is correct: nothing of it
   *  exists on the server yet.
   *
   *  @returns {"saving"|"saved"|"unsaved"}
   *
   *  @example
   *  >>> // fresh app, nothing sent to the server yet
   *  >>> app.saveState()
   *  "unsaved"
   *  >>> await app.saveToServer("Deck"); app.saveState()
   *  "saved"
   *  >>> app.commit(editedDoc); app.saveState()
   *  "unsaved"
   */
  saveState() {
    if (this.saving) return "saving";
    return this.savedDoc === this.doc ? "saved" : "unsaved";
  }

  /** Query. List saved projects on the server (newest first) — the data the
   *  Open modal renders. Exposed so the UI can be a lib Modal (built in
   *  parallel); no ad-hoc dialog is built here. */
  async listProjects() {
    return projectStore().list();
  }

  /** Query. Fetch a project's raw {doc, assets} from the server WITHOUT loading
   *  it into the editor (loadProject mutates editor state — this does not). The
   *  Open modal's preview grid uses this to rasterize each project's slide 0
   *  off to the side. Throws loudly on a non-OK response (same as loadProject). */
  async fetchProjectDoc(name) {
    return projectStore().load(name);
  }

  /** Command. THE GUARDED OPEN — what the Open Project picker calls when the user
   *  chooses a project. Asks about unsaved work first (the ONE gate; see
   *  guardedOpen), then loads. Returns whether the load ran, so the caller can
   *  tell "opened" from "user cancelled".
   *
   *  DISTINCT FROM `loadProject`, DELIBERATELY, and the split is the opposite of
   *  what it first looks like: the GESTURE is guarded, the API is not.
   *  `loadProject` is a plain programmatic load with ~a dozen callers — probes and
   *  fixtures that seed a project, the render-job page, boot paths — none of which
   *  has a user to answer a dialog. Guarding the API instead would DEADLOCK every
   *  one of them on a modal nobody can click, which is not a hypothetical: it hung
   *  project_rename_probe on a CDP timeout the moment it was tried. So the gate
   *  sits where a human actually is. */
  async openProjectNamed(name) {
    return this.guardedOpen(() => this.loadProject(name), `the project "${name}"`);
  }

  /** Command. Load a project from the library by name into the editor (same
   *  repair + binding migration as loadFile). UI resets mirror loadFile. A new
   *  project's font assets must re-register so a text run's `font` id resolves,
   *  so dynamic fonts are cleared (drop the prior project's) then re-synced.
   *
   *  UNGUARDED, and that is its job — see openProjectNamed above for the split.
   *  Any USER-FACING open must go through that instead. */
  async loadProject(name) {
    const { doc } = await projectStore().load(name);
    // PRIME THE ASSET URLS BEFORE THE FIRST PAINT. #resolvedSrc is synchronous
    // (derive/paint cannot await), so in LOCAL mode every one of this project's
    // blob: object URLs must exist before the deck renders — otherwise the first
    // frame resolves every image to the MISSING sentinel and reports a library
    // full of broken assets that are actually present. A no-op in HTTP mode,
    // where a ref resolves by string rewrite alone.
    await assetStore().primeUrls(name);
    clearDynamicFonts(); // drop the previous project's uploaded font families
    // PLUGIN ASSETS BEFORE REPAIR — THE ORDER IS LOAD-BEARING, NOT STYLISTIC.
    // A `*.plugin.js` asset registers a widget TYPE, and repairedDocument's first
    // step drops every item whose type no plugin claims (core/document.js
    // orphanedItems). Repairing first would therefore delete every instance of an
    // asset-defined widget AND save the deletion back — data loss, in the exact
    // case the feature exists for (a deck someone else authored, whose widgets
    // travel with it). Awaited, and awaited HERE, for that reason.
    await this.reloadPluginAssets(name);
    // OPENING SETS THE NAME: the server folder is authoritative, so the title,
    // any future Save, and a possibly-stale stored meta.name all agree on `name`
    // (keeps title / open / save consistent — the one-name-model invariant).
    const repaired = this.repaired(doc); // repaired() includes bindings migration
    this.commit({ ...repaired, meta: { ...repaired.meta, name } });
    // A JUST-OPENED project IS the server's copy, so the save indicator must
    // read SAVED rather than showing a freshly-opened deck as unsaved work.
    // Marked AFTER commit and from `this.doc`, because commit() is what installs
    // the object identity savedDoc is compared against — marking the local
    // literal instead would compare against something the app never adopted.
    // (If repair rewrote anything, that rewrite is genuinely not on the server;
    // the repair pipeline reports such migrations loudly on its own channel.)
    this.savedDoc = this.doc;
    this.lastSavedAt = Date.now();
    // OPENED FROM THE LIBRARY, so it IS in the library — quick-Save writes back to
    // this folder even though this session has not written to it yet. This is the
    // half of everSaved that a "has been written" flag alone would get wrong.
    this.everSaved = true;
    this.slideIndex = 0;
    this.selection = null;
    this.syncFontAssets(name); // fire-and-forget: register + load this project's font assets
  }

  // ── PLUGIN ASSETS: a widget that is a project asset ─────────────────────────
  // A `*.plugin.js` asset declares a whole widget type (core/plugin_assets.js
  // runs it in the equation evaluator's jail). Its lifecycle is per-PROJECT, so
  // it is rebuilt on every open — see reloadPluginAssets for why "rebuild" rather
  // than "deregister".

  /**
   * Command (rebuilds this.registry; reports). Point the app's registry at
   * `name`'s plugin assets: the built-in roster, then that project's `*.plugin.js`
   * assets. MUST be awaited before repairedDocument sees the project's document
   * (see the comment at the call site in loadProject).
   *
   * A REBUILD, NOT A DEREGISTER. core/registry.js exposes register/get/all and no
   * removal, deliberately — a plugin map that could shrink under a live document
   * lets a derive walk meet a node whose plugin vanished mid-frame. So switching
   * projects constructs a fresh registry from the built-in roster and loads the
   * new project's assets into that.
   *
   * THE COMMANDS REGISTRY IS DELIBERATELY NOT REBUILT, and passing it here was a
   * measured bug: `registerAll(registry, commands)` adds each plugin's palette
   * commands as well as the plugin, and core/commands.js refuses a duplicate id —
   * so the second project open threw `Duplicate command id "add-rect"` and left
   * the editor unopenable. The right model is that the two registries have
   * DIFFERENT lifetimes: plugin types are per-project (an asset defines one), while
   * palette commands are process-lifetime and were fully populated by the
   * constructor. Nothing project-scoped can be in there to drop, because a plugin
   * asset may not declare `commands` at all (the sandbox withholds the live app).
   * `registerPlugins` registers the roster WITHOUT touching commands, for exactly
   * this call.
   *
   * Failures are REPORTED, never thrown: one bad plugin asset must not make a
   * project unopenable, and every refusal is printed naming the file
   * (printPluginAssetReports). A widget that silently failed to register is
   * indistinguishable to the user from one that was deleted.
   */
  async reloadPluginAssets(name = this.projectName()) {
    this.registry = createRegistry();
    registerPlugins(this.registry); // types only — commands are process-lifetime (see above)
    const result = await loadProjectPluginAssets(this.registry, assetStoreFor(name), name);
    printPluginAssetReports(result, name);
    this.pluginAssetTypes = result.loaded; // what the Insert menu offers (App.svelte)
    // The FILE→TYPE map, for acting on one asset by its filename (the canvas
    // drop-to-instantiate path). Replaced, not merged: this rebuilt the whole
    // registry above, so a stale entry would name a type that is no longer
    // registered and the drop would throw "Unknown widget type".
    this.pluginAssetTypeByFile = { ...result.types };
    // EVERY loaded plugin-asset widget appears in the palette as "Plugin: <name>"
    // (user ruling). Rebuilt here, on every project load, because the widget SET is
    // per-project — see plugins/builtin_asset_commands.js for why this is one stable
    // submenu with replaceable children rather than N registered commands.
    refreshPluginWidgetCommands(this.pluginAssetPlugins());
    return result;
  }

  /** Query. The widget types this project's plugin assets registered, in load
   *  order. Empty for a project with no `*.plugin.js` assets. */
  pluginAssetPlugins() {
    return (this.pluginAssetTypes ?? []).map((type) => this.registry.get(type));
  }

  // ── Fonts as an ASSET (#26): a project-uploaded font file becomes a
  // SELECTABLE family. registerFontAssets makes each font-kind asset resolve
  // (render_gpu/fonts.js dynamic registry) AND loads it into the browser so it
  // actually renders. Called from the Asset Explorer's re-list (any project /
  // upload change) and after loadProject — one registration pathway. ──────────

  /** Command. Register every font-kind asset in `assetList` as a selectable
   *  family and load its face into the browser. Idempotent (re-registering a
   *  family overwrites; the loader skips an already-loaded face). An invalid
   *  font file surfaces LOUDLY (console.error) but never blocks the others or
   *  the asset list (#26 "loud on invalid font"). Returns the ids registered. */
  registerFontAssets(assetList) {
    const ids = [];
    for (const a of assetList ?? []) {
      if (a.kind !== "font") continue;
      const id = fontAssetId(a.name);
      // Through the STORAGE SEAM: a locally stored font resolves to a blob: URL,
      // which is what FontFace() needs to load bytes that never touched a server.
      const src = this.#resolvedSrc(a.url);
      const { cssFamily, url } = fontDescriptor(id).dynamic
        ? fontDescriptor(id)
        : registerFontFamily(id, { filename: a.name, url: src, title: a.name });
      ids.push(id);
      loadDynamicFont(cssFamily, url ?? src).catch((e) => {
        console.error(`registerFontAssets: ${e.message}`);
      });
    }
    return ids;
  }

  /** Command. List the current project's assets and register its font assets
   *  (loadProject path). Fire-and-forget; errors surface loudly. */
  async syncFontAssets(name = this.projectName()) {
    try {
      this.registerFontAssets(await assetStoreFor(name).list(name));
    } catch (e) {
      console.error(`syncFontAssets: could not list assets for "${name}":`, e);
    }
  }

  /** Command (browser: rasterizes via pdfjs, persists via the server thumb
   *  cache). Ensure an asset has a cached {thumbnail, badge}. For a PDF with no
   *  server-cached thumbnail yet, rasterize page 1 client-side + POST it so it
   *  persists for next session. Returns {thumbnail, badge} for immediate tile
   *  display, or null when nothing to render (already cached / not a
   *  client-thumbnail kind). Rejects loudly on a rasterize/store failure so the
   *  caller shows the plain kind icon (never a silently-blank tile). */
  async ensureAssetThumbnail(asset, name = this.projectName()) {
    const pres = assetTilePresentation(asset);
    if (!pres.needsClientThumbnail) return null; // already cached, or a kind we don't rasterize
    const { renderPdfThumbnail } = await import("../render_gpu/gpu/asset_thumbnail.js");
    const { dataUrl, pageCount } = await renderPdfThumbnail(this.#resolvedSrc(asset.url));
    const badge = pageCountBadge(pageCount);
    // Persist for next session — BEST-EFFORT. The thumbnail is already rendered
    // (returned below); a disk-cache write failure must not lose it. If the backend
    // exposes no thumb route (e.g. a frontend-only harness / a backend hiccup), learn
    // it ONCE and stop retrying — thumbnails still render in-session. A failed
    // optional-cache write is non-fatal, so warn ONCE (not error, not per-asset).
    // In STATIC mode there is no disk cache to persist into — the thumbnail is
    // already rendered and returned, so the honest behavior is to skip the write
    // rather than POST at a route that cannot exist. Learned once, reported once
    // (UNAVAILABLE_IN_STATIC.thumbnailCache names this exact bound).
    if (isStatic()) this._thumbPersistUnavailable = true;
    if (!this._thumbPersistUnavailable) {
      const png = await (await fetch(dataUrl)).blob();
      projectApi.storeThumb(name, asset.name, asset.mtime, badge, png).catch((e) => {
        this._thumbPersistUnavailable = true;
        console.warn(`ensureAssetThumbnail: thumbnail disk-cache unavailable (${e?.message ?? e}); rendering in-session only.`);
      });
    }
    return { thumbnail: dataUrl, badge };
  }

  /** Command. Export the whole project (document + assets) to a .zip file on the
   *  user's disk — the archive is built server-side from the project folder.
   *  SAVES TO THE SERVER FIRST so the .zip reflects the live document; that
   *  server write is stated in the command's title, since a title that only said
   *  "Download" would have hidden it. */
  async downloadZip(name = this.projectName()) {
    await this.saveToServer(name);
    // The archive is built where the bytes LIVE: server-side from the project
    // folder in HTTP mode, in the page from IndexedDB in static mode. Both
    // produce the SAME layout ("<name>/doc.json" + "<name>/assets/…" — see
    // web/projectZip.js), so an archive from either half imports into either
    // half. That interchangeability is the whole transfer story.
    //
    // BOTH HALVES ALSO LOCALIZE: a document may reference another project's asset
    // (Save-As mints exactly that), and an archive that shipped such a ref without
    // the file was the user's "the robotsim.zip references a video file, but that
    // video file is not in that zip" bug. The foreign bytes are copied in and the
    // ARCHIVED doc rewritten; the saved project is left as authored. An asset that
    // could not be copied is WARNED about, never dropped silently.
    if (isStatic()) {
      const { bytes, warnings } = await buildProjectZip(name, this.doc, assetStore());
      for (const w of warnings) console.warn(`downloadZip(${name}): ${w}`);
      // The MIME type is STATED, not defaulted: downloadBytes is general (it also
      // saves assets, renders and decks), so "application/zip" is this call's fact
      // to declare rather than the helper's to assume.
      downloadBytes(bytes, `${name}.zip`, "application/zip");
      return;
    }
    const { warnings } = await projectApi.downloadProjectZip(name);
    for (const w of warnings) console.warn(`downloadZip(${name}): ${w}`);
  }

  /** Query. How many of this document's asset references point at ANOTHER project
   *  — the count "Localize Foreign Assets" would move. Zero means the project is
   *  already self-contained, which is what gates the command out of the palette. */
  foreignAssetCount() {
    return foreignAssetRefs(documentAssetRefs(this.doc), this.projectName()).length;
  }

  /**
   * Command (mutates the asset store AND the document; ONE undo unit). Copy every
   * asset this document borrows from another project INTO this project, and repoint
   * the references at the local copies.
   *
   * WHY THIS EXISTS AS A USER-FACING ACTION and not only inside the exporters. The
   * exporters localize into the ARCHIVE, which fixes the .zip but leaves the live
   * project still borrowing — so the next export does the same work again, and the
   * project remains one deleted folder away from a hole. This makes the fix
   * PERMANENT and visible: after it runs, the document says what it actually
   * depends on. The exporters keep their own localization anyway, because an author
   * must never be REQUIRED to run a maintenance command to get a working archive.
   *
   * WHERE THE FOREIGN REFS COME FROM: Save-As. `saveProjectAs` renames
   * doc.meta.name and saves the document to a NEW project folder, while the assets
   * stay in the folder they were uploaded to — so every `src` keeps naming the old
   * project. This server serves `/asset/<any project>/…` to anyone, so nothing
   * breaks locally and the divergence is invisible until the deck leaves the
   * machine.
   *
   * Runs through the asset store seam, so it works identically in HTTP and static
   * mode. An unreadable foreign asset is REPORTED and its reference left alone
   * (still findable) rather than repointed at a local file that will not exist.
   *
   * @param {string} name - the project to localize into (default: the open one)
   * @returns {Promise<{moved: Array<{from: string, to: string}>, warnings: string[]}>}
   */
  async localizeForeignAssets(name = this.projectName()) {
    const store = assetStoreFor(name);
    const listing = await store.list(name);
    const plan = localizationPlan(
      documentAssetRefs(this.doc),
      name,
      listing.map((a) => a.name),
      uniqueAssetName,
    );
    const moved = [];
    const warnings = [];
    const landed = {};
    for (const c of plan.copies) {
      let blob;
      try {
        blob = await store.get(c.project, c.file);
      } catch (e) {
        warnings.push(`/asset/${c.project}/${c.file} could not be read (${e?.message ?? e}); its reference was left as-is`);
        continue;
      }
      // `put` de-collides again on its own, so the FINAL name is whatever the store
      // returns — not the plan's guess. Trusting the guess is how a copy would end
      // up stored as "logo-2.png" while the document pointed at "logo 2.png".
      const res = await store.put(name, blob, c.as);
      landed[c.ref] = assetRef(name, res.name);
      moved.push({ from: c.ref, to: landed[c.ref] });
    }
    if (moved.length) this.commit(rewriteAssetRefs(this.doc, (e) => landed[e.ref] ?? null));
    for (const w of warnings) console.warn(`localizeForeignAssets(${name}): ${w}`);
    for (const m of moved) console.log(`localizeForeignAssets(${name}): ${m.from} → ${m.to}`);
    if (!moved.length && !warnings.length) console.log(`localizeForeignAssets(${name}): already self-contained — nothing to move.`);
    return { moved, warnings };
  }

  // ── Opening a .zip: the inverse of downloadZip ─────────────────────────────
  // "I can export a zip — can I OPEN one?" A .zip is the PROJECT payload
  // (document + assets), so opening one cannot be the DOCUMENT-only loadFile
  // path — it carries assets, which a .powerrp.json does not.
  //
  // IT OPENS AS A DRAFT (user ruling; see the DRAFTS region below). This used to
  // WRITE FIRST — the archive landed on the server or in IndexedDB as a new
  // project folder before the editor ever showed it, so merely LOOKING at
  // someone's deck left "RobotSim", "RobotSim 2", "RobotSim 3" behind. Now the
  // archive is staged into the draft keyspace and the library gains nothing
  // until the user saves. The current deck is still untouched until the draft
  // opens successfully.

  /** Hook installed by App.svelte: shows the import RESULT (or refusal) as a
   *  modal. Assigned there so this class stays DOM-free; the default is a
   *  console report, so a harness without the shell still says what happened
   *  rather than swallowing it. */
  showImportResult = (result) => console.log("PowerRP import:", result);

  /**
   * Command. Open an exported project .zip (a File/Blob from a drop or the file
   * picker) as a DRAFT. Returns `{ok, name, requested, draft: true}`.
   *
   * NOTHING IS WRITTEN TO THE LIBRARY. The document lands in the working buffer
   * and the assets in the draft keyspace, so opening the same archive twice
   * produces two clean drafts and zero projects — which is why the old
   * "<Name> 2" de-collision no longer appears here. There is no collision to
   * resolve: a draft has no name in the library to collide with, and the name
   * shown is simply what the user dropped.
   *
   * ADAPTER-BLIND, and now for a stronger reason than before: a draft ALWAYS
   * stages locally, in both storage modes, so this path no longer branches on
   * `isStatic()` at all. The server is involved only when the user saves.
   *
   * A refusal (not a zip, no doc.json, unsafe member) surfaces through
   * showImportResult AND rethrows, so a caller with its own error affordance
   * still sees it and nothing opens.
   */
  async importProjectZip(file) {
    const requested = projectApi.projectZipName(file.name ?? "");
    let result = null;
    // GUARDED: dropping a zip REPLACES the working copy ("Same thing if I drag a
    // zip into it"). Cancelling returns {ok:false, cancelled:true} rather than
    // throwing — a user who said "don't" has not hit an error.
    const opened = await this.guardedOpen(async () => {
      try {
        const { name, assetCount } = await this.openDraftFromZipBytes(new Uint8Array(await file.arrayBuffer()), requested, "");
        result = { ok: true, name, requested, draft: true, assetCount };
        this.showImportResult(result);
      } catch (e) {
        this.showImportResult({ ok: false, requested, error: String(e.message ?? e) });
        throw e;
      }
    }, `"${requested || file.name || "that .zip"}"`);
    return opened ? result : { ok: false, requested, cancelled: true };
  }

  /** Command. Pick a .zip from disk and import it (the menu route to the same
   *  thing dropping one on the canvas does). Opens the OS file picker, hence
   *  the ellipsis on its title. Cancelling the picker is a no-op. */
  async importZipFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    const file = await new Promise((res) => {
      input.onchange = () => res(input.files[0]);
      input.click();
    });
    if (!file) return;
    await this.importProjectZip(file);
  }

  // ── DRAFTS: a zip or a share link opens a WORKING COPY, not a project ───────
  //
  // THE RULING (user): "It shouldn't have to save until the user decides to save
  // — that goes for uploading zips too. Most editors let you edit things UNTIL
  // you decide to save, and the browser can persist it until later."
  //
  // So opening a .zip (drop, picker, ?zip=, or the URL modal) STAGES it: the
  // healed document goes into the working buffer that autosave already
  // persists, its assets go into the reserved draft keyspace, and the LIBRARY IS
  // UNTOUCHED until the user saves. web/projectDraft.js states the invariant in
  // full; the one line to carry here is that `projectName()` answers the draft
  // key while `projectDisplayName()` keeps saying "RobotSim".
  //
  // OPENING A SERVER OR BROWSER-LIBRARY PROJECT IS NOT A DRAFT — that project is
  // the library entry itself and is saved in place, exactly as it always was.

  // ── THE UNSAVED-WORK GUARD: one gate, one seam ─────────────────────────────
  //
  // THE RULING (user, verbatim): "if I've been working on something and then
  // suddenly I open a new URL, what happens? Can opening a link break my project?"
  // and "perhaps it should ask me — would you like to save this current
  // presentation before opening a new one? Same thing if I drag a zip into it."
  //
  // ONE GATE, NOT SIX. Every gesture that REPLACES the working copy — a dropped
  // .zip, Open from URL, the ?zip= and ?repo= boot params, Open Project from the
  // library, New Document — routes through `guardedOpen` below. Guarding
  // per-caller is how the seventh entry point silently ships without one; this
  // way, an open that does not go through the gate is visibly not going through
  // the gate. `openNeedsConfirm` (pure, doctested) decides IF it asks.

  /** UI seam (mirrors showSaveModal): App.svelte sets this to the function that
   *  raises the Save / Discard / Cancel dialog and resolves to one of those three
   *  strings. Default answers "discard" so a HARNESS without the shell — and the
   *  bare-node tests — behave exactly as the app did before the guard existed,
   *  rather than deadlocking on a dialog nobody can answer. */
  confirmUnsavedWork = null;

  /**
   * Command (may save; may not run `open` at all). THE ONE SEAM every working-copy
   * replacement passes through: ask about unsaved work, then do the open.
   *
   * THREE ANSWERS, and Cancel is a real one:
   *   · SAVE     — run the state-appropriate save (quickSave for a saved project,
   *                the Save As… naming flow for a draft — the same dispatch Cmd+S
   *                uses, so "Save" here can never mean something the Save button
   *                does not), THEN open. If that save fails or the user backs out
   *                of the naming modal, the open is ABANDONED: proceeding would
   *                destroy the work the user just asked to keep.
   *   · DISCARD  — open immediately. The working copy is gone, as asked.
   *   · CANCEL   — do not open. Returns false, and the caller must not proceed —
   *                INCLUDING the boot-param case, where the ?zip= / ?repo= URL
   *                simply does not load and the editor stays on what was open.
   *
   * A saved-and-clean working copy is never asked about (openNeedsConfirm), which
   * is what keeps the dialog meaningful — one that appears every time is one
   * nobody reads.
   *
   * @param {() => Promise<any>} open Runs the actual open. Called at most once.
   * @param {string} what What is being opened, for the dialog's sentence.
   * @returns {Promise<boolean>} Whether the open ran.
   */
  async guardedOpen(open, what = "another project") {
    // AN UNTOUCHED DOCUMENT HAS NOTHING TO LOSE, and this exemption is what keeps
    // the whole gate honest. A freshly-booted editor holds a never-saved, never-
    // edited blank document — which `isDraft()` correctly calls a draft — so
    // without this, EVERY ?zip= boot and every first Open of a session would raise
    // "save your work?" over an empty canvas. That is the dialog nobody reads,
    // trained on the user in the first ten seconds. `undoLog` is the honest test:
    // it has a step only if the document was actually edited (commit() is what
    // pushes one), so this exempts exactly "blank and untouched" and nothing more.
    if (this.isDraft() && !this.everSaved && !this.undoLog?.canUndo) {
      await open();
      return true;
    }
    if (!openNeedsConfirm(this.isDraft(), this.saveState())) {
      await open();
      return true;
    }
    const answer = this.confirmUnsavedWork ? await this.confirmUnsavedWork({ what, draft: this.isDraft(), name: this.projectDisplayName() }) : "discard";
    if (answer === "cancel") return false;
    if (answer === "save") {
      // THE SAME DISPATCH Cmd+S USES, for the same reason: a draft has no library
      // entry to quick-save into, so its "Save" is the naming flow. `saveAndWait`
      // resolves false when the naming modal is dismissed without saving — an
      // explicit backing-out, which must abandon the open rather than silently
      // discarding the work the user was in the middle of keeping.
      if (!(await this.saveForGuard())) return false;
    } else if (answer !== "discard") {
      throw new Error(`guardedOpen: unknown answer ${JSON.stringify(answer)} — expected "save", "discard" or "cancel".`);
    }
    await open();
    return true;
  }

  /** UI seam: App.svelte sets this to a function that opens the Save As… modal
   *  and resolves TRUE only if a save actually completed (false if dismissed).
   *  The plain `showSaveModal` hook cannot serve here because it resolves as soon
   *  as the dialog is UP, which the guard would read as a successful save and
   *  then destroy the document. Null until wired; the guard reports loudly. */
  saveAsAndWait = null;

  /**
   * Command (async; saves). Run the save the CURRENT state calls for and report
   * whether it completed — the guard's "Save" button, and nothing else's.
   *
   * @returns {Promise<boolean>} True if the working copy is now in the library.
   */
  async saveForGuard() {
    if (!this.isDraft()) {
      await this.quickSave();
      return true;
    }
    if (!this.saveAsAndWait) throw new Error("saveForGuard: the Save As… modal is not wired yet (App.svelte hook missing), so an unsaved draft cannot be saved before opening something else.");
    return Boolean(await this.saveAsAndWait());
  }

  /** Hook installed by App.svelte: renders download progress for a URL import.
   *  Receives `{loaded, total}` (total 0 = unknown, per the boot-splash honesty
   *  rule) or null when finished. Defaults to a no-op so a harness without the
   *  shell — and the boot path, which draws on the splash instead — needs no
   *  branch. */
  showUrlImportProgress = () => {};

  /**
   * Command. Open zip BYTES as a DRAFT: stage its assets under the draft key,
   * install the healed document, and leave the project library untouched.
   *
   * THE ORDER IS STAGE-THEN-INSTALL, and it is load-bearing for the same reason
   * loadProject primes before it commits: `resolveUrl` is synchronous by
   * contract, so every asset must be resolvable BEFORE the document that
   * references it can be painted. Installing first would render one frame of a
   * deck whose every image is the loud MISSING sentinel.
   *
   * `draftMode` is set BEFORE the commit for the same reason — it is what makes
   * `projectName()` answer the draft key, and a commit with it still null would
   * derive the first frame against the wrong keyspace.
   *
   * @param {Uint8Array} bytes The .zip bytes.
   * @param {string} requested Preferred display name ("" = let the archive decide).
   * @param {string} sourceUrl The URL it came from, or "" for a local file.
   * @returns {Promise<{name: string, assetCount: number}>}
   */
  async openDraftFromZipBytes(bytes, requested, sourceUrl = "", { repoSlug = "" } = {}) {
    const { doc, name, assetCount } = await draftFromZipBytes(bytes, requested);
    // `repoSlug` is the draft's ADDRESS when the transport was a repo — the one
    // fact `sourceUrl` cannot carry, because a repo's bytes never came from a
    // single URL (they are assembled from N contents-API responses). It is what
    // lets Copy Share Link emit `?repo=owner/name@branch` instead of nothing. It
    // rides the persisted marker below, so it survives a reload like the rest.
    this.draftMode = repoSlug ? { name, sourceUrl, repoSlug } : { name, sourceUrl };
    // OUT of correspondence with the library: whatever was open before, THIS deck
    // has never been in it. Redundant while draftMode is set (isDraft() short-
    // circuits on it), and NOT redundant the moment commitDraft clears draftMode —
    // it is what keeps the flag honest if a future path opens a draft over a
    // previously-saved project.
    this.everSaved = false;
    // Persist the two facts autosave cannot carry: that this IS a draft, and
    // where it came from (which is what gates the share link across a reload).
    localStorage.setItem(DRAFT_STATE_KEY, JSON.stringify(this.draftMode));
    clearDynamicFonts(); // drop the previous project's uploaded font families
    // Plugin assets BEFORE repair, for the reason loadProject spells out: repair
    // drops items whose type no plugin claims, so a deck whose widgets ride
    // inside the archive would lose them all. The draft key is where they were
    // just staged.
    await this.reloadPluginAssets(DRAFT_KEY);
    this.commit(this.repaired(doc));
    this.slideIndex = 0;
    this.selection = null;
    this.assetsVersion++; // a draft is a different asset library
    this.syncFontAssets(DRAFT_KEY); // fire-and-forget: register this draft's fonts
    console.log(`PowerRP: opened "${name}" as an UNSAVED DRAFT (${assetCount} asset(s) staged under ${DRAFT_KEY}) — nothing was added to the project library. Save to keep it.`);
    return { name, assetCount };
  }

  /**
   * Command (WRITES TO THE LIBRARY — the commitment point). Save the open DRAFT
   * as a real project `name`: copy its staged assets into that project, write
   * the document, and leave draft mode.
   *
   * THIS IS THE ONLY PLACE A DRAFT BECOMES A LIBRARY ENTRY. Until it runs, no
   * amount of opening, editing or reloading has put anything in the library —
   * which is the whole point of the working-copy model.
   *
   * COPY-THEN-SAVE, REUSING SAVE-AS'S MACHINERY (c2e1bbf): `copyAssets` lands
   * the files first, so at no instant does a doc.json exist whose refs resolve
   * to nothing. The copy runs against the LOCAL store because that is where a
   * draft is always staged (the server has no folder for an unsaved draft) —
   * in HTTP mode that means uploading each staged blob to the destination
   * project, which `copyDraftAssetsTo` does through the ordinary asset seam.
   *
   * `draftMode` is cleared only AFTER the save succeeds: a failed commit must
   * leave the user with their draft intact, not with a working copy that now
   * believes it is a saved project.
   *
   * @param {string} name The project name to commit as.
   * @returns {Promise<{name: string, copied: string[]}>}
   */
  async commitDraft(name) {
    const trimmed = (name ?? "").trim();
    if (!this.draftMode) throw new Error("commitDraft: no draft is open — use saveToServer or saveProjectAsFork");
    if (!trimmed) throw new Error("commitDraft: a project needs a name");
    if (!validProjectName(trimmed)) throw new Error(`commitDraft: "${trimmed}" is not a valid project name (no "/", "\\" or NUL).`);
    const copied = await this.copyDraftAssetsTo(trimmed);
    // The document's own meta.name must agree with the project it landed in —
    // the one-name model (loadProject stamps the same thing on open).
    this.doc = { ...this.doc, meta: { ...this.doc.meta, name: trimmed } };
    // LEAVE DRAFT MODE BEFORE THE SAVE: saveToServer reads projectName() through
    // its default argument in other call paths, and every asset read after this
    // point must resolve against the REAL project, whose copies now exist.
    this.draftMode = null;
    localStorage.removeItem(DRAFT_STATE_KEY);
    await this.saveToServer(trimmed);
    await assetStore().primeUrls(trimmed);
    await this.reloadPluginAssets(trimmed);
    this.assetsVersion++;
    console.log(`PowerRP: draft committed as project "${trimmed}" (${copied.length} asset(s) copied out of the draft staging).`);
    return { name: trimmed, copied };
  }

  /**
   * Command (writes assets). Copy every staged draft asset into project `name`.
   *
   * MODE-CROSSING BY NATURE, which is why it is its own method: the source is
   * ALWAYS the local (IndexedDB) store — a draft stages there in both storage
   * modes — while the destination is whatever `assetStore()` is. In static mode
   * that is a local→local copy; in HTTP mode it is an upload of each blob to the
   * server. `localProjectStore.copyAssets` cannot serve the HTTP case, so the
   * copy goes through the ordinary per-asset seam instead.
   *
   * @param {string} name Destination project.
   * @returns {Promise<string[]>} The asset filenames copied.
   */
  async copyDraftAssetsTo(name) {
    const dest = assetStore();
    const copied = [];
    for (const a of await localAssetStore.list(DRAFT_KEY)) {
      await dest.put(name, await localAssetStore.get(DRAFT_KEY, a.name), a.name);
      copied.push(a.name);
    }
    return copied.sort();
  }

  /**
   * Command. Restore an in-progress DRAFT after a reload — the "the browser can
   * persist it until later" half of the ruling.
   *
   * Called from the boot path right after `loadAutosave`, which has already put
   * the draft's DOCUMENT back AND set `draftMode` from the same DRAFT_STATE_KEY
   * read done here (autosave persists on every commit and knows nothing about
   * drafts itself, so `loadAutosave` reads the marker directly — that duplicate
   * read is what makes ITS OWN `primeUrls(projectName())` call prime the draft
   * keyspace instead of the empty `doc.meta.name` one; see loadAutosave's
   * comment for the regression this closed). Re-deriving `state` and
   * re-assigning `draftMode` here is therefore a harmless no-op on the reload
   * path; what this function actually still contributes is the ASYNC half
   * `loadAutosave` cannot do inline — priming plugin assets — plus being the
   * only path that runs when a draft is opened WITHOUT a preceding autosave
   * load (there is none today, but nothing here assumes one).
   *
   * Returns whether a draft was restored, so the boot path can skip its ordinary
   * prime rather than doing both.
   *
   * @returns {Promise<boolean>}
   */
  async restoreDraft() {
    const state = draftStateFromJson(localStorage.getItem(DRAFT_STATE_KEY));
    if (!state) return false;
    this.draftMode = state;
    // The draft keyspace, not doc.meta.name: the staged assets are under the
    // draft key, which is exactly what projectName() now answers.
    await localAssetStore.primeUrls(DRAFT_KEY);
    await this.reloadPluginAssets(DRAFT_KEY);
    console.log(`PowerRP: restored the UNSAVED DRAFT "${state.name}"${state.sourceUrl ? ` (from ${state.sourceUrl})` : ""} — still not in the project library. Save to keep it.`);
    return true;
  }

  /** Query. The share link for the open draft, or null when there is nothing
   *  shareable — a draft that came from a local file, or an ordinary saved
   *  project, has no URL a recipient could fetch. This is the `when` clause
   *  behind the Copy Share Link command: a command that cannot do its job must
   *  be disabled, not pretend.
   *
   *  TWO TRANSPORTS, TWO PARAMS. A draft fetched from a repo shares as
   *  `?repo=owner/name@branch` and NOT as a `?zip=` of some archive URL, because
   *  that is the address the deck actually lives at — and it is the form that
   *  keeps pointing at whatever the branch says tomorrow, which is the whole
   *  reason a repo beats a zip (githubProject.js's header). THE REF IS CARRIED,
   *  because a link that drops it silently hands the recipient a DIFFERENT deck
   *  (the default branch) while looking like it worked. */
  shareLink() {
    if (typeof location === "undefined") return null;
    if (this.draftMode?.repoSlug) return repoShareLink(parseRepoSlug(this.draftMode.repoSlug), location.href);
    if (!this.draftMode?.sourceUrl) return null;
    return shareUrl(location.href, this.draftMode.sourceUrl);
  }

  /** Command (writes the clipboard). Copy the open draft's share link. Refuses
   *  LOUDLY rather than copying nothing if run without a shareable draft — the
   *  command's `when` clause already prevents that, so reaching here is a bug. */
  async copyShareLink() {
    const link = this.shareLink();
    if (!link) throw new Error("copyShareLink: this project did not come from a URL, so there is no link to share. Export a .zip and host it, then open it by URL.");
    await copyText(link, "share link");
    return link;
  }

  /** UI seam (mirrors showSaveModal): App.svelte sets this to the function that
   *  opens the "Open Project from URL" modal. */
  showOpenUrlModal = null;

  /** Command. Open the "Open Project from URL…" modal (delegates to the hook once
   *  App.svelte has wired it). */
  openProjectFromUrlModal() {
    if (this.showOpenUrlModal) return this.showOpenUrlModal();
    console.error("Open Project from URL: the modal is not wired yet (App.svelte hook missing). Use app.openProjectFromUrl(url).");
  }

  /**
   * Command. Fetch a project .zip from `rawUrl` and open it as a DRAFT.
   *
   * NO IDEMPOTENCY MEMO, deliberately — drafts made it unnecessary. The
   * predecessor design remembered url → project name in localStorage so a
   * five-times-visited share link would not leave five projects behind; with the
   * working-copy model it leaves ZERO, every time, so there is nothing to
   * remember and no stale-cache case to reason about. Opening the same link
   * twice is two clean drafts.
   *
   * Every failure is loud: the URL is validated before any network call, and a
   * blocked fetch raises ZipFetchBlockedError carrying the CORS help.
   *
   * @param {string} rawUrl The URL as typed or as read from `?zip=`.
   * @param {(p: {loaded: number, total: number}) => void} [onProgress]
   * @returns {Promise<{name: string, assetCount: number}>}
   */
  async openProjectFromUrl(rawUrl, onProgress = this.showUrlImportProgress) {
    const url = validatedZipUrl(rawUrl, typeof location === "undefined" ? undefined : location.href);
    // GUARDED, AND THE GATE COMES BEFORE THE DOWNLOAD. Asking first means a
    // cancelled open costs no bytes — and, more importantly, that the question is
    // answered while the working copy is still definitely intact. This is also the
    // ?zip= / ?repo= BOOT path (App.svelte's openBootZip and main.js both land
    // here or in openDraftFromZipBytes via guardedOpen), so a share link opened
    // over live work waits for the answer instead of overwriting it.
    let opened = null;
    const ran = await this.guardedOpen(async () => {
      // STATIC MODE HAS NO PROXY. isStatic() means there is no server to ask, so a
      // blocked fetch must produce the helpful CORS refusal rather than a request
      // to an endpoint that does not exist.
      const bytes = await fetchZipBytes(url, onProgress, { proxy: !isStatic() });
      opened = await this.openDraftFromZipBytes(bytes, projectApi.projectZipName(zipFileNameFromUrl(url)), url);
    }, `the project at ${url}`);
    if (!ran) return { cancelled: true };
    return opened;
  }

  /**
   * Command. Fetch a project from a GITHUB REPO and open it as a DRAFT — the
   * repo twin of `openProjectFromUrl`, and deliberately its mirror image.
   *
   * A REPO IS A DIFFERENTLY-FETCHED ZIP (main.js's `?repo=` path established
   * this, and this shares its synthesis): the contents API's files are packed
   * into an in-memory archive and handed to `openDraftFromZipBytes`, so archive
   * adoption, ref healing, draft staging and the whole save flow apply unchanged.
   * There is no second importer, and adding one would be the mistake.
   *
   * `slug` may be `owner/name`, `owner/name@ref`, or a github.com URL —
   * `parseRepoSlug` is the one grammar, and `@ref` is a BRANCH, tag or commit.
   * Guarded like every other open, and asked BEFORE the fetch so a declined open
   * costs no network.
   *
   * @param {string} slug As typed, or as read from `?repo=`.
   * @param {(p: {loaded: number, total: number, message?: string}) => void} [onProgress]
   * @returns {Promise<{name: string, assetCount: number}|{cancelled: true}>}
   */
  async openProjectFromRepo(slug, onProgress = () => {}) {
    const target = parseRepoSlug(slug); // refuses loudly, before any request
    const canonical = target.ref ? `${target.owner}/${target.repo}@${target.ref}` : `${target.owner}/${target.repo}`;
    let opened = null;
    const ran = await this.guardedOpen(async () => {
      const { root, doc, assets } = await fetchProjectFromRepo(canonical, { onProgress });
      const name = (root || target.repo).trim();
      const members = { [`${name}/doc.json`]: strToU8(JSON.stringify(doc)) };
      for (const a of assets) members[`${name}/assets/${a.name}`] = a.bytes;
      // sourceUrl stays "" — a repo's bytes never came from ONE url, so there is
      // no honest value for it. `repoSlug` is the address instead, and it is what
      // the share link is built from (see shareLink()).
      opened = await this.openDraftFromZipBytes(zipSync(members), name, "", { repoSlug: canonical });
    }, `the GitHub project ${canonical}`);
    if (!ran) return { cancelled: true };
    return opened;
  }

  /**
   * Command. THE ONE INPUT, BOTH GRAMMARS (user ruling: "it should support
   * branches too", on a field whose label already promised "a zip from anywhere
   * or a github repository/branch").
   *
   * Routes on `projectSourceKind` — the pure, doctested grammar decision — and
   * then hands off to the transport that owns the string. It does NOT parse:
   * each loader validates strictly and refuses loudly, and a second weaker
   * validator here would disagree with them silently.
   *
   * An unrecognized string is refused HERE with a sentence about the INPUT,
   * rather than being pushed at a loader to fail as a confusing network error.
   *
   * @param {string} raw As typed into the Open-from-URL field.
   * @param {Function} [onProgress]
   * @returns {Promise<{name: string, assetCount: number}|{cancelled: true}>}
   */
  async openProjectFromAnySource(raw, onProgress = () => {}) {
    const text = String(raw ?? "").trim();
    const kind = projectSourceKind(text);
    if (kind === "repo") return this.openProjectFromRepo(text, onProgress);
    if (kind === "url") return this.openProjectFromUrl(text, onProgress);
    throw new Error(
      `"${text}" is neither a link nor a GitHub repository. Give a full URL to a project .zip (https://example.com/deck.zip), or a repository as owner/name — optionally with a branch, as owner/name@branch.`,
    );
  }

  // ── Assets: upload / delete / insert / filmstrip frames (one region) ────────

  /** Bumped on every asset add/remove, so asset consumers (the Asset Explorer
   *  pane) can re-list reactively — e.g. a canvas OS-file drop must show up in
   *  the pane without a manual Refresh. Monotonic, viewer-local, not undoable. */
  assetsVersion = $state(0);

  /** THE REACTIVE MIRROR of the connectivity seam — read by internet-gated
   *  command `when` clauses so their surfacings (palette rows, toolbar buttons)
   *  actually RE-EVALUATE when the network comes or goes.
   *
   *  Why a mirror and not `isOnline()` inside the gate: `isOnline()` is a plain
   *  function over a module-level variable, so Svelte has nothing to subscribe
   *  to — a gate reading it would be correct the moment it ran and then never
   *  run again, leaving "Unavailable — requires an internet connection" frozen
   *  on screen over a working connection. The seam stays framework-free
   *  (bare-node tests import it); THIS is the one place its value becomes
   *  reactive. Kept in sync by `#connectivityStop`'s subscription below.
   *
   *  Viewer-local, not document state, not undoable. */
  online = $state(true);

  /** Unsubscribe for the connectivity subscription that feeds `online`. */
  #connectivityStop = null;

  /** Command. Starts mirroring the connectivity seam into `this.online`. Called
   *  once from the app's construction path; idempotent. Seeds from the seam
   *  first, because a page that BOOTS offline must not spend its first render
   *  claiming otherwise. */
  startConnectivityMirror() {
    if (this.#connectivityStop) return;
    this.online = isOnline();
    this.#connectivityStop = onConnectivityChange((up) => {
      this.online = up;
    });
  }

  // ── Optimistic upload progress (this feature) ────────────────────────────
  // Every in-flight/failed upload as a reactive tile the Asset Explorer renders
  // BEFORE the real assets. Entry shape:
  //   { id, name, kind, loaded, total, status: "uploading"|"done"|"error", error }
  // The SINGLE source of upload progress: because every entry point (Asset
  // Explorer button, AssetField button, Finder drop onto either surface, canvas
  // drop, paste-to-upload) funnels through THIS uploadAsset, they all get the
  // optimistic tile for free. Viewer-local, not undoable.
  uploads = $state([]);
  #uploadSeq = 0;

  /** Command. Patch one upload entry by id (functional: a fresh array + object,
   *  so Svelte's keyed {#each} updates the tile without me relying on deep-proxy
   *  mutation of a nested $state object). No-op if the id is gone (dismissed). */
  #patchUpload(id, patch) {
    this.uploads = this.uploads.map((u) => (u.id === id ? { ...u, ...patch } : u));
  }

  /** Command. Upload a File/Blob into the current project's assets/ folder (the
   *  source of truth for the asset library). Returns {ok, name, url}. Pushes an
   *  optimistic upload tile IMMEDIATELY (before any await, so it appears the
   *  instant the user clicks/drops), streams xhr.upload.onprogress into its
   *  loaded/total, marks it "done" on success (the Asset Explorer's re-list then
   *  swaps in the real tile via reconcileUploads) or "error" on ANY failure —
   *  a loud, visible error tile, AND the error is re-thrown so direct-gesture
   *  callers (AssetField) still surface their inline message (NO SILENT
   *  FALLBACK). Saves the project first so the folder exists server-side —
   *  SKIPPED for a draft: a draft has no server-side folder to pre-create (it
   *  stages in the browser regardless of storageMode(), see web/projectDraft.js),
   *  and `saveToServer(DRAFT_KEY)` would try to write a project literally named
   *  "~draft/current", hitting the same `_SAFE_NAME` guard the asset-routing fix
   *  exists to avoid — uploading INTO an open draft must touch the server not at
   *  all until Save. */
  async uploadAsset(file, filename = file.name, name = this.projectName()) {
    const id = `upload_${++this.#uploadSeq}`;
    this.uploads = [
      ...this.uploads,
      { id, name: filename, kind: assetKindForFile(file), loaded: 0, total: file.size ?? 0, status: "uploading", error: null },
    ];
    try {
      if (!isDraftKey(name)) await this.saveToServer(name);
      const res = await assetStoreFor(name).put(name, file, filename, (loaded, total) =>
        this.#patchUpload(id, total ? { loaded, total } : { loaded })
      );
      // Final de-collided basename + full bar; the done tile lingers only until
      // the Asset Explorer's assetsVersion re-list drops it (reconcileUploads).
      this.uploads = this.uploads.map((u) =>
        u.id === id ? { ...u, name: res.name, status: "done", loaded: u.total || u.loaded } : u
      );
      this.assetsVersion++;
      return res;
    } catch (e) {
      this.#patchUpload(id, { status: "error", error: String(e?.message ?? e) });
      console.error(`uploadAsset: upload of "${filename}" failed:`, e);
      throw e; // re-raise — the tile shows it AND the calling gesture surfaces it
    }
  }

  /** Command. Drop finished ("done") upload tiles whose real asset now appears
   *  in `assetList` — called by the Asset Explorer right after a successful
   *  re-list, so a pending tile is only removed once its REAL tile has arrived
   *  (no flicker gap where the new asset shows in neither). Error tiles are left
   *  standing (they persist, loudly, until the user dismisses them). */
  reconcileUploads(assetList) {
    const names = new Set((assetList ?? []).map((a) => a.name));
    this.uploads = this.uploads.filter((u) => !(u.status === "done" && names.has(u.name)));
  }

  /** Command. Remove one upload tile by id — the error tile's dismiss (×). */
  dismissUpload(id) {
    this.uploads = this.uploads.filter((u) => u.id !== id);
  }

  /** Query. List the current project's assets from the server (reflects the
   *  assets/ folder on disk — a manual drop appears after a refresh). This is
   *  the refresh-button data source for the future Asset Explorer pane. */
  async listProjectAssets(name = this.projectName()) {
    return assetStoreFor(name).list(name);
  }

  /** Command. Delete one asset from the current project (the server removes
   *  the file AND its cached filmstrip frames). Throws loudly on failure —
   *  the Asset Explorer's trash-can flow surfaces it. */
  async deleteProjectAsset(filename, name = this.projectName()) {
    await assetStoreFor(name).delete(name, filename);
    this.assetsVersion++;
  }

  // ── STORAGE MODE: what the UI asks to know where its bytes live ─────────────
  // The seam itself is web/storageMode.js (decided once at boot). These are the
  // read-only surfacings the shell needs: the static-mode notice, and the Asset
  // Explorer's quota line. Nothing here CHOOSES the mode — that already happened.

  /** Query. "http" (a project server owns storage) or "local" (this browser's
   *  IndexedDB owns it). */
  storageMode() {
    return storageMode();
  }

  /** Query. Whether this page is running with NO backend — the predicate every
   *  server-only affordance branches on. */
  isStatic() {
    return isStatic();
  }

  /** Query. The one-sentence reason for the current mode, shown in the
   *  static-mode notice so the state is explained, not just asserted. */
  storageModeReason() {
    return storageModeReason();
  }

  /** Query. The browser's storage budget: {usage, quota, persisted, supported}.
   *  `supported:false` in HTTP mode (a server has no per-browser quota), which is
   *  how the Asset Explorer knows to render NO quota line there. */
  async storageQuota() {
    return assetStore().quota();
  }

  /** Command (asks the browser for a permission). In static mode, ask for
   *  PERSISTENT storage and return the browser's answer — surfaced because the
   *  user's decks live only in this browser here, so evictable-vs-persistent is a
   *  fact they need. A no-op returning false in HTTP mode (nothing to persist:
   *  the server holds the data). */
  async requestStoragePersistence() {
    if (!isStatic()) return false;
    const granted = await localAssetStore.requestPersistence();
    console.log(`PowerRP storage persistence: ${granted ? "GRANTED (this browser will not evict your projects under storage pressure)" : "NOT granted (the browser may evict this origin's data under storage pressure — export a .zip to keep a durable copy)"}`);
    return granted;
  }

  /** Command. Refuse a server-only feature by name, with the sentence saying why
   *  and what to use instead — the loud half of the static-mode contract. */
  refuseInStatic(feature) {
    refuseInStatic(feature);
  }

  /** Query. World point at the center of the CURRENT camera view — the default
   *  placement for inserts that don't come from a canvas drop (the same
   *  cameraRect(evaluateState(foldState(…))) idiom exportPng uses). */
  #viewCenter() {
    const rect = cameraRect(evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry, this.projectScript()).state, this.doc.meta);
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  }

  /** Command. addItem a media widget at native size `w`×`h`, CENTERED at world
   *  point `at` (or the camera-view center when null). addItem keyframes
   *  active:true on this slide and selects the new item. */
  #insertMediaAt(defaults, src, w, h, at) {
    const p = at ?? this.#viewCenter();
    this.addItem({ ...defaults, src, w, h, x: p.x - w / 2, y: p.y - h / 2 });
  }

  /** Query. A src string for the document, resolved through THE STORAGE ADAPTER
   *  (web/assetStore.js). This is THE ONE resolution seam — a document always
   *  stores the portable `"/asset/<project>/<file>"` ref and never a resolved
   *  URL, so which adapter answers here is the only difference between a
   *  server-backed deck and a browser-local one:
   *
   *    HTTP  → the backend base is prefixed (identity when same-origin/proxied),
   *            which is byte-identical to what this method did before.
   *    LOCAL → a memoized blob: object URL for the IndexedDB-stored bytes.
   *
   *  Either way absolute URLs and data: URIs pass through untouched. SYNCHRONOUS
   *  by contract (derive/paint call it and cannot await), which is why the local
   *  adapter primes a project's URLs when it opens — see assetStore.js. */
  #resolvedSrc(url) {
    return assetStoreFor(this.projectName()).resolveUrl(url);
  }

  /** Query. `#resolvedSrc`'s OPPOSITE NUMBER: the string that belongs in the
   *  DOCUMENT for an asset the user just picked, uploaded or dropped.
   *
   *  The two are easy to confuse and must never be swapped. `#resolvedSrc` answers
   *  "what can I load right now?" and its answer is MODE-DEPENDENT and TRANSIENT —
   *  a backend URL in HTTP mode, a `blob:` object URL in static mode, dead on the
   *  next reload. This answers "what should I persist?", and its answer must be
   *  neither: a document stores a ref, never a resolution (web/assetStore.js's
   *  invariant), and since core/asset_ref.js's grammar that ref is RELATIVE for an
   *  asset of this project so a rename, a Save-As or a zip round-trip cannot break
   *  it. A FOREIGN project's asset keeps its absolute ref, which is the only thing
   *  that could name it.
   *
   *  @param {string} url - the listing's `url` (an absolute ref, or a non-ref src)
   *  @returns {string} the value to store
   *
   *  @example // in project "RobotSim": #storedSrc("/asset/RobotSim/clip.mp4") // "clip.mp4"
   *  @example // in project "RobotSim": #storedSrc("/asset/Shared/bg.png")     // "/asset/Shared/bg.png"
   */
  #storedSrc(url) {
    return relativeAssetRef(url, this.projectName());
  }

  /**
   * Command. Inserts the widget an ASSET becomes — THE ONE media-insert path,
   * for every kind a widget claims. A new image widget for an image, a player
   * for a video, a page for a PDF, at the asset's NATIVE size (manifest Round
   * 12: "because we have pixels to measure things"), CENTERED at world point
   * `at` — a canvas drop point (Round 12C: asset→canvas drag inserts at the drop
   * point) — or at the camera-view center when `at` is omitted (the Asset
   * Explorer's insert button, and paste, which have no drop point).
   *
   * NOTHING HERE KNOWS A WIDGET TYPE, which is the point. `widgetForAssetKind`
   * reads the claim off the registry (plugins declare `assetDrop`) and
   * `assetNaturalSize` measures the file. Before this existed the pair
   * image-or-video was written out by hand in THREE places, so `pdf_page` — which
   * had shipped long since — could not be reached by dropping a PDF, and the user
   * got "nothing on the canvas can show a 'pdf' asset". Adding the fourth
   * droppable kind now touches a plugin and a measurer, not this method.
   *
   * Async because a native size is only known after a decode / metadata load /
   * document open. A FAILURE REJECTS LOUDLY (no silent fallback, no guessed box)
   * so the caller surfaces it.
   *
   * @param {{kind: string, url: string, name?: string}} asset - the asset to place
   * @param {{x: number, y: number}|null} at - world drop point, or null for view center
   */
  async insertAssetWidget(asset, at = null) {
    const plugin = widgetForAssetKind(this.registry, asset?.kind);
    if (!plugin)
      throw new Error(`insertAssetWidget: no widget claims "${asset?.kind}" assets — the caller should have classified this as a non-canvas kind and reported it`);
    // TWO DIFFERENT STRINGS, and conflating them was the latent half of the
    // relative-ref bug. `loadable` is what the browser can actually open RIGHT NOW
    // (a backend URL in HTTP mode, a blob: object URL in static mode); `stored` is
    // what belongs in the DOCUMENT. Storing the loadable one wrote a blob: URL into
    // the deck in static mode — dead the moment the page reloaded.
    const loadable = this.#resolvedSrc(asset.url);
    const { w, h } = await assetNaturalSize(asset.kind, loadable, plugin.type);
    this.#insertMediaAt(plugin.defaults, this.#storedSrc(asset.url), w, h, at);
  }

  /** Command. Inserts an image asset by URL — the named shorthand kept for the
   *  Asset Explorer's insert button and the browser QA suite, both of which have
   *  an image in hand and no asset record. Everything it does is
   *  insertAssetWidget's. */
  async insertImageAsset(url, at = null) {
    return this.insertAssetWidget({ kind: "image", url }, at);
  }

  /**
   * Command. Inserts the widget a `*.plugin.js` ASSET declares, at `at` (a canvas
   * drop point) or the camera-view centre. THE DROP-TO-INSTANTIATE path, per the
   * user's ruling: "If I drag and drop a widget plugin onto the canvas, it should
   * add the widget… from the asset library".
   *
   * ENSURE-LOADED FIRST, and this is the whole reason the method exists rather than
   * the drop handler calling addItem. Three cases reach it and only one has its
   * plugin already registered:
   *
   *   · a PROJECT plugin asset in the open project — registered at project open
   *     (loadProject → loadProjectPluginAssets), so the lookup already resolves.
   *   · a BUILT-IN library widget — registered at boot in every mode, likewise.
   *   · an asset the registry does NOT have — a file added since the project
   *     opened (a manual folder drop, or an upload in another tab). That is the
   *     case that would otherwise throw an "Unknown widget type" out of a drop
   *     gesture, so the type is resolved by RE-READING the project's plugin assets
   *     once before giving up.
   *
   * A FAILURE IS LOUD, never a dropped gesture that looks like a miss: an asset
   * whose source will not compile, or which declares a type nothing registered,
   * throws with the asset named. The caller (CanvasView's drop) reports it.
   *
   * THE PLACEMENT IS THE SAME ARITHMETIC A CLICK USES — widget_handlers'
   * anchoredDefaults, honouring the plugin's own `placementAnchor` — so a widget
   * lands in the same place whether it was placed by crosshair or dropped.
   *
   * @param {{name: string, kind?: string}} asset - the dropped plugin asset
   * @param {{x: number, y: number}|null} at - world drop point, or null for the view centre
   * @returns {Promise<void>}
   *
   * @example // await app.insertPluginAssetWidget({name: "donut.plugin.js"}, {x: 400, y: 300})
   * //   → a donut item added with its centre at (400, 300)
   */
  async insertPluginAssetWidget(asset, at = null) {
    const type = await this.pluginAssetType(asset.name);
    const plugin = this.registry.get(type); // loud on an unknown type, by contract
    this.addItem(anchoredDefaults(plugin, at ?? this.#viewCenter()));
  }

  /**
   * Query (may re-read the project's assets). The widget TYPE the plugin asset
   * `filename` declares, ensuring it is REGISTERED first — the ensure-loaded half
   * of drop-to-instantiate.
   *
   * A type name lives in the asset's SOURCE, never in its listing entry, so the map
   * is built at registration (core/plugin_assets.registerPluginAssets returns it)
   * rather than inferred from the filename. Inferring would be wrong in both
   * directions: `my_shapes.plugin.js` may declare `squircle`, and two files can
   * declare types unrelated to their names.
   *
   * THE BUILT-IN LIBRARY IS CONSULTED TOO, because a dropped tile can come from
   * either surface — the Asset Explorer lists project assets and (with the toggle on)
   * the built-in widget library, and a drop must work from both. Built-ins are
   * registered at boot in every mode, so their map needs no re-read.
   *
   * @param {string} filename - a plugin asset's basename (e.g. "gear.plugin.js")
   * @returns {Promise<string>} the registered widget type
   *
   * @example // await app.pluginAssetType("donut.plugin.js")  // "donut"  (a built-in)
   * @example // await app.pluginAssetType("gear.plugin.js")   // "gear"   (a project asset)
   */
  async pluginAssetType(filename) {
    const known = this.pluginAssetTypeByFile?.[filename] ?? BUILTIN_PLUGIN_ASSET_TYPES[filename];
    if (known) return known;
    // Unknown under this name — the asset arrived AFTER the project opened (a manual
    // folder drop, or an upload from another tab). Re-read once. Idempotent: an
    // already-registered type is REFUSED by the collision rule and reported, never
    // double-registered.
    const result = await loadProjectPluginAssets(this.registry, assetStoreFor(this.projectName()), this.projectName());
    printPluginAssetReports(result, this.projectName());
    this.pluginAssetTypes = [...(this.pluginAssetTypes ?? []), ...result.loaded];
    this.pluginAssetTypeByFile = { ...this.pluginAssetTypeByFile, ...result.types };
    const found = result.types[filename];
    if (!found)
      throw new Error(`pluginAssetType: "${filename}" declares no usable widget — it is not registered, and re-reading this project's plugin assets did not register it. See the console for the refusal reason.`);
    return found;
  }

  /**
   * Command. Inserts a video asset (by URL) as a new video PLAYER widget at
   * native pixel size, centered at `at` (canvas drop point) or the camera-view
   * center — the video twin of insertImageAsset (manifest Round 12 drag-drop:
   * "Same for videos"; autoplay/loop/muted defaults come from the plugin).
   * Loads METADATA only (no full decode) for the native size; a load failure
   * rejects loudly.
   */
  async insertVideoAsset(url, at = null) {
    return this.insertAssetWidget({ kind: "video", url }, at);
  }

  /**
   * Command. Inserts a VIDEO SCRUBBER + a PROGRESS BAR, LINKED on creation: the
   * bar's `fraction` is bound by a `=` equation to the scrubber's `progress`
   * export (`= @<scrubberId>.progress`), so the bar fills to match how far along
   * the clip the scrubber's deterministic `scrubTime` is (once the scrubber's
   * `duration` is set — see plugins/video_scrub.js on why duration is a user
   * input). The bar is placed directly beneath the scrubber, matching its width.
   *
   * Both items are created with withNewItem (each spreads its plugin defaults, so
   * the scrubber's derived exports are materialized), keyframed active:true on the
   * current slide, layered above the existing content, and committed as ONE undo
   * unit. The bar is selected afterward (its fraction binding is the thing to
   * inspect). Uses the STORED `@<id>` reference form so the link survives renames.
   */
  insertVideoWithProgressBar() {
    const scrub = this.registry.get("video_scrub");
    const bar = this.registry.get("progress_bar");
    const vw = scrub.defaults.w, vh = scrub.defaults.h;
    const barW = vw, barH = bar.defaults.h;
    const GAP = 12; // world units between the scrubber and its bar
    const totalH = vh + GAP + barH;
    const c = this.#viewCenter();
    const left = c.x - vw / 2, top = c.y - totalH / 2;
    const zs = this.nodes().map((n) => n.state.z ?? 0);
    const baseZ = zs.length ? Math.max(...zs) : 0;

    const [docWithScrub, scrubId] = withNewItem(this.doc, this.slideIndex, {
      ...scrub.defaults, active: true, z: baseZ + 1, x: left, y: top,
    });
    // The bar's fraction is bound to the scrubber's progress export on creation
    // (STORED `@<id>` form → survives renames). This IS the "linked on creation".
    const [doc, barId] = withNewItem(docWithScrub, this.slideIndex, {
      ...bar.defaults, active: true, z: baseZ + 2,
      x: left, y: top + vh + GAP, w: barW, h: barH,
      fraction: `= @${scrubId}.progress`,
    });
    this.commit(withNormalizedZ(doc));
    this.selection = barId; // the fraction binding is the thing to inspect
  }

  // Open-project UI seam: the Open command opens a project-picker MODAL, but
  // the Modal lib component is landing in PARALLEL (Sonnet1). The modal
  // integration sets `app.showOpenModal` to a function; until it lands the
  // command reports LOUDLY (no ad-hoc dialog is built here — the data/API
  // above — listProjects()/loadProject() — is the seam the modal consumes).
  showOpenModal = null;

  /** Command. Open the project-picker (delegates to the modal hook once wired). */
  openProject() {
    if (this.showOpenModal) return this.showOpenModal();
    console.error(
      "Open Project from Server: the project-picker modal is not wired yet " +
      "(Modal lib component pending). Use app.listProjects() / app.loadProject(name) " +
      "programmatically, or Import Document from .powerrp.json for a local file.",
    );
  }

  // Save + Rename UI seams (mirror showOpenModal): App.svelte sets these to
  // functions that open the respective Modal. Both operate on ONE name model —
  // doc.meta.name (renameProject) — so the title, Save, and Open never diverge.
  // Until App.svelte wires them, each command reports LOUDLY (no ad-hoc dialog).
  showSaveModal = null;
  showRenameModal = null;

  /** Command. Open the "Save Project As…" modal: choose/confirm the name and, if
   *  that name already exists, warn + require an explicit Overwrite (never a
   *  silent clobber). Delegates to the modal hook. The low-level push
   *  (saveToServer) is unchanged and still used non-interactively by asset upload
   *  / project .zip export.
   *
   *  THIS IS THE NAMING FLOW, and for a DRAFT it is the FIRST save — the modal's
   *  draft branch runs commitDraft, which copies the staged assets into the new
   *  project through the fork-copy machinery. It is ALWAYS available; quickSave is
   *  the gated one. */
  saveProjectAs() {
    if (this.showSaveModal) return this.showSaveModal();
    console.error("Save Project As: the save modal is not wired yet (App.svelte hook missing). Use app.saveToServer(name).");
  }

  /**
   * Command (async; WRITES TO THE LIBRARY). QUICK SAVE — write the current
   * document straight back to the library entry it came from. No modal, no name
   * prompt, no collision check: the entry already exists and this IS it.
   *
   * REFUSES ON A DRAFT, LOUDLY. The command's `when` gate makes this unreachable
   * from any surface (button, palette, Cmd+S all dispatch Save As instead), so
   * arriving here with a draft open is a wiring bug, not a user action — and the
   * failure mode it prevents is the exact thing the user ruled out: a library
   * entry minted with no naming ceremony, named whatever the working copy happens
   * to hold. It would additionally write under `projectName()`, which for a draft
   * is the draft KEY — a name the server's rule forbids.
   *
   * @returns {Promise<string>} The project name written.
   */
  async quickSave() {
    if (this.isDraft())
      throw new Error(`quickSave: "${this.projectDisplayName()}" is not saved yet, so there is no project to save INTO — use Save As… (the command's when-gate should have prevented this).`);
    return this.saveToServer();
  }

  /** Command. Open the Rename modal for the PROJECT name (writes doc.meta.name
   *  via renameProject — the name the toolbar shows as the title). Delegates to
   *  the modal hook; also the target of the toolbar title's double-click (bug:
   *  the title was inert). NAME KEPT: the two Toolbar.svelte call sites (a file
   *  this agent does not own) call it, so renaming the METHOD to match the
   *  command's "Rename Project…" title is a separate, coordinated patch. */
  renamePresentation() {
    if (this.showRenameModal) return this.showRenameModal();
    console.error("Rename Project: the rename modal is not wired yet (App.svelte hook missing). Use app.renameProject(name).");
  }

  // Built-in asset browser UI seam (mirrors showOpenModal): App.svelte sets this
  // to a function that opens the "Built-in Assets" Modal. NAMED *Modal to stay
  // clear of `showBuiltinAssets` above — that one is the Asset Explorer's
  // show-built-ins TOGGLE (a persisted boolean); this one is a modal hook.
  // Built-in assets are ship-with-the-app and live in a SEPARATE surface from
  // the project Asset Explorer — this is DISCOVERY only; widgets read
  // built-ins directly (web/builtinAssets.js is the catalog).
  showBuiltinAssetsModal = null;

  /** Command. Open the built-in asset browser (delegates to the modal hook once
   *  wired by App.svelte). */
  browseBuiltinAssets() {
    if (this.showBuiltinAssetsModal) return this.showBuiltinAssetsModal();
    console.error("Browse Built-in Assets: the browser modal is not wired yet (App.svelte hook missing).");
  }

  // ── ARRANGE SELECTION INTO GRID (bento box) ─────────────────────────────────
  // Lays the selected widgets out as a BENTO GRID. This tool CONSUMES the bento
  // widget (type "bento", parallel lane #86: a grid-layout widget with props
  // {rows, cols, rowGap, colGap, padding} that emits per-cell anchors) — it does
  // NOT rebuild it. The pure grid math (core/grid.js) is independent of the
  // widget and fully tested; the create-and-place step below is guarded on the
  // "bento" plugin being registered so this lane is safe to merge before/after
  // #86. The UX is INTERACTIVE (palette commands take no args): the command opens
  // a grid-size picker (Office "Insert Table" sweep) via the showGridPicker seam;
  // the picker's confirm calls arrangeSelectionIntoGrid(rows, cols).

  /** The widget type this tool creates. Consumed from parallel lane #86. */
  static #BENTO_TYPE = "bento";

  // Grid-size-picker UI seam (mirrors showOpenModal / showBuiltinAssets):
  // App.svelte sets this to a function (itemCount) => void that opens the
  // GridSizePicker popover; its confirm handler calls arrangeSelectionIntoGrid.
  showGridPicker = null;

  /**
   * Query. The selected nodes that have a bounding box (own x/y/w/h), as
   * {node, box} pairs in selection order — the same basis align/mirror/
   * distribute use. Non-bbox items (arrows, endpoints) are excluded: placing a
   * widget's CENTER in a cell needs a width/height.
   */
  #selectedBboxNodes() {
    const ids = new Set(this.selectedIds());
    return this.nodes()
      .filter((n) => ids.has(n.itemId) && n.plugin.capabilities.bbox)
      .map((n) => ({ node: n, box: { x: n.state.x ?? 0, y: n.state.y ?? 0, w: n.state.w ?? 0, h: n.state.h ?? 0 } }));
  }

  /** Query. Is the "bento" widget (lane #86) registered yet? Guards the
   *  create-and-place step without tripping registry.get's loud throw. */
  #bentoAvailable() {
    return this.registry.all().some((p) => p.type === PowerRPApp.#BENTO_TYPE);
  }

  /** Command. "Arrange into Grid": opens the grid-size picker (delegates to the
   *  App.svelte hook). The picker's confirm calls arrangeSelectionIntoGrid.
   *  Gated to ≥2 bbox items by the command registration; this guard keeps a
   *  direct/test call safe. */
  arrangeIntoGrid() {
    const count = this.#selectedBboxNodes().length;
    if (count < 2) return;
    if (this.showGridPicker) return this.showGridPicker(count);
    console.error("Arrange into Grid: the grid-size picker UI is not wired yet (App.svelte hook missing).");
  }

  /**
   * Command (ONE undo unit). Realizes the current selection as a BENTO GRID:
   * creates ONE bento box sized to the selection's current union AABB (its
   * width/height taken from where the items already are), with the chosen
   * rows×cols, then moves each selected bbox item (row-major order) so its own
   * CENTER sits on its cell's center. Overflow (more items than rows*cols) grows
   * the row count to fit (effectiveRows). Selects the new bento. Placement is
   * absolute x/y keyframes on the current slide — the same mechanism as align/
   * distribute — so re-running the command re-flows.
   *
   * Gap defaults come from the bento plugin's OWN defaults (rowGap/colGap/
   * padding) so the tool never invents grid spacing. The bento is layered just
   * BEHIND the selected items (a container sits behind its contents) — a sensible
   * default; final layering is a bento-integration detail.
   *
   * INTEGRATION POINT (#86): if "bento" is not registered yet, this reports
   * LOUDLY and no-ops (the picker + pure math still work). FLAGGED for post-merge
   * finalization: (a) whether to bind item x/y to the bento's cell-center anchors
   * via `=` equations so editing rows/cols in the Inspector AUTO-reflows (needs
   * the finalized cell-anchor naming from #86) rather than only re-running;
   * (b) parenting items to the bento vs. absolute placement; (c) final z-order.
   */
  arrangeSelectionIntoGrid(rows, cols) {
    const items = this.#selectedBboxNodes();
    if (items.length < 2) return;
    if (!this.#bentoAvailable()) {
      console.error(
        `Arrange into Grid: the "${PowerRPApp.#BENTO_TYPE}" widget is not registered yet ` +
        "(parallel lane #86 pending). The grid-size picker and the pure grid math are wired; " +
        "the bento create-and-place step finalizes once that lane merges.",
      );
      return;
    }
    const bento = this.registry.get(PowerRPApp.#BENTO_TYPE);
    const bounds = unionRect(items.map((it) => it.box));
    const usedRows = effectiveRows(items.length, rows, cols);
    const gaps = {
      rowGap: bento.defaults.rowGap ?? 0,
      colGap: bento.defaults.colGap ?? 0,
      padding: bento.defaults.padding ?? 0,
    };
    // 1. Create the bento sized to the union AABB, at the chosen grid shape,
    //    layered behind the selection.
    const zs = this.nodes().map((n) => n.state.z ?? 0);
    const bentoState = {
      ...bento.defaults,
      x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h,
      rows: usedRows, cols,
      active: true,
      z: (zs.length ? Math.min(...zs) : 0) - 1,
    };
    let [doc, bentoId] = withNewItem(this.doc, this.slideIndex, bentoState);
    // 2. Place each item's CENTER on its cell center (row-major), as x/y
    //    keyframes on the current slide.
    const byCell = new Map(cellCenters(bounds, usedRows, cols, gaps).map((c) => [`${c.row},${c.col}`, c]));
    const assignments = gridAssign(items.length, usedRows, cols);
    items.forEach(({ node, box }, i) => {
      const cell = byCell.get(`${assignments[i].row},${assignments[i].col}`);
      doc = keyframed(doc, this.slideIndex, ["items", node.itemId, "x"], cell.x - box.w / 2);
      doc = keyframed(doc, this.slideIndex, ["items", node.itemId, "y"], cell.y - box.h / 2);
    });
    this.commit(withNormalizedZ(doc));
    this.selection = bentoId;
  }

  /**
   * Clears to a fresh document (round 11: "next to save and load I should be
   * able to clear the current thing"). Goes through commit() so it lands in
   * the UNDO log — undo restores everything, which is the safety net (no
   * confirm dialog by design). newDocument() guarantees THE camera exists.
   * UI resets mirror loadFile: slide 0, nothing selected.
   */
  async newDocument() {
    // GUARDED like every other working-copy replacement. The old comment on
    // clearDoc claimed undo was safety net enough ("no confirm dialog by design"),
    // and for the DOCUMENT it still is — but it never was for the LIBRARY LINK:
    // after this runs the app points at a fresh unsaved document, and an undo
    // restores the items without restoring which project they belonged to.
    //
    // SAME SPLIT AS openProjectNamed/loadProject, for the same reason: this is the
    // GESTURE (the "New Empty Document" command), while `clearDoc` stays the plain
    // programmatic reset that a dozen probes call as setup. A probe has no user to
    // answer a dialog, so guarding the API would deadlock it.
    return this.guardedOpen(() => this.clearDoc(), "a new empty document");
  }

  /** Command. Reset to a fresh document. UNGUARDED — see newDocument above for
   *  the split. Any USER-FACING "new document" must go through that instead. */
  clearDoc() {
    clearDynamicFonts(); // a fresh doc has no project → drop uploaded font families
    this.commit(newDocument());
    // A BRAND-NEW DOCUMENT IS AN UNSAVED DRAFT — the unification (user ruling:
    // "Untitled is a special project — I shouldn't be allowed to just save it").
    // Both flags reset: `everSaved` because nothing of THIS document is in the
    // library, and `draftMode` because a new document is not the IMPORTED draft
    // that may have been open a moment ago — leaving that set would keep
    // projectName() answering the draft key, so a later Save would commit the
    // previous deck's staged assets under this empty document's name.
    this.everSaved = false;
    this.draftMode = null;
    localStorage.removeItem(DRAFT_STATE_KEY);
    this.slideIndex = 0;
    this.selection = null;
  }

  loadAutosave() {
    const json = localStorage.getItem(AUTOSAVE_KEY);
    if (json) {
      // repaired() runs the full load-boundary pipeline: drops orphaned items
      // LOUDLY, ensures THE camera, and migrates legacy {item, anchor} arrow
      // bindings to equation pairs (THE UNIFICATION) — all inside
      // repairedDocument now, so no separate withBindingsMigrated wrap.
      this.doc = this.repaired(deserialize(json));
      this.undoLog = createUndo(this.snapshot(this.doc));
      // THE REGRESSED SEAM: projectName() reads `this.draftMode` to choose
      // between DRAFT_KEY and doc.meta.name, but `draftMode` used to still be
      // null here — restoreDraft(), the one thing that sets it, is called by
      // App.svelte AFTER loadAutosave(), because it also needs the document
      // loadAutosave just restored. So a reloaded DRAFT primed its human-name
      // keyspace (empty) instead of DRAFT_KEY (where the assets actually are),
      // and every ref failed resolveUrl. draftStateFromJson is a pure sync
      // localStorage read — nothing stops doing it here too, before the prime,
      // so projectName() already answers correctly on the very first call.
      // restoreDraft() still runs afterwards for the async half (plugin assets,
      // the boot log); re-assigning the same value there is a harmless no-op.
      this.draftMode = draftStateFromJson(localStorage.getItem(DRAFT_STATE_KEY));
      // Prime the object-URL memo for THIS project at the boot path itself. A
      // reload restores from autosave without ever calling loadProject, so the
      // sync resolveUrl memo used to stay empty until the Explorer's refresh
      // primed it — one transient 404 per canvas asset on every static reload
      // (2abe36d put the reachable fix in the Explorer; this is the
      // architectural home it named). Fire-and-forget: a repaint follows.
      //
      // assetStoreFor, NOT the bare assetStore(): `draftMode` is now set (just
      // above) BEFORE this runs, so `this.projectName()` may already answer the
      // draft key on a reloaded draft. In HTTP mode, `assetStore()` would be
      // `httpAssetStore`, whose `primeUrls` is a no-op — silently leaving the
      // reloaded draft's assets unprimed (every ref then reads as the MISSING
      // sentinel instead of the loud 500 the CRUD seam used to give — a quieter
      // but equally wrong failure of the same underlying routing gap).
      assetStoreFor(this.projectName()).primeUrls(this.projectName()).catch((e) => console.error(`PowerRP boot: primeUrls failed — ${e}`));
    }
  }

  runCommand(id) {
    const cmd = this.commands.get(id);
    // Disabled-command semantics: a failing `when` means "not runnable here"
    // (guards e.g. deleting the non-purgeable camera via the Delete key).
    if (cmd.when && !cmd.when(this)) return;
    // toggle-palette is excluded from MRU: keyboard-opening the palette IS a
    // command run, and tracking it made it permanently #1 — pure noise.
    if (id !== "toggle-palette") this.commands.markUsed(id);
    // Running a submenu child (e.g. a theme under "Color Theme →") also bumps
    // its parent: the child can't appear in the top-level list, so surfacing the
    // parent is what makes "recently used" visible there.
    const parent = this.commands.parentOf(id);
    if (parent) this.commands.markUsed(parent.id);
    localStorage.setItem("powerrp.mru", JSON.stringify(this.commands.usageList()));
    cmd.run(this);
  }

  loadMru() {
    const json = localStorage.getItem("powerrp.mru");
    if (json) this.commands.loadUsage(JSON.parse(json));
  }

  /**
   * Renders the current slide THROUGH THE CAMERA and downloads a PNG.
   * The camera determines the output size/aspect (manifest: THE CAMERA).
   */
  async exportPng() {
    // THE renderer via the shared pixel service; the camera determines the
    // output size/aspect (evaluated state — its properties may be equations).
    const rect = cameraRect(evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry, this.projectScript()).state, this.doc.meta);
    // THE DRAIN (#281): a PNG export gets ONE chance at its pixels, so it waits
    // for every async raster the frame needs and REFUSES rather than saving a
    // file with a hole where a PDF page, image, LaTeX or Mermaid diagram should
    // be. The editor canvas beside it does not wait — it repaints on
    // onImageLoad — which is exactly why the export must: a stale preview
    // corrects itself in a moment and a saved file never does.
    const canvas = await settledFrame(() => renderCameraFrame(this.doc, {
      slideIndex: this.slideIndex,
      alpha: 1,
      registry: this.registry,
      width: Math.round(rect.w),
      height: Math.round(rect.h),
      project: this.projectName(),
    }), "PNG export");
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${this.projectDisplayName()}-slide${this.slideIndex + 1}.png`;
    a.click();
  }

  /**
   * Exports the current slide as a VECTOR PDF (manifest "PDF export, round
   * 11"): shapes/text stay vector (text selectable), blur regions embed as
   * raster per the hybrid rule. The camera rect IS the page (pt = world px).
   *
   * EMBEDDED PDFs STAY VECTOR: (a) before deriving the scene, every pdf_page
   * node's async VECTOR ingest is awaited (a one-shot export has no repaint loop
   * to pick up the fire-and-forget result), so a vector-safe page emits its real
   * `path` IR instead of the raster fallback; (b) a text/paper page — which the
   * classifier rasterizes — is instead copied LOSSLESSLY via pdf-lib embedPdf
   * (resolvePdfPageEmbed), keeping its real vectors, selectable text, and fonts.
   * A synthetic pdfpage:/latex: ref that must raster (cropped / translucent /
   * under an effect) is resolved to bytes through resolveImageBytes — the seam
   * that replaces the old fetch("pdfpage:…") crash.
   */
  async exportPdf() {
    const { irToPDF, parsePdfPageRef } = await import("../render_gpu/pdf_backend.js");
    const { sceneIR } = await import("../render_gpu/ports.js");
    const { fitRectView } = await import("../core/view.js");
    const { loadFontBytes, fontkit, measureTextAscent, measureText } = await import("./pdfFonts.js");
    const { getImage } = await import("../render_gpu/gpu/image_registry.js");
    const { ensurePdfPageVector } = await import("../render_gpu/gpu/pdf_page_vector.js");
    const { clampPage, pdfPageCount } = await import("../render_gpu/gpu/pdf_page_raster.js");
    const { resolveSilhouetteBorders } = await import("../render_gpu/skia/silhouette.js");
    const { ensureCanvasKit } = await import("../render_gpu/skia/browser_canvaskit.js");
    const state = evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry, this.projectScript()).state;
    const rect = cameraRect(state, this.doc.meta);

    // (a) WARM UP the vector ingest for every pdf_page node BEFORE deriving the
    // scene. emit() reads pdfPageVectorIRFor synchronously; a fresh export never
    // awaits the fire-and-forget ensurePdfPageVector, so without this the first
    // read is always null → raster fallback. Clamp exactly like emit() so the
    // warmed page is the one emit() will read.
    await Promise.all(Object.values(state.items ?? {})
      .filter((s) => s.type === "pdf_page" && typeof s.src === "string" && s.src.length > 0)
      .map((s) => {
        const requested = s.page ?? 1;
        let page = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1;
        const count = pdfPageCount(s.src);
        if (count != null) page = clampPage(requested, count).page;
        return ensurePdfPageVector(s.src, page);
      }));

    // The synthetic-ref → PNG-bytes resolver (pdfpage:/latex: rasters): read the
    // registry ImageBitmap and re-encode it (the exportSvg videoFrame pattern).
    // A ref with no ready bitmap (source still rasterizing) reports and draws
    // nothing rather than throwing — a reported skip, never a silent one.
    const resolveImageBytes = async (ref) => {
      const bitmap = getImage(ref);
      if (!bitmap) {
        console.warn(`exportPdf: synthetic ref "${ref.slice(0, 48)}…" has no rasterized bitmap yet — it exports blank. Re-export once the page/equation has finished rendering.`);
        return null;
      }
      const c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      c.getContext("2d").drawImage(bitmap, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      return new Uint8Array(await blob.arrayBuffer());
    };
    // The LOSSLESS page-embed source for a full-frame opaque pdf_page: parse the
    // ref back to (src, page) and hand pdf-lib the raw source-PDF bytes to copy.
    // A non-pdf_page synthetic ref (latex:) returns null → the raster path above.
    const resolvePdfPageEmbed = async (ref) => {
      const parsed = parsePdfPageRef(ref);
      if (!parsed) return null;
      const res = await fetch(parsed.src); // fetch handles data:/blob:/http(s)/relative
      if (!res.ok) throw new Error(`exportPdf: failed to fetch PDF source "${parsed.src.slice(0, 48)}…" for a lossless page-embed — HTTP ${res.status} ${res.statusText}`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), pageIndex: parsed.page - 1 };
    };

    // Embed the SAME committed fonts the glyph atlas rasterizes (manifest "Text
    // fonts" / embedFont seam): registerFontkit + loadFontBytes let pdf-lib
    // embed the TTFs; measureTextAscent gives per-font baseline parity with the
    // atlas. `system` text still uses standard-14 Helvetica (no committed file).
    // measureText is the RICH-TEXT layout seam (Round 13.4) — without it the PDF
    // backend degrades a multi-run text box to its first run (and outline/
    // highlight never emit); passing it makes exported rich text match the editor.
    // SILHOUETTE BORDER STAMPING (render_gpu/skia/silhouette.js): the ONE
    // CanvasKit-consuming pre-pass over the flat IR, before the DOM-free/
    // CanvasKit-free PDF backend ever sees it — see resolveSilhouetteBorders'
    // docblock for why this cannot live inside sceneIR itself.
    const CanvasKit = await ensureCanvasKit();
    const irWithBorders = resolveSilhouetteBorders(sceneIR(deriveRenderTree(state, this.registry, this.projectName())), CanvasKit);
    const bytes = await irToPDF(irWithBorders, {
      width: rect.w,
      height: rect.h,
      view: fitRectView(rect, rect.w, rect.h, 1),
      background: rect.background,
      rasterize: rasterizeIrPng,
      textAscent: measureTextAscent(),
      measureText: measureText(),
      loadFontBytes,
      registerFontkit: await fontkit(),
      resolveImageBytes,
      resolvePdfPageEmbed,
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    a.download = `${this.projectDisplayName()}-slide${this.slideIndex + 1}.pdf`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /**
   * Exports the current slide as a standalone, SELF-CONTAINED VECTOR SVG
   * (manifest "SVG export", the PDF backend's sibling): shapes/text stay vector
   * (text SELECTABLE), fonts embed as @font-face data: URIs, images/video-frames
   * inline as data: URIs, and blur regions embed as raster per the HYBRID RULE.
   * The camera rect IS the viewBox. The output opens in any browser with NO
   * network (OFFLINE RULE) — every asset is inlined.
   *
   * Seams mirror exportPdf's, plus two SVG-specific inliners (the SVG must
   * embed every asset, unlike a PDF which could in principle fetch): a
   * resolveImageHref that fetches a URL image → data URI, and a videoFrame that
   * grabs the <video> element's CURRENT frame → PNG (the manifest video rule).
   */
  async exportSvg() {
    const { irToSVG } = await import("../render_gpu/svg_backend.js");
    const { loadFontBytes, measureTextAscent, measureText } = await import("./pdfFonts.js");
    const { getVideo } = await import("../render_gpu/gpu/video_registry.js");
    const { resolveSilhouetteBorders } = await import("../render_gpu/skia/silhouette.js");
    const { ensureCanvasKit } = await import("../render_gpu/skia/browser_canvaskit.js");
    const state = evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry, this.projectScript()).state;
    const rect = cameraRect(state, this.doc.meta);

    // Any image src that is a URL (asset-server case) must be inlined for a
    // self-contained SVG. A data-URI src is used as-is by the backend (no
    // resolver call); this only fires for URL refs. Loud on a failed fetch.
    const resolveImageHref = async (ref) => {
      const res = await fetch(ref);
      if (!res.ok) throw new Error(`exportSvg: failed to fetch image "${ref}" for inlining — HTTP ${res.status} ${res.statusText}`);
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result); // a data: URI
        fr.onerror = () => reject(new Error(`exportSvg: could not read image "${ref}" as a data URI`));
        fr.readAsDataURL(blob);
      });
    };
    // Grab the video's CURRENT frame as a PNG (manifest: a video exports as its
    // current frame). The <video> element lives in the shared registry; if it
    // isn't decoded yet there is no drawable frame → return null (draw nothing,
    // loud is unnecessary — the compositor skips an undecoded video too).
    const videoFrame = async (ref) => {
      const el = getVideo(ref);
      if (!el || !el.videoWidth || !el.videoHeight) return null;
      const c = document.createElement("canvas");
      c.width = el.videoWidth;
      c.height = el.videoHeight;
      c.getContext("2d").drawImage(el, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      return { mime: "image/png", bytes: new Uint8Array(await blob.arrayBuffer()) };
    };

    // SILHOUETTE BORDER STAMPING — see exportPdf's identical pre-pass comment.
    const CanvasKit = await ensureCanvasKit();
    const irWithBorders = resolveSilhouetteBorders(sceneIR(deriveRenderTree(state, this.registry, this.projectName())), CanvasKit);
    const svg = await irToSVG(irWithBorders, {
      width: rect.w,
      height: rect.h,
      view: fitRectView(rect, rect.w, rect.h, 1),
      background: rect.background,
      rasterize: rasterizeIrPng,
      textAscent: measureTextAscent(),
      measureText: measureText(), // RICH-TEXT layout seam (Round 13.4) — see exportPdf
      loadFontBytes,
      resolveImageHref,
      videoFrame,
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    a.download = `${this.projectDisplayName()}-slide${this.slideIndex + 1}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /**
   * Command (async). Exports ALL SLIDES (the whole deck, or the modal's chosen
   * startIndex..endIndex range) as one playable .mp4 file on the user's disk,
   * DETERMINISTICALLY — surfaced as "Export All Slides as MP4…", the scope that
   * distinguishes it from the one-slide Export Slide as PNG/PDF/SVG commands.
   * The client renders every frame; the SERVER encodes the
   * H.264 MP4 (ffmpeg). MP4-specific orchestration over the GENERAL video-export
   * pipeline (web/videoExport.js): it builds the timeline PLAN (the presenter's
   * hold + transition-in model), defines the deterministic frame renderer, wires
   * the pluggable server encoder (web/serverMp4Encoder.js) and the controlled-time
   * seam, and runs exportVideo(). Returns the "video/mp4" Blob and, when
   * `download` (default), saves it. Dynamic imports keep the export lane out of
   * the initial bundle and out of node (the exportPdf/exportSvg pattern).
   *
   * WHY server-side: the browser's WebCodecs VideoEncoder is secure-context-only
   * (HTTPS / localhost). PowerRP runs on plain HTTP on a LAN IP, so in-browser
   * encoding is impossible there — the app's HTTPS-independence tenant demands the
   * encode happen on the server. The frame RENDER stays fully client-side and
   * deterministic; only the encode moves (serverMp4Encoder streams each PNG to the
   * backend, which runs libx264 and returns the file).
   *
   * FRAME RENDER: each (slide, alpha) is rendered through the SAME deterministic
   * path the presenter/CLI use (transitionRender.renderTransitionFrame — tween OR
   * fade), composited over the chosen letterbox background. At the default
   * (output size == camera size) the content fills the frame, so the result is
   * byte-for-byte the presenter/CLI render.
   *
   * MOTION BLUR (`samples` > 1): exportVideo renders N sub-frames per output
   * frame at evenly-subdivided sub-times and averages them (CLIENT-side, before a
   * frame is shipped). The controlled-time setter is
   * render_gpu/particle_clock.setParticleTimeOverride, so the ambient animation
   * clock (particle emitters, raycast-dither, any particleTime() consumer) samples
   * each sub-time too — time-driven effects blur alongside the tween. samples=1
   * (default) is one render per frame (no blur, no extra cost), but STILL drives
   * the clock so animated widgets animate over the video (like the presenter)
   * rather than freezing.
   *
   * LOUD when the server is unreachable or errors: createServerMp4Encoder /
   * finalize throw with the reason; the modal surfaces it. No client fallback.
   *
   * @param {object} o
   * @param {number} o.width Output width in px (even).
   * @param {number} o.height Output height in px (even).
   * @param {number} o.fps Frames per second.
   * @param {number} o.crf libx264 Constant Rate Factor (0..51, lower = higher quality).
   * @param {number} [o.samples] Temporal subsamples for motion blur (default 1).
   * @param {number} [o.startIndex] First slide index (default 0).
   * @param {number} [o.endIndex] Last slide index inclusive (default last).
   * @param {boolean} [o.includeTransitions] Animate transitions (default true).
   * @param {number} [o.holdSeconds] Per-slide dwell fallback (default from videoExport).
   * @param {string} [o.background] Letterbox fill CSS color (default black).
   * @param {(f:number)=>void} [o.onProgress] 0..1 after each encoded frame.
   * @param {AbortSignal} [o.signal] Cancels the encode.
   * @param {boolean} [o.download] Save the blob (default true).
   * @returns {Promise<Blob>}
   */
  async exportMp4({ width, height, fps, crf, samples = 1, startIndex = 0, endIndex = this.doc.slides.length - 1, includeTransitions = true, holdSeconds, background = "#000000", onProgress, signal, download = true }) {
    const { exportVideo, timelinePlan, DEFAULT_HOLD_SECONDS } = await import("./videoExport.js");
    const { createServerMp4Encoder } = await import("./serverMp4Encoder.js");
    const { createLetterboxFrameRenderer } = await import("./transitionRender.js");
    const { setParticleTimeOverride } = await import("../render_gpu/particle_clock.js");
    const plan = timelinePlan(this.doc, {
      startIndex, endIndex, includeTransitions,
      holdSeconds: holdSeconds ?? DEFAULT_HOLD_SECONDS,
    });
    // THE letterbox composite — shared with the client-backend job below and with
    // the server-side headless worker's page half (web/renderJobPage.js), so all
    // three produce the same pixels for the same frame.
    const renderFrame = createLetterboxFrameRenderer({ doc: this.doc, registry: this.registry, width, height, background });
    const encoder = await createServerMp4Encoder({ fps, crf });
    const blob = await exportVideo({
      plan, renderFrame, encoder, width, height, fps, samples,
      setTime: setParticleTimeOverride, // controlled time → ambient-clock effects blur too
      onProgress, signal,
    });
    if (download) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${this.projectDisplayName()}.mp4`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    return blob;
  }

  /**
   * Command (async; submits a job, and for the client backend renders into it).
   * SUBMIT A RENDER JOB — the one entry point both backends go through.
   *
   * WHY THIS REPLACED "export and hold a promise". exportMp4 above makes THIS PAGE
   * the owner of the render: its progress lives in a component, so closing the
   * dialog, refreshing, or an editor hot-reload destroyed the work with no way to
   * find it again. A job instead belongs to the SERVER — submit hands over a
   * SNAPSHOT of the document and returns immediately, and every later question
   * ("how far along?", "where is the file?") is answered by polling
   * listRenderJobs. Nothing the page holds is load-bearing.
   *
   * THE SNAPSHOT IS TAKEN SERVER-SIDE AT SUBMIT from the doc posted here, so
   * editing the deck a second later cannot splice two documents into one video.
   *
   * backend "server": the server spawns headless workers; the page's job is over.
   * backend "client": this page produces the frames (the browser has a real GPU and
   *   renders media, which the headless path cannot yet). That path now belongs to
   *   web/browserRenderJobs.js, which also makes it RESUMABLE: closing the tab
   *   PAUSES such a render and reopening the project continues it. It appears in
   *   the same list with the same progress bar — one job shape, two frame producers.
   *
   * @param {object} o
   * @param {string} o.name Job name; also the output filename stem.
   * @param {string} o.backend "server" | "client".
   * @param {object} o.params width/height/fps/crf/background/range/samples/…
   * @param {string} [o.encoder] For the client backend: which browser encoder
   *   ("upload" | "wasm" — see web/browserRenderJobs.js BROWSER_ENCODERS).
   * @param {AbortSignal} [o.signal] Cancels a CLIENT-backend frame walk.
   * @returns {Promise<object>} the submitted job record (NOT the finished movie)
   */
  async submitRender({ name, backend, params, encoder, signal }) {
    if (backend === "client") {
      const { submitBrowserRenderJob, DEFAULT_BROWSER_ENCODER } = await import("./browserRenderJobs.js");
      return submitBrowserRenderJob({
        project: this.projectName(), name, params, doc: this.doc, registry: this.registry,
        encoder: encoder ?? DEFAULT_BROWSER_ENCODER,
      });
    }
    const { timelinePlan, frameCount, DEFAULT_HOLD_SECONDS } = await import("./videoExport.js");
    const { submitRenderJob } = await import("./projectApi.js");
    const plan = timelinePlan(this.doc, {
      startIndex: params.startIndex,
      endIndex: params.endIndex,
      includeTransitions: params.includeTransitions,
      holdSeconds: params.holdSeconds ?? DEFAULT_HOLD_SECONDS,
    });
    // The denominator for the progress bar, computed from the SAME pure helpers
    // the headless worker uses on the same document — so both agree — and sent
    // only so the bar has a total before the first frame lands.
    const framesTotal = frameCount(plan.duration, params.fps);
    return submitRenderJob(this.projectName(), {
      name, backend, framesTotal, params, doc: this.doc,
    });
  }

  /**
   * Command (async, fire-and-forget). Continue a PAUSED browser render job from
   * where it stopped. Surfaced by the Render Center's Resume button.
   *
   * Not awaited by the caller for the same reason a submit is not: the modal may be
   * closed a second later, and the job is tracked by polling.
   *
   * @param {string} jobId
   * @returns {Promise<object>} the finished job record
   */
  async resumeRender(jobId) {
    const { resumeBrowserRenderJob } = await import("./browserRenderJobs.js");
    return resumeBrowserRenderJob(jobId, this.registry);
  }

  // ── Copy selection as PNG/PDF (manifest Round 12B "Palette / selection
  // commands"): render ONLY the selected items, cropped to their collective
  // world AABB, onto the SYSTEM clipboard. Distinct from exportPng/exportPdf
  // (which always render the FULL slide through THE CAMERA) — these two crop
  // to the selection instead, reusing the same GPU/PDF backends. ──────────────

  /**
   * Query. The selected nodes' collective WORLD AABB (union of each selected
   * bbox node's effectInclusiveAABB — rotatedBBoxAABB, the same conservative
   * rotation-aware bound the culling protocol uses, inflated by that node's
   * shadow/bloom reach so a copied/exported PNG contains the WHOLE rendered
   * element, halo and all — manifest 15.8 ADDITION), or null when nothing
   * selected or none of the selected items have a bbox (e.g. only the
   * camera, or a non-bbox widget alone — nothing to crop to).
   */
  selectionWorldAABB() {
    const boxes = this.selectedNodes().map(effectInclusiveAABB).filter(Boolean);
    if (boxes.length === 0) return null;
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /** Query. The render job for the SELECTED ITEMS ONLY — `{rect, nodes}` where
   *  rect is their collective world AABB (selectionWorldAABB) and nodes are the
   *  derived render-tree nodes of exactly those items (not everything that
   *  merely intersects the box) — or null when there is nothing with a bbox to
   *  render (e.g. a camera-only selection). The ONE place copy-as-PNG,
   *  copy-as-PDF, and the copySelection OS render agree on WHAT to rasterize. */
  #selectionRenderJob() {
    const rect = this.selectionWorldAABB();
    if (!rect || rect.w <= 0 || rect.h <= 0) return null;
    const state = evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry, this.projectScript()).state;
    const selected = new Set(this.selectedIds());
    const nodes = deriveRenderTree(state, this.registry, this.projectName()).filter((n) => selected.has(n.itemId));
    return { rect, nodes };
  }

  /**
   * Command (async). Rasterizes the current selection to PNG bytes at its pixel
   * resolution (dpr-scaled), or null when there is no bbox to render. THE shared
   * selection-crop rasterize path (copySelection's OS write and copyAsPng both
   * call it). Reports loudly and returns null on a render failure.
   *
   * fitRectView's (w, h) args are WORLD units (rect.w/rect.h) — dpr is a
   * SEPARATE multiplier the compositor applies on top (view.zoom * view.dpr;
   * core/view.js fitRectView doctests). Passing the already-dpr-scaled device px
   * as (w, h) double-applies dpr (at dpr 2 it rasterizes 4x too big so only the
   * top-left quarter fills — the 15.8 bug); world units is what every other
   * rasterizeIrPng caller passes, with dpr flowing through the 4th arg only.
   *
   * @returns {Promise<Uint8Array|null>} PNG bytes, or null (nothing to render)
   */
  async #renderSelectionPng() {
    const job = this.#selectionRenderJob();
    if (!job) return null;
    const { rect, nodes } = job;
    const dpr = this.dpr();
    const width = Math.max(1, Math.round(rect.w * dpr));
    const height = Math.max(1, Math.round(rect.h * dpr));
    try {
      return await rasterizeIrPng(sceneIR(nodes), fitRectView(rect, rect.w, rect.h, dpr), width, height);
    } catch (e) {
      console.error("Render selection PNG failed:", e.message);
      return null;
    }
  }

  /**
   * Command (async). Renders the SELECTED ITEMS ONLY (not everything that
   * merely intersects their box — the spec's "whatever bounding box are the
   * things we currently select we copy that") at their collective world AABB
   * to PNG bytes, then writes those bytes to the SYSTEM clipboard as
   * image/png (navigator.clipboard.write + ClipboardItem). No camera
   * background rect is drawn first (unlike exportPng) — outside the selected
   * items' own fills, the PNG is transparent.
   *
   * Loud on failure: clipboard image writes need a permission browsers can
   * silently deny, and unlike copySelection's item-copy (which has an in-app
   * fallback) THERE IS NO IN-APP FALLBACK for a system-image copy — pasting
   * into another app is the entire point, so a denial is reported, not
   * swallowed. No-op (reported) with nothing selected.
   */
  async copyAsPng() {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      console.error("Copy as PNG: this browser has no Clipboard image-write API (navigator.clipboard.write/ClipboardItem) — cannot copy an image to the system clipboard.");
      return;
    }
    // Same selection-crop rasterize as the copySelection OS render (#renderSelectionPng).
    const png = await this.#renderSelectionPng();
    if (!png) {
      console.error("Copy as PNG: nothing selected (or the selection has no bounding box) — nothing to copy.");
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) })]);
    } catch (e) {
      console.error("Copy as PNG: system clipboard write was denied or failed (permission?) — the in-app clipboard fallback does NOT apply to system-image copies:", e.message);
    }
  }

  /**
   * Command (async). Renders the SELECTED ITEMS ONLY at their collective
   * world AABB through the vector PDF backend (exportPdf's irToPDF path,
   * same hybrid-raster/text-embedding rules), then tries to put the PDF
   * bytes on the SYSTEM clipboard as application/pdf. Most browsers' Async
   * Clipboard API only allows a small clipboard-item type allowlist
   * (image/png, text/plain, text/html) and REJECTS application/pdf — when
   * that happens this falls back to DOWNLOADING the PDF file, with a loud
   * console.warn explaining why: a reported degradation, never a silent one.
   * No-op (reported) with nothing selected.
   */
  async copyAsPdf() {
    const job = this.#selectionRenderJob();
    if (!job) {
      console.error("Copy as PDF: nothing selected (or the selection has no bounding box) — nothing to copy.");
      return;
    }
    const { rect, nodes } = job;
    const { irToPDF } = await import("../render_gpu/pdf_backend.js");
    const { loadFontBytes, fontkit, measureTextAscent, measureText } = await import("./pdfFonts.js");
    const bytes = await irToPDF(sceneIR(nodes), {
      width: rect.w,
      height: rect.h,
      view: fitRectView(rect, rect.w, rect.h, 1),
      background: null, // no camera background — transparent outside the selected items
      rasterize: rasterizeIrPng,
      textAscent: measureTextAscent(),
      measureText: measureText(), // RICH-TEXT layout seam (Round 13.4) — see exportPdf
      loadFontBytes,
      registerFontkit: await fontkit(),
    });
    const blob = new Blob([bytes], { type: "application/pdf" });
    let wroteToClipboard = false;
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "application/pdf": blob })]);
        wroteToClipboard = true;
      } catch (e) {
        console.warn(`Copy as PDF: the browser's clipboard rejected application/pdf (${e.message}) — falling back to downloading the PDF file instead of a silent failure.`);
      }
    } else {
      console.warn("Copy as PDF: this browser has no Clipboard write API for application/pdf — falling back to downloading the PDF file instead of a silent failure.");
    }
    if (!wroteToClipboard) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${this.projectDisplayName()}-selection.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }
}
