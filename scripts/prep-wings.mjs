#!/usr/bin/env node
// Wing pipeline: the downloaded feather wings (Sketchfab "Angel wings", one static mesh of feather cards, 2 PNGs) -> the game's shared wing model.
//   node scripts/prep-wings.mjs <input.glb> [--out client/public/models/wings.glb] [--inspect]
// Run `npx tsx scripts/pack-models.ts` afterwards (model files are only served as .pak). The original download is NOT kept in the repo.
//
// OUTPUT CONVENTION (what client/src/wingModels.ts expects)
//   - ONE skinned mesh `wings` (both wings) and one skeleton rooted at `wing_root`: the origin is the centre line between the shoulder blades at
//     the height where the wings grow out. +x is the character's left. The wings are flat: the plane is z = 0, the feathers hang down (-y) and
//     out (+-x) from the shoulder joint at x = +-0.1, about 2 wide per wing and 0.95 deep, ~5.7k triangles. The runtime hinges, raises and flutters them.
//   - bones per side (L = +x, R = -x): `wing_L` (shoulder, at x = 0.1) > `wing_L_m` (wrist, 0.8 further out) > `wing_L_t` (tip, 0.7 further out); the same
//     for `wing_R*`. Skin weights blend along the span (smooth steps on |x|), so bending the chain curls the whole feather fan.
//   - one material `wings`, double sided, alpha tested: the base colour map is a NEUTRAL grey 512 px PNG with the feather cut-out in its alpha
//     (the original's pale blue-white shading, normalised). The wing styles repaint it (gradient maps, glow edges) and multiply their colours on.
//   - the credit (title, author, licence, source URL) is kept in asset.extras.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlbFile, readAccessor, GlbWriter } from './lib/glb.mjs';
import { decodePng, resize, encodePng } from './lib/png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, bool) => {
  const i = args.indexOf(n);
  if (i < 0) return null;
  return args.splice(i, bool ? 1 : 2)[bool ? 0 : 1] ?? true;
};
const inspect = !!flag('--inspect', true);
const out = resolve(flag('--out') || join(here, '../client/public/models/wings.glb'));
const inPath = args[0];
if (!inPath) {
  console.error('usage: node scripts/prep-wings.mjs <input.glb> [--out file] [--inspect]');
  process.exit(1);
}
const TEX = 512;

const g = readGlbFile(inPath);
const { json } = g;
const prim = json.meshes[0].primitives[0];
const pos = readAccessor(g, prim.attributes.POSITION).data;
const nrm = readAccessor(g, prim.attributes.NORMAL).data;
const uv = readAccessor(g, prim.attributes.TEXCOORD_0).data;
const idx = readAccessor(g, prim.indices).data;
const n = pos.length / 3;

// the source's node chain turns the mesh upright: (x, y, z) -> (x, z + 1.307, -y - 0.233); then the shoulder joint becomes the origin
const PIVOT = [0, 1.45, -0.19];
const P = new Float32Array(n * 3), N = new Float32Array(n * 3);
for (let i = 0; i < n; i++) {
  const [x, y, z] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  P.set([x - PIVOT[0], z + 1.307 - PIVOT[1], -y - 0.233 - PIVOT[2]], i * 3);
  const [nx, ny, nz] = [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]];
  N.set([nx, nz, -ny], i * 3);
}

