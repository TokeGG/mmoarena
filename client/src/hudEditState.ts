/**
 * Open / close state of the HUD editor, kept pure so it can be tested. The editor can be opened in a match (Esc menu,
 * Edit HUD) or from the main menu over a pretend fight; however it was opened, closing it must leave nothing behind:
 * the body classes, the game's input and (from the main menu) the menu itself.
 */

export interface HudEditState {
  editing: boolean;
  /** Opened from the main menu, so closing brings the menu back. */
  fromMenu: boolean;
}

export const EDIT_IDLE: HudEditState = { editing: false, fromMenu: false };

/** Classes the editor puts on the body; all of them go when it closes. */
export const EDIT_BODY_CLASSES = ['hud-edit', 'hud-demo'] as const;

export function openEditor(_s: HudEditState, fromMenu: boolean): HudEditState {
  return { editing: true, fromMenu };
}

export interface CloseResult {
  state: HudEditState;
  /** Give the main menu back (only when it was where the editor came from, and no match started meanwhile). */
  restoreMenu: boolean;
}

export function closeEditor(s: HudEditState, matchStarted: boolean): CloseResult {
  return { state: EDIT_IDLE, restoreMenu: s.fromMenu && !matchStarted };
}

/** What the game's input does with the game keys: they are off exactly while the editor is open. */
export const gameInputEnabled = (s: HudEditState): boolean => !s.editing;

/** Whether a key press leaves the editor: Escape always does (a focused drop-down or box included), never auto-repeat. */
export function leavesEditor(s: HudEditState, code: string, repeat = false): boolean {
  return s.editing && code === 'Escape' && !repeat;
}
