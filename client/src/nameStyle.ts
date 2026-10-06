/** Name colouring shared by every place a name is drawn: plain colour, glow, or a two-colour gradient. */
export interface NameLook {
  color: string;
  color2?: string;
  glow?: boolean;
}

export function applyName(e: HTMLElement, look: NameLook, base = '', size = 8): void {
  const s = e.style;
  if (look.color2) {
    s.background = `linear-gradient(90deg, ${look.color}, ${look.color2})`;
    s.setProperty('-webkit-background-clip', 'text');
    s.backgroundClip = 'text';
    s.color = 'transparent';
    s.textShadow = '';
    s.filter = look.glow ? `drop-shadow(0 0 ${size}px ${look.color})` : '';
  } else {
    s.background = '';
    s.removeProperty('-webkit-background-clip');
    s.backgroundClip = '';
    s.color = look.color;
    s.filter = '';
    s.textShadow = look.glow ? `0 0 ${size}px ${look.color}${base ? ', ' + base : ''}` : base;
  }
}

/** A small animated icon, or null when there is none. Only same-origin /avatar paths are ever used. */
export function avatarImg(url: string | undefined, cls = 'av-img'): HTMLImageElement | null {
  if (!url || !url.startsWith('/avatar/')) return null;
  const img = document.createElement('img');
  img.className = cls;
  img.src = url;
  img.alt = '';
  img.draggable = false;
  return img;
}

export const avatarUrl = (name: string, v?: number): string | undefined => (v ? `/avatar/${encodeURIComponent(name.toLowerCase())}?v=${v}` : undefined);
