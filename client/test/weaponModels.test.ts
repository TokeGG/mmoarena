import { describe, it, before, after } from 'node:test';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { COSMETICS, gearLook } from '@arena/shared';
import { createCharacter } from '../src/models';
import { packModel, unpackModel } from '../src/modelPack';
import { registerRiggedModel, forgetRiggedModels, modelVersion } from '../src/riggedModels';
import { registerWeaponModel, forgetWeaponModels, WEAPONS } from '../src/weaponModels';

const DIR = fileURLToPath(new URL('../public/models/', import.meta.url));
const load = (file: string) => unpackModel(new Uint8Array(readFileSync(DIR + file.replace(/\.glb$/, '.pak'))));
const WARRIOR_WEAPONS = ['dual', 'twohand', 'polearm']; // the mage staffs are tested in mageModel.test.ts
const WEAPON_FILES: Record<string, string> = { dual: 'weapons/saber-dual.glb', twohand: 'weapons/greatsword.glb', polearm: 'weapons/polearm.glb' };

describe('real weapon models', () => {
  const g = globalThis as unknown as { createImageBitmap?: unknown; self?: unknown };
  const realBitmap = g.createImageBitmap;
  const realSelf = g.self;
  before(async () => {
    g.self = globalThis;
    g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
    await registerRiggedModel('knight', load('warrior.glb'));
    for (const [id, file] of Object.entries(WEAPON_FILES)) await registerWeaponModel(id, load(file));
  });
  after(() => {
    forgetWeaponModels();
    forgetRiggedModels();
    g.createImageBitmap = realBitmap;
    g.self = realSelf;
  });

  const bonesOf = (ch: ReturnType<typeof createCharacter>) => {
    const out: Record<string, THREE.Bone> = {};
    ch.root.traverse((o) => o instanceof THREE.Bone && (out[o.name] = o));
    return out;
  };
  const held = (ch: ReturnType<typeof createCharacter>) => ch.meshes.filter((m) => !(m instanceof THREE.SkinnedMesh));
  const handOf = (o: THREE.Object3D, bones: Record<string, THREE.Bone>) => {
    for (let p = o.parent; p; p = p.parent) {
      if (p === bones.hand_r) return 'r';
      if (p === bones.hand_l) return 'l';
    }
    return null;
  };

  it('every warrior spec holds its own model: sabers in both hands, the others in the right hand with both arms on it', () => {
    for (const weapon of WARRIOR_WEAPONS) {
      const ch = createCharacter('warrior', '', weapon);
      const bones = bonesOf(ch);
      const meshes = held(ch);
      assert.ok(meshes.length > 0, `${weapon} is attached`);
      const hands = new Set(meshes.map((m) => handOf(m, bones)));
      assert.ok(!hands.has(null), `${weapon} follows a hand bone`);
      assert.deepEqual([...hands].sort(), weapon === 'dual' ? ['l', 'r'] : ['r'], `${weapon} hands`);
      // nothing of the procedural weapon is left: every held mesh carries a texture from the GLB
      for (const m of meshes) assert.ok((m.material as THREE.MeshStandardMaterial).map, `${weapon} uses the GLB material`);
    }
    // two-handers: the off arm is raised onto the weapon, unlike with the sabers
    const rest = createCharacter('warrior', '', 'dual');
    const axe = createCharacter('warrior', '', 'polearm');
    for (const ch of [rest, axe]) for (let i = 0; i < 40; i++) ch.pose({ phase: 0, move: 0, casting: false, time: i * 0.05, dt: 0.05 });
    // (the polearm's left arm stays in front of the shoulder, so the shoulder turns less than the bent elbow: see the hold comment in weaponModels.ts)
    assert.ok(bonesOf(rest).upperarm_l.quaternion.angleTo(bonesOf(axe).upperarm_l.quaternion) > 0.3, 'off shoulder is on the axe');
    assert.ok(bonesOf(rest).forearm_l.quaternion.angleTo(bonesOf(axe).forearm_l.quaternion) > 0.8, 'off elbow is on the axe');
  });

  const GRIP = new THREE.Vector3(0, -0.62, 0.05);
  const settled = (ch: ReturnType<typeof createCharacter>, frames: number, swingAt = -1) => {
    for (let i = 0; i < frames; i++) {
      if (i === swingAt) ch.swing();
      ch.pose({ phase: 0, move: 0, casting: false, time: i / 30, dt: 1 / 30 });
    }
    ch.root.updateMatrixWorld(true);
  };
  const driverOf = (ch: ReturnType<typeof createCharacter>) => (ch.root.userData as { driver: { grip: number } }).driver;
  /** Distance of the left fist from the weapon's axis, and the fist's place along it (weapon units from the right fist). */
  const leftFist = (ch: ReturnType<typeof createCharacter>) => {
    const bones = bonesOf(ch);
    const pivot = ch.root.getObjectByName('weapon:weapon')!;
    const hand = bones.hand_l.children.find((c) => c.type === 'Group')!;
    const fist = hand.localToWorld(GRIP.clone());
    const p = new THREE.Vector3().setFromMatrixPosition(pivot.matrixWorld);
    const axis = new THREE.Vector3(0, 1, 0).transformDirection(pivot.matrixWorld);
    const rel = fist.clone().sub(p);
    const along = rel.dot(axis);
    return { off: rel.addScaledVector(axis, -along).length(), along, hand: fist, axis, p };
  };

  it('the greatsword rests on the shoulder one-handed, takes the second hand to swing, and lets go after a grace period', () => {
    const ch = createCharacter('warrior', '', 'twohand');
    settled(ch, 60);
    assert.ok(driverOf(ch).grip < 0.01, 'one hand at idle');
    const rest = leftFist(ch);
    assert.ok(rest.off > 0.4, `left hand hangs free (${rest.off.toFixed(2)} from the sword)`);
    assert.ok(rest.axis.y > 0.6 && rest.axis.z < -0.2, 'blade up and back over the shoulder');
    assert.ok(rest.p.x < -0.2, 'on the right side');
    // an attack: both hands within a few frames, and the left fist stays on the handle through the whole swing
    ch.swing();
    let worst = 0;
    for (let i = 0; i < 12; i++) {
      ch.pose({ phase: 0, move: 0, casting: false, time: 2 + i / 30, dt: 1 / 30 });
      ch.root.updateMatrixWorld(true);
      if (i >= 5) worst = Math.max(worst, leftFist(ch).off);
    }
    assert.ok(driverOf(ch).grip > 0.95, 'both hands on the sword right after attacking');
    assert.ok(worst < 0.08, `left fist on the handle during the swing (${worst.toFixed(3)})`);
    const l = leftFist(ch);
    assert.ok(l.along > -0.45 && l.along < 0.3, `left fist along the handle (${l.along.toFixed(2)})`);
    // still gripping inside the grace period, then back on the shoulder
    for (let i = 0; i < 30; i++) ch.pose({ phase: 0, move: 0, casting: false, time: 3 + i / 30, dt: 1 / 30 });
    assert.ok(driverOf(ch).grip > 0.9, 'the second hand stays on for a moment after the swing');
    for (let i = 0; i < 90; i++) ch.pose({ phase: 0, move: 0, casting: false, time: 4 + i / 30, dt: 1 / 30 });
    assert.ok(driverOf(ch).grip < 0.05, 'the left hand let go');
    ch.root.updateMatrixWorld(true);
    assert.ok(leftFist(ch).off > 0.4);
  });

  it('the greatsword blade clears the head and the helm while resting and while carried walking', () => {
    for (const move of [0, 1]) {
      const ch = createCharacter('warrior', '', 'twohand');
      for (let i = 0; i < 60; i++) ch.pose({ phase: i * 0.3, move, casting: false, time: i / 30, dt: 1 / 30 });
      ch.root.updateMatrixWorld(true);
      const pivot = ch.root.getObjectByName('weapon:weapon')!;
      const p = new THREE.Vector3().setFromMatrixPosition(pivot.matrixWorld);
      const axis = new THREE.Vector3(0, 1, 0).transformDirection(pivot.matrixWorld);
      const head = new THREE.Vector3(0, 2.0, 0.0);
      for (let t = 0.5; t < 2.0; t += 0.1) {
        const q = p.clone().addScaledVector(axis, t);
        const d = Math.hypot(q.x - head.x, q.z - head.z);
        if (Math.abs(q.y - head.y) < 0.25) assert.ok(d > 0.3, `blade ${d.toFixed(2)} from the head at y ${q.y.toFixed(2)}`);
      }
    }
  });

  it('the axe lies diagonally across the body with both fists on the haft', () => {
    const ch = createCharacter('warrior', '', 'polearm');
    settled(ch, 60);
    const bones = bonesOf(ch);
    const pivot = ch.root.getObjectByName('weapon:weapon')!;
    const hand = bones.hand_l.children.find((c) => c.type === 'Group')!;
    const fist = hand.localToWorld(GRIP.clone());
    const p = new THREE.Vector3().setFromMatrixPosition(pivot.matrixWorld);
    const axis = new THREE.Vector3(0, 1, 0).transformDirection(pivot.matrixWorld);
    const rel = fist.clone().sub(p);
    assert.ok(rel.addScaledVector(axis, -rel.dot(axis)).length() < 0.03, 'left fist on the haft line');
    assert.ok(fist.x > p.x + 0.2 && fist.y > p.y + 0.2, 'upper hand left of and above the lower hand');
    assert.ok(p.x < -0.15 && p.y < 1.4 && p.y > 0.8, 'lower hand on the right hip side');
    assert.ok(axis.x > 0.5 && axis.y > 0.5 && Math.abs(axis.z) < 0.4, `haft runs across the chest (${axis.x.toFixed(2)}, ${axis.y.toFixed(2)}, ${axis.z.toFixed(2)})`);
    assert.equal(driverOf(ch).grip, 1, 'always two-handed');
  });

  /** Skinned edges that stretched past `factor` times their bind length (and are longer than 5 cm): torn-looking triangles. */
  const stretched = (ch: ReturnType<typeof createCharacter>, factor = 2.5) => {
    let bad = 0, longest = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), pa = new THREE.Vector3(), pb = new THREE.Vector3();
    ch.root.updateMatrixWorld(true);
    ch.root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh || !m.geometry.index) return;
      const pos = m.geometry.attributes.position, idx = m.geometry.index;
      for (let i = 0; i < idx.count; i += 3) {
        for (let k = 0; k < 3; k++) {
          const u = idx.getX(i + k), v = idx.getX(i + ((k + 1) % 3));
          a.fromBufferAttribute(pos, u); b.fromBufferAttribute(pos, v);
          const bl = a.distanceTo(b);
          if (bl < 0.004) continue;
          m.getVertexPosition(u, pa); m.getVertexPosition(v, pb);
          const pl = pa.distanceTo(pb);
          if (pl > 0.05 && pl / bl > factor) { bad++; longest = Math.max(longest, pl); }
        }
      }
    });
    return { bad, longest };
  };

  it('the polearm hold does not tear the knight\'s shoulder skin (the old pose swung the left arm 68 degrees across the chest: 320 stretched edges, up to 0.4 yd long)', () => {
    const ch = createCharacter('warrior', '', 'polearm');
    settled(ch, 90);
    const idle = stretched(ch);
    assert.ok(idle.bad < 100, `${idle.bad} stretched edges at idle`);
    assert.ok(idle.longest < 0.25, `longest stretched edge ${idle.longest.toFixed(2)} yd`);
    // the rest pose of the greatsword and the free arms stay clean as well
    const gs = createCharacter('warrior', '', 'twohand');
    settled(gs, 90);
    assert.ok(stretched(gs).bad < 40, 'greatsword at rest');
  });

  it('the left saber is a true mirror of the right one', () => {
    const ch = createCharacter('warrior', '', 'dual');
    ch.root.updateMatrixWorld(true);
    const bones = bonesOf(ch);
    const dets = { l: [] as number[], r: [] as number[] };
    for (const m of held(ch)) dets[handOf(m, bones) as 'l' | 'r'].push(m.matrixWorld.determinant());
    assert.ok(dets.r.every((d) => d > 0) && dets.l.every((d) => d < 0), 'mirrored in the off hand only');
  });

  it('units share geometry and textures but own their materials (hit flash, stealth and death tint per unit)', () => {
    const a = createCharacter('warrior', '', 'twohand');
    const b = createCharacter('warrior', '', 'twohand');
    const [ma, mb] = [held(a)[0], held(b)[0]];
    assert.equal(ma.geometry, mb.geometry);
    const [xa, xb] = [ma.material as THREE.MeshStandardMaterial, mb.material as THREE.MeshStandardMaterial];
    assert.notEqual(xa, xb);
    assert.equal(xa.map, xb.map);
    const before = xa.color.getHex();
    a.setState(false, false);
    assert.notEqual(xa.color.getHex(), before, 'a dead unit\'s weapon greys out');
    assert.equal(xb.color.getHex(), before, 'the other unit is untouched');
    a.setState(true, true);
    assert.ok(xa.transparent, 'stealth fades the weapon');
  });

  it('weapon cosmetics follow the real weapon and the unit still animates (swings, flash, death)', () => {
    for (const item of COSMETICS.items.filter((i) => i.slot === 'weapon')) {
      for (const weapon of WARRIOR_WEAPONS) {
        const ch = createCharacter('warrior', gearLook({ weapon: item.id }), weapon);
        ch.swing();
        for (let i = 0; i < 12; i++) ch.pose({ phase: i, move: i % 2, casting: false, time: i * 0.1, dt: 0.05 });
        ch.flash();
        ch.setState(false, false);
        ch.pose({ phase: 0, move: 0, casting: false, time: 3, dt: 0.05 });
      }
    }
  });

  it('weapons stay a sensible size next to the 2.25 tall knight and survive a swing', () => {
    const lengths: Record<string, [number, number]> = { dual: [0.9, 1.6], twohand: [2.0, 2.8], polearm: [2.0, 2.8] };
    for (const weapon of WARRIOR_WEAPONS) {
      const ch = createCharacter('warrior', '', weapon);
      ch.root.updateMatrixWorld(true);
      const box = new THREE.Box3();
      for (const m of held(ch).filter((m) => handOf(m, bonesOf(ch)) === 'r')) {
        m.geometry.computeBoundingBox();
        box.union(m.geometry.boundingBox!);
      }
      const len = box.max.y - box.min.y;
      assert.ok(len > lengths[weapon][0] && len < lengths[weapon][1], `${weapon} length ${len.toFixed(2)}`);
      ch.swing();
      for (let i = 0; i < 10; i++) ch.pose({ phase: 0, move: 0, casting: false, time: i * 0.05, dt: 0.05 });
    }
  });

  it('falls back to the procedural weapons while the models are not loaded, and the version changes when they load', async () => {
    forgetWeaponModels();
    for (const weapon of WARRIOR_WEAPONS) {
      const ch = createCharacter('warrior', '', weapon);
      assert.ok(held(ch).length > 0, `${weapon} procedural stand-in`);
      for (const m of held(ch)) assert.ok(!(m.material as THREE.MeshStandardMaterial).map, 'plain procedural material');
    }
    const v = modelVersion();
    await registerWeaponModel('dual', load(WEAPON_FILES.dual));
    assert.notEqual(modelVersion(), v, 'scenes rebuild when a weapon model arrives');
    for (const [id, file] of Object.entries(WEAPON_FILES)) if (id !== 'dual') await registerWeaponModel(id, load(file));
  });
});

