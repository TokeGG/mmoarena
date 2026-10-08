#!/usr/bin/env node
// Character pipeline for models that are ALREADY rigged AND animated (real clips), e.g. the mage's Old Wizard:
//   node scripts/prep-character.mjs <input.glb> [scripts/models/mage.json] [--out client/public/models/mage-wizard.glb]
// Unlike rig-model.mjs / convert-skinned.mjs (static or skinned meshes driven by procedural bone animation, riggedPose.ts) this keeps
// the skeleton hierarchy, the skin and EVERY animation clip untouched, so the client plays them with a THREE.AnimationMixer
// (riggedClips.ts). What it does:
//   - drops the meshes listed under `dropMeshes` (the original staff: the spec staffs replace it) and every node that is then
//     useless (empty helper nodes); keeps the joints and the grip bone
//   - names the sub-meshes by `parts` (head / hands / boots / robe / beard) so cosmetics and dyes can address them
//   - re-encodes the textures: downscaled, JPEG (PNG only where `alpha` is set), normal / occlusion / metal maps dropped (the game has
//     no environment map), plain roughness factors
//   - collapses animation tracks that never change into one key (fingers, scale tracks)
//   - scales / moves the whole model through its root node so it stands at y = 0, `height` tall, facing +z (config `rotateY` turns it)
//   - measures the idle pose and stores the rig metadata the cosmetics need in the root node's extras (rig.*), plus `rig.clips`
//     and `rig.bones` (canonical bone name -> the file's bone name)
//   - writes the credit into asset.extras
// Mesh nodes are named part_body__<what> like the procedural-bone models (the cosmetics code reads the slot from the first part).
// Then run `npx tsx scripts/pack-models.ts` (see DEVELOPING.md, "Packed models").
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readGlbFile, readAccessor, GlbWriter } from './lib/glb.mjs';
import { decodeJpeg, encodeJpeg } from './lib/mesh.mjs';
import { decodePng, resize, encodePng } from './lib/png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i < 0 ? null : args.splice(i, 2)[1];
};
const outArg = flag('--out');
const [inPath, cfgPath = join(here, 'models/mage.json')] = args;
if (!inPath) {
  console.error('usage: node scripts/prep-character.mjs <input.glb> [config.json] [--out file.glb]');
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const outFile = resolve(outArg || join(here, '../client/public/models', cfg.out));

const g = readGlbFile(inPath);
const src = g.json;
const w = new GlbWriter();

// ---- 1. which nodes survive
const meshName = (n) => (n.mesh !== undefined ? src.meshes[n.mesh].name || '' : '');
const dropRe = (cfg.dropMeshes ?? []).map((r) => new RegExp(r));
const alive = new Set(src.nodes.map((_, i) => i));
for (const [i, n] of src.nodes.entries()) if (n.mesh !== undefined && dropRe.some((re) => re.test(meshName(n)))) alive.delete(i);
const joints = new Set(src.skins.flatMap((s) => s.joints));
for (let changed = true; changed; ) {
  changed = false;
  for (const i of [...alive]) {
    const n = src.nodes[i];
    const kids = (n.children ?? []).filter((c) => alive.has(c));
    if (!kids.length && n.mesh === undefined && !joints.has(i)) {
      alive.delete(i);
      changed = true;
    }
  }
}
const remap = new Map();
[...alive].sort((a, b) => a - b).forEach((old, i) => remap.set(old, i));

// ---- 2. textures
const imageBytes = (i) => {
  const bv = src.bufferViews[src.images[i].bufferView];
  return g.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
};
const out = { asset: { version: '2.0', generator: 'scripts/prep-character.mjs', extras: { ...cfg.credit, note: cfg.note } }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], textures: [], images: [], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }], skins: [], animations: [] };
const texCache = new Map();
const texture = (texIndex, spec) => {
  const imgIndex = src.textures[texIndex].source;
  const key = `${imgIndex}@${spec.size}${spec.alpha ? 'a' : ''}`;
  if (!texCache.has(key)) {
    const bytes = imageBytes(imgIndex);
    const img = src.images[imgIndex].mimeType === 'image/png' ? decodePng(bytes) : decodeJpeg(bytes);
    const k = Math.min(1, spec.size / Math.max(img.width, img.height));
    const small = resize(img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
    const enc = spec.alpha ? encodePng(small.data, small.width, small.height) : encodeJpeg(small.data, small.width, small.height, spec.quality ?? 82);
    console.log(`  texture ${imgIndex}: ${img.width}x${img.height} ${(bytes.length / 1024).toFixed(0)} KB -> ${small.width}x${small.height} ${(enc.length / 1024).toFixed(0)} KB`);
    out.images.push({ bufferView: w.addBytes(enc), mimeType: spec.alpha ? 'image/png' : 'image/jpeg', name: `tex${out.images.length}` });
    out.textures.push({ sampler: 0, source: out.images.length - 1 });
    texCache.set(key, out.textures.length - 1);
  }
  return texCache.get(key);
};
const matMap = new Map();
const outMaterial = (si) => {
  if (matMap.has(si)) return matMap.get(si);
  const m = src.materials[si];
  const mc = cfg.materials?.[m.name] ?? {};
  const o = { name: m.name, doubleSided: true, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: mc.roughness ?? 0.8 } };
  const bt = m.pbrMetallicRoughness?.baseColorTexture;
  if (bt && mc.base) o.pbrMetallicRoughness.baseColorTexture = { index: texture(bt.index, mc.base) };
  else if (m.pbrMetallicRoughness?.baseColorFactor) o.pbrMetallicRoughness.baseColorFactor = m.pbrMetallicRoughness.baseColorFactor;
  if (m.emissiveTexture && mc.emissive) {
    o.emissiveTexture = { index: texture(m.emissiveTexture.index, mc.emissive) };
    o.emissiveFactor = [1, 1, 1];
  }
  if (mc.alphaMode) {
    o.alphaMode = mc.alphaMode;
    if (mc.alphaCutoff !== undefined) o.alphaCutoff = mc.alphaCutoff;
  }
  out.materials.push(o);
  matMap.set(si, out.materials.length - 1);
  return out.materials.length - 1;
};

