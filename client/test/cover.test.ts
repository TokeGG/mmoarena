import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ARENAS, LOS_PEEK, hasLOS } from '@arena/shared';
import type { ArenaDef } from '@arena/shared';
import { unpackModel } from '../src/modelPack';
import { COVER_MAX, COVER_PROUD, scannedObelisk } from '../src/cover';
import { AUDIT_HEIGHTS, MAX_UNDER, RECT_TOL, auditArena, pillarPartsOf, pillarRow, radialReach, sectionAt } from '../src/coverAudit';

describe('cover: what you see is what blocks', () => {
  for (const a of ARENAS) {
    it(`${a.id}: every pillar, wall and low is drawn as wide as the shape that blocks`, () => {
      const r = auditArena(a);
      assert.deepEqual(r.problems, []);
      assert.equal(r.pillars.length, a.pillars.length * AUDIT_HEIGHTS.length);
    });
  }

  it('a pillar is a round shaft of its own radius at every height up to 2.5 yards (flare, taper and lean only above)', () => {
    for (const a of ARENAS)
      a.pillars.forEach((p, i) => {
        for (const y of AUDIT_HEIGHTS) {
          const row = pillarRow(a, i, y);
          assert.ok(row.over <= COVER_PROUD + 1e-6, `${a.id} pillar ${i} ${y}: ${row.outer.toFixed(2)} vs ${p.r}`);
          assert.ok(row.under <= MAX_UNDER + 1e-6, `${a.id} pillar ${i} ${y}: ${row.inner.toFixed(2)} vs ${p.r}`);
        }
      });
  });

  it('the audit notices a flare (so it cannot pass by measuring nothing)', () => {
    const a = ARENAS.find((x) => x.id === 'forge')!;
    const parts = pillarPartsOf(a, 0);
    const wide = parts.map((q) => (q.role === 'body' ? { ...q, geo: q.geo.clone().scale(1.3, 1, 1.3) } : q));
    assert.ok(pillarRow(a, 0, 0.5, wide).over > 0.3);
    const none = pillarRow(a, 0, 3.5, []);
    assert.equal(none.inner, 0);
  });

  it('sight agrees with the drawing at the edge of a pillar: the line is cut where the outline is (peek allowing)', () => {
    for (const id of ['forge', 'cinder', 'sandstone', 'colosseum', 'frost']) {
      const a = ARENAS.find((x) => x.id === id)!;
      a.pillars.forEach((p, i) => {
        const solo: ArenaDef = { ...a, pillars: [p], walls: [], lows: [], deck: undefined };
        const segs = sectionAt(pillarPartsOf(a, i).filter((q) => q.role === 'body'), 1.4);
        for (const ang of [0.3, 1.9, 3.4, 5.1]) {
          const dx = Math.cos(ang), dz = Math.sin(ang);
          const V = { x: p.x - dx * 10, z: p.z - dz * 10 };
          const target = (lat: number) => ({ x: p.x + dx * 30 - dz * lat * 4, z: p.z + dz * 30 + dx * lat * 4 }); // lat = offset where the line passes the centre
          // the drawn silhouette: the smallest lateral offset at which the V->target line misses the outline
          let drawn = 0;
          for (let lat = 0; lat < 4; lat += 0.01) {
            const T = target(lat);
            if (!segs.some(([x0, z0, x1, z1]) => segCross(V, T, { x: x0, z: z0 }, { x: x1, z: z1 }))) { drawn = lat; break; }
          }
          assert.ok(Math.abs(drawn - p.r) < 0.12, `${id} pillar ${i}: outline ends at ${drawn.toFixed(2)}, shape at ${p.r}`);
          // and the sim's sight line starts where the shape (less the peek a body gets) ends
          assert.ok(!hasLOS(V, target(p.r - LOS_PEEK - 0.06), solo), `${id} pillar ${i}: should be hidden`);
          assert.ok(hasLOS(V, target(p.r - LOS_PEEK + 0.06), solo), `${id} pillar ${i}: should be seen`);
        }
      });
    }
  });

  it('the scanned sandstone obelisk stands on its pedestal above head height and fits inside the circle', () => {
    const buf = Buffer.from(unpackModel(readFileSync(fileURLToPath(new URL('../public/models/arenas/sandstone.pak', import.meta.url)))));
    const jl = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'));
    const bin = buf.subarray(28 + jl, 28 + jl + buf.readUInt32LE(20 + jl));
    const a = ARENAS.find((x) => x.id === 'sandstone')!;
    for (const name of ['prop_obelisk_0', 'prop_obelisk_1']) {
      const node = json.nodes.find((n: any) => n.name === name);
      const acc = json.accessors[json.meshes[node.mesh].primitives[0].attributes.POSITION];
      const bv = json.bufferViews[acc.bufferView];
      let half = 0, minY = Infinity;
      for (let k = 0; k < acc.count; k++) {
        const o = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0) + k * (bv.byteStride ?? 12);
        half = Math.max(half, Math.hypot(bin.readFloatLE(o), bin.readFloatLE(o + 8)));
        minY = Math.min(minY, bin.readFloatLE(o + 4));
      }
      for (const p of a.pillars) {
        const at = scannedObelisk(p.r);
        assert.ok(at.y >= COVER_MAX, 'above head height');
        assert.ok(minY >= -1e-6, 'the piece starts at its foot');
        assert.ok(half * at.sx <= p.r * 0.6, `${name}: ${(half * at.sx).toFixed(2)} reaches past the pedestal (r ${p.r})`);
      }
    }
  });

  it('radialReach reads a plain circle back', () => {
    const segs = Array.from({ length: 64 }, (_, i): [number, number, number, number] => [Math.cos((i / 64) * 6.2832) * 2, Math.sin((i / 64) * 6.2832) * 2, Math.cos(((i + 1) / 64) * 6.2832) * 2, Math.sin(((i + 1) / 64) * 6.2832) * 2]);
    const r = radialReach(segs, 0, 0);
    assert.ok(Math.min(...r) > 1.99 && Math.max(...r) < 2.01);
    assert.ok(RECT_TOL > 0);
  });
});

function segCross(a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }, d: { x: number; z: number }) {
  const o = (p: typeof a, q: typeof a, r: typeof a) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
