import { SHOUT_DUR, newShoutPose, shoutPose } from './shoutPose';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { parseLook, clamp } from '@arena/shared';
import type { ClassId, CosmeticItem } from '@arena/shared';
import { RigAnimator } from './riggedPose';
import { attachWeapon, WEAPONS } from './weaponModels';
import type { AttachedWeapon, WeaponLook } from './weaponModels';
import { instantiate, riggedAssetFor } from './riggedModels';
import type { RigAsset, RigDriver } from './riggedModels';
import { buildCape, isCapeItem, DEFAULT_CAPE_FIT } from './capeModels';
import { buildWings, DEFAULT_WING_FIT } from './wingModels';
import type { WingFit } from './wingModels';
import type { CapeFit, CapeInput } from './capeModels';

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
  /** Height above the ground (jumps), for the airborne pose of rigged models. */
  air?: number;
}

/**
 * Cosmetic slots that have a built-in counterpart on the class model. A base part tagged with one of these is removed from
 * the model while a cosmetic item is worn in that slot (a "none" selection keeps the base part). The weapon, aura, dye and
 * companion slots only add to the model, so they have no base part.
 */
export const REPLACEABLE_SLOTS = ['head', 'back'] as const;
export type ReplaceableSlot = (typeof REPLACEABLE_SLOTS)[number];

export interface Character {
  root: THREE.Group;
  /** Every mesh, for picking. */
  meshes: THREE.Mesh[];
  /** The model's built-in parts per cosmetic slot. A part worn over by a cosmetic is detached (no parent, invisible). */
  parts: Record<string, THREE.Group[]>;
  pose(p: PoseInput): void;
  /** Play a quick melee swing (`fast`: a short one, for a flurry of them). */
  swing(fast?: boolean): void;
  /** Flash red for a moment (took a hit). */
  flash(): void;
  setState(alive: boolean, stealthed: boolean): void;
  /** Play the shout pose (lean back, chest out, then snap forward; shoutPose.ts): a shout, roar, scream or breath. */
  shout(): void;
  /** A spell was cast (only models with a cast animation have it: clip models play their attack clip). */
  cast?(): void;
}

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
  /** Per-frame cloth motion of worn capes (they need the wearer's speed, see capeModels.ts). */
  readonly motion: ((p: CapeInput) => void)[] = [];
  readonly outline = makeOutlineMaterial(0.014);
  outlines = true;
  /** Built-in parts by cosmetic slot (see `part`). */
  readonly parts: Record<string, { group: THREE.Group; meshes: THREE.Mesh[]; fx: THREE.Object3D[]; anim: ((t: number, move: number) => void)[] }[]> = {};
  /** What to draw in place of a slot's base part once a cosmetic replaces it (e.g. the bare face under a helm). */
  readonly bare: Record<string, () => void> = {};
  private geos = new Map<string, THREE.BufferGeometry>();
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

  /** One geometry per distinct shape, shared by every mesh that uses it (mirrored limbs, repeated plates). */
  geoShared(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let g = this.geos.get(key);
    if (!g) {
      g = make();
      this.geos.set(key, g);
    }
    return g;
  }

  /**
   * Build a built-in part of the model that belongs to a cosmetic slot. Everything `fn` builds goes into one group (the
   * group sits at the parent's origin, so positions inside it are the parent's own) and is remembered, so `dropPart` can
   * take the whole part away again: meshes, glows and animations alike.
   */
  part(slot: string, parent: THREE.Object3D, fn: (g: THREE.Group) => void): THREE.Group {
    const group = new THREE.Group();
    group.name = `part:${slot}`;
    parent.add(group);
    const m0 = this.meshes.length;
    const f0 = this.fx.length;
    const a0 = this.anim.length;
    fn(group);
    (this.parts[slot] ??= []).push({ group, meshes: this.meshes.slice(m0), fx: this.fx.slice(f0), anim: this.anim.slice(a0) });
    return group;
  }

  /** A cosmetic takes over `slot`: detach the base parts so the two never show together (and never get picked or animated). */
  dropPart(slot: string) {
    for (const p of this.parts[slot] ?? []) {
      p.group.removeFromParent();
      p.group.visible = false;
      const gone = new Set<unknown>([...p.meshes, ...p.fx, ...p.anim]);
      for (const list of [this.meshes, this.fx, this.anim] as unknown[][]) {
        for (let i = list.length - 1; i >= 0; i--) if (gone.has(list[i])) list.splice(i, 1);
      }
    }
    this.bare[slot]?.();
  }

  /** A built-in part that no cosmetic replaces (it is built straight into the parent). */
  body(parent: THREE.Object3D, fn: (g: THREE.Object3D) => void) {
    fn(parent);
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
    return this.add(p, this.geoShared(`b${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d)), mat, x, y, z);
  }
  /** Bevelled box: the workhorse for the stylized look. */
  rbox(p: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0, r = 0.05) {
    return this.add(p, this.geoShared(`r${w}|${h}|${d}|${r}`, () => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001))), mat, x, y, z);
  }
  ball(p: THREE.Object3D, r: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
    return this.add(p, this.geoShared(`s${r}`, () => new THREE.SphereGeometry(r, 18, 14)), mat, x, y, z);
  }
  cyl(p: THREE.Object3D, rt: number, rb: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 16) {
    return this.add(p, this.geoShared(`c${rt}|${rb}|${h}|${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg)), mat, x, y, z);
  }
  cone(p: THREE.Object3D, r: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 16) {
    return this.add(p, this.geoShared(`n${r}|${h}|${seg}`, () => new THREE.ConeGeometry(r, h, seg)), mat, x, y, z);
  }
  caps(p: THREE.Object3D, r: number, len: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
    return this.add(p, this.geoShared(`p${r}|${len}`, () => new THREE.CapsuleGeometry(r, len, 6, 14)), mat, x, y, z);
  }
  torus(p: THREE.Object3D, r: number, tube: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
    return this.add(p, this.geoShared(`t${r}|${tube}`, () => new THREE.TorusGeometry(r, tube, 10, 28)), mat, x, y, z);
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
  /** Skinned models: cosmetic anchors that follow the bones (same coordinates as `upper`), the fit measured on that model, and the animator. */
  head?: THREE.Object3D;
  shoulderL?: THREE.Object3D;
  shoulderR?: THREE.Object3D;
  fit?: Fit;
  rigged?: { anim: RigDriver; ensureOwn(): void; deadY: number };
  /** Where weapon cosmetics are centred, in the right hand group's frame, when a real weapon model is held (default: at the grip). */
  weaponGlowAt?: THREE.Vector3;
  /** Blends a shoulder-carried weapon between its one-handed rest and the two-handed hold (weaponModels.ts); the weapon cosmetics ride on `weaponPivot`. */
  weaponGrip?: (k: number) => void;
  weaponPivot?: { node: THREE.Object3D; mid: number };
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
  const p = r.head ?? r.upper;
  b.plain(() => {
    for (const s of [-x, x]) {
      b.ball(p, size * 1.5, b.m(0xffffff, { rough: 0.4 }), s, y, z - 0.012);
      b.ball(p, size, b.m(color), s, y, z + 0.004);
    }
  });
}

function addCape(b: Builder, r: Rig, parent: THREE.Object3D, color: number, trim: number, w: number, len: number) {
  const pivot = new THREE.Group();
  pivot.position.set(0, 0.7, -0.22);
  // a slightly flared, rounded cloth rather than a flat plank
  b.rbox(pivot, w, len, 0.05, b.m(color, { rough: 0.95 }), 0, -len / 2, 0, 0.02);
  b.rbox(pivot, w * 1.12, 0.08, 0.07, b.m(trim, { metal: 0.6, rough: 0.35 }), 0, -len + 0.04, 0, 0.03);
  b.rbox(pivot, w * 0.9, 0.12, 0.09, b.m(trim, { metal: 0.6, rough: 0.35 }), 0, -0.02, 0, 0.04);
  parent.add(pivot);
  r.cape = pivot;
}

/** A flat piece of cloth: a trapezoid (narrow at the top, wider at the hem, with a notch cut into it) with smooth normals. */
function clothGeo(top: number, bottom: number, len: number, notch: number, depth: number): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  sh.moveTo(-top / 2, 0);
  sh.lineTo(top / 2, 0);
  sh.lineTo(bottom / 2, -len);
  sh.lineTo(0, -len + notch);
  sh.lineTo(-bottom / 2, -len);
  sh.closePath();
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  g.computeVertexNormals();
  return g;
}

function warrior(b: Builder, weapon?: string): Rig {
  // palette: bright steel plate over dark mail, navy cloth, crimson cape, gold trim
  const steel = b.m(0xb4bccb, { metal: 0.7, rough: 0.32 });
  const steelDk = b.m(0x6b7588, { metal: 0.7, rough: 0.4 });
  const mail = b.m(0x4d576b, { metal: 0.5, rough: 0.55 });
  const navy = b.m(0x25437d, { rough: 0.75 });
  const crimson = b.m(0x9b2c2c, { rough: 0.9 });
  const gold = b.m(0xe2b53f, { metal: 0.85, rough: 0.28 });
  const leather = b.m(0x4b3425, { rough: 0.65 });
  const goldC = 0xe2b53f;

  const root = new THREE.Group();
  const upper = new THREE.Group();
  upper.position.y = HIP;
  root.add(upper);

  // ---- legs: cuisse, knee cop, greave, cuffed boot
  const mkLeg = (side: number) => {
    const g = new THREE.Group();
    g.position.set(side * 0.16, HIP, 0);
    b.rbox(g, 0.23, 0.42, 0.26, mail, 0, -0.22, 0, 0.08);
    b.rbox(g, 0.245, 0.24, 0.27, steelDk, 0, -0.2, 0.01, 0.07); // thigh plate
    const knee = b.ball(g, 0.085, gold, 0, -0.43, 0.1);
    knee.scale.set(1, 0.9, 0.7);
    b.rbox(g, 0.225, 0.32, 0.25, steel, 0, -0.58, 0.005, 0.07); // greave
    b.rbox(g, 0.1, 0.28, 0.04, steelDk, 0, -0.58, 0.14, 0.015); // shin ridge
    b.torus(g, 0.12, 0.022, gold, 0, -0.72, 0.0).rotation.x = Math.PI / 2; // boot cuff
    b.rbox(g, 0.25, 0.15, 0.27, leather, 0, -0.77, 0.0, 0.06);
    b.rbox(g, 0.24, 0.1, 0.2, leather, 0, -0.79, 0.19, 0.05); // toe
    root.add(g);
    return g;
  };
  const legL = mkLeg(1);
  const legR = mkLeg(-1);

  // ---- waist: mail skirt, belt with buckle and pouch, layered tassets and a short tabard
  b.rbox(upper, 0.6, 0.24, 0.38, mail, 0, 0.06, 0, 0.09);
  b.rbox(upper, 0.64, 0.085, 0.4, leather, 0, 0.16, 0, 0.035);
  b.rbox(upper, 0.12, 0.11, 0.05, gold, 0, 0.16, 0.2, 0.03);
  b.rbox(upper, 0.1, 0.13, 0.08, leather, 0.3, 0.07, 0.06, 0.03);
  b.rbox(upper, 0.24, 0.3, 0.04, navy, 0, -0.03, 0.215, 0.015); // tabard
  b.rbox(upper, 0.24, 0.035, 0.05, gold, 0, -0.16, 0.215, 0.012);
  for (const s of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const t = b.rbox(upper, 0.17 - i * 0.015, 0.14, 0.05, i ? steelDk : steel, s * 0.255, 0.02 - i * 0.1, 0.14 + i * 0.02, 0.025);
      t.rotation.set(0.12 + i * 0.05, s * 0.35, -s * 0.06);
    }
  }
  b.rbox(upper, 0.17, 0.12, 0.05, steel, 0, 0.03, 0.2, 0.025).rotation.x = 0.1;

  // ---- torso: banded abdomen, domed breastplate, backplate, gorget
  b.rbox(upper, 0.5, 0.2, 0.34, steelDk, 0, 0.33, 0, 0.08);
  b.rbox(upper, 0.56, 0.07, 0.38, steel, 0, 0.27, 0.0, 0.03);
  b.rbox(upper, 0.52, 0.07, 0.36, steel, 0, 0.37, 0.0, 0.03);
  b.rbox(upper, 0.72, 0.34, 0.42, steel, 0, 0.58, 0, 0.13); // chest
  const bp = b.rbox(upper, 0.58, 0.3, 0.1, steel, 0, 0.56, 0.17, 0.06); // raised breastplate
  bp.rotation.x = -0.05;
  b.rbox(upper, 0.04, 0.3, 0.12, gold, 0, 0.56, 0.2, 0.015); // central ridge
  b.rbox(upper, 0.6, 0.035, 0.12, gold, 0, 0.42, 0.18, 0.012); // lower trim
  b.plain(() => b.ball(upper, 0.045, b.m(0xffd46a, { glow: 1.4 }), 0, 0.58, 0.245));
  b.rbox(upper, 0.62, 0.5, 0.08, steelDk, 0, 0.5, -0.2, 0.05); // backplate
  b.rbox(upper, 0.08, 0.46, 0.1, gold, 0, 0.5, -0.215, 0.02);
  b.cyl(upper, 0.075, 0.085, 0.12, b.m(SKIN), 0, 0.8, 0, 10);
  b.cyl(upper, 0.14, 0.17, 0.09, steel, 0, 0.77, 0, 14); // gorget
  b.torus(upper, 0.155, 0.017, gold, 0, 0.815, 0).rotation.x = Math.PI / 2;

  // ---- arms: shoulder joint, mail upper arm, elbow cop, vambrace, gauntlet
  const mkArm = (side: number) => {
    const g = new THREE.Group();
    g.position.set(side * 0.49, 0.68, 0);
    b.ball(g, 0.1, mail, 0, 0, 0);
    b.caps(g, 0.075, 0.17, mail, 0, -0.2, 0);
    b.ball(g, 0.085, gold, 0, -0.34, -0.015).scale.set(1, 0.8, 1);
    b.cyl(g, 0.098, 0.083, 0.24, steel, 0, -0.45, 0, 12); // vambrace
    b.torus(g, 0.093, 0.017, gold, 0, -0.35, 0).rotation.x = Math.PI / 2;
    b.rbox(g, 0.16, 0.1, 0.17, steelDk, 0, -0.56, 0, 0.04); // gauntlet cuff
    b.ball(g, 0.085, leather, 0, -0.62, 0); // fist
    upper.add(g);
    return g;
  };
  const armL = mkArm(1);
  const armR = mkArm(-1);
  const r: Rig = { root, upper, legL, legR, armL, armR };

  // ---- shoulders (cosmetic slot): segmented pauldrons, a layered dome with gold trim
  for (const s of [-1, 1]) {
    b.body(upper, (g) => {
      const pd = new THREE.Group();
      pd.position.set(s * 0.5, 0.73, 0);
      pd.rotation.z = -s * 0.28;
      g.add(pd);
      const dome = b.ball(pd, 0.17, steel, 0, 0.03, 0);
      dome.scale.set(1.12, 0.62, 1.1);
      for (let i = 0; i < 3; i++) {
        const l = b.rbox(pd, 0.3 + i * 0.045, 0.07, 0.31 + i * 0.03, i === 1 ? steelDk : steel, s * i * 0.02, -0.035 - i * 0.065, 0, 0.03);
        l.rotation.z = 0;
      }
      b.torus(pd, 0.2, 0.014, gold, 0, -0.005, 0).rotation.x = Math.PI / 2;
      b.cone(pd, 0.03, 0.09, gold, 0, 0.13, 0, 6);
    });
  }

  // ---- back (cosmetic slot): a short cape hung from gold clasps
  b.part('back', upper, (g) => {
    const pivot = new THREE.Group();
    pivot.position.set(0, 0.74, -0.27);
    g.add(pivot);
    const len = 0.96;
    b.add(pivot, b.geoShared('cape', () => clothGeo(0.46, 0.64, len, 0.12, 0.035)), crimson);
    b.rbox(pivot, 0.5, 0.07, 0.06, gold, 0, -0.02, 0, 0.025); // collar
    b.rbox(pivot, 0.66, 0.045, 0.05, gold, 0, -len + 0.03, 0, 0.018); // hem trim
    for (const s of [-1, 1]) b.ball(pivot, 0.04, gold, s * 0.27, 0.0, 0.02);
    r.cape = pivot;
  });

  // ---- head: bare face under a great helm; with a cosmetic worn the face and hair show instead
  b.ball(upper, 0.2, b.m(SKIN, { rough: 0.8 }), 0, 0.99, 0);
  b.bare.head = () => {
    eyes(b, r, 0.99, 0.19, 0x3a5f8f, 0.07, 0.022);
    b.ball(upper, 0.212, b.m(0x4a3222, { rough: 0.9 }), 0, 1.01, -0.035).scale.set(1, 1, 0.92);
  };
  b.part('head', upper, (g) => {
    const skull = b.ball(g, 0.24, steel, 0, 1.0, 0);
    skull.scale.set(1, 1.04, 1.05);
    b.rbox(g, 0.31, 0.24, 0.1, steelDk, 0, 0.94, 0.17, 0.05); // face plate
    b.rbox(g, 0.46, 0.2, 0.2, steelDk, 0, 0.94, -0.02, 0.07).scale.set(1, 1, 1); // cheek and neck guard
    b.torus(g, 0.236, 0.02, gold, 0, 1.06, 0).rotation.x = Math.PI / 2; // brow band
    b.plain(() => {
      b.box(g, 0.25, 0.035, 0.04, b.m(0xffb347, { glow: 1.6 }), 0, 0.99, 0.228);
      b.box(g, 0.035, 0.12, 0.04, b.m(0xffb347, { glow: 1.6 }), 0, 0.93, 0.228);
    });
    // crest: a low arc of crimson plates, front to back
    for (let i = 0; i < 6; i++) {
      const k = i / 5;
      const seg = b.rbox(g, 0.05, 0.075 + 0.05 * Math.sin(k * Math.PI), 0.075, crimson, 0, 1.25 + 0.05 * Math.sin(k * Math.PI) - k * 0.07, 0.12 - k * 0.3, 0.02);
      seg.rotation.x = 0.35 - k * 0.7;
    }
    // horns: swept back and up, ivory with gold sockets
    for (const s of [-1, 1]) {
      b.cyl(g, 0.065, 0.075, 0.05, gold, s * 0.215, 1.07, 0, 10).rotation.z = Math.PI / 2 - s * 0.35;
      const h1 = b.cone(g, 0.055, 0.22, b.m(0xf1ead6, { rough: 0.5 }), s * 0.27, 1.16, 0, 10);
      h1.rotation.z = -s * 0.8;
      const h2 = b.cone(g, 0.034, 0.2, b.m(0xf1ead6, { rough: 0.5 }), s * 0.36, 1.3, 0, 10);
      h2.rotation.z = -s * 0.25;
    }
  });
  warriorWeapons(b, r, weapon);
  return r;
}

