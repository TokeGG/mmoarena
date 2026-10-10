import { applyModelData } from './modelData';
import { ABILITIES, allArenas, CLASSES, CLASS_IDS, SPECS, applyPatches, mergePatches, talentsFor } from '@arena/shared';
import type { Build, DevCommitRow, DevPageId, ClassId, ClientMsg, DataPatch, ServerMsg, SimEvent, UnitBuild } from '@arena/shared';
import { refreshIcons } from './iconArt';
import { invalidateTip } from './tooltip';
import { cycleArena } from './mapCycle';
import { DevWorkspace } from './devPages';
import { tours } from './tour';
import { designer } from './designer';
import { noteBox } from './botNoteUi';

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
  private hadModels = false;
  private hadPreview = false;
  /** Takes the typed (not yet kept) Models numbers off the data again. */
  private previewUndo: (() => void) | null = null;
  /** The Models page's typed numbers show on the characters at once (the model view, and the game's models), before anything is kept or tried. */
  previewModels(typed: readonly DataPatch[]) {
    const mine = typed.filter((p) => p.file === 'models');
    if (!mine.length && !this.previewUndo) return;
    this.previewUndo?.();
    this.previewUndo = mine.length ? applyPatches(mine) : null;
    this.hadPreview = true;
    applyModelData();
  }
  private apply() {
    this.previewUndo?.();
    this.previewUndo = null;
    this.undo?.();
    const a = applyPatches(this.live);
    const s = applyPatches(this.session);
    const b = applyPatches(this.room);
    this.undo = () => {
      b();
      s();
      a();
    };
    // the Models page's numbers are merged over the model registry, and the characters are rebuilt, only while some are in effect (and once more when they go)
    const modelsNow = [...this.live, ...this.session, ...this.room].some((p) => p.file === 'models');
    if (modelsNow || this.hadModels || this.hadPreview) applyModelData();
    this.hadPreview = false;
    this.hadModels = modelsNow;
    invalidateTip(); // open tooltips redraw with the new numbers
    refreshIcons(); // and every icon on the screen with the new pictures
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
  /** Watching a match (not playing in it): opening the window must not pause it. */
  spectating?(): boolean;
  /** The map of the match being played or watched. */
  mapId(): string;
  /** In the menu: the class picked there, whose skills the panel opens on. */
  menuClass(): ClassId;
  /** Whether the signed-in account is the owner. */
  isOwner(): boolean;
  /** The id of the match being played or watched when it has bots (a note for the bots can be written for it), else null. */
  noteMatch?(): string | null;
}

/**
 * Dev tools in a match: pause it, change any number on a skill (and on the effects it puts on people), try it at once,
 * then keep it for everyone or put it back; and send the owner a note about a skill. In any match that is not ranked:
 * everyone in it gets the same test numbers and is told, and the match stops counting.
 */
export class DevPanel {
  readonly root = el('div', 'devp embed');
  /** The tools window shows this tab (set by the window; the panel pauses and polls only while it does). */
  private shown = false;
  /** Set by the tools window: the pause button, the status and the title bar follow the panel. */
  onChrome?: () => void;
  /** Set by the tools window: the match went away under an open window (close it). */
  onGone?: () => void;
  /** Set by the tools window: the 🛠 button was pressed. */
  onButton?: () => void;
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
  /** The numbers kept for everyone this session (the owner's button), which every match uses. */
  private everyone: DataPatch[] = [];
  /** In a match the tools act on it; in the menu changes go to the dev's session or to everyone. */
  private inMatch = false;
  /** Bots being edited: the class and build chosen for each, until applied. */
  private botDraft = new Map<number, { classId: ClassId; build: Build }>();
  private botsOpen = false;
  /** Damage and healing meter: what each unit dealt, healed and took since the match (or the last reset), with the last ten seconds for per-second numbers. */
  private meter = new Map<number, { dealt: number; healed: number; taken: number; log: { t: number; d: number; h: number }[] }>();
  private meterNow = 0;
  private meterOpen = false;
  private noteOpen = false;
  private meterBox: HTMLElement | null = null;
  private meterPaintAt = 0;
  private setupsOpen = false;
  private setupName = '';
  /** The window paused the match when it opened (and resumes it when it closes). */
  private autoPaused = false;
  /** Live mode (the default): opening the window does not pause the match and every number you change is tried in it a moment later. Off: it pauses and "Try in this match" sends. */
  private live = (() => {
    try {
      return localStorage.getItem('arena.devlive') !== '0';
    } catch {
      return true;
    }
  })();
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the last change did, in words, so there is never a doubt whether it went in (shown by the toolbar). */
  private saveNote = '';
  private noteNow(text: string) {
    this.saveNote = `✓ ${new Date().toLocaleTimeString()}  ${text}`;
  }

