/**
 * Look options for the HUD frames and bars. Every option is a value on a `data-hud-*` attribute of the body; the
 * stylesheet does the drawing, and the two text/colour options below are read by the HUD when it fills a frame.
 * Saved in localStorage next to the layout.
 */

import { textVars } from './hudText';

export interface LookOption {
  id: string;
  label: string;
  choices: [value: string, label: string][];
  /** The heading it sits under in the editor. */
  group?: string;
}

export const LOOK_OPTIONS: LookOption[] = [
  { id: 'bar', label: 'Bar style', choices: [['smooth', 'Smooth'], ['segmented', 'Segmented'], ['striped', 'Striped'], ['flat', 'Flat'], ['chunky', 'Chunky']] },
  { id: 'hpText', label: 'Health text', choices: [['value', 'Value'], ['percent', 'Percent'], ['both', 'Value and percent'], ['none', 'Hidden']] },
  { id: 'hpColor', label: 'Health colour', choices: [['team', 'Ally / enemy colours'], ['class', 'Class colour'], ['health', 'By health left']] },
  { id: 'portrait', label: 'Portrait', choices: [['left', 'Left'], ['right', 'Right'], ['off', 'Hidden']] },
  { id: 'slots', label: 'Ability slots', choices: [['rounded', 'Rounded'], ['square', 'Square'], ['circle', 'Circle']] },
  { id: 'slotSize', label: 'Slot size', choices: [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']] },
  { id: 'keys', label: 'Key labels', choices: [['show', 'Shown'], ['hide', 'Hidden']] },
  { id: 'names', label: 'Ability names', choices: [['show', 'Shown'], ['hide', 'Hidden']] },
  { id: 'cast', label: 'Cast bar', choices: [['classic', 'Classic'], ['slim', 'Slim'], ['large', 'Large']] },
  { id: 'log', label: 'Combat log', choices: [['show', 'Shown'], ['hide', 'Hidden']] },
  { id: 'help', label: 'Help text', choices: [['show', 'Shown'], ['hide', 'Hidden']] },
  { id: 'killfeed', label: 'Kill feed', group: 'Kill feed', choices: [['show', 'Shown'], ['hide', 'Hidden']] },
  { id: 'dpsmeter', label: 'DPS meter', group: 'DPS meter', choices: [['show', 'Shown'], ['hide', 'Hidden']] },
  // health bars on your frames, the target's, party and enemies
  { id: 'barHeight', label: 'Health bar height', group: 'Health bars', choices: [['thin', 'Thin'], ['normal', 'Normal'], ['thick', 'Thick'], ['huge', 'Huge']] },
  { id: 'allyColor', label: 'Ally health colour', group: 'Health bars', choices: [['green', 'Green'], ['blue', 'Blue'], ['teal', 'Teal'], ['gold', 'Gold']] },
  { id: 'enemyColor', label: 'Enemy health colour', group: 'Health bars', choices: [['red', 'Red'], ['orange', 'Orange'], ['purple', 'Purple'], ['pink', 'Pink']] },
  { id: 'hpFont', label: 'Health text size', group: 'Health bars', choices: [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']] },
  // nameplates over heads in the world
  { id: 'plates', label: 'Show nameplates', group: 'Nameplates', choices: [['all', 'Everyone'], ['enemies', 'Enemies only'], ['allies', 'Allies only'], ['off', 'Off']] },
  { id: 'plateWidth', label: 'Nameplate width', group: 'Nameplates', choices: [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide'], ['xwide', 'Extra wide']] },
  { id: 'plateBar', label: 'Nameplate bar height', group: 'Nameplates', choices: [['thin', 'Thin'], ['normal', 'Normal'], ['thick', 'Thick'], ['huge', 'Huge']] },
  { id: 'plateHp', label: 'Nameplate health text', group: 'Nameplates', choices: [['none', 'Hidden'], ['percent', 'Percent'], ['value', 'Value']] },
  { id: 'plateColor', label: 'Nameplate colour', group: 'Nameplates', choices: [['team', 'Ally / enemy colours'], ['class', 'Class colour'], ['health', 'By health left']] },
  { id: 'plateName', label: 'Names on nameplates', group: 'Nameplates', choices: [['show', 'Shown'], ['hide', 'Hidden']] },
  { id: 'plateText', label: 'Nameplate text size', group: 'Nameplates', choices: [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']] },
  { id: 'plateRes', label: 'Mana / energy / rage on nameplates', group: 'Nameplates', choices: [['show', 'Shown'], ['hide', 'Hidden']] },
  { id: 'plateCast', label: 'Cast bars on nameplates', group: 'Nameplates', choices: [['show', 'Shown'], ['hide', 'Hidden']] },
  { id: 'plateDebuffs', label: 'Debuffs on nameplates', group: 'Nameplates', choices: [['show', 'Shown'], ['hide', 'Hidden']] },
  // how your current target is marked: the arrow over its head, the circle under its feet, its health bars
  { id: 'targetArrow', label: 'Arrow over the target', group: 'Target', choices: [['arrow', '▼ Arrow'], ['chevron', '⌄ Chevron'], ['diamond', '◆ Diamond'], ['star', '★ Star'], ['cross', '⌖ Crosshair'], ['off', 'Hidden']] },
  { id: 'targetColor', label: 'Target mark colour', group: 'Target', choices: [['auto', 'Red enemy / green ally'], ['gold', 'Gold'], ['white', 'White'], ['cyan', 'Cyan'], ['magenta', 'Magenta'], ['lime', 'Lime']] },
  { id: 'targetSize', label: 'Target mark size', group: 'Target', choices: [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large'], ['xl', 'Huge']] },
  { id: 'targetAnim', label: 'Target mark movement', group: 'Target', choices: [['bob', 'Bobbing'], ['pulse', 'Pulsing'], ['still', 'Still']] },
  { id: 'targetRing', label: 'Circle under the target', group: 'Target', choices: [['normal', 'Ring'], ['thin', 'Thin ring'], ['thick', 'Thick ring'], ['disc', 'Glowing disc'], ['off', 'Off']] },
  { id: 'targetBars', label: 'Target health bar highlight', group: 'Target', choices: [['glow', 'Glow'], ['bright', 'Bright outline'], ['off', 'Off']] },
  // the error text ("Out of range"...) and the stun / control text ("STUNNED 2.1s"); both also move and resize in the editor
  { id: 'errSize', label: 'Size', group: 'Error text', choices: [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large'], ['xl', 'Huge']] },
  { id: 'errColor', label: 'Colour', group: 'Error text', choices: [['auto', 'Auto (red)'], ['red', 'Red'], ['orange', 'Orange'], ['yellow', 'Yellow'], ['white', 'White'], ['cyan', 'Cyan'], ['magenta', 'Magenta']] },
  { id: 'errBold', label: 'Weight', group: 'Error text', choices: [['bold', 'Bold'], ['normal', 'Normal']] },
  { id: 'errOutline', label: 'Outline and shadow', group: 'Error text', choices: [['off', 'None'], ['soft', 'Soft shadow'], ['strong', 'Strong outline']] },
  { id: 'errPlate', label: 'Background', group: 'Error text', choices: [['none', 'None'], ['pill', 'Dark pill']] },
  { id: 'errTime', label: 'Stays visible', group: 'Error text', choices: [['0.8', '0.8 s'], ['1.2', '1.2 s'], ['1.8', '1.8 s'], ['2.4', '2.4 s'], ['3', '3 s']] },
  { id: 'errAnim', label: 'Appears with', group: 'Error text', choices: [['pop', 'A quick pop'], ['fade', 'Fade only'], ['none', 'Nothing']] },
  { id: 'errRepeat', label: 'Same error again', group: 'Error text', choices: [['hold', 'Ignored for 0.3 s'], ['every', 'Shown every time']] },
  { id: 'ccSize', label: 'Size', group: 'Stun text', choices: [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large'], ['xl', 'Huge']] },
  { id: 'ccColor', label: 'Colour', group: 'Stun text', choices: [['auto', 'Auto (by what holds you)'], ['red', 'Red'], ['orange', 'Orange'], ['yellow', 'Yellow'], ['white', 'White'], ['cyan', 'Cyan'], ['magenta', 'Magenta']] },
  { id: 'ccBold', label: 'Weight', group: 'Stun text', choices: [['bold', 'Bold'], ['normal', 'Normal']] },
  { id: 'ccOutline', label: 'Outline and shadow', group: 'Stun text', choices: [['off', 'None'], ['soft', 'Soft shadow'], ['strong', 'Strong outline']] },
  { id: 'ccPlate', label: 'Background', group: 'Stun text', choices: [['pill', 'Coloured plate'], ['none', 'None']] },
  { id: 'ccAnim', label: 'Movement', group: 'Stun text', choices: [['pulse', 'Pulsing'], ['still', 'Still']] },
  // the network stats readout (Esc menu: Show network stats; always on for devs); it moves and resizes in the editor too
  { id: 'netSize', label: 'Text size', group: 'Network stats', choices: [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']] },
  { id: 'netColor', label: 'Text colour', group: 'Network stats', choices: [['auto', 'Auto (parchment)'], ['white', 'White'], ['yellow', 'Yellow'], ['cyan', 'Cyan'], ['orange', 'Orange'], ['magenta', 'Magenta']] },
  { id: 'netPlate', label: 'Background', group: 'Network stats', choices: [['plate', 'Dark plate'], ['none', 'None']] },
];

const DEFAULTS: Record<string, string> = {
  bar: 'smooth', hpText: 'value', hpColor: 'team', portrait: 'left', slots: 'rounded', slotSize: 'md', keys: 'show', names: 'show', cast: 'classic', log: 'show', help: 'show',
  barHeight: 'normal', allyColor: 'green', enemyColor: 'red', hpFont: 'md',
  targetArrow: 'arrow', targetColor: 'auto', targetSize: 'md', targetAnim: 'bob', targetRing: 'normal', targetBars: 'glow',
  killfeed: 'show', dpsmeter: 'show',
  errSize: 'lg', errColor: 'auto', errBold: 'bold', errOutline: 'strong', errPlate: 'none', errTime: '1.8', errAnim: 'pop', errRepeat: 'hold',
  ccSize: 'lg', ccColor: 'auto', ccBold: 'bold', ccOutline: 'soft', ccPlate: 'pill', ccAnim: 'pulse',
  netSize: 'md', netColor: 'auto', netPlate: 'plate',
  plates: 'all', plateWidth: 'normal', plateBar: 'normal', plateHp: 'none', plateColor: 'team', plateName: 'show', plateText: 'md', plateRes: 'show', plateCast: 'show', plateDebuffs: 'show',
};

/** Fill gradients for the ally and enemy health colours. */
const ALLY: Record<string, string> = { green: 'linear-gradient(#58d37a,#2a8745)', blue: 'linear-gradient(#5aa8ff,#2860b8)', teal: 'linear-gradient(#4fd8c8,#1f8a80)', gold: 'linear-gradient(#ffd25a,#b8861f)' };
const ENEMY: Record<string, string> = { red: 'linear-gradient(#e0523f,#8e271b)', orange: 'linear-gradient(#ff9a3c,#b85a14)', purple: 'linear-gradient(#b67bff,#6a32b8)', pink: 'linear-gradient(#ff6fb4,#b02a6c)' };
const KEY = 'arena.hud.look.v1';

export const look: Record<string, string> = { ...DEFAULTS };

/** The target mark's colours (auto = red for an enemy, green for an ally, chosen where it is drawn). */
export const TARGET_COLORS: Record<string, string> = { gold: '#ffd24a', white: '#ffffff', cyan: '#4fd8ff', magenta: '#ff4fd8', lime: '#8dff3a' };
export const TARGET_ARROWS: Record<string, string> = { arrow: '▼', chevron: '⌄', diamond: '◆', star: '★', cross: '⌖' };

export function applyLook() {
  if (typeof document === 'undefined') return;
  // the plate* options are the old single nameplate profile; plates follow their own profiles now (nameplateLayout.ts)
  for (const o of LOOK_OPTIONS) if (!o.id.startsWith('plate')) document.body.dataset[`hud${o.id.charAt(0).toUpperCase()}${o.id.slice(1)}`] = look[o.id];
  document.body.style.setProperty('--tgt-color', TARGET_COLORS[look.targetColor] ?? '');
  for (const [k, v] of Object.entries(textVars(look))) document.body.style.setProperty(k, v);
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

/** A health fill for a colour mode: team colours (the ally / enemy picks), class colour, or green-to-red by health left. */
export function fillFor(mode: string, enemy: boolean, frac: number, classColor: string): string {
  if (mode === 'class') return `linear-gradient(${classColor}, ${classColor}aa)`;
  if (mode === 'health') {
    const hue = Math.round(Math.max(0, Math.min(1, frac)) * 120);
    return `linear-gradient(hsl(${hue} 70% 52%), hsl(${hue} 70% 32%))`;
  }
  return enemy ? ENEMY[look.enemyColor] ?? ENEMY.red : ALLY[look.allyColor] ?? ALLY.green;
}

/** The fill colour of a health bar, following the Health colour option. */
export function hpFill(enemy: boolean, frac: number, classColor: string): string {
  return fillFor(look.hpColor, enemy, frac, classColor);
}

/** The fill colour of a nameplate's health bar, following the Nameplate colour option. */
export function plateFill(enemy: boolean, frac: number, classColor: string): string {
  return fillFor(look.plateColor, enemy, frac, classColor);
}

/** The text on a nameplate's health bar. */
export function plateHpText(health: number, max: number): string {
  if (look.plateHp === 'percent') return max > 0 ? `${Math.round((health / max) * 100)}%` : '0%';
  if (look.plateHp === 'value') return `${health}`;
  return '';
}

/** Whether to draw a nameplate over a unit. */
export function plateShown(enemy: boolean): boolean {
  return look.plates === 'all' || (look.plates === 'enemies' && enemy) || (look.plates === 'allies' && !enemy);
}
