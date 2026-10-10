import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS, ArenaSim, allArenas, arenaById, blankArena, botSmoke, checkReach, cleanCustomArena, contentHash, copyArena, customArenas, findArena, isCustomArena, parseClientMsg, registerCustomArenas, suggestMapId } from '../src/index';
import type { ArenaDef } from '../src/index';

const ok = (a: unknown, others: ArenaDef[] = []) => {
  const r = cleanCustomArena(a, others);
  assert.deepEqual(r.problems, []);
  assert.ok(r.arena);
  return r.arena!;
};
const bad = (a: unknown, re: RegExp, others: ArenaDef[] = []) => {
  const r = cleanCustomArena(a, others);
  assert.ok(r.problems.some((p) => re.test(p)), `expected ${re}, got ${JSON.stringify(r.problems)}`);
};
const mk = (f: (a: ArenaDef) => void): ArenaDef => {
  const a = blankArena('test-map', 'Test map');
  f(a);
  return a;
};

describe('custom map validation', () => {
  it('the blank starter map is valid and walkable', () => {
    const a = ok(blankArena());
    assert.deepEqual(checkReach(a), []);
  });

  it('every built-in map, copied under a new name, passes the same checks', () => {
    for (const b of ARENAS) {
      const c = cleanCustomArena(copyArena(b, 'copy-of-' + b.id.replace(/[^a-z]/g, ''), 'Copy ' + b.id));
      assert.deepEqual(c.problems, [], b.id);
    }
  });

  it('refuses built-in ids and names, bad ids, reserved words and duplicates among custom maps', () => {
    bad(mk((a) => (a.id = 'colosseum')), /built-in/);
    bad(mk((a) => (a.id = 'random')), /reserved/);
    bad(mk((a) => (a.id = 'Bad Id')), /id needs/);
    bad(mk((a) => (a.id = 'ab')), /id needs/);
    bad(mk((a) => (a.name = ARENAS[0].name)), /taken/);
    bad(mk((a) => (a.name = 'x')), /name needs/);
    const other = ok(blankArena('other-map', 'Other map'));
    bad(mk((a) => (a.id = 'other-map')), /already uses/, [other]);
    bad(mk((a) => (a.name = 'OTHER MAP')), /taken/, [other]);
    // saving over itself is not a clash
    ok(blankArena('other-map', 'Other map'), [{ ...other, id: 'another-one', name: 'Another one' }]);
  });

  it('refuses things that are not objects, NaN and out-of-range numbers', () => {
    bad(null, /not an object/);
    bad('x', /not an object/);
    bad(mk((a) => (a.bounds.minX = NaN)), /minX is not a number/);
    bad(mk((a) => (a.pillars[0].r = Infinity)), /radius is not a number/);
    bad(mk((a) => (a.pillars[0].r = 99)), /radius must be/);
    bad(mk((a) => (a.theme = 'lava-land')), /theme/);
    bad(mk((a) => ((a as unknown as Record<string, unknown>).bounds = undefined)), /bounds are missing/);
    bad(mk((a) => (a.spawns = [[], []])), /exactly 3/);
  });

  it('keeps the size within limits', () => {
    bad(mk((a) => { a.bounds = { minX: -10, maxX: 10, minZ: -20, maxZ: 20 }; }), /yards long/);
    bad(mk((a) => { a.bounds = { minX: -30, maxX: 30, minZ: -5, maxZ: 5 }; }), /yards wide|minZ must|maxZ must/);
    bad(mk((a) => (a.bounds.maxX = 500)), /maxX must be/);
  });

  it('keeps spawns inside, behind their gate, apart and out of solids', () => {
    bad(mk((a) => (a.spawns[0][0] = { x: -40, z: 0 })), /outside the map/);
    bad(mk((a) => (a.spawns[0][0] = { x: -10, z: 0 })), /behind its start gate/);
    bad(mk((a) => (a.spawns[1][0] = { x: 10, z: 0 })), /behind its start gate/);
    bad(mk((a) => { a.walls = [{ x0: -26, x1: -22, z0: -5, z1: 5 }]; }), /spawn 1 is inside/);
    bad(mk((a) => { a.pillars = [{ x: -24, z: -3, r: 2 }]; }), /spawn 1 is inside/);
    bad(mk((a) => { a.lows = [{ x0: -30, x1: -20, z0: -5, z1: 5, lava: true }]; }), /inside a pillar|in lava/);
    bad(mk((a) => (a.spawns[0][1] = { ...a.spawns[0][0] })), /on top of each other/);
  });

  it('keeps pillars, walls and barricades inside the bounds and within their limits', () => {
    bad(mk((a) => (a.pillars = [{ x: 29.5, z: 0, r: 2 }])), /outside the map/);
    bad(mk((a) => (a.walls = [{ x0: 25, x1: 35, z0: 0, z1: 2 }])), /outside the map/);
    bad(mk((a) => (a.walls = [{ x0: 0, x1: 0.1, z0: 0, z1: 5 }])), /too small/);
    bad(mk((a) => (a.lows = [{ x0: -50, x1: 50, z0: 0, z1: 2 }])), /outside|too big/);
    bad(mk((a) => (a.pillars = Array.from({ length: 30 }, (_, i) => ({ x: -10 + i * 0.5, z: 0, r: 0.6 })))), /Too many pillars/);
    bad(mk((a) => (a.walls = Array.from({ length: 30 }, () => ({ x0: 0, x1: 2, z0: 0, z1: 2 })))), /Too many Wall/i);
    // reversed corners are put right
    const a = ok(mk((x) => (x.walls = [{ x0: 4, x1: 0, z0: 5, z1: 1 }])));
    assert.deepEqual(a.walls, [{ x0: 0, x1: 4, z0: 1, z1: 5 }]);
  });

  it('checks the walkway: ramps must climb into a flat, pieces stay clear of pillars, walls and bounds', () => {
    const deck = (ramps: NonNullable<ArenaDef['deck']>['ramps']) => mk((a) => {
      a.pillars = [];
      a.deck = { height: 3, flats: [{ x0: -5, x1: 5, z0: 14, z1: 20 }], ramps };
    });
    ok(deck([{ x0: -11, x1: -5, z0: 16, z1: 20, rise: '+x' }, { x0: 5, x1: 11, z0: 16, z1: 20, rise: '-x' }]));
    bad(deck([{ x0: -11, x1: -5, z0: 16, z1: 20, rise: '-x' }]), /does not connect/);
    bad(deck([{ x0: -13, x1: -7, z0: 16, z1: 20, rise: '+x' }]), /does not connect/);
    bad(deck([{ x0: -11, x1: -5, z0: 0, z1: 4, rise: '+x' }]), /does not connect/);
    bad(deck([{ x0: -6, x1: -5, z0: 16, z1: 20, rise: '+x' }]), /yards long/);
    bad(deck([{ x0: -11, x1: -5, z0: 16, z1: 20, rise: 'up' as never }]), /rise of/);
    bad(mk((a) => { a.deck = { height: 3, flats: [], ramps: [{ x0: -11, x1: -5, z0: 16, z1: 20, rise: '+x' }] }; }), /need a walkway flat/);
    bad(mk((a) => { a.deck = { height: 9, flats: [{ x0: -5, x1: 5, z0: 14, z1: 20 }], ramps: [] }; }), /height must be/);
    bad(mk((a) => { a.deck = { height: 3, flats: [{ x0: -5, x1: 5, z0: 14, z1: 30 }], ramps: [] }; }), /outside the map/);
    bad(mk((a) => { a.pillars = [{ x: 0, z: 17, r: 1 }]; a.deck = { height: 3, flats: [{ x0: -5, x1: 5, z0: 14, z1: 20 }], ramps: [] }; }), /stands under a walkway/);
    bad(mk((a) => { a.pillars = []; a.walls = [{ x0: 0, x1: 2, z0: 15, z1: 17 }]; a.deck = { height: 3, flats: [{ x0: -5, x1: 5, z0: 14, z1: 20 }], ramps: [] }; }), /under a walkway/);
    const r = cleanCustomArena(mk((a) => { a.pillars = []; a.deck = { height: 3, flats: [{ x0: -5, x1: 5, z0: 14, z1: 20 }], ramps: [] }; }));
    assert.ok(r.warnings.some((w) => /no ramp/.test(w)));
  });

  it('cleans: drops unknown fields, rounds, strips markup, derives route points for walls', () => {
    const a = ok({ ...blankArena(), evil: 1, desc: '<b>hi</b> there', pillars: [{ x: 1.23456, z: 2, r: 2, extra: 1 }], walls: [{ x0: -3, x1: 3, z0: -1, z1: 1 }] });
    assert.equal((a as unknown as Record<string, unknown>).evil, undefined);
    assert.equal(a.desc, 'bhi/b there');
    assert.deepEqual(a.pillars, [{ x: 1.23, z: 2, r: 2 }]);
    assert.ok(a.nav!.length >= 4, 'wall corners become route points');
    assert.ok(!a.randomPool);
  });
});

