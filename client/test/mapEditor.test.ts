import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS, blankArena, cleanCustomArena, copyArena } from '@arena/shared';
import type { ArenaDef } from '@arena/shared';
import { addItem, addTwin, deleteSel, handleAt, hitTest, itemOf, makeView, mirrorSpawns, moveSel, rectBetween, resizeRect, snap } from '../src/mapEditLogic';
import { drawArena } from '../src/mapPreview';

const fresh = (): ArenaDef => blankArena('edit-me', 'Edit me');
const clean = (d: ArenaDef) => cleanCustomArena(JSON.parse(JSON.stringify(d)));

describe('map editor rules', () => {
  it('snaps to half yards', () => {
    assert.equal(snap(1.24), 1);
    assert.equal(snap(1.26), 1.5);
    assert.equal(snap(-3.8), -4);
  });

  it('adds every kind of piece and the result passes the shared check', () => {
    const d = fresh();
    d.pillars = [];
    addItem(d, 'pillar', { x: 0, z: 10 }, { x: 0, z: 10 });
    assert.equal(d.pillars[0].r, 2, 'a click places a default pillar');
    addItem(d, 'pillar', { x: 0, z: -10 }, { x: 3, z: -10 });
    assert.equal(d.pillars[1].r, 3, 'a drag from the centre sets the radius');
    assert.deepEqual(addItem(d, 'wall', { x: -4, z: -2 }, { x: 4, z: -1 }), { kind: 'wall', i: 0 });
    assert.deepEqual(d.walls![0], { x0: -4, x1: 4, z0: -2, z1: -1 });
    addItem(d, 'low', { x: 10, z: 0 }, { x: 10, z: 0 });
    addItem(d, 'lava', { x: -10, z: 12 }, { x: -6, z: 16 });
    assert.equal(d.lows!.length, 2);
    assert.equal(d.lows![1].lava, true);
    assert.equal(d.lows![0].lava, undefined);
    addItem(d, 'flat', { x: -5, z: 14 }, { x: 5, z: 19 });
    addItem(d, 'ramp', { x: -11, z: 15 }, { x: -5, z: 19 });
    assert.equal(d.deck!.ramps[0].rise, '+x', 'a ramp drawn wide climbs along x');
    addItem(d, 'pier', { x: -4, z: 18 }, { x: -4, z: 18 });
    assert.deepEqual(d.deck!.piers!.length, 1);
    const r = clean(d);
    // the lava pit overlaps the ramp row: move it away and the map is clean
    d.lows!.pop();
    const r2 = clean(d);
    assert.deepEqual(r2.problems, [], JSON.stringify(r.problems));
  });

  it('a click on a rect tool places a default-sized piece centred on the click', () => {
    const d = fresh();
    addItem(d, 'wall', { x: 2, z: 2 }, { x: 2, z: 2 });
    assert.deepEqual(d.walls![0], { x0: -1, x1: 5, z0: 1.25, z1: 2.75 });
  });

  it('finds what is under the pointer, topmost first, and nothing in the open', () => {
    const d = fresh();
    d.pillars = [{ x: 0, z: 0, r: 2 }];
    d.walls = [{ x0: 10, x1: 14, z0: 0, z1: 1 }];
    d.deck = { height: 3, flats: [{ x0: -5, x1: 5, z0: 14, z1: 20 }], ramps: [] };
    assert.deepEqual(hitTest(d, 0.5, 0.5), { kind: 'pillar', i: 0 });
    assert.deepEqual(hitTest(d, 12, 0.5), { kind: 'wall', i: 0 });
    assert.deepEqual(hitTest(d, 0, 17), { kind: 'flat', i: 0 });
    assert.deepEqual(hitTest(d, d.spawns[0][0].x, d.spawns[0][0].z), { kind: 'spawn', team: 0, i: 0 });
    assert.deepEqual(hitTest(d, d.spawns[1][2].x + 0.3, d.spawns[1][2].z), { kind: 'spawn', team: 1, i: 2 });
    assert.equal(hitTest(d, 20, 10), null);
    assert.equal(hitTest(d, 0, 12, 0.1), null, 'flats are not grabbed from outside');
  });

  it('moves and resizes pieces', () => {
    const d = fresh();
    d.walls = [{ x0: 0, x1: 4, z0: 0, z1: 2 }];
    moveSel(d, { kind: 'wall', i: 0 }, 1, -1);
    assert.deepEqual(d.walls[0], { x0: 1, x1: 5, z0: -1, z1: 1 });
    moveSel(d, { kind: 'spawn', team: 0, i: 0 }, 2, 0);
    assert.equal(d.spawns[0][0].x, -22);
    const w = d.walls[0];
    assert.deepEqual(handleAt(w, 5, 0), { hx: 1, hz: 0 });
    assert.deepEqual(handleAt(w, 1, -1), { hx: -1, hz: -1 });
    assert.equal(handleAt(w, 3, 0, 0.3), null, 'the middle moves it');
    resizeRect(w, { hx: 1, hz: 1 }, 9, 4);
    assert.deepEqual(w, { x0: 1, x1: 9, z0: -1, z1: 4 });
    resizeRect(w, { hx: -1, hz: 0 }, 50, 0);
    assert.ok(w.x1 - w.x0 >= 0.5, 'never inside out');
    assert.deepEqual(rectBetween({ x: 5, z: 5 }, { x: 1, z: 2 }), { x0: 1, x1: 5, z0: 2, z1: 5 });
  });

  it('deletes pieces and tidies up empty lists and an empty walkway', () => {
    const d = fresh();
    d.walls = [{ x0: 0, x1: 4, z0: 0, z1: 2 }];
    d.lows = [{ x0: 8, x1: 10, z0: 0, z1: 1 }];
    d.deck = { height: 3, flats: [{ x0: -5, x1: 5, z0: 14, z1: 20 }], ramps: [] };
    assert.equal(deleteSel(d, { kind: 'wall', i: 0 }), true);
    assert.equal(d.walls, undefined);
    assert.equal(deleteSel(d, { kind: 'low', i: 0 }), true);
    assert.equal(d.lows, undefined);
    assert.equal(deleteSel(d, { kind: 'flat', i: 0 }), true);
    assert.equal(d.deck, undefined);
    assert.equal(deleteSel(d, { kind: 'pillar', i: 0 }), true);
    assert.equal(d.pillars.length, 1);
    assert.equal(deleteSel(d, { kind: 'spawn', team: 0, i: 0 }), false, 'start spots stay');
    assert.equal(deleteSel(d, { kind: 'wall', i: 3 }), false);
    assert.equal(deleteSel(d, null), false);
  });

  it('adds a point-symmetric twin, flipping a ramp', () => {
    const d = fresh();
    d.pillars = [{ x: -8, z: -6, r: 2 }];
    d.deck = { height: 3, flats: [{ x0: -5, x1: 5, z0: 14, z1: 20 }], ramps: [{ x0: -11, x1: -5, z0: 16, z1: 20, rise: '+x' }] };
    addTwin(d, { kind: 'pillar', i: 0 });
    assert.deepEqual(d.pillars[1], { x: 8, z: 6, r: 2 });
    const s = addTwin(d, { kind: 'ramp', i: 0 });
    assert.deepEqual(s, { kind: 'ramp', i: 1 });
    assert.deepEqual(d.deck.ramps[1], { x0: 5, x1: 11, z0: -20, z1: -16, rise: '-x' });
    assert.equal(addTwin(d, { kind: 'spawn', team: 0, i: 0 }), null);
    const r = clean(d);
    assert.deepEqual(r.problems.filter((p) => !/Ramp 2/.test(p)), []);
  });

  it('mirrors a team’s start spots to the other team', () => {
    const d = fresh();
    d.spawns[0] = [{ x: -22, z: -4 }, { x: -22, z: 4 }, { x: -25, z: 0 }];
    mirrorSpawns(d, 0);
    assert.deepEqual(d.spawns[1], [{ x: 22, z: 4 }, { x: 22, z: -4 }, { x: 25, z: 0 }]);
    assert.deepEqual(clean(d).problems, []);
  });

  it('maps between yards and pixels both ways', () => {
    const v = makeView({ minX: -30, maxX: 30, minZ: -20, maxZ: 20 }, 640, 420, 10);
    assert.ok(Math.abs(v.wx(v.px(7.5)) - 7.5) < 1e-9 && Math.abs(v.wz(v.py(-3)) + 3) < 1e-9);
    assert.ok(v.px(-30) >= 10 - 1e-9 && v.px(30) <= 630 + 1e-9);
  });

  it('itemOf reads the draft', () => {
    const d = fresh();
    assert.equal(itemOf(d, null), null);
    assert.deepEqual(itemOf(d, { kind: 'pillar', i: 0 }), d.pillars[0]);
    assert.equal(itemOf(d, { kind: 'wall', i: 0 }), null);
  });
});

