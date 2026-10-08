#!/usr/bin/env node
// Character model pipeline: static GLB + rig config -> game-ready skinned GLB.
//   node scripts/rig-model.mjs <input.glb> <config.rig.json> <output.glb> [--debug <prefix>]
// See DEVELOPING.md ("Character models") for the config fields. Steps: decimate, re-unwrap and bake a 1024 texture,
// split into cosmetic slot parts (head / shoulders / back / body), build the skeleton, compute skin weights, write GLB.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import v8 from 'node:v8';
import { readGlbFile, readAccessor, GlbWriter } from './lib/glb.mjs';
import { weld, decimate, vertexNormals, decodeJpeg, encodeJpeg, vertexColours, unwrapAndBake } from './lib/mesh.mjs';
import { computeWeights, BONES } from './lib/skin.mjs';

const args = process.argv.slice(2);
const dbg = args.indexOf('--debug');
const debugPrefix = dbg >= 0 ? args.splice(dbg, 2)[1] : null;
const ci = args.indexOf('--cache');
const cachePath = ci >= 0 ? args.splice(ci, 2)[1] : null; // reuse the slow decimate + bake step while tuning regions and joints
const [inPath, cfgPath, outPath] = args;
if (!inPath || !cfgPath || !outPath) {
  console.error('usage: node scripts/rig-model.mjs <input.glb> <config.rig.json> <output.glb> [--debug <prefix>]');
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const log = (m) => console.log(m);

let d, baked, jpg;
const cached = cachePath && existsSync(cachePath) ? v8.deserialize(readFileSync(cachePath)) : null;
if (cached) ({ d, baked, jpg } = cached);
else {
// ---- 1. read and normalise: feet on y = 0, centred in x and z, total height 1 (the config works in these units)
const g = readGlbFile(inPath);
const prim = g.json.meshes[0].primitives[0];
const rawPos = readAccessor(g, prim.attributes.POSITION).data;
const rawUv = readAccessor(g, prim.attributes.TEXCOORD_0).data;
const rawNrm = readAccessor(g, prim.attributes.NORMAL).data;
const rawIdx = readAccessor(g, prim.indices).data;
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < rawPos.length; i++) {
  lo[i % 3] = Math.min(lo[i % 3], rawPos[i]);
  hi[i % 3] = Math.max(hi[i % 3], rawPos[i]);
}
const H = hi[1] - lo[1];
const cx = cfg.centerX ?? (lo[0] + hi[0]) / 2, cz = cfg.centerZ ?? (lo[2] + hi[2]) / 2;
const norm = new Float32Array(rawPos.length);
for (let i = 0; i < rawPos.length; i += 3) {
  norm[i] = (rawPos[i] - cx) / H;
  norm[i + 1] = (rawPos[i + 1] - lo[1]) / H;
  norm[i + 2] = (rawPos[i + 2] - cz) / H;
}
log(`input ${rawIdx.length / 3} triangles, height ${H.toFixed(3)}`);

// ---- 2. decimate geometry, re-unwrap, bake texture
const bv = g.json.bufferViews[g.json.images[0].bufferView];
const img = decodeJpeg(g.bin.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength));
const w = weld(norm, rawIdx, 1e-6);
d = await decimate(w.pos, w.idx, cfg.targetTris ?? 12000);
log(`decimated to ${d.idx.length / 3} triangles (error ${d.error.toFixed(4)})`);
const dn = vertexNormals(d.pos, d.idx);
baked = unwrapAndBake({ pos: d.pos, idx: d.idx, normals: dn }, { pos: norm, normals: rawNrm, colour: vertexColours(rawUv, img), cell: 0.006 }, cfg.textureSize ?? 1024, { log });
if (cfg.textureGain) { // very dark sources (black assassin garb): stretch brightness so the dye shader and cosmetics have something to work with; detail stays in luminance
  const gm = cfg.textureGamma ?? 1;
  const ds = cfg.textureDesat ?? 0; // pull the colours toward their own brightness (strongly coloured sources, the sentinel's brown and gold): dyes then read as dyes, the engraving stays
  for (let i = 0; i < baked.rgba.length; i += 4) {
    const l = 0.2126 * baked.rgba[i] + 0.7152 * baked.rgba[i + 1] + 0.0722 * baked.rgba[i + 2];
    for (let k = 0; k < 3; k++) baked.rgba[i + k] = Math.min(255, 255 * Math.pow((baked.rgba[i + k] * (1 - ds) + l * ds) / 255, gm) * cfg.textureGain);
  }
}
jpg = encodeJpeg(baked.rgba, cfg.textureSize ?? 1024, cfg.textureSize ?? 1024, cfg.textureQuality ?? 88);
log(`baked ${baked.charts} charts, texture ${(jpg.length / 1024).toFixed(0)} KB`);

  if (cachePath) writeFileSync(cachePath, v8.serialize({ d, baked, jpg }));
}
// ---- 3. skin weights per welded node, then per output vertex
const sk = computeWeights(d.pos, d.idx, cfg);
const nv = baked.pos.length / 3;
const vJoints = new Uint8Array(nv * 4), vWeights = new Float32Array(nv * 4);
for (let i = 0; i < nv; i++) {
  const o = baked.origin[i];
  for (let k = 0; k < 4; k++) {
    vJoints[i * 4 + k] = sk.joints[o * 4 + k];
    vWeights[i * 4 + k] = sk.weights[o * 4 + k];
  }
}

