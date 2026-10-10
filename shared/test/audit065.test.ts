import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, ReplayRecorder, ReplayRunner, TUNING, arenaById, onRaised } from '../src/index';
import type { ClassId, SimEvent, TeamId, Unit } from '../src/index';

/** Regression tests for the 0.65 audit: combat rules, walkways and Bladestorm. */

const TICK = TUNING.tickMs;
const run = (sim: ArenaSim, ms: number): SimEvent[] => {
  const out: SimEvent[] = [];
  for (let t = 0; t < ms; t += TICK) {
    sim.step();
    out.push(...sim.drainEvents());
  }
  return out;
};
const DEFAULT_SPEC: Record<ClassId, string> = { warrior: 'arms', mage: 'frost', priest: 'discipline', rogue: 'assassination' };
const add = (sim: ArenaSim, classId: ClassId, team: TeamId, x: number, z: number, spec?: string, talents: string[] = []): Unit => {
  const u = sim.addUnit({ name: `${classId}${team}`, classId, team, build: { spec: spec ?? DEFAULT_SPEC[classId], talents, gear: {} } });
  u.pos = { x, z };
  return u;
};

describe('0.65 crowd control', () => {
  it('diminishing returns shorten the combo-point part of Kidney Shot too', () => {
    const sim = new ArenaSim({ seed: 1, prepMs: 0 });
    const r = add(sim, 'rogue', 0, 0, 0);
    const w = add(sim, 'warrior', 1, 1, 0);
    run(sim, TICK);
    const d = [0, 1, 2].map(() => {
      const res = sim.applyAura(r, w, 'kidney_shot', 5000);
      w.auras = [];
      return res.applied ? res.duration : 0;
    });
    assert.ok(Math.abs(d[1] - d[0] / 2) < 1, `second is half the first (${d})`);
    assert.ok(Math.abs(d[2] - d[0] / 4) < 1, `third is a quarter (${d})`);
  });

  it('Dispel Magic takes crowd control off an ally before a damage-over-time effect', () => {
    const sim = new ArenaSim({ seed: 2, prepMs: 0 });
    const p = add(sim, 'priest', 0, 0, 0, 'discipline');
    const ally = add(sim, 'warrior', 0, 5, 0);
    const mage = add(sim, 'mage', 1, 15, 0);
    const shadow = add(sim, 'priest', 1, 15, 5, 'shadow');
    run(sim, TICK);
    sim.applyAura(shadow, ally, 'plague_bloom');
    sim.applyAura(mage, ally, 'polymorph');
    assert.ok(sim.useAbility(p.id, 'dispel_magic', ally.id).ok);
    assert.ok(!ally.auras.some((a) => a.id === 'polymorph'), 'the sheep went first');
    assert.ok(ally.auras.some((a) => a.id === 'plague_bloom'), 'the rot is still there');
  });

  it('a feared unit that is also rooted or stunned stays put', () => {
    const sim = new ArenaSim({ seed: 3, prepMs: 0 });
    const p = add(sim, 'priest', 0, 0, 0);
    const m = add(sim, 'mage', 0, 0, 2);
    const w = add(sim, 'warrior', 1, 4, 0);
    run(sim, TICK);
    sim.applyAura(m, w, 'frost_nova_root');
    sim.applyAura(p, w, 'psychic_scream');
    const at = { ...w.pos };
    run(sim, 1000);
    assert.ok(Math.hypot(w.pos.x - at.x, w.pos.z - at.z) < 0.01, 'rooted: no fear running');
  });
});

