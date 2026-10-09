import { ABILITIES, ARENAS, CLASSES, CLASS_IDS, SPECS, TALENTS, applyPatches, mergePatches, skillInfo, talentsFor, tunableNumbers } from '@arena/shared';
import type { Build, ClassId, ClientMsg, DataPatch, ServerMsg, SimEvent, TunableNumber, UnitBuild } from '@arena/shared';
import { ABILITY_ICON } from './icons';
import { invalidateTip } from './tooltip';
import { makeResizable } from './resizable';
import { cycleArena } from './mapCycle';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/**
 * The numbers this client plays with: the data files, then the numbers a dev saved for everyone (from the server), then
 * the test numbers in the dev's own match. Each layer is put back before the layers are applied again.
 */
export class DataLayers {
  private live: DataPatch[] = [];
  private room: DataPatch[] = [];
  private session: DataPatch[] = [];
  private undo: (() => void) | null = null;
  setLive(p: DataPatch[]) {
    this.live = p;
    this.apply();
  }
  setRoom(p: DataPatch[]) {
    this.room = p;
    this.apply();
  }
  /** The dev's session numbers (shown in tooltips in the menu; in a match the room's numbers already carry them). */
  setSession(p: DataPatch[]) {
    this.session = p;
    this.apply();
  }
  get roomPatches(): DataPatch[] {
    return this.room;
  }
  private apply() {
    this.undo?.();
    const a = applyPatches(this.live);
    const s = applyPatches(this.session);
    const b = applyPatches(this.room);
    this.undo = () => {
      b();
      s();
      a();
    };
    invalidateTip(); // open tooltips redraw with the new numbers
  }
}

/** A saved set of test numbers and builds. */
interface DevSetup { name: string; patches: DataPatch[]; builds: { me: boolean; classId: ClassId; build: Build }[] }

interface Hooks {
  send(m: ClientMsg): void;
  /** Abilities to offer: everyone's bars in the match. */
  builds(): UnitBuild[];
  /** The dev's own bar, offered first. */
  myBar(): string[];
  /** The dev's own unit in the match (it can be rebuilt like a bot). */
  youId(): number;
  /** The map of the match being played or watched. */
  mapId(): string;
  /** In the menu: the class picked there, whose skills the panel opens on. */
  menuClass(): ClassId;
  /** Whether the signed-in account is the owner. */
  isOwner(): boolean;
}

/**
 * Dev tools in a match: pause it, change any number on a skill (and on the effects it puts on people), try it at once,
 * then keep it for everyone or put it back; and send the owner a note about a skill. In any match that is not ranked:
 * everyone in it gets the same test numbers and is told, and the match stops counting.
 */
export class DevPanel {
  readonly root = el('div', 'devp hidden');
  readonly button = el('button', 'devp-btn hidden', '🛠');
  private paused = false;
  private pick = '';
  private edits = new Map<string, DataPatch>();
  private result: { ok: boolean; text: string; url?: string } | null = null;
  private note = '';
  /** Numbers kept for this session (the server puts them into every match the dev starts). */
  private session: DataPatch[] = [];
  private ask = '';
  private asking = false;
  /** In a match the tools act on it; in the menu changes go to the dev's session or to everyone. */
  private inMatch = false;
  private menuCls: ClassId | null = null;
  /** Bots being edited: the class and build chosen for each, until applied. */
  private botDraft = new Map<number, { classId: ClassId; build: Build }>();
  private botsOpen = false;
  /** Damage and healing meter: what each unit dealt, healed and took since the match (or the last reset), with the last ten seconds for per-second numbers. */
  private meter = new Map<number, { dealt: number; healed: number; taken: number; log: { t: number; d: number; h: number }[] }>();
  private meterNow = 0;
  private meterOpen = false;
  private meterBox: HTMLElement | null = null;
  private meterPaintAt = 0;
  private setupsOpen = false;
  private setupName = '';
  /** The window paused the match when it opened (and resumes it when it closes). */
  private autoPaused = false;
  /** Skills, or every number of a class, its specs and its talents. */
  private mode: 'skills' | 'class' = 'skills';

  constructor(private hooks: Hooks, readonly layers: DataLayers) {
    this.button.id = 'devbtn'; // a HUD element: movable in the HUD editor
    this.button.title = 'Dev tools (F2)';
    this.button.setAttribute('aria-label', 'Dev tools');
    this.button.addEventListener('click', () => this.toggle());
    document.body.append(this.root, this.button);
    makeResizable(this.root, { key: 'dev', corner: 'br', minW: 240, minH: 200, z: 32 });
    this.draggable();
  }

