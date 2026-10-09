/**
 * The DOM of one nameplate, shared by the game (hud.ts) and the nameplate editor so they can never look different.
 * The owner fills the text, bars and colours; `apply` sizes and places every part from a profile's layout.
 */
import { Bar, el } from './bar';
import { iconEl } from './iconArt';
import { AURA_GAP, layoutPlate, titleSize, type PartId, type PlateContext, type PlateLayout, type PlateProfile, type PartRect } from './nameplateLayout';

const CSS = `
.plate.np.np.np { position:absolute; width:0; height:0; margin:0; padding:0; text-align:center; white-space:nowrap; transform:none; transform-origin:0 0; font-family:var(--serif, serif); }
.plate.np.np.np > * { position:absolute; margin:0; box-sizing:border-box; }
.plate.np .ptop { bottom:auto; transform:none; flex-direction:column; align-items:center; justify-content:flex-start; }
.plate.np .picon img { width:100%; height:100%; }
.plate.np .picon { margin:0; }
.plate.np .pdebuffs { display:flex; flex-wrap:wrap; justify-content:center; align-content:flex-start; min-height:0; }
.plate.np .pdebuff { flex:none; box-sizing:border-box; display:flex; align-items:center; justify-content:center; margin:0; }
.plate.np .pdebuff.good { border-color:#3fa34d; box-shadow:0 0 4px rgba(63,163,77,.6); }
.plate.np .pdebuff b { position:absolute; left:1px; top:0; font:700 9px/9px system-ui; color:#ffe9a0; text-shadow:0 0 2px #000, 0 0 2px #000; }
.plate.np .bar { border-radius:2px; }
.plate.np .pcast { margin:0; }
.plate.np.tg-off.targeted .bar { box-shadow:none !important; outline:none !important; filter:none !important; }
.plate.np.tg-glow.targeted .bar { box-shadow:0 0 0 1px #fff3, 0 0 9px 1px var(--tgt-color, #ffd24a) !important; filter:brightness(1.18) !important; outline:none !important; }
.plate.np.tg-bright.targeted .bar { outline:2px solid var(--tgt-color, #ffd24a) !important; outline-offset:1px; filter:brightness(1.25) saturate(1.2) !important; box-shadow:none !important; }
`;

let styled = false;
export function ensurePlateStyles(): void {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const s = document.createElement('style');
  s.id = 'plate-np-styles';
  s.textContent = CSS;
  document.head.append(s);
}

/** One effect icon of the buff row. */
export interface AuraIcon {
  id: string;
  harmful: boolean;
  /** Seconds left, or -1 for none. */
  secs: number;
  stacks: number;
  /** Shown as the tooltip. */
  title?: string;
  /** Not a real effect: a marker only the owner and devs see (a bot on an experimental brain). Drawn as a glyph with a tooltip key. */
  pseudo?: { glyph: string; tip: string };
}

const WEIGHT = { normal: '400', bold: '700', heavy: '900' } as const;

export class PlateView {
  readonly root = el('div', 'plate np');
  readonly marks = el('div', 'ptop');
  readonly mark = el('div', 'pmark hidden');
  readonly arrow = el('div', 'parrow hidden', '▼');
  readonly icon = el('div', 'picon');
  readonly name = el('div', 'pname');
  readonly title = el('div', 'ptitle');
  readonly bar = new Bar('#3fbf5f', true);
  readonly res = new Bar('#3b82f6', true);
  readonly cast = new Bar('linear-gradient(#ffd966,#d9962a)', true);
  readonly auras = el('div', 'pdebuffs');
  private lastKey = '';
  private lastProfile: PlateProfile | null = null;
  private auraKey = '';
  /** The layout the last `apply` used. */
  layout: PlateLayout | null = null;
  /** The shadow under the name text for applyName() (the outline option). */
  nameBase = '0 1px 2px #000';

  constructor() {
    ensurePlateStyles();
    this.res.root.classList.add('pres');
    this.cast.root.classList.add('pcast', 'hidden');
    this.marks.append(this.mark, this.arrow);
    // later is drawn over earlier: the name (which may sit over the bar) and the marks are on top
    this.root.append(this.bar.root, this.res.root, this.cast.root, this.auras, this.icon, this.title, this.name, this.marks);
  }

  private el(id: PartId): HTMLElement {
    switch (id) {
      case 'marks': return this.marks;
      case 'icon': return this.icon;
      case 'name': return this.name;
      case 'title': return this.title;
      case 'bar': return this.bar.root;
      case 'res': return this.res.root;
      case 'cast': return this.cast.root;
      case 'auras': return this.auras;
    }
  }

  private static box(e: HTMLElement, r: PartRect): void {
    const s = e.style;
    s.display = r.visible ? '' : 'none';
    s.left = `${r.x}px`;
    s.top = `${r.y}px`;
    s.width = `${r.w}px`;
    s.height = `${r.h}px`;
  }