describe('0.65 area attacks', () => {
  it('area attacks need line of sight: Psychic Scream does not go through a pillar', () => {
    const arena = arenaById('colosseum');
    const sim = new ArenaSim({ seed: 4, prepMs: 0, arena });
    const pil = arena.pillars[0];
    const p = add(sim, 'priest', 0, pil.x - pil.r - 0.8, pil.z);
    const w = add(sim, 'warrior', 1, pil.x + pil.r + 0.8, pil.z);
    run(sim, TICK);
    assert.ok(sim.useAbility(p.id, 'psychic_scream').ok);
    assert.ok(!w.auras.some((a) => a.id === 'psychic_scream'), 'the pillar shields it');
  });

  it('area attacks respect floors: a Psychic Scream on the deck does not reach people underneath it', () => {
    const arena = arenaById('colosseum');
    const sim = new ArenaSim({ seed: 5, prepMs: 0, arena });
    const p = add(sim, 'priest', 0, 0, 17);
    p.level = 1;
    const under = add(sim, 'warrior', 1, 1, 17); // on the ground, under the deck
    run(sim, TICK);
    assert.ok(sim.useAbility(p.id, 'psychic_scream').ok);
    assert.ok(!under.auras.some((a) => a.id === 'psychic_scream'), 'the deck is in the way');
  });

  it('a +4 yards range modifier on Reel In makes the cone longer', () => {
    const sim = new ArenaSim({ seed: 6, prepMs: 0 });
    const w = add(sim, 'warrior', 0, 0, 0, 'protection', []);
    w.mods.ability.reel_in = { range: 4 }; // (what a talent that added range would carry)
    const m = add(sim, 'mage', 1, 0, 12.5); // 12.5 yd: past the base 10, inside 14
    run(sim, TICK);
    w.facing = 0;
    w.resource = 100;
    assert.ok(sim.useAbility(w.id, 'reel_in').ok);
    assert.ok(Math.hypot(m.pos.x - w.pos.x, m.pos.z - w.pos.z) < 3, 'pulled in from 12.5 yd');
  });
});

describe('0.65 walkways', () => {
  const colosseum = () => {
    const arena = arenaById('colosseum');
    return { arena, sim: new ArenaSim({ seed: 7, prepMs: 0, arena }) };
  };

  it('Shadowstep to a target at the edge of the deck lands on the deck', () => {
    const { arena, sim } = colosseum();
    const r = add(sim, 'rogue', 0, 0, 0, 'subtlety');
    const t = add(sim, 'mage', 1, 0, 14.4); // right at the deck's south edge, facing away from it (back over the drop)
    t.level = 1;
    t.facing = 0; // looking north: "behind" is south, off the deck
    run(sim, TICK);
    r.resource = 100;
    const res = sim.useAbility(r.id, 'shadowstep', t.id);
    assert.ok(res.ok, (res as any).reason);
    assert.equal(r.level, 1);
    assert.ok(onRaised(arena, r.pos.x, r.pos.z), `standing on the deck (${r.pos.x.toFixed(2)}, ${r.pos.z.toFixed(2)})`);
  });

  it('a Charge at someone up on the deck ends underneath without parking you there', () => {
    const { sim } = colosseum();
    const w = add(sim, 'warrior', 0, 0, 0);
    const m = add(sim, 'mage', 1, 0, 16);
    m.level = 1;
    run(sim, TICK);
    assert.ok(sim.useAbility(w.id, 'charge', m.id).ok);
    const ev = run(sim, 1500);
    assert.equal(w.charge, null, 'the charge is over');
    assert.ok(!ev.some((e) => e.t === 'damage' && e.ability === 'charge'), 'no hit on someone a floor away');
    assert.ok(!m.auras.some((a) => a.id === 'charge_stun'), 'no stun left behind');
  });

  it('Reel In pulling someone off the deck puts them on the ground', () => {
    const { sim } = colosseum();
    const w = add(sim, 'warrior', 0, 0, 10, 'protection');
    const m = add(sim, 'mage', 1, 0, 15);
    m.level = 1;
    run(sim, TICK);
    w.facing = 0;
    w.resource = 100;
    (sim as any).sees = () => true; // the deck edge is in the way; this test is about the level afterwards
    (sim as any).gap = (u: Unit, p: { x: number; z: number }) => Math.hypot(u.pos.x - p.x, u.pos.z - p.z);
    assert.ok(sim.useAbility(w.id, 'reel_in').ok);
    assert.ok(m.pos.z < 14, 'pulled off the deck');
    assert.equal(m.level, 0, 'and down on the ground');
  });

  it('Heroic Leap landing damage is measured in 3D', () => {
    const { sim } = colosseum();
    const w = add(sim, 'warrior', 0, 0, 5);
    const under = add(sim, 'mage', 1, 1, 16); // on the ground under the deck, 3.2 yd below the landing spot
    run(sim, TICK);
    const hp = under.health;
    assert.ok(sim.useAbility(w.id, 'heroic_leap', null, { x: 0, z: 15.5, lv: 1 }).ok);
    run(sim, 2000);
    assert.equal(w.level, 1, 'landed on the deck');
    assert.equal(under.health, hp, 'nobody on the floor below is hit');
  });

  it('stealth is spotted in 3D: a rogue on the deck right above you is not within 2 yards', () => {
    const { sim } = colosseum();
    const m = add(sim, 'mage', 0, 0, 15);
    const r = add(sim, 'rogue', 1, 0, 15.5);
    r.level = 1;
    run(sim, TICK);
    sim.applyAura(r, r, 'stealth');
    assert.equal(sim.canSee(m, r), false);
    assert.ok(!sim.snapshot(0).units.some((u) => u.id === r.id));
  });
});