// ---- 3. meshes
const KEEP = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'];
const meshMap = new Map();
const partOf = (name) => cfg.parts?.find((p) => new RegExp(p.match).test(name))?.name ?? name;
const outMesh = (mi) => {
  if (meshMap.has(mi)) return meshMap.get(mi);
  const m = src.meshes[mi];
  const primitives = m.primitives.map((p) => {
    const attributes = {};
    let verts = 0;
    for (const k of KEEP) {
      if (p.attributes[k] === undefined) continue;
      const a = readAccessor(g, p.attributes[k]);
      const meta = src.accessors[p.attributes[k]];
      verts = a.count;
      attributes[k] = w.addAccessor(a.data, meta.type, { target: 34962, minmax: k === 'POSITION', normalized: meta.normalized });
    }
    const idx = readAccessor(g, p.indices).data;
    return { attributes, indices: w.addAccessor(verts > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 'SCALAR', { target: 34963 }), material: outMaterial(p.material ?? 0), mode: 4 };
  });
  out.meshes.push({ name: partOf(m.name), primitives });
  meshMap.set(mi, out.meshes.length - 1);
  return out.meshes.length - 1;
};

// ---- 4. nodes and skins
for (const [old] of [...remap.entries()]) {
  const n = src.nodes[old];
  const o = { name: n.mesh !== undefined ? partOf(meshName(n)) : n.name }; // mesh nodes are named by part: three.js names the object after the node
  for (const k of ['matrix', 'translation', 'rotation', 'scale']) if (n[k]) o[k] = n[k];
  const kids = (n.children ?? []).filter((c) => alive.has(c)).map((c) => remap.get(c));
  if (kids.length) o.children = kids;
  if (n.mesh !== undefined) o.mesh = outMesh(n.mesh);
  if (n.skin !== undefined) o.skin = n.skin;
  out.nodes.push(o);
}
out.scenes[0].nodes = (src.scenes[src.scene ?? 0].nodes).filter((i) => alive.has(i)).map((i) => remap.get(i));
for (const s of src.skins) {
  const ibm = readAccessor(g, s.inverseBindMatrices);
  out.skins.push({ joints: s.joints.map((j) => remap.get(j)), skeleton: s.skeleton !== undefined ? remap.get(s.skeleton) : undefined, inverseBindMatrices: w.addAccessor(ibm.data, 'MAT4') });
}