// ---- 4. split into parts by region
const ntri = baked.idx.length / 3;
const partOfTri = new Array(ntri);
for (let t = 0; t < ntri; t++) {
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < 3; k++) {
    const v = baked.idx[t * 3 + k];
    x += baked.pos[v * 3] / 3; y += baked.pos[v * 3 + 1] / 3; z += baked.pos[v * 3 + 2] / 3;
  }
  partOfTri[t] = sk.partAt(x, y, z);
}
const partNames = ['body', 'head', 'shoulders', 'back'];
const tris = Object.fromEntries(partNames.map((p) => [p, []]));
// splitLegs: legs that touch (boots, skirts) get bridged by triangles that tear apart when they scissor: drop every triangle that joins a left-leg vertex to a right-leg one
const legSide = (v) => {
  let best = -1, bw = 0;
  for (let k = 0; k < 4; k++) if (vWeights[v * 4 + k] > bw) { bw = vWeights[v * 4 + k]; best = vJoints[v * 4 + k]; }
  const n = BONES[best]?.name ?? '';
  return /^(thigh|shin|foot)_l$/.test(n) ? 1 : /^(thigh|shin|foot)_r$/.test(n) ? -1 : 0;
};
const hipW = (v) => { let w = 0; for (let k = 0; k < 4; k++) if (BONES[vJoints[v * 4 + k]]?.name === 'hips') w += vWeights[v * 4 + k]; return w; };
// splitArms: arms that hang against the hips and the skirt are fused to them by the source mesh; when the arms swing up for a two-handed hold those joining triangles stretch into long shards.
// Drops every triangle that joins a forearm / hand vertex (or an upper-arm vertex below `splitArms` in height) to a hip, thigh or spine vertex.
const armSide = (v) => {
  let best = -1, bw = 0;
  for (let k = 0; k < 4; k++) if (vWeights[v * 4 + k] > bw) { bw = vWeights[v * 4 + k]; best = vJoints[v * 4 + k]; }
  const n = BONES[best]?.name ?? '';
  if (/^(forearm|hand)_[lr]$/.test(n)) return 1;
  if (/^upperarm_[lr]$/.test(n) && baked.pos[v * 3 + 1] < cfg.splitArms) return 1;
  return /^(hips|spine|thigh_[lr])$/.test(n) ? -1 : 0;
};
let dropped = 0, droppedArms = 0;
partOfTri.forEach((p, t) => {
  if (cfg.splitArms) {
    const sd = [0, 1, 2].map((k) => armSide(baked.idx[t * 3 + k]));
    if (sd.includes(1) && sd.includes(-1)) { droppedArms++; return; }
  }
  if (cfg.splitLegs) {
    const sd = [0, 1, 2].map((k) => legSide(baked.idx[t * 3 + k]));
    if (sd.includes(1) && sd.includes(-1)) { dropped++; return; }
    // the same for hanging cloth (hip-weighted below the hips) touching a boot: they are separate shells that the decimation fused
    const cloth = [0, 1, 2].map((k) => { const v = baked.idx[t * 3 + k]; return baked.pos[v * 3 + 1] < cfg.splitLegs && hipW(v) > 0.6; });
    if (cloth.includes(true) && sd.some((q) => q !== 0)) { dropped++; return; }
  }
  tris[p === 'shoulders_l' || p === 'shoulders_r' ? 'shoulders' : p].push(t);
});
if (dropped) log(`dropped ${dropped} triangles bridging the legs`);
if (droppedArms) log(`dropped ${droppedArms} triangles bridging the arms and the hips`);
// splitArms leaves bits of the gauntlet spikes (hip-weighted, they were fused to the skirt) floating beside the hips: small islands next to an arm go to that arm's forearm
if (cfg.splitArms) {
  const keep = partNames.flatMap((pn) => tris[pn]);
  const pk = (v) => [0, 1, 2].map((k) => Math.round(baked.pos[v * 3 + k] * 2000)).join(',');
  const ids = new Map(), rep = new Map();
  const repOf = (v) => { let k = rep.get(v); if (k === undefined) { const key = pk(v); if (!ids.has(key)) ids.set(key, ids.size); k = ids.get(key); rep.set(v, k); } return k; };
  const par = [];
  const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (const t of keep) for (let k = 0; k < 3; k++) { const r = repOf(baked.idx[t * 3 + k]); while (par.length <= r) par.push(par.length); }
  for (const t of keep) { const a = find(repOf(baked.idx[t * 3])); for (let k = 1; k < 3; k++) par[find(repOf(baked.idx[t * 3 + k]))] = a; }
  const comp = new Map();
  for (const t of keep) { const r = find(repOf(baked.idx[t * 3])); (comp.get(r) ?? comp.set(r, []).get(r)).push(t); }
  let moved = 0;
  for (const list of comp.values()) {
    if (list.length >= 60) continue;
    let cx = 0, cy = 0, n = 0;
    const vs = new Set();
    for (const t of list) for (let k = 0; k < 3; k++) { const v = baked.idx[t * 3 + k]; vs.add(v); cx += baked.pos[v * 3]; cy += baked.pos[v * 3 + 1]; n++; }
    cx /= n; cy /= n;
    if (Math.abs(cx) < 0.12 || cy < 0.25 || cy > 0.6) continue;
    const bone = BONES.findIndex((b) => b.name === `forearm_${cx > 0 ? 'l' : 'r'}`);
    for (const v of vs) { vJoints.set([bone, 0, 0, 0], v * 4); vWeights.set([1, 0, 0, 0], v * 4); }
    moved++;
  }
  if (moved) log(`${moved} loose gauntlet pieces follow the forearm`);
}
log('parts: ' + partNames.map((p) => `${p} ${tris[p].length}`).join(', '));

