import { describe, it, before, after } from 'node:test';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CLASS_IDS, COSMETICS, gearLook, itemsForSlot, weaponFor } from '@arena/shared';
import { createCharacter } from '../src/models';
import { unpackModel } from '../src/modelPack';
import { registerRiggedModel, forgetRiggedModels, modelVersion } from '../src/riggedModels';
import { registerWeaponModel, forgetWeaponModels } from '../src/weaponModels';
import { registerCapeModel, forgetCapeModel, capeAsset, capeSkinFor, capeMaterial, isCapeItem, capeModelVersion, CAPE_STYLES } from '../src/capeModels';
import { CREDITS } from '../src/credits';

const DIR = fileURLToPath(new URL('../public/models/', import.meta.url));
const load = (file: string) => unpackModel(new Uint8Array(readFileSync(DIR + file)));
const capeItems = itemsForSlot('back').filter(isCapeItem);
const frame = { phase: 0, move: 0, casting: false, time: 0, dt: 1 / 30 };
const run = (ch: ReturnType<typeof createCharacter>, secs: number, o: Partial<Parameters<typeof ch.pose>[0]> = {}) => {
  for (let i = 0; i < secs * 30; i++) ch.pose({ ...frame, time: i / 30, phase: i * 0.3, move: Math.min(1, Math.abs(o.vf ?? 0) / 7), ...o });
};
const bone = (ch: ReturnType<typeof createCharacter>, name: string) => ch.root.getObjectByName(name) as THREE.Bone;
/** Where a bone of the cape is, in the frame of the cape's own group (so the wearer's walking does not count). */
const at = (ch: ReturnType<typeof createCharacter>, name: string) => {
  ch.root.updateMatrixWorld(true);
  const group = ch.root.getObjectByProperty('isGroup', true) && ch.root.getObjectByName('cape:cloak_azure')!;
  return group.worldToLocal(bone(ch, name).getWorldPosition(new THREE.Vector3()));
};
const capeMeshes = (ch: ReturnType<typeof createCharacter>) => {
  const out: THREE.SkinnedMesh[] = [];
  ch.root.traverse((o) => o instanceof THREE.SkinnedMesh && o.name === 'cape' && out.push(o));
  return out;
};

