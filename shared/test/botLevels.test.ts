import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, ARENAS, ArenaSim, Bot, DECK_THICKNESS, TUNING, heightAt, onRaised, resolveCollisions } from '../src/index';
import { navRoute } from '../src/nav';
import type { ArenaDef, ClassId, SimEvent, TeamId, Unit } from '../src/index';

/**
 * Bots on arenas with two levels: they take the ramps to a unit on the other floor (no pacing under or over it), do not
 * swing or cast through the floor, and do not stand still. Deterministic scenarios on every arena that has a deck.
 */
const TICK = TUNING.tickMs;
const DECKED = ARENAS.filter((a) => a.deck);

type Spot = { x: number; z: number; lv: 0 | 1 };

/** The middle of the arena's last deck piece (a flat, not a ramp), and open ground a few yards off a ramp's foot. */
function deckSpot(a: ArenaDef): Spot {
  const f = a.deck!.flats[a.deck!.flats.length - 1];
  return { x: (f.x0 + f.x1) / 2, z: (f.z0 + f.z1) / 2, lv: 1 };
}
const groundSpot = (a: ArenaDef): Spot => ({ x: a.spawns[0][0].x, z: a.spawns[0][0].z, lv: 0 });

/** Does the straight chest-to-chest line between two units pass through the middle of a deck (not just a corner of it: a body is 0.6 wide and sees round an edge)? */
function throughDeck(a: ArenaDef, s: Unit, v: Unit): boolean {
  const dk = a.deck!;
  const ya = heightAt(a, s.pos.x, s.pos.z, s.level) + 1.2, yb = heightAt(a, v.pos.x, v.pos.z, v.level) + 1.2;
  const plane = dk.height - DECK_THICKNESS / 2;
  if ((ya - plane) * (yb - plane) >= 0) return false;
  const t = (plane - ya) / (yb - ya);
  const x = s.pos.x + (v.pos.x - s.pos.x) * t, z = s.pos.z + (v.pos.z - s.pos.z) * t;
  return dk.flats.some((f) => x > f.x0 + 1 && x < f.x1 - 1 && z > f.z0 + 1 && z < f.z1 - 1);
}

interface Result { firstHit: number; crossed: number; idleMax: number; travelled: number; units: Unit[]; sim: ArenaSim }

/** A bot against a standing dummy; the bot's gap-closers are on cooldown so it has to walk. Runs `secs` of game time. */
function duel(arena: ArenaDef, botClass: ClassId, dummyClass: ClassId, botAt: Spot, dummyAt: Spot, secs: number, walk = true): Result {
  const sim = new ArenaSim({ seed: 3, prepMs: 0, arena });
  const a = sim.addUnit({ name: 'bot', classId: botClass, team: 0 as TeamId, controller: 'bot' });
  const d = sim.addUnit({ name: 'dummy', classId: dummyClass, team: 1 as TeamId, controller: 'dummy' });
  sim.step();
  sim.drainEvents();
  a.pos = { x: botAt.x, z: botAt.z }; a.level = botAt.lv;
  d.pos = { x: dummyAt.x, z: dummyAt.z }; d.level = dummyAt.lv;
  d.health = d.maxHealth = 1e7;
  if (walk) for (const id of ['charge', 'heroic_leap', 'shadowstep', 'sprint', 'blink']) a.cooldowns[id] = 1e9;
  const bot = new Bot(sim, a.id, 'hard', 1);
  let firstHit = -1, crossed = 0, idle = 0, idleMax = 0, travelled = 0;
  let last = { ...a.pos };
  const per = Math.round(1000 / sim.tickMs);
  for (let t = 0; t < (secs * 1000) / sim.tickMs; t++) {
    bot.tick();
    const check = (list: SimEvent[]) => {
      for (const e of list) {
        if (e.t !== 'damage' || e.src !== a.id) continue;
        if (firstHit < 0) firstHit = sim.time;
        if (throughDeck(arena, a, d) && sim.airOf(a) === 0 && sim.airOf(d) === 0) crossed++;
      }
    };
    check(sim.drainEvents());
    sim.step();
    check(sim.drainEvents());
    if (t % per === per - 1) {
      const m = Math.hypot(a.pos.x - last.x, a.pos.z - last.z);
      travelled += m;
      last = { ...a.pos };
      if (m < 0.2 && !a.cast && a.alive) idle++; else idle = 0;
      idleMax = Math.max(idleMax, idle);
    }
  }
  return { firstHit, crossed, idleMax, travelled, units: [a, d], sim };
}

