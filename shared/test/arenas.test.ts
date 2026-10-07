import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, ARENAS, ArenaSim, Bot, TUNING, arenaById, blinkDestination, deckPiers, deckRails, dist, hasLOS, heightAt, JUMP_HEIGHT, jumpHeight, navStep, onRaised, resolveCollisions, stepMovementL, walkClear } from '../src/index';
import type { ArenaDef } from '../src/index';

describe('arenas', () => {
  it('has unique ids and valid layouts', () => {
    assert.ok(ARENAS.length >= 3);
    assert.equal(new Set(ARENAS.map((a) => a.id)).size, ARENAS.length);
    for (const a of ARENAS) {
      const b = a.bounds;
      for (const p of a.pillars) {
        assert.ok(p.x - p.r > b.minX && p.x + p.r < b.maxX && p.z - p.r > b.minZ && p.z + p.r < b.maxZ, `${a.id}: pillar inside bounds`);
      }
      for (let i = 0; i < a.pillars.length; i++)
        for (let j = i + 1; j < a.pillars.length; j++) {
          const p = a.pillars[i];
          const q = a.pillars[j];
          assert.ok(Math.hypot(p.x - q.x, p.z - q.z) > p.r + q.r + 1.6, `${a.id}: pillars ${i}/${j} leave a gap to walk through`);
        }
      for (const team of [0, 1]) {
        assert.ok(a.spawns[team].length >= 3);
        for (const s of a.spawns[team]) {
          assert.ok(Math.abs(s.x) > a.gateX, `${a.id}: spawn behind own gate`);
          assert.ok(s.x > b.minX && s.x < b.maxX && s.z > b.minZ && s.z < b.maxZ);
          for (const p of a.pillars) assert.ok(Math.hypot(p.x - s.x, p.z - s.z) > p.r + 1.5, `${a.id}: spawn clear of pillars`);
        }
      }
    }
  });

  it('every arena runs a match and blocks line of sight through its pillars', () => {
    for (const a of ARENAS) {
      const sim = new ArenaSim({ prepMs: 1000, seed: 3, arena: arenaById(a.id) });
      sim.addUnit({ name: 'A', classId: 'mage', team: 0, controller: 'player' });
      sim.addUnit({ name: 'B', classId: 'warrior', team: 1, controller: 'player' });
      for (let i = 0; i < 40; i++) sim.step();
      assert.equal(sim.arena.id, a.id);
      const p = a.pillars[0];
      assert.equal(hasLOS({ x: p.x - p.r - 2, z: p.z }, { x: p.x + p.r + 2, z: p.z }, a), false, `${a.id}: pillar blocks sight`);
    }
  });

  it('unknown ids fall back to the default arena', () => {
    assert.equal(arenaById('nope').id, ARENAS[0].id);
  });
});

