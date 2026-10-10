/**
 * The Abyssal Sentinel's mesh came with the right arm held straight out to the side with an open claw (the left arm points forward),
 * so a staff put in the right fist floated beside him. This turns the right arm's skin (every vertex, weighted by how much it follows
 * upperarm_r / forearm_r / hand_r) about the shoulder joint until it points forward like the mirror of the left arm, and moves
 * `attach_hand_r` (where weapons are held) onto the palm. Edits client/public/models/priest.pak in place; running it twice is a no-op.
 *   npx tsx scripts/fix-priest-arm.ts [in.pak out.pak]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore
import { parseGlb, readAccessor } from './lib/glb.mjs';
import { packModel, unpackModel } from '../client/src/modelPack';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const inFile = process.argv[2] ?? path.join(root, 'client/public/models/priest.pak');
const outFile = process.argv[3] ?? inFile;
const glbIn = Buffer.from(unpackModel(fs.readFileSync(inFile)));
const g = parseGlb(glbIn);
const { json, bin } = g;
if (json.nodes[0].extras?.rig?.armPosed) {
  console.log('already posed');
  process.exit(0);
}
const joints: string[] = json.skins[0].joints.map((i: number) => json.nodes[i].name);
const jIdx = (n: string) => joints.indexOf(n);
const armR = new Set(['upperarm_r', 'forearm_r', 'hand_r'].map(jIdx));
const armL = new Set(['upperarm_l', 'forearm_l', 'hand_l'].map(jIdx));
const nodeByName = (n: string) => json.nodes.findIndex((x: any) => x.name === n);
const parent: Record<number, number> = {};
json.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => (parent[c] = i)));
const world = (i: number): number[] => {
  const t = json.nodes[i].translation ?? [0, 0, 0];
  const p = parent[i] !== undefined ? world(parent[i]) : [0, 0, 0];
  return [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
};
const pivot = world(nodeByName('upperarm_r'));
const pivotL = world(nodeByName('upperarm_l'));

type Prim = { P: Float32Array; N: Float32Array; J: ArrayLike<number>; W: ArrayLike<number>; pAcc: any; nAcc: any };
const prims: Prim[] = [];
for (const m of json.meshes) for (const p of m.primitives) {
  prims.push({
    P: readAccessor(g, p.attributes.POSITION).data, N: readAccessor(g, p.attributes.NORMAL).data,
    J: readAccessor(g, p.attributes.JOINTS_0).data, W: readAccessor(g, p.attributes.WEIGHTS_0).data,
    pAcc: p.attributes.POSITION, nAcc: p.attributes.NORMAL,
  });
}
const weight = (pr: Prim, i: number, set: Set<number>) => {
  let w = 0;
  for (let k = 0; k < 4; k++) if (set.has(pr.J[i * 4 + k])) w += pr.W[i * 4 + k];
  return Math.min(1, w);
};
// where each hand is: the weighted centre of the vertices on the outer end of the arm
const centroid = (set: Set<number>, sign: 1 | -1, minOut: number, minW = 0.5) => {
  const c = [0, 0, 0];
  let n = 0;
  for (const pr of prims) for (let i = 0; i < pr.P.length / 3; i++) {
    const w = weight(pr, i, set);
    if (w < minW || pr.P[i * 3] * sign < minOut) continue;
    for (let a = 0; a < 3; a++) c[a] += pr.P[i * 3 + a];
    n++;
  }
  return c.map((x) => x / n);
};
const handR = centroid(armR, -1, 0.62);
const handL = centroid(new Set([jIdx('hand_l')]), 1, 0.3, 0.15);
// the left fist, mirrored, is where the right one belongs
const target = [-handL[0], handL[1], handL[2]];
const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const from = sub(handR, pivot), to = sub(target, pivot);
const a = from.map((x) => x / len(from)), b = to.map((x) => x / len(to));
let axis = cross(a, b);
const sin = len(axis);
axis = axis.map((x) => x / sin);
const angle = Math.atan2(sin, dot(a, b));
const scale = Math.min(1, len(to) / len(from));
console.log('pivot', pivot, 'handR', handR, 'handL', handL, 'turn', ((angle * 180) / Math.PI).toFixed(1), 'deg, scale', scale.toFixed(3));
const rot = (v: number[]) => {
  // Rodrigues
  const c = Math.cos(angle), s = Math.sin(angle), k = axis, kv = dot(k, v), kx = cross(k, v);
  return [0, 1, 2].map((i) => v[i] * c + kx[i] * s + k[i] * kv * (1 - c));
};
const roll = Number(process.env.ROLL ?? 0); // extra turn about the new arm direction (radians)
const rollRot = (v: number[]) => {
  const c = Math.cos(roll), s = Math.sin(roll), k = b, kv = dot(k, v), kx = cross(k, v);
  return [0, 1, 2].map((i) => v[i] * c + kx[i] * s + k[i] * kv * (1 - c));
};
const move = (v: number[]) => rollRot(rot(v.map((x, i) => x - pivot[i]).map((x) => x * scale))).map((x, i) => x + pivot[i]);
for (const pr of prims) {
  for (let i = 0; i < pr.P.length / 3; i++) {
    const w = weight(pr, i, armR);
    if (w <= 0) continue;
    const p = [pr.P[i * 3], pr.P[i * 3 + 1], pr.P[i * 3 + 2]];
    const q = move(p);
    for (let k = 0; k < 3; k++) pr.P[i * 3 + k] = p[k] + (q[k] - p[k]) * w;
    const n = [pr.N[i * 3], pr.N[i * 3 + 1], pr.N[i * 3 + 2]];
    const nq = rollRot(rot(n));
    const m = [0, 1, 2].map((k) => n[k] + (nq[k] - n[k]) * w);
    const l = len(m) || 1;
    for (let k = 0; k < 3; k++) pr.N[i * 3 + k] = m[k] / l;
  }
}
// write the vertex data back into the BIN chunk
const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
let pi = 0;
for (const m of json.meshes) for (const p of m.primitives) {
  const pr = prims[pi++];
  for (const [attr, arr] of [['POSITION', pr.P], ['NORMAL', pr.N]] as const) {
    const acc = json.accessors[p.attributes[attr]], view = json.bufferViews[acc.bufferView];
    const stride = view.byteStride || 12, base = (view.byteOffset || 0) + (acc.byteOffset || 0);
    for (let i = 0; i < acc.count; i++) for (let k = 0; k < 3; k++) dv.setFloat32(base + i * stride + k * 4, arr[i * 3 + k], true);
    if (attr === 'POSITION') {
      const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
      for (let i = 0; i < acc.count; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], arr[i * 3 + k]); mx[k] = Math.max(mx[k], arr[i * 3 + k]); }
      acc.min = mn; acc.max = mx;
    }
  }
}
// the palm: where weapons are held
const palm = move(handR);
const hi = nodeByName('hand_r'), ai = nodeByName('attach_hand_r');
const hw = world(hi);
const PALM_BACK = Number(process.env.PALM_BACK ?? 0);
json.nodes[ai].translation = [palm[0] - hw[0], palm[1] - hw[1], palm[2] - hw[2] + PALM_BACK];
console.log('palm', palm.map((x) => +x.toFixed(3)));
json.nodes[0].extras.rig.armPosed = true;
// rebuild the GLB
const pad = (buf: Buffer, byte: number) => Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4, byte)]);
const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
const binChunk = pad(Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength), 0);
const head = Buffer.alloc(12);
head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const ch = (len: number, type: number) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.writeUInt32LE(type, 4); return h; };
const out = Buffer.concat([head, ch(jsonChunk.length, 0x4e4f534a), jsonChunk, ch(binChunk.length, 0x004e4942), binChunk]);
fs.writeFileSync(outFile, packModel(out));
console.log('wrote', outFile);
