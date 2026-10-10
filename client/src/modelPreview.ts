import * as THREE from 'three';
import { MODELS_DATA, CLASSES, gearLook, itemsForSlot, jumpHeight, pristineModels } from '@arena/shared';
import type { ClassId } from '@arena/shared';
import { createCharacter } from './models';
import type { Character } from './models';
import { modelVersion } from './riggedModels';
import { applyModelData } from './modelData';
import { playOn, readAnimationFile, retarget } from './animRetarget';
import type { LoadedClip } from './animRetarget';
import { el } from './bar';

/**
 * The Models page's view of the model: a window of its own that floats over the game like the HUD editor's pieces (drag its title
 * to move it, pull its corner to resize it, it remembers where it was), with the character as it is now beside the character as
 * it shipped, turning together, so every change can be judged against the original. Both are built by the game's own model
 * code; the shipped one is built while the file's untouched numbers are applied, so it keeps them. Buttons stand, walk, run, swing,
 * cast and jump; an animation file (.glb or .fbx) can be dropped onto any of them to see how the model moves with it, matched to the
 * character's bones by name. Drag a picture to turn both, wheel to zoom, right-drag to raise or lower the view.
 */

export interface PreviewSpec {
  classId: ClassId;
  /** A weapon id of weaponModels.ts (the specs' weapons); empty: the class default. */
  weapon?: string;
}

type Mode = 'stand' | 'walk' | 'run' | 'swing' | 'cast' | 'jump';
const MODES: [Mode, string][] = [['stand', 'Stand'], ['walk', 'Walk'], ['run', 'Run'], ['swing', 'Swing'], ['cast', 'Cast'], ['jump', 'Jump']];
const SLOTS: [string, string][] = [['head', 'Head'], ['back', 'Back'], ['wings', 'Wings'], ['weapon', 'Weapon glow']];
const KEY = 'arena.modelwin.v1';

/** What every picture of the window shares, so they turn and move together. */
interface Shared {
  spec: PreviewSpec;
  gear: Record<string, string>;
  mode: Mode;
  spin: boolean;
  yaw: number;
  pitch: number;
  dist: number;
  lookY: number;
  time: number;
  /** Bumped when a button restarts the motion (a swing or a jump starts over in every picture). */
  restart: number;
  /** Animation files tried per motion: the "Now" picture plays them (the shipped one keeps the built-in motion to compare with). */
  anims: Partial<Record<Mode, LoadedClip>>;
  animRev: number;
  /** What the last file said about itself (bones matched), per mode. */
  animNote: Partial<Record<Mode, string>>;
}

/** One picture: a canvas, a renderer, and the character built for the shared state. */
class ModelView {
  readonly canvas = document.createElement('canvas');
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  private char: Character | null = null;
  private builtFor = '';
  private phase = 0;
  private swingAt = -9;
  private jumpAt = 0;
  private seenRestart = -1;
  private seenAnim = -1;
  private mixer: THREE.AnimationMixer | null = null;
  private mixerMode: Mode | null = null;
  failed = false;

  constructor(readonly label: string, private pristine: boolean) {
    this.canvas.className = 'mwin-canvas';
    this.canvas.title = `${label}. Drag to turn, wheel to zoom.`;
  }

