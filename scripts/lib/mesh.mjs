// Mesh helpers for the character rigging pipeline: welding, decimation, UV re-unwrapping and texture baking.
// Plain arrays/typed arrays, no dependencies besides meshoptimizer (decimation) and jpeg-js (textures).
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import jpeg from 'jpeg-js';

/** Merge vertices that sit at the same position (UV and normal seams). Returns welded positions and indices (degenerate triangles dropped). */
export function weld(pos, idx, eps = 1e-6) {
  const map = new Map();
  const out = [];
  const remap = new Uint32Array(pos.length / 3);
  const q = (v) => Math.round(v / eps);
  for (let i = 0; i < remap.length; i++) {
    const key = `${q(pos[i * 3])},${q(pos[i * 3 + 1])},${q(pos[i * 3 + 2])}`;
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      map.set(key, id);
      out.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    }
    remap[i] = id;
  }
  const ind = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = remap[idx[t]], b = remap[idx[t + 1]], c = remap[idx[t + 2]];
    if (a !== b && b !== c && a !== c) ind.push(a, b, c);
  }
  return { pos: new Float32Array(out), idx: new Uint32Array(ind) };
}

/** Drop unused vertices and renumber. */
export function compact(pos, idx) {
  const map = new Int32Array(pos.length / 3).fill(-1);
  const out = [];
  const ind = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    let m = map[idx[i]];
    if (m < 0) {
      m = out.length / 3;
      map[idx[i]] = m;
      out.push(pos[idx[i] * 3], pos[idx[i] * 3 + 1], pos[idx[i] * 3 + 2]);
    }
    ind[i] = m;
  }
  return { pos: new Float32Array(out), idx: ind };
}

/** Geometry-only decimation (no UVs: those are rebuilt afterwards), toward `targetTris` triangles. */
export async function decimate(pos, idx, targetTris, { error = 1, flags = [] } = {}) {
  await MeshoptSimplifier.ready;
  const ind = new Uint32Array(idx);
  const p = new Float32Array(pos);
  const [n, err] = MeshoptSimplifier.simplifyWithUpdate(ind, p, 3, new Float32Array(0), 0, [], null, targetTris * 3, error, flags);
  const r = compact(p, ind.subarray(0, n));
  return { ...r, error: err };
}

/** Area-weighted smooth vertex normals. */
export function vertexNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      n[i] += nx;
      n[i + 1] += ny;
      n[i + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}

export function decodeJpeg(bytes) {
  return jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
}
export function encodeJpeg(rgba, w, h, quality) {
  return jpeg.encode({ data: rgba, width: w, height: h }, quality).data;
}

