import * as THREE from 'three';
import { ABILITIES, ArenaSim, CLASSES, SPECS, TUNING, skillLook, weaponFor } from '@arena/shared';
import type { AbilityDef, ClassId, SimEvent, Unit } from '@arena/shared';
import { Effects } from './effects';
import { createCharacter } from './models';
import type { Character } from './models';
import { uploadModel } from './customModels';
import { el } from './bar';
import { defaultBuild } from './profile';

/**
 * The Animations page's view of a skill: a window of its own that floats over the game like the model view (drag its title to move it,
 * pull its corner to resize it). It runs the game's own simulation with a caster and a dummy, casts the skill again and again, and
 * draws it with the game's own effects, so the picture is exactly what a match shows. Every change made on the page shows at once (the
 * skill is cast again a moment after an edit), the motion can be slowed down, and a picture (png, webp, jpg) or a model (.glb)
 * dropped on the window is uploaded and flown in place of the skill's projectile.
 */

const KEY = 'arena.skillwin.v1';
const SPEEDS: [number, string][] = [[1, '1×'], [0.5, '½×'], [0.25, '¼×'], [0.1, '⅒×']];

/** The ability an Animations page entry is about (a `skill_<id>` page, or an effect named after the skill: dragonsBreath), or null. */
export function abilityOfEntry(id: string): string | null {
  if (id.startsWith('skill_')) return ABILITIES[id.slice(6)] ? id.slice(6) : null;
  const snake = id.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return ABILITIES[snake] ? snake : null;
}

interface Dummy { char: Character; unit: Unit; holder: THREE.Group }

export class SkillWindow {
  readonly root = el('div', 'swin');
  private canvas = document.createElement('canvas');
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  private effects!: Effects;
  private sim: ArenaSim | null = null;
  private chars = new Map<number, Dummy>();
  private ability = '';
  private caster: Unit | null = null;
  private foe: Unit | null = null;
  private ally: Unit | null = null;
  private clock = 0;
  private acc = 0;
  private nextCast = 0;
  private period = 4;
  private loop = true;
  private speed = 1;
  private paused = false;
  private yaw = -1.2;
  private pitch = 0.28;
  private dist = 16;
  private target = new THREE.Vector3(0, 1.4, 5);
  private raf = 0;
  private running = false;
  private last = 0;
  private replayAt = 0;
  private note = el('small', 'swin-note', '');
  private title = el('b', '', 'Skill view');
  private failed = false;
  private casterWeapon: string | undefined;
  /** Set by the Animations page: stores the name of an uploaded picture or model as this skill's own look. */
  private setLookFile: ((file: string) => void) | null = null;

