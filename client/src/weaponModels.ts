import * as THREE from 'three';
import { customScene, fittedWeapon } from './customModels';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { fetchModel } from './modelPack';
import type { ArmHold } from './riggedPose';

/**
 * The warrior's real weapon models (client/public/models/weapons/*.glb, written by scripts/prep-weapon.mjs; credits in
 * client/src/credits.ts). Convention of those files: every part is a root-level node with the GRIP POINT at its origin, the
 * weapon pointing along +Y (blade tip / axe head) and +Z the flat face of the blade (the axe head's wings run along Z).
 *
 * This file is the registry (which weapon id uses which GLB and how it sits in the hands), the loader and the per-unit
 * instancing: geometry and textures are shared by every unit, materials are cloned per unit (hit flash, stealth and death
 * tint them). While a GLB has not loaded (or failed to) `attachWeapon` returns undefined and models.ts builds the old
 * procedural weapon instead.
 *
 * Hand groups (`armR` / `armL` in models.ts) sit where the hand is, offset so that a child at (0, -0.62, 0.05) lands on the grip
 * point and character-aligned at rest (x = the character's left, y up, z forward). `rot` is the weapon's orientation in that
 * frame while the arm hangs; the animator turns the whole hand group with the arm.
 */

export interface HandHold {
  /** Node name in the GLB. */
  part: string;
  /** Euler XYZ (radians) turning the weapon (y = tip) into the hand group's frame. */
  rot: [number, number, number];
  /** Extra offset from the grip point (hand group frame). */
  pos?: [number, number, number];
  /** Extra aim on top of `rot`, in the character's frame: raise the tip by `lift` radians and turn it away from the body by `out`. */
  lift?: number;
  out?: number;
  /** Mirror across the character's centre plane (the off-hand copy of a one-handed pair). */
  mirror?: boolean;
}

export interface WeaponDef {
  url: string;
  /** A model the dev uploaded in place of the weapon's own (models.json `file`): stood along y at the length of the weapon (2 x `mid`). */
  file?: string;
  right: HandHold;
  /** Second hand-held piece (dual wield). Two-handers leave this out and use `hold` for the off hand. */
  left?: HandHold;
  /** Soft halo along the weapon in the spec's colour: where along the weapon (y, from the grip), how long and how thick. */
  /** Where along the weapon (y from the grip) weapon cosmetics (flames, stars, rings) are centred. */
  mid: number;
  glow?: { color: number; from: number; to: number; r: number; opacity?: number };
  /** Arm pose while held (two-handers): the animator keeps both arms on the weapon and swings them together. */
  hold?: ArmHold;
  /** Orientation (and offset) of the weapon in the right hand group while it rests on the shoulder one-handed (see ArmHold.rest); it turns into `right` as the second hand takes hold. */
  rest?: { rot: [number, number, number]; pos?: [number, number, number]; /** Turn about the weapon's own long axis (radians): which face of the blade rests on the shoulder. */ roll?: number };
  /** What the wielder looks like with it (the mage specs): robe tint and the magic that hangs around the weapon's head (models.ts applies them). */
  look?: WeaponLook;
}

/** Per-spec look of the unit that holds a weapon. The robe is pulled toward `color` (see the dye shader in models.ts); `glyph` makes the robe's red trim glow in that colour. */
export interface WeaponLook {
  robe: { color: number; k?: number; floor?: number; rim?: number; rimColor?: number; glyph: number; glyphK: number };
  /** 'embers' rise off the head, 'frost' motes drift around it, 'stars' orbit it. `color` / `color2` are the mote colours. */
  fx: 'embers' | 'frost' | 'stars';
  color: number;
  color2: number;
}

const H = Math.PI / 2;