describe('0.65 charge rules', () => {
  it('a damage-over-time tick does not stop a Charge', () => {
    const sim = new ArenaSim({ seed: 8, prepMs: 0 });
    const w = add(sim, 'warrior', 0, 0, 0);
    const p = add(sim, 'priest', 1, 20, 0, 'shadow');
    run(sim, TICK);
    sim.applyAura(p, w, 'plague_bloom');
    const plague = w.auras.find((a) => a.id === 'plague_bloom')!;
    assert.ok(sim.useAbility(w.id, 'charge', p.id).ok);
    plague.nextTick = sim.time + TICK; // a tick lands mid-run
    const ev = run(sim, 1500);
    assert.ok(ev.some((e) => e.t === 'damage' && e.tgt === w.id && e.ability !== 'charge'), 'the tick hit');
    assert.ok(ev.some((e) => e.t === 'damage' && e.ability === 'charge'), 'and the charge still landed');
  });

  it('Vanish cancels a Charge already on its way', () => {
    const sim = new ArenaSim({ seed: 9, prepMs: 0 });
    const w = add(sim, 'warrior', 0, 0, 0);
    const r = add(sim, 'rogue', 1, 20, 0);
    run(sim, TICK);
    assert.ok(sim.useAbility(w.id, 'charge', r.id).ok);
    run(sim, 100);
    r.auras = r.auras.filter((a) => a.id !== 'charge_stun'); // freed from the charge's stun (as by a trinket), it vanishes before the warrior arrives
    assert.ok(sim.useAbility(r.id, 'vanish').ok);
    const ev = run(sim, 1500);
    assert.equal(w.charge, null);
    assert.ok(!ev.some((e) => e.t === 'damage' && e.ability === 'charge'), 'no hit on the vanished rogue');
    assert.ok(sim.isStealthed(r), 'still stealthed');
  });
});

describe('0.65 casting', () => {
  it('pressing the spell you are casting does not restart it', () => {
    const sim = new ArenaSim({ seed: 10, prepMs: 0 });
    const m = add(sim, 'mage', 0, 0, 0);
    const w = add(sim, 'warrior', 1, 20, 0);
    run(sim, TICK);
    assert.ok(sim.useAbility(m.id, 'frostbolt', w.id).ok);
    const start = m.cast!.start;
    run(sim, 600);
    const again = sim.useAbility(m.id, 'frostbolt', w.id);
    assert.equal(again.ok, false);
    assert.equal(m.cast!.start, start, 'same cast, not started over');
  });

  it('refused presses are not recorded, a bot dropping a cast is, and the replay matches', () => {
    const sim = new ArenaSim({ seed: 12, prepMs: 0, facing: true });
    const rec = new ReplayRecorder(sim, { arena: sim.arena.id, seed: 12, prepMs: 0 });
    const p = sim.addUnit({ name: 'p', classId: 'priest', team: 0, controller: 'bot', build: { spec: 'discipline', talents: [], gear: {} } });
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 1, controller: 'dummy' });
    p.pos = { x: 0, z: 0 };
    w.pos = { x: 10, z: 0 };
    sim.step();
    let refused = 0;
    for (let i = 0; i < 50; i++) if (!sim.useAbility(p.id, 'kick', w.id).ok) refused++; // not a priest ability: refused
    for (let i = 0; i < 50; i++) if (!sim.useAbility(p.id, 'mind_blast', w.id).ok) refused++; // not on a Discipline bar
    assert.ok(refused > 0);
    assert.ok(sim.useAbility(p.id, 'smite', w.id).ok);
    sim.step();
    sim.stopCast(p.id);
    for (let i = 0; i < 20; i++) sim.step();
    const data = rec.finish([]);
    assert.ok(!data.cmds.some((c) => c[1] === 2 && (c[3] === 'kick' || c[3] === 'mind_blast')), 'no refused presses in the log');
    assert.ok(data.cmds.some((c) => c[1] === 6), 'the cancel is in the log');
    const rr = new ReplayRunner(data);
    rr.seek(data.ticks);
    assert.deepEqual(rr.sim.snapshot().units.map((u) => [u.health, u.cast]), sim.snapshot().units.map((u) => [u.health, u.cast]));
  });
});

