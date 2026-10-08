// Skeleton, region classification and smooth skin weights for the character rigging pipeline.
// Everything here works in normalised units: feet on y = 0, total height 1, x/z in fractions of the height, +x = character's left.

export const BONES = [
  { name: 'root', parent: null },
  { name: 'hips', parent: 'root' },
  { name: 'spine', parent: 'hips' },
  { name: 'chest', parent: 'spine' },
  { name: 'neck', parent: 'chest' },
  { name: 'head', parent: 'neck' },
  ...['l', 'r'].flatMap((s) => [
    { name: `shoulder_${s}`, parent: 'chest' },
    { name: `upperarm_${s}`, parent: `shoulder_${s}` },
    { name: `forearm_${s}`, parent: `upperarm_${s}` },
    { name: `hand_${s}`, parent: `forearm_${s}` },
    { name: `thigh_${s}`, parent: 'hips' },
    { name: `shin_${s}`, parent: `thigh_${s}` },
    { name: `foot_${s}`, parent: `shin_${s}` },
  ]),
];
const IDX = Object.fromEntries(BONES.map((b, i) => [b.name, i]));

const mirror = (p) => [-p[0], p[1], p[2]];

/** Does the point lie in a region shape? Shapes: { box: {x,y,z: [min,max], absX} } or { ellipsoid: {c, r} } (both may be mirrored with `mirror`). */
export function inShape(sh, x, y, z) {
  const test = (px) => {
    if (sh.box) {
      const b = sh.box;
      const xx = b.absX ? Math.abs(px) : px;
      return (!b.x || (xx >= b.x[0] && xx <= b.x[1])) && (!b.y || (y >= b.y[0] && y <= b.y[1])) && (!b.z || (z >= b.z[0] && z <= b.z[1]));
    }
    const e = sh.ellipsoid;
    return ((px - e.c[0]) / e.r[0]) ** 2 + ((y - e.c[1]) / e.r[1]) ** 2 + ((z - e.c[2]) / e.r[2]) ** 2 <= 1;
  };
  if (sh.ellipsoid?.mirror) return test(x) || test(-x);
  return test(x);
}

