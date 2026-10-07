import * as THREE from 'three';
import { ABILITIES, AURAS } from '@arena/shared';
import type { AbilityDef, School, SimEvent, ZoneSnap } from '@arena/shared';

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

const CHEST = 1.2;
const HEAD = 2.1;
const PROJECTILE_SPEED = 38;

type TexName = 'glow' | 'star' | 'plus' | 'smoke' | 'spark';

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

interface Attachment {
  group: THREE.Group;
  update(dt: number, t: number, u: EffectUnit, moving: boolean): void;
}

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
  onSwing: (unit: number) => void = () => {};
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
  private column(x: number, z: number, color: number, life = 0.7, radius = 0.55, height = 6) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
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
        mat.opacity = 0.55 * (1 - k);
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
            this.particle(q.x + rnd(-0.1, 0.1), q.y + rnd(-0.1, 0.1), q.z + rnd(-0.1, 0.1), { color: Math.random() < 0.5 ? 0xff5a1a : 0xffb23a, vy: rnd(0, 0.8), s0: 0.5 * size, life: 0.35, drag: 2 });
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
        if (ev.ability === null && ev.src !== 0) {
          // auto-attack: swing the attacker's weapon and draw a quick steel slash so every swing is visible
          const a = this.pos(ev.src);
          if (a) {
            this.onSwing(ev.src);
            this.slash(a.x, a.z, p.x, p.z, 0xe9eef7, 0.95, CHEST);
            this.later(0.05, () => this.ring(p.x, p.z, 0xffffff, 0.18, 1.2, 0.18));
          }
        }
        const color = SCHOOL_COLOR[ev.school] ?? 0xffffff;
        const key = ev.ability ? `${ev.src}:${ev.ability}` : '';
        const delay = key ? this.flights.get(key) ?? 0 : 0;
        if (key) this.flights.delete(key);
        const big = Math.min(1.6, 0.6 + ev.amount / 600);
        const absorbed = ev.absorbed > 0 && ev.amount === 0;
        this.later(delay, () => {
          const q = this.pos(ev.tgt) ?? p;
          if (absorbed) {
            this.burst(q.x, CHEST, q.z, 0xfff1a8, 10, 3, 0.25, 0.4, 0);
            return;
          }
          this.burst(q.x, CHEST, q.z, color, Math.round(8 * big), 4 * big, 0.3, 0.5);
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
      case 'reel_in':
        if (t) {
          this.onSwing(unit);
          this.beam(s.x, 1.5, s.z, t.x, CHEST, t.z, ability === 'axe_throw' ? 0xd7dbe4 : 0x9aa3b8, 0.25, 0.08);
          this.burst(t.x, CHEST, t.z, 0xd7dbe4, 8, 4, 0.25, 0.35);
        }
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
      case 'polymorph':
        if (t) this.beam(s.x, 1.5, s.z, t.x, CHEST, t.z, 0xc58bff, 0.45, 0.1);
        break;
      case 'counterspell':
        if (t) this.beam(s.x, 1.5, s.z, t.x, CHEST, t.z, 0xc58bff, 0.25, 0.07);
        break;
      case 'dispel_magic':
        if (t) this.beam(s.x, 1.5, s.z, t.x, CHEST, t.z, 0xfff1a8, 0.35, 0.07);
        break;
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
        for (const e of [-half, 0, half]) this.beam(s.x, 1.2, s.z, s.x + Math.sin(s.facing + e) * r, 0.8, s.z + Math.cos(s.facing + e) * r, color, 0.35, 0.07);
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
        this.beam(s.x, 1.5, s.z, t.x, CHEST, t.z, color, 0.22, 0.08);
      }
      return;
    }
    if (enemyTarget && t) {
      this.beam(s.x, 1.5, s.z, t.x, CHEST, t.z, color, 0.3, 0.07);
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
      case 'frost_nova_root': {
        const mat = new THREE.MeshBasicMaterial({ color: 0x9fe0ff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false });
        mats.push(mat);
        const spikes: THREE.Mesh[] = [];
        for (let i = 0; i < 7; i++) {
          const m = new THREE.Mesh(this.iceGeo, mat);
          const a = (i / 7) * Math.PI * 2;
          m.userData.h = rnd(0.7, 1.3);
          m.position.set(Math.cos(a) * 0.75, 0, Math.sin(a) * 0.75);
          m.rotation.set(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
          group.add(m);
          spikes.push(m);
        }
        let age = 0;
        return finish({
          update: (dt) => {
            age += dt;
            const k = Math.min(1, age / 0.25);
            for (const m of spikes) {
              const h = (m.userData.h as number) * k;
              m.scale.set(1, h, 1);
              m.position.y = h / 2;
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

  private zoneMeshes = new Map<number, { disc: THREE.Mesh; ring: THREE.Mesh }>();

  /** Ground zones (Flamestrike etc.): warning ring that fills until the first beat, then a pulsing fire disc. */
  private smokeMeshes = new Map<number, { group: THREE.Group; disc: THREE.Mesh; blobs: { mesh: THREE.Mesh; x: number; z: number; r: number; ph: number }[] }>();
  private smokeGeo = new THREE.SphereGeometry(1, 12, 10);

  /** A smoke cloud: pops up from the caster's feet, billows for its duration and thins out at the end. */
  private setSmoke(z: ZoneSnap, now: number, seenSmoke: Set<number>) {
    seenSmoke.add(z.id);
    let m = this.smokeMeshes.get(z.id);
    if (!m) {
      const group = new THREE.Group();
      group.position.set(z.x, this.groundY(z.x, z.z), z.z);
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

  setZones(zones: ZoneSnap[], now: number) {
    const seen = new Set<number>();
    const seenSmoke = new Set<number>();
    for (const z of zones) {
      if (z.smoke) {
        this.setSmoke(z, now, seenSmoke);
        continue;
      }
      seen.add(z.id);
      let m = this.zoneMeshes.get(z.id);
      const color = SCHOOL_COLOR[z.school] ?? 0xff6a20;
      if (!m) {
        const mk = (geo: THREE.BufferGeometry) => {
          const mat = new THREE.MeshBasicMaterial({ color: z.flag ? 0xffd34a : color, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.rotation.x = -Math.PI / 2;
          mesh.position.set(z.x, 0.06 + this.groundY(z.x, z.z), z.z);
          mesh.scale.set(z.r, z.r, 1);
          this.scene.add(mesh);
          return mesh;
        };
        m = { disc: mk(this.discGeo), ring: mk(this.ringGeo) };
        this.zoneMeshes.set(z.id, m);
        // a zone with an opening hit (Flamestrike) lands with a blast: column, shockwave and sparks
        const zone = ABILITIES[z.ability]?.effects.find((e) => e.type === 'zone');
        if (zone && zone.type === 'zone' && zone.initial) {
          this.column(z.x, z.z, color, 0.7, z.r * 0.5, 9);
          this.ring(z.x, z.z, color, 0.5, z.r, 0.55, 0.08, 1);
          this.ring(z.x, z.z, 0xffffff, 0.3, z.r * 0.7, 0.4, 0.09, 0.8);
          this.burst(z.x, 0.8, z.z, color, 34, 7, 0.6, 0.7);
        }
      }
      const armed = now >= z.firstAt;
      const sincePulse = armed ? ((now - z.firstAt) % z.pulse) / z.pulse : 0;
      (m.ring.material as THREE.MeshBasicMaterial).opacity = armed ? 0.9 : 0.5 + 0.4 * Math.sin(now / 90);
      (m.disc.material as THREE.MeshBasicMaterial).opacity = armed ? 0.55 - 0.4 * sincePulse : 0.12 + 0.18 * Math.min(1, (now - z.start) / Math.max(1, z.firstAt - z.start));
    }
    for (const [id, m] of this.smokeMeshes) {
      if (seenSmoke.has(id)) continue;
      this.scene.remove(m.group);
      for (const c of m.group.children) (c as THREE.Mesh).material && ((c as THREE.Mesh).material as THREE.Material).dispose();
      this.smokeMeshes.delete(id);
    }
    for (const [id, m] of this.zoneMeshes) {
      if (seen.has(id)) continue;
      for (const mesh of [m.disc, m.ring]) {
        this.scene.remove(mesh);
        (mesh.material as THREE.Material).dispose();
      }
      this.zoneMeshes.delete(id);
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
    for (const u of units) {
      const prev = this.prevPos.get(u.id);
      const moving = !!prev && Math.hypot(u.x - prev.x, u.z - prev.z) / Math.max(dt, 0.001) > 1;
      this.prevPos.set(u.id, { x: u.x, z: u.z });
      if (!u.alive) continue;
      for (const a of u.auras) {
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
  }
}
