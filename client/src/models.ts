import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { parseLook } from '@arena/shared';
import type { ClassId, LookPiece } from '@arena/shared';

/**
 * Stylized heroic humanoids built from rounded primitives with ink outlines, one silhouette per class so you can read a fight at a glance:
 * Warrior = plate, horned helm, sword and shield. Mage = blue robe, pointed hat, glowing staff.
 * Priest = white and gold robe, halo, mace and holy tome. Rogue = dark hood and mask, twin daggers, forward lean.
 *
 * Every character faces +z with its feet at y = 0. Its right hand is on -x (matching the sim's right vector).
 * Swap this file for a glTF loader later; the rest of the client only touches the `Character` interface.
 */

export interface PoseInput {
  /** Walk cycle phase in radians. */
  phase: number;
  /** 0 = standing, 1 = full run. */
  move: number;
  casting: boolean;
  /** Seconds, for idle breathing. */
  time: number;
  /** Seconds since the last pose call. */
  dt: number;
  /** Signed speed along the facing direction (negative = backpedalling) and sideways (positive = towards the character's left). */
  vf?: number;
  vs?: number;
}

export interface Character {
  root: THREE.Group;
  /** Every mesh, for picking. */
  meshes: THREE.Mesh[];
  pose(p: PoseInput): void;
  /** Play a quick melee swing. */
  swing(): void;
  /** Flash red for a moment (took a hit). */
  flash(): void;
  setState(alive: boolean, stealthed: boolean): void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const smooth = (x: number) => {
  const k = clamp(x, 0, 1);
  return k * k * (3 - 2 * k);
};
const easeOut = (x: number) => 1 - (1 - clamp(x, 0, 1)) ** 3;
/** Frame-rate independent exponential approach: the basis of all the smoothing. */
const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

const SKIN = 0xe8b898;
const HIP = 0.85;
const DEAD_GRAY = new THREE.Color(0x555555);

/** Shared ink-outline material: a back-face shell pushed out along the normals (the classic cel-shaded rim). */
function makeOutlineMaterial(thickness: number): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color: 0x0b0806, side: THREE.BackSide });
  mat.onBeforeCompile = (shader: { vertexShader: string }) => {
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `vec3 transformed = position + normalize(normal) * ${thickness.toFixed(4)};`);
  };
  return mat;
}

class Builder {
  readonly mats: THREE.MeshStandardMaterial[] = [];
  readonly meshes: THREE.Mesh[] = [];
  /** Additive glow shapes (wings, light rings). Hidden while dead or stealthed. */
  readonly fx: THREE.Object3D[] = [];
  /** Per-frame cosmetic animation (spinning halos, bobbing orbs). */
  readonly anim: ((t: number, move: number) => void)[] = [];
  readonly outline = makeOutlineMaterial(0.014);
  outlines = true;
  private cache = new Map<string, THREE.MeshStandardMaterial>();
  private glowCache = new Map<number, THREE.MeshBasicMaterial>();

  m(color: number, o: { metal?: number; rough?: number; glow?: number } = {}): THREE.MeshStandardMaterial {
    const key = `${color}|${o.metal ?? 0.1}|${o.rough ?? 0.7}|${o.glow ?? 0}`;
    let mat = this.cache.get(key);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color,
        metalness: o.metal ?? 0.1,
        roughness: o.rough ?? 0.7,
        emissive: o.glow ? color : 0x000000,
        emissiveIntensity: o.glow ?? 0,
      });
      mat.userData.base = new THREE.Color(color);
      mat.userData.glow = o.glow ?? 0;
      this.cache.set(key, mat);
      this.mats.push(mat);
    }
    return mat;
  }

  /** Translucent additive material for magical glow shapes. */
  g(color: number, opacity = 0.6): THREE.MeshBasicMaterial {
    let mat = this.glowCache.get(color * 1000 + Math.round(opacity * 100));
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
      this.glowCache.set(color * 1000 + Math.round(opacity * 100), mat);
    }
    return mat;
  }

  /** Run `fn` with outlines disabled (eyes, glow shapes, thin details). */
  plain<T>(fn: () => T): T {
    const was = this.outlines;
    this.outlines = false;
    try {
      return fn();
    } finally {
      this.outlines = was;
    }
  }

  add(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    mesh.castShadow = true;
    this.meshes.push(mesh);
    if (this.outlines) {
      const shell = new THREE.Mesh(geo, this.outline);
      shell.raycast = () => {}; // never picked
      mesh.add(shell);
    }
    return mesh;
  }

  /** A glow shape: no outline, no picking, not a shadow caster. Registered so it hides with the unit. */
  glow(parent: THREE.Object3D, geo: THREE.BufferGeometry, color: number, opacity: number, x = 0, y = 0, z = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, this.g(color, opacity));
    mesh.position.set(x, y, z);
    mesh.raycast = () => {};
    parent.add(mesh);
    this.fx.push(mesh);
    return mesh;
  }

  setOutline(alive: boolean, stealthed: boolean) {
    this.outline.transparent = stealthed;
    this.outline.opacity = stealthed ? 0.25 : 1;
    this.outline.color.set(alive ? 0x0b0806 : 0x1a1a1a);
    this.outline.needsUpdate = true;
    for (const o of this.fx) o.visible = alive && !stealthed;
  }

  box(p: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
    return this.add(p, new THREE.BoxGeometry(w, h, d), mat, x, y, z);
  }
  /** Bevelled box: the workhorse for the stylized look. */
  rbox(p: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0, r = 0.05) {
    return this.add(p, new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001)), mat, x, y, z);
  }
  ball(p: THREE.Object3D, r: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
    return this.add(p, new THREE.SphereGeometry(r, 18, 14), mat, x, y, z);
  }
  cyl(p: THREE.Object3D, rt: number, rb: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 16) {
    return this.add(p, new THREE.CylinderGeometry(rt, rb, h, seg), mat, x, y, z);
  }
  cone(p: THREE.Object3D, r: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 16) {
    return this.add(p, new THREE.ConeGeometry(r, h, seg), mat, x, y, z);
  }
  caps(p: THREE.Object3D, r: number, len: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
    return this.add(p, new THREE.CapsuleGeometry(r, len, 6, 14), mat, x, y, z);
  }
  torus(p: THREE.Object3D, r: number, tube: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
    return this.add(p, new THREE.TorusGeometry(r, tube, 10, 28), mat, x, y, z);
  }
  /** Surface of revolution from [radius, y] points (robes, bells, vases). Order points so the OUTER side runs upward, or the faces point inward. */
  lathe(p: THREE.Object3D, pts: [number, number][], mat: THREE.Material, x = 0, y = 0, z = 0, seg = 28) {
    return this.add(p, new THREE.LatheGeometry(pts.map(([r, h]) => new THREE.Vector2(r, h)), seg), mat, x, y, z);
  }
}