// ---- 5. animations (a track whose value never changes becomes one key)
const sizes = { translation: 3, rotation: 4, scale: 3 };
const inputCache = new Map();
let keysIn = 0, keysOut = 0;
const zero = new Float32Array([0]);
let zeroAcc = null;
for (const a of src.animations ?? []) {
  const samplers = [];
  const channels = [];
  for (const c of a.channels) {
    if (!alive.has(c.target.node)) continue;
    const s = a.samplers[c.sampler];
    const n = sizes[c.target.path];
    const vals = readAccessor(g, s.output).data;
    keysIn += vals.length / n;
    let flat = true;
    for (let i = n; i < vals.length && flat; i++) if (Math.abs(vals[i] - vals[i % n]) > 1e-4) flat = false;
    let input, output;
    if (flat) {
      zeroAcc ??= w.addAccessor(zero, 'SCALAR', { minmax: true });
      input = zeroAcc;
      output = w.addAccessor(new Float32Array(vals.subarray(0, n)), n === 4 ? 'VEC4' : 'VEC3');
      keysOut += 1;
    } else {
      if (!inputCache.has(s.input)) inputCache.set(s.input, w.addAccessor(readAccessor(g, s.input).data, 'SCALAR', { minmax: true }));
      input = inputCache.get(s.input);
      output = w.addAccessor(vals, n === 4 ? 'VEC4' : 'VEC3');
      keysOut += vals.length / n;
    }
    samplers.push({ input, output, interpolation: s.interpolation ?? 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: remap.get(c.target.node), path: c.target.path } });
  }
  out.animations.push({ name: a.name, samplers, channels });
}
console.log(`animation keys ${keysIn} -> ${keysOut}`);

