import { ABILITIES, ARENAS, CLASSES, CLASS_IDS, SPECS, applyPatches, mergePatches, talentsFor } from '@arena/shared';
import type { Build, DevCommitRow, ClassId, ClientMsg, DataPatch, ServerMsg, SimEvent, UnitBuild } from '@arena/shared';
import { ABILITY_ICON } from './icons';
import { invalidateTip } from './tooltip';
import { makeResizable } from './resizable';
import { cycleArena } from './mapCycle';
import { DevWorkspace } from './devPages';
import { designer } from './designer';

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
  /** The pages and number editor (shared with the admin panel's Tuning tab). */
  private ws: DevWorkspace;
  /** What the window shows: the values to edit, the match tools, or Ask Claude. */
  private section: 'values' | 'match' | 'ask' = 'values';
  private drawerOpen = false;
  private get edits() {
    return this.ws.set;
  }
  private result: { ok: boolean; text: string; url?: string } | null = null;
  private note = '';
  /** Numbers kept for this session (the server puts them into every match the dev starts). */
  private session: DataPatch[] = [];
  /** In a match the tools act on it; in the menu changes go to the dev's session or to everyone. */
  private inMatch = false;
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

  constructor(private hooks: Hooks, readonly layers: DataLayers) {
    this.button.id = 'devbtn'; // a HUD element: movable in the HUD editor
    this.button.title = 'Dev tools (F2)';
    this.button.setAttribute('aria-label', 'Dev tools');
    this.button.addEventListener('click', () => this.toggle());
    document.body.append(this.root, this.button);
    this.ws = new DevWorkspace({
      testing: () => new Map(this.inEffect().map((p) => [this.key(p), p])),
      inEffect: () => this.inEffect(),
      canRevert: true,
      onEdit: () => this.refreshBar(),
      repaint: () => this.paint(),
      startClass: () => this.startClass(),
      matchSkills: () => (this.inMatch ? this.matchSkills() : []),
      onSelect: () => (this.section === 'ask' || this.drawerOpen ? this.paint() : undefined),
    });
    designer.onChange(() => this.open && this.paint());
    makeResizable(this.root, { key: 'dev2', corner: 'br', minW: 300, minH: 260, z: 32 });
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
      const patches = this.toSend();
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
    if (!on) this.watchDeploy();
    if (on) {
      this.hooks.send({ t: 'dev_builds' });
      this.hooks.send({ t: 'dev_commits' });
      this.hooks.send({ t: 'dev_requests', op: 'list' });
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

  /** Recent commits to GitHub and the version the server runs; polled while a commit is still deploying. */
  private commits: { rows: DevCommitRow[]; running: string } | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  private static newer(a: string, b: string): boolean {
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  }

  /** While any commit is newer than what the server runs, ask the server's status page (it keeps answering across a restart). */
  private watchDeploy() {
    const waiting = !!this.commits?.rows.some((r) => DevPanel.newer(r.version, this.commits!.running));
    if (!waiting || !this.open) {
      if (this.poll) clearInterval(this.poll);
      this.poll = null;
      return;
    }
    if (this.poll) return;
    this.poll = setInterval(() => {
      fetch('/api/status', { cache: 'no-store' })
        .then((r) => r.json())
        .then((j: { version?: string }) => {
          if (this.commits && typeof j.version === 'string' && j.version !== this.commits.running) {
            this.commits.running = j.version;
            this.watchDeploy();
            if (this.open) this.paint();
          }
        })
        .catch(() => undefined);
    }, 15000);
  }

  /** "Your commits": each patch and whether the game is running it yet. */
  private commitsBox(): HTMLElement | null {
    const c = this.commits;
    if (!c?.rows.length) return null;
    const box = el('div', 'devp-sec');
    box.append(el('b', '', 'Commits to GitHub'));
    for (const r of c.rows.slice(0, 5)) {
      const live = !DevPanel.newer(r.version, c.running);
      const line = el('div', 'devp-commit');
      line.append(
        el('span', live ? 'devp-ok' : 'devp-dim', live ? '✅ Live' : '⏳ Deploying…'),
        el('span', '', ` patch ${r.version} · ${r.by} · ${new Date(r.at).toLocaleTimeString()} · ${r.lines.length} change${r.lines.length === 1 ? '' : 's'}`),
      );
      if (r.url) {
        const a = el('a', '', ' view');
        a.href = r.url;
        a.target = '_blank';
        a.rel = 'noopener';
        line.append(a);
      }
      line.title = r.lines.join('\n');
      box.append(line);
      // the patch notes this commit put out, under who pushed them
      const notes = el('ul', 'devp-commit-notes');
      for (const l of r.lines.slice(0, 6)) notes.append(el('li', 'devp-dim', l));
      if (r.lines.length > 6) notes.append(el('li', 'devp-dim', `and ${r.lines.length - 6} more`));
      box.append(notes);
    }
    const waiting = c.rows.some((r) => DevPanel.newer(r.version, c.running));
    box.append(el('small', 'devp-dim', waiting ? `The game is on patch ${c.running} now. This updates by itself when the deploy finishes (a minute or two); then refresh the page with Ctrl+Shift+R.` : `The game is running patch ${c.running}. Refresh the page (Ctrl+Shift+R) to play on it.`));
    return box;
  }

  handle(m: ServerMsg) {
    if (m.t === 'dev_commits') {
      this.commits = { rows: m.rows, running: m.running };
      this.watchDeploy();
    } else if (m.t === 'dev_map') {
      this.meter.clear();
    } else if (m.t === 'dev_state') {
      this.paused = m.paused;
      // what was typed stays when only the pause changed; new numbers in the match replace it
      const same = JSON.stringify(m.patches) === JSON.stringify(this.layers.roomPatches);
      this.layers.setRoom(m.patches);
      if (!same || m.reset) this.edits.clear();
    } else if (m.t === 'dev_session') {
      this.session = m.patches;
      this.layers.setSession(m.patches);
      if (!this.inMatch) this.edits.clear();
    }
    else if (m.t === 'dev_result') {
      this.result = { ok: m.ok, text: m.text, url: m.url };
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

  /** The numbers in effect that the pages compare against: the match's test numbers, or in the menu the session's. */
  private inEffect(): DataPatch[] {
    return this.inMatch ? this.layers.roomPatches : this.session;
  }

  /** The class the pages open on: yours in a match, else the one picked in the menu. */
  private startClass(): ClassId {
    const me = this.hooks.builds().find((b) => b.id === this.hooks.youId());
    return this.inMatch && me ? me.classId : this.hooks.menuClass();
  }

  /** The skills in this match: yours first, then everyone else's, then the trinkets. */
  private matchSkills(): string[] {
    const ids = [...new Set([...this.hooks.myBar(), ...this.hooks.builds().flatMap((b) => b.bar)])].filter((id) => ABILITIES[id]);
    for (const id of Object.keys(ABILITIES)) if (ABILITIES[id].class === 'trinket' && !ABILITIES[id].retired && !ids.includes(id)) ids.push(id);
    return ids;
  }

  /** Everything to send with "Keep", "Send" and "Commit": what is in effect, minus what was put back, plus what was typed. */
  private toSend(): DataPatch[] {
    return this.edits.patches(this.inEffect());
  }

  private changesBtn: HTMLButtonElement | null = null;
  private drawerList: HTMLElement | null = null;

  /** A value was typed or reset: the counter and the open changes list follow without drawing the pages again. */
  private refreshBar() {
    const n = this.ws.changeCount();
    if (this.changesBtn) this.changesBtn.textContent = `Changes (${n})`;
    if (this.drawerList?.isConnected) this.drawerList.replaceChildren(this.ws.changesList());
  }

  private scrollOf(sel: string): number {
    return this.root.querySelector<HTMLElement>(sel)?.scrollTop ?? 0;
  }

  private paint() {
    const r = this.root;
    const keep = { body: this.scrollOf('.devp-body'), nav: this.scrollOf('.devp-nav'), detail: this.scrollOf('.devp-detail'), drawer: this.scrollOf('.devp-drawer') };
    r.replaceChildren();
    const head = el('div', 'devp-head');
    const title = el('div', 'devp-title-row');
    title.append(el('b', '', '🛠 Dev tools'));
    const room = this.layers.roomPatches.length;
    title.append(el('small', 'devp-dim', this.inMatch ? (room ? `${room} test number${room === 1 ? '' : 's'} in this match` : 'Real numbers') : 'Menu'));
    head.append(title);
    const secs = el('div', 'devp-sections');
    for (const [id, label] of [['values', 'Edit values'], ['match', 'Match tools'], ['ask', 'Ask Claude']] as const) {
      const b = el('button', `devp-sec-tab${this.section === id ? ' sel' : ''}`, label);
      b.addEventListener('click', () => {
        this.section = id;
        this.paint();
      });
      secs.append(b);
    }
    head.append(secs);
    const hr = el('div', 'devp-row');
    if (this.inMatch) {
      const pause = el('button', `mm-small${this.paused ? ' mm-go' : ''}`, this.paused ? '▶ Resume' : '⏸ Pause');
      pause.addEventListener('click', () => {
        this.autoPaused = false; // your own choice from now on
        this.hooks.send({ t: 'dev_pause', on: !this.paused });
      });
      hr.append(pause);
    }
    const close = el('button', 'mm-small', '✕');
    close.addEventListener('click', () => this.toggle(false));
    hr.append(close);
    head.append(hr);
    r.append(head, this.toolbar());
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
    if (this.drawerOpen) r.append(this.drawer());

    const body = el('div', `devp-body ${this.section}`);
    if (this.section === 'values') body.append(this.ws.render());
    else if (this.section === 'match') body.append(this.matchSection());
    else body.append(this.askSection());
    r.append(body);
    body.scrollTop = keep.body;
    const nav = r.querySelector<HTMLElement>('.devp-nav');
    const detail = r.querySelector<HTMLElement>('.devp-detail');
    if (nav) nav.scrollTop = keep.nav;
    if (detail) detail.scrollTop = keep.detail;
    const drawer = r.querySelector<HTMLElement>('.devp-drawer');
    if (drawer) drawer.scrollTop = keep.drawer;
  }

  /** The actions, always in view: try the changes, keep them, send them, commit them, redeploy, put everything back. */
  private toolbar(): HTMLElement {
    const acts = el('div', 'devp-toolbar');
    const tryIt = el('button', 'mm-small mm-go', 'Try in this match');
    tryIt.title = 'Everyone in this match plays on these numbers at once (the match no longer counts)';
    tryIt.addEventListener('click', () => this.hooks.send({ t: 'dev_patch', patches: this.toSend() }));
    const reset = el('button', 'mm-small', 'Put all back');
    reset.title = this.inMatch ? 'Back to the real numbers in this match' : 'Forget what you typed and the numbers kept for your session';
    reset.addEventListener('click', () => {
      this.edits.clear();
      if (this.inMatch) this.hooks.send({ t: 'dev_patch', patches: [] });
      else {
        this.hooks.send({ t: 'dev_session', patches: [] });
        this.paint();
      }
    });
    const nothing = () => {
      this.result = { ok: false, text: 'Change a number first.' };
      this.paint();
    };
    const save = el('button', 'mm-small', 'Send to the admin panel…');
    save.title = "Sends these changes, with the old and new numbers, to the owner's admin panel. Nothing goes live until the owner acts on it.";
    save.addEventListener('click', () => {
      const all = this.toSend();
      if (!all.length) return nothing();
      if (!window.confirm(`Send ${all.length} changed number${all.length === 1 ? '' : 's'} to the owner's admin panel? Nothing goes live until the owner applies it.`)) return;
      this.hooks.send({ t: 'dev_save', patches: all, ...(this.note.trim() ? { note: this.note.trim() } : {}) });
    });
    const keep = el('button', 'mm-small mm-go', 'Keep for my session');
    keep.title = 'Every match you start (not ranked) uses these numbers until you clear them or sign out, so you can keep testing across matches';
    keep.addEventListener('click', () => {
      const all = this.edits.patches(mergePatches(this.session, this.layers.roomPatches));
      if (!all.length) return nothing();
      this.hooks.send({ t: 'dev_session', patches: all });
    });
    const changes = el('button', `mm-small devp-changes-btn${this.drawerOpen ? ' mm-go' : ''}`, `Changes (${this.ws.changeCount()})`);
    changes.title = 'Every changed number as old -> new, with an undo for each';
    changes.addEventListener('click', () => {
      this.drawerOpen = !this.drawerOpen;
      this.paint();
    });
    this.changesBtn = changes;
    if (this.inMatch) acts.append(tryIt, keep, save, reset, changes);
    else acts.append(keep, save, reset, changes);
    return acts;
  }

  /** The "changes so far" list with the session's numbers and the recent commits. */
  private drawer(): HTMLElement {
    const box = el('div', 'devp-drawer');
    box.append(el('b', '', 'Changes so far'));
    const list = el('div');
    list.append(this.ws.changesList());
    this.drawerList = list;
    box.append(list);
    if (this.session.length) {
      const srow = el('div', 'devp-row');
      srow.append(el('small', 'devp-dim', `🔁 ${this.session.length} number${this.session.length === 1 ? '' : 's'} kept for your session`));
      const clear = el('button', 'mm-small', 'Clear session');
      clear.addEventListener('click', () => this.hooks.send({ t: 'dev_session', patches: [] }));
      srow.append(clear);
      box.append(srow);
    }
    const done = this.commitsBox();
    if (done) box.append(done);
    return box;
  }

  /** Pause, restart, map, meter, saved setups and the bots' builds. */
  private matchSection(): HTMLElement {
    const wrap = el('div', 'devp-matchtab');
    if (!this.inMatch) wrap.append(el('small', 'devp-dim', 'From the menu: "Keep for my session" puts your numbers in every match you start (not ranked); "Send to the admin panel" proposes them to the owner (nothing is live until the owner acts). The match tools below need a match.'));
    wrap.append(this.matchTools());
    if (this.inMatch) wrap.append(this.botEditor());
    return wrap;
  }

  /** The chat about the skill or class on show, the dev's change requests and a note to the owner. */
  private askSection(): HTMLElement {
    const wrap = el('div', 'devp-asktab');
    const scope = this.ws.chatScope();
    wrap.append(el('small', 'devp-dim', `Asking about ${scope.name}. Open another skill or class under Edit values to ask about that.`));
    wrap.append(designer.renderChat(scope, this.hooks.send, false));
    const mine = designer.renderRequests(true);
    if (mine) wrap.append(mine);
    const ability = scope.ability;
    const noteBox = el('textarea', 'devp-note');
    noteBox.placeholder = ability ? `A note on ${ABILITIES[ability]?.name ?? 'a skill'} for the owner (sent to Discord)` : 'Open a skill on the Skills page to leave a note on it for the owner';
    noteBox.maxLength = 600;
    noteBox.disabled = !ability;
    noteBox.value = this.note;
    noteBox.addEventListener('input', () => (this.note = noteBox.value));
    noteBox.addEventListener('keydown', (e) => e.stopPropagation());
    const send = el('button', 'mm-small', 'Send note');
    send.disabled = !ability;
    send.addEventListener('click', () => {
      if (!this.note.trim() || !ability) return;
      this.hooks.send({ t: 'dev_note', ability, text: this.note.trim() });
      this.note = '';
      noteBox.value = '';
    });
    wrap.append(noteBox, send);
    return wrap;
  }
}
