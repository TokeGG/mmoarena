/**
 * How each HUD element looks: its own background, border, corners, opacity, text colour and shadow, plus a few options that only make
 * sense for one element (the party's layout, the Ready / Leave button style...). Saved on this device; shown in the element's popup in
 * Edit HUD. Everything is "default" until changed, and "Reset style" in the popup puts one element back.
 */
export interface SkinOption { id: string; label: string; choices: [string, string][] }

const COLORS: [string, string][] = [['default', 'Default'], ['#ffd24a', 'Gold'], ['#ff5b5b', 'Red'], ['#58d37a', 'Green'], ['#5aa8ff', 'Blue'], ['#b67bff', 'Purple'], ['#ffffff', 'White'], ['#000000', 'Black'], ['#8a93a6', 'Grey']];

/** What every element can change. */
export const SKIN_OPTIONS: SkinOption[] = [
  { id: 'show', label: 'Shown', choices: [['default', 'Yes'], ['hide', 'Hidden']] },
  { id: 'opacity', label: 'Opacity', choices: [['default', '100%'], ['90', '90%'], ['80', '80%'], ['70', '70%'], ['60', '60%'], ['50', '50%'], ['40', '40%'], ['30', '30%']] },
  { id: 'bg', label: 'Background', choices: [['default', 'Default'], ['none', 'None'], ['glass', 'Glass'], ['dark', 'Dark'], ['solid', 'Solid']] },
  { id: 'bgColor', label: 'Background colour', choices: COLORS },
  { id: 'border', label: 'Border', choices: [['default', 'Default'], ['none', 'None'], ['thin', 'Thin'], ['thick', 'Thick']] },
  { id: 'borderColor', label: 'Border colour', choices: COLORS },
  { id: 'radius', label: 'Corners', choices: [['default', 'Default'], ['square', 'Square'], ['rounded', 'Rounded'], ['pill', 'Pill']] },
  { id: 'textColor', label: 'Text colour', choices: COLORS },
  { id: 'shadow', label: 'Shadow', choices: [['default', 'Default'], ['none', 'None'], ['soft', 'Soft'], ['strong', 'Strong'], ['glow', 'Gold glow']] },
];

const PORTRAIT: SkinOption = { id: 'portrait', label: 'Portrait', choices: [['default', 'Shown'], ['hide', 'Hidden']] };
const LAYOUT: SkinOption = { id: 'layout', label: 'Layout', choices: [['default', 'One column'], ['row', 'One row'], ['grid', 'Two columns']] };

/** Options only some elements have. */
export const SKIN_EXTRA: Record<string, SkinOption[]> = {
  party: [LAYOUT, PORTRAIT],
  enemies: [LAYOUT, PORTRAIT],
  'self-frame': [PORTRAIT],
  'target-frame': [PORTRAIT],
  actionbar: [{ id: 'gap', label: 'Space between buttons', choices: [['default', 'Normal'], ['none', 'None'], ['tight', 'Tight'], ['wide', 'Wide'], ['huge', 'Very wide']] }],
  endchoice: [
    { id: 'btn', label: 'Button style', choices: [['default', 'Solid'], ['outline', 'Outline'], ['pill', 'Pill'], ['square', 'Square'], ['ghost', 'Text only']] },
    { id: 'btnsize', label: 'Button size', choices: [['default', 'Large'], ['md', 'Medium'], ['sm', 'Small']] },
    { id: 'stack', label: 'Buttons', choices: [['default', 'Side by side'], ['column', 'Stacked']] },
  ],
  log: [{ id: 'lines', label: 'Look', choices: [['default', 'Default'], ['compact', 'Compact'], ['spaced', 'Spaced out']] }],
  killfeed: [{ id: 'lines', label: 'Look', choices: [['default', 'Default'], ['compact', 'Compact'], ['spaced', 'Spaced out']] }],
};