  /** Every event of the match, for the meter (the time is the match clock in ms). */
  feed(events: readonly SimEvent[], time: number) {
    this.meterNow = time;
    for (const e of events) {
      if (e.t === 'damage') {
        const a = this.meterOf(e.src), b = this.meterOf(e.tgt);
        a.dealt += e.amount;
        a.log.push({ t: time, d: e.amount, h: 0 });
        b.taken += e.amount;
      } else if (e.t === 'heal') {
        const a = this.meterOf(e.src);
        a.healed += e.amount;
        a.log.push({ t: time, d: 0, h: e.amount });
      } else if (e.t === 'phase' && e.phase === 'live') this.meter.clear();
    }
    if (this.open && this.meterOpen && this.meterBox?.isConnected && time - this.meterPaintAt > 250) {
      this.meterPaintAt = time;
      this.paintMeter();
    }
  }

  private meterOf(id: number) {
    let m = this.meter.get(id);
    if (!m) this.meter.set(id, (m = { dealt: 0, healed: 0, taken: 0, log: [] }));
    return m;
  }

  private paintMeter() {
    const box = this.meterBox;
    if (!box) return;
    const names = new Map(this.hooks.builds().map((b) => [b.id, b]));
    const rows = [...this.meter.entries()].filter(([id]) => id > 0).sort((a, b) => b[1].dealt - a[1].dealt);
    const table = el('table', 'devp-meter');
    const head = el('tr');
    for (const h of ['Unit', 'DPS', 'Dealt', 'HPS', 'Healed', 'Taken']) head.append(el('th', '', h));
    table.append(head);
    for (const [id, m] of rows) {
      m.log = m.log.filter((x) => this.meterNow - x.t <= 10000);
      const span = Math.max(1, Math.min(10, (this.meterNow - (m.log[0]?.t ?? this.meterNow)) / 1000));
      const dps = m.log.reduce((n, x) => n + x.d, 0) / span;
      const hps = m.log.reduce((n, x) => n + x.h, 0) / span;
      const b = names.get(id);
      const tr = el('tr');
      tr.append(el('td', b && b.team === 0 ? 'tm0' : 'tm1', b?.name ?? `#${id}`), el('td', '', String(Math.round(dps))), el('td', '', String(Math.round(m.dealt))), el('td', '', String(Math.round(hps))), el('td', '', String(Math.round(m.healed))), el('td', '', String(Math.round(m.taken))));
      table.append(tr);
    }
    if (!rows.length) {
      const tr = el('tr');
      tr.append(el('td', 'devp-dim', 'Nothing yet: fight something.'));
      table.append(tr);
    }
    box.replaceChildren(table);
  }

  /** Owner only: swap the map of this test match on the fly (everyone stays, builds and numbers are kept). */
  private mapPicker(): HTMLElement {
    const row = el('div', 'devp-row');
    const ids = ARENAS.map((a) => a.id);
    const go = (id: string) => this.hooks.send({ t: 'dev_map', id });
    const sel = document.createElement('select');
    sel.title = 'Swap the map of this match at once: same units, builds, bots and numbers, everyone back at the new spawns (works while paused)';
    for (const a of ARENAS) {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.name;
      sel.append(o);
    }
    sel.value = this.hooks.mapId();
    sel.addEventListener('change', () => go(sel.value));
    const prev = el('button', 'mm-small', '◀ Prev map');
    prev.addEventListener('click', () => go(cycleArena(ids, this.hooks.mapId(), -1)));
    const next = el('button', 'mm-small', 'Next map ▶');
    next.addEventListener('click', () => go(cycleArena(ids, this.hooks.mapId(), 1)));
    row.append(prev, sel, next);
    return row;
  }

  /** The meter, the match restart and saved setups (numbers and builds you want back later). */
  private matchTools(): HTMLElement {
    const wrap = el('div', 'devp-sec tools');
    const row = el('div', 'devp-row');
    if (this.inMatch) {
      const restart = el('button', 'mm-small', '↻ Restart match');
      restart.title = 'Everyone back at the start with the same builds and numbers, full health, fighting at once';
      restart.addEventListener('click', () => {
        this.meter.clear();
        this.hooks.send({ t: 'dev_restart' });
      });
      const meter = el('button', `mm-small${this.meterOpen ? ' mm-go' : ''}`, '📊 Meter');
      meter.addEventListener('click', () => {
        this.meterOpen = !this.meterOpen;
        this.paint();
      });
      row.append(restart, meter);
      wrap.append(this.mapPicker());
    }
    const setups = el('button', `mm-small${this.setupsOpen ? ' mm-go' : ''}`, '💾 Setups');
    setups.addEventListener('click', () => {
      this.setupsOpen = !this.setupsOpen;
      this.paint();
    });
    row.append(setups);
    wrap.append(row);
    if (this.inMatch && this.meterOpen) {
      const box = el('div', 'devp-meterbox');
      this.meterBox = box;
      const reset = el('button', 'mm-small', 'Reset meter');
      reset.addEventListener('click', () => {
        this.meter.clear();
        this.paintMeter();
      });
      wrap.append(box, reset);
      this.paintMeter();
    } else this.meterBox = null;
    if (this.setupsOpen) wrap.append(this.setupsBox());
    return wrap;
  }