// ---- 5. write the GLB
const S = cfg.height ?? 2.25; // output height in game units
const wr = new GlbWriter();
const nodes = [];
const joints = BONES.map((b) => ({ ...b }));
const jpos = sk.jointPos; // normalised world position per bone
const boneIndex = Object.fromEntries(joints.map((b, i) => [b.name, i]));
joints.forEach((b, i) => {
  const p = b.parent ? jpos[boneIndex[b.parent]] : [0, 0, 0];
  const q = jpos[i];
  nodes.push({ name: b.name, translation: [(q[0] - p[0]) * S, (q[1] - p[1]) * S, (q[2] - p[2]) * S], children: [] });
});
joints.forEach((b, i) => b.parent && nodes[boneIndex[b.parent]].children.push(i));
// attach points (hands, head) as empty child nodes
const attach = {};
for (const [name, a] of Object.entries(cfg.attach ?? {})) {
  const bi = boneIndex[a.bone];
  const q = jpos[bi];
  nodes.push({ name, translation: [(a.at[0] - q[0]) * S, (a.at[1] - q[1]) * S, (a.at[2] - q[2]) * S] });
  nodes[bi].children.push(nodes.length - 1);
  attach[name] = a.bone;
}
const ibm = new Float32Array(joints.length * 16);
jpos.forEach((q, i) => {
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -q[0] * S, -q[1] * S, -q[2] * S, 1];
  ibm.set(m, i * 16);
});
const ibmAcc = wr.addAccessor(ibm, 'MAT4');
const imgView = wr.addBytes(jpg);
const meshes = [];
const sceneNodes = [0];
const skinIdx = 0;
const partsOut = {};
for (const part of partNames) {
  const list = tris[part];
  if (!list.length) continue;
  const remap = new Map();
  const P = [], N = [], U = [], J = [], W = [], I = [];
  for (const t of list) for (let k = 0; k < 3; k++) {
    const v = baked.idx[t * 3 + k];
    let m = remap.get(v);
    if (m === undefined) {
      m = P.length / 3;
      remap.set(v, m);
      P.push(baked.pos[v * 3] * S, baked.pos[v * 3 + 1] * S, baked.pos[v * 3 + 2] * S);
      N.push(baked.normals[v * 3], baked.normals[v * 3 + 1], baked.normals[v * 3 + 2]);
      U.push(baked.uv[v * 2], baked.uv[v * 2 + 1]);
      for (let c = 0; c < 4; c++) { J.push(vJoints[v * 4 + c]); W.push(vWeights[v * 4 + c]); }
    }
    I.push(m);
  }
  const prim = {
    attributes: {
      POSITION: wr.addAccessor(new Float32Array(P), 'VEC3', { target: 34962, minmax: true }),
      NORMAL: wr.addAccessor(new Float32Array(N), 'VEC3', { target: 34962 }),
      TEXCOORD_0: wr.addAccessor(new Float32Array(U), 'VEC2', { target: 34962 }),
      JOINTS_0: wr.addAccessor(new Uint8Array(J), 'VEC4', { target: 34962 }),
      WEIGHTS_0: wr.addAccessor(new Float32Array(W), 'VEC4', { target: 34962 }),
    },
    indices: wr.addAccessor(new Uint16Array(I), 'SCALAR', { target: 34963 }),
    material: 0,
  };
  meshes.push({ name: part, primitives: [prim] });
  nodes.push({ name: `part_${part}`, mesh: meshes.length - 1, skin: skinIdx });
  sceneNodes.push(nodes.length - 1);
  partsOut[part] = list.length;
}
nodes[0].extras = { rig: { height: S, tris: partsOut, ...sk.runtimeMeta(S), attach } };
const json = {
  asset: { version: '2.0', generator: 'scripts/rig-model.mjs' },
  scene: 0,
  scenes: [{ nodes: sceneNodes }],
  nodes,
  meshes,
  skins: [{ joints: joints.map((_, i) => i), inverseBindMatrices: ibmAcc, skeleton: 0 }],
  materials: [{ name: 'body', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0.15, roughnessFactor: 0.7 }, doubleSided: true }],
  textures: [{ source: 0, sampler: 0 }],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
  images: [{ bufferView: imgView, mimeType: 'image/jpeg' }],
};
const out = wr.build(json);
writeFileSync(outPath, out);
const total = Object.values(partsOut).reduce((a, b) => a + b, 0);
log(`wrote ${outPath}: ${total} triangles, ${(out.length / 1048576).toFixed(2)} MB`);