  private ensure(): THREE.WebGLRenderer | null {
    if (this.renderer || this.failed) return this.renderer;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.scene.background = new THREE.Color(this.pristine ? 0x1d1a24 : 0x1b2226);
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x554466, 1.6));
      const sun = new THREE.DirectionalLight(0xfff0dd, 1.8);
      sun.position.set(3, 6, 4);
      this.scene.add(sun);
      const floor = new THREE.Mesh(new THREE.CircleGeometry(2.2, 40), new THREE.MeshBasicMaterial({ color: this.pristine ? 0x2a2535 : 0x253238 }));
      floor.rotation.x = -Math.PI / 2;
      this.scene.add(floor);
    } catch {
      this.failed = true;
    }
    return this.renderer;
  }

  private key(s: Shared): string {
    return `${modelVersion()}|${s.spec.classId}|${s.spec.weapon ?? ''}|${JSON.stringify(s.gear)}`;
  }

  private build(s: Shared): void {
    if (this.char) this.scene.remove(this.char.root);
    this.char = null;
    this.mixer = null;
    this.mixerMode = null;
    const look = gearLook(s.gear);
    const make = () => createCharacter(s.spec.classId, /^-*$/.test(look) ? undefined : look, s.spec.weapon || undefined);
    try {
      if (this.pristine) {
        // built with the data file's own numbers, then the live ones go back (without telling the scenes to rebuild)
        applyModelData(pristineModels(), false);
        try {
          this.char = make();
        } finally {
          applyModelData(MODELS_DATA, false);
        }
      } else this.char = make();
      this.scene.add(this.char.root);
    } catch {
      this.char = null;
    }
    this.builtFor = this.key(s);
    this.seenAnim = -1;
  }

  /** The animation file for the mode on show, retargeted onto this character (only the "Now" picture plays files). */
  private syncMixer(s: Shared): void {
    const loaded = this.pristine ? undefined : s.anims[s.mode];
    if (!loaded || !this.char) {
      this.mixer = null;
      this.mixerMode = null;
      return;
    }
    const r = retarget(this.char.root, loaded);
    if (!r) {
      s.animNote[s.mode] = 'Too few of its bones match this character by name to move it (it needs hips, spine, head, arms and legs).';
      this.mixer = null;
      return;
    }
    s.animNote[s.mode] = `${loaded.name}: ${r.matched} of 19 bones matched${r.missing.length ? `; not moved: ${r.missing.join(', ')}` : ''}.`;
    this.mixer = playOn(this.char.root, r.clip).mixer;
    this.mixerMode = s.mode;
  }

  frame(dt: number, s: Shared): void {
    const r = this.ensure();
    if (!r) return;
    if (this.builtFor !== this.key(s)) this.build(s);
    if (this.seenRestart !== s.restart) {
      this.seenRestart = s.restart;
      this.swingAt = s.time - 9;
      this.jumpAt = s.time;
    }
    if (this.seenAnim !== s.animRev || this.mixerMode !== (this.mixer ? s.mode : null)) {
      this.seenAnim = s.animRev;
      this.syncMixer(s);
    }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w > 0 && h > 0 && (this.canvas.width !== Math.round(w * r.getPixelRatio()) || this.canvas.height !== Math.round(h * r.getPixelRatio()))) {
      r.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    const cp = Math.cos(s.pitch);
    this.camera.position.set(Math.sin(s.yaw) * cp * s.dist, s.lookY + Math.sin(s.pitch) * s.dist, Math.cos(s.yaw) * cp * s.dist);
    this.camera.lookAt(0, s.lookY, 0);
    const c = this.char;
    if (c) {
      const move = s.mode === 'walk' ? 0.55 : s.mode === 'run' ? 1 : 0;
      this.phase += dt * (s.mode === 'run' ? 11 : 7) * (move > 0 ? 1 : 0);
      if (s.mode === 'swing' && s.time - this.swingAt > 1.1) {
        this.swingAt = s.time;
        c.swing();
      }
      const air = s.mode === 'jump' ? jumpHeight(((s.time - this.jumpAt) * 1000) % 1500) : 0;
      c.pose({ phase: this.phase, move, casting: s.mode === 'cast', time: s.time, dt, vf: move * 7, vs: 0, air });
      this.mixer?.update(dt); // the file's motion lands on the bones after the built-in pose, so it replaces it
    }
    r.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = null;
  }
}

export class ModelWindow {
  readonly root = el('div', 'mwin');
  private s: Shared = { spec: { classId: 'warrior' }, gear: {}, mode: 'stand', spin: true, yaw: 2.6, pitch: 0.12, dist: 5.2, lookY: 1.15, time: 0, restart: 0, anims: {}, animRev: 0, animNote: {} };
  private now = new ModelView('As it is now', false);
  private shipped = new ModelView('As it shipped', true);
  private compare = true;
  private panes = el('div', 'mwin-panes');
  private note = el('small', 'mwin-note', '');
  private animBox = el('div', 'mwin-anim');
  private raf = 0;
  private running = false;
  private last = 0;