describe('weapon files', () => {
  const dir = DIR + 'weapons/';
  const parse = (file: string) => {
    const b = Buffer.from(unpackModel(new Uint8Array(readFileSync(dir + file.replace(/\.glb$/, '.pak')))));
    const len = b.readUInt32LE(12);
    return JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
  };
  it('are small and keep their credit', () => {
    const packs = readdirSync(dir).filter((f) => f.endsWith('.pak') && !f.startsWith('staff-'));
    assert.deepEqual(packs.sort(), ['dagger.pak', 'greatsword.pak', 'polearm.pak', 'saber-dual.pak']);
    assert.ok(packs.reduce((n, f) => n + statSync(dir + f).size, 0) < 3 * 1024 * 1024, 'under 3 MB in all');
    const files = packs.map((f) => f.replace(/\.pak$/, '.glb'));
    for (const f of files) {
      const j = parse(f);
      const x = j.asset.extras;
      assert.ok(x?.title && x.author && x.license && x.source?.startsWith('https://sketchfab.com/'), `${f} credit`);
      for (const im of j.images) assert.equal(im.mimeType, 'image/jpeg');
    }
  });
});

describe('model files are not served in the clear', () => {
  it('no plain .glb is left in the served folder, and every pack unscrambles to a glTF binary', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d + e.name + '/') : [d + e.name]));
    const all = walk(DIR);
    assert.deepEqual(all.filter((f) => f.endsWith('.glb')), [], 'plain models would be downloadable');
    const packs = all.filter((f) => f.endsWith('.pak'));
    assert.ok(packs.length >= 5);
    for (const f of packs) {
      const raw = readFileSync(f);
      assert.notEqual(raw.subarray(0, 4).toString('latin1'), 'glTF', 'the pack must not look like a glb');
      assert.equal(Buffer.from(unpackModel(new Uint8Array(raw))).subarray(0, 4).toString('latin1'), 'glTF', f);
    }
  });
  it('a damaged or foreign file is refused', () => {
    assert.throws(() => unpackModel(new Uint8Array([1, 2, 3])));
    const pak = packModel(new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]));
    pak[pak.length - 1] ^= 1;
    assert.throws(() => unpackModel(pak), /damaged/);
    assert.deepEqual([...new Uint8Array(unpackModel(packModel(new Uint8Array([9, 8, 7]))))], [9, 8, 7]);
  });
});
