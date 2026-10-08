import { describe, it, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CLASS_IDS, COSMETICS, SLOT_IDS, gearLook, itemsForSlot } from '@arena/shared';
import { createCharacter, createSheep, REPLACEABLE_SLOTS } from '../src/models';
import { unpackModel } from '../src/modelPack';
import { registerRiggedModel, forgetRiggedModels, modelVersion } from '../src/riggedModels';

/** Every mesh below `o` (the tree itself, not the picking list). */
const meshesIn = (o: THREE.Object3D) => {
  const out: THREE.Object3D[] = [];
  o.traverse((c) => c instanceof THREE.Mesh && out.push(c));
  return out;
};

describe('cosmetic models', () => {
  it('every item can be worn by every class and animates without errors', () => {
    for (const cls of CLASS_IDS) for (const item of COSMETICS.items) {
      const look = gearLook({ [item.slot]: item.id });
      const ch = createCharacter(cls, look);
      for (let i = 0; i < 4; i++) ch.pose({ phase: i, move: i % 2, casting: false, time: i * 0.37, dt: 0.05 });
      ch.setState(false, false);
      ch.pose({ phase: 0, move: 0, casting: false, time: 2, dt: 0.05 });
    }
  });
  it('every owner-only item has a shape of its own: no other item uses its style in the same slot', () => {
    for (const slot of SLOT_IDS) {
      const items = itemsForSlot(slot);
      for (const o of items.filter((i) => i.owner)) {
        const same = items.filter((i) => i !== o && i.style === o.style);
        assert.deepEqual(same.map((i) => i.id), [], `${o.id} shares the ${o.style} model`);
      }
    }
  });

  it('every class has a built-in part tagged for each replaceable slot (except where it has none)', () => {
    const expected: Record<string, string[]> = { warrior: ['head', 'shoulders', 'back'], mage: ['head', 'shoulders'], priest: ['head', 'shoulders', 'back'], rogue: ['head', 'shoulders', 'back'] };
    for (const cls of CLASS_IDS) {
      const ch = createCharacter(cls);
      assert.deepEqual(Object.keys(ch.parts).sort(), [...expected[cls]].sort(), `${cls} base parts`);
    }
  });

  it('a cosmetic in a slot replaces the base part; none keeps it; never both', () => {
    for (const cls of CLASS_IDS) {
      const bare = createCharacter(cls);
      for (const slot of REPLACEABLE_SLOTS) {
        for (const part of bare.parts[slot] ?? []) {
          assert.equal(part.visible, true);
          assert.ok(bare.root.getObjectById(part.id), `${cls} ${slot} base part is on the model`);
        }
        for (const item of itemsForSlot(slot)) {
          const ch = createCharacter(cls, gearLook({ [slot]: item.id }));
          for (const [s, parts] of Object.entries(ch.parts)) {
            for (const part of parts) {
              const worn = s === slot;
              assert.equal(!!ch.root.getObjectById(part.id), !worn, `${cls}: ${s} base part with ${item.id} in ${slot}`);
              assert.equal(part.visible, !worn);
              // nothing of a replaced part stays pickable
              const inTree = new Set(meshesIn(ch.root));
              for (const m of meshesIn(part)) assert.equal(inTree.has(m) || ch.meshes.includes(m as THREE.Mesh), !worn);
            }
          }
        }
      }
    }
  });

  it('switching items repeatedly never leaves a stale or doubled base part', () => {
    for (const cls of CLASS_IDS) {
      const seq = ['void_horns', '', 'founder_crown', '', 'crown_gold'];
      let last: ReturnType<typeof createCharacter> | undefined;
      for (const id of seq) {
        last = createCharacter(cls, gearLook(id ? { head: id } : {}));
        const parts = last.parts.head ?? [];
        for (const p of parts) assert.equal(!!last.root.getObjectById(p.id), !id, `${cls} head part with ${id || 'none'}`);
        last.pose({ phase: 1, move: 1, casting: false, time: 1, dt: 0.05 });
      }
    }
  });

  it('the warrior keeps its height, and the polymorph form has no base parts to replace', () => {
    const top = (ch: ReturnType<typeof createCharacter>) => new THREE.Box3().setFromObject(ch.root).max.y;
    const plain = top(createCharacter('warrior'));
    assert.ok(plain > 1.9 && plain < 2.6, `warrior height ${plain}`);
    assert.deepEqual(createSheep().parts, {});
  });
});

// ------------------------------------------------------------------ rigged (skinned) models

const MODEL_DIR = fileURLToPath(new URL('../public/models/', import.meta.url));
/** The models are served scrambled (.pak): read and unscramble like the game does. */
const loadGlb = (file: string) => unpackModel(new Uint8Array(readFileSync(MODEL_DIR + file.replace(/\.glb$/, '.pak'))));

