import { ARENAS, ARENA_THEMES, MAP_LIMITS, blankArena, checkReach, cleanCustomArena, copyArena, customArenas, suggestMapId } from '@arena/shared';
import type { ArenaDef, BotPick, ClientMsg, MapCheck, ServerMsg } from '@arena/shared';
import { KIND_LABEL, addItem, addTwin, deleteSel, handleAt, hitTest, itemOf, makeView, mirrorSpawns, moveSel, rectBetween, resizeRect, snap } from './mapEditLogic';
import type { Handle, Sel, Tool } from './mapEditLogic';
import { drawArena } from './mapPreview';

/**
 * The owner's map editor (admin panel, Maps tab). A list of the custom maps (editable) and the built-in ones (read only,
 * "Copy to custom" starts one), and an editor with a live top-down preview: click and drag on the picture to add, move,
 * resize and delete pieces, or type the numbers in the form. The shared validator (cleanCustomArena) runs after every
 * edit and its problems are listed live; the server runs it again on Save, together with a walk-the-map check.
 * Custom maps are for practice, party and bot matches. They are never in the queue, the random pool or ranked play.
 */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export interface MapEditorHooks {
  send(m: ClientMsg): void;
  /** Close the admin window (a test match opens over it). */
  closeWindow(): void;
  /** Start a practice match on this map as the player (the menu's Practice button with this arena). */
  playOn(mapId: string): void;
}

const TOOLS: [Tool, string, string][] = [
  ['select', 'Select', 'Click a piece to select it; drag it to move it, drag its edges or corners to resize it (a pillar: drag its rim).'],
  ['pillar', '+ Pillar', 'Click to place a pillar, or drag from its centre outwards for its size.'],
  ['wall', '+ Wall', 'Drag out a solid wall: it blocks walking, Blink and sight on every level.'],
  ['low', '+ Low wall', 'Drag out a barricade: it blocks walking and sight on the ground, a jump clears it.'],
  ['lava', '+ Lava', 'Drag out a lava pit: standing in it burns.'],
  ['flat', '+ Walkway flat', 'Drag out a raised walkway piece (a platform).'],
  ['ramp', '+ Ramp', 'Drag out a ramp. Its high end must touch a walkway flat (change its direction in the form).'],
  ['pier', '+ Pier', 'Drag out a stone pier that holds a walkway up (only needed when you list piers yourself).'],
];

const BOT_TEAMS = [['mage', 'warrior', 'priest'], ['rogue', 'mage', 'priest']] as const;

export class MapEditor {
  readonly root: HTMLElement = el('div', 'mape own-box');
  private active = false;
  private draft: ArenaDef | null = null;
  private isNew = false;
  private savedJson = '';
  private sel: Sel = null;
  private tool: Tool = 'select';
  private check: MapCheck | null = null;
  private reach: string[] | null = null;
  private msg: { ok: boolean; text: string; warnings?: string[] } | null = null;
  private idTouched = false;
  private confirmDelete = false;
  private pendingAfterSave: 'test' | 'play' | null = null;
  private size: 1 | 2 | 3 = 1;
  private saving = false;
  private canvas: HTMLCanvasElement | null = null;
  private ghost: { x0: number; x1: number; z0: number; z1: number } | null = null;
  private selBox: HTMLElement | null = null;
  private probBox: HTMLElement | null = null;
  private actionsBox: HTMLElement | null = null;
  /** Re-reads every number box of the form from the draft (after a drag). */
  private syncers: (() => void)[] = [];
  private view = makeView(blankArena().bounds, 100, 100);

  constructor(private hooks: MapEditorHooks) {
    window.addEventListener('resize', () => this.active && this.draft && this.draw());
  }

  /** The Maps tab is showing: ask for the list and draw. */
  show(): void {
    this.active = true;
    this.hooks.send({ t: 'maps_list' });
    this.render();
  }

  hide(): void {
    this.active = false;
  }

  handle(m: ServerMsg): void {
    if (m.t === 'custom_maps') {
      if (this.active && !this.draft) this.render();
    } else if (m.t === 'map_result') {
      this.saving = false;
      this.msg = { ok: m.ok, text: m.text, warnings: m.warnings };
      const after = this.pendingAfterSave;
      this.pendingAfterSave = null;
      if (m.ok && this.draft) {
        this.savedJson = JSON.stringify(this.draft);
        this.isNew = false;
        this.confirmDelete = false;
        if (after && m.id) return void this.launch(after, m.id);
      }
      if (m.ok && !this.draft) this.confirmDelete = false;
      if (this.active) this.render();
    }
  }

