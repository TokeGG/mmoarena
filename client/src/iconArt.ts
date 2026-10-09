import { iconIdFor, iconTitle, iconUrl } from '@arena/shared';
import type { IconKind } from '@arena/shared';
import { ABILITY_ICON, AURA_ICON } from './icons';

/**
 * The art of a skill or buff: its picture from the icon library (shared/data/icons.json), or the emoji of icons.ts when it has
 * none or the picture cannot be loaded (a private pack the server does not have). Every place that draws a skill or buff icon
 * calls `iconEl`; when a dev changes an icon, `refreshIcons` redraws every one on the page without a reload.
 */

/** Icons a dev picked in the Icon edit page and has not sent yet: shown at once, over the saved ones. Keyed "ability:fireball". */
const preview = new Map<string, string>();

export const emojiFor = (kind: IconKind, id: string): string => (kind === 'ability' ? ABILITY_ICON[id] : AURA_ICON[id]) ?? '✦';

/** The icon id a skill or buff wears on screen now (a dev's unsent pick first), or null for the emoji. */
export function shownIconId(kind: IconKind, id: string): string | null {
  const p = preview.get(`${kind}:${id}`);
  if (p !== undefined) return p || null;
  return iconIdFor(kind, id);
}

/** Replace the unsent picks (the Icon edit page's typed and put-back icons); redraws every icon when they changed. */
export function setIconPreview(next: Map<string, string>): void {
  let same = next.size === preview.size;
  if (same) for (const [k, v] of next) if (preview.get(k) !== v) same = false;
  if (same) return;
  preview.clear();
  for (const [k, v] of next) preview.set(k, v);
  refreshIcons();
}

function fill(node: HTMLElement, kind: IconKind, id: string): void {
  node.dataset.ic = `${kind}:${id}`;
}

/** One icon element: an <img> of the library picture, or a span with the emoji. `cls` is added to it. */
export function iconEl(kind: IconKind, id: string, cls = '', lazy = false, title = ''): HTMLElement {
  const icon = shownIconId(kind, id);
  let node: HTMLElement;
  if (icon) {
    const img = document.createElement('img');
    img.className = `ic ${cls}`.trim();
    img.src = iconUrl(icon);
    img.alt = title;
    img.draggable = false;
    if (lazy) img.loading = 'lazy';
    img.decoding = 'async';
    // a picture that cannot be loaded (a private pack the server does not have) becomes the emoji
    img.addEventListener('error', () => {
      if (!img.isConnected) return;
      const span = document.createElement('span');
      span.className = `ic-emoji ${cls}`.trim();
      span.textContent = emojiFor(kind, id);
      fill(span, kind, id);
      span.dataset.failed = icon;
      img.replaceWith(span);
    });
    node = img;
  } else {
    node = document.createElement('span');
    node.className = `ic-emoji ${cls}`.trim();
    node.textContent = emojiFor(kind, id);
  }
  if (title) node.title = title;
  fill(node, kind, id);
  return node;
}

/** Redraw every icon under `root`: a changed pick swaps the picture; a picture that failed to load is tried again only when its icon changed. */
export function refreshIcons(root?: ParentNode): void {
  if (!root && typeof document === 'undefined') return;
  root ??= document;
  for (const node of root.querySelectorAll<HTMLElement>('[data-ic]')) {
    const [kind, ...rest] = (node.dataset.ic ?? '').split(':');
    const id = rest.join(':');
    if (kind !== 'ability' && kind !== 'aura') continue;
    const icon = shownIconId(kind, id);
    if (node instanceof HTMLImageElement) {
      if (!icon) node.replaceWith(iconEl(kind, id, node.className.replace(/\bic\b/, '').trim(), node.loading === 'lazy', node.title));
      else if (node.getAttribute('src') !== iconUrl(icon)) node.src = iconUrl(icon);
    } else if (icon && node.dataset.failed !== icon) {
      node.replaceWith(iconEl(kind, id, node.className.replace(/\bic-emoji\b/, '').trim(), false, node.title));
    } else if (!icon) node.textContent = emojiFor(kind, id);
  }
}

/** The plain-words name of what a skill or buff wears now ("Fire mage set: Fire mage 3"), for tooltips of the editor. */
export const shownIconTitle = (kind: IconKind, id: string): string => {
  const i = shownIconId(kind, id);
  return i ? iconTitle(i) : 'the emoji';
};
