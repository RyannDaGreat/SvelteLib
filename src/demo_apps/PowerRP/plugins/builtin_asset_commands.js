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
/**
 * THE PLUGIN-WIDGET SUBMENU — every LOADED plugin-asset widget as an Add command,
 * titled "Plugin: <name>" (user ruling).
 *
 * ── WHY A SUBMENU WITH A MUTABLE CHILD LIST, AND NOT N TOP-LEVEL COMMANDS ─────
 * The requirement is that entries appear when a plugin loads and go away on a
 * project switch. The command registry has NO `remove`, deliberately: commands are
 * process-lifetime, and that is precisely what fixed the "Duplicate command id
 * add-rect" crash that made the editor unopenable on a second project open
 * (plugins/index.js registerPlugins documents it). Adding a `remove` to serve this
 * feature would reintroduce the class of bug that constraint exists to prevent.
 *
 * So the registry entry is ONE stable submenu, registered once at boot, whose
 * CHILDREN are replaced on every project load. `commands.search(query, parent)`
 * reads `parent.children` at call time, so a rebuilt array is picked up
 * immediately — no registration, no removal, no duplicate-id hazard. The submenu id
 * never changes, so a keybinding or MRU stamp on it stays valid across projects.
 *
 * ── WHY THE CHILDREN CANNOT BE STATIC ─────────────────────────────────────────
 * A project's `*.plugin.js` assets ARE the widget set, and it differs per project:
 * `app.registry` is rebuilt on every open. A captured plugin object would go stale
 * on the second open; a captured TYPE would name something no longer registered.
 * Each child therefore resolves its plugin LAZILY from the live registry at click
 * time — the same pattern the three entries above use, for the same reason.
 */
export const PLUGIN_WIDGETS_SUBMENU = Object.freeze({
  id: "add-plugin-widget",
  title: "Add Plugin Widget",
  icon: "mdi:puzzle-outline",
  aliases: ["plugin", "custom widget", "asset widget"],
  // Populated by refreshPluginWidgetCommands on every project load. Starts EMPTY
  // rather than absent: `children` is what makes this entry a submenu at all
  // (core/commands.js: a command has `run` XOR `children`), so dropping it would
  // make a project with no plugin assets register a malformed command.
  children: [],
});

/**
 * Pure function. The Add command for ONE plugin-asset widget.
 *
 * TITLE IS "Plugin: <name>" per the user's ruling — the prefix is the point. A
 * palette full of bare widget names gives no way to tell a shipped widget from one
 * a project's own Claude wrote five minutes ago, and those two have very different
 * trust and portability stories (a plugin widget travels with the deck; a built-in
 * does not need to).
 *
 * THE PLUGIN'S OWN HELP TEXT IS CARRIED WHEN IT DECLARES ONE, because a widget
 * nobody but its author has seen is exactly the case where the palette's
 * one-line explanation is load-bearing. `help` is the field the palette already
 * renders for built-in commands, so this needs no new surface.
 *
 * @param {object} plugin - a registered plugin-asset plugin
 * @returns {{id: string, title: string, icon: string, help?: string, run: Function}}
 *
 * @example
 * // pluginWidgetCommand({type: "gear", title: "Gear"}).title  // "Plugin: Gear"
 * @example
 * // pluginWidgetCommand({type: "gear", title: "Gear"}).id     // "add-plugin-gear"
 * @example
 * // A plugin that documents itself passes its help through:
 * // pluginWidgetCommand({type: "sq", title: "Squircle", help: "A rounded superellipse."}).help
 * // "A rounded superellipse."
 * @example
 * // A plugin with no help gets none (the palette omits the line rather than
 * // printing a placeholder):
 * // "help" in pluginWidgetCommand({type: "gear", title: "Gear"})  // false
 */
export function pluginWidgetCommand(plugin) {
  const cmd = {
    id: `add-plugin-${plugin.type}`,
    title: `Plugin: ${plugin.title ?? plugin.type}`,
    icon: plugin.icon ?? "mdi:puzzle-outline",
    run: (app) => app.armCrosshairPlacement(app.registry.get(plugin.type)),
  };
  if (plugin.help) cmd.help = plugin.help;
  return cmd;
}

/**
 * Command (mutates PLUGIN_WIDGETS_SUBMENU.children). Rebuild the submenu's children
 * from the plugin-asset widgets currently registered. Called after every project
 * load, which is when the set can change.
 *
 * MUTATES THE ARRAY IN PLACE (splice, not reassignment) because the submenu object
 * is frozen and — more importantly — the registry holds a reference to that exact
 * array from registration. Reassigning `children` would leave the palette reading
 * the original empty array forever, which is the kind of failure that looks like
 * "the feature does nothing" rather than an error.
 *
 * @param {object[]} plugins - the project's plugin-asset plugins (app.pluginAssetPlugins())
 * @returns {number} how many children the submenu now has
 *
 * @example
 * // refreshPluginWidgetCommands([{type: "gear", title: "Gear"}])  // 1
 * // PLUGIN_WIDGETS_SUBMENU.children[0].title                     // "Plugin: Gear"
 * @example
 * // A project with no plugin assets empties it (the entries "go away"):
 * // refreshPluginWidgetCommands([])            // 0
 * // PLUGIN_WIDGETS_SUBMENU.children            // []
 */
export function refreshPluginWidgetCommands(plugins) {
  const children = (plugins ?? []).map(pluginWidgetCommand);
  PLUGIN_WIDGETS_SUBMENU.children.splice(0, PLUGIN_WIDGETS_SUBMENU.children.length, ...children);
  return children.length;
}

/**
 * The add-commands registerAll registers, in Insert-menu order: the three named
 * entries the migration carried over, then the PLUGIN-WIDGET SUBMENU.
 *
 * DECLARED LAST IN THE FILE, and that is not stylistic. It holds a reference to
 * PLUGIN_WIDGETS_SUBMENU, and a `const` cannot be read before its initializer runs —
 * with this array at the top of the file, importing this module threw "Cannot access
 * 'PLUGIN_WIDGETS_SUBMENU' before initialization" and took the whole app's boot with
 * it (registerAll imports this).
 */
export const builtinAssetCommands = [
  { id: "add-donut", title: "Add Donut", icon: "mdi:circle-double", run: (app) => app.armCrosshairPlacement(app.registry.get("donut")) },
  { id: "add-clock-digital", title: "Add Digital Clock", icon: "mdi:clock-digital", run: (app) => app.armCrosshairPlacement(app.registry.get("clock_digital")) },
  { id: "add-clock_analog", title: "Add Analog Clock", icon: "mdi:clock-outline", run: (app) => app.armCrosshairPlacement(app.registry.get("clock_analog")) },
  PLUGIN_WIDGETS_SUBMENU,
];