export const WEAPONS: Record<string, WeaponDef> = {
  // Warbringer: a curved sabre in each hand, blades forward and a little out, edges down
  dual: {
    url: '/models/weapons/saber-dual.glb',
    right: { part: 'saber', rot: [H, H, 0], lift: 0.4, out: 0.3 },
    left: { part: 'saber', rot: [H, H, 0], lift: 0.4, out: 0.3, mirror: true },
    mid: 0.6,
    glow: { color: 0x7fd0ff, from: 0.1, to: 1.1, r: 0.05, opacity: 0.08 },
  },
  // Rogue (every spec): the same dagger in each hand, point forward and a little out, held in a forward grip
  daggers: {
    url: '/models/weapons/dagger.glb',
    right: { part: 'dagger', rot: [H, H, 0], lift: -0.3, out: 0.12 },
    left: { part: 'dagger', rot: [H, H, 0], lift: -0.3, out: 0.12, mirror: true },
    mid: 0.4,
  },
  // Rampager: the greatsword rests on the right shoulder in one hand; both hands take it up and forward to swing
  twohand: {
    url: '/models/weapons/greatsword.glb',
    right: { part: 'weapon', rot: [2.259, 1.199, -0.654] },
    mid: 1.0,
    glow: { color: 0xffb347, from: 0.3, to: 2.0, r: 0.07, opacity: 0.12 },
    hold: { r: { x: -0.212, z: 0.46, e: -0.887 }, l: { x: -0.687, z: -0.769, e: -0.103 }, walk: 0.3, arc: 0.6, elbowArc: 0, rest: { r: { x: 0.016, z: 0.295, e: -1.661 }, walk: 0.3 } },
    rest: { rot: [1.016, 0.17, -0.14], roll: Math.PI / 2 },
  },
  // Barbarian: the Tyra polearm, carried diagonally across the body in both hands
  polearm: {
    url: '/models/weapons/polearm.glb',
    right: { part: 'weapon', rot: [-0.379, -0.488, -1.659] },
    mid: 1.3,
    // Both fists on the haft, the left hand reaching across at chest height. The old pose swung the left arm 68 degrees across the
    // chest (z -1.18), which the knight's shoulder skin cannot follow: 320 edges of the shoulder, chest and neck stretched past 2.5x
    // (up to 24x) and tore into shards. This one keeps the arm in front of the shoulder (z -0.4): 55 edges, none longer than 0.14 yd.
    // `elbowArc: 0` keeps both fists rigid on the haft through a swing; `arc` 0.4 raises the weapon without dragging the shoulders past what the skin tolerates.
    hold: { r: { x: 0.1, z: 0.2, e: -0.7 }, l: { x: -0.2, z: -0.4, e: -1.4 }, walk: 0.3, arc: 0.4, elbowArc: 0 },
  },
  // The mage staffs (Old Wizard, models.ts / riggedClips.ts). `rot` stands the staff up the way the wizard's own staff was held in
  // his idle clip (prep-character.mjs measures it: leaning 9 degrees forward); the grip is at the staff's middle, the head `mid` above it.
  fire_staff: {
    url: '/models/weapons/staff-fire.glb',
    right: { part: 'staff', rot: [0.159, 0, 0.034] },
    mid: 1.0,
    look: { robe: { color: 0xb8401a, k: 0.82, floor: 0.1, rim: 0.35, rimColor: 0xff9a4a, glyph: 0xff8a2a, glyphK: 1.7 }, fx: 'embers', color: 0xe8661c, color2: 0xf0a040 },
  },
  ice_staff: {
    url: '/models/weapons/staff-ice.glb',
    right: { part: 'staff', rot: [0.159, 0, 0.034] },
    mid: 0.9,
    look: { robe: { color: 0x5f9ccc, k: 0.82, floor: 0.14, rim: 0.7, rimColor: 0xe2f8ff, glyph: 0xa8f0ff, glyphK: 1.5 }, fx: 'frost', color: 0x9fdcf0, color2: 0xdff6ff },
  },
  arcane_staff: {
    url: '/models/weapons/staff-arcane.glb',
    right: { part: 'staff', rot: [0.159, 0, 0.034] },
    mid: 1.0,
    look: { robe: { color: 0x5a3cb0, k: 0.84, floor: 0.12, rim: 0.55, rimColor: 0xd8c4ff, glyph: 0xdcc8ff, glyphK: 1.6 }, fx: 'stars', color: 0xb08cf0, color2: 0xece0ff },
  },
  // Priest staffs (Abyssal Sentinel): the shaft stands up through the fist like the mage staffs, the gold head above it. Warden and Lightbearer share the holy staff.
  holy_staff: {
    url: '/models/weapons/staff-holy.glb',
    // the fist closes about a third of the way up the shaft (`pos` slides the staff down through the hand), so its foot stands near the floor instead of hanging in the air
    right: { part: 'staff', rot: [0.159, 0, 0.034], pos: [0, -0.4, 0] },
    mid: 1.0,
  },
  necro_staff: {
    url: '/models/weapons/staff-necro.glb',
    right: { part: 'staff', rot: [0.159, 0, 0.034], pos: [0, -0.4, 0] },
    mid: 0.9,
  },
};