describe('rigged character models', () => {
  const g = globalThis as unknown as { createImageBitmap?: unknown; self?: unknown };
  const realBitmap = g.createImageBitmap;
  const realSelf = g.self;
  before(async () => {
    g.self = globalThis; // the glTF loader reads self.URL
    // node has no image decoding: give the loader a stub bitmap so textures "load" (nothing renders here)
    g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
    await registerRiggedModel('knight', loadGlb('warrior.glb'));
    await registerRiggedModel('brute', loadGlb('warrior-brute.glb'));
  });
  after(() => {
    forgetRiggedModels();
    g.createImageBitmap = realBitmap;
    g.self = realSelf;
  });

  const bonesOf = (ch: ReturnType<typeof createCharacter>) => {
    const out: Record<string, THREE.Bone> = {};
    ch.root.traverse((o) => o instanceof THREE.Bone && (out[o.name] = o));
    return out;
  };
  const skinned = (o: THREE.Object3D) => meshesIn(o).filter((m): m is THREE.SkinnedMesh => m instanceof THREE.SkinnedMesh);

  it('the warrior wears the rigged knight, with the standard skeleton and parts', () => {
    const ch = createCharacter('warrior');
    assert.ok(skinned(ch.root).length >= 4, 'skinned parts');
    assert.deepEqual(Object.keys(ch.parts).sort(), ['back', 'shoulders']); // the helm is not a replaceable part
    const bones = bonesOf(ch);
    for (const n of ['root', 'hips', 'spine', 'chest', 'neck', 'head', 'shoulder_l', 'shoulder_r', 'upperarm_l', 'upperarm_r', 'forearm_l', 'forearm_r', 'hand_l', 'hand_r', 'thigh_l', 'thigh_r', 'shin_l', 'shin_r', 'foot_l', 'foot_r']) assert.ok(bones[n], `bone ${n}`);
    for (const m of skinned(ch.root)) assert.ok(ch.meshes.includes(m), 'every skinned mesh is pickable');
    const box = new THREE.Box3().setFromObject(ch.root);
    assert.ok(box.max.y > 1.9 && box.max.y < 2.6, `height ${box.max.y}`);
    assert.ok(Math.abs(box.min.y) < 0.1, `feet at the floor (${box.min.y})`);
  });

  it('units share geometry, materials and textures but own their skeleton', () => {
    const a = createCharacter('warrior');
    const b = createCharacter('warrior');
    const ma = skinned(a.root)[0];
    const mb = skinned(b.root).find((m) => m.name === ma.name)!;
    assert.equal(ma.geometry, mb.geometry);
    assert.equal(ma.material, mb.material);
    assert.notEqual(ma.skeleton, mb.skeleton);
    assert.notEqual(bonesOf(a).hips, bonesOf(b).hips);
    // a dye (or a hit flash) gives that one unit its own material, nobody else's
    const dyed = createCharacter('warrior', gearLook({ tint: 'dye_aurora' }));
    assert.notEqual(skinned(dyed.root)[0].material, ma.material);
    assert.equal(ma.material, mb.material);
  });

  it('a head cosmetic keeps the knight\'s helm (it is fitted on top); shoulders and back still replace their parts', () => {
    const plain = createCharacter('warrior');
    assert.equal(plain.parts.head, undefined, 'the helm is body geometry, not a replaceable part');
    const helmMeshes = (ch: ReturnType<typeof createCharacter>) => skinned(ch.root).filter((m) => m.name.startsWith('part_head'));
    assert.ok(helmMeshes(plain).length > 0);
    for (const item of itemsForSlot('head')) {
      const ch = createCharacter('warrior', gearLook({ head: item.id }));
      const helm = helmMeshes(ch);
      assert.equal(helm.length, helmMeshes(plain).length, `${item.id} keeps the helm`);
      for (const m of helm) assert.ok(ch.meshes.includes(m) && m.visible, 'helm stays pickable and visible');
    }
  });

  it('a cosmetic in shoulders/back removes that base part (unpickable), none keeps it', () => {
    for (const slot of REPLACEABLE_SLOTS.filter((s) => s !== 'head')) {
      const bare = createCharacter('warrior');
      assert.ok(bare.parts[slot]?.length, `${slot} part`);
      for (const part of bare.parts[slot]) {
        assert.ok(bare.root.getObjectById(part.id));
        assert.ok(skinned(part).length > 0, `${slot} is skinned geometry`);
        for (const m of skinned(part)) assert.ok(bare.meshes.includes(m));
      }
      for (const item of itemsForSlot(slot)) {
        const ch = createCharacter('warrior', gearLook({ [slot]: item.id }));
        for (const part of ch.parts[slot]) {
          assert.equal(ch.root.getObjectById(part.id), undefined, `${item.id} replaces the ${slot}`);
          for (const m of skinned(part)) assert.ok(!ch.meshes.includes(m), 'removed meshes are not pickable');
        }
        for (const other of REPLACEABLE_SLOTS.filter((s) => s !== slot && s !== 'head')) for (const part of ch.parts[other]) assert.ok(ch.root.getObjectById(part.id), `${other} stays`);
      }
    }
  });

  it('every cosmetic item can be worn on both rigged models and animates', () => {
    for (const model of ['knight', 'brute']) {
      globalThis.location = { search: `?warriormodel=${model}` } as unknown as Location;
      try {
        for (const item of COSMETICS.items) {
          const ch = createCharacter('warrior', gearLook({ [item.slot]: item.id }), 'dual');
          assert.ok(skinned(ch.root).length > 0, `${model} is skinned`);
          for (let i = 0; i < 3; i++) ch.pose({ phase: i, move: i % 2, casting: i === 2, time: i * 0.4, dt: 0.05 });
        }
      } finally {
        delete (globalThis as { location?: unknown }).location;
      }
    }
  });

  it('pose() moves the bones: legs differ between phases, arms rise when casting, flash and death work', () => {
    const ch = createCharacter('warrior');
    const bones = bonesOf(ch);
    const frame = (o: Partial<Parameters<typeof ch.pose>[0]>) => {
      for (let i = 0; i < 30; i++) ch.pose({ phase: 0, move: 0, casting: false, time: i / 30, dt: 1 / 30, ...o });
    };
    frame({ move: 1, phase: Math.PI / 2, vf: 6 });
    const a = bones.thigh_l.quaternion.clone();
    frame({ move: 1, phase: (3 * Math.PI) / 2, vf: 6 });
    const b = bones.thigh_l.quaternion.clone();
    assert.ok(a.angleTo(b) > 0.4, `thigh swings (${a.angleTo(b)})`);
    assert.ok(bones.thigh_l.quaternion.angleTo(bones.thigh_r.quaternion) > 0.2, 'legs are not locked together');
    frame({});
    const rest = bones.upperarm_r.quaternion.clone();
    frame({ casting: true });
    assert.ok(rest.angleTo(bones.upperarm_r.quaternion) > 0.8, 'arms rise to cast');
    ch.swing();
    ch.pose({ phase: 0, move: 0, casting: false, time: 3, dt: 0.1 });
    ch.flash();
    ch.pose({ phase: 0, move: 0, casting: false, time: 3.1, dt: 0.05 });
    ch.setState(false, false);
    frame({});
    assert.ok(Math.abs(ch.root.rotation.x + Math.PI / 2) < 1e-6, 'lies down when dead');
  });

  it('spec weapons attach to the hand bones (procedural stand-ins here: the weapon models are not loaded in this file; see weaponModels.test.ts)', () => {
    for (const weapon of ['dual', 'twohand', 'polearm', undefined]) {
      const ch = createCharacter('warrior', '', weapon);
      const bones = bonesOf(ch);
      const inHand = (o: THREE.Object3D) => {
        for (let p = o.parent; p; p = p.parent) if (p === bones.hand_r || p === bones.hand_l) return true;
        return false;
      };
      const weaponMeshes = ch.meshes.filter((m) => !(m instanceof THREE.SkinnedMesh));
      assert.ok(weaponMeshes.length > 0 && weaponMeshes.every(inHand), `${weapon ?? 'default'} weapon is held`);
    }
    // the brute alternative carries its own axe in the mesh: nothing extra is attached
    globalThis.location = { search: '?warriormodel=brute' } as unknown as Location;
    try {
      const brute = createCharacter('warrior', '', 'polearm');
      assert.equal(brute.meshes.filter((m) => !(m instanceof THREE.SkinnedMesh)).length, 0);
    } finally {
      delete (globalThis as { location?: unknown }).location;
    }
  });

  it('the polymorph sheep still swaps in and the brute alternative builds the same way', () => {
    assert.deepEqual(createSheep().parts, {});
    globalThis.location = { search: '?warriormodel=brute' } as unknown as Location;
    try {
      const ch = createCharacter('warrior', gearLook({ head: 'void_horns', shoulders: 'dragon_pauldrons' }), 'dual');
      assert.ok(skinned(ch.root).length >= 2, 'body and axe remain');
      assert.deepEqual(Object.keys(ch.parts).sort(), ['head', 'shoulders']); // no cape on the brute
      assert.equal(ch.root.getObjectById(createCharacter('warrior', '', 'dual').parts.head[0].id), undefined);
      const tris = skinned(createCharacter('warrior').root).reduce((n, m) => n + m.geometry.index!.count / 3, 0);
      assert.ok(tris < 15000, `${tris} triangles`);
    } finally {
      delete (globalThis as { location?: unknown }).location;
    }
  });

  it('falls back to the procedural warrior while no model is loaded', () => {
    forgetRiggedModels();
    const ch = createCharacter('warrior');
    assert.equal(skinned(ch.root).length, 0);
    assert.deepEqual(Object.keys(ch.parts).sort(), ['back', 'head', 'shoulders']);
    assert.ok(modelVersion() > 0);
  });
});
