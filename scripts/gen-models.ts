// Writes shared/data/models.json from what the code says today: the pose, style, helm, cape and wing numbers of every character
// model, how every weapon sits in the hands and a neutral placement for every kind of cosmetic. Angles are written in degrees.
// Run once to start the file; numbers already in it are kept (`--fresh` writes it all again from the code).
import { readFileSync, writeFileSync } from 'node:fs';
import { BONE_NAMES, COSMETIC_SLOTS } from '../shared/src/index';
import { NEUTRAL_PART } from '../shared/src/index';
import type { BoneAdjust, PartFit, CharacterData, ModelsFile, SlotData, Triple, WeaponData } from '../shared/src/index';
import { codeDefaults } from '../client/src/modelData';

const path = new URL('../shared/data/models.json', import.meta.url);
const fresh = process.argv.includes('--fresh');
let old: ModelsFile = { characters: {}, weapons: {}, cosmetics: {} };
if (!fresh) {
  try {
    old = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    /* first run */
  }
}
const d = codeDefaults();
const round = (n: number) => Math.round(n * 1000) / 1000;
const deg = (r: number) => round((r * 180) / Math.PI);
const tri = (a: number[], f = deg): Triple => [f(a[0] ?? 0), f(a[1] ?? 0), f(a[2] ?? 0)];

const characters: Record<string, CharacterData> = {};
for (const [id, m] of Object.entries(d.characters)) {
  const c: CharacterData = {};
  if (!m.clips) {
    c.pose = {};
    for (const [k, v] of Object.entries(m.pose ?? {})) if (typeof v === 'number') c.pose[k] = ['stride', 'rightSwing'].includes(k) ? round(v) : deg(v);
    for (const [k, def] of Object.entries({ armRest: -0.12, elbow: 0.15, armIn: 0, legIn: 0, stride: 0.62, rightSwing: 1, castR: -1.4, castL: -1.25, swingArc: -2.5 })) if (!(k in c.pose)) c.pose[k] = ['stride', 'rightSwing'].includes(k) ? def : deg(def);
    c.style = { bounce: 1, sway: 1, lean: 1, crouch: 0, arms: 1, guard: 0, landing: 1, tuck: 1, float: 0 };
    for (const [k, v] of Object.entries(m.style ?? {})) if (typeof v === 'number') c.style[k] = round(v);
    c.bones = {};
    for (const b of BONE_NAMES) c.bones[b] = old.characters[id]?.bones?.[b] ?? ({ rx: 0, ry: 0, rz: 0, size: 1 } satisfies BoneAdjust);
  }
  c.body = { file: '' };
  if (!m.clips) c.anims = { stand: '', walk: '', run: '', swing: '', cast: '', jump: '', ...(old.characters[id]?.anims ?? {}) };
  c.parts = {};
  for (const b of BONE_NAMES) c.parts[b] = old.characters[id]?.parts?.[b] ?? ({ ...NEUTRAL_PART } satisfies PartFit);
  if (m.helm) c.helm = { ...m.helm };
  c.cape = Object.fromEntries(Object.entries(m.cape).map(([k, v]) => [k, round(v)]));
  c.wings = Object.fromEntries(Object.entries(m.wings).map(([k, v]) => [k, round(v)]));
  characters[id] = { ...c, ...(old.characters[id] ?? {}) };
}
const weapons: Record<string, WeaponData> = {};
for (const [id, w] of Object.entries(d.weapons)) {
  const hand = (h: { rot: number[]; pos?: number[]; lift?: number; out?: number }) => ({ rot: tri(h.rot), pos: tri(h.pos ?? [0, 0, 0], round), lift: deg(h.lift ?? 0), out: deg(h.out ?? 0) });
  const e: WeaponData = { file: '', right: hand(w.right), mid: round(w.mid) };
  if (w.left) e.left = hand(w.left);
  if (w.hold) e.hold = { r: tri([w.hold.r.x, w.hold.r.z, w.hold.r.e]), l: tri([w.hold.l.x, w.hold.l.z, w.hold.l.e]), walk: round(w.hold.walk), arc: round(w.hold.arc), elbowArc: round(w.hold.elbowArc ?? 1) };
  if (w.rest) e.rest = { rot: tri(w.rest.rot) };
  weapons[id] = { ...e, ...(old.weapons[id] ?? {}), file: old.weapons[id]?.file ?? '' };
}
const cosmetics: Record<string, SlotData> = {};
for (const s of COSMETIC_SLOTS) cosmetics[s] = old.cosmetics[s] ?? { x: 0, y: 0, z: 0, scale: 1, rotY: 0 };
writeFileSync(path, JSON.stringify({ characters, weapons, cosmetics }, null, 1) + '\n');
console.log(`wrote ${Object.keys(characters).length} characters, ${Object.keys(weapons).length} weapons, ${Object.keys(cosmetics).length} cosmetic slots`);