interface Rig {
  root: THREE.Group;
  upper: THREE.Group; // everything above the hips; pivots at the hip
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group; // character's left = +x
  armR: THREE.Group;
  /** Optional cloth that trails when moving. Pivots at the shoulders. */
  cape?: THREE.Group;
}

interface RigOpts {
  torso: number;
  torsoW: number;
  torsoD?: number;
  sleeve: number;
  pants: number;
  boots: number;
  glove?: number;
  legW?: number;
  armW?: number;
  headR?: number;
  /** Robes: the legs are hidden, so skip the detailed boots. */
  hidden?: boolean;
  metal?: number;
}

function rig(b: Builder, o: RigOpts): Rig {
  const root = new THREE.Group();
  const upper = new THREE.Group();
  upper.position.y = HIP;
  root.add(upper);

  const legW = o.legW ?? 0.23;
  const mkLeg = (side: number) => {
    const g = new THREE.Group();
    g.position.set(side * 0.16, HIP, 0);
    b.rbox(g, legW, 0.8, 0.27, b.m(o.pants, { rough: 0.8 }), 0, -0.38, 0, 0.09);
    b.rbox(g, legW + 0.06, 0.24, 0.4, b.m(o.boots, { rough: 0.6, metal: 0.15 }), 0, -0.72, 0.06, 0.08);
    root.add(g);
    return g;
  };
  const legL = mkLeg(1);
  const legR = mkLeg(-1);

  const torsoD = o.torsoD ?? 0.38;
  const metal = o.metal ?? 0.3;
  // waist, chest, neck: a V-shaped heroic torso
  b.rbox(upper, o.torsoW * 0.74, 0.26, torsoD * 0.85, b.m(o.pants, { rough: 0.8 }), 0, 0.1, 0, 0.09);
  b.rbox(upper, o.torsoW, 0.54, torsoD, b.m(o.torso, { metal: o.hidden ? 0.1 : metal, rough: 0.55 }), 0, 0.48, 0, 0.14);
  b.cyl(upper, 0.075, 0.09, 0.14, b.m(SKIN), 0, 0.8, 0, 10);

  const armW = o.armW ?? 0.16;
  const mkArm = (side: number) => {
    const g = new THREE.Group();
    g.position.set(side * (o.torsoW / 2 + armW * 0.5), 0.68, 0);
    b.ball(g, armW * 0.78, b.m(o.sleeve, { metal: 0.2 }), 0, 0, 0);
    b.caps(g, armW * 0.5, 0.36, b.m(o.sleeve, { metal: 0.2, rough: 0.65 }), 0, -0.28, 0);
    b.ball(g, armW * 0.66, b.m(o.glove ?? SKIN, { rough: 0.7 }), 0, -0.6, 0);
    upper.add(g);
    return g;
  };
  const armL = mkArm(1);
  const armR = mkArm(-1);

  b.ball(upper, o.headR ?? 0.22, b.m(SKIN, { rough: 0.8 }), 0, 0.99, 0);
  return { root, upper, legL, legR, armL, armR };
}

function eyes(b: Builder, r: Rig, y = 1.0, z = 0.19, color = 0x1a1a22, x = 0.075, size = 0.032) {
  b.plain(() => {
    for (const s of [-x, x]) {
      b.ball(r.upper, size * 1.5, b.m(0xffffff, { rough: 0.4 }), s, y, z - 0.012);
      b.ball(r.upper, size, b.m(color), s, y, z + 0.004);
    }
  });
}

function addCape(b: Builder, r: Rig, color: number, trim: number, w: number, len: number) {
  const pivot = new THREE.Group();
  pivot.position.set(0, 0.7, -0.22);
  // a slightly flared, rounded cloth rather than a flat plank
  b.rbox(pivot, w, len, 0.05, b.m(color, { rough: 0.95 }), 0, -len / 2, 0, 0.02);
  b.rbox(pivot, w * 1.12, 0.08, 0.07, b.m(trim, { metal: 0.6, rough: 0.35 }), 0, -len + 0.04, 0, 0.03);
  b.rbox(pivot, w * 0.9, 0.12, 0.09, b.m(trim, { metal: 0.6, rough: 0.35 }), 0, -0.02, 0, 0.04);
  r.upper.add(pivot);
  r.cape = pivot;
}