function bilinear(img, u, v, out) {
  const x = Math.min(Math.max(u * img.width - 0.5, 0), img.width - 1.001);
  const y = Math.min(Math.max(v * img.height - 0.5, 0), img.height - 1.001);
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  for (let c = 0; c < 3; c++) {
    const g = (xx, yy) => img.data[(yy * img.width + xx) * 4 + c];
    out[c] = (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
  }
}

/**
 * Re-unwrap a decimated mesh and bake the original texture onto it. The source atlas is split into thousands of tiny
 * islands, which breaks as soon as the mesh is decimated (collapsing across a seam smears the texture), so instead the
 * decimated mesh gets fresh UVs (normal-clustered planar charts, shelf-packed) and every new texel takes its colour from
 * the nearest vertices of the original, high-poly surface.
 */
export function unwrapAndBake({ pos, idx, normals }, src, size, { maxAngleDeg = 50, maxChart = 0.22, pad = 3, log = () => {} } = {}) {
  const ntri = idx.length / 3;
  // ---- face data and adjacency
  const fn = new Float32Array(ntri * 3);
  const area = new Float32Array(ntri);
  for (let t = 0; t < ntri; t++) {
    const [a, b, c] = [idx[t * 3] * 3, idx[t * 3 + 1] * 3, idx[t * 3 + 2] * 3];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    area[t] = l / 2;
    fn[t * 3] = nx / l;
    fn[t * 3 + 1] = ny / l;
    fn[t * 3 + 2] = nz / l;
  }
  const edgeMap = new Map();
  const nbr = Array.from({ length: ntri }, () => []);
  for (let t = 0; t < ntri; t++) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t * 3 + e], b = idx[t * 3 + ((e + 1) % 3)];
      const key = a < b ? a * 4194304 + b : b * 4194304 + a;
      const o = edgeMap.get(key);
      if (o === undefined) edgeMap.set(key, t);
      else {
        nbr[t].push(o);
        nbr[o].push(t);
      }
    }
  }
  // ---- charts: grow from the biggest unassigned triangle while the faces stay within the angle of the chart's mean normal
  const cosT = Math.cos((maxAngleDeg * Math.PI) / 180);
  const chartOf = new Int32Array(ntri).fill(-1);
  const order = Array.from({ length: ntri }, (_, i) => i).sort((a, b) => area[b] - area[a]);
  const charts = [];
  for (const seed of order) {
    if (chartOf[seed] >= 0) continue;
    const id = charts.length;
    const tris = [seed];
    chartOf[seed] = id;
    let mx = fn[seed * 3] * area[seed], my = fn[seed * 3 + 1] * area[seed], mz = fn[seed * 3 + 2] * area[seed];
    let ml = Math.hypot(mx, my, mz) || 1;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const grow = (t) => {
      for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) {
        const v = pos[idx[t * 3 + k] * 3 + c];
        lo[c] = Math.min(lo[c], v);
        hi[c] = Math.max(hi[c], v);
      }
    };
    grow(seed);
    for (let q = 0; q < tris.length; q++) {
      for (const o of nbr[tris[q]]) {
        if (chartOf[o] >= 0) continue;
        const d = (fn[o * 3] * mx + fn[o * 3 + 1] * my + fn[o * 3 + 2] * mz) / ml;
        if (d < cosT || fn[o * 3] * fn[tris[q] * 3] + fn[o * 3 + 1] * fn[tris[q] * 3 + 1] + fn[o * 3 + 2] * fn[tris[q] * 3 + 2] < 0.5) continue;
        const sav = [...lo, ...hi];
        grow(o);
        if (Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) > maxChart) {
          lo[0] = sav[0]; lo[1] = sav[1]; lo[2] = sav[2]; hi[0] = sav[3]; hi[1] = sav[4]; hi[2] = sav[5];
          continue;
        }
        chartOf[o] = id;
        tris.push(o);
        mx += fn[o * 3] * area[o];
        my += fn[o * 3 + 1] * area[o];
        mz += fn[o * 3 + 2] * area[o];
        ml = Math.hypot(mx, my, mz) || 1;
      }
    }
    charts.push({ tris, n: [mx / ml, my / ml, mz / ml] });
  }
  // ---- planar projection per chart, new vertices per (chart, vertex)
  const outPos = [], outNrm = [], outUv = [], outIdx = [], outOrigin = [];
  const rects = [];
  for (const ch of charts) {
    const n = ch.n;
    const up = Math.abs(n[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
    let ux = up[1] * n[2] - up[2] * n[1], uy = up[2] * n[0] - up[0] * n[2], uz = up[0] * n[1] - up[1] * n[0];
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = n[1] * uz - n[2] * uy, vy = n[2] * ux - n[0] * uz, vz = n[0] * uy - n[1] * ux;
    const local = new Map();
    const verts = [];
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const t of ch.tris) for (let k = 0; k < 3; k++) {
      const vi = idx[t * 3 + k];
      if (!local.has(vi)) {
        const x = pos[vi * 3], y = pos[vi * 3 + 1], z = pos[vi * 3 + 2];
        const u = x * ux + y * uy + z * uz, v = x * vx + y * vy + z * vz;
        local.set(vi, verts.length);
        verts.push({ vi, u, v });
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
    }
    ch.verts = verts;
    ch.local = local;
    ch.u0 = u0;
    ch.v0 = v0;
    rects.push({ ch, w: u1 - u0, h: v1 - v0 });
  }
  // ---- shelf packing; binary search the largest world->texel scale that fits
  const tryPack = (scale) => {
    const sorted = [...rects].sort((a, b) => b.h - a.h);
    let x = 0, y = 0, rowH = 0;
    for (const r of sorted) {
      const w = Math.ceil(r.w * scale) + pad * 2 + 1, h = Math.ceil(r.h * scale) + pad * 2 + 1;
      if (x + w > size) {
        x = 0;
        y += rowH;
        rowH = 0;
      }
      if (y + h > size || w > size) return false;
      r.px = x + pad;
      r.py = y + pad;
      x += w;
      rowH = Math.max(rowH, h);
    }
    return true;
  };
  let lo = 10, hi = 20000;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (tryPack(mid)) lo = mid;
    else hi = mid;
  }
  const scale = lo * 0.995;
  if (!tryPack(scale)) throw new Error('atlas packing failed');
  log(`charts ${charts.length}, texel size ${(2000 / scale).toFixed(2)} mm per texel on a 2 m character`);
  for (const { ch, px, py } of rects) {
    const base = outPos.length / 3;
    for (const v of ch.verts) {
      outOrigin.push(v.vi);
      outPos.push(pos[v.vi * 3], pos[v.vi * 3 + 1], pos[v.vi * 3 + 2]);
      outNrm.push(normals[v.vi * 3], normals[v.vi * 3 + 1], normals[v.vi * 3 + 2]);
      outUv.push(px + (v.u - ch.u0) * scale, py + (v.v - ch.v0) * scale); // in texels for now
    }
    for (const t of ch.tris) for (let k = 0; k < 3; k++) outIdx.push(base + ch.local.get(idx[t * 3 + k]));
  }
  const P = new Float32Array(outPos), N = new Float32Array(outNrm), UV = new Float32Array(outUv), I = new Uint32Array(outIdx);
  // keep the winding of the source (the projection may mirror a chart): flip triangles whose UV winding disagrees with the 3D normal
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const ax = UV[b * 2] - UV[a * 2], ay = UV[b * 2 + 1] - UV[a * 2 + 1], bx = UV[c * 2] - UV[a * 2], by = UV[c * 2 + 1] - UV[a * 2 + 1];
    const cross2 = ax * by - ay * bx;
    // the chart basis is right-handed (u, v, n), so a front-facing triangle is counter-clockwise in (u, v)
    if (cross2 < 0) throw new Error('unexpected UV winding');
  }
  // ---- bake: rasterise each triangle, look each texel's 3D point up on the original surface
  const grid = buildGrid(src.pos, src.cell ?? 0.006);
  const rgb = new Uint8Array(size * size * 4);
  const covered = new Uint8Array(size * size);
  const bc = new Float64Array(3);
  const sampleAt = (x, y, z, nx, ny, nz, out) => nearestColour(grid, src, x, y, z, nx, ny, nz, out);
  const col = [0, 0, 0];
  for (const pass of [0, 1]) {
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      const ax = UV[a * 2], ay = UV[a * 2 + 1], bx = UV[b * 2], by = UV[b * 2 + 1], cx = UV[c * 2], cy = UV[c * 2 + 1];
      const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(den) < 1e-9) continue;
      const m = pass === 0 ? 1.6 : 0;
      const minx = Math.max(0, Math.floor(Math.min(ax, bx, cx) - m)), maxx = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx) + m));
      const miny = Math.max(0, Math.floor(Math.min(ay, by, cy) - m)), maxy = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy) + m));
      for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
        const o = y * size + x;
        if (pass === 0 ? covered[o] : covered[o] === 2) continue;
        const px = x + 0.5, py = y + 0.5;
        let w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
        let w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
        let w2 = 1 - w0 - w1;
        const inside = w0 >= 0 && w1 >= 0 && w2 >= 0;
        if (pass === 1 && !inside) continue;
        if (pass === 0 && !inside) {
          // padding ring: clamp onto the triangle, but only within ~1.5 texels of it
          w0 = Math.max(0, w0); w1 = Math.max(0, w1); w2 = Math.max(0, w2);
          const s = w0 + w1 + w2 || 1;
          w0 /= s; w1 /= s; w2 /= s;
        }
        bc[0] = w0; bc[1] = w1; bc[2] = w2;
        const X = P[a * 3] * w0 + P[b * 3] * w1 + P[c * 3] * w2, Y = P[a * 3 + 1] * w0 + P[b * 3 + 1] * w1 + P[c * 3 + 1] * w2, Z = P[a * 3 + 2] * w0 + P[b * 3 + 2] * w1 + P[c * 3 + 2] * w2;
        const NX = N[a * 3] * w0 + N[b * 3] * w1 + N[c * 3] * w2, NY = N[a * 3 + 1] * w0 + N[b * 3 + 1] * w1 + N[c * 3 + 1] * w2, NZ = N[a * 3 + 2] * w0 + N[b * 3 + 2] * w1 + N[c * 3 + 2] * w2;
        sampleAt(X, Y, Z, NX, NY, NZ, col);
        rgb[o * 4] = col[0]; rgb[o * 4 + 1] = col[1]; rgb[o * 4 + 2] = col[2]; rgb[o * 4 + 3] = 255;
        covered[o] = pass === 0 ? 1 : 2;
      }
    }
  }
  // fill what no triangle touches (so mip levels do not bleed black): grow the covered colours outwards
  for (let it = 0; it < 6; it++) {
    const next = Uint8Array.from(covered);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const o = y * size + x;
      if (covered[o]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
        const q = yy * size + xx;
        if (!covered[q]) continue;
        r += rgb[q * 4]; g += rgb[q * 4 + 1]; b += rgb[q * 4 + 2]; n++;
      }
      if (n) {
        rgb[o * 4] = r / n; rgb[o * 4 + 1] = g / n; rgb[o * 4 + 2] = b / n; rgb[o * 4 + 3] = 255;
        next[o] = 1;
      }
    }
    covered.set(next);
  }
  for (let o = 0; o < size * size; o++) if (!covered[o]) { rgb[o * 4] = 40; rgb[o * 4 + 1] = 40; rgb[o * 4 + 2] = 40; rgb[o * 4 + 3] = 255; }
  for (let i = 0; i < UV.length; i += 2) {
    UV[i] /= size;
    UV[i + 1] /= size;
  }
  return { pos: P, normals: N, uv: UV, idx: I, rgba: rgb, charts: charts.length, origin: new Uint32Array(outOrigin) };
}

