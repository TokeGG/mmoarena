import { describe, it, before, after } from 'node:test';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CLASS_IDS, COSMETICS, gearLook, itemsForSlot } from '@arena/shared';
import { createCharacter } from '../src/models';
import { unpackModel } from '../src/modelPack';
import { registerRiggedModel, forgetRiggedModels, modelVersion } from '../src/riggedModels';
import { registerCapeModel, forgetCapeModel } from '../src/capeModels';
import { registerWingModel, forgetWingModel, wingAsset, wingStyleFor, wingModelVersion, WING_STYLE_IDS, DEFAULT_WING_FIT } from '../src/wingModels';
import { CREDITS } from '../src/credits';

const DIR = fileURLToPath(new URL('../public/models/', import.meta.url));
const load = (file: string) => unpackModel(new Uint8Array(readFileSync(DIR + file)));
const wingItems = itemsForSlot('wings');
const frame = { phase: 0, move: 0, casting: false, time: 0, dt: 1 / 30 };
type Ch = ReturnType<typeof createCharacter>;
const run = (ch: Ch, secs: number, o: Partial<Parameters<Ch['pose']>[0]> = {}) => {
  for (let i = 0; i < secs * 30; i++) ch.pose({ ...frame, time: i / 30, phase: i * 0.3, move: Math.min(1, Math.abs(o.vf ?? 0) / 7), ...o });
};
const wingGroup = (ch: Ch) => findGroup(ch.root, 'wings:');
const findGroup = (o: THREE.Object3D, prefix: string): THREE.Group | undefined => {
  let out: THREE.Group | undefined;
  o.traverse((x) => {
    if (!out && x instanceof THREE.Group && x.name.startsWith(prefix)) out = x;
  });
  return out;
};
const wingMeshes = (ch: Ch) => {
  const out: THREE.SkinnedMesh[] = [];
  ch.root.traverse((o) => o instanceof THREE.SkinnedMesh && o.name === 'wings' && out.push(o));
  return out;
};
const bone = (ch: Ch, name: string) => ch.root.getObjectByName(name) as THREE.Bone;

const g = globalThis as unknown as { createImageBitmap: unknown; self: unknown };
const realBitmap = g.createImageBitmap;
const realSelf = g.self;