function warrior(b: Builder): Rig {
  const steel = 0x9aa3b4;
  const dark = 0x4a5160;
  const gold = 0xe0b040;
  const r = rig(b, { torso: steel, torsoW: 0.78, torsoD: 0.46, sleeve: steel, pants: dark, boots: 0x3a2f27, glove: 0x5a4636, legW: 0.26, armW: 0.2, metal: 0.65, headR: 0.2 });
  const { upper } = r;
  addCape(b, r, 0x9a2a22, gold, 0.66, 1.2);
  // breastplate with a glowing sigil, tabard and belt
  b.rbox(upper, 0.36, 0.64, 0.05, b.m(0x1f4f9e, { rough: 0.8 }), 0, 0.27, 0.25, 0.02);
  b.rbox(upper, 0.84, 0.1, 0.5, b.m(0x3a2c20, { rough: 0.6 }), 0, 0.12, 0, 0.04);
  b.rbox(upper, 0.14, 0.14, 0.07, b.m(gold, { metal: 0.8, rough: 0.3 }), 0, 0.12, 0.27, 0.03);
  b.plain(() => b.ball(upper, 0.05, b.m(0xffd46a, { glow: 1.4 }), 0, 0.55, 0.255));
  // huge layered pauldrons with gold trim
  for (const s of [-1, 1]) {
    const p = b.ball(upper, 0.3, b.m(steel, { metal: 0.7, rough: 0.35 }), s * 0.5, 0.74, 0);
    p.scale.set(1.0, 0.62, 1.05);
    const p2 = b.ball(upper, 0.24, b.m(dark, { metal: 0.7, rough: 0.4 }), s * 0.53, 0.64, 0);
    p2.scale.set(1.0, 0.55, 1.05);
    const trim = b.torus(upper, 0.27, 0.025, b.m(gold, { metal: 0.8, rough: 0.3 }), s * 0.5, 0.67, 0);
    trim.rotation.x = Math.PI / 2;
    trim.scale.set(1, 1.05, 1.0);
    const spike = b.cone(upper, 0.055, 0.22, b.m(steel, { metal: 0.8, rough: 0.3 }), s * 0.58, 0.9, 0, 8);
    spike.rotation.z = -s * 0.35;
  }
  // gauntlets
  for (const arm of [r.armL, r.armR]) b.rbox(arm, 0.24, 0.2, 0.24, b.m(dark, { metal: 0.7, rough: 0.4 }), 0, -0.5, 0, 0.06);
  // great helm: dome, face plate with a glowing visor slit, crest and horns
  b.ball(upper, 0.255, b.m(steel, { metal: 0.75, rough: 0.3 }), 0, 1.01, 0);
  b.rbox(upper, 0.34, 0.2, 0.14, b.m(dark, { metal: 0.7, rough: 0.35 }), 0, 0.94, 0.17, 0.06);
  b.plain(() => b.box(upper, 0.3, 0.045, 0.05, b.m(0xffb347, { glow: 1.6 }), 0, 0.99, 0.245));
  b.rbox(upper, 0.05, 0.1, 0.4, b.m(0xb02a22, { rough: 0.9 }), 0, 1.28, -0.02, 0.02);
  for (const s of [-1, 1]) {
    const h = b.cone(upper, 0.07, 0.4, b.m(0xf1ead6, { rough: 0.5 }), s * 0.3, 1.2, 0, 10);
    h.rotation.z = -s * 0.95;
    const tip = b.cone(upper, 0.04, 0.2, b.m(0xf1ead6, { rough: 0.5 }), s * 0.5, 1.34, 0, 10);
    tip.rotation.z = -s * 0.2;
  }
  // sword (right hand): grip at the hand, blade pointing forward, glowing fuller
  const sword = new THREE.Group();
  sword.position.set(0, -0.62, 0.05);
  sword.rotation.x = Math.PI / 2;
  b.cyl(sword, 0.035, 0.035, 0.22, b.m(0x4a2f1b), 0, 0, 0, 8);
  b.ball(sword, 0.055, b.m(gold, { metal: 0.8, rough: 0.3 }), 0, -0.13, 0);
  b.rbox(sword, 0.34, 0.055, 0.09, b.m(gold, { metal: 0.8, rough: 0.3 }), 0, 0.12, 0, 0.02);
  b.rbox(sword, 0.1, 1.05, 0.03, b.m(0xdfe5ee, { metal: 0.9, rough: 0.2 }), 0, 0.68, 0, 0.012);
  b.cone(sword, 0.05, 0.14, b.m(0xdfe5ee, { metal: 0.9, rough: 0.2 }), 0, 1.26, 0, 4).scale.z = 0.3;
  b.plain(() => b.box(sword, 0.022, 0.8, 0.036, b.m(0x7fd0ff, { glow: 1.5 }), 0, 0.66, 0));
  r.armR.add(sword);
  // kite-ish shield (left arm): domed face, rim, boss and emblem
  const shield = new THREE.Group();
  shield.position.set(0.24, -0.3, 0.06);
  shield.rotation.y = Math.PI / 2;
  b.rbox(shield, 0.62, 0.86, 0.08, b.m(0x1f4f9e, { rough: 0.55, metal: 0.3 }), 0, 0, 0, 0.05);
  b.rbox(shield, 0.68, 0.92, 0.05, b.m(gold, { metal: 0.8, rough: 0.35 }), 0, 0, -0.035, 0.05);
  b.ball(shield, 0.12, b.m(gold, { metal: 0.85, rough: 0.3 }), 0, 0.05, 0.05).scale.z = 0.5;
  b.plain(() => b.box(shield, 0.04, 0.5, 0.03, b.m(0xffe08a, { glow: 0.8 }), 0, -0.02, 0.085));
  r.armL.add(shield);
  return r;
}

function mage(b: Builder): Rig {
  const robe = 0x2f63b8;
  const deep = 0x1c3f86;
  const trim = 0x7fe0ff;
  const r = rig(b, { torso: robe, torsoW: 0.58, sleeve: deep, pants: robe, boots: 0x2a2233, glove: 0xd9b89a, hidden: true, armW: 0.15, headR: 0.22 });
  const { root, upper } = r;
  // flared robe (lathe) with glowing hem, sash, and a layered mantle
  b.lathe(root, [[0.0, 0.0], [0.6, 0.0], [0.57, 0.12], [0.5, 0.4], [0.4, 0.7], [0.32, 0.95], [0.0, 0.95]], b.m(robe, { rough: 0.85 }), 0, 0.02, 0, 32);
  b.plain(() => {
    const hem = b.torus(root, 0.585, 0.03, b.m(trim, { glow: 1.1 }), 0, 0.06, 0);
    hem.rotation.x = Math.PI / 2;
  });
  b.rbox(upper, 0.64, 0.11, 0.42, b.m(0xe2c870, { metal: 0.5, rough: 0.4 }), 0, 0.1, 0, 0.05);
  b.plain(() => b.ball(upper, 0.05, b.m(trim, { glow: 1.6 }), 0, 0.1, 0.22));
  b.lathe(upper, [[0.24, -0.1], [0.4, -0.16], [0.42, -0.05], [0.2, 0.0]], b.m(deep, { rough: 0.8 }), 0, 0.7, 0, 24).scale.set(1.15, 1, 1);
  for (const s of [-1, 1]) {
    // bell sleeves
    const arm = s < 0 ? r.armR : r.armL;
    b.lathe(arm, [[0.2, -0.3], [0.19, -0.18], [0.1, 0]], b.m(deep, { rough: 0.85 }), 0, -0.3, 0, 16).scale.set(1, 1, 1);
    // little crystal pauldrons
    const crystal = b.cone(upper, 0.07, 0.26, b.m(trim, { glow: 0.9, rough: 0.2 }), s * 0.38, 0.84, 0, 5);
    crystal.rotation.z = -s * 0.5;
  }
  // wide-brim hat, bent tip with a star, glowing band
  b.cyl(upper, 0.5, 0.5, 0.045, b.m(0x1b3a78, { rough: 0.85 }), 0, 1.13, 0, 28);
  const hatMid = b.cone(upper, 0.31, 0.5, b.m(0x1f4590, { rough: 0.85 }), 0, 1.4, -0.02, 20);
  hatMid.rotation.x = -0.08;
  const hatTip = b.cone(upper, 0.15, 0.5, b.m(0x1f4590, { rough: 0.85 }), 0, 1.78, -0.16, 16);
  hatTip.rotation.x = -0.65;
  const band = b.torus(upper, 0.31, 0.04, b.m(0xe2c870, { metal: 0.6, rough: 0.35 }), 0, 1.17, 0);
  band.rotation.x = Math.PI / 2;
  b.plain(() => b.ball(upper, 0.055, b.m(trim, { glow: 1.8 }), 0, 1.19, 0.31));
  // face: eyes, long silver hair and beard
  eyes(b, r, 1.0, 0.195, 0x3fb0ff);
  const hair = b.ball(upper, 0.235, b.m(0xe8e8f0, { rough: 0.9 }), 0, 0.97, -0.07);
  hair.scale.set(1.0, 1.0, 0.9);
  const beard = b.cone(upper, 0.15, 0.42, b.m(0xe8e8f0, { rough: 0.9 }), 0, 0.76, 0.14, 12);
  beard.rotation.x = Math.PI;
  // staff with a floating, spinning arcane orb
  const staff = new THREE.Group();
  staff.position.set(0, -0.62, 0.06);
  b.cyl(staff, 0.035, 0.045, 1.9, b.m(0x5a3b22, { rough: 0.7 }), 0, 0.3, 0, 10);
  b.cone(staff, 0.09, 0.2, b.m(0xe2c870, { metal: 0.8, rough: 0.3 }), 0, 1.3, 0, 6).rotation.x = Math.PI;
  const orbGroup = new THREE.Group();
  orbGroup.position.set(0, 1.62, 0);
  b.plain(() => {
    b.ball(orbGroup, 0.15, b.m(trim, { glow: 1.6, rough: 0.15 }), 0, 0, 0);
    b.glow(orbGroup, new THREE.SphereGeometry(0.3, 16, 12), trim, 0.22);
    for (const [tilt, speed] of [[0.4, 1.6], [-0.7, -1.1]] as const) {
      const ring = b.torus(orbGroup, 0.24, 0.012, b.m(0xffffff, { glow: 1.4 }), 0, 0, 0);
      ring.rotation.x = Math.PI / 2 + tilt;
      b.anim.push((t) => (ring.rotation.z = t * speed));
    }
  });
  b.anim.push((t) => (orbGroup.position.y = 1.62 + Math.sin(t * 2.4) * 0.035));
  staff.add(orbGroup);
  r.armR.add(staff);
  return r;
}