  private others(): ArenaDef[] {
    return this.isNew ? [...customArenas()] : customArenas().filter((a) => a.id !== this.draft?.id);
  }

  private dirty(): boolean {
    return !!this.draft && (this.isNew || JSON.stringify(this.draft) !== this.savedJson);
  }

  // ------------------------------------------------------------------ list

  private render(): void {
    if (!this.active) return;
    this.root.replaceChildren();
    this.syncers = [];
    if (this.draft) this.renderEditor();
    else this.renderList();
  }

  private open(a: ArenaDef, isNew: boolean): void {
    this.draft = JSON.parse(JSON.stringify(a)) as ArenaDef;
    delete this.draft.nav; // worked out from the walls on every save
    this.isNew = isNew;
    this.savedJson = isNew ? '' : JSON.stringify(this.draft);
    this.sel = null;
    this.tool = 'select';
    this.reach = null;
    this.msg = null;
    this.idTouched = !isNew;
    this.confirmDelete = false;
    this.pendingAfterSave = null;
    this.revalidate();
    this.render();
  }

  private renderList(): void {
    const r = this.root;
    r.append(el('p', 'mm-modal-foot', 'Make your own arenas. Custom maps can be picked by name in Practice and party matches, in the dev panel’s map swap and in bot matches. They never come up in the queue, the random pool or ranked play. Built-in maps are read only: copy one to start from it.'));
    const top = el('div', 'own-row');
    const add = el('button', 'mm-small mm-go', '+ New map');
    add.addEventListener('click', () => {
      const taken = customArenas().map((a) => a.id);
      const d = blankArena(suggestMapId('my-map', taken), 'My map');
      let n = 1;
      const names = new Set([...ARENAS, ...customArenas()].map((a) => a.name.toLowerCase()));
      while (names.has(d.name.toLowerCase())) d.name = `My map ${++n}`;
      this.open(d, true);
    });
    top.append(add, el('span', 'mape-count', `${customArenas().length} of ${MAP_LIMITS.maps} custom maps`));
    r.append(top);
    const mine = customArenas();
    r.append(el('h3', '', 'Custom maps'));
    if (!mine.length) r.append(el('p', 'mm-modal-foot', 'None yet. Start a new map, or copy a built-in one below.'));
    if (this.msg) r.append(el('div', `adm-state ${this.msg.ok ? 'ok' : 'bad'}`, this.msg.text));
    for (const a of mine) r.append(this.listRow(a, true));
    const det = el('details', 'mape-builtin');
    det.append(el('summary', '', `Built-in maps (${ARENAS.length}, read only)`));
    let filled = false;
    det.addEventListener('toggle', () => {
      if (!det.open || filled) return;
      filled = true;
      for (const a of ARENAS) det.append(this.listRow(a, false));
    });
    r.append(det);
  }

  private listRow(a: ArenaDef, custom: boolean): HTMLElement {
    const row = el('div', 'own-room mape-row');
    const th = el('canvas', 'mape-thumb');
    th.width = 120;
    th.height = 72;
    const ctx = th.getContext('2d');
    if (ctx) drawArena(ctx, a, 120, 72);
    const info = el('div', 'own-room-info');
    info.append(el('span', '', a.name), el('small', '', `${custom ? 'custom' : 'built-in'} · ${a.id} · ${a.bounds.maxX - a.bounds.minX}×${a.bounds.maxZ - a.bounds.minZ} yd · ${a.pillars.length} pillars${a.walls?.length ? `, ${a.walls.length} walls` : ''}${a.deck ? ', walkway' : ''}${a.lows?.some((l) => l.lava) ? ', lava' : ''}`));
    row.append(th, info);
    if (custom) {
      const edit = el('button', 'mm-small', 'Edit');
      edit.addEventListener('click', () => this.open(a, false));
      row.append(edit);
    } else {
      const copy = el('button', 'mm-small', 'Copy to custom');
      copy.title = 'Start a custom map from this one (the built-in map stays as it is)';
      copy.addEventListener('click', () => {
        const taken = customArenas().map((x) => x.id);
        const names = new Set([...ARENAS, ...customArenas()].map((x) => x.name.toLowerCase()));
        let name = `Copy of ${a.name}`.slice(0, MAP_LIMITS.nameMax);
        for (let i = 2; names.has(name.toLowerCase()); i++) name = `Copy ${i} of ${a.name}`.slice(0, MAP_LIMITS.nameMax);
        this.open(copyArena(a, suggestMapId(`${a.id}-copy`, taken), name), true);
      });
      row.append(copy);
    }
    return row;
  }