  constructor() {
    const style = document.createElement('style');
    style.textContent = `
.swin{position:fixed;z-index:9500;left:90px;top:110px;width:640px;height:480px;min-width:320px;min-height:260px;max-width:96vw;max-height:94vh;display:none;flex-direction:column;background:#14111d;border:1px solid #5a4a8a;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.6);resize:both;overflow:hidden;color:#e6e9ef;font:13px/1.35 system-ui}
.swin.open{display:flex}
.swin-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;background:#241d36;cursor:move;user-select:none;flex:none}.swin-bar b{color:#e2c7ff}.swin-bar .sp{flex:1}
.swin-tools{display:flex;flex-wrap:wrap;gap:5px;align-items:center;padding:6px 8px;flex:none;border-bottom:1px solid #2c2638}.swin-tools .on{background:#3a2a66;color:#fff}
.swin-view{position:relative;flex:1;min-height:0;background:#0c0a12}.swin-view canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block;cursor:grab;outline:none;touch-action:none}
.swin-note{padding:4px 10px;color:#a99cc4;flex:none}
.swin.dropping{outline:3px dashed #b58cff;outline-offset:-6px}`;
    this.root.append(style);
    const bar = el('div', 'swin-bar');
    const close = el('button', 'mm-small', '✕');
    close.title = 'Close the skill view';
    close.addEventListener('click', () => this.close());
    bar.append(this.title, el('small', 'devp-dim', 'drag here to move · pull the corner to resize'), el('span', 'sp'), close);
    this.dragBar(bar);
    const tools = el('div', 'swin-tools');
    const replay = el('button', 'mm-small mm-go', '▶ Cast it');
    replay.title = 'Cast the skill once more from the start';
    replay.addEventListener('click', () => this.replay());
    const loop = el('button', 'mm-small on', '⟲ Repeat');
    loop.title = 'Cast it again every few seconds';
    loop.addEventListener('click', () => {
      this.loop = !this.loop;
      loop.classList.toggle('on', this.loop);
    });
    const pause = el('button', 'mm-small', '⏸ Pause');
    pause.title = 'Hold the picture still';
    pause.addEventListener('click', () => {
      this.paused = !this.paused;
      pause.classList.toggle('on', this.paused);
      pause.textContent = this.paused ? '▶ Play' : '⏸ Pause';
    });
    const speed = el('select');
    speed.title = 'How fast it plays';
    for (const [v, l] of SPEEDS) speed.append(new Option(l, String(v)));
    speed.addEventListener('change', () => (this.speed = Number(speed.value)));
    tools.append(replay, loop, pause, speed);
    for (const [label, yaw, pitch] of [['Side', -1.2, 0.28], ['Behind', Math.PI, 0.3], ['Front', 0, 0.3], ['Above', -1.2, 1.35]] as const) {
      const b = el('button', 'mm-small', label);
      b.addEventListener('click', () => {
        this.yaw = yaw;
        this.pitch = pitch;
      });
      tools.append(b);
    }
    const view = el('div', 'swin-view');
    view.append(this.canvas);
    this.root.append(bar, tools, view, this.note);
    this.wire(this.canvas);
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
      if (f) void this.drop(f);
    });
    this.restoreGeometry();
    new ResizeObserver(() => this.saveGeometry()).observe(this.root);
    this.freshScene();
  }

  /** A new scene and a new set of effects: nothing of the skill shown before stays behind. */
  private freshScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1822);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x554466, 1.5));
    const sun = new THREE.DirectionalLight(0xfff0dd, 1.6);
    sun.position.set(5, 9, 4);
    this.scene.add(sun);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.MeshBasicMaterial({ color: 0x2a2535 }));
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    const grid = new THREE.PolarGridHelper(16, 4, 8, 48, 0x40395a, 0x332e48);
    grid.position.y = 0.01;
    this.scene.add(grid);
    this.effects = new Effects(this.scene, (id) => {
      const d = this.chars.get(id);
      return d ? { x: d.unit.pos.x, y: 0, z: d.unit.pos.z, facing: d.unit.facing } : null;
    });
    this.effects.camera = this.camera;
    this.effects.onSwing = (id, fast) => this.chars.get(id)?.char.swing(fast);
    this.effects.onShout = (id) => this.chars.get(id)?.char.shout();
    this.effects.onHit = (id) => this.chars.get(id)?.char.flash();
  }

  get isOpen(): boolean {
    return this.root.classList.contains('open');
  }

  /** Show a skill; `setLookFile` stores the name of a picture or model dropped on the window as the skill's own look. */
  show(ability: string, setLookFile: ((file: string) => void) | null): void {
    this.setLookFile = setLookFile;
    if (this.ability !== ability) {
      this.ability = ability;
      this.build();
    }
    this.title.textContent = `Skill view: ${ABILITIES[ability]?.name ?? ability}`;
    this.note.textContent = setLookFile ? 'Drop a picture (png, webp, jpg) or a model (.glb) on this window to fly it as the skill\'s projectile. Every change on the page shows when the skill is cast again.' : 'Every change on the page shows when the skill is cast again.';
    this.open();
    this.replay();
  }

  /** A change was made on the page: cast again in a moment, so the new look is what plays. */
  replaySoon(): void {
    if (!this.isOpen) return;
    this.replayAt = performance.now() + 350;
  }

  // ---------------------------------------------------------------- the little match

  private build(): void {
    this.chars.clear();
    this.freshScene();
    const def: AbilityDef | undefined = ABILITIES[this.ability];
    if (!def) return;
    const sim = new ArenaSim({ seed: 11, prepMs: 0, tickMs: TUNING.tickMs, facing: true });
    this.sim = sim;
    const cls: ClassId = def.class !== 'trinket' && CLASSES[def.class as ClassId] ? (def.class as ClassId) : 'warrior';
    // the caster is the spec that has this skill on its bar, with that spec's weapon (a skill only a talent gives is put on the bar by hand)
    const spec = SPECS[cls]?.find((x) => x.bar.includes(this.ability)) ?? SPECS[cls]?.find((x) => x.bar.length) ?? undefined;
    const build = spec ? { ...defaultBuild(cls), spec: spec.id } : undefined;
    const caster = sim.addUnit({ name: 'You', classId: cls, team: 0, ...(build ? { build } : {}) });
    if (!caster.bar.includes(this.ability) && caster.trinket !== this.ability) caster.bar = [...caster.bar, this.ability];
    this.casterWeapon = spec ? weaponFor(cls, spec.id) : undefined;
    const reach = def.range > 0 ? Math.min(10, Math.max(4, def.range * 0.45)) : def.target === 'aoe_enemy' || def.target === 'aoe_all' ? 3 : 6;
    // the dummies are never the caster's own class, so who is casting is clear
    const foe = sim.addUnit({ name: 'Dummy', classId: cls === 'warrior' ? 'rogue' : 'warrior', team: 1, controller: 'dummy' });
    const ally = sim.addUnit({ name: 'Friend', classId: cls === 'priest' ? 'mage' : 'priest', team: 0, controller: 'dummy' });
    caster.pos = { x: 0, z: 0 };
    caster.facing = 0;
    foe.pos = { x: 0, z: reach };
    foe.facing = Math.PI;
    ally.pos = { x: 3.2, z: reach * 0.5 };
    ally.facing = 0;
    foe.home = { ...foe.pos };
    ally.home = { ...ally.pos };
    for (const u of [foe, ally]) u.maxHealth = u.health = 1_000_000;
    this.caster = caster;
    this.foe = foe;
    this.ally = ally;
    for (const u of [caster, foe, ally]) {
      const char = createCharacter(u.classId, undefined, u.id === caster.id ? this.casterWeapon : undefined);
      const holder = new THREE.Group(); // the character moves itself (its lunge), so it is placed by a group around it
      holder.add(char.root);
      this.scene.add(holder);
      this.chars.set(u.id, { char, unit: u, holder });
    }
    const zoneMs = def.effects.find((e) => e.type === 'zone');
    this.period = Math.max(3.2, def.castTime / 1000 + 2.6 + (zoneMs && zoneMs.type === 'zone' ? Math.min(6, zoneMs.duration / 1000) : 0));
    this.target.set(0, 1.3, reach * 0.5);
    this.dist = Math.max(9, reach * 1.1 + 4.5);
    sim.step();
    sim.drainEvents();
  }

  /** Cast the skill from the start. */
  replay(): void {
    const sim = this.sim;
    const def = ABILITIES[this.ability];
    const c = this.caster;
    if (!sim || !def || !c || !this.foe) return;
    for (const u of [c, this.foe, this.ally!]) {
      u.alive = true;
      u.health = u.maxHealth;
      u.auras = [];
      u.cast = null;
      u.cooldowns = {};
      u.chargesUsed = {};
      u.lockouts = {};
      u.gcdEnd = 0;
      u.resource = u.resourceMax;
      u.cp = 5;
    }
    c.pos = { x: 0, z: 0 };
    c.facing = 0;
    (sim as unknown as { zones: unknown[] }).zones = [];
    const ground = def.target === 'ground' ? { x: this.foe.pos.x, z: this.foe.pos.z } : null;
    const tgt = def.target === 'self' || def.target === 'aoe_enemy' || def.target === 'aoe_all' ? c.id : def.target === 'ally' ? this.ally!.id : this.foe.id;
    c.target = this.foe.id;
    const r = sim.useAbility(c.id, this.ability, tgt, ground, 0, 0);
    if (!r.ok) this.note.textContent = `The skill could not be cast in this little match: ${(r as { reason: string }).reason}.`;
    this.nextCast = this.clock + this.period;
  }

  private stepSim(dt: number): void {
    const sim = this.sim;
    if (!sim) return;
    this.acc += dt;
    const tick = TUNING.tickMs / 1000;
    let guard = 0;
    while (this.acc >= tick && guard++ < 8) {
      this.acc -= tick;
      sim.step();
      for (const ev of sim.drainEvents() as SimEvent[]) this.effects.event(ev);
    }
    for (const u of sim.units.values()) {
      if (u.id === this.foe?.id || u.id === this.ally?.id) {
        u.health = u.maxHealth; // the dummies never fall
        u.alive = true;
      }
    }
  }

  // ---------------------------------------------------------------- drawing

  private ensure(): THREE.WebGLRenderer | null {
    if (this.renderer || this.failed) return this.renderer;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    } catch {
      this.failed = true;
      this.note.textContent = 'This browser could not start the 3D view.';
    }
    return this.renderer;
  }

  private frame(rawDt: number): void {
    const r = this.ensure();
    const sim = this.sim;
    if (!r || !sim) return;
    if (this.replayAt && performance.now() >= this.replayAt) {
      this.replayAt = 0;
      this.replay();
    }
    const dt = this.paused ? 0 : rawDt * this.speed;
    this.clock += dt;
    if (dt > 0) {
      this.stepSim(dt);
      if (this.loop && this.clock >= this.nextCast) this.replay();
    }
    const snap = sim.snapshot();
    this.effects.setZones(snap.zones ?? [], snap.time);
    this.effects.update(
      dt,
      snap.units.map((s) => ({ id: s.id, x: s.x, y: s.y ?? 0, z: s.z, facing: s.facing, alive: s.alive, auras: s.auras.map((a) => a.id) })),
    );
    for (const d of this.chars.values()) {
      const u = d.unit;
      d.holder.position.set(u.pos.x, 0, u.pos.z);
      d.holder.rotation.y = u.facing;
      d.char.setState(u.alive, false);
      d.char.pose({ phase: 0, move: 0, casting: !!u.cast, time: this.clock, dt: Math.max(0.001, dt), vf: 0, vs: 0, air: 0 });
    }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w > 0 && h > 0 && (this.canvas.width !== Math.round(w * r.getPixelRatio()) || this.canvas.height !== Math.round(h * r.getPixelRatio()))) {
      r.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    const cp = Math.cos(this.pitch);
    this.camera.position.set(this.target.x + Math.sin(this.yaw) * cp * this.dist, this.target.y + Math.sin(this.pitch) * this.dist, this.target.z + Math.cos(this.yaw) * cp * this.dist);
    this.camera.lookAt(this.target);
    r.render(this.scene, this.camera);
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
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  close(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.root.classList.remove('open');
  }

  // ---------------------------------------------------------------- the dropped file

  private async drop(f: File): Promise<void> {
    if (!this.setLookFile) {
      this.note.textContent = 'This page has no projectile to give a picture or model to.';
      return;
    }
    this.note.textContent = `Uploading ${f.name}…`;
    const r = await uploadModel(f);
    if (!r.ok) {
      this.note.textContent = r.text;
      return;
    }
    this.setLookFile(r.file);
    this.note.textContent = `${f.name} is now the look of ${ABILITIES[this.ability]?.name ?? this.ability}'s projectile (${skillLook(this.ability).file || r.file}). Cast it again to see it.`;
    this.replaySoon();
  }

  // ---------------------------------------------------------------- window

  private wire(c: HTMLCanvasElement): void {
    let drag: { x: number; y: number; pan: boolean } | null = null;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
      c.style.cursor = 'grabbing';
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.pan) {
        this.target.y = Math.max(0.2, Math.min(6, this.target.y + dy * 0.01));
        this.target.z += dx * 0.01;
      } else {
        this.yaw -= dx * 0.01;
        this.pitch = Math.max(0.05, Math.min(1.45, this.pitch + dy * 0.006));
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
        this.dist = Math.max(4, Math.min(60, this.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
      },
      { passive: false },
    );
  }

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
      this.root.style.height = `${Math.max(260, Math.min(window.innerHeight, g.h))}px`;
    } catch {
      /* no saved place */
    }
  }
}