function priest(b: Builder): Rig {
  const white = 0xf4f0e6;
  const gold = 0xe8b93c;
  const r = rig(b, { torso: white, torsoW: 0.58, sleeve: white, pants: white, boots: 0xc9b27a, glove: 0xf2d9bf, hidden: true, armW: 0.15, headR: 0.22 });
  const { root, upper } = r;
  b.lathe(root, [[0.0, 0.0], [0.58, 0.0], [0.55, 0.12], [0.47, 0.4], [0.38, 0.7], [0.32, 0.95], [0.0, 0.95]], b.m(white, { rough: 0.85 }), 0, 0.02, 0, 32);
  b.torus(root, 0.575, 0.04, b.m(gold, { metal: 0.7, rough: 0.3 }), 0, 0.07, 0).rotation.x = Math.PI / 2;
  // gold mantle, stole with a glowing cross, belt
  b.lathe(upper, [[0.27, -0.11], [0.45, -0.17], [0.46, -0.04], [0.24, 0.0]], b.m(gold, { metal: 0.65, rough: 0.35 }), 0, 0.72, 0, 24).scale.set(1.2, 1, 1);
  b.rbox(upper, 0.17, 1.0, 0.05, b.m(0xb0262a, { rough: 0.7 }), 0, 0.1, 0.22, 0.02);
  b.rbox(upper, 0.2, 0.05, 0.06, b.m(gold, { metal: 0.7, rough: 0.3 }), 0, 0.55, 0.235, 0.015);
  b.plain(() => {
    b.box(r.upper, 0.04, 0.2, 0.03, b.m(0xfff0a0, { glow: 1.6 }), 0, 0.42, 0.255);
    b.box(r.upper, 0.14, 0.04, 0.03, b.m(0xfff0a0, { glow: 1.6 }), 0, 0.46, 0.255);
  });
  b.rbox(upper, 0.64, 0.1, 0.42, b.m(gold, { metal: 0.65, rough: 0.35 }), 0, 0.1, 0, 0.05);
  // radiant halo (spins slowly) and glowing wings of light
  const halo = new THREE.Group();
  halo.position.set(0, 1.42, -0.02);
  b.plain(() => {
    const ring = b.torus(halo, 0.25, 0.028, b.m(0xfff0a0, { glow: 1.8 }), 0, 0, 0);
    ring.rotation.x = Math.PI / 2;
    const ring2 = b.glow(halo, new THREE.TorusGeometry(0.25, 0.09, 8, 28), 0xffe9a0, 0.28);
    ring2.rotation.x = Math.PI / 2;
  });
  upper.add(halo);
  b.anim.push((t) => (halo.position.y = 1.42 + Math.sin(t * 2) * 0.02));
  const wings = new THREE.Group();
  wings.position.set(0, 0.55, -0.26);
  upper.add(wings);
  for (const s of [-1, 1]) {
    const w = new THREE.Group();
    wings.add(w);
    for (let i = 0; i < 4; i++) {
      const f = b.glow(w, new THREE.PlaneGeometry(0.18, 0.62 - i * 0.07), i % 2 ? 0xffe9a0 : 0xfff6d0, 0.32);
      f.geometry.translate(0, 0.28, 0);
      f.position.set(s * (0.1 + i * 0.09), 0.1 - i * 0.04, 0);
      f.rotation.z = -s * (0.5 + i * 0.28);
    }
    b.anim.push((t) => (w.rotation.y = s * (0.35 + Math.sin(t * 2.2) * 0.07)));
  }
  eyes(b, r, 1.0, 0.195, 0x2f8f5a);
  const hair = b.ball(upper, 0.235, b.m(0xe6cf86, { rough: 0.85 }), 0, 0.99, -0.06);
  hair.scale.set(1.0, 1.0, 0.92);
  const bun = b.ball(upper, 0.11, b.m(0xe6cf86, { rough: 0.85 }), 0, 1.14, -0.2);
  void bun;
  // mace (right hand)
  const mace = new THREE.Group();
  mace.position.set(0, -0.62, 0.06);
  mace.rotation.x = Math.PI / 2;
  b.cyl(mace, 0.035, 0.045, 0.9, b.m(0x6b4a2b, { rough: 0.7 }), 0, 0.3, 0, 10);
  b.ball(mace, 0.15, b.m(gold, { metal: 0.7, rough: 0.3, glow: 0.35 }), 0, 0.82, 0);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const fl = b.rbox(mace, 0.05, 0.16, 0.08, b.m(gold, { metal: 0.7, rough: 0.3 }), Math.cos(a) * 0.16, 0.82, Math.sin(a) * 0.16, 0.02);
    fl.rotation.y = -a;
  }
  b.plain(() => b.glow(mace, new THREE.SphereGeometry(0.26, 14, 10), 0xfff0a0, 0.22, 0, 0.82, 0));
  r.armR.add(mace);
  // glowing tome (left hand)
  const tome = new THREE.Group();
  tome.position.set(0.04, -0.62, 0.14);
  b.rbox(tome, 0.3, 0.06, 0.38, b.m(0x7a2f2f, { rough: 0.7 }), 0, 0, 0, 0.02);
  b.rbox(tome, 0.25, 0.05, 0.33, b.m(0xfff0a0, { glow: 0.8 }), 0, 0.03, 0, 0.015);
  b.plain(() => b.glow(tome, new THREE.CircleGeometry(0.28, 20), 0xfff0a0, 0.3, 0, 0.08, 0).rotation.x = -Math.PI / 2);
  r.armL.add(tome);
  return r;
}