// skeleton: root > wing_L > wing_L_m > wing_L_t, and the mirror image
const SHOULDER = 0.1, ARM = 0.8, HAND = 0.7;
const nodes = [{ name: 'wings', mesh: 0, skin: 0 }, { name: 'wing_root', children: [] }];
const joints = [1];
const bonePos = [[0, 0, 0]];
for (const [side, sd] of [['L', 1], ['R', -1]]) {
  let parent = 1, at = [0, 0, 0];
  for (const [suffix, dx] of [['', SHOULDER], ['_m', ARM], ['_t', HAND]]) {
    const id = nodes.length;
    nodes.push({ name: `wing_${side}${suffix}`, translation: [sd * dx, 0, 0] });
    (nodes[parent].children ??= []).push(id);
    joints.push(id);
    at = [at[0] + sd * dx, 0, 0];
    bonePos.push(at);
    parent = id;
  }
}
// joint order: 0 root, 1..3 L, 4..6 R
const smooth = (a, b, x) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
const J = new Uint8Array(n * 4), W = new Float32Array(n * 4);
for (let i = 0; i < n; i++) {
  const x = P[i * 3];
  const base = x >= 0 ? 1 : 4;
  const ax = Math.abs(x);
  const wm = smooth(0.55, 1.15, ax), wt = smooth(1.2, 1.8, ax);
  const w = [1 - wm, wm * (1 - wt), wm * wt];
  for (let k = 0; k < 3; k++) {
    J[i * 4 + k] = base + k;
    W[i * 4 + k] = w[k];
  }
}
const ibm = new Float32Array(joints.length * 16);
bonePos.forEach((p, i) => ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], i * 16));

// texture: a neutral grey of the original's shading, keeping its alpha cut-out
const im = json.images[json.textures[json.materials[0].pbrMetallicRoughness.baseColorTexture.index].source];
const bv = json.bufferViews[im.bufferView];
const small = resize(decodePng(g.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength)), TEX, TEX);
const lum = (d, i) => (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
let sum = 0, cnt = 0;
for (let i = 0; i < small.data.length; i += 4) if (small.data[i + 3] > 200) (sum += lum(small.data, i)), cnt++;
const mean = sum / cnt;
const tex = new Uint8Array(TEX * TEX * 4);
for (let i = 0; i < tex.length; i += 4) {
  const v = Math.min(1, Math.max(0.35, 0.86 + (lum(small.data, i) / mean - 1) * 1.7));
  tex[i] = tex[i + 1] = tex[i + 2] = Math.round(v * 255);
  tex[i + 3] = small.data[i + 3];
}
const png = encodePng(tex, TEX, TEX);

const w = new GlbWriter();
const meshJson = {
  name: 'wings',
  primitives: [{
    attributes: {
      POSITION: w.addAccessor(P, 'VEC3', { target: 34962, minmax: true }),
      NORMAL: w.addAccessor(N, 'VEC3', { target: 34962 }),
      TEXCOORD_0: w.addAccessor(uv, 'VEC2', { target: 34962 }),
      JOINTS_0: w.addAccessor(J, 'VEC4', { target: 34962 }),
      WEIGHTS_0: w.addAccessor(W, 'VEC4', { target: 34962 }),
    },
    indices: w.addAccessor(new Uint16Array(idx), 'SCALAR', { target: 34963 }),
    material: 0,
    mode: 4,
  }],
};
const ibmAcc = w.addAccessor(ibm, 'MAT4');
const image = w.addBytes(png);
const result = {
  asset: { version: '2.0', generator: 'scripts/prep-wings.mjs', extras: { ...json.asset.extras } },
  scene: 0,
  scenes: [{ nodes: [0, 1] }],
  nodes,
  meshes: [meshJson],
  skins: [{ name: 'wings', skeleton: 1, joints, inverseBindMatrices: ibmAcc }],
  materials: [{ name: 'wings', doubleSided: true, alphaMode: 'MASK', alphaCutoff: 0.45, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.7 } }],
  textures: [{ sampler: 0, source: 0 }],
  images: [{ bufferView: image, mimeType: 'image/png', name: 'wings-shading' }],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
};
const bytes = w.build(result);
const b = [[1e9, -1e9], [1e9, -1e9], [1e9, -1e9]];
for (let i = 0; i < n * 3; i++) (b[i % 3][0] = Math.min(b[i % 3][0], P[i])), (b[i % 3][1] = Math.max(b[i % 3][1], P[i]));
console.log(`wings: ${idx.length / 3} tris, ${n} verts, ${joints.length} bones, bounds x ${b[0].map((v) => v.toFixed(2))} y ${b[1].map((v) => v.toFixed(2))} z ${b[2].map((v) => v.toFixed(2))}, texture ${TEX}px ${(png.length / 1024).toFixed(0)} KB, file ${(bytes.length / 1024).toFixed(0)} KB`);
if (!inspect) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  console.log('wrote', out);
}
