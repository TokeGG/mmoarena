#!/usr/bin/env node
// Cape pipeline: the downloaded skinned cape GLB (Sketchfab "Cape", 70-joint rig, 1 MB PNGs) -> the game's shared cape model.
//   node scripts/prep-cape.mjs <input.glb> [--out client/public/models/cape.glb] [--inspect]
// Run `npx tsx scripts/pack-models.ts` afterwards (model files are only served as .pak). The original download is NOT kept in the repo.
//
// OUTPUT CONVENTION (what client/src/capeModels.ts expects)
//   - ONE skinned mesh `cape` and ONE skeleton rooted at the bone `cape_root`: the origin is the collar (the centre of the neck line),
//     the cape hangs along -y (1.26 tall, 0.9 wide at the hem) and its back is -z (the hem swings out to z = -0.4). The character's
//     front is +z, so the collar wraps the neck at z = +0.04 .. -0.13 and the hem sits behind the legs.
//   - the body half of the source skeleton (pelvis, spine, collars, arms, shoulder helpers) is dropped and its skin weights go to
//     `cape_root` (the rigid collar). What is left are five cloth chains of 11 bones each, hanging from the collar:
//     `cape_00..10` (centre), `cape_L1_*` / `cape_R1_*` (inner sides), `cape_L2_*` / `cape_R2_*` (outer sides, left = +x).
//     Bone 00 of a chain is the unweighted anchor; 01..10 carry the skin. The runtime swings them as damped chains (capeModels.ts).
//   - one material `cape`, double sided, rough cloth: the base colour map is a NEUTRAL 512 px JPEG (the baked drape shading of the
//     original, normalised to a flat light grey). The cape cosmetics multiply their own colours, trim and emblems onto it. UV layout:
//     the outer face is the big island (centre axis at u = 0.52, collar at the top, hem at v ~ 0.95), the lining the small island at the
//     top right (u > 0.69, v < 0.4). Both are flat layouts of the cloth, so a skin painted in UV space lies on the cloth.
//   - the credit (title, author, licence, source URL) is kept in asset.extras.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlbFile, readAccessor, GlbWriter } from './lib/glb.mjs';
import { decodePng, resize } from './lib/png.mjs';
import { encodeJpeg } from './lib/mesh.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, bool) => {
  const i = args.indexOf(n);
  if (i < 0) return null;
  return args.splice(i, bool ? 1 : 2)[bool ? 0 : 1] ?? true;
};
const inspect = !!flag('--inspect', true);
const out = resolve(flag('--out') || join(here, '../client/public/models/cape.glb'));
const inPath = args[0];
if (!inPath) {
  console.error('usage: node scripts/prep-cape.mjs <input.glb> [--out file] [--inspect]');
  process.exit(1);
}
const TEX = 512;

// ---- column-major 4x4 helpers
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const nodeMatrix = (n) => {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
};
const quatOf = (m) => {
  // rotation part of a rigid matrix -> quaternion
  const t = m[0] + m[5] + m[10];
  let x, y, z, w;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    w = s / 4; x = (m[6] - m[9]) / s; y = (m[8] - m[2]) / s; z = (m[1] - m[4]) / s;
  } else if (m[0] > m[5] && m[0] > m[10]) {
    const s = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2;
    w = (m[6] - m[9]) / s; x = s / 4; y = (m[1] + m[4]) / s; z = (m[2] + m[8]) / s;
  } else if (m[5] > m[10]) {
    const s = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2;
    w = (m[8] - m[2]) / s; x = (m[1] + m[4]) / s; y = s / 4; z = (m[6] + m[9]) / s;
  } else {
    const s = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2;
    w = (m[1] - m[4]) / s; x = (m[2] + m[8]) / s; y = (m[6] + m[9]) / s; z = s / 4;
  }
  return [x, y, z, w];
};
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