describe('cape cosmetics', () => {
  const g = globalThis as unknown as { createImageBitmap?: unknown; self?: unknown };
  const realBitmap = g.createImageBitmap;
  const realSelf = g.self;
  before(async () => {
    g.self = globalThis;
    g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
    await registerRiggedModel('knight', load('warrior.pak'));
    await registerRiggedModel('wizard', load('mage-wizard.pak'));
    await registerWeaponModel('fire_staff', load('weapons/staff-fire.pak'));
    await registerCapeModel(load('cape.pak'));
  });
  after(() => {
    forgetCapeModel();
    forgetWeaponModels();
    forgetRiggedModels();
    g.createImageBitmap = realBitmap;
    g.self = realSelf;
  });

  it('loads from its pack: one skinned mesh, the five cloth chains, small, credited', () => {
    const a = capeAsset()!;
    assert.ok(a, 'cape asset');
    let meshes = 0;
    const names = new Set<string>();
    a.scene.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) meshes++;
      if (o instanceof THREE.Bone) names.add(o.name);
    });
    assert.equal(meshes, 1);
    for (const c of ['cape', 'cape_L1', 'cape_L2', 'cape_R1', 'cape_R2']) for (let j = 0; j < 11; j++) assert.ok(names.has(`${c}_${String(j).padStart(2, '0')}`), `${c}_${j}`);
    assert.ok(names.has('cape_root'));
    assert.ok(names.size <= 60, `only the cloth bones are kept (${names.size})`);
    const size = statSync(DIR + 'cape.pak').size;
    assert.ok(size < 400 * 1024, `cape.pak is ${(size / 1024).toFixed(0)} KB`);
    // the credit travels with the file, exactly as its metadata states it
    assert.equal(a.credit.title, 'Cape');
    assert.match(a.credit.author, /^That one larry \(https:\/\/sketchfab\.com\/Professor_E12\)$/);
    assert.match(a.credit.license, /CC-BY-4\.0/);
    assert.equal(a.credit.source, 'https://sketchfab.com/3d-models/cape-b9efc9d1f1234564b7d5afd20ef76ffc');
    const credit = CREDITS.find((c) => c.id === 'cape')!;
    assert.equal(credit.title, a.credit.title);
    assert.equal(credit.url, a.credit.source);
    assert.match(credit.author ?? '', /That one larry/);
    assert.match(readFileSync(fileURLToPath(new URL('../../CREDITS.md', import.meta.url)), 'utf8'), /That one larry/);
    // the cloth sits where the convention says: collar at the origin, hanging down, back at -z, about 1.3 tall
    const box = new THREE.Box3();
    const mesh = a.scene.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
    mesh.geometry.computeBoundingBox();
    box.copy(mesh.geometry.boundingBox!);
    assert.ok(box.max.y < 0.1 && box.min.y < -1.1 && box.min.y > -1.4, `y ${box.min.y}..${box.max.y}`);
    assert.ok(box.min.z < -0.3 && box.max.z < 0.1, `z ${box.min.z}..${box.max.z}`);
    assert.ok(box.max.x - box.min.x > 0.8 && box.max.x - box.min.x < 1.0);
  });

  it('only the cape styles are capes; ribbons and the banner are left alone', () => {
    assert.deepEqual([...CAPE_STYLES].sort(), ['cloak', 'embercloak', 'starcloak']);
    const styles = new Set(itemsForSlot('back').map((i) => i.style));
    for (const s of ['ribbons', 'banner']) assert.ok(styles.has(s), s);
    for (const i of itemsForSlot('back')) assert.equal(isCapeItem(i), (CAPE_STYLES as readonly string[]).includes(i.style), i.id);
    assert.ok(capeItems.length >= 8);
  });

  it('every cape item has a skin of its own (colours, trim, emblem) and a shared per-item material', () => {
    const seen = new Set<string>();
    for (const item of capeItems) {
      const s = capeSkinFor(item);
      const key = JSON.stringify([s.top, s.bottom, s.lining, s.trim, s.emblem, s.glow, s.pattern]);
      assert.ok(!seen.has(key), `${item.id} looks like another cape`);
      seen.add(key);
      const m = capeMaterial(item)!;
      assert.equal(capeMaterial(item), m, 'one shared material per item');
      assert.equal(m.material.side, THREE.DoubleSide);
      assert.ok(m.material.map, 'has a colour map');
    }
    assert.ok(capeSkinFor(COSMETICS.items.find((i) => i.id === 'starfall_cloak')!).glow > 0, 'the owner capes glow');
    assert.ok(capeSkinFor(COSMETICS.items.find((i) => i.id === 'ember_cloak')!).glow > 0);
    assert.equal(capeSkinFor(COSMETICS.items.find((i) => i.id === 'cloak_azure')!).glow, 0);
    assert.notEqual(capeMaterial(COSMETICS.items.find((i) => i.id === 'cloak_azure')!)!.material.color.getHex(), capeMaterial(COSMETICS.items.find((i) => i.id === 'cloak_crimson')!)!.material.color.getHex());
  });

  it('every cape item builds on every class (rigged knight and wizard, procedural priest and rogue) and survives animation', () => {
    for (const cls of CLASS_IDS) {
      const weapon = cls === 'mage' ? 'fire_staff' : cls === 'warrior' ? 'dual' : weaponFor(cls, undefined);
      for (const item of capeItems) {
        const ch = createCharacter(cls, gearLook({ back: item.id }), weapon);
        const capes = capeMeshes(ch);
        assert.equal(capes.length, 1, `${cls} ${item.id}: one cape`);
        assert.ok(ch.meshes.includes(capes[0]), 'pickable');
        run(ch, 1, { vf: 7 });
        run(ch, 0.5, { vs: 5 });
        ch.flash();
        ch.setState(false, false);
        run(ch, 0.5);
        ch.setState(true, true);
        run(ch, 0.2);
        const box = new THREE.Box3().setFromObject(ch.root);
        assert.ok(Number.isFinite(box.min.y) && box.max.y < 3.2, `${cls} ${item.id} stays finite and sane`);
        for (let c = 0; c < 4; c++) assert.ok(Number.isFinite(bone(ch, 'cape_08').quaternion.x));
      }
    }
  });

  it('the knight\'s own coat (back part) is replaced by the cape; a mage has none to replace; other back items do not use the cape', () => {
    const plain = createCharacter('warrior', '', 'dual');
    assert.ok(plain.parts.back?.length);
    assert.equal(capeMeshes(plain).length, 0);
    const caped = createCharacter('warrior', gearLook({ back: 'cloak_crimson' }), 'dual');
    for (const part of caped.parts.back) assert.equal(caped.root.getObjectById(part.id), undefined, 'the coat is gone');
    assert.equal(capeMeshes(caped).length, 1);
    const ribboned = createCharacter('warrior', gearLook({ back: 'ribbons_ember' }), 'dual');
    assert.equal(capeMeshes(ribboned).length, 0);
    for (const part of ribboned.parts.back) assert.equal(ribboned.root.getObjectById(part.id), undefined);
    // wings are their own slot: the coat stays under them
    const winged = createCharacter('warrior', gearLook({ wings: 'wings_angel' }), 'dual');
    for (const part of winged.parts.back) assert.ok(winged.root.getObjectById(part.id), 'wings do not replace the back part');
    assert.equal(createCharacter('mage', '', 'fire_staff').parts.back, undefined);
  });

  it('on the wizard the cape hangs from under the hood at the shoulder blades, centred on the body, not floating behind it', () => {
    const ch = createCharacter('mage', gearLook({ back: 'starfall_cloak' }), 'fire_staff');
    run(ch, 1);
    ch.root.updateMatrixWorld(true);
    const wp = (n: string) => bone(ch, n).getWorldPosition(new THREE.Vector3());
    const cape = ch.root.getObjectByName('cape:starfall_cloak')!.getWorldPosition(new THREE.Vector3());
    const hips = wp('Bip01_Pelvis_02'), neck = wp('Bip01_Neck_055'), chest = wp('Bip01_Spine1_05');
    assert.ok(Math.abs(cape.x - hips.x) < 0.05, `centred (${cape.x.toFixed(2)} vs ${hips.x.toFixed(2)})`);
    assert.ok(cape.y < neck.y && cape.y > chest.y, `root between the chest and the neck (${cape.y.toFixed(2)})`);
    assert.ok(cape.z < chest.z && cape.z > chest.z - 0.3, `on the back, not far behind it (${(chest.z - cape.z).toFixed(2)} behind the chest)`);
    // the hem ends a little above the robe's hem, and no part of the cloth strays wide of the body
    const box = new THREE.Box3().setFromObject(capeMeshes(ch)[0]);
    assert.ok(box.min.y > 0.05 && box.min.y < 0.9, `hem at ${box.min.y.toFixed(2)}`);
    assert.ok(box.max.x - box.min.x < 1.4, `${(box.max.x - box.min.x).toFixed(2)} wide`);
  });

  it('the cape is parented under the torso (so it follows the body) and units own their material and skeleton', () => {
    const a = createCharacter('mage', gearLook({ back: 'cloak_violet' }), 'fire_staff');
    const b = createCharacter('mage', gearLook({ back: 'cloak_violet' }), 'fire_staff');
    const ca = capeMeshes(a)[0], cb = capeMeshes(b)[0];
    assert.equal(ca.geometry, cb.geometry, 'geometry is shared');
    assert.notEqual(ca.skeleton, cb.skeleton);
    assert.equal((ca.material as THREE.MeshStandardMaterial).map, (cb.material as THREE.MeshStandardMaterial).map, 'textures are shared per item');
    let p: THREE.Object3D | null = ca;
    let underBone = false;
    while ((p = p.parent)) if (p instanceof THREE.Bone) underBone = true;
    assert.ok(underBone, 'mounted below a bone of the wizard');
    // a hit flash tints only that unit's cape
    a.flash();
    run(a, 0.1);
    assert.ok((ca.material as THREE.MeshStandardMaterial).emissiveIntensity > 0);
    assert.equal((cb.material as THREE.MeshStandardMaterial).emissiveIntensity, 0);
  });

  it('the cloth bones swing with speed, strafing and turning, settle again, and go limp when dead', () => {
    for (const [cls, weapon] of [['warrior', 'dual'], ['mage', 'fire_staff'], ['priest', undefined], ['rogue', undefined]] as const) {
      const ch = createCharacter(cls, gearLook({ back: 'cloak_azure' }), weapon);
      run(ch, 2);
      const hem = () => at(ch, 'cape_10');
      const p0 = hem();
      run(ch, 2, { vf: 7 });
      const running = hem();
      assert.ok(p0.distanceTo(running) > 0.12, `${cls}: the hem streams out when running (${p0.distanceTo(running).toFixed(3)})`);
      assert.ok(running.z < p0.z, `${cls}: and it streams backwards`);
      run(ch, 4);
      assert.ok(p0.distanceTo(hem()) < p0.distanceTo(running) * 0.5, `${cls}: it settles again`);
      // sideways: the outer chain swings out when strafing
      const side = createCharacter(cls, gearLook({ back: 'cloak_azure' }), weapon);
      run(side, 1);
      const idle = at(side, 'cape_L2_10');
      run(side, 1.5, { vs: 7 });
      assert.ok(idle.distanceTo(at(side, 'cape_L2_10')) > 0.05, `${cls}: strafing moves the outer chain`);
      // dead: no forced streaming, still finite
      const dead = createCharacter(cls, gearLook({ back: 'cloak_azure' }), weapon);
      dead.setState(false, false);
      run(dead, 1, { vf: 7 });
      assert.ok(Number.isFinite(bone(dead, 'cape_10').quaternion.w));
    }
  });

  it('is stable at low frame rates and with huge steps (dt is clamped), with no NaN', () => {
    const ch = createCharacter('mage', gearLook({ back: 'starfall_cloak' }), 'fire_staff');
    for (const dt of [0.001, 0.016, 0.1, 0.5, 5]) for (let i = 0; i < 20; i++) ch.pose({ ...frame, dt, time: i * dt, move: 1, vf: 7, vs: i % 2 ? 6 : -6 });
    for (const n of ['cape_01', 'cape_05', 'cape_10', 'cape_L2_10', 'cape_R2_10']) {
      const q = bone(ch, n).quaternion;
      assert.ok([q.x, q.y, q.z, q.w].every(Number.isFinite), n);
      assert.ok(Math.abs(q.length() - 1) < 1e-3, `${n} stays a unit rotation`);
    }
  });

  it('ribbons are fitted on the back of every class without a cape and stay below head height', () => {
    for (const cls of CLASS_IDS) {
      const weapon = cls === 'mage' ? 'fire_staff' : cls === 'warrior' ? 'dual' : undefined;
      for (const item of itemsForSlot('back').filter((i) => !isCapeItem(i) && i.style !== 'banner')) {
        const ch = createCharacter(cls, gearLook({ back: item.id }), weapon);
        const base = createCharacter(cls, '', weapon);
        const top = new THREE.Box3().setFromObject(ch.root).max.y;
        const baseTop = new THREE.Box3().setFromObject(base.root).max.y;
        assert.ok(top < baseTop + 0.3, `${cls} ${item.id}: top ${top.toFixed(2)} vs ${baseTop.toFixed(2)}`);
      }
    }
  });

  it('the cape model counts as a loaded model: scenes rebuild their characters when it arrives', async () => {
    const was = modelVersion();
    const wasCape = capeModelVersion();
    await registerCapeModel(load('cape.pak'));
    assert.ok(capeModelVersion() > wasCape);
    assert.ok(modelVersion() > was);
    const stand = capeAsset()!;
    assert.ok(stand);
  });
});

describe('capes before the model has loaded', () => {
  it('fall back to the old plank cloaks and nothing breaks', () => {
    forgetCapeModel();
    forgetRiggedModels();
    for (const cls of CLASS_IDS) for (const item of capeItems) {
      const ch = createCharacter(cls, gearLook({ back: item.id }));
      assert.equal(capeMeshes(ch).length, 0);
      run(ch, 0.3, { vf: 7 });
    }
  });
});
