/** DOM pieces of the Look window's sections: the HUD / text look controls with their previews. (The pure part is lookSections.ts.) */
import { openNameplateEditor } from './nameplateEditor';
import { LOOK_OPTIONS, TARGET_ARROWS, TARGET_COLORS, hpFill, hpText, look, plateFill, plateHpText, resetLook, setLook } from './hudLook';
import type { LookOption } from './hudLook';
import { controlColor } from './hudText';
import { UNGROUPED_TITLE, groupsOf, optionsOfSection } from './lookSections';
import type { LookSectionId } from './lookSections';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** One labelled drop-down per option, grouped under headings. Changes are applied and saved at once. */
export function buildOptionGrid(options: readonly LookOption[], onChange: () => void, withGroupInLabel = false): HTMLElement {
  const root = el('div', 'lk-opts');
  for (const g of groupsOf(options)) {
    if (!withGroupInLabel) root.append(el('h4', 'lk-group', g.group || UNGROUPED_TITLE));
    const grid = el('div', 'lk-optgrid');
    for (const o of g.options) {
      const l = el('label', 'lk-opt');
      l.append(el('span', '', withGroupInLabel && o.group ? `${o.group}: ${o.label}` : o.label));
      const sel = el('select');
      sel.setAttribute('aria-label', o.label);
      for (const [v, t] of o.choices) sel.append(new Option(t, v));
      sel.value = look[o.id];
      sel.addEventListener('change', () => {
        setLook(o.id, sel.value);
        onChange();
      });
      l.append(sel);
      grid.append(l);
    }
    root.append(grid);
  }
  return root;
}

const BAR_PX: Record<string, number> = { thin: 5, normal: 9, thick: 13, huge: 18 };
const PLATE_PX: Record<string, number> = { narrow: 70, normal: 96, wide: 124, xwide: 150 };

/** A small ally and enemy nameplate plus the target mark, drawn from the current options. Call `paint` after a change. */
export function buildHudPreview(): { el: HTMLElement; paint: () => void } {
  const box = el('div', 'lk-prev lk-prev-hud');
  const paint = () => {
    box.replaceChildren();
    const mark = el('div', 'lk-tmark');
    if (look.targetArrow !== 'off') {
      mark.textContent = TARGET_ARROWS[look.targetArrow] ?? '▼';
      mark.style.color = look.targetColor === 'auto' ? '#ff6a5a' : TARGET_COLORS[look.targetColor] ?? '#fff';
      mark.style.fontSize = `${{ sm: 14, md: 18, lg: 24, xl: 30 }[look.targetSize] ?? 18}px`;
    }
    const plate = (name: string, enemy: boolean, frac: number, color: string, withMark: boolean) => {
      const p = el('div', 'lk-plate');
      if (look.plates === 'off' || (look.plates === 'enemies' && !enemy) || (look.plates === 'allies' && enemy)) p.classList.add('off');
      const w = PLATE_PX[look.plateWidth] ?? 96;
      const bar = el('div', 'lk-pbar');
      bar.style.width = `${w}px`;
      bar.style.height = `${BAR_PX[look.plateBar] ?? 9}px`;
      const fill = el('i');
      fill.style.width = `${Math.round(frac * 100)}%`;
      fill.style.background = plateFill(enemy, frac, color);
      bar.append(fill);
      const txt = plateHpText(Math.round(frac * 1000), 1000);
      const fs = { sm: 10, md: 12, lg: 14 }[look.plateText] ?? 12;
      if (look.plateName !== 'hide') {
        const n = el('span', 'lk-pname', name);
        n.style.fontSize = `${fs}px`;
        p.append(n);
      }
      if (withMark && look.targetArrow !== 'off') p.prepend(mark.cloneNode(true));
      p.append(bar);
      if (txt) {
        const t = el('small', '', txt);
        t.style.fontSize = `${fs - 1}px`;
        p.append(t);
      }
      return p;
    };
    const frame = el('div', 'lk-pframe');
    const hp = el('div', 'lk-pbar lk-pbar-big');
    hp.style.height = `${(BAR_PX[look.barHeight] ?? 9) + 6}px`;
    const fill = el('i');
    fill.style.width = '72%';
    fill.style.background = hpFill(false, 0.72, '#6aa6ff');
    hp.append(fill);
    const label = hpText(720, 1000);
    frame.append(el('span', 'lk-pname', 'Your frame'), hp);
    if (label) frame.append(el('small', '', label));
    // nameplates have their own editor with a live preview (Edit nameplates below); only your frame is previewed here
    void plate;
    box.append(frame);
  };
  paint();
  return { el: box, paint };
}

/** The error text and stun text, drawn by the same variables as the real ones, on a dark and a light floor. */
export function buildTextPreview(): { el: HTMLElement; paint: () => void } {
  const box = el('div', 'lk-prev lk-prev-text');
  const err = el('span', 'he-prev-err', 'Out of range');
  const cc = el('span', 'he-prev-cc cc-stun', 'STUNNED 2.1s');
  box.append(err, cc);
  const paint = () => {
    cc.style.color = controlColor(look.ccColor, 'stun', look.ccPlate !== 'none');
  };
  paint();
  return { el: box, paint };
}

/** A section made of look options (the HUD one or the text one), with its preview and a reset. */
export function buildLookOptionsSection(id: Extract<LookSectionId, 'hud' | 'effects'>, rerender: () => void): HTMLElement {
  const root = el('div', 'lk-sec');
  const preview = id === 'hud' ? buildHudPreview() : buildTextPreview();
  root.append(preview.el);
  if (id === 'hud') {
    // nameplates: separate looks for you, allies and enemies, dragged to size in a live editor (nameplateEditor.ts)
    const plates = el('div', 'lk-plates');
    const btn = el('button', 'mm-small mm-go', 'Edit nameplates…');
    btn.title = 'Size, place and style the nameplates: separate looks for you, allies and enemies, with the anchor at the head or the feet';
    btn.addEventListener('click', () => openNameplateEditor({ onClose: rerender }));
    plates.append(el('h4', 'lk-group', 'Nameplates'), el('p', 'mm-modal-foot', 'Your own, ally and enemy nameplates each have their own look. Open the editor to drag and resize the name, health bar and debuffs, snap them to each other, and anchor the plate at the head or the feet.'), btn);
    root.append(plates);
  }
  // the old single-profile nameplate dropdowns are replaced by that editor
  root.append(buildOptionGrid(optionsOfSection(id, LOOK_OPTIONS).filter((o) => o.group !== 'Nameplates'), preview.paint));
  const bottom = el('div', 'lk-secfoot');
  const reset = el('button', 'mm-small', 'Reset all HUD looks to default');
  reset.title = 'Puts every bar, nameplate, target mark and text option back to its default (the layout is not touched)';
  reset.addEventListener('click', () => {
    resetLook();
    rerender();
  });
  bottom.append(reset);
  root.append(bottom);
  return root;
}

/** The results of a search: the matching HUD options as live controls. */
export function buildOptionResults(options: LookOption[], onChange: () => void): HTMLElement {
  return buildOptionGrid(options, onChange, true);
}