interface Loaded {
  scene: THREE.Group;
}
const loaded = new Map<string, Loaded>();
let version = 0;

/** Changes whenever a weapon model finishes loading (added to riggedModels' `modelVersion`, so scenes rebuild their knights). */
export const weaponModelVersion = () => version;

function finish(id: string, gltf: { scene: THREE.Group }) {
  const def = WEAPONS[id];
  for (const h of [def.right, def.left]) if (h && !gltf.scene.getObjectByName(h.part)) throw new Error(`weapon ${id}: no part "${h.part}"`);
  gltf.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });
  loaded.set(id, { scene: gltf.scene });
  version++;
}

/** Parse a weapon GLB that is already in memory (tests). */
export function registerWeaponModel(id: string, data: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(data, '', (g) => {
      try {
        finish(id, g);
        resolve();
      } catch (e) {
        reject(e);
      }
    }, reject);
  });
}

export function forgetWeaponModels() {
  loaded.clear();
  version++;
}

export const weaponModelLoaded = (id: string) => loaded.has(id);

/** Load every weapon GLB in the background; failures are logged and leave the procedural weapon in place. */
export function preloadWeaponModels(): Promise<void> {
  const loader = new GLTFLoader();
  return Promise.all(
    Object.entries(WEAPONS).map(
      ([id, def]) =>
        fetchModel(def.url)
          .then(
            (data) =>
              new Promise<void>((resolve) => {
                loader.parse(data, '', (g) => {
                  try {
                    finish(id, g);
                  } catch (e) {
                    console.warn(`weapon ${id}:`, e);
                  }
                  resolve();
                }, (e) => {
                  console.warn(`weapon ${id} could not be read, keeping the procedural weapon`, e);
                  resolve();
                });
              }),
          )
          .catch((e) => console.warn(`weapon ${id} failed to load, keeping the procedural weapon`, e)),
    ),
  ).then(() => undefined);
}

export interface WeaponHost {
  armR: THREE.Object3D;
  armL: THREE.Object3D;
  /** Pickable meshes of the unit. */
  addMesh(m: THREE.Mesh): void;
  /** Materials the unit tints (hit flash, stealth, death). */
  addMaterial(m: THREE.MeshStandardMaterial): void;
  /** Register a non-pickable shape that hides with the unit (additive flames). */
  addFx(o: THREE.Object3D): void;
  /** Additive glow shapes (hidden while dead or stealthed). */
  glow(parent: THREE.Object3D, geo: THREE.BufferGeometry, color: number, opacity: number, x: number, y: number, z: number): THREE.Mesh;
}

export interface AttachedWeapon {
  /** Arm pose to hold while the weapon is carried (two-handers). */
  hold?: ArmHold;
  /** The weapon's pivot in the right hand group, and where its middle is (cosmetics ride on it). */
  pivot: THREE.Object3D;
  mid: number;
  /** Blend the weapon between its one-handed rest pose (0) and the two-handed hold (1); a no-op for weapons without a rest pose. */
  setGrip(k: number): void;
  /** Where the middle of the weapon's glowing part is, in the right hand group's frame (weapon cosmetics are centred there). */
  glowAt: THREE.Vector3;
}