export const optionsFor = (id: string): SkinOption[] => [...SKIN_OPTIONS, ...(SKIN_EXTRA[id] ?? [])];

const KEY = 'arena.hud.skin.v1';
export const skin: Record<string, Record<string, string>> = {};

const valid = (id: string, opt: string, v: string): boolean => optionsFor(id).find((o) => o.id === opt)?.choices.some(([c]) => c === v) ?? false;

export function loadSkin(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Record<string, unknown>>;
    for (const [id, opts] of Object.entries(raw)) {
      if (!opts || typeof opts !== 'object') continue;
      for (const [o, v] of Object.entries(opts)) if (typeof v === 'string' && valid(id, o, v) && v !== 'default') (skin[id] ??= {})[o] = v;
    }
  } catch {
    /* defaults */
  }
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(skin));
  } catch {
    /* ignore */
  }
}

export const skinValue = (id: string, opt: string): string => skin[id]?.[opt] ?? 'default';

export function setSkin(id: string, opt: string, value: string): void {
  if (!valid(id, opt, value)) return;
  if (value === 'default') {
    if (skin[id]) delete skin[id][opt];
    if (skin[id] && !Object.keys(skin[id]).length) delete skin[id];
  } else (skin[id] ??= {})[opt] = value;
  save();
}

export function resetSkin(id: string): void {
  delete skin[id];
  save();
}

export const skinChanged = (id: string): boolean => !!skin[id] && Object.keys(skin[id]).length > 0;

const rgba = (hex: string, a: number): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const BG_ALPHA: Record<string, number> = { glass: 0.45, dark: 0.85, solid: 1 };
const BG_BASE: Record<string, string> = { glass: '#141822', dark: '#0a0a0e', solid: '#1b1d24' };
const SHADOW: Record<string, string> = { none: 'none', soft: '0 2px 8px rgba(0,0,0,.5)', strong: '0 4px 18px rgba(0,0,0,.9)', glow: '0 0 14px rgba(255,210,74,.65)' };

/** Put an element's look on it: inline styles for what every element has, and `data-hs-*` for the options a stylesheet turns into layout. */
export function applySkinTo(e: HTMLElement, id: string): void {
  const s = skin[id] ?? {};
  const set = (prop: string, v: string | null) => (v === null ? e.style.removeProperty(prop) : e.style.setProperty(prop, v, 'important'));
  e.classList.toggle('hs-hidden', s.show === 'hide');
  set('opacity', s.opacity ? String(Number(s.opacity) / 100) : null);
  const bgColor = s.bgColor && s.bgColor !== 'default' ? s.bgColor : null;
  if (s.bg === 'none') set('background', 'transparent');
  else if (s.bg || bgColor) {
    const style = s.bg ?? 'solid';
    set('background', rgba(bgColor ?? BG_BASE[style] ?? '#1b1d24', BG_ALPHA[style] ?? 1));
  } else set('background', null);
  e.style.setProperty('backdrop-filter', s.bg === 'glass' ? 'blur(6px)' : '');
  if (s.border === 'none') set('border', '0');
  else if (s.border || s.borderColor) set('border', `${s.border === 'thick' ? 3 : 1}px solid ${s.borderColor ?? '#c9a24a'}`);
  else set('border', null);
  set('border-radius', s.radius ? ({ square: '0', rounded: '10px', pill: '999px' } as Record<string, string>)[s.radius] : null);
  set('color', s.textColor ?? null);
  set('box-shadow', s.shadow ? SHADOW[s.shadow] : null);
  for (const o of optionsFor(id)) {
    if (o.id === 'show' || SKIN_OPTIONS.some((x) => x.id === o.id)) continue;
    if (s[o.id]) e.setAttribute(`data-hs-${o.id}`, s[o.id]);
    else e.removeAttribute(`data-hs-${o.id}`);
  }
  if (s.textColor) e.setAttribute('data-hs-textcolor', '1');
  else e.removeAttribute('data-hs-textcolor');
}
