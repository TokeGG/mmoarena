/**
 * A grab corner for a window: drag it to change the window's width and height, double-click it to go back to the
 * default size. The size is remembered in this browser. `corner` is the corner the grip sits in: bottom-right for a
 * window anchored on the left (it grows to the right), bottom-left for one anchored on the right (it grows to the left).
 */
export interface ResizeOptions {
  key: string;
  corner?: 'br' | 'bl';
  minW?: number;
  minH?: number;
  /** Stacking order of the grip: just above the window. */
  z?: number;
}

/** Every grip and its window: the grips float in the page (a scrolling window would carry them away) and follow their window each frame. */
const grips: { grip: HTMLElement; target: HTMLElement; corner: 'br' | 'bl' }[] = [];
function follow() {
  for (const { grip, target, corner } of grips) {
    const r = target.isConnected ? target.getBoundingClientRect() : null;
    const show = !!r && r.width > 0 && r.height > 0;
    grip.style.display = show ? '' : 'none';
    if (!show) continue;
    grip.style.top = `${r!.bottom - 16}px`;
    grip.style.left = `${corner === 'br' ? r!.right - 16 : r!.left}px`;
  }
  requestAnimationFrame(follow);
}

export function makeResizable(target: HTMLElement, opts: ResizeOptions): void {
  const corner = opts.corner ?? 'br';
  const minW = opts.minW ?? 200;
  const minH = opts.minH ?? 120;
  const storeKey = `arena.size.${opts.key}`;
  const grip = document.createElement('div');
  grip.className = `rs-grip ${corner}`;
  grip.title = 'Drag to resize · double-click for the default size';
  grip.style.zIndex = String(opts.z ?? 50);

  const apply = (w: number | null, h: number | null) => {
    target.style.width = w ? `${w}px` : '';
    target.style.height = h ? `${h}px` : '';
    // a window sized by hand is not capped by its default max height any more
    target.style.maxHeight = h ? 'none' : '';
    target.style.maxWidth = w ? 'none' : '';
  };
  const fit = (w: number, h: number): [number, number] => [Math.round(Math.max(minW, Math.min(w, window.innerWidth - 16))), Math.round(Math.max(minH, Math.min(h, window.innerHeight - 16)))];
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) ?? 'null') as [number, number] | null;
    if (Array.isArray(saved) && saved.every((n) => Number.isFinite(n))) apply(...fit(saved[0], saved[1]));
  } catch {
    /* default size */
  }

  let drag: { x: number; y: number; w: number; h: number } | null = null;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = target.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('rs-dragging');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) * (corner === 'bl' ? -1 : 1);
    apply(...fit(drag.w + dx, drag.h + (e.clientY - drag.y)));
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    document.body.classList.remove('rs-dragging');
    const r = target.getBoundingClientRect();
    try {
      localStorage.setItem(storeKey, JSON.stringify([Math.round(r.width), Math.round(r.height)]));
    } catch {
      /* not remembered */
    }
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    apply(null, null);
    try {
      localStorage.removeItem(storeKey);
    } catch {
      /* ignore */
    }
  });
  document.body.append(grip);
  grips.push({ grip, target, corner });
  if (grips.length === 1) requestAnimationFrame(follow);
}