describe('bots on a deck: reaching a unit on the other floor', () => {
  for (const arena of DECKED) {
    it(`${arena.id}: melee bots take the ramp up to a unit on the deck, and down to one on the ground`, () => {
      for (const cls of ['warrior', 'rogue'] as ClassId[]) {
        const up = duel(arena, cls, 'mage', groundSpot(arena), deckSpot(arena), 30);
        assert.ok(up.firstHit >= 0 && up.firstHit < 22000, `${cls} up to the deck: first strike at ${up.firstHit} ms`);
        assert.equal(up.crossed, 0, `${cls} up: nothing lands through the floor`);
        assert.ok(up.idleMax <= 3, `${cls} up: stood still for ${up.idleMax} s`);
        const down = duel(arena, cls, 'mage', deckSpot(arena), groundSpot(arena), 30);
        assert.ok(down.firstHit >= 0 && down.firstHit < 22000, `${cls} down to the ground: first strike at ${down.firstHit} ms`);
        assert.equal(down.crossed, 0, `${cls} down: nothing lands through the floor`);
        assert.ok(down.idleMax <= 3, `${cls} down: stood still for ${down.idleMax} s`);
      }
    });

    it(`${arena.id}: casters get a spell off at a unit on the other floor, and do not park where they cannot reach`, () => {
      for (const cls of ['mage', 'priest'] as ClassId[]) {
        for (const [from, to, name] of [[groundSpot(arena), deckSpot(arena), 'up'], [deckSpot(arena), groundSpot(arena), 'down']] as const) {
          const r = duel(arena, cls, 'warrior', from, to, 30);
          assert.ok(r.firstHit >= 0 && r.firstHit < 20000, `${cls} ${name}: first spell at ${r.firstHit} ms`);
          assert.equal(r.crossed, 0, `${cls} ${name}: nothing lands through the floor`);
          assert.ok(r.idleMax <= 8, `${cls} ${name}: stood still for ${r.idleMax} s`);
        }
      }
    });
  }

  it('serpent: a warrior on the ground does not press against the side of the ramp (it walks to the foot)', () => {
    const arena = ARENAS.find((a) => a.id === 'serpent')!;
    const r = duel(arena, 'warrior', 'mage', { x: -18, z: 0, lv: 0 }, { x: 0, z: 0, lv: 1 }, 25);
    assert.ok(r.firstHit >= 0 && r.firstHit < 9000, `first strike at ${r.firstHit} ms`);
    assert.ok(r.idleMax <= 1);
    // right beside the ramp (its side is 0.6 up here, too high to step onto): round to the foot, not into the wall
    const side = duel(arena, 'warrior', 'mage', { x: -15.5, z: 8.5, lv: 0 }, { x: 0, z: 0, lv: 1 }, 25);
    assert.ok(side.firstHit >= 0 && side.firstHit < 9000, `from the ramp's side: first strike at ${side.firstHit} ms`);
    assert.ok(side.idleMax <= 1, `stood still for ${side.idleMax} s`);
  });

  it('ruins: a priest at the far end of the range stands where it can reach a unit up on the deck (3D range)', () => {
    const arena = ARENAS.find((a) => a.id === 'ruins')!;
    const r = duel(arena, 'priest', 'warrior', { x: -24, z: -3, lv: 0 }, { x: 10, z: -15, lv: 1 }, 25);
    assert.ok(r.firstHit >= 0 && r.firstHit < 15000, `first spell at ${r.firstHit} ms`);
  });

  it('a warrior does not charge at a unit on the deck from the ground (Heroic Leap or the ramp instead)', () => {
    const arena = ARENAS.find((a) => a.id === 'overlook')!;
    const sim = new ArenaSim({ seed: 3, prepMs: 0, arena });
    const a = sim.addUnit({ name: 'bot', classId: 'warrior', team: 0 as TeamId, controller: 'bot' });
    const d = sim.addUnit({ name: 'dummy', classId: 'mage', team: 1 as TeamId, controller: 'dummy' });
    sim.step();
    sim.drainEvents();
    a.pos = { x: -14, z: 0 }; d.pos = { x: 0, z: 0 }; d.level = 1;
    d.health = d.maxHealth = 1e7;
    const bot = new Bot(sim, a.id, 'hard', 1);
    const used: string[] = [];
    let wrongCharge = 0;
    for (let t = 0; t < 8000 / sim.tickMs; t++) {
      bot.tick();
      const lv = a.level;
      for (const e of sim.drainEvents()) if (e.t === 'cast' && e.unit === a.id) { used.push(e.ability); if (e.ability === 'charge' && lv === 0) wrongCharge++; }
      sim.step();
      sim.drainEvents();
    }
    assert.equal(wrongCharge, 0, `charged at the deck from the ground (${used.join(', ')})`);
    assert.ok(used.includes('heroic_leap') || a.level === 1, 'got up there by leaping or walking');
  });

  it('a ground zone on the floor below does not chase a bot off the deck above it', () => {
    const arena = ARENAS.find((a) => a.id === 'overlook')!;
    const sim = new ArenaSim({ seed: 3, prepMs: 0, arena });
    const mage = sim.addUnit({ name: 'm', classId: 'mage', team: 0 as TeamId, controller: 'dummy' });
    const bot = sim.addUnit({ name: 'b', classId: 'warrior', team: 1 as TeamId, controller: 'dummy' });
    sim.step();
    sim.drainEvents();
    mage.pos = { x: -3, z: 0 }; mage.level = 0;
    bot.pos = { x: -3, z: 0 }; bot.level = 1;
    mage.bar = [...mage.bar, 'flamestrike'];
    assert.ok(sim.useAbility(mage.id, 'flamestrike', null, { x: -3, z: 0 }).ok);
    for (let t = 0; t < 3500 / sim.tickMs; t++) sim.step();
    assert.equal(sim.hazardsFor(1).length, 1, 'a zone on the ground');
    assert.equal(sim.hazardsFor(1, heightAt(arena, -3, 0, 1)).length, 0, 'but not for someone on the deck');
    assert.equal(sim.hazardsFor(1, 0).length, 1, 'and still for someone standing in it');
    void onRaised;
  });
});

