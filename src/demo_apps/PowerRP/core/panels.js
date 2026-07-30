/**
 * THE PANEL INVENTORY — the dockable panels of the editor shell, declared ONCE
 * in DOM-free core so three consumers read the same list instead of three
 * hand-kept copies: web/App.svelte's layout, the "Toggle Visibility: …"
 * command family, and tests/panel_visibility_test.js.
 *
 * WHY A DECLARATION AND NOT JUST MARKUP. Before this, a pane's existence, its
 * name, and its share of the column were three literals in App.svelte's
 * template + a `$state([0.35, 0.57, 0.78])` boundary array. Hiding one meant
 * editing a boundary array by hand, and boundary arrays cannot express
 * absence — SplitPane derives paneCount from `splits.length + 1`, so a hidden
 * pane rendered as an empty slot with a LIVE DIVIDER next to it (a divider you
 * can drag that resizes nothing is exactly the "dead divider" the user's
 * ruling forbids). Declaring per-panel WEIGHTS instead, and deriving the
 * boundaries from the VISIBLE subset, makes absence structural: a hidden panel
 * contributes no pane and therefore no handle.
 *
 * THE CANVAS IS NOT A PANEL — it is the interaction surface, has no Panel
 * wrapper, no name plate, and cannot be hidden. Neither is the Hint Bar: it
 * lives outside `.main`, is not a SplitPane pane, and is the discoverability
 * substrate the whole shortcut convention rests on.
 *
 * TITLE CONVENTION (user ruling, verbatim): "we're going to have toggle
 * visibility as a prefix. It's convention. Toggle visibility of different
 * panels: toggle visibility properties panel, toggle visibility keyframes
 * panel…". So every command title is exactly
 * `Toggle Visibility: <label> Panel` — the prefix first so the family sorts
 * and filters together in the palette.
 *
 * The GLOBAL VARIABLES panel is the one panel hidden by default (user ruling:
 * variables panel "by default will be off for now on."), and it is named
 * "Global Variables" because those variables ARE global — the per-item
 * variables live in the Property Panel's own Variables category, and calling
 * both "Variables" is what made the distinction invisible.
 */

/** The command-title prefix. ONE literal, so the convention cannot drift. */
export const TOGGLE_VISIBILITY_PREFIX = "Toggle Visibility: ";

/**
 * THE dockable panels, in layout order within each column.
 *
 *   id       — slug; the command is `toggle-panel-<id>` and the localStorage
 *              key is `powerrp.panel.<id>`.
 *   label    — user-facing name WITHOUT the word "Panel" (the command title
 *              and the Panel name plate both append it, so the noun is
 *              written once).
 *   column   — "left" | "right"; which vertical SplitPane the pane sits in.
 *   weight   — its share of that column when visible. Relative, not
 *              fractional: only the ratios among the VISIBLE panels matter,
 *              which is what lets a hidden panel's share redistribute to its
 *              neighbours instead of leaving a gap. Values reproduce the
 *              pre-toggle layout's boundaries (left [0.62]; right
 *              [0.35, 0.57, 0.78] → 0.35/0.22/0.21/0.22).
 *   icon     — palette/toolbar glyph for the toggle command.
 *   defaultVisible — today's layout, EXCEPT globalVariables (see docblock).
 */
export const PANELS = [
  { id: "slides", label: "Slide Navigator", column: "left", weight: 0.62, icon: "mdi:filmstrip", defaultVisible: true },
  { id: "assets", label: "Asset Explorer", column: "left", weight: 0.38, icon: "mdi:folder-multiple-image", defaultVisible: true },
  { id: "properties", label: "Property", column: "right", weight: 0.35, icon: "mdi:tune-vertical", defaultVisible: true },
  { id: "tools", label: "Tools", column: "right", weight: 0.22, icon: "mdi:toolbox-outline", defaultVisible: true },
  { id: "globalVariables", label: "Global Variables", column: "right", weight: 0.21, icon: "mdi:variable", defaultVisible: false },
  { id: "keyframes", label: "Keyframe", column: "right", weight: 0.22, icon: "mdi:diamond-stone", defaultVisible: true },
];

