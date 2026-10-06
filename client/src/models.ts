import * as THREE from 'three';
import type { ClassId } from '@arena/shared';

/**
 * Low-poly humanoids built from primitives, one silhouette per class so you can read a fight at a glance:
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

const SKIN = 0xe0b090;
const HIP = 0.85;
const DEAD_GRAY = new THREE.Color(0x555555);

class Builder {
  readonly mats: THREE.MeshStandardMaterial[] = [];
  readonly meshes: THREE.Mesh[] = [];
  private cache = new Map<string, THREE.MeshStandardMaterial>();

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

  add(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    mesh.castShadow = true;
    this.meshes.push(mesh);
    return mesh;
  }

  box(p: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
    return this.add(p, new THREE.BoxGeometry(w, h, d), mat, x, y, z);
  }
  ball(p: THREE.Object3D, r: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
    return this.add(p, new THREE.SphereGeometry(r, 14, 10), mat, x, y, z);
  }
  cyl(p: THREE.Object3D, rt: number, rb: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 14) {
    return this.add(p, new THREE.CylinderGeometry(rt, rb, h, seg), mat, x, y, z);
  }
  cone(p: THREE.Object3D, r: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 14) {
    return this.add(p, new THREE.ConeGeometry(r, h, seg), mat, x, y, z);
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

function rig(b: Builder, o: { torso: number; torsoW: number; torsoD?: number; sleeve: number; pants: number; boots: number; legW?: number; armW?: number; hidden?: boolean }): Rig {
  const root = new THREE.Group();
  const upper = new THREE.Group();
  upper.position.y = HIP;
  root.add(upper);

  const legW = o.legW ?? 0.21;
  const mkLeg = (side: number) => {
    const g = new THREE.Group();
    g.position.set(side * 0.15, HIP, 0);
    b.box(g, legW, 0.78, 0.23, b.m(o.pants), 0, -0.4, 0);
    b.box(g, legW + 0.03, 0.14, 0.34, b.m(o.boots), 0, -0.78, 0.05);
    root.add(g);
    return g;
  };
  const legL = mkLeg(1);
  const legR = mkLeg(-1);

  b.box(upper, o.torsoW, 0.7, o.torsoD ?? 0.36, b.m(o.torso, { metal: o.hidden ? 0.1 : 0.3 }), 0, 0.35, 0);

  const armW = o.armW ?? 0.15;
  const mkArm = (side: number) => {
    const g = new THREE.Group();
    g.position.set(side * (o.torsoW / 2 + armW / 2 + 0.02), 0.62, 0);
    b.box(g, armW, 0.58, armW, b.m(o.sleeve, { metal: 0.2 }), 0, -0.29, 0);
    b.ball(g, armW * 0.62, b.m(SKIN), 0, -0.62, 0);
    upper.add(g);
    return g;
  };
  const armL = mkArm(1);
  const armR = mkArm(-1);

  b.ball(upper, 0.2, b.m(SKIN), 0, 0.92, 0);
  return { root, upper, legL, legR, armL, armR };
}

function eyes(b: Builder, r: Rig, y = 0.94, z = 0.185, color = 0x1a1a22) {
  for (const x of [-0.07, 0.07]) b.ball(r.upper, 0.03, b.m(color), x, y, z);
}

function addCape(b: Builder, r: Rig, color: number, trim: number, w: number, len: number) {
  const pivot = new THREE.Group();
  pivot.position.set(0, 0.68, -0.2);
  b.box(pivot, w, len, 0.04, b.m(color, { rough: 0.95 }), 0, -len / 2, 0);
  b.box(pivot, w + 0.02, 0.06, 0.05, b.m(trim, { metal: 0.5 }), 0, -len + 0.03, 0);
  r.upper.add(pivot);
  r.cape = pivot;
}

function warrior(b: Builder): Rig {
  const steel = 0x8a8f9a;
  const dark = 0x4d525c;
  const r = rig(b, { torso: steel, torsoW: 0.74, torsoD: 0.42, sleeve: steel, pants: dark, boots: 0x3a2f27, legW: 0.24, armW: 0.18 });
  const { upper } = r;
  addCape(b, r, 0x8c2a24, 0xd4af37, 0.62, 1.15);
  // tabard in class colour
  b.box(upper, 0.34, 0.62, 0.05, b.m(0xc79c6e), 0, 0.3, 0.23);
  // pauldrons
  for (const s of [-1, 1]) {
    const p = b.ball(upper, 0.2, b.m(dark, { metal: 0.5 }), s * 0.47, 0.7, 0);
    p.scale.set(1.1, 0.7, 1.1);
  }
  // great helm with visor slit and horns
  const helm = b.ball(upper, 0.235, b.m(steel, { metal: 0.6, rough: 0.4 }), 0, 0.95, 0);
  helm.scale.set(1, 1.02, 1);
  b.box(upper, 0.3, 0.05, 0.06, b.m(0x15171c), 0, 0.93, 0.2);
  for (const s of [-1, 1]) {
    const h = b.cone(upper, 0.055, 0.34, b.m(0xe8e0cc), s * 0.25, 1.12, 0);
    h.rotation.z = -s * 0.85;
  }
  // sword (right hand): grip at the hand, blade pointing forward
  const sword = new THREE.Group();
  sword.position.set(0, -0.62, 0.05);
  sword.rotation.x = Math.PI / 2;
  b.box(sword, 0.05, 0.16, 0.05, b.m(0x4a2f1b), 0, 0, 0);
  b.box(sword, 0.28, 0.04, 0.07, b.m(0xd4af37, { metal: 0.6 }), 0, 0.09, 0);
  b.box(sword, 0.07, 0.95, 0.02, b.m(0xd8dde6, { metal: 0.8, rough: 0.25 }), 0, 0.58, 0);
  r.armR.add(sword);
  // shield (left arm)
  const shield = b.cyl(r.armL, 0.4, 0.4, 0.07, b.m(0x6b3f23, { rough: 0.6 }), 0.17, -0.3, 0.05, 20);
  shield.rotation.z = Math.PI / 2;
  const boss = b.cyl(r.armL, 0.1, 0.1, 0.1, b.m(0xd4af37, { metal: 0.7 }), 0.2, -0.3, 0.05);
  boss.rotation.z = Math.PI / 2;
  return r;
}

function mage(b: Builder): Rig {
  const robe = 0x2c5fa8;
  const r = rig(b, { torso: robe, torsoW: 0.56, sleeve: 0x244f8c, pants: robe, boots: 0x2a2233, hidden: true });
  const { root, upper } = r;
  // flowing robe covers the legs
  b.cyl(root, 0.3, 0.58, 1.5, b.m(robe, { rough: 0.9 }), 0, 0.8, 0, 20);
  b.cyl(root, 0.585, 0.585, 0.07, b.m(0x69ccf0, { glow: 0.3 }), 0, 0.07, 0, 20);
  b.box(upper, 0.6, 0.1, 0.38, b.m(0xd8c07a), 0, 0.12, 0); // sash
  // pointed hat
  b.cyl(upper, 0.4, 0.4, 0.04, b.m(0x1f4380), 0, 1.07, 0, 20);
  const hat = b.cone(upper, 0.27, 0.72, b.m(0x1f4380), 0, 1.45, 0, 16);
  hat.rotation.x = -0.18;
  hat.position.z = -0.05;
  b.cyl(upper, 0.275, 0.275, 0.07, b.m(0x69ccf0, { glow: 0.4 }), 0, 1.13, 0, 16);
  eyes(b, r);
  // beard
  const beard = b.cone(upper, 0.14, 0.34, b.m(0xdcdcdc), 0, 0.68, 0.14, 10);
  beard.rotation.x = Math.PI;
  // staff with glowing orb (right hand)
  const staff = new THREE.Group();
  staff.position.set(0, -0.62, 0.06);
  b.cyl(staff, 0.035, 0.04, 1.9, b.m(0x5a3b22), 0, 0.3, 0, 8);
  b.ball(staff, 0.13, b.m(0x69ccf0, { glow: 1.2 }), 0, 1.3, 0);
  b.cyl(staff, 0.09, 0.06, 0.1, b.m(0xd4af37, { metal: 0.7 }), 0, 1.17, 0, 8);
  r.armR.add(staff);
  return r;
}

function priest(b: Builder): Rig {
  const white = 0xf0eee6;
  const gold = 0xe2b93b;
  const r = rig(b, { torso: white, torsoW: 0.56, sleeve: white, pants: white, boots: 0xc9b27a, hidden: true });
  const { root, upper } = r;
  b.cyl(root, 0.3, 0.56, 1.5, b.m(white, { rough: 0.9 }), 0, 0.8, 0, 20);
  b.cyl(root, 0.565, 0.565, 0.08, b.m(gold, { metal: 0.5 }), 0, 0.06, 0, 20);
  // gold mantle and stole
  b.cyl(upper, 0.36, 0.42, 0.14, b.m(gold, { metal: 0.5 }), 0, 0.66, 0, 18);
  b.box(upper, 0.14, 0.9, 0.04, b.m(gold, { metal: 0.4 }), 0, 0.1, 0.2);
  // halo
  const halo = b.add(upper, new THREE.TorusGeometry(0.22, 0.025, 8, 24), b.m(0xfff0a0, { glow: 1.3 }), 0, 1.3, 0);
  halo.rotation.x = Math.PI / 2;
  eyes(b, r, 0.96, 0.19);
  // gentle hair
  const hair = b.ball(upper, 0.215, b.m(0xd9c27a), 0, 0.96, -0.03);
  hair.scale.set(1, 0.9, 1);
  // mace (right hand)
  const mace = new THREE.Group();
  mace.position.set(0, -0.62, 0.06);
  mace.rotation.x = Math.PI / 2;
  b.cyl(mace, 0.035, 0.04, 0.8, b.m(0x6b4a2b), 0, 0.3, 0, 8);
  b.ball(mace, 0.13, b.m(gold, { metal: 0.6, glow: 0.35 }), 0, 0.78, 0);
  b.box(mace, 0.04, 0.3, 0.04, b.m(gold, { metal: 0.6 }), 0, 0.78, 0);
  b.box(mace, 0.3, 0.04, 0.04, b.m(gold, { metal: 0.6 }), 0, 0.78, 0);
  r.armR.add(mace);
  // glowing tome (left hand)
  const tome = new THREE.Group();
  tome.position.set(0.04, -0.62, 0.12);
  b.box(tome, 0.26, 0.04, 0.34, b.m(0x7a2f2f), 0, 0, 0);
  b.box(tome, 0.22, 0.045, 0.3, b.m(0xfff0a0, { glow: 0.6 }), 0, 0.01, 0);
  r.armL.add(tome);
  return r;
}

function rogue(b: Builder): Rig {
  const leather = 0x2b2b33;
  const r = rig(b, { torso: leather, torsoW: 0.5, torsoD: 0.3, sleeve: 0x23232a, pants: 0x1e1e24, boots: 0x14141a, legW: 0.18, armW: 0.13 });
  const { upper } = r;
  upper.rotation.x = 0.14; // permanent forward lean, set again in pose()
  addCape(b, r, 0x1c1c22, 0x5a4a2a, 0.5, 0.9);
  // belt and bandolier in class colour
  b.box(upper, 0.52, 0.08, 0.32, b.m(0xfff569, { rough: 0.5 }), 0, 0.04, 0);
  const strap = b.box(upper, 0.08, 0.8, 0.34, b.m(0x5a4a2a), 0.05, 0.38, 0);
  strap.rotation.z = 0.55;
  // hood and mask
  const hood = b.ball(upper, 0.235, b.m(leather), 0, 0.94, -0.03);
  hood.scale.set(1, 1.05, 1.05);
  const peak = b.cone(upper, 0.19, 0.3, b.m(leather), 0, 1.0, -0.2, 12);
  peak.rotation.x = -1.9;
  b.box(upper, 0.3, 0.13, 0.12, b.m(0x14141a), 0, 0.85, 0.15); // face mask
  b.box(upper, 0.24, 0.04, 0.05, b.m(0xfff569, { glow: 0.5 }), 0, 0.96, 0.2); // eyes
  // twin daggers
  for (const [arm, s] of [[r.armR, -1], [r.armL, 1]] as const) {
    const d = new THREE.Group();
    d.position.set(0, -0.62, 0.05);
    d.rotation.x = Math.PI / 2;
    d.rotation.z = s * 0.1;
    b.box(d, 0.04, 0.12, 0.04, b.m(0x3a2f27), 0, 0, 0);
    b.box(d, 0.14, 0.03, 0.05, b.m(0x888c96, { metal: 0.6 }), 0, 0.07, 0);
    b.box(d, 0.05, 0.42, 0.015, b.m(0xc9d0da, { metal: 0.85, rough: 0.2 }), 0, 0.3, 0);
    arm.add(d);
  }
  return r;
}

const BUILDERS: Record<ClassId, (b: Builder) => Rig> = { warrior, mage, priest, rogue };
const LEAN: Record<ClassId, number> = { warrior: 0, mage: 0, priest: 0, rogue: 0.14 };
const RESTING_ARMS: Record<ClassId, number> = { warrior: -0.15, mage: -0.2, priest: -0.15, rogue: -0.35 };

export function createCharacter(classId: ClassId): Character {
  const b = new Builder();
  const r = BUILDERS[classId](b);
  const lean = LEAN[classId];
  const armRest = RESTING_ARMS[classId];
  let lastAlive = true;
  let lastStealth = false;
  let swingT = 0;
  let flashT = 0;
  const SWING = 0.3;

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
    },
    flash() {
      flashT = 0.2;
    },
    pose({ phase, move, casting, time, dt }) {
      const swing = Math.sin(phase) * 0.75 * move;
      r.legL.rotation.x = swing;
      r.legR.rotation.x = -swing;
      const breathe = Math.sin(time * 2.2) * 0.02;
      r.upper.rotation.x = lean + move * 0.06 + breathe;
      r.upper.position.y = HIP + Math.abs(Math.sin(phase)) * 0.05 * move;
      if (r.cape) r.cape.rotation.x = 0.08 + move * 0.45 + Math.sin(time * 2.4 + phase) * 0.05 * (0.4 + move);
      if (casting) {
        // both hands forward and up, with a slight shake of concentration
        const shake = Math.sin(time * 18) * 0.03;
        r.armL.rotation.x = -1.35 + shake;
        r.armR.rotation.x = -1.45 - shake;
      } else {
        r.armL.rotation.x = armRest - swing * 0.9;
        r.armR.rotation.x = armRest + swing * 0.9;
      }
      if (swingT > 0) {
        // wind up, then chop forward and down
        const p = 1 - swingT / SWING;
        const arc = p < 0.35 ? -2.4 * (p / 0.35) : -2.4 + 3.0 * ((p - 0.35) / 0.65);
        r.armR.rotation.x = arc;
        if (classId === 'rogue') r.armL.rotation.x = arc * 0.8 - 0.2;
        r.upper.rotation.y = Math.sin(p * Math.PI) * -0.35;
        swingT = Math.max(0, swingT - dt);
        if (swingT === 0) r.upper.rotation.y = 0;
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