describe('the walking routes agree with the movement rules', () => {
  /** Walk a unit along navRoute (jumping where it says) and return the seconds it takes to get within 2 yards of the goal, or Infinity. */
  function walk(arena: ArenaDef, from: Spot, goal: Spot, secs = 40): number {
    const sim = new ArenaSim({ seed: 1, prepMs: 0, arena });
    const u = sim.addUnit({ name: 'walker', classId: 'warrior', team: 0 as TeamId, controller: 'dummy' });
    sim.addUnit({ name: 'other', classId: 'warrior', team: 1 as TeamId, controller: 'dummy' }).pos = { x: arena.spawns[1][0].x, z: arena.spawns[1][0].z };
    sim.step();
    sim.drainEvents();
    u.pos = { x: from.x, z: from.z };
    u.level = from.lv;
    let seq = 0;
    for (let t = 0; t < (secs * 1000) / sim.tickMs; t++) {
      if (Math.hypot(u.pos.x - goal.x, u.pos.z - goal.z) < 2 && u.level === goal.lv) return sim.time / 1000;
      const r = navRoute(arena, u.pos, u.level, goal, goal.lv);
      if (!r) return Infinity;
      sim.queueInput(u.id, { seq: ++seq, fwd: 1, strafe: 0, facing: Math.atan2(r.point.x - u.pos.x, r.point.z - u.pos.z), jump: r.jump });
      sim.step();
      sim.drainEvents();
    }
    return Infinity;
  }

  for (const arena of DECKED) {
    it(`${arena.id}: from every open spot on the ground the route gets up to the deck, and from the deck back down`, () => {
      const goalUp = deckSpot(arena);
      const goalDown = groundSpot(arena);
      const failed: string[] = [];
      let n = 0;
      const b = arena.bounds;
      for (let x = b.minX + 3; x < b.maxX - 2; x += 6) {
        for (let z = b.minZ + 3; z < b.maxZ - 2; z += 6) {
          const free = Math.hypot(resolveCollisions({ x, z }, arena, 0).x - x, resolveCollisions({ x, z }, arena, 0).z - z) < 1e-6;
          if (free && !onRaised(arena, x, z)) {
            n++;
            const t = walk(arena, { x, z, lv: 0 }, goalUp);
            if (!(t < 35)) failed.push(`(${x}, ${z}) up: ${t}`);
          }
          if (onRaised(arena, x, z) && free) {
            n++;
            const t = walk(arena, { x, z, lv: 1 }, goalDown);
            if (!(t < 35)) failed.push(`(${x}, ${z}) down: ${t}`);
          }
        }
      }
      assert.ok(n > 5, 'sampled some spots');
      assert.deepEqual(failed, [], `${arena.id}: routes that never arrive`);
    });
  }
});

