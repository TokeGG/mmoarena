import { describe, it, before, after } from 'node:test';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { COSMETICS, SPECS, weaponFor, gearLook, CLASS_IDS } from '@arena/shared';
import { createCharacter } from '../src/models';
import { unpackModel } from '../src/modelPack';
import { registerRiggedModel, forgetRiggedModels, riggedAssetFor } from '../src/riggedModels';
import { registerWeaponModel, forgetWeaponModels, WEAPONS } from '../src/weaponModels';
import type { ClipAnimator } from '../src/riggedClips';

const DIR = fileURLToPath(new URL('../public/models/', import.meta.url));
const load = (file: string) => unpackModel(new Uint8Array(readFileSync(DIR + file)));
const STAFFS: Record<string, string> = { fire_staff: 'weapons/staff-fire.pak', ice_staff: 'weapons/staff-ice.pak', arcane_staff: 'weapons/staff-arcane.pak' };
const SPEC_STAFF: Record<string, string> = { fire: 'fire_staff', frost: 'ice_staff', arcane: 'arcane_staff' };
const frame = { phase: 0, move: 0, casting: false, time: 0, dt: 1 / 30 };
const run = (ch: ReturnType<typeof createCharacter>, secs: number, o: Partial<Parameters<typeof ch.pose>[0]> & { vf?: number } = {}) => {
  for (let i = 0; i < secs * 30; i++) ch.pose({ ...frame, time: i / 30, move: Math.min(1, Math.abs(o.vf ?? 0) / 7), ...o });
};
const driver = (ch: ReturnType<typeof createCharacter>) => ch.root.getObjectByName('rigged')!.userData.driver as ClipAnimator;
const bonesOf = (ch: ReturnType<typeof createCharacter>) => {
  const out: Record<string, THREE.Bone> = {};
  ch.root.traverse((o) => o instanceof THREE.Bone && (out[o.name] = o));
  return out;
};

describe('procedural mage (the model not loaded)', () => {
  it('is the fallback: a built-in head part, no cast animation', () => {
    forgetRiggedModels();
    assert.equal(riggedAssetFor('mage', 'fire_staff'), undefined);
    const ch = createCharacter('mage', '', 'fire_staff');
    assert.deepEqual(Object.keys(ch.parts).sort(), ['head']);
    assert.equal(ch.cast, undefined);
    ch.pose({ ...frame, vf: 0, vs: 0 });
  });
});

