import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, JUMP_DODGE_CD, JUMP_MS, SPECS, TUNING } from '../src/index';
import type { Build, ClassId, SimEvent, TeamId, Unit } from '../src/index';

const TICK = TUNING.tickMs;
function add(sim: ArenaSim, classId: ClassId, team: TeamId, x: number, z: number, build?: Build): Unit {
  const u = sim.addUnit({ name: `${classId}${team}`, classId, team, build, controller: 'player' });
  u.pos = { x, z };
  return u;
}
function advance(sim: ArenaSim, ms: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let t = 0; t < ms; t += TICK) {
    sim.step();
    out.push(...sim.drainEvents());
  }
  return out;
}
const fire: Build = { spec: 'fire', talents: [], gear: {} };

/** A mage and a victim 12 yards apart; Flamestrike cast and resolved. Returns the sim, the victim and the zone's first pulse time. */
function setup() {
  const sim = new ArenaSim({ seed: 5, prepMs: 0 });
  const mage = add(sim, 'mage', 0, -6, 0, fire);
  const victim = add(sim, 'warrior', 1, 6, 0);
  advance(sim, TICK);
  mage.resource = mage.resourceMax;
  assert.deepEqual(sim.setTarget(mage.id, victim.id), { ok: true });
  const r = sim.useAbility(mage.id, 'flamestrike', victim.id);
  assert.deepEqual(r, { ok: true }, JSON.stringify(r));
  advance(sim, 3000 + TICK);
  const zone = sim.snapshot().zones[0];
  assert.ok(zone, 'zone placed');
  return { sim, mage, victim, zone };
}
const stillInput = (u: Unit, seq: number, jump = false) => ({ seq, fwd: 0, strafe: 0, facing: u.facing, jump });

