/**
 * The nameplate editor: a full-screen overlay that works over the main menu, the pretend-fight backdrop of the HUD editor
 * or a match. It shows a sample unit with the plate of the profile being edited (tabs Me / Ally / Enemy) at a large scale.
 * Drag a part to move it (it snaps to the other parts and to the plate's anchor, with guide lines), drag its handles to
 * resize it, drag the plate's corner to scale the whole plate; every number also has a box.
 *
 * Self-contained: the main menu only needs `openNameplateEditor()` (e.g. behind an "Edit nameplates" button). The
 * profiles are saved through nameplateStore.ts as they change, so the game follows live.
 */
import { AURAS, CLASSES } from '@arena/shared';
import { AURA_ICON } from './icons';
import { el } from './bar';
import { registerPopup } from './popups';
import { fillFor } from './hudLook';
import { PlateView, type AuraIcon } from './nameplateView';
import {
  FIELD_GROUPS, PART_IDS, PART_LABEL, PLATE_FIELDS, PLATE_KINDS, PLATE_KIND_LABEL, PLATE_PRESETS, SIDES, SIDE_LABEL,
  auraGrid, auraSide, barText, canAttach, cloneProfile, defaultProfile, getPath, nudgePart, pickAuras, reattach, resetPart, resizePlate,
  setAnchor, setAuraSide, setNum, setPath, snapEdge, snapMove, descendants,
  type Field, type Guide, type PartId, type PlateContext, type PlateKind, type PlateLayout, type PlateProfile, type Rect, type Side,
} from './nameplateLayout';
import { copyPlate, loadPrefs, plateProfile, resetPlate, savePrefs, setPlate, type PlateEditorPrefs } from './nameplateStore';

/** Height of the sample unit and where its head anchor sits, in editor pixels before zoom (the game's 2.7 m over a ~1.9 m model). */
const FIG_H = 110;
const HEAD_ANCHOR = -156;
const SNAP_PX = 7;

const CSS = `
.npe { position:fixed; inset:0; z-index:9800; display:flex; background:rgba(8,10,15,.84); color:#e8e2d0; font:13px/1.35 system-ui, sans-serif; user-select:none; }
.npe * { box-sizing:border-box; }
.npe-stage { position:relative; flex:1; min-width:0; overflow:hidden; touch-action:none; }
.npe-world { position:absolute; left:0; top:0; transform-origin:0 0; pointer-events:none; }
.npe-ground { position:absolute; left:-70px; top:-9px; width:140px; height:18px; border-radius:50%; background:radial-gradient(closest-side, rgba(255,255,255,.18), rgba(255,255,255,0)); border:1px solid rgba(255,255,255,.14); }
.npe-fig { position:absolute; left:-26px; top:${-FIG_H}px; width:52px; height:${FIG_H}px; opacity:.9; }
.npe-over { position:absolute; inset:0; }
.npe-box { position:absolute; border:1px dashed rgba(255,255,255,.35); border-radius:2px; cursor:move; outline:none; }
.npe-box:hover { border-color:rgba(255,255,255,.8); background:rgba(255,255,255,.07); }
.npe-box.sel { border:1px solid #ffd24a; background:rgba(255,210,74,.10); }
.npe-box:focus-visible { border:2px solid #7fd4ff; }
.npe-box b { position:absolute; left:0; bottom:100%; font:600 10px/12px system-ui; color:#ffd24a; background:rgba(0,0,0,.65); padding:0 4px; border-radius:2px; white-space:nowrap; display:none; pointer-events:none; }
.npe-box:hover b, .npe-box.sel b { display:block; }
.npe-plate { position:absolute; border:1px dashed rgba(255,210,74,.55); pointer-events:none; }
.npe-plate.sel { border:1px solid #ffd24a; }
.npe-plate b { position:absolute; right:0; bottom:100%; font:600 10px/12px system-ui; color:#ffd24a; background:rgba(0,0,0,.65); padding:0 4px; border-radius:2px; }
.npe-handle { position:absolute; width:12px; height:12px; margin:-6px 0 0 -6px; background:#ffd24a; border:1px solid #000; border-radius:2px; touch-action:none; z-index:3; }
.npe-handle.plate { background:#7fd4ff; width:14px; height:14px; margin:-7px 0 0 -7px; border-radius:50%; }
.npe-handle.w { cursor:ew-resize; } .npe-handle.h { cursor:ns-resize; } .npe-handle.c { cursor:nwse-resize; }
.npe-anchor { position:absolute; height:0; border-top:1px dashed rgba(127,212,255,.75); cursor:ns-resize; }
.npe-anchor::before { content:''; position:absolute; left:50%; top:-9px; width:0; height:18px; border-left:1px solid rgba(127,212,255,.9); }
.npe-anchor i { position:absolute; left:50%; top:-8px; width:16px; height:16px; margin-left:-8px; border-radius:50%; border:2px solid #7fd4ff; background:rgba(127,212,255,.25); cursor:ns-resize; }
.npe-anchor span { position:absolute; right:0; top:-16px; font:600 10px/12px system-ui; color:#7fd4ff; pointer-events:none; }
.npe-guide { position:absolute; background:#ff4fd8; pointer-events:none; z-index:4; box-shadow:0 0 4px #ff4fd8; }
.npe-hint { position:absolute; left:12px; bottom:10px; right:12px; font-size:12px; color:#b9b19a; pointer-events:none; text-shadow:0 1px 2px #000; }
.npe-panel { width:372px; max-width:100%; display:flex; flex-direction:column; background:#14161c; border-left:1px solid #3a3526; overflow:hidden; }
.npe-head { display:flex; align-items:center; gap:8px; padding:10px 12px 6px; }
.npe-head b { font-size:15px; color:#ffd24a; flex:1; }
.npe-tabs { display:flex; gap:4px; padding:0 12px 8px; }
.npe-tabs button { flex:1; padding:7px 4px; background:#20232c; color:#cfc7ae; border:1px solid #3a3526; border-radius:6px; cursor:pointer; font-weight:700; }
.npe-tabs button[aria-selected=true] { background:#4a3c14; color:#ffe9a0; border-color:#c9a24a; }
.npe-scroll { flex:1; overflow-y:auto; padding:0 12px 14px; }
.npe-scroll::-webkit-scrollbar { width:8px; } .npe-scroll::-webkit-scrollbar-thumb { background:#4a4432; border-radius:4px; }
.npe button, .npe select, .npe input { font:inherit; }
.npe button.b { padding:5px 9px; background:#262a35; color:#e8e2d0; border:1px solid #484232; border-radius:5px; cursor:pointer; }
.npe button.b:hover { background:#323847; } .npe button.b.primary { background:#7a5d12; border-color:#c9a24a; color:#fff3c8; } .npe button.b.warn { border-color:#8a3b30; color:#ffb0a4; }
.npe button.b:focus-visible, .npe select:focus-visible, .npe input:focus-visible, .npe-tabs button:focus-visible, .npe-chip:focus-visible { outline:2px solid #7fd4ff; outline-offset:1px; }
.npe-bar { display:flex; flex-wrap:wrap; gap:6px 12px; align-items:center; padding:8px 0; border-bottom:1px solid #2b2a22; }
.npe-bar label, .npe-row label { display:flex; align-items:center; gap:6px; }
.npe-sec { margin:8px 0 2px; font:700 11px/1 system-ui; letter-spacing:.06em; text-transform:uppercase; color:#a89e7c; }
.npe-chips { display:flex; flex-wrap:wrap; gap:4px; padding:4px 0; }
.npe-chip { padding:3px 8px; border-radius:11px; background:#20232c; border:1px solid #3a3526; color:#cfc7ae; cursor:pointer; font-size:12px; }
.npe-chip.sel { background:#4a3c14; border-color:#c9a24a; color:#ffe9a0; } .npe-chip.off { opacity:.5; }
.npe-card { margin:6px 0; padding:8px 10px; background:#1b1e26; border:1px solid #3a3526; border-radius:7px; display:grid; gap:6px; }
.npe-card h4 { margin:0; font-size:13px; color:#ffd24a; }
.npe-card .r { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center; }
.npe details { margin:6px 0; border:1px solid #2f2d22; border-radius:7px; background:#171a21; }
.npe summary { padding:7px 10px; cursor:pointer; font-weight:700; color:#e0d6b4; }
.npe details > div { padding:2px 10px 8px; display:grid; gap:5px; }
.npe-row { display:grid; grid-template-columns:1fr auto; gap:6px; align-items:center; }
.npe-row.off { opacity:.45; }
.npe-row .ctl { display:flex; align-items:center; gap:5px; justify-content:flex-end; }
.npe-row input[type=range] { width:96px; } .npe-row input[type=number] { width:58px; } .npe-row select { max-width:170px; }
.npe-row input[type=number], .npe select, .npe-card input[type=number] { background:#0f1116; color:#e8e2d0; border:1px solid #484232; border-radius:4px; padding:2px 4px; }
.npe-card input[type=number] { width:60px; }
.npe small { color:#a89e7c; }
.npe-presets { display:flex; flex-wrap:wrap; gap:5px; }
@media (max-width: 820px) { .npe { flex-direction:column; } .npe-stage { flex:1 1 42%; } .npe-panel { width:100%; flex:1 1 58%; border-left:0; border-top:1px solid #3a3526; } .npe-hint { display:none; } }
`;