const GRIP = new THREE.Vector3(0, -0.62, 0.05);
const haloGeo = new THREE.SphereGeometry(1, 14, 10);

/** Put weapon `id` into the unit's hands, or return undefined when its model is not loaded (the caller builds the procedural one). */
export function attachWeapon(id: string | undefined, host: WeaponHost): AttachedWeapon | undefined {
  const def = id ? WEAPONS[id] : undefined;
  const src = id ? loaded.get(id) : undefined;
  if (!def || !src) return undefined;
  const mats = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  const own = (m: THREE.Material) => {
    let c = mats.get(m);
    if (!c) {
      c = (m as THREE.MeshStandardMaterial).clone();
      c.userData.base = c.color.clone();
      // a material with a glow map (the fire staff's embers) keeps it lit; additive materials (flames on black) never take tints
      c.userData.glow = c.emissiveMap ? c.emissiveIntensity : 0;
      mats.set(m, c);
      if (c.userData.additive) {
        c.blending = THREE.AdditiveBlending;
        c.transparent = true;
        c.depthWrite = false;
        c.fog = false;
        c.emissive.set(0x000000);
        c.color.multiplyScalar(1.4);
      } else host.addMaterial(c);
    }
    return c;
  };
  const place = (arm: THREE.Object3D, h: HandHold) => {
    const pivot = new THREE.Group();
    pivot.name = `weapon:${h.part}`;
    pivot.position.copy(GRIP).add(new THREE.Vector3(...(h.pos ?? [0, 0, 0])));
    pivot.rotation.set(...h.rot);
    if (h.lift || h.out) {
      const aim = new THREE.Quaternion().setFromEuler(new THREE.Euler(-(h.lift ?? 0), (h.mirror ? 1 : -1) * (h.out ?? 0), 0, 'YXZ'));
      pivot.quaternion.premultiply(aim);
      pivot.userData.aim = aim.clone();
    }
    pivot.userData.grip = GRIP.clone();
    const upload = def.file ? customScene(def.file) : null;
    const part = upload ? fittedWeapon(upload, Math.max(0.2, def.mid * 2)) : src.scene.getObjectByName(h.part)!.clone(true); // meshes share geometry and textures
    if (h.mirror) part.scale.z = -1;
    part.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material);
      if ((o.material as THREE.Material).userData.additive) {
        o.castShadow = false;
        o.renderOrder = 2;
        host.addFx(o);
      } else host.addMesh(o);
    });
    pivot.add(part);
    arm.add(pivot);
    return pivot;
  };
  const right = place(host.armR, def.right);
  right.userData.hand = 'right';
  const left = def.left ? place(host.armL, def.left) : undefined;
  if (left) left.userData.hand = 'left';
  // a faint halo in the spec's colour along the blade
  const g = def.glow;
  const mid = def.mid;
  if (g) {
    for (const pivot of left ? [right, left] : [right]) {
      const halo = host.glow(pivot, haloGeo, g.color, g.opacity ?? 0.12, 0, (g.from + g.to) / 2, 0);
      halo.scale.set(g.r, (g.to - g.from) / 2, g.r);
    }
  }
  const glowAt = new THREE.Vector3(0, mid, 0).applyQuaternion(right.quaternion).add(right.position);
  const holdQ = right.quaternion.clone(), holdPos = right.position.clone();
  const restQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(def.rest?.rot ?? [0, 0, 0])));
  if (def.rest?.roll) restQ.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), def.rest.roll));
  const restPos = GRIP.clone().add(new THREE.Vector3(...(def.rest?.pos ?? [0, 0, 0])));
  let lastK = 1;
  const setGrip = (k: number) => {
    if (!def.rest || k === lastK) return;
    lastK = k;
    right.quaternion.slerpQuaternions(restQ, holdQ, k);
    right.position.lerpVectors(restPos, holdPos, k);
  };
  return { hold: def.hold, pivot: right, mid, setGrip, glowAt };
}
