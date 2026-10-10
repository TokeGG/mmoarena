import * as THREE from 'three';
import { MODELS_DATA, CLASSES, gearLook, itemsForSlot, jumpHeight, pristineModels } from '@arena/shared';
import type { ClassId } from '@arena/shared';
import { createCharacter } from './models';
import type { Character } from './models';
import { modelVersion } from './riggedModels';
import { applyModelData } from './modelData';
import { CANON, canonicalOf, playOn, readAnimationFile, retarget } from './animRetarget';
import { BONE_LABEL } from '@arena/shared';
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
/** The weapons to try on the model (each with the class that carries it), chosen in the window whatever page is open. */
const WEAPONS: [string, string, ClassId][] = [['', 'Default weapon', 'warrior'], ['dual', 'Dual blades', 'warrior'], ['twohand', 'Two-handed sword', 'warrior'], ['polearm', 'Polearm', 'warrior'], ['daggers', 'Daggers', 'rogue'], ['fire_staff', 'Fire staff', 'mage'], ['ice_staff', 'Ice staff', 'mage'], ['arcane_staff', 'Arcane staff', 'mage'], ['holy_staff', 'Holy staff', 'priest'], ['necro_staff', 'Necro staff', 'priest']];

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

  /** The pivot a weapon hangs on in this hand (weaponModels.ts names its pivots and marks the hand). */
  private pivotOf(hand: 'right' | 'left'): THREE.Object3D | null {
    let found: THREE.Object3D | null = null;
    this.char?.root.traverse((o) => {
      if (!found && o.userData.hand === hand && o.name.startsWith('weapon:')) found = o;
    });
    return found;
  }

  private raycaster = new THREE.Raycaster();

  /**
   * What is under a point of this picture: a weapon (and which hand), a body part the dev uploaded (and its bone), or a bit of the
   * game's own body (the bone that moves most of the triangle that was hit).
   */
  pickPart(clientX: number, clientY: number): { kind: 'weapon'; hand: 'right' | 'left' } | { kind: 'part' | 'bone'; bone: string } | null {
    if (!this.char) return null;
    const r = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    this.char.root.updateMatrixWorld(true);
    const hits = this.raycaster.intersectObject(this.char.root, true).filter((h) => h.object.visible && (h.object as THREE.Mesh).isMesh);
    for (const h of hits) {
      for (let o: THREE.Object3D | null = h.object; o; o = o.parent) {
        if (o.name.startsWith('weapon:') && (o.userData.hand === 'right' || o.userData.hand === 'left')) return { kind: 'weapon', hand: o.userData.hand };
        if (o.name.startsWith('custom-part:')) return { kind: 'part', bone: o.name.slice('custom-part:'.length) };
      }
      const m = h.object as THREE.SkinnedMesh;
      const f = h.face;
      const si = m.geometry?.getAttribute('skinIndex');
      const sw = m.geometry?.getAttribute('skinWeight');
      if (!m.isSkinnedMesh || !f || !si || !sw) continue;
      const total = new Map<number, number>();
      for (const v of [f.a, f.b, f.c]) for (let k = 0; k < 4; k++) total.set(si.getComponent(v, k), (total.get(si.getComponent(v, k)) ?? 0) + sw.getComponent(v, k));
      const best = [...total.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const canon = best === undefined ? null : canonicalOf(m.skeleton.bones[best]?.name ?? '');
      if (canon && (CANON as readonly string[]).includes(canon)) return { kind: 'bone', bone: canon };
    }
    return null;
  }

  /** Is there a weapon in this hand to move? */
  hasHand(hand: 'right' | 'left'): boolean {
    return !!this.pivotOf(hand);
  }

  /**
   * Move or turn the weapon in a hand by a drag of the mouse, as seen from this picture's camera: `slide` moves it across the
   * view (with shift: towards or away from the viewer), `turn` swings it about the view's up and sideways axes (with shift: rolls it
   * about the line of sight). Returns the new numbers the game keeps (slide in yards from the fist, turn in degrees), or null.
   */
  dragWeapon(s: Shared, hand: 'right' | 'left', mode: 'slide' | 'turn', dx: number, dy: number, shift: boolean): { pos: number[]; rot: number[] } | null {
    const p = this.pivotOf(hand);
    const par = p?.parent;
    if (!p || !par) return null;
    p.updateWorldMatrix(true, false);
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorld.elements;
    const right = new THREE.Vector3(e[0], e[1], e[2]);
    const up = new THREE.Vector3(e[4], e[5], e[6]);
    const back = new THREE.Vector3(e[8], e[9], e[10]);
    const grip = (p.userData.grip as THREE.Vector3 | undefined) ?? new THREE.Vector3();
    const pos = p.position.clone();
    const quat = p.quaternion.clone();
    if (mode === 'slide') {
      const k = (2 * Math.tan((18 * Math.PI) / 180) * s.dist) / Math.max(1, this.canvas.clientHeight);
      const d = shift ? back.multiplyScalar(dy * k) : right.multiplyScalar(dx * k).add(up.multiplyScalar(-dy * k));
      const w0 = new THREE.Vector3().setFromMatrixPosition(p.matrixWorld);
      pos.add(par.worldToLocal(w0.clone().add(d)).sub(par.worldToLocal(w0.clone())));
    } else {
      const qd = new THREE.Quaternion();
      if (shift) qd.setFromAxisAngle(back, -dx * 0.012);
      else qd.setFromAxisAngle(up, dx * 0.012).multiply(new THREE.Quaternion().setFromAxisAngle(right, dy * 0.012));
      const pq = par.getWorldQuaternion(new THREE.Quaternion());
      quat.premultiply(pq.clone().invert().multiply(qd).multiply(pq));
    }
    p.position.copy(pos); // at once, so the next bit of the drag builds on this one before the picture is rebuilt
    p.quaternion.copy(quat);
    const aim = (p.userData.aim as THREE.Quaternion | undefined) ?? new THREE.Quaternion();
    const eq = aim.clone().invert().multiply(quat);
    const eu = new THREE.Euler().setFromQuaternion(eq, 'XYZ');
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const dg = (n: number) => (n * 180) / Math.PI;
    return { pos: [r3(pos.x - grip.x), r3(pos.y - grip.y), r3(pos.z - grip.z)], rot: [r1(dg(eu.x)), r1(dg(eu.y)), r1(dg(eu.z))] };
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
  /** Set by the Models page while a weapon is on show: writes the numbers a drag made (final: the drag is over). */
  private weaponEdit: ((hand: 'right' | 'left', v: { pos: number[]; rot: number[] }, final: boolean) => void) | null = null;
  private animFiles: Partial<Record<Mode, File>> = {};
  /** Set by the Models page on a character: keeps a tried animation for this character's motion (uploads it and sets the field). Resolves with a problem text, or null when kept. */
  private keepAnim: ((mode: string, f: File) => Promise<string | null>) | null = null;
  setKeepAnim(fn: ((mode: string, f: File) => Promise<string | null>) | null): void {
    this.keepAnim = fn;
    this.paintAnim();
  }
  /** Set by the Models page on a character: writes a number of that character (path from its own entry: ['bones', 'hand_r', 'rx']) and reads one. */
  private partEdit: { set: (path: (string | number)[], v: number, final: boolean) => void; get: (path: (string | number)[]) => number | undefined } | null = null;
  private picked = '';
  setPartEdit(e: { set: (path: (string | number)[], v: number, final: boolean) => void; get: (path: (string | number)[]) => number | undefined } | null): void {
    this.partEdit = e;
    if (!e && !this.weaponEdit) this.moveOn = false;
    this.paintMove();
  }
  private moveOn = false;
  private editWeapon = '';
  private weaponPicked = false;
  private weaponSel = document.createElement('select');
  private moveMode: 'slide' | 'turn' = 'slide';
  private hand: 'right' | 'left' = 'right';
  private moveBox = el('div', 'mwin-move');

  /** Offer (or take away) dragging the weapon in the picture; the page gives the function that saves what the drag made. */
  setWeaponEdit(fn: ((hand: 'right' | 'left', v: { pos: number[]; rot: number[] }, final: boolean) => void) | null, weapon = ''): void {
    this.weaponEdit = fn;
    this.editWeapon = weapon;
    if (!fn && !this.partEdit) this.moveOn = false;
    this.paintMove();
  }

  private paintMove(): void {
    const b = this.moveBox;
    b.replaceChildren();
    b.style.display = this.weaponEdit || this.partEdit ? 'flex' : 'none';
    if (this.partEdit && !this.weaponEdit) {
      const on = el('button', `mm-small${this.moveOn ? ' on' : ''}`, '✋ Move parts');
      on.title = 'Click a part of the model in the left picture (a hand, the head, an arm, a leg, a part you uploaded) and drag it.';
      on.addEventListener('click', () => {
        this.moveOn = !this.moveOn;
        this.paintMove();
      });
      b.append(on);
      if (this.moveOn) b.append(el('small', 'devp-dim', this.picked ? `${this.picked}: drag left / right to turn it, up / down to swing it, Shift for lean. A part you uploaded slides (Shift: forward / back).` : 'Click a part of the model, then drag it. Drag the background to turn the view.'));
      return;
    }
    if (!this.weaponEdit) return;
    if ((this.s.spec.weapon ?? '') !== this.editWeapon) {
      b.append(el('small', 'devp-dim', `Pick ${this.editWeapon.replace(/_/g, ' ')} in the weapon list to move it by hand.`));
      return;
    }
    const on = el('button', `mm-small${this.moveOn ? ' on' : ''}`, '✋ Move the weapon');
    on.title = 'Drag the weapon in the left picture: it moves with the mouse and the numbers are saved as you let go.';
    on.addEventListener('click', () => {
      this.moveOn = !this.moveOn;
      this.paintMove();
    });
    b.append(on);
    if (!this.moveOn) return;
    const mode = (m: 'slide' | 'turn', label: string, tip: string) => {
      const x = el('button', `mm-small${this.moveMode === m ? ' on' : ''}`, label);
      x.title = tip;
      x.addEventListener('click', () => {
        this.moveMode = m;
        this.paintMove();
      });
      return x;
    };
    b.append(mode('slide', 'Slide', 'Drag to slide it across the view; hold Shift to push it towards or away from you.'), mode('turn', 'Turn', 'Drag to swing it about; hold Shift and drag sideways to roll it about its own length.'));
    if (this.now.hasHand('left')) {
      for (const h of ['right', 'left'] as const) {
        const x = el('button', `mm-small${this.hand === h ? ' on' : ''}`, h === 'right' ? 'Right hand' : 'Left hand');
        x.addEventListener('click', () => {
          this.hand = h;
          this.paintMove();
        });
        b.append(x);
      }
    } else this.hand = 'right';
    b.append(el('small', 'devp-dim', this.moveMode === 'slide' ? 'drag the weapon · Shift: nearer / farther' : 'drag to swing · Shift: roll'));
  }

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
.mwin-move{display:none;flex-wrap:wrap;gap:5px;align-items:center;padding:5px 8px;flex:none;border-bottom:1px solid #2c2638;background:#1b1530}
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
    const ws = this.weaponSel;
    ws.title = 'The weapon the model holds here';
    for (const [id, name] of WEAPONS) ws.append(new Option(name, id));
    ws.addEventListener('change', () => {
      const w = WEAPONS.find((x) => x[0] === ws.value)!;
      this.weaponPicked = true;
      this.s.spec = { classId: w[2], weapon: w[0] || undefined };
      this.note.textContent = `${CLASSES[w[2]].name}${w[0] ? ` with ${w[1].toLowerCase()}` : ''}. Changes show as you make them; the right side keeps the original for comparison.`;
      this.paintMove();
    });
    tools.append(ws);
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
    this.root.append(bar, tools, this.moveBox, this.panes, this.animBox, this.note);
    this.paintAnim();
    this.layout();
    this.restoreGeometry();
    for (const v of [this.now, this.shipped]) this.wire(v.canvas, v === this.now);
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
        delete this.animFiles[mode];
        delete this.s.animNote[mode];
        this.s.animRev++;
        this.paintAnim();
      });
      b.append(back);
      const file = this.animFiles[mode];
      if (this.keepAnim && file) {
        const keep = el('button', 'mm-small mm-go', 'Keep it for this model');
        keep.title = /\.glb$/i.test(file.name) ? 'Uploads the file and sets it as this character\'s animation for this motion, so it plays in matches.' : 'Only a .glb can be kept. Convert the .fbx to .glb (Blender or an online converter) and try that.';
        keep.addEventListener('click', async () => {
          keep.setAttribute('disabled', '');
          const problem = /\.glb$/i.test(file.name) ? await this.keepAnim!(mode, file) : 'Only a .glb can be kept: convert the .fbx to .glb first.';
          this.s.animNote[mode] = problem ?? `Kept: ${file.name} now plays for this motion in matches.`;
          if (!problem) {
            delete this.s.anims[mode]; // the saved one is played from now on, by the character itself
            delete this.animFiles[mode];
            this.s.animRev++;
          }
          this.paintAnim();
        });
        b.append(keep);
      }
    }
    b.append(el('small', '', this.s.animNote[mode] ?? 'The picture on the left plays it; the one on the right keeps the built-in motion to compare.'));
  }

  private async tryFile(f: File): Promise<void> {
    try {
      const loaded = await readAnimationFile(f);
      this.s.anims[this.s.mode] = loaded;
      this.animFiles[this.s.mode] = f;
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
    // a weapon picked in the window stays while other pages are looked at; a weapon page shows its own
    if (spec.weapon || !this.weaponPicked) {
      this.s.spec = spec;
      this.weaponPicked = false;
    }
    this.weaponSel.value = this.s.spec.weapon ?? '';
    this.paintMove();
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

  private wire(c: HTMLCanvasElement, editable: boolean): void {
    let drag: { x: number; y: number; pan: boolean; weapon: boolean } | null = null;
    let last: { pos: number[]; rot: number[] } | null = null;
    let part: { kind: 'part' | 'bone'; bone: string; start: Record<string, number> } | null = null;
    let acc = { x: 0, y: 0 };
    let lastPut: { path: (string | number)[]; v: number } | null = null;
    const put = (path: (string | number)[], v: number) => {
      lastPut = { path, v };
      this.partEdit?.set(path, v, false);
    };
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey, weapon: editable && this.moveOn && !!this.weaponEdit && e.button === 0 };
      last = null;
      part = null;
      lastPut = null;
      acc = { x: 0, y: 0 };
      if (editable && this.moveOn && this.partEdit && !this.weaponEdit && e.button === 0) {
        const hit = this.now.pickPart(e.clientX, e.clientY);
        if (hit && hit.kind !== 'weapon') {
          const keys = hit.kind === 'part' ? ['x', 'y', 'z'] : ['rx', 'ry', 'rz'];
          const root = hit.kind === 'part' ? 'parts' : 'bones';
          const start: Record<string, number> = {};
          for (const k of keys) start[k] = this.partEdit.get([root, hit.bone, k]) ?? (k === 'size' ? 1 : 0);
          part = { kind: hit.kind, bone: hit.bone, start };
          this.picked = `${hit.kind === 'part' ? 'Your ' : ''}${BONE_LABEL[hit.bone] ?? hit.bone}${/_l$/.test(hit.bone) ? ' (left)' : /_r$/.test(hit.bone) ? ' (right)' : ''}`;
          this.paintMove();
          drag!.weapon = false;
          drag!.pan = false;
        }
      }
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
      if (part && this.partEdit) {
        // the view looks at the character from the front when yaw is 0: left / right on the screen is the character's left / right the other way round once it has turned half way
        const sgn = Math.cos(this.s.yaw) >= 0 ? 1 : -1;
        acc = { x: acc.x + dx, y: acc.y + dy };
        const root = part.kind === 'part' ? 'parts' : 'bones';
        if (part.kind === 'part') {
          const k = (2 * Math.tan((18 * Math.PI) / 180) * this.s.dist) / Math.max(1, c.clientHeight);
          if (e.shiftKey) put([root, part.bone, 'z'], Math.round((part.start.z - acc.y * k) * 1000) / 1000);
          else {
            put([root, part.bone, 'x'], Math.round((part.start.x + acc.x * k * sgn) * 1000) / 1000);
            put([root, part.bone, 'y'], Math.round((part.start.y - acc.y * k) * 1000) / 1000);
          }
        } else if (e.shiftKey) put([root, part.bone, 'rz'], Math.round((part.start.rz + acc.x * 0.6 * sgn) * 10) / 10);
        else {
          put([root, part.bone, 'ry'], Math.round((part.start.ry + acc.x * 0.6 * sgn) * 10) / 10);
          put([root, part.bone, 'rx'], Math.round((part.start.rx - acc.y * 0.6) * 10) / 10);
        }
      } else if (drag.weapon) {
        const r = this.now.dragWeapon(this.s, this.hand, this.moveMode, dx, dy, e.shiftKey);
        if (r) {
          last = r;
          this.weaponEdit?.(this.hand, r, false);
        }
      } else if (drag.pan) this.s.lookY = Math.max(0.2, Math.min(2.2, this.s.lookY + dy * 0.004));
      else {
        this.s.yaw -= dx * 0.01;
        this.s.pitch = Math.max(-0.3, Math.min(1.3, this.s.pitch + dy * 0.006));
      }
    });
    const end = () => {
      if (drag?.weapon && last) this.weaponEdit?.(this.hand, last, true);
      if (part && lastPut) this.partEdit?.set(lastPut.path, lastPut.v, true);
      lastPut = null;
      part = null;
      drag = null;
      last = null;
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