function distSeg(p, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz || 1e-9;
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2;
  t = Math.max(0, Math.min(1, t));
  const dx = p[0] - (a[0] + abx * t), dy = p[1] - (a[1] + aby * t), dz = p[2] - (a[2] + abz * t);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function computeWeights(pos, idx, cfg) {
  const J = cfg.joints;
  const jointPos = BONES.map((b) => {
    const side = b.name.endsWith('_r') ? -1 : 1;
    const base = b.name.replace(/_[lr]$/, '');
    const key = { root: null, hips: 'hips', spine: 'spine', chest: 'chest', neck: 'neck', head: 'head', shoulder: 'shoulder', upperarm: 'upperarm', forearm: 'forearm', hand: 'hand', thigh: 'thigh', shin: 'shin', foot: 'foot' }[base];
    if (!key) return [0, 0, 0];
    const p = J[key];
    return side < 0 ? mirror(p) : [...p];
  });
  const at = (n) => jointPos[IDX[n]];
  // capsule per bone: [bone, from, to, radius]
  const R = { hips: 0.1, spine: 0.1, chest: 0.12, neck: 0.04, head: 0.07, shoulder: 0.05, upperarm: 0.06, forearm: 0.05, hand: 0.045, thigh: 0.07, shin: 0.05, foot: 0.05, ...(cfg.radius ?? {}) };
  const caps = [
    ['hips', at('hips'), at('spine'), R.hips],
    ['spine', at('spine'), at('chest'), R.spine],
    ['chest', at('chest'), at('neck'), R.chest],
    ['neck', at('neck'), at('head'), R.neck],
    ['head', at('head'), J.headTop, R.head],
  ];
  for (const s of ['l', 'r']) {
    const m = s === 'r' ? mirror : (p) => p;
    caps.push([`shoulder_${s}`, at('chest'), at(`upperarm_${s}`), R.shoulder]);
    caps.push([`upperarm_${s}`, at(`upperarm_${s}`), at(`forearm_${s}`), R.upperarm]);
    caps.push([`forearm_${s}`, at(`forearm_${s}`), at(`hand_${s}`), R.forearm]);
    caps.push([`hand_${s}`, at(`hand_${s}`), m(J.handTip), R.hand]);
    caps.push([`thigh_${s}`, at(`thigh_${s}`), at(`shin_${s}`), R.thigh]);
    caps.push([`shin_${s}`, at(`shin_${s}`), at(`foot_${s}`), R.shin]);
    caps.push([`foot_${s}`, at(`foot_${s}`), m(J.toe), R.foot]);
  }
  const regions = cfg.regions ?? [];
  const partAt = (x, y, z) => {
    for (const r of regions) if (inShape(r, x, y, z)) return r.part === 'shoulders' ? (x >= 0 ? 'shoulders_l' : 'shoulders_r') : r.part;
    return 'body';
  };
  const cloth = cfg.cloth ?? [];
  const hipY = J.hips[1];
  const n = pos.length / 3;
  const src = new Float32Array(n * BONES.length); // soft assignment per node
  const isCloth = new Uint8Array(n);
  const sstep = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const p = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    p[0] = x; p[1] = y; p[2] = z;
    const part = partAt(x, y, z);
    const row = i * BONES.length;
    const cl = cloth.find((c) => inShape(c, x, y, z));
    if (cl) {
      isCloth[i] = 1;
      const follow = (cl.maxFollow ?? 0.5) * sstep(hipY, hipY - (cl.ramp ?? 0.12), y);
      const wl = sstep(-(cl.spread ?? 0.06), cl.spread ?? 0.06, x);
      src[row + IDX.thigh_l] = follow * wl;
      src[row + IDX.thigh_r] = follow * (1 - wl);
      src[row + IDX.hips] = 1 - follow;
      continue;
    }
    if (part === 'head') { src[row + IDX.head] = 1; continue; }
    if (part === 'shoulders_l' || part === 'shoulders_r') { src[row + IDX[part === 'shoulders_l' ? 'upperarm_l' : 'upperarm_r']] = 1; continue; }
    let best = 1e9, bi = 0;
    for (const [name, a, b, r] of caps) {
      const bone = IDX[name];
      // limbs only claim their own side of the body
      if (/_l$/.test(name) && x < -0.01) continue;
      if (/_r$/.test(name) && x > 0.01) continue;
      const d = distSeg(p, a, b) / r;
      if (d < best) { best = d; bi = bone; }
    }
    src[row + bi] = 1;
  }
  // ---- blur over the surface: geodesic Gaussian (edges of the welded mesh), so weights fade across joints and never leap across the air
  const adj = Array.from({ length: n }, () => []);
  for (let t = 0; t < idx.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = idx[t + e], b = idx[t + ((e + 1) % 3)];
    const l = Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
    adj[a].push([b, l]);
    adj[b].push([a, l]);
  }
  const sigma = cfg.smooth ?? 0.03;
  const maxD = sigma * 2.5;
  const NB = BONES.length;
  const W = new Float32Array(n * NB);
  const dist = new Float32Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    if (isCloth[i]) { W.set(src.subarray(i * NB, i * NB + NB), i * NB); continue; }
    const visited = [i];
    dist[i] = 0;
    const heap = [[0, i]];
    const acc = new Float64Array(NB);
    let sw = 0;
    while (heap.length) {
      // tiny binary heap pop
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          let l = 2 * k + 1, r = l + 1, m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[k], heap[m]] = [heap[m], heap[k]];
          k = m;
        }
      }
      const [d0, u] = top;
      if (d0 > dist[u]) continue;
      const g = Math.exp(-(d0 * d0) / (2 * sigma * sigma));
      for (let b = 0; b < NB; b++) acc[b] += g * src[u * NB + b];
      sw += g;
      for (const [v, l] of adj[u]) {
        const nd = d0 + l;
        if (nd < dist[v] && nd <= maxD) {
          if (dist[v] === Infinity) visited.push(v);
          dist[v] = nd;
          heap.push([nd, v]);
          let k = heap.length - 1;
          while (k > 0) {
            const pa = (k - 1) >> 1;
            if (heap[pa][0] <= heap[k][0]) break;
            [heap[pa], heap[k]] = [heap[k], heap[pa]];
            k = pa;
          }
        }
      }
    }
    for (const v of visited) dist[v] = Infinity;
    for (let b = 0; b < NB; b++) W[i * NB + b] = acc[b] / sw;
  }
  // ---- keep the 4 strongest influences
  const joints = new Uint8Array(n * 4), weights = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const order = Array.from({ length: NB }, (_, b) => b).sort((a, b) => W[i * NB + b] - W[i * NB + a]).slice(0, 4);
    let s = 0;
    for (const b of order) s += W[i * NB + b];
    order.forEach((b, k) => {
      const w = W[i * NB + b] / (s || 1);
      joints[i * 4 + k] = w > 0.01 ? b : 0;
      weights[i * 4 + k] = w > 0.01 ? w : 0;
    });
    let t = 0;
    for (let k = 0; k < 4; k++) t += weights[i * 4 + k];
    for (let k = 0; k < 4; k++) weights[i * 4 + k] = t ? weights[i * 4 + k] / t : k === 0 ? 1 : 0;
    if (!t) joints[i * 4] = IDX.hips;
  }
  const runtimeMeta = (S) => {
    const scale = (v) => (Array.isArray(v) ? v.map(scale) : typeof v === 'number' ? v * S : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scale(x)])) : v);
    return { ...scale(cfg.runtime ?? {}), ...(cfg.runtimeRaw ?? {}) };
  };
  return { joints, weights, jointPos, partAt, runtimeMeta };
}