describe('ground zones', () => {
  it('Flamestrike leaves a zone at the target that damages enemies on a fixed beat', () => {
    const { sim, victim, zone } = setup();
    assert.ok(Math.abs(zone.x - 6) < 0.01 && Math.abs(zone.z) < 0.01);
    const hp0 = victim.health;
    const ev = advance(sim, zone.firstAt - sim.time + 2 * TICK);
    assert.ok(victim.health < hp0, 'first pulse hurt');
    assert.ok(ev.some((e) => e.t === 'damage' && e.ability === 'flamestrike' && e.tgt === victim.id));
    const after1 = victim.health;
    advance(sim, 500);
    assert.equal(victim.health, after1, 'nothing between pulses');
    advance(sim, 600);
    assert.ok(victim.health < after1, 'next pulse hurt');
  });

  it('Flamestrike hits for 420 the moment the cast lands, then 70 per pulse', () => {
    const sim = new ArenaSim({ seed: 5, prepMs: 0 });
    const mage = add(sim, 'mage', 0, -6, 0, fire);
    const victim = add(sim, 'warrior', 1, 6, 0);
    const outside = add(sim, 'rogue', 1, 6, 9); // 9 yd from the zone centre, outside its 5 yd radius
    advance(sim, TICK);
    mage.resource = mage.resourceMax;
    assert.deepEqual(sim.setTarget(mage.id, victim.id), { ok: true });
    assert.deepEqual(sim.useAbility(mage.id, 'flamestrike', victim.id), { ok: true });
    const v = TUNING.damageVariance;
    const spec = SPECS.mage.find((x) => x.id === 'fire')?.mods?.damageDone ?? 1; // the Pyromancy passive scales every hit
    const hits = (ev: SimEvent[], who: Unit) => ev.filter((e) => e.t === 'damage' && e.ability === 'flamestrike' && e.tgt === who.id) as Extract<SimEvent, { t: 'damage' }>[];

    const landed = advance(sim, 3000 + 2 * TICK); // the cast finishes; the first pulse is still 0.8 s away
    const opening = hits(landed, victim);
    assert.equal(opening.length, 1, 'one opening hit');
    assert.ok(opening[0].amount >= 420 * spec * (1 - v) - 1 && opening[0].amount <= 420 * spec * (1 + v) + 1, `opening hit ${opening[0].amount}`);
    assert.equal(hits(landed, outside).length, 0, 'nothing for someone outside the area');

    const next = hits(advance(sim, 800 + 2 * TICK), victim); // standing in it: the first pulse
    assert.equal(next.length, 1, 'one pulse');
    assert.ok(next[0].amount >= 70 * spec * (1 - v) - 1 && next[0].amount <= 70 * spec * (1 + v) + 1, `pulse ${next[0].amount}`);
  });

  it('does not hurt allies or enemies standing outside, and expires', () => {
    const { sim, mage, victim, zone } = setup();
    const ally = add(sim, 'priest', 0, 6, 0);
    const far = add(sim, 'rogue', 1, 20, 0);
    const hpAlly = ally.health;
    const hpFar = far.health;
    advance(sim, zone.end - sim.time + 2 * TICK);
    assert.equal(ally.health, hpAlly);
    assert.equal(far.health, hpFar);
    assert.equal(sim.snapshot().zones.length, 0, 'zone gone after its duration');
    void mage;
    void victim;
  });

  it('a jump at the pulse dodges it; targeted spells still always hit while airborne', () => {
    const { sim, mage, victim, zone } = setup();
    // jump so that the first pulse lands mid-air
    advance(sim, zone.firstAt - sim.time - 300 - TICK);
    sim.queueInput(victim.id, stillInput(victim, 1, true));
    const hp0 = victim.health;
    const ev = advance(sim, 300 + 3 * TICK);
    assert.equal(victim.health, hp0, 'airborne during the pulse: no damage');
    assert.ok(ev.some((e) => e.t === 'dodge' && e.unit === victim.id && e.ability === 'flamestrike'));

    // while still in the air, a lock-on bolt lands
    sim.queueInput(victim.id, stillInput(victim, 2, false));
    assert.ok(sim.snapshot().units.find((u) => u.id === victim.id)!.y > 0, 'victim is airborne');
    mage.resource = mage.resourceMax;
    const hpBolt = victim.health;
    sim.useAbility(mage.id, 'fireball', victim.id);
    advance(sim, 2600);
    assert.ok(victim.health < hpBolt, 'a fireball hits a jumping target');
  });

  it('hop-spamming does not give permanent immunity: a second jump within the cooldown does not dodge', () => {
    const { sim, victim, zone } = setup();
    advance(sim, zone.firstAt - sim.time - 300 - TICK);
    sim.queueInput(victim.id, stillInput(victim, 1, true));
    advance(sim, 300 + 3 * TICK); // dodged pulse 1
    const hp = victim.health;
    // land, then jump again so pulse 2 (1 s after pulse 1) happens in the air, well inside the dodge cooldown
    const jumpAt = zone.firstAt + zone.pulse - 300;
    advance(sim, jumpAt - sim.time - TICK);
    assert.ok(sim.time - (zone.firstAt - 300) < JUMP_DODGE_CD, 'still on cooldown');
    sim.queueInput(victim.id, stillInput(victim, 2, true));
    advance(sim, 300 + 3 * TICK);
    assert.ok(victim.health < hp, 'second pulse hit despite the jump');
    void JUMP_MS;
  });

  it('after the cooldown a new jump dodges again', () => {
    const { sim, victim, zone } = setup();
    advance(sim, zone.firstAt - sim.time - 300 - TICK);
    sim.queueInput(victim.id, stillInput(victim, 1, true));
    advance(sim, 300 + 3 * TICK);
    // pulse 3 is 2 s after pulse 1; start a jump 300 ms before it (>1.5 s after the first jump began)
    const jumpAt = zone.firstAt + 2 * zone.pulse - 300;
    advance(sim, jumpAt - sim.time - TICK);
    const hp = victim.health;
    sim.queueInput(victim.id, stillInput(victim, 2, true));
    const ev = advance(sim, 300 + 3 * TICK);
    assert.equal(victim.health, hp);
    assert.ok(ev.some((e) => e.t === 'dodge'));
  });
});