describe('jumping', () => {
  it('is cosmetic: height follows the curve, ground position is untouched, and it needs a fresh request', async () => {
    const { ArenaSim, JUMP_HEIGHT, JUMP_MS, jumpHeight, TUNING } = await import('../src/index');
    assert.equal(jumpHeight(0), 0);
    assert.equal(jumpHeight(JUMP_MS), 0);
    assert.ok(Math.abs(jumpHeight(JUMP_MS / 2) - JUMP_HEIGHT) < 1e-9);

    const sim = new ArenaSim({ prepMs: 0, seed: 1 });
    const u = sim.addUnit({ name: 'J', classId: 'rogue', team: 0, controller: 'player' });
    sim.addUnit({ name: 'T', classId: 'warrior', team: 1, controller: 'dummy' });
    const at = () => sim.snapshot().units.find((x) => x.id === u.id)!;
    for (let i = 0; i < 3; i++) sim.step();
    const x0 = at().x;
    sim.queueInput(u.id, { seq: 1, fwd: 0, strafe: 0, facing: u.facing, jump: true });
    sim.step();
    let peak = 0;
    const ticks = Math.ceil(JUMP_MS / TUNING.tickMs) + 2;
    for (let i = 0; i < ticks; i++) {
      peak = Math.max(peak, at().y);
      sim.step();
    }
    assert.ok(peak > JUMP_HEIGHT * 0.9, `peaked at ${peak}`);
    assert.equal(at().y, 0, 'landed');
    assert.equal(at().x, x0, 'no ground movement from jumping');
    // the late-packet repeat of the same input must not start another jump
    for (let i = 0; i < 6; i++) sim.step();
    assert.equal(at().y, 0);
  });

  it('cannot jump while stunned or dead', async () => {
    const { ArenaSim } = await import('../src/index');
    const sim = new ArenaSim({ prepMs: 0, seed: 2 });
    const u = sim.addUnit({ name: 'J', classId: 'rogue', team: 0, controller: 'player' });
    sim.addUnit({ name: 'T', classId: 'warrior', team: 1, controller: 'dummy' });
    for (let i = 0; i < 3; i++) sim.step();
    u.alive = false;
    sim.queueInput(u.id, { seq: 1, fwd: 0, strafe: 0, facing: 0, jump: true });
    for (let i = 0; i < 4; i++) sim.step();
    assert.equal(sim.snapshot().units.find((x) => x.id === u.id)!.y, 0);
  });

});

const WALLED = { ...arenaById('serpent'), deck: undefined, bounds: {"minX":-21,"maxX":21,"minZ":-32,"maxZ":32}, pillars: [{"x":7,"z":6,"r":1.4},{"x":-9,"z":-6,"r":1.4}], walls: [{"x0":0.6,"x1":8,"z0":-18.8,"z1":-17.6},{"x0":0.6,"x1":1.8,"z0":-18.8,"z1":19.6},{"x0":-9.5,"x1":1.8,"z0":18.4,"z1":19.6},{"x0":-4.6,"x1":9,"z0":-24.1,"z1":-22.9},{"x0":-4.6,"x1":-3.4,"z0":-24.1,"z1":11.1},{"x0":-9.5,"x1":-3.4,"z0":9.9,"z1":11.1}], nav: [{"x":-14,"z":0},{"x":14,"z":0},{"x":-8,"z":-12},{"x":-8,"z":5},{"x":-8,"z":14.75},{"x":-1.4,"z":14.75},{"x":-1.4,"z":0},{"x":-1.4,"z":-12},{"x":-1.4,"z":-20.85},{"x":5,"z":-20.85},{"x":12,"z":-20.85},{"x":12,"z":-12},{"x":12,"z":5},{"x":6,"z":10},{"x":-8,"z":24.5},{"x":4,"z":24.5},{"x":12,"z":24.5},{"x":-8,"z":-28},{"x":4,"z":-28},{"x":12,"z":-28}] } as ArenaDef;

