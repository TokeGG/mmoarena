import { ACTIONS, Keybinds, browserKeeps, comboOf, isModifierCode, keyLabel } from './keybinds';
import type { Action } from './keybinds';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

export interface MenuHandlers {
  /** Menu opened or closed; the game uses this to pause input. */
  onToggle: (open: boolean) => void;
  /** Leave the current match (only offered while in one). */
  onLeave: () => void;
  onSensitivity: (v: number) => void;
  /** The auto-attack setting changed (also called once at start-up with the saved value). */
  onAutoAttack: (enabled: boolean) => void;
  /** Open the HUD layout editor (only offered while in a match). */
  onEditHud: () => void;
}

/**
 * Esc menu with Resume / Controls / Leave match. The same Controls screen is reachable from the join screen
 * (menu opened with `inMatch = false`, which hides Resume and Leave).
 */
/** localStorage key of the auto-attack setting ('0' = off). Synced with the account like every `arena.*` key. */
export const AUTO_KEY = 'arena.autoattack';

export class Menu {
  private root = $('menu');
  private main = $('menu-main');
  private keysView = $('menu-keys');
  private list = $('keys-list');
  private note = $('keys-note');
  private listening: { action: Action; slot: 0 | 1; btn: HTMLButtonElement } | null = null;
  private inMatch = false;
  private buttons = new Map<string, HTMLButtonElement>();
  private sensKey = 'arena.sens';

  constructor(private binds: Keybinds, private handlers: MenuHandlers) {
    $('menu-resume').addEventListener('click', () => this.close());
    $('menu-controls').addEventListener('click', () => this.showKeys());
    $('menu-hud').addEventListener('click', () => {
      this.close();
      handlers.onEditHud();
    });
    $('menu-leave').addEventListener('click', () => {
      this.close();
      handlers.onLeave();
    });
    $('keys-back').addEventListener('click', () => this.back());
    $('keys-reset').addEventListener('click', () => {
      this.binds.reset();
      this.render();
      this.say('Keys reset to default.');
    });

    const sens = $('sens') as HTMLInputElement;
    try {
      const v = Number(localStorage.getItem(this.sensKey));
      if (v >= 0.3 && v <= 2.5) sens.value = String(v);
    } catch {
      /* ignore */
    }
    const applySens = () => {
      const v = Number(sens.value);
      handlers.onSensitivity(v);
      $('sens-val').textContent = `${v.toFixed(1)}×`;
      try {
        localStorage.setItem(this.sensKey, String(v));
      } catch {
        /* ignore */
      }
    };
    sens.addEventListener('input', applySens);
    applySens();

    const auto = $('auto-toggle') as HTMLInputElement;
    try {
      auto.checked = localStorage.getItem(AUTO_KEY) !== '0';
    } catch {
      /* ignore */
    }
    const applyAuto = () => {
      $('auto-toggle-val').textContent = auto.checked ? 'On' : 'Off';
      try {
        localStorage.setItem(AUTO_KEY, auto.checked ? '1' : '0');
      } catch {
        /* ignore */
      }
      handlers.onAutoAttack(auto.checked);
    };
    auto.addEventListener('change', applyAuto);
    $('auto-toggle-val').textContent = auto.checked ? 'On' : 'Off';
    handlers.onAutoAttack(auto.checked);

    // Key capture. Runs in the capture phase so the game never sees the key that is being bound.
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.listening) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.code === 'Escape') return this.stopListening();
        if (['MetaLeft', 'MetaRight'].includes(e.code)) return;
        // a modifier on its own waits: hold Shift, then press 1 for Shift+1. Releasing it alone binds the modifier itself.
        if (isModifierCode(e.code)) {
          this.pendingMod = e.code;
          this.say('Now press the key to combine with it, or release it to bind it on its own.');
          return;
        }
        this.pendingMod = null;
        this.finishBind(comboOf(e));
      },
      true,
    );
    window.addEventListener(
      'keyup',
      (e) => {
        if (!this.listening || this.pendingMod !== e.code) return;
        this.pendingMod = null;
        this.finishBind(e.code);
      },
      true,
    );

    this.render();
  }

  private pendingMod: string | null = null;

  private finishBind(combo: string) {
    if (!this.listening) return;
    const { action, slot } = this.listening;
    const stolen = this.binds.set(action, slot, combo);
    this.stopListening();
    this.render();
    const kept = browserKeeps(combo) ? ` Careful: your browser keeps ${keyLabel(combo)} for itself, so it may not reach the game.` : '';
    this.say(`${stolen ? `${keyLabel(combo)} moved here from “${this.labelOf(stolen)}”.` : ''}${kept}`.trim());
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  open(inMatch: boolean, view: 'main' | 'keys' = 'main') {
    this.inMatch = inMatch;
    this.root.classList.remove('hidden');
    $('menu-resume').classList.toggle('hidden', !inMatch);
    $('menu-leave').classList.toggle('hidden', !inMatch);
    $('menu-sub').classList.toggle('hidden', !inMatch);
    $('menu-rule').classList.toggle('hidden', !inMatch);
    if (view === 'keys') this.showKeys();
    else this.showMain();
    this.handlers.onToggle(true);
  }

  close() {
    this.stopListening();
    this.root.classList.add('hidden');
    this.handlers.onToggle(false);
  }

  /** Escape: cancel a pending rebind, else go back a screen, else close. */
  back() {
    if (this.listening) return this.stopListening();
    if (!this.keysView.classList.contains('hidden') && this.inMatch) return this.showMain();
    this.close();
  }

  private showMain() {
    this.main.classList.remove('hidden');
    this.keysView.classList.add('hidden');
    this.root.querySelector('.card')?.classList.remove('wide');
  }

  private showKeys() {
    this.main.classList.add('hidden');
    this.keysView.classList.remove('hidden');
    this.root.querySelector('.card')?.classList.add('wide');
    this.say('');
    this.render();
  }

  private labelOf(a: Action) {
    return ACTIONS.find((x) => x.id === a)!.label;
  }

  private say(text: string) {
    this.note.textContent = text;
  }

  private stopListening() {
    if (!this.listening) return;
    this.listening.btn.classList.remove('listening');
    this.listening = null;
    this.pendingMod = null;
    this.render();
  }

  private render() {
    this.list.replaceChildren();
    this.buttons.clear();
    let group = '';
    let card: HTMLElement = this.list;
    for (const a of ACTIONS) {
      if (a.group !== group) {
        group = a.group;
        card = document.createElement('div');
        card.className = 'kcard';
        const h = document.createElement('div');
        h.className = 'kgroup';
        h.textContent = group;
        card.append(h);
        this.list.append(card);
      }
      const row = document.createElement('div');
      row.className = 'krow';
      const name = document.createElement('span');
      name.textContent = a.label;
      row.append(name);
      for (const slot of [0, 1] as const) {
        const b = document.createElement('button');
        b.className = 'kbtn';
        const listening = this.listening?.action === a.id && this.listening.slot === slot;
        const code = this.binds.get(a.id, slot);
        b.textContent = listening ? 'Press a key…' : code ? keyLabel(code) : '';
        if (!code && !listening) b.classList.add('empty');
        if (listening) b.classList.add('listening');
        b.addEventListener('click', () => {
          this.say('Press the new key, or a modifier (Shift, Ctrl, Alt) then a key for a combo like Shift+1. Esc cancels. Right-click clears.');
          this.listening = { action: a.id, slot, btn: b };
          this.render();
        });
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.listening = null;
          this.binds.set(a.id, slot, '');
          this.render();
        });
        row.append(b);
      }
      card.append(row);
    }
  }
}