/** Put the spec's real weapon model (weaponModels.ts) into the hands of a rigged unit; false while it is not loaded (the caller builds the procedural one). */
function heldWeapon(b: Builder, r: Rig, weapon?: string): AttachedWeapon | undefined {
  if (!r.rigged) return undefined;
  const held = attachWeapon(weapon, {
    armR: r.armR,
    armL: r.armL,
    addMesh: (m) => b.meshes.push(m),
    addMaterial: (m) => b.mats.push(m),
    addFx: (o) => b.fx.push(o),
    glow: (parent, geo, color, opacity, x, y, z) => b.glow(parent, geo, color, opacity, x, y, z),
  });
  if (held) {
    r.rigged.anim.hold = held.hold ?? null;
    r.weaponGlowAt = held.glowAt;
    if (held.hold?.rest) {
      r.weaponGrip = held.setGrip;
      r.weaponPivot = { node: held.pivot, mid: held.mid };
    }
  }
  return held;
}

/** The warrior's spec weapons, held in the hands (`armR` / `armL` are the hand groups of whichever model is worn). */
function warriorWeapons(b: Builder, r: Rig, weapon?: string) {
  // the real weapon models (weaponModels.ts) once loaded, on the rigged knight; the procedural weapons below are the fallback
  if (heldWeapon(b, r, weapon)) return;
  const goldC = 0xe2b53f;
  // weapons: dual wield (a sword in each hand), a two-handed greatsword, a polearm, or the default sword and shield
  const blade = (len: number, width: number, glow = 0x7fd0ff) => {
    const g = new THREE.Group();
    b.cyl(g, 0.035, 0.035, 0.22, b.m(0x4a2f1b), 0, 0, 0, 8);
    b.ball(g, 0.055, b.m(goldC, { metal: 0.8, rough: 0.3 }), 0, -0.13, 0);
    b.rbox(g, 0.34 * (width / 0.1) ** 0.5, 0.055, 0.09, b.m(goldC, { metal: 0.8, rough: 0.3 }), 0, 0.12, 0, 0.02);
    b.rbox(g, width, len, 0.03, b.m(0xdfe5ee, { metal: 0.9, rough: 0.2 }), 0, 0.15 + len / 2, 0, 0.012);
    b.cone(g, width / 2, 0.14, b.m(0xdfe5ee, { metal: 0.9, rough: 0.2 }), 0, 0.15 + len + 0.07, 0, 4).scale.z = 0.3;
    b.plain(() => b.box(g, 0.022, len * 0.76, 0.036, b.m(glow, { glow: 1.5 }), 0, 0.14 + len / 2, 0));
    return g;
  };
  if (weapon === 'dual') {
    for (const arm of [r.armR, r.armL]) {
      const sw = blade(0.78, 0.085, arm === r.armR ? 0x7fd0ff : 0xff9a6a);
      sw.position.set(0, -0.62, 0.05);
      sw.rotation.x = Math.PI / 2;
      arm.add(sw);
    }
  } else if (weapon === 'twohand') {
    const sw = blade(1.55, 0.17, 0xffb347);
    sw.position.set(0, -0.62, 0.05);
    sw.rotation.x = Math.PI / 2.35; // held up and forward in both hands
    r.armR.add(sw);
    r.armL.rotation.x = -0.35; // the off-hand supports the grip
  } else if (weapon === 'polearm') {
    const pole = new THREE.Group();
    pole.position.set(0, -0.62, 0.05);
    pole.rotation.x = Math.PI / 2.15;
    b.cyl(pole, 0.032, 0.032, 2.5, b.m(0x5a3b22, { rough: 0.8 }), 0, 0.45, 0, 8);
    b.cyl(pole, 0.045, 0.045, 0.12, b.m(goldC, { metal: 0.8, rough: 0.3 }), 0, 1.62, 0, 8);
    b.cone(pole, 0.055, 0.34, b.m(0xdfe5ee, { metal: 0.9, rough: 0.2 }), 0, 1.84, 0, 4).scale.z = 0.4;
    b.rbox(pole, 0.34, 0.36, 0.03, b.m(0xdfe5ee, { metal: 0.9, rough: 0.2 }), 0.17, 1.52, 0, 0.02);
    b.rbox(pole, 0.2, 0.2, 0.03, b.m(0xc9d1de, { metal: 0.9, rough: 0.25 }), -0.1, 1.5, 0, 0.02);
    b.cone(pole, 0.03, 0.2, b.m(0xdfe5ee, { metal: 0.9, rough: 0.2 }), 0, -0.82, 0, 4);
    b.plain(() => b.box(pole, 0.02, 0.26, 0.036, b.m(0x7fd0ff, { glow: 1.4 }), 0.17, 1.52, 0));
    r.armR.add(pole);
    r.armL.rotation.x = -0.3;
  } else {
    const sword = blade(1.05, 0.1);
    sword.position.set(0, -0.62, 0.05);
    sword.rotation.x = Math.PI / 2;
    r.armR.add(sword);
    // kite-ish shield (left arm): domed face, rim, boss and emblem
    const shield = new THREE.Group();
    shield.position.set(0.24, -0.3, 0.06);
    shield.rotation.y = Math.PI / 2;
    b.rbox(shield, 0.62, 0.86, 0.08, b.m(0x1f4f9e, { rough: 0.55, metal: 0.3 }), 0, 0, 0, 0.05);
    b.rbox(shield, 0.68, 0.92, 0.05, b.m(goldC, { metal: 0.8, rough: 0.35 }), 0, 0, -0.035, 0.05);
    b.ball(shield, 0.12, b.m(goldC, { metal: 0.85, rough: 0.3 }), 0, 0.05, 0.05).scale.z = 0.5;
    b.plain(() => b.box(shield, 0.04, 0.5, 0.03, b.m(0xffe08a, { glow: 0.8 }), 0, -0.02, 0.085));
    r.armL.add(shield);
  }
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
  b.body(upper, (g) => b.lathe(g, [[0.24, -0.1], [0.4, -0.16], [0.42, -0.05], [0.2, 0.0]], b.m(deep, { rough: 0.8 }), 0, 0.7, 0, 24).scale.set(1.15, 1, 1));
  for (const s of [-1, 1]) {
    // bell sleeves
    const arm = s < 0 ? r.armR : r.armL;
    b.lathe(arm, [[0.2, -0.3], [0.19, -0.18], [0.1, 0]], b.m(deep, { rough: 0.85 }), 0, -0.3, 0, 16).scale.set(1, 1, 1);
    // little crystal pauldrons
    b.body(upper, (g) => {
      const crystal = b.cone(g, 0.07, 0.26, b.m(trim, { glow: 0.9, rough: 0.2 }), s * 0.38, 0.84, 0, 5);
      crystal.rotation.z = -s * 0.5;
    });
  }
  // wide-brim hat, bent tip with a star, glowing band
  b.part('head', upper, (g) => {
    b.cyl(g, 0.5, 0.5, 0.045, b.m(0x1b3a78, { rough: 0.85 }), 0, 1.13, 0, 28);
    const hatMid = b.cone(g, 0.31, 0.5, b.m(0x1f4590, { rough: 0.85 }), 0, 1.4, -0.02, 20);
    hatMid.rotation.x = -0.08;
    const hatTip = b.cone(g, 0.15, 0.5, b.m(0x1f4590, { rough: 0.85 }), 0, 1.78, -0.16, 16);
    hatTip.rotation.x = -0.65;
    const band = b.torus(g, 0.31, 0.04, b.m(0xe2c870, { metal: 0.6, rough: 0.35 }), 0, 1.17, 0);
    band.rotation.x = Math.PI / 2;
    b.plain(() => b.ball(g, 0.055, b.m(trim, { glow: 1.8 }), 0, 1.19, 0.31));
  });
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
  b.body(upper, (g) => b.lathe(g, [[0.27, -0.11], [0.45, -0.17], [0.46, -0.04], [0.24, 0.0]], b.m(gold, { metal: 0.65, rough: 0.35 }), 0, 0.72, 0, 24).scale.set(1.2, 1, 1));
  b.rbox(upper, 0.17, 1.0, 0.05, b.m(0xb0262a, { rough: 0.7 }), 0, 0.1, 0.22, 0.02);
  b.rbox(upper, 0.2, 0.05, 0.06, b.m(gold, { metal: 0.7, rough: 0.3 }), 0, 0.55, 0.235, 0.015);
  b.plain(() => {
    b.box(r.upper, 0.04, 0.2, 0.03, b.m(0xfff0a0, { glow: 1.6 }), 0, 0.42, 0.255);
    b.box(r.upper, 0.14, 0.04, 0.03, b.m(0xfff0a0, { glow: 1.6 }), 0, 0.46, 0.255);
  });
  b.rbox(upper, 0.64, 0.1, 0.42, b.m(gold, { metal: 0.65, rough: 0.35 }), 0, 0.1, 0, 0.05);
  // radiant halo (spins slowly) and glowing wings of light
  b.part('head', upper, (g) => {
    const halo = new THREE.Group();
    halo.position.set(0, 1.42, -0.02);
    b.plain(() => {
      const ring = b.torus(halo, 0.25, 0.028, b.m(0xfff0a0, { glow: 1.8 }), 0, 0, 0);
      ring.rotation.x = Math.PI / 2;
      const ring2 = b.glow(halo, new THREE.TorusGeometry(0.25, 0.09, 8, 28), 0xffe9a0, 0.28);
      ring2.rotation.x = Math.PI / 2;
    });
    g.add(halo);
    b.anim.push((t) => (halo.position.y = 1.42 + Math.sin(t * 2) * 0.02));
  });
  b.part('back', upper, (g) => {
    const wings = new THREE.Group();
    wings.position.set(0, 0.55, -0.26);
    g.add(wings);
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
  });
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
  b.part('back', upper, (g) => addCape(b, r, g, 0x16161d, 0x6a5a30, 0.54, 1.0));
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
    b.body(upper, (g) => {
      const sp = b.cone(g, 0.06, 0.26, b.m(0x4a4a58, { metal: 0.7, rough: 0.35 }), s * 0.34, 0.85, 0, 6);
      sp.rotation.z = -s * 0.7;
    });
  }
  for (const arm of [r.armL, r.armR]) b.rbox(arm, 0.19, 0.18, 0.19, b.m(0x3a2f27, { rough: 0.6 }), 0, -0.46, 0, 0.05);
  // deep hood with a shadowed face, scarf and glowing eyes
  b.part('head', upper, (g) => {
    const hood = b.ball(g, 0.25, b.m(leather, { rough: 0.9 }), 0, 0.99, -0.03);
    hood.scale.set(1.0, 1.06, 1.08);
    const peak = b.cone(g, 0.2, 0.34, b.m(leather, { rough: 0.9 }), 0, 1.04, -0.22, 12);
    peak.rotation.x = -1.95;
    b.rbox(g, 0.31, 0.2, 0.14, b.m(0x0c0c12, { rough: 1 }), 0, 0.96, 0.15, 0.06);
    b.rbox(g, 0.34, 0.12, 0.3, b.m(0x7a1f2a, { rough: 0.9 }), 0, 0.84, 0.03, 0.05);
    b.plain(() => {
      for (const x of [-0.075, 0.075]) b.box(g, 0.07, 0.025, 0.03, b.m(gold, { glow: 2.0 }), x, 0.99, 0.225).rotation.z = x < 0 ? -0.2 : 0.2;
    });
  });
  // with the hood replaced the head is bare: give it a face and short dark hair
  b.bare.head = () => {
    eyes(b, r, 0.99, 0.185, 0x6a4a2a);
    b.ball(upper, 0.215, b.m(0x2a1f1a, { rough: 0.9 }), 0, 1.0, -0.035).scale.set(1, 1, 0.92);
  };
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