// ---- debug views: vertex colours by part / by dominant bone
if (debugPrefix) {
  const colourFile = (name, colourOf) => {
    const w2 = new GlbWriter();
    const C = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      const c = colourOf(i);
      C.set(c, i * 3);
    }
    const a = [
      w2.addAccessor(baked.pos, 'VEC3', { target: 34962, minmax: true }),
      w2.addAccessor(baked.normals, 'VEC3', { target: 34962 }),
      w2.addAccessor(C, 'VEC3', { target: 34962 }),
      w2.addAccessor(baked.idx, 'SCALAR', { target: 34963 }),
    ];
    const jsn = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, scale: [S, S, S] }], meshes: [{ primitives: [{ attributes: { POSITION: a[0], NORMAL: a[1], COLOR_0: a[2] }, indices: a[3], material: 0 }] }], materials: [{ pbrMetallicRoughness: { metallicFactor: 0 }, doubleSided: true }] };
    writeFileSync(`${debugPrefix}.${name}.glb`, w2.build(jsn));
  };
  const PC = { body: [0.55, 0.55, 0.55], head: [1, 0.3, 0.3], shoulders: [0.3, 1, 0.3], back: [0.3, 0.5, 1] };
  const vpart = new Array(nv).fill('body');
  partOfTri.forEach((p, t) => { for (let k = 0; k < 3; k++) vpart[baked.idx[t * 3 + k]] = p.startsWith('shoulders') ? 'shoulders' : p; });
  colourFile('parts', (i) => PC[vpart[i]]);
  const hue = (h) => {
    const f = (n) => { const k = (n + h * 12) % 12; return 0.6 - 0.4 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0), f(8), f(4)];
  };
  colourFile('weights', (i) => {
    const c = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const wgt = vWeights[i * 4 + k];
      const h = hue((vJoints[i * 4 + k] * 0.37) % 1);
      for (let q = 0; q < 3; q++) c[q] += h[q] * wgt;
    }
    return c;
  });
}