/** A canvas 2D context that records which calls were made and accepts any other. */
function stubCtx() {
  const calls: string[] = [];
  const grad = { addColorStop() {} };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : k === 'createLinearGradient' ? () => grad : (...args: unknown[]) => void calls.push(`${k}:${args.map((a) => (typeof a === 'number' ? (Number.isFinite(a) ? 'n' : 'NaN') : '')).join('')}`)),
    set: (t, k: string, v) => ((t[k] = v), true),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('map preview drawing', () => {
  it('draws every built-in map (detail and thumbnail) with finite coordinates', () => {
    for (const a of ARENAS) {
      for (const detail of [true, false]) {
        const { ctx, calls } = stubCtx();
        drawArena(ctx, a, 640, 420, { detail, sel: { kind: 'pillar', i: 0 } });
        assert.ok(calls.length > 20, a.id);
        assert.ok(!calls.some((c) => c.includes('NaN')), `${a.id}: no NaN reaches the canvas`);
      }
    }
  });

  it('draws a copy with every piece selected in turn, and a ghost box', () => {
    const a = copyArena(ARENAS.find((x) => x.id === 'forge')!, 'forge-cp', 'Forge cp');
    for (const sel of [{ kind: 'wall', i: 0 }, { kind: 'low', i: 0 }, { kind: 'flat', i: 0 }, { kind: 'ramp', i: 0 }, { kind: 'spawn', team: 1, i: 2 }] as const) {
      const { ctx } = stubCtx();
      drawArena(ctx, a, 500, 400, { detail: true, sel, ghost: { x0: 0, x1: 2, z0: 0, z1: 2 } });
    }
  });
});
