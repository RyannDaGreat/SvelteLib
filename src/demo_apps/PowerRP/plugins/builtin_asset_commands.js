/**
 * builtin_asset_commands.js — the PALETTE ENTRIES for widgets that live in the
 * built-in plugin-asset library (assets/builtin/library/, loaded through the jail
 * by core/builtin_plugin_assets.js).
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────
 * A plugin ASSET may not declare `commands`. That is not an oversight in the
 * loader — core/plugin_assets.pluginShapeProblem refuses it outright, because a
 * command's `run(app)` receives the LIVE APP: the document, the network, the
 * whole editor. Handing that to a sandboxed source would give away the exact
 * capability the jail exists to withhold. So a plugin asset describes a widget;
 * it does not drive the editor.
 *
 * Three of the five batch-1 migrations carried an add-command in their source
 * file (`add-donut`, `add-clock-digital`, `add-clock_analog`). Those entries had
 * to keep working — and keep their EXACT ids, because tests/modifier_probe.js and
 * tests/multiresize_place_probe.js drive them by id — so they moved here.
 *
 * ── THE PATTERN IS ALREADY THE HOUSE ONE ──────────────────────────────────────
 * Each entry resolves its plugin LAZILY from the registry at click time
 * (`a.registry.get(type)`) rather than closing over an imported plugin object.
 * web/App.svelte already does exactly this for `add-number`, `add-line` and every
 * demo insert, and for the same reason: registration ORDER stops mattering. It is
 * also the only thing that CAN work here — the plugin object does not exist until
 * the library has been evaluated, and `app.registry` is REBUILT on every project
 * open (a project's own `*.plugin.js` assets are per-project), so a captured
 * object would go stale on the second open while a lazy lookup cannot.
 *
 * ── WHY NOT IN web/App.svelte, WHERE THE SIBLINGS LIVE ────────────────────────
 * Two reasons. It belongs with the plugins (registerAll is the ONE boot path that
 * adds a built-in widget's command, and App.svelte's list is the app SHELL's own
 * commands). And App.svelte is a large, contended file: a widget's palette entry
 * should not require touching the shell to add.
 */

/**
 * The add-commands for the built-in plugin-asset widgets, in Insert-menu order.
 *
 * Each is the plain crosshair placement every bbox Add button uses: CanvasView
 * drives click-drag-places off the plugin's `type` + `.defaults`, so a drag sizes
 * the widget and a plain click drops it at its default size (web/widget_handlers.js
 * placeByBBox).
 *
 * IDS ARE A STABLE INTERFACE. They are what the command palette, the keybinding
 * registry and the browser probes reference, so they match the ids the source
 * plugins declared before the migration, character for character — including
 * `add-clock_analog`'s underscore, which is inconsistent with `add-clock-digital`
 * but is what tests/multiresize_place_probe.js and any user keybinding already
 * hold. Renaming it would be a silent break for a cosmetic gain.
 */
export const builtinAssetCommands = [
  { id: "add-donut", title: "Add Donut", icon: "mdi:circle-double", run: (app) => app.armCrosshairPlacement(app.registry.get("donut")) },
  { id: "add-clock-digital", title: "Add Digital Clock", icon: "mdi:clock-digital", run: (app) => app.armCrosshairPlacement(app.registry.get("clock_digital")) },
  { id: "add-clock_analog", title: "Add Analog Clock", icon: "mdi:clock-outline", run: (app) => app.armCrosshairPlacement(app.registry.get("clock_analog")) },
];