function rogue(b: Builder): Rig {
  const leather = 0x2c2c38;
  const dark = 0x1c1c26;
  const gold = 0xffe94a;
  const r = rig(b, { torso: leather, torsoW: 0.54, torsoD: 0.32, sleeve: 0x25252f, pants: dark, boots: 0x15151c, glove: 0x15151c, legW: 0.2, armW: 0.14, metal: 0.2, headR: 0.21 });
  const { upper } = r;
  upper.rotation.x = 0.14; // permanent forward lean, set again in pose()
  addCape(b, r, 0x16161d, 0x6a5a30, 0.54, 1.0);
  // belt, buckle and crossed bandolier with tiny vials
  b.rbox(upper, 0.6, 0.1, 0.36, b.m(0x3a2f27, { rough: 0.6 }), 0, 0.1, 0, 0.04);
  b.rbox(upper, 0.1, 0.1, 0.05, b.m(gold, { metal: 0.8, rough: 0.3 }), 0, 0.1, 0.19, 0.02);
  const strap = b.rbox(upper, 0.09, 0.85, 0.36, b.m(0x5a4a2a, { rough: 0.6 }), 0.05, 0.46, 0, 0.03);
  strap.rotation.z = 0.55;
  b.plain(() => {
    for (let i = 0; i < 3; i++) b.cyl(upper, 0.024, 0.024, 0.09, b.m(0x6dff9a, { glow: 1.2 }), -0.12 + i * 0.1, 0.62 - i * 0.14, 0.2, 8);
  });
  // shoulder spikes and bracers
  for (const s of [-1, 1]) {
    const sp = b.cone(upper, 0.06, 0.26, b.m(0x4a4a58, { metal: 0.7, rough: 0.35 }), s * 0.34, 0.85, 0, 6);
    sp.rotation.z = -s * 0.7;
  }
  for (const arm of [r.armL, r.armR]) b.rbox(arm, 0.19, 0.18, 0.19, b.m(0x3a2f27, { rough: 0.6 }), 0, -0.46, 0, 0.05);
  // deep hood with a shadowed face, scarf and glowing eyes
  const hood = b.ball(upper, 0.25, b.m(leather, { rough: 0.9 }), 0, 0.99, -0.03);
  hood.scale.set(1.0, 1.06, 1.08);
  const peak = b.cone(upper, 0.2, 0.34, b.m(leather, { rough: 0.9 }), 0, 1.04, -0.22, 12);
  peak.rotation.x = -1.95;
  b.rbox(upper, 0.31, 0.2, 0.14, b.m(0x0c0c12, { rough: 1 }), 0, 0.96, 0.15, 0.06);
  b.rbox(upper, 0.34, 0.12, 0.3, b.m(0x7a1f2a, { rough: 0.9 }), 0, 0.84, 0.03, 0.05);
  b.plain(() => {
    for (const x of [-0.075, 0.075]) b.box(upper, 0.07, 0.025, 0.03, b.m(gold, { glow: 2.0 }), x, 0.99, 0.225).rotation.z = x < 0 ? -0.2 : 0.2;
  });
  // twin curved daggers with venom-green edges
  for (const [arm, s] of [[r.armR, -1], [r.armL, 1]] as const) {
    const d = new THREE.Group();
    d.position.set(0, -0.62, 0.05);
    d.rotation.x = Math.PI / 2;
    d.rotation.z = s * 0.1;
    b.cyl(d, 0.03, 0.03, 0.14, b.m(0x3a2f27), 0, 0, 0, 8);
    b.rbox(d, 0.16, 0.035, 0.06, b.m(0x6a6e7a, { metal: 0.8, rough: 0.3 }), 0, 0.08, 0, 0.012);
    const blade = b.rbox(d, 0.06, 0.46, 0.016, b.m(0xd2d9e4, { metal: 0.9, rough: 0.2 }), 0, 0.33, 0, 0.007);
    blade.rotation.x = 0.0;
    const tip = b.cone(d, 0.03, 0.12, b.m(0xd2d9e4, { metal: 0.9, rough: 0.2 }), 0, 0.62, 0.01, 4);
    tip.scale.z = 0.3;
    tip.rotation.x = 0.15;
    b.plain(() => b.box(d, 0.012, 0.4, 0.022, b.m(0x6dff9a, { glow: 1.6 }), 0, 0.33, 0));
    arm.add(d);
  }
  return r;
}


// ------------------------------------------------------------------ gear looks

const FLAVOR_COLOR: Record<string, number> = { fury: 0xe0392b, bulwark: 0x3f7fe0, tempo: 0x21c9c0, balance: 0xf0c53a };
/** Where each class's head, shoulders and so on sit, so worn gear lands on the right spot. */
const FIT: Record<ClassId, { headTop: number; headR: number; tw: number; chestZ: number; robe: boolean; legW: number; pauldronX: number; pauldronY: number }> = {
  warrior: { headTop: 1.58, headR: 0.285, tw: 0.78, chestZ: 0.31, robe: false, legW: 0.26, pauldronX: 0.52, pauldronY: 0.98 },
  mage: { headTop: 2.12, headR: 0.25, tw: 0.58, chestZ: 0.235, robe: true, legW: 0.23, pauldronX: 0.4, pauldronY: 0.84 },
  priest: { headTop: 1.72, headR: 0.25, tw: 0.58, chestZ: 0.285, robe: true, legW: 0.23, pauldronX: 0.4, pauldronY: 0.84 },
  rogue: { headTop: 1.44, headR: 0.275, tw: 0.54, chestZ: 0.2, robe: false, legW: 0.2, pauldronX: 0.36, pauldronY: 0.84 },
};
const hexNum = (c: string) => parseInt(c.replace('#', ''), 16) || 0x9d9d9d;

/**
 * Draws what a unit has equipped on top of its class model, in a way you can see from across the arena.
 * - The flavor (Fury red, Bulwark blue, Tempo teal, Balance gold) tints the armour pieces and their gems at every tier.
 * - The tier or loot rarity (rank 1-5) sets the metal sheen and how elaborate each piece is: plain at rank 1, spikes and
 *   studs from rank 3, glow and a halo at the top.
 * Nothing equipped in a slot draws nothing there, so a bare character shows just its class look.
 */