// ------------------------------------------------------------------ rigged (skinned) models

/**
 * Build a Rig from a skinned GLB (scripts/rig-model.mjs). The unit gets its own skeleton; geometry, texture and material are
 * shared with every other unit until the unit needs a colour of its own (hit flash, death, stealth, dye). Cosmetic anchors
 * ride on the bones and use the same coordinates as the procedural models' `upper` group: its origin is placed so the head
 * centre lands at y = 0.99, as on every procedural model.
 */
function riggedRig(b: Builder, asset: RigAsset, classId: ClassId, weapon?: string): Rig {
  const inst = instantiate(asset);
  const { root, bones, rest, attach } = inst;
  const meta = asset.meta;
  const O = meta.headCenter[1] - 0.99;
  // a group that sits at a character-space point at rest (axes aligned with the character, whatever the bone's own axes are) and then rides the bone
  const place = (g: THREE.Group, bone: string, at: THREE.Vector3) => {
    const m = new THREE.Matrix4().copy(bones[bone].matrixWorld).invert().multiply(new THREE.Matrix4().makeTranslation(at.x, at.y, at.z));
    m.decompose(g.position, g.quaternion, g.scale);
    bones[bone].add(g);
    return g;
  };
  const anchor = (bone: string, name: string, dx = 0, dz = 0) => {
    const g = new THREE.Group();
    g.name = name;
    return place(g, bone, new THREE.Vector3(dx, O, dz));
  };
  const upper = anchor('chest', 'upper');
  // head items are centred on the model's own head (a stooping model's head is not over the middle of its body)
  const head = anchor('head', 'head-anchor', meta.headCenter[0] - ((root.userData.centerX as number) ?? 0), meta.headCenter[2]);
  const shoulderL = anchor('shoulder_l', 'shoulder-anchor-l');
  const shoulderR = anchor('shoulder_r', 'shoulder-anchor-r');
  // hand groups behave like the procedural arm groups: the old weapon offset (0, -0.62, 0.05) lands on the grip point
  const hand = (side: 'l' | 'r') => {
    const a = attach[`attach_hand_${side}`];
    const at = a ? a.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3().setFromMatrixPosition(bones[`hand_${side}`].matrixWorld);
    // clip models: the fist closes where the model's own staff was held (measured by prep-character.mjs), right hand only
    if (!a && side === 'r' && meta.hold) at.add(new THREE.Vector3(...meta.hold.grip));
    return place(new THREE.Group(), `hand_${side}`, at.add(new THREE.Vector3(0, 0.62, -0.05)));
  };
  const armL = hand('l');
  const armR = hand('r');
  const R = meta.headR;
  const helm = asset.def.keepHead ? asset.def.helm : undefined;
  const fit: Fit = {
    headTop: helm?.top ?? 0.99 + Math.max(R, (meta.headTop ?? 0) - meta.headCenter[1]),
    headR: helm?.r ?? R,
    tw: meta.torsoW,
    chestZ: meta.chestBackZ,
    robe: false,
    legW: 0.26,
    brow: helm?.brow ?? 0.99 + R * 0.2,
    helm: !!helm,
    // the shared cape hangs from the collar, just behind the shoulder blades (capeModels.ts); each model's `cape` overrides refine it
    cape: { ...DEFAULT_CAPE_FIT, y: meta.shoulderJoint[1] - O + 0.04, z: Math.max(0.05, meta.chestBackZ - 0.1), sx: Math.max(1, meta.torsoW / 0.45), sy: Math.max(0.7, meta.height / 2.6), sz: 0.8, ...asset.def.cape },
    // the wings grow between the shoulder blades, behind the back plate (and behind a cape); each model's `wings` overrides refine it
    wings: { ...DEFAULT_WING_FIT, y: meta.shoulderJoint[1] - O + 0.02, z: Math.max(0.1, meta.chestBackZ + 0.04), scale: 0.5 * Math.max(0.9, meta.height / 2.4), sx: Math.max(1, meta.torsoW / 0.6), ...asset.def.wings },
  };
  const r: Rig = { root, upper, legL: new THREE.Group(), legR: new THREE.Group(), armL, armR, head, shoulderL, shoulderR, fit };

  const bodyMeshes: THREE.SkinnedMesh[] = [];
  for (const [slot, list] of Object.entries(inst.parts)) {
    // the knight keeps its helm under a head cosmetic (see ModelDef.keepHead): the helm is plain body geometry there
    const replaceable = (REPLACEABLE_SLOTS as readonly string[]).includes(slot) && !(slot === 'head' && asset.def.keepHead);
    if (!replaceable) {
      for (const m of list) {
        if (!inst.anim) root.add(m); // clip models keep their node hierarchy: the meshes stay where the skeleton is
        bodyMeshes.push(m);
        b.meshes.push(m);
      }
      continue;
    }
    const group = new THREE.Group();
    group.name = `part:${slot}`;
    root.add(group);
    for (const m of list) {
      group.add(m);
      bodyMeshes.push(m);
      b.meshes.push(m);
    }
    (b.parts[slot] ??= []).push({ group, meshes: [...list], fx: [], anim: [] });
  }

  // what shows where a worn item took a part away: a bare face under the helm, plain joints under the pauldrons
  const skin = b.m(SKIN, { rough: 0.8 });
  if (!asset.def.keepHead && b.parts.head) b.bare.head = () => {
    b.ball(head, R, skin, 0, 0.99, 0);
    eyes(b, r, 0.99, R * 0.93, 0x3a5f8f, R * 0.33, R * 0.11);
    b.ball(head, R * 1.06, b.m(0x4a3222, { rough: 0.9 }), 0, 0.99 + R * 0.1, -R * 0.18).scale.set(1, 1, 0.92);
  };

  // each unit gets its own materials the first time it needs a colour of its own
  let owned = false;
  const ensureOwn = () => {
    if (owned) return;
    owned = true;
    for (const m of bodyMeshes) {
      const clone = (mat: THREE.Material) => {
        const c = mat.clone() as THREE.MeshStandardMaterial;
        c.userData.base = c.color.clone();
        c.userData.glow = c.emissiveMap ? 1 : 0;
        c.userData.rigged = true;
        // models that dye only some parts (the wizard's robe, not his skin) list them in ModelDef.dye
        if (asset.def.dye && !asset.def.dye.includes(m.name.split('__')[1])) c.userData.noDye = true;
        b.mats.push(c);
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(clone) : clone(m.material);
    }
  };
  r.rigged = { anim: inst.anim ?? new RigAnimator(bones, asset.def.pose), ensureOwn, deadY: meta.deadY ?? 0.3 };
  root.userData.driver = r.rigged.anim; // for tests and debugging
  if (!asset.def.ownWeapon) {
    if (classId === 'warrior') warriorWeapons(b, r, weapon);
    else {
      const held = heldWeapon(b, r, weapon);
      const look = weapon ? WEAPONS[weapon]?.look : undefined;
      if (held && look) specLook(b, r, held, look);
    }
  }
  return r;
}

/**
 * What a held weapon does to its wielder (WeaponLook in weaponModels.ts): the robe is tinted through the dye shader (its own
 * material per unit, texture detail kept; the trim glows in the spec's colour) and the weapon's head gets its magic: embers
 * rising, frost motes drifting, stars orbiting. Cosmetic dyes later replace the tint; the motes stay.
 */
function specLook(b: Builder, r: Rig, held: AttachedWeapon, look: WeaponLook) {
  r.rigged!.ensureOwn();
  const rb = look.robe;
  for (const m of [...b.mats]) {
    if (!m.userData.rigged || m.userData.noDye) continue;
    const u: DyeUniforms = {
      uDye: { value: new THREE.Color(rb.color) },
      uRimCol: { value: new THREE.Color(rb.rimColor ?? 0xffffff) },
      uK: { value: rb.k ?? 0.8 },
      uLift: { value: 0.14 },
      uGain: { value: 2.3 },
      uFloor: { value: rb.floor ?? 0.12 },
      uRim: { value: rb.rim ?? 0 },
      uOn: { value: 1 },
      uGlyph: { value: new THREE.Color(rb.glyph).multiplyScalar(rb.glyphK) },
    };
    m.metalness = 0.1;
    dyeShader(m, u);
  }
  // the motes are placed in world-aligned axes around the staff head (the hand turns with the animation, the sparks keep rising)
  const hand = r.armR;
  const qi = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const at = (o: THREE.Object3D, x: number, y: number, z: number) => {
    hand.getWorldQuaternion(qi).invert();
    o.position.copy(v.set(x, y, z).applyQuaternion(qi)).add(held.glowAt);
  };
  const mote = (geo: THREE.BufferGeometry, color: number, opacity: number) => b.glow(hand, geo, color, opacity, 0, 0, 0);
  if (look.fx === 'embers') {
    const geo = new THREE.SphereGeometry(0.028, 6, 5);
    const es = Array.from({ length: 9 }, (_, i) => mote(geo, i % 3 ? look.color : look.color2, 0.6));
    b.anim.push((t) => es.forEach((e, i) => {
      const k = (t * 0.5 + i / es.length) % 1;
      const a = i * 2.4 + t * 0.7;
      at(e, Math.cos(a) * 0.14 * (1 - k * 0.5), -0.1 + k * 0.85, Math.sin(a) * 0.14 * (1 - k * 0.5));
      e.scale.setScalar(Math.max(0.05, Math.sin(k * Math.PI)));
    }));
  } else if (look.fx === 'frost') {
    const geo = new THREE.OctahedronGeometry(0.03);
    const ms = Array.from({ length: 8 }, (_, i) => mote(geo, i % 2 ? look.color : look.color2, 0.85));
    b.anim.push((t) => ms.forEach((m, i) => {
      const k = (t * 0.16 + i / ms.length) % 1;
      const a = i * 2.1 + t * 0.5;
      at(m, Math.cos(a) * (0.2 + 0.08 * Math.sin(i)), 0.4 - k * 0.8, Math.sin(a) * (0.2 + 0.08 * Math.sin(i)));
      m.scale.setScalar(Math.max(0.05, Math.sin(k * Math.PI)));
      m.rotation.set(t + i, t * 1.3, 0);
    }));
  } else {
    const geo = new THREE.OctahedronGeometry(0.035);
    const ss = Array.from({ length: 4 }, (_, i) => mote(geo, i % 2 ? look.color : look.color2, 0.95));
    b.anim.push((t) => ss.forEach((m, i) => {
      const a = t * 1.3 + (i / ss.length) * Math.PI * 2;
      at(m, Math.cos(a) * 0.3, 0.05 + Math.sin(a * 2 + i) * 0.06, Math.sin(a) * 0.3);
      m.scale.set(0.7, 1.7, 0.7);
      m.rotation.y = t * 2 + i;
    }));
  }
}

// ------------------------------------------------------------------ cosmetics

/** Where each class's head, shoulders and so on sit, so worn cosmetics land on the right spot. */
interface Fit { /** where a worn cape hangs and how big it is (capeModels.ts); the default fits an upright torso */ cape?: CapeFit; /** where the wings grow and how big they are (wingModels.ts) */ wings?: WingFit; headTop: number; headR: number; tw: number; chestZ: number; robe: boolean; legW: number; brow?: number; /** a worn helm stays under head cosmetics */ helm?: boolean }
const FIT: Record<ClassId, Fit> = {
  // headTop / headR describe the BARE head (the built-in helm, hood or hat is gone while a cosmetic is worn)
  warrior: { wings: { ...DEFAULT_WING_FIT, y: 0.84, z: 0.42, scale: 0.56, sx: 1.12 }, cape: { ...DEFAULT_CAPE_FIT, y: 0.8, z: 0.2, sx: 1.6, sy: 0.95 }, headTop: 1.25, headR: 0.25, tw: 0.72, chestZ: 0.31, robe: false, legW: 0.26 },
  mage: { wings: { ...DEFAULT_WING_FIT, y: 0.82, z: 0.34 }, cape: { ...DEFAULT_CAPE_FIT, y: 0.8, z: 0.15, sx: 1.3, sy: 1.1 }, headTop: 1.26, headR: 0.25, tw: 0.58, chestZ: 0.235, robe: true, legW: 0.23 },
  priest: { wings: { ...DEFAULT_WING_FIT, y: 0.82, z: 0.36 }, cape: { ...DEFAULT_CAPE_FIT, y: 0.8, z: 0.18, sx: 1.3, sy: 1.05 }, headTop: 1.27, headR: 0.25, tw: 0.58, chestZ: 0.285, robe: true, legW: 0.23 },
  rogue: { wings: { ...DEFAULT_WING_FIT, y: 0.82, z: 0.3, scale: 0.46 }, cape: { ...DEFAULT_CAPE_FIT, y: 0.8, z: 0.1, sx: 1.2, sy: 0.95, tilt: -0.02 }, headTop: 1.28, headR: 0.25, tw: 0.54, chestZ: 0.2, robe: false, legW: 0.2 },
};
const hexNum = (c: string) => parseInt(c.replace('#', ''), 16) || 0x888888;
const lighter = (c: number, k = 0.45) => new THREE.Color(c).lerp(new THREE.Color(0xffffff), k).getHex();
const darker = (c: number, k = 0.45) => new THREE.Color(c).lerp(new THREE.Color(0x000000), k).getHex();

/** Per-material dye state, driven by the shader patch below (`userData.dye`). */
interface DyeUniforms {
  uDye: { value: THREE.Color };
  uRimCol: { value: THREE.Color };
  uK: { value: number };
  uLift: { value: number };
  uGain: { value: number };
  uFloor: { value: number };
  uRim: { value: number };
  /** 1 while alive, 0 when dead (the grey corpse look must not glow). */
  uOn: { value: number };
  /** The robe's red trim glows in this colour (the mage specs): `uGlyph` is the colour times its strength; zero for every dye. */
  uGlyph: { value: THREE.Color };
}

const DYE_STYLES: Record<string, { k: number; lift: number; gain: number; floor: number; rim: number; rimCol: number; metal: number; rough: number }> = {
  // k: how far the texture colour is pulled to the dye; lift/gain: shade = lift + gain * texture brightness (keeps the engraved detail);
  // floor: emissive share of the dye so shadows never go black; rim: fresnel glow. The scene has no environment map, so metalness stays low.
  dye: { k: 0.78, lift: 0.12, gain: 2.4, floor: 0.2, rim: 0, rimCol: 0xffffff, metal: 0.2, rough: 0.55 },
  midas: { k: 0.97, lift: 0.22, gain: 2.0, floor: 0.22, rim: 0.3, rimCol: 0xffe9a0, metal: 0.4, rough: 0.28 },
  eclipse: { k: 0.92, lift: 0.18, gain: 2.1, floor: 0.2, rim: 1.1, rimCol: 0x9a72ff, metal: 0.25, rough: 0.5 },
  aurora: { k: 0.85, lift: 0.16, gain: 2.2, floor: 0.16, rim: 0.4, rimCol: 0xaaffe0, metal: 0.25, rough: 0.5 },
};
const lumOf = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** Make `m` dye-capable: the shader blends its (texture) colour toward the dye by brightness, adds an emissive floor and a rim. */
function dyeShader(m: THREE.MeshStandardMaterial, u: DyeUniforms) {
  m.userData.dye = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uDye; uniform vec3 uRimCol; uniform float uK; uniform float uLift; uniform float uGain; uniform float uFloor; uniform float uRim; uniform float uOn; uniform vec3 uGlyph;
float dyeShade; float dyeGlyph;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  dyeGlyph = clamp((diffuseColor.r - max(diffuseColor.g, diffuseColor.b) - 0.05) * 6.0, 0.0, 1.0);
  dyeShade = clamp(uLift + uGain * pow(l, 0.8), 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, uDye * dyeShade, uK * uOn);
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float fr = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.5);
  totalEmissiveRadiance += uOn * (uDye * uFloor * (0.4 + 0.6 * dyeShade) + uRimCol * uRim * fr * 0.45) + uOn * uGlyph * dyeGlyph;
}`);
  };
  m.customProgramCacheKey = () => 'dye';
  m.needsUpdate = true;
}

/**
 * Armor dye: the model's cloth and metal colours are pulled toward the dye, keeping the engraving and plate detail (the dye is
 * scaled by the texture's brightness instead of multiplied into it, so dark armour never turns black), with an emissive floor of
 * the dye colour so shadows stay coloured. Skin, eye whites and glows stay. Owner dyes do more: `midas` is polished warm gold
 * with glints, `eclipse` a deep violet-indigo with a breathing rim glow, `aurora` ripples through green, teal and violet.
 */
function dye(b: Builder, r: Rig, color: number, style: string) {
  r.rigged?.ensureOwn();
  const st = DYE_STYLES[style] ?? DYE_STYLES.dye;
  // pick the working colour: bright dyes are held back (white albedo blows out in the sun), the owner dyes use a richer shade than their swatch
  const target = new THREE.Color(style === 'eclipse' ? 0x30208c : style === 'midas' ? 0xe3b32e : color);
  if (style === 'dye') {
    const lum = lumOf(target);
    if (lum > 0.3) target.multiplyScalar(0.3 / lum + (1 - 0.3 / lum) * 0.35);
    if (lum < 0.03) target.lerp(new THREE.Color(0x3a3a48), 0.55); // obsidian: a dark steel, not a hole
  }
  const floor = style === 'dye' ? 0.26 - 0.18 * Math.min(1, lumOf(target) / 0.35) : st.floor;
  const ds: { m: THREE.MeshStandardMaterial; u: DyeUniforms; i: number }[] = [];
  for (const m of [...b.mats]) {
    const base = m.userData.base as THREE.Color;
    const hx = base.getHex();
    const lum = (((hx >> 16) & 255) + ((hx >> 8) & 255) + (hx & 255)) / 765;
    if (m.userData.noDye) continue;
    if (!m.userData.rigged && (hx === SKIN || m.userData.glow || lum > 0.93 || lum < 0.05)) continue;
    const u: DyeUniforms = {
      uDye: { value: target.clone() },
      uRimCol: { value: new THREE.Color(st.rimCol) },
      uK: { value: st.k },
      uLift: { value: st.lift },
      uGain: { value: st.gain },
      uFloor: { value: floor },
      uRim: { value: st.rim },
      uOn: { value: 1 },
      uGlyph: { value: new THREE.Color(0, 0, 0) },
    };
    m.metalness = Math.min(m.metalness, st.metal);
    m.roughness = style === 'midas' ? st.rough : Math.min(m.roughness, st.rough + 0.15);
    dyeShader(m, u);
    ds.push({ m, u, i: ds.length });
  }
  if (style === 'aurora' || style === 'eclipse') {
    const col = new THREE.Color();
    b.anim.push((t) => {
      ds.forEach(({ u, i }) => {
        if (style === 'aurora') col.setHSL((0.36 + 0.24 * (0.5 + 0.5 * Math.sin(t * 0.7 + i * 0.55))) % 1, 0.85, 0.37);
        else col.setHSL(0.72 + 0.04 * Math.sin(t * 0.6 + i), 0.66, 0.3 + 0.06 * Math.sin(t * 1.1 + i * 0.4));
        u.uDye.value.copy(col);
      });
    });
  }
  if (style === 'midas') {
    // a few glints that flash over the gold
    const gl: THREE.Object3D[] = [];
    for (let i = 0; i < 5; i++) {
      const g = b.glow(r.upper, new THREE.OctahedronGeometry(0.035), 0xfff6c8, 0.95, 0, 0, 0);
      g.scale.set(0.35, 1.6, 0.35);
      gl.push(g);
    }
    b.anim.push((t) => gl.forEach((g, i) => {
      const k = (t * 0.55 + i * 0.2) % 1;
      const a = i * 2.4 + t * 0.5;
      g.position.set(Math.cos(a) * 0.42, 0.25 + ((i * 37) % 10) / 10 * 0.9, Math.sin(a) * 0.3 + 0.1);
      g.scale.set(0.35 * Math.sin(k * Math.PI), 1.6 * Math.sin(k * Math.PI), 0.35 * Math.sin(k * Math.PI));
      g.rotation.y = t * 3 + i;
    }));
  }
}


/** Lit, softly glowing material for flat ribbon parts (two sided, never dyed). */
function ribbonMat(b: Builder, color: number, glow: number, rough = 0.6): THREE.MeshStandardMaterial {
  const m = b.m(color, { rough, glow });
  m.side = THREE.DoubleSide;
  return m;
}

/**
 * Draws a unit's cosmetics on top of its class model. Every style is a different shape, so what a player picked is
 * obvious from across the arena. A slot with nothing picked draws nothing.
 */
function wearCosmetics(b: Builder, r: Rig, classId: ClassId, look: Record<string, CosmeticItem>) {
  const fit = r.fit ?? FIT[classId];
  const { upper } = r;
  const hu = r.head ?? upper; // head items ride on the head bone of a skinned model
  // a cosmetic in a slot REPLACES the model's built-in part for it (helm/hood/hat, pauldrons, cape/wings) rather than stacking on it
  for (const slot of REPLACEABLE_SLOTS) {
    if (!look[slot]) continue;
    b.dropPart(slot);
    if (slot === 'back') r.cape = undefined;
  }
  if (look.tint) dye(b, r, hexNum(look.tint.color), look.tint.style);
  // no environment map in the arena: high metalness only turns the colour black, so cosmetics stay in the 0.3 range
  const metal = (c: number) => b.m(c, { metal: 0.3, rough: 0.38 });
  const cloth = (c: number) => b.m(c, { rough: 0.9 });
  const gemMat = (c: number) => b.m(c, { glow: 1.3, rough: 0.25 });
  /** A glow shape with a material of its own, so its colour can change by itself. */
  const own = <T extends THREE.Mesh>(m: T): T => ((m.material = (m.material as THREE.MeshBasicMaterial).clone()), m);
  const hue = (m: THREE.Mesh, h: number, l = 0.6) => (m.material as THREE.MeshBasicMaterial).color.setHSL(((h % 1) + 1) % 1, 1, l);

  // ---- head
  const head = look.head;
  if (head) {
    const c = hexNum(head.color);
    const R = fit.headR;
    const top = fit.headTop;
    const brow = fit.brow ?? 1.02;
    const sides = [-1, 1];
    switch (head.style) {
      case 'horns':
        for (const sd of sides) {
          // two stacked segments sweeping up and out from a base point; over the knight's helm they branch off its sides, outside its own horns
          const base = fit.helm ? { x: 0.14, y: 0.98 } : { x: R * 0.9 - 0.19 * Math.sin(0.75), y: brow + 0.12 - 0.19 * Math.cos(0.75) };
          const tip1 = { x: base.x + 0.38 * Math.sin(0.75), y: base.y + 0.38 * Math.cos(0.75) };
          const horn = b.cone(hu, 0.07, 0.38, metal(c), sd * (base.x + 0.19 * Math.sin(0.75)), base.y + 0.19 * Math.cos(0.75), 0, 8);
          horn.rotation.z = -sd * 0.75;
          const tip = b.cone(hu, 0.045, 0.22, metal(lighter(c)), sd * (tip1.x + 0.11 * Math.sin(0.25) - 0.02), tip1.y + 0.11 * Math.cos(0.25) - 0.02, 0, 8);
          tip.rotation.z = -sd * 0.25;
        }
        break;
      case 'crown': {
        const band = b.torus(hu, R * 0.82, 0.03, metal(c), 0, top - 0.1, 0);
        band.rotation.x = Math.PI / 2;
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          b.cone(hu, 0.032, 0.15 + (i % 2) * 0.05, metal(c), Math.cos(a) * R * 0.82, top - 0.02, Math.sin(a) * R * 0.82, 6);
        }
        b.plain(() => b.ball(hu, 0.045, gemMat(0xff4466), 0, top - 0.1, R * 0.82 + 0.02));
        break;
      }
      case 'hat': {
        b.cyl(hu, R * 1.65, R * 1.65, 0.035, cloth(darker(c, 0.2)), 0, top - 0.12, 0, 28);
        b.cone(hu, R * 1.0, 0.55, cloth(c), 0, top + 0.17, 0, 20).rotation.z = 0.12;
        const band = b.torus(hu, R * 1.0, 0.025, metal(0xf0c53a), 0, top - 0.08, 0);
        band.rotation.x = Math.PI / 2;
        break;
      }
      case 'crest':
        for (let i = 0; i < 8; i++) {
          const h = 0.1 + 0.12 * Math.sin((i / 7) * Math.PI);
          b.rbox(hu, 0.045, h, 0.07, cloth(c), 0, top - 0.04 + h / 2 - 0.04, -0.2 + i * 0.058, 0.015);
        }
        break;
      case 'halo': {
        const halo = b.glow(hu, new THREE.TorusGeometry(0.3, 0.02, 8, 40), c, 0.7, 0, top + 0.12, 0);
        halo.rotation.x = Math.PI / 2;
        b.glow(hu, new THREE.TorusGeometry(0.3, 0.06, 8, 40), c, 0.1, 0, top + 0.12, 0).rotation.x = Math.PI / 2;
        b.anim.push((t) => (halo.position.y = top + 0.12 + Math.sin(t * 2) * 0.02));
        break;
      }
      case 'antlers':
        for (const sd of sides) {
          const main = b.cone(hu, 0.035, 0.5, cloth(c), sd * (R * 0.7), top + 0.02, 0, 6);
          main.rotation.z = -sd * 0.3;
          for (const [h, len] of [[0.0, 0.26], [0.14, 0.2]] as const) {
            const tine = b.cone(hu, 0.025, len, cloth(lighter(c, 0.2)), sd * (R * 0.7 + 0.08 + h * 0.5), top + 0.1 + h, 0, 6);
            tine.rotation.z = -sd * 1.0;
          }
        }
        break;
      case 'ears':
        for (const sd of sides) {
          const ear = b.cone(hu, 0.075, 0.2, cloth(c), sd * R * 0.62, top - 0.02, 0, 4);
          ear.rotation.z = -sd * 0.25;
          b.cone(hu, 0.04, 0.12, cloth(0xe89ab0), sd * R * 0.62, top - 0.04, 0.03, 4).rotation.z = -sd * 0.25;
        }
        break;
      case 'helm': {
        if (fit.helm) {
          // over the knight's helm: a domed war cap resting on its crest, between the horns, with a ridge and a brow band
          const dome = b.add(hu, new THREE.SphereGeometry(R * 0.95, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), metal(c), 0, top - 0.2, 0);
          dome.scale.set(1, 0.9, 1.1);
          b.rbox(hu, 0.03, 0.06, R * 1.9, metal(lighter(c, 0.2)), 0, top - 0.2 + R * 0.78, 0, 0.01);
          b.torus(hu, R * 0.8, 0.02, metal(darker(c, 0.2)), 0, top - 0.2 + 0.015, 0).rotation.x = Math.PI / 2;
          break;
        }
        const dome = b.add(hu, new THREE.SphereGeometry(R * 1.1, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), metal(c), 0, brow - 0.04, 0);
        dome.scale.set(1, 1.05, 1.05);
        b.rbox(hu, 0.05, 0.2, 0.05, metal(darker(c, 0.2)), 0, brow, R * 1.1, 0.01); // nose guard
        b.rbox(hu, 0.03, 0.1, R * 2.1, metal(lighter(c, 0.2)), 0, brow + R * 1.08, 0, 0.01); // ridge
        break;
      }
      case 'flamecrown': {
        const band = b.torus(hu, R * 0.85, 0.03, metal(darker(c, 0.3)), 0, top - 0.06, 0);
        band.rotation.x = Math.PI / 2;
        const fl: THREE.Object3D[] = [];
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2;
          fl.push(b.glow(hu, new THREE.ConeGeometry(0.06, 0.3 + (i % 3) * 0.08, 7), i % 2 ? lighter(c, 0.4) : c, 0.8, Math.cos(a) * R * 0.85, top + 0.1, Math.sin(a) * R * 0.85));
        }
        b.anim.push((t) => fl.forEach((f, i) => f.scale.set(1, 0.7 + 0.7 * Math.abs(Math.sin(t * 8 + i * 1.6)), 1)));
        break;
      }
      case 'shards': {
        const ss: THREE.Object3D[] = [];
        for (let i = 0; i < 5; i++) {
          const m = b.glow(hu, new THREE.OctahedronGeometry(0.06), i % 2 ? lighter(c, 0.4) : c, 0.9, 0, 0, 0);
          m.scale.set(0.6, 1.6, 0.6);
          ss.push(m);
        }
        b.anim.push((t) => ss.forEach((m, i) => {
          const a = t * 1.5 + (i / 5) * Math.PI * 2;
          m.position.set(Math.cos(a) * (R + 0.14), top + 0.1 + Math.sin(t * 2 + i) * 0.05, Math.sin(a) * (R + 0.14));
          m.rotation.y = t * 2 + i;
        }));
        break;
      }
      case 'prism': {
        // a crown whose spikes slowly cycle through every colour, with a bright halo of the same shifting hue
        const band = b.torus(hu, R * 0.85, 0.035, metal(0xffffff), 0, top - 0.08, 0);
        band.rotation.x = Math.PI / 2;
        const tips: THREE.Mesh[] = [];
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2;
          const m = b.glow(hu, new THREE.ConeGeometry(0.045, 0.28 + (i % 2) * 0.1, 6), c, 0.9, Math.cos(a) * R * 0.85, top + 0.06, Math.sin(a) * R * 0.85);
          m.material = (m.material as THREE.MeshBasicMaterial).clone();
          tips.push(m);
        }
        const halo = b.glow(hu, new THREE.TorusGeometry(0.4, 0.02, 8, 48), c, 0.85, 0, top + 0.3, 0);
        halo.material = (halo.material as THREE.MeshBasicMaterial).clone();
        halo.rotation.x = Math.PI / 2;
        b.anim.push((t) => {
          tips.forEach((m, i) => (m.material as THREE.MeshBasicMaterial).color.setHSL((t * 0.25 + i / 9) % 1, 1, 0.5));
          (halo.material as THREE.MeshBasicMaterial).color.setHSL((t * 0.25) % 1, 1, 0.55);
          halo.position.y = top + 0.3 + Math.sin(t * 2) * 0.025;
        });
        break;
      }
      case 'founder': {
        // a tall gold crown, a big ruby, a tilted spinning halo and sparks circling it
        const band = b.torus(hu, R * 0.85, 0.04, metal(c), 0, top - 0.08, 0);
        band.rotation.x = Math.PI / 2;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          b.cone(hu, 0.04, 0.26 + (i % 2) * 0.12, metal(i % 2 ? 0xfff2b0 : c), Math.cos(a) * R * 0.85, top + 0.05, Math.sin(a) * R * 0.85, 6);
          b.plain(() => b.ball(hu, 0.025, gemMat(0xff3355), Math.cos(a) * R * 0.85, top + 0.2 + (i % 2) * 0.12, Math.sin(a) * R * 0.85));
        }
        b.plain(() => b.ball(hu, 0.07, gemMat(0xff2244), 0, top - 0.08, R * 0.85 + 0.03));
        const halo = b.glow(hu, new THREE.TorusGeometry(0.46, 0.022, 8, 48), c, 0.9, 0, top + 0.32, 0);
        halo.rotation.x = Math.PI / 2 - 0.25;
        const sparks: THREE.Object3D[] = [];
        for (let i = 0; i < 6; i++) sparks.push(b.glow(hu, new THREE.SphereGeometry(0.03, 6, 5), 0xfff2b0, 0.95, 0, 0, 0));
        b.anim.push((t) => {
          halo.rotation.z = t * 1.1;
          sparks.forEach((m, i) => {
            const a = t * 1.8 + (i / 6) * Math.PI * 2;
            m.position.set(Math.cos(a) * 0.46, top + 0.32 + Math.sin(a) * 0.46 * Math.sin(0.25), Math.sin(a) * 0.46 * Math.cos(0.25));
          });
        });
        break;
      }
      case 'eclipse': {
        // a black sun hanging over the head: a dark orb in a spinning gold corona with a ring of long rays
        const sun = new THREE.Group();
        sun.position.set(0, top + (fit.helm ? 0.26 : 0.36), 0);
        hu.add(sun);
        b.plain(() => b.ball(sun, 0.15, b.m(0x07040d, { rough: 0.35 }), 0, 0, 0));
        b.glow(sun, new THREE.SphereGeometry(0.25, 14, 10), c, 0.12, 0, 0, 0);
        b.glow(sun, new THREE.TorusGeometry(0.19, 0.026, 8, 40), c, 0.8, 0, 0, 0);
        const spokes = new THREE.Group();
        sun.add(spokes);
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          const ray = b.glow(spokes, new THREE.BoxGeometry(0.014, 0.12 + (i % 2) * 0.1, 0.014), c, 0.8, Math.cos(a) * 0.34, Math.sin(a) * 0.34, 0);
          ray.rotation.z = a - Math.PI / 2;
        }
        b.anim.push((t) => {
          sun.rotation.y = t * 0.9;
          spokes.rotation.z = -t * 0.5;
          sun.position.y = top + (fit.helm ? 0.26 : 0.36) + Math.sin(t * 1.6) * 0.03;
        });
        break;
      }
      case 'voidhorns': {
        const flames: THREE.Object3D[] = [];
        for (const sd of sides) {
          const a = 0.65;
          const base = fit.helm ? { x: 0.14, y: 0.98 } : { x: R * 0.9 - 0.3 * Math.sin(a), y: brow + 0.2 - 0.3 * Math.cos(a) };
          const mid = { x: base.x + 0.3 * Math.sin(a), y: base.y + 0.3 * Math.cos(a) };
          const horn = b.cone(hu, 0.09, 0.6, metal(darker(c, 0.4)), sd * mid.x, mid.y, 0, 8);
          horn.rotation.z = -sd * a;
          const glowHorn = b.glow(hu, new THREE.ConeGeometry(0.13, 0.66, 8), c, 0.35, sd * mid.x, mid.y, 0);
          glowHorn.rotation.z = -sd * a;
          for (let i = 0; i < 3; i++) flames.push(b.glow(hu, new THREE.ConeGeometry(0.045, 0.2 - i * 0.03, 6), lighter(c, 0.3), 0.8, sd * (base.x + 0.6 * Math.sin(a) + 0.04 + i * 0.03), base.y + 0.6 * Math.cos(a) + 0.08 + i * 0.07, (i - 1) * 0.03));
        }
        b.anim.push((t) => flames.forEach((f, i) => f.scale.set(1, 0.6 + 0.8 * Math.abs(Math.sin(t * 7 + i * 1.7)), 1)));
        break;
      }
    }
  }

  // ---- back
  const back = look.back;
  if (back) {
    const c = hexNum(back.color);
    // where wings, ribbons and the rift grow from: the shoulder blades, just behind where a cape hangs (so every back item sits on the same spot)
    const cf = fit.cape ?? DEFAULT_CAPE_FIT;
    const wk = clamp(fit.tw / 0.62, 0.9, 1.25);
    const wingRoot = new THREE.Vector3(0.09 * wk, cf.y - 0.16, -(cf.z + 0.167 * cf.sz + 0.03));
    // every cape and cloak is the same cloth model in the item's own skin (capeModels.ts); the planks below are the stand-in until it has loaded
    const capeRig = isCapeItem(back) ? buildCape(back, fit.cape ?? DEFAULT_CAPE_FIT, upper) : undefined;
    if (capeRig) {
      b.mats.push(capeRig.material);
      b.meshes.push(capeRig.mesh);
      b.motion.push(capeRig.update);
    }
    switch (capeRig ? '' : back.style) {
      case 'cloak': {
        const len = fit.robe ? 1.25 : 0.95;
        const pivot = new THREE.Group();
        pivot.position.set(0, 0.72, -fit.chestZ + 0.02);
        const w = fit.tw * 1.12;
        b.rbox(pivot, w, len, 0.045, cloth(c), 0, -len / 2, 0, 0.02);
        b.rbox(pivot, w * 1.1, 0.07, 0.065, metal(0xf0c53a), 0, -len + 0.035, 0, 0.025);
        b.rbox(pivot, w * 0.95, 0.1, 0.08, metal(0xf0c53a), 0, -0.02, 0, 0.03);
        upper.add(pivot);
        b.anim.push((t, move) => {
          pivot.rotation.x = 0.1 + move * 0.5 + Math.sin(t * 1.8) * 0.03;
        });
        break;
      }
      case 'ribbons': {
        // long glowing ribbons that stream out behind the runner, hung from the collar
        const rs: THREE.Group[] = [];
        for (let i = 0; i < 4; i++) {
          const pivot = new THREE.Group();
          pivot.position.set((i - 1.5) * 0.1 * wk, cf.y - 0.06, wingRoot.z + 0.02);
          const L = (0.95 + (i % 2) * 0.25) * wk;
          b.plain(() => {
            const rg = b.geoShared(`ribbon${L.toFixed(2)}|${wk.toFixed(2)}`, () => {
              const sh = new THREE.Shape();
              sh.moveTo(-0.035 * wk, 0);
              sh.lineTo(0.035 * wk, 0);
              sh.quadraticCurveTo(0.05 * wk, -L * 0.5, 0.012 * wk, -L);
              sh.lineTo(0, -L - 0.06);
              sh.lineTo(-0.012 * wk, -L);
              sh.quadraticCurveTo(-0.05 * wk, -L * 0.5, -0.035 * wk, 0);
              return new THREE.ShapeGeometry(sh, 6);
            });
            b.add(pivot, rg, ribbonMat(b, i % 2 ? lighter(c, 0.35) : c, 0.75), 0, 0, 0);
          });
          upper.add(pivot);
          rs.push(pivot);
        }
        b.anim.push((t, move) => rs.forEach((g, i) => {
          g.rotation.x = 0.12 + move * 0.7 + Math.sin(t * 2.4 + i * 0.9) * 0.08;
          g.rotation.z = Math.sin(t * 1.7 + i * 1.3) * 0.1;
        }));
        break;
      }
      case 'starcloak': {
        // a midnight cape full of twinkling stars, with shooting stars sliding down it
        const len = fit.robe ? 1.3 : 1.0;
        const pivot = new THREE.Group();
        pivot.position.set(0, 0.72, -fit.chestZ + 0.02);
        const w = fit.tw * 1.2;
        b.rbox(pivot, w, len, 0.045, b.m(darker(c, 0.72), { rough: 0.9, glow: 0.14 }), 0, -len / 2, 0, 0.02);
        b.plain(() => b.rbox(pivot, w * 1.06, 0.05, 0.06, b.m(c, { glow: 1.2 }), 0, -len + 0.025, 0, 0.02));
        upper.add(pivot);
        const stars: THREE.Object3D[] = [];
        for (let i = 0; i < 14; i++) {
          const st = b.glow(pivot, new THREE.OctahedronGeometry(0.022 + (i % 3) * 0.008), i % 3 ? lighter(c, 0.55) : 0xffffff, 0.95, (((i * 53) % 10) / 10 - 0.5) * w * 0.85, -0.08 - (((i * 37) % 10) / 10) * (len - 0.18), -0.04);
          stars.push(st);
        }
        const streaks: THREE.Object3D[] = [];
        for (let i = 0; i < 3; i++) streaks.push(b.glow(pivot, new THREE.BoxGeometry(0.014, 0.3, 0.014), 0xffffff, 0.9, 0, 0, -0.06));
        b.anim.push((t, move) => {
          pivot.rotation.x = 0.1 + move * 0.5 + Math.sin(t * 1.8) * 0.03;
          stars.forEach((st, i) => st.scale.setScalar(0.3 + 1.0 * Math.abs(Math.sin(t * 2.6 + i * 1.7))));
          streaks.forEach((m, i) => {
            const k = (t * 0.6 + i / 3) % 1;
            m.position.set((i - 1) * w * 0.3, -0.1 - k * (len - 0.1), -0.06);
            m.rotation.z = 0.35;
            m.visible = k < 0.9;
            m.scale.y = 1 - k * 0.6;
          });
        });
        break;
      }
      case 'embercloak': {
        const len = fit.robe ? 1.3 : 1.0;
        const pivot = new THREE.Group();
        pivot.position.set(0, 0.72, -fit.chestZ + 0.02);
        const w = fit.tw * 1.2;
        b.rbox(pivot, w, len, 0.045, b.m(lighter(c, 0.14), { rough: 0.9, glow: 0.04 }), 0, -len / 2, 0, 0.02);
        b.plain(() => b.rbox(pivot, w * 1.06, 0.07, 0.06, b.m(0xff7a1a, { glow: 1.4 }), 0, -len + 0.035, 0, 0.02));
        b.plain(() => b.rbox(pivot, 0.035, len * 0.9, 0.05, b.m(0xff7a1a, { glow: 1.1 }), 0, -len / 2, 0.01, 0.01));
        upper.add(pivot);
        const embers: THREE.Object3D[] = [];
        for (let i = 0; i < 8; i++) embers.push(b.glow(pivot, new THREE.SphereGeometry(0.025, 6, 5), i % 2 ? 0xffd27a : 0xff7a1a, 0.95, 0, 0, 0));
        b.anim.push((t, move) => {
          pivot.rotation.x = 0.1 + move * 0.5 + Math.sin(t * 1.8) * 0.03;
          embers.forEach((e, i) => {
            const k = (t * 0.5 + i * 0.137) % 1;
            e.position.set((((i * 53) % 10) / 10 - 0.5) * w, -len * 0.4 - k * 0.5, -0.05 - k * 0.15);
            e.scale.setScalar(1 - k * 0.8);
          });
        });
        break;
      }
      case 'banner': {
        b.cyl(upper, 0.02, 0.02, 1.5, metal(0x6b5a3a), 0.0, 0.95, -fit.chestZ - 0.04, 8);
        b.cone(upper, 0.04, 0.14, metal(0xd0d6df), 0, 1.75, -fit.chestZ - 0.04, 6);
        const flag = new THREE.Group();
        flag.position.set(0, 1.62, -fit.chestZ - 0.04);
        b.rbox(flag, 0.38, 0.55, 0.02, cloth(c), 0.2, -0.28, 0, 0.01);
        b.rbox(flag, 0.38, 0.06, 0.03, metal(0xf0c53a), 0.2, -0.04, 0, 0.01);
        upper.add(flag);
        b.anim.push((t, move) => (flag.rotation.y = Math.sin(t * 3) * 0.2 + move * 0.3));
        break;
      }
    }
  }

  // ---- wings: the shared feathered pair (wingModels.ts), between the shoulder blades and behind any cape
  if (look.wings) {
    const wingRig = buildWings(look.wings, fit.wings ?? DEFAULT_WING_FIT, upper);
    if (wingRig) {
      b.mats.push(...wingRig.materials);
      b.meshes.push(...wingRig.meshes);
      b.fx.push(...wingRig.fx);
      b.motion.push(wingRig.update);
    }
  }

  // ---- weapon glow, around the weapon hand
  const weapon = look.weapon;
  if (weapon) {
    const c = hexNum(weapon.color);
    const aura = new THREE.Group();
    if (r.weaponPivot) {
      aura.position.set(0, r.weaponPivot.mid, 0); // a shoulder-carried weapon turns in the hand: the glow rides on it
      r.weaponPivot.node.add(aura);
    } else {
      aura.position.copy(r.weaponGlowAt ?? new THREE.Vector3(0, -0.6, 0.05));
      r.armR.add(aura);
    }
    b.glow(aura, new THREE.SphereGeometry(0.22, 16, 12), c, 0.22, 0, 0, 0);
    if (weapon.style === 'sparks') {
      const pts: THREE.Object3D[] = [];
      for (let i = 0; i < 5; i++) pts.push(b.glow(aura, new THREE.SphereGeometry(0.035, 8, 6), lighter(c, 0.3), 0.95, 0, 0, 0));
      b.anim.push((t) => pts.forEach((m, i) => {
        const a = t * 2.8 + (i / pts.length) * Math.PI * 2;
        m.position.set(Math.cos(a) * 0.3, Math.sin(a * 0.7 + i) * 0.22, Math.sin(a) * 0.3);
      }));
    } else if (weapon.style === 'flame') {
      const fl: THREE.Object3D[] = [];
      for (let i = 0; i < 4; i++) fl.push(b.glow(aura, new THREE.ConeGeometry(0.07, 0.3, 8), i % 2 ? lighter(c, 0.4) : c, 0.8, (i - 1.5) * 0.07, 0.15, (i % 2 - 0.5) * 0.1));
      b.anim.push((t) => fl.forEach((f, i) => {
        f.scale.set(1, 0.7 + 0.5 * Math.abs(Math.sin(t * 8 + i * 1.7)), 1);
        f.position.y = 0.12 + 0.05 * Math.sin(t * 6 + i);
      }));
    } else if (weapon.style === 'lightning') {
      const zs: THREE.Object3D[] = [];
      for (let i = 0; i < 6; i++) {
        const z = b.glow(aura, new THREE.BoxGeometry(0.02, 0.38, 0.02), i % 2 ? lighter(c, 0.5) : c, 0.95, 0, 0, 0);
        zs.push(z);
      }
      b.anim.push((t) => zs.forEach((z, i) => {
        z.visible = Math.sin(t * 17 + i * 2.1) + Math.sin(t * 7.3 + i) > 0.1;
        const a = Math.floor(t * 9 + i * 3) * 1.7 + i;
        z.position.set(Math.cos(a) * 0.2, Math.sin(a * 1.3) * 0.18, Math.sin(a) * 0.2);
        z.rotation.set(a, a * 0.7, a * 1.3);
      }));
    } else if (weapon.style === 'inferno') {
      b.glow(aura, new THREE.SphereGeometry(0.34, 16, 12), c, 0.2, 0, 0, 0);
      const fl: THREE.Object3D[] = [];
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        fl.push(b.glow(aura, new THREE.ConeGeometry(0.09, 0.45, 8), i % 2 ? lighter(c, 0.45) : c, 0.8, Math.cos(a) * 0.14, 0.22, Math.sin(a) * 0.14));
      }
      const sp: THREE.Object3D[] = [];
      for (let i = 0; i < 6; i++) sp.push(b.glow(aura, new THREE.SphereGeometry(0.04, 6, 5), 0xfff0b0, 0.95, 0, 0, 0));
      b.anim.push((t) => {
        fl.forEach((f, i) => f.scale.set(1, 0.7 + 0.8 * Math.abs(Math.sin(t * 9 + i * 1.5)), 1));
        sp.forEach((m, i) => {
          const a = t * 3.2 + (i / 6) * Math.PI * 2;
          m.position.set(Math.cos(a) * 0.4, 0.1 + ((t * 0.8 + i * 0.17) % 1) * 0.6, Math.sin(a) * 0.4);
        });
      });
    } else if (weapon.style === 'godfire') {
      // a pillar of fire as tall as the wielder with rings of flame turning round it and sparks rising
      b.glow(aura, new THREE.SphereGeometry(0.3, 16, 12), c, 0.2, 0, 0, 0);
      const col: THREE.Object3D[] = [];
      for (let i = 0; i < 5; i++) col.push(b.glow(aura, new THREE.ConeGeometry(0.15 - i * 0.022, 0.5, 8), i % 2 ? lighter(c, 0.45) : c, 0.75, 0, 0.3 + i * 0.3, 0));
      const rings: THREE.Mesh[] = [];
      for (let i = 0; i < 3; i++) rings.push(b.glow(aura, new THREE.TorusGeometry(0.2 + i * 0.07, 0.016, 8, 30), lighter(c, 0.3), 0.85, 0, 0.15 + i * 0.4, 0));
      const em: THREE.Object3D[] = [];
      for (let i = 0; i < 8; i++) em.push(b.glow(aura, new THREE.SphereGeometry(0.03, 6, 5), 0xfff0b0, 0.95, 0, 0, 0));
      b.anim.push((t) => {
        col.forEach((f, i) => {
          f.scale.set(1 + 0.15 * Math.sin(t * 9 + i * 2), 0.8 + 0.4 * Math.abs(Math.sin(t * 7 + i * 1.3)), 1 + 0.15 * Math.cos(t * 8 + i));
          f.position.x = Math.sin(t * 4 + i) * 0.03 * i;
        });
        rings.forEach((m, i) => {
          m.rotation.x = Math.PI / 2 + Math.sin(t * 2 + i) * 0.25;
          m.rotation.z = t * (i % 2 ? -2.2 : 2.2);
        });
        em.forEach((m, i) => {
          const k = (t * 0.5 + i * 0.125) % 1;
          const a = i * 2.4 + t;
          m.position.set(Math.cos(a) * 0.25 * (1 - k * 0.5), 0.1 + k * 1.6, Math.sin(a) * 0.25 * (1 - k * 0.5));
          m.scale.setScalar(1 - k * 0.8);
        });
      });
    } else if (weapon.style === 'starforge') {
      // a four-point star flaring at the weapon, with little stars circling it and glowing sparks thrown off the anvil
      const star = new THREE.Group();
      star.position.set(0, 0.2, 0.08);
      aura.add(star);
      for (const [w, len, rot, k] of [[0.05, 0.8, 0, 0], [0.05, 0.8, Math.PI / 2, 0], [0.025, 0.5, Math.PI / 4, 0.5], [0.025, 0.5, -Math.PI / 4, 0.5]] as const) {
        b.glow(star, new THREE.BoxGeometry(w, len, 0.012), k ? lighter(c, 0.5) : c, 0.9, 0, 0, 0).rotation.z = rot;
      }
      const minis: THREE.Object3D[] = [];
      for (let i = 0; i < 4; i++) {
        const m = b.glow(aura, new THREE.OctahedronGeometry(0.05), lighter(c, 0.4), 0.95, 0, 0, 0);
        m.scale.set(0.5, 1.5, 0.5);
        minis.push(m);
      }
      const sp: THREE.Object3D[] = [];
      for (let i = 0; i < 8; i++) sp.push(b.glow(aura, new THREE.SphereGeometry(0.025, 6, 5), 0xfff6c8, 0.95, 0, 0, 0));
      b.anim.push((t) => {
        star.rotation.z = t * 0.9;
        star.scale.setScalar(0.85 + 0.25 * Math.sin(t * 5));
        minis.forEach((m, i) => {
          const a = t * 2.4 + (i / 4) * Math.PI * 2;
          m.position.set(Math.cos(a) * 0.4, 0.2 + Math.sin(a) * 0.4, 0.08);
          m.rotation.z = a;
        });
        sp.forEach((m, i) => {
          const k = (t * 1.3 + i / 8) % 1;
          const a = (i / 8) * Math.PI * 2 + Math.floor(t * 1.3 + i / 8);
          m.position.set(Math.cos(a) * k * 0.7, 0.2 + Math.sin(a) * k * 0.5 - k * k * 0.45, Math.sin(a * 1.7) * 0.15);
          m.scale.setScalar(1 - k * 0.8);
        });
      });
    } else if (weapon.style === 'voidstorm') {
      // a black core that drags light in: tilted rings spin around it and glowing motes spiral into the dark
      b.plain(() => b.ball(aura, 0.1, b.m(0x050208, { rough: 0.4 }), 0, 0.05, 0));
      b.glow(aura, new THREE.SphereGeometry(0.2, 12, 10), c, 0.3, 0, 0.05, 0);
      const rings: THREE.Mesh[] = [];
      for (let i = 0; i < 3; i++) rings.push(b.glow(aura, new THREE.TorusGeometry(0.18 + i * 0.07, 0.013, 8, 32), i === 1 ? lighter(c, 0.4) : c, 0.85, 0, 0.05, 0));
      const motes: THREE.Object3D[] = [];
      for (let i = 0; i < 12; i++) motes.push(b.glow(aura, new THREE.SphereGeometry(0.03, 6, 5), lighter(c, 0.35), 0.95, 0, 0, 0));
      b.anim.push((t) => {
        rings.forEach((m, i) => {
          m.rotation.x = t * (1.4 + i * 0.5) + i * 1.1;
          m.rotation.y = t * (0.8 - i * 0.6);
        });
        motes.forEach((m, i) => {
          const k = (t * 0.7 + i / 12) % 1;
          const a = i * 2.1 + k * 7;
          const rad = 0.65 * (1 - k);
          m.position.set(Math.cos(a) * rad, 0.05 + Math.sin(i * 1.9) * 0.25 * (1 - k), Math.sin(a) * rad);
          m.scale.setScalar(0.4 + k * 0.9);
          m.visible = k < 0.96;
        });
      });
    } else {
      const rings: THREE.Mesh[] = [];
      for (let i = 0; i < 2; i++) rings.push(b.glow(aura, new THREE.TorusGeometry(0.28 - i * 0.05, 0.014, 8, 30), c, 0.85, 0, 0, 0));
      b.anim.push((t) => rings.forEach((m, i) => {
        m.rotation.x = t * (1.6 + i) + i;
        m.rotation.y = t * (1.1 - i * 0.7);
      }));
    }
  }

  // ---- ground aura
  const ground = look.aura;
  if (ground) {
    const c = hexNum(ground.color);
    const root = r.root;
    const flat = (m: THREE.Mesh) => ((m.rotation.x = Math.PI / 2), m);
    switch (ground.style) {
      case 'ring': {
        const a = flat(b.glow(root, new THREE.TorusGeometry(0.85, 0.03, 8, 48), c, 0.85, 0, 0.04, 0));
        flat(b.glow(root, new THREE.RingGeometry(0.2, 0.85, 40), c, 0.14, 0, 0.035, 0));
        const inner = flat(b.glow(root, new THREE.TorusGeometry(0.55, 0.015, 8, 40), lighter(c, 0.4), 0.7, 0, 0.045, 0));
        b.anim.push((t) => {
          a.scale.setScalar(1 + Math.sin(t * 2.4) * 0.05);
          inner.scale.setScalar(1 - Math.sin(t * 2.4) * 0.06);
        });
        break;
      }
      case 'runes': {
        const rings: THREE.Group[] = [];
        for (const [rad, n, dir] of [[0.9, 8, 1], [0.6, 6, -1]] as const) {
          const g = new THREE.Group();
          g.position.y = 0.045;
          flat(b.glow(g, new THREE.TorusGeometry(rad, 0.012, 6, 48), c, 0.8, 0, 0, 0));
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2;
            const rune = b.glow(g, new THREE.BoxGeometry(0.1, 0.02, 0.06), lighter(c, 0.3), 0.95, Math.cos(a) * rad, 0, Math.sin(a) * rad);
            rune.rotation.y = -a;
          }
          root.add(g);
          rings.push(g);
          void dir;
        }
        b.anim.push((t) => rings.forEach((g, i) => (g.rotation.y = t * (i ? -0.9 : 0.6))));
        break;
      }
      case 'flames': {
        const fl: THREE.Object3D[] = [];
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2;
          fl.push(b.glow(root, new THREE.ConeGeometry(0.09, 0.4, 8), i % 2 ? lighter(c, 0.35) : c, 0.75, Math.cos(a) * 0.75, 0.2, Math.sin(a) * 0.75));
        }
        flat(b.glow(root, new THREE.RingGeometry(0.2, 0.8, 36), c, 0.12, 0, 0.035, 0));
        b.anim.push((t) => fl.forEach((f, i) => f.scale.set(1, 0.7 + 0.6 * Math.abs(Math.sin(t * 6 + i * 1.3)), 1)));
        break;
      }
      case 'vortex': {
        const cyls: THREE.Mesh[] = [];
        for (let i = 0; i < 2; i++) cyls.push(b.glow(root, new THREE.CylinderGeometry(0.85 - i * 0.15, 0.55 - i * 0.1, 1.9, 24, 1, true), i ? lighter(c, 0.3) : c, 0.16 + i * 0.06, 0, 0.95, 0));
        flat(b.glow(root, new THREE.TorusGeometry(0.7, 0.02, 8, 40), c, 0.8, 0, 0.04, 0));
        b.anim.push((t) => cyls.forEach((m, i) => (m.rotation.y = t * (i ? -2.2 : 1.6))));
        break;
      }
      case 'petals': {
        const ps: THREE.Object3D[] = [];
        for (let i = 0; i < 12; i++) ps.push(b.glow(root, new THREE.BoxGeometry(0.1, 0.012, 0.06), i % 3 ? c : lighter(c, 0.4), 0.9, 0, 0, 0));
        b.anim.push((t) => ps.forEach((p, i) => {
          const a = t * (0.8 + (i % 3) * 0.25) + (i / 12) * Math.PI * 2;
          const rad = 0.65 + 0.15 * Math.sin(t + i);
          p.position.set(Math.cos(a) * rad, 0.15 + ((t * 0.35 + i * 0.17) % 1) * 1.6, Math.sin(a) * rad);
          p.rotation.set(t * 2 + i, a, t * 1.5);
        }));
        break;
      }
      case 'throne': {
        // a big rotating seal with a pillar of light and gold motes rising through it
        flat(b.glow(root, new THREE.TorusGeometry(1.15, 0.035, 8, 56), c, 0.9, 0, 0.045, 0));
        flat(b.glow(root, new THREE.RingGeometry(0.25, 1.15, 48), c, 0.08, 0, 0.04, 0));
        const seal = new THREE.Group();
        seal.position.y = 0.05;
        flat(b.glow(seal, new THREE.TorusGeometry(0.8, 0.018, 6, 48), lighter(c, 0.4), 0.85, 0, 0, 0));
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          b.glow(seal, new THREE.BoxGeometry(0.16, 0.02, 0.07), 0xfff2b0, 0.95, Math.cos(a) * 0.8, 0, Math.sin(a) * 0.8).rotation.y = -a;
        }
        root.add(seal);
        const beam = b.glow(root, new THREE.CylinderGeometry(0.55, 0.65, 3.2, 24, 1, true), c, 0.05, 0, 1.6, 0);
        const motes: THREE.Object3D[] = [];
        for (let i = 0; i < 10; i++) motes.push(b.glow(root, new THREE.SphereGeometry(0.035, 6, 5), 0xfff2b0, 0.95, 0, 0, 0));
        b.anim.push((t) => {
          seal.rotation.y = t * 0.7;
          beam.rotation.y = -t * 0.4;
          motes.forEach((m, i) => {
            const k = (t * 0.35 + i * 0.1) % 1;
            const a = i * 2.2 + t * 0.9;
            m.position.set(Math.cos(a) * (0.3 + 0.25 * ((i * 37) % 10) / 10), 0.1 + k * 2.6, Math.sin(a) * (0.3 + 0.25 * ((i * 37) % 10) / 10));
            m.scale.setScalar(1 - k * 0.6);
          });
        });
        break;
      }
      case 'eclipsedisc': {
        // a black disc cut into the floor, ringed by a flaring corona with long rays turning round it and light draining inward
        const disc = b.plain(() => b.add(root, new THREE.CircleGeometry(1.05, 48), b.m(0x05030c, { rough: 0.35 }), 0, 0.03, 0));
        disc.rotation.x = -Math.PI / 2;
        disc.castShadow = false;
        const ring = flat(b.glow(root, new THREE.TorusGeometry(1.05, 0.04, 8, 56), c, 0.95, 0, 0.05, 0));
        const outer = flat(b.glow(root, new THREE.TorusGeometry(1.3, 0.012, 8, 56), lighter(c, 0.4), 0.6, 0, 0.045, 0));
        const rays = new THREE.Group();
        rays.position.y = 0.05;
        root.add(rays);
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          const len = i % 2 ? 0.28 : 0.5;
          const ray = b.glow(rays, new THREE.BoxGeometry(0.035, 0.008, len), i % 2 ? lighter(c, 0.4) : c, 0.85, Math.cos(a) * (1.12 + len / 2), 0, Math.sin(a) * (1.12 + len / 2));
          ray.rotation.y = -a + Math.PI / 2;
        }
        const drain: THREE.Object3D[] = [];
        for (let i = 0; i < 8; i++) drain.push(b.glow(root, new THREE.SphereGeometry(0.035, 6, 5), lighter(c, 0.5), 0.95, 0, 0.06, 0));
        b.anim.push((t) => {
          ring.scale.setScalar(1 + Math.sin(t * 2.2) * 0.03);
          outer.scale.setScalar(1 + Math.sin(t * 1.3 + 1) * 0.05);
          rays.rotation.y = t * 0.35;
          drain.forEach((m, i) => {
            const k = (t * 0.4 + i / 8) % 1;
            const a = i * 0.785 + k * 2;
            m.position.set(Math.cos(a) * (1.25 * (1 - k)), 0.06, Math.sin(a) * (1.25 * (1 - k)));
            m.scale.setScalar(1 - k * 0.7);
          });
        });
        break;
      }
      case 'stormlord': {
        // four lightning pylons round you joined by crackling arcs, and a bolt that now and then strikes the middle
        const R = 1.0;
        const tops: THREE.Vector3[] = [];
        flat(b.glow(root, new THREE.TorusGeometry(R, 0.025, 8, 48), c, 0.7, 0, 0.04, 0));
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          const px = Math.cos(a) * R;
          const pz = Math.sin(a) * R;
          b.glow(root, new THREE.BoxGeometry(0.07, 1.2, 0.07), c, 0.8, px, 0.6, pz);
          b.glow(root, new THREE.OctahedronGeometry(0.1), lighter(c, 0.3), 0.85, px, 1.28, pz);
          tops.push(new THREE.Vector3(px, 1.28, pz));
        }
        const arcs: THREE.Mesh[] = [];
        for (let i = 0; i < 4; i++) {
          const p = tops[i];
          const q = tops[(i + 1) % 4];
          const len = p.distanceTo(q);
          const arc = b.glow(root, new THREE.BoxGeometry(len, 0.03, 0.03), lighter(c, 0.4), 0.85, (p.x + q.x) / 2, 1.28, (p.z + q.z) / 2);
          arc.rotation.y = -Math.atan2(q.z - p.z, q.x - p.x);
          arcs.push(arc);
        }
        const bolt = b.glow(root, new THREE.BoxGeometry(0.07, 2.8, 0.07), lighter(c, 0.4), 0.85, 0, 1.4, 0);
        const flash = flat(b.glow(root, new THREE.RingGeometry(0.05, 0.55, 32), lighter(c, 0.5), 0.6, 0, 0.05, 0));
        b.anim.push((t) => {
          arcs.forEach((m, i) => {
            m.visible = Math.sin(t * 19 + i * 2.3) + Math.sin(t * 7.1 + i) > -0.3;
            m.position.y = 1.28 + Math.sin(t * 40 + i) * 0.06;
          });
          const k = (t * 0.6) % 1.4;
          bolt.visible = flash.visible = k < 0.16 && Math.sin(t * 60) > -0.4;
          bolt.position.x = Math.sin(t * 90) * 0.04;
        });
        break;
      }
      case 'cyclone': {
        // a tall funnel of whirling bands that widens as it climbs, with leaves torn up inside it
        const levels: THREE.Group[] = [];
        for (let i = 0; i < 9; i++) {
          const g = new THREE.Group();
          g.position.y = 0.1 + i * 0.26;
          const rad = 0.3 + i * 0.075;
          flat(b.glow(g, new THREE.TorusGeometry(rad, 0.014, 6, 36), i % 2 ? lighter(c, 0.3) : c, 0.6 - i * 0.04, 0, 0, 0));
          for (let j = 0; j < 3; j++) {
            const a = (j / 3) * Math.PI * 2;
            const bl = b.glow(g, new THREE.BoxGeometry(0.2 + i * 0.012, 0.02, 0.05), c, 0.7 - i * 0.04, Math.cos(a) * rad, 0, Math.sin(a) * rad);
            bl.rotation.y = -a;
          }
          root.add(g);
          levels.push(g);
        }
        const leaves: THREE.Object3D[] = [];
        for (let i = 0; i < 9; i++) leaves.push(b.glow(root, new THREE.BoxGeometry(0.09, 0.012, 0.05), i % 2 ? 0xd8ffd0 : lighter(c, 0.5), 0.95, 0, 0, 0));
        b.anim.push((t) => {
          levels.forEach((g, i) => (g.rotation.y = t * (2.6 - i * 0.18) * (i % 2 ? -1 : 1)));
          leaves.forEach((m, i) => {
            const k = (t * 0.3 + i * 0.111) % 1;
            const a = t * 3 + i * 2.2;
            const rad = 0.2 + k * 0.7;
            m.position.set(Math.cos(a) * rad, 0.1 + k * 2.2, Math.sin(a) * rad);
            m.rotation.set(t * 3 + i, a, t * 2);
          });
        });
        break;
      }
      case 'storm': {
        flat(b.glow(root, new THREE.TorusGeometry(0.95, 0.03, 8, 48), c, 0.85, 0, 0.04, 0));
        const cloud = b.glow(root, new THREE.SphereGeometry(0.55, 14, 10), darker(c, 0.5), 0.5, 0, fit.headTop + 0.75, 0);
        cloud.scale.set(1.2, 0.45, 1.2);
        const bolts: THREE.Object3D[] = [];
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const bolt = b.glow(root, new THREE.BoxGeometry(0.03, 2.2, 0.03), lighter(c, 0.5), 0.95, Math.cos(a) * 0.55, fit.headTop - 0.35, Math.sin(a) * 0.55);
          bolt.rotation.z = (i % 2 ? 1 : -1) * 0.12;
          bolts.push(bolt);
        }
        b.anim.push((t) => bolts.forEach((bl, i) => {
          const on = Math.sin(t * 13 + i * 2.7) + Math.sin(t * 5.3 + i) > 0.9;
          bl.visible = on;
        }));
        break;
      }
      case 'pulse': {
        const rs: THREE.Mesh[] = [];
        for (let i = 0; i < 3; i++) rs.push(flat(b.glow(root, new THREE.TorusGeometry(1, 0.025, 8, 48), i === 1 ? lighter(c, 0.4) : c, 0.8, 0, 0.045, 0)));
        flat(b.glow(root, new THREE.RingGeometry(0.15, 0.6, 32), c, 0.18, 0, 0.035, 0));
        b.anim.push((t) => rs.forEach((m, i) => {
          const k = (t * 0.6 + i / 3) % 1;
          m.scale.setScalar(0.3 + k * 1.0);
          m.visible = k < 0.95;
        }));
        break;
      }
      case 'helix': {
        const hs: THREE.Object3D[] = [];
        for (let i = 0; i < 16; i++) hs.push(b.glow(root, new THREE.SphereGeometry(0.04, 6, 5), i % 2 ? lighter(c, 0.4) : c, 0.95, 0, 0, 0));
        flat(b.glow(root, new THREE.TorusGeometry(0.65, 0.02, 8, 40), c, 0.8, 0, 0.045, 0));
        b.anim.push((t) => hs.forEach((h, i) => {
          const k = (t * 0.4 + i / 16) % 1;
          const a = k * Math.PI * 4 + (i % 2) * Math.PI;
          h.position.set(Math.cos(a) * 0.6, 0.1 + k * 2.2, Math.sin(a) * 0.6);
          h.scale.setScalar(1 - k * 0.5);
        }));
        break;
      }
      case 'embers': {
        const es: THREE.Object3D[] = [];
        for (let i = 0; i < 14; i++) es.push(b.glow(root, new THREE.SphereGeometry(0.03, 6, 5), i % 2 ? lighter(c, 0.4) : c, 0.95, 0, 0, 0));
        flat(b.glow(root, new THREE.RingGeometry(0.3, 0.8, 36), c, 0.1, 0, 0.035, 0));
        b.anim.push((t) => es.forEach((e, i) => {
          const k = (t * 0.45 + i * 0.211) % 1;
          const a = i * 2.4 + t * 0.7;
          e.position.set(Math.cos(a) * (0.35 + 0.35 * ((i * 37) % 10) / 10), 0.1 + k * 1.9, Math.sin(a) * (0.35 + 0.35 * ((i * 37) % 10) / 10));
          e.scale.setScalar(1 - k * 0.7);
        }));
        break;
      }
    }
  }

  // ---- companion
  const orbit = look.orbit;
  if (orbit) {
    const c = hexNum(orbit.color);
    const make = (size: number): THREE.Group => {
      const g = new THREE.Group();
      b.plain(() => b.ball(g, size, b.m(c, { glow: 1.4, rough: 0.2 }), 0, 0, 0));
      b.glow(g, new THREE.SphereGeometry(size * 2.1, 10, 8), c, 0.25, 0, 0, 0);
      upper.add(g);
      return g;
    };
    switch (orbit.style) {
      case 'orb': {
        const g = make(0.075);
        b.anim.push((t) => g.position.set(Math.cos(t * 1.4) * 0.8, 0.75 + Math.sin(t * 2.2) * 0.12, Math.sin(t * 1.4) * 0.8));
        break;
      }
      case 'crystal': {
        const g = new THREE.Group();
        b.plain(() => b.add(g, new THREE.OctahedronGeometry(0.1), b.m(c, { glow: 1.1, rough: 0.2, metal: 0.2 }), 0, 0, 0).scale.set(0.8, 1.5, 0.8));
        b.glow(g, new THREE.SphereGeometry(0.2, 10, 8), c, 0.22, 0, 0, 0);
        upper.add(g);
        b.anim.push((t) => {
          g.position.set(0.62, 1.05 + Math.sin(t * 2) * 0.07, -0.1);
          g.rotation.y = t * 1.8;
        });
        break;
      }
      case 'trio': {
        const gs = [make(0.05), make(0.05), make(0.05)];
        b.anim.push((t) => gs.forEach((g, i) => {
          const a = t * 2.1 + (i / 3) * Math.PI * 2;
          g.position.set(Math.cos(a) * 0.7, 0.8 + Math.sin(a * 1.5) * 0.15, Math.sin(a) * 0.7);
        }));
        break;
      }
      case 'moon': {
        const g = new THREE.Group();
        b.plain(() => b.ball(g, 0.14, b.m(c, { glow: 0.6, rough: 0.9 }), 0, 0, 0));
        b.glow(g, new THREE.SphereGeometry(0.26, 12, 10), c, 0.2, 0, 0, 0);
        upper.add(g);
        b.anim.push((t) => g.position.set(Math.cos(t * 0.9) * 0.55, fit.headTop + 0.35 + Math.sin(t * 1.3) * 0.05, Math.sin(t * 0.9) * 0.55));
        break;
      }
      case 'satellites': {
        const gs = [0, 1, 2, 3, 4, 5].map(() => make(0.05));
        const ring = b.glow(upper, new THREE.TorusGeometry(0.62, 0.01, 6, 48), c, 0.5, 0, fit.headTop - 0.2, 0);
        ring.rotation.x = Math.PI / 2;
        b.anim.push((t) => gs.forEach((g, i) => {
          const a = t * 1.6 + (i / 6) * Math.PI * 2;
          g.position.set(Math.cos(a) * 0.62, fit.headTop - 0.2 + Math.sin(t * 3 + i) * 0.04, Math.sin(a) * 0.62);
        }));
        break;
      }
      case 'sun': {
        const g = new THREE.Group();
        b.plain(() => b.ball(g, 0.13, b.m(c, { glow: 1.8, rough: 0.2 }), 0, 0, 0));
        b.glow(g, new THREE.SphereGeometry(0.3, 12, 10), c, 0.3, 0, 0, 0);
        const rays = new THREE.Group();
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          const ray = b.glow(rays, new THREE.ConeGeometry(0.035, 0.26, 5), lighter(c, 0.3), 0.85, Math.cos(a) * 0.26, Math.sin(a) * 0.26, 0);
          ray.rotation.z = a - Math.PI / 2;
        }
        g.add(rays);
        upper.add(g);
        b.anim.push((t) => {
          rays.rotation.z = t * 1.2;
          g.position.set(Math.cos(t * 0.8) * 0.5, fit.headTop + 0.55 + Math.sin(t * 1.6) * 0.06, Math.sin(t * 0.8) * 0.5);
        });
        break;
      }
      case 'comet': {
        const g = make(0.07);
        const tail: THREE.Object3D[] = [];
        for (let i = 0; i < 6; i++) {
          const m = b.glow(upper, new THREE.SphereGeometry(0.06 - i * 0.008, 6, 5), i % 2 ? lighter(c, 0.4) : c, 0.7 - i * 0.09, 0, 0, 0);
          tail.push(m);
        }
        const pos = (t: number) => new THREE.Vector3(Math.cos(t * 1.7) * 0.85, 0.9 + Math.sin(t * 2.4) * 0.25, Math.sin(t * 1.7) * 0.85);
        b.anim.push((t) => {
          g.position.copy(pos(t));
          tail.forEach((m, i) => m.position.copy(pos(t - (i + 1) * 0.07)));
        });
        break;
      }
      case 'crownring': {
        // four little golden crowns circling at chest height, each turning on its own
        const minis: THREE.Group[] = [];
        for (let i = 0; i < 4; i++) {
          const g = new THREE.Group();
          b.torus(g, 0.07, 0.012, metal(c), 0, 0, 0).rotation.x = Math.PI / 2;
          for (let j = 0; j < 5; j++) {
            const a = (j / 5) * Math.PI * 2;
            b.cone(g, 0.014, 0.07 + (j % 2) * 0.03, metal(c), Math.cos(a) * 0.07, 0.045, Math.sin(a) * 0.07, 5);
          }
          b.plain(() => b.ball(g, 0.016, gemMat(i % 2 ? 0xff3355 : 0x55ccff), 0, 0, 0.07));
          upper.add(g);
          minis.push(g);
        }
        const trail = b.glow(upper, new THREE.TorusGeometry(0.68, 0.008, 6, 48), c, 0.4, 0, 0.8, 0);
        trail.rotation.x = Math.PI / 2;
        b.anim.push((t) => minis.forEach((g, i) => {
          const a = t * 1.1 + (i / 4) * Math.PI * 2;
          g.position.set(Math.cos(a) * 0.68, 0.8 + Math.sin(t * 2 + i * 1.6) * 0.06, Math.sin(a) * 0.68);
          g.rotation.y = -a + t * 2;
          g.rotation.z = Math.sin(t * 1.5 + i) * 0.35;
        }));
        break;
      }
      case 'armillary': {
        // a miniature sun held in three turning golden rings, hovering over the shoulder
        const g = new THREE.Group();
        b.plain(() => b.ball(g, 0.075, b.m(c, { glow: 1.9, rough: 0.2 }), 0, 0, 0));
        b.glow(g, new THREE.SphereGeometry(0.2, 12, 10), c, 0.28, 0, 0, 0);
        const rings: THREE.Mesh[] = [];
        for (let i = 0; i < 3; i++) rings.push(b.glow(g, new THREE.TorusGeometry(0.15 + i * 0.05, 0.011, 6, 32), i % 2 ? lighter(c, 0.4) : c, 0.9, 0, 0, 0));
        const flare = b.glow(g, new THREE.SphereGeometry(0.03, 6, 5), 0xffffff, 0.95, 0.3, 0, 0);
        upper.add(g);
        b.anim.push((t) => {
          rings.forEach((m, i) => {
            m.rotation.x = t * (1.1 + i * 0.4) + i * 2;
            m.rotation.y = t * (0.7 - i * 0.5) + i;
          });
          flare.position.set(Math.cos(t * 3) * 0.3, Math.sin(t * 3) * 0.1, Math.sin(t * 3) * 0.3);
          g.position.set(-0.55, fit.headTop * 0.85 + Math.sin(t * 1.8) * 0.07, 0.05);
        });
        break;
      }
      case 'eclipseorb': {
        // a black star with a thin flaring corona that traces a figure of eight round you, leaving a violet wake
        const g = new THREE.Group();
        b.plain(() => b.ball(g, 0.085, b.m(0x07040d, { rough: 0.3 }), 0, 0, 0));
        const corona = b.glow(g, new THREE.TorusGeometry(0.12, 0.016, 8, 32), c, 0.95, 0, 0, 0);
        b.glow(g, new THREE.SphereGeometry(0.2, 12, 10), c, 0.18, 0, 0, 0);
        upper.add(g);
        const wake: THREE.Object3D[] = [];
        for (let i = 0; i < 5; i++) wake.push(b.glow(upper, new THREE.SphereGeometry(0.035 - i * 0.005, 6, 5), c, 0.7 - i * 0.12, 0, 0, 0));
        const pos = (t: number) => new THREE.Vector3(Math.sin(t * 0.9) * 0.85, fit.headTop * 0.7 + Math.sin(t * 1.8) * 0.2, Math.sin(t * 1.8) * 0.55);
        b.anim.push((t) => {
          g.position.copy(pos(t));
          corona.rotation.set(t * 2.2, t * 1.4, 0);
          wake.forEach((m, i) => m.position.copy(pos(t - (i + 1) * 0.12)));
        });
        break;
      }
      case 'serpent': {
        // a long ribbon of light that winds up and down round you, its colour drifting through green, teal and violet
        const head = make(0.06);
        const segs: THREE.Mesh[] = [];
        for (let i = 0; i < 14; i++) segs.push(own(b.glow(upper, new THREE.SphereGeometry(0.058 - i * 0.003, 8, 6), c, 0.85 - i * 0.04, 0, 0, 0)));
        const pos = (t: number) => new THREE.Vector3(Math.cos(t * 1.3) * 0.75, 0.85 + Math.sin(t * 0.9) * 0.7, Math.sin(t * 1.3) * 0.75);
        b.anim.push((t) => {
          head.position.copy(pos(t));
          segs.forEach((m, i) => {
            m.position.copy(pos(t - (i + 1) * 0.085));
            hue(m, 0.36 + 0.24 * (0.5 + 0.5 * Math.sin(t * 0.9 - i * 0.35)));
          });
        });
        break;
      }
      case 'lantern': {
        const g = new THREE.Group();
        b.cyl(g, 0.05, 0.05, 0.02, metal(0x6b5a3a), 0, 0.09, 0, 8);
        b.cyl(g, 0.06, 0.06, 0.02, metal(0x6b5a3a), 0, -0.09, 0, 8);
        b.plain(() => b.ball(g, 0.065, b.m(c, { glow: 1.5, rough: 0.2 }), 0, 0, 0));
        b.glow(g, new THREE.SphereGeometry(0.2, 10, 8), c, 0.28, 0, 0, 0);
        upper.add(g);
        b.anim.push((t) => g.position.set(-0.62, 0.35 + Math.sin(t * 2.3) * 0.06, 0.12));
        break;
      }
    }
  }
}

const BUILDERS: Record<ClassId, (b: Builder, weapon?: string) => Rig> = { warrior, mage: (b) => mage(b), priest: (b) => priest(b), rogue: (b) => rogue(b) };
const LEAN: Record<ClassId, number> = { warrior: 0, mage: 0, priest: 0, rogue: 0.14 };
const RESTING_ARMS: Record<ClassId, number> = { warrior: -0.15, mage: -0.2, priest: -0.15, rogue: -0.35 };

export function createCharacter(classId: ClassId, look?: string, weapon?: string): Character {
  const b = new Builder();
  const asset = riggedAssetFor(classId, weapon);
  const r = asset ? riggedRig(b, asset, classId, weapon) : BUILDERS[classId](b, weapon);
  if (look) wearCosmetics(b, r, classId, parseLook(look));
  const lean = LEAN[classId];
  const armRest = RESTING_ARMS[classId];
  let lastAlive = true;
  let lastStealth = false;
  let swingT = 0;
  let shoutT = 0;
  const shP = newShoutPose();
  let flashT = 0;
  const SWING = 0.38;
  let swingDur = SWING;
  let swingHand = 0;
  // smoothed joint state so nothing ever snaps
  const st = { sign: 1, upX: lean, upZ: 0, bob: 0, legL: 0, legR: 0, armLx: armRest, armRx: armRest, armLz: 0, armRz: 0, twist: 0, lunge: 0, cape: 0.08, capeV: 0, lastVf: 0 };

  let dead = false;
  const applyState = (alive: boolean, stealthed: boolean) => {
    r.rigged?.ensureOwn();
    for (const m of b.mats) {
      const base = m.userData.base as THREE.Color;
      m.color.copy(base);
      if (!alive) m.color.lerp(DEAD_GRAY, 0.75);
      if (m.userData.dye) (m.userData.dye as DyeUniforms).uOn.value = alive ? 1 : 0;
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
    if (v > 0) r.rigged?.ensureOwn();
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

  const doSwing = (fast = false) => {
    swingDur = fast ? 0.2 : SWING;
    swingT = swingDur;
    if (classId === 'rogue' || (r.rigged && weapon === 'dual')) swingHand = 1 - swingHand; // twin blades strike in turn
  };

  return {
    root: r.root,
    meshes: b.meshes,
    parts: Object.fromEntries(Object.entries(b.parts).map(([slot, ps]) => [slot, ps.map((p) => p.group)])),
    setState(alive, stealthed) {
      if (alive !== lastAlive || stealthed !== lastStealth) {
        lastAlive = alive;
        lastStealth = stealthed;
        applyState(alive, stealthed);
      }
      // lie flat on the ground when dead
      dead = !alive;
      if (alive || r.rigged?.anim.ownDeath) {
        r.root.rotation.x = 0;
        r.root.position.y = 0;
      } else {
        r.root.rotation.x = -Math.PI / 2;
        r.root.position.y = r.rigged?.deadY ?? 0.28;
      }
    },
    swing: doSwing,
    shout() {
      shoutT = SHOUT_DUR;
    },
    flash() {
      flashT = 0.2;
    },
    // a clip model plays its attack animation for a cast (the swing path starts it, see ClipAnimator)
    cast: r.rigged?.anim.castable ? () => doSwing(true) : undefined,
    pose({ phase, move, casting, time, dt: rawDt, vf: vfIn, vs: vsIn, air }) {
      const dt = clamp(rawDt, 0.001, 0.1);
      const vf = vfIn ?? move * 7;
      const vs = vsIn ?? 0;
      for (const a of b.anim) a(time, move);
      if (r.rigged) {
        const swinging = swingT > 0;
        const q = swinging ? 1 - swingT / swingDur : -1;
        const shq = shoutT > 0 && !dead ? 1 - shoutT / SHOUT_DUR : -1;
        if (shoutT > 0) shoutT = Math.max(0, shoutT - dt);
        r.rigged.anim.update({ phase, move, casting, time, dt, vf, vs, swing: q, hand: swingHand, air: air ?? 0, dead, shout: shq });
        r.weaponGrip?.(r.rigged.anim.grip ?? 1);
        for (const f of b.motion) f({ dt, vf, vs, move, time, air, dead, casting });
        if (swinging) swingT = Math.max(0, swingT - dt);
        r.root.position.z = r.rigged.anim.lungeZ;
        if (flashT > 0 || flashed) {
          flashT = Math.max(0, flashT - dt);
          setFlash(flashT > 0 ? flashT / 0.2 : 0);
        }
        return;
      }

      // gait: reverses when backpedalling, eased so direction changes do not snap
      st.sign = damp(st.sign, vf < -0.6 ? -1 : 1, 14, dt);
      const stride = Math.sin(phase) * 0.82 * move * st.sign;
      const breathe = Math.sin(time * 2.0) * 0.02;

      // body: lean into the run, roll into strafes, counter-twist against the legs, bob on each step
      st.upX = damp(st.upX, lean + 0.11 * clamp(vf / 7, -0.5, 1) + breathe, 9, dt);
      st.upZ = damp(st.upZ, -clamp(vs / 7, -1, 1) * 0.13 + Math.sin(phase) * 0.045 * move + Math.sin(time * 0.8) * 0.012 * (1 - move), 10, dt);
      st.bob = damp(st.bob, Math.abs(Math.sin(phase)) * 0.06 * move + breathe * 0.5, 16, dt);
      // the shout pose is added on top of the smoothed body (it is a smooth curve itself)
      const sh = shoutT > 0 && !dead ? shoutPose(1 - shoutT / SHOUT_DUR, shP) : null;
      if (shoutT > 0) shoutT = Math.max(0, shoutT - dt);
      r.upper.rotation.x = st.upX + (sh ? (sh.spine + sh.chest) * 0.6 : 0);
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
        const p = 1 - swingT / swingDur;
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
      r.armL.rotation.x = st.armLx + (sh ? sh.armX : 0);
      r.armR.rotation.x = st.armRx + (sh ? sh.armX : 0);
      r.armL.rotation.z = st.armLz + (sh ? sh.armZ : 0);
      r.armR.rotation.z = st.armRz - (sh ? sh.armZ : 0);
      st.twist = damp(st.twist, twist, swingT > 0 ? 40 : 12, dt);
      r.upper.rotation.y = st.twist;
      st.lunge = damp(st.lunge, lunge, 30, dt);
      r.root.position.z = st.lunge + (sh ? sh.lunge : 0);

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

      for (const f of b.motion) f({ dt, vf, vs, move, time, air, dead, casting });
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
    parts: {}, // the sheep wears nothing: cosmetics only exist on the class model, which is hidden while polymorphed
    swing() {},
    shout() {},
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
