import {
  ABILITIES, ARENAS, CLASSES, CLASS_IDS, COSMETICS, PATCHES, SPECS, barFor, canWear, compileMods, describeAbility, itemById, itemsForSlot, talentsFor,
} from '@arena/shared';
import type { AccountInfo, Build, ClassId, PartyInfo, PracticeDifficulty } from '@arena/shared';
import { ABILITY_ICON, CLASS_ICON } from './icons';
import { flags, loadBuild, loadSpecTalents, progress, saveBuild, saveSpecTalents } from './profile';
import { CLASS_BLURB, tipBuildKey } from './tips';
import { applyOrder, loadOrder, saveOrder, swapSlots } from './barOrder';

/**
 * Character-select style main menu. A 3D preview of the chosen class stands in the arena behind it (see
 * ArenaScene.setPreview); this module is only DOM: class, spec, talents, gear, practice options, play buttons.
 */

export interface PlayRequest {
  mode: 'practice' | 'queue' | 'party';
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
  /** Open the list of live matches to watch. */
  onWatch(): void;
  /** Key label for action-bar slot n (1-8), from the player's keybinds. */
  slotKey?(n: number): string;
  /** The previewed class or build changed (so the tooltip numbers and 3D model can follow). */
  onSelect(classId: ClassId, build: Build): void;
  /** A non-leader party member toggled Ready. */
  onReady(on: boolean): void;
  /** You picked a side for the party match. */
  onSide(side: 0 | 1): void;
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
  private specPop = el('div', 'mm-specpop hidden');
  private popHide = 0;
  private talents = el('div', 'mm-talents');
  private gearRow = el('div', 'mm-gear');
  private lookCard = el('button', 'mm-lookcard');
  private lookSlot = 'head';
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
  /** Your party as the server last described it (null when not in one). */
  get currentParty(): PartyInfo | null {
    return this.party;
  }
  private partyBox = el('div', 'mm-party hidden');
  private practiceBtn = el('button', 'mm-btn primary', 'Practice');
  private readyBtn = el('button', 'mm-btn primary rdy hidden', 'Ready');
  private partyBtn = el('button', 'mm-btn hidden', 'Party match');
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
    this.partyBtn.classList.toggle('hidden', !leader || !info || info.members.length < 2);
    this.readyBtn.textContent = this.isReady ? 'Ready ✓ (click to cancel)' : 'Ready';
    this.readyBtn.classList.toggle('on', this.isReady);
    this.partyBox.replaceChildren();
    this.queueBtn.textContent = this.queueLabel(!!this.account);
    if (!info) return;
    const waiting = info.members.filter((m) => !m.ready && m.name !== info.leader).length;
    const head = el('div', 'pr-head');
    head.append(el('b', '', `Party (${info.members.length}/3)`), el('small', '', leader ? 'You pick the mode and arena' : `${info.leader} picks the mode and arena`));
    this.partyBox.append(head);
    for (const m of info.members) {
      const lead = m.name === info.leader;
      const row = el('div', `pr-row${m.name === me ? ' me' : ''}`);
      const cls = m.classId ? CLASSES[m.classId as ClassId] : undefined;
      const spec = m.classId ? SPECS[m.classId as ClassId]?.find((x) => x.id === m.spec) : undefined;
      row.append(
        el('span', 'pr-ico', m.classId ? (CLASS_ICON[m.classId as ClassId] ?? '✦') : '…'),
        el('span', 'pr-name', `${lead ? '👑 ' : ''}${m.name}${m.name === me ? ' (you)' : ''}`),
        el('small', 'pr-kit', cls ? `${cls.name}${spec ? ` · ${spec.name}` : ''}` : 'choosing…'),
      );
      const side = el('button', `mm-pside s${m.side}`, m.side === 0 ? 'Team 1' : 'Team 2');
      side.title = m.name === me ? 'Click to switch sides in a party match' : `${m.name}'s side in a party match`;
      if (m.name === me) side.addEventListener('click', () => this.hooks.onSide(m.side === 0 ? 1 : 0));
      else side.disabled = true;
      row.append(side, el('span', `pr-rdy${lead || m.ready ? ' ok' : ''}`, lead ? 'Leader' : m.ready ? 'Ready ✓' : 'Not ready'));
      this.partyBox.append(row);
    }
    this.partyBox.append(el('small', 'pr-foot', leader ? (waiting ? `Waiting for ${waiting} to ready up.` : 'Everyone is ready. Pick Practice or Ranked.') : 'Press Ready when you are set.'));
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
    if (this.openSlot) this.openLook(this.openSlot); // keep the picker in step after a discard
  }

  show(visible: boolean) {
    this.root.classList.toggle('hidden', !visible);
    if (!visible) {
      window.clearTimeout(this.popHide);
      this.specPop.classList.add('hidden');
    }
  }

  // ------------------------------------------------------------------ DOM skeleton

  private buildDom() {
    const logo = el('div', 'mm-logo');
    logo.append(el('h1', '', 'ARENA'), el('p', '', 'Outplay. Outlast.'));
    const ver = el('div', 'mm-ver');
    ver.id = 'ver';

    // left: character
    const left = el('section', 'mm-panel mm-left');
    this.nameInput.type = 'text';
    this.nameInput.maxLength = 16;
    this.nameInput.placeholder = 'Character name';
    this.nameInput.value = store.get('arena.name', '');
    // the spec card stays up while the pointer is anywhere on this side (or on the card itself), so you can reach it from any spec
    left.addEventListener('mouseenter', () => window.clearTimeout(this.popHide));
    left.addEventListener('mouseleave', (e) => {
      if (!(e.relatedTarget instanceof Node && this.specPop.contains(e.relatedTarget))) this.hideSpecPop();
    });
    left.append(el('h2', '', 'Character'), this.classRow, this.blurb, this.sectionHead('Specialisation', 'hover for its skills'), this.specs, this.sectionHead('Talent tree · one per tier'), this.talents);

    // right: the Look card and the Match panel
    const right = el('section', 'mm-right');
    this.lookCard.addEventListener('click', () => this.openLook());
    const matchPanel = el('div', 'mm-match');
    const play = matchPanel;
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
    const practice = this.practiceBtn;
    const queue = this.queueBtn;
    practice.addEventListener('click', () => this.play('practice'));
    queue.addEventListener('click', () => this.play('queue'));
    this.readyBtn.addEventListener('click', () => {
      this.isReady = !this.isReady;
      this.paintParty();
      this.hooks.onReady(this.isReady);
    });
    this.partyBtn.title = 'A friendly match with your whole party: pick sides, bots fill the empty places.';
    this.partyBtn.addEventListener('click', () => this.play('party'));
    // the size buttons drive the (hidden) select so the saved setting and partner list keep working
    const segs = el('div', 'mm-seg');
    const paintSeg = () => {
      for (const b of [...segs.children] as HTMLButtonElement[]) b.classList.toggle('on', b.dataset.v === this.size.value);
    };
    for (const [v, t] of [['1', '1v1'], ['2', '2v2'], ['3', '3v3']]) {
      const bt = el('button', '', t);
      bt.dataset.v = v;
      bt.addEventListener('click', () => {
        this.size.value = v;
        this.size.dispatchEvent(new Event('change'));
        paintSeg();
      });
      segs.append(bt);
    }
    this.size.addEventListener('change', paintSeg);
    paintSeg();
    const rowSel = (label: string, sel: HTMLSelectElement, cls = '') => {
      const r = el('label', `mm-selrow ${cls}`);
      r.append(el('span', '', label), sel);
      return r;
    };
    const adv = el('details', 'mm-adv');
    adv.append(el('summary', '', 'Advanced: partners and foes'), rowSel('PARTNERS (PRACTICE)', this.ally), this.mapDesc);
    const actions = el('div', 'mm-actions');
    actions.append(this.partyBtn, this.readyBtn, practice, queue);
    const hint = el('div', 'mm-esc');
    hint.append('Press ', el('b', '', 'Esc'), ' for controls, HUD and sound');
    matchPanel.append(el('div', 'mm-match-h', 'MATCH'), this.partyBox, segs, rowSel('ARENA', this.map, 'dash'), rowSel('BOT SKILL', this.diff), adv, this.msg, actions, hint);
    right.append(this.lookCard, matchPanel);

    this.modal.addEventListener('mousedown', (e) => {
      if (e.target === this.modal) this.closeGear();
    });
    this.root.replaceChildren(logo, ver, left, right, this.modal);
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
    saveSpecTalents(this.classId, this.build.spec, this.build.talents);
    this.hooks.onSelect(this.classId, this.build);
    this.renderAll();
    // an open spec card follows the new picks (its skills and their numbers)
    const open = this.specPop.classList.contains('hidden') ? null : SPECS[this.classId].find((x) => x.id === this.specPop.dataset.spec);
    const card = open ? this.specs.querySelector<HTMLElement>(`[data-spec="${open.id}"]`) : null;
    if (open && card) this.showSpecPop(card, open);
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

  private sectionHead(title: string, hint = ''): HTMLElement {
    const h = el('div', 'mm-sec');
    h.append(el('span', '', title));
    if (hint) h.append(el('small', '', hint));
    return h;
  }

  private renderSpecs() {
    this.specs.replaceChildren(
      ...SPECS[this.classId].map((spec) => {
        const card = el('button', `mm-spec${spec.id === this.build.spec ? ' sel' : ''}`);
        card.dataset.spec = spec.id;
        card.append(el('span', 'ci', spec.icon), el('b', '', spec.name));
        card.addEventListener('mouseenter', () => this.showSpecPop(card, spec));
        card.addEventListener('click', () => {
          if (this.build.spec !== spec.id) {
            saveSpecTalents(this.classId, this.build.spec, this.build.talents); // keep what this spec had
            this.build.talents = this.specBuild(spec.id).talents;
          }
          this.build.spec = spec.id;
          this.commit();
        });
        return card;
      }),
    );
  }

  /**
   * The build a spec has: the current one for the picked spec, else the talents it had last time (talents belong to a
   * spec), falling back to the shared tier picks of the current build.
   */
  private specBuild(specId: string): Build {
    if (specId === this.build.spec) return this.build;
    const talents = loadSpecTalents(this.classId, specId) ?? talentsFor(this.classId, specId).map((tier, i) => (tier.some((t) => t.id === this.build.talents[i]) ? this.build.talents[i] : ''));
    return { ...this.build, spec: specId, talents };
  }

  /**
   * The hover card of a spec: what it does, its skills in bar order with their keys. The skills are the ones that spec's
   * talents give (a swapped-in skill takes the place of the one it replaces) and their tooltips use that spec and its
   * talents; a skill a talent changes or brings in is flagged. Drag a skill onto another slot to swap them.
   */
  private showSpecPop(card: HTMLElement, spec: (typeof SPECS)[ClassId][number]) {
    window.clearTimeout(this.popHide);
    const build = this.specBuild(spec.id);
    const order = applyOrder(barFor(this.classId, build, spec.bar), loadOrder(this.classId, spec.id));
    const withTalents = compileMods(this.classId, build);
    const specOnly = compileMods(this.classId, { ...build, talents: [] });
    const buildKey = tipBuildKey(this.classId, build);
    const pop = this.specPop;
    pop.replaceChildren();
    pop.dataset.spec = spec.id;
    const head = el('div', 'sp-head');
    const ico = el('span', 'sp-bigico', spec.icon);
    const title = el('div', 'sp-title');
    title.append(el('b', '', spec.name), el('span', 'role', spec.role));
    head.append(ico, title);
    const reset = el('button', 'mm-small', 'Reset order');
    reset.addEventListener('click', () => {
      saveOrder(this.classId, spec.id, spec.bar);
      this.showSpecPop(card, spec);
    });
    const sub = el('div', 'sp-sub');
    sub.append(el('span', '', `Its ${spec.bar.length} skills`), el('small', '', 'drag to reorder · talents can swap some'), reset);
    const list = el('div', 'sp-list');
    order.forEach((a, i) => {
      const slot = el('div', 'sp-slot');
      slot.draggable = true;
      const tile = el('span', 'sp-tile', ABILITY_ICON[a] ?? '✦');
      slot.append(el('span', 'be-key', this.hooks.slotKey?.(i + 1) ?? String(i + 1)), tile, el('span', 'sp-name', ABILITIES[a]?.name ?? a));
      tip(slot, `ability:${a}`, { tipBuild: buildKey });
      if (!spec.bar.includes(a)) {
        slot.classList.add('swapped');
        slot.append(el('span', 'sp-flag', 'talent'));
      } else if (ABILITIES[a] && JSON.stringify(describeAbility(ABILITIES[a], withTalents)) !== JSON.stringify(describeAbility(ABILITIES[a], specOnly))) {
        slot.classList.add('buffed');
        slot.append(el('span', 'sp-flag', '▲'));
      }
      slot.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/plain', String(i));
        slot.classList.add('drag');
      });
      slot.addEventListener('dragend', () => slot.classList.remove('drag'));
      slot.addEventListener('dragover', (e) => {
        e.preventDefault();
        slot.classList.add('over');
      });
      slot.addEventListener('dragleave', () => slot.classList.remove('over'));
      slot.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer?.getData('text/plain'));
        if (Number.isNaN(from)) return;
        saveOrder(this.classId, spec.id, swapSlots(order, from, i));
        this.showSpecPop(card, spec);
      });
      list.append(slot);
    });
    pop.append(head, el('div', 'sp-desc', spec.desc), sub, list);
    if (!pop.isConnected) {
      document.body.append(pop);
      pop.addEventListener('mouseenter', () => window.clearTimeout(this.popHide));
      pop.addEventListener('mouseleave', (e) => {
        if (!(e.relatedTarget instanceof Element && e.relatedTarget.closest('.mm-left'))) this.hideSpecPop();
      });
    }
    pop.classList.remove('hidden');
    const r = (card.closest('.mm-left') ?? card).getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = r.right + 8 + w < window.innerWidth ? r.right + 8 : Math.max(6, r.left - w - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(6, Math.min(cr.top - 40, window.innerHeight - pop.offsetHeight - 6))}px`;
  }

  private hideSpecPop() {
    window.clearTimeout(this.popHide);
    this.popHide = window.setTimeout(() => this.specPop.classList.add('hidden'), 450);
  }

  private renderTalents() {
    this.talents.replaceChildren(
      ...talentsFor(this.classId, this.build.spec).map((tier, i) => {
        const row = el('div', 'mm-tier');
        row.append(el('span', 'tier-label', ROMAN[i]));
        for (const t of tier) {
          const b = el('button', `mm-talent${this.build.talents[i] === t.id ? ' sel' : ''}`);
          b.append(el('span', 'tn', t.name));
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
    const worn = COSMETICS.slots.filter((sl) => this.build.gear[sl.id]).length;
    this.lookCard.replaceChildren();
    const ico = el('span', 'lc-ico', '🎭');
    const txt = el('span', 'lc-txt');
    txt.append(el('span', 'lc-t', 'Look'), el('span', 'lc-s', worn ? `${worn} of ${COSMETICS.slots.length} slots dressed · ${progress.matches} matches played` : 'Headwear, shoulders, back, glow and 3 more'));
    this.lookCard.append(ico, txt, el('span', 'lc-go', '›'));
    if (this.openSlot) this.openLook(this.openSlot);
  }

  private renderSummary() {
    /* the Look menu carries the unlock text now */
  }

  // ------------------------------------------------------------------ the Look menu

  /** Slots down the left, the options of the picked slot as a grid on the right. Click to try one on; Done closes. */
  private openLook(slotId = this.lookSlot) {
    this.lookSlot = slotId;
    this.openSlot = slotId;
    const card = el('div', 'mm-modal-card lk-card');
    const head = el('div', 'lk-head');
    const titles = el('div', 'lk-titles');
    titles.append(el('h2', '', 'LOOK'), el('p', '', `Cosmetics change how you look to everyone. They never change how you fight. Flashier ones unlock as you play (${progress.matches} matches so far).`));
    const random = el('button', 'mm-small', 'Random look');
    random.addEventListener('click', () => {
      this.build.gear = Object.fromEntries(COSMETICS.slots.filter(() => Math.random() < 0.8).map((sl) => {
        const list = itemsForSlot(sl.id).filter((i) => canWear(i, flags.owner, progress.matches));
        return [sl.id, list[Math.floor(Math.random() * list.length)].id];
      }));
      this.commit();
    });
    const clearAll = el('button', 'mm-small', 'Clear all');
    clearAll.addEventListener('click', () => {
      this.build.gear = {};
      this.commit();
    });
    const done = el('button', 'mm-small mm-go', 'Done');
    done.addEventListener('click', () => this.closeGear());
    head.append(titles, random, clearAll, done);

    const body = el('div', 'lk-body');
    const list = el('div', 'lk-slots');
    for (const sl of COSMETICS.slots) {
      const id = this.build.gear[sl.id];
      const item = id ? itemById(id) : undefined;
      const b = el('button', `lk-slot${sl.id === slotId ? ' sel' : ''}`);
      if (item) b.style.setProperty('--q', item.color);
      b.append(el('span', 'ls-n', sl.name), el('span', 'ls-v', item ? item.name : 'None'));
      b.addEventListener('click', () => this.openLook(sl.id));
      list.append(b);
    }
    const pane = el('div', 'lk-pane');
    pane.append(el('div', 'lk-ph', COSMETICS.slots.find((x) => x.id === slotId)!.name.toUpperCase()));
    const grid = el('div', 'lk-grid');
    const none = el('button', `lk-item${this.build.gear[slotId] ? '' : ' sel'}`);
    none.append(el('span', 'lk-none'), el('span', 'ist', 'None'));
    none.addEventListener('click', () => {
      delete this.build.gear[slotId];
      this.commit();
      this.openLook(slotId);
    });
    grid.append(none);
    for (const item of itemsForSlot(slotId)) {
      if (item.owner && !flags.owner) continue; // owner-only looks stay hidden from everyone else
      const locked = !canWear(item, flags.owner, progress.matches);
      const b = el('button', `lk-item${this.build.gear[slotId] === item.id ? ' sel' : ''}${item.owner ? ' owner' : ''}${locked ? ' locked' : ''}`);
      b.style.setProperty('--q', item.color);
      b.append(el('span', 'sw'), el('span', 'ist', (item.owner ? '★ ' : '') + item.name));
      if (locked) b.append(el('span', 'lk', `🔒 ${item.unlock} matches`));
      tip(b, `item:${item.id}`);
      b.addEventListener('click', () => {
        if (locked) return;
        this.build.gear[slotId] = item.id;
        this.commit(); // keep the menu open so you can try several; the model behind it updates
        this.openLook(slotId);
      });
      grid.append(b);
    }
    pane.append(grid, el('div', 'lk-foot', 'The character behind this window updates as you pick.'));
    body.append(list, pane);
    card.append(head, body);
    this.modal.replaceChildren(card);
    this.modal.classList.remove('hidden');
  }

  private closeGear() {
    this.openSlot = null;
    this.modal.classList.add('hidden');
  }

  // ------------------------------------------------------------------ patch notes

  openPatches() {
    const card = el('div', 'mm-modal-card mm-patches');
    const head = el('div', 'mm-modal-head');
    const close = el('button', 'mm-small', 'Close');
    close.addEventListener('click', () => this.closeGear());
    head.append(el('h2', '', 'Patch notes'), close);
    card.append(head);
    PATCHES.forEach((p, i) => {
      const box = el('section', `mm-patch${i === 0 ? ' latest' : ''}`);
      const h = el('h3', '');
      h.append(el('span', 'pv', `v${p.version}`), el('span', 'pt', p.title), el('span', 'pd', p.date));
      if (i === 0) h.append(el('span', 'pnew', 'Latest'));
      const ul = el('ul', '');
      for (const c of p.changes) ul.append(el('li', '', c));
      box.append(h, ul);
      card.append(box);
    });
    this.modal.replaceChildren(card);
    this.modal.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ play

  private play(mode: 'practice' | 'queue' | 'party') {
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