describe('Walled arenas (walls and route points, tested on a fixture layout)', () => {
  const a = WALLED;

  it('is a real layout: spawns and route points stand in the open, walls stay inside the bounds', () => {
    assert.ok(a.walls!.length >= 6 && a.nav!.length >= 10);
    const b = a.bounds;
    for (const w of a.walls!) assert.ok(w.x0 < w.x1 && w.z0 < w.z1 && w.x0 >= b.minX && w.x1 <= b.maxX && w.z0 >= b.minZ && w.z1 <= b.maxZ);
    for (const p of [...a.spawns[0], ...a.spawns[1], ...a.nav!]) {
      const r = resolveCollisions(p, a);
      assert.ok(Math.hypot(r.x - p.x, r.z - p.z) < 1e-6, `(${p.x}, ${p.z}) is free`);
    }
  });

  it('walls stop walking and Blink, and block line of sight', () => {
    // straight across the long hook wall at x about 1.2
    const left = { x: -6, z: 0 };
    const right = { x: 6, z: 0 };
    assert.equal(hasLOS(left, right, a), false);
    let p = left;
    for (let i = 0; i < 80; i++) p = stepMovementL(p, 0, { fwd: 1, strafe: 0, facing: Math.PI / 2 }, TUNING.runSpeed, 0.05, a).pos;
    assert.ok(p.x < 0, 'the wall held');
    const end = blinkDestination({ x: -6, z: 0 }, Math.PI / 2, 20, a);
    assert.ok(end.x < 0.6, 'Blink stops at the wall');
  });

  it('bots route round the walls and meet in a mirror duel', () => {
    for (const [c0, c1] of [['warrior', 'rogue'], ['mage', 'warrior']] as const) {
      const sim = new ArenaSim({ prepMs: 0, seed: 11, arena: a });
      const u0 = sim.addUnit({ name: 'a', classId: c0, team: 0, controller: 'bot' });
      const u1 = sim.addUnit({ name: 'b', classId: c1, team: 1, controller: 'bot' });
      const bots = [new Bot(sim, u0.id, 'hard', 1), new Bot(sim, u1.id, 'hard', 2)];
      let first = Infinity;
      for (let i = 0; i < 20 * 40 && !sim.winner; i++) {
        for (const b of bots) b.tick();
        sim.step();
        if (hasLOS(u0.pos, u1.pos, a) && first === Infinity) first = i;
      }
      assert.ok(first < 20 * 25, `${c0} and ${c1} found each other (${first})`);
    }
  });

  it('navStep goes round a wall and is silent when the way is clear', () => {
    assert.equal(walkClear({ x: -8, z: 0 }, { x: -8, z: 5 }, a), true);
    assert.equal(navStep({ x: -8, z: 0 }, { x: -8, z: 5 }, a), null);
    const step = navStep({ x: -14, z: 0 }, { x: 14, z: 0 }, a);
    assert.ok(step && walkClear({ x: -14, z: 0 }, step, a));
  });
});


const WALKWAY_MAPS = ARENAS.filter((x) => x.deck);
type St = { pos: { x: number; z: number }; level: 0 | 1 };
/** Walk with a jump starting on tick `jumpAt` (heights from the real jump curve, as the sim does). */
function walkL(a: ArenaDef, st: St, facing: number, ticks: number, jumpAt = -1): St & { trail: St[] } {
  const trail: St[] = [];
  for (let i = 0; i < ticks; i++) {
    const air = jumpAt >= 0 && i >= jumpAt ? jumpHeight((i - jumpAt) * TUNING.tickMs) : 0;
    st = stepMovementL(st.pos, st.level, { fwd: 1, strafe: 0, facing }, TUNING.runSpeed, TUNING.tickMs / 1000, a, air);
    trail.push(st);
  }
  return { ...st, trail };
}
const toward = (p: { x: number; z: number }, q: { x: number; z: number }) => Math.atan2(q.x - p.x, q.z - p.z);