// ---- 1. read: world matrices, the skin, the mesh
const g = readGlbFile(inPath);
const { json } = g;
const parent = new Map();
json.nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
const world = new Map();
const worldOf = (i) => {
  if (!world.has(i)) world.set(i, parent.has(i) ? mul(worldOf(parent.get(i)), nodeMatrix(json.nodes[i])) : nodeMatrix(json.nodes[i]));
  return world.get(i);
};
const skin = json.skins[0];
const meshNode = json.nodes.findIndex((n) => n.mesh !== undefined && n.skin !== undefined);
const prim = json.meshes[json.nodes[meshNode].mesh].primitives[0];
const pos = readAccessor(g, prim.attributes.POSITION).data;
const nrm = readAccessor(g, prim.attributes.NORMAL).data;
const uv = readAccessor(g, prim.attributes.TEXCOORD_0).data;
const jnt = readAccessor(g, prim.attributes.JOINTS_0).data;
const wgt = readAccessor(g, prim.attributes.WEIGHTS_0).data;
const idx = readAccessor(g, prim.indices).data;
const ibmAll = readAccessor(g, skin.inverseBindMatrices).data;
const baseNode = json.nodes.findIndex((n) => /^cape base/.test(n.name || ''));
if (baseNode < 0) throw new Error('no "cape base" bone');
const origin = worldOf(baseNode).slice(12, 15);

// ---- 2. the kept bones: the cloth chains under "cape base" (the body skeleton is dropped)
const newNodes = [];
const newIndex = new Map(); // old node -> new node index
const addBone = (old, isRoot) => {
  const n = json.nodes[old];
  const o = { name: isRoot ? 'cape_root' : n.name.replace(/_\d+$/, '') };
  if (isRoot) {
    const W = worldOf(old);
    o.translation = [W[12] - origin[0], W[13] - origin[1], W[14] - origin[2]];
    o.rotation = quatOf(W).map((v) => +v.toFixed(6));
  } else {
    const m = nodeMatrix(n);
    o.translation = [m[12], m[13], m[14]].map((v) => +v.toFixed(6));
    const q = n.rotation || quatOf(m);
    if (Math.abs(q[0]) + Math.abs(q[1]) + Math.abs(q[2]) > 1e-6) o.rotation = q.map((v) => +v.toFixed(6));
  }
  const id = newNodes.length;
  newNodes.push(o);
  newIndex.set(old, id);
  const kids = (n.children || []).filter((c) => /^cape_/.test(json.nodes[c].name || ''));
  if (kids.length) o.children = kids.map((c) => addBone(c, false));
  return id;
};
const rootBone = addBone(baseNode, true);
console.log(`kept ${newNodes.length} of ${skin.joints.length} bones`);

// skin joints: root first, then in node order
const jointNodes = [...newIndex.keys()];
const jointOfOld = new Map(jointNodes.map((o, i) => [o, i]));
const ibm = new Float32Array(jointNodes.length * 16);
jointNodes.forEach((old, i) => {
  const k = skin.joints.indexOf(old);
  const src = k >= 0 ? Array.from(ibmAll.subarray(k * 16, k * 16 + 16)) : null;
  if (!src) throw new Error('kept bone is not a joint: ' + json.nodes[old].name);
  ibm.set(mul(src, translate(origin[0], origin[1], origin[2])), i * 16); // positions move by -origin, so the bind matrices by +origin
});

// weights of the dropped body bones go to the root (the collar is rigid)
const J = new Uint8Array(jnt.length);
const Wt = new Float32Array(wgt.length);
for (let v = 0; v < pos.length / 3; v++) {
  const acc = new Map();
  for (let k = 0; k < 4; k++) {
    const w = wgt[v * 4 + k];
    if (w <= 0) continue;
    const old = skin.joints[jnt[v * 4 + k]];
    const nj = jointOfOld.get(old) ?? 0; // 0 = cape_root
    acc.set(nj, (acc.get(nj) ?? 0) + w);
  }
  const sorted = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = sorted.reduce((s, [, w]) => s + w, 0) || 1;
  sorted.forEach(([j, w], k) => {
    J[v * 4 + k] = j;
    Wt[v * 4 + k] = w / sum;
  });
}
const p2 = new Float32Array(pos.length);
for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) p2[i + k] = pos[i + k] - origin[k];

