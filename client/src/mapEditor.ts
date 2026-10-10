import { ARENAS, ARENA_THEMES, MAP_LIMITS, blankArena, checkReach, cleanCustomArena, copyArena, customArenas, mapDisabled, suggestMapId } from '@arena/shared';
import type { ArenaDef, BotPick, ClientMsg, MapCheck, ServerMsg } from '@arena/shared';
import { KIND_LABEL, addItem, addTwin, deleteSel, duplicateSel, handleAt, hitTest, itemOf, makeView, mirrorSpawns, moveSel, rectBetween, resizeRect, snap, symmetrize } from './mapEditLogic';
import { SNAP_STEPS } from './mapEditLogic';
import type { Handle, Sel, Tool } from './mapEditLogic';
import { drawArena } from './mapPreview';
import { MapView3D } from './mapView3d';

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

const CSS = `
.mapw { position:fixed; inset:0; z-index:9000; display:flex; flex-direction:column; background:#0c0e14; color:#e6e9ef; font:14px/1.4 system-ui; }
.mapw.dropping::after { content:'Drop a map file here to open it'; position:absolute; inset:12px; border:3px dashed #b58cff; border-radius:14px; background:rgba(40,28,70,.82); display:flex; align-items:center; justify-content:center; font-size:26px; color:#eadcff; z-index:5; pointer-events:none; }
.mapw-bar { display:flex; align-items:center; gap:10px; padding:8px 14px; background:#14111d; border-bottom:1px solid #2c2638; flex:none; }
.mapw-bar b { font-size:16px; color:#e2c7ff; } .mapw-bar .sp { flex:1; }
.mapw-body { flex:1; min-height:0; overflow:auto; padding:12px 14px; }
.mape-win { display:grid; grid-template-columns:260px minmax(0,1fr) 340px; grid-template-rows:auto auto; gap:10px; align-items:start; }
.mape-win > .mape-head { grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.mape-win .mape-left, .mape-win .mape-right { display:grid; gap:10px; align-content:start; }
.mape-win .mape-center { display:flex; flex-direction:column; gap:8px; min-width:0; }
.mape-win .mape-stage { position:relative; width:100%; height:calc(100vh - 190px); min-height:320px; border-radius:8px; border:1px solid #2c2638; background:#10131a; overflow:hidden; }
.mape-win .mape-stage .mape-canvas-wrap { position:absolute; left:0; top:0; right:0; bottom:0; width:auto; border:0; border-radius:0; overflow:hidden; }
.mape-win .mape-stage .mape-canvas { position:absolute; left:0; top:0; margin:0; }
.mape-win .mape-stage .mape-3d { position:absolute; left:0; top:0; width:100%; height:100%; display:block; outline:none; cursor:grab; }
.mape-win [hidden] { display:none !important; }
.mape-win .mape-toolcol { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.mape-win .mape-toolcol button { text-align:left; }
.mape-win .mape-form .own-row { flex-wrap:wrap; }
.mape-win .mape-left .own-row.mape-nums { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.mape-win .mape-left .mape-f input[type=number] { width:100%; box-sizing:border-box; }
.mape-win .mape-form select { width:100%; background:#10131a; color:#e6e9ef; border:1px solid #333b4d; border-radius:6px; padding:6px; }
.mape-win .mape-form .own-row { display:grid; gap:8px; }
.mape-tab.on { background:#3a2a66; color:#fff; }
.mape-opt { display:flex; align-items:center; gap:6px; font-size:13px; color:#cfc5e6; }
.mape-opt select { background:#10131a; color:#e6e9ef; border:1px solid #333b4d; border-radius:6px; padding:3px 6px; }
.mape-hint { color:#a99cc4; font-size:12px; margin:0; }
.mape-drop { border:2px dashed #4b3d73; border-radius:10px; padding:14px; text-align:center; color:#a99cc4; }
@media (max-width:1100px) { .mape-win { grid-template-columns:1fr; grid-template-rows:auto; height:auto; } .mape-win .mape-stage { min-height:340px; } }
`;
let styled = false;
function ensureStyles(): void {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const st = document.createElement('style');
  st.id = 'map-window-styles';
  st.textContent = CSS;
  document.head.append(st);
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
  /** The window the editor lives in (its own, over everything), made on first use. */
  private win: HTMLElement | null = null;
  /** Piece placement snaps to this many yards. */
  private snapStep = 0.5;
  /** A piece drawn on one side gets its point-symmetric twin on the other. */
  private autoMirror = false;
  private mode: 'top' | '3d' = 'top';
  private view3d: MapView3D | null = null;
  private hist: string[] = [];
  private histAt = -1;

  constructor(private hooks: MapEditorHooks) {
    window.addEventListener('resize', () => this.active && this.draft && this.draw());
    new ResizeObserver(() => this.active && this.draft && this.mode === 'top' && this.draw()).observe(this.root);
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
    this.hist = [];
    this.histAt = -1;
    this.revalidate();
    this.pushHist();
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
    const on = !mapDisabled(a.id);
    const avail = el('button', `mm-small${on ? ' mm-go' : ''}`, on ? 'Available' : 'Off');
    avail.title = on ? 'Players can pick it and it can come up at random. Click to switch it off.' : 'Switched off: not in the queue, ranked or the random pool, and players cannot pick it. Click to switch it on.';
    avail.addEventListener('click', () => this.hooks.send({ t: 'map_enable', id: a.id, on: !on }));
    row.append(avail);
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
    this.pushHist();
    if (this.draft) this.view3d?.set(this.draft);
    this.confirmDelete = false;
    this.draw();
    this.paintProblems();
    this.paintActions();
  }

  private renderEditor(): void {
    ensureStyles();
    const d = this.draft!;
    const r = this.root;
    r.className = 'mape own-box mape-win';
    const head = el('div', 'mape-head');
    const back = el('button', 'mm-small', '← All maps');
    back.addEventListener('click', () => {
      if (this.dirty() && !window.confirm('Leave without saving your changes?')) return;
      this.draft = null;
      this.msg = null;
      this.view3d?.stop();
      this.render();
    });
    const undo = el('button', 'mm-small', '↶ Undo');
    undo.title = 'Undo the last change (Ctrl+Z)';
    undo.disabled = this.histAt <= 0;
    undo.addEventListener('click', () => this.undo());
    const redo = el('button', 'mm-small', '↷ Redo');
    redo.title = 'Redo (Ctrl+Y)';
    redo.disabled = this.histAt >= this.hist.length - 1;
    redo.addEventListener('click', () => this.redo());
    const tabTop = el('button', `mm-small mape-tab${this.mode === 'top' ? ' on' : ''}`, 'Top view');
    const tab3d = el('button', `mm-small mape-tab${this.mode === '3d' ? ' on' : ''}`, '3D view');
    tabTop.addEventListener('click', () => this.setMode('top'));
    tab3d.addEventListener('click', () => this.setMode('3d'));
    const snapSel = el('select');
    for (const n of SNAP_STEPS) snapSel.append(new Option(n === 0 ? 'free' : `${n} yd`, String(n)));
    snapSel.value = String(this.snapStep);
    snapSel.addEventListener('change', () => (this.snapStep = Number(snapSel.value)));
    const snapLbl = el('label', 'mape-opt', 'Snap ');
    snapLbl.title = 'Pieces snap to this many yards when drawn, moved and resized';
    snapLbl.append(snapSel);
    const mirror = el('input');
    mirror.type = 'checkbox';
    mirror.checked = this.autoMirror;
    mirror.addEventListener('change', () => (this.autoMirror = mirror.checked));
    const mirrorLbl = el('label', 'mape-opt');
    mirrorLbl.title = 'Every piece you draw also gets its turned-around twin on the other side, so the map stays fair';
    mirrorLbl.append(mirror, document.createTextNode(' Draw both sides'));
    const exp = el('button', 'mm-small', 'Export file');
    exp.title = 'Save this map as a file you can keep, share or drop back into the editor';
    exp.addEventListener('click', () => this.exportMap());
    const imp = el('button', 'mm-small', 'Import file…');
    imp.title = 'Open a map file (or just drop it anywhere in this window)';
    const pick = el('input');
    pick.type = 'file';
    pick.accept = '.json,application/json';
    pick.hidden = true;
    pick.addEventListener('change', () => {
      const f = pick.files?.[0];
      if (f) void this.importFile(f);
      pick.value = '';
    });
    imp.addEventListener('click', () => pick.click());
    head.append(back, el('b', '', this.isNew ? 'New custom map' : 'Editing'), el('span', 'mape-count', d.name), undo, redo, tabTop, tab3d, snapLbl, mirrorLbl, exp, imp, pick);
    r.append(head);

    // left: tools and the map's settings
    const left = el('div', 'mape-left');
    const tools = el('div', 'mape-toolcol');
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
    left.append(el('h3', '', 'Pieces'), tools);
    const extra = el('div', 'mape-toolcol');
    const dup = el('button', 'mm-small', 'Duplicate');
    dup.title = 'Copy the selected piece (D)';
    dup.addEventListener('click', () => this.duplicate());
    const sym = el('button', 'mm-small', 'Make symmetric');
    sym.title = 'Keep the left half and rebuild the right half as its turned-around copy, so both teams get the same map';
    sym.addEventListener('click', () => {
      if (!this.draft || !window.confirm('Replace the right half of the map with the turned-around copy of the left half?')) return;
      const r2 = symmetrize(this.draft);
      this.msg = { ok: true, text: `Made symmetric: ${r2.removed} pieces on the right replaced by ${r2.added} copies of the left.` };
      this.sel = null;
      this.changed();
      this.render();
    });
    extra.append(dup, sym);
    left.append(extra);
    const settings = this.settingsForm();
    this.settingsSyncersCount = this.syncers.length;
    left.append(el('h3', '', 'Map settings'), settings);
    r.append(left);

    // centre: the picture (top view, or the same map in 3D)
    const centre = el('div', 'mape-center');
    const stage = el('div', 'mape-stage');
    const wrap = el('div', 'mape-canvas-wrap');
    const cv = el('canvas', 'mape-canvas');
    cv.tabIndex = 0;
    this.canvas = cv;
    wrap.append(cv);
    stage.append(wrap);
    this.view3d ??= new MapView3D();
    stage.append(this.view3d.canvas);
    wrap.hidden = this.mode === '3d';
    this.view3d.canvas.hidden = this.mode !== '3d';
    centre.append(stage);
    const hint = el('p', 'mape-hint', this.mode === '3d' ? 'Left drag turns the view, right drag (or Shift+drag) slides it, the wheel zooms. Blue cones: team 1 start spots, red: team 2, yellow lines: the gates.' : 'Blue: team 1 start spots (left). Red: team 2 (right). Dashed lines are the start gates. Grid lines every 5 yards. Delete removes the selected piece, arrow keys nudge it (Shift: 2 yards), D copies it, Ctrl+Z undoes.');
    centre.append(hint);
    r.append(centre);
    this.wireCanvas(cv);

    // right: what is selected, the problems and the buttons
    const right = el('div', 'mape-right');
    this.selBox = el('div', 'mape-sel');
    right.append(this.selBox);
    this.paintSel();
    this.probBox = el('div', 'mape-problems');
    right.append(this.probBox);
    this.actionsBox = el('div', 'own-row mape-actions');
    right.append(this.actionsBox);
    right.append(el('div', 'mape-drop', 'Have a map file? Drop it anywhere in this window to open it as a new map.'));
    r.append(right);

    requestAnimationFrame(() => {
      this.draw();
      this.paintProblems();
      this.paintActions();
    });
    if (this.mode === '3d') {
      this.view3d.set(d);
      this.view3d.start();
    }
    this.paintProblems();
    this.paintActions();
  }

  private setMode(m: 'top' | '3d'): void {
    this.mode = m;
    if (m !== '3d') this.view3d?.stop();
    this.render();
  }

  // ------------------------------------------------------------------ history, files and the window

  private pushHist(): void {
    if (!this.draft) return;
    const j = JSON.stringify(this.draft);
    if (this.hist[this.histAt] === j) return;
    this.hist = this.hist.slice(0, this.histAt + 1);
    this.hist.push(j);
    if (this.hist.length > 200) this.hist.shift();
    this.histAt = this.hist.length - 1;
    this.refreshUndo();
  }

  private refreshUndo(): void {
    // the undo and redo buttons live in the header: redrawing the whole editor for them would lose the drag, so only their state moves
    const bar = this.root.querySelector('.mape-head');
    if (!bar) return;
    const [u, rd] = [...bar.querySelectorAll('button')].filter((b) => b.textContent?.includes('Undo') || b.textContent?.includes('Redo'));
    if (u) u.disabled = this.histAt <= 0;
    if (rd) rd.disabled = this.histAt >= this.hist.length - 1;
  }

  private restore(i: number): void {
    const j = this.hist[i];
    if (!j || !this.draft) return;
    this.histAt = i;
    const was = this.draft;
    this.draft = JSON.parse(j) as ArenaDef;
    if (!this.isNew) this.draft.id = was.id; // the id of a saved map never changes
    this.sel = null;
    this.revalidate();
    this.render();
  }

  private undo(): void {
    if (this.histAt > 0) this.restore(this.histAt - 1);
  }

  private redo(): void {
    if (this.histAt < this.hist.length - 1) this.restore(this.histAt + 1);
  }

  private duplicate(): void {
    if (!this.draft || !this.sel) return;
    const next = duplicateSel(this.draft, this.sel);
    if (!next) return;
    this.sel = next;
    this.changed();
    this.render();
  }

  /** The map as a file: {format, map}, the same text the import reads back. */
  private exportMap(): void {
    if (!this.draft) return;
    const text = JSON.stringify({ format: 'arena-map', version: 1, map: this.draft }, null, 1);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.draft.id || 'map'}.arena.json`;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /** Open a map file (exported here, or a plain arena definition) as a new custom map. Problems are listed, nothing is saved yet. */
  async importFile(f: File): Promise<void> {
    if (f.size > 400_000) return void this.flash(false, 'That file is too big to be a map.');
    let raw: unknown;
    try {
      raw = JSON.parse(await f.text());
    } catch {
      return void this.flash(false, 'That file is not a map (it is not readable JSON).');
    }
    const body = raw && typeof raw === 'object' && 'map' in (raw as object) ? (raw as { map: unknown }).map : raw;
    if (!body || typeof body !== 'object') return void this.flash(false, 'That file is not a map.');
    const taken = customArenas().map((a) => a.id);
    const m = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    delete m.nav;
    m.id = suggestMapId(typeof m.id === 'string' && m.id ? m.id : 'imported', taken);
    const names = new Set([...ARENAS, ...customArenas()].map((x) => x.name.toLowerCase()));
    let name = typeof m.name === 'string' && m.name ? m.name.slice(0, MAP_LIMITS.nameMax) : 'Imported map';
    for (let i = 2; names.has(name.toLowerCase()); i++) name = `${String(m.name ?? 'Imported map').slice(0, MAP_LIMITS.nameMax - 4)} ${i}`;
    m.name = name;
    const check = cleanCustomArena(JSON.parse(JSON.stringify(m)), customArenas());
    // a map the checker cannot read at all (not an arena) is refused; one with fixable problems opens, and the problems are listed
    if (!check.arena && !('bounds' in m && 'spawns' in m)) return void this.flash(false, `That file is not a map: ${check.problems[0] ?? 'it has no arena in it'}`);
    this.active = true;
    this.open((check.arena ?? (m as unknown as ArenaDef)) as ArenaDef, true);
    this.flash(true, `Opened "${name}" from the file. It is not saved until you press Create map.`);
  }

  private flash(ok: boolean, text: string): void {
    this.msg = { ok, text };
    if (this.active) this.render();
  }

  /** The editor in a window of its own over everything (so nothing overlaps it); closing it asks about unsaved changes. */
  openWindow(): void {
    ensureStyles();
    if (!this.win) {
      const w = el('div', 'mapw');
      const bar = el('div', 'mapw-bar');
      const close = el('button', 'mm-small', '✕ Close');
      close.addEventListener('click', () => this.closeWindow());
      bar.append(el('b', '', 'Map editor'), el('span', 'mape-count', 'make arenas and see them in 3D'), el('span', 'sp'), close);
      const body = el('div', 'mapw-body');
      body.append(this.root);
      w.append(bar, body);
      let depth = 0;
      w.addEventListener('dragenter', (e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        depth++;
        w.classList.add('dropping');
      });
      w.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
      });
      w.addEventListener('dragleave', () => {
        depth = Math.max(0, depth - 1);
        if (!depth) w.classList.remove('dropping');
      });
      w.addEventListener('drop', (e) => {
        e.preventDefault();
        depth = 0;
        w.classList.remove('dropping');
        const f = [...(e.dataTransfer?.files ?? [])].find((x) => /\.json$/i.test(x.name) || x.type === 'application/json') ?? e.dataTransfer?.files[0];
        if (f) void this.importFile(f);
      });
      window.addEventListener('keydown', (e) => {
        if (!this.win?.isConnected) return;
        const t = e.target as HTMLElement | null;
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) this.redo();
          else this.undo();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
          e.preventDefault();
          this.redo();
        } else if (e.key.toLowerCase() === 'd' && !e.ctrlKey && !e.metaKey && this.sel) this.duplicate();
      });
      this.win = w;
    }
    document.body.append(this.win);
    this.show();
  }

  /** Close the window without asking (the map was just saved, or a match starts). */
  forceClose(): void {
    this.draft = null;
    this.view3d?.dispose();
    this.view3d = null;
    this.win?.remove();
    this.hide();
  }

  closeWindow(): void {
    if (this.draft && this.dirty() && !window.confirm('Close the editor? Your unsaved changes to this map are lost.')) return;
    this.draft = null;
    this.view3d?.dispose();
    this.view3d = null;
    this.win?.remove();
    this.hide();
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
      this.forceClose();
      this.hooks.closeWindow();
      this.hooks.playOn(id);
      return;
    }
    const n = this.size;
    this.hooks.send({ t: 'bot_match', size: n, teams: [BOT_TEAMS[0].slice(0, n).map((classId): BotPick => ({ classId })), BOT_TEAMS[1].slice(0, n).map((classId): BotPick => ({ classId }))], difficulty: 'hard', map: id });
    this.forceClose();
    this.hooks.closeWindow();
  }

  // ------------------------------------------------------------------ the picture

  private draw(): void {
    const cv = this.canvas;
    if (!cv || !this.draft) return;
    const d = this.draft;
    const host = cv.parentElement;
    const w = Math.max(280, host?.clientWidth || 720);
    const h = Math.max(240, host?.clientHeight || 480);
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
      return { x, z, sx: snap(x, this.snapStep), sz: snap(z, this.snapStep) };
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
        this.ghost = this.tool === 'pillar' ? null : rectBetween(drag.a, drag.b, Math.max(0.25, this.snapStep));
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
        if (it && 'r' in it) (it as { r: number }).r = Math.max(MAP_LIMITS.pillarR[0], Math.min(MAP_LIMITS.pillarR[1], snap(Math.hypot(p.x - (it as { x: number }).x, p.z - (it as { z: number }).z), this.snapStep)));
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
        if (this.autoMirror) addTwin(this.draft, this.sel); // the twin is added after: the drawn piece stays selected
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

