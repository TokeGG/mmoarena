#!/usr/bin/env node
// Weapon model pipeline: a downloaded (Sketchfab-style) GLB -> small game-ready GLB for the knight's hands.
//   node scripts/prep-weapon.mjs <preset> <input.glb> [--out client/public/models/weapons] [--inspect]
//   node scripts/prep-weapon.mjs --list
// Presets live in scripts/models/weapons.json. The original downloads are large (up to 10 MB of 2k PNGs) and are NOT kept in
// the repo: keep them anywhere outside it and point this script at them; the small outputs are what gets committed.
//
// OUTPUT CONVENTION (what client/src/weaponModels.ts expects)
//   - units are the game's: the knight is ~2 tall, so a greatsword is ~2.4 long. Every output part is a root-level node.
//   - each part is normalised on its own: the GRIP POINT is the origin, the weapon points along +Y (blade tip / axe head up
//     from the grip), and +Z is the flat face of the blade (the axe head's cutting side points along +Z for the axe preset).
//   - parts are named by the preset ("saberR", "saberL", "weapon"); a preset with several parts (dual sabers) splits them so
//     each hand gets one, in its own frame (no mirroring needed at runtime, the two sabers are already a mirrored pair).
//   - one material per source material, base colour map only (JPEG, resized), metallic/roughness as plain factors: the game has
//     no environment map, so metal maps would render black. Normal / ORM / extra maps are dropped on purpose.
//   - the credit (title, author, licence, source URL) is kept in asset.extras so it travels with the file.
// OPTIONAL preset fields for heavy sources (the mage staffs):
//   - "decimate": [{ "match": "<regex on the source node name>", "tris": N }]: that source mesh is simplified to N triangles with
//     meshoptimizer, keeping its UVs and normals (the first matching rule wins); `uvWeight` (default 4) and `normalWeight` (default 1) are how much UV
//     stretch / shading change is avoided against shape error.
//   - per material: "emissiveMap": { size, quality, strength } keeps the emissive texture (a glow) as a JPEG plus the glTF
//     emissive_strength; "noBase": true drops the base colour texture ("color": [r,g,b,a] is used instead); "additive": true marks
//     the material in its extras (the game draws it with additive blending: flames on a black background, no alpha needed).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlbFile, readAccessor, GlbWriter } from './lib/glb.mjs';
import { decodeJpeg, encodeJpeg } from './lib/mesh.mjs';
import { decodePng, resize } from './lib/png.mjs';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';