describe('custom map walkability', () => {
  it('a wall that seals a pocket is reported, a pocket opened up is not', () => {
    const sealed = ok(mk((a) => {
      a.walls = [{ x0: -8, x1: 8, z0: -2, z1: -1 }, { x0: -8, x1: -7, z0: -10, z1: -1 }, { x0: 7, x1: 8, z0: -10, z1: -1 }, { x0: -8, x1: 8, z0: -11, z1: -10 }];
      a.pillars = [];
    }));
    assert.ok(checkReach(sealed).some((p) => /cannot be walked to/.test(p)));
    const open = ok(mk((a) => { a.walls = [{ x0: -8, x1: 8, z0: -2, z1: -1 }]; a.pillars = []; }));
    assert.deepEqual(checkReach(open), []);
  });

  it('a walkway with no way up is reported', () => {
    const a = ok(mk((x) => { x.pillars = []; x.deck = { height: 3, flats: [{ x0: -5, x1: 5, z0: 14, z1: 20 }], ramps: [], piers: [] }; }));
    assert.ok(checkReach(a).some((p) => /walkway/.test(p)));
  });

  it('copies of built-in maps with walls, lava and walkways are walkable', () => {
    for (const id of ['cinder', 'forge', 'overlook']) assert.deepEqual(checkReach(copyArena(arenaById(id), 'cp-' + id, 'Copy ' + id)), [], id);
  });

  it('bots finish a duel on a custom map with walls (production tick)', () => {
    const a = ok(mk((x) => { x.walls = [{ x0: -3, x1: 3, z0: -4, z1: 4 }]; x.pillars = [{ x: -10, z: 8, r: 2 }, { x: 10, z: -8, r: 2 }]; }));
    const r = botSmoke(a, { tickMs: 16 });
    assert.ok(r.finished && !r.stuck, JSON.stringify(r));
  });
});