describe('raised walkways (every map with one)', () => {
  it('every map has a walkway now, and Twin Ramps is gone', () => {
    assert.equal(WALKWAY_MAPS.length, ARENAS.length);
    assert.ok(ARENAS.length >= 7);
    assert.ok(!ARENAS.some((x) => x.id === 'bridge'));
  });

  for (const a of WALKWAY_MAPS) {
    const dk = a.deck!;
    describe(a.name, () => {
      it('spawns are free, rails never sit on the deck floor, piers stand under flats', () => {
        for (const p of a.spawns.flat()) {
          const r = resolveCollisions(p, a);
          assert.ok(Math.hypot(r.x - p.x, r.z - p.z) < 1e-6, `spawn (${p.x}, ${p.z}) is free`);
        }
        const pieces = [...dk.flats, ...dk.ramps];
        for (const r of deckRails(a)) {
          const inside = pieces.some((q) => Math.min(r.x1, q.x1) - Math.max(r.x0, q.x0) > 1e-6 && Math.min(r.z1, q.z1) - Math.max(r.z0, q.z0) > 1e-6);
          assert.ok(!inside, `rail ${JSON.stringify(r)} overlaps the deck`);
        }
        for (const p of deckPiers(a)) assert.ok(dk.flats.some((f) => p.x0 >= f.x0 - 1e-6 && p.x1 <= f.x1 + 1e-6 && p.z0 >= f.z0 - 1e-6 && p.z1 <= f.z1 + 1e-6), 'pier under a flat');
      });

      it('every ramp: walk up from the foot to full height, and back down to the ground', () => {
        for (const r of dk.ramps) {
          const axis = r.rise[1], up = r.rise[0] === '+';
          const mid = { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 };
          const foot = axis === 'x' ? { x: up ? r.x0 - 3 : r.x1 + 3, z: mid.z } : { x: mid.x, z: up ? r.z0 - 3 : r.z1 + 3 };
          const top = axis === 'x' ? { x: up ? r.x1 + 1 : r.x0 - 1, z: mid.z } : { x: mid.x, z: up ? r.z1 + 1 : r.z0 - 1 }; // a step onto the deck at its top
          const climb = walkL(a, { pos: foot, level: 0 }, toward(foot, top), Math.ceil(((dist(foot, top) - 0.2) / TUNING.runSpeed) * 20));
          assert.equal(climb.level, 1, `${a.id}: climbed ${r.rise} ramp`);
          assert.ok(heightAt(a, climb.pos.x, climb.pos.z, 1) > dk.height * 0.95, `${a.id}: reached the top (${JSON.stringify(climb.pos)})`);
          const down = walkL(a, climb, toward(top, foot) , 60);
          assert.equal(down.level, 0, `${a.id}: walked off the foot`);
        }
      });

      it('rails stop a walk off the edge; a jump clears them and you land on the ground', () => {
        const rails = deckRails(a).filter((r) => heightAt(a, (r.x0 + r.x1) / 2 + r.inward.x * 0.5, (r.z0 + r.z1) / 2 + r.inward.z * 0.5, 1) > dk.height * 0.9);
        assert.ok(rails.length >= 2, 'has rails on the high parts');
        let tried = 0;
        for (const r of rails.flatMap((r) => [0.25, 0.5, 0.75].map((f) => ({ ...r, c: { x: r.x0 + (r.x1 - r.x0) * f, z: r.z0 + (r.z1 - r.z0) * f } })))) {
          const c = r.c;
          const start = { x: c.x + r.inward.x * 2, z: c.z + r.inward.z * 2 };
          const out = { x: c.x - r.inward.x * 6, z: c.z - r.inward.z * 6 };
          if (resolveCollisions(out, a, 0).x !== out.x || out.x < a.bounds.minX + 1 || out.x > a.bounds.maxX - 1 || out.z < a.bounds.minZ + 1 || out.z > a.bounds.maxZ - 1) continue;
          if (onRaised(a, out.x, out.z)) continue; // another piece beyond this edge (the inner side of a ring)
          tried++;
          const face = toward(start, out);
          const held = walkL(a, { pos: start, level: 1 }, face, 40);
          assert.equal(held.level, 1, `${a.id}: the rail held at ${JSON.stringify(c)}`);
          const jumped = walkL(a, { pos: start, level: 1 }, face, 40, 0);
          assert.equal(jumped.level, 0, `${a.id}: jumped off at ${JSON.stringify(c)} (ended ${JSON.stringify(jumped.pos)})`);
          assert.ok(jumped.trail.findIndex((t) => t.level === 0) < 20, 'dropped while still in the jump');
        }
        assert.ok(tried >= 1, `${a.id}: found an edge to jump off`);
      });

      it('from the ground: the high part of a ramp is a wall, the low part can be jumped onto from the side', () => {
        for (const r of dk.ramps) {
          const axis = r.rise[1], up = r.rise[0] === '+';
          const len = axis === 'x' ? r.x1 - r.x0 : r.z1 - r.z0;
          const footC = axis === 'x' ? (up ? r.x0 : r.x1) : up ? r.z0 : r.z1;
          const at = (frac: number) => footC + (up ? 1 : -1) * len * frac; // along the ramp from its foot
          // stand beside the ramp (on whichever side is open ground), facing it
          for (const side of [-1, 1]) {
            const lat = axis === 'x' ? (side < 0 ? r.z0 - 1.5 : r.z1 + 1.5) : side < 0 ? r.x0 - 1.5 : r.x1 + 1.5;
            const spot = (frac: number) => (axis === 'x' ? { x: at(frac), z: lat } : { x: lat, z: at(frac) });
            const low = spot(0.3), high = spot(0.85);
            const free = (p: { x: number; z: number }) => { const q = resolveCollisions(p, a, 0); return Math.hypot(q.x - p.x, q.z - p.z) < 1e-6 && !onRaised(a, p.x, p.z) && p.x > a.bounds.minX + 1 && p.x < a.bounds.maxX - 1 && p.z > a.bounds.minZ + 1 && p.z < a.bounds.maxZ - 1; };
            if (!free(low) || !free(high)) continue;
            const inward = axis === 'x' ? (side < 0 ? 0 : Math.PI) : side < 0 ? Math.PI / 2 : -Math.PI / 2;
            assert.equal(walkL(a, { pos: high, level: 0 }, inward, 30, 0).level, 0, `${a.id}: cannot jump onto the high part`);
            assert.equal(walkL(a, { pos: low, level: 0 }, inward, 30).level, 0, `${a.id}: cannot walk onto the side without a jump`);
            assert.equal(walkL(a, { pos: low, level: 0 }, inward, 30, 0).level, 1, `${a.id}: jumped onto the low part from the side`);
          }
        }
      });

      it('sight: the deck is a ceiling over the ground beneath it, ramps block sight on the ground', () => {
        const f = dk.flats[0];
        const under = { x: (f.x0 + f.x1) / 2, z: (f.z0 + f.z1) / 2 };
        const upTop = { x: under.x + 0.5, z: under.z };
        assert.equal(hasLOS(under, upTop, a, 0, 1), false, 'under the deck cannot see up');
        assert.equal(hasLOS(upTop, { x: under.x - 0.5, z: under.z }, a, 1, 1), true, 'on the deck they see each other');
        const r = dk.ramps[0];
        const axis = r.rise[1];
        const c = { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 };
        const p = axis === 'x' ? { x: c.x, z: r.z0 - 2 } : { x: r.x0 - 2, z: c.z };
        const q = axis === 'x' ? { x: c.x, z: r.z1 + 2 } : { x: r.x1 + 2, z: c.z };
        assert.equal(hasLOS(p, q, a, 0, 0), false, 'the ramp blocks the ground view across it');
      });

      it('bots find each other and fight (they climb, jump down and go round as needed)', () => {
        for (const [c0, c1] of [['warrior', 'rogue'], ['mage', 'warrior'], ['priest', 'mage']] as const) {
          const sim = new ArenaSim({ prepMs: 0, seed: 11, arena: a });
          const u0 = sim.addUnit({ name: 'a', classId: c0, team: 0, controller: 'bot' });
          const u1 = sim.addUnit({ name: 'b', classId: c1, team: 1, controller: 'bot' });
          const bots = [new Bot(sim, u0.id, 'hard', 1), new Bot(sim, u1.id, 'hard', 2)];
          let fought = false;
          for (let i = 0; i < 20 * 60 && !fought; i++) {
            for (const b of bots) b.tick();
            sim.step();
            fought = u0.health < u0.maxHealth || u1.health < u1.maxHealth;
          }
          assert.ok(fought, `${a.id}: ${c0} and ${c1} reached each other (${JSON.stringify(u0.pos)} L${u0.level} / ${JSON.stringify(u1.pos)} L${u1.level})`);
        }
      });

      it('a bot on the walkway reaches an enemy below (down a ramp or by jumping off)', () => {
        const f = dk.flats[0];
        const sim = new ArenaSim({ prepMs: 0, seed: 4, arena: a });
        const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 0, controller: 'bot' });
        const d = sim.addUnit({ name: 'd', classId: 'warrior', team: 1, controller: 'dummy' });
        w.pos = { x: (f.x0 + f.x1) / 2, z: (f.z0 + f.z1) / 2 };
        w.level = 1;
        d.pos = { ...a.spawns[1][0] };
        const bot = new Bot(sim, w.id, 'hard', 3);
        let hit = false;
        for (let i = 0; i < 20 * 30 && !hit; i++) {
          bot.tick();
          sim.step();
          hit = d.health < d.maxHealth;
        }
        assert.ok(hit, `${a.id}: reached the dummy (ended at ${JSON.stringify(w.pos)} L${w.level})`);
      });
    });
  }
});

