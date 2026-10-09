/** A health / resource / cast bar: a fill, a shield segment and a label. Styled by the `.bar` rules of the page. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export class Bar {
  readonly root: HTMLElement;
  private fill = el('div', 'fill');
  private label = el('div', 'blabel');
  private shield = el('div', 'shield');
  constructor(color: string, thin = false) {
    this.root = el('div', thin ? 'bar thin' : 'bar');
    this.root.append(this.fill, this.shield, this.label);
    this.fill.style.background = color;
  }
  setColor(c: string) {
    if (this.fill.dataset.c !== c) {
      this.fill.dataset.c = c;
      this.fill.style.background = c;
    }
  }
  /** `absorb` draws a pale segment after the health (pushed back from the right edge when it would overflow). */
  set(v: number, max: number, text: string, absorb = 0) {
    const hp = max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0;
    this.fill.style.width = `${hp}%`;
    const w = max > 0 ? Math.min(100, (absorb / max) * 100) : 0;
    this.shield.style.display = w > 0 ? 'block' : 'none'; // 'block', not '': the stylesheet hides it by default
    this.shield.style.width = `${w}%`;
    this.shield.style.left = `${Math.min(hp, 100 - w)}%`;
    this.label.textContent = text;
  }
}
