/**
 * Rebindable keyboard actions. Each action has two slots (primary, secondary), saved in localStorage.
 * A binding is a key code ("Digit1") or a combo with modifiers ("Shift+Digit1", "Ctrl+Alt+KeyQ"; modifiers are always
 * written Ctrl, Alt, Shift in that order). A plain binding still fires with a modifier held when no combo is bound for it.
 */

export type Action =
  | 'jump' | 'forward' | 'back' | 'turnLeft' | 'turnRight' | 'strafeLeft' | 'strafeRight'
  | 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'slot5' | 'slot6' | 'slot7' | 'slot8'
  | 'nextTarget' | 'prevTarget' | 'autoAttack' | 'detail';

export const ACTIONS: { id: Action; label: string; group: string }[] = [
  { id: 'forward', label: 'Move forward', group: 'Movement' },
  { id: 'back', label: 'Move backward', group: 'Movement' },
  { id: 'turnLeft', label: 'Turn left (strafe while steering)', group: 'Movement' },
  { id: 'turnRight', label: 'Turn right (strafe while steering)', group: 'Movement' },
  { id: 'strafeLeft', label: 'Strafe left', group: 'Movement' },
  { id: 'strafeRight', label: 'Strafe right', group: 'Movement' },
  { id: 'jump', label: 'Jump', group: 'Movement' },
  { id: 'slot1', label: 'Ability 1', group: 'Abilities' },
  { id: 'slot2', label: 'Ability 2', group: 'Abilities' },
  { id: 'slot3', label: 'Ability 3', group: 'Abilities' },
  { id: 'slot4', label: 'Ability 4', group: 'Abilities' },
  { id: 'slot5', label: 'Ability 5', group: 'Abilities' },
  { id: 'slot6', label: 'Ability 6', group: 'Abilities' },
  { id: 'slot7', label: 'Ability 7', group: 'Abilities' },
  { id: 'slot8', label: 'Ability 8', group: 'Abilities' },
  { id: 'nextTarget', label: 'Next enemy', group: 'Targeting' },
  { id: 'prevTarget', label: 'Previous enemy', group: 'Targeting' },
  { id: 'autoAttack', label: 'Toggle auto-attack', group: 'Targeting' },
  { id: 'detail', label: 'Detailed tooltips (hold while hovering)', group: 'Interface' },
];

export const SLOT_ACTIONS: Action[] = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8'];

/** Escape always opens the menu and can never be bound, so a bad binding can't lock you out. */
export const RESERVED = ['Escape'];

const DEFAULTS: Record<Action, [string, string]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  turnLeft: ['KeyA', 'ArrowLeft'],
  turnRight: ['KeyD', 'ArrowRight'],
  strafeLeft: ['KeyQ', ''],
  strafeRight: ['KeyE', ''],
  jump: ['Space', ''],
  slot1: ['Digit1', ''],
  slot2: ['Digit2', ''],
  slot3: ['Digit3', ''],
  slot4: ['Digit4', ''],
  slot5: ['Digit5', ''],
  slot6: ['Digit6', ''],
  slot7: ['Digit7', ''],
  slot8: ['Digit8', ''],
  nextTarget: ['Tab', ''],
  prevTarget: ['', ''],
  autoAttack: ['KeyR', ''],
  detail: ['AltLeft', 'AltRight'],
};

const STORE = 'arena.keybinds.v1';

const MOD_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);
export const isModifierCode = (code: string) => MOD_CODES.has(code);
const MODS = ['Ctrl', 'Alt', 'Shift'] as const;
const MOD_KEYS: Record<(typeof MODS)[number], [string, string]> = { Ctrl: ['ControlLeft', 'ControlRight'], Alt: ['AltLeft', 'AltRight'], Shift: ['ShiftLeft', 'ShiftRight'] };

export interface KeyEventLike { code: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean }

