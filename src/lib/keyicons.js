/**
 * keyicons [general] — iconify (mdi) icons for keyboard key tokens.
 *
 * Shared by HintBar and any shortcut-chip renderer so modifier/special keys
 * (Cmd, Shift, Backspace, …) show their conventional glyphs instead of text.
 * Letter/digit tokens have no icon and render as text chips.
 */

export const KEY_ICONS = {
  Cmd: "mdi:apple-keyboard-command",
  Ctrl: "mdi:apple-keyboard-control",
  Alt: "mdi:apple-keyboard-option",
  Shift: "mdi:apple-keyboard-shift",
  Backspace: "mdi:keyboard-backspace",
  Delete: "mdi:backspace-reverse-outline",
  Esc: "mdi:keyboard-esc",
  Escape: "mdi:keyboard-esc",
  Space: "mdi:keyboard-space",
  Enter: "mdi:keyboard-return",
  Return: "mdi:keyboard-return",
  Tab: "mdi:keyboard-tab",
  Left: "mdi:arrow-left",
  Right: "mdi:arrow-right",
  Up: "mdi:arrow-up",
  Down: "mdi:arrow-down",
};

/**
 * Pure function. The mdi icon name for a key token, or null (render as text).
 *
 * @example keyIcon("Cmd") // "mdi:apple-keyboard-command"
 * @example keyIcon("C") // null
 */
export function keyIcon(token) {
  return KEY_ICONS[token] ?? null;
}

/** Mouse tokens → icons (shared by KeyCombo/HintBar consumers). */
export const MOUSE_ICONS = {
  mouse_left: "mdi:mouse-left-click-outline",
  mouse_right: "mdi:mouse-right-click-outline",
  mouse_middle: "mdi:mouse",
  mouse_scroll: "mdi:mouse-scroll-wheel",
  mouse: "mdi:mouse-outline",
};

/**
 * Pure function. Is this token a mouse gesture (renders as a mouse icon)?
 *
 * @example isMouseToken("mouse_left") // true
 * @example isMouseToken("Cmd") // false
 */
export function isMouseToken(token) {
  return token in MOUSE_ICONS;
}
