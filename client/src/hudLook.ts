/**
 * Look options for the HUD frames and bars. Every option is a value on a `data-hud-*` attribute of the body; the
 * stylesheet does the drawing, and the two text/colour options below are read by the HUD when it fills a frame.
 * Saved in localStorage next to the layout.
 */

export interface LookOption {
  id: string;
  label: string;
  choices: [value: string, label: string][];
}

export const LOOK_OPTIONS: LookOption[] = [
  { id: 'bar', label: 'Bar style', choices: [['smooth', 'Smooth'], ['segmented', 'Segmented'], ['striped', 'Striped'], ['flat', 'Flat'], ['chunky', 'Chunky']] },
  { id: 'hpText', label: 'Health text', choices: [['value', 'Value'], ['percent', 'Percent'], ['both', 'Value and percent'], ['none', 'Hidden']] },
  { id: 'hpColor', label: 'Health colour', choices: [['team', 'Green and red'], ['class', 'Class colour'], ['health', 'By health left']] },
  { id: 'portrait', label: 'Portrait', choices: [['left', 'Left'], ['right', 'Right'], ['off', 'Hidden']] },
  { id: 'slots', label: 'Ability slots', choices: [['rounded', 'Rounded'], ['square', 'Square'], ['circle', 'Circle']] },
  { id: 'slotSize', label: 'Slot size', choices: [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']] },
  { id: 'keys', label: 'Key labels', choices: [['show', 'Shown'], ['hide', 'Hidden']] },
  { id: 'names', label: 'Ability names', choices: [['show', 'Shown'], ['hide', 'Hidden']] },
  { id: 'cast', label: 'Cast bar', choices: [['classic', 'Classic'], ['slim', 'Slim'], ['large', 'Large']] },
  { id: 'log', label: 'Combat log', choices: [['show', 'Shown'], ['hide', 'Hidden']] },
  { id: 'help', label: 'Help text', choices: [['show', 'Shown'], ['hide', 'Hidden']] },
];

const DEFAULTS: Record<string, string> = {
  bar: 'smooth', hpText: 'value', hpColor: 'team', portrait: 'left', slots: 'rounded', slotSize: 'md', keys: 'show', names: 'show', cast: 'classic', log: 'show', help: 'show',
};
const KEY = 'arena.hud.look.v1';

export const look: Record<string, string> = { ...DEFAULTS };

export function applyLook() {
  if (typeof document === 'undefined') return;
  for (const o of LOOK_OPTIONS) document.body.dataset[`hud${o.id.charAt(0).toUpperCase()}${o.id.slice(1)}`] = look[o.id];
}

export function loadLook() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    for (const o of LOOK_OPTIONS) if (typeof raw[o.id] === 'string' && o.choices.some(([v]) => v === raw[o.id])) look[o.id] = raw[o.id] as string;
  } catch {
    /* defaults */
  }
  applyLook();
}

export function setLook(id: string, value: string) {
  const o = LOOK_OPTIONS.find((x) => x.id === id);
  if (!o || !o.choices.some(([v]) => v === value)) return;
  look[id] = value;
  applyLook();
  try {
    localStorage.setItem(KEY, JSON.stringify(look));
  } catch {
    /* ignore */
  }
}

export function resetLook() {
  for (const o of LOOK_OPTIONS) look[o.id] = DEFAULTS[o.id];
  applyLook();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** The text on a health bar, following the Health text option. */
export function hpText(health: number, max: number, absorb = 0): string {
  const extra = absorb ? ` (+${absorb})` : '';
  const pct = max > 0 ? `${Math.round((health / max) * 100)}%` : '0%';
  switch (look.hpText) {
    case 'percent': return pct + extra;
    case 'both': return `${health} / ${max} · ${pct}${extra}`;
    case 'none': return '';
    default: return `${health} / ${max}${extra}`;
  }
}

/** The fill colour of a health bar, following the Health colour option. */
export function hpFill(enemy: boolean, frac: number, classColor: string): string {
  if (look.hpColor === 'class') return `linear-gradient(${classColor}, ${classColor}aa)`;
  if (look.hpColor === 'health') {
    const hue = Math.round(Math.max(0, Math.min(1, frac)) * 120);
    return `linear-gradient(hsl(${hue} 70% 52%), hsl(${hue} 70% 32%))`;
  }
  return enemy ? 'linear-gradient(#e0523f,#8e271b)' : 'linear-gradient(#58d37a,#2a8745)';
}
