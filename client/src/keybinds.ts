/** Rebindable keyboard actions. Each action has two slots (primary, secondary), saved in localStorage. */

export type Action =
  | 'jump' | 'forward' | 'back' | 'turnLeft' | 'turnRight' | 'strafeLeft' | 'strafeRight'
  | 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'slot5' | 'slot6' | 'slot7' | 'slot8'
  | 'nextTarget' | 'prevTarget' | 'autoAttack';

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
};

const STORE = 'arena.keybinds.v1';

export function keyLabel(code: string): string {
  if (!code) return '—';
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
          if (Array.isArray(v) && v.length === 2 && v.every((c) => typeof c === 'string' && !RESERVED.includes(c))) {
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

  /** Binds a key. If another action already uses it, that action loses the key. Returns the action that lost it. */
  set(action: Action, slot: 0 | 1, code: string): Action | null {
    if (RESERVED.includes(code)) return null;
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