  /** Live mode: send what was typed to the match shortly after the last keystroke. */
  private autoApply() {
    if (!this.live || !this.inMatch) return;
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null;
      if (this.live && this.inMatch) this.hooks.send({ t: 'dev_patch', patches: this.toSend() });
    }, 350);
  }

  constructor(private hooks: Hooks, readonly layers: DataLayers) {
    this.button.id = 'devbtn'; // a HUD element: movable in the HUD editor
    this.button.title = 'Dev and admin tools (F2 opens and closes, Shift+F2 switches tab)';
    this.button.setAttribute('aria-label', 'Dev tools');
    this.button.addEventListener('click', () => this.onButton?.());
    document.body.append(this.button);
    this.ws = new DevWorkspace({
      testing: () => new Map(this.inEffect().map((p) => [this.key(p), p])),
      inEffect: () => this.inEffect(),
      canRevert: true,
      onEdit: () => {
        this.refreshBar();
        this.layers.previewModels(this.toSend());
        this.autoApply();
      },
      saveTitle: "Saves what you picked: sends it to the admin panel's Proposals list, where it can be committed.",
      save: () => {
        const all = this.toSend();
        if (!all.length) return 'Nothing to save yet.';
        this.hooks.send({ t: 'dev_save', patches: all });
        return 'Saved: it is on the Proposals list in the admin panel.';
      },
      repaint: () => this.paint(),
      startClass: () => this.startClass(),
      matchSkills: () => (this.inMatch ? this.matchSkills() : []),
      onSelect: () => (this.section === 'ask' || this.drawerOpen ? this.paint() : undefined),
    });
    designer.onChange(() => this.open && this.paint());
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
    const ids = allArenas().map((a) => a.id);
    const go = (id: string) => this.hooks.send({ t: 'dev_map', id });
    const sel = document.createElement('select');
    sel.title = 'Swap the map of this match at once: same units, builds, bots and numbers, everyone back at the new spawns (works while paused)';
    for (const a of allArenas()) {
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

  /** Cooldowns are switched off in this match (the server says so in dev_state). */
  private noCooldowns = false;

  /** Quick resets of everyone in the match: cooldowns, health, resources, buffs and debuffs, spawns, the dead. */
  private resetTools(): HTMLElement {
    const box = el('div', 'devp-sec');
    box.append(el('b', '', 'Resets (everyone in the match)'));
    const row = el('div', 'devp-row devp-resets');
    const reset = (label: string, what: 'cooldowns' | 'health' | 'resources' | 'auras' | 'positions' | 'revive', tip: string) => {
      const b = el('button', 'mm-small', label);
      b.title = `${tip} The match stops counting.`;
      b.addEventListener('click', () => this.hooks.send({ t: 'dev_reset', what }));
      row.append(b);
    };
    reset('⟲ Cooldowns', 'cooldowns', 'Clears every cooldown, charge and recharge at once.');
    const off = el('button', `mm-small${this.noCooldowns ? ' mm-go' : ''}`, this.noCooldowns ? 'Cooldowns: off' : 'Cooldowns: on');
    off.title = 'Switch cooldowns off so no skill starts one (the global cooldown stays). The match stops counting.';
    off.addEventListener('click', () => this.hooks.send({ t: 'dev_cooldowns', off: !this.noCooldowns }));
    row.append(off);
    reset('♥ Full health', 'health', 'Everyone alive back to full health.');
    reset('◆ Full resources', 'resources', 'Mana, energy and rage full for everyone alive.');
    reset('✦ Clear buffs & debuffs', 'auras', 'Removes every buff and debuff, diminishing returns and school lockouts.');
    reset('⌂ Back to spawns', 'positions', 'Puts everyone back at their spawn without touching health or cooldowns.');
    reset('✚ Revive the dead', 'revive', 'Brings every dead unit back at its spawn at full health.');
    box.append(row);
    return box;
  }

  /** Owner only: kill, kick or ban someone in the match being played or watched. */
  private unitTools(): HTMLElement {
    const box = el('div', 'devp-sec');
    box.append(el('b', '', 'Players in this match'));
    for (const b of this.hooks.builds()) {
      const row = el('div', 'devp-row');
      row.append(el('span', '', `${b.bot ? '🤖 ' : ''}${b.name} · ${CLASSES[b.classId].name} · team ${b.team + 1}`));
      const kill = el('button', 'mm-small', 'Kill');
      kill.title = 'Kills this unit now. The match stops counting.';
      kill.addEventListener('click', () => this.hooks.send({ t: 'dev_unit', unit: b.id, op: 'kill' }));
      row.append(kill);
      if (!b.bot && b.id !== this.hooks.youId()) {
        const kick = el('button', 'mm-small adm-danger', 'Kick');
        kick.title = 'Removes them from the server (they can come back).';
        kick.addEventListener('click', () => window.confirm(`Kick ${b.name} off the server?`) && this.hooks.send({ t: 'dev_unit', unit: b.id, op: 'kick' }));
        const ban = el('button', 'mm-small adm-danger', 'Ban');
        ban.title = 'Bans their account and disconnects them. Guests have no account: kick them.';
        ban.addEventListener('click', () => {
          const m = window.prompt(`Ban ${b.name} for how many minutes? (0 = for good)`, '60');
          if (m === null || m.trim() === '' || !Number.isFinite(Number(m))) return;
          const reason = window.prompt('Reason (optional)', '') ?? '';
          this.hooks.send({ t: 'dev_unit', unit: b.id, op: 'ban', minutes: Math.max(0, Math.round(Number(m))), ...(reason.trim() ? { reason: reason.trim() } : {}) });
        });
        row.append(kick, ban);
      }
      box.append(row);
    }
    return box;
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
      wrap.append(this.mapPicker(), this.resetTools());
      const noteId = this.hooks.noteMatch?.();
      if (noteId) {
        const note = el('button', `mm-small${this.noteOpen ? ' mm-go' : ''}`, '📝 Note for the bots');
        note.title = 'Write what the bots did wrong in this match, in plain words. It goes to the bot brain with the match, stamped with the time in the fight.';
        note.addEventListener('click', () => {
          this.noteOpen = !this.noteOpen;
          this.paint();
        });
        row.append(note);
        if (this.noteOpen) wrap.append(noteBox(noteId, this.hooks.send, { liveNote: true }));
      }
      if (this.hooks.isOwner()) wrap.append(this.unitTools());
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

  get open(): boolean {
    return this.shown;
  }

  /** In a match as a dev: the tools act on that match. Out of it the test numbers go (the menu mode may stay). */
  setAvailable(on: boolean) {
    this.inMatch = on;
    if (!on) {
      const was = this.shown;
      this.autoPaused = false;
      this.noCooldowns = false;
      this.meter.clear();
      this.paused = false;
      this.edits.clear();
      this.result = null;
      this.layers.setRoom([]);
      if (was) this.onGone?.(); // a window left open over the old match closes
    } else if (this.shown) this.paint();
    this.onChrome?.();
  }

  /** Whether the tools act on a match being played (or watched by the owner) right now. */
  get matchMode(): boolean {
    return this.inMatch;
  }

  /** The 🛠 button: shown for anyone with dev or owner access, wherever they are. */
  setButton(on: boolean) {
    this.button.classList.toggle('hidden', !on);
  }

  /** The status line of the title bar: the test numbers in this match, or where the numbers go. */
  statusText(): string {
    const room = this.layers.roomPatches.length;
    return this.inMatch ? (room ? `${room} test number${room === 1 ? '' : 's'} in this match` : 'Real numbers') : 'Menu';
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** The pause button of the title bar (only in a match). */
  togglePause() {
    this.autoPaused = false; // your own choice from now on
    this.hooks.send({ t: 'dev_pause', on: !this.paused });
  }

  /** The window shows the Dev tab (on) or stops showing it (off). */
  setShown(on: boolean) {
    if (on === this.shown) return;
    this.shown = on;
    if (!on) this.watchDeploy();
    if (on) {
      this.hooks.send({ t: 'dev_builds' });
      this.hooks.send({ t: 'dev_commits' });
      this.hooks.send({ t: 'dev_requests', op: 'list' });
      // opening the window in your own match pauses it, so you can read and edit in peace; closing it resumes. Watching a match never pauses it.
      if (!this.live && this.inMatch && !this.paused && this.hooks.youId() > 0 && !this.hooks.spectating?.()) {
        this.autoPaused = true;
        this.hooks.send({ t: 'dev_pause', on: true });
      }
      this.paint();
      tours.autoRun('devpanel', true); // the first time ever: how the window works
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
      this.onChrome?.();
      this.noCooldowns = !!m.noCooldowns;
      // what was typed stays when only the pause changed; new numbers in the match replace it
      const same = JSON.stringify(m.patches) === JSON.stringify(this.layers.roomPatches);
      if (!same) this.noteNow(m.patches.length ? `Applied to this match: ${m.patches.length} changed number${m.patches.length === 1 ? '' : 's'}, live for everyone in it. Not saved for everyone yet: Keep or Commit does that.` : 'Back to the real numbers in this match.');
      this.layers.setRoom(m.patches);
      if (!same || m.reset) this.edits.clear();
    } else if (m.t === 'overrides') {
      // what everyone plays with (kept for everyone this session by the owner): shown in the changes list
      this.everyone = m.patches;
      if (this.drawerOpen) this.paint();
    } else if (m.t === 'dev_session') {
      this.session = m.patches;
      if (m.patches.length) this.noteNow(`Saved for your session: ${m.patches.length} changed number${m.patches.length === 1 ? '' : 's'} in every match you start until you sign out.`);
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

  /** The guided tour shows a part of the window: a section, a page of the Edit values section, the Changes list, the setups box. */
  tourShow(o: { section?: 'values' | 'match' | 'ask'; page?: DevPageId; drawer?: boolean; setups?: boolean }) {
    if (o.section) this.section = o.section;
    if (o.page) this.ws.page = o.page;
    if (o.drawer !== undefined) this.drawerOpen = o.drawer;
    if (o.setups !== undefined) this.setupsOpen = o.setups;
    if (this.open) this.paint();
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
    const secs = el('div', 'devp-sections');
    secs.dataset.tour = 'dev-sections'; // the guided tours point at these (tourData.ts)
    for (const [id, label] of [['values', 'Edit values'], ['match', 'Match tools'], ['ask', 'Ask Claude']] as const) {
      const b = el('button', `devp-sec-tab${this.section === id ? ' sel' : ''}`, label);
      b.addEventListener('click', () => {
        this.section = id;
        this.paint();
      });
      secs.append(b);
    }
    head.append(secs);
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
    this.onChrome?.();
  }

  /** The actions, always in view: try the changes, keep them, send them, put everything back. */
  private toolbar(): HTMLElement {
    const acts = el('div', 'devp-toolbar');
    const liveBox = el('label', 'devp-live');
    const liveCb = el('input') as HTMLInputElement;
    liveCb.type = 'checkbox';
    liveCb.checked = this.live;
    liveCb.title = 'On: the match keeps running while this window is open and every number you change is tried in it a moment after you type it. Off: the window pauses the match and you press "Try in this match".';
    liveCb.addEventListener('change', () => {
      this.live = liveCb.checked;
      try {
        localStorage.setItem('arena.devlive', this.live ? '1' : '0');
      } catch {
        /* ignore */
      }
      if (this.live && this.autoPaused) {
        this.autoPaused = false;
        if (this.paused) this.hooks.send({ t: 'dev_pause', on: false });
      }
      if (this.live) this.autoApply();
    });
    liveBox.append(liveCb, document.createTextNode(' Live: change numbers while the match runs'));
    const savedNote = el('small', 'devp-saved', this.saveNote);
    const tryIt = el('button', 'mm-small mm-go', 'Try in this match');
    tryIt.title = 'Everyone in this match plays on these numbers at once (the match no longer counts)';
    tryIt.addEventListener('click', () => this.hooks.send({ t: 'dev_patch', patches: this.toSend() }));
    const reset = el('button', 'mm-small', 'Put all back');
    reset.title = this.inMatch ? 'Back to the real numbers in this match' : 'Forget what you typed and the numbers kept for your session';
    reset.addEventListener('click', () => {
      this.edits.clear();
      this.layers.previewModels([]);
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
    const owner = this.hooks.isOwner();
    const keep = el('button', 'mm-small mm-go', owner ? 'Keep for everyone this session' : 'Keep for my session');
    keep.title = owner
      ? 'Everyone plays with these numbers for this session, in every match and in the menu, until you clear them. "Try in this match" only changes the match you are in.'
      : 'Every match you start (not ranked) uses these numbers until you clear them or sign out, so you can keep testing across matches';
    keep.addEventListener('click', () => {
      const all = this.edits.patches(mergePatches(this.session, this.layers.roomPatches));
      if (!all.length) return nothing();
      if (owner && !window.confirm(`Keep ${all.length} number${all.length === 1 ? '' : 's'} for everyone this session?`)) return;
      this.hooks.send({ t: 'dev_session', patches: all, ...(owner ? { live: true } : {}) });
    });
    const changes = el('button', `mm-small devp-changes-btn${this.drawerOpen ? ' mm-go' : ''}`, `Changes (${this.ws.changeCount()})`);
    changes.title = 'Every changed number as old -> new, with an undo for each';
    changes.addEventListener('click', () => {
      this.drawerOpen = !this.drawerOpen;
      this.paint();
    });
    this.changesBtn = changes;
    for (const [b, id] of [[tryIt, 'try'], [keep, 'keep'], [save, 'send'], [reset, 'reset'], [changes, 'changes']] as const) b.dataset.tour = `dev-${id}`;
    if (this.inMatch) acts.append(liveBox, tryIt, keep, save, reset, changes);
    else acts.append(keep, save, reset, changes);
    if (this.saveNote) acts.append(savedNote);
    return acts;
  }

  /** The "changes so far" list with the session's numbers and the recent commits. */
  private drawer(): HTMLElement {
    const box = el('div', 'devp-drawer');
    box.dataset.tour = 'dev-drawer';
    box.append(el('b', '', 'Changes so far'));
    const list = el('div');
    list.append(this.ws.changesList());
    this.drawerList = list;
    box.append(list);
    if (this.everyone.length) box.append(el('small', 'devp-dim', `🌐 ${this.everyone.length} number${this.everyone.length === 1 ? '' : 's'} kept for everyone this session (the owner's button)`));
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
