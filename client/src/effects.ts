import { lightMode } from './lightMode';
import * as THREE from 'three';
import { ABILITIES, AURAS, FX_INFO, NEUTRAL_LOOK, fxNum, fxSec, lookColor, skillLook } from '@arena/shared';
import type { SkillLook } from '@arena/shared';

const FX_GROUPS = FX_INFO;
import type { AbilityDef, School, SimEvent, ZoneSnap } from '@arena/shared';
import { clothShade, clothWave, endFade, unfurlProgress } from './flagCloth';
import { AURA_VISUAL, LayerBook, coneShape, fireFieldShape, coneSpawnAngle, fireballLookFor, fireballShape, fireballTailScale, hotAuras, impactKindFor, isDotTick, layerAlpha, visualFor, windupScale } from './skillVisuals';
import { FireballRig, fireballColors, makeRibbonTexture } from './fireballFx';
import { FireField, newFirePlace } from './fireFx';
import type { RigHost } from './fireballFx';
import { SHOUT_RELEASE } from './shoutPose';
import type { AuraStyle, AuraVisual, FireballLook, ImpactKind } from './skillVisuals';

/**
 * Spell and combat visuals, driven entirely by sim events plus the aura list on each unit.
 * Purely cosmetic: nothing here feeds back into the simulation or the protocol.
 */

export interface EffectUnit {
  id: number;
  x: number;
  z: number;
  /** Height of the model's feet as drawn (floor plus air). */
  y: number;
  facing: number;
  alive: boolean;
  auras: string[];
  /** Model size relative to a normal unit (default 1); aura visuals around the body scale with it. */
  scale?: number;
}

interface Pos {
  x: number;
  z: number;
  /** Height of the model's feet as drawn (the floor under it plus any jump or levitation): unit-attached effects are built on it. */
  y: number;
  facing: number;
}

const SCHOOL_COLOR: Record<School, number> = {
  physical: 0xffe2b0,
  fire: 0xff7a2a,
  frost: 0x7fd8ff,
  arcane: 0xc58bff,
  holy: 0xffe98a,
  shadow: 0x9a4dff,
  nature: 0x7dff7a,
};

const BUFF_COLOR: Record<string, number> = {
  recklessness: 0xff4a2a, shield_wall: 0x9db4d8, arcane_power: 0xc58bff, pain_suppression: 0xfff1a8,
  dispersion: 0x9a4dff, adrenaline_rush: 0xfff079, evasion: 0xb8c4d8,
};

const ERUPT: Record<ImpactKind, { col: number; core: number; tex: string; disc: number; discAdd: boolean; spark: number }> = {
  fire: { col: 0xff5a14, core: 0xffd45a, tex: 'flame', disc: 0x1a0d06, discAdd: false, spark: 0xffc060 },
  frost: { col: 0x8fdcff, core: 0xeaf9ff, tex: 'ice', disc: 0xcdf1ff, discAdd: true, spark: 0xe6f8ff },
  shadow: { col: 0x7a2fd8, core: 0xd9a8ff, tex: 'flame', disc: 0x1a0a2a, discAdd: false, spark: 0xb06bff },
  holy: { col: 0xffd75a, core: 0xffffff, tex: 'glow', disc: 0xffe98a, discAdd: true, spark: 0xfff1a8 },
  arcane: { col: 0xb06bff, core: 0xf0dcff, tex: 'flame', disc: 0x5a2a8a, discAdd: true, spark: 0xe0c2ff },
  nature: { col: 0x6aff5a, core: 0xe4ffb0, tex: 'flame', disc: 0x1a3a10, discAdd: false, spark: 0xb8ff9a },
  dust: { col: 0xc9b99a, core: 0xffffff, tex: 'smoke', disc: 0x8a7a60, discAdd: false, spark: 0xe6d8b8 },
};

const CHEST = 1.2;
const HEAD = 2.1;
const PROJECTILE_SPEED = 38;
const AXE_FLIGHT = 0.25;

type TexName = 'glow' | 'star' | 'plus' | 'smoke' | 'spark' | 'flame';