  /** Size and place every part. Cheap to call every frame: nothing is written while the profile and what is on the plate stay the same. */
  apply(p: PlateProfile, c: PlateContext): PlateLayout {
    const key = `${c.hasMark}|${c.hasArrow}|${c.hasAvatar}|${c.hasTitle}|${c.hasRes}|${c.hasCast}|${c.auraCount}`;
    if (this.layout && this.lastProfile === p && this.lastKey === key) return this.layout;
    this.lastProfile = p;
    this.lastKey = key;
    const lay = layoutPlate(p, c);
    this.layout = lay;
    const sh = p.scaleH;
    for (const id of ['marks', 'icon', 'name', 'title', 'bar', 'res', 'cast', 'auras'] as PartId[]) PlateView.box(this.el(id), lay.parts[id]);
    // name and title
    const ns = this.name.style;
    ns.fontSize = `${p.name.size * sh}px`;
    ns.lineHeight = `${lay.parts.name.h}px`;
    ns.fontWeight = WEIGHT[p.name.weight];
    ns.setProperty('-webkit-text-stroke', p.name.outline === 'strong' ? `${Math.max(2, 3 * sh)}px #000` : '');
    ns.setProperty('paint-order', p.name.outline === 'strong' ? 'stroke fill' : '');
    this.nameBase = p.name.outline === 'none' ? '' : p.name.outline === 'strong' ? '0 0 3px #000' : '0 1px 2px #000';
    const ts = this.title.style;
    ts.fontSize = `${titleSize(p) * sh}px`;
    ts.lineHeight = `${lay.parts.title.h}px`;
    ts.setProperty('-webkit-text-stroke', p.name.outline === 'strong' ? `${Math.max(1.5, 2 * sh)}px #000` : '');
    ts.setProperty('paint-order', p.name.outline === 'strong' ? 'stroke fill' : '');
    // bars
    const bw = p.bar.border === 'none' ? 0 : p.bar.border === 'thin' ? 1 : 2;
    const bs = this.bar.root.style;
    bs.border = bw ? `${bw}px solid #000` : '0';
    const label = this.bar.root.querySelector<HTMLElement>('.blabel');
    if (label) {
      label.style.fontSize = `${p.bar.textSize * sh}px`;
      label.style.lineHeight = `${Math.max(0, lay.parts.bar.h - bw * 2)}px`;
      label.style.fontWeight = '700';
      label.style.display = p.bar.text === 'none' ? 'none' : '';
    }
    const cl = this.cast.root.querySelector<HTMLElement>('.blabel');
    this.cast.root.style.border = '1px solid #000';
    if (cl) {
      cl.style.fontSize = `${Math.max(6, Math.round(p.cast.h * 0.8)) * sh}px`;
      cl.style.lineHeight = `${Math.max(0, lay.parts.cast.h - 2)}px`;
      cl.style.fontWeight = '700';
    }
    // marks
    this.mark.style.fontSize = `${26 * sh}px`;
    this.arrow.style.fontSize = `${20 * sh}px`;
    this.auras.style.gap = `${AURA_GAP * sh}px`;
    // target highlight: the profile decides, whatever the global look says
    this.root.classList.remove('tg-glow', 'tg-bright', 'tg-off');
    this.root.classList.add(`tg-${p.target.glow}`);
    this.auraKey = ''; // the icons follow the new sizes
    return lay;
  }

  /** The buff row's icons (rebuilt only when the set, a seconds counter, a stack count or the profile changes). */
  setAuras(items: AuraIcon[], p: PlateProfile): void {
    const key = `${p.auras.size}|${p.scaleH}|${p.auras.duration}|${p.auras.stacks}|${items.map((a) => `${a.id}:${a.secs}:${a.stacks}:${a.pseudo ? 1 : 0}`).join()}`;
    if (key === this.auraKey) return;
    this.auraKey = key;
    const s = p.auras.size * p.scaleH;
    this.auras.replaceChildren(
      ...items.map((a) => {
        const ic = el('div', `pdebuff${a.harmful ? '' : ' good'}${a.pseudo ? ' bottest' : ''}`);
        if (a.pseudo) {
          ic.append(el('span', '', a.pseudo.glyph));
          ic.dataset.tip = a.pseudo.tip;
        } else ic.append(iconEl('aura', a.id));
        const st = ic.style;
        st.width = st.height = `${s}px`;
        st.fontSize = `${Math.round(s * 0.62)}px`;
        st.lineHeight = `${s - 2}px`;
        if (a.title) ic.title = a.title;
        if (p.auras.duration && a.secs >= 0) {
          const t = el('i', '', String(a.secs));
          t.style.fontSize = `${Math.max(6, Math.round(s * 0.45))}px`;
          t.style.lineHeight = t.style.fontSize;
          ic.append(t);
        }
        if (p.auras.stacks && a.stacks > 1) {
          const b = el('b', '', String(a.stacks));
          b.style.fontSize = `${Math.max(7, Math.round(s * 0.5))}px`;
          b.style.lineHeight = b.style.fontSize;
          ic.append(b);
        }
        return ic;
      }),
    );
  }

  /** Place the plate: its anchor point on the screen, size factor (distance), opacity (fade) and stacking order. */
  position(x: number, y: number, scale: number, alpha: number, z: number): void {
    const s = this.root.style;
    s.left = `${x}px`;
    s.top = `${y}px`;
    s.transform = scale === 1 ? '' : `scale(${scale})`;
    s.opacity = alpha >= 1 ? '' : String(alpha);
    s.zIndex = String(z);
  }
}