  constructor() {
    const style = document.createElement('style');
    style.textContent = `
.mwin{position:fixed;z-index:9500;left:60px;top:80px;width:660px;height:500px;min-width:320px;min-height:280px;max-width:96vw;max-height:94vh;display:none;flex-direction:column;background:#14111d;border:1px solid #5a4a8a;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.6);resize:both;overflow:hidden;color:#e6e9ef;font:13px/1.35 system-ui}
.mwin.open{display:flex}
.mwin-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;background:#241d36;cursor:move;user-select:none;flex:none}.mwin-bar b{color:#e2c7ff}.mwin-bar .sp{flex:1}
.mwin-tools{display:flex;flex-wrap:wrap;gap:5px;align-items:center;padding:6px 8px;flex:none;border-bottom:1px solid #2c2638}
.mwin-tools select{max-width:130px;background:#10131a;color:#e6e9ef;border:1px solid #333b4d;border-radius:6px;padding:3px 5px}.mwin-tools .on{background:#3a2a66;color:#fff}
.mwin-panes{flex:1;min-height:0;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;background:#0c0a12}
.mwin-pane{position:relative;min-width:0;min-height:0}.mwin-canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block;cursor:grab;outline:none;touch-action:none}
.mwin-tag{position:absolute;left:8px;top:6px;padding:2px 8px;border-radius:10px;background:rgba(0,0,0,.55);font-size:12px;pointer-events:none}
.mwin-anim{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:5px 8px;flex:none;border-top:1px solid #2c2638;background:#181424}.mwin-anim small{color:#a99cc4}
.mwin.dropping{outline:3px dashed #b58cff;outline-offset:-6px}
.mwin-note{padding:3px 10px;color:#a99cc4;flex:none}`;
    this.root.append(style);
    const bar = el('div', 'mwin-bar');
    const close = el('button', 'mm-small', '✕');
    close.title = 'Close the model view';
    close.addEventListener('click', () => this.close());
    bar.append(el('b', '', 'Model view'), el('small', 'devp-dim', 'drag here to move · pull the corner to resize'), el('span', 'sp'), close);
    this.dragBar(bar);
    const tools = el('div', 'mwin-tools');
    for (const [id, label] of MODES) {
      const b = el('button', `mm-small${id === this.s.mode ? ' on' : ''}`, label);
      b.dataset.mode = id;
      b.addEventListener('click', () => {
        this.s.mode = id;
        this.s.restart++;
        tools.querySelectorAll('button[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
        this.paintAnim();
      });
      tools.append(b);
    }
    const spin = el('button', 'mm-small on', '⟳ Turn');
    spin.dataset.spin = '1';
    spin.addEventListener('click', () => {
      this.s.spin = !this.s.spin;
      spin.classList.toggle('on', this.s.spin);
    });
    const cmp = el('button', 'mm-small on', '⇄ Compare');
    cmp.title = 'Show the model as it shipped next to the one you are editing';
    cmp.addEventListener('click', () => {
      this.compare = !this.compare;
      cmp.classList.toggle('on', this.compare);
      this.layout();
    });
    tools.append(spin, cmp);
    for (const [slot, label] of SLOTS) {
      const sel = el('select');
      sel.dataset.slot = slot;
      sel.title = label;
      sel.append(new Option(`${label}: none`, ''));
      for (const it of itemsForSlot(slot)) sel.append(new Option(it.name, it.id));
      sel.addEventListener('change', () => {
        if (sel.value) this.s.gear = { ...this.s.gear, [slot]: sel.value };
        else {
          const g = { ...this.s.gear };
          delete g[slot];
          this.s.gear = g;
        }
      });
      tools.append(sel);
    }
    this.root.append(bar, tools, this.panes, this.animBox, this.note);
    this.paintAnim();
    this.layout();
    this.restoreGeometry();
    for (const v of [this.now, this.shipped]) this.wire(v.canvas);
    new ResizeObserver(() => this.saveGeometry()).observe(this.root);
    // an animation file dropped anywhere on the window goes to the motion on show
    this.root.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        this.root.classList.add('dropping');
      }
    });
    this.root.addEventListener('dragleave', () => this.root.classList.remove('dropping'));
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      this.root.classList.remove('dropping');
      const f = e.dataTransfer?.files[0];
      if (f) void this.tryFile(f);
    });
  }

  private paintAnim(): void {
    const b = this.animBox;
    b.replaceChildren();
    const mode = this.s.mode;
    const label = MODES.find((m) => m[0] === mode)![1];
    b.append(el('small', '', `Animation for ${label}:`));
    const have = this.s.anims[mode];
    b.append(el('b', '', have ? have.name : 'the built-in one'));
    const pick = el('input');
    pick.type = 'file';
    pick.accept = '.glb,.gltf,.fbx';
    pick.hidden = true;
    pick.addEventListener('change', () => {
      const f = pick.files?.[0];
      if (f) void this.tryFile(f);
      pick.value = '';
    });
    const up = el('button', 'mm-small', 'Try an animation file…');
    up.title = 'Pick (or drop on this window) a .glb or .fbx with a skeleton and an animation. Mixamo downloads work: its bones are matched to the character by name.';
    up.addEventListener('click', () => pick.click());
    b.append(up, pick);
    if (have) {
      const back = el('button', 'mm-small', 'Back to built-in');
      back.addEventListener('click', () => {
        delete this.s.anims[mode];
        delete this.s.animNote[mode];
        this.s.animRev++;
        this.paintAnim();
      });
      b.append(back);
    }
    b.append(el('small', '', this.s.animNote[mode] ?? 'The picture on the left plays it; the one on the right keeps the built-in motion to compare.'));
  }

  private async tryFile(f: File): Promise<void> {
    try {
      const loaded = await readAnimationFile(f);
      this.s.anims[this.s.mode] = loaded;
      this.s.animNote[this.s.mode] = 'Reading…';
      this.s.animRev++;
      this.s.restart++;
      this.paintAnim();
      window.setTimeout(() => this.paintAnim(), 400); // the picture says how many bones matched once it has built it
    } catch (e) {
      this.s.animNote[this.s.mode] = (e as Error).message;
      this.paintAnim();
    }
  }

  private layout(): void {
    this.panes.replaceChildren();
    const views = this.compare ? [this.now, this.shipped] : [this.now];
    for (const v of views) {
      const pane = el('div', 'mwin-pane');
      pane.append(v.canvas, el('div', 'mwin-tag', v.label));
      this.panes.append(pane);
    }
  }

  /** What to show (the window opens if it is not open yet). */
  show(spec: PreviewSpec, gear: Record<string, string> = {}): void {
    this.s.spec = spec;
    // the slot a page is about is worn at first (a head page puts a head item on); what was picked by hand stays
    this.s.gear = { ...gear, ...this.s.gear };
    this.root.querySelectorAll<HTMLSelectElement>('select[data-slot]').forEach((sel) => (sel.value = this.s.gear[sel.dataset.slot!] ?? ''));
    this.note.textContent = `${CLASSES[spec.classId].name}${spec.weapon ? ` with ${spec.weapon.replace(/_/g, ' ')}` : ''}. Changes show as you make them; the right side keeps the original for comparison.`;
    this.open();
  }

  get isOpen(): boolean {
    return this.root.classList.contains('open');
  }

  open(): void {
    if (!this.root.isConnected) document.body.append(this.root);
    this.root.classList.add('open');
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.s.time += dt;
      if (this.s.spin) this.s.yaw += dt * 0.5;
      this.now.frame(dt, this.s);
      if (this.compare) this.shipped.frame(dt, this.s);
    };
    this.raf = requestAnimationFrame(loop);
  }

  close(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.root.classList.remove('open');
  }

  // ------------------------------------------------------------------ moving, resizing, remembering

  private dragBar(bar: HTMLElement): void {
    let from: { x: number; y: number; l: number; t: number } | null = null;
    bar.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      bar.setPointerCapture(e.pointerId);
      const r = this.root.getBoundingClientRect();
      from = { x: e.clientX, y: e.clientY, l: r.left, t: r.top };
    });
    bar.addEventListener('pointermove', (e) => {
      if (!from) return;
      this.root.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, from.l + e.clientX - from.x))}px`;
      this.root.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, from.t + e.clientY - from.y))}px`;
    });
    const end = () => {
      if (!from) return;
      from = null;
      this.saveGeometry();
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  private saveGeometry(): void {
    if (!this.isOpen) return;
    const r = this.root.getBoundingClientRect();
    try {
      localStorage.setItem(KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }));
    } catch {
      /* private window */
    }
  }

  private restoreGeometry(): void {
    try {
      const g = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { x: number; y: number; w: number; h: number } | null;
      if (!g) return;
      this.root.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, g.x))}px`;
      this.root.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, g.y))}px`;
      this.root.style.width = `${Math.max(320, Math.min(window.innerWidth, g.w))}px`;
      this.root.style.height = `${Math.max(280, Math.min(window.innerHeight, g.h))}px`;
    } catch {
      /* no saved place */
    }
  }

  private wire(c: HTMLCanvasElement): void {
    let drag: { x: number; y: number; pan: boolean } | null = null;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
      c.style.cursor = 'grabbing';
      this.s.spin = false;
      this.root.querySelector('button[data-spin]')?.classList.remove('on');
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.pan) this.s.lookY = Math.max(0.2, Math.min(2.2, this.s.lookY + dy * 0.004));
      else {
        this.s.yaw -= dx * 0.01;
        this.s.pitch = Math.max(-0.3, Math.min(1.3, this.s.pitch + dy * 0.006));
      }
    });
    const end = () => {
      drag = null;
      c.style.cursor = 'grab';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.s.dist = Math.max(1.6, Math.min(12, this.s.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
      },
      { passive: false },
    );
  }
}
