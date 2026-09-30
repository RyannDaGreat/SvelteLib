/**
 * RESIZABLE PRESET GRIDS — the shared rules behind web/ResizeGrip.svelte.
 *
 * User, 2026-09-30: "It would also be good if preset menus for both gradients and...
 * well, all of them were like vertically resizable ... I wanna see all the pretty
 * gradients at once but it won't let me. It only lets me see maybe two and a half
 * rows at a time."
 *
 * A grid has THREE size modes, stored per library KIND (not per mount, so every
 * gradient stop list shares one height and reopening a library restores it):
 *   null    — COMPACT: the grid's own CSS max-height cap (the pre-feature look).
 *   number  — the height in CSS px the user dragged the grip to.
 *   "all"   — SHOW ALL: no cap, so the grid is as tall as its content (and keeps
 *             tracking it as a search filters or a library grows).
 * The stored height is a per-VIEWER convenience (localStorage), never document state.
 */
import { warnOnce } from "../core/report.js";

export const GRID_SHOW_ALL = "all";
const STORAGE_PREFIX = "powerrp.gridHeight.";

/**
 * Pure function. Clamps a dragged grid height to [min, max].
 * @param {number} desired - Height the drag asks for, px.
 * @param {number} min - Smallest allowed height (about one row), px.
 * @param {number} max - Largest useful height (the whole content, or the room a floating panel has), px.
 * @returns {number} Height to apply, px. A max below min yields min.
 * @example clampGridHeight(900, 80, 640) // 640 (cannot grow past the content)
 * @example clampGridHeight(10, 80, 640) // 80 (never smaller than one row)
 * @example clampGridHeight(300, 80, 640) // 300
 */
export function clampGridHeight(desired, min, max) {
  return Math.max(min, Math.min(desired, Math.max(min, max)));
}

/**
 * Pure function. Parses a stored grid height, rejecting garbage loudly.
 * @param {string|null} raw - The localStorage string, or null when never stored.
 * @returns {number|"all"|null} px, GRID_SHOW_ALL, or null for compact.
 * @example parseGridHeight(null) // null
 * @example parseGridHeight("all") // "all"
 * @example parseGridHeight("412.5") // 412.5
 * @example parseGridHeight("tall") // throws Error
 */
export function parseGridHeight(raw) {
  if (raw === null) return null;
  if (raw === GRID_SHOW_ALL) return GRID_SHOW_ALL;
  const px = Number(raw);
  if (!Number.isFinite(px) || px <= 0) throw new Error(`Stored grid height is not a positive number: ${JSON.stringify(raw)}`);
  return px;
}

/**
 * Query (reads localStorage). The stored size mode for one library kind. A storage
 * failure or a corrupt value is REPORTED (warnOnce) and treated as compact, so a
 * broken browser store never breaks the picker it only decorates.
 * @param {string} kind - Library kind, e.g. "multipoint-presets".
 * @returns {number|"all"|null} px, GRID_SHOW_ALL, or null (compact).
 * @example readGridHeight("gradient-presets") // null on a fresh browser
 */
export function readGridHeight(kind) {
  try {
    return parseGridHeight(localStorage.getItem(STORAGE_PREFIX + kind));
  } catch (err) {
    warnOnce(`grid-height-read:${kind}`, `Preset grid "${kind}": could not read its saved height (${err.message}); showing the compact size.`);
    return null;
  }
}

/**
 * Command (writes localStorage). Stores (or with null, clears) one kind's size mode.
 * A storage failure is REPORTED (warnOnce); the on-screen size still applies.
 * @param {string} kind - Library kind.
 * @param {number|"all"|null} value - px, GRID_SHOW_ALL, or null for compact.
 * @returns {void}
 * @example writeGridHeight("multipoint-presets", "all") // later reads return "all"
 */
export function writeGridHeight(kind, value) {
  try {
    if (value === null) localStorage.removeItem(STORAGE_PREFIX + kind);
    else localStorage.setItem(STORAGE_PREFIX + kind, String(value));
  } catch (err) {
    warnOnce(`grid-height-write:${kind}`, `Preset grid "${kind}": could not save its height (${err.message}); it will reset on reload.`);
  }
}

/**
 * Query (reads layout). The ROOM a grid may grow into: inside a container that
 * declares `data-resize-room` (a floating canvas panel states how many px it may
 * occupy on screen), that room minus the rest of the container; otherwise Infinity
 * (the Inspector pane scrolls, so an Inspector grid is unbounded).
 * @param {HTMLElement} grid - The grid element.
 * @returns {number} px, or Infinity.
 */
export function gridRoom(grid) {
  const bounded = grid.closest("[data-resize-room]");
  if (!bounded) return Infinity;
  const room = Number(bounded.dataset.resizeRoom);
  if (!Number.isFinite(room)) throw new Error(`data-resize-room must be a number of px, got ${JSON.stringify(bounded.dataset.resizeRoom)}`);
  return room - (bounded.getBoundingClientRect().height - grid.getBoundingClientRect().height);
}

/**
 * Query (reads layout). The largest useful height: the grid's whole content, never
 * more than its room (gridRoom), so growing it cannot push a floating panel off screen.
 * @param {HTMLElement} grid - The grid element.
 * @returns {number} Maximum height, px.
 */
export function gridMaximum(grid) {
  return Math.min(grid.scrollHeight, gridRoom(grid));
}

/**
 * Query (reads layout). About one row: the tallest of the grid's first few children
 * plus its vertical padding. A family caption counts, so a grid that opens on a
 * caption still shows the caption and the top of the first tiles.
 * @param {HTMLElement} grid - The grid element.
 * @returns {number} Minimum height, px.
 */
export function gridRowMinimum(grid) {
  const CHILDREN_SAMPLED = 3; // enough to reach the first real tile after a caption
  const style = getComputedStyle(grid);
  const kids = [...grid.children].slice(0, CHILDREN_SAMPLED);
  const tallest = Math.max(0, ...kids.map((el) => el.getBoundingClientRect().height));
  return tallest + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
}

/**
 * Command (mutates the element's inline style). Applies a size mode to a grid:
 * compact clears the inline override so the CSS cap governs again; any other mode
 * lifts the CSS cap but stays inside the grid's room (gridRoom).
 * @param {HTMLElement} grid - The scrolling grid element.
 * @param {number|"all"|null} mode - px, GRID_SHOW_ALL, or null.
 * @returns {void}
 */
export function applyGridHeight(grid, mode) {
  if (mode === null) {
    grid.style.maxHeight = "";
    grid.style.height = "";
    return;
  }
  const room = gridRoom(grid);
  grid.style.maxHeight = Number.isFinite(room) ? `${room}px` : "none";
  grid.style.height = mode === GRID_SHOW_ALL ? "auto" : `${mode}px`;
}