describe('above and below a walkway', () => {
  const a = arenaById('overlook'); // plateau x -6..6, z -5..5, ramps north and south
  it('the deck hides someone above from someone below, except past its edge', () => {
    assert.equal(hasLOS({ x: -9, z: 0 }, { x: 3, z: 0 }, a, 0, 1), false, 'from the ground beside it you cannot see the middle of the deck');
    assert.equal(hasLOS({ x: -9, z: 0 }, { x: -5.2, z: 0 }, a, 0, 1), true, 'but you see someone standing at its edge');
    assert.equal(hasLOS({ x: 0, z: 0 }, { x: 4, z: 3 }, a, 0, 1), false, 'under it you see nothing up top');
    assert.equal(hasLOS({ x: -20, z: 0 }, { x: -5.2, z: 0 }, a, 0, 1), true, 'from far off you see over the edge');
  });

  it('Heroic Leap aimed on top of a walkway lands up there; aimed below, on the ground', () => {
    for (const [lv, want] of [[1, 1], [undefined, 0]] as const) {
      const sim = new ArenaSim({ prepMs: 0, seed: 1, arena: a });
      const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 0, controller: 'player', build: { spec: 'arms', talents: [], gear: {} } as never });
      sim.addUnit({ name: 'd', classId: 'warrior', team: 1, controller: 'dummy' });
      w.pos = { x: -17, z: 7 }; // past the end of the barricade at x -16 (z -5..5), so it does not block the aim
      w.facing = Math.atan2(17, -6);
      sim.step();
      const r = sim.useAbility(w.id, 'heroic_leap', null, { x: 0, z: 1, ...(lv ? { lv } : {}) });
      assert.ok(r.ok, (r as { reason?: string }).reason);
      for (let i = 0; i < 40; i++) sim.step();
      assert.equal(w.level, want, `landed on level ${w.level}`);
      assert.ok(Math.hypot(w.pos.x, w.pos.z - 1) < 1.5, `at the spot (${JSON.stringify(w.pos)})`);
    }
  });

  it('a zone on the deck does not burn the ground below it, and one on the ground does not reach the deck', () => {
    const sim = new ArenaSim({ prepMs: 0, seed: 1, arena: a });
    const m = sim.addUnit({ name: 'm', classId: 'mage', team: 0, controller: 'player', build: { spec: 'fire', talents: [], gear: {} } as never });
    const up = sim.addUnit({ name: 'up', classId: 'warrior', team: 1, controller: 'dummy' });
    const down = sim.addUnit({ name: 'down', classId: 'warrior', team: 1, controller: 'dummy' });
    m.pos = { x: 0, z: 12 }; m.level = 1; m.facing = Math.PI; // top of the north ramp... on it
    up.pos = { x: 0, z: 0 }; up.level = 1;
    down.pos = { x: 0, z: 0.5 }; down.level = 0;
    sim.step();
    const fs = Object.keys(ABILITIES).find((k) => ABILITIES[k].effects.some((e) => e.type === 'zone' && (e as { amount?: number }).amount));
    assert.ok(fs, 'a damaging ground spell exists');
    m.resource = 9999;
    const r = sim.useAbility(m.id, fs!, null, { x: 0, z: 0, lv: 1 });
    assert.ok(r.ok, (r as { reason?: string }).reason);
    for (let i = 0; i < 20 * 8; i++) sim.step();
    assert.ok(up.health < up.maxHealth, 'the one on the deck burns');
    assert.equal(down.health, down.maxHealth, 'the one underneath does not');
  });
});

