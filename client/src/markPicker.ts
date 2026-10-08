import { MARKS } from '@arena/shared';

/**
 * The raid mark picker: right-click the target frame and pick a mark to put over your target's head for your team
 * (skull, cross, moon...), or clear it. The keys Alt+1 to Alt+8 (rebindable) do the same without the picker.
 */
export class MarkPicker {
  private root: HTMLElement | null = null;

  constructor(private pick: (mark: number) => void, private current: () => number) {
    const frame = document.getElementById('target-frame');
    frame?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.show(e.clientX, e.clientY);
    });
    frame?.setAttribute('title', 'Right-click to mark this target for your team');
    window.addEventListener('mousedown', (e) => {
      if (this.root && !this.root.contains(e.target as Node)) this.hide();
    }, true);
  }

  show(x: number, y: number) {
    this.hide();
    const root = document.createElement('div');
    root.className = 'markpick';
    const now = this.current();
    // skull first, as in the keys (Alt+1 is skull)
    for (const n of [8, 7, 6, 5, 4, 3, 2, 1]) {
      const m = MARKS[n - 1];
      const b = document.createElement('button');
      b.className = `markpick-b${now === n ? ' sel' : ''}`;
      b.textContent = m.icon;
      b.title = `${m.name}${now === n ? ' (click again to clear)' : ''}`;
      b.addEventListener('click', () => {
        this.pick(n);
        this.hide();
      });
      root.append(b);
    }
    const clear = document.createElement('button');
    clear.className = 'markpick-b clear';
    clear.textContent = '✕';
    clear.title = 'Clear the mark';
    clear.addEventListener('click', () => {
      this.pick(0);
      this.hide();
    });
    root.append(clear);
    document.body.append(root);
    const w = root.offsetWidth || 340;
    root.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2))}px`;
    root.style.top = `${Math.min(window.innerHeight - 60, y + 12)}px`;
    this.root = root;
  }

  hide() {
    this.root?.remove();
    this.root = null;
  }
}