describe('mage wizard model', () => {
  const g = globalThis as unknown as { createImageBitmap?: unknown; self?: unknown };
  const realBitmap = g.createImageBitmap;
  const realSelf = g.self;
  before(async () => {
    g.self = globalThis;
    g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
    await registerRiggedModel('wizard', load('mage-wizard.pak'));
    for (const [id, file] of Object.entries(STAFFS)) await registerWeaponModel(id, load(file));
  });
  after(() => {
    forgetWeaponModels();
    forgetRiggedModels();
    g.createImageBitmap = realBitmap;
    g.self = realSelf;
  });

  it('loads from its pack with the five clips, the credit and a sensible height', () => {
    const asset = riggedAssetFor('mage')!;
    assert.ok(asset, 'the mage has a model');
    assert.deepEqual(asset.clips!.map((c) => c.name).sort(), ['attack', 'death', 'idle', 'run', 'walk']);
    assert.ok(asset.meta.height >= 1.9 && asset.meta.height <= 2.6, `height ${asset.meta.height}`);
    const box = new THREE.Box3();
    const ch = createCharacter('mage', '', 'fire_staff');
    ch.root.updateMatrixWorld(true);
    ch.root.traverse((o) => o instanceof THREE.Bone && box.expandByPoint(o.getWorldPosition(new THREE.Vector3())));
    assert.ok(box.min.y > -0.2 && box.min.y < 0.4, 'stands on the ground');
    assert.ok(box.max.y > 1.5 && box.max.y < 2.4, `head bone at ${box.max.y}`);
    // the credit travels with the file
    const raw = Buffer.from(load('mage-wizard.pak'));
    const json = JSON.parse(raw.subarray(20, 20 + raw.readUInt32LE(12)).toString('utf8'));
    assert.match(json.asset.extras.author, /JuanCarlosOsanteHernandez/);
    assert.match(json.asset.extras.license, /CC-BY-4\.0/);
  });

  it('every mage spec has its own staff id and holds that staff in the right hand bone', () => {
    const seen = new Set<string>();
    for (const spec of SPECS.mage) {
      const id = weaponFor('mage', spec.id);
      assert.equal(id, SPEC_STAFF[spec.id], spec.id);
      const ch = createCharacter('mage', '', id);
      const bones = bonesOf(ch);
      const held = ch.meshes.filter((m) => !(m instanceof THREE.SkinnedMesh) && (m.material as THREE.MeshStandardMaterial).map);
      assert.ok(held.length > 0, `${spec.id} staff`);
      for (const m of held) {
        let p: THREE.Object3D | null = m;
        while (p && p !== bones.Bip01_R_Hand_09) p = p.parent;
        assert.ok(p, `${spec.id}: staff follows the right hand bone`);
      }
      seen.add((held[0].material as THREE.MeshStandardMaterial).map!.uuid ? id! : '');
    }
    assert.equal(seen.size, 3);
    for (const id of Object.keys(STAFFS)) assert.ok(WEAPONS[id].look, `${id} look`);
  });

  it('plays the right clip: idle standing, walk and run by speed, the death clip when dead', () => {
    const ch = createCharacter('mage', '', 'fire_staff');
    run(ch, 1);
    assert.ok(driver(ch).state().idle > 0.99);
    run(ch, 1, { vf: 3, vs: 0 });
    assert.ok(driver(ch).state().walk > 0.95, JSON.stringify(driver(ch).state()));
    run(ch, 1, { vf: 7, vs: 0 });
    assert.ok(driver(ch).state().run > 0.95);
    run(ch, 1, { vf: -3, vs: 0 }); // backing up
    assert.ok(driver(ch).state().walk > 0.95);
    ch.setState(false, false);
    run(ch, 2.5);
    const s = driver(ch).state();
    assert.ok(s.death > 0.99 && s.fall === 1, JSON.stringify(s));
    assert.equal(ch.root.rotation.x, 0, 'the clip model is not laid flat by the Character');
    ch.setState(true, false);
    run(ch, 1);
    assert.ok(driver(ch).state().idle > 0.99);
  });

  it('swings and casts play the attack clip; a long cast winds up and holds', () => {
    const ch = createCharacter('mage', '', 'ice_staff');
    assert.ok(ch.cast, 'clip models cast');
    run(ch, 0.5);
    ch.cast!();
    run(ch, 0.3);
    assert.ok(driver(ch).state().attack > 0.5 && driver(ch).state().phase === 'full');
    run(ch, 2);
    assert.equal(driver(ch).state().phase, 'none');
    run(ch, 1.0, { casting: true });
    assert.equal(driver(ch).state().phase, 'hold');
    run(ch, 0.1);
    assert.equal(driver(ch).state().phase, 'release');
    ch.swing();
    run(ch, 0.2);
  });

  it('hit flash, stealth and the dead tint still work', () => {
    const ch = createCharacter('mage', '', 'arcane_staff');
    ch.flash();
    run(ch, 0.1);
    ch.setState(true, true);
    ch.setState(false, false);
    run(ch, 0.2);
    ch.setState(true, false);
    run(ch, 0.2);
    for (const m of ch.meshes) if (m instanceof THREE.SkinnedMesh) assert.ok(!Array.isArray(m.material));
  });

  it('stands upright and on its own origin: the idle clip\'s stoop is countered, the body is centred', () => {
    const wp = (ch: ReturnType<typeof createCharacter>, n: string) => bonesOf(ch)[n].getWorldPosition(new THREE.Vector3());
    const pitch = (ch: ReturnType<typeof createCharacter>) => {
      ch.root.updateMatrixWorld(true);
      const out: Record<string, number> = {};
      for (const n of ['Bip01_Spine1_05', 'Bip01_Neck_055', 'Bip01_Head_056']) {
        const q = bonesOf(ch)[n].getWorldQuaternion(new THREE.Quaternion());
        out[n] = Math.atan2(new THREE.Vector3(0, 1, 0).applyQuaternion(q).z, new THREE.Vector3(0, 1, 0).applyQuaternion(q).y);
      }
      return out;
    };
    const ch = createCharacter('mage', '', 'fire_staff');
    run(ch, 1);
    ch.root.updateMatrixWorld(true);
    const hips = wp(ch, 'Bip01_Pelvis_02'), head = wp(ch, 'Bip01_Head_056');
    assert.ok(Math.abs(hips.x) < 0.04, `the hips are over the unit's origin (x ${hips.x.toFixed(2)})`);
    const lean = Math.atan2(head.z - hips.z, head.y - hips.y) * (180 / Math.PI);
    assert.ok(Math.abs(lean) < 6, `head over the hips (${lean.toFixed(1)} degrees)`);
    // the correction tips chest, neck and head forward against the bare clip, and a run keeps only part of it
    const withFix = pitch(ch);
    const d = driver(ch) as unknown as { o: { posture: object } };
    const saved = d.o.posture;
    d.o.posture = {};
    run(ch, 0.1);
    const bare = pitch(ch);
    d.o.posture = saved;
    for (const n of Object.keys(bare)) assert.ok(withFix[n] > bare[n] + 0.05, `${n} is tipped forward (${bare[n].toFixed(2)} -> ${withFix[n].toFixed(2)})`);
    run(ch, 0.1);
    // the staff stays in the closed fist while the spine is corrected, in idle and in a cast
    const staff = ch.meshes.find((m) => !(m instanceof THREE.SkinnedMesh) && (m.material as THREE.MeshStandardMaterial).map)!;
    const grip = (c: typeof ch) => {
      c.root.updateMatrixWorld(true);
      return staff.getWorldPosition(new THREE.Vector3()).distanceTo(wp(c, 'Bip01_R_Hand_09'));
    };
    assert.ok(grip(ch) < 0.35, `staff at the hand (${grip(ch).toFixed(2)})`);
    ch.cast!();
    run(ch, 0.4);
    assert.ok(grip(ch) < 0.35, 'and in a cast');
  });

  it('the three specs tint the robe differently and leave skin alone', () => {
    const tints = new Map<string, string>();
    for (const spec of ['fire', 'frost', 'arcane']) {
      const ch = createCharacter('mage', '', weaponFor('mage', spec));
      const robes = ch.meshes.filter((m) => m.name.endsWith('__robe')) as THREE.SkinnedMesh[];
      assert.equal(robes.length, 1);
      const dye = (robes[0].material as THREE.Material).userData.dye;
      assert.ok(dye, `${spec} robe has a tint`);
      tints.set(spec, dye.uDye.value.getHexString());
      assert.ok(dye.uGlyph.value.r + dye.uGlyph.value.g + dye.uGlyph.value.b > 0, 'the trim glows');
      for (const m of ch.meshes.filter((x) => /__(head|hands|beard)$/.test(x.name))) assert.ok(!(m.material as THREE.Material).userData.dye, `${m.name} untinted`);
    }
    assert.equal(new Set(tints.values()).size, 3);
  });

  it('every cosmetic can be worn on top of the wizard and animates (no base part is taken away)', () => {
    for (const item of COSMETICS.items) {
      const ch = createCharacter('mage', gearLook({ [item.slot]: item.id }), 'fire_staff');
      assert.deepEqual(Object.keys(ch.parts), [], 'the wizard has no replaceable parts');
      run(ch, 0.2, { vf: 4 });
      ch.cast!();
      run(ch, 0.2);
      ch.setState(false, false);
      run(ch, 0.1);
    }
    // a dye reaches the robe, not the face
    const ch = createCharacter('mage', gearLook({ tint: 'midas' }), 'ice_staff');
    const robe = ch.meshes.find((m) => m.name.endsWith('__robe'))!;
    const head = ch.meshes.find((m) => m.name.endsWith('__head'))!;
    assert.equal((robe.material as THREE.Material).userData.dye.uK.value > 0.9, true);
    assert.ok(!(head.material as THREE.Material).userData.dye);
  });

  it('other classes are unaffected', () => {
    for (const cls of CLASS_IDS.filter((c) => c !== 'mage')) createCharacter(cls).pose({ ...frame, vf: 0, vs: 0 });
  });
});

describe('model files', () => {
  it('stay within budget and are only served packed', () => {
    const size = (f: string) => statSync(DIR + f).size;
    assert.ok(size('mage-wizard.pak') < 2.5 * 1024 * 1024, 'wizard < 2.5 MB');
    for (const f of Object.values(STAFFS)) assert.ok(size(f) < 700 * 1024, `${f} < 700 KB`);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d + e.name + '/') : [d + e.name]));
    assert.deepEqual(walk(DIR).filter((f) => f.endsWith('.glb')), []);
  });
});
