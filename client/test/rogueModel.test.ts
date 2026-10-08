import { describe, it, before, after } from 'node:test';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { COSMETICS, SPECS, weaponFor, gearLook } from '@arena/shared';
import { createCharacter } from '../src/models';
import { unpackModel } from '../src/modelPack';
import { registerRiggedModel, forgetRiggedModels, riggedAssetFor } from '../src/riggedModels';
import { registerWeaponModel, forgetWeaponModels, WEAPONS } from '../src/weaponModels';
import { CREDITS } from '../src/credits';

const DIR = fileURLToPath(new URL('../public/models/', import.meta.url));
const load = (file: string) => unpackModel(new Uint8Array(readFileSync(DIR + file)));
const frame = { phase: 0, move: 0, casting: false, time: 0, dt: 1 / 30 };
const run = (ch: ReturnType<typeof createCharacter>, secs: number, o: Partial<Parameters<typeof ch.pose>[0]> = {}) => {
  for (let i = 0; i < secs * 30; i++) ch.pose({ ...frame, time: i / 30, ...o });
};
const bonesOf = (ch: ReturnType<typeof createCharacter>) => {
  const out: Record<string, THREE.Bone> = {};
  ch.root.traverse((o) => o instanceof THREE.Bone && (out[o.name] = o));
  return out;
};
const triangles = (o: THREE.Object3D) => {
  let n = 0;
  o.traverse((c) => c instanceof THREE.Mesh && (n += (c.geometry.index ? c.geometry.index.count : c.geometry.attributes.position.count) / 3));
  return n;
};

describe('rogue specs', () => {
  it('every rogue spec holds the twin daggers (the rig draws them in both hands)', () => {
    assert.equal(SPECS.rogue.length, 3);
    for (const s of SPECS.rogue) assert.deepEqual(s.weapon, { id: 'daggers', name: 'Twin Daggers' }, s.id);
    assert.ok(WEAPONS.daggers.left?.mirror, 'the off-hand dagger is a mirrored copy');
    assert.equal(WEAPONS.daggers.right.part, WEAPONS.daggers.left!.part);
  });
});

describe('rogue assassin model and daggers', () => {
  const g = globalThis as unknown as { createImageBitmap?: unknown; self?: unknown };
  const realBitmap = g.createImageBitmap;
  const realSelf = g.self;
  before(async () => {
    g.self = globalThis;
    g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
    await registerRiggedModel('assassin', load('rogue.pak'));
    await registerWeaponModel('daggers', load('weapons/dagger.pak'));
  });
  after(() => {
    forgetWeaponModels();
    forgetRiggedModels();
    g.createImageBitmap = realBitmap;
    g.self = realSelf;
  });

  it('loads from its pack within budget, with the standard skeleton and part names', () => {
    const asset = riggedAssetFor('rogue', 'daggers')!;
    assert.ok(asset, 'the rogue has a model');
    assert.ok(asset.meta.height >= 2.0 && asset.meta.height <= 2.4, `height ${asset.meta.height}`);
    assert.ok(triangles(asset.scene) >= 8000 && triangles(asset.scene) <= 16000, `triangles ${triangles(asset.scene)}`);
    assert.ok(statSync(DIR + 'rogue.pak').size < 2_500_000, 'pack size');
    const ch = createCharacter('rogue', '', 'daggers');
    const bones = bonesOf(ch);
    for (const n of ['hips', 'chest', 'head', 'upperarm_l', 'hand_r', 'thigh_l', 'foot_r']) assert.ok(bones[n], n);
    assert.deepEqual(Object.keys(ch.parts).sort(), ['back']);
  });

  it('holds one dagger in each hand, the off hand mirrored', () => {
    const ch = createCharacter('rogue', '', 'daggers');
    const pivots: THREE.Object3D[] = [];
    ch.root.traverse((o) => o.name === 'weapon:dagger' && pivots.push(o));
    assert.equal(pivots.length, 2);
    assert.deepEqual(pivots.map((p) => p.children[0].scale.z).sort(), [-1, 1]);
    assert.notEqual(pivots[0].parent, pivots[1].parent, 'one per hand');
  });

  it('walks, strikes with both hands in turn, dies and wears every cosmetic', () => {
    const ch = createCharacter('rogue', '', 'daggers');
    const bones = bonesOf(ch);
    run(ch, 1, { move: 1, phase: Math.PI / 2, vf: 6 });
    const a = bones.thigh_l.quaternion.clone();
    run(ch, 1, { move: 1, phase: (3 * Math.PI) / 2, vf: 6 });
    assert.ok(a.angleTo(bones.thigh_l.quaternion) > 0.4, 'legs swing');
    run(ch, 1);
    const rest = [bones.upperarm_r.quaternion.clone(), bones.upperarm_l.quaternion.clone()];
    const lead: number[] = [];
    for (let k = 0; k < 2; k++) {
      ch.swing();
      let r = 0, l = 0;
      for (let i = 0; i < 8; i++) {
        ch.pose({ ...frame, time: 5 + k + i / 30 });
        r = Math.max(r, rest[0].angleTo(bones.upperarm_r.quaternion));
        l = Math.max(l, rest[1].angleTo(bones.upperarm_l.quaternion));
      }
      lead.push(r - l);
      run(ch, 1);
    }
    assert.ok(lead[0] * lead[1] < 0, `the two strikes use different hands (${lead})`);
    for (const item of COSMETICS.items) {
      const w = createCharacter('rogue', gearLook({ [item.slot]: item.id }), weaponFor('rogue', 'combat'));
      run(w, 0.3, { move: 1, vf: 5 });
    }
    ch.setState(false, false);
    run(ch, 2, { dead: true } as never);
  });

  it('a back cosmetic replaces the body part, the hood stays under head items', () => {
    const base = createCharacter('rogue', '', 'daggers');
    const helm = createCharacter('rogue', gearLook({ head: 'helm_steel' }), 'daggers');
    assert.ok(!helm.parts.head, 'the hood is plain body geometry');
    for (const slot of ['back'] as const) {
      const item = COSMETICS.items.find((i) => i.slot === slot)!;
      const ch = createCharacter('rogue', gearLook({ [slot]: item.id }), 'daggers');
      for (const part of ch.parts[slot]) assert.ok(!ch.root.getObjectById(part.id), `${slot} body part removed`);
      for (const part of base.parts[slot]) assert.ok(base.root.getObjectById(part.id));
    }
  });

  it('dyes tint the body (its texture is bright enough to show a dye)', () => {
    const plain = createCharacter('rogue', '', 'daggers');
    const dyed = createCharacter('rogue', gearLook({ tint: 'dye_crimson' }), 'daggers');
    const dyes = (c: ReturnType<typeof createCharacter>) => {
      let n = 0;
      c.root.traverse((o) => o instanceof THREE.SkinnedMesh && (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: THREE.Material) => m.userData.dye && n++));
      return n;
    };
    assert.equal(dyes(plain), 0);
    assert.ok(dyes(dyed) > 0);
  });

  it('is credited with the authors the files name', () => {
    const by = (id: string) => CREDITS.find((c) => c.id === id)!;
    assert.equal(by('hooded-assassin').author, 'iRahulRajput');
    assert.equal(by('hooded-assassin').title, 'Hooded Shadow Assassin');
    assert.equal(by('twin-daggers').author, 'RickLop');
    assert.match(by('twin-daggers').license, /CC BY/i);
  });
});