// ---- nearest-colour lookup on the original surface (uniform hash grid over its vertices)
function buildGrid(pos, cell) {
  const cells = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  for (let i = 0; i < pos.length / 3; i++) {
    const k = key(Math.floor(pos[i * 3] / cell), Math.floor(pos[i * 3 + 1] / cell), Math.floor(pos[i * 3 + 2] / cell));
    let l = cells.get(k);
    if (!l) cells.set(k, (l = []));
    l.push(i);
  }
  return { cells, cell, key };
}

function nearestColour(grid, src, x, y, z, nx, ny, nz, out) {
  const { cells, cell, key } = grid;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
  let best = [];
  for (let r = 1; r <= 4; r++) {
    best = [];
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r && r > 1) continue;
      const l = cells.get(key(cx + dx, cy + dy, cz + dz));
      if (!l) continue;
      for (const i of l) {
        const d = (src.pos[i * 3] - x) ** 2 + (src.pos[i * 3 + 1] - y) ** 2 + (src.pos[i * 3 + 2] - z) ** 2;
        const dot = src.normals[i * 3] * nx + src.normals[i * 3 + 1] * ny + src.normals[i * 3 + 2] * nz;
        // surfaces facing the other way (the far side of a thin cloth) must not lend their colour
        best.push([d + (dot < 0.2 ? 4 * cell * cell : 0), i]);
      }
    }
    if (best.length >= 3) break;
  }
  if (!best.length) {
    out[0] = out[1] = out[2] = 40;
    return;
  }
  best.sort((a, b) => a[0] - b[0]);
  const lim = best[0][0] * 2.5 + 0.01 * cell * cell;
  let r = 0, g = 0, b = 0, sw = 0;
  for (let k = 0; k < Math.min(4, best.length); k++) {
    if (best[k][0] > lim) break;
    const w = 1 / (best[k][0] + 0.05 * cell * cell);
    const i = best[k][1];
    r += src.colour[i * 3] * w; g += src.colour[i * 3 + 1] * w; b += src.colour[i * 3 + 2] * w; sw += w;
  }
  out[0] = r / sw; out[1] = g / sw; out[2] = b / sw;
}

/** Per-vertex colours of the source mesh, sampled from its texture. */
export function vertexColours(uv, img) {
  const out = new Float32Array((uv.length / 2) * 3);
  const c = [0, 0, 0];
  for (let i = 0; i < uv.length / 2; i++) {
    bilinear(img, uv[i * 2], uv[i * 2 + 1], c);
    out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2];
  }
  return out;
}