function wearGear(b: Builder, r: Rig, classId: ClassId, look: Record<string, LookPiece>) {
  const fit = FIT[classId];
  const { upper } = r;
  const accentOf = (p: LookPiece) => FLAVOR_COLOR[p.flavor] ?? 0xf0c53a;
  /** Armour colour: the tier colour pulled strongly towards the flavor, so both show. */
  const armorHex = (p: LookPiece) => new THREE.Color(hexNum(p.color)).lerp(new THREE.Color(accentOf(p)), 0.6).getHex();
  const armor = (p: LookPiece) => b.m(armorHex(p), { metal: 0.45 + 0.1 * p.rank, rough: 0.5 - 0.06 * p.rank });
  const trim = (p: LookPiece) => b.m(hexNum(p.color), { metal: 0.8, rough: 0.3 });
  const gem = (p: LookPiece) => b.m(accentOf(p), { glow: 1.1 + 0.2 * p.rank, rough: 0.25 });

  // head: a band round the brow, a gem, side fins from rank 3, a crown of spikes from rank 4, a halo at rank 5
  const head = look.head;
  if (head?.rank) {
    const R = fit.headR;
    const band = b.torus(upper, R, 0.03 + 0.006 * head.rank, armor(head), 0, 1.03, 0);
    band.rotation.x = Math.PI / 2;
    b.plain(() => b.ball(upper, 0.04 + 0.006 * head.rank, gem(head), 0, 1.03, R + 0.01));
    if (head.rank >= 2) {
      const brow = b.rbox(upper, 0.12 + 0.02 * head.rank, 0.07, 0.05, trim(head), 0, 1.03, R + 0.02, 0.02);
      brow.renderOrder = 1;
    }
    if (head.rank >= 3) {
      for (const sd of [-1, 1]) {
        const fin = b.cone(upper, 0.05 + 0.01 * head.rank, 0.22 + 0.05 * head.rank, armor(head), sd * (R + 0.02), 1.12, -0.02, 6);
        fin.rotation.z = -sd * (0.9 + 0.05 * head.rank);
      }
    }
    if (head.rank >= 4) {
      const n = head.rank === 4 ? 5 : 7;
      for (let i = 0; i < n; i++) {
        const ang = -Math.PI / 2 + (i / (n - 1)) * Math.PI; // front arc, over the brow
        const sp = b.cone(upper, 0.03, 0.14 + 0.02 * head.rank, trim(head), Math.sin(ang) * (R + 0.01), 1.12, Math.cos(ang) * (R + 0.01) * 0.6 - 0.02, 6);
        sp.rotation.z = -Math.sin(ang) * 0.5;
      }
    }
    if (head.rank >= 5) {
      const halo = b.glow(upper, new THREE.TorusGeometry(0.3, 0.015, 8, 36), accentOf(head), 0.75, 0, fit.headTop - 0.05, 0);
      halo.rotation.x = Math.PI / 2;
      b.anim.push((t) => (halo.rotation.z = t * 1.2));
    }
  }

  // chest: shoulder plates, a tabard in the flavor colour with a metal frame, and (high rank) glow
  const chest = look.chest;
  if (chest?.rank) {
    for (const sd of [-1, 1]) {
      const pd = b.ball(upper, 0.13 + 0.025 * chest.rank, armor(chest), sd * fit.pauldronX, fit.pauldronY, 0);
      pd.scale.set(1.15, 0.7, 1.1);
      const rim = b.torus(upper, 0.13 + 0.025 * chest.rank, 0.016 + 0.003 * chest.rank, trim(chest), sd * fit.pauldronX, fit.pauldronY - 0.03, 0);
      rim.rotation.x = Math.PI / 2;
      rim.scale.set(1.15, 1.1, 1);
      if (chest.rank >= 3) {
        const sp = b.cone(upper, 0.05, 0.12 + 0.05 * chest.rank, trim(chest), sd * (fit.pauldronX + 0.04), fit.pauldronY + 0.1, 0, 6);
        sp.rotation.z = -sd * 0.45;
      }
      if (chest.rank >= 5) b.glow(upper, new THREE.SphereGeometry(0.26, 12, 10), accentOf(chest), 0.18, sd * fit.pauldronX, fit.pauldronY, 0);
    }
    const len = 0.26 + 0.05 * chest.rank;
    b.rbox(upper, 0.26 + 0.02 * chest.rank, len, 0.03, b.m(accentOf(chest), { rough: 0.8 }), 0, 0.62 - len / 2, fit.chestZ, 0.012);
    b.rbox(upper, 0.3 + 0.02 * chest.rank, 0.06, 0.05, trim(chest), 0, 0.6, fit.chestZ + 0.005, 0.02);
    b.plain(() => b.ball(upper, 0.04 + 0.006 * chest.rank, gem(chest), 0, 0.5, fit.chestZ + 0.035));
    if (chest.rank >= 4) b.glow(upper, new THREE.SphereGeometry(0.2, 12, 10), accentOf(chest), 0.16, 0, 0.5, 0.1);
  }

  // legs: greaves and knee guards on plate and leather; a coloured, heavier hem on robes
  const legs = look.legs;
  if (legs?.rank) {
    if (fit.robe) {
      const hemBand = b.cyl(r.root, 0.6, 0.64, 0.1 + 0.015 * legs.rank, armor(legs), 0, 0.1, 0, 32);
      hemBand.renderOrder = 1;
      const edge = b.torus(r.root, 0.63, 0.018 + 0.004 * legs.rank, trim(legs), 0, 0.2 + 0.015 * legs.rank, 0);
      edge.rotation.x = Math.PI / 2;
      b.plain(() => {
        const g = b.torus(r.root, 0.645, 0.012, b.m(accentOf(legs), { glow: 1.2 + 0.2 * legs.rank }), 0, 0.045, 0);
        g.rotation.x = Math.PI / 2;
      });
      if (legs.rank >= 3) for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        b.plain(() => b.ball(r.root, 0.03, gem(legs), Math.cos(a) * 0.63, 0.11, Math.sin(a) * 0.63));
      }
    } else {
      const w = fit.legW;
      for (const leg of [r.legL, r.legR]) {
        b.rbox(leg, w + 0.07, 0.36, 0.34, armor(legs), 0, -0.5, 0.01, 0.07);
        const knee = b.ball(leg, 0.11 + 0.012 * legs.rank, trim(legs), 0, -0.3, 0.12);
        knee.scale.set(1.1, 0.9, 0.85);
        b.plain(() => b.ball(leg, 0.03 + 0.004 * legs.rank, gem(legs), 0, -0.3, 0.2));
        if (legs.rank >= 3) b.rbox(leg, w + 0.09, 0.05, 0.36, trim(legs), 0, -0.34, 0.01, 0.02);
        if (legs.rank >= 4) b.plain(() => (b.torus(leg, w * 0.62, 0.016, b.m(accentOf(legs), { glow: 1.4 }), 0, -0.62, 0).rotation.x = Math.PI / 2));
      }
    }
  }

  // weapon: a flavor-coloured aura round the weapon hand, with sparks orbiting from rank 2
  const weapon = look.weapon;
  if (weapon?.rank) {
    const aura = new THREE.Group();
    aura.position.set(0, -0.6, 0.05);
    r.armR.add(aura);
    b.glow(aura, new THREE.SphereGeometry(0.17 + 0.03 * weapon.rank, 16, 12), accentOf(weapon), 0.2 + 0.06 * weapon.rank, 0, 0, 0);
    const pts: THREE.Object3D[] = [];
    for (let i = 0; i < weapon.rank + 1; i++) pts.push(b.glow(aura, new THREE.SphereGeometry(0.035, 8, 6), hexNum(weapon.color), 0.95, 0, 0, 0));
    b.anim.push((t) => pts.forEach((m, i) => {
      const a = t * 2.6 + (i / pts.length) * Math.PI * 2;
      m.position.set(Math.cos(a) * 0.3, Math.sin(a * 0.7) * 0.2, Math.sin(a) * 0.3);
    }));
  }

  // trinket: a charm that floats beside the hip, in the flavor colour, bigger and brighter with rank
  const trinket = look.trinket;
  if (trinket?.rank) {
    const charm = new THREE.Group();
    upper.add(charm);
    b.plain(() => b.add(charm, new THREE.OctahedronGeometry(0.08 + 0.012 * trinket.rank), b.m(accentOf(trinket), { glow: 1.0 + 0.25 * trinket.rank, rough: 0.3 }), 0, 0, 0));
    b.glow(charm, new THREE.SphereGeometry(0.13 + 0.018 * trinket.rank, 10, 8), hexNum(trinket.color), 0.3, 0, 0, 0);
    b.anim.push((t) => {
      charm.position.set(0.55, 0.12 + Math.sin(t * 2.1) * 0.06, -0.05);
      charm.rotation.y = t * 1.6;
    });
  }
}

