function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const SVG = {
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  friends: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.8"/><path d="M17 14a5.5 5.5 0 0 1 4.5 6"/>',
  patches: '<path d="M6 3h11a3 3 0 0 1 0 6H9"/><path d="M6 3a3 3 0 0 0 0 6v9a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3V9"/>',
  watch: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
  suggest: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  admin: '<path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
} as const;

export type HeaderIcon = keyof typeof SVG;

export interface HeaderItem {
  icon: HeaderIcon;
  label: string;
  onClick(): void;
  /** An element (such as a count bubble) drawn on the corner of the button. */
  badge?: HTMLElement;
}

/** The round icon buttons along the top of the main menu: profile, friends, patch notes, watch live, suggestions. */
export function buildHeaderBar(items: HeaderItem[]): { root: HTMLElement; buttons: Record<string, HTMLButtonElement> } {
  const root = el('div', 'hdr-icons');
  const buttons: Record<string, HTMLButtonElement> = {};
  for (const it of items) {
    const b = el('button', 'hdr-btn');
    b.type = 'button';
    b.title = it.label;
    b.setAttribute('aria-label', it.label);
    b.dataset.icon = it.icon;
    b.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${SVG[it.icon]}</svg>`;
    if (it.badge) b.append(it.badge);
    b.addEventListener('click', it.onClick);
    root.append(b);
    buttons[it.icon] = b;
  }
  return { root, buttons };
}