  // ------------------------------------------------------------------ editor

  private revalidate(): void {
    if (!this.draft) return;
    this.check = cleanCustomArena(JSON.parse(JSON.stringify(this.draft)), this.others());
    this.reach = null;
  }

  /** Something changed: re-check, redraw the picture, the problems and the buttons. */
  private changed(): void {
    this.revalidate();
    this.confirmDelete = false;
    this.draw();
    this.paintProblems();
    this.paintActions();
  }

  private renderEditor(): void {
    const d = this.draft!;
    const r = this.root;
    const head = el('div', 'own-row');
    const back = el('button', 'mm-small', '← All maps');
    back.addEventListener('click', () => {
      if (this.dirty() && !window.confirm('Leave without saving your changes?')) return;
      this.draft = null;
      this.msg = null;
      this.render();
    });
    head.append(back, el('b', '', this.isNew ? 'New custom map' : 'Editing'), el('span', 'mape-count', d.name));
    r.append(head);

    // tools
    const tools = el('div', 'own-row mape-tools');
    for (const [id, label, tip] of TOOLS) {
      const b = el('button', `mm-small${this.tool === id ? ' mm-go' : ''}`, label);
      b.title = tip;
      b.addEventListener('click', () => {
        this.tool = id;
        if (id !== 'select') this.sel = null;
        this.render();
      });
      tools.append(b);
    }
    r.append(tools);

    // the picture
    const wrap = el('div', 'mape-canvas-wrap');
    const cv = el('canvas', 'mape-canvas');
    cv.tabIndex = 0;
    this.canvas = cv;
    wrap.append(cv);
    r.append(wrap);
    this.wireCanvas(cv);
    r.append(el('p', 'mm-modal-foot', 'Blue: team 1 start spots (left). Red: team 2 (right). Dashed lines are the start gates. Grid lines every 5 yards; pieces snap to half a yard. Delete removes the selected piece, arrow keys nudge it.'));

    const settings = this.settingsForm();
    this.settingsSyncersCount = this.syncers.length;
    this.selBox = el('div', 'mape-sel');
    r.append(this.selBox);
    this.paintSel();

    this.probBox = el('div', 'mape-problems');
    r.append(this.probBox);

    r.append(el('h3', '', 'Map settings'), settings);

    this.actionsBox = el('div', 'own-row mape-actions');
    r.append(this.actionsBox);
    requestAnimationFrame(() => {
      this.draw();
      this.paintProblems();
      this.paintActions();
    });
    this.paintProblems();
    this.paintActions();
  }

  private numField(label: string, get: () => number, set: (v: number) => void, opts: { step?: number; min?: number; max?: number; disabled?: boolean } = {}): HTMLElement {
    const l = el('label', 'mape-f');
    l.append(el('span', '', label));
    const i = el('input');
    i.type = 'number';
    i.step = String(opts.step ?? 0.5);
    if (opts.min !== undefined) i.min = String(opts.min);
    if (opts.max !== undefined) i.max = String(opts.max);
    i.disabled = !!opts.disabled;
    const sync = () => {
      if (document.activeElement !== i) i.value = String(Math.round(get() * 100) / 100);
    };
    sync();
    this.syncers.push(sync);
    i.addEventListener('input', () => {
      if (i.value.trim() === '') return;
      const v = Number(i.value);
      set(Number.isFinite(v) ? v : NaN);
      this.changed();
      this.syncers.forEach((s) => s());
    });
    l.append(i);
    return l;
  }