const BUILDERS: Record<ClassId, (b: Builder) => Rig> = { warrior, mage, priest, rogue };
const LEAN: Record<ClassId, number> = { warrior: 0, mage: 0, priest: 0, rogue: 0.14 };
const RESTING_ARMS: Record<ClassId, number> = { warrior: -0.15, mage: -0.2, priest: -0.15, rogue: -0.35 };

export function createCharacter(classId: ClassId, look?: string): Character {
  const b = new Builder();
  const r = BUILDERS[classId](b);
  if (look) wearGear(b, r, classId, parseLook(look));
  const lean = LEAN[classId];
  const armRest = RESTING_ARMS[classId];
  let lastAlive = true;
  let lastStealth = false;
  let swingT = 0;
  let flashT = 0;
  const SWING = 0.38;
  let swingHand = 0;
  // smoothed joint state so nothing ever snaps
  const st = { sign: 1, upX: lean, upZ: 0, bob: 0, legL: 0, legR: 0, armLx: armRest, armRx: armRest, armLz: 0, armRz: 0, twist: 0, lunge: 0, cape: 0.08, capeV: 0, lastVf: 0 };

  const applyState = (alive: boolean, stealthed: boolean) => {
    for (const m of b.mats) {
      const base = m.userData.base as THREE.Color;
      m.color.copy(base);
      if (!alive) m.color.lerp(DEAD_GRAY, 0.75);
      m.emissiveIntensity = alive ? (m.userData.glow as number) : 0;
      m.transparent = stealthed;
      m.opacity = stealthed ? 0.35 : 1;
      m.needsUpdate = true;
    }
    b.setOutline(alive, stealthed);
  };

  let flashed = false;
  const setFlash = (v: number) => {
    flashed = v > 0;
    for (const m of b.mats) {
      if (v > 0) {
        m.emissive.set(0xff2a1a);
        m.emissiveIntensity = 0.7 * v;
      } else {
        m.emissive.set(m.userData.glow ? (m.userData.base as THREE.Color) : 0x000000);
        m.emissiveIntensity = m.userData.glow as number;
      }
    }
  };

  return {
    root: r.root,
    meshes: b.meshes,
    setState(alive, stealthed) {
      if (alive !== lastAlive || stealthed !== lastStealth) {
        lastAlive = alive;
        lastStealth = stealthed;
        applyState(alive, stealthed);
      }
      // lie flat on the ground when dead
      if (alive) {
        r.root.rotation.x = 0;
        r.root.position.y = 0;
      } else {
        r.root.rotation.x = -Math.PI / 2;
        r.root.position.y = 0.28;
      }
    },
    swing() {
      swingT = SWING;
      if (classId === 'rogue') swingHand = 1 - swingHand; // twin daggers strike in turn
    },
    flash() {
      flashT = 0.2;
    },
    pose({ phase, move, casting, time, dt: rawDt, vf: vfIn, vs: vsIn }) {
      const dt = clamp(rawDt, 0.001, 0.1);
      const vf = vfIn ?? move * 7;
      const vs = vsIn ?? 0;
      for (const a of b.anim) a(time, move);

      // gait: reverses when backpedalling, eased so direction changes do not snap
      st.sign = damp(st.sign, vf < -0.6 ? -1 : 1, 14, dt);
      const stride = Math.sin(phase) * 0.82 * move * st.sign;
      const breathe = Math.sin(time * 2.0) * 0.02;

      // body: lean into the run, roll into strafes, counter-twist against the legs, bob on each step
      st.upX = damp(st.upX, lean + 0.11 * clamp(vf / 7, -0.5, 1) + breathe, 9, dt);
      st.upZ = damp(st.upZ, -clamp(vs / 7, -1, 1) * 0.13 + Math.sin(phase) * 0.045 * move + Math.sin(time * 0.8) * 0.012 * (1 - move), 10, dt);
      st.bob = damp(st.bob, Math.abs(Math.sin(phase)) * 0.06 * move + breathe * 0.5, 16, dt);
      r.upper.rotation.x = st.upX;
      r.upper.rotation.z = st.upZ;
      r.upper.position.y = HIP + st.bob;

      st.legL = damp(st.legL, stride, 34, dt);
      st.legR = damp(st.legR, -stride, 34, dt);
      r.legL.rotation.x = st.legL;
      r.legR.rotation.x = st.legR;
      r.legL.rotation.z = r.legR.rotation.z = 0;

      // arms: swing opposite the legs, hang loose when idle, rise smoothly into a cast
      let tLx = armRest - stride * 1.05 + Math.sin(time * 1.3) * 0.02 * (1 - move);
      let tRx = armRest + stride * 1.05 - Math.sin(time * 1.3) * 0.02 * (1 - move);
      let tLz = 0.07 + move * 0.03;
      let tRz = -0.07 - move * 0.03;
      let twist = -stride * 0.14;
      let armRate = 22;
      let lunge = 0;
      if (casting) {
        const shake = Math.sin(time * 16) * 0.02;
        tLx = -1.3 + shake;
        tRx = -1.45 - shake;
        tLz = 0.16;
        tRz = -0.16;
        armRate = 13;
      }
      if (swingT > 0) {
        // anticipation -> fast strike -> follow-through -> settle
        const p = 1 - swingT / SWING;
        let arc: number;
        let tw: number;
        if (p < 0.3) {
          const k = easeOut(p / 0.3);
          arc = lerp(armRest, -2.5, k);
          tw = -0.5 * k;
        } else if (p < 0.52) {
          const k = (p - 0.3) / 0.22;
          arc = lerp(-2.5, 0.55, k * k * k);
          tw = lerp(-0.5, 0.45, easeOut(k));
          lunge = Math.sin(k * Math.PI * 0.5) * 0.2;
        } else {
          const k = smooth((p - 0.52) / 0.48);
          arc = lerp(0.55, armRest, k);
          tw = lerp(0.45, 0, k);
          lunge = 0.2 * (1 - k);
        }
        const hit = classId === 'rogue' && swingHand === 1 ? 'L' : 'R';
        if (hit === 'R') {
          tRx = arc;
          if (classId === 'rogue') tLx = armRest - 0.3 + (arc - armRest) * -0.25;
        } else {
          tLx = arc;
          tRx = armRest - 0.3 + (arc - armRest) * -0.25;
          tw = -tw;
        }
        twist = tw;
        armRate = 55;
        swingT = Math.max(0, swingT - dt);
      }
      st.armLx = damp(st.armLx, tLx, armRate, dt);
      st.armRx = damp(st.armRx, tRx, armRate, dt);
      st.armLz = damp(st.armLz, tLz, 14, dt);
      st.armRz = damp(st.armRz, tRz, 14, dt);
      r.armL.rotation.x = st.armLx;
      r.armR.rotation.x = st.armRx;
      r.armL.rotation.z = st.armLz;
      r.armR.rotation.z = st.armRz;
      st.twist = damp(st.twist, twist, swingT > 0 ? 40 : 12, dt);
      r.upper.rotation.y = st.twist;
      st.lunge = damp(st.lunge, lunge, 30, dt);
      r.root.position.z = st.lunge;

      // cape: a damped spring that lags behind acceleration and streams out at speed
      if (r.cape) {
        const target = 0.08 + move * 0.5 * (st.sign > 0 ? 1 : -0.3) + Math.sin(time * 2.4 + phase) * 0.05 * (0.4 + move);
        st.capeV -= (vf - st.lastVf) * 0.04;
        st.capeV += (62 * (target - st.cape) - 9 * st.capeV) * dt;
        st.cape += st.capeV * dt;
        st.lastVf = vf;
        r.cape.rotation.x = st.cape;
        r.cape.rotation.z = -clamp(vs / 7, -1, 1) * 0.15;
      }

      if (flashT > 0 || flashed) {
        flashT = Math.max(0, flashT - dt);
        setFlash(flashT > 0 ? flashT / 0.2 : 0);
      }
    },
  };
}