  private loadSetups(): DevSetup[] {
    try {
      const v = JSON.parse(localStorage.getItem('arena.devsetups') ?? '[]') as unknown;
      return Array.isArray(v) ? (v as DevSetup[]).filter((x) => x && typeof x.name === 'string' && Array.isArray(x.patches)) : [];
    } catch {
      return [];
    }
  }

  private saveSetups(list: DevSetup[]) {
    try {
      localStorage.setItem('arena.devsetups', JSON.stringify(list.slice(0, 40)));
    } catch {
      /* not remembered */
    }
  }

  /** Name what you have now (numbers, your build, the bots' builds) and bring it back with one click. */
  private setupsBox(): HTMLElement {
    const box = el('div', 'devp-setups');
    const row = el('div', 'devp-row');
    const name = el('input');
    name.type = 'text';
    name.maxLength = 40;
    name.placeholder = 'Name this setup';
    name.value = this.setupName;
    name.addEventListener('input', () => (this.setupName = name.value));
    name.addEventListener('keydown', (e) => e.stopPropagation()); // typing here never casts spells
    const save = el('button', 'mm-small mm-go', 'Save');
    save.addEventListener('click', () => {
      const label = this.setupName.trim();
      if (!label) return;
      const patches = mergePatches(this.inMatch ? this.layers.roomPatches : this.session, [...this.edits.values()]);
      const you = this.hooks.youId();
      const builds = this.inMatch
        ? this.hooks.builds().filter((b) => b.bot || b.id === you).map((b) => ({ me: b.id === you, classId: b.classId, build: { spec: b.spec ?? SPECS[b.classId][0].id, talents: [...b.talents], gear: {} } as Build }))
        : [];
      const list = this.loadSetups().filter((x) => x.name !== label);
      list.unshift({ name: label, patches, builds });
      this.saveSetups(list);
      this.setupName = '';
      this.paint();
    });
    row.append(name, save);
    box.append(row);
    const list = this.loadSetups();
    if (!list.length) box.append(el('small', 'devp-dim', 'Nothing saved yet.'));
    for (const st of list) {
      const r = el('div', 'devp-row');
      r.append(el('span', 'devp-setup-name', st.name), el('small', 'devp-dim', `${st.patches.length} number${st.patches.length === 1 ? '' : 's'}${st.builds.length ? ` · ${st.builds.length} build${st.builds.length === 1 ? '' : 's'}` : ''}`));
      const load = el('button', 'mm-small', 'Load');
      load.addEventListener('click', () => {
        this.edits.clear();
        this.hooks.send({ t: this.inMatch ? 'dev_patch' : 'dev_session', patches: st.patches });
        if (this.inMatch) {
          // your build, then the bots' builds in the order they were saved
          const you = this.hooks.youId();
          const bots = this.hooks.builds().filter((b) => b.bot);
          let i = 0;
          for (const b of st.builds) {
            const unit = b.me ? you : bots[i++]?.id;
            if (unit !== undefined && unit > 0) this.hooks.send({ t: 'dev_bot', unit, classId: b.classId, build: b.build });
          }
        }
      });
      const del = el('button', 'mm-small', '✕');
      del.addEventListener('click', () => {
        this.saveSetups(this.loadSetups().filter((x) => x.name !== st.name));
        this.paint();
      });
      r.append(load, del);
      box.append(r);
    }
    return box;
  }