function makeTexture(draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  draw(c.getContext('2d')!, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildTextures(): Record<TexName, THREE.Texture> {
  const radial = (g: CanvasRenderingContext2D, s: number, stops: [number, string][]) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    for (const [o, col] of stops) grad.addColorStop(o, col);
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  };
  const poly = (g: CanvasRenderingContext2D, s: number, pts: [number, number][]) => {
    g.fillStyle = '#fff';
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)));
    g.closePath();
    g.fill();
  };
  return {
    glow: makeTexture((g, s) => radial(g, s, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,.6)'], [1, 'rgba(255,255,255,0)']])),
    smoke: makeTexture((g, s) => radial(g, s, [[0, 'rgba(255,255,255,.55)'], [0.6, 'rgba(255,255,255,.2)'], [1, 'rgba(255,255,255,0)']])),
    spark: makeTexture((g, s) => radial(g, s, [[0, 'rgba(255,255,255,1)'], [0.12, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,.15)'], [1, 'rgba(255,255,255,0)']])),
    flame: makeTexture((g, s) => {
      // teardrop of fire: bright base, soft pointed tip
      g.save();
      g.beginPath();
      g.moveTo(s * 0.5, s * 0.02);
      g.bezierCurveTo(s * 0.86, s * 0.38, s * 0.98, s * 0.62, s * 0.5, s * 0.98);
      g.bezierCurveTo(s * 0.02, s * 0.62, s * 0.14, s * 0.38, s * 0.5, s * 0.02);
      g.closePath();
      g.clip();
      const grad = g.createRadialGradient(s * 0.5, s * 0.72, 0, s * 0.5, s * 0.72, s * 0.62);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.45, 'rgba(255,255,255,.7)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
      g.restore();
    }),
    star: makeTexture((g, s) => {
      radial(g, s, [[0, 'rgba(255,255,255,.5)'], [1, 'rgba(255,255,255,0)']]);
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const r = i % 2 ? 0.17 : 0.46;
        pts.push([0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r]);
      }
      poly(g, s, pts);
    }),
    plus: makeTexture((g, s) => {
      radial(g, s, [[0, 'rgba(255,255,255,.4)'], [1, 'rgba(255,255,255,0)']]);
      poly(g, s, [[0.38, 0.12], [0.62, 0.12], [0.62, 0.38], [0.88, 0.38], [0.88, 0.62], [0.62, 0.62], [0.62, 0.88], [0.38, 0.88], [0.38, 0.62], [0.12, 0.62], [0.12, 0.38], [0.38, 0.38]]);
    }),
  };
}

interface Particle {
  sprite: THREE.Sprite;
  vx: number; vy: number; vz: number;
  life: number; max: number;
  s0: number; s1: number;
  a0: number;
  grav: number; drag: number;
  spin: number;
  /** Fire flipbook: frame offset and frames per second (0 = not a flipbook particle). */
  fps: number; ph: number; frame: number;
  /** Colour at the start and the end of life (r, g, b), when it fades from one to the other. */
  cr: number; cg: number; cb: number; er: number; eg: number; eb: number; fade: boolean;
}

interface Fx {
  /** Returns true when finished. */
  update(dt: number): boolean;
  dispose(): void;
}

interface ZoneVfx {
  last: number;
  update(z: ZoneSnap, now: number, dt: number): void;
  dispose(): void;
}

/** A persistent aura visual around one unit (DoT swirl, bleed drips, burn flames, frost shards, holy shimmer). */
interface Layer {
  group: THREE.Group;
  x: number;
  y: number;
  z: number;
  sc: number;
  age: number;
  /** 1 right after a tick, decays to 0. */
  flare: number;
  update(dt: number, alpha: number, t: number): void;
  dispose(): void;
}

interface Attachment {
  group: THREE.Group;
  update(dt: number, t: number, u: EffectUnit, moving: boolean): void;
}

const _o = new THREE.Object3D();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const PARTICLE_CAP = 900;
const PARTICLE_CAP_LIGHT = 360;
const FIRE_FRAMES = 25;
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _x = new THREE.Vector3(1, 0, 0);
const _y = new THREE.Vector3(0, 1, 0);
const _fd = new THREE.Vector3();

const rnd = (a = -1, b = 1) => a + Math.random() * (b - a);
const smoothstep = (x: number) => {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
};

export class Effects {
  private tex = buildTextures();
  /** The fire flipbook (public/fx/fire-sheet.webp, 5 x 5 frames, flame on black: drawn additively). Null until it has loaded or when it is missing: flames then use the canvas teardrop. */
  private fireFrames: THREE.Texture[] | null = null;
  private parts: Particle[] = [];
  private thin = 0;
  private pool: THREE.Sprite[] = [];
  private fx: Fx[] = [];
  private timers: { at: number; fn: () => void }[] = [];
  private flights = new Map<string, number>();
  private casting = new Map<number, Fx & { stop(): void }>();
  private attach = new Map<string, Attachment>();
  private prevPos = new Map<number, { x: number; z: number }>();
  /** The units drawn this frame, so a ring or column at a unit's spot can sit at its height. */
  private ids: number[] = [];
  private clock = 0;
  private ringGeo = new THREE.RingGeometry(0.88, 1, 56);
  private discGeo = new THREE.CircleGeometry(1, 40);
  private planeGeo = new THREE.PlaneGeometry(1, 1);
  private sphereGeo = new THREE.SphereGeometry(1, 24, 16);
  private beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
  private slashGeo = new THREE.RingGeometry(0.55, 0.68, 24, 1, 0, 2.3);
  private slashGeoThin = new THREE.RingGeometry(0.6, 0.63, 24, 1, 0.1, 2.1);
  private iceGeo = new THREE.ConeGeometry(0.13, 1, 5);

  /** Fired for melee abilities so the model can play its swing. */
  onSwing: (unit: number, fast?: boolean) => void = () => {};
  /** Fired for a shout, roar, scream or breath so the model can throw its head back and then thrust forward (shoutPose.ts). */
  onShout: (unit: number) => void = () => {};
  /** Fired when a unit takes a hit so the model can flash. */
  onHit: (unit: number) => void = () => {};

  /** The game camera, so the tail of a fireball can point along its flight as seen on screen (optional: without it the tail is only particles). */
  camera: THREE.Camera | null = null;

  /** Ground height under a point (bridge arenas); rings and zones sit on it. */
  groundY: (x: number, z: number) => number = () => 0;
  /**
   * The one light every fireball shares, created here once and left in the scene for good with intensity 0: three.js recompiles
   * every lit material when the number of lights changes, so a light is never added or removed while playing, only moved and dimmed.
   */
  private fireLight = new THREE.PointLight(0xff7a2a, 0, 12, 2);
  private lightWant = 0;
  private lightFlash = 0;
  private lightPos = new THREE.Vector3();
  private lightCur = 0;
  private lightFlashPos = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private pos: (id: number) => Pos | null) {
    this.fireLight.castShadow = false;
    scene.add(this.fireLight);
    this.loadFire();
  }

  /** A fireball asks for light at `p` this frame (the strongest ask wins). */
  private fireGlow(p: THREE.Vector3, power: number) {
    if (power <= this.lightWant) return;
    this.lightWant = power;
    this.lightPos.copy(p);
  }

  private loadFire() {
    try {
      new THREE.TextureLoader().load(
        '/fx/fire-sheet.webp',
        (sheet) => {
          sheet.colorSpace = THREE.SRGBColorSpace;
          // one texture object per frame, all sharing the one image (one upload): frames are picked per sprite
          const frames: THREE.Texture[] = [];
          for (let i = 0; i < FIRE_FRAMES; i++) {
            const t = sheet.clone();
            t.colorSpace = THREE.SRGBColorSpace;
            t.repeat.set(0.2, 0.2);
            t.offset.set((i % 5) * 0.2, 1 - (Math.floor(i / 5) + 1) * 0.2);
            t.needsUpdate = true;
            frames.push(t);
          }
          this.fireFrames = frames;
        },
        undefined,
        () => {},
      );
    } catch {
      /* no flipbook: the procedural flame is used */
    }
  }

  // ------------------------------------------------------------ primitives

  private sprite(tex: TexName, color: number, additive = true): THREE.Sprite {
    const s = this.pool.pop() ?? new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    const m = s.material as THREE.SpriteMaterial;
    m.map = this.tex[tex];
    m.color.set(color);
    m.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.opacity = 1;
    m.rotation = 0;
    m.needsUpdate = true;
    s.visible = true;
    this.scene.add(s);
    return s;
  }

  private particle(
    x: number, y: number, z: number,
    o: { tex?: TexName; color: number; vx?: number; vy?: number; vz?: number; life?: number; s0?: number; s1?: number; a?: number; grav?: number; drag?: number; add?: boolean; spin?: number; rot?: number; fire?: boolean; fps?: number; col1?: number },
  ) {
    if (this.parts.length > (lightMode.on ? PARTICLE_CAP_LIGHT : PARTICLE_CAP)) return;
    if (lightMode.on && this.thin++ % 5 < 2) return; // light mode: two of every five sparks are never drawn
    if (this.skillK.amount < 1 && Math.random() > this.skillK.amount) return; // fewer sparks (the Animations page's Amount)
    const flip = !!o.fire && !!this.fireFrames;
    const sp = this.sprite(flip ? 'glow' : o.tex ?? 'spark', o.color, flip ? true : o.add ?? true);
    const mat = sp.material as THREE.SpriteMaterial;
    const ph = flip ? Math.floor(Math.random() * FIRE_FRAMES) : 0;
    if (flip) mat.map = this.fireFrames![ph];
    if (o.rot !== undefined) mat.rotation = o.rot;
    _c.set(o.color);
    const c1 = o.col1 !== undefined ? _c2.set(o.col1) : _c;
    sp.position.set(x, y, z);
    const k = this.skillK;
    const s0 = (o.s0 ?? 0.3) * k.size;
    sp.scale.set(s0, s0, 1);
    this.parts.push({
      sprite: sp, vx: o.vx ?? 0, vy: o.vy ?? 0, vz: o.vz ?? 0,
      life: (o.life ?? 0.6) * k.life, max: (o.life ?? 0.6) * k.life, s0, s1: (o.s1 ?? 0) * k.size, a0: o.a ?? 1,
      grav: o.grav ?? 0, drag: o.drag ?? 0, spin: o.spin ?? 0,
      fps: flip ? o.fps ?? 18 : 0, ph, frame: ph,
      cr: _c.r, cg: _c.g, cb: _c.b, er: c1.r, eg: c1.g, eb: c1.b, fade: o.col1 !== undefined,
    });
  }

  /** Burst of sparks flying outward. */
  private burst(x: number, y: number, z: number, color: number, n: number, speed = 3.5, size = 0.28, life = 0.55, grav = 3) {
    n = Math.round(n * Math.max(1, this.skillK.amount)); // more sparks when the Animations page asks for them (fewer are dropped in particle)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const u = rnd(-0.3, 1);
      const r = Math.sqrt(1 - u * u);
      const sp = speed * rnd(0.4, 1);
      this.particle(x, y, z, {
        color, vx: Math.cos(a) * r * sp, vy: u * sp, vz: Math.sin(a) * r * sp,
        s0: size * rnd(0.6, 1.2), s1: 0, life: life * rnd(0.6, 1.1), grav, drag: 1.5,
      });
    }
  }

  private puff(x: number, y: number, z: number, color: number, n: number, size = 1.1) {
    for (let i = 0; i < n; i++) {
      this.particle(x + rnd(-0.3, 0.3), y + rnd(0, 0.4), z + rnd(-0.3, 0.3), {
        tex: 'smoke', color, add: false, vx: rnd(-1, 1), vy: rnd(0.2, 1), vz: rnd(-1, 1),
        s0: size * 0.5, s1: size * 1.6, life: rnd(0.6, 1.0), a: 0.55, drag: 1.2,
      });
    }
  }

  private later(sec: number, fn: () => void) {
    if (sec <= 0.001) fn();
    else this.timers.push({ at: this.clock + sec, fn });
  }

  private addFx(f: Fx) {
    this.fx.push(f);
    return f;
  }

  /** Height of the floor for something drawn at (x, z): the feet of a unit standing exactly there (a decked, jumping or levitating caster or target), else the ground. */
  private floorAt(x: number, z: number): number {
    for (const id of this.ids) {
      const p = this.pos(id);
      if (p && p.x === x && p.z === z) return p.y;
    }
    return this.groundY(x, z);
  }

  /** Flat ring on the ground that expands and fades. */
  private ring(x: number, z: number, color: number, from: number, to: number, life: number, y = 0.07, opacity = 0.9, additive = true) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: false });
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y + this.floorAt(x, z), z);
    this.scene.add(mesh);
    let t = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / life);
        const e = 1 - (1 - k) * (1 - k);
        const s = from + (to - from) * e;
        mesh.scale.set(s, s, 1);
        mat.opacity = opacity * (1 - k);
        return k >= 1;
      },
      dispose: () => {
        this.scene.remove(mesh);
        mat.dispose();
      },
    });
  }

  /**
   * A soft flat disc on the ground that grows from `from` to `to` yards, holds for `hold` of its life and then fades: the lingering
   * glow of a fire (additive or, to stay saturated on a light floor, normal blending) and the dark scorch mark (normal blending).
   */
  private decal(x: number, z: number, color: number, from: number, to: number, life: number, opacity: number, additive: boolean, hold = 0.2, y = 0.05) {
    const mat = new THREE.MeshBasicMaterial({ color, map: this.tex.glow, transparent: true, opacity, side: THREE.DoubleSide, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: false });
    const mesh = new THREE.Mesh(this.discGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y + this.floorAt(x, z), z);
    this.scene.add(mesh);
    let t = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / life);
        const s = from + (to - from) * (1 - (1 - k) * (1 - k));
        mesh.scale.set(s, s, 1);
        mat.opacity = opacity * (k < hold ? 1 : 1 - (k - hold) / (1 - hold));
        return k >= 1;
      },
      dispose: () => {
        this.scene.remove(mesh);
        mat.dispose();
      },
    });
  }

  /** Vertical column of light on a spot. */
  private column(x: number, z: number, color: number, life = 0.7, radius = 0.55, height = 6, op = 0.55) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(this.beamGeo, mat);
    mesh.position.set(x, height / 2 + this.floorAt(x, z), z);
    this.scene.add(mesh);
    let t = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / life);
        const r = radius * (1 - k * 0.7);
        mesh.scale.set(r, height, r);
        mat.opacity = op * (1 - k);
        return k >= 1;
      },
      dispose: () => {
        this.scene.remove(mesh);
        mat.dispose();
      },
    });
  }

  /** Straight beam between two points that fades out. */
  private beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: number, life = 0.28, radius = 0.09) {
    const a = new THREE.Vector3(ax, ay, az);
    const b = new THREE.Vector3(bx, by, bz);
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 0.01) return;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const mk = (r: number, col: number, op: number) => {
      const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const m = new THREE.Mesh(this.beamGeo, mat);
      m.position.copy(mid);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      m.scale.set(r, len, r);
      this.scene.add(m);
      return { m, mat, op, r };
    };
    const parts = [mk(radius * 2.4, color, 0.45), mk(radius, 0xffffff, 0.95)];
    let t = 0;
    for (let i = 0; i < 10; i++) {
      const f = Math.random();
      this.particle(ax + dir.x * f, ay + dir.y * f, az + dir.z * f, { color, vx: rnd(-0.8, 0.8), vy: rnd(-0.2, 1), vz: rnd(-0.8, 0.8), s0: 0.3, life: 0.5, drag: 1 });
    }
    this.addFx({
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / life);
        for (const p of parts) {
          p.mat.opacity = p.op * (1 - k);
          p.m.scale.set(p.r * (1 - k * 0.6), len, p.r * (1 - k * 0.6));
        }
        return k >= 1;
      },
      dispose: () => {
        for (const p of parts) {
          this.scene.remove(p.m);
          p.mat.dispose();
        }
      },
    });
  }

  /** Crescent slash across the target, seen from the attacker's side. */
  private slash(ax: number, az: number, tx: number, tz: number, color: number, scale = 1, y = CHEST, tilt = rnd(-0.7, 0.7)) {
    const group = new THREE.Group();
    group.position.set(tx, y + this.floorAt(tx, tz), tz);
    group.rotation.y = Math.atan2(tx - ax, tz - az);
    const inner = new THREE.Group();
    inner.rotation.z = tilt;
    group.add(inner);
    const mk = (geo: THREE.BufferGeometry, col: number, op: number) => {
      const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
      const m = new THREE.Mesh(geo, mat);
      inner.add(m);
      return mat;
    };
    const m1 = mk(this.slashGeo, color, 0.9);
    const m2 = mk(this.slashGeoThin, 0xffffff, 1);
    this.scene.add(group);
    let t = 0;
    const life = 0.24;
    this.addFx({
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / life);
        const s = scale * (0.75 + 0.6 * (1 - (1 - k) * (1 - k)));
        inner.scale.set(s, s, 1);
        inner.rotation.z = tilt - 0.5 + k * 1.0;
        m1.opacity = 0.9 * (1 - k);
        m2.opacity = 1 - k * k;
        return k >= 1;
      },
      dispose: () => {
        this.scene.remove(group);
        m1.dispose();
        m2.dispose();
      },
    });
  }

  /** One puff of a projectile's trail in a named style (the Animations page picks it; a skill's own look uses its school's). */
  private trailPuff(style: string, q: THREE.Vector3, color: number, size: number): void {
    switch (style) {
      case 'none':
        return;
      case 'flame':
        this.flame(q.x, q.y - 0.1, q.z, 0.55 * size);
        if (Math.random() < 0.3) this.particle(q.x, q.y, q.z, { tex: 'smoke', color: 0x332a26, add: false, s0: 0.3, s1: 0.9, life: 0.6, a: 0.5, vy: 0.6 });
        return;
      case 'frost':
        this.particle(q.x + rnd(-0.12, 0.12), q.y + rnd(-0.12, 0.12), q.z + rnd(-0.12, 0.12), { tex: Math.random() < 0.3 ? 'star' : 'spark', color: Math.random() < 0.5 ? 0xbfeaff : 0x5cb8ff, vy: rnd(-0.4, 0.4), s0: 0.32 * size, life: 0.45, drag: 2 });
        return;
      case 'embers':
        this.particle(q.x + rnd(-0.1, 0.1), q.y + rnd(-0.1, 0.1), q.z + rnd(-0.1, 0.1), { tex: 'spark', color: Math.random() < 0.5 ? 0xff9a3c : 0xffd24a, vy: rnd(0.2, 0.9), s0: 0.2 * size, s1: 0.02, life: 0.7, drag: 1 });
        return;
      case 'smoke':
        this.particle(q.x, q.y, q.z, { tex: 'smoke', color: 0x3a3340, add: false, s0: 0.3 * size, s1: 0.9 * size, life: 0.7, a: 0.5, vy: 0.4 });
        return;
      case 'shadow':
        this.particle(q.x + rnd(-0.15, 0.15), q.y + rnd(-0.15, 0.15), q.z + rnd(-0.15, 0.15), { tex: 'smoke', color: 0x6a2fb0, add: true, s0: 0.3 * size, s1: 0.8 * size, life: 0.6, a: 0.5, vy: rnd(0, 0.4) });
        return;
      case 'holy':
        this.particle(q.x + rnd(-0.15, 0.15), q.y + rnd(-0.15, 0.15), q.z + rnd(-0.15, 0.15), { tex: Math.random() < 0.4 ? 'star' : 'spark', color: 0xfff1a8, vy: rnd(0, 0.5), s0: 0.34 * size, life: 0.5, drag: 2 });
        return;
      case 'stars':
        this.particle(q.x + rnd(-0.15, 0.15), q.y + rnd(-0.15, 0.15), q.z + rnd(-0.15, 0.15), { tex: 'star', color, vy: rnd(0, 0.5), s0: 0.34 * size, life: 0.55, drag: 2 });
        return;
      default:
        this.particle(q.x + rnd(-0.15, 0.15), q.y + rnd(-0.15, 0.15), q.z + rnd(-0.15, 0.15), { tex: 'spark', color, vy: rnd(0, 0.5), s0: 0.34 * size, life: 0.5, drag: 2 });
    }
  }

  private projectile(srcId: number, tgtId: number, school: School, kind: 'frost' | 'fire' | 'holy' | 'arcane' | 'shadow', size = 1, swirl = 0, look: SkillLook = NEUTRAL_LOOK) {
    const s = this.pos(srcId);
    if (!s) return 0;
    const color = lookColor(look.color) ?? SCHOOL_COLOR[school];
    size *= look.size;
    const speed = PROJECTILE_SPEED * look.speed;
    if (look.form === 'spiral' && !swirl) swirl = 1;
    // the trail of the school's own look unless a style was picked
    const trailStyle = look.trail !== 'default' ? look.trail : kind === 'fire' ? 'flame' : kind === 'frost' ? 'frost' : kind === 'holy' ? 'holy' : 'default';
    const trailEvery = 0.016 / Math.max(0.05, look.trailAmount * (look.form === 'comet' ? 2.5 : 1));
    let last: THREE.Vector3 | null = null;
    const core = this.sprite('spark', 0xffffff);
    const halo = this.sprite('glow', color);
    core.scale.set(0.7 * size, 0.7 * size, 1);
    halo.scale.set(1.7 * size, 1.7 * size, 1);
    // volley missiles leave from alternating sides of the caster and curve in towards the target
    const side = Math.random() < 0.5 ? -1 : 1;
    const hand = swirl ? side * rnd(0.3, 0.6) : 0;
    const p = new THREE.Vector3(s.x + Math.sin(s.facing) * 0.6 + Math.cos(s.facing) * hand, s.y + 1.5 + (swirl ? rnd(-0.1, 0.5) : 0), s.z + Math.cos(s.facing) * 0.6 - Math.sin(s.facing) * hand);
    const q = p.clone();
    core.position.copy(p);
    halo.position.copy(p);
    const first = this.pos(tgtId);
    const flight = first ? Math.hypot(first.x - p.x, first.z - p.z) / speed : 0.2;
    let t = 0;
    let trail = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        const tp = this.pos(tgtId);
        const to = tp ? new THREE.Vector3(tp.x, tp.y + CHEST, tp.z) : p;
        const d = to.clone().sub(p);
        const step = speed * dt;
        const done = d.length() <= step + 0.4 || t > 3;
        const remaining = d.length();
        if (!done) p.addScaledVector(d.normalize(), step);
        q.copy(p);
        if (swirl) {
          const prog = Math.min(1, Math.max(0, 1 - remaining / Math.max(1, flight * speed)));
          const bend = Math.sin(Math.PI * prog) * swirl;
          const len = Math.hypot(d.x, d.z) || 1;
          q.x += (-d.z / len) * bend * side;
          q.z += (d.x / len) * bend * side;
          q.y += bend * 0.45;
        }
        core.position.copy(q);
        halo.position.copy(q);
        const pulse = 1 + Math.sin(t * 40) * 0.12;
        halo.scale.set(1.7 * size * pulse, 1.7 * size * pulse, 1);
        trail += dt;
        while (trail > trailEvery) {
          trail -= trailEvery;
          this.trailPuff(trailStyle, q, color, size);
        }
        if (look.form === 'bolt') {
          // a jagged bolt from where it was a moment ago to where it is now
          if (last) this.bolt(last.x, last.y, last.z, q.x, q.y, q.z, color, 0.12, 5, 0.35 * size);
          (last ??= new THREE.Vector3()).copy(q);
        }
        return done;
      },
      dispose: () => {
        for (const sp of [core, halo]) {
          this.scene.remove(sp);
          sp.visible = false;
          this.pool.push(sp);
        }
      },
    });
    return flight;
  }

  // ------------------------------------------------------------ flipbook fireball (Fireball, Pyroblast: see fireballFx.ts)

  private rigHost: RigHost | null = null;
  private ribbonTex: THREE.Texture | null = null;
  private makeRig(look: FireballLook): FireballRig {
    return new FireballRig(this.getRigHost(), look);
  }

  /** The sprite pool, flipbook frames and ground disc the flame rigs (fireball and fire fields) draw with. */
  private getRigHost(): RigHost {
    return (this.rigHost ??= {
      scene: this.scene,
      sprite: (tex, color, additive) => this.sprite(tex, color, additive),
      release: (sp) => {
        this.scene.remove(sp);
        sp.visible = false;
        this.pool.push(sp);
      },
      frames: () => this.fireFrames,
      glowTex: this.tex.glow,
      discGeo: this.discGeo,
      ribbonTex: (this.ribbonTex ??= makeRibbonTexture()),
    });
  }

  /** The ball grows in the caster's hand during the cast time (Pyroblast), with embers drawn into it. Ends at `stop()`. */
  private fireballWindup(unit: number, def: AbilityDef, look: FireballLook): Fx & { stop(): void } {
    const rig = this.makeRig(look);
    const col = rig.colors;
    const dur = Math.max(0.5, (def.castTime || 1000) / 1000);
    const pos = new THREE.Vector3();
    let t = 0;
    let acc = 0;
    let keep = 1; // the size factor that keeps the ball clear of a close camera, eased so it never jumps
    return {
      stop: () => {
        t = 1e9;
      },
      update: (dt: number) => {
        t += dt;
        const p = this.pos(unit);
        if (!p || t > 8) return true;
        const grow = Math.min(1, t / dur);
        const e = 0.12 + 0.43 * grow * grow; // small at first and about hand-sized at the moment of release (it swells to full size in the first moments of the flight)
        const sinF = Math.sin(p.facing);
        const cosF = Math.cos(p.facing);
        // held out in front of the right hand; with a close camera it slides to the side and down so it never fills the view
        pos.set(p.x + sinF * 0.7 - cosF * 0.35, p.y + 1.4, p.z + cosF * 0.7 + sinF * 0.35);
        let want = 1;
        if (this.camera) {
          const cp = this.camera.position;
          const d = Math.hypot(pos.x - cp.x, pos.y - cp.y, pos.z - cp.z);
          const near = 1 - Math.min(1, Math.max(0, (d - 1.2) / 3));
          pos.x += (-cosF * 0.45 + sinF * 0.2) * near;
          pos.z += (sinF * 0.45 + cosF * 0.2) * near;
          pos.y -= 0.3 * near;
          want = windupScale(d, rig.shape.shell * 2.6 * (0.35 + 0.65 * e));
        }
        keep += (want - keep) * Math.min(1, dt * 10);
        rig.sizeMul = keep;
        _fd.set(sinF, 0, cosF);
        rig.place(pos, _fd, t, e, false, this.camera, this.groundY(p.x, p.z));
        this.fireGlow(pos, 8 * look.size * (0.3 + 0.7 * grow));
        acc += dt * (1.5 + grow * 3);
        while (acc > 0.05) {
          acc -= 0.05;
          const a = Math.random() * Math.PI * 2;
          const r = rnd(0.9, 1.6) * (0.5 + look.size * 0.5) * (0.4 + 0.6 * keep);
          const sx = pos.x + Math.cos(a) * r;
          const sy = pos.y + rnd(-0.8, 0.5) * keep;
          const sz = pos.z + Math.sin(a) * r;
          const life = rnd(0.28, 0.4);
          this.particle(sx, sy, sz, { tex: 'spark', color: col.ember, s0: rnd(0.1, 0.18) * keep, s1: 0.04, life, vx: (pos.x - sx) / life, vy: (pos.y - sy) / life, vz: (pos.z - sz) / life, drag: 0 });
        }
        if (grow > 0.5 && Math.random() < dt * 8) this.flame(pos.x + rnd(-0.2, 0.2), pos.y + 0.1, pos.z + rnd(-0.2, 0.2), 0.45 * look.size * keep, rig.colors.shellB);
        return false;
      },
      dispose: () => rig.dispose(),
    };
  }

  /** A flipbook fireball in flight to `tgtId`: returns the flight time (the hit lands when it arrives), like `projectile`. */
  private fireballFlight(srcId: number, tgtId: number, look: FireballLook): number {
    const s = this.pos(srcId);
    if (!s) return 0;
    const rig = this.makeRig(look);
    const sh = rig.shape;
    const col = rig.colors;
    const p = new THREE.Vector3(s.x + Math.sin(s.facing) * 0.6, s.y + 1.5, s.z + Math.cos(s.facing) * 0.6);
    const dir = new THREE.Vector3(Math.sin(s.facing), 0, Math.cos(s.facing));
    const first = this.pos(tgtId);
    const flight = first ? Math.hypot(first.x - p.x, first.z - p.z) / PROJECTILE_SPEED : 0.2;
    rig.range = flight * PROJECTILE_SPEED;
    const tl = fireballTailScale(rig.range, sh.tail); // a short throw gets a short tail
    let t = 0;
    let gap = 0; // yards flown since the last tail flame
    let smokeGap = 0;
    let embers = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        const tp = this.pos(tgtId);
        if (tp) _fd.set(tp.x - p.x, tp.y + CHEST - p.y, tp.z - p.z);
        else _fd.set(0, 0, 0);
        const remaining = _fd.length();
        const step = PROJECTILE_SPEED * dt;
        const done = remaining <= step + 0.4 || t > 3;
        if (!done) {
          _fd.multiplyScalar(1 / remaining);
          dir.copy(_fd);
          p.addScaledVector(_fd, step);
          gap += step;
          smokeGap += step;
        }
        const en = Math.min(1, 0.5 + (t / 0.12) * 0.5);
        rig.place(p, dir, t, en, true, this.camera, this.groundY(p.x, p.z));
        this.fireGlow(p, 15 * look.size * (0.5 + 0.5 * en) * (1 + Math.sin(t * 31) * 0.08));
        // tail flames: dense and overlapping, one every `tailSpacing` yards along the path, tips trailing back, orange to red to dark
        while (gap > sh.tailSpacing && !done) {
          gap -= sh.tailSpacing;
          const j = sh.shell * 0.22;
          const back = gap + rnd(0, 0.15);
          if (back > rig.tailLen * 1.05) continue;
          this.particle(p.x - dir.x * back + rnd(-j, j), p.y - dir.y * back + rnd(-j, j), p.z - dir.z * back + rnd(-j, j), {
            fire: true, tex: 'flame', color: col.tailHot, col1: col.tailEnd, s0: sh.shell * rnd(1.9, 2.5) * (0.6 + 0.4 * tl), s1: sh.shell * 0.5, life: Math.max(0.07, (rig.tailLen / PROJECTILE_SPEED) * 1.35) * rnd(0.9, 1.25),
            vy: rnd(0.2, 0.9), drag: 1, a: 0.8, fps: rnd(18, 28), rot: rig.backRot + rnd(-0.3, 0.3),
          });
        }
        // dark smoke wisps in normal blending that stay behind in the air after the fire has gone by
        while (smokeGap > sh.tailSpacing * 2.5 && !done) {
          smokeGap -= sh.tailSpacing * 2.5;
          const back = smokeGap + rnd(0, 0.3) + rig.tailLen * 0.45;
          const j = sh.shell * 0.3;
          this.particle(p.x - dir.x * back + rnd(-j, j), p.y + rnd(-0.1, 0.25), p.z - dir.z * back + rnd(-j, j), {
            tex: 'smoke', color: col.smoke, add: false, s0: sh.shell * rnd(1.3, 1.9), s1: sh.shell * rnd(3.4, 4.6), life: rnd(0.7, 1.2) * (0.7 + 0.3 * tl), a: 0.62, vx: rnd(-0.3, 0.3), vy: rnd(0.5, 1.1), vz: rnd(-0.3, 0.3), drag: 1.4,
          });
        }
        // embers and sparks shed along the path
        embers += dt * sh.embersPerSec;
        while (embers > 1) {
          embers -= 1;
          const sp = rnd(0.5, 2.4);
          this.particle(p.x + rnd(-0.15, 0.15), p.y + rnd(-0.15, 0.15), p.z + rnd(-0.15, 0.15), {
            tex: Math.random() < 0.25 ? 'star' : 'spark', color: Math.random() < 0.6 ? col.ember : 0xffe9a0, s0: rnd(0.1, 0.22) * look.size ** 0.5, s1: 0.02,
            vx: -dir.x * rnd(1, 4) + rnd(-1, 1) * sp, vy: rnd(-0.3, 1.6), vz: -dir.z * rnd(1, 4) + rnd(-1, 1) * sp, grav: 3.5, drag: 1.1, life: rnd(0.4, 0.9),
          });
        }
        return done;
      },
      dispose: () => rig.dispose(),
    });
    return flight;
  }

  /** The fireball lands: a white flash, flames flaring outward, a ground ring, embers and smoke. `power` 0.6..1.6 from the damage. */
  fireballImpact(x: number, y: number, z: number, look: FireballLook, power = 1) {
    const sh = fireballShape(look.size, look.heat);
    const col = fireballColors(look.heat);
    const pk = Math.max(0.7, Math.min(1.4, 0.7 + 0.3 * power));
    const gy = this.floorAt(x, z); // the floor under the hit: a target on a deck or in the air
    // the flash and the heat bloom
    this.fireFlash(x, y, z, sh.flare, look.heat, pk);
    // flipbook flames flaring outward and up
    const n = Math.round(sh.flames * pk);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd(-0.3, 0.3);
      const sp = rnd(1.8, 5.2) * look.size * pk;
      const up = rnd(0.1, 0.9);
      this.particle(x + Math.cos(a) * 0.15, y + rnd(-0.2, 0.2), z + Math.sin(a) * 0.15, {
        fire: true, tex: 'flame', color: i % 3 ? col.shellA : col.shellB, col1: col.tailEnd, s0: sh.flare * rnd(0.8, 1.2), s1: sh.flare * rnd(1.8, 2.6),
        vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: sp * up + rnd(0.2, 1.2), life: rnd(0.4, 0.75), drag: 3, a: 0.95, fps: rnd(16, 26), rot: rnd(-0.5, 0.5),
      });
    }
    for (let i = 0; i < 3; i++) {
      this.particle(x + rnd(-0.25, 0.25), y + rnd(-0.1, 0.2), z + rnd(-0.25, 0.25), { fire: true, tex: 'flame', color: col.tailHot, col1: col.tailMid, s0: sh.flare * 1.3, s1: sh.flare * 2.4, vy: rnd(2.5, 4.5) * look.size, life: rnd(0.55, 0.8), drag: 1.5, a: 0.9, fps: 20, rot: rnd(-0.3, 0.3) });
    }
    // the shock rings on the ground: a saturated orange ring in normal blending (it stays orange on a light floor), a hot additive
    // ring on top of it, and a second thin one following
    this.ring(x, z, col.ringBase, 0.3, sh.ring * pk, 0.45, 0.075, 0.95, false);
    this.ring(x, z, col.ringHot, 0.3, sh.ring * 0.96 * pk, 0.4, 0.085, 1);
    this.ring(x, z, col.ringHot, 0.2, sh.ring * 0.62 * pk, 0.26, 0.09, 0.8);
    // sparks and embers thrown out, then smoke
    const m = Math.round(sh.embers * pk);
    for (let i = 0; i < m; i++) {
      const a = Math.random() * Math.PI * 2;
      const u = rnd(-0.2, 1);
      const r = Math.sqrt(1 - u * u);
      const sp = rnd(2.5, 8) * Math.sqrt(look.size);
      this.particle(x, y, z, { tex: Math.random() < 0.3 ? 'star' : 'spark', color: Math.random() < 0.6 ? col.ember : 0xffe9a0, s0: rnd(0.12, 0.3), s1: 0.02, vx: Math.cos(a) * r * sp, vy: u * sp, vz: Math.sin(a) * r * sp, grav: 6, drag: 1.2, life: rnd(0.5, 1.1) });
    }
    for (let i = 0, k = Math.round(sh.smoke * pk); i < k; i++) {
      this.particle(x + rnd(-0.4, 0.4), Math.max(y, gy + 0.3) + rnd(-0.2, 0.3), z + rnd(-0.4, 0.4), { tex: 'smoke', color: col.smoke, add: false, s0: sh.flare * 0.9, s1: sh.flare * rnd(2.2, 3), vx: rnd(-1, 1), vy: rnd(0.8, 1.8), vz: rnd(-1, 1), life: rnd(0.8, 1.4), a: 0.5, drag: 1.3 });
    }
    // what lingers on the ground: an orange glow (normal blending under an additive core, so it reads on light and dark floors) and,
    // under it, a short-lived darkened scorch mark
    this.fireGroundGlow(x, z, sh.ring, look.heat);
    this.lightFlash = 90 * look.size * pk;
    this.lightFlashPos.set(x, Math.max(y, gy + 0.8), z);
  }

  // ------------------------------------------------------------ axe and chain

  private axeGeos: { blade: THREE.BufferGeometry; haft: THREE.BufferGeometry; cap: THREE.BufferGeometry } | null = null;
  private axeMats = {
    steel: new THREE.MeshStandardMaterial({ color: 0xd3dae6, metalness: 0.7, roughness: 0.3, emissive: 0x3a4252, side: THREE.DoubleSide }),
    wood: new THREE.MeshLambertMaterial({ color: 0x7a4a26, emissive: 0x2a180a }),
  };
  private linkGeo = new THREE.TorusGeometry(0.13, 0.04, 5, 10);
  private linkMat = new THREE.MeshStandardMaterial({ color: 0xaab3c4, metalness: 0.7, roughness: 0.35, emissive: 0x30384a });
  private hookGeo = new THREE.ConeGeometry(0.1, 0.34, 5);

  /** A small two-bladed throwing axe (about 1.1 yd long) built from shared geometry. */
  private makeAxe(): THREE.Group {
    if (!this.axeGeos) {
      const sh = new THREE.Shape();
      sh.moveTo(0, 0.07);
      sh.quadraticCurveTo(0.2, 0.1, 0.3, 0.28);
      sh.quadraticCurveTo(0.42, 0.1, 0.38, 0);
      sh.quadraticCurveTo(0.42, -0.1, 0.3, -0.28);
      sh.quadraticCurveTo(0.2, -0.1, 0, -0.07);
      sh.closePath();
      const blade = new THREE.ExtrudeGeometry(sh, { depth: 0.05, bevelEnabled: false, curveSegments: 5 });
      blade.translate(0, 0, -0.025);
      this.axeGeos = {
        blade,
        haft: new THREE.CylinderGeometry(0.035, 0.045, 1.1, 6),
        cap: new THREE.SphereGeometry(0.06, 6, 5),
      };
    }
    const g = new THREE.Group();
    const haft = new THREE.Mesh(this.axeGeos.haft, this.axeMats.wood);
    g.add(haft);
    // blades extend along local Z (the spin plane is YZ)
    for (const side of [1, -1]) {
      const b = new THREE.Mesh(this.axeGeos.blade, this.axeMats.steel);
      b.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      b.position.y = 0.38;
      g.add(b);
    }
    const cap = new THREE.Mesh(this.axeGeos.cap, this.axeMats.steel);
    cap.position.y = 0.38;
    cap.scale.set(1, 1.6, 1);
    const pom = new THREE.Mesh(this.axeGeos.cap, this.axeMats.steel);
    pom.position.y = -0.56;
    g.add(cap, pom);
    return g;
  }

  /** Axe Throw: the axe leaves the hand, spins end over end along an arc and bites into the target. */
  private axeThrow(srcId: number, tgtId: number) {
    const s = this.pos(srcId);
    const t0 = this.pos(tgtId);
    if (!s || !t0) return;
    const axe = this.makeAxe();
    const holder = new THREE.Group(); // yaw towards the target; the axe spins about the holder's X axis
    holder.add(axe);
    axe.scale.setScalar(1.9);
    this.scene.add(holder);
    const sx = s.x + Math.sin(s.facing) * 0.6 + Math.cos(s.facing) * 0.35;
    const sz = s.z + Math.cos(s.facing) * 0.6 - Math.sin(s.facing) * 0.35;
    const sy = s.y + 1.6;
    let t = 0;
    let trail = 0;
    let tx = t0.x, tz = t0.z, ty = t0.y;
    this.addFx({
      update: (dt) => {
        t += dt;
        const tp = this.pos(tgtId);
        if (tp) {
          tx = tp.x;
          tz = tp.z;
          ty = tp.y;
        }
        const k = Math.min(1, t / AXE_FLIGHT);
        const px = sx + (tx - sx) * k;
        const pz = sz + (tz - sz) * k;
        const py = sy + (ty + CHEST - sy) * k + Math.sin(Math.PI * k) * 0.9;
        holder.position.set(px, py, pz);
        holder.rotation.y = Math.atan2(tx - sx, tz - sz); // local Z points at the target
        axe.rotation.set(-k * Math.PI * 5 - 0.6, 0, 0);
        trail += dt;
        while (trail > 0.012) {
          trail -= 0.012;
          this.particle(px + rnd(-0.05, 0.05), py + rnd(-0.25, 0.25), pz + rnd(-0.05, 0.05), { color: 0xdfe6f2, s0: 0.2, life: 0.22, drag: 2, vy: rnd(-0.3, 0.3) });
          this.particle(px, py, pz, { tex: 'glow', color: 0x9aa6bd, s0: 0.5, s1: 0.05, life: 0.18, a: 0.5 });
        }
        if (k >= 1) {
          this.onHit(tgtId);
          this.burst(px, ty + CHEST, pz, 0xfff0c0, 14, 6, 0.26, 0.4, 5);
          this.burst(px, ty + CHEST, pz, 0xdfe6f2, 8, 4, 0.22, 0.35, 3);
          this.particle(px, ty + CHEST, pz, { tex: 'star', color: 0xffffff, s0: 0.3, s1: 2.2, life: 0.18 });
          this.ring(px, pz, 0xdfe6f2, 0.3, 1.6, 0.25, 0.1, 0.8);
          return true;
        }
        return false;
      },
      dispose: () => this.scene.remove(holder),
    });
  }

  /** Reel In: a chain of links shoots to the target, hooks on and drags it back towards the warrior. */
  private chain(srcId: number, tgtId: number) {
    const MAX = 22;
    const mesh = new THREE.InstancedMesh(this.linkGeo, this.linkMat, MAX);
    mesh.frustumCulled = false;
    const hook = new THREE.Mesh(this.hookGeo, this.linkMat);
    this.scene.add(mesh, hook);
    let t = 0;
    const life = 0.55;
    this.addFx({
      update: (dt) => {
        t += dt;
        const a = this.pos(srcId);
        const b = this.pos(tgtId);
        if (!a || !b) return true;
        const ax = a.x + Math.sin(a.facing) * 0.4, az = a.z + Math.cos(a.facing) * 0.4;
        const reach = Math.min(1, t / 0.1);
        const dx = b.x - ax, dz = b.z - az;
        const dy = b.y + CHEST - (a.y + 1.3);
        const len = Math.hypot(dx, dy, dz) * reach;
        const n = Math.max(1, Math.min(MAX, Math.round(len / 0.24)));
        _v.set(dx, dy, dz).normalize();
        _q.setFromUnitVectors(_x, _v);
        const tension = Math.max(0, 1 - Math.max(0, t - 0.1) / 0.3); // slack tightens as it pulls
        for (let i = 0; i < MAX; i++) {
          if (i >= n) {
            _o.scale.setScalar(0.0001);
            _o.updateMatrix();
            mesh.setMatrixAt(i, _o.matrix);
            continue;
          }
          const f = (i + 0.5) / n;
          const dist = f * len;
          const sag = Math.sin(Math.PI * f) * 0.35 * tension;
          _o.position.set(ax + _v.x * dist, a.y + 1.3 + _v.y * dist - sag, az + _v.z * dist);
          _o.quaternion.copy(_q);
          _o.rotateX(i % 2 ? Math.PI / 2 : 0);
          _o.scale.set(1.35, 1, 1);
          _o.updateMatrix();
          mesh.setMatrixAt(i, _o.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        hook.position.set(ax + _v.x * len, a.y + 1.3 + _v.y * len, az + _v.z * len);
        hook.quaternion.setFromUnitVectors(_y, _v);
        hook.rotateX(Math.PI); // barb points at the target
        if (t < 0.15 && Math.random() < 0.8) this.particle(b.x, b.y + CHEST, b.z, { color: 0xdfe6f2, vx: rnd(-2, 2), vz: rnd(-2, 2), vy: rnd(0, 2), s0: 0.2, life: 0.25, drag: 2 });
        return t >= life;
      },
      dispose: () => {
        this.scene.remove(mesh, hook);
        mesh.dispose();
      },
    });
  }

  // ------------------------------------------------------------ on-target toolkit
  // Instants draw their result where it lands: eruptions out of the ground, impacts on the body, swirls around it.

  private lastCast = new Map<string, number>();
  private unitAuras = new Map<number, readonly string[]>();
  private hotIds = new Set(hotAuras());
  private layers = new Map<string, Layer>();
  private layerBook = new LayerBook();

  /**
   * Fire erupting under a target (Scorch): the shared flame field (fireFx.ts) at the target's feet, tongues leaping up in a swirl round a
   * white-hot core, a flash, ground rings, embers, smoke, and an orange glow over a scorch mark that stays. About 30 pooled sprites.
   */
  private fireEruption(x: number, z: number, scale = 1) {
    const gy = this.groundY(x, z);
    const field = new FireField(this.getRigHost(), fireFieldShape('burst', 1.15, scale), 0);
    const pl = newFirePlace();
    pl.x = x;
    pl.y = gy;
    pl.z = z;
    this.fireFlash(x, gy + 0.9 * scale, z, 0.8 * scale);
    const fc = fireballColors(0);
    this.ring(x, z, fc.ringBase, 0.4, 2.6 * scale, 0.45, 0.075, 0.95, false);
    this.ring(x, z, fc.ringHot, 0.4, 2.5 * scale, 0.4, 0.085, 1);
    this.ring(x, z, fc.ringHot, 0.2, 1.5 * scale, 0.3, 0.09, 0.8);
    this.emberShower(x, gy, z, 0.9 * scale, 16, { rise: 1.6 });
    this.smokeWisps(x, gy + 1.2 * scale, z, 3, 1.2 * scale, { spread: 0.5 });
    this.fireGroundGlow(x, z, 1.4 * scale);
    let t = 0;
    let acc = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        pl.t = t;
        pl.build = smoothstep(t / 0.2);
        pl.fade = 1 - smoothstep((t - 0.55) / 0.6);
        pl.flash = Math.max(0, 1 - t / 0.35);
        pl.scorch = pl.fade;
        // (no flames on the ground: the fire comes down from above)
        acc += dt * 34;
        while (t < 0.4 && acc > 1) {
          acc -= 1;
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * 0.85 * scale;
          this.fireTongue(x + Math.cos(a) * r, gy + 0.1, z + Math.sin(a) * r, 0.9 * scale, 0xff5a14, { vy: rnd(2, 3.4) * scale });
        }
        return t >= 1.2;
      },
      dispose: () => field.dispose(),
    });
  }

  /** Flames, ice, shadow or light shooting up out of the ground under a point, with a ring, a scorch mark and sparks. */
  groundEruption(x: number, z: number, kind: ImpactKind, scale = 1) {
    if (kind === 'fire') return this.fireEruption(x, z, scale);
    const P = ERUPT[kind];
    const gy = this.groundY(x, z);
    const ice = P.tex === 'ice';
    const group = new THREE.Group();
    group.position.set(x, gy, z);
    const map = ice ? null : this.tex[P.tex as TexName];
    const mat = new THREE.MeshBasicMaterial({ color: P.col, map, transparent: true, opacity: 0.95, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const matCore = mat.clone();
    matCore.color.set(P.core);
    const discMat = new THREE.MeshBasicMaterial({ color: P.disc, transparent: true, opacity: 0, depthWrite: false, blending: P.discAdd ? THREE.AdditiveBlending : THREE.NormalBlending });
    const disc = new THREE.Mesh(this.discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.04;
    group.add(disc);
    const N = 10;
    const tongues: { m: THREE.Mesh; h: number; w: number; d: number; ph: number }[] = [];
    for (let i = 0; i < N; i++) {
      const inner = i >= 7;
      const a = (i / N) * Math.PI * 2 + rnd(-0.3, 0.3);
      const r = inner ? rnd(0, 0.25) * scale : rnd(0.45, 1.0) * scale;
      const m = new THREE.Mesh(ice ? this.iceGeo : this.tongueGeo, inner ? matCore : mat);
      m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      if (ice) m.rotation.set(Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3);
      group.add(m);
      tongues.push({
        m,
        h: (ice ? rnd(1.2, 2.1) : inner ? rnd(2.8, 3.4) : rnd(1.8, 2.7)) * scale * (inner && ice ? 1.3 : 1),
        w: (ice ? 2.3 : rnd(0.9, 1.3)) * (inner ? 0.65 : 1) * scale,
        d: i * 0.012 + rnd(0, 0.08),
        ph: rnd(0, 6.28),
      });
    }
    this.scene.add(group);
    // flash, ring, sparks flying up
    this.particle(x, gy + 0.6, z, { tex: 'glow', color: P.col, s0: 1, s1: 4.2 * scale, life: 0.35, a: 0.9 });
    this.ring(x, z, P.col, 0.4, 2.6 * scale, 0.45, 0.08, 1);
    this.ring(x, z, 0xffffff, 0.2, 1.5 * scale, 0.3, 0.09, 0.7);
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.8 * scale;
      this.particle(x + Math.cos(a) * r, gy + 0.1, z + Math.sin(a) * r, { color: P.spark, vx: rnd(-1, 1), vz: rnd(-1, 1), vy: rnd(3.5, 8) * scale, s0: rnd(0.15, 0.3), life: rnd(0.5, 0.9), grav: 8, drag: 0.6 });
    }
    if (kind === 'shadow') this.puff(x, gy + 0.5, z, 0x2a1040, 4, 1.4 * scale);
    let t = 0;
    let acc = 0;
    const LIFE = ice ? 0.9 : 0.7;
    this.addFx({
      update: (dt) => {
        t += dt;
        const fall = Math.min(1, Math.max(0, (t - 0.3) / (LIFE - 0.3)));
        for (const q of tongues) {
          const u = Math.min(1, Math.max(0, (t - q.d) / 0.16));
          const grow = 1 - (1 - u) * (1 - u) * (1 - u);
          const sink = Math.min(1, Math.max(0, (t - 0.28 - q.d) / (LIFE - 0.28)));
          const hh = Math.max(0.001, q.h * grow * (1 - sink * sink));
          const ww = q.w * (ice ? 1 : 1 + 0.18 * Math.sin(t * 32 + q.ph)) * (1 - sink * 0.5);
          q.m.scale.set(ww, hh, ww);
          if (ice) q.m.position.y = hh / 2;
        }
        mat.opacity = matCore.opacity = 0.95 * (1 - fall * fall);
        const dk = Math.min(1, t / 0.1) * (1 - Math.min(1, Math.max(0, (t - 0.3) / 1.0)));
        discMat.opacity = (P.discAdd ? 0.35 : 0.55) * dk;
        const ds = scale * (1.1 + t * 0.5);
        disc.scale.set(ds, ds, 1);
        acc += dt;
        while (t < 0.35 && acc > 0.03) {
          acc -= 0.03;
          const a = Math.random() * Math.PI * 2;
          const r = Math.random() * 0.9 * scale;
          this.particle(x + Math.cos(a) * r, gy + 0.1, z + Math.sin(a) * r, { color: P.spark, vy: rnd(2, 4), s0: 0.22, life: 0.5, drag: 0.8 });
        }
        return t >= 1.3;
      },
      dispose: () => {
        this.scene.remove(group);
        mat.dispose();
        matCore.dispose();
        discMat.dispose();
      },
    });
  }

  /** Flying shards of ice (or anything pointed) that scatter from a point and drop. One shared material. */
  private shards(x: number, y: number, z: number, color: number, n = 6, speed = 5) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const list: { m: THREE.Mesh; vx: number; vy: number; vz: number }[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd(-0.3, 0.3);
      const sp = speed * rnd(0.7, 1.2);
      const v = { vx: Math.cos(a) * sp, vy: rnd(0.5, 3), vz: Math.sin(a) * sp };
      const m = new THREE.Mesh(this.iceGeo, mat);
      m.position.set(x, y, z);
      _v.set(v.vx, v.vy, v.vz).normalize();
      m.quaternion.setFromUnitVectors(_y, _v);
      m.scale.set(1.1, 0.6, 1.1);
      this.scene.add(m);
      list.push({ m, ...v });
    }
    let t = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        for (const s of list) {
          s.vy -= 9 * dt;
          s.m.position.x += s.vx * dt;
          s.m.position.y = Math.max(0.05, s.m.position.y + s.vy * dt);
          s.m.position.z += s.vz * dt;
          _v.set(s.vx, s.vy, s.vz).normalize();
          s.m.quaternion.setFromUnitVectors(_y, _v);
        }
        mat.opacity = 0.9 * (1 - (t / 0.5) ** 2);
        return t >= 0.5;
      },
      dispose: () => {
        for (const s of list) this.scene.remove(s.m);
        mat.dispose();
      },
    });
  }

  /** An instant hit shown on the target itself: flash, shock rings and a few school specific accents. Nothing travels. */
  impactAt(tgt: number | { x: number; z: number; y?: number }, kind: ImpactKind, scale = 1, dy = CHEST) {
    const p = typeof tgt === 'number' ? this.pos(tgt) : tgt;
    if (!p) return;
    const feet = p.y ?? this.groundY(p.x, p.z);
    const y = feet + dy;
    const P = ERUPT[kind];
    this.particle(p.x, y, p.z, { tex: 'star', color: 0xffffff, s0: 0.4 * scale, s1: 2.6 * scale, life: 0.2 });
    this.particle(p.x, y, p.z, { tex: 'glow', color: P.col, s0: 0.6 * scale, s1: 3.2 * scale, life: 0.35, a: 0.8 });
    this.ring(p.x, p.z, P.col, 0.3, 2.0 * scale, 0.4, 0.08, 0.9);
    this.ring(p.x, p.z, P.col, 0.2 * scale, 1.7 * scale, 0.3, dy, 0.7); // shock disc at body height
    this.burst(p.x, y, p.z, P.spark, Math.round(12 * scale), 5 * scale, 0.3, 0.5, kind === 'frost' ? 4 : 2);
    switch (kind) {
      case 'fire':
        for (let i = 0; i < 4; i++) this.flame(p.x + rnd(-0.4, 0.4), y - 0.5 + rnd(0, 0.6), p.z + rnd(-0.4, 0.4), 1.1 * scale);
        this.puff(p.x, y, p.z, 0x3a2f2a, 3, 1.2 * scale);
        break;
      case 'frost':
        this.shards(p.x, y, p.z, 0xbfeaff, 6, 5 * scale);
        break;
      case 'arcane':
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          this.particle(p.x, y, p.z, { tex: 'star', color: 0xe0c2ff, vx: Math.cos(a) * 4, vz: Math.sin(a) * 4, vy: rnd(-0.3, 0.5), s0: 0.35 * scale, life: 0.45, drag: 3 });
        }
        break;
      case 'shadow':
        // wisps are pulled in, then the dark bursts out
        for (let i = 0; i < 10; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = rnd(1.3, 1.9) * scale;
          this.particle(p.x + Math.cos(a) * r, y + rnd(-0.6, 0.6), p.z + Math.sin(a) * r, { tex: 'glow', color: 0x8a3dff, vx: -Math.cos(a) * r * 4, vz: -Math.sin(a) * r * 4, s0: 0.5, s1: 0.15, life: 0.25 });
        }
        this.later(0.22, () => this.puff(p.x, y, p.z, 0x2a1040, 4, 1.4 * scale));
        break;
      case 'holy':
        this.column(p.x, p.z, 0xfff1a8, 0.45, 0.35 * scale, 6, 0.28);
        for (let i = 0; i < 4; i++) this.particle(p.x + rnd(-0.5, 0.5), y - 0.5, p.z + rnd(-0.5, 0.5), { tex: 'plus', color: 0xfff1a8, vy: rnd(1, 2), s0: 0.35, s1: 0.1, life: 0.8, drag: 0.5 });
        break;
      case 'dust':
        this.puff(p.x, feet + HEAD - 0.1, p.z, 0xc9b99a, 5, 1.1 * scale);
        break;
      default:
        break;
    }
  }

  /** A spiral of motes winding up around a target (polymorph, dispel, leaps of faith). */
  swirlAt(tgt: number | { x: number; z: number; y?: number }, kind: ImpactKind, scale = 1) {
    const P = ERUPT[kind];
    let t = 0;
    let acc = 0;
    this.addFx({
      update: (dt) => {
        const p = typeof tgt === 'number' ? this.pos(tgt) : tgt;
        if (!p) return true;
        const feet = p.y ?? this.groundY(p.x, p.z);
        t += dt;
        acc += dt;
        while (acc > 0.025) {
          acc -= 0.025;
          const k = Math.min(1, t / 0.6);
          for (const o of [0, Math.PI]) {
            const a = t * 14 + o;
            const r = (1.0 - 0.55 * k) * scale;
            this.particle(p.x + Math.cos(a) * r, feet + 0.2 + k * 1.9, p.z + Math.sin(a) * r, { tex: k > 0.5 ? 'star' : 'glow', color: o ? P.core : P.col, s0: 0.3 * scale, s1: 0.1, life: 0.35 });
          }
        }
        if (t >= 0.6) {
          this.burst(p.x, feet + 2, p.z, P.spark, 12, 3, 0.3, 0.5, 0);
          this.ring(p.x, p.z, P.col, 0.4, 1.8 * scale, 0.4);
          return true;
        }
        return false;
      },
      dispose: () => {},
    });
  }

  // ------------------------------------------------------------ cones, sound waves, shockwaves, spinning blades

  private fanTex: THREE.Texture | null = null;
  private waveTex: THREE.Texture | null = null;
  private capGeo: THREE.SphereGeometry | null = null;

  /** Soft radial gradient with a bright rim (the ground sector of a cone: what the spell really covers). */
  private getFanTex(): THREE.Texture {
    if (this.fanTex) return this.fanTex;
    const s = 128;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,.85)');
    grad.addColorStop(0.55, 'rgba(255,255,255,.4)');
    grad.addColorStop(0.9, 'rgba(255,255,255,.3)');
    grad.addColorStop(0.97, 'rgba(255,255,255,.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    this.fanTex = new THREE.CanvasTexture(c);
    this.fanTex.colorSpace = THREE.SRGBColorSpace;
    return this.fanTex;
  }

  /** Pressure wave: transparent at the pole of the cap, a bright rim with two fainter ripples behind it. */
  private getWaveTex(): THREE.Texture {
    if (this.waveTex) return this.waveTex;
    const h = 128;
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = h;
    const g = c.getContext('2d')!;
    for (let y = 0; y < h; y++) {
      const t = y / (h - 1);
      const band = (m: number, w: number, a: number) => a * Math.exp(-(((t - m) / w) ** 2));
      const a = Math.min(1, 0.02 + 0.2 * t * t + band(0.93, 0.045, 0.95) + band(0.74, 0.03, 0.4) + band(0.56, 0.025, 0.22));
      g.fillStyle = `rgba(255,255,255,${a * (t > 0.985 ? 0.2 : 1)})`;
      g.fillRect(0, y, 4, 1);
    }
    this.waveTex = new THREE.CanvasTexture(c);
    this.waveTex.colorSpace = THREE.SRGBColorSpace;
    return this.waveTex;
  }

  /** Flat sector on the ground that grows to `r` yards along `facing` and fades: the real area of a cone. */
  private sector(x: number, z: number, facing: number, r: number, half: number, color: number, life: number, opacity = 0.7, follow?: number) {
    const geo = new THREE.CircleGeometry(1, Math.max(8, Math.ceil(half * 14)), facing - Math.PI / 2 - half, half * 2);
    const mat = this.flatMat(color, 0, this.getFanTex());
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.07 + this.floorAt(x, z), z);
    mesh.scale.set(0.01, 0.01, 1);
    this.scene.add(mesh);
    let t = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / life);
        const grow = Math.min(1, t / Math.min(0.28, life * 0.5));
        const sc = Math.max(0.01, r * (1 - (1 - grow) ** 2));
        mesh.scale.set(sc, sc, 1);
        if (follow !== undefined) {
          const p = this.pos(follow);
          if (p) mesh.position.set(p.x, 0.07 + p.y, p.z);
        }
        mat.opacity = opacity * Math.min(1, t / 0.08) * (1 - k * k) * (0.88 + 0.12 * Math.sin(t * 40));
        return k >= 1;
      },
      dispose: () => {
        this.scene.remove(mesh);
        geo.dispose();
        mat.dispose();
      },
    });
  }

  /**
   * Slice and Dice: the real cone on the ground (as Sweep draws it) stays under the warrior for the whole channel and turns with him,
   * and the blade flashes back and forth across the wedge instead of spinning all round. Ends with stop().
   */
  private sliceCone(unit: number, range: number, half: number, dur: number): Fx & { stop(): void } {
    const geo = new THREE.CircleGeometry(1, Math.max(8, Math.ceil(half * 14)), -Math.PI / 2 - half, half * 2);
    const mat = this.flatMat(0xdfe6f2, 0, this.getFanTex());
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.set(range, range, 1);
    const grp = new THREE.Group();
    grp.add(mesh);
    this.scene.add(grp);
    let t = 0;
    let off = 0;
    let stopped = false;
    let cut = 0;
    const fx = {
      stop: () => {
        stopped = true;
      },
      update: (dt: number) => {
        t += dt;
        const p = this.pos(unit);
        if (!p) return true;
        if (stopped) off += dt;
        const k = Math.min(1, t / 0.12) * (stopped ? Math.max(0, 1 - off / 0.2) : Math.min(1, Math.max(0, (dur - t) / 0.2)));
        grp.position.set(p.x, 0.07 + this.groundY(p.x, p.z), p.z);
        grp.rotation.y = p.facing;
        mat.opacity = 0.32 * k * (0.9 + 0.1 * Math.sin(t * 30));
        cut -= dt;
        if (cut <= 0 && k > 0.5) {
          // a flash of steel across a different part of the wedge every few frames
          cut = 0.12;
          const a = p.facing + Math.sin(t * 17) * half * 0.8;
          const px = p.x + Math.sin(a) * range * 0.7;
          const pz = p.z + Math.cos(a) * range * 0.7;
          this.slash(p.x, p.z, px, pz, 0xe9eef7, 1.1, CHEST, Math.sin(t * 17) * 0.9);
          this.particle(px, 1.0 + rnd(-0.3, 0.3), pz, { color: 0xfff1d0, s0: 0.2, s1: 0.04, life: 0.3, vx: Math.sin(a) * 2, vz: Math.cos(a) * 2 });
        }
        return stopped ? off >= 0.2 : t >= dur;
      },
      dispose: () => {
        this.scene.remove(grp);
        geo.dispose();
        mat.dispose();
      },
    };
    this.addFx(fx);
    return fx;
  }

  /**
   * A true cone of flame (Dragon's Breath, Dragon Roar): the caster simply sprays fire out in front of him. Pooled fire sprites (the
   * flipbook, or the canvas teardrop) leave the mouth at once and fly out to the spell's real range, spread over the real cone angle
   * (a thin ground outline shows exactly what is hit), with a few embers. `spray` seconds of full fire, then `fade` seconds dying down;
   * `length` and `width` scale the plume and `density` how many flames are drawn (the Animations page of the dev panel, FX_INFO).
   * Follows the caster while it burns. Per frame it spawns about `rate` pooled sprites; the global particle cap bounds the total.
   */
  fireCone(unit: number, range: number, half: number, o: { spray: number; fade: number; length?: number; width?: number; density?: number; color?: number } = { spray: 0.65, fade: 0.25 }) {
    const p0 = this.pos(unit);
    if (!p0) return;
    const density = o.density ?? 1;
    const reach = range * (o.length ?? 1);
    const spread = half * (o.width ?? 1);
    const total = o.spray + o.fade;
    // flames per second: enough to fill the area in front of the caster
    const rate = (70 + 9 * range * (half / (Math.PI / 4))) * density * Math.max(0.3, o.width ?? 1);
    this.sector(p0.x, p0.z, p0.facing, range, half, o.color ?? 0xff5a14, total + 0.1, 0.3, unit);
    this.fireFlash(p0.x + Math.sin(p0.facing) * 0.8, p0.y + 1.7, p0.z + Math.cos(p0.facing) * 0.8, 0.5);
    let t = 0;
    let acc = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        const p = p0; // the cone stays where and how it was cast, like the cone that holds the victims (the caster may walk or turn while it burns)
        const MY = p.y + 1.6;
        // full strength for `spray` seconds (a quick ramp in), then it dies down over `fade`
        const env = Math.min(1, t / 0.05) * (t <= o.spray ? 1 : o.fade > 0 ? Math.max(0, 1 - (t - o.spray) / o.fade) : 0);
        if (t >= total) return true;
        const mx = p.x + Math.sin(p.facing) * 0.5;
        const mz = p.z + Math.cos(p.facing) * 0.5;
        acc += dt * rate * env;
        while (acc >= 1) {
          acc -= 1;
          const a = p.facing + coneSpawnAngle(rnd(-1, 1), spread);
          const life = rnd(0.36, 0.55);
          const near = Math.random() < 0.12; // a few white-hot flames stay by the mouth
          const dist = reach * (near ? rnd(0.08, 0.3) : 0.3 + 0.7 * Math.sqrt(Math.random())); // more flames far out, where the cone is wider
          const sp = dist / life;
          const sx = Math.sin(a);
          const sz = Math.cos(a);
          // the flame grows as it travels, but stays small enough for its edge to stay inside the cone
          const size1 = near ? 1.2 : Math.min(3.4, 1.0 + dist * 0.22);
          const yEnd = Math.max(0.5, MY - 0.6 + rnd(-0.2, 0.5));
          this.particle(mx + sx * 0.3, MY + rnd(-0.1, 0.1), mz + sz * 0.3, {
            fire: true, color: near ? 0xffe8b0 : 0xffd0a0, col1: near ? 0xff9030 : 0xff2a08,
            vx: sx * sp, vz: sz * sp, vy: (yEnd - MY) / life,
            s0: near ? 0.5 : 0.7, s1: size1, life, a: near ? 0.7 : 0.6,
            fps: rnd(16, 30), rot: rnd(-0.5, 0.5), spin: rnd(-0.6, 0.6),
          });
          if (Math.random() < 0.12) {
            // an ember racing out
            const l2 = rnd(0.5, 0.9);
            const d2 = reach * rnd(0.5, 1.0);
            this.particle(mx, MY, mz, { tex: 'spark', color: 0xffc050, col1: 0xff3010, vx: sx * d2 / l2, vz: sz * d2 / l2, vy: rnd(-0.3, 1.2), s0: rnd(0.12, 0.2), s1: 0.04, life: l2, grav: 2.2, drag: 0.3 });
          }
        }
        return false;
      },
      dispose: () => {},
    });
    // scorch marks smoulder on the ground inside the cone while it burns
    for (let i = 0; i < 4; i++) {
      this.later(rnd(0.05, Math.max(0.1, o.spray)), () => {
        const a = p0.facing + coneSpawnAngle(rnd(-1, 1), half);
        const d = range * rnd(0.3, 0.95);
        const p = p0;
        const fx = p.x + Math.sin(a) * d;
        const fz = p.z + Math.cos(a) * d;
        this.fireTongue(fx, this.groundY(fx, fz) + 0.1, fz, rnd(0.8, 1.2));
        this.fireGroundGlow(fx, fz, 1.1, 0, { light: true, life: 0.8 });
      });
    }
  }

  /**
   * Sound waves from the face: `count` pressure shells (open spherical caps, additive, rippled rim) leave the mouth along the caster's
   * facing and grow to `radius` yards, one after the other, with a ripple ring at head height. The caller adds the ground shock ring.
   */
  soundWaves(unit: number, radius: number, color: number, o: { count?: number; gap?: number; life?: number; opacity?: number; half?: number } = {}) {
    const p = this.pos(unit);
    if (!p) return;
    const count = o.count ?? 4;
    const gap = o.gap ?? 0.1;
    const life = o.life ?? 0.55;
    const op = o.opacity ?? 0.7;
    if (!this.capGeo) {
      this.capGeo = new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, 1.05);
      this.capGeo.rotateX(Math.PI / 2); // the pole points forward (+z)
    }
    const MY = 1.7;
    for (let i = 0; i < count; i++) {
      const mat = this.flatMat(color, 0, this.getWaveTex());
      const mesh = new THREE.Mesh(this.capGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      let t = -i * gap;
      const widen = o.half ? o.half / 1.05 : 1;
      this.addFx({
        update: (dt) => {
          t += dt;
          if (t < 0) return false;
          const k = Math.min(1, t / life);
          const e = 1 - (1 - k) ** 2.2;
          const q = this.pos(unit) ?? p;
          mesh.visible = true;
          mesh.position.set(q.x + Math.sin(q.facing) * 0.45, q.y + MY, q.z + Math.cos(q.facing) * 0.45);
          mesh.rotation.y = q.facing;
          const sc = 0.5 + (radius - 0.5) * e;
          mesh.scale.set(sc * widen, sc * widen, sc);
          mat.opacity = op * Math.min(1, k * 7) * (1 - k) ** 1.4 * (1 - i * 0.12);
          return k >= 1;
        },
        dispose: () => {
          this.scene.remove(mesh);
          mat.dispose();
        },
      });
    }
    // the ripple of the same sound at head height, all around
    for (let i = 0; i < 2; i++) this.later(i * gap * 1.5, () => this.ring(p.x, p.z, color, 0.6, radius * 0.9, life * 1.1, MY, op * 0.55));
  }

  /** Ground shock: a ring racing out to `radius`, a second fainter one behind it, and a ring of dust kicked up along it. */
  shockwave(x: number, z: number, radius: number, color = 0xffe2b0, dust = true, life = 0.55) {
    this.ring(x, z, color, 0.5, radius, life, 0.08, 1);
    this.later(0.07, () => this.ring(x, z, 0xffffff, 0.3, radius * 0.8, life * 0.82, 0.09, 0.6));
    if (!dust) return;
    const n = Math.min(22, 8 + Math.round(radius * 1.6));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd(-0.1, 0.1);
      const sp = radius / 0.55;
      this.particle(x + Math.cos(a) * 0.6, this.floorAt(x, z) + 0.2, z + Math.sin(a) * 0.6, {
        tex: 'smoke', color: 0xb8a888, add: false, vx: Math.cos(a) * sp * rnd(0.6, 0.95), vz: Math.sin(a) * sp * rnd(0.6, 0.95), vy: rnd(0.3, 1.2),
        s0: 0.7, s1: 2.0, life: rnd(0.55, 0.85), a: 0.5, drag: 3.2,
      });
    }
  }

  /**
   * A shout, roar or scream: the caster throws its head back (the model plays the lean, see shoutPose.ts), then the waves leave the
   * face at the moment of release, the ground shock runs out to the ability's real radius and dust rises.
   */
  private shout(unit: number, s: Pos, radius: number, color: number, o: { count?: number; dust?: boolean; ring2?: number; opacity?: number } = {}) {
    this.onShout(unit);
    this.later(SHOUT_RELEASE, () => {
      const p = this.pos(unit) ?? s;
      this.soundWaves(unit, radius, color, { count: o.count ?? 4, opacity: o.opacity });
      this.shockwave(p.x, p.z, radius, o.ring2 ?? color, o.dust !== false);
      this.burst(p.x + Math.sin(p.facing) * 0.5, p.y + 1.7, p.z + Math.cos(p.facing) * 0.5, color, 10, 3.5, 0.22, 0.4, 0);
    });
  }

  /**
   * Blades whirling round the caster (Cleave, Bladestorm, Slice and Dice): two bright arcs sweep round at waist height out to `radius`,
   * with sparks off their tips. `turns` over `dur` seconds, or until stop() for a channel.
   */
  private spinBlades(unit: number, radius: number, color: number, dur: number, turns: number): Fx & { stop(): void } {
    const mat = this.flatMat(color, 0.6);
    const mat2 = this.flatMat(0xffffff, 0.35);
    const grp = new THREE.Group();
    const a = new THREE.Mesh(this.slashGeoThin, mat);
    const b = new THREE.Mesh(this.slashGeoThin, mat2);
    for (const m of [a, b]) m.rotation.x = -Math.PI / 2;
    b.rotation.z = Math.PI;
    a.scale.set(radius, radius, 1);
    b.scale.set(radius * 0.92, radius * 0.92, 1);
    grp.add(a, b);
    this.scene.add(grp);
    let t = 0;
    let off = 0;
    let stopped = false;
    const fx = {
      stop: () => {
        stopped = true;
      },
      update: (dt: number) => {
        t += dt;
        const p = this.pos(unit);
        if (!p) return true;
        if (stopped) off += dt;
        const k = Math.min(1, t / 0.12) * (stopped ? Math.max(0, 1 - off / 0.2) : Math.min(1, Math.max(0, (dur - t) / 0.2)));
        grp.position.set(p.x, p.y + 1.05 + Math.sin(t * 9) * 0.08, p.z);
        grp.rotation.y = -t * ((turns * Math.PI * 2) / Math.max(dur, 0.01));
        mat.opacity = 0.6 * k;
        mat2.opacity = 0.35 * k;
        if (k > 0.3 && Math.random() < dt * 40) {
          const ang = rnd(0, Math.PI * 2);
          this.particle(p.x + Math.cos(ang) * radius * 0.9, p.y + 1.0 + rnd(-0.3, 0.3), p.z + Math.sin(ang) * radius * 0.9, { color: 0xfff1d0, s0: 0.2, s1: 0.04, life: 0.3, vx: -Math.sin(ang) * 3, vz: Math.cos(ang) * 3 });
        }
        return stopped ? off >= 0.2 : t >= dur;
      },
      dispose: () => {
        this.scene.remove(grp);
        mat.dispose();
        mat2.dispose();
      },
    };
    this.addFx(fx);
    return fx;
  }

  /** The table-driven result of an instant spell, drawn at (or under) the target. */
  private hitVisual(h: { kind: ImpactKind; style: 'eruption' | 'impact' | 'pillar' | 'swirl' }, p: { x: number; z: number; y?: number }, target: number, k = 1) {
    switch (h.style) {
      case 'eruption':
        this.groundEruption(p.x, p.z, h.kind, k);
        this.impactAt(p, h.kind, 0.55 * k); // and a flare around the body
        break;
      case 'swirl':
        if (target) this.swirlAt(target, h.kind);
        else this.swirlAt(p, h.kind);
        this.impactAt(p, h.kind, 0.6 * k);
        break;
      case 'pillar':
        this.column(p.x, p.z, ERUPT[h.kind].col, 0.5 * k, 0.7 * k, 7);
        this.impactAt(p, h.kind, 0.7 * k);
        break;
      default:
        this.impactAt(p, h.kind, k);
    }
  }

  // ------------------------------------------------------------ aura layers (DoTs, bleeds, burns, frost, shields)

  /** Pulse the visual of one aura on a unit (damage or heal tick). */
  private layerFlare(unit: number, aura: string) {
    const l = this.layers.get(`${unit}:${aura}`);
    if (l) l.flare = 1;
  }

  /** A damage-over-time tick: flare the aura layer and add a small accent on the body. */
  private auraTick(tgt: number, aura: string, _amount: number) {
    this.layerFlare(tgt, aura);
    const p = this.pos(tgt);
    const v = AURA_VISUAL[aura];
    if (!p || !v) return;
    const s = v.strength;
    switch (v.style) {
      case 'shadow':
        for (let i = 0; i < 4; i++) {
          const a = Math.random() * Math.PI * 2;
          this.particle(p.x + Math.cos(a) * 0.9, p.y + rnd(0.6, 1.8), p.z + Math.sin(a) * 0.9, { tex: 'glow', color: 0x8a3dff, vx: -Math.cos(a) * 3, vz: -Math.sin(a) * 3, s0: 0.4, s1: 0.1, life: 0.3 });
        }
        this.particle(p.x, p.y + CHEST, p.z, { tex: 'glow', color: 0x7a2fd8, s0: 0.5, s1: 2.2, life: 0.35, a: 0.8 });
        break;
      case 'bleed':
        for (let i = 0; i < 6; i++) this.particle(p.x + rnd(-0.25, 0.25), p.y + rnd(0.8, 1.6), p.z + rnd(-0.25, 0.25), { color: 0xb8101c, add: false, vx: rnd(-1, 1), vz: rnd(-1, 1), vy: rnd(0.5, 2), s0: 0.24, s1: 0.14, life: 0.6, grav: 9 });
        this.ring(p.x, p.z, 0xc01820, 0.3, 1.3, 0.35, 0.06, 0.7 * s);
        break;
      case 'burn':
        // a tick flares the field on the body (see the burn layer); a few tongues and embers fly off it
        for (let i = 0; i < 2; i++) this.fireTongue(p.x + rnd(-0.3, 0.3), p.y + 0.7 + rnd(0, 0.8), p.z + rnd(-0.3, 0.3), 0.55);
        this.emberShower(p.x, p.y + 0.8, p.z, 0.35, 5, { rise: 1.2 });
        break;
      default:
        break;
    }
  }

  /** The small accent when a lasting aura lands. */
  private auraStart(p: Pos, style: AuraStyle) {
    switch (style) {
      case 'shadow':
        this.ring(p.x, p.z, 0x7a2fd8, 0.4, 2.0, 0.5);
        this.puff(p.x, p.y + 1.0, p.z, 0x2a1040, 3, 1.1);
        break;
      case 'bleed':
        this.burst(p.x, p.y + CHEST, p.z, 0xc01820, 8, 3, 0.2, 0.5, 8);
        this.ring(p.x, p.z, 0xc01820, 0.3, 1.5, 0.4, 0.06, 0.8);
        break;
      case 'burn':
        this.fireFlash(p.x, p.y + 1.1, p.z, 0.35);
        for (let i = 0; i < 4; i++) this.fireTongue(p.x + rnd(-0.3, 0.3), p.y + 0.5 + rnd(0, 0.9), p.z + rnd(-0.3, 0.3), 0.7);
        this.smokeWisps(p.x, p.y + 1.6, p.z, 2, 0.7, { spread: 0.3 });
        break;
      case 'frost':
        this.ring(p.x, p.z, 0x9fe0ff, 0.3, 1.8, 0.45);
        break;
      default:
        break;
    }
  }

  private makeLayer(aura: string, vis: AuraVisual): Layer {
    const group = new THREE.Group();
    this.scene.add(group);
    const sprites: THREE.Sprite[] = [];
    const mats: THREE.Material[] = [];
    const sp = (tex: TexName, color: number, size: number, additive = true) => {
      const s = this.sprite(tex, color, additive);
      this.scene.remove(s);
      group.add(s);
      s.scale.set(size, size, 1);
      sprites.push(s);
      return s;
    };
    const flat = (color: number, op: number, geo: THREE.BufferGeometry, r: number, tex?: THREE.Texture, y = 0.06) => {
      const m = this.flatMat(color, op, tex);
      mats.push(m);
      return { mesh: this.flat(group, geo, m, y, r), mat: m, op };
    };
    const opac = (s: THREE.Sprite, a: number) => ((s.material as THREE.SpriteMaterial).opacity = Math.max(0, Math.min(1, a)));
    const S = vis.strength;
    let acc = 0;
    // the body's centre in the world, for particles
    const wx = (l: Layer, dx = 0) => l.x + dx * l.sc;
    let upd: (l: Layer, dt: number, a: number, t: number) => void;
    let fire: FireField | null = null;

    switch (vis.style) {
      case 'shadow': {
        const wisps = [0, 1, 2, 3].map(() => sp('glow', 0x9a4dff, 0.6));
        const smokes = [0, 1, 2].map(() => sp('smoke', 0x2a0f45, 1.0, false));
        const rune = flat(0x9ab04a, 0.4, this.discGeo, 1.05, this.getRuneTex());
        const ring = flat(0x7a3fc0, 0.35, this.ringGeo, 0.8);
        const all = [...wisps, ...smokes];
        upd = (l, dt, a, t) => {
          all.forEach((s, i) => {
            const ang = t * (1.4 + i * 0.12) * (i % 2 ? -1 : 1) + (i / all.length) * Math.PI * 2;
            const r = 0.55 + 0.15 * Math.sin(t * 1.7 + i);
            const h = 1.0 + 0.85 * Math.sin(t * 0.9 + i * 1.7);
            s.position.set(Math.cos(ang) * r, h, Math.sin(ang) * r);
            const big = 1 + l.flare * 0.8;
            const base = i < wisps.length ? 0.6 : 1.0;
            s.scale.set(base * big, base * big, 1);
            opac(s, a * (i < wisps.length ? 0.9 : 0.55) * S + l.flare * 0.3);
          });
          rune.mesh.rotation.z = t * 0.6;
          rune.mat.opacity = rune.op * a * S * (1 + l.flare * 0.8);
          ring.mat.opacity = ring.op * a * S;
          ring.mesh.scale.set(0.8 + 0.1 * Math.sin(t * 3), 0.8 + 0.1 * Math.sin(t * 3), 1);
          acc += dt * 7 * S * a;
          while (acc > 1) {
            acc -= 1;
            const ang = Math.random() * Math.PI * 2;
            this.particle(wx(l, Math.cos(ang) * 0.6), l.y + 0.2, l.z + Math.sin(ang) * 0.6 * l.sc, { tex: 'glow', color: 0xb06bff, vy: rnd(0.6, 1.2), s0: 0.22 * l.sc, s1: 0.05, life: 1.0, a: 0.8 });
          }
        };
        break;
      }
      case 'bleed': {
        const spots: [number, number, number][] = [[0.16, 1.5, 0.2], [-0.2, 1.1, 0.24], [0.12, 0.7, -0.2]];
        const wounds = spots.map(() => sp('glow', 0x9a0f1a, 0.5));
        const pool = flat(0x5a0a10, 0.55, this.discGeo, 0.5, undefined, 0.035);
        pool.mat.blending = THREE.NormalBlending;
        upd = (l, dt, a, t) => {
          wounds.forEach((w, i) => {
            w.position.set(spots[i][0], spots[i][1], spots[i][2]);
            const f = 0.28 + 0.1 * Math.sin(t * 5 + i * 2) + l.flare * 0.3;
            w.scale.set(f * 1.4, f * 1.4, 1);
            opac(w, a * S * (0.55 + l.flare * 0.35));
          });
          const pr = 0.4 + Math.min(0.5, l.age * 0.12) + 0.04 * Math.sin(t * 2);
          pool.mesh.scale.set(pr, pr, 1);
          pool.mat.opacity = pool.op * a * S;
          acc += dt * 8 * S * a;
          while (acc > 1) {
            acc -= 1;
            const sIdx = (Math.random() * 3) | 0;
            this.particle(wx(l, spots[sIdx][0]), l.y + spots[sIdx][1] * l.sc, l.z + spots[sIdx][2] * l.sc, { color: 0xb8101c, add: false, s0: 0.22 * l.sc, s1: 0.14 * l.sc, life: 0.8, grav: 9, a: 1 });
          }
        };
        break;
      }
      case 'burn': {
        // the shared flame field (fireFx.ts) licking up the body: small tongues round a glowing middle, flaring on every tick, with
        // embers and smoke rising off it; about 25 pooled sprites per burning unit
        const field = new FireField(this.getRigHost(), fireFieldShape('body', 0.42), 0);
        fire = field;
        const pl = newFirePlace();
        upd = (l, dt, a, t) => {
          pl.x = l.x;
          pl.z = l.z;
          pl.y = l.y;
          pl.t = t;
          pl.build = a;
          pl.fade = Math.min(1, a * 1.5) * (0.75 + 0.25 * S);
          pl.flare = l.flare;
          pl.sc = l.sc;
          field.place(pl, this.camera);
          acc += dt * 7 * S * a;
          while (acc > 1) {
            acc -= 1;
            const ang = Math.random() * Math.PI * 2;
            const r = rnd(0.1, 0.4) * l.sc;
            const hy = rnd(0.3, 1.5) * l.sc;
            const gx = l.x + Math.cos(ang) * r;
            const gz = l.z + Math.sin(ang) * r;
            if (Math.random() < 0.5) this.fireTongue(gx, pl.y + hy, gz, 0.5 * l.sc, 0xff5a14, { vy: rnd(0.9, 1.6) * l.sc });
            else this.emberShower(gx, pl.y + hy, gz, 0.1, 1, { rise: 0.9 });
            if (Math.random() < 0.18) this.smokeWisps(gx, pl.y + 1.7 * l.sc, gz, 1, 0.55 * l.sc, { spread: 0.1 });
          }
        };
        break;
      }
      case 'frost': {
        const n = S >= 1.2 ? 9 : S >= 0.7 ? 7 : 5;
        const mat = new THREE.MeshBasicMaterial({ color: 0x5ab4f0, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
        mats.push(mat);
        const shards: { m: THREE.Mesh; h: number }[] = [];
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + rnd(-0.15, 0.15);
          const m = new THREE.Mesh(this.iceGeo, mat);
          const h = rnd(0.5, 0.9) * (0.8 + 0.3 * S);
          m.position.set(Math.cos(a) * 0.55, h / 2, Math.sin(a) * 0.55);
          m.rotation.set(Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4);
          m.scale.set(1.5, h, 1.5);
          group.add(m);
          shards.push({ m, h });
        }
        const stars = [sp('star', 0xe6f8ff, 0.3), sp('star', 0xcdf1ff, 0.26), sp('star', 0xe6f8ff, 0.3)];
        const disc = flat(0xcdf1ff, 0.2, this.discGeo, 0.85, undefined, 0.04);
        upd = (l, dt, a, t) => {
          const grow = Math.min(1, l.age / 0.25);
          for (const q of shards) {
            const hh = q.h * grow * (0.4 + 0.6 * a);
            q.m.scale.set(1.5, Math.max(0.001, hh), 1.5);
            q.m.position.y = hh / 2;
          }
          mat.opacity = 0.55 * a + 0.12 * Math.sin(t * 4) * a;
          stars.forEach((s, i) => {
            const ang = t * 0.9 + (i / 3) * Math.PI * 2;
            s.position.set(Math.cos(ang) * 0.7, 0.55 + 0.1 * Math.sin(t * 2 + i), Math.sin(ang) * 0.7);
            opac(s, a * 0.9);
          });
          disc.mat.opacity = disc.op * a;
          acc += dt * 3 * a;
          while (acc > 1) {
            acc -= 1;
            const ang = Math.random() * Math.PI * 2;
            this.particle(l.x + Math.cos(ang) * 0.6 * l.sc, l.y + 0.15, l.z + Math.sin(ang) * 0.6 * l.sc, { tex: 'smoke', color: 0xbfe8ff, add: false, s0: 0.35 * l.sc, s1: 0.9 * l.sc, life: 0.9, a: 0.35, vy: 0.35, vx: rnd(-0.2, 0.2) });
          }
        };
        break;
      }
      case 'holy': {
        const N = 6;
        const motes = Array.from({ length: N }, (_, i) => sp(i % 3 === 2 ? 'plus' : 'glow', i % 3 === 2 ? 0xfff1a8 : 0xffe07a, i % 3 === 2 ? 0.3 : 0.4));
        const ring = flat(0xffe98a, 0.3, this.ringGeo, 0.8);
        let bubble: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial } | null = null;
        if (vis.bubble) {
          const bm = new THREE.MeshBasicMaterial({ color: 0xffe98a, transparent: true, opacity: vis.bubble, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
          mats.push(bm);
          const mesh = new THREE.Mesh(this.sphereGeo, bm);
          mesh.scale.set(1.0, 1.4, 1.0);
          mesh.position.y = 1.0;
          group.add(mesh);
          bubble = { mesh, mat: bm };
        }
        upd = (l, _dt, a, t) => {
          motes.forEach((s, i) => {
            const f = (t * 0.55 + i / N) % 1;
            const ang = t * 2.4 + (i / N) * Math.PI * 2;
            const r = 0.62 + 0.08 * Math.sin(t * 3 + i);
            s.position.set(Math.cos(ang) * r, 0.1 + f * 2.0, Math.sin(ang) * r);
            const g = 1 + l.flare * 0.7;
            const base = i % 3 === 2 ? 0.3 : 0.4;
            s.scale.set(base * g, base * g, 1);
            opac(s, a * Math.sin(Math.PI * f) * (0.9 + l.flare * 0.4));
          });
          ring.mat.opacity = ring.op * a * (0.7 + 0.3 * Math.sin(t * 3) + l.flare);
          const rs = 0.8 + l.flare * 0.2;
          ring.mesh.scale.set(rs, rs, 1);
          if (bubble) {
            bubble.mat.opacity = (vis.bubble ?? 0.15) * a * (0.8 + 0.2 * Math.sin(t * 3) + l.flare * 0.8);
            bubble.mesh.rotation.y = t * 0.5;
          }
        };
        break;
      }
      default: {
        // poison: green bubbles rising off the body
        const bubbles = [0, 1, 2, 3].map(() => sp('glow', 0x7dff4a, 0.3));
        upd = (l, dt, a, t) => {
          bubbles.forEach((b, i) => {
            const f = (t * 0.5 + i / 4) % 1;
            b.position.set(Math.cos(t * 2 + i * 1.6) * 0.4, 0.3 + f * 1.8, Math.sin(t * 2 + i * 1.6) * 0.4);
            opac(b, a * Math.sin(Math.PI * f));
          });
          acc += dt * 4 * a;
          while (acc > 1) {
            acc -= 1;
            this.particle(l.x + rnd(-0.3, 0.3) * l.sc, l.y + rnd(0.4, 1.6) * l.sc, l.z + rnd(-0.3, 0.3) * l.sc, { tex: 'smoke', color: 0x5aa83a, add: false, vy: 0.6, s0: 0.2, s1: 0.5, life: 0.8, a: 0.4 });
          }
        };
      }
    }
    const layer: Layer = {
      group, x: 0, y: 0, z: 0, sc: 1, age: 0, flare: 0,
      update: (dt, a, t) => {
        layer.flare = Math.max(0, layer.flare - dt * 3.5);
        group.position.set(layer.x, layer.y, layer.z);
        group.scale.setScalar(layer.sc);
        upd(layer, dt, a, t);
      },
      dispose: () => {
        this.scene.remove(group);
        for (const s of sprites) {
          s.visible = false;
          this.pool.push(s);
        }
        for (const m of mats) m.dispose();
        fire?.dispose();
      },
    };
    void aura;
    return layer;
  }

  // ------------------------------------------------------------ casting

  /** Radius of the Heroic Leap landing (from the ability data). */
  private leapRadius(): number {
    const e = ABILITIES.heroic_leap?.effects.find((x) => x.type === 'leap');
    return e && e.type === 'leap' ? e.radius ?? 5 : 5;
  }

  private startCast(unit: number, ability: string) {
    this.stopCast(unit);
    const def = ABILITIES[ability];
    if (!def) return;
    const color = SCHOOL_COLOR[def.school];
    const fbLook = fireballLookFor(ability);
    if (fbLook) {
      // Pyroblast: a fireball grows in the caster's hand until it is thrown
      const fx = this.fireballWindup(unit, def, fbLook);
      this.casting.set(unit, fx);
      this.addFx(fx);
      return;
    }
    if (ability === 'slice_and_dice') {
      // a flurry of cuts across the cone in front of the warrior, drawn on the real wedge, until the channel ends
      const cone = coneShape(def);
      this.casting.set(unit, this.sliceCone(unit, cone?.range ?? 5, cone?.half ?? Math.PI / 4, (def.castTime || 4000) / 1000));
      return;
    }
    if (ability === 'bladestorm') {
      // a warrior whirling steel, not a caster gathering a spell: blades spin round him until the channel ends
      const dur = (def.castTime || 4000) / 1000;
      this.casting.set(unit, this.spinBlades(unit, def.radius ?? 6, 0xdfe6f2, dur, dur * fxNum('bladestorm', 'spinPerSec')));
      return;
    }
    const orb = this.sprite('glow', color);
    const core = this.sprite('spark', 0xffffff);
    const rune = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const mat2 = mat.clone();
    const a = new THREE.Mesh(new THREE.RingGeometry(0.95, 1, 48, 1, 0, Math.PI * 1.5), mat);
    const b = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.68, 48, 1, 0.5, Math.PI * 1.2), mat2);
    const c = new THREE.Mesh(this.ringGeo, mat2);
    c.scale.set(0.4, 0.4, 1);
    for (const m of [a, b, c]) m.rotation.x = -Math.PI / 2;
    rune.add(a, b, c);
    this.scene.add(rune);
    let t = 0;
    let acc = 0;
    const fx = {
      stop: () => {
        t = 1e9;
      },
      update: (dt: number) => {
        t += dt;
        const p = this.pos(unit);
        if (!p || t > 8) return true;
        const hx = p.x + Math.sin(p.facing) * 0.55;
        const hz = p.z + Math.cos(p.facing) * 0.55;
        const grow = Math.min(1, t / 0.6);
        orb.position.set(hx, p.y + 1.55, hz);
        core.position.set(hx, p.y + 1.55, hz);
        const pulse = 1 + Math.sin(t * 22) * 0.15;
        orb.scale.set((0.5 + grow * 0.9) * pulse, (0.5 + grow * 0.9) * pulse, 1);
        core.scale.set(0.25 + grow * 0.4, 0.25 + grow * 0.4, 1);
        rune.position.set(p.x, p.y + 0.06, p.z);
        a.rotation.z = t * 1.8;
        b.rotation.z = -t * 2.6;
        rune.scale.setScalar(0.9 + Math.sin(t * 5) * 0.04);
        acc += dt;
        while (acc > 0.05) {
          acc -= 0.05;
          const ang = Math.random() * Math.PI * 2;
          const r = rnd(1.2, 1.8);
          this.particle(p.x + Math.cos(ang) * r, p.y + rnd(0.2, 1.6), p.z + Math.sin(ang) * r, {
            color, s0: 0.22, life: 0.42,
            vx: (hx - (p.x + Math.cos(ang) * r)) * 2.4, vy: (1.5 - 0.9) * 1.5, vz: (hz - (p.z + Math.sin(ang) * r)) * 2.4,
          });
        }
        return false;
      },
      dispose: () => {
        for (const sp of [orb, core]) {
          this.scene.remove(sp);
          sp.visible = false;
          this.pool.push(sp);
        }
        this.scene.remove(rune);
        for (const m of [a, b, c]) m.geometry === this.ringGeo || m.geometry.dispose();
        mat.dispose();
        mat2.dispose();
      },
    };
    this.casting.set(unit, fx);
    this.addFx(fx);
  }

  private stopCast(unit: number) {
    const c = this.casting.get(unit);
    if (c) {
      c.stop();
      this.casting.delete(unit);
    }
  }

  // ------------------------------------------------------------ events

  event(ev: SimEvent) {
    switch (ev.t) {
      case 'cast_start':
        this.startCast(ev.unit, ev.ability);
        break;
      case 'cast':
        if (!ABILITIES[ev.ability]?.channel) this.stopCast(ev.unit);
        this.lastCast.set(`${ev.unit}:${ev.ability}`, this.clock);
        this.onCast(ev.unit, ev.ability, ev.target);
        break;
      case 'channel_end':
        this.stopCast(ev.unit);
        break;
      case 'leap':
        this.column(ev.fromX, ev.fromZ, 0xc9b99a, 0.5, 0.6, 3);
        break;
      case 'leap_land':
        this.column(ev.x, ev.z, 0xffd34a, 0.7, 1, 5);
        this.shockwave(ev.x, ev.z, this.leapRadius(), 0xffd34a, true, fxSec('heroicLeap', 'landingRingMs'));
        break;
      case 'cast_fail':
        this.stopCast(ev.unit);
        break;
      case 'interrupt': {
        this.stopCast(ev.tgt);
        const p = this.pos(ev.tgt);
        if (p) {
          const c = SCHOOL_COLOR[ev.school] ?? 0xffffff;
          this.burst(p.x, p.y + HEAD, p.z, 0xff5a4d, 14, 4, 0.3, 0.5, 0);
          const s = this.sprite('star', 0xff4d3d);
          s.position.set(p.x, p.y + HEAD + 0.2, p.z);
          s.scale.set(0.2, 0.2, 1);
          let t = 0;
          this.addFx({
            update: (dt) => {
              t += dt;
              const k = Math.min(1, t / 0.55);
              const sc = 0.3 + Math.sin(Math.min(1, k * 1.6) * Math.PI * 0.5) * 1.8;
              s.scale.set(sc, sc, 1);
              (s.material as THREE.SpriteMaterial).opacity = 1 - k * k;
              (s.material as THREE.SpriteMaterial).rotation = k * 1.2;
              return k >= 1;
            },
            dispose: () => {
              this.scene.remove(s);
              s.visible = false;
              this.pool.push(s);
            },
          });
          this.ring(p.x, p.z, c, 0.3, 2.2, 0.4, 0.08);
        }
        break;
      }
      case 'damage': {
        const p = this.pos(ev.tgt);
        if (!p) break;
        this.onHit(ev.tgt);
        if (ev.ability === 'lava') {
          // standing in a lava pit: flames lick up the body and embers fly, every burn tick
          this.fireFlash(p.x, p.y + 0.4, p.z, 0.7, 0.3);
          this.emberShower(p.x, p.y + 0.2, p.z, 0.8, 6, { heat: 0.3, rise: 1.4 });
          break;
        }
        {
          // a tick of a damage-over-time aura flares the aura on the target instead of replaying the spell's hit
          const tickAura = ev.ability ? isDotTick(ev.ability, this.unitAuras.get(ev.tgt) ?? [], this.clock - (this.lastCast.get(`${ev.src}:${ev.ability}`) ?? -99)) : null;
          if (tickAura) {
            this.auraTick(ev.tgt, tickAura, ev.amount);
            break;
          }
        }
        if (ev.ability === 'slice_and_dice') {
          // a flurry: a short swing of the warrior's on every tick and a slash across the held target from a new angle each time
          const a = this.pos(ev.src);
          this.onSwing(ev.src, true);
          if (a) {
            const ang = (this.clock * 9 + ev.tgt) % (Math.PI * 2);
            this.slash(p.x - Math.sin(ang) * 1.1, p.z - Math.cos(ang) * 1.1, p.x + Math.sin(ang) * 1.1, p.z + Math.cos(ang) * 1.1, 0xe9eef7, 0.6, p.y - this.groundY(p.x, p.z) + CHEST + Math.sin(ang * 2) * 0.4);
          }
        } else if (ev.ability === null && ev.src !== 0) {
          // auto-attack: swing the attacker's weapon and draw a quick steel slash so every swing is visible
          const a = this.pos(ev.src);
          if (a) {
            this.onSwing(ev.src);
            this.slash(a.x, a.z, p.x, p.z, 0xe9eef7, 0.95, CHEST);
            this.later(0.05, () => this.ring(p.x, p.z, 0xffffff, 0.18, 1.2, 0.18));
          }
        }
        if (ev.ability === 'reel_in') this.chain(ev.src, ev.tgt);
        const color = SCHOOL_COLOR[ev.school] ?? 0xffffff;
        const key = ev.ability ? `${ev.src}:${ev.ability}` : '';
        const delay = key ? this.flights.get(key) ?? 0 : 0;
        if (key) this.flights.delete(key);
        const big = Math.min(1.6, 0.6 + ev.amount / 600);
        const absorbed = ev.absorbed > 0 && ev.amount === 0;
        const adef = ev.ability ? ABILITIES[ev.ability] : undefined;
        const vcls = adef ? visualFor(adef).cls : null;
        const quiet = vcls === 'onTarget' || vcls === 'aura'; // the cast already drew the impact at the target
        this.later(delay, () => {
          const q = this.pos(ev.tgt) ?? p;
          if (absorbed) {
            this.burst(q.x, q.y + CHEST, q.z, 0xfff1a8, 10, 3, 0.25, 0.4, 0);
            return;
          }
          if (quiet) {
            this.burst(q.x, q.y + CHEST, q.z, color, 4, 3, 0.25, 0.4);
            return;
          }
          const sl = skillLook(ev.ability);
          if (sl.hitKind !== 'default' || sl.hitStyle !== 'default' || sl.hitSize !== 1) {
            // the Animations page picked another impact for this skill
            const hk = (sl.hitKind !== 'default' ? sl.hitKind : impactKindFor(ev.school)) as ImpactKind;
            this.hitVisual({ kind: hk, style: (sl.hitStyle !== 'default' ? sl.hitStyle : 'impact') as 'eruption' | 'impact' | 'pillar' | 'swirl' }, q, ev.tgt, sl.hitSize);
            return;
          }
          const fl = fireballLookFor(ev.ability);
          if (fl) {
            this.fireballImpact(q.x, q.y + CHEST, q.z, fl, big);
            return;
          }
          this.burst(q.x, q.y + CHEST, q.z, color, Math.round(8 * big), 4 * big, 0.3, 0.5);
          if (ev.school === 'fire') for (let i = 0, n = 2 + Math.round(big * 2); i < n; i++) this.flame(q.x + rnd(-0.4, 0.4), q.y + CHEST - 0.5 + rnd(0, 0.6), q.z + rnd(-0.4, 0.4), big * rnd(0.9, 1.4));
          if (ev.ability === 'frostbolt') {
            this.ring(q.x, q.z, 0x7fd8ff, 0.3, 2.0, 0.4);
            this.burst(q.x, q.y + CHEST, q.z, 0xe6f8ff, 12, 4.5, 0.3, 0.6, 4);
          } else if (ev.ability === 'smite') {
            this.column(q.x, q.z, 0xfff1a8, 0.55, 0.7, 7);
            this.ring(q.x, q.z, 0xffe98a, 0.3, 2.2, 0.4);
          } else if (ev.ability === 'frost_nova') {
            this.burst(q.x, q.y + 0.5, q.z, 0xcdf1ff, 8, 3, 0.3, 0.5, 4);
          }
        });
        break;
      }
      case 'heal': {
        const p = this.pos(ev.tgt);
        if (!p || ev.amount <= 0) break;
        for (let i = 0; i < 6; i++) {
          this.particle(p.x + rnd(-0.5, 0.5), p.y + rnd(0.2, 1.0), p.z + rnd(-0.5, 0.5), {
            tex: 'plus', color: Math.random() < 0.5 ? 0x7dff9a : 0xfff1a8, vy: rnd(1.2, 2.4), s0: rnd(0.3, 0.5), s1: 0.1, life: rnd(0.8, 1.2), drag: 0.5,
          });
        }
        this.ring(p.x, p.z, 0x7dff9a, 0.4, 1.6, 0.55);
        if (this.hotIds.has(ev.ability)) this.layerFlare(ev.tgt, ev.ability);
        break;
      }
      case 'aura': {
        const p = this.pos(ev.tgt);
        if (!p) break;
        switch (ev.aura) {
          case 'polymorph':
            this.puff(p.x, p.y + 1.1, p.z, 0xf3ecff, 10, 1.6);
            this.burst(p.x, p.y + 1.2, p.z, 0xc58bff, 16, 4, 0.35, 0.7, 0);
            break;
          case 'frost_nova_root':
            this.burst(p.x, p.y + 0.3, p.z, 0xcdf1ff, 10, 3, 0.3, 0.5, 5);
            break;
          case 'psychic_scream':
            this.burst(p.x, p.y + HEAD, p.z, 0x9a4dff, 12, 3, 0.35, 0.7, 0);
            break;
          case 'cheap_shot_stun':
          case 'kidney_shot':
            this.burst(p.x, p.y + HEAD, p.z, 0xfff1a8, 10, 3, 0.3, 0.5, 0);
            break;
          case 'pw_shield':
            this.burst(p.x, p.y + 1.0, p.z, 0xfff1a8, 14, 3, 0.3, 0.6, 0);
            this.ring(p.x, p.z, 0xffe98a, 0.4, 1.8, 0.5);
            break;
          default: {
            const v = AURA_VISUAL[ev.aura];
            if (v && v.style !== 'holy') this.auraStart(p, v.style);
          }
        }
        break;
      }
      case 'aura_removed': {
        const p = this.pos(ev.tgt);
        if (!p) break;
        if (ev.aura === 'polymorph') this.puff(p.x, p.y + 1.1, p.z, 0xf3ecff, 8, 1.4);
        else if (ev.aura === 'pw_shield' && ev.reason !== 'expired') this.burst(p.x, p.y + 1.0, p.z, 0xfff1a8, 18, 5, 0.35, 0.6, 0);
        else if (ev.aura === 'stealth') this.puff(p.x, p.y + 1.0, p.z, 0x2b2b33, 7, 1.2);
        break;
      }
      case 'dispel': {
        const p = this.pos(ev.tgt);
        if (!p) break;
        for (let i = 0; i < 12; i++) {
          this.particle(p.x + rnd(-0.5, 0.5), p.y + rnd(0.2, 1.6), p.z + rnd(-0.5, 0.5), { tex: 'star', color: 0xfff1a8, vy: rnd(0.5, 2), s0: 0.35, life: 0.8, drag: 0.5 });
        }
        this.ring(p.x, p.z, 0xffe98a, 0.4, 1.8, 0.5);
        break;
      }
      case 'death': {
        this.stopCast(ev.unit);
        const p = this.pos(ev.unit);
        if (!p) break;
        this.puff(p.x, p.y + 0.6, p.z, 0x8a8f9a, 10, 1.6);
        for (let i = 0; i < 10; i++) {
          this.particle(p.x + rnd(-0.3, 0.3), p.y + rnd(0.5, 1.3), p.z + rnd(-0.3, 0.3), { color: 0xcfe8ff, vy: rnd(1, 2.5), s0: rnd(0.25, 0.45), life: rnd(1, 1.6), drag: 0.4 });
        }
        this.ring(p.x, p.z, 0xcfe8ff, 0.4, 2.6, 0.9);
        break;
      }
      default:
        break;
    }
  }

  /**
   * The expanding ring every cast used to leave, dressed: a glyph circle under it that turns, a sunburst for the bigger ones and, by
   * the colour (warm, cold, dark, bright), motes winding up or an inward vortex. Same arguments as `ring`.
   */
  private styledRing(x: number, z: number, color: number, from: number, to: number, life: number, y = 0.07, opacity = 0.9) {
    this.ring(x, z, color, from, to, life, y, opacity);
    if (to < 1.3) return;
    _c.set(color);
    const hsl = { h: 0, s: 0, l: 0 };
    _c.getHSL(hsl);
    this.runeCircle(x, z, color, to * 0.85, Math.max(0.6, life * 1.7), hsl.h > 0.5 && hsl.h < 0.8 ? -1.3 : 1.2, y + 0.02);
    if (to >= 2.4) this.sunburst(x, 0.1, z, color, to * 0.75, Math.max(0.35, life * 0.9));
    const gy = this.floorAt(x, z);
    if (hsl.l > 0.7 || (hsl.h > 0.1 && hsl.h < 0.2)) this.helix(x, gy, z, color, 2.2 + to * 0.15, Math.min(1.1, to * 0.3), 2, 0.8, 22, false, 'star'); // bright and golden: light winding up
    else if (hsl.h > 0.65 && hsl.h < 0.85) this.vortex(x, gy + 0.1, z, color, to * 0.9, true, 20, 0.6); // purples: drawn in
    else if (hsl.h > 0.45 && hsl.h <= 0.65) this.spikes(x, z, color, to * 0.7, 8); // cold: crystals
  }

  /** The Animations page's numbers for the skill being played right now (size, amount and lasting time of its sparks): 1 each otherwise. */
  private skillK = { size: 1, amount: 1, life: 1 };

  private onCast(unit: number, ability: string, target: number) {
    this.skillK = { size: fxNum(`skill_${ability}`, 'size') || 1, amount: fxNum(`skill_${ability}`, 'amount'), life: fxNum(`skill_${ability}`, 'length') || 1 };
    if (!(`skill_${ability}` in FX_GROUPS)) this.skillK = { size: 1, amount: 1, life: 1 };
    try {
      this.playCast(unit, ability, target);
    } finally {
      this.skillK = { size: 1, amount: 1, life: 1 };
    }
  }

  private playCast(unit: number, ability: string, target: number) {
    const def = ABILITIES[ability];
    const s = this.pos(unit);
    if (!def || !s) return;
    const t = target && target !== unit ? this.pos(target) : null;
    const color = SCHOOL_COLOR[def.school];
    const melee = (c: number, scale: number, y = CHEST) => {
      if (!t) return;
      this.onSwing(unit);
      this.slash(s.x, s.z, t.x, t.z, c, scale, y);
      this.burst(t.x, t.y + y, t.z, c, 6, 3.5, 0.25, 0.35);
    };

    switch (ability) {
      case 'slam':
        melee(0xffaa40, 1.7);
        if (t) this.styledRing(t.x, t.z, 0xffaa40, 0.3, 2.2, 0.3);
        break;
      case 'sweep': {
        // a 90 degree slice of the blade across the real arc in front of the warrior: three cuts fan across the wedge
        const cone = coneShape(def);
        const r = cone?.range ?? 5;
        const half = cone?.half ?? Math.PI / 4;
        this.onSwing(unit);
        this.sector(s.x, s.z, s.facing, r, half, 0xffaa40, 0.35, 0.5, unit);
        [-0.6, 0, 0.6].forEach((k, i) => {
          const a = s.facing + k * half;
          const px = s.x + Math.sin(a) * r * 0.7;
          const pz = s.z + Math.cos(a) * r * 0.7;
          this.later(i * 0.05, () => {
            this.slash(s.x, s.z, px, pz, 0xffaa40, 1.5, s.y - this.groundY(px, pz) + CHEST, k * 0.9);
            this.burst(px, s.y + CHEST, pz, 0xffaa40, 5, 3.5, 0.25, 0.35);
          });
        });
        break;
      }
      case 'bloodthirst': {
        // a red turn of the blade round the warrior, out to the real reach
        this.onSwing(unit);
        this.later(0.1, () => this.onSwing(unit, true));
        this.spinBlades(unit, (def.radius ?? 3) + 1, 0xd02a3a, 0.4, 1.1);
        this.styledRing(s.x, s.z, 0xd02a3a, 0.4, (def.radius ?? 3) + 1, 0.4, 0.08, 0.7);
        break;
      }
      case 'deep_cuts':
        melee(0xc0202a, 1.2);
        break;
      case 'axe_throw':
        if (t) {
          this.onSwing(unit);
          this.flights.set(`${unit}:axe_throw`, AXE_FLIGHT);
          this.axeThrow(unit, target);
        }
        break;
      case 'reel_in': {
        // a hook thrown out along the cone: steel sector, and dust and sparks streaming back towards the caster
        const cone = coneShape(def);
        const r = cone?.range ?? 10;
        const half = cone?.half ?? Math.PI / 4;
        this.onSwing(unit);
        this.sector(s.x, s.z, s.facing, r, half, 0xaab4c8, 0.6, 0.5, unit);
        for (let i = 0; i < 44; i++) {
          const a = s.facing + coneSpawnAngle(rnd(-1, 1), half);
          const d = r * rnd(0.4, 1);
          const life = rnd(0.35, 0.55);
          this.particle(s.x + Math.sin(a) * d, s.y + rnd(0.3, 1.4), s.z + Math.cos(a) * d, { tex: 'star', color: i % 3 ? 0xdfe6f2 : 0xaab4c8, s0: 0.6, s1: 0.08, life, vx: -Math.sin(a) * d / life * 0.9, vz: -Math.cos(a) * d / life * 0.9, drag: 0 });
        }
        break;
      }
      case 'slice_and_dice':
        this.onSwing(unit); // the cone itself is drawn by the channel
        break;
      case 'bladestorm':
        this.onSwing(unit);
        this.styledRing(s.x, s.z, 0xdfe6f2, 0.3, def.radius ?? 6, 0.3, 0.08, 0.9);
        break;
      case 'whirlwind': {
        // Cleave: a full turn of the blade round the warrior, out to the real radius
        this.onSwing(unit);
        this.later(0.12, () => this.onSwing(unit, true));
        this.spinBlades(unit, def.radius ?? 8, 0xffe2b0, 0.45, 1.25);
        this.styledRing(s.x, s.z, 0xffe2b0, 0.5, def.radius ?? 8, 0.45, 0.08, 0.7);
        break;
      }
      case 'intimidating_shout':
        this.shout(unit, s, def.radius ?? 8, 0xffd9a0, { count: 4 });
        break;
      case 'dragons_breath': {
        // the mage sprays fire at once over the spell's real cone; how long it waits, stays and fades is on the Animations page
        const cone = coneShape(def);
        this.later(fxSec('dragonsBreath', 'startDelayMs'), () => this.fireCone(unit, cone?.range ?? 14, cone?.half ?? Math.PI / 4, {
          spray: fxSec('dragonsBreath', 'sprayMs'), fade: fxSec('dragonsBreath', 'fadeMs'),
          length: fxNum('dragonsBreath', 'lengthScale'), width: fxNum('dragonsBreath', 'widthScale'), density: fxNum('dragonsBreath', 'density'),
        }));
        break;
      }
      case 'vanish':
        this.puff(s.x, s.y + 0.9, s.z, 0x2b2b33, 16, 2.0);
        this.puff(s.x, s.y + 1.5, s.z, 0x4a3a66, 8, 1.4);
        this.styledRing(s.x, s.z, 0x555566, 0.4, 3, 0.6);
        this.burst(s.x, s.y + 1.1, s.z, 0x9a8ac0, 18, 4, 0.3, 0.7, 0);
        break;
      case 'mirror_image':
        for (let i = 0; i < 2; i++) {
          // the two images stand behind the mage to either side, the three of them making a triangle
          const side = i === 0 ? -1.2 : 1.2;
          const x = s.x + Math.cos(s.facing) * side - Math.sin(s.facing) * 2.08;
          const z = s.z - Math.sin(s.facing) * side - Math.cos(s.facing) * 2.08;
          this.later(i * 0.08, () => {
            this.puff(x, s.y + 1.0, z, 0xe6d8ff, 6, 1.3);
            this.burst(x, s.y + 1.1, z, 0xc58bff, 10, 3.5, 0.3, 0.6, 0);
            this.column(x, z, 0xc58bff, 0.5, 0.5, 3);
          });
        }
        this.styledRing(s.x, s.z, 0xc58bff, 0.4, 3.2, 0.5);
        break;
      case 'holy_nova': {
        const r = def.radius ?? 12;
        const grow = fxSec('holyNova', 'expandMs');
        this.styledRing(s.x, s.z, 0xffe98a, 0.5, r, grow, 0.08, 1);
        this.later(0.08, () => this.styledRing(s.x, s.z, 0xffffff, 0.3, r * 0.7, grow * 0.85, 0.09, 0.8));
        this.column(s.x, s.z, 0xfff1a8, 0.6, 1.3, 6, 0.5);
        for (let i = 0; i < 26; i++) {
          const a = Math.random() * Math.PI * 2;
          const d = rnd(0.5, r * 0.85);
          this.particle(s.x + Math.cos(a) * d * 0.3, s.y + rnd(0.2, 0.8), s.z + Math.sin(a) * d * 0.3, { tex: 'star', color: 0xfff1a8, vx: Math.cos(a) * d * 1.3, vz: Math.sin(a) * d * 1.3, vy: rnd(0.8, 2.4), s0: rnd(0.3, 0.5), s1: 0.08, life: rnd(0.6, 0.9), drag: 1.8 });
        }
        break;
      }
      case 'purifying_light': {
        // the sanctified ground: a circle of light at the real radius that stays as long as the Purified aura it gives lasts
        const r = def.radius ?? 12;
        this.styledRing(s.x, s.z, 0xfff1a8, 0.5, r, 0.55, 0.08, 1);
        this.column(s.x, s.z, 0xfff1a8, 0.6, 1.1, 6, 0.45);
        this.holyCircle(s.x, s.z, r, (AURAS.purified?.duration ?? 4000) / 1000);
        break;
      }
      case 'evocation':
      case 'arcane_power': {
        // arcane energy streams in towards the caster
        for (let i = 0; i < 20; i++) {
          const a = Math.random() * Math.PI * 2;
          const d = rnd(2.5, 4);
          const life = rnd(0.5, 0.8);
          this.particle(s.x + Math.cos(a) * d, s.y + rnd(0.2, 2.2), s.z + Math.sin(a) * d, { color: 0xc58bff, s0: 0.35, s1: 0.08, life, vx: -Math.cos(a) * d / life, vz: -Math.sin(a) * d / life, vy: (1.2 - 1) * 0 });
        }
        this.column(s.x, s.z, 0xc58bff, 0.8, 0.8, 4);
        this.styledRing(s.x, s.z, 0xc58bff, 0.4, 2.0, 0.5);
        break;
      }
      case 'enraged_regeneration':
        this.styledRing(s.x, s.z, 0xff4a2a, 0.3, 2.2, 0.5);
        this.column(s.x, s.z, 0xff4a2a, 0.7, 0.7, 4, 0.4);
        for (let i = 0; i < 8; i++) this.particle(s.x + rnd(-0.6, 0.6), s.y + rnd(0.2, 1.0), s.z + rnd(-0.6, 0.6), { tex: 'plus', color: 0xff6a4a, vy: rnd(1.2, 2.4), s0: rnd(0.3, 0.5), s1: 0.1, life: rnd(0.8, 1.2), drag: 0.5 });
        break;
      case 'frostbolt':
      case 'fireball':
      case 'smite': {
        const kind = ability === 'frostbolt' ? 'frost' : ability === 'fireball' ? 'fire' : 'holy';
        const sl = skillLook(ability);
        const look = sl.form === 'fireball' ? ({ look: 'fireball', size: sl.size, heat: 0 } as FireballLook) : sl.form === 'default' ? fireballLookFor(ability) : null;
        const flight = look ? this.fireballFlight(unit, target, look) : this.projectile(unit, target, def.school, kind, 1, 0, sl);
        this.flights.set(`${unit}:${ability}`, flight);
        break;
      }
      case 'flash_heal': {
        const p = this.pos(target) ?? s;
        this.column(p.x, p.z, 0x9dffb4, 0.8, 0.6, 5);
        this.styledRing(p.x, p.z, 0xfff1a8, 0.3, 1.5, 0.6);
        break;
      }
      case 'power_word_shield': {
        const p = this.pos(target) ?? s;
        this.column(p.x, p.z, 0xfff1a8, 0.7, 0.9, 4);
        break;
      }
      case 'penance': {
        // holy light falls on the target on every pulse (a bolt of damage on an enemy, a mending glow on an ally)
        const p = this.pos(target) ?? s;
        this.onSwing(unit);
        this.column(p.x, p.z, 0xfff1a8, 0.4, 0.45, 8, 0.32);
        this.styledRing(p.x, p.z, 0xffe98a, 0.3, 1.6, 0.35, 0.08);
        this.burst(p.x, p.y + CHEST, p.z, 0xfff1a8, 6, 3, 0.25, 0.4, 0);
        break;
      }
      case 'frost_nova': {
        const r = def.radius ?? 10;
        const grow = fxSec('frostNova', 'expandMs');
        this.styledRing(s.x, s.z, 0x7fd8ff, 0.5, r, grow, 0.08, 1);
        this.styledRing(s.x, s.z, 0xffffff, 0.3, r * 0.8, grow * 0.75, 0.09, 0.8);
        for (let i = 0; i < 28; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = rnd(r * 1.1, r * 1.8);
          this.particle(s.x, s.y + 0.4, s.z, { tex: 'star', color: 0xcdf1ff, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: rnd(0, 1.4), s0: rnd(0.3, 0.5), life: 0.55, drag: 2.5, grav: 3 });
        }
        break;
      }
      case 'psychic_scream': {
        // a scream: head back, then violet waves from the mouth and a dark shock ring to the real radius
        const r = def.radius ?? 8;
        this.shout(unit, s, r, 0xb06bff, { count: 5, dust: false, ring2: 0x9a4dff });
        this.later(SHOUT_RELEASE, () => {
          this.styledRing(s.x, s.z, 0x331a55, 0.3, r * 0.9, 0.7, 0.09, 0.9);
          for (let i = 0; i < 20; i++) {
            const a = Math.random() * Math.PI * 2;
            const sp = rnd(r * 0.9, r * 1.5);
            this.particle(s.x, s.y + rnd(0.5, 1.8), s.z, { color: 0xb06bff, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: rnd(-0.2, 0.8), s0: rnd(0.4, 0.8), life: 0.6, drag: 2.2 });
          }
        });
        break;
      }
      case 'blink': {
        this.burst(s.x, s.y + 1.1, s.z, 0xc58bff, 22, 5, 0.4, 0.6, 0);
        this.styledRing(s.x, s.z, 0xc58bff, 0.3, 2.2, 0.4);
        this.later(0.06, () => {
          const n = this.pos(unit);
          if (!n) return;
          this.burst(n.x, n.y + 1.1, n.z, 0xe0c2ff, 22, 5, 0.4, 0.6, 0);
          this.styledRing(n.x, n.z, 0xc58bff, 0.3, 2.2, 0.4);
          this.beam(s.x, s.y + 1.1, s.z, n.x, n.y + 1.1, n.z, 0xc58bff, fxSec('blink', 'streakMs'), 0.05);
        });
        break;
      }
      case 'charge': {
        // a streak and dust follow the warrior along the whole run (however long it takes), then an impact where he arrives
        this.dashRun(unit, 0xffe2b0, (n) => {
          this.burst(n.x, n.y + 0.4, n.z, 0xd9c19a, 10, 4, 0.5, 0.5);
          this.styledRing(n.x, n.z, 0xffe2b0, 0.4, 2.8, 0.35);
          this.onSwing(unit);
        });
        break;
      }
      case 'mortal_strike':
        melee(0xff4a2a, 1.5);
        if (t) this.styledRing(t.x, t.z, 0xff4a2a, 0.3, 2, 0.3);
        break;
      case 'sinister_strike':
      case 'backstab':
        melee(0xfff079, 1.1);
        if (t) this.later(0.08, () => this.slash(s.x, s.z, t.x, t.z, 0xffffff, 0.9, CHEST + 0.1));
        break;
      case 'hamstring':
        melee(0xff3030, 1.1, 0.5);
        break;
      case 'pummel':
        melee(0xffe2b0, 1.2);
        break;
      case 'kick':
        melee(0xfff079, 1.1, 0.9);
        break;
      case 'cheap_shot':
        melee(0xffffff, 1.3);
        if (t) this.burst(t.x, t.y + HEAD, t.z, 0xfff1a8, 10, 3, 0.35, 0.5, 0);
        break;
      case 'kidney_shot':
        melee(0xc01818, 1.3, 1.0);
        break;
      case 'stealth':
        this.puff(s.x, s.y + 0.9, s.z, 0x2b2b33, 12, 1.5);
        this.styledRing(s.x, s.z, 0x555566, 0.4, 2, 0.5);
        break;
      case 'sprint':
        this.puff(s.x, s.y + 0.3, s.z, 0xc9b99a, 8, 1.2);
        this.styledRing(s.x, s.z, 0xfff079, 0.3, 1.8, 0.35);
        break;
      default:
        this.genericCast(unit, def, s, t, target);
    }
  }

  /**
   * A run at a target (Charge, Intercept): from the cast until the unit comes to rest, a streak and kicked-up dust are laid along the
   * path it really travels (every frame, so the trail is continuous however far or fast), then `onEnd` plays where it stopped.
   * The unit's drawn position is already smooth (see dashPath.ts), so this never blinks. Amounts come from the Animations page.
   */
  private dashRun(unit: number, color: number, onEnd: (at: Pos) => void) {
    const start = this.pos(unit);
    if (!start) return;
    const life = fxSec('charge', 'trailMs');
    const trail = fxNum('charge', 'trailDensity');
    const dust = fxNum('charge', 'dustDensity');
    this.puff(start.x, start.y + 0.4, start.z, 0xb59a7a, Math.round(8 * dust), 1.4);
    let last = { x: start.x, z: start.z };
    let t = 0;
    let moved = false;
    let still = 0;
    let accT = 0;
    let accD = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        const n = this.pos(unit);
        if (!n) return true;
        const d = Math.hypot(n.x - last.x, n.z - last.z);
        const speed = d / Math.max(dt, 0.001);
        if (speed > 8) {
          moved = true;
          still = 0;
          // one puff of streak every ~0.45 yd of path, spread along what was covered this frame (so a long frame leaves no gaps)
          accT += (d / 0.45) * trail;
          accD += (d / 2.2) * dust;
          while (accT >= 1) {
            accT--;
            const f = Math.random();
            this.particle(last.x + (n.x - last.x) * f, n.y + 0.9 + rnd(-0.4, 0.4), last.z + (n.z - last.z) * f, { color, s0: 1.0, s1: 0.15, life, a: 0.6, drag: 0 });
          }
          while (accD >= 1) {
            accD--;
            const f = Math.random();
            this.puff(last.x + (n.x - last.x) * f, n.y + 0.2, last.z + (n.z - last.z) * f, 0x8a7a60, 2, 0.7);
          }
        } else if (moved) still += dt;
        else if (t > 0.8) return true; // it never set off (the charge was stopped)
        last = { x: n.x, z: n.z };
        if (moved && (still > 0.08 || t > 3)) {
          onEnd(n);
          return true;
        }
        return false;
      },
      dispose: () => {},
    });
  }

  /** Visuals for any ability without a hand-made effect, chosen from what the ability does. */
  // ------------------------------------------------------------ style kit: the shapes the plainest skills are dressed in

  private raysTex: THREE.Texture | null = null;

  /** Radial streaks (a sunburst): white wedges fading outward. */
  private raysTexture(): THREE.Texture {
    if (this.raysTex) return this.raysTex;
    this.raysTex = makeTexture((g, sz) => {
      const c = sz / 2;
      const n = 16;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + (i % 2 ? 0.05 : 0);
        const w = (i % 2 ? 0.05 : 0.09) * Math.PI;
        const grad = g.createRadialGradient(c, c, 0, c, c, c);
        grad.addColorStop(0, 'rgba(255,255,255,.95)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(c, c);
        g.arc(c, c, c * (i % 2 ? 0.7 : 1), a - w / 2, a + w / 2);
        g.closePath();
        g.fill();
      }
    });
    return this.raysTex;
  }

  /** A glyph circle laid on the ground: it turns, swells in, holds and fades (the mark of a spell being worked). */
  private runeCircle(x: number, z: number, color: number, radius: number, life = 1.0, spin = 1.2, y = 0.09) {
    const mat = new THREE.MeshBasicMaterial({ color, map: this.getRuneTex(), transparent: true, opacity: 0.95, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(this.planeGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    const gy = y + this.floorAt(x, z);
    mesh.position.set(x, gy, z);
    this.scene.add(mesh);
    let t = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / life);
        const grow = k < 0.2 ? k / 0.2 : 1;
        const sc = radius * 2 * (0.4 + 0.6 * (1 - (1 - grow) * (1 - grow)));
        mesh.scale.set(sc, sc, 1);
        mesh.rotation.z = t * spin;
        mat.opacity = 0.95 * (k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45);
        return k >= 1;
      },
      dispose: () => {
        this.scene.remove(mesh);
        mat.dispose();
      },
    });
  }

  /** A sunburst: radial streaks that flash out from a point and fade (lying on the ground, or standing up facing the camera when `flat` is false). */
  private sunburst(x: number, y: number, z: number, color: number, radius: number, life = 0.45, flat = true) {
    const mat = new THREE.MeshBasicMaterial({ color, map: this.raysTexture(), transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(this.planeGeo, mat);
    if (flat) mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, flat ? y + this.floorAt(x, z) : y, z);
    this.scene.add(mesh);
    let t = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / life);
        const sc = radius * 2 * (0.3 + 0.7 * (1 - (1 - k) * (1 - k)));
        mesh.scale.set(sc, sc, 1);
        if (flat) mesh.rotation.z = t * 0.6;
        mat.opacity = 0.9 * (1 - k);
        return k >= 1;
      },
      dispose: () => {
        this.scene.remove(mesh);
        mat.dispose();
      },
    });
  }

  /** Motes winding up (or down) a spiral round a point: a helix of light. */
  private helix(x: number, y: number, z: number, color: number, height = 2.6, radius = 0.8, turns = 2.2, life = 0.9, n = 34, down = false, tex: TexName = 'glow') {
    for (let i = 0; i < n; i++) {
      const f = i / n;
      this.later(f * life * 0.6, () => {
        const a = f * turns * Math.PI * 2;
        const h = down ? height * (1 - f) : height * f;
        this.particle(x + Math.cos(a) * radius, y + h, z + Math.sin(a) * radius, { tex, color, vx: -Math.sin(a) * 1.3, vz: Math.cos(a) * 1.3, vy: down ? -0.6 : 0.9, s0: 0.32, s1: 0.05, life: life * 0.55, a: 0.9, drag: 0.8 });
      });
    }
  }

  /** Particles pulled in from a ring toward a point (a gathering), or thrown out from it (a release). */
  private vortex(x: number, y: number, z: number, color: number, radius: number, inward = true, n = 26, life = 0.6) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd(-0.1, 0.1);
      const r = radius * rnd(0.8, 1.1);
      const sp = (r / life) * (inward ? -1 : 1);
      const px = inward ? x + Math.cos(a) * r : x;
      const pz = inward ? z + Math.sin(a) * r : z;
      this.particle(px, y + rnd(0, 0.5), pz, { color, vx: Math.cos(a) * sp + Math.sin(a) * 2.2, vz: Math.sin(a) * sp - Math.cos(a) * 2.2, vy: rnd(0.2, 1.2), s0: 0.3, s1: 0.06, life, a: 0.9 });
    }
  }

  /** A jagged bolt between two points: a few kinked beams that flash and fade. */
  private bolt(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: number, life = 0.16, segs = 6, jag = 0.5) {
    let px = ax, py = ay, pz = az;
    for (let i = 1; i <= segs; i++) {
      const f = i / segs;
      const last = i === segs;
      const nx = ax + (bx - ax) * f + (last ? 0 : rnd(-jag, jag));
      const ny = ay + (by - ay) * f + (last ? 0 : rnd(-jag, jag));
      const nz = az + (bz - az) * f + (last ? 0 : rnd(-jag, jag));
      this.beam(px, py, pz, nx, ny, nz, color, life, 0.04);
      px = nx; py = ny; pz = nz;
    }
  }

  /** Slim crystal-like shards thrown upward in a ring (ice, arcane): a burst with a shape to it. */
  private spikes(x: number, z: number, color: number, radius: number, n = 10) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd(-0.15, 0.15);
      const r = radius * rnd(0.55, 1);
      this.later(rnd(0, 0.12), () => {
        for (let k = 0; k < 4; k++) this.particle(x + Math.cos(a) * r, this.floorAt(x, z) + 0.1 + k * 0.28, z + Math.sin(a) * r, { tex: 'star', color: k > 2 ? 0xffffff : color, vy: 1.2 + k * 0.4, s0: 0.38 - k * 0.04, s1: 0.05, life: 0.55, a: 0.9, drag: 1.2 });
      });
    }
  }

  /** A school's own way of arriving on a spot: the ground rune, then what that school does with it. */
  private schoolBurst(p: Pos, school: School, radius: number) {
    const color = SCHOOL_COLOR[school];
    const y = p.y;
    switch (school) {
      case 'fire':
        this.sunburst(p.x, 0.1, p.z, 0xffb347, radius * 0.9, 0.5);
        this.shockwave(p.x, p.z, radius, 0xff8a3a, false, 0.5);
        this.emberShower(p.x, y + 0.2, p.z, radius * 0.7, 18, { heat: 0.6, rise: 2.5 });
        break;
      case 'frost':
        this.runeCircle(p.x, p.z, 0xbfeaff, radius, 0.9, -0.9);
        this.spikes(p.x, p.z, color, radius * 0.85, 12);
        break;
      case 'holy':
        this.runeCircle(p.x, p.z, 0xfff1a8, radius, 1.1, 0.7);
        this.sunburst(p.x, 0.12, p.z, 0xfff6c8, radius * 0.9, 0.7);
        this.helix(p.x, y, p.z, 0xfff1a8, 3.2, Math.min(1.4, radius * 0.35), 2.4, 1.0, 36);
        break;
      case 'shadow':
        this.runeCircle(p.x, p.z, 0x9a5cff, radius, 1.0, -1.4);
        this.vortex(p.x, y + 0.1, p.z, 0x6b2fb0, radius, true, 30, 0.7);
        this.puff(p.x, y + 0.8, p.z, 0x2a1442, 8, 1.6);
        break;
      case 'arcane':
        this.runeCircle(p.x, p.z, 0xd9a8ff, radius, 1.0, 1.6);
        this.spikes(p.x, p.z, color, radius * 0.8, 10);
        this.bolt(p.x, y + 3.2, p.z, p.x + rnd(-1, 1), y, p.z + rnd(-1, 1), 0xf0d8ff, 0.2, 5, 0.4);
        break;
      case 'nature':
        this.runeCircle(p.x, p.z, 0x7fe08a, radius, 1.0, 0.8);
        this.helix(p.x, y, p.z, 0x9dff8f, 2.4, radius * 0.4, 2, 0.9, 28, false, 'star');
        break;
      default: // physical
        this.shockwave(p.x, p.z, radius, 0xffe2b0, true, 0.55);
        this.sunburst(p.x, 0.1, p.z, 0xffe8bd, radius * 0.7, 0.35);
        for (let i = 0; i < 10; i++) {
          const a = Math.random() * Math.PI * 2;
          this.particle(p.x, y + 0.3, p.z, { tex: 'spark', color: 0xfff2c4, vx: Math.cos(a) * rnd(4, 9), vz: Math.sin(a) * rnd(4, 9), vy: rnd(1, 4), s0: 0.22, life: 0.45, grav: 9 });
        }
    }
  }

  private genericCast(unit: number, def: AbilityDef, s: Pos, t: Pos | null, target: number) {
    const color = SCHOOL_COLOR[def.school];
    const has = (type: string) => def.effects.some((e) => e.type === type);
    const enemyTarget = def.target === 'enemy' || def.target === 'any';
    const melee = enemyTarget && def.range <= 6;

    if (has('charge') && t) {
      // dust and a streak while the unit runs, then an impact where it lands
      this.dashRun(unit, color, (n) => {
        this.burst(n.x, n.y + 0.5, n.z, color, 10, 4, 0.4, 0.5);
        this.sunburst(n.x, 0.1, n.z, 0xffe8bd, 2.6, 0.35);
        this.shockwave(n.x, n.z, 2.8, color, true, 0.4);
        this.onSwing(unit);
      });
      return;
    }
    if (has('dashToTarget') && t) {
      const ox = s.x;
      const oz = s.z;
      this.puff(ox, s.y + 0.4, oz, 0x2b2b33, 6, 1.2);
      this.later(0.05, () => {
        const n = this.pos(unit);
        if (!n) return;
        for (let i = 0; i <= 12; i++) {
          const f = i / 12;
          this.particle(ox + (n.x - ox) * f, s.y + (n.y - s.y) * f + 1.0 + rnd(-0.3, 0.3), oz + (n.z - oz) * f, { color, s0: 0.8, s1: 0.2, life: 0.35, a: 0.6 });
        }
        this.burst(n.x, n.y + 0.5, n.z, color, 8, 3.5, 0.4, 0.45);
        this.sunburst(n.x, 0.1, n.z, color, 2.2, 0.3);
        this.onSwing(unit);
      });
      return;
    }
    const vis = visualFor(def);
    if ((vis.cls === 'onTarget' || vis.cls === 'aura') && vis.hit) {
      // an instant that lands now: drawn at the target, nothing flies there
      const tp = target ? this.pos(target) : null;
      if (tp) {
        const sl = skillLook(def.id);
        const kind = (sl.hitKind !== 'default' ? sl.hitKind : vis.hit.kind) as ImpactKind;
        const style = (sl.hitStyle !== 'default' ? sl.hitStyle : vis.hit.style) as typeof vis.hit.style;
        this.hitVisual({ kind, style }, tp, target, sl.hitSize);
        if (def.target === 'ally' && unit !== target) this.runeCircle(s.x, s.z, color, 1.1, 0.7, 1.4);
        return;
      }
    }
    if (def.target === 'aoe_enemy' || def.target === 'aoe_all') {
      const r = Math.min(def.radius ?? 8, 24);
      const cone = coneShape(def);
      if (cone) {
        // any other cone: the real sector on the ground and a fan of the school's colour out along it
        this.sector(s.x, s.z, s.facing, cone.range, cone.half, color, 0.6, 0.55, unit);
        for (let i = 0; i < 46; i++) {
          const a = s.facing + coneSpawnAngle(rnd(-1, 1), cone.half);
          const sp = rnd(r * 0.8, r * 1.9);
          this.particle(s.x + Math.sin(a) * 0.8, s.y + rnd(0.6, 1.6), s.z + Math.cos(a) * 0.8, { color: i % 3 === 0 ? 0xffe066 : color, vx: Math.sin(a) * sp, vz: Math.cos(a) * sp, vy: rnd(-0.2, 0.8), s0: rnd(0.4, 0.8), life: 0.6, drag: 2.3 });
        }
        if (has('damage')) this.onSwing(unit);
        return;
      }
      this.schoolBurst(s, def.school, r); // a shape of the school's own, not a plain ring
      for (let i = 0; i < 22; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = rnd(r * 0.9, r * 1.6);
        this.particle(s.x, s.y + rnd(0.4, 1.5), s.z, { color, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: rnd(0, 1), s0: rnd(0.3, 0.6), life: 0.55, drag: 2.3 });
      }
      if (has('damage')) this.onSwing(unit);
      return;
    }
    if (melee && t) {
      this.onSwing(unit);
      const heavy = def.effects.some((e) => e.type === 'damage' && e.amount >= 140);
      this.slash(s.x, s.z, t.x, t.z, color, heavy ? 1.35 : 1.1);
      this.burst(t.x, t.y + CHEST, t.z, color, 7, 3.6, 0.26, 0.4);
      if (heavy) {
        this.sunburst(t.x, t.y + CHEST, t.z, 0xffe8bd, 1.6, 0.3, false);
        this.bolt(s.x, s.y + 1.2, s.z, t.x, t.y + CHEST, t.z, color, 0.14, 4, 0.25);
      }
      if (def.school !== 'physical') this.helix(t.x, t.y, t.z, color, 1.8, 0.5, 1.4, 0.5, 14, false, 'star');
      if (has('aura') && !has('damage')) this.burst(t.x, t.y + HEAD, t.z, 0xfff1a8, 8, 3, 0.3, 0.5, 0);
      return;
    }
    if (enemyTarget && t && has('damage')) {
      const kind = def.school === 'fire' ? 'fire' : def.school === 'frost' ? 'frost' : def.school === 'holy' ? 'holy' : def.school === 'shadow' ? 'shadow' : 'arcane';
      if (def.channel?.beam) {
        // a continuous beam: each pulse redraws a beam that lasts until the next one
        this.beam(s.x, s.y + 1.5, s.z, t.x, t.y + CHEST, t.z, color, (def.castTime / def.channel.ticks / 1000) * 1.15, 0.1);
        this.onSwing(unit);
      } else if (def.channel) {
        // one small curving missile per tick of the volley
        this.flights.set(`${unit}:${def.id}`, this.projectile(unit, target, def.school, kind, 0.62, rnd(0.6, 1.3), skillLook(def.id)));
        this.onSwing(unit);
      } else if (def.castTime > 0) {
        const big = def.effects.some((e) => e.type === 'damage' && e.amount >= 300) ? 1.35 : 1;
        const sl = skillLook(def.id);
        const look = sl.form === 'fireball' ? ({ look: 'fireball', size: sl.size, heat: 0 } as FireballLook) : sl.form === 'default' ? fireballLookFor(def.id) : null;
        this.flights.set(`${unit}:${def.id}`, look ? this.fireballFlight(unit, target, look) : this.projectile(unit, target, def.school, kind, big, 0, sl));
      } else {
        this.impactAt(t, impactKindFor(def.school));
      }
      return;
    }
    if (enemyTarget && t) {
      this.impactAt(t, impactKindFor(def.school), 0.8);
      return;
    }
    if (has('heal')) {
      const p = this.pos(target) ?? s;
      this.column(p.x, p.z, def.school === 'holy' ? 0x9dffb4 : color, 0.8, 0.5, 5);
      this.helix(p.x, p.y, p.z, 0x9dffb4, 3.0, 0.7, 2.4, 1.0, 36);
      this.helix(p.x, p.y, p.z, 0xfff1a8, 3.0, 0.45, -2.0, 0.9, 20, false, 'star');
      this.runeCircle(p.x, p.z, 0xcfffd8, 1.3, 0.8, 1.0);
      return;
    }
    // self or ally buff
    const p = def.target === 'ally_or_self' && target ? this.pos(target) ?? s : s;
    this.column(p.x, p.z, color, 0.7, 0.6, 4);
    this.schoolBurst(p, def.school, 2.0);
    this.burst(p.x, p.y + 1.0, p.z, color, 14, 3.2, 0.3, 0.6, 0);
  }

  // ------------------------------------------------------------ persistent aura visuals

  private makeAttachment(aura: string): Attachment | null {
    const group = new THREE.Group();
    this.scene.add(group);
    const sprites: THREE.Sprite[] = [];
    const meshes: THREE.Mesh[] = [];
    const mats: THREE.Material[] = [];
    const finish = (att: Omit<Attachment, 'group'>): Attachment & { dispose(): void } => ({
      group,
      update: att.update,
      dispose: () => {
        this.scene.remove(group);
        for (const sp of sprites) {
          sp.visible = false;
          this.pool.push(sp);
        }
        for (const m of mats) m.dispose();
      },
    });
    const orbiters = (tex: TexName, color: number, n: number, radius: number, height: number, speed: number, size: number) => {
      for (let i = 0; i < n; i++) {
        const sp = this.sprite(tex, color);
        sp.scale.set(size, size, 1);
        sprites.push(sp);
        group.add(sp);
        this.scene.remove(sp);
        group.add(sp);
      }
      return (t: number) => {
        sprites.forEach((sp, i) => {
          const a = t * speed + (i / n) * Math.PI * 2;
          sp.position.set(Math.cos(a) * radius, height + Math.sin(t * 3 + i) * 0.06, Math.sin(a) * radius);
        });
      };
    };

    switch (aura) {
      case 'cheap_shot_stun':
      case 'concussion_stun':
      case 'kidney_shot': {
        const upd = orbiters('star', 0xffe65a, 3, 0.5, 2.35, 3.2, 0.45);
        return finish({ update: (_dt, t) => upd(t) });
      }
      case 'psychic_scream':
      case 'intimidating_shout': {
        const upd = orbiters('glow', 0xb06bff, 4, 0.55, 2.2, 5, 0.55);
        const exc = this.sprite('star', 0xd9a8ff);
        exc.scale.set(0.5, 0.5, 1);
        sprites.push(exc);
        group.add(exc);
        return finish({
          update: (_dt, t) => {
            upd(t);
            exc.position.set(0, 2.75 + Math.sin(t * 9) * 0.07, 0);
          },
        });
      }
      case 'ascended': {
        // Ascend to the Heavens: a soft halo round the hovering priest, a faint shaft of light down to the floor and motes drifting down it
        const halo = this.sprite('glow', 0xfff1a8);
        this.scene.remove(halo);
        group.add(halo);
        sprites.push(halo);
        halo.position.y = 1.2;
        const mat = new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.12, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
        mats.push(mat);
        const shaft = new THREE.Mesh(this.beamGeo, mat);
        group.add(shaft);
        meshes.push(shaft);
        return finish({
          update: (dt, t, u) => {
            const drop = Math.max(0.01, u.y - this.groundY(u.x, u.z)); // how far up the feet are
            shaft.visible = drop > 0.3;
            shaft.scale.set(0.55, drop, 0.55);
            shaft.position.y = -drop / 2;
            mat.opacity = 0.1 + Math.sin(t * 2.4) * 0.03;
            const hm = halo.material as THREE.SpriteMaterial;
            hm.opacity = 0.45 + Math.sin(t * 3) * 0.1;
            halo.scale.setScalar(3.2 + Math.sin(t * 2.4) * 0.25);
            if (Math.random() < dt * 14) {
              const ang = Math.random() * Math.PI * 2;
              this.particle(u.x + Math.cos(ang) * 0.5, u.y + 0.5 + rnd(0, 1.5), u.z + Math.sin(ang) * 0.5, { tex: 'glow', color: 0xfff1a8, vy: -rnd(0.6, 1.4), s0: 0.22, s1: 0.06, life: 0.9, a: 0.7 });
            }
          },
        });
      }
      case 'ice_barrier':
      case 'pw_shield': {
        const tint = aura === 'ice_barrier' ? 0x9fe0ff : 0xffe98a;
        const mat = new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
        const mat2 = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, wireframe: true, blending: THREE.AdditiveBlending, depthWrite: false });
        mats.push(mat, mat2);
        const a = new THREE.Mesh(this.sphereGeo, mat);
        const b = new THREE.Mesh(this.sphereGeo, mat2);
        a.scale.set(1.15, 1.45, 1.15);
        b.scale.set(1.18, 1.48, 1.18);
        a.position.y = b.position.y = 1.0;
        group.add(a, b);
        meshes.push(a, b);
        return finish({
          update: (_dt, t) => {
            mat.opacity = 0.18 + Math.sin(t * 4) * 0.05;
            b.rotation.y = t * 0.8;
            if (Math.random() < 0.15) {
              const ang = Math.random() * Math.PI * 2;
              this.particle(group.position.x + Math.cos(ang) * 1.1, group.position.y + rnd(0.2, 2), group.position.z + Math.sin(ang) * 1.1, { color: 0xfff1a8, s0: 0.2, life: 0.6, vy: 0.8 });
            }
          },
        });
      }
      case 'frostbolt_slow':
      case 'hamstring_slow': {
        const col = aura === 'frostbolt_slow' ? 0x7fd8ff : 0xff4a3a;
        const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.6, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
        mats.push(mat);
        const m = new THREE.Mesh(this.ringGeo, mat);
        m.rotation.x = -Math.PI / 2;
        m.position.y = 0.06;
        group.add(m);
        return finish({
          update: (_dt, t) => {
            const s = 0.85 + Math.sin(t * 5) * 0.06;
            m.scale.set(s, s, 1);
            mat.opacity = 0.45 + Math.sin(t * 5) * 0.15;
            if (aura === 'frostbolt_slow' && Math.random() < 0.12) {
              this.particle(group.position.x + rnd(-0.4, 0.4), group.position.y + 1.8, group.position.z + rnd(-0.4, 0.4), { tex: 'star', color: 0xcdf1ff, vy: -0.8, s0: 0.22, life: 0.9 });
            }
          },
        });
      }
      case 'sprint':
        return finish({
          update: (_dt, _t, _u, moving) => {
            if (moving && Math.random() < 0.6) {
              this.particle(group.position.x + rnd(-0.2, 0.2), group.position.y + 0.15, group.position.z + rnd(-0.2, 0.2), { tex: 'smoke', color: 0xc9b99a, add: false, s0: 0.3, s1: 0.9, life: 0.5, a: 0.5, vy: 0.4 });
              this.particle(group.position.x + rnd(-0.2, 0.2), group.position.y + rnd(0.3, 1.3), group.position.z + rnd(-0.2, 0.2), { color: 0xfff079, s0: 0.15, life: 0.3, a: 0.7 });
            }
          },
        });
      case 'polymorph':
        return finish({
          update: (_dt, t) => {
            if (Math.random() < 0.1) {
              this.particle(group.position.x + rnd(-0.4, 0.4), group.position.y + 1.4 + Math.sin(t) * 0.1, group.position.z + rnd(-0.4, 0.4), { tex: 'star', color: 0xd9b3ff, vy: 0.7, s0: 0.25, life: 0.8 });
            }
          },
        });
      default: {
        // Buff auras (cooldowns like Recklessness or Evasion): a glowing ground ring with rising sparks.
        if (AURAS[aura]?.kind !== 'buff') {
          this.scene.remove(group);
          return null;
        }
        const col = BUFF_COLOR[aura] ?? 0xffe98a;
        const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.6, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
        mats.push(mat);
        const m = new THREE.Mesh(this.ringGeo, mat);
        m.rotation.x = -Math.PI / 2;
        m.position.y = 0.07;
        group.add(m);
        return finish({
          update: (_dt, t) => {
            const sc = 1.1 + Math.sin(t * 4) * 0.08;
            m.scale.set(sc, sc, 1);
            mat.opacity = 0.5 + Math.sin(t * 6) * 0.15;
            if (Math.random() < 0.35) {
              const a = Math.random() * Math.PI * 2;
              this.particle(group.position.x + Math.cos(a) * 0.9, group.position.y + 0.1, group.position.z + Math.sin(a) * 0.9, { color: col, vy: rnd(1.2, 2.4), s0: 0.22, life: 0.7, drag: 0.3 });
            }
          },
        });
      }
    }
  }

  // ------------------------------------------------------------ per frame

  /** Ground zones (Flamestrike etc.): warning ring that fills until the first beat, then a pulsing fire disc. */
  private smokeMeshes = new Map<number, { group: THREE.Group; disc: THREE.Mesh; blobs: { mesh: THREE.Mesh; x: number; z: number; r: number; ph: number }[] }>();
  private smokeGeo = new THREE.SphereGeometry(1, 8, 6);

  /** A smoke cloud: pops up from the caster's feet, billows for its duration and thins out at the end. */
  private setSmoke(z: ZoneSnap, now: number, seenSmoke: Set<number>) {
    seenSmoke.add(z.id);
    let m = this.smokeMeshes.get(z.id);
    if (!m) {
      const group = new THREE.Group();
      group.position.set(z.x, z.y ?? 0, z.z); // on top of a walkway when cast there
      const mat = () => new THREE.MeshBasicMaterial({ color: 0x8b8f99, transparent: true, opacity: 0.4, depthWrite: false });
      const disc = new THREE.Mesh(this.discGeo, new THREE.MeshBasicMaterial({ color: 0x555a66, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.05;
      group.add(disc);
      const blobs: { mesh: THREE.Mesh; x: number; z: number; r: number; ph: number }[] = [];
      for (let i = 0; i < 7; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * z.r * 0.85;
        const mesh = new THREE.Mesh(this.smokeGeo, mat());
        const b = { mesh, x: Math.cos(a) * d, z: Math.sin(a) * d, r: 1.4 + Math.random() * 1.5, ph: Math.random() * 6.28 };
        group.add(mesh);
        blobs.push(b);
      }
      this.scene.add(group);
      m = { group, disc, blobs };
      this.smokeMeshes.set(z.id, m);
    }
    const age = Math.max(0, (now - z.start) / 1000);
    const left = Math.max(0, (z.end - now) / 1000);
    const grow = Math.min(1, age / 0.35);
    const fade = Math.min(1, left / 0.8);
    (m.disc.material as THREE.MeshBasicMaterial).opacity = 0.35 * fade;
    m.disc.scale.set(z.r * grow, z.r * grow, 1);
    for (const b of m.blobs) {
      const bob = Math.sin(now / 700 + b.ph);
      const s = b.r * (0.85 + 0.15 * bob) * grow;
      b.mesh.position.set(b.x * grow, 1 + s * 0.6 + bob * 0.2, b.z * grow);
      b.mesh.scale.set(s, s * 0.8, s);
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.42 * fade;
    }
  }

  // ------------------------------------------------------------ ground zones

  private zoneVfx = new Map<number, ZoneVfx>();
  /** Two crossed upright quads (base at y = 0): a flame tongue that reads from any angle. */
  private tongueGeo = (() => {
    const g = new THREE.BufferGeometry();
    const p = [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0, 0, 0, -0.5, 0, 0, 0.5, 0, 1, 0.5, 0, 1, -0.5];
    const uv = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    return g;
  })();
  private runeTex: THREE.Texture | null = null;
  private glyphTex: THREE.Texture[] = [];

  /** Shared white-on-clear circle of runes; tinted by the material colour. */
  private getRuneTex(): THREE.Texture {
    if (this.runeTex) return this.runeTex;
    const s = 256;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d')!;
    g.translate(s / 2, s / 2);
    g.strokeStyle = '#fff';
    g.lineCap = 'round';
    const circle = (r: number, w: number) => {
      g.lineWidth = w;
      g.beginPath();
      g.arc(0, 0, r * s, 0, Math.PI * 2);
      g.stroke();
    };
    circle(0.485, 3);
    circle(0.435, 2);
    circle(0.3, 2);
    // two interlocked triangles
    g.lineWidth = 2;
    for (const off of [0, Math.PI]) {
      g.beginPath();
      for (let i = 0; i <= 3; i++) {
        const a = off + (i / 3) * Math.PI * 2 - Math.PI / 2;
        const x = Math.cos(a) * 0.3 * s;
        const y = Math.sin(a) * 0.3 * s;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    // runic strokes in the band between the two outer circles
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      const k = (i * 7919) % 5;
      g.save();
      g.rotate(a);
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(0.44 * s, 0);
      g.lineTo(0.48 * s, 0);
      g.moveTo(0.455 * s, 0);
      g.lineTo(0.455 * s + (k % 2 ? 6 : -6), k < 3 ? -7 : 7);
      g.stroke();
      g.restore();
    }
    // tick marks on the inner circle
    for (let i = 0; i < 12; i++) {
      g.save();
      g.rotate((i / 12) * Math.PI * 2);
      g.beginPath();
      g.moveTo(0.3 * s, 0);
      g.lineTo(0.43 * s, 0);
      g.lineWidth = 1.2;
      g.stroke();
      g.restore();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    this.runeTex = t;
    return t;
  }

  /** A few small runic glyphs (floating around Rune of Power). */
  private getGlyph(i: number): THREE.Texture {
    if (this.glyphTex.length) return this.glyphTex[i % this.glyphTex.length];
    const shapes: [number, number, number, number][][] = [
      [[0.5, 0.1, 0.5, 0.9], [0.5, 0.3, 0.8, 0.5], [0.5, 0.55, 0.8, 0.75]],
      [[0.3, 0.1, 0.3, 0.9], [0.3, 0.15, 0.75, 0.4], [0.75, 0.4, 0.3, 0.65]],
      [[0.5, 0.1, 0.2, 0.9], [0.5, 0.1, 0.8, 0.9], [0.3, 0.6, 0.7, 0.6]],
      [[0.25, 0.15, 0.75, 0.85], [0.75, 0.15, 0.25, 0.85], [0.5, 0.05, 0.5, 0.95]],
      [[0.5, 0.1, 0.8, 0.5], [0.8, 0.5, 0.5, 0.9], [0.5, 0.9, 0.2, 0.5], [0.2, 0.5, 0.5, 0.1]],
    ];
    for (const lines of shapes) {
      this.glyphTex.push(makeTexture((g, s) => {
        g.strokeStyle = '#fff';
        g.lineWidth = 5;
        g.lineCap = 'round';
        g.shadowColor = '#fff';
        g.shadowBlur = 8;
        g.beginPath();
        for (const [a, b, c, d] of lines) {
          g.moveTo(a * s, b * s);
          g.lineTo(c * s, d * s);
        }
        g.stroke();
      }));
    }
    return this.glyphTex[i % this.glyphTex.length];
  }

  /**
   * The one flame every fire effect shares: a layered tongue that rises and dies. With the flipbook: a dark red body behind it (normal
   * blending, so the fire has a darker edge), a large flame tongue and a smaller, hotter one inside it, each on its own frame phase.
   * `color` tints the outer tongue (the default keeps the fireball orange); without the flipbook the canvas flame is drawn.
   */
  fireTongue(x: number, y: number, z: number, scale = 1, color = 0xff5a14, o: { vy?: number; life?: number; heat?: number } = {}) {
    const j = 0.12 * scale;
    const life = o.life ?? rnd(0.4, 0.6);
    const vy = o.vy ?? rnd(0.9, 1.8) * scale;
    if (this.fireFrames) {
      const c = fireballColors(o.heat ?? 0);
      const tint = color === 0xff5a14 ? c.tongueA : color;
      const px = x + rnd(-j, j);
      const pz = z + rnd(-j, j);
      const vx = rnd(-0.25, 0.25);
      const vz = rnd(-0.25, 0.25);
      this.particle(px, y + 0.15 * scale, pz, { tex: 'glow', color: c.outer, add: false, vx, vz, vy: vy * 0.8, s0: 0.9 * scale, s1: 1.1 * scale, life: life * 1.1, drag: 0.8, a: 0.3 });
      this.particle(px, y, pz, { fire: true, color: tint, col1: c.tailMid, vy, vx, vz, s0: 1.15 * scale, s1: 0.7 * scale, life, drag: 0.8, a: 0.95, fps: rnd(16, 26), rot: rnd(-0.25, 0.25) });
      this.particle(px, y - 0.05 * scale, pz, { fire: true, color: c.body, col1: c.tailHot, vy: vy * 1.05, vx: vx * 0.6, vz: vz * 0.6, s0: 0.6 * scale, s1: 0.32 * scale, life: life * 0.75, drag: 0.8, a: 0.9, fps: rnd(18, 28), rot: rnd(-0.25, 0.25) });
      return;
    }
    this.particle(x + rnd(-j, j), y, z + rnd(-j, j), { tex: 'flame', color, vy: rnd(0.9, 1.8) * scale, vx: rnd(-0.25, 0.25), vz: rnd(-0.25, 0.25), s0: 0.95 * scale, s1: 0.25 * scale, life: rnd(0.35, 0.55), drag: 0.8, a: 0.9 });
    this.particle(x + rnd(-j, j) * 0.5, y, z + rnd(-j, j) * 0.5, { tex: 'flame', color: 0xffd45a, vy: rnd(0.8, 1.5) * scale, s0: 0.5 * scale, s1: 0.1 * scale, life: rnd(0.25, 0.4), drag: 0.8, a: 1 });
  }

  /** Reusable flame (the old name of `fireTongue`): every caller, the cosmetics included, gets the shared fire look. */
  flame(x: number, y: number, z: number, scale = 1, color = 0xff5a14) {
    this.fireTongue(x, y, z, scale, color);
  }

  /** Dark smoke rising off a fire: normal-blended wisps that stay in the air, a share of them tinted by the fire under them. */
  smokeWisps(x: number, y: number, z: number, n: number, size = 1, o: { spread?: number; heat?: number } = {}) {
    const c = fireballColors(o.heat ?? 0);
    const sp = o.spread ?? 0.4;
    for (let i = 0; i < n; i++) {
      this.particle(x + rnd(-sp, sp), y + rnd(0, 0.3), z + rnd(-sp, sp), {
        tex: 'smoke', color: i % 3 === 0 ? 0x3a1209 : c.smoke, add: false, vx: rnd(-0.4, 0.4), vy: rnd(0.8, 1.7), vz: rnd(-0.4, 0.4),
        s0: size * 0.6, s1: size * rnd(1.7, 2.4), life: rnd(1.2, 1.9), a: 0.42, drag: 0.4, spin: rnd(-0.4, 0.4),
      });
    }
  }

  /** Embers drifting up over a disc of `radius` yards (a slow swirl round its middle), orange and pale yellow, fading as they rise. */
  emberShower(x: number, y: number, z: number, radius: number, n: number, o: { heat?: number; swirl?: number; rise?: number } = {}) {
    const c = fireballColors(o.heat ?? 0);
    const sw = o.swirl ?? 0.25;
    const rise = o.rise ?? 1;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * radius;
      const dx = Math.cos(a) * d;
      const dz = Math.sin(a) * d;
      this.particle(x + dx, y + 0.2, z + dz, {
        tex: Math.random() < 0.25 ? 'star' : 'spark', color: Math.random() < 0.6 ? c.ember : 0xffe9a0, col1: c.tailMid,
        vy: rnd(1.5, 3.8) * rise, vx: rnd(-0.6, 0.6) - dz * sw, vz: rnd(-0.6, 0.6) + dx * sw, s0: rnd(0.12, 0.26), s1: 0.03, life: rnd(0.9, 1.6), drag: 0.3,
      });
    }
  }

  /** The white-hot flash and heat bloom of a fire lighting (fireball hit, Scorch, Flamestrike cast). `size` is the flare radius in yards. */
  fireFlash(x: number, y: number, z: number, size: number, heat = 0, grow = 1) {
    const c = fireballColors(heat);
    this.particle(x, y, z, { tex: 'glow', color: 0xfff2c8, s0: size * 1.3, s1: size * 4 * grow, life: 0.2, a: 1, drag: 0 });
    this.particle(x, y, z, { tex: 'spark', color: 0xffffff, s0: size * 1.2, s1: size * 0.2, life: 0.12, a: 1, drag: 0 });
    this.particle(x, y, z, { tex: 'glow', color: c.halo, s0: size * 2, s1: size * 6 * grow, life: 0.5, a: 0.7, drag: 0 });
  }

  /**
   * What a fire leaves on the ground: an orange glow (normal blending under an additive core, so it reads on light and dark floors) over
   * a darker scorch mark that outlasts it. `radius` is the footprint of the fire; `light` leaves out the additive core (many small ones).
   */
  fireGroundGlow(x: number, z: number, radius: number, heat = 0, o: { light?: boolean; life?: number } = {}) {
    const c = fireballColors(heat);
    const k = o.life ?? 1;
    this.decal(x, z, 0x0e0705, radius * 0.5, radius * 1.15, 2.6 * k, 0.62, false, 0.3, 0.045);
    this.decal(x, z, c.ringBase, radius * 0.6, radius * 1.5, 1.0 * k, 0.5, false, 0.15, 0.052);
    if (!o.light) this.decal(x, z, c.ground, radius * 0.5, radius * 1.1, 0.8 * k, 0.65, true, 0.2, 0.058);
  }

  private flatMat(color: number, opacity: number, tex?: THREE.Texture) {
    return new THREE.MeshBasicMaterial({ color, map: tex ?? null, transparent: true, opacity, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
  }

  private flat(group: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, y: number, r: number) {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = y;
    m.scale.set(r, r, 1);
    group.add(m);
    return m;
  }

  private makeZoneVfx(z: ZoneSnap, now: number): ZoneVfx {
    if (z.flag) return this.bannerZone(z, now, 'flag');
    if (z.buff === 'allies') return this.bannerZone(z, now, 'battle');
    if (z.buff === 'self') return this.runeZone(z, now);
    if (z.school === 'frost') return this.iceZone(z, now);
    if (z.school === 'fire') return this.fireZone(z, now);
    return this.plainZone(z, now);
  }

  private hasOpening(z: ZoneSnap) {
    const zone = ABILITIES[z.ability]?.effects.find((e) => e.type === 'zone');
    return !!(zone && zone.type === 'zone' && zone.initial);
  }

  /** Any other damaging zone: the old coloured disc and ring, with the opening blast. */
  private plainZone(z: ZoneSnap, now: number): ZoneVfx {
    const color = SCHOOL_COLOR[z.school] ?? 0xff6a20;
    const group = new THREE.Group();
    group.position.set(z.x, (z.y ?? 0) + 0.06, z.z);
    const dm = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
    const rm = dm.clone();
    this.flat(group, this.discGeo, dm, 0, z.r);
    this.flat(group, this.ringGeo, rm, 0, z.r);
    this.scene.add(group);
    if (this.hasOpening(z)) {
      this.column(z.x, z.z, color, 0.7, z.r * 0.5, 9);
      this.ring(z.x, z.z, color, 0.5, z.r, 0.55, 0.08, 1);
      this.ring(z.x, z.z, 0xffffff, 0.3, z.r * 0.7, 0.4, 0.09, 0.8);
      this.burst(z.x, 0.8, z.z, color, 34, 7, 0.6, 0.7);
    }
    return {
      last: now,
      update: (zz, t) => {
        const armed = t >= zz.firstAt;
        const sincePulse = armed ? ((t - zz.firstAt) % zz.pulse) / zz.pulse : 0;
        rm.opacity = armed ? 0.9 : 0.5 + 0.4 * Math.sin(t / 90);
        dm.opacity = armed ? 0.55 - 0.4 * sincePulse : 0.12 + 0.18 * Math.min(1, (t - zz.start) / Math.max(1, zz.firstAt - zz.start));
      },
      dispose: () => {
        this.scene.remove(group);
        dm.dispose();
        rm.dispose();
      },
    };
  }

  /** A lasting ring of holy light with a slowly turning rune disc and a soft glow on the ground over `r` yards (Purifying Light): it fades in, holds, then fades out over the last moments of `dur` seconds. */
  private holyCircle(x: number, z: number, r: number, dur: number) {
    const group = new THREE.Group();
    group.position.set(x, this.groundY(x, z), z);
    const ringM = this.flatMat(0xffe98a, 0);
    const runeM = this.flatMat(0xfff1c0, 0, this.getRuneTex());
    const glowM = this.flatMat(0xffe27a, 0);
    this.flat(group, this.discGeo, glowM, 0.06, r);
    this.flat(group, this.ringGeo, ringM, 0.07, r);
    const rune = this.flat(group, this.discGeo, runeM, 0.08, r * 1.02);
    this.scene.add(group);
    let t = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        const fade = Math.min(1, t / 0.25) * Math.min(1, Math.max(0, (dur - t) / 0.8));
        ringM.opacity = (0.7 + 0.15 * Math.sin(t * 5)) * fade;
        runeM.opacity = 0.3 * fade;
        glowM.opacity = 0.13 * fade;
        rune.rotation.z = t * 0.5;
        if (fade > 0.5 && Math.random() < dt * r * 0.6) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.sqrt(Math.random()) * r * 0.95;
          this.particle(x + Math.cos(a) * d, 0.1, z + Math.sin(a) * d, { tex: 'star', color: 0xfff1a8, vy: rnd(0.8, 1.8), s0: rnd(0.2, 0.35), s1: 0.05, life: rnd(0.7, 1.1), drag: 0.4 });
        }
        return t >= dur;
      },
      dispose: () => {
        this.scene.remove(group);
        ringM.dispose();
        runeM.dispose();
        glowM.dispose();
      },
    });
  }

  /**
   * Flamestrike: a gathering runic ring over the zone's real radius, then a field of flipbook flame tongues (fireFx.ts) swirling round a
   * white-hot core, a pillar of fire when it lights, an orange glow over a scorch mark that builds up, and on every damage pulse a ring
   * out to the radius, a jump of the flames and a burst of embers. Embers drift and smoke rises while it burns; a scorch mark stays
   * after it. About 55 pooled sprites for the field plus the particles, all under the global cap.
   */
  /** One meteor of a Flamestrike: it falls from the sky at a slant, trailing fire, and bursts where it lands. */
  private meteor(tx: number, tz: number, y0: number, big: boolean): void {
    const ang = Math.random() * Math.PI * 2;
    const run = rnd(2.5, 4.5); // a slight slant, like wind-driven hail
    const high = rnd(11, 16);
    const sx = tx + Math.cos(ang) * run;
    const sz = tz + Math.sin(ang) * run;
    const fall = rnd(0.34, 0.5);
    const size = big ? rnd(1.2, 1.6) : rnd(0.55, 0.9);
    const core = this.sprite('spark', 0xffffff);
    const halo = this.sprite('glow', 0xff7a1a);
    let t = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        const p = Math.min(1, t / fall);
        const e = p * p; // it speeds up as it falls
        const x = sx + (tx - sx) * e;
        const z = sz + (tz - sz) * e;
        const y = y0 + high * (1 - e);
        core.position.set(x, y, z);
        halo.position.set(x, y, z);
        core.scale.setScalar(size * 1.1);
        halo.scale.setScalar(size * 3.2);
        for (let k = 0; k < 2; k++) this.particle(x + rnd(-0.2, 0.2), y + rnd(-0.2, 0.2), z + rnd(-0.2, 0.2), { color: 0xffa23a, col1: 0x6a1a08, vx: (sx - tx) * 0.1, vy: 1.4, vz: (sz - tz) * 0.1, life: 0.6, s0: size * 1.2, s1: size * 0.25, a: 0.95, fire: true });
        if (Math.random() < 0.6) this.particle(x, y, z, { color: 0x3a2a24, vy: 0.5, life: 0.7, s0: size * 0.7, s1: size * 1.6, a: 0.45, add: false });
        if (p < 1) return false;
        this.scene.remove(core, halo);
        core.visible = halo.visible = false;
        this.pool.push(core, halo);
        // impact: a flash, a shock ring, a scorch crater and sparks thrown up
        this.fireFlash(tx, y0 + 0.8, tz, size * 1.4);
        this.ring(tx, tz, 0xffb24a, size * 0.4, size * 2.4, 0.3, 0.09, 0.8);
        this.decal(tx, tz, 0x0e0705, size * 1.6, size * 1.9, 3.2, 0.55, false, 0.4, 0.045);
        this.burst(tx, y0 + 0.3, tz, 0xffa23a, big ? 8 : 4, big ? 5 : 3.5, 0.2, 0.5, 7);
        for (let k = 0; k < (big ? 2 : 0); k++) this.fireTongue(tx + rnd(-1, 1) * size, y0 + 0.1, tz + rnd(-1, 1) * size, rnd(1.0, 1.7), 0xff5a14, { vy: rnd(2, 4) });
        if (big) this.smokeWisps(tx, y0 + 0.6, tz, 1, 1.0, { spread: 0.4 });
        return true;
      },
      dispose: () => {
        if (core.visible) {
          this.scene.remove(core, halo);
          core.visible = halo.visible = false;
          this.pool.push(core, halo);
        }
      },
    });
  }

  private fireZone(z: ZoneSnap, now: number): ZoneVfx {
    const r = z.r;
    const y0 = z.y ?? 0;
    const group = new THREE.Group();
    group.position.set(z.x, y0, z.z);
    const ringM = this.flatMat(0xff6a1a, 0.9);
    const runeM = this.flatMat(0xffa23a, 0, this.getRuneTex());
    this.flat(group, this.ringGeo, ringM, 0.07, r);
    const rune = this.flat(group, this.discGeo, runeM, 0.08, r * 1.02);
    const field = new FireField(this.getRigHost(), fireFieldShape('zone', r), 0);
    const pl = newFirePlace();
    pl.x = z.x;
    pl.y = y0;
    pl.z = z.z;
    this.scene.add(group);
    let flash = 0;
    if (this.hasOpening(z)) {
      flash = 1;
      this.fireFlash(z.x, y0 + 1, z.z, r * 0.3);
      this.column(z.x, z.z, 0xff7a2a, 0.6, r * 0.3, 9, 0.3);
      this.ring(z.x, z.z, 0xff7a2a, 0.5, r * 1.1, 0.55, 0.08, 1);
      this.ring(z.x, z.z, 0xffffff, 0.3, r * 0.7, 0.4, 0.09, 0.8);
      this.emberShower(z.x, y0, z.z, r * 0.8, 26, { rise: 1.5 });
    }
    let lastPulse = now >= z.firstAt ? Math.floor((now - z.firstAt) / z.pulse) : -1;
    let flare = 0;
    let accE = 0, accS = 0, accF = 0, accG = 0, accM = 0;
    const disc = (k = 0.92) => {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * r * k;
      return [Math.cos(a) * d, Math.sin(a) * d] as const;
    };
    return {
      last: now,
      update: (zz, t, dt) => {
        const age = Math.max(0, (t - zz.start) / 1000);
        const left = Math.max(0, zz.end - t);
        const armed = t >= zz.firstAt;
        const prog = armed ? 1 : Math.min(1, (t - zz.start) / Math.max(1, zz.firstAt - zz.start));
        const fade = Math.min(1, left / Math.max(1, fxNum('flamestrike', 'fadeOutMs'))) * Math.min(1, age / Math.max(0.001, fxSec('flamestrike', 'popInMs')) * 0.85 + 0.15);
        const idx = armed ? Math.floor((t - zz.firstAt) / zz.pulse) : -1;
        if (idx > lastPulse) {
          lastPulse = idx;
          flare = 1;
          this.ring(zz.x, zz.z, 0xffa23a, r * 0.4, r, 0.4, 0.09, 0.9);
          this.ring(zz.x, zz.z, 0xe8500e, r * 0.3, r, 0.45, 0.075, 0.6, false);
          this.column(zz.x, zz.z, 0xff8a2a, 0.35, r * 0.16, 4, 0.25);
          this.emberShower(zz.x, y0, zz.z, r * 0.9, 12, { rise: 1.3 });
          this.fireFlash(zz.x, y0 + 0.8, zz.z, r * 0.12);
        }
        flare = Math.max(0, flare - dt * 2.8);
        flash = Math.max(0, flash - dt * 1.1);
        const build = armed ? Math.min(1, 0.45 + (t - zz.firstAt) / 700) : 0.12 + 0.3 * prog;
        // the ground ring (bright while gathering) and the runic sigil (a scorched mark once burning)
        ringM.opacity = (armed ? 0.65 + flare * 0.3 : 0.45 + 0.4 * Math.sin(t / 90) * 0.5 + 0.2) * fade;
        runeM.opacity = (armed ? 0.22 : 0.3 + 0.5 * prog) * fade;
        rune.rotation.z = age * (armed ? 0.5 : 1.6);
        pl.t = age;
        pl.build = build;
        pl.fade = fade;
        pl.flare = flare;
        pl.flash = flash;
        pl.scorch = Math.min(1, age / 3 + 0.1) * Math.min(1, left / 1200);
        field.place(pl, this.camera);
        // embers, flames and smoke
        accE += dt * (armed ? r * 5 : r * 1.2) * fade;
        if (accE > 1) {
          const n = Math.floor(accE);
          accE -= n;
          this.emberShower(zz.x, y0, zz.z, r * 0.92, n);
        }
        if (armed) {

          // meteors keep raining down on the circle while it burns
          accM += dt * (r * 4.2) * fade; // a downpour of small fireballs, like a blizzard of fire
          while (accM > 1) {
            accM--;
            const [mx, mz] = disc(0.95);
            this.meteor(zz.x + mx, zz.z + mz, y0, Math.random() < 0.08);
          }
          accS += dt * 3 * fade;
          if (accS > 1) {
            const n = Math.floor(accS);
            accS -= n;
            const [dx, dz] = disc(0.7);
            this.smokeWisps(zz.x + dx, y0 + 2.2, zz.z + dz, n, 1.1, { spread: 0.5 });
          }
        } else {
          // gathering: sparks drawn in from the rim
          accG += dt * r * 4 * prog;
          while (accG > 1) {
            accG--;
            const a = Math.random() * Math.PI * 2;
            this.particle(zz.x + Math.cos(a) * r, y0 + 0.2, zz.z + Math.sin(a) * r, { color: 0xffa23a, vx: -Math.cos(a) * r * 1.3, vz: -Math.sin(a) * r * 1.3, vy: rnd(0.3, 1.2), s0: 0.22, life: 0.7 });
          }
        }
      },
      dispose: () => {
        this.scene.remove(group);
        field.dispose();
        for (const m of [ringM, runeM]) m.dispose();
        // what is left once the fire is out: a scorch mark that fades slowly
        this.decal(z.x, z.z, 0x0e0705, r * 0.9, r * 1.05, 3, 0.5, false, 0.35, 0.045);
      },
    };
  }

  /** Blizzard-style storm of falling icicles and snow inside a circle for `duration` seconds. */
  iceStorm(x: number, z: number, radius: number, duration: number, y = 0) {
    const core = this.iceCore(x, y, z, radius);
    let t = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        core.update(t, Math.max(0, duration - t) * 1000, dt);
        return t >= duration;
      },
      dispose: () => core.dispose(),
    });
  }

  private iceZone(z: ZoneSnap, now: number): ZoneVfx {
    const core = this.iceCore(z.x, z.y ?? 0, z.z, z.r);
    return {
      last: now,
      update: (zz, t, dt) => core.update(Math.max(0, (t - zz.start) / 1000), Math.max(0, zz.end - t), dt),
      dispose: () => core.dispose(),
    };
  }

  private iceCore(x: number, y0: number, z: number, r: number) {
    const group = new THREE.Group();
    group.position.set(x, y0, z);
    const glowM = this.flatMat(0xa8dcff, 0.25);
    const ringM = this.flatMat(0x8fd0ff, 0.5);
    const runeM = this.flatMat(0xbfe8ff, 0.35, this.getRuneTex());
    const iceM = new THREE.MeshBasicMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.9 });
    const iceM2 = new THREE.MeshBasicMaterial({ color: 0xf2fbff, transparent: true, opacity: 0.9 });
    this.flat(group, this.discGeo, glowM, 0.05, r);
    this.flat(group, this.ringGeo, ringM, 0.07, r);
    const rune = this.flat(group, this.discGeo, runeM, 0.08, r);
    const n = Math.min(34, Math.round(8 + r * 3));
    const shards: THREE.Mesh[] = [];
    const sx = new Float32Array(n), sz = new Float32Array(n), sy = new Float32Array(n), sv = new Float32Array(n), sl = new Float32Array(n), ss = new Float32Array(n);
    const place = (i: number, high: number) => {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * r * 0.97;
      sx[i] = Math.cos(a) * d;
      sz[i] = Math.sin(a) * d;
      sy[i] = high + Math.random() * 7;
      sv[i] = rnd(20, 28);
      sl[i] = rnd(0.9, 1.7);
      ss[i] = rnd(-5, 5);
    };
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.iceGeo, i % 3 ? iceM : iceM2);
      m.rotation.order = 'YXZ';
      m.rotation.x = Math.PI + rnd(-0.18, 0.18);
      m.rotation.z = rnd(-0.18, 0.18);
      m.visible = false;
      group.add(m);
      shards.push(m);
      place(i, 12);
    }
    this.scene.add(group);
    this.ring(x, z, 0xbfe8ff, 0.4 * r, r, 0.5, 0.08, 0.9);
    this.burst(x, 0.5, z, 0xdff4ff, 14, 4, 0.3, 0.6, 3);
    let accS = 0, accM = 0;
    return {
      update: (age: number, leftMs: number, dt: number) => {
        const fade = Math.min(1, leftMs / Math.max(1, fxNum('blizzard', 'fadeOutMs'))) * Math.min(1, age / Math.max(0.001, fxSec('blizzard', 'popInMs')));
        const ending = leftMs < 600;
        glowM.opacity = (0.2 + 0.06 * Math.sin(age * 3)) * fade;
        ringM.opacity = 0.5 * fade;
        runeM.opacity = 0.35 * fade;
        rune.rotation.z = -age * 0.5;
        iceM.opacity = iceM2.opacity = 0.92;
        for (let i = 0; i < n; i++) {
          const m = shards[i];
          if (age < i * 0.025 || (ending && sy[i] > 11)) {
            m.visible = false;
            continue;
          }
          m.visible = true;
          sy[i] -= sv[i] * dt;
          if (sy[i] <= 0.1) {
            const wx = x + sx[i], wz = z + sz[i];
            this.burst(wx, 0.3, wz, 0xdff4ff, 4, 3, 0.22, 0.4, 5);
            this.particle(wx, 0.25, wz, { tex: 'glow', color: 0xbfe6ff, s0: 1.1, s1: 0.2, life: 0.22, a: 0.8 });
            if (Math.random() < 0.3) this.particle(wx, 0.3, wz, { tex: 'star', color: 0xffffff, s0: 0.5, s1: 0, life: 0.35, vy: 1.5, grav: 4 });
            place(i, ending ? 99 : 12);
            m.visible = !ending;
            continue;
          }
          m.position.set(sx[i], sy[i], sz[i]);
          m.rotation.y += ss[i] * dt;
          m.scale.set(1.7, sl[i], 1.7);
        }
        accS += dt * (14 + r * 4) * fade;
        while (accS > 1) {
          accS--;
          const a = Math.random() * Math.PI * 2;
          const d = Math.sqrt(Math.random()) * r;
          this.particle(x + Math.cos(a) * d, y0 + rnd(8, 12), z + Math.sin(a) * d, { tex: Math.random() < 0.25 ? 'star' : 'spark', color: 0xeaf6ff, vy: -rnd(4, 7), vx: rnd(-0.5, 0.5), s0: rnd(0.12, 0.24), s1: 0.08, life: 1.9, drag: 0 });
        }
        accM += dt * (r * 0.8) * fade;
        while (accM > 1) {
          accM--;
          const a = Math.random() * Math.PI * 2;
          const d = Math.sqrt(Math.random()) * r * 0.95;
          this.particle(x + Math.cos(a) * d, y0 + 0.3, z + Math.sin(a) * d, { tex: 'smoke', color: 0xcfeaff, add: false, vx: rnd(-0.7, 0.7), vz: rnd(-0.7, 0.7), vy: rnd(0.1, 0.4), s0: 1.2, s1: 2.8, life: rnd(1.6, 2.2), a: 0.28, drag: 0.3 });
        }
      },
      dispose: () => {
        this.scene.remove(group);
        for (const m of [glowM, ringM, runeM, iceM, iceM2]) m.dispose();
      },
    };
  }

  /** Battle Banner / Not Going Anywhere: a planted pole with a waving cloth. */
  private bannerZone(z: ZoneSnap, now: number, kind: 'battle' | 'flag'): ZoneVfx {
    const battle = kind === 'battle';
    const glow = battle ? 0xffd34a : 0x7fb0ff;
    const POLE = 3.2;
    const W = battle ? 2.1 : 2.2;
    const H = battle ? 1.5 : 1.6;
    const taper = battle ? 0.0 : 0.5;
    const group = new THREE.Group();
    group.position.set(z.x, z.y ?? 0, z.z);
    const glowM = this.flatMat(glow, 0.2);
    const ringM = this.flatMat(glow, 0.8);
    this.flat(group, this.discGeo, glowM, 0.05, z.r);
    this.flat(group, this.ringGeo, ringM, 0.07, z.r);
    let wall: THREE.Mesh | null = null;
    let wallM: THREE.MeshBasicMaterial | null = null;
    if (!battle) {
      // the banner holds enemies in: a faint curtain along the rim
      wallM = new THREE.MeshBasicMaterial({ color: glow, transparent: true, opacity: 0.1, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
      wall = new THREE.Mesh(this.beamGeo, wallM);
      wall.scale.set(z.r, 1.6, z.r);
      wall.position.y = 0.8;
      group.add(wall);
    }
    const lit = (color: number) => new THREE.MeshLambertMaterial({ color, emissive: 0x201810 });
    const woodM = lit(0x7a5230);
    const metalM = lit(battle ? 0xe8c25a : 0xaab4c8);
    const earthM = lit(0x5a4630);
    const spikeM = lit(0x6c7280);
    // pole, finial and crossbar
    const pole = new THREE.Group();
    pole.position.y = 7;
    group.add(pole);
    const shaft = new THREE.Mesh(this.poleGeo, woodM);
    shaft.scale.set(1, POLE, 1);
    shaft.position.y = POLE / 2;
    const finial = new THREE.Mesh(this.finialGeo, metalM);
    finial.position.y = POLE + 0.08;
    const bar = new THREE.Mesh(this.poleGeo, woodM);
    bar.rotation.z = Math.PI / 2;
    bar.scale.set(0.7, W * 0.95, 0.7);
    bar.position.set(W * 0.48, POLE - 0.1, 0);
    pole.add(shaft, finial, bar);
    // cloth: subdivided plane displaced by a travelling wave every frame
    const SU = 14, SV = 6;
    const geo = new THREE.PlaneGeometry(1, 1, SU, SV);
    const cnt = geo.attributes.position.count;
    const uv = new Float32Array(cnt * 2);
    for (let k = 0; k < cnt; k++) {
      uv[k * 2] = geo.attributes.uv.getX(k);
      uv[k * 2 + 1] = 1 - geo.attributes.uv.getY(k);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cnt * 3).fill(1), 3));
    const tex = this.bannerTexture(battle);
    const clothM = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, side: THREE.DoubleSide, transparent: true });
    const cloth = new THREE.Mesh(geo, clothM);
    cloth.frustumCulled = false;
    pole.add(cloth);
    // base: mound of earth and iron spikes
    const mound = new THREE.Mesh(this.moundGeo, earthM);
    mound.position.y = 0.05;
    mound.scale.setScalar(0.001);
    group.add(mound);
    const spikes: THREE.Mesh[] = [];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.3;
      const sp = new THREE.Mesh(this.spikeGeo, spikeM);
      sp.position.set(Math.cos(a) * 0.5, 0.2, Math.sin(a) * 0.5);
      sp.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
      sp.scale.setScalar(0.001);
      group.add(sp);
      spikes.push(sp);
    }
    group.rotation.y = (z.id * 2.399) % (Math.PI * 2);
    // keep the ground circle upright in world terms: it is round so rotation is harmless
    this.scene.add(group);
    let landed = false;
    let accM = 0;
    const phase = Math.random() * 6;
    const col = geo.attributes.color as THREE.BufferAttribute;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    return {
      last: now,
      update: (zz, t, dt) => {
        const age = Math.max(0, (t - zz.start) / 1000);
        const fade = endFade(zz.end - t);
        const drop = 0.22;
        const k = Math.min(1, age / drop);
        const sink = (1 - fade) * (1 - fade);
        pole.position.y = 7 * (1 - k * k) - sink * (POLE + 0.6);
        if (!landed && age >= drop) {
          landed = true;
          this.ring(zz.x, zz.z, 0xb89a6a, 0.3, 3.2, 0.5, 0.08, 0.9);
          this.ring(zz.x, zz.z, glow, 0.3, 2.2, 0.4, 0.09, 0.9);
          for (let q = 0; q < 8; q++) {
            const a = Math.random() * Math.PI * 2;
            this.particle(zz.x + Math.cos(a) * 0.4, (zz.y ?? 0) + 0.2, zz.z + Math.sin(a) * 0.4, { tex: 'smoke', color: 0xa38d6a, add: false, vx: Math.cos(a) * 2.2, vz: Math.sin(a) * 2.2, vy: rnd(0.4, 1), s0: 0.6, s1: 1.7, life: rnd(0.6, 0.9), a: 0.6, drag: 2 });
          }
          this.burst(zz.x, (zz.y ?? 0) + 0.3, zz.z, glow, 14, 4, 0.3, 0.5, 6);
        }
        const since = age - drop;
        const land = Math.min(1, Math.max(0, since / 0.25));
        const shake = since > 0 && since < 0.5 ? 0.1 * Math.exp(-since * 7) * Math.sin(since * 45) : 0;
        pole.rotation.z = shake;
        mound.scale.setScalar(Math.max(0.001, land) * (battle ? 1 : 1.1));
        for (const sp of spikes) sp.scale.setScalar(Math.max(0.001, land) * 1);
        // cloth
        const un = unfurlProgress(age) * fade;
        cloth.visible = un > 0.01;
        clothM.opacity = Math.min(1, fade * 1.4);
        const ts = t / 1000 + phase;
        const top = POLE - 0.12;
        const w = W * un;
        for (let iy = 0, v0 = 0; iy <= SV; iy++) {
          const v = iy / SV;
          for (let ix = 0; ix <= SU; ix++, v0++) {
            const u = ix / SU;
            const hh = H * (1 - taper * u);
            const wv = clothWave(u, v, ts) * un;
            pos.setXYZ(v0, 0.05 + u * w, top - v * hh, wv);
            const s = clothShade(u, v, ts);
            col.setXYZ(v0, s, s, s);
          }
        }
        pos.needsUpdate = true;
        col.needsUpdate = true;
        // ground circle and rising motes
        const rise = Math.min(1, age / 0.5);
        glowM.opacity = (0.16 + 0.05 * Math.sin(t / 450)) * fade * rise;
        ringM.opacity = (0.7 + 0.15 * Math.sin(t / 300)) * fade * rise;
        if (wallM) wallM.opacity = (0.09 + 0.04 * Math.sin(t / 260)) * fade * rise;
        if (wall) wall.rotation.y = age * 0.3;
        accM += dt * zz.r * 2.2 * fade * rise;
        while (accM > 1) {
          accM--;
          const a = Math.random() * Math.PI * 2;
          const d = zz.r * rnd(0.9, 1.0);
          this.particle(zz.x + Math.cos(a) * d, (zz.y ?? 0) + 0.1, zz.z + Math.sin(a) * d, { color: glow, vy: rnd(1.1, 2.4), s0: rnd(0.16, 0.26), life: 0.9, drag: 0.3 });
        }
      },
      dispose: () => {
        this.scene.remove(group);
        geo.dispose();
        tex.dispose();
        for (const m of [glowM, ringM, clothM, woodM, metalM, earthM, spikeM]) m.dispose();
        wallM?.dispose();
      },
    };
  }

  private poleGeo = new THREE.CylinderGeometry(0.05, 0.065, 1, 6);
  private finialGeo = new THREE.SphereGeometry(0.11, 8, 6);
  private moundGeo = new THREE.ConeGeometry(0.7, 0.35, 10).translate(0, 0.17, 0);
  private spikeGeo = new THREE.ConeGeometry(0.06, 0.6, 5).translate(0, 0.3, 0);

  private bannerTexture(battle: boolean): THREE.Texture {
    const w = 160, h = 112;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    const star = (cx: number, cy: number, ro: number, ri: number, col: string) => {
      g.fillStyle = col;
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 ? ri : ro;
        i ? g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr) : g.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      g.closePath();
      g.fill();
    };
    if (battle) {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#c4202a');
      grad.addColorStop(1, '#7c0f1a');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffd34a';
      g.fillRect(0, 0, w, 9);
      g.fillRect(0, h - 9, w, 9);
      g.fillRect(0, 0, 7, h);
      g.strokeStyle = '#ffd34a';
      g.lineWidth = 3;
      g.strokeRect(14, 16, w - 26, h - 32);
      g.lineWidth = 6;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(52, 82); g.lineTo(108, 30);
      g.moveTo(108, 82); g.lineTo(52, 30);
      g.stroke();
      star(80, 56, 20, 8, '#ffe98a');
      g.strokeStyle = '#ffd34a';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(80, 56, 27, 0, Math.PI * 2);
      g.stroke();
    } else {
      const grad = g.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#2c64c0');
      grad.addColorStop(1, '#183a80');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#cfd8e8';
      g.fillRect(0, 0, 7, h);
      g.strokeStyle = '#9fb3d6';
      g.lineWidth = 8;
      for (let i = 0; i < 4; i++) {
        g.beginPath();
        g.moveTo(24, 6 + i * 30);
        g.lineTo(w * 0.55, 36 + i * 30);
        g.lineTo(w * 0.9, 6 + i * 30);
        g.stroke();
      }
      // shackle ring barred shut
      g.strokeStyle = '#f2f6ff';
      g.lineWidth = 7;
      g.beginPath();
      g.arc(70, 56, 24, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(40, 56); g.lineTo(100, 56);
      g.stroke();
      g.fillStyle = '#f2f6ff';
      g.fillRect(64, 36, 12, 40);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** Rune of Power: a rotating arcane circle with glyphs drifting above it. */
  private runeZone(z: ZoneSnap, now: number): ZoneVfx {
    const r = z.r;
    const y0 = z.y ?? 0;
    const group = new THREE.Group();
    group.position.set(z.x, y0, z.z);
    const tex = this.getRuneTex();
    const outerM = this.flatMat(0xa070ff, 0.6, tex);
    const innerM = this.flatMat(0xc8a0ff, 0.45, tex);
    const glowM = this.flatMat(0x8a4dff, 0.2);
    const ringM = this.flatMat(0x9a6dff, 0.8);
    this.flat(group, this.discGeo, glowM, 0.05, r);
    const outer = this.flat(group, this.discGeo, outerM, 0.07, r);
    const inner = this.flat(group, this.discGeo, innerM, 0.08, r * 0.62);
    this.flat(group, this.ringGeo, ringM, 0.09, r);
    const glyphs: { s: THREE.Sprite; a: number; rad: number; h: number; sp: number }[] = [];
    for (let k = 0; k < 6; k++) {
      const s = this.sprite('glow', 0xd9b8ff);
      (s.material as THREE.SpriteMaterial).map = this.getGlyph(k);
      s.material.needsUpdate = true;
      glyphs.push({ s, a: (k / 6) * Math.PI * 2, rad: r * (0.35 + 0.15 * (k % 2)), h: 1.2 + 0.2 * k, sp: k % 2 ? 0.5 : -0.4 });
    }
    this.scene.add(group);
    this.ring(z.x, z.z, 0xa070ff, 0.5, r, 0.5, 0.1, 0.6);
    this.burst(z.x, y0 + 0.5, z.z, 0xc58bff, 18, 4, 0.35, 0.6, 0);
    let accM = 0;
    return {
      last: now,
      update: (zz, t, dt) => {
        const age = Math.max(0, (t - zz.start) / 1000);
        const fade = endFade(zz.end - t);
        const grow = 0.25 + 0.75 * (1 - Math.pow(1 - Math.min(1, age / 0.4), 2));
        outer.scale.set(r * grow, r * grow, 1);
        inner.scale.set(r * 0.62 * grow, r * 0.62 * grow, 1);
        outer.rotation.z = age * 0.35;
        inner.rotation.z = -age * 0.7;
        outerM.opacity = (0.4 + 0.08 * Math.sin(t / 300)) * fade;
        innerM.opacity = (0.35 + 0.1 * Math.sin(t / 240 + 1)) * fade;
        glowM.opacity = (0.14 + 0.04 * Math.sin(t / 450)) * fade;
        ringM.opacity = (0.4 + 0.1 * Math.sin(t / 300)) * fade;
        for (const g of glyphs) {
          const a = g.a + age * g.sp;
          const bob = Math.sin(age * 1.8 + g.a * 3) * 0.25;
          g.s.position.set(zz.x + Math.cos(a) * g.rad * grow, y0 + g.h + bob, zz.z + Math.sin(a) * g.rad * grow);
          const sc = (0.75 + 0.1 * Math.sin(age * 3 + g.a)) * fade;
          g.s.scale.set(sc, sc, 1);
          (g.s.material as THREE.SpriteMaterial).opacity = 0.9 * fade;
        }
        accM += dt * r * 1.6 * fade;
        while (accM > 1) {
          accM--;
          const a = Math.random() * Math.PI * 2;
          const d = Math.sqrt(Math.random()) * r * 0.95;
          this.particle(zz.x + Math.cos(a) * d, y0 + 0.1, zz.z + Math.sin(a) * d, { color: Math.random() < 0.5 ? 0xb48cff : 0xe0c8ff, vy: rnd(0.8, 1.8), s0: rnd(0.15, 0.25), life: 1.1, drag: 0.3 });
        }
      },
      dispose: () => {
        this.scene.remove(group);
        for (const m of [outerM, innerM, glowM, ringM]) m.dispose();
        for (const g of glyphs) {
          this.scene.remove(g.s);
          g.s.visible = false;
          (g.s.material as THREE.SpriteMaterial).opacity = 1;
          this.pool.push(g.s);
        }
      },
    };
  }

  setZones(zones: ZoneSnap[], now: number) {
    const seen = new Set<number>();
    const seenSmoke = new Set<number>();
    for (const z of zones) {
      if (z.smoke) {
        this.setSmoke(z, now, seenSmoke);
        continue;
      }
      seen.add(z.id);
      let v = this.zoneVfx.get(z.id);
      if (!v) {
        v = this.makeZoneVfx(z, now);
        this.zoneVfx.set(z.id, v);
      }
      const dt = Math.min(0.1, Math.max(0, (now - v.last) / 1000));
      v.last = now;
      v.update(z, now, dt);
    }
    for (const [id, m] of this.smokeMeshes) {
      if (seenSmoke.has(id)) continue;
      this.scene.remove(m.group);
      for (const c of m.group.children) (c as THREE.Mesh).material && ((c as THREE.Mesh).material as THREE.Material).dispose();
      this.smokeMeshes.delete(id);
    }
    for (const [id, v] of this.zoneVfx) {
      if (seen.has(id)) continue;
      v.dispose();
      this.zoneVfx.delete(id);
    }
  }

  update(dt: number, units: EffectUnit[]) {
    this.clock += dt;
    this.ids = units.map((u) => u.id);

    // timers
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.clock >= this.timers[i].at) {
        const { fn } = this.timers[i];
        this.timers.splice(i, 1);
        fn();
      }
    }

    // fx
    for (let i = this.fx.length - 1; i >= 0; i--) {
      if (this.fx[i].update(dt)) {
        this.fx[i].dispose();
        this.fx.splice(i, 1);
      }
    }

    // the shared fireball light: follows the strongest fireball (or the flash of a hit), dark when there is none
    let want = this.lightWant;
    this.lightWant = 0;
    if (this.lightFlash > 0.5) {
      this.lightFlash *= Math.exp(-dt * 6);
      if (this.lightFlash > want) {
        want = this.lightFlash;
        this.lightPos.copy(this.lightFlashPos);
      }
    } else this.lightFlash = 0;
    this.lightCur += (want - this.lightCur) * Math.min(1, dt * 24);
    if (this.lightCur < 0.05 && want === 0) this.lightCur = 0;
    this.fireLight.intensity = this.lightCur;
    if (want > 0) this.fireLight.position.copy(this.lightPos);

    // particles
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.sprite);
        p.sprite.visible = false;
        this.pool.push(p.sprite);
        this.parts.splice(i, 1);
        continue;
      }
      const k = 1 - p.life / p.max;
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vx *= damp;
      p.vz *= damp;
      p.vy = p.vy * damp - p.grav * dt;
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y = Math.max(0.03, p.sprite.position.y + p.vy * dt);
      p.sprite.position.z += p.vz * dt;
      const s = p.s0 + (p.s1 - p.s0) * k;
      p.sprite.scale.set(Math.max(0.001, s), Math.max(0.001, s), 1);
      const pm = p.sprite.material as THREE.SpriteMaterial;
      pm.opacity = p.a0 * (1 - k * k);
      if (p.spin) pm.rotation += p.spin * dt;
      if (p.fade) pm.color.setRGB(p.cr + (p.er - p.cr) * k, p.cg + (p.eg - p.cg) * k, p.cb + (p.eb - p.cb) * k);
      if (p.fps && this.fireFrames) {
        const f = (p.ph + Math.floor((p.max - p.life) * p.fps)) % FIRE_FRAMES;
        if (f !== p.frame) {
          p.frame = f;
          pm.map = this.fireFrames[f];
        }
      }
    }

    // persistent aura visuals
    const wanted = new Set<string>();
    const wantedLayers = new Set<string>();
    for (const u of units) {
      const prev = this.prevPos.get(u.id);
      const moving = !!prev && Math.hypot(u.x - prev.x, u.z - prev.z) / Math.max(dt, 0.001) > 1;
      this.prevPos.set(u.id, { x: u.x, z: u.z });
      this.unitAuras.set(u.id, u.alive ? u.auras : []);
      if (!u.alive) continue;
      for (const a of u.auras) {
        const vis = AURA_VISUAL[a];
        if (vis) {
          const lk = `${u.id}:${a}`;
          wantedLayers.add(lk);
          let l = this.layers.get(lk);
          if (!l) {
            l = this.makeLayer(a, vis);
            this.layers.set(lk, l);
          }
          l.x = u.x;
          l.y = u.y;
          l.z = u.z;
          l.sc = u.scale ?? 1;
        }
        const key = `${u.id}:${a}`;
        wanted.add(key);
        let att = this.attach.get(key);
        if (!att) {
          const made = this.makeAttachment(a);
          if (!made) {
            this.attach.set(key, { group: new THREE.Group(), update: () => {} });
            continue;
          }
          att = made;
          this.attach.set(key, att);
        }
        att.group.position.set(u.x, u.y, u.z);
        att.update(dt, this.clock, u, moving);
      }
    }
    for (const [key, att] of this.attach) {
      if (wanted.has(key)) continue;
      (att as Attachment & { dispose?: () => void }).dispose?.();
      this.attach.delete(key);
    }

    // lasting aura layers fade in, and fade out once their aura (or the unit) is gone
    for (const k of this.layerBook.step(wantedLayers, dt)) {
      this.layers.get(k)?.dispose();
      this.layers.delete(k);
    }
    for (const [k, l] of this.layers) {
      l.age += dt;
      l.update(dt, layerAlpha(l.age, this.layerBook.goneFor(k)), this.clock);
    }
  }


}