  private settingsForm(): HTMLElement {
    const d = this.draft!;
    const box = el('div', 'mape-form');
    const row1 = el('div', 'own-row');
    const name = el('input');
    name.type = 'text';
    name.maxLength = MAP_LIMITS.nameMax;
    name.placeholder = 'Name (shown in the pickers)';
    name.value = d.name;
    name.addEventListener('input', () => {
      d.name = name.value;
      if (this.isNew && !this.idTouched) {
        d.id = suggestMapId(d.name, customArenas().map((a) => a.id));
        id.value = d.id;
      }
      this.changed();
    });
    const id = el('input');
    id.type = 'text';
    id.maxLength = 24;
    id.placeholder = 'id (a-z, 0-9, dashes)';
    id.value = d.id;
    id.disabled = !this.isNew;
    id.title = this.isNew ? 'The id is kept in replays and cannot change after the first save' : 'The id cannot change after the first save';
    id.addEventListener('input', () => {
      this.idTouched = true;
      d.id = id.value.trim().toLowerCase();
      this.changed();
    });
    const theme = el('select');
    for (const t of ARENA_THEMES) theme.append(new Option(t, t));
    theme.value = d.theme;
    theme.title = 'The art theme (materials, sky, props). It does not change how the map plays.';
    theme.addEventListener('change', () => {
      d.theme = theme.value;
      this.changed();
    });
    row1.append(name, id, theme);
    const desc = el('textarea');
    desc.rows = 2;
    desc.maxLength = MAP_LIMITS.descMax;
    desc.placeholder = 'Description (shown under the arena picker)';
    desc.value = d.desc;
    desc.addEventListener('input', () => {
      d.desc = desc.value;
      this.changed();
    });
    const b = d.bounds;
    const row2 = el('div', 'own-row mape-nums');
    row2.append(
      this.numField('min X', () => b.minX, (v) => (b.minX = v), { step: 1 }),
      this.numField('max X', () => b.maxX, (v) => (b.maxX = v), { step: 1 }),
      this.numField('min Z', () => b.minZ, (v) => (b.minZ = v), { step: 1 }),
      this.numField('max Z', () => b.maxZ, (v) => (b.maxZ = v), { step: 1 }),
      this.numField('Gate X (±)', () => d.gateX, (v) => (d.gateX = v), { step: 0.5 }),
      this.numField('Team 1 faces (°)', () => Math.round((d.spawnFacing[0] * 180) / Math.PI), (v) => (d.spawnFacing[0] = (v * Math.PI) / 180), { step: 5 }),
      this.numField('Team 2 faces (°)', () => Math.round((d.spawnFacing[1] * 180) / Math.PI), (v) => (d.spawnFacing[1] = (v * Math.PI) / 180), { step: 5 }),
    );
    box.append(row1, desc, row2);
    if (d.deck) {
      const row3 = el('div', 'own-row mape-nums');
      const piers = el('select');
      piers.append(new Option('Piers: automatic', 'auto'), new Option('Piers: none', 'none'), new Option('Piers: as drawn', 'listed'));
      piers.value = !d.deck.piers ? 'auto' : d.deck.piers.length ? 'listed' : 'none';
      piers.title = 'Stone piers hold the walkway up and block the ground under them. Automatic: a pair at each end of every flat.';
      piers.addEventListener('change', () => {
        if (piers.value === 'auto') delete d.deck!.piers;
        else if (piers.value === 'none') d.deck!.piers = [];
        else if (!d.deck!.piers?.length) d.deck!.piers = [];
        this.changed();
      });
      row3.append(this.numField('Walkway height', () => d.deck!.height, (v) => (d.deck!.height = v), { step: 0.1 }), piers);
      box.append(row3);
    }
    const sp = el('div', 'own-row');
    const mir = el('button', 'mm-small', 'Mirror team 1 start spots to team 2');
    mir.title = 'Turns the three team 1 spots around the centre for team 2 (and the other way with the second button)';
    mir.addEventListener('click', () => {
      mirrorSpawns(d, 0);
      this.changed();
    });
    const mir2 = el('button', 'mm-small', 'Mirror team 2 to team 1');
    mir2.addEventListener('click', () => {
      mirrorSpawns(d, 1);
      this.changed();
    });
    sp.append(mir, mir2);
    box.append(sp);
    return box;
  }

  // ------------------------------------------------------------------ selection form