/** Polymorph form. Smaller than a person, same interface, so the scene can swap it in. */
export function createSheep(): Character {
  const b = new Builder();
  const root = new THREE.Group();
  const wool = b.m(0xf4f1ea, { rough: 1, metal: 0 });
  const dark = b.m(0x3a3430, { rough: 0.9 });
  const body = b.ball(root, 0.5, wool, 0, 0.72, 0);
  body.scale.set(0.85, 0.8, 1.15);
  for (const [x, y, z] of [[0.25, 0.95, 0.2], [-0.25, 0.95, 0.15], [0, 1.0, -0.15], [0.3, 0.7, -0.35], [-0.3, 0.7, -0.35]] as const) b.ball(root, 0.27, wool, x, y, z);
  const head = b.ball(root, 0.2, dark, 0, 0.95, 0.62);
  head.scale.set(0.9, 1, 1.15);
  b.ball(root, 0.2, wool, 0, 1.12, 0.52);
  for (const s of [-1, 1]) {
    const ear = b.ball(root, 0.09, dark, s * 0.22, 0.98, 0.55);
    ear.scale.set(1.4, 0.5, 0.8);
    b.ball(root, 0.035, b.m(0xffffff), s * 0.1, 1.0, 0.78);
  }
  const legs: THREE.Group[] = [];
  for (const [x, z] of [[0.2, 0.3], [-0.2, 0.3], [0.2, -0.3], [-0.2, -0.3]] as const) {
    const g = new THREE.Group();
    g.position.set(x, 0.42, z);
    b.box(g, 0.1, 0.42, 0.1, dark, 0, -0.21, 0);
    root.add(g);
    legs.push(g);
  }
  const tail = b.ball(root, 0.12, wool, 0, 0.8, -0.58);
  void tail;
  let flashT = 0;
  const setFlash = (v: number) => {
    for (const m of b.mats) {
      m.emissive.set(v > 0 ? 0xff2a1a : 0x000000);
      m.emissiveIntensity = 0.7 * v;
    }
  };
  let lastAlive = true;
  let lastStealth = false;
  return {
    root,
    meshes: b.meshes,
    swing() {},
    flash() {
      flashT = 0.2;
    },
    setState(alive, stealthed) {
      if (alive !== lastAlive || stealthed !== lastStealth) {
        lastAlive = alive;
        lastStealth = stealthed;
        for (const m of b.mats) {
          m.color.copy(m.userData.base as THREE.Color);
          if (!alive) m.color.lerp(DEAD_GRAY, 0.75);
          m.transparent = stealthed;
          m.opacity = stealthed ? 0.35 : 1;
          m.needsUpdate = true;
        }
        b.setOutline(alive, stealthed);
      }
      root.rotation.x = alive ? 0 : -Math.PI / 2;
      root.position.y = alive ? 0 : 0.3;
    },
    pose({ phase, move, time, dt }) {
      const sw = Math.sin(phase * 1.3) * 0.6 * move;
      legs[0].rotation.x = sw;
      legs[3].rotation.x = sw;
      legs[1].rotation.x = -sw;
      legs[2].rotation.x = -sw;
      body.position.y = 0.72 + Math.abs(Math.sin(phase * 1.3)) * 0.04 * move + Math.sin(time * 2) * 0.01;
      if (flashT > 0) {
        flashT = Math.max(0, flashT - dt);
        setFlash(flashT / 0.2);
      }
    },
  };
}