/** Real effects of the game for the sample's buff row: debuffs of every sort, then a few buffs. */
const SAMPLE_AURAS = ['cheap_shot_stun', 'frostbolt_slow', 'garrote_bleed', 'frost_nova_root', 'polymorph', 'psychic_scream', 'creeping_rot', 'kidney_shot'];
const SAMPLE_BUFFS = ['recklessness', 'pw_shield', 'renew'];

type Sel = PartId | 'plate' | null;

interface Drag {
  kind: 'move' | 'resize' | 'plate' | 'offset' | 'scale';
  id?: PartId;
  axis?: 'w' | 'h' | 'c';
  px: number;
  py: number;
  rect?: Rect;
  dx0?: number;
  dy0?: number;
  others?: Rect[];
  start?: { scaleW: number; scaleH: number; w: number; h: number; offsetY: number; param: number; param2: number };
}

class NameplateEditor {
  private kind: PlateKind = 'enemy';
  private prof: PlateProfile = defaultProfile();
  private selected: Sel = 'bar';
  private prefs: PlateEditorPrefs = loadPrefs();
  private root = el('div', 'npe');
  private stage = el('div', 'npe-stage');
  private world = el('div', 'npe-world');
  private over = el('div', 'npe-over');
  private view = new PlateView();
  private boxes = new Map<PartId, HTMLElement>();
  private plateBox = el('div', 'npe-plate');
  private anchorEl = el('div', 'npe-anchor');
  private handles: HTMLElement[] = [];
  private plateHandle = el('div', 'npe-handle plate');
  private guideEls: HTMLElement[] = [];
  private guides: Guide[] = [];
  private tabBtns = new Map<PlateKind, HTMLButtonElement>();
  private chips = new Map<PartId | 'plate', HTMLButtonElement>();
  private rows: { field: Field; row: HTMLElement; refresh(): void }[] = [];
  private card = el('div', 'npe-card');
  private sample = { mark: true, target: true, avatar: true, title: true, res: true, cast: true, auras: 4 };
  private zoom = 3;
  private origin = { x: 0, y: 0 };
  private lay: PlateLayout | null = null;
  private ctx: PlateContext = { hasMark: false, hasArrow: false, hasAvatar: false, hasTitle: false, hasRes: false, hasCast: false, auraCount: 0 };
  private drag: Drag | null = null;
  private snapBtn!: HTMLInputElement;
  private guideBtn!: HTMLInputElement;
  private zoomSel!: HTMLSelectElement;
  private onClose: () => void;
  private resizeObs: ResizeObserver | null = null;
  private opener: Element | null = null;
  open = false;

  constructor(onClose: () => void) {
    this.onClose = onClose;
    // one of the game's pop-ups: Escape closes the top one, and a match starting closes it
    registerPopup({ isOpen: () => this.open, close: () => this.close(), el: () => this.root });
  }

  // ------------------------------------------------------------------ opening

  show(kind?: PlateKind): void {
    if (this.open) {
      if (kind) this.setKind(kind);
      return;
    }
    this.open = true;
    this.opener = document.activeElement;
    if (!document.getElementById('npe-styles')) {
      const s = document.createElement('style');
      s.id = 'npe-styles';
      s.textContent = CSS;
      document.head.append(s);
    }
    this.build();
    document.body.append(this.root);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    this.resizeObs = new ResizeObserver(() => {
      this.needFit = true;
      this.render();
    });
    this.resizeObs.observe(this.stage);
    this.setKind(kind ?? this.kind);
    this.tabBtns.get(this.kind)?.focus();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.drag = null;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.root.remove();
    this.root = el('div', 'npe');
    this.boxes.clear();
    this.rows = [];
    this.handles = [];
    this.guideEls = [];
    this.chips.clear();
    this.tabBtns.clear();
    this.stage = el('div', 'npe-stage');
    this.world = el('div', 'npe-world');
    this.over = el('div', 'npe-over');
    this.view = new PlateView();
    this.plateBox = el('div', 'npe-plate');
    this.anchorEl = el('div', 'npe-anchor');
    this.plateHandle = el('div', 'npe-handle plate');
    this.card = el('div', 'npe-card');
    if (this.opener instanceof HTMLElement && this.opener.isConnected) this.opener.focus();
    this.onClose();
  }