describe('low barricades', () => {
  const a = arenaById('overlook');
  it('in a match: an instant spell across one fails standing, and lands from the top of a jump', () => {
    const lw = a.lows![0];
    const c = { x: (lw.x0 + lw.x1) / 2, z: (lw.z0 + lw.z1) / 2 };
    const sim = new ArenaSim({ seed: 1, prepMs: 0, arena: a });
    const m = sim.addUnit({ name: 'm', classId: 'mage', team: 0, controller: 'player', build: { spec: 'frost', talents: [], gear: {} } as never });
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 1, controller: 'dummy' });
    sim.step();
    m.pos = { x: c.x - 3, z: c.z };
    w.pos = { x: c.x + 6, z: c.z };
    const facing = Math.atan2(w.pos.x - m.pos.x, w.pos.z - m.pos.z);
    m.facing = facing;
    sim.queueInput(m.id, { seq: 1, fwd: 0, strafe: 0, facing });
    sim.step();
    sim.setTarget(m.id, w.id);
    const r = sim.useAbility(m.id, 'ice_lance', w.id);
    assert.equal(r.ok, false, 'blocked on the ground');
    assert.match((r as { reason: string }).reason, /line of sight/);
    sim.queueInput(m.id, { seq: 2, fwd: 0, strafe: 0, facing, jump: true });
    for (let i = 0; i < 7; i++) sim.step(); // about the top of the jump
    const hp = w.health;
    const r2 = sim.useAbility(m.id, 'ice_lance', w.id);
    assert.ok(r2.ok, (r2 as { reason?: string }).reason);
    for (let i = 0; i < 30; i++) sim.step();
    assert.ok(w.health < hp, 'the lance hit');
  });
  it('block walking and, standing, sight; a jump clears them and sees over them', () => {
    const lw = a.lows![0];
    const c = { x: (lw.x0 + lw.x1) / 2, z: (lw.z0 + lw.z1) / 2 };
    const p = { x: c.x - 4, z: c.z }, q = { x: c.x + 4, z: c.z };
    assert.equal(hasLOS(p, q, a, 0, 0), false, 'person-high: no sight past it on the ground');
    assert.equal(hasLOS(p, q, a, 0, 0, JUMP_HEIGHT), true, 'at the top of a jump you see over it');
    assert.equal(hasLOS(p, q, a, 0, 0, 0, JUMP_HEIGHT), true, 'and are seen');
    assert.equal(hasLOS(p, q, a, 0, 0, 0.3), false, 'a hop is not enough');
    assert.equal(hasLOS(p, { x: c.x - 4, z: c.z + 6 }, a, 0, 0), true, 'sight that does not cross it is untouched');
    const walked = walkL(a, { pos: p, level: 0 }, Math.PI / 2, 30);
    assert.ok(walked.pos.x < lw.x0, `held by the barricade (x=${walked.pos.x})`);
    const jumped = walkL(a, { pos: { x: lw.x0 - 1.4, z: c.z }, level: 0 }, Math.PI / 2, 30, 0);
    assert.ok(jumped.pos.x > lw.x1 + 0.5, `jumped over (x=${jumped.pos.x})`);
  });
});

