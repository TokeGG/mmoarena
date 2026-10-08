#!/usr/bin/env node
// Character model pipeline for models that ARE ALREADY RIGGED (FBX with a skeleton and skin weights): keeps the skinning
// as authored, renames the bones to the game's standard names, normalises scale, splits the mesh into the cosmetic slot
// parts (head / shoulders / back / body) and writes a game GLB the same way rig-model.mjs does.
//   node scripts/convert-skinned.mjs <input.fbx> <config.json> <output.glb> [--assets <dir with the textures>] [--debug <prefix>]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GlbWriter } from './lib/glb.mjs';
import { decodeJpeg, encodeJpeg } from './lib/mesh.mjs';
import { inShape } from './lib/skin.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const assetsDir = opt('--assets');
const debugPrefix = opt('--debug');
const [inPath, cfgPath, outPath] = args;
if (!inPath || !cfgPath || !outPath) {
  console.error('usage: node scripts/convert-skinned.mjs <input.fbx> <config.json> <output.glb> [--assets <dir>] [--debug <prefix>]');
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));

// ---- load (textures are resolved by this script, not by the loader)
THREE.TextureLoader.prototype.load = () => new THREE.Texture();
const buf = readFileSync(inPath);
const origWarn = console.warn;
console.warn = () => {}; // the loader warns about vertices with more than 4 weights; it keeps the strongest 4
const fbx = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
console.warn = origWarn;
fbx.updateMatrixWorld(true);
const mesh = fbx.getObjectByName(cfg.mesh);
if (!mesh?.isSkinnedMesh) throw new Error(`no skinned mesh named ${cfg.mesh}`);
const geo = mesh.geometry;
const skel = mesh.skeleton;

// ---- bind pose: vertices through the bind matrix, bones at the inverse of their inverse bind matrices
const bindM = mesh.bindMatrix.clone();
const nVert = geo.attributes.position.count;
const P = new Float32Array(nVert * 3);
const v = new THREE.Vector3();
for (let i = 0; i < nVert; i++) {
  v.fromBufferAttribute(geo.attributes.position, i).applyMatrix4(bindM);
  P.set([v.x, v.y, v.z], i * 3);
}
const nrmM = new THREE.Matrix3().getNormalMatrix(bindM);
const N = new Float32Array(nVert * 3);
for (let i = 0; i < nVert; i++) {
  v.fromBufferAttribute(geo.attributes.normal, i).applyMatrix3(nrmM).normalize();
  N.set([v.x, v.y, v.z], i * 3);
}
const boneWorld = skel.boneInverses.map((m) => m.clone().invert());

