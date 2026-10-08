import * as THREE from 'three';
import { ABILITIES, AURAS } from '@arena/shared';
import type { AbilityDef, School, SimEvent, ZoneSnap } from '@arena/shared';
import { clothShade, clothWave, endFade, unfurlProgress } from './flagCloth';
import { AURA_VISUAL, LayerBook, hotAuras, impactKindFor, isDotTick, layerAlpha, visualFor } from './skillVisuals';
import type { AuraStyle, AuraVisual, ImpactKind } from './skillVisuals';

/**
 * Spell and combat visuals, driven entirely by sim events plus the aura list on each unit.
 * Purely cosmetic: nothing here feeds back into the simulation or the protocol.
 */

export interface EffectUnit {
  id: number;
  x: number;
  z: number;
  facing: number;
  alive: boolean;
  auras: string[];
  /** Model size relative to a normal unit (default 1); aura visuals around the body scale with it. */
  scale?: number;
}

interface Pos {
  x: number;
  z: number;
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
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _x = new THREE.Vector3(1, 0, 0);
const _y = new THREE.Vector3(0, 1, 0);

const rnd = (a = -1, b = 1) => a + Math.random() * (b - a);

export class Effects {
  private tex = buildTextures();
  private parts: Particle[] = [];
  private pool: THREE.Sprite[] = [];
  private fx: Fx[] = [];
  private timers: { at: number; fn: () => void }[] = [];
  private flights = new Map<string, number>();
  private casting = new Map<number, Fx & { stop(): void }>();
  private attach = new Map<string, Attachment>();
  private prevPos = new Map<number, { x: number; z: number }>();
  private clock = 0;
  private ringGeo = new THREE.RingGeometry(0.88, 1, 56);
  private discGeo = new THREE.CircleGeometry(1, 40);
  private sphereGeo = new THREE.SphereGeometry(1, 24, 16);
  private beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
  private slashGeo = new THREE.RingGeometry(0.55, 0.68, 24, 1, 0, 2.3);
  private slashGeoThin = new THREE.RingGeometry(0.6, 0.63, 24, 1, 0.1, 2.1);
  private iceGeo = new THREE.ConeGeometry(0.13, 1, 5);

  /** Fired for melee abilities so the model can play its swing. */
  onSwing: (unit: number, fast?: boolean) => void = () => {};
  /** Fired when a unit takes a hit so the model can flash. */
  onHit: (unit: number) => void = () => {};

  /** Ground height under a point (bridge arenas); rings and zones sit on it. */
  groundY: (x: number, z: number) => number = () => 0;
  constructor(private scene: THREE.Scene, private pos: (id: number) => Pos | null) {}

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
    o: { tex?: TexName; color: number; vx?: number; vy?: number; vz?: number; life?: number; s0?: number; s1?: number; a?: number; grav?: number; drag?: number; add?: boolean; spin?: number },
  ) {
    if (this.parts.length > 700) return;
    const sp = this.sprite(o.tex ?? 'spark', o.color, o.add ?? true);
    sp.position.set(x, y, z);
    const s0 = o.s0 ?? 0.3;
    sp.scale.set(s0, s0, 1);
    this.parts.push({
      sprite: sp, vx: o.vx ?? 0, vy: o.vy ?? 0, vz: o.vz ?? 0,
      life: o.life ?? 0.6, max: o.life ?? 0.6, s0, s1: o.s1 ?? 0, a0: o.a ?? 1,
      grav: o.grav ?? 0, drag: o.drag ?? 0, spin: o.spin ?? 0,
    });
  }

  /** Burst of sparks flying outward. */
  private burst(x: number, y: number, z: number, color: number, n: number, speed = 3.5, size = 0.28, life = 0.55, grav = 3) {
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

  /** Flat ring on the ground that expands and fades. */
  private ring(x: number, z: number, color: number, from: number, to: number, life: number, y = 0.07, opacity = 0.9) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y + this.groundY(x, z), z);
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

  /** Vertical column of light on a spot. */
  private column(x: number, z: number, color: number, life = 0.7, radius = 0.55, height = 6, op = 0.55) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(this.beamGeo, mat);
    mesh.position.set(x, height / 2, z);
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
    group.position.set(tx, y, tz);
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

