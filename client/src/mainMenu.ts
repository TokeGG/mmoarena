import {
  ABILITIES, ARENAS, CLASSES, CLASS_IDS, COSMETICS, SPECS, TALENTS, itemById, itemsForSlot,
} from '@arena/shared';
import type { AccountInfo, Build, ClassId, PartyInfo, PracticeDifficulty } from '@arena/shared';
import { ABILITY_ICON, CLASS_ICON } from './icons';
import { flags, loadBuild, progress, saveBuild } from './profile';
import { CLASS_BLURB } from './tips';

/**
 * Character-select style main menu. A 3D preview of the chosen class stands in the arena behind it (see
 * ArenaScene.setPreview); this module is only DOM: class, spec, talents, gear, practice options, play buttons.
 */

export interface PlayRequest {
  mode: 'practice' | 'queue';
  name: string;
  classId: ClassId;
  build: Build;
  /** Players per team (1v1, 2v2, 3v3). */
  size: 1 | 2 | 3;
  foes: ClassId[];
  allies: ClassId[];
  difficulty: PracticeDifficulty;
  /** An arena id or 'random'. */
  map: string;
}

export interface MainMenuHooks {
  onPlay(req: PlayRequest): void;
  onControls(): void;
  onEditHud(): void;
  /** Open the list of live ranked matches to watch. */
  onWatch(): void;
  /** The previewed class or build changed (so the tooltip numbers and 3D model can follow). */
  onSelect(classId: ClassId, build: Build): void;
  /** A non-leader party member toggled Ready. */
  onReady(on: boolean): void;
  /** The account chip, placed top right under the settings bar. */
  extras?: HTMLElement;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
const tip = (e: HTMLElement, key: string, extra: Record<string, string> = {}) => {
  e.dataset.tip = key;
  for (const [k, v] of Object.entries(extra)) e.dataset[k] = v;
  return e;
};
const store = {
  get(k: string, d: string) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

export class MainMenu {
  private root: HTMLElement;
  private classId: ClassId;
  private build: Build;
  private nameInput = el('input');
  private ally = el('select');
  private size = el('select');
  private diff = el('select');
  private map = el('select');
  private mapDesc = el('div', 'mm-mapdesc');
  private classRow = el('div', 'mm-classes');
  private blurb = el('div', 'mm-blurb');
  private specs = el('div', 'mm-specs');
  private talents = el('div', 'mm-talents');
  private gearRow = el('div', 'mm-gear');
  private summary = el('div', 'mm-summary');
  private progressEl = el('div', 'mm-progress');
  private msg = el('div', 'mm-msg');
  private modal = el('div', 'mm-modal hidden');
  private queueBtn = el('button', 'mm-btn', 'Find match');
  private queueLabel(signedIn: boolean): string {
    const m = `${this.size.value}v${this.size.value}`;
    return signedIn ? `Ranked ${m}` : `Find ${m} match`;
  }
  private account: AccountInfo | null = null;
  private party: PartyInfo | null = null;
  private partyBox = el('div', 'mm-party hidden');
  private practiceBtn = el('button', 'mm-btn primary', 'Practice');
  private readyBtn = el('button', 'mm-btn primary rdy hidden', 'Ready');
  private isReady = false;
  private openSlot: string | null = null;

  constructor(root: HTMLElement, private hooks: MainMenuHooks) {
    this.root = root;
    const saved = store.get('arena.class', 'mage') as ClassId;
    this.classId = CLASS_IDS.includes(saved) ? saved : 'mage';
    this.build = loadBuild(this.classId);
    this.buildDom();
    this.renderAll();
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && !this.modal.classList.contains('hidden')) this.closeGear();
    });
  }

  get selectedClass(): ClassId {
    return this.classId;
  }
  /** The arena picked in the menu: an id or 'random'. */
  get selectedMap(): string {
    return this.map.value;
  }
  get currentBuild(): Build {
    return this.build;
  }

  get ready(): boolean {
    return this.isReady;
  }

  /** Your party (null when alone). The leader keeps Practice and Ranked; everyone else gets a Ready toggle. */
  setParty(info: PartyInfo | null) {
    this.party = info;
    const me = this.account?.name ?? '';
    const leader = !info || info.leader === me;
    const mine = info?.members.find((m) => m.name === me);
    this.isReady = !!mine?.ready && !leader;
    this.paintParty();
  }

  private paintParty() {
    const info = this.party;
    const me = this.account?.name ?? '';
    const leader = !info || info.leader === me;
    this.partyBox.classList.toggle('hidden', !info);
    this.practiceBtn.classList.toggle('hidden', !leader);
    this.queueBtn.classList.toggle('hidden', !leader);
    this.readyBtn.classList.toggle('hidden', leader);
    this.readyBtn.textContent = this.isReady ? 'Ready ✓ (click to cancel)' : 'Ready';
    this.readyBtn.classList.toggle('on', this.isReady);
    this.partyBox.replaceChildren();
    this.queueBtn.textContent = this.queueLabel(!!this.account);
    if (!info) return;
    const waiting = info.members.filter((m) => !m.ready).length;
    this.partyBox.append(el('b', '', `Party (${info.members.length}/3)`));
    for (const m of info.members) {
      const chip = el('span', `mm-pchip${m.ready ? ' ok' : ''}`, `${m.name === info.leader ? '👑 ' : ''}${m.name} ${m.ready ? '✓' : '…'}`);
      this.partyBox.append(chip);
    }
    this.partyBox.append(
      el('small', '', leader ? (waiting ? `Waiting for ${waiting} to ready up. You pick the mode and arena.` : 'Everyone is ready. Pick Practice or Ranked.') : `${info.leader} picks the mode and arena. Press Ready.`),
    );
    this.queueBtn.textContent += (info.members.length > 1 ? ` (${info.members.length - waiting}/${info.members.length} ready)` : '');
  }

  setMessage(text: string) {
    this.msg.textContent = text;
  }

  /** Signed in: the account's name is used in matches and the queue becomes the ranked ladder. */
  setAccount(a: AccountInfo | null) {
    this.account = a;
    this.nameInput.disabled = !!a;
    if (a) this.nameInput.value = a.name;
    else this.nameInput.value = store.get('arena.name', '');
    this.paintParty();
    this.queueBtn.title = a ? 'Queue for a rated match. Your rating changes with the result.' : 'Sign in to play for rank.';
  }

  /** Call when progress changed (a match finished) so locks and the counter refresh. */
  refresh() {
    this.build = loadBuild(this.classId);
    this.renderAll();
    if (this.openSlot) this.openGear(this.openSlot); // keep the picker in step after a discard
  }

  show(visible: boolean) {
    this.root.classList.toggle('hidden', !visible);
  }

  // ------------------------------------------------------------------ DOM skeleton

  private buildDom() {
    const logo = el('div', 'mm-logo');
    logo.append(el('h1', '', 'Arena'), el('p', '', 'Third-person arena combat · server-authoritative'));
    const ver = el('div', 'mm-ver');
    ver.id = 'ver';

    // left: character
    const left = el('section', 'mm-panel mm-left');
    this.nameInput.type = 'text';
    this.nameInput.maxLength = 16;
    this.nameInput.placeholder = 'Character name';
    this.nameInput.value = store.get('arena.name', '');
    left.append(el('h2', '', 'Character'), this.nameInput, this.classRow, this.blurb, el('h3', '', 'Specialization'), this.specs, el('h3', '', 'Talents'), this.talents);

    // right: gear + play
    const right = el('section', 'mm-panel mm-right');
    const autoRow = el('div', 'mm-auto');
    const random = el('button', 'mm-small', '🎲 Random look');
    random.addEventListener('click', () => {
      this.build.gear = Object.fromEntries(COSMETICS.slots.filter(() => Math.random() < 0.8).map((sl) => {
        const list = itemsForSlot(sl.id).filter((i) => !i.owner || flags.owner);
        return [sl.id, list[Math.floor(Math.random() * list.length)].id];
      }));
      this.commit();
    });
    const clearAll = el('button', 'mm-small', 'Clear all');
    clearAll.addEventListener('click', () => {
      this.build.gear = {};
      this.commit();
    });
    autoRow.append(random, clearAll);
    right.append(el('h2', '', 'Appearance'), this.gearRow, autoRow, this.summary, this.progressEl);

    const play = el('div', 'mm-play');
    const opts = el('div', 'mm-opts');
    const mk = (label: string, sel: HTMLSelectElement) => {
      const l = el('label', '', label);
      l.append(sel);
      return l;
    };
    const opt = (sel: HTMLSelectElement, items: [string, string][], key: string, dflt: string) => {
      for (const [v, t] of items) sel.append(new Option(t, v));
      const saved = store.get(key, dflt);
      sel.value = [...sel.options].some((o) => o.value === saved) ? saved : dflt;
      sel.addEventListener('change', () => store.set(key, sel.value));
    };
    opt(this.size, [['1', '1v1'], ['2', '2v2'], ['3', '3v3']], 'arena.size', '2');
    const combos = (n: number): [string, string][] => {
      const out: [string, string][] = [];
      const rec = (start: number, cur: ClassId[]) => {
        if (cur.length === n) return void out.push([cur.join(','), cur.map((c) => CLASSES[c].name).join(' + ')]);
        for (let i = start; i < CLASS_IDS.length; i++) rec(i, [...cur, CLASS_IDS[i]]);
      };
      rec(0, []);
      return out;
    };
    /** The partner list depends on the team size (n-1 bot partners). */
    const fill = (sel: HTMLSelectElement, items: [string, string][], key: string, dflt: string) => {
      sel.replaceChildren();
      for (const [v, t] of items) sel.append(new Option(t, v));
      const saved = store.get(key, dflt);
      sel.value = [...sel.options].some((o) => o.value === saved) ? saved : [...sel.options].some((o) => o.value === dflt) ? dflt : sel.options[0].value;
    };
    const refill = () => {
      const n = Number(this.size.value);
      fill(this.ally, n === 1 ? [['none', 'None (solo)']] : combos(n - 1), `arena.allies${n}`, ['', 'priest', 'priest,mage'][n - 1] || 'none');
      this.ally.disabled = n === 1;
    };
    this.ally.addEventListener('change', () => store.set(`arena.allies${this.size.value}`, this.ally.value));
    this.size.addEventListener('change', () => {
      store.set('arena.size', this.size.value);
      refill();
      this.paintParty();
    });
    refill();
    this.queueBtn.textContent = this.queueLabel(!!this.account);
    opt(this.diff, [['dummy', 'Dummies (passive)'], ['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']], 'arena.difficulty', 'normal');
    opt(this.map, [['random', 'Random'], ...ARENAS.map((a): [string, string] => [a.id, a.name])], 'arena.map', 'random');
    const showMap = () => {
      const a = ARENAS.find((x) => x.id === this.map.value);
      this.mapDesc.textContent = a ? a.desc : 'A random arena each match. In the queue, random players fill any arena.';
    };
    this.map.addEventListener('change', showMap);
    showMap();
    opts.append(mk('Mode', this.size), mk('Arena', this.map), this.mapDesc, mk('Your partners (practice)', this.ally), mk('Bot skill', this.diff));
    const row = el('div', 'mm-row');
    const practice = this.practiceBtn;
    const queue = this.queueBtn;
    practice.addEventListener('click', () => this.play('practice'));
    queue.addEventListener('click', () => this.play('queue'));
    this.readyBtn.addEventListener('click', () => {
      this.isReady = !this.isReady;
      this.paintParty();
      this.hooks.onReady(this.isReady);
    });
    row.append(practice, queue, this.readyBtn);
    const controls = el('button', 'mm-link', 'Controls & keybinds');
    controls.id = 'btn-keys';
    controls.addEventListener('click', () => this.hooks.onControls());
    const hudBtn = el('button', 'mm-link', 'Edit HUD layout & style');
    hudBtn.addEventListener('click', () => this.hooks.onEditHud());
    const watch = el('button', 'mm-link', '👁 Watch live ranked matches');
    watch.addEventListener('click', () => this.hooks.onWatch());
    play.append(this.partyBox, opts, row, controls, hudBtn, watch, this.msg);
    right.append(play);

    this.modal.addEventListener('mousedown', (e) => {
      if (e.target === this.modal) this.closeGear();
    });
    this.root.replaceChildren(logo, ver, left, right, this.modal);
    this.nameInput.addEventListener('input', () => {
      if (!this.account) store.set('arena.name', this.nameInput.value);
    });
    if (this.hooks.extras) {
      const box = el('div', 'mm-acct');
      box.append(this.hooks.extras);
      this.root.append(box);
    }
  }

  // ------------------------------------------------------------------ rendering

  private renderAll() {
    this.renderClasses();
    this.renderSpecs();
    this.renderTalents();
    this.renderGear();
    this.renderSummary();
  }

  private commit() {
    saveBuild(this.classId, this.build);
    this.hooks.onSelect(this.classId, this.build);
    this.renderAll();
  }

  private renderClasses() {
    this.classRow.replaceChildren(
      ...CLASS_IDS.map((id) => {
        const b = el('button', `mm-class${id === this.classId ? ' sel' : ''}`);
        b.style.setProperty('--c', CLASSES[id].color);
        b.append(el('span', 'ci', CLASS_ICON[id]), el('span', '', CLASSES[id].name));
        tip(b, `class:${id}`, { tipText: CLASS_BLURB[id] });
        b.addEventListener('click', () => {
          if (id === this.classId) return;
          this.classId = id;
          store.set('arena.class', id);
          this.build = loadBuild(id);
          this.hooks.onSelect(id, this.build);
          this.renderAll();
        });
        return b;
      }),
    );
    this.blurb.textContent = CLASS_BLURB[this.classId];
  }

  private renderSpecs() {
    this.specs.replaceChildren(
      ...SPECS[this.classId].map((spec) => {
        const card = el('button', `mm-spec${spec.id === this.build.spec ? ' sel' : ''}`);
        const head = el('div', 'mm-spec-head');
        head.append(el('span', 'ci', spec.icon), el('b', '', spec.name), el('span', 'role', spec.role));
        const kit = el('div', 'mm-kit');
        for (const a of spec.bar) {
          const k = el('span', 'kit-ico', ABILITY_ICON[a] ?? '✦');
          tip(k, `ability:${a}`);
          kit.append(k);
        }
        card.append(head, el('div', 'mm-spec-desc', spec.desc), kit);
        tip(card, `spec:${this.classId}:${spec.id}`);
        card.addEventListener('click', () => {
          this.build.spec = spec.id;
          this.commit();
        });
        return card;
      }),
    );
  }

  private renderTalents() {
    this.talents.replaceChildren(
      ...TALENTS[this.classId].map((tier, i) => {
        const row = el('div', 'mm-tier');
        row.append(el('span', 'tier-label', `Tier ${ROMAN[i]}`));
        for (const t of tier) {
          const b = el('button', `mm-talent${this.build.talents[i] === t.id ? ' sel' : ''}`);
          b.append(el('span', 'ci', t.icon), el('span', 'tn', t.name));
          tip(b, `talent:${this.classId}:${t.id}`);
          b.addEventListener('click', () => {
            this.build.talents[i] = this.build.talents[i] === t.id ? '' : t.id;
            this.commit();
          });
          row.append(b);
        }
        return row;
      }),
    );
  }

  private renderGear() {
    this.gearRow.replaceChildren(
      ...COSMETICS.slots.map((slot) => {
        const id = this.build.gear[slot.id];
        const item = id ? itemById(id) : undefined;
        const b = el('button', 'mm-slot');
        if (item) b.style.setProperty('--q', item.color);
        b.append(el('span', 'ci', slot.icon), el('span', 'sn', slot.name), el('span', 'in', item ? item.name : 'None'));
        if (item) tip(b, `item:${item.id}`);
        b.addEventListener('click', () => this.openGear(slot.id));
        return b;
      }),
    );
  }

  private renderSummary() {
    this.summary.replaceChildren(el('div', 'perk', 'Cosmetics change how you look to everyone. They never change how you fight, and they are all free.'));
    this.progressEl.textContent = `Matches played: ${progress.matches} · Wins: ${progress.wins}`;
  }

  // ------------------------------------------------------------------ cosmetic picker

  private openGear(slotId: string) {
    const slot = COSMETICS.slots.find((s) => s.id === slotId)!;
    const card = el('div', 'mm-modal-card');
    const head = el('div', 'mm-modal-head');
    const close = el('button', 'mm-small', 'Close');
    close.addEventListener('click', () => this.closeGear());
    const clear = el('button', 'mm-small', 'None');
    clear.addEventListener('click', () => {
      delete this.build.gear[slotId];
      this.closeGear();
      this.commit();
    });
    head.append(el('h2', '', slot.name), clear, close);
    const grid = el('div', 'mm-cos-grid');
    for (const item of itemsForSlot(slotId)) {
      if (item.owner && !flags.owner) continue; // owner-only looks stay hidden from everyone else
      const b = el('button', `mm-item${this.build.gear[slotId] === item.id ? ' sel' : ''}${item.owner ? ' owner' : ''}`);
      b.style.setProperty('--q', item.color);
      b.append(el('span', 'sw'), el('span', 'ist', (item.owner ? '★ ' : '') + item.name));
      tip(b, `item:${item.id}`);
      b.addEventListener('click', () => {
        this.build.gear[slotId] = item.id;
        this.commit(); // keep the picker open so you can try several; the model behind it updates
        this.openGear(slotId);
      });
      grid.append(b);
    }
    card.append(head, grid, el('div', 'mm-modal-foot', 'Click to try one on. Cosmetics are free and only change your look.'));
    this.openSlot = slotId;
    this.modal.replaceChildren(card);
    this.modal.classList.remove('hidden');
  }

  private closeGear() {
    this.openSlot = null;
    this.modal.classList.add('hidden');
  }

  // ------------------------------------------------------------------ play

  private play(mode: 'practice' | 'queue') {
    const name = this.account ? this.account.name : this.nameInput.value.trim() || 'Player';
    if (!this.account) store.set('arena.name', name);
    this.hooks.onPlay({
      mode,
      name,
      classId: this.classId,
      build: this.build,
      size: Number(this.size.value) as 1 | 2 | 3,
      // practice opponents are always random classes, rolled for every match
      foes: Array.from({ length: Number(this.size.value) }, () => CLASS_IDS[Math.floor(Math.random() * CLASS_IDS.length)]),
      allies: this.ally.value === 'none' ? [] : (this.ally.value.split(',') as ClassId[]),
      difficulty: this.diff.value as PracticeDifficulty,
      map: this.map.value,
    });
  }
}

void ABILITIES;