describe('bots on a deck: whole matches', () => {
  it('nobody is hit through the floor, and nobody stands still, in 2v2 and 3v3 matches on every decked arena', () => {
    const classes: ClassId[] = ['warrior', 'rogue', 'mage', 'priest'];
    for (const arena of DECKED) {
      for (const seed of [1, 2, 3, 4]) {
        const size = seed % 2 ? 2 : 3;
        const sim = new ArenaSim({ seed: seed * 7 + 1, prepMs: 0, arena });
        const units: Unit[] = [];
        for (let t = 0; t < 2; t++) for (let k = 0; k < size; k++) units.push(sim.addUnit({ name: `u${t}${k}`, classId: classes[(seed + t * 2 + k * 3) % 4], team: t as TeamId, controller: 'bot' }));
        const bots = units.map((u, i) => new Bot(sim, u.id, 'hard', seed * 10 + i));
        const idle = units.map(() => 0);
        const last = units.map((u) => ({ ...u.pos }));
        let crossed = 0, stuck = 0;
        const per = Math.round(1000 / sim.tickMs);
        const check = () => {
          for (const e of sim.drainEvents()) {
            if (e.t !== 'damage' || !e.src || e.src === e.tgt) continue;
            const s = sim.units.get(e.src)!, v = sim.units.get(e.tgt)!;
            // direct hits only (a damage-over-time tick may outlive the sight line), and nobody in the air (a jump lifts the line)
            const direct = e.ability === null || ABILITIES[e.ability]?.effects.some((x) => x.type === 'damage');
            if (direct && !s.image && !v.image && sim.airOf(s) === 0 && sim.airOf(v) === 0 && throughDeck(arena, s, v)) crossed++;
          }
        };
        for (let t = 0; t < 40000 / sim.tickMs && sim.winner === null; t++) {
          for (const b of bots) { b.tick(); check(); }
          sim.step();
          check();
          if (t % per === per - 1) units.forEach((u, i) => {
            const m = Math.hypot(u.pos.x - last[i].x, u.pos.z - last[i].z);
            last[i] = { ...u.pos };
            // held in place by a stun, polymorph, fear or root is not stuck
            const held = u.auras.some((x) => ['stun', 'incapacitate', 'fear', 'root'].includes(x.kind));
            if (u.alive && u.classId !== 'priest' && m < 0.2 && !u.cast && !held) idle[i]++; else idle[i] = 0;
            stuck = Math.max(stuck, idle[i]);
          });
        }
        assert.equal(crossed, 0, `${arena.id} seed ${seed}: ${crossed} hits through the floor`);
        assert.ok(stuck <= 10, `${arena.id} seed ${seed}: someone stood still for ${stuck} s`);
      }
    }
  });
});