  private paintSel(): void {
    const box = this.selBox;
    if (!box || !this.draft) return;
    const d = this.draft;
    // number boxes of the selection are rebuilt; the settings form keeps its own
    this.syncers = this.syncers.slice(0, this.settingsSyncers());
    box.replaceChildren();
    const it = itemOf(d, this.sel);
    if (!this.sel || !it) {
      box.append(el('p', 'mm-modal-foot', this.tool === 'select' ? 'Nothing selected. Click a piece in the picture.' : `Tool: ${TOOLS.find((t) => t[0] === this.tool)![1]}. ${TOOLS.find((t) => t[0] === this.tool)![2]}`));
      return;
    }
    const kind = this.sel.kind;
    const head = el('div', 'own-row');
    const title = kind === 'low' && (it as { lava?: boolean }).lava ? 'Lava pit' : KIND_LABEL[kind];
    head.append(el('b', '', `${title}${kind === 'spawn' ? ` ${this.sel.i + 1} (team ${(this.sel as { team: number }).team + 1})` : ` ${this.sel.i + 1}`}`));
    const row = el('div', 'own-row mape-nums');
    if ('x0' in it) {
      row.append(
        this.numField('x0', () => it.x0, (v) => (it.x0 = v)),
        this.numField('x1', () => it.x1, (v) => (it.x1 = v)),
        this.numField('z0', () => it.z0, (v) => (it.z0 = v)),
        this.numField('z1', () => it.z1, (v) => (it.z1 = v)),
      );
      if (kind === 'ramp') {
        const rise = el('select');
        for (const v of ['+x', '-x', '+z', '-z']) rise.append(new Option(`climbs towards ${v}`, v));
        rise.value = (it as { rise?: string }).rise ?? '+x';
        rise.addEventListener('change', () => {
          (it as { rise: string }).rise = rise.value;
          this.changed();
        });
        row.append(rise);
      }
      if (kind === 'low') {
        const lava = el('label', 'mape-f');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = !!(it as { lava?: boolean }).lava;
        cb.addEventListener('change', () => {
          if (cb.checked) (it as { lava?: boolean }).lava = true;
          else delete (it as { lava?: boolean }).lava;
          this.changed();
          this.paintSel();
        });
        lava.append(cb, el('span', '', 'Lava'));
        row.append(lava);
      }
    } else {
      row.append(
        this.numField('x', () => (it as { x: number }).x, (v) => ((it as { x: number }).x = v)),
        this.numField('z', () => (it as { z: number }).z, (v) => ((it as { z: number }).z = v)),
      );
      if ('r' in it) row.append(this.numField('radius', () => (it as { r: number }).r, (v) => ((it as { r: number }).r = v)));
    }
    head.append(...(kind === 'spawn' ? [] : [this.twinBtn(), this.delBtn()]));
    box.append(head, row);
  }

  private settingsSyncersCount = 0;
  private settingsSyncers(): number {
    return this.settingsSyncersCount;
  }

  private twinBtn(): HTMLElement {
    const b = el('button', 'mm-small', 'Add mirrored twin');
    b.title = 'Adds the same piece turned around the centre (how the built-in maps stay fair for both teams)';
    b.addEventListener('click', () => {
      const s = addTwin(this.draft!, this.sel);
      if (s) this.sel = s;
      this.afterStructure();
    });
    return b;
  }

  private delBtn(): HTMLElement {
    const b = el('button', 'mm-small', 'Delete piece');
    b.addEventListener('click', () => this.deleteSelected());
    return b;
  }

  private deleteSelected(): void {
    if (this.draft && deleteSel(this.draft, this.sel)) {
      this.sel = null;
      this.afterStructure();
    }
  }

  /** A piece was added or removed (or the selection moved to another piece): the selection form is rebuilt too. */
  private afterStructure(): void {
    this.paintSel();
    this.changed();
  }

  // ------------------------------------------------------------------ problems and buttons

  private paintProblems(): void {
    const box = this.probBox;
    if (!box || !this.check) return;
    box.replaceChildren();
    const c = this.check;
    if (!c.problems.length) box.append(el('div', 'adm-state ok', 'No problems found. Check walkability before you save (the server checks it again).'));
    else {
      const bad = el('div', 'adm-state bad');
      bad.append(el('b', '', `${c.problems.length} problem${c.problems.length === 1 ? '' : 's'} to fix before saving`));
      const ul = el('ul', 'mape-list');
      for (const p of c.problems.slice(0, 12)) ul.append(el('li', '', p));
      if (c.problems.length > 12) ul.append(el('li', '', `…and ${c.problems.length - 12} more`));
      bad.append(ul);
      box.append(bad);
    }
    if (c.warnings.length) {
      const w = el('div', 'adm-state warn');
      const ul = el('ul', 'mape-list');
      for (const p of c.warnings) ul.append(el('li', '', p));
      w.append(el('b', '', 'Worth a look'), ul);
      box.append(w);
    }
    if (this.reach) {
      if (!this.reach.length) box.append(el('div', 'adm-state ok', 'Walkability: both teams can reach every spot on the ground and on the walkway.'));
      else {
        const w = el('div', 'adm-state bad');
        const ul = el('ul', 'mape-list');
        for (const p of this.reach) ul.append(el('li', '', p));
        w.append(el('b', '', 'Walkability problems'), ul);
        box.append(w);
      }
    }
    if (this.msg) {
      const m = el('div', `adm-state ${this.msg.ok ? 'ok' : 'bad'}`, this.msg.text);
      if (this.msg.warnings?.length) m.append(el('div', '', this.msg.warnings.join(' ')));
      box.append(m);
    }
  }