  /** Drag the window by its title bar; where you leave it is remembered. */
  private draggable() {
    const KEY = 'arena.pos.dev';
    const place = (x: number, y: number) => {
      const w = this.root.offsetWidth || 300;
      this.root.style.left = `${Math.max(0, Math.min(x, window.innerWidth - Math.min(w, 120)))}px`;
      this.root.style.top = `${Math.max(0, Math.min(y, window.innerHeight - 40))}px`;
    };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as [number, number] | null;
      if (Array.isArray(saved) && saved.every((n) => Number.isFinite(n))) place(saved[0], saved[1]);
    } catch {
      /* default spot */
    }
    let drag: { dx: number; dy: number } | null = null;
    this.root.addEventListener('pointerdown', (e) => {
      const head = (e.target as HTMLElement).closest('.devp-head');
      if (!head || (e.target as HTMLElement).closest('button')) return;
      const r = this.root.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      this.root.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.root.addEventListener('pointermove', (e) => {
      if (drag) place(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      try {
        localStorage.setItem(KEY, JSON.stringify([parseInt(this.root.style.left, 10), parseInt(this.root.style.top, 10)]));
      } catch {
        /* not remembered */
      }
    };
    this.root.addEventListener('pointerup', end);
    this.root.addEventListener('pointercancel', end);
  }

  get open(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** In a match as a dev: the tools act on that match. Out of it the test numbers go (the menu mode may stay). */
  setAvailable(on: boolean) {
    this.inMatch = on;
    if (on) this.button.classList.remove('hidden');
    if (!on) {
      this.autoPaused = false;
      this.meter.clear();
      this.paused = false;
      this.edits.clear();
      this.result = null;
      this.layers.setRoom([]);
      this.button.classList.add('hidden');
      this.root.classList.add('hidden');
    }
  }

  /** Out of a match: whether a dev may open the panel from the menu (called every frame; cheap when nothing changes). */
  menuAvailable(on: boolean) {
    if (this.inMatch) return;
    const was = !this.button.classList.contains('hidden');
    if (was === on) return;
    this.button.classList.toggle('hidden', !on);
    if (!on) this.root.classList.add('hidden');
  }

  toggle(on = !this.open) {
    if (this.button.classList.contains('hidden')) return;
    this.root.classList.toggle('hidden', !on);
    if (on) {
      this.hooks.send({ t: 'dev_builds' });
      // opening the window in your own match pauses it, so you can read and edit in peace; closing it resumes
      if (this.inMatch && !this.paused && this.hooks.youId() > 0) {
        this.autoPaused = true;
        this.hooks.send({ t: 'dev_pause', on: true });
      }
      this.paint();
    } else if (this.autoPaused) {
      this.autoPaused = false;
      if (this.paused) this.hooks.send({ t: 'dev_pause', on: false });
    }
  }

  handle(m: ServerMsg) {
    if (m.t === 'dev_map') {
      this.meter.clear();
    } else if (m.t === 'dev_state') {
      this.paused = m.paused;
      this.layers.setRoom(m.patches);
      this.edits.clear();
    } else if (m.t === 'dev_session') {
      this.session = m.patches;
      this.layers.setSession(m.patches);
      if (!this.inMatch) this.edits.clear();
    }
    else if (m.t === 'dev_result') {
      this.result = { ok: m.ok, text: m.text, url: m.url };
      this.asking = false;
    }
    if (this.open) this.paint();
  }

  /** Builds arrived: the skill list can offer everyone's bars. */
  refresh() {
    if (this.open) this.paint();
  }

  /** Change a bot's class, spec and talents on the fly: pick, press Apply, and it plays the new build at once. */
  private botEditor(): HTMLElement {
    const box = el('div', 'devp-sec bots');
    const you = this.hooks.youId();
    const bots = this.hooks.builds().filter((b) => b.bot || b.id === you).sort((a, b) => Number(b.id === you) - Number(a.id === you));
    const head = el('button', 'mm-small', `${this.botsOpen ? '▾' : '▸'} Change my build and the bots' (${bots.length})`);
    head.addEventListener('click', () => {
      this.botsOpen = !this.botsOpen;
      this.hooks.send({ t: 'dev_builds' });
      this.paint();
    });
    box.append(head);
    if (!this.botsOpen) return box;
    if (!bots.length) box.append(el('small', 'devp-dim', ' No bots in this match.'));
    const select = (opts: [string, string][], value: string, on: (v: string) => void) => {
      const s = el('select', 'devp-sel');
      for (const [v, label] of opts) {
        const o = el('option', '', label);
        o.value = v;
        s.append(o);
      }
      s.value = value;
      s.addEventListener('change', () => on(s.value));
      return s;
    };
    for (const b of bots) {
      let d = this.botDraft.get(b.id);
      if (!d) {
        d = { classId: b.classId, build: { spec: b.spec ?? SPECS[b.classId][0].id, talents: [...b.talents], gear: {} } };
        this.botDraft.set(b.id, d);
      }
      const draft = d;
      const card = el('div', 'devp-bot');
      card.append(el('b', '', b.id === you ? `You · ${b.name}` : `${b.name} · team ${b.team + 1}`));
      const redraw = () => this.paint();
      const row1 = el('div', 'devp-row');
      row1.append(
        select(CLASS_IDS.map((c): [string, string] => [c, CLASSES[c].name]), draft.classId, (v) => {
          draft.classId = v as ClassId;
          draft.build = { spec: SPECS[draft.classId][0].id, talents: [], gear: {} };
          redraw();
        }),
        select(SPECS[draft.classId].map((s): [string, string] => [s.id, s.name]), draft.build.spec, (v) => {
          draft.build = { spec: v, talents: draft.build.talents.map((t, i) => (talentsFor(draft.classId, v)[i]?.some((x) => x.id === t) ? t : '')), gear: {}, ...(draft.build.replace ? { replace: draft.build.replace } : {}) };
          redraw();
        }),
      );
      card.append(row1);
      talentsFor(draft.classId, draft.build.spec).forEach((tier, i) => {
        const roman = ['I', 'II', 'III', 'IV', 'V'][i];
        const row = el('div', 'devp-row');
        row.append(
          el('small', 'devp-dim', roman),
          select([['', 'none'], ...tier.map((t): [string, string] => [t.id, t.name])], draft.build.talents[i] ?? '', (v) => {
            const talents = [...draft.build.talents];
            while (talents.length < 5) talents.push('');
            talents[i] = v;
            draft.build = { ...draft.build, talents };
            redraw();
          }),
        );
        const picked = tier.find((t) => t.id === draft.build.talents[i]);
        if (picked?.swap?.alt?.length) {
          row.append(el('small', 'devp-dim', 'replaces'), select([picked.swap.from, ...picked.swap.alt].map((a): [string, string] => [a, ABILITIES[a]?.name ?? a]), draft.build.replace?.[picked.id] ?? picked.swap.from, (v) => {
            draft.build = { ...draft.build, replace: { ...(draft.build.replace ?? {}), [picked.id]: v } };
          }));
        }
        card.append(row);
      });
      const apply = el('button', 'mm-small mm-go', b.id === you ? 'Apply to me' : 'Apply to this bot');
      apply.addEventListener('click', () => {
        const talents = [...draft.build.talents];
        while (talents.length < 5) talents.push('');
        this.botDraft.delete(b.id);
        this.hooks.send({ t: 'dev_bot', unit: b.id, classId: draft.classId, build: { ...draft.build, talents } });
      });
      card.append(apply);
      box.append(card);
    }
    return box;
  }

  private key = (p: Pick<DataPatch, 'file' | 'id' | 'path'>) => `${p.file}:${p.id}:${p.path.join('.')}`;

  private paint() {
    const r = this.root;
    r.replaceChildren();
    const head = el('div', 'devp-head');
    head.append(el('b', '', '🛠 Dev tools'));
    const close = el('button', 'mm-small', '✕');
    close.addEventListener('click', () => this.toggle(false));
    head.append(close);
    r.append(head);

    let ids: string[];
    if (this.inMatch) {
      const row = el('div', 'devp-row');
      const pause = el('button', `mm-small${this.paused ? ' mm-go' : ''}`, this.paused ? '▶ Resume' : '⏸ Pause');
      pause.addEventListener('click', () => {
        this.autoPaused = false; // your own choice from now on
        this.hooks.send({ t: 'dev_pause', on: !this.paused });
      });
      row.append(pause, el('small', 'devp-dim', this.layers.roomPatches.length ? `${this.layers.roomPatches.length} test number${this.layers.roomPatches.length === 1 ? '' : 's'} in this match` : 'Real numbers'));
      r.append(row);
      // the skills in this match: yours first, then everyone else's
      ids = [...new Set([...this.hooks.myBar(), ...this.hooks.builds().flatMap((b) => b.bar)])].filter((id) => ABILITIES[id]);
      // the trinkets are tier IV picks on every class: offered after the bars
      for (const id of Object.keys(ABILITIES)) if (ABILITIES[id].class === 'trinket' && !ABILITIES[id].retired) ids.push(id);
    } else {
      // in the menu: every skill of a class; changes go to your session (every match you start) or to everyone
      r.append(el('small', 'devp-dim', 'From the menu: "Keep for my session" puts your numbers in every match you start (not ranked); "Send to the admin panel" proposes them to the owner (nothing is live until the owner acts).'));
      const cls = this.menuCls ?? this.hooks.menuClass();
      const tabs = el('div', 'devp-row');
      for (const c of CLASS_IDS) {
        const b = el('button', `mm-small${c === cls ? ' mm-go' : ''}`, CLASSES[c].name);
        b.addEventListener('click', () => {
          this.menuCls = c;
          this.pick = '';
          this.paint();
        });
        tabs.append(b);
      }
      r.append(tabs);
      ids = Object.keys(ABILITIES).filter((id) => !ABILITIES[id].retired && (ABILITIES[id].class === cls || ABILITIES[id].class === 'trinket'));
    }
    const testing = new Map((this.inMatch ? this.layers.roomPatches : this.session).map((p) => [this.key(p), p]));
    r.append(this.matchTools());
    if (this.inMatch) r.append(this.botEditor());
    const modes = el('div', 'devp-row');
    for (const [id, label] of [['skills', 'Skills'], ['class', 'Class, specs and talents']] as const) {
      const b = el('button', `mm-small${this.mode === id ? ' mm-go' : ''}`, label);
      b.addEventListener('click', () => {
        this.mode = id;
        this.paint();
      });
      modes.append(b);
    }
    r.append(modes);
    if (this.mode === 'class') {
      r.append(this.classView(testing));
      this.tail(r, false);
      return;
    }
    if (!this.pick || !ids.includes(this.pick)) this.pick = ids[0] ?? '';
    const picker = el('div', 'devp-skills');
    for (const id of ids) {
      const b = el('button', `devp-skill${id === this.pick ? ' sel' : ''}`, ABILITY_ICON[id] ?? '✦');
      b.dataset.tip = `ability:${id}`;
      b.addEventListener('click', () => {
        this.pick = id;
        this.paint();
      });
      picker.append(b);
    }
    r.append(picker);
    if (!this.pick) return;
    r.append(el('div', 'devp-title', ABILITIES[this.pick].name));

    const info = skillInfo(this.pick);
    // how the skill behaves, as chips (hover for what each means)
    const chips = el('div', 'devp-chips');
    for (const f of info.flags) {
      const c = el('span', `devp-chip ${f.tone}`, f.label);
      c.title = f.tip;
      chips.append(c);
    }
    r.append(chips);
    for (const sec of info.sections) {
      const box = el('div', `devp-sec ${sec.kind === 'aura' ? 'effect' : sec.kind}`);
      const head = el('div', 'devp-sec-head');
      head.append(el('b', '', sec.kind === 'aura' ? `✦ ${sec.name}` : sec.name), el('small', 'devp-dim', ` ${sec.link}`));
      box.append(head);
      if (sec.from.length) box.append(el('div', 'devp-from', `From: ${sec.from.join(' · ')}`));
      if (sec.does.length) box.append(el('div', 'devp-does', sec.does.join(' · ')));
      if (sec.options) box.append(this.optionsBox(sec.id, sec.options, testing));
      const list = this.fieldList(sec.fields, testing);
      if (!sec.fields.length) list.append(el('small', 'devp-dim', 'No numbers to tune.'));
      box.append(list);
      r.append(box);
    }
    if (info.modifiers.length) {
      const box = el('div', 'devp-sec mods');
      box.append(el('b', '', 'Also changed by'));
      const ul = el('ul', 'devp-mods');
      for (const m of info.modifiers) {
        const li = el('li');
        li.append(el('b', '', m.name), el('small', 'devp-dim', ` (${m.where})`), el('div', '', m.text));
        if (m.fields.length) li.append(this.fieldList(m.fields, testing));
        ul.append(li);
      }
      box.append(ul);
      r.append(box);
    }

    this.tail(r, true);
  }

  /** The buttons that try, keep, send or clear the changes, then (for skills) Ask Claude and a note, and the last result. */
  private tail(r: HTMLElement, withAsk: boolean) {
    const acts = el('div', 'devp-row');
    const tryIt = el('button', 'mm-small mm-go', 'Try in this match');
    tryIt.addEventListener('click', () => this.hooks.send({ t: 'dev_patch', patches: mergePatches(this.layers.roomPatches, [...this.edits.values()]) }));
    const reset = el('button', 'mm-small', 'Put all back');
    reset.addEventListener('click', () => {
      this.edits.clear();
      this.hooks.send({ t: 'dev_patch', patches: [] });
    });
    const save = el('button', 'mm-small', 'Send to the admin panel…');
    save.title = 'Sends these changes, with the old and new numbers, to the owner\'s admin panel. Nothing goes live until the owner acts on it.';
    save.addEventListener('click', () => {
      const all = mergePatches(this.inMatch ? this.layers.roomPatches : this.session, [...this.edits.values()]);
      if (!all.length) {
        this.result = { ok: false, text: 'Change a number first.' };
        return this.paint();
      }
      if (!window.confirm(`Send ${all.length} changed number${all.length === 1 ? '' : 's'} to the owner's admin panel? Nothing goes live until the owner applies it.`)) return;
      this.hooks.send({ t: 'dev_save', patches: all, ...(this.note.trim() ? { note: this.note.trim() } : {}) });
    });
    const commit = el('button', 'mm-small', 'Commit to GitHub');
    commit.title = 'Commits these numbers straight to the main branch on GitHub (the data files only). There is no review: the game updates when the next deploy finishes.';
    commit.addEventListener('click', () => {
      const all = mergePatches(this.inMatch ? this.layers.roomPatches : this.session, [...this.edits.values()]);
      if (!all.length) {
        this.result = { ok: false, text: 'Change a number first.' };
        return this.paint();
      }
      if (!window.confirm(`Commit ${all.length} changed number${all.length === 1 ? '' : 's'} straight to the main branch on GitHub? There is no review and the live game updates on the next deploy.`)) return;
      this.hooks.send({ t: 'dev_commit', patches: all, ...(this.note.trim() ? { note: this.note.trim() } : {}) });
    });
    const keep = el('button', 'mm-small mm-go', 'Keep for my session');
    keep.title = 'Every match you start (not ranked) uses these numbers until you clear them or sign out, so you can keep testing across matches';
    keep.addEventListener('click', () => {
      const all = mergePatches(mergePatches(this.session, this.layers.roomPatches), [...this.edits.values()]);
      if (!all.length) {
        this.result = { ok: false, text: 'Change a number first.' };
        return this.paint();
      }
      this.hooks.send({ t: 'dev_session', patches: all });
    });
    if (this.inMatch) acts.append(tryIt, keep, reset, save, commit);
    else acts.append(keep, save, commit);
    r.append(acts);
    if (this.session.length) {
      const srow = el('div', 'devp-row');
      srow.append(el('small', 'devp-dim', `🔁 ${this.session.length} number${this.session.length === 1 ? '' : 's'} kept for your session`));
      const clear = el('button', 'mm-small', 'Clear session');
      clear.addEventListener('click', () => this.hooks.send({ t: 'dev_session', patches: [] }));
      srow.append(clear);
      r.append(srow);
    }

    if (withAsk) {
      // ask Claude: plain words in, number changes out, tried in this match at once
      const askBox = el('textarea', 'devp-note devp-ask');
      askBox.placeholder = `🤖 Ask Claude to change ${(ABILITIES[this.pick]?.name ?? 'a skill')} (e.g. "hit 20% harder but cost more", "slow lasts 2s less")`;
      askBox.maxLength = 600;
      askBox.value = this.ask;
      askBox.addEventListener('input', () => (this.ask = askBox.value));
      // Enter sends (Shift+Enter for a new line)
      askBox.addEventListener('keydown', (e) => {
        e.stopPropagation(); // typing here never casts spells
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          askGo.click();
        }
      });
      const askGo = el('button', 'mm-small mm-go', this.asking ? 'Claude is thinking…' : '🤖 Ask Claude');
      askGo.disabled = this.asking;
      askGo.addEventListener('click', () => {
        if (!this.ask.trim()) return;
        this.asking = true;
        this.result = null;
        this.hooks.send({ t: 'dev_ai', ability: this.pick, text: this.ask.trim() });
        this.paint();
      });
      r.append(askBox, askGo);

      const noteBox = el('textarea', 'devp-note');
      noteBox.placeholder = `A note on ${(ABILITIES[this.pick]?.name ?? 'a skill')} for the owner (sent to Discord)`;
      noteBox.maxLength = 600;
      noteBox.value = this.note;
      noteBox.addEventListener('input', () => (this.note = noteBox.value));
      const send = el('button', 'mm-small', 'Send note');
      send.addEventListener('click', () => {
        if (!this.note.trim()) return;
        this.hooks.send({ t: 'dev_note', ability: this.pick, text: this.note.trim() });
        this.note = '';
        noteBox.value = '';
      });
      r.append(noteBox, send);


    }
    if (this.result) {
      const res = el('div', `devp-result ${this.result.ok ? 'ok' : 'bad'}`, this.result.text);
      if (this.result.url) {
        const a = el('a', '', ' Open the pull request');
        a.href = this.result.url;
        a.target = '_blank';
        a.rel = 'noopener';
        res.append(a);
      }
      r.append(res);
    }
  }

  /** A skill's yes/no options (global cooldown, facing, works while stunned...) as tick boxes and its target and school as lists. */
  private optionsBox(abilityId: string, o: NonNullable<ReturnType<typeof skillInfo>['sections'][number]['options']>, testing: Map<string, DataPatch>): HTMLElement {
    const box = el('div', 'devp-options');
    for (const f of o.flags) {
      const path = [f.key];
      const k = this.key({ file: 'abilities', id: abilityId, path });
      const changed = () => testing.has(k) || this.edits.has(k);
      const row = el('label', `devp-opt${changed() ? ' changed' : ''}`);
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = Number(this.edits.get(k)?.value ?? f.value) === 1;
      cb.addEventListener('change', () => {
        this.edits.set(k, { file: 'abilities', id: abilityId, path, value: cb.checked ? 1 : 0 });
        row.classList.add('changed');
      });
      row.append(cb, el('span', '', f.label));
      box.append(row);
    }
    for (const c of o.choices) {
      const path = [c.key];
      const k = this.key({ file: 'abilities', id: abilityId, path });
      const row = el('label', `devp-opt${testing.has(k) || this.edits.has(k) ? ' changed' : ''}`);
      const sel = el('select', 'devp-sel');
      for (const v of c.options) {
        const op = el('option', '', v.replace(/_/g, ' '));
        op.value = v;
        sel.append(op);
      }
      sel.value = String(this.edits.get(k)?.value ?? c.value);
      sel.addEventListener('change', () => {
        this.edits.set(k, { file: 'abilities', id: abilityId, path, value: sel.value });
        row.classList.add('changed');
      });
      row.append(el('span', '', c.label), sel);
      box.append(row);
    }
    return box;
  }

  /** One row per number: its name and a box to type the new value in (green once changed). */
  private fieldList(fields: TunableNumber[], testing: Map<string, DataPatch>): HTMLElement {
    const list = el('div', 'devp-fields');
    for (const t of fields) {
      const k = this.key(t);
      const f = el('label', `devp-field${testing.has(k) || this.edits.has(k) ? ' changed' : ''}`);
      const input = el('input');
      input.type = 'number';
      input.step = 'any';
      input.value = String(this.edits.get(k)?.value ?? t.value);
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        this.edits.set(k, { file: t.file, id: t.id, path: t.path, value: v });
        f.classList.add('changed');
      });
      f.append(el('span', '', t.label), input);
      list.append(f);
    }
    return list;
  }

  /** Every number of a class (health, resource, auto-attack), of each of its specs (bonuses, weapon swing) and of every talent. */
  private classView(testing: Map<string, DataPatch>): HTMLElement {
    const wrap = el('div');
    const me = this.hooks.builds().find((b) => b.id === this.hooks.youId());
    const cls = this.menuCls ?? (this.inMatch && me ? me.classId : this.hooks.menuClass());
    const tabs = el('div', 'devp-row');
    for (const c of CLASS_IDS) {
      const b = el('button', `mm-small${c === cls ? ' mm-go' : ''}`, CLASSES[c].name);
      b.addEventListener('click', () => {
        this.menuCls = c;
        this.pick = '';
        this.paint();
      });
      tabs.append(b);
    }
    wrap.append(tabs);
    const clean = (fields: TunableNumber[], strip: string[]) => fields.map((f) => ({ ...f, label: f.path.filter((k) => !strip.includes(String(k))).join(' · ') }));
    const section = (title: string, sub: string, fields: TunableNumber[], open = false) => {
      const box = el('details', 'devp-sec');
      box.open = open;
      const sum = el('summary', 'devp-sec-head');
      sum.append(el('b', '', title), el('small', 'devp-dim', ` ${sub} · ${fields.length} numbers`));
      box.append(sum, fields.length ? this.fieldList(fields, testing) : el('small', 'devp-dim', 'No numbers to tune.'));
      return box;
    };
    wrap.append(section(`${CLASSES[cls].name}`, 'class: health, resource, auto-attack', clean(tunableNumbers('classes', cls), []), true));
    for (const sp of SPECS[cls]) {
      wrap.append(section(sp.name, 'spec: bonuses and weapon', clean(tunableNumbers('specs', sp.id), ['mods']), true));
    }
    // talents: the shared tiers once, the spec tiers under their spec
    const seen = new Set<string>();
    TALENTS[cls][SPECS[cls][0].id].forEach((tier, ti) => {
      for (const t of tier) {
        const id = t.id;
        if (seen.has(id)) continue;
        seen.add(id);
        wrap.append(section(`${['I', 'II', 'III', 'IV', 'V'][ti]} · ${t.name}`, 'talent', clean(tunableNumbers('talents', id), ['mods', 'ability'])));
      }
    });
    for (const sp of SPECS[cls]) {
      (TALENTS[cls][sp.id] ?? []).forEach((tier, ti) => {
        for (const t of tier) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          wrap.append(section(`${sp.name} · ${['I', 'II', 'III', 'IV', 'V'][ti]} · ${t.name}`, 'talent', clean(tunableNumbers('talents', t.id), ['mods', 'ability'])));
        }
      });
    }
    return wrap;
  }
}
