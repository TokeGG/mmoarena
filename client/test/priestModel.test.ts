import { describe, it, before, after } from 'node:test';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { COSMETICS, SPECS, gearLook } from '@arena/shared';
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
const STAFFS: Record<string, string> = { holy_staff: 'weapons/staff-holy.pak', necro_staff: 'weapons/staff-necro.pak' };

describe('priest specs', () => {
  it('Warden and Lightbearer carry the holy staff, Gloomweaver the necrotic staff', () => {
    assert.deepEqual(SPECS.priest.map((s) => s.id), ['discipline', 'holy', 'shadow']);
    assert.deepEqual(SPECS.priest.map((s) => s.weapon?.id), ['holy_staff', 'holy_staff', 'necro_staff']);
    for (const s of SPECS.priest) assert.ok(WEAPONS[s.weapon!.id], s.id);
  });
});

describe('priest sentinel model and staffs', () => {
  const g = globalThis as unknown as { createImageBitmap?: unknown; self?: unknown };
  const realBitmap = g.createImageBitmap;
  const realSelf = g.self;
  before(async () => {
    g.self = globalThis;
    g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
    await registerRiggedModel('sentinel', load('priest.pak'));
    for (const [id, file] of Object.entries(STAFFS)) await registerWeaponModel(id, load(file));
  });
  after(() => {
    forgetWeaponModels();
    forgetRiggedModels();
    g.createImageBitmap = realBitmap;
    g.self = realSelf;
  });

  it('loads from its pack within budget, with the standard skeleton and part names', () => {
    const asset = riggedAssetFor('priest', 'holy_staff')!;
    assert.ok(asset, 'the priest has a model');
    assert.ok(asset.meta.height >= 2.0 && asset.meta.height <= 2.4, `height ${asset.meta.height}`);
    assert.ok(triangles(asset.scene) >= 8000 && triangles(asset.scene) <= 16000, `triangles ${triangles(asset.scene)}`);
    assert.ok(statSync(DIR + 'priest.pak').size < 2_500_000, 'pack size');
    const ch = createCharacter('priest', '', 'holy_staff');
    const bones = bonesOf(ch);
    for (const n of ['hips', 'chest', 'head', 'upperarm_l', 'hand_r', 'thigh_l', 'foot_r']) assert.ok(bones[n], n);
    assert.deepEqual(Object.keys(ch.parts).sort(), ['back']);
  });

  it('the staffs are small and held by the right hand, the shaft through the grip point', () => {
    for (const [id, file] of Object.entries(STAFFS)) {
      assert.ok(statSync(DIR + file).size < 600_000, `${file} size`);
      assert.equal(WEAPONS[id].right.part, 'staff');
      assert.equal(WEAPONS[id].right.pos, undefined, 'no sideways offset: the shaft is the grip point');
      const ch = createCharacter('priest', '', id);
      const pivots: THREE.Object3D[] = [];
      ch.root.traverse((o) => o.name === 'weapon:staff' && pivots.push(o));
      assert.equal(pivots.length, 1, id);
      assert.ok(triangles(pivots[0]) < 10000, `${id} triangles`);
    }
  });

  it('walks, casts with the staff raised, swings, dies and wears every cosmetic', () => {
    const ch = createCharacter('priest', '', 'necro_staff');
    const bones = bonesOf(ch);
    run(ch, 1, { move: 1, phase: Math.PI / 2, vf: 6 });
    const a = bones.thigh_l.quaternion.clone();
    run(ch, 1, { move: 1, phase: (3 * Math.PI) / 2, vf: 6 });
    assert.ok(a.angleTo(bones.thigh_l.quaternion) > 0.2, 'legs swing');
    run(ch, 1);
    const rest = bones.upperarm_r.quaternion.clone();
    run(ch, 1, { casting: true });
    assert.ok(rest.angleTo(bones.upperarm_r.quaternion) > 0.05, 'the staff arm lifts in a cast');
    run(ch, 1);
    ch.swing();
    let r = 0;
    for (let i = 0; i < 8; i++) {
      ch.pose({ ...frame, time: 9 + i / 30 });
      r = Math.max(r, rest.angleTo(bones.upperarm_r.quaternion));
    }
    assert.ok(r > 0.3, 'the staff arm swings');
    for (const item of COSMETICS.items) {
      const w = createCharacter('priest', gearLook({ [item.slot]: item.id }), 'holy_staff');
      run(w, 0.3, { move: 1, vf: 5 });
    }
    ch.setState(false, false);
    run(ch, 2, { dead: true } as never);
  });

  it('a back cosmetic replaces the body part, the helm stays under head items', () => {
    const base = createCharacter('priest', '', 'holy_staff');
    const helm = createCharacter('priest', gearLook({ head: 'helm_steel' }), 'holy_staff');
    assert.ok(!helm.parts.head, 'the helm is plain body geometry');
    for (const slot of ['back'] as const) {
      const item = COSMETICS.items.find((i) => i.slot === slot)!;
      const ch = createCharacter('priest', gearLook({ [slot]: item.id }), 'holy_staff');
      for (const part of ch.parts[slot]) assert.ok(!ch.root.getObjectById(part.id), `${slot} body part removed`);
      for (const part of base.parts[slot]) assert.ok(base.root.getObjectById(part.id));
    }
  });

  it('dyes tint the body (its texture is bright enough to show a dye)', () => {
    const plain = createCharacter('priest', '', 'holy_staff');
    const dyed = createCharacter('priest', gearLook({ tint: 'dye_crimson' }), 'holy_staff');
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
    assert.equal(by('abyssal-sentinel').author, 'Rignu');
    assert.equal(by('abyssal-sentinel').title, 'Abyssal Sentinel Gizurr');
    assert.equal(by('holy-staff').author, '3DMode');
    assert.equal(by('necro-staff').author, 'suddel');
    for (const id of ['abyssal-sentinel', 'holy-staff', 'necro-staff']) assert.match(by(id).license, /CC BY/i);
  });
});
