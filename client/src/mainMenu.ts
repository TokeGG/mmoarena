import {
  ABILITIES, ARENAS, CLASSES, CLASS_IDS, GEAR, ITEMS, SPECS, TALENTS, bestGear, gearStats, itemById, statBonuses, tierOf, tierUnlocked,
} from '@arena/shared';
import type { AccountInfo, Build, ClassId, PracticeDifficulty, StatId } from '@arena/shared';
import { ABILITY_ICON, CLASS_ICON } from './icons';
import { loadBuild, progress, saveBuild } from './profile';
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
  foes: ClassId[];
  ally: ClassId | null;
  difficulty: PracticeDifficulty;
  /** An arena id or 'random'. */
  map: string;
}

export interface MainMenuHooks {
  onPlay(req: PlayRequest): void;
  onControls(): void;
  onEditHud(): void;
  /** The previewed class or build changed (so the tooltip numbers and 3D model can follow). */
  onSelect(classId: ClassId, build: Build): void;
  /** The account chip, placed top right under the settings bar. */
  extras?: HTMLElement;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V'];
const STAT_ORDER: StatId[] = ['power', 'vitality', 'haste', 'resilience'];

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
  private foes = el('select');
  private ally = el('select');
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
  private flavor = el('select');
  private queueBtn = el('button', 'mm-btn', 'Find 2v2 match');
  private account: AccountInfo | null = null;

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

  setMessage(text: string) {
    this.msg.textContent = text;
  }

  /** Signed in: the account's name is used in matches and the queue becomes the ranked ladder. */
  setAccount(a: AccountInfo | null) {
    this.account = a;
    this.nameInput.disabled = !!a;
    if (a) this.nameInput.value = a.name;
    else this.nameInput.value = store.get('arena.name', '');
    this.queueBtn.textContent = a ? 'Ranked 2v2' : 'Find 2v2 match';
    this.queueBtn.title = a ? 'Queue for a rated match. Your rating changes with the result.' : 'Sign in to play for rank.';
  }