// ---- 3. texture: the baked drape shading as a neutral grey map
const im = json.images[json.textures[json.materials[0].pbrMetallicRoughness.baseColorTexture.index].source];
const bv = json.bufferViews[im.bufferView];
const src = decodePng(g.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
const small = resize(src, TEX, TEX);
const lum = (d, i) => (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
const meanOf = (x0, y0, x1, y1, pred) => {
  let s = 0, n = 0;
  for (let y = Math.floor(y0 * TEX); y < y1 * TEX; y++) for (let x = Math.floor(x0 * TEX); x < x1 * TEX; x++) {
    const i = (y * TEX + x) * 4;
    if (pred && !pred(small.data, i)) continue;
    s += lum(small.data, i);
    n++;
  }
  return s / Math.max(1, n);
};
const isBlue = (d, i) => d[i + 2] > d[i] + 40;
const outerMean = meanOf(0.3, 0.15, 0.7, 0.8, (d, i) => !isBlue(d, i));
const innerMean = meanOf(0.69, 0.05, 1.0, 0.38, isBlue);
const tex = new Uint8Array(TEX * TEX * 4);
for (let i = 0; i < tex.length; i += 4) {
  const l = lum(small.data, i);
  const inner = isBlue(small.data, i);
  const k = inner ? 1.0 : 1.7; // the drape shading of the outside is subtle: lift its contrast a little
  const v = Math.min(1, Math.max(0.3, 0.9 + (l / (inner ? innerMean : outerMean) - 1) * k * 0.55));
  const c = Math.round(v * 255);
  tex[i] = tex[i + 1] = tex[i + 2] = c;
  tex[i + 3] = 255;
}
const jpg = encodeJpeg(tex, TEX, TEX, 85);

// ---- 4. write
const w = new GlbWriter();
const meshJson = {
  name: 'cape',
  primitives: [
    {
      attributes: {
        POSITION: w.addAccessor(p2, 'VEC3', { target: 34962, minmax: true }),
        NORMAL: w.addAccessor(nrm, 'VEC3', { target: 34962 }),
        TEXCOORD_0: w.addAccessor(uv, 'VEC2', { target: 34962 }),
        JOINTS_0: w.addAccessor(J, 'VEC4', { target: 34962 }),
        WEIGHTS_0: w.addAccessor(Wt, 'VEC4', { target: 34962 }),
      },
      indices: w.addAccessor(new Uint16Array(idx), 'SCALAR', { target: 34963 }),
      material: 0,
      mode: 4,
    },
  ],
};
const ibmAcc = w.addAccessor(ibm, 'MAT4');
const image = w.addBytes(jpg);
const nodes = [{ name: 'cape', mesh: 0, skin: 0 }, ...newNodes.map((n) => n)];
// the bone node indices shift by one (node 0 is the mesh)
for (const n of nodes) if (n.children) n.children = n.children.map((c) => c + 1);
const result = {
  asset: { version: '2.0', generator: 'scripts/prep-cape.mjs', extras: { ...json.asset.extras } },
  scene: 0,
  scenes: [{ nodes: [0, rootBone + 1] }],
  nodes,
  meshes: [meshJson],
  skins: [{ name: 'cape', skeleton: rootBone + 1, joints: jointNodes.map((o) => newIndex.get(o) + 1), inverseBindMatrices: ibmAcc }],
  materials: [{ name: 'cape', doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.85 } }],
  textures: [{ sampler: 0, source: 0 }],
  images: [{ bufferView: image, mimeType: 'image/jpeg', name: 'cape-shading' }],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
};
const bytes = w.build(result);
console.log(`cape: ${idx.length / 3} tris, ${pos.length / 3} verts, ${jointNodes.length} bones, texture ${TEX}px ${(jpg.length / 1024).toFixed(0)} KB, file ${(bytes.length / 1024).toFixed(0)} KB`);
if (!inspect) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  console.log('wrote', out);
}