describe('Bladestorm', () => {
  const setup = () => {
    const sim = new ArenaSim({ seed: 13, prepMs: 0 });
    const w = add(sim, 'warrior', 0, 0, 0, 'fury');
    const r = add(sim, 'rogue', 1, 2, 0);
    const prot = add(sim, 'warrior', 1, 0, 6, 'protection');
    run(sim, TICK);
    w.resource = 100;
    assert.ok(sim.useAbility(w.id, 'bladestorm').ok);
    run(sim, 300);
    return { sim, w, r, prot };
  };

  it('is not ended by pressing another skill', () => {
    const { sim, w, r } = setup();
    w.cooldowns = {};
    const p = sim.useAbility(w.id, 'pummel', r.id);
    assert.equal(p.ok, false);
    assert.equal(w.cast?.ability, 'bladestorm', 'still spinning');
  });

  it('cannot be kicked', () => {
    const { sim, w, r } = setup();
    r.resource = 100;
    assert.ok(sim.useAbility(r.id, 'kick', w.id).ok);
    const ev = run(sim, TICK);
    assert.equal(w.cast?.ability, 'bladestorm', 'still spinning');
    assert.ok(ev.some((e) => e.t === 'immune' && e.tgt === w.id));
    assert.ok(!Object.values(w.lockouts).some((t) => (t ?? 0) > sim.time), 'no lockout');
  });

  it('shrugs off stuns, fears, roots and slows, and cannot be pulled', () => {
    const { sim, w, r, prot } = setup();
    for (const aura of ['kidney_shot', 'psychic_scream', 'frost_nova_root', 'hamstring']) assert.equal(sim.applyAura(r, w, aura).applied, false, aura);
    assert.equal(w.cast?.ability, 'bladestorm');
    prot.facing = Math.PI; // facing the spinning warrior
    prot.resource = 100;
    const at = { ...w.pos };
    sim.useAbility(prot.id, 'reel_in');
    assert.ok(Math.hypot(w.pos.x - at.x, w.pos.z - at.z) < 0.01, 'not dragged');
    run(sim, 7500); // Bladestorm channels for 7 s
    assert.equal(w.cast, null, 'and it runs its course');
    assert.ok(sim.applyAura(r, w, 'kidney_shot').applied, 'afterwards control works again');
  });
});

describe('physical channels and interrupts', () => {
  it('kicking Slice and Dice only locks Slice and Dice, not every physical ability', () => {
    const sim = new ArenaSim({ seed: 14, prepMs: 0 });
    const w = add(sim, 'warrior', 0, 0, 0, 'arms');
    const r = add(sim, 'rogue', 1, 2, 0);
    run(sim, TICK);
    w.resource = 100;
    w.facing = -Math.PI / 2; // spinning away from the rogue, so it is not stunned by the strikes
    w.lastInput = { ...w.lastInput, facing: w.facing };
    assert.ok(sim.useAbility(w.id, 'slice_and_dice').ok);
    run(sim, 200);
    r.resource = 100;
    const k = sim.useAbility(r.id, 'kick', w.id);
    assert.ok(k.ok, (k as any).reason);
    run(sim, TICK);
    assert.equal(w.cast, null, 'interrupted');
    assert.ok(!(w.lockouts.physical && w.lockouts.physical > sim.time), 'physical school not locked');
    w.gcdEnd = 0;
    assert.ok(sim.useAbility(w.id, 'mortal_strike', r.id).ok, 'Mortal Strike still works');
  });
});