  /** Call when progress changed (a match finished) so locks and the counter refresh. */
  refresh() {
    this.build = loadBuild(this.classId);
    this.renderAll();
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
    for (const f of GEAR.flavors) this.flavor.append(new Option(`${f.name} (${f.desc})`, f.id));
    this.flavor.value = store.get('arena.flavor', 'balance');
    const auto = el('button', 'mm-small', 'Auto-equip best');
    auto.addEventListener('click', () => {
      store.set('arena.flavor', this.flavor.value);
      this.build.gear = bestGear(this.flavor.value, progress.matches);
      this.commit();
    });
    autoRow.append(this.flavor, auto);
    right.append(el('h2', '', 'Gear'), this.gearRow, autoRow, this.summary, this.progressEl);

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
    const foeCombos: [string, string][] = [];
    for (let i = 0; i < CLASS_IDS.length; i++) for (let j = i + 1; j < CLASS_IDS.length; j++) foeCombos.push([`${CLASS_IDS[i]},${CLASS_IDS[j]}`, `${CLASSES[CLASS_IDS[i]].name} + ${CLASSES[CLASS_IDS[j]].name}`]);
    for (const c of CLASS_IDS) foeCombos.push([c, `${CLASSES[c].name} (alone)`]);
    opt(this.foes, foeCombos, 'arena.foes', 'warrior,mage');
    opt(this.ally, [...CLASS_IDS.map((c): [string, string] => [c, `${CLASSES[c].name} bot`]), ['none', 'None']], 'arena.ally', 'priest');
    opt(this.diff, [['dummy', 'Dummies (passive)'], ['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']], 'arena.difficulty', 'normal');
    opt(this.map, [['random', 'Random'], ...ARENAS.map((a): [string, string] => [a.id, a.name])], 'arena.map', 'random');
    const showMap = () => {
      const a = ARENAS.find((x) => x.id === this.map.value);
      this.mapDesc.textContent = a ? a.desc : 'A random arena each match. In the queue, random players fill any arena.';
    };
    this.map.addEventListener('change', showMap);
    showMap();
    opts.append(mk('Arena', this.map), this.mapDesc, mk('Opponents', this.foes), mk('Your partner', this.ally), mk('Bot skill', this.diff));
    const row = el('div', 'mm-row');
    const practice = el('button', 'mm-btn primary', 'Practice');
    const queue = this.queueBtn;
    practice.addEventListener('click', () => this.play('practice'));
    queue.addEventListener('click', () => this.play('queue'));
    row.append(practice, queue);
    const controls = el('button', 'mm-link', 'Controls & keybinds');
    controls.id = 'btn-keys';
    controls.addEventListener('click', () => this.hooks.onControls());
    const hudBtn = el('button', 'mm-link', 'Edit HUD layout & style');
    hudBtn.addEventListener('click', () => this.hooks.onEditHud());
    play.append(opts, row, controls, hudBtn, this.msg);
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
      ...GEAR.slots.map((slot) => {
        const id = this.build.gear[slot.id];
        const item = id ? itemById(id) : undefined;
        const b = el('button', 'mm-slot');
        const tier = item ? tierOf(item.tier) : undefined;
        if (tier) b.style.setProperty('--q', tier.color);
        b.append(el('span', 'ci', slot.icon), el('span', 'sn', slot.name), el('span', 'in', item ? item.name : 'Empty'));
        if (item) tip(b, `item:${item.id}`);
        b.addEventListener('click', () => this.openGear(slot.id));
        return b;
      }),
    );
  }

  private renderSummary() {
    const stats = gearStats(this.build.gear);
    const bonus = statBonuses(stats);
    const cap = (GEAR.stats.power.ratePct > 0 ? 15 : 15) as number;
    this.summary.replaceChildren(
      ...STAT_ORDER.map((s) => {
        const row = el('div', 'mm-stat');
        tip(row, `stat:${s}`);
        const bar = el('div', 'bar');
        const fill = el('div', 'fill');
        fill.style.width = `${Math.min(100, (bonus[s] / cap) * 100)}%`;
        bar.append(fill);
        row.append(el('span', 'sname', GEAR.stats[s].name), bar, el('span', 'sval', `${stats[s]} · ${s === 'haste' || s === 'resilience' ? '−' : '+'}${bonus[s].toFixed(1)}%`));
        return row;
      }),
    );
    const next = GEAR.tiers.find((t) => progress.matches < t.unlockMatches);
    this.progressEl.textContent = `Matches played: ${progress.matches} · Wins: ${progress.wins}` + (next ? ` · ${next.name} gear unlocks in ${next.unlockMatches - progress.matches} more` : ' · All gear unlocked');
  }

  // ------------------------------------------------------------------ gear picker

  private openGear(slotId: string) {
    const slot = GEAR.slots.find((s) => s.id === slotId)!;
    const card = el('div', 'mm-modal-card');
    const head = el('div', 'mm-modal-head');
    const close = el('button', 'mm-small', 'Close');
    close.addEventListener('click', () => this.closeGear());
    const clear = el('button', 'mm-small', 'Unequip');
    clear.addEventListener('click', () => {
      delete this.build.gear[slotId];
      this.closeGear();
      this.commit();
    });
    head.append(el('h2', '', `${slot.name}`), clear, close);
    const grid = el('div', 'mm-gear-grid');
    grid.style.gridTemplateColumns = `110px repeat(${GEAR.flavors.length}, 1fr)`;
    grid.append(el('span'));
    for (const f of GEAR.flavors) grid.append(el('div', 'gh', f.name));
    for (const tier of GEAR.tiers) {
      const unlocked = tierUnlocked(tier.id, progress.matches);
      const label = el('div', 'gt');
      label.style.color = tier.color;
      label.append(el('b', '', tier.name), el('small', '', unlocked ? '' : `${tier.unlockMatches} matches`));
      grid.append(label);
      for (const f of GEAR.flavors) {
        const item = ITEMS.find((i) => i.slot === slotId && i.tier === tier.id && i.flavor === f.id)!;
        const b = el('button', `mm-item${this.build.gear[slotId] === item.id ? ' sel' : ''}${unlocked ? '' : ' locked'}`);
        b.style.setProperty('--q', tier.color);
        b.append(el('span', 'ist', STAT_ORDER.filter((s) => item.stats[s] > 0).map((s) => `${item.stats[s]} ${GEAR.stats[s].name.slice(0, 3)}`).join(' · ')));
        tip(b, `item:${item.id}`);
        b.addEventListener('click', () => {
          if (!unlocked) return;
          this.build.gear[slotId] = item.id;
          this.closeGear();
          this.commit();
        });
        grid.append(b);
      }
    }
    card.append(head, grid, el('div', 'mm-modal-foot', 'Higher tiers unlock as you finish matches. Bonuses are capped, so the gap between tiers stays small.'));
    this.modal.replaceChildren(card);
    this.modal.classList.remove('hidden');
  }

  private closeGear() {
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
      foes: this.foes.value.split(',') as ClassId[],
      ally: this.ally.value === 'none' ? null : (this.ally.value as ClassId),
      difficulty: this.diff.value as PracticeDifficulty,
      map: this.map.value,
    });
  }
}

void ABILITIES;