const here = dirname(fileURLToPath(import.meta.url));
const presets = JSON.parse(readFileSync(join(here, 'models/weapons.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  if (i < 0) return null;
  return args.splice(i, n === '--inspect' ? 1 : 2)[n === '--inspect' ? 0 : 1] ?? true;
};
if (args.includes('--list')) {
  console.log(Object.keys(presets).join('\n'));
  process.exit(0);
}
const inspect = !!flag('--inspect');
const outDir = resolve(flag('--out') || join(here, '../client/public/models/weapons'));
const [presetName, inPath] = args;
const cfg = presets[presetName];
if (!cfg || !inPath) {
  console.error('usage: node scripts/prep-weapon.mjs <preset> <input.glb> [--out dir] [--inspect]   (presets: ' + Object.keys(presets).join(', ') + ')');
  process.exit(1);
}

// ---- 4x4 column-major matrix helpers
const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
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
const apply = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const applyDir = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
const norm3 = (v) => {
  const l = Math.hypot(...v) || 1;
  return v.map((c) => c / l);
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---- 1. read the file and flatten every mesh node into world space
const g = readGlbFile(inPath);
const { json } = g;
const prims = [];
const walk = (ni, parent) => {
  const n = json.nodes[ni];
  const m = mul(parent, nodeMatrix(n));
  if (n.mesh !== undefined) {
    for (const p of json.meshes[n.mesh].primitives) {
      const pos = readAccessor(g, p.attributes.POSITION).data;
      const nrm = readAccessor(g, p.attributes.NORMAL).data;
      const uv = readAccessor(g, p.attributes.TEXCOORD_0).data;
      const idx = readAccessor(g, p.indices).data;
      const wp = new Float32Array(pos.length), wn = new Float32Array(nrm.length);
      for (let i = 0; i < pos.length; i += 3) wp.set(apply(m, pos[i], pos[i + 1], pos[i + 2]), i);
      // uniform scale in all of these files, so the direction transform plus normalising is the normal matrix
      for (let i = 0; i < nrm.length; i += 3) wn.set(norm3(applyDir(m, nrm[i], nrm[i + 1], nrm[i + 2])), i);
      prims.push({ node: n.name || `node${ni}`, pos: wp, nrm: wn, uv, idx, material: p.material ?? 0 });
    }
  }
  for (const c of n.children || []) walk(c, m);
};
for (const r of json.scenes?.[json.scene ?? 0]?.nodes ?? json.scene?.[0]?.nodes ?? []) walk(r, ident());
// ---- 1b. optional decimation of heavy source meshes (UVs and normals kept, so the original textures still fit)
await MeshoptSimplifier.ready;
const weldPrim = (p) => {
  // identical position + normal + uv -> one vertex (exports often repeat vertices per triangle, which blocks every collapse)
  const map = new Map();
  const remap = new Uint32Array(p.pos.length / 3);
  const pos = [], nrm = [], uv = [];
  const q = (v) => Math.round(v * 1e4);
  for (let i = 0; i < remap.length; i++) {
    const key = `${q(p.pos[i * 3])},${q(p.pos[i * 3 + 1])},${q(p.pos[i * 3 + 2])}|${q(p.nrm[i * 3] * 20)},${q(p.nrm[i * 3 + 1] * 20)},${q(p.nrm[i * 3 + 2] * 20)}|${q(p.uv[i * 2] * 100)},${q(p.uv[i * 2 + 1] * 100)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      map.set(key, id);
      pos.push(p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]);
      nrm.push(p.nrm[i * 3], p.nrm[i * 3 + 1], p.nrm[i * 3 + 2]);
      uv.push(p.uv[i * 2], p.uv[i * 2 + 1]);
    }
    remap[i] = id;
  }
  p.pos = new Float32Array(pos);
  p.nrm = new Float32Array(nrm);
  p.uv = new Float32Array(uv);
  p.idx = p.idx.map((i) => remap[i]);
};
const simplifyPrim = (p, tris, uvWeight, nrmWeight) => {
  weldPrim(p);
  const n = p.pos.length / 3;
  const attrs = new Float32Array(n * 5);
  for (let i = 0; i < n; i++) attrs.set([p.nrm[i * 3], p.nrm[i * 3 + 1], p.nrm[i * 3 + 2], p.uv[i * 2], p.uv[i * 2 + 1]], i * 5);
  const [ind] = MeshoptSimplifier.simplifyWithAttributes(new Uint32Array(p.idx), p.pos, 3, attrs, 5, [nrmWeight, nrmWeight, nrmWeight, uvWeight, uvWeight], null, tris * 3, 1, cfg.simplifyFlags ?? []);
  const map = new Int32Array(n).fill(-1);
  const pos = [], nrm = [], uv = [], idx = new Uint32Array(ind.length);
  for (let i = 0; i < ind.length; i++) {
    let m = map[ind[i]];
    if (m < 0) {
      m = pos.length / 3;
      map[ind[i]] = m;
      const v = ind[i];
      pos.push(p.pos[v * 3], p.pos[v * 3 + 1], p.pos[v * 3 + 2]);
      nrm.push(p.nrm[v * 3], p.nrm[v * 3 + 1], p.nrm[v * 3 + 2]);
      uv.push(p.uv[v * 2], p.uv[v * 2 + 1]);
    }
    idx[i] = m;
  }
  p.pos = new Float32Array(pos);
  p.nrm = new Float32Array(nrm);
  p.uv = new Float32Array(uv);
  p.idx = idx;
};
for (const p of prims) {
  const rule = (cfg.decimate ?? []).find((r) => new RegExp(r.match).test(p.node));
  if (!rule || p.idx.length / 3 <= rule.tris) continue;
  const was = p.idx.length / 3;
  simplifyPrim(p, rule.tris, cfg.uvWeight ?? 4, cfg.normalWeight ?? 1);
  console.log(`  decimated ${p.node}: ${was} -> ${p.idx.length / 3} tris`);
}
const bounds = (list, basis) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of list) for (let i = 0; i < p.pos.length; i += 3) {
    const v = basis ? [dot(p.pos.subarray(i, i + 3), basis[0]), dot(p.pos.subarray(i, i + 3), basis[1]), dot(p.pos.subarray(i, i + 3), basis[2])] : p.pos.subarray(i, i + 3);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], v[k]);
      hi[k] = Math.max(hi[k], v[k]);
    }
  }
  return { lo, hi };
};
if (inspect) {
  for (const p of prims) {
    const b = bounds([p]);
    console.log(`${p.node}: ${p.idx.length / 3} tris, material ${p.material}, lo ${b.lo.map((v) => v.toFixed(3))} hi ${b.hi.map((v) => v.toFixed(3))}`);
  }
}

// ---- 2. orientation basis (per part, `up`/`face` on the part override the preset's): Y = tip direction, Z = flat face / cutting
// side, X = Y cross Z (right-handed)
const basisOf = (pt) => {
  const Y = norm3(pt.up ?? cfg.up);
  const face = pt.face ?? cfg.face;
  const Z = norm3(face.map((c, i) => c - dot(face, Y) * Y[i]));
  return [cross(Y, Z), Y, Z];
};

// ---- 3. textures: decode, resize, re-encode as JPEG (cached per image/size)
const w = new GlbWriter();
const imageCache = new Map();
const imageBytes = (i) => {
  const im = json.images[i];
  const bv = json.bufferViews[im.bufferView];
  return g.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
};
const texImage = (texIndex, size, brighten = 1, quality = cfg.jpegQuality ?? 82) => {
  const src = json.textures[texIndex].source;
  const key = `${src}@${size}x${brighten}q${quality}`;
  if (!imageCache.has(key)) {
    const bytes = imageBytes(src);
    const img = json.images[src].mimeType === 'image/png' ? decodePng(bytes) : decodeJpeg(bytes);
    const longest = Math.max(img.width, img.height);
    const k = Math.min(1, size / longest);
    const small = resize(img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
    // the source art is very dark for a scene lit without an environment map: an optional gain (gamma-ish, keeps blacks black)
    if (brighten !== 1) for (let i = 0; i < small.data.length; i += 4) for (let c = 0; c < 3; c++) small.data[i + c] = Math.min(255, small.data[i + c] * brighten);
    const jpg = encodeJpeg(small.data, small.width, small.height, quality);
    console.log(`  texture ${src}: ${img.width}x${img.height} ${(bytes.length / 1024).toFixed(0)} KB -> ${small.width}x${small.height} ${(jpg.length / 1024).toFixed(0)} KB`);
    imageCache.set(key, { index: null, bytes: jpg });
  }
  return imageCache.get(key);
};

const outJson = {
  asset: { version: '2.0', generator: 'scripts/prep-weapon.mjs', extras: cfg.credit },
  scene: 0,
  scenes: [{ nodes: [] }],
  nodes: [],
  meshes: [],
  materials: [],
  textures: [],
  images: [],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
};
const matMap = new Map();
const outMaterial = (srcIndex) => {
  if (matMap.has(srcIndex)) return matMap.get(srcIndex);
  const src = json.materials[srcIndex] ?? {};
  const mc = cfg.materials?.[srcIndex] ?? cfg.materials?.default ?? {};
  const m = { name: src.name || `material${srcIndex}`, doubleSided: true, pbrMetallicRoughness: { metallicFactor: mc.metallic ?? 0.3, roughnessFactor: mc.roughness ?? 0.5 } };
  const bt = src.pbrMetallicRoughness?.baseColorTexture;
  const addTexture = (im, name) => {
    if (im.index === null) {
      im.index = outJson.images.length;
      outJson.images.push({ bufferView: w.addBytes(im.bytes), mimeType: 'image/jpeg', name: `${name}${im.index}` });
    }
    outJson.textures.push({ sampler: 0, source: im.index });
    return { index: outJson.textures.length - 1 };
  };
  if (bt && !mc.noBase) {
    m.pbrMetallicRoughness.baseColorTexture = addTexture(texImage(bt.index, mc.size ?? cfg.textureSize ?? 1024, mc.brighten ?? cfg.brighten ?? 1), 'base');
  } else if (mc.color) m.pbrMetallicRoughness.baseColorFactor = mc.color;
  else if (src.pbrMetallicRoughness?.baseColorFactor) m.pbrMetallicRoughness.baseColorFactor = src.pbrMetallicRoughness.baseColorFactor;
  if (mc.emissiveMap && src.emissiveTexture) {
    m.emissiveTexture = addTexture(texImage(src.emissiveTexture.index, mc.emissiveMap.size ?? 512, 1, mc.emissiveMap.quality ?? 80), 'glow');
    m.emissiveFactor = [1, 1, 1];
    if (mc.emissiveMap.strength) {
      m.extensions = { KHR_materials_emissive_strength: { emissiveStrength: mc.emissiveMap.strength } };
      outJson.extensionsUsed = ['KHR_materials_emissive_strength'];
    }
  } else if (Array.isArray(mc.emissive)) m.emissiveFactor = mc.emissive;
  if (mc.additive) m.extras = { additive: true };
  outJson.materials.push(m);
  matMap.set(srcIndex, outJson.materials.length - 1);
  return outJson.materials.length - 1;
};

// ---- 4. build each part: rotate into the game basis, scale, move the grip to the origin
const parts = cfg.parts ?? [{ name: 'weapon' }];
const partPrims = parts.map((pt) => prims.filter((p) => !pt.match || new RegExp(pt.match).test(p.node)));
const lengths = partPrims.map((l, i) => {
  const b = bounds(l, basisOf(parts[i]));
  return b.hi[1] - b.lo[1];
});
const scale = cfg.length / (lengths.reduce((a, b) => a + b, 0) / lengths.length); // one scale for all parts so a pair stays a pair
console.log(`${presetName}: source length ${lengths.map((l) => l.toFixed(2)).join(', ')} -> scale ${scale.toFixed(5)}`);
parts.forEach((pt, pi) => {
  const list = partPrims[pi];
  if (!list.length) throw new Error(`part ${pt.name} matched nothing`);
  const [X, Y, Z] = basisOf(pt);
  const basis = [X, Y, Z];
  const b = bounds(list, basis);
  const gripY = b.lo[1] + (pt.grip ?? cfg.grip ?? 0.2) * (b.hi[1] - b.lo[1]);
  // x/z centre of the shaft near the grip (bounding box of the vertices within a slab around it), so the origin sits on the axis
  const near = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let slab = (b.hi[1] - b.lo[1]) * 0.02; near[0] === Infinity; slab *= 1.5) {
    for (const p of list) for (let i = 0; i < p.pos.length; i += 3) {
      const v = p.pos.subarray(i, i + 3);
      if (Math.abs(dot(v, Y) - gripY) > slab) continue;
      const x = dot(v, X), z = dot(v, Z);
      near[0] = Math.min(near[0], x); near[3] = Math.max(near[3], x);
      near[2] = Math.min(near[2], z); near[5] = Math.max(near[5], z);
    }
  }
  const cx = (near[0] + near[3]) / 2 + (pt.shiftX ?? cfg.shiftX ?? 0) / scale;
  const cz = (near[2] + near[5]) / 2 + (pt.shiftZ ?? cfg.shiftZ ?? 0) / scale;
  const byMaterial = new Map();
  for (const p of list) {
    const o = byMaterial.get(p.material) ?? { pos: [], nrm: [], uv: [], idx: [] };
    byMaterial.set(p.material, o);
    const base = o.pos.length / 3;
    for (let i = 0; i < p.pos.length; i += 3) {
      const v = p.pos.subarray(i, i + 3), n = p.nrm.subarray(i, i + 3);
      o.pos.push((dot(v, X) - cx) * scale, (dot(v, Y) - gripY) * scale, (dot(v, Z) - cz) * scale);
      o.nrm.push(dot(n, X), dot(n, Y), dot(n, Z));
    }
    o.uv.push(...p.uv);
    for (const k of p.idx) o.idx.push(base + k);
  }
  const primitives = [];
  for (const [mat, o] of byMaterial) {
    const verts = o.pos.length / 3;
    primitives.push({
      attributes: {
        POSITION: w.addAccessor(new Float32Array(o.pos), 'VEC3', { target: 34962, minmax: true }),
        NORMAL: w.addAccessor(new Float32Array(o.nrm), 'VEC3', { target: 34962 }),
        TEXCOORD_0: w.addAccessor(new Float32Array(o.uv), 'VEC2', { target: 34962 }),
      },
      indices: w.addAccessor(verts > 65535 ? new Uint32Array(o.idx) : new Uint16Array(o.idx), 'SCALAR', { target: 34963 }),
      material: outMaterial(mat),
      mode: 4,
    });
  }
  outJson.meshes.push({ name: pt.name, primitives });
  outJson.nodes.push({ name: pt.name, mesh: outJson.meshes.length - 1 });
  outJson.scenes[0].nodes.push(outJson.nodes.length - 1);
  const fb = bounds(list, basis);
  console.log(`  part ${pt.name}: ${list.reduce((a, p) => a + p.idx.length / 3, 0)} tris, y ${((fb.lo[1] - gripY) * scale).toFixed(2)}..${((fb.hi[1] - gripY) * scale).toFixed(2)}, x/z ${((fb.lo[0] - cx) * scale).toFixed(2)}..${((fb.hi[0] - cx) * scale).toFixed(2)} / ${((fb.lo[2] - cz) * scale).toFixed(2)}..${((fb.hi[2] - cz) * scale).toFixed(2)}`);
});

if (!inspect) {
  mkdirSync(outDir, { recursive: true });
  const out = w.build(outJson);
  const file = join(outDir, cfg.out);
  writeFileSync(file, out);
  console.log(`wrote ${file}: ${(out.length / 1024).toFixed(0)} KB`);
}