describe('shared wing model', () => {
  before(async () => {
    g.self = g;
    g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
    await registerRiggedModel('knight', load('warrior.pak'));
    await registerRiggedModel('wizard', load('mage-wizard.pak'));
    await registerCapeModel(load('cape.pak'));
    await registerWingModel(load('wings.pak'));
  });
  after(() => {
    forgetWingModel();
    forgetCapeModel();
    forgetRiggedModels();
    g.createImageBitmap = realBitmap;
    g.self = realSelf;
  });

  it('loads from its pack: one skinned mesh, the seven wing bones, small, credited exactly as the file states', () => {
    const a = wingAsset()!;
    assert.ok(a, 'wing asset');
    let meshes = 0;
    const names = new Set<string>();
    a.scene.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) meshes++;
      if (o instanceof THREE.Bone) names.add(o.name);
    });
    assert.equal(meshes, 1);
    assert.deepEqual([...names].sort(), ['wing_L', 'wing_L_m', 'wing_L_t', 'wing_R', 'wing_R_m', 'wing_R_t', 'wing_root']);
    assert.ok(a.triangles > 5000 && a.triangles < 6500, `${a.triangles} triangles`);
    const size = statSync(DIR + 'wings.pak').size;
    assert.ok(size < 500 * 1024, `wings.pak is ${(size / 1024).toFixed(0)} KB`);
    assert.equal(a.credit.title, 'Angel wings');
    assert.equal(a.credit.author, 'sxnneh (https://sketchfab.com/Sxnneh)');
    assert.equal(a.credit.license, 'SKETCHFAB Standard (https://sketchfab.com/licenses)');
    assert.equal(a.credit.source, 'https://sketchfab.com/3d-models/angel-wings-a575b36467d840be84d8f91d5074d7d4');
    const c = CREDITS.find((x) => x.id === 'angel-wings')!;
    assert.ok(c, 'credited in the game');
    assert.equal(c.title, a.credit.title);
    assert.equal(c.author, a.credit.author);
    assert.equal(c.license, a.credit.license);
    assert.equal(c.url, a.credit.source);
    assert.match(c.note ?? '', /review before the Steam release/);
    // the wings are flat, centred, about 4 wide, and hang below the shoulder joint
    const box = new THREE.Box3().setFromObject(a.scene.getObjectByProperty('isSkinnedMesh', true)!);
    assert.ok(box.max.x - box.min.x > 3.8 && box.max.x - box.min.x < 4.2, `span ${box.max.x - box.min.x}`);
    assert.ok(Math.abs(box.max.x + box.min.x) < 0.1, 'symmetric');
    assert.ok(box.max.z - box.min.z < 0.4, 'flat');
  });

  it('the wing model counts as a loaded model: scenes rebuild their characters when it arrives', async () => {
    const was = modelVersion();
    const wasWing = wingModelVersion();
    await registerWingModel(load('wings.pak'));
    assert.ok(wingModelVersion() > wasWing);
    assert.ok(modelVersion() > was);
  });

  it('the catalog: every wing item has a described style, the owner ones their own look, and the looks differ', () => {
    assert.ok(wingItems.length >= 12);
    const seen = new Set<string>();
    for (const item of wingItems) {
      assert.ok(WING_STYLE_IDS.includes(item.style), `${item.id}: style ${item.style}`);
      const s = wingStyleFor(item);
      assert.equal(s.id, item.id);
      const key = JSON.stringify([s.ramp, s.tip, s.root, s.fx?.kind, s.disc?.kind, !!s.layer]);
      assert.ok(!seen.has(key), `${item.id} looks like another wing`);
      seen.add(key);
    }
    // the effects: every kind is used by some item
    const kinds = new Set(wingItems.map((i) => wingStyleFor(i).fx?.kind));
    for (const k of ['feathers', 'embers', 'frost', 'wisps', 'bolts', 'petals', 'stars']) assert.ok(kinds.has(k as never), `an item sheds ${k}`);
    assert.ok(wingItems.some((i) => wingStyleFor(i).layer), 'a second layer');
    assert.ok(wingItems.some((i) => wingStyleFor(i).disc?.kind === 'rays'), 'sun rays');
    // an unknown style still works (the plain look from the item's colour)
    assert.equal(wingStyleFor({ id: 'x', style: 'nope', color: '#336699' }).ramp[1], 0x336699);
  });

  it('every wing item can be worn on every class (rigged and procedural), animates and never produces NaN', () => {
    for (const cls of CLASS_IDS) {
      for (const item of wingItems) {
        const ch = createCharacter(cls, gearLook({ wings: item.id }), cls === 'mage' ? 'fire_staff' : cls === 'warrior' ? 'dual' : undefined);
        const meshes = wingMeshes(ch);
        assert.equal(meshes.length, wingStyleFor(item).layer ? 2 : 1, `${cls} ${item.id}`);
        for (const m of meshes) assert.ok(ch.meshes.includes(m), 'pickable like the rest of the body');
        run(ch, 0.5);
        run(ch, 0.5, { vf: 7 });
        run(ch, 0.5, { air: 1 });
        run(ch, 0.3, { casting: true });
        ch.setState(false, false);
        run(ch, 0.5, { dead: true } as never);
        ch.setState(true, true);
        run(ch, 0.2);
        ch.setState(true, false);
        for (const n of ['wing_L', 'wing_L_m', 'wing_L_t', 'wing_R', 'wing_R_m', 'wing_R_t']) {
          const q = bone(ch, n).quaternion;
          assert.ok(Number.isFinite(q.x + q.y + q.z + q.w) && Math.abs(q.length() - 1) < 1e-3, `${cls} ${item.id} ${n}`);
        }
      }
    }
  });

  it('wings sit behind a cape, flutter at rest, sweep back when running, beat in the air and fold when dead', () => {
    for (const cls of CLASS_IDS) {
      const weapon = cls === 'mage' ? 'fire_staff' : cls === 'warrior' ? 'dual' : undefined;
      const both = createCharacter(cls, gearLook({ wings: 'wings_angel', back: 'cloak_azure' }), weapon);
      const wing = findGroup(both.root, 'wings:')!;
      const cape = findGroup(both.root, 'cape:')!;
      assert.ok(wing && cape, `${cls}: both worn`);
      assert.ok(wing.position.z < cape.position.z - 0.03, `${cls}: wings (${wing.position.z.toFixed(2)}) are further back than the cape (${cape.position.z.toFixed(2)})`);
      assert.ok(wing.position.y > cape.position.y - 0.25, `${cls}: wings grow at the collar`);
    }
    const ch = createCharacter('rogue', gearLook({ wings: 'wings_phoenix' }));
    const angle = (n: string) => bone(ch, n).rotation.clone();
    run(ch, 1);
    const idle = angle('wing_L');
    run(ch, 1, { vf: 7 });
    const running = angle('wing_L');
    assert.ok(running.y > idle.y + 0.1, `swept back at speed (${idle.y.toFixed(2)} -> ${running.y.toFixed(2)})`);
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      run(ch, 1 / 30, { air: 1 });
      seen.push(bone(ch, 'wing_L').rotation.z);
    }
    assert.ok(Math.max(...seen) - Math.min(...seen) > 0.4, 'flaps while airborne');
    const rGood = bone(ch, 'wing_R').rotation;
    assert.ok(Math.sign(rGood.y) !== Math.sign(bone(ch, 'wing_L').rotation.y) || Math.abs(rGood.y) < 1e-6, 'the two wings mirror each other');
    run(ch, 1);
    const up = bone(ch, 'wing_L').rotation.z;
    ch.setState(false, false);
    run(ch, 1.2, { dead: true } as never);
    assert.ok(bone(ch, 'wing_L').rotation.z < up - 0.9, 'folds down when dead');
  });

  it('wings stay below head height on every class (they are never a wall above the head)', () => {
    for (const cls of CLASS_IDS) {
      const weapon = cls === 'mage' ? 'fire_staff' : cls === 'warrior' ? 'dual' : undefined;
      const base = createCharacter(cls, '', weapon);
      const baseTop = new THREE.Box3().setFromObject(base.root).max.y;
      for (const item of wingItems) {
        const ch = createCharacter(cls, gearLook({ wings: item.id }), weapon);
        ch.root.updateMatrixWorld(true);
        const top = new THREE.Box3().setFromObject(ch.root).max.y;
        assert.ok(top < baseTop + 0.3, `${cls} ${item.id}: top ${top.toFixed(2)} vs ${baseTop.toFixed(2)}`);
        const box = new THREE.Box3().setFromObject(wingGroup(ch) ?? ch.root);
        assert.ok(box.max.x - box.min.x < 3, `${cls} ${item.id}: ${(box.max.x - box.min.x).toFixed(2)} wide`);
      }
    }
  });

  it('a wing item does not take the back part away, and the default fit is sane', () => {
    const winged = createCharacter('warrior', gearLook({ wings: 'wings_angel' }), 'dual');
    assert.ok(winged.parts.back.length > 0);
    for (const part of winged.parts.back) assert.ok(winged.root.getObjectById(part.id), 'the coat stays under the wings');
    assert.ok(DEFAULT_WING_FIT.scale > 0.3 && DEFAULT_WING_FIT.scale < 0.8);
    assert.ok(COSMETICS.slots.some((s) => s.id === 'wings'));
  });
});

describe('wings before the model has loaded', () => {
  it('draw nothing and nothing breaks', () => {
    forgetWingModel();
    forgetRiggedModels();
    for (const cls of CLASS_IDS) for (const item of wingItems) {
      const ch = createCharacter(cls, gearLook({ wings: item.id }));
      assert.equal(wingMeshes(ch).length, 0);
      run(ch, 0.2, { vf: 7 });
    }
  });
});