// normalisation: feet on y = 0, centred on the hips in x/z, height `height` measured on the listed material groups
const index = geo.index ? Array.from(geo.index.array) : Array.from({ length: nVert }, (_, i) => i);
const triMat = new Int32Array(index.length / 3);
for (const g of geo.groups) for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) triMat[t] = g.materialIndex;
let minY = Infinity, maxY = -Infinity;
const heightMats = new Set(cfg.heightMaterials ?? [0]);
for (let t = 0; t < triMat.length; t++) {
  if (!heightMats.has(triMat[t])) continue;
  for (let k = 0; k < 3; k++) {
    const y = P[index[t * 3 + k] * 3 + 1];
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
}
const S = cfg.height ?? 2.1;
const k = S / (maxY - minY);
const hipsIdx = skel.bones.findIndex((b) => b.name === cfg.bones.hips);
const hipPos = new THREE.Vector3().setFromMatrixPosition(boneWorld[hipsIdx]);
const norm = new THREE.Matrix4().makeScale(k, k, k).multiply(new THREE.Matrix4().makeTranslation(-hipPos.x, -minY, -hipPos.z));
for (let i = 0; i < nVert; i++) {
  v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(norm);
  P.set([v.x, v.y, v.z], i * 3);
}
const bw = boneWorld.map((m) => norm.clone().multiply(m));

// ---- skeleton: standard names; the game's `root` above the hips
const nameOf = Object.fromEntries(Object.entries({ ...cfg.bones, ...(cfg.extraBones ?? {}) }).map(([out, src]) => [src, out]));
const outBones = [{ name: 'root', parent: null, world: new THREE.Matrix4() }];
const idxOfSrc = new Map();
const order = [];
const visit = (b) => {
  if (!nameOf[b.name]) throw new Error(`bone ${b.name} has no mapping in the config`);
  order.push(b);
  for (const c of b.children) if (c.isBone) visit(c);
};
const rootBone = skel.bones.find((b) => !(b.parent && b.parent.isBone));
visit(rootBone);
for (const b of order) {
  const si = skel.bones.indexOf(b);
  idxOfSrc.set(si, outBones.length);
  outBones.push({ name: nameOf[b.name], parent: b.parent?.isBone ? nameOf[b.parent.name] : 'root', world: bw[si] });
}
const byName = Object.fromEntries(outBones.map((b, i) => [b.name, i]));
const nodes = outBones.map((b) => {
  const parentWorld = b.parent ? outBones[byName[b.parent]].world : new THREE.Matrix4();
  const local = parentWorld.clone().invert().multiply(b.world);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  local.decompose(p, q, s);
  const node = { name: b.name, translation: p.toArray(), children: [] };
  if (Math.abs(q.w) < 0.99999) node.rotation = q.toArray();
  if (Math.abs(s.x - 1) > 1e-4 || Math.abs(s.y - 1) > 1e-4 || Math.abs(s.z - 1) > 1e-4) node.scale = s.toArray();
  return node;
});
outBones.forEach((b, i) => b.parent && nodes[byName[b.parent]].children.push(i));
const jointPos = outBones.map((b) => new THREE.Vector3().setFromMatrixPosition(b.world));
const ibm = new Float32Array(outBones.length * 16);
outBones.forEach((b, i) => ibm.set(b.world.clone().invert().elements, i * 16));

// ---- per vertex skin: remap joint indices
const J = new Uint8Array(nVert * 4), W = new Float32Array(nVert * 4);
for (let i = 0; i < nVert; i++) {
  let sum = 0;
  for (let c = 0; c < 4; c++) {
    const w = geo.attributes.skinWeight.getComponent(i, c);
    const j = idxOfSrc.get(geo.attributes.skinIndex.getComponent(i, c));
    if (w > 0 && j !== undefined) { J[i * 4 + c] = j; W[i * 4 + c] = w; sum += w; }
  }
  for (let c = 0; c < 4; c++) W[i * 4 + c] = sum ? W[i * 4 + c] / sum : c === 0 ? 1 : 0;
}

// ---- parts by region (normalised: feet y = 0, height 1)
const regions = cfg.regions ?? [];
const partAt = (x, y, z) => {
  for (const r of regions) if (inShape(r, x, y, z)) return r.part === 'shoulders' ? 'shoulders' : r.part;
  return 'body';
};
const partOfTri = [];
const buckets = new Map(); // `${part}|${material}` -> triangles
for (let t = 0; t < triMat.length; t++) {
  let x = 0, y = 0, z = 0;
  for (let c = 0; c < 3; c++) {
    const i = index[t * 3 + c];
    x += P[i * 3] / 3; y += P[i * 3 + 1] / 3; z += P[i * 3 + 2] / 3;
  }
  // axe (any non-body material) always stays with the body
  const part = cfg.bodyOnlyMaterials?.includes(triMat[t]) ? 'body' : partAt(x / S, y / S, z / S);
  partOfTri[t] = part;
  const key = `${part}|${triMat[t]}`;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(t);
}

// ---- textures
const dir = assetsDir ? resolve(assetsDir) : dirname(resolve(inPath));
const wr = new GlbWriter();
const images = [], textures = [], materials = [];
const addTex = (file, size, quality = 86) => {
  const img = decodeJpeg(readFileSync(resolve(dir, file)));
  let { width, height, data } = img;
  if (size && width > size) {
    const f = width / size;
    const out = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let c = 0; c < 4; c++) {
      let sum = 0, n = 0;
      for (let yy = Math.floor(y * f); yy < Math.floor((y + 1) * f); yy++) for (let xx = Math.floor(x * f); xx < Math.floor((x + 1) * f); xx++) { sum += data[(yy * width + xx) * 4 + c]; n++; }
      out[(y * size + x) * 4 + c] = sum / n;
    }
    width = height = size;
    data = out;
  }
  const bytes = encodeJpeg(data, width, height, quality);
  images.push({ bufferView: wr.addBytes(bytes), mimeType: 'image/jpeg' });
  textures.push({ source: images.length - 1, sampler: 0 });
  return textures.length - 1;
};
for (const m of cfg.materials) {
  const mat = { name: m.name, pbrMetallicRoughness: { metallicFactor: m.metal ?? 0.25, roughnessFactor: m.rough ?? 0.65, baseColorFactor: m.color ?? [1, 1, 1, 1] }, doubleSided: true };
  if (m.texture) mat.pbrMetallicRoughness.baseColorTexture = { index: addTex(m.texture, m.size) };
  if (m.emissive) {
    mat.emissiveTexture = { index: addTex(m.emissive, m.size) };
    mat.emissiveFactor = m.emissiveFactor ?? [1, 1, 1];
  }
  materials.push(mat);
}