  private paintActions(): void {
    const box = this.actionsBox;
    if (!box || !this.draft) return;
    box.replaceChildren();
    const okToSave = !!this.check && !this.check.problems.length && !this.saving;
    const save = el('button', 'mm-small mm-go', this.saving ? 'Saving…' : this.isNew ? 'Create map' : 'Save');
    save.disabled = !okToSave || (!this.dirty() && !this.isNew);
    save.title = okToSave ? 'Keep this map on the server. Everyone can then pick it in practice.' : 'Fix the problems first';
    save.addEventListener('click', () => this.save(null));
    const walk = el('button', 'mm-small', 'Check walkability');
    walk.title = 'Walk the map the way bots do: both teams must reach every standing spot, on the ground and on the walkway';
    walk.disabled = !this.check?.arena || !!this.check.problems.length;
    walk.addEventListener('click', () => {
      this.reach = checkReach(this.check!.arena!);
      this.paintProblems();
    });
    const size = el('select');
    for (const n of [1, 2, 3]) size.append(new Option(`${n}v${n}`, String(n)));
    size.value = String(this.size);
    size.addEventListener('change', () => (this.size = Number(size.value) as 1 | 2 | 3));
    const test = el('button', 'mm-small', 'Test it: watch bots');
    test.title = 'Saves the map, then starts a bot match on it that you watch (hard bots, private)';
    test.disabled = !okToSave && !(this.check && !this.check.problems.length && !this.dirty());
    test.addEventListener('click', () => this.save('test'));
    const play = el('button', 'mm-small', 'Play it: practice');
    play.title = 'Saves the map, then starts a practice match on it with your character';
    play.disabled = test.disabled;
    play.addEventListener('click', () => this.save('play'));
    box.append(save, walk, size, test, play);
    if (!this.isNew) {
      const del = el('button', `mm-small${this.confirmDelete ? ' mape-danger' : ''}`, this.confirmDelete ? 'Really delete this map?' : 'Delete map');
      del.addEventListener('click', () => {
        if (!this.confirmDelete) {
          this.confirmDelete = true;
          this.paintActions();
          return;
        }
        this.hooks.send({ t: 'map_delete', id: this.draft!.id });
        this.draft = null;
        this.confirmDelete = false;
        this.render();
      });
      box.append(del);
    }
  }

  private save(after: 'test' | 'play' | null): void {
    if (!this.draft || !this.check || this.check.problems.length || this.saving) return;
    if (!this.dirty() && !this.isNew && after) return void this.launch(after, this.draft.id);
    this.saving = true;
    this.pendingAfterSave = after;
    this.msg = null;
    this.hooks.send({ t: 'map_save', map: JSON.parse(JSON.stringify(this.draft)) as ArenaDef });
    this.paintActions();
  }

  private launch(what: 'test' | 'play', id: string): void {
    if (what === 'play') {
      this.hooks.closeWindow();
      this.hooks.playOn(id);
      return;
    }
    const n = this.size;
    this.hooks.send({ t: 'bot_match', size: n, teams: [BOT_TEAMS[0].slice(0, n).map((classId): BotPick => ({ classId })), BOT_TEAMS[1].slice(0, n).map((classId): BotPick => ({ classId }))], difficulty: 'hard', map: id });
    this.hooks.closeWindow();
  }

  // ------------------------------------------------------------------ the picture