  private onKey = (ev: KeyboardEvent) => {
    if (!this.open) return;
    if (ev.code === 'Escape' && !ev.repeat) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      this.close();
      return;
    }
    // the game's own keys must not act while this is open
    const t = ev.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || !!t.closest('.npe-tabs'));
    if (!typing && this.selected && ev.code.startsWith('Arrow') && !ev.ctrlKey && !ev.metaKey) {
      ev.preventDefault();
      ev.stopPropagation();
      const step = ev.shiftKey ? 10 : 1;
      const dx = ev.code === 'ArrowLeft' ? -step : ev.code === 'ArrowRight' ? step : 0;
      const dy = ev.code === 'ArrowUp' ? -step : ev.code === 'ArrowDown' ? step : 0;
      if (this.selected === 'plate') this.prof.offsetY = Math.min(150, Math.max(-150, this.prof.offsetY - dy));
      else nudgePart(this.prof, this.selected, dx, dy);
      this.commit();
    }
  };

  // ------------------------------------------------------------------ building the page

  private build(): void {
    const { root, stage } = this;
    // nothing typed or clicked in here reaches the game underneath
    root.tabIndex = -1;
    for (const t of ['keydown', 'keyup', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu', 'pointerdown']) root.addEventListener(t, (e) => e.stopPropagation());
    stage.append(this.world, this.over);
    const fig = el('div', 'npe-fig');
    fig.innerHTML = `<svg viewBox="0 0 52 ${FIG_H}" width="52" height="${FIG_H}"><defs><linearGradient id="npe-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b93a6"/><stop offset="1" stop-color="#50566a"/></linearGradient></defs><circle cx="26" cy="12" r="10" fill="url(#npe-g)"/><path d="M12 28 Q26 22 40 28 L44 66 L36 68 L35 100 L28 102 L26 76 L24 102 L17 100 L16 68 L8 66 Z" fill="url(#npe-g)"/></svg>`;
    this.world.append(el('div', 'npe-ground'), fig, this.view.root);
    this.view.root.style.zIndex = '2';

    for (const id of PART_IDS) {
      const b = el('div', 'npe-box');
      b.tabIndex = 0;
      b.setAttribute('role', 'button');
      b.setAttribute('aria-label', `${PART_LABEL[id]}: drag to move, arrow keys to nudge`);
      b.append(el('b', '', PART_LABEL[id]));
      b.addEventListener('pointerdown', (ev) => this.beginMove(ev, id));
      b.addEventListener('focus', () => {
        if (this.selected !== id) this.select(id);
      });
      this.boxes.set(id, b);
      this.over.append(b);
    }
    this.plateBox.append(el('b', '', 'Whole plate'));
    this.over.append(this.plateBox, this.anchorEl);
    const knob = el('i');
    this.anchorEl.append(knob, el('span', '', ''));
    this.anchorEl.addEventListener('pointerdown', (ev) => this.beginOffset(ev));
    for (const axis of ['w', 'h', 'c']) {
      const h = el('div', `npe-handle ${axis}`);
      h.dataset.axis = axis;
      h.addEventListener('pointerdown', (ev) => this.beginResize(ev, axis as 'w' | 'h' | 'c'));
      this.handles.push(h);
      this.over.append(h);
    }
    this.plateHandle.title = 'Drag to scale the whole plate (Shift keeps its shape)';
    this.plateHandle.addEventListener('pointerdown', (ev) => this.beginScale(ev));
    this.over.append(this.plateHandle);
    for (let i = 0; i < 6; i++) {
      const g = el('div', 'npe-guide');
      g.style.display = 'none';
      this.guideEls.push(g);
      this.over.append(g);
    }
    stage.append(el('div', 'npe-hint', 'Drag a part to move it, its square handles to resize it; the round handle scales the whole plate and the blue ring moves the plate up or down. Arrow keys nudge (Shift = 10). Alt ignores snapping. Esc closes.'));
    stage.addEventListener('pointerdown', (ev) => {
      if (ev.target === stage || ev.target === this.over) this.select(null);
    });

    // ---- the panel
    const panel = el('div', 'npe-panel');
    const head = el('div', 'npe-head');
    head.append(el('b', '', 'Edit nameplates'));
    const done = el('button', 'b primary', 'Done (Esc)');
    done.addEventListener('click', () => this.close());
    head.append(done);
    const tabs = el('div', 'npe-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const k of PLATE_KINDS) {
      const t = el('button', '', PLATE_KIND_LABEL[k]);
      t.setAttribute('role', 'tab');
      t.title = k === 'me' ? 'Your own nameplate' : k === 'ally' ? 'Nameplates of allies' : 'Nameplates of enemy players, bots, neutral units and dummies';
      t.addEventListener('click', () => this.setKind(k));
      t.addEventListener('keydown', (ev) => {
        const i = PLATE_KINDS.indexOf(k);
        if (ev.code === 'ArrowRight' || ev.code === 'ArrowLeft') {
          ev.preventDefault();
          ev.stopPropagation();
          const n = PLATE_KINDS[(i + (ev.code === 'ArrowRight' ? 1 : PLATE_KINDS.length - 1)) % PLATE_KINDS.length];
          this.setKind(n);
          this.tabBtns.get(n)?.focus();
        }
      });
      this.tabBtns.set(k, t);
      tabs.append(t);
    }
    const scroll = el('div', 'npe-scroll');

    // snapping, zoom
    const bar = el('div', 'npe-bar');
    const chk = (text: string, get: () => boolean, set: (v: boolean) => void, title = '') => {
      const l = el('label');
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = get();
      c.addEventListener('change', () => {
        set(c.checked);
        savePrefs(this.prefs);
        this.render();
      });
      l.title = title;
      l.append(c, document.createTextNode(text));
      bar.append(l);
      return c;
    };
    this.snapBtn = chk('Snap', () => this.prefs.snap, (v) => (this.prefs.snap = v), 'Parts snap to each other and to the anchor while you drag (hold Alt to skip a snap)');
    this.guideBtn = chk('Guide lines', () => this.prefs.guides, (v) => (this.prefs.guides = v));
    const zl = el('label', '', 'Zoom ');
    this.zoomSel = document.createElement('select');
    for (const [v, t] of [[0, 'Fit'], [1, '1×'], [2, '2×'], [3, '3×'], [4, '4×']] as [number, string][]) this.zoomSel.append(new Option(t, String(v)));
    this.zoomSel.value = String(this.prefs.zoom);
    this.zoomSel.addEventListener('change', () => {
      this.prefs.zoom = Number(this.zoomSel.value);
      this.needFit = true;
      savePrefs(this.prefs);
      this.render();
    });
    zl.append(this.zoomSel);
    bar.append(zl);
    scroll.append(bar);

    // what the sample shows
    const prev = el('div', 'npe-bar');
    prev.append(el('small', '', 'Sample shows:'));
    const sw = (text: string, key: 'mark' | 'target' | 'avatar' | 'title' | 'res' | 'cast') => {
      const l = el('label');
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = this.sample[key];
      c.addEventListener('change', () => {
        this.sample[key] = c.checked;
        this.render();
      });
      l.append(c, document.createTextNode(text));
      prev.append(l);
    };
    sw('Raid mark', 'mark');
    sw('Targeted', 'target');
    sw('Avatar', 'avatar');
    sw('Title', 'title');
    sw('Resource', 'res');
    sw('Casting', 'cast');
    const al = el('label', '', 'Effects ');
    const an = document.createElement('input');
    an.type = 'number';
    an.min = '0';
    an.max = '12';
    an.value = String(this.sample.auras);
    an.style.width = '48px';
    an.addEventListener('change', () => {
      this.sample.auras = Math.max(0, Math.min(12, Math.round(Number(an.value) || 0)));
      an.value = String(this.sample.auras);
      this.render();
    });
    al.append(an);
    prev.append(al);
    scroll.append(prev);

    // parts
    scroll.append(el('div', 'npe-sec', 'Parts (click one here or in the picture)'));
    const chips = el('div', 'npe-chips');
    for (const id of ['plate', ...PART_IDS] as (PartId | 'plate')[]) {
      const c = el('button', 'npe-chip', id === 'plate' ? 'Whole plate' : PART_LABEL[id]);
      c.addEventListener('click', () => this.select(id));
      this.chips.set(id, c);
      chips.append(c);
    }
    scroll.append(chips, this.card);

    // presets, copy, reset
    scroll.append(el('div', 'npe-sec', 'Start from'));
    const presets = el('div', 'npe-presets');
    for (const pr of PLATE_PRESETS) {
      const b = el('button', 'b', pr.name);
      b.title = pr.desc;
      b.addEventListener('click', () => {
        this.prof = pr.make();
        this.needFit = true;
        this.commit();
      });
      presets.append(b);
    }
    scroll.append(presets);
    const copyRow = el('div', 'npe-bar');
    const from = document.createElement('select');
    for (const k of PLATE_KINDS) from.append(new Option(PLATE_KIND_LABEL[k], k));
    const copyBtn = el('button', 'b', 'Copy to this tab');
    copyBtn.addEventListener('click', () => {
      const f = from.value as PlateKind;
      if (f === this.kind) return;
      this.prof = cloneProfile(copyPlate(f, this.kind));
      this.commit(false);
    });
    const copyOther = el('button', 'b', 'Copy this to all others');
    copyOther.addEventListener('click', () => {
      for (const k of PLATE_KINDS) if (k !== this.kind) copyPlate(this.kind, k);
    });
    const lab = el('label', '', 'Copy from ');
    lab.append(from);
    copyRow.append(lab, copyBtn, copyOther);
    scroll.append(copyRow);
    const resetRow = el('div', 'npe-bar');
    const confirm = (btn: HTMLButtonElement, text: string, act: () => void) => {
      let t = 0;
      btn.addEventListener('click', () => {
        if (!t) {
          btn.textContent = 'Click again to confirm';
          t = window.setTimeout(() => {
            btn.textContent = text;
            t = 0;
          }, 3000);
          return;
        }
        window.clearTimeout(t);
        t = 0;
        btn.textContent = text;
        act();
      });
    };
    const rp = el('button', 'b warn', 'Reset this profile');
    confirm(rp, 'Reset this profile', () => {
      this.prof = cloneProfile(resetPlate(this.kind));
      this.commit(false);
    });
    const ra = el('button', 'b warn', 'Reset all three');
    confirm(ra, 'Reset all three', () => {
      for (const k of PLATE_KINDS) resetPlate(k);
      this.prof = cloneProfile(plateProfile(this.kind));
      this.commit(false);
    });
    resetRow.append(rp, ra);
    scroll.append(resetRow);

    // every option, by group
    for (const g of FIELD_GROUPS) {
      const d = document.createElement('details');
      d.open = g === 'Plate';
      d.append(el('summary', '', g));
      const body = el('div');
      for (const f of PLATE_FIELDS.filter((x) => x.group === g)) body.append(this.buildField(f));
      if (g === 'Buffs and debuffs') body.prepend(this.buildAuraSide());
      d.append(body);
      scroll.append(d);
    }
    panel.append(head, tabs, scroll);
    root.append(stage, panel);
  }

  /** "Icons sit above / below the plate" is a shortcut for the buff row's attachment. */
  private buildAuraSide(): HTMLElement {
    const row = el('div', 'npe-row');
    row.append(el('label', '', 'Icons sit'));
    const ctl = el('div', 'ctl');
    const sel = document.createElement('select');
    sel.append(new Option('Below the bars', 'below'), new Option('Above the name', 'above'));
    sel.addEventListener('change', () => {
      setAuraSide(this.prof, sel.value as 'above' | 'below');
      this.commit();
    });
    ctl.append(sel);
    row.append(ctl);
    this.rows.push({ field: { path: 'auras.side', label: '', group: '', kind: 'choice' }, row, refresh: () => (sel.value = auraSide(this.prof)) });
    return row;
  }

  private enabledIf(path: string): boolean {
    const p = this.prof;
    switch (path) {
      case 'fade.near': case 'fade.far': return p.fade.on;
      case 'name.custom': return p.name.color === 'custom';
      case 'bar.custom': return p.bar.color === 'custom';
      case 'bar.textSize': return p.bar.text !== 'none';
      case 'auras.width': return p.auras.layout === 'wrap';
      case 'auras.cols': return p.auras.layout === 'columns';
      case 'name.size': case 'name.weight': case 'name.color': case 'name.outline': case 'title.show': return p.name.show;
      case 'icon.size': return p.icon.show;
      case 'res.h': return p.res.show;
      case 'cast.h': return p.cast.show;
      default:
        if (path.startsWith('auras.') && path !== 'auras.show') return p.auras.show;
        return true;
    }
  }

  private buildField(f: Field): HTMLElement {
    const row = el('div', 'npe-row');
    row.append(el('label', '', f.label + (f.unit && f.kind === 'num' ? ` (${f.unit})` : '')));
    const ctl = el('div', 'ctl');
    const get = () => getPath(this.prof, f.path);
    const set = (v: unknown) => {
      if (f.path === 'anchor') {
        setAnchor(this.prof, v as 'head' | 'feet');
        this.needFit = true;
      }
      else setPath(this.prof as unknown as Record<string, unknown>, f.path, v);
      this.commit();
    };
    let refresh = () => {};
    if (f.kind === 'bool') {
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.addEventListener('change', () => set(c.checked));
      ctl.append(c);
      refresh = () => (c.checked = !!get());
    } else if (f.kind === 'num') {
      const r = document.createElement('input');
      r.type = 'range';
      r.min = String(f.min);
      r.max = String(f.max);
      r.step = String(f.step ?? 1);
      const n = document.createElement('input');
      n.type = 'number';
      n.min = r.min;
      n.max = r.max;
      n.step = r.step;
      r.addEventListener('input', () => set(Number(r.value)));
      n.addEventListener('change', () => {
        if (n.value !== '') set(Number(n.value));
        else refresh();
      });
      ctl.append(r, n);
      refresh = () => {
        const v = String(get());
        r.value = v;
        if (document.activeElement !== n) n.value = v;
      };
    } else if (f.kind === 'choice') {
      const s = document.createElement('select');
      for (const [v, t] of f.choices ?? []) s.append(new Option(t, v));
      s.addEventListener('change', () => set(s.value));
      ctl.append(s);
      refresh = () => (s.value = String(get()));
    } else {
      const c = document.createElement('input');
      c.type = 'color';
      c.addEventListener('input', () => set(c.value));
      ctl.append(c);
      refresh = () => (c.value = String(get()));
    }
    row.append(ctl);
    this.rows.push({
      field: f,
      row,
      refresh: () => {
        refresh();
        const on = this.enabledIf(f.path);
        row.classList.toggle('off', !on);
        for (const i of ctl.querySelectorAll('input,select')) (i as HTMLInputElement).disabled = !on;
      },
    });
    return row;
  }

  // ------------------------------------------------------------------ state

  private setKind(k: PlateKind): void {
    this.kind = k;
    this.needFit = true;
    this.prof = cloneProfile(plateProfile(k));
    for (const [kk, b] of this.tabBtns) {
      b.setAttribute('aria-selected', String(kk === k));
      b.tabIndex = kk === k ? 0 : -1;
    }
    this.render();
  }

  private select(s: Sel): void {
    this.selected = s;
    this.render();
  }

  /** Use and save the working profile, then redraw. */
  private commit(rebuildFocus = true): void {
    const clean = setPlate(this.kind, this.prof);
    this.prof = cloneProfile(clean);
    void rebuildFocus;
    this.render();
  }

  // ------------------------------------------------------------------ drawing

  private sampleAuras(): AuraIcon[] {
    const n = this.sample.auras;
    const nb = Math.min(SAMPLE_BUFFS.length, Math.floor(n / 3)); // a few buffs too, so "buffs and debuffs" shows more than "debuffs only"
    const bad = Array.from({ length: n - nb }, (_, i) => ({ id: SAMPLE_AURAS[i % SAMPLE_AURAS.length], src: i % 2 === 0 ? 1 : 2, stacks: i === 2 ? 3 : 0, expiresAt: (3 + i * 4) * 1000 }));
    const good = SAMPLE_BUFFS.slice(0, nb).map((id, i) => ({ id, src: 1, stacks: 0, expiresAt: (9 + i * 5) * 1000 }));
    const list = [...bad, ...good].filter((a) => AURAS[a.id]);
    const info = (id: string) => ({ harmful: !!AURAS[id]?.harmful, kind: AURAS[id]?.kind });
    return pickAuras(this.prof.auras, list, info, 1).map((a) => ({ id: a.id, glyph: AURA_ICON[a.id] ?? '✦', harmful: !!AURAS[a.id]?.harmful, secs: Math.ceil(a.expiresAt / 1000), stacks: a.stacks ?? 0, title: AURAS[a.id]?.name }));
  }

  private fillSample(): void {
    const v = this.view;
    const p = this.prof;
    const enemy = this.kind === 'enemy';
    const cls = CLASSES.mage?.color ?? '#6fa8ff';
    const teamColor = enemy ? '#ff8a7a' : '#a8f0b8';
    v.name.textContent = this.kind === 'me' ? 'You' : enemy ? 'Grimjaw' : 'Aldric';
    const nameColor = p.name.color === 'class' ? cls : p.name.color === 'custom' ? p.name.custom : teamColor;
    v.name.style.color = nameColor;
    v.name.style.textShadow = v.nameBase;
    v.title.textContent = '«Warden»';
    const hp = 7200;
    const max = 10000;
    v.bar.setColor(p.bar.color === 'custom' ? p.bar.custom : fillFor(p.bar.color, enemy, hp / max, cls));
    v.bar.set(hp, max, barText(p.bar.text, hp, max), 900);
    v.res.setColor('#3b82f6');
    v.res.set(60, 100, '');
    v.cast.setColor(enemy ? 'linear-gradient(#ff9a52,#d94a1c)' : 'linear-gradient(#ffd966,#d9962a)');
    v.cast.set(45, 100, 'Fireball');
    v.mark.textContent = '⭐';
    v.mark.classList.toggle('hidden', !this.sample.mark);
    v.arrow.textContent = p.anchor === 'feet' ? '▲' : '▼';
    v.arrow.classList.toggle('enemy', enemy);
    v.arrow.classList.toggle('hidden', !this.sample.target || !p.target.arrow);
    v.root.classList.toggle('targeted', this.sample.target);
    v.res.root.classList.toggle('hidden', !this.sample.res);
    v.cast.root.classList.toggle('hidden', !this.sample.cast);
    if (!v.icon.firstChild && this.sample.avatar) {
      const img = document.createElement('img');
      img.className = 'pav';
      img.alt = '';
      img.src = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><radialGradient id="a" cx="35%" cy="30%"><stop offset="0" stop-color="#ffe9a0"/><stop offset="1" stop-color="#8a5a1a"/></radialGradient></defs><rect width="40" height="40" fill="url(#a)"/><circle cx="20" cy="16" r="7" fill="#3a2a10"/><path d="M6 40 Q20 20 34 40Z" fill="#3a2a10"/></svg>')}`;
      v.icon.append(img);
    }
  }

  /** Redraw the sample and the overlay from the working profile (and refresh the panel's values). */
  render(): void {
    if (!this.open) return;
    const p = this.prof;
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    if (W === 0 || H === 0) return;
    const items = this.sampleAuras();
    this.ctx = { hasMark: this.sample.mark, hasArrow: this.sample.target, hasAvatar: this.sample.avatar, hasTitle: this.sample.title, hasRes: this.sample.res, hasCast: this.sample.cast, auraCount: items.length };
    const lay = this.view.apply(p, this.ctx);
    this.lay = lay;
    if (this.needFit) this.refit(W, H, lay);
    const Z = this.zoom;
    this.world.style.transform = `translate(${this.origin.x}px, ${this.origin.y}px) scale(${Z})`;
    this.view.setAuras(items, p);
    if (!this.sample.avatar) this.view.icon.replaceChildren();
    this.fillSample();
    const ay = (p.anchor === 'head' ? HEAD_ANCHOR : 0) - p.offsetY;
    this.view.position(0, ay, 1, 1, 2);
    this.layoutOverlay(lay, ay);
    this.paintGuides();
    // panel
    for (const r of this.rows) r.refresh();
    for (const [k, b] of this.tabBtns) b.setAttribute('aria-selected', String(k === this.kind));
    for (const [id, c] of this.chips) {
      c.classList.toggle('sel', this.selected === id);
      c.classList.toggle('off', id !== 'plate' && !lay.parts[id].visible);
      c.setAttribute('aria-pressed', String(this.selected === id));
    }
    this.paintCard();
  }

  /**
   * Pick the zoom and the picture's place so the sample unit and the whole plate fit. Done when something big changes (a tab,
   * the anchor, a preset, the window), not on every edit, so the picture does not jump around while you drag.
   */
  private refit(W: number, H: number, lay: PlateLayout): void {
    this.needFit = false;
    const p = this.prof;
    const ay = (p.anchor === 'head' ? HEAD_ANCHOR : 0) - p.offsetY;
    let x0 = -60;
    let x1 = 60;
    let y0 = -FIG_H;
    let y1 = 14;
    const b = lay.bounds;
    if (b) {
      x0 = Math.min(x0, b.x - 6);
      x1 = Math.max(x1, b.x + b.w + 6);
      y0 = Math.min(y0, b.y + ay - 6);
      y1 = Math.max(y1, b.y + b.h + ay + 6);
    }
    const availH = H - 48;
    this.zoom = this.prefs.zoom || Math.max(1, Math.min(4, Math.floor(Math.min((W - 40) / (x1 - x0), (availH - 20) / (y1 - y0)) * 10) / 10));
    this.origin = { x: W / 2 - ((x0 + x1) / 2) * this.zoom, y: availH / 2 + 8 - ((y0 + y1) / 2) * this.zoom };
  }

  private needFit = true;

  private sx(x: number): number {
    return this.origin.x + x * this.zoom;
  }
  private sy(y: number, ay: number): number {
    return this.origin.y + (y + ay) * this.zoom;
  }

  private layoutOverlay(lay: PlateLayout, ay: number): void {
    const Z = this.zoom;
    for (const id of PART_IDS) {
      const r = lay.parts[id];
      const b = this.boxes.get(id)!;
      b.style.display = r.visible ? '' : 'none';
      b.style.left = `${this.sx(r.x)}px`;
      b.style.top = `${this.sy(r.y, ay)}px`;
      b.style.width = `${Math.max(6, r.w * Z)}px`;
      b.style.height = `${Math.max(6, r.h * Z)}px`;
      b.classList.toggle('sel', this.selected === id);
      b.style.zIndex = this.selected === id ? '2' : '1';
    }
    // the anchor line
    const a = this.anchorEl;
    a.style.left = `${this.sx(-150)}px`;
    a.style.width = `${300 * Z}px`;
    a.style.top = `${this.sy(0, ay)}px`;
    (a.lastElementChild as HTMLElement).textContent = this.prof.anchor === 'head' ? 'Head anchor' : 'Feet anchor';
    // whole plate
    const bnd = lay.bounds;
    const pb = this.plateBox;
    pb.style.display = bnd ? '' : 'none';
    this.plateHandle.style.display = bnd ? '' : 'none';
    if (bnd) {
      const pad = 4;
      pb.style.left = `${this.sx(bnd.x) - pad}px`;
      pb.style.top = `${this.sy(bnd.y, ay) - pad}px`;
      pb.style.width = `${bnd.w * Z + pad * 2}px`;
      pb.style.height = `${bnd.h * Z + pad * 2}px`;
      pb.classList.toggle('sel', this.selected === 'plate');
      const head = this.prof.anchor === 'head';
      this.plateHandle.style.left = `${this.sx(bnd.x + bnd.w) + pad}px`;
      this.plateHandle.style.top = `${(head ? this.sy(bnd.y, ay) - pad : this.sy(bnd.y + bnd.h, ay) + pad)}px`;
    }
    this.placeHandles(lay, ay);
  }

  /** Which sides of a part grow when it is resized: the free ones (its attached edge stays where it is). */
  private growth(id: PartId): { sx: 1 | -1; sy: 1 | -1; kx: 1 | 2; ky: 1 | 2 } {
    const side: Side = this.prof.parts[id].side;
    return { sx: side === 'left' ? -1 : 1, sy: side === 'above' ? -1 : 1, kx: side === 'left' || side === 'right' ? 1 : 2, ky: side === 'above' || side === 'below' ? 1 : 2 };
  }

  private resizable(id: PartId): { w: boolean; h: boolean } {
    switch (id) {
      case 'bar': return { w: true, h: true };
      case 'res': case 'cast': case 'name': return { w: false, h: true };
      case 'icon': return { w: false, h: true };
      case 'auras': return { w: true, h: true };
      default: return { w: false, h: false };
    }
  }

  /** Where the handles of a part sit (layout coordinates): its free edges; the buff row's width handle is at the width a row wraps at. */
  private edgeOf(id: PartId, r: Rect): { x: number; y: number } {
    const g = this.growth(id);
    const p = this.prof;
    let x = g.sx > 0 ? r.x + r.w : r.x;
    if (id === 'auras') {
      const cap = p.auras.layout === 'columns' ? p.auras.cols * p.auras.size * p.scaleH + (p.auras.cols - 1) * 2 * p.scaleH : p.auras.width * p.scaleW;
      x = r.x + r.w / 2 + (g.sx * cap) / 2;
    }
    return { x, y: g.sy > 0 ? r.y + r.h : r.y };
  }

  private placeHandles(lay: PlateLayout, ay: number): void {
    const id = this.selected && this.selected !== 'plate' ? this.selected : null;
    const [hw, hh, hc] = this.handles;
    for (const h of this.handles) h.style.display = 'none';
    if (!id || !lay.parts[id].visible) return;
    const r = lay.parts[id];
    const can = this.resizable(id);
    const g = this.growth(id);
    const Z = this.zoom;
    const L = this.sx(r.x);
    const T = this.sy(r.y, ay);
    const wpx = r.w * Z;
    const hpx = r.h * Z;
    const e = this.edgeOf(id, r);
    const xEdge = this.sx(e.x);
    const yEdge = this.sy(e.y, ay);
    if (can.w) {
      hw.style.display = '';
      hw.style.left = `${xEdge}px`;
      hw.style.top = `${T + hpx / 2}px`;
    }
    if (can.h) {
      hh.style.display = '';
      hh.style.left = `${L + wpx / 2}px`;
      hh.style.top = `${yEdge}px`;
    }
    if (can.w && can.h) {
      hc.style.display = '';
      hc.style.left = `${xEdge}px`;
      hc.style.top = `${yEdge}px`;
    }
  }

  private paintGuides(): void {
    const Z = this.zoom;
    const ay = (this.prof.anchor === 'head' ? HEAD_ANCHOR : 0) - this.prof.offsetY;
    this.guideEls.forEach((g, i) => {
      const gd = this.prefs.guides ? this.guides[i] : undefined;
      if (!gd) {
        g.style.display = 'none';
        return;
      }
      g.style.display = '';
      if (gd.axis === 'x') {
        g.style.left = `${this.sx(gd.at)}px`;
        g.style.top = `${this.sy(gd.from, ay)}px`;
        g.style.width = '1px';
        g.style.height = `${(gd.to - gd.from) * Z}px`;
      } else {
        g.style.left = `${this.sx(gd.from)}px`;
        g.style.top = `${this.sy(gd.at, ay)}px`;
        g.style.height = '1px';
        g.style.width = `${(gd.to - gd.from) * Z}px`;
      }
    });
  }

  // ------------------------------------------------------------------ the selected part's card

  private paintCard(): void {
    const card = this.card;
    card.replaceChildren();
    const sel = this.selected;
    if (!sel) {
      card.append(el('small', '', 'Nothing selected. Click a part (in the picture or the list above) to change how it is attached.'));
      return;
    }
    if (sel === 'plate') {
      card.append(el('h4', '', 'Whole plate'), el('small', '', 'Drag the round handle to scale it, or the blue ring to move it up and down. It is anchored at the unit\'s head or feet (Plate section below).'));
      return;
    }
    const a = this.prof.parts[sel];
    card.append(el('h4', '', PART_LABEL[sel]));
    if (!this.lay?.parts[sel].visible) card.append(el('small', '', 'Not on the sample right now (turned off, or empty). Its place is kept.'));
    const r1 = el('div', 'r');
    const lab = (t: string, c: HTMLElement) => {
      const l = el('label', '', `${t} `);
      l.append(c);
      return l;
    };
    const to = document.createElement('select');
    to.append(new Option('The plate', 'plate'));
    for (const id of PART_IDS) if (id !== sel && canAttach(this.prof.parts, sel, id)) to.append(new Option(PART_LABEL[id], id));
    to.value = a.to;
    const side = document.createElement('select');
    for (const s of SIDES) side.append(new Option(SIDE_LABEL[s], s));
    side.value = a.side;
    const move = () => {
      if (reattach(this.prof, this.ctx, sel, to.value as PartId | 'plate', side.value as Side)) this.commit();
    };
    to.addEventListener('change', move);
    side.addEventListener('change', move);
    r1.append(lab('Anchored to', to), lab('on its', side));
    const r2 = el('div', 'r');
    const num = (get: () => number, set: (v: number) => void) => {
      const n = document.createElement('input');
      n.type = 'number';
      n.step = '1';
      n.value = String(get());
      n.addEventListener('change', () => {
        const v = Number(n.value);
        if (Number.isFinite(v)) set(Math.max(-500, Math.min(500, v)));
        this.commit();
      });
      return n;
    };
    r2.append(lab('Offset x', num(() => a.dx, (v) => (a.dx = v))), lab('y', num(() => a.dy, (v) => (a.dy = v))));
    const flush = el('button', 'b', 'Flush');
    flush.title = 'Put it right against its anchor (offset 0)';
    flush.addEventListener('click', () => {
      a.dx = 0;
      a.dy = 0;
      this.commit();
    });
    const reset = el('button', 'b warn', 'Reset part');
    reset.title = 'Put this part\'s size and place back to the classic ones';
    reset.addEventListener('click', () => {
      resetPart(this.prof, sel);
      this.commit();
    });
    r2.append(flush, reset);
    card.append(r1, r2, el('small', '', sel === 'title' ? 'The title follows the name\'s text size.' : 'Parts attached to this one move with it.'));
  }

  // ------------------------------------------------------------------ dragging

  private beginMove(ev: PointerEvent, id: PartId): void {
    if (ev.button !== 0 || !this.lay) return;
    ev.preventDefault();
    this.boxes.get(id)?.focus({ preventScroll: true }); // so the arrow keys nudge this part
    this.select(id);
    const kids = descendants(this.prof.parts, id);
    const lay = this.lay;
    this.drag = {
      kind: 'move',
      id,
      px: ev.clientX,
      py: ev.clientY,
      rect: { x: lay.parts[id].x, y: lay.parts[id].y, w: lay.parts[id].w, h: lay.parts[id].h },
      dx0: this.prof.parts[id].dx,
      dy0: this.prof.parts[id].dy,
      others: PART_IDS.filter((q) => q !== id && !kids.includes(q) && lay.parts[q].visible).map((q) => lay.parts[q]),
    };
  }

  private beginResize(ev: PointerEvent, axis: 'w' | 'h' | 'c'): void {
    const id = this.selected;
    if (ev.button !== 0 || !id || id === 'plate' || !this.lay) return;
    ev.preventDefault();
    ev.stopPropagation();
    const lay = this.lay;
    const kids = descendants(this.prof.parts, id);
    this.boxes.get(id)?.focus({ preventScroll: true });
    this.drag = {
      kind: 'resize',
      id,
      axis,
      px: ev.clientX,
      py: ev.clientY,
      rect: { x: lay.parts[id].x, y: lay.parts[id].y, w: lay.parts[id].w, h: lay.parts[id].h },
      others: PART_IDS.filter((q) => q !== id && !kids.includes(q) && lay.parts[q].visible).map((q) => lay.parts[q]),
      start: { scaleW: this.prof.scaleW, scaleH: this.prof.scaleH, w: lay.parts[id].w, h: lay.parts[id].h, offsetY: 0, param: this.paramOf(id, 'w'), param2: this.paramOf(id, 'h') },
    };
  }

  private beginScale(ev: PointerEvent): void {
    if (ev.button !== 0 || !this.lay?.bounds) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.select('plate');
    const b = this.lay.bounds;
    this.drag = { kind: 'scale', px: ev.clientX, py: ev.clientY, start: { scaleW: this.prof.scaleW, scaleH: this.prof.scaleH, w: b.w, h: b.h, offsetY: 0, param: 0, param2: 0 } };
  }

  private beginOffset(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    ev.preventDefault();
    this.select('plate');
    this.drag = { kind: 'offset', px: ev.clientX, py: ev.clientY, start: { scaleW: 1, scaleH: 1, w: 0, h: 0, offsetY: this.prof.offsetY, param: 0, param2: 0 } };
  }

  /** The option a part's size handles change, for readouts and the drag's starting values. */
  private paramOf(id: PartId, axis: 'w' | 'h'): number {
    const p = this.prof;
    switch (id) {
      case 'bar': return axis === 'w' ? p.bar.w : p.bar.h;
      case 'res': return p.res.h;
      case 'cast': return p.cast.h;
      case 'name': return p.name.size;
      case 'icon': return p.icon.size;
      case 'auras': return axis === 'w' ? (p.auras.layout === 'columns' ? p.auras.cols : p.auras.width) : p.auras.size;
      default: return 0;
    }
  }

  private onPointerMove = (ev: PointerEvent) => {
    const d = this.drag;
    if (!d || !this.lay) return;
    const Z = this.zoom;
    const p = this.prof;
    const snapOn = this.prefs.snap && !ev.altKey;
    const thr = SNAP_PX / Z;
    let dx = (ev.clientX - d.px) / Z;
    let dy = (ev.clientY - d.py) / Z;
    this.guides = [];
    if (d.kind === 'move' && d.id && d.rect && d.others) {
      if (ev.shiftKey && Math.abs(dx) > Math.abs(dy)) dy = 0;
      else if (ev.shiftKey) dx = 0;
      if (snapOn) {
        const cand: Rect = { x: d.rect.x + dx, y: d.rect.y + dy, w: d.rect.w, h: d.rect.h };
        const pl = this.lay.plate;
        const s = snapMove(cand, d.others, { x: [0, pl.x, pl.x + pl.w], y: [0] }, thr);
        dx += s.dx;
        dy += s.dy;
        this.guides = s.guides;
      }
      const a = p.parts[d.id];
      a.dx = Math.round(Math.max(-500, Math.min(500, (d.dx0 ?? 0) + dx / p.scaleW)) * 10) / 10;
      a.dy = Math.round(Math.max(-500, Math.min(500, (d.dy0 ?? 0) + dy / p.scaleH)) * 10) / 10;
    } else if (d.kind === 'resize' && d.id && d.rect && d.start && d.others) {
      this.resizeDrag(d, dx, dy, snapOn, thr);
    } else if (d.kind === 'scale' && d.start) {
      const head = p.anchor === 'head';
      let sdx = dx * 2;
      let sdy = head ? -dy : dy;
      if (snapOn && Math.abs(sdx) < 8 / Z && Math.abs(sdy) < 8 / Z) {
        sdx = 0;
        sdy = 0;
      }
      resizePlate(p, d.start, sdx, sdy, ev.shiftKey);
    } else if (d.kind === 'offset' && d.start) {
      let off = d.start.offsetY - dy;
      if (snapOn) {
        const s = snapEdge(off, [0], thr * 1.5);
        if (s) off += s.delta;
      }
      p.offsetY = Math.round(Math.max(-150, Math.min(150, off)));
    }
    this.commit();
  };

  private resizeDrag(d: Drag, dx: number, dy: number, snapOn: boolean, thr: number): void {
    const id = d.id as PartId;
    const p = this.prof;
    const st = d.start!;
    const r = d.rect!;
    const g = this.growth(id);
    const can = this.resizable(id);
    const axis = d.axis as 'w' | 'h' | 'c';
    const pl = this.lay!.plate;
    const e0 = this.edgeOf(id, r);
    let ex = dx * g.sx; // how far the free edge moved
    let ey = dy * g.sy;
    // snap the moving edge to the lines of the other parts and the plate
    if (snapOn) {
      if (axis === 'w' && can.w) {
        const tx = [0, pl.x, pl.x + pl.w, ...d.others!.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])];
        const s = snapEdge(e0.x + dx, tx, thr);
        if (s) {
          ex += g.sx * s.delta;
          this.guides.push({ axis: 'x', at: s.at, from: r.y - 8, to: r.y + r.h + 8 });
        }
      }
      if ((axis === 'h' || axis === 'c') && can.h) {
        const ty = [0, ...d.others!.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h])];
        const s = snapEdge(e0.y + dy, ty, thr);
        if (s) {
          ey += g.sy * s.delta;
          this.guides.push({ axis: 'y', at: s.at, from: r.x - 8, to: r.x + r.w + 8 });
        }
      }
    }
    const dW = ex * g.kx; // how much wider the part gets
    const dH = ey * g.ky;
    const sw = p.scaleW;
    const sh = p.scaleH;
    switch (id) {
      case 'bar':
        if (axis === 'w' || axis === 'c') setNum(p, 'bar.w', st.param + dW / sw);
        if (axis === 'h' || axis === 'c') setNum(p, 'bar.h', st.param2 + dH / sh);
        break;
      case 'res': setNum(p, 'res.h', st.param2 + dH / sh); break;
      case 'cast': setNum(p, 'cast.h', st.param2 + dH / sh); break;
      case 'name': setNum(p, 'name.size', st.param2 + dH / sh / 1.25); break;
      case 'icon': setNum(p, 'icon.size', st.param2 + dH / sh); break;
      case 'auras': {
        if (axis === 'w') {
          if (p.auras.layout === 'columns') setNum(p, 'auras.cols', Math.round(st.param + dW / (p.auras.size * sh + 2 * sh)));
          else setNum(p, 'auras.width', st.param + dW / sw);
        } else {
          const rows = Math.max(1, auraGrid(p, Math.max(1, this.ctx.auraCount)).rows);
          setNum(p, 'auras.size', st.param2 + dH / rows / sh);
        }
        break;
      }
      default: break;
    }
  }

  private onPointerUp = () => {
    if (!this.drag) return;
    if (this.drag.kind === 'scale') this.needFit = true; // a bigger plate may no longer fit the picture
    this.drag = null;
    this.guides = [];
    this.render();
  };
}

// ------------------------------------------------------------------ public API

let editor: NameplateEditor | null = null;
let closedCb: (() => void) | undefined;

/** Open the nameplate editor (over the menu, the HUD editor's pretend fight or a match). `onClose` runs when it closes. */
export function openNameplateEditor(opts: { kind?: PlateKind; onClose?: () => void } = {}): void {
  closedCb = opts.onClose;
  if (!editor) editor = new NameplateEditor(() => closedCb?.());
  editor.show(opts.kind);
}

export function closeNameplateEditor(): void {
  editor?.close();
}

export const nameplateEditorOpen = (): boolean => !!editor?.open;

export { PLATE_FIELDS, FIELD_GROUPS, PLATE_PRESETS, PLATE_KINDS, PLATE_KIND_LABEL } from './nameplateLayout';