/**
 * Pure function. The panel with this id.
 *
 * @param {string} id Panel id (a PANELS entry's `id`).
 * @returns {{id: string, label: string, column: string, weight: number, icon: string, defaultVisible: boolean}}
 *
 * @example panelById("tools").label
 * 'Tools'
 * @example panelById("globalVariables").defaultVisible
 * false
 */
export function panelById(id) {
  const panel = PANELS.find((p) => p.id === id);
  if (!panel) throw new Error(`No such panel: ${id}. Known panels: ${PANELS.map((p) => p.id).join(", ")}`);
  return panel;
}

/**
 * Pure function. The panels of one column, in layout order.
 *
 * @param {string} column "left" | "right".
 * @returns {object[]} The matching PANELS entries.
 *
 * @example panelsInColumn("left").map((p) => p.id)
 * [ 'slides', 'assets' ]
 * @example panelsInColumn("right").map((p) => p.id)
 * [ 'properties', 'tools', 'globalVariables', 'keyframes' ]
 */
export function panelsInColumn(column) {
  return PANELS.filter((p) => p.column === column);
}

/**
 * Pure function. The user-facing name plate / hover-region name for a panel:
 * the label plus the noun "Panel". One place, so the plate, the command title
 * and the region name cannot disagree.
 *
 * @param {object} panel A PANELS entry.
 * @returns {string}
 *
 * @example panelName(panelById("properties"))
 * 'Property Panel'
 * @example panelName(panelById("globalVariables"))
 * 'Global Variables Panel'
 */
export function panelName(panel) {
  return `${panel.label} Panel`;
}

/**
 * Pure function. The command id and title for a panel's visibility toggle.
 *
 * @param {object} panel A PANELS entry.
 * @returns {{id: string, title: string}}
 *
 * @example panelToggleCommand(panelById("keyframes"))
 * { id: 'toggle-panel-keyframes', title: 'Toggle Visibility: Keyframe Panel' }
 * @example panelToggleCommand(panelById("globalVariables")).title
 * 'Toggle Visibility: Global Variables Panel'
 */
export function panelToggleCommand(panel) {
  return { id: `toggle-panel-${panel.id}`, title: `${TOGGLE_VISIBILITY_PREFIX}${panelName(panel)}` };
}

/**
 * Pure function. The localStorage key holding a panel's visibility.
 *
 * @param {string} id Panel id.
 * @returns {string}
 *
 * @example panelSettingKey("globalVariables")
 * 'powerrp.panel.globalVariables'
 */
export function panelSettingKey(id) {
  return `powerrp.panel.${id}`;
}

/**
 * Pure function. SplitPane BOUNDARY positions for one column, derived from the
 * visible panels' weights. `n` visible panels produce `n - 1` boundaries — so a
 * hidden panel removes both a pane AND its handle, which is what makes a
 * collapsed slot leave no dead divider behind.
 *
 * Weights are normalised by their own sum, NOT by the full column's, so the
 * hidden panel's share is redistributed proportionally and the visible panels
 * keep their relative sizes. Re-showing a panel restores the same boundaries
 * this function produced before it was hidden, because the weights it reads are
 * the panel declarations — a size preference no toggle can lose.
 *
 * Returns [] for 0 or 1 visible panels (a single pane needs no boundary), which
 * is also the empty-column case: the caller hides the whole column then.
 *
 * @param {object[]} visible The visible PANELS entries of one column, in order.
 * @returns {number[]} Ascending boundaries in (0, 1), length `visible.length - 1`.
 *
 * @example columnSplits(panelsInColumn("left"))
 * [ 0.62 ]
 * @example columnSplits([panelById("slides")])
 * []
 * @example // Right column with Global Variables hidden: 0.35/0.22/0.22 of 0.79
 * @example columnSplits(panelsInColumn("right").filter((p) => p.id !== "globalVariables")).map((b) => b.toFixed(3))
 * [ '0.443', '0.722' ]
 */
export function columnSplits(visible) {
  const total = visible.reduce((sum, p) => sum + p.weight, 0);
  const boundaries = [];
  let acc = 0;
  for (const panel of visible.slice(0, -1)) {
    acc += panel.weight / total;
    boundaries.push(acc);
  }
  return boundaries;
}