// ---- write the parts
const ibmAcc = wr.addAccessor(ibm, 'MAT4');
const meshes = [];
const sceneNodes = [0];
const partsOut = {};
for (const [key, list] of buckets) {
  const [part, matIdx] = key.split('|');
  const remap = new Map();
  const PP = [], NN = [], UU = [], JJ = [], WW = [], II = [];
  for (const t of list) for (let c = 0; c < 3; c++) {
    const vi = index[t * 3 + c];
    let m = remap.get(vi);
    if (m === undefined) {
      m = PP.length / 3;
      remap.set(vi, m);
      PP.push(P[vi * 3], P[vi * 3 + 1], P[vi * 3 + 2]);
      NN.push(N[vi * 3], N[vi * 3 + 1], N[vi * 3 + 2]);
      UU.push(geo.attributes.uv.getX(vi), 1 - geo.attributes.uv.getY(vi)); // FBX/three UVs have v up; glTF has v down
      for (let q = 0; q < 4; q++) { JJ.push(J[vi * 4 + q]); WW.push(W[vi * 4 + q]); }
    }
    II.push(m);
  }
  // the loader's triangle order is the file's winding, which three already treats as front-facing
  const prim = {
    attributes: {
      POSITION: wr.addAccessor(new Float32Array(PP), 'VEC3', { target: 34962, minmax: true }),
      NORMAL: wr.addAccessor(new Float32Array(NN), 'VEC3', { target: 34962 }),
      TEXCOORD_0: wr.addAccessor(new Float32Array(UU), 'VEC2', { target: 34962 }),
      JOINTS_0: wr.addAccessor(new Uint8Array(JJ), 'VEC4', { target: 34962 }),
      WEIGHTS_0: wr.addAccessor(new Float32Array(WW), 'VEC4', { target: 34962 }),
    },
    indices: wr.addAccessor(new Uint16Array(II), 'SCALAR', { target: 34963 }),
    material: +matIdx,
  };
  const name = `${part}${+matIdx ? `__${cfg.materials[+matIdx].name}` : ''}`;
  meshes.push({ name, primitives: [prim] });
  nodes.push({ name: `part_${name}`, mesh: meshes.length - 1, skin: 0 });
  sceneNodes.push(nodes.length - 1);
  partsOut[name] = list.length;
}
const attach = {};
for (const [name, a] of Object.entries(cfg.attach ?? {})) {
  const bi = byName[a.bone];
  const at = new THREE.Vector3(a.at[0] * S, a.at[1] * S, a.at[2] * S).applyMatrix4(outBones[bi].world.clone().invert());
  nodes.push({ name, translation: at.toArray() });
  nodes[bi].children.push(nodes.length - 1);
  attach[name] = a.bone;
}
const scale = (val) => (Array.isArray(val) ? val.map(scale) : typeof val === 'number' ? val * S : val);
const meta = { height: S, tris: partsOut, ...Object.fromEntries(Object.entries(cfg.runtime ?? {}).map(([kk, val]) => [kk, scale(val)])), ...(cfg.runtimeRaw ?? {}), attach };
nodes[0].extras = { rig: meta };
const json = {
  asset: { version: '2.0', generator: 'scripts/convert-skinned.mjs' },
  scene: 0,
  scenes: [{ nodes: sceneNodes }],
  nodes,
  meshes,
  skins: [{ joints: outBones.map((_, i) => i), inverseBindMatrices: ibmAcc, skeleton: 0 }],
  materials,
  textures,
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
  images,
};
const out = wr.build(json);
writeFileSync(outPath, out);
console.log(`wrote ${outPath}: ${triMat.length} triangles (${Object.entries(partsOut).map(([n, c]) => `${n} ${c}`).join(', ')}), ${(out.length / 1048576).toFixed(2)} MB`);

if (debugPrefix) {
  console.log('bones (fractions of height):');
  outBones.forEach((b, i) => console.log(`  ${b.name.padEnd(12)} ${jointPos[i].toArray().map((q) => (q / S).toFixed(3)).join(' ')}`));
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < nVert; i++) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], P[i * 3 + c]); hi[c] = Math.max(hi[c], P[i * 3 + c]); }
  console.log('bounds /S', lo.map((q) => (q / S).toFixed(3)).join(' '), '..', hi.map((q) => (q / S).toFixed(3)).join(' '));
  const w2 = new GlbWriter();
  const C = new Float32Array(nVert * 3);
  const PC = { body: [0.55, 0.55, 0.55], head: [1, 0.3, 0.3], shoulders: [0.3, 1, 0.3], back: [0.3, 0.5, 1] };
  partOfTri.forEach((p, t) => { for (let c = 0; c < 3; c++) C.set(PC[p] ?? [1, 1, 0], index[t * 3 + c] * 3); });
  const a = [w2.addAccessor(P, 'VEC3', { target: 34962, minmax: true }), w2.addAccessor(N, 'VEC3', { target: 34962 }), w2.addAccessor(C, 'VEC3', { target: 34962 }), w2.addAccessor(new Uint32Array(index), 'SCALAR', { target: 34963 })];
  writeFileSync(`${debugPrefix}.parts.glb`, w2.build({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: a[0], NORMAL: a[1], COLOR_0: a[2] }, indices: a[3], material: 0 }] }], materials: [{ pbrMetallicRoughness: { metallicFactor: 0 }, doubleSided: true }] }));
}