describe('custom maps at runtime', () => {
  it('register, look up by id, and stay out of ARENAS and the content hash', () => {
    const before = contentHash();
    const a = ok(blankArena('run-time', 'Run time'));
    try {
      registerCustomArenas([a]);
      assert.equal(findArena('run-time'), a);
      assert.equal(arenaById('run-time'), a);
      assert.ok(isCustomArena('run-time') && !isCustomArena('colosseum'));
      assert.equal(allArenas().length, ARENAS.length + 1);
      assert.equal(ARENAS.length, 30, 'ARENAS stays the built-ins');
      assert.equal(contentHash(), before);
      assert.ok(new ArenaSim({ prepMs: 0, seed: 1, arena: arenaById('run-time') }));
      // the parser accepts the id once registered
      assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'dev_map', id: 'run-time' })), { t: 'dev_map', id: 'run-time' });
      registerCustomArenas([{ ...a, id: 'colosseum' }]);
      assert.equal(customArenas().length, 0, 'a custom map can never shadow a built-in');
    } finally {
      registerCustomArenas([]);
    }
    assert.equal(findArena('run-time'), undefined);
    assert.equal(arenaById('run-time'), ARENAS[0], 'a deleted map falls back to the default');
    assert.equal(parseClientMsg(JSON.stringify({ t: 'dev_map', id: 'run-time' })), null);
  });

  it('suggests free ids', () => {
    assert.equal(suggestMapId('Fire Pit!', []), 'fire-pit');
    assert.equal(suggestMapId('Fire Pit!', ['fire-pit']), 'fire-pit-2');
    assert.equal(suggestMapId('colosseum', []), 'colosseum-2');
    assert.equal(suggestMapId('123', []), 'my-map');
  });
});