describe('bots and low barricades', () => {
  it('a bot hops and throws an instant over a barricade it cannot see past standing', () => {
    const a = arenaById('overlook');
    const lw = a.lows![0];
    const c = { x: (lw.x0 + lw.x1) / 2, z: (lw.z0 + lw.z1) / 2 };
    const sim = new ArenaSim({ seed: 2, prepMs: 0, arena: a });
    const m = sim.addUnit({ name: 'm', classId: 'mage', team: 0, controller: 'bot', build: { spec: 'frost', talents: [], gear: {} } as never });
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 1, controller: 'dummy' });
    sim.step();
    m.pos = { x: c.x - 3, z: c.z };
    w.pos = { x: c.x + 5, z: c.z };
    const bot = new Bot(sim, m.id, 'hard', 5);
    let jumped = false;
    let overTheTop = false;
    for (let i = 0; i < 20 * 6 && !overTheTop; i++) {
      w.pos = { x: c.x + 5, z: c.z }; // the dummy stays put on the far side
      bot.tick();
      sim.step();
      for (const e of sim.drainEvents()) {
        if (e.t === 'cast' && e.unit === m.id && ABILITIES[e.ability].castTime === 0 && sim.airOf(m) > 0) overTheTop = true;
      }
      if (sim.airOf(m) > 0) jumped = true;
    }
    assert.ok(jumped, 'it jumped');
    assert.ok(overTheTop, 'and cast an instant while in the air');
  });
});