// ---- 6. measure (three.js, idle pose) and place the model: standing on y = 0, `height` tall, centred, facing +z
globalThis.self ??= globalThis;
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });
const parse = (buf) => new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
const idlePose = async () => {
  const gltf = await parse(w.build(out));
  const idle = gltf.animations.find((a) => a.name === 'idle') ?? gltf.animations[0];
  const mixer = new THREE.AnimationMixer(gltf.scene);
  if (idle) mixer.clipAction(idle).play();
  mixer.update(0);
  gltf.scene.updateMatrixWorld(true);
  return gltf;
};
const skinnedBox = (scene, filter = () => true, ymin = -Infinity, ymax = Infinity) => {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  scene.traverse((o) => {
    if (!(o instanceof THREE.SkinnedMesh) || !filter(o)) return;
    o.skeleton.update();
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      o.applyBoneTransform(i, v);
      v.applyMatrix4(o.matrixWorld);
      if (v.y >= ymin && v.y <= ymax) box.expandByPoint(v);
    }
  });
  return box;
};
const before = skinnedBox((await idlePose()).scene);
const scale = cfg.height / (before.max.y - before.min.y);
const root = out.scenes[0].nodes[0];
const cy = Math.cos(((cfg.rotateY ?? 0) * Math.PI) / 180), sy = Math.sin(((cfg.rotateY ?? 0) * Math.PI) / 180);
const place = new THREE.Matrix4().makeTranslation(0, 0, 0).multiply(new THREE.Matrix4().makeRotationY(Math.atan2(sy, cy))).multiply(new THREE.Matrix4().makeScale(scale, scale, scale));
const base = new THREE.Matrix4().fromArray(out.nodes[root].matrix ?? new THREE.Matrix4().compose(new THREE.Vector3(...(out.nodes[root].translation ?? [0, 0, 0])), new THREE.Quaternion(...(out.nodes[root].rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(out.nodes[root].scale ?? [1, 1, 1]))).toArray());
delete out.nodes[root].translation;
delete out.nodes[root].rotation;
delete out.nodes[root].scale;
out.nodes[root].matrix = place.clone().multiply(base).toArray();
const mid = skinnedBox((await idlePose()).scene);
out.nodes[root].matrix = new THREE.Matrix4().makeTranslation(-(mid.min.x + mid.max.x) / 2, -mid.min.y, -(mid.min.z + mid.max.z) / 2).multiply(new THREE.Matrix4().fromArray(out.nodes[root].matrix)).toArray();

const gl = await idlePose();
const box = skinnedBox(gl.scene);
const bonePos = {};
const bones = cfg.bones;
for (const [canon, name] of Object.entries(bones)) {
  const b = gl.scene.getObjectByName(name);
  if (!b) throw new Error(`no bone ${name}`);
  bonePos[canon] = b.getWorldPosition(new THREE.Vector3());
}
const r3 = (v) => +v.toFixed(4);
const part = (what) => (o) => o.name.endsWith(`__${what}`);
// head: the head mesh above the neck bone; radius = half its widest horizontal extent
const hb = skinnedBox(gl.scene, part('head'), bonePos.neck.y + 0.02);
const headCenter = hb.getCenter(new THREE.Vector3());
const headR = Math.max(hb.max.x - hb.min.x, hb.max.z - hb.min.z) / 2;
const beard = skinnedBox(gl.scene, part('beard'));
const chest = bonePos.chest.y;
const rb = skinnedBox(gl.scene, part('robe'), chest - 0.08, chest + 0.08);
const full = skinnedBox(gl.scene, (o) => !/__(beard|head)$/.test(o.name));
const rig = {
  height: r3(box.max.y - box.min.y),
  headCenter: [r3(headCenter.x), r3(headCenter.y), r3(headCenter.z)],
  headR: r3(headR),
  headTop: r3(hb.max.y),
  faceZ: r3(hb.max.z),
  beard: { minY: r3(beard.min.y), maxZ: r3(beard.max.z), halfW: r3((beard.max.x - beard.min.x) / 2) },
  shoulderJoint: [r3(Math.abs(bonePos.upperarm_l.x)), r3(bonePos.upperarm_l.y), 0],
  chestBackZ: r3(-rb.min.z),
  torsoW: r3(rb.max.x - rb.min.x),
  deadY: 0,
  clips: true,
  bones,
  grip: bonePos[cfg.grip ?? 'hand_r'].toArray().map(r3),
};
// how the ORIGINAL staff was held (it was skinned rigidly to the grip bone): its axis and where the fist closes on it, in the idle
// pose and the final character frame. The spec staffs are attached the same way (weaponModels.ts / riggedClips.ts).
if (cfg.holdFrom) {
  const orig = await parse(readFileSync(inPath));
  const oroot = orig.scene.getObjectByName(src.nodes[src.scenes[src.scene ?? 0].nodes[0]].name);
  oroot.matrix.fromArray(out.nodes[root].matrix);
  oroot.matrix.decompose(oroot.position, oroot.quaternion, oroot.scale);
  const mixer = new THREE.AnimationMixer(orig.scene);
  mixer.clipAction(orig.animations.find((a) => a.name === 'idle') ?? orig.animations[0]).play();
  mixer.update(0);
  orig.scene.updateMatrixWorld(true);
  const re = new RegExp(cfg.holdFrom);
  const pts = [];
  const v = new THREE.Vector3();
  orig.scene.traverse((o) => {
    if (!(o instanceof THREE.SkinnedMesh) || !re.test(`${o.name} ${o.material.name}`)) return;
    o.skeleton.update();
    for (let i = 0; i < o.geometry.attributes.position.count; i++) {
      v.fromBufferAttribute(o.geometry.attributes.position, i);
      o.applyBoneTransform(i, v);
      pts.push(v.clone().applyMatrix4(o.matrixWorld));
    }
  });
  if (pts.length) {
    const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
    let ax = new THREE.Vector3(0, 1, 0);
    for (let it = 0; it < 50; it++) {
      const n = new THREE.Vector3();
      for (const p of pts) {
        const d = p.clone().sub(c);
        n.addScaledVector(d, d.dot(ax));
      }
      ax = n.normalize();
    }
    if (ax.y < 0) ax.negate();
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) {
      const t = p.clone().sub(c).dot(ax);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    const hand = orig.scene.getObjectByName(bones[cfg.grip ?? 'hand_r']).getWorldPosition(new THREE.Vector3());
    const t = hand.clone().sub(c).dot(ax);
    const grip = c.clone().addScaledVector(ax, t).sub(hand);
    rig.hold = { axis: ax.toArray().map(r3), grip: grip.toArray().map(r3), length: r3(hi - lo), along: r3((t - lo) / (hi - lo)) };
  }
}
Object.assign(rig, cfg.rig ?? {});
out.nodes[root].extras = { rig };
const buf = w.build(out);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, buf);
const tris = out.meshes.reduce((a, m) => a + m.primitives.reduce((b, p) => b + w.accessors[p.indices].count / 3, 0), 0);
console.log(`wrote ${outFile}: ${(buf.length / 1024).toFixed(0)} KB, ${tris} tris, ${out.animations.length} clips (${out.animations.map((a) => a.name).join(', ')})`);
console.log('rig', JSON.stringify(rig));
console.log('body (no head/beard) box', full.min.toArray().map(r3), full.max.toArray().map(r3));
