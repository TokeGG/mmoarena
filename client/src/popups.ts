/**
 * One place that knows every pop-up window (friends, profile and sign-in, suggestions, watch live, the look picker, the
 * spec card). Escape closes the one on top, wherever the keyboard focus is (a text box, a slider), and nothing else
 * reacts to that press; a match starting closes them all, so nothing is left open over the fight.
 */
export interface Popup {
  isOpen(): boolean;
  close(): void;
  /** The pop-up's element: of two open ones, the one later in the page is drawn on top and closes first. */
  el?(): Element | null;
}

const popups: Popup[] = [];

export function registerPopup(p: Popup): Popup {
  popups.push(p);
  return p;
}

export function anyPopupOpen(): boolean {
  return popups.some((p) => p.isOpen());
}

/** Close the newest open pop-up. Returns whether one was open. */
export function closeTopPopup(): boolean {
  const open = popups.filter((p) => p.isOpen());
  if (!open.length) return false;
  const later = (a: Popup, b: Popup) => {
    const x = a.el?.();
    const y = b.el?.();
    if (!x || !y || x === y) return 0;
    return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1;
  };
  open.sort(later)[0].close();
  return true;
}

export function closeAllPopups(): void {
  for (const p of popups) if (p.isOpen()) p.close();
}

/** Inputs that take typing: keys pressed in them are text, not game commands. Sliders and checkboxes are not. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return true;
  if (target.tagName !== 'INPUT') return false;
  return !['range', 'checkbox', 'radio', 'button', 'color', 'submit'].includes((target as HTMLInputElement).type);
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.code !== 'Escape' || e.repeat) return;
      // a focused slider or checkbox keeps its focus otherwise, and the game's keys would go to it
      if (document.activeElement instanceof HTMLInputElement && !isTyping(document.activeElement)) document.activeElement.blur();
      if (closeTopPopup()) {
        e.preventDefault();
        e.stopImmediatePropagation(); // the press is spent: the settings menu must not open behind the closing window
      }
    },
    true,
  );
}