describe('melee between floors', () => {
  it('a bot on a walkway cannot swing at someone on the ground below its edge, and neither can a melee skill', () => {
    const a = arenaById('overlook'); // plateau x -6..6, z -5..5
    const sim = new ArenaSim({ seed: 1, prepMs: 0, arena: a });
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 0, controller: 'player', build: { spec: 'arms', talents: [], gear: {} } as never });
    const m = sim.addUnit({ name: 'm', classId: 'mage', team: 1, controller: 'dummy' });
    sim.step();
    w.pos = { x: -6, z: -5 }; w.level = 1; // the deck's corner, up top (3.2 high)
    m.pos = { x: -5, z: -5 }; m.level = 0; // on the ground just under it: in sight past the edge, and within 3D sword reach
    assert.ok(hasLOS(w.pos, m.pos, a, 1, 0), 'the spot this test is about: sight passes the edge');
    w.facing = Math.atan2(1, 0);
    sim.setTarget(w.id, m.id);
    sim.setAutoAttack(w.id, true);
    const hp = m.health;
    for (let i = 0; i < 80; i++) sim.step();
    assert.equal(m.health, hp, 'no swing reaches down a floor');
    w.resource = 100;
    const r = sim.useAbility(w.id, 'mortal_strike', m.id);
    assert.equal(r.ok, false);
    // on the same floor it hits as usual
    m.pos = { x: -10, z: -8 }; w.pos = { x: -12, z: -8 }; w.level = 0; w.facing = Math.PI / 2; // both out in the open on the ground
    for (let i = 0; i < 80; i++) sim.step();
    assert.ok(m.health < hp, 'and on the same floor it does');
  });
});

describe('ramps and sight', () => {
  it('a ramp is a solid wedge: from on it you cannot see someone on the ground on its far side, and the other way round', () => {
    const a = arenaById('overlook'); // north ramp x -2.5..2.5, z 5..13, rising to the deck at z 5
    const onRamp = { x: 2.2, z: 7 };
    const across = { x: -5, z: 7 };
    assert.equal(hasLOS(onRamp, across, a, 1, 0), false, 'the ramp body is in the way');
    assert.equal(hasLOS(across, onRamp, a, 0, 1), false, 'both ways');
    assert.equal(hasLOS(onRamp, { x: 6, z: 7 }, a, 1, 0), true, 'someone on the near side is seen');
    assert.equal(hasLOS({ x: 0, z: 11 }, { x: 0, z: 3 }, a, 1, 1), true, 'up the ramp onto the deck is clear');
  });
});
