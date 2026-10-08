// Reading a downloaded scene GLB into plain world-space meshes and cutting them up (scripts/prep-arena.mjs).
// A piece is { name, pos, nrm, uv, idx, material } with pos/nrm/uv Float32Arrays and idx Uint32Array, all in world space.
import { readGlbFile, readAccessor } from './glb.mjs';
import { decodePng, resize } from './png.mjs';
import { decodeJpeg } from './mesh.mjs';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';

const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const local = (n) => {
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

/** Every mesh primitive of the file in world space, with its node name and material index. */
export function loadScene(path) {
  const g = readGlbFile(path);
  const { json } = g;
  const parent = {};
  json.nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)));
  const world = (i) => (parent[i] === undefined ? local(json.nodes[i]) : mul(world(parent[i]), local(json.nodes[i])));
  const pieces = [];
  json.nodes.forEach((n, i) => {
    if (n.mesh === undefined) return;
    const m = world(i);
    json.meshes[n.mesh].primitives.forEach((p, k) => {
      const P = readAccessor(g, p.attributes.POSITION).data;
      const N = p.attributes.NORMAL !== undefined ? readAccessor(g, p.attributes.NORMAL).data : null;
      const U = p.attributes.TEXCOORD_0 !== undefined ? readAccessor(g, p.attributes.TEXCOORD_0).data : new Float32Array((P.length / 3) * 2);
      const idx = Uint32Array.from(readAccessor(g, p.indices).data);
      const pos = new Float32Array(P.length), nrm = new Float32Array(P.length);
      for (let v = 0; v < P.length; v += 3) {
        const x = P[v], y = P[v + 1], z = P[v + 2];
        pos[v] = m[0] * x + m[4] * y + m[8] * z + m[12];
        pos[v + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        pos[v + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        if (N) {
          const a = N[v], b = N[v + 1], c = N[v + 2];
          const nx = m[0] * a + m[4] * b + m[8] * c, ny = m[1] * a + m[5] * b + m[9] * c, nz = m[2] * a + m[6] * b + m[10] * c;
          const l = Math.hypot(nx, ny, nz) || 1;
          nrm[v] = nx / l; nrm[v + 1] = ny / l; nrm[v + 2] = nz / l;
        }
      }
      if (!N) recomputeNormals({ pos, nrm, idx });
      pieces.push({ name: `${n.name || 'node' + i}${json.meshes[n.mesh].primitives.length > 1 ? '.' + k : ''}`, pos, nrm, uv: Float32Array.from(U), idx, material: p.material ?? 0 });
    });
  });
  return { g, json, pieces };
}

export function recomputeNormals(p) {
  p.nrm.fill(0);
  for (let t = 0; t < p.idx.length; t += 3) {
    const [a, b, c] = [p.idx[t] * 3, p.idx[t + 1] * 3, p.idx[t + 2] * 3];
    const e1 = [p.pos[b] - p.pos[a], p.pos[b + 1] - p.pos[a + 1], p.pos[b + 2] - p.pos[a + 2]];
    const e2 = [p.pos[c] - p.pos[a], p.pos[c + 1] - p.pos[a + 1], p.pos[c + 2] - p.pos[a + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) p.nrm[v + k] += n[k];
  }
  for (let v = 0; v < p.nrm.length; v += 3) {
    const l = Math.hypot(p.nrm[v], p.nrm[v + 1], p.nrm[v + 2]) || 1;
    p.nrm[v] /= l; p.nrm[v + 1] /= l; p.nrm[v + 2] /= l;
  }
}

/** The decoded RGBA image of a material's texture slot ('base' | 'normal' | 'emissive'), or null. */
export function materialImage({ g, json }, matIndex, slot = 'base') {
  const m = json.materials[matIndex];
  const t = slot === 'base' ? m.pbrMetallicRoughness?.baseColorTexture : slot === 'normal' ? m.normalTexture : m.emissiveTexture;
  if (!t) return null;
  return imageByIndex({ g, json }, json.textures[t.index].source);
}
export function imageByIndex({ g, json }, imageIndex) {
  const im = json.images[imageIndex];
  const bv = json.bufferViews[im.bufferView];
  const bytes = g.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  const d = im.mimeType === 'image/png' ? decodePng(bytes) : decodeJpeg(bytes);
  return { data: new Uint8Array(d.data), width: d.width, height: d.height };
}
/** Resize to size x size RGBA ({ rgba, w, h } as the Pack wants it). */
export function sized(img, w, h = w) {
  const r = img.width === w && img.height === h ? img : resize(img, w, h);
  return { rgba: r.data, w, h };
}

export function bbox(p) {
  const mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30];
  for (let i = 0; i < p.pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p.pos[i + k]); mx[k] = Math.max(mx[k], p.pos[i + k]); }
  return { min: mn, max: mx, size: mx.map((v, k) => v - mn[k]), center: mx.map((v, k) => (v + mn[k]) / 2) };
}