  private projectile(srcId: number, tgtId: number, school: School, kind: 'frost' | 'fire' | 'holy' | 'arcane' | 'shadow', size = 1, swirl = 0) {
    const s = this.pos(srcId);
    if (!s) return 0;
    const color = SCHOOL_COLOR[school];
    const core = this.sprite('spark', 0xffffff);
    const halo = this.sprite('glow', color);
    core.scale.set(0.7 * size, 0.7 * size, 1);
    halo.scale.set(1.7 * size, 1.7 * size, 1);
    // volley missiles leave from alternating sides of the caster and curve in towards the target
    const side = Math.random() < 0.5 ? -1 : 1;
    const hand = swirl ? side * rnd(0.3, 0.6) : 0;
    const p = new THREE.Vector3(s.x + Math.sin(s.facing) * 0.6 + Math.cos(s.facing) * hand, 1.5 + (swirl ? rnd(-0.1, 0.5) : 0), s.z + Math.cos(s.facing) * 0.6 - Math.sin(s.facing) * hand);
    const q = p.clone();
    core.position.copy(p);
    halo.position.copy(p);
    const first = this.pos(tgtId);
    const flight = first ? Math.hypot(first.x - p.x, first.z - p.z) / PROJECTILE_SPEED : 0.2;
    let t = 0;
    let trail = 0;
    this.addFx({
      update: (dt) => {
        t += dt;
        const tp = this.pos(tgtId);
        const to = tp ? new THREE.Vector3(tp.x, CHEST, tp.z) : p;
        const d = to.clone().sub(p);
        const step = PROJECTILE_SPEED * dt;
        const done = d.length() <= step + 0.4 || t > 3;
        const remaining = d.length();
        if (!done) p.addScaledVector(d.normalize(), step);
        q.copy(p);
        if (swirl) {
          const prog = Math.min(1, Math.max(0, 1 - remaining / Math.max(1, flight * PROJECTILE_SPEED)));
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
        while (trail > 0.016) {
          trail -= 0.016;
          if (kind === 'fire') {
            this.flame(q.x, q.y - 0.1, q.z, 0.55 * size);
            if (Math.random() < 0.3) this.particle(q.x, q.y, q.z, { tex: 'smoke', color: 0x332a26, add: false, s0: 0.3, s1: 0.9, life: 0.6, a: 0.5, vy: 0.6 });
          } else if (kind === 'frost') {
            this.particle(q.x + rnd(-0.12, 0.12), q.y + rnd(-0.12, 0.12), q.z + rnd(-0.12, 0.12), { tex: Math.random() < 0.3 ? 'star' : 'spark', color: Math.random() < 0.5 ? 0xbfeaff : 0x5cb8ff, vy: rnd(-0.4, 0.4), s0: 0.32 * size, life: 0.45, drag: 2 });
          } else {
            this.particle(q.x + rnd(-0.15, 0.15), q.y + rnd(-0.15, 0.15), q.z + rnd(-0.15, 0.15), { tex: Math.random() < 0.4 ? 'star' : 'spark', color: kind === 'holy' ? 0xfff1a8 : color, vy: rnd(0, 0.5), s0: 0.34, life: 0.5, drag: 2 });
          }
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
    const sy = 1.6;
    let t = 0;
    let trail = 0;
    let tx = t0.x, tz = t0.z;
    this.addFx({
      update: (dt) => {
        t += dt;
        const tp = this.pos(tgtId);
        if (tp) {
          tx = tp.x;
          tz = tp.z;
        }
        const k = Math.min(1, t / AXE_FLIGHT);
        const px = sx + (tx - sx) * k;
        const pz = sz + (tz - sz) * k;
        const py = sy + (CHEST - sy) * k + Math.sin(Math.PI * k) * 0.9;
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
          this.burst(px, CHEST, pz, 0xfff0c0, 14, 6, 0.26, 0.4, 5);
          this.burst(px, CHEST, pz, 0xdfe6f2, 8, 4, 0.22, 0.35, 3);
          this.particle(px, CHEST, pz, { tex: 'star', color: 0xffffff, s0: 0.3, s1: 2.2, life: 0.18 });
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
        const dy = CHEST - 1.3;
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
          _o.position.set(ax + _v.x * dist, 1.3 + _v.y * dist - sag, az + _v.z * dist);
          _o.quaternion.copy(_q);
          _o.rotateX(i % 2 ? Math.PI / 2 : 0);
          _o.scale.set(1.35, 1, 1);
          _o.updateMatrix();
          mesh.setMatrixAt(i, _o.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        hook.position.set(ax + _v.x * len, 1.3 + _v.y * len, az + _v.z * len);
        hook.quaternion.setFromUnitVectors(_y, _v);
        hook.rotateX(Math.PI); // barb points at the target
        if (t < 0.15 && Math.random() < 0.8) this.particle(b.x, CHEST, b.z, { color: 0xdfe6f2, vx: rnd(-2, 2), vz: rnd(-2, 2), vy: rnd(0, 2), s0: 0.2, life: 0.25, drag: 2 });
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

  /** Flames, ice, shadow or light shooting up out of the ground under a point, with a ring, a scorch mark and sparks. */
  groundEruption(x: number, z: number, kind: ImpactKind, scale = 1) {
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
    if (kind === 'fire') this.puff(x, gy + 0.5, z, 0x2f2622, 4, 1.5 * scale);
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
          if (kind === 'fire') this.flame(x + Math.cos(a) * r, gy + 0.1, z + Math.sin(a) * r, 0.9 * scale);
          else this.particle(x + Math.cos(a) * r, gy + 0.1, z + Math.sin(a) * r, { color: P.spark, vy: rnd(2, 4), s0: 0.22, life: 0.5, drag: 0.8 });
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
  impactAt(tgt: number | { x: number; z: number }, kind: ImpactKind, scale = 1, y = CHEST) {
    const p = typeof tgt === 'number' ? this.pos(tgt) : tgt;
    if (!p) return;
    const P = ERUPT[kind];
    this.particle(p.x, y, p.z, { tex: 'star', color: 0xffffff, s0: 0.4 * scale, s1: 2.6 * scale, life: 0.2 });
    this.particle(p.x, y, p.z, { tex: 'glow', color: P.col, s0: 0.6 * scale, s1: 3.2 * scale, life: 0.35, a: 0.8 });
    this.ring(p.x, p.z, P.col, 0.3, 2.0 * scale, 0.4, 0.08, 0.9);
    this.ring(p.x, p.z, P.col, 0.2 * scale, 1.7 * scale, 0.3, y, 0.7); // shock disc at body height
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
        this.puff(p.x, HEAD - 0.1, p.z, 0xc9b99a, 5, 1.1 * scale);
        break;
      default:
        break;
    }
  }

  /** A spiral of motes winding up around a target (polymorph, dispel, leaps of faith). */
  swirlAt(tgt: number | { x: number; z: number }, kind: ImpactKind, scale = 1) {
    const P = ERUPT[kind];
    let t = 0;
    let acc = 0;
    this.addFx({
      update: (dt) => {
        const p = typeof tgt === 'number' ? this.pos(tgt) : tgt;
        if (!p) return true;
        t += dt;
        acc += dt;
        while (acc > 0.025) {
          acc -= 0.025;
          const k = Math.min(1, t / 0.6);
          for (const o of [0, Math.PI]) {
            const a = t * 14 + o;
            const r = (1.0 - 0.55 * k) * scale;
            this.particle(p.x + Math.cos(a) * r, 0.2 + k * 1.9, p.z + Math.sin(a) * r, { tex: k > 0.5 ? 'star' : 'glow', color: o ? P.core : P.col, s0: 0.3 * scale, s1: 0.1, life: 0.35 });
          }
        }
        if (t >= 0.6) {
          this.burst(p.x, 2, p.z, P.spark, 12, 3, 0.3, 0.5, 0);
          this.ring(p.x, p.z, P.col, 0.4, 1.8 * scale, 0.4);
          return true;
        }
        return false;
      },
      dispose: () => {},
    });
  }

  /** Fan of flames out along a cone (Dragon's Breath) in place of the old beams. */
  private coneFlames(s: Pos, r: number, half: number, color: number) {
    for (const e of [-half * 0.8, -half * 0.35, 0, half * 0.35, half * 0.8]) {
      for (let d = 1.5; d < r; d += 2) {
        this.later(d * 0.025, () => {
          const a = s.facing + e;
          if (color === SCHOOL_COLOR.fire) this.flame(s.x + Math.sin(a) * d, 0.6 + rnd(0, 0.5), s.z + Math.cos(a) * d, 1.2 + d * 0.06);
          else this.particle(s.x + Math.sin(a) * d, 0.8, s.z + Math.cos(a) * d, { color, s0: 0.9, s1: 0.2, life: 0.4 });
        });
      }
    }
  }

  /** The table-driven result of an instant spell, drawn at (or under) the target. */
  private hitVisual(h: { kind: ImpactKind; style: 'eruption' | 'impact' | 'pillar' | 'swirl' }, p: { x: number; z: number }, target: number) {
    switch (h.style) {
      case 'eruption':
        this.groundEruption(p.x, p.z, h.kind, 1);
        this.impactAt(p, h.kind, 0.55); // and a flare around the body
        break;
      case 'swirl':
        if (target) this.swirlAt(target, h.kind);
        else this.swirlAt(p, h.kind);
        this.impactAt(p, h.kind, 0.6);
        break;
      case 'pillar':
        this.column(p.x, p.z, ERUPT[h.kind].col, 0.5, 0.7, 7);
        this.impactAt(p, h.kind, 0.7);
        break;
      default:
        this.impactAt(p, h.kind, 1);
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
          this.particle(p.x + Math.cos(a) * 0.9, rnd(0.6, 1.8), p.z + Math.sin(a) * 0.9, { tex: 'glow', color: 0x8a3dff, vx: -Math.cos(a) * 3, vz: -Math.sin(a) * 3, s0: 0.4, s1: 0.1, life: 0.3 });
        }
        this.particle(p.x, CHEST, p.z, { tex: 'glow', color: 0x7a2fd8, s0: 0.5, s1: 2.2, life: 0.35, a: 0.8 });
        break;
      case 'bleed':
        for (let i = 0; i < 6; i++) this.particle(p.x + rnd(-0.25, 0.25), rnd(0.8, 1.6), p.z + rnd(-0.25, 0.25), { color: 0xb8101c, add: false, vx: rnd(-1, 1), vz: rnd(-1, 1), vy: rnd(0.5, 2), s0: 0.24, s1: 0.14, life: 0.6, grav: 9 });
        this.ring(p.x, p.z, 0xc01820, 0.3, 1.3, 0.35, 0.06, 0.7 * s);
        break;
      case 'burn':
        for (let i = 0; i < 3; i++) this.flame(p.x + rnd(-0.3, 0.3), 0.6 + rnd(0, 0.8), p.z + rnd(-0.3, 0.3), 0.7);
        this.burst(p.x, CHEST, p.z, 0xffc060, 5, 3, 0.2, 0.5, 2);
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
        this.puff(p.x, 1.0, p.z, 0x2a1040, 3, 1.1);
        break;
      case 'bleed':
        this.burst(p.x, CHEST, p.z, 0xc01820, 8, 3, 0.2, 0.5, 8);
        this.ring(p.x, p.z, 0xc01820, 0.3, 1.5, 0.4, 0.06, 0.8);
        break;
      case 'burn':
        for (let i = 0; i < 3; i++) this.flame(p.x + rnd(-0.3, 0.3), 0.6 + rnd(0, 0.8), p.z + rnd(-0.3, 0.3), 0.9);
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
            this.particle(wx(l, Math.cos(ang) * 0.6), 0.2, l.z + Math.sin(ang) * 0.6 * l.sc, { tex: 'glow', color: 0xb06bff, vy: rnd(0.6, 1.2), s0: 0.22 * l.sc, s1: 0.05, life: 1.0, a: 0.8 });
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
            this.particle(wx(l, spots[sIdx][0]), spots[sIdx][1] * l.sc, l.z + spots[sIdx][2] * l.sc, { color: 0xb8101c, add: false, s0: 0.22 * l.sc, s1: 0.14 * l.sc, life: 0.8, grav: 9, a: 1 });
          }
        };
        break;
      }
      case 'burn': {
        const glows = [sp('glow', 0xff5a14, 1.3), sp('glow', 0xff9a3a, 0.8)];
        const ring = flat(0xff6a1a, 0.4, this.ringGeo, 0.75);
        upd = (l, dt, a, t) => {
          glows[0].position.set(0, 1.1, 0);
          glows[1].position.set(0.1 * Math.sin(t * 3), 1.5, 0.1 * Math.cos(t * 4));
          const fl = 1 + 0.2 * Math.sin(t * 17) + 0.15 * Math.sin(t * 29) + l.flare * 0.8;
          glows[0].scale.set(1.3 * fl, 1.6 * fl, 1);
          glows[1].scale.set(0.8 * fl, 0.8 * fl, 1);
          glows.forEach((g) => opac(g, a * S * (0.22 + l.flare * 0.35)));
          ring.mat.opacity = ring.op * a * S * (0.7 + 0.3 * Math.sin(t * 13) + l.flare);
          acc += dt * 20 * S * a;
          while (acc > 1) {
            acc -= 1;
            const ang = Math.random() * Math.PI * 2;
            const r = rnd(0.1, 0.45) * l.sc;
            this.flame(l.x + Math.cos(ang) * r, rnd(0.4, 1.8) * l.sc, l.z + Math.sin(ang) * r, 0.42 * l.sc);
            if (Math.random() < 0.3) this.particle(l.x + Math.cos(ang) * r, rnd(0.6, 1.6) * l.sc, l.z + Math.sin(ang) * r, { color: 0xffb040, vy: rnd(1.2, 2.2), s0: 0.1 * l.sc, life: 1.0, drag: 0.3 });
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
            this.particle(l.x + Math.cos(ang) * 0.6 * l.sc, 0.15, l.z + Math.sin(ang) * 0.6 * l.sc, { tex: 'smoke', color: 0xbfe8ff, add: false, s0: 0.35 * l.sc, s1: 0.9 * l.sc, life: 0.9, a: 0.35, vy: 0.35, vx: rnd(-0.2, 0.2) });
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
            this.particle(l.x + rnd(-0.3, 0.3) * l.sc, rnd(0.4, 1.6) * l.sc, l.z + rnd(-0.3, 0.3) * l.sc, { tex: 'smoke', color: 0x5aa83a, add: false, vy: 0.6, s0: 0.2, s1: 0.5, life: 0.8, a: 0.4 });
          }
        };
      }
    }
    const layer: Layer = {
      group, x: 0, z: 0, sc: 1, age: 0, flare: 0,
      update: (dt, a, t) => {
        layer.flare = Math.max(0, layer.flare - dt * 3.5);
        group.position.set(layer.x, 0, layer.z);
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
      },
    };
    void aura;
    return layer;
  }

  // ------------------------------------------------------------ casting

  private startCast(unit: number, ability: string) {
    this.stopCast(unit);
    const def = ABILITIES[ability];
    if (!def) return;
    const color = SCHOOL_COLOR[def.school];
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
        orb.position.set(hx, 1.55, hz);
        core.position.set(hx, 1.55, hz);
        const pulse = 1 + Math.sin(t * 22) * 0.15;
        orb.scale.set((0.5 + grow * 0.9) * pulse, (0.5 + grow * 0.9) * pulse, 1);
        core.scale.set(0.25 + grow * 0.4, 0.25 + grow * 0.4, 1);
        rune.position.set(p.x, 0.06, p.z);
        a.rotation.z = t * 1.8;
        b.rotation.z = -t * 2.6;
        rune.scale.setScalar(0.9 + Math.sin(t * 5) * 0.04);
        acc += dt;
        while (acc > 0.05) {
          acc -= 0.05;
          const ang = Math.random() * Math.PI * 2;
          const r = rnd(1.2, 1.8);
          this.particle(p.x + Math.cos(ang) * r, rnd(0.2, 1.6), p.z + Math.sin(ang) * r, {
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
        this.ring(ev.x, ev.z, 0xffd34a, 0.4, 3, 0.5, 0.08, 1);
        break;
      case 'cast_fail':
        this.stopCast(ev.unit);
        break;
      case 'interrupt': {
        this.stopCast(ev.tgt);
        const p = this.pos(ev.tgt);
        if (p) {
          const c = SCHOOL_COLOR[ev.school] ?? 0xffffff;
          this.burst(p.x, HEAD, p.z, 0xff5a4d, 14, 4, 0.3, 0.5, 0);
          const s = this.sprite('star', 0xff4d3d);
          s.position.set(p.x, HEAD + 0.2, p.z);
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
            this.slash(p.x - Math.sin(ang) * 1.1, p.z - Math.cos(ang) * 1.1, p.x + Math.sin(ang) * 1.1, p.z + Math.cos(ang) * 1.1, 0xe9eef7, 0.6, CHEST + Math.sin(ang * 2) * 0.4);
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
            this.burst(q.x, CHEST, q.z, 0xfff1a8, 10, 3, 0.25, 0.4, 0);
            return;
          }
          if (quiet) {
            this.burst(q.x, CHEST, q.z, color, 4, 3, 0.25, 0.4);
            return;
          }
          this.burst(q.x, CHEST, q.z, color, Math.round(8 * big), 4 * big, 0.3, 0.5);
          if (ev.school === 'fire') for (let i = 0, n = 2 + Math.round(big * 2); i < n; i++) this.flame(q.x + rnd(-0.4, 0.4), CHEST - 0.5 + rnd(0, 0.6), q.z + rnd(-0.4, 0.4), big * rnd(0.9, 1.4));
          if (ev.ability === 'fireball') {
            this.ring(q.x, q.z, 0xff7a2a, 0.3, 2.4, 0.35);
            this.puff(q.x, CHEST, q.z, 0x3a2f2a, 4, 1.3);
            this.burst(q.x, CHEST, q.z, 0xffd27a, 14, 5.5, 0.4, 0.6);
          } else if (ev.ability === 'frostbolt') {
            this.ring(q.x, q.z, 0x7fd8ff, 0.3, 2.0, 0.4);
            this.burst(q.x, CHEST, q.z, 0xe6f8ff, 12, 4.5, 0.3, 0.6, 4);
          } else if (ev.ability === 'smite') {
            this.column(q.x, q.z, 0xfff1a8, 0.55, 0.7, 7);
            this.ring(q.x, q.z, 0xffe98a, 0.3, 2.2, 0.4);
          } else if (ev.ability === 'frost_nova') {
            this.burst(q.x, 0.5, q.z, 0xcdf1ff, 8, 3, 0.3, 0.5, 4);
          }
        });
        break;
      }
      case 'heal': {
        const p = this.pos(ev.tgt);
        if (!p || ev.amount <= 0) break;
        for (let i = 0; i < 6; i++) {
          this.particle(p.x + rnd(-0.5, 0.5), rnd(0.2, 1.0), p.z + rnd(-0.5, 0.5), {
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
            this.puff(p.x, 1.1, p.z, 0xf3ecff, 10, 1.6);
            this.burst(p.x, 1.2, p.z, 0xc58bff, 16, 4, 0.35, 0.7, 0);
            break;
          case 'frost_nova_root':
            this.burst(p.x, 0.3, p.z, 0xcdf1ff, 10, 3, 0.3, 0.5, 5);
            break;
          case 'psychic_scream':
            this.burst(p.x, HEAD, p.z, 0x9a4dff, 12, 3, 0.35, 0.7, 0);
            break;
          case 'cheap_shot_stun':
          case 'kidney_shot':
            this.burst(p.x, HEAD, p.z, 0xfff1a8, 10, 3, 0.3, 0.5, 0);
            break;
          case 'pw_shield':
            this.burst(p.x, 1.0, p.z, 0xfff1a8, 14, 3, 0.3, 0.6, 0);
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
        if (ev.aura === 'polymorph') this.puff(p.x, 1.1, p.z, 0xf3ecff, 8, 1.4);
        else if (ev.aura === 'pw_shield' && ev.reason !== 'expired') this.burst(p.x, 1.0, p.z, 0xfff1a8, 18, 5, 0.35, 0.6, 0);
        else if (ev.aura === 'stealth') this.puff(p.x, 1.0, p.z, 0x2b2b33, 7, 1.2);
        break;
      }
      case 'dispel': {
        const p = this.pos(ev.tgt);
        if (!p) break;
        for (let i = 0; i < 12; i++) {
          this.particle(p.x + rnd(-0.5, 0.5), rnd(0.2, 1.6), p.z + rnd(-0.5, 0.5), { tex: 'star', color: 0xfff1a8, vy: rnd(0.5, 2), s0: 0.35, life: 0.8, drag: 0.5 });
        }
        this.ring(p.x, p.z, 0xffe98a, 0.4, 1.8, 0.5);
        break;
      }
      case 'death': {
        this.stopCast(ev.unit);
        const p = this.pos(ev.unit);
        if (!p) break;
        this.puff(p.x, 0.6, p.z, 0x8a8f9a, 10, 1.6);
        for (let i = 0; i < 10; i++) {
          this.particle(p.x + rnd(-0.3, 0.3), rnd(0.5, 1.3), p.z + rnd(-0.3, 0.3), { color: 0xcfe8ff, vy: rnd(1, 2.5), s0: rnd(0.25, 0.45), life: rnd(1, 1.6), drag: 0.4 });
        }
        this.ring(p.x, p.z, 0xcfe8ff, 0.4, 2.6, 0.9);
        break;
      }
      default:
        break;
    }
  }

  private onCast(unit: number, ability: string, target: number) {
    const def = ABILITIES[ability];
    const s = this.pos(unit);
    if (!def || !s) return;
    const t = target && target !== unit ? this.pos(target) : null;
    const color = SCHOOL_COLOR[def.school];
    const melee = (c: number, scale: number, y = CHEST) => {
      if (!t) return;
      this.onSwing(unit);
      this.slash(s.x, s.z, t.x, t.z, c, scale, y);
      this.burst(t.x, y, t.z, c, 6, 3.5, 0.25, 0.35);
    };

    switch (ability) {
      case 'slam':
        melee(0xffaa40, 1.7);
        if (t) this.ring(t.x, t.z, 0xffaa40, 0.3, 2.2, 0.3);
        break;
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
      case 'reel_in':
        this.onSwing(unit);
        this.ring(s.x, s.z, 0x9aa3b8, 0.4, def.radius ?? 10, 0.35, 0.08, 0.7);
        break;
      case 'slice_and_dice':
      case 'bladestorm':
        this.onSwing(unit);
        this.ring(s.x, s.z, 0xdfe6f2, 0.3, def.radius ?? 6, 0.3, 0.08, 0.9);
        break;
      case 'frostbolt':
      case 'fireball':
      case 'smite': {
        const kind = ability === 'frostbolt' ? 'frost' : ability === 'fireball' ? 'fire' : 'holy';
        const flight = this.projectile(unit, target, def.school, kind, ability === 'fireball' ? 1.25 : 1);
        this.flights.set(`${unit}:${ability}`, flight);
        break;
      }
      case 'flash_heal': {
        const p = this.pos(target) ?? s;
        this.column(p.x, p.z, 0x9dffb4, 0.8, 0.6, 5);
        this.ring(p.x, p.z, 0xfff1a8, 0.3, 1.5, 0.6);
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
        this.ring(p.x, p.z, 0xffe98a, 0.3, 1.6, 0.35, 0.08);
        this.burst(p.x, CHEST, p.z, 0xfff1a8, 6, 3, 0.25, 0.4, 0);
        break;
      }
      case 'frost_nova': {
        const r = def.radius ?? 10;
        this.ring(s.x, s.z, 0x7fd8ff, 0.5, r, 0.55, 0.08, 1);
        this.ring(s.x, s.z, 0xffffff, 0.3, r * 0.8, 0.4, 0.09, 0.8);
        for (let i = 0; i < 28; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = rnd(r * 1.1, r * 1.8);
          this.particle(s.x, 0.4, s.z, { tex: 'star', color: 0xcdf1ff, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: rnd(0, 1.4), s0: rnd(0.3, 0.5), life: 0.55, drag: 2.5, grav: 3 });
        }
        break;
      }
      case 'psychic_scream': {
        const r = def.radius ?? 8;
        this.ring(s.x, s.z, 0x9a4dff, 0.5, r, 0.6, 0.08, 1);
        this.ring(s.x, s.z, 0x331a55, 0.3, r * 0.9, 0.7, 0.09, 0.9);
        for (let i = 0; i < 24; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = rnd(r * 0.9, r * 1.5);
          this.particle(s.x, rnd(0.5, 1.8), s.z, { color: 0xb06bff, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: rnd(-0.2, 0.8), s0: rnd(0.4, 0.8), life: 0.6, drag: 2.2 });
        }
        break;
      }
      case 'blink': {
        this.burst(s.x, 1.1, s.z, 0xc58bff, 22, 5, 0.4, 0.6, 0);
        this.ring(s.x, s.z, 0xc58bff, 0.3, 2.2, 0.4);
        this.later(0.06, () => {
          const n = this.pos(unit);
          if (!n) return;
          this.burst(n.x, 1.1, n.z, 0xe0c2ff, 22, 5, 0.4, 0.6, 0);
          this.ring(n.x, n.z, 0xc58bff, 0.3, 2.2, 0.4);
          this.beam(s.x, 1.1, s.z, n.x, 1.1, n.z, 0xc58bff, 0.3, 0.05);
        });
        break;
      }
      case 'charge': {
        const ox = s.x;
        const oz = s.z;
        this.puff(ox, 0.4, oz, 0xb59a7a, 8, 1.4);
        this.later(0.05, () => {
          const n = this.pos(unit);
          if (!n) return;
          const steps = 14;
          for (let i = 0; i <= steps; i++) {
            const f = i / steps;
            this.particle(ox + (n.x - ox) * f, 1.0 + rnd(-0.4, 0.4), oz + (n.z - oz) * f, { color: 0xffe2b0, s0: 0.9, s1: 0.2, life: 0.35 + f * 0.1, a: 0.7, drag: 0 });
          }
          this.burst(n.x, 0.4, n.z, 0xd9c19a, 10, 4, 0.5, 0.5);
          this.ring(n.x, n.z, 0xffe2b0, 0.4, 2.8, 0.35);
          this.onSwing(unit);
        });
        break;
      }
      case 'mortal_strike':
        melee(0xff4a2a, 1.5);
        if (t) this.ring(t.x, t.z, 0xff4a2a, 0.3, 2, 0.3);
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
        if (t) this.burst(t.x, HEAD, t.z, 0xfff1a8, 10, 3, 0.35, 0.5, 0);
        break;
      case 'kidney_shot':
        melee(0xc01818, 1.3, 1.0);
        break;
      case 'stealth':
        this.puff(s.x, 0.9, s.z, 0x2b2b33, 12, 1.5);
        this.ring(s.x, s.z, 0x555566, 0.4, 2, 0.5);
        break;
      case 'sprint':
        this.puff(s.x, 0.3, s.z, 0xc9b99a, 8, 1.2);
        this.ring(s.x, s.z, 0xfff079, 0.3, 1.8, 0.35);
        break;
      default:
        this.genericCast(unit, def, s, t, target);
    }
  }

  /** Visuals for any ability without a hand-made effect, chosen from what the ability does. */
  private genericCast(unit: number, def: AbilityDef, s: Pos, t: Pos | null, target: number) {
    const color = SCHOOL_COLOR[def.school];
    const has = (type: string) => def.effects.some((e) => e.type === type);
    const enemyTarget = def.target === 'enemy' || def.target === 'any';
    const melee = enemyTarget && def.range <= 6;

    if (has('charge') && t) {
      // dust and a streak while the unit runs, then an impact where it lands
      this.puff(s.x, 0.4, s.z, 0x8a7a60, 7, 1.4);
      for (let k = 1; k <= 18; k++) {
        this.later(k * 0.05, () => {
          const n = this.pos(unit);
          if (!n) return;
          this.particle(n.x + rnd(-0.3, 0.3), 0.9 + rnd(-0.4, 0.4), n.z + rnd(-0.3, 0.3), { color, s0: 0.7, s1: 0.1, life: 0.35, a: 0.55 });
          if (k % 3 === 0) this.puff(n.x, 0.2, n.z, 0x8a7a60, 2, 0.7);
        });
      }
      this.later(0.95, () => {
        const n = this.pos(unit);
        if (!n) return;
        this.burst(n.x, 0.5, n.z, color, 10, 4, 0.4, 0.5);
        this.ring(n.x, n.z, color, 0.4, 2.8, 0.3);
        this.onSwing(unit);
      });
      return;
    }
    if (has('dashToTarget') && t) {
      const ox = s.x;
      const oz = s.z;
      this.puff(ox, 0.4, oz, 0x2b2b33, 6, 1.2);
      this.later(0.05, () => {
        const n = this.pos(unit);
        if (!n) return;
        for (let i = 0; i <= 12; i++) {
          const f = i / 12;
          this.particle(ox + (n.x - ox) * f, 1.0 + rnd(-0.3, 0.3), oz + (n.z - oz) * f, { color, s0: 0.8, s1: 0.2, life: 0.35, a: 0.6 });
        }
        this.burst(n.x, 0.5, n.z, color, 8, 3.5, 0.4, 0.45);
        this.ring(n.x, n.z, color, 0.4, 2.4, 0.3);
        this.onSwing(unit);
      });
      return;
    }
    const vis = visualFor(def);
    if ((vis.cls === 'onTarget' || vis.cls === 'aura') && vis.hit) {
      // an instant that lands now: drawn at the target, nothing flies there
      const tp = target ? this.pos(target) : null;
      if (tp) {
        this.hitVisual(vis.hit, tp, target);
        if (def.target === 'ally' && unit !== target) this.ring(s.x, s.z, color, 0.3, 1.8, 0.4);
        return;
      }
    }
    if (def.target === 'aoe_enemy' || def.target === 'aoe_all') {
      const r = Math.min(def.radius ?? 8, 24);
      if (def.coneDeg) {
        // a cone: a fan of flame out to full range along the caster's facing, instead of a ring
        const half = (def.coneDeg * Math.PI) / 360;
        for (let i = 0; i < 46; i++) {
          const a = s.facing + rnd(-half, half);
          const sp = rnd(r * 0.8, r * 1.9);
          this.particle(s.x + Math.sin(a) * 0.8, rnd(0.6, 1.6), s.z + Math.cos(a) * 0.8, { color: i % 3 === 0 ? 0xffe066 : color, vx: Math.sin(a) * sp, vz: Math.cos(a) * sp, vy: rnd(-0.2, 0.8), s0: rnd(0.4, 0.8), life: 0.6, drag: 2.3 });
        }
        this.coneFlames(s, r, half, color);
        if (has('damage')) this.onSwing(unit);
        return;
      }
      this.ring(s.x, s.z, color, 0.5, r, 0.55, 0.08, 1);
      this.ring(s.x, s.z, 0xffffff, 0.3, r * 0.75, 0.4, 0.09, 0.7);
      for (let i = 0; i < 22; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = rnd(r * 0.9, r * 1.6);
        this.particle(s.x, rnd(0.4, 1.5), s.z, { color, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: rnd(0, 1), s0: rnd(0.3, 0.6), life: 0.55, drag: 2.3 });
      }
      if (has('damage')) this.onSwing(unit);
      return;
    }
    if (melee && t) {
      this.onSwing(unit);
      const heavy = def.effects.some((e) => e.type === 'damage' && e.amount >= 140);
      this.slash(s.x, s.z, t.x, t.z, color, heavy ? 1.35 : 1.1);
      this.burst(t.x, CHEST, t.z, color, 7, 3.6, 0.26, 0.4);
      if (has('aura') && !has('damage')) this.burst(t.x, HEAD, t.z, 0xfff1a8, 8, 3, 0.3, 0.5, 0);
      return;
    }
    if (enemyTarget && t && has('damage')) {
      const kind = def.school === 'fire' ? 'fire' : def.school === 'frost' ? 'frost' : def.school === 'holy' ? 'holy' : def.school === 'shadow' ? 'shadow' : 'arcane';
      if (def.channel?.beam) {
        // a continuous beam: each pulse redraws a beam that lasts until the next one
        this.beam(s.x, 1.5, s.z, t.x, CHEST, t.z, color, (def.castTime / def.channel.ticks / 1000) * 1.15, 0.1);
        this.onSwing(unit);
      } else if (def.channel) {
        // one small curving missile per tick of the volley
        this.flights.set(`${unit}:${def.id}`, this.projectile(unit, target, def.school, kind, 0.62, rnd(0.6, 1.3)));
        this.onSwing(unit);
      } else if (def.castTime > 0) {
        const big = def.effects.some((e) => e.type === 'damage' && e.amount >= 300) ? 1.35 : 1;
        this.flights.set(`${unit}:${def.id}`, this.projectile(unit, target, def.school, kind, big));
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
      this.column(p.x, p.z, def.school === 'holy' ? 0x9dffb4 : color, 0.8, 0.6, 5);
      this.ring(p.x, p.z, 0xfff1a8, 0.3, 1.5, 0.6);
      return;
    }
    // self or ally buff
    const p = def.target === 'ally_or_self' && target ? this.pos(target) ?? s : s;
    this.column(p.x, p.z, color, 0.7, 0.8, 4);
    this.ring(p.x, p.z, color, 0.4, 2.0, 0.5);
    this.burst(p.x, 1.0, p.z, color, 14, 3.2, 0.3, 0.6, 0);
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
              this.particle(group.position.x + Math.cos(ang) * 1.1, rnd(0.2, 2), group.position.z + Math.sin(ang) * 1.1, { color: 0xfff1a8, s0: 0.2, life: 0.6, vy: 0.8 });
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
              this.particle(group.position.x + rnd(-0.4, 0.4), 1.8, group.position.z + rnd(-0.4, 0.4), { tex: 'star', color: 0xcdf1ff, vy: -0.8, s0: 0.22, life: 0.9 });
            }
          },
        });
      }
      case 'sprint':
        return finish({
          update: (_dt, _t, _u, moving) => {
            if (moving && Math.random() < 0.6) {
              this.particle(group.position.x + rnd(-0.2, 0.2), 0.15, group.position.z + rnd(-0.2, 0.2), { tex: 'smoke', color: 0xc9b99a, add: false, s0: 0.3, s1: 0.9, life: 0.5, a: 0.5, vy: 0.4 });
              this.particle(group.position.x + rnd(-0.2, 0.2), rnd(0.3, 1.3), group.position.z + rnd(-0.2, 0.2), { color: 0xfff079, s0: 0.15, life: 0.3, a: 0.7 });
            }
          },
        });
      case 'polymorph':
        return finish({
          update: (_dt, t) => {
            if (Math.random() < 0.1) {
              this.particle(group.position.x + rnd(-0.4, 0.4), 1.4 + Math.sin(t) * 0.1, group.position.z + rnd(-0.4, 0.4), { tex: 'star', color: 0xd9b3ff, vy: 0.7, s0: 0.25, life: 0.8 });
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
              this.particle(group.position.x + Math.cos(a) * 0.9, 0.1, group.position.z + Math.sin(a) * 0.9, { color: col, vy: rnd(1.2, 2.4), s0: 0.22, life: 0.7, drag: 0.3 });
            }
          },
        });
      }
    }
  }

  // ------------------------------------------------------------ per frame

  /** Ground zones (Flamestrike etc.): warning ring that fills until the first beat, then a pulsing fire disc. */
  private smokeMeshes = new Map<number, { group: THREE.Group; disc: THREE.Mesh; blobs: { mesh: THREE.Mesh; x: number; z: number; r: number; ph: number }[] }>();
  private smokeGeo = new THREE.SphereGeometry(1, 12, 10);

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
      for (let i = 0; i < 16; i++) {
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

  /** Reusable flame: a flickering tongue with a hotter core that rises and dies. Colour is the outer flame. */
  flame(x: number, y: number, z: number, scale = 1, color = 0xff5a14) {
    const j = 0.12 * scale;
    this.particle(x + rnd(-j, j), y, z + rnd(-j, j), { tex: 'flame', color, vy: rnd(0.9, 1.8) * scale, vx: rnd(-0.25, 0.25), vz: rnd(-0.25, 0.25), s0: 0.95 * scale, s1: 0.25 * scale, life: rnd(0.35, 0.55), drag: 0.8, a: 0.9 });
    this.particle(x + rnd(-j, j) * 0.5, y, z + rnd(-j, j) * 0.5, { tex: 'flame', color: 0xffd45a, vy: rnd(0.8, 1.5) * scale, s0: 0.5 * scale, s1: 0.1 * scale, life: rnd(0.25, 0.4), drag: 0.8, a: 1 });
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

  /** Flamestrike: gathering runic ring, then a swirl of flame tongues, embers, smoke and a flare on every pulse. */
  private fireZone(z: ZoneSnap, now: number): ZoneVfx {
    const r = z.r;
    const y0 = z.y ?? 0;
    const group = new THREE.Group();
    group.position.set(z.x, y0, z.z);
    const glowM = this.flatMat(0xff4a10, 0.3);
    const ringM = this.flatMat(0xff6a1a, 0.9);
    const runeM = this.flatMat(0xffa23a, 0, this.getRuneTex());
    const outerM = new THREE.MeshBasicMaterial({ map: this.tex.flame, color: 0xff3a0a, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const innerM = outerM.clone();
    innerM.color.set(0xffc23a);
    innerM.opacity = 0.75;
    this.flat(group, this.discGeo, glowM, 0.05, r);
    this.flat(group, this.ringGeo, ringM, 0.07, r);
    const rune = this.flat(group, this.discGeo, runeM, 0.08, r * 1.02);
    interface Tongue { o: THREE.Mesh; i: THREE.Mesh; a: number; rad: number; ph: number; dir: number; h: number }
    const tongues: Tongue[] = [];
    const mk = (n: number, rad: number, dir: number, h: number) => {
      for (let k = 0; k < n; k++) {
        const o = new THREE.Mesh(this.tongueGeo, outerM);
        const i = new THREE.Mesh(this.tongueGeo, innerM);
        group.add(o, i);
        tongues.push({ o, i, a: (k / n) * Math.PI * 2, rad, ph: Math.random() * 6.28, dir, h });
      }
    };
    mk(12, r * 0.86, 1, 1.0);
    mk(6, r * 0.45, -1, 0.8);
    this.scene.add(group);
    if (this.hasOpening(z)) {
      this.column(z.x, z.z, 0xff7a2a, 0.7, r * 0.45, 9, 0.4);
      this.column(z.x, z.z, 0xffd27a, 0.5, r * 0.2, 10, 0.5);
      this.ring(z.x, z.z, 0xff7a2a, 0.5, r * 1.1, 0.55, 0.08, 1);
      this.ring(z.x, z.z, 0xffffff, 0.3, r * 0.7, 0.4, 0.09, 0.8);
      this.burst(z.x, 0.8, z.z, 0xff9a3a, 34, 7, 0.6, 0.7);
      for (let k = 0; k < 10; k++) this.flame(z.x + rnd(-r, r) * 0.7, y0 + 0.1, z.z + rnd(-r, r) * 0.7, rnd(1.4, 2.2));
    }
    let lastPulse = now >= z.firstAt ? Math.floor((now - z.firstAt) / z.pulse) : -1;
    let flare = 0;
    let accE = 0, accS = 0, accF = 0, accG = 0;
    const cRed = new THREE.Color(0xff2a08), cOra = new THREE.Color(0xff8a1a), cYel = new THREE.Color(0xffc23a), cHot = new THREE.Color(0xfff0b0);
    const disc = () => {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * r * 0.92;
      return [Math.cos(a) * d, Math.sin(a) * d] as const;
    };
    return {
      last: now,
      update: (zz, t, dt) => {
        const age = Math.max(0, (t - zz.start) / 1000);
        const left = Math.max(0, zz.end - t);
        const armed = t >= zz.firstAt;
        const prog = armed ? 1 : Math.min(1, (t - zz.start) / Math.max(1, zz.firstAt - zz.start));
        const fade = Math.min(1, left / 600) * Math.min(1, age / 0.15 + 0.2);
        const idx = armed ? Math.floor((t - zz.firstAt) / zz.pulse) : -1;
        if (idx > lastPulse) {
          lastPulse = idx;
          flare = 1;
          this.ring(zz.x, zz.z, 0xffa23a, r * 0.4, r, 0.4, 0.09, 0.9);
          this.column(zz.x, zz.z, 0xff8a2a, 0.35, r * 0.2, 4, 0.3);
          for (let k = 0; k < 8; k++) this.flame(zz.x + rnd(-r, r) * 0.7, y0 + 0.1, zz.z + rnd(-r, r) * 0.7, rnd(1.2, 1.9));
          this.burst(zz.x, 0.5, zz.z, 0xffb040, 14, 5, 0.4, 0.6);
        }
        flare = Math.max(0, flare - dt * 2.8);
        const gather = armed ? 1 : 0.1 + 0.3 * prog;
        // ground: glow, ring and the runic sigil (bright while gathering, a scorched mark once burning)
        glowM.opacity = (armed ? 0.32 + 0.1 * Math.sin(t / 110) + flare * 0.35 : 0.06 + 0.2 * prog) * fade;
        ringM.opacity = (armed ? 0.65 + flare * 0.3 : 0.45 + 0.4 * Math.sin(t / 90) * 0.5 + 0.2) * fade;
        runeM.opacity = (armed ? 0.22 : 0.3 + 0.5 * prog) * fade;
        rune.rotation.z = age * (armed ? 0.5 : 1.6);
        // flame tongues swirling round the circle
        const sw = age * 1.3;
        const fk = 0.5 + 0.5 * Math.sin(t / 55);
        outerM.color.copy(cRed).lerp(cOra, fk);
        innerM.color.copy(cYel).lerp(cHot, 0.5 - 0.5 * Math.sin(t / 70));
        outerM.opacity = 0.5 * fade;
        innerM.opacity = 0.6 * fade;
        for (const f of tongues) {
          const a = f.a + sw * f.dir;
          const flick = 0.65 + 0.35 * Math.sin(age * 11 + f.ph) + 0.15 * Math.sin(age * 23 + f.ph * 2);
          const h = f.h * (1.05 + flare * 0.9) * gather * (0.7 + flick * 0.5) * fade;
          const w = (0.9 + 0.3 * flick) * (0.7 + 0.3 * gather);
          const px = Math.cos(a) * f.rad, pz = Math.sin(a) * f.rad;
          const tx = -Math.sin(a) * f.dir, tz = Math.cos(a) * f.dir;
          const lean = 0.3 + 0.12 * flick;
          f.o.position.set(px, 0.05, pz);
          f.o.rotation.set(lean * tz, 0, -lean * tx);
          f.o.scale.set(w * 1.5, h * 2.5, w * 1.5);
          f.i.position.set(px, 0.05, pz);
          f.i.rotation.set(lean * tz * 0.8, 0, -lean * tx * 0.8);
          f.i.scale.set(w * 0.85, h * 1.6, w * 0.85);
        }
        // embers, flames and smoke
        accE += dt * (armed ? r * 5 : r * 1.2) * fade;
        while (accE > 1) {
          accE--;
          const [dx, dz] = disc();
          this.particle(zz.x + dx, y0 + 0.2, zz.z + dz, { color: Math.random() < 0.5 ? 0xff9a3a : 0xffd27a, vy: rnd(1.5, 3.8), vx: rnd(-0.6, 0.6) - dz * 0.25, vz: rnd(-0.6, 0.6) + dx * 0.25, s0: rnd(0.14, 0.26), life: rnd(0.9, 1.6), drag: 0.3 });
        }
        if (armed) {
          accF += dt * r * 2.2 * fade;
          while (accF > 1) {
            accF--;
            const [dx, dz] = disc();
            this.flame(zz.x + dx, y0 + 0.1, zz.z + dz, rnd(0.9, 1.5));
          }
          accS += dt * 3 * fade;
          while (accS > 1) {
            accS--;
            const [dx, dz] = disc();
            this.particle(zz.x + dx, y0 + 1.5, zz.z + dz, { tex: 'smoke', color: 0x2a2320, add: false, vy: rnd(1, 1.8), vx: rnd(-0.4, 0.4), s0: 0.9, s1: 2.4, life: rnd(1.2, 1.8), a: 0.45, drag: 0.4 });
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
        for (const m of [glowM, ringM, runeM, outerM, innerM]) m.dispose();
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
        const fade = Math.min(1, leftMs / 700) * Math.min(1, age / 0.25);
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
      (p.sprite.material as THREE.SpriteMaterial).opacity = p.a0 * (1 - k * k);
      if (p.spin) (p.sprite.material as THREE.SpriteMaterial).rotation += p.spin * dt;
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
        att.group.position.set(u.x, 0, u.z);
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
