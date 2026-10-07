import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS, ArenaSim, Bot, TUNING, arenaById, blinkDestination, hasLOS, heightAt, navStep, resolveCollisions, stepMovementL, walkClear } from '../src/index';

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

  it('Twin Ramps: ramps climb to a deck, rails keep you on it, and the tunnel underneath is open ground', () => {
    const a = arenaById('bridge');
    const br = a.bridge!;
    const walk = (pos: { x: number; z: number }, level: 0 | 1, facing: number, ticks: number, fwd = 1) => {
      let st = { pos, level };
      const trail: { x: number; z: number; level: 0 | 1 }[] = [];
      for (let i = 0; i < ticks; i++) { st = stepMovementL(st.pos, st.level, { fwd, strafe: 0, facing }, 7, 0.05, a); trail.push({ ...st.pos, level: st.level }); }
      return { ...st, trail };
    };
    // from the left spawn side, straight at the bridge: up the ramp, along the deck, down the far ramp
    const across = walk({ x: -24, z: 0 }, 0, Math.PI / 2, 140);
    assert.ok(across.trail.some((t) => t.level === 1 && Math.abs(t.x) < br.deckHalf), 'was on the deck');
    assert.ok(across.pos.x > 18 && across.level === 0, `down the far ramp, x=${across.pos.x}`);
    // beside the ramp you cannot climb it sideways, and walking into it from the side does not change level
    const side = walk({ x: -12, z: 8 }, 0, Math.PI, 60);
    assert.ok(side.pos.z >= br.halfWidth && side.level === 0, `stopped at the ramp wall, z=${side.pos.z}`);
    // rails: on the deck you cannot walk off the side
    const rail = walk({ x: 0, z: 0 }, 1, 0, 60); // facing +z
    assert.ok(Math.abs(rail.pos.z) <= br.halfWidth && rail.level === 1, `kept on the deck, z=${rail.pos.z}`);
    // the tunnel: level 0 walks straight through underneath, from one side to the other
    const tunnel = walk({ x: 0, z: -10 }, 0, 0, 140);
    assert.ok(tunnel.pos.z > 10 && tunnel.level === 0 && tunnel.trail.some((t) => Math.abs(t.z) < 1), `walked through the tunnel, z=${tunnel.pos.z}`);
    // blink toward a ramp from the ground stops at its wall
    const land = blinkDestination({ x: -24, z: 0 }, Math.PI / 2, 20, a, 0);
    assert.ok(land.x < -br.deckHalf - br.rampLen + 0.01, 'a ground blink cannot go up a ramp');
    // heights: flat on the ground, the deck is at full height, ramps slope between
    assert.equal(heightAt(a, 0, 0, 1), br.height);
    assert.equal(heightAt(a, 0, 0, 0), 0);
    assert.ok(heightAt(a, 13, 0, 1) > 0 && heightAt(a, 13, 0, 1) < br.height);
    assert.equal(heightAt(a, 24, 0, 1), 0);
  });

  it('Twin Ramps: the deck is a ceiling over the tunnel, and the ramps are walls on the ground', () => {
    const a = arenaById('bridge');
    assert.equal(hasLOS({ x: 0, z: 0 }, { x: 6, z: 0 }, a, 1, 1), true, 'deck to deck is clear');
    assert.equal(hasLOS({ x: 0, z: 0 }, { x: 5, z: 2 }, a, 1, 0), false, 'no sight from the deck into the tunnel');
    assert.equal(hasLOS({ x: 0, z: 1 }, { x: 3, z: 9 }, a, 0, 0), true, 'tunnel to the open ground at the side');
    assert.equal(hasLOS({ x: -22, z: 0 }, { x: 22, z: 0 }, a, 0, 0), false, 'the ramps block sight along the ground');
    assert.equal(hasLOS({ x: -22, z: 8 }, { x: 22, z: 8 }, a, 0, 0), true, 'clear beside the ramps');
    assert.equal(hasLOS({ x: -22, z: 0 }, { x: 0, z: 0 }, a, 0, 1), true, 'from the ground you can see up the ramp onto the deck');
  });

  it('Twin Ramps: bots walk over the bridge to reach each other', () => {
    const sim = new ArenaSim({ prepMs: 0, seed: 5, arena: arenaById('bridge'), facing: true });
    const w = sim.addUnit({ name: 'W', classId: 'warrior', team: 0, controller: 'bot' });
    const r = sim.addUnit({ name: 'R', classId: 'warrior', team: 1, controller: 'bot' });
    w.pos = { x: -24, z: 8 }; r.pos = { x: 24, z: -8 };
    const bots = [new Bot(sim, w.id, 'hard', 1), new Bot(sim, r.id, 'hard', 2)];
    let met = false;
    sim.step();
    for (let i = 0; i < 20 * 40 && !met; i++) {
      for (const b of bots) b.tick();
      sim.step();
      met = Math.hypot(w.pos.x - r.pos.x, w.pos.z - r.pos.z) < 4 || w.health < w.maxHealth || r.health < r.maxHealth;
    }
    assert.ok(met, `bots stuck at ${JSON.stringify(w.pos)} / ${JSON.stringify(r.pos)}`);
  });
});

describe('The Serpent (walls)', () => {
  const a = arenaById('serpent');

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