  private draw(): void {
    const cv = this.canvas;
    if (!cv || !this.draft) return;
    const d = this.draft;
    const w = Math.max(280, Math.min(960, cv.parentElement?.clientWidth || 720));
    const b = d.bounds;
    const ratio = Number.isFinite(b.maxZ - b.minZ) && b.maxX > b.minX ? (b.maxZ - b.minZ) / (b.maxX - b.minX) : 0.66;
    const h = Math.round(Math.max(200, Math.min(560, w * Math.min(1.2, Math.max(0.3, ratio)) + 36)));
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    try {
      this.view = drawArena(ctx, d, w, h, { sel: this.sel, detail: true, ghost: this.ghost });
    } catch {
      // a half-typed number (NaN) can make a piece undrawable for a moment
    }
  }

  private wireCanvas(cv: HTMLCanvasElement): void {
    type Drag =
      | { mode: 'draw'; a: { x: number; z: number }; b: { x: number; z: number } }
      | { mode: 'move'; start: { x: number; z: number }; orig: string }
      | { mode: 'resize'; h: Handle }
      | { mode: 'radius' };
    let drag: Drag | null = null;
    const at = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      const x = this.view.wx(e.clientX - r.left), z = this.view.wz(e.clientY - r.top);
      return { x, z, sx: snap(x), sz: snap(z) };
    };
    cv.addEventListener('pointerdown', (e) => {
      if (!this.draft) return;
      cv.focus();
      cv.setPointerCapture(e.pointerId);
      const p = at(e);
      const tol = 9 / this.view.scale;
      if (this.tool !== 'select') {
        drag = { mode: 'draw', a: { x: p.sx, z: p.sz }, b: { x: p.sx, z: p.sz } };
        return;
      }
      const cur = itemOf(this.draft, this.sel);
      if (cur && this.sel) {
        if ('x0' in cur) {
          const h = handleAt(cur, p.x, p.z, tol);
          if (h) return void (drag = { mode: 'resize', h });
        } else if ('r' in cur && this.sel.kind === 'pillar' && Math.abs(Math.hypot(p.x - cur.x, p.z - cur.z) - cur.r) < tol) {
          return void (drag = { mode: 'radius' });
        }
      }
      const hit = hitTest(this.draft, p.x, p.z, tol * 0.5);
      const changedSel = JSON.stringify(hit) !== JSON.stringify(this.sel);
      this.sel = hit;
      if (hit) drag = { mode: 'move', start: { x: p.sx, z: p.sz }, orig: JSON.stringify(itemOf(this.draft, hit)) };
      if (changedSel) this.paintSel();
      this.draw();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag || !this.draft) return;
      const p = at(e);
      if (drag.mode === 'draw') {
        drag.b = { x: p.sx, z: p.sz };
        this.ghost = this.tool === 'pillar' ? null : rectBetween(drag.a, drag.b, 0.5);
      } else if (drag.mode === 'move') {
        const it = itemOf(this.draft, this.sel);
        if (!it) return;
        const orig = JSON.parse(drag.orig) as Record<string, number>;
        const dx = p.sx - drag.start.x, dz = p.sz - drag.start.z;
        Object.assign(it, orig);
        moveSel(this.draft, this.sel, dx, dz);
      } else if (drag.mode === 'resize') {
        const it = itemOf(this.draft, this.sel);
        if (it && 'x0' in it) resizeRect(it, drag.h, p.sx, p.sz);
      } else if (drag.mode === 'radius') {
        const it = itemOf(this.draft, this.sel);
        if (it && 'r' in it) (it as { r: number }).r = Math.max(MAP_LIMITS.pillarR[0], Math.min(MAP_LIMITS.pillarR[1], snap(Math.hypot(p.x - (it as { x: number }).x, p.z - (it as { z: number }).z))));
      }
      this.syncers.forEach((s) => s());
      this.revalidate();
      this.draw();
      this.paintProblems();
    });
    const end = () => {
      const d0 = drag;
      drag = null;
      this.ghost = null;
      if (!d0 || !this.draft) return;
      if (d0.mode === 'draw' && this.tool !== 'select') {
        this.sel = addItem(this.draft, this.tool, d0.a, d0.b);
        this.tool = 'select';
        this.render();
        return;
      }
      this.changed();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('keydown', (e) => {
      if (!this.draft) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.deleteSelected();
      } else if (e.key.startsWith('Arrow') && this.sel) {
        e.preventDefault();
        const s = e.shiftKey ? 2 : 0.5;
        moveSel(this.draft, this.sel, e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0);
        this.syncers.forEach((f) => f());
        this.changed();
      } else if (e.key === 'Escape') {
        this.tool = 'select';
        this.sel = null;
        this.render();
      }
    });
  }
}