/** The binding string for a key press: modifiers held plus the key, or just the code when the key is itself a modifier. */
export function comboOf(e: KeyEventLike): string {
  if (isModifierCode(e.code)) return e.code;
  return [e.ctrlKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(Boolean).concat(e.code).join('+');
}

export function splitCombo(combo: string): { mods: (typeof MODS)[number][]; code: string } {
  const parts = combo.split('+');
  const code = parts.pop() ?? '';
  return { mods: parts.filter((m): m is (typeof MODS)[number] => (MODS as readonly string[]).includes(m)), code };
}

const VALID = /^((Ctrl|Alt|Shift)\+){0,3}[A-Za-z0-9]+$/;


export function keyLabel(combo: string): string {
  if (!combo) return '—';
  if (combo.includes('+') && combo.length > 1) {
    const { mods, code } = splitCombo(combo);
    return [...mods, keyLabel(code)].join('+');
  }
  const code = combo;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  const names: Record<string, string> = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Tab: 'Tab',
    ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
    AltLeft: 'L-Alt', AltRight: 'R-Alt', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', CapsLock: 'Caps',
  };
  return names[code] ?? code;
}

export class Keybinds {
  private map: Record<Action, [string, string]>;
  /** Called after any change so the HUD can relabel the action bar. */
  onChange: () => void = () => {};

  constructor() {
    this.map = structuredClone(DEFAULTS);
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Record<Action, unknown>>;
        for (const a of ACTIONS) {
          const v = saved[a.id];
          if (Array.isArray(v) && v.length === 2 && v.every((c) => typeof c === 'string' && (c === '' || (VALID.test(c) && !RESERVED.includes(splitCombo(c).code))))) {
            this.map[a.id] = [v[0], v[1]];
          }
        }
      }
    } catch {
      /* storage unavailable or corrupt: defaults */
    }
  }

  codes(action: Action): string[] {
    return this.map[action].filter(Boolean);
  }

  get(action: Action, slot: 0 | 1): string {
    return this.map[action][slot];
  }

  /** Display text for an action's keys, e.g. "W / ↑". */
  label(action: Action): string {
    const c = this.codes(action);
    return c.length ? c.map(keyLabel).join(' / ') : '—';
  }

  actionFor(code: string): Action | null {
    for (const a of ACTIONS) if (this.map[a.id].includes(code)) return a.id;
    return null;
  }

  /** The action for a key press: an exact combo first (Shift+1), else the plain key (so Shift+Tab still reverses Tab). */
  actionForEvent(e: KeyEventLike): Action | null {
    const exact = this.actionFor(comboOf(e));
    if (exact) return exact;
    return comboOf(e) !== e.code && !isModifierCode(e.code) ? this.actionFor(e.code) : null;
  }

  /** True when the press matches one of the action's bindings (used for instant actions such as jump). */
  matches(action: Action, e: KeyEventLike): boolean {
    return this.actionForEvent(e) === action;
  }

  /** True while the action's key is held. Plain bindings ignore modifiers (Shift+W still runs); combos need theirs held. */
  isHeld(action: Action, held: ReadonlySet<string>): boolean {
    for (const c of this.codes(action)) {
      const { mods, code } = splitCombo(c);
      if (!held.has(code)) continue;
      if (mods.every((m) => held.has(MOD_KEYS[m][0]) || held.has(MOD_KEYS[m][1]))) return true;
    }
    return false;
  }

  /** Binds a key. If another action already uses it, that action loses the key. Returns the action that lost it. */
  set(action: Action, slot: 0 | 1, code: string): Action | null {
    if (RESERVED.includes(splitCombo(code).code)) return null;
    let stolenFrom: Action | null = null;
    if (code) {
      for (const a of ACTIONS) {
        for (const s of [0, 1] as const) {
          if (this.map[a.id][s] === code && !(a.id === action && s === slot)) {
            this.map[a.id][s] = '';
            stolenFrom = a.id;
          }
        }
      }
    }
    this.map[action][slot] = code;
    this.save();
    return stolenFrom;
  }

  reset() {
    this.map = structuredClone(DEFAULTS);
    this.save();
  }

  private save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.map));
    } catch {
      /* ignore */
    }
    this.onChange();
  }
}