/** Keep the triangles whose centroid passes `keep(cx, cy, cz)`; unused vertices are dropped. */
export function subset(p, keep) {
  const map = new Int32Array(p.pos.length / 3).fill(-1);
  const pos = [], nrm = [], uv = [], idx = [];
  const take = (v) => {
    if (map[v] < 0) {
      map[v] = pos.length / 3;
      pos.push(p.pos[v * 3], p.pos[v * 3 + 1], p.pos[v * 3 + 2]);
      nrm.push(p.nrm[v * 3], p.nrm[v * 3 + 1], p.nrm[v * 3 + 2]);
      uv.push(p.uv[v * 2], p.uv[v * 2 + 1]);
    }
    return map[v];
  };
  for (let t = 0; t < p.idx.length; t += 3) {
    const [a, b, c] = [p.idx[t], p.idx[t + 1], p.idx[t + 2]];
    const cx = (p.pos[a * 3] + p.pos[b * 3] + p.pos[c * 3]) / 3, cy = (p.pos[a * 3 + 1] + p.pos[b * 3 + 1] + p.pos[c * 3 + 1]) / 3, cz = (p.pos[a * 3 + 2] + p.pos[b * 3 + 2] + p.pos[c * 3 + 2]) / 3;
    if (keep(cx, cy, cz)) idx.push(take(a), take(b), take(c));
  }
  return { ...p, pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), uv: Float32Array.from(uv), idx: Uint32Array.from(idx) };
}

/** Triangles joined by shared positions form one component; returns the pieces, biggest first. */
export function components(p, eps = 1e-3) {
  const key = new Map();
  const parent = [];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const vid = new Int32Array(p.pos.length / 3);
  for (let v = 0; v < vid.length; v++) {
    const k = `${Math.round(p.pos[v * 3] / eps)},${Math.round(p.pos[v * 3 + 1] / eps)},${Math.round(p.pos[v * 3 + 2] / eps)}`;
    let id = key.get(k);
    if (id === undefined) { id = parent.length; parent.push(id); key.set(k, id); }
    vid[v] = id;
  }
  for (let t = 0; t < p.idx.length; t += 3) {
    const a = find(vid[p.idx[t]]);
    for (let k = 1; k < 3; k++) { const b = find(vid[p.idx[t + k]]); if (a !== b) parent[b] = a; }
  }
  const groups = new Map();
  for (let t = 0; t < p.idx.length; t += 3) {
    const r = find(vid[p.idx[t]]);
    if (!groups.has(r)) groups.set(r, new Set());
    groups.get(r).add(t);
  }
  return [...groups.values()].map((set) => cut(p, set)).sort((a, b) => b.idx.length - a.idx.length);
}
function cut(p, tris) {
  const t = [...tris].sort((a, b) => a - b);
  const idx = new Uint32Array(t.length * 3);
  t.forEach((s, i) => idx.set([p.idx[s], p.idx[s + 1], p.idx[s + 2]], i * 3));
  return subset({ ...p, idx }, () => true);
}

/** Merge pieces that share a material into one. */
export function merge(list) {
  const pos = [], nrm = [], uv = [], idx = [];
  let base = 0;
  for (const p of list) {
    pos.push(...p.pos); nrm.push(...p.nrm); uv.push(...p.uv);
    for (const i of p.idx) idx.push(i + base);
    base += p.pos.length / 3;
  }
  return { name: list[0].name, material: list[0].material, pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), uv: Float32Array.from(uv), idx: Uint32Array.from(idx) };
}

/** Apply (x, y, z) -> scale * R * (p - pivot) + offset with a plain function on positions; normals follow with `nfn`. */
export function transform(p, fn, nfn = (n) => n) {
  const pos = new Float32Array(p.pos.length), nrm = new Float32Array(p.nrm.length);
  for (let v = 0; v < pos.length; v += 3) {
    const q = fn([p.pos[v], p.pos[v + 1], p.pos[v + 2]]);
    pos.set(q, v);
    nrm.set(nfn([p.nrm[v], p.nrm[v + 1], p.nrm[v + 2]]), v);
  }
  return { ...p, pos, nrm };
}

/** Decimate keeping the UVs (they are attributes of the simplifier, so seams survive); then renormalise. */
export async function simplify(p, targetTris, { uvWeight = 1.5, error = 0.05 } = {}) {
  await MeshoptSimplifier.ready;
  if (p.idx.length / 3 <= targetTris) return p;
  const n = p.pos.length / 3;
  const attr = new Float32Array(n * 5);
  for (let v = 0; v < n; v++) {
    attr.set([p.uv[v * 2], p.uv[v * 2 + 1], p.nrm[v * 3], p.nrm[v * 3 + 1], p.nrm[v * 3 + 2]], v * 5);
  }
  const idx = new Uint32Array(p.idx);
  const pos = new Float32Array(p.pos);
  const [count] = MeshoptSimplifier.simplifyWithUpdate(idx, pos, 3, attr, 5, [uvWeight, uvWeight, 0.5, 0.5, 0.5], null, targetTris * 3, error, []);
  const used = idx.subarray(0, count);
  const out = { ...p, pos, nrm: new Float32Array(n * 3), uv: new Float32Array(n * 2), idx: used };
  for (let v = 0; v < n; v++) {
    out.uv.set([attr[v * 5], attr[v * 5 + 1]], v * 2);
    out.nrm.set([attr[v * 5 + 2], attr[v * 5 + 3], attr[v * 5 + 4]], v * 3);
  }
  return subset(out, () => true);
}

export const triCount = (p) => p.idx.length / 3;
