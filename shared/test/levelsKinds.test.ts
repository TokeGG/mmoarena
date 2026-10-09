import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, ArenaSim, TUNING, arenaById, onRaised } from '../src/index';
import type { ClassId, SimEvent, TeamId, Unit } from '../src/index';

/**
 * The ability kinds that are not a plain single-target spell, on an arena with a deck: ground spells, leaps, teleports,
 * channels, pulls, summons, smoke and stealth. Each works on the floor it is aimed at and never through the other one.
 * Arena "overlook": a deck at height 3.2 over x -6..6, z -5..5, ramps at both ends (z 5..13 and -13..-5).
 */
const TICK = TUNING.tickMs;
const ARENA = arenaById('overlook');

type Spot = { x: number; z: number; lv: 0 | 1 };
const DECK1: Spot = { x: -3, z: 0, lv: 1 };
const DECK2: Spot = { x: -1, z: 0, lv: 1 };
const GROUND1: Spot = { x: -3, z: 0, lv: 0 };
const GROUND2: Spot = { x: -1, z: 0, lv: 0 };
const FAR: Spot = { x: 25, z: 15, lv: 0 };
const lvOf = (s: Spot) => (s.lv === 1 ? { lv: 1 as const } : {});

const tough = (u: Unit) => { u.health = u.maxHealth = 1e7; };

function world(arena = ARENA) {
  const sim = new ArenaSim({ seed: 9, prepMs: 0, arena });
  const mk = (classId: ClassId, team: TeamId, s: Spot, controller: 'bot' | 'dummy' = 'dummy') => {
    const u = sim.addUnit({ name: `${classId}${team}`, classId, team, controller });
    u.pos = { x: s.x, z: s.z };
    u.level = s.lv;
    return u;
  };
  const run = (ms: number): SimEvent[] => {
    const out: SimEvent[] = [];
    for (let t = 0; t < ms; t += TICK) { sim.step(); out.push(...sim.drainEvents()); }
    return out;
  };
  // a sentinel on each team far away, so neither side is empty (an empty side ends the match)
  for (const [team, at] of [[0, { x: -25, z: -15, lv: 0 }], [1, { x: 25, z: 17, lv: 0 }]] as const) tough(mk('warrior', team, at));
  sim.step();
  sim.drainEvents();
  return { sim, mk, run };
}
const give = (u: Unit, id: string) => { if (!u.bar.includes(id)) u.bar = [...u.bar, id]; u.resource = u.resourceMax = 1e6; u.cp = 5; };
const faceTo = (u: Unit, p: { x: number; z: number; lv?: number }) => { u.facing = Math.atan2(p.x - u.pos.x, p.z - u.pos.z); u.lastInput = { ...u.lastInput, facing: u.facing }; };

describe('ground-targeted spells keep to their floor', () => {
  for (const id of ['flamestrike', 'blizzard']) {
    it(`${id} on the deck hurts the deck and not the ground under it (and the other way round)`, () => {
      for (const [casterAt, aim, hitAt, spareAt] of [
        [DECK1, DECK2, DECK2, GROUND2],
        [GROUND1, GROUND2, GROUND2, DECK2],
      ] as const) {
        const { sim, mk, run } = world();
        const mage = mk('mage', 0, casterAt, 'bot');
        const onFloor = mk('warrior', 1, hitAt);
        const other = mk('rogue', 1, spareAt);
        give(mage, id);
        faceTo(mage, aim);
        const r = sim.useAbility(mage.id, id, onFloor.id, { x: aim.x, z: aim.z, ...lvOf(aim) });
        assert.ok(r.ok, JSON.stringify(r));
        const ev = run(ABILITIES[id].castTime + 4500);
        assert.ok(ev.some((e) => e.t === 'damage' && e.tgt === onFloor.id && e.ability === id), `${id}: the unit on the aimed floor burns`);
        assert.ok(!ev.some((e) => e.t === 'damage' && e.tgt === other.id && e.ability === id), `${id}: the unit on the other floor, same spot, does not`);
        const z = sim.snapshot().zones.find((q) => q.ability === id)!;
        assert.equal((z.y ?? 0) > 1, aim.lv === 1, `${id}: the zone is drawn on its floor`);
      }
    });
  }

  it('a ground spell cannot be aimed through the floor', () => {
    for (const [from, aim] of [[DECK1, GROUND2], [GROUND1, DECK2]] as const) {
      const { sim, mk } = world();
      const mage = mk('mage', 0, from, 'bot');
      give(mage, 'flamestrike');
      const r = sim.useAbility(mage.id, 'flamestrike', null, { x: aim.x, z: aim.z, ...lvOf(aim) });
      assert.deepEqual(r, { ok: false, reason: 'no line of sight' });
    }
  });

  it('a ground spell cast at a target takes the floor the target stands on', () => {
    const { sim, mk, run } = world();
    const mage = mk('mage', 0, DECK1, 'bot');
    const up = mk('warrior', 1, DECK2);
    const below = mk('rogue', 1, GROUND2);
    give(mage, 'flamestrike');
    faceTo(mage, DECK2);
    assert.ok(sim.useAbility(mage.id, 'flamestrike', up.id).ok);
    const ev = run(ABILITIES.flamestrike.castTime + 3000);
    assert.ok(ev.some((e) => e.t === 'damage' && e.tgt === up.id && e.ability === 'flamestrike'));
    assert.ok(!ev.some((e) => e.t === 'damage' && e.tgt === below.id && e.ability === 'flamestrike'));
  });

  it('Heroic Leap lands on the floor it was aimed at: deck to deck, deck to ground, ground to deck', () => {
    for (const [from, aim] of [
      [{ x: -5, z: 0, lv: 1 }, { x: 5, z: 0, lv: 1 }],
      [{ x: -5.5, z: 0, lv: 1 }, { x: -15, z: 0, lv: 0 }],
      [{ x: -15, z: 0, lv: 0 }, { x: -4, z: 0, lv: 1 }],
    ] as const) {
      const { sim, mk, run } = world();
      const w = mk('warrior', 0, from, 'bot');
      mk('mage', 1, FAR);
      give(w, 'heroic_leap');
      faceTo(w, aim);
      const r = sim.useAbility(w.id, 'heroic_leap', null, { x: aim.x, z: aim.z, ...lvOf(aim) });
      assert.ok(r.ok, `${JSON.stringify(from)} -> ${JSON.stringify(aim)}: ${JSON.stringify(r)}`);
      run(2500);
      assert.equal(w.level, aim.lv, `${JSON.stringify(from)} -> ${JSON.stringify(aim)}: lands on level ${aim.lv}`);
      assert.ok(Math.hypot(w.pos.x - aim.x, w.pos.z - aim.z) < 1.2, `lands near the mark (${w.pos.x.toFixed(1)}, ${w.pos.z.toFixed(1)})`);
      if (aim.lv === 1) assert.ok(onRaised(ARENA, w.pos.x, w.pos.z), 'and on the walkway');
    }
  });

  it('Heroic Leap hurts only the floor it lands on', () => {
    const { sim, mk, run } = world();
    const w = mk('warrior', 0, { x: -5, z: 0, lv: 1 }, 'bot');
    const up = mk('mage', 1, { x: 4, z: 1, lv: 1 });
    const below = mk('rogue', 1, { x: 4.5, z: -1, lv: 0 });
    tough(up); tough(below);
    give(w, 'heroic_leap');
    faceTo(w, { x: 4, z: 0 });
    assert.ok(sim.useAbility(w.id, 'heroic_leap', null, { x: 4, z: 0, lv: 1 }).ok);
    const ev = run(2500);
    assert.ok(ev.some((e) => e.t === 'damage' && e.tgt === up.id && e.ability === 'heroic_leap'), 'the unit up there is hit');
    assert.ok(!ev.some((e) => e.t === 'damage' && e.tgt === below.id), 'nothing under the floor');
  });

  it('Not Going Anywhere holds the floor it was put down on, not the one below', () => {
    const { sim, mk, run } = world();
    const w = mk('warrior', 0, DECK1, 'bot');
    const upFoe = mk('mage', 1, DECK2);
    const lowFoe = mk('rogue', 1, GROUND2);
    give(w, 'not_going_anywhere');
    faceTo(w, DECK2);
    assert.ok(sim.useAbility(w.id, 'not_going_anywhere', null, { x: DECK2.x, z: DECK2.z, lv: 1 }).ok);
    run(300);
    const z = sim.snapshot().zones.find((q) => q.ability === 'not_going_anywhere')!;
    assert.ok((z.y ?? 0) > 1, 'a zone up on the deck');
    upFoe.pos = { x: DECK2.x + z.r + 2, z: 0 };
    lowFoe.pos = { x: GROUND2.x + z.r + 2, z: 0 };
    run(300);
    assert.ok(Math.hypot(upFoe.pos.x - DECK2.x, upFoe.pos.z) <= z.r + 0.2, 'the foe on the deck is held in');
    assert.ok(lowFoe.pos.x > GROUND2.x + z.r + 1, 'the foe on the ground below walks free');
  });

  it('Battle Banner buffs the floor it stands on', () => {
    const { sim, mk, run } = world();
    const w = mk('warrior', 0, DECK1, 'bot');
    const upAlly = mk('priest', 0, DECK2);
    const lowAlly = mk('priest', 0, GROUND2);
    give(w, 'battle_banner');
    assert.ok(sim.useAbility(w.id, 'battle_banner', null, { x: DECK1.x, z: DECK1.z, lv: 1 }).ok);
    run(900);
    assert.ok(w.auras.length > 0, 'the caster is buffed');
    assert.ok(upAlly.auras.length > 0, 'the ally up on the deck is buffed');
    assert.equal(lowAlly.auras.length, 0, 'the ally under the deck is not');
  });
});

describe('self-centred and moving abilities on a deck', () => {
  it('Blink stays on the deck, on the ground under it, and drops off the open end', () => {
    for (const [from, facing, level, moved] of [
      [{ x: -4, z: 0, lv: 1 }, Math.PI / 2, 1, true], // along the deck
      [{ x: -4, z: 0, lv: 0 }, Math.PI / 2, 0, true], // under it
    ] as const) {
      const { sim, mk } = world();
      const m = mk('mage', 0, from, 'bot');
      mk('warrior', 1, FAR);
      give(m, 'blink');
      m.facing = facing;
      m.lastInput = { ...m.lastInput, facing };
      assert.ok(sim.useAbility(m.id, 'blink').ok);
      assert.equal(m.level, level);
      assert.ok(!moved || Math.hypot(m.pos.x - from.x, m.pos.z - from.z) > 5, 'blinked a good way');
      if (level === 1) assert.ok(onRaised(ARENA, m.pos.x, m.pos.z), 'still on the walkway');
    }
  });

  it('Blink off the edge of the deck puts you on the ground', () => {
    const { sim, mk } = world();
    const m = mk('mage', 0, { x: 5.5, z: 0, lv: 1 }, 'bot');
    mk('warrior', 1, FAR);
    give(m, 'blink');
    m.facing = Math.PI / 2;
    m.lastInput = { ...m.lastInput, facing: m.facing };
    sim.useAbility(m.id, 'blink');
    if (!onRaised(ARENA, m.pos.x, m.pos.z)) assert.equal(m.level, 0, 'past the deck you are on the ground');
    else assert.equal(m.level, 1);
  });

  it('Shadowstep lands on the target\'s floor, behind it', () => {
    for (const [from, to] of [[{ x: -5, z: 0, lv: 1 }, { x: 3, z: 0, lv: 1 }], [{ x: -5, z: 0, lv: 0 }, { x: 3, z: 0, lv: 0 }]] as const) {
      const { sim, mk } = world();
      const r = mk('rogue', 0, from, 'bot');
      const t = mk('warrior', 1, to);
      t.facing = Math.PI / 2; // facing away from the rogue
      give(r, 'shadowstep');
      faceTo(r, t.pos);
      assert.ok(sim.useAbility(r.id, 'shadowstep', t.id).ok);
      assert.equal(r.level, to.lv);
      assert.ok(Math.hypot(r.pos.x - t.pos.x, r.pos.z - t.pos.z) < 3, 'next to the target');
      if (to.lv === 1) assert.ok(onRaised(ARENA, r.pos.x, r.pos.z), 'on the walkway');
    }
  });

  it('Charge runs along the deck and hits; at someone on another floor it does not hit', () => {
    {
      const { sim, mk, run } = world();
      const w = mk('warrior', 0, { x: -5, z: 0, lv: 1 }, 'bot');
      const t = mk('mage', 1, { x: 3, z: 0, lv: 1 });
      tough(t);
      faceTo(w, t.pos);
      assert.ok(sim.useAbility(w.id, 'charge', t.id).ok);
      run(1500);
      assert.equal(w.level, 1);
      assert.ok(Math.hypot(w.pos.x - t.pos.x, w.pos.z - t.pos.z) < 3, 'arrived');
      assert.ok(onRaised(ARENA, w.pos.x, w.pos.z));
    }
    {
      // from the ground at the foot of the deck, the unit up on it is out of reach of the strike
      const { sim, mk, run } = world();
      const w = mk('warrior', 0, { x: -12, z: 0, lv: 0 }, 'bot');
      const t = mk('mage', 1, { x: -3, z: 0, lv: 1 });
      tough(t);
      faceTo(w, t.pos);
      const r = sim.useAbility(w.id, 'charge', t.id);
      if (r.ok) {
        const ev = run(2500);
        assert.ok(!ev.some((e) => e.t === 'damage' && e.src === w.id && e.tgt === t.id), 'no hit through the floor');
      }
    }
  });

  it('Mirror Image copies appear on the caster\'s floor', () => {
    for (const at of [DECK1, GROUND1]) {
      const { sim, mk } = world();
      const m = mk('mage', 0, at, 'bot');
      mk('warrior', 1, FAR);
      give(m, 'mirror_image');
      assert.ok(sim.useAbility(m.id, 'mirror_image').ok);
      const images = [...sim.units.values()].filter((u) => u.image);
      assert.equal(images.length, 2);
      for (const i of images) {
        assert.equal(i.level, at.lv);
        if (at.lv === 1) assert.ok(onRaised(ARENA, i.pos.x, i.pos.z), 'an image stands on the walkway, not in the air');
      }
    }
  });

  it('Choke Bomb\'s smoke hides the floor it was thrown on and not the one under it', () => {
    const { sim, mk, run } = world();
    const r = mk('rogue', 0, DECK1, 'bot');
    const upFoe = mk('warrior', 1, DECK2);
    const lowFoe = mk('mage', 1, { x: -3.5, z: 0.2, lv: 0 });
    give(r, 'choke_bomb');
    assert.ok(sim.useAbility(r.id, 'choke_bomb').ok);
    run(200);
    assert.equal(sim.smokeHides(upFoe, r), false, 'both in the cloud on the deck: they see each other');
    assert.equal(sim.smokeHides(lowFoe, r), true, 'the cloud is on the deck: the foe below is outside it');
  });

  it('Rune of Power is a circle on the floor it is dropped on: stand under it and it does not reach you', () => {
    const { sim, mk, run } = world();
    const m = mk('mage', 0, DECK1, 'bot');
    give(m, 'rune_of_power');
    assert.ok(sim.useAbility(m.id, 'rune_of_power').ok);
    run(500);
    const z = sim.snapshot().zones.find((q) => q.ability === 'rune_of_power')!;
    assert.ok((z.y ?? 0) > 1, 'on the deck');
    assert.ok(m.auras.some((a) => a.id === z.buff || a.sourceId === m.id), 'the caster on the deck is in it');
    const had = m.auras.length;
    m.pos = { x: DECK1.x, z: DECK1.z };
    m.level = 0; // dropped to the ground right under the rune
    run(1500);
    assert.ok(m.auras.length < had || m.auras.every((a) => a.expiresAt <= sim.time + 1000), 'under the deck the rune no longer refreshes');
  });
});

describe('channels, pulls and cones across floors', () => {
  it('a channel ends when the target drops to the floor below (no ticking through the deck)', () => {
    for (const id of ['arcane_missiles', 'mind_flay', 'penance']) {
      const { sim, mk, run } = world();
      const c = mk(id === 'arcane_missiles' ? 'mage' : 'priest', 0, { x: -5, z: 0, lv: 1 }, 'bot');
      const t = mk('warrior', 1, { x: -3, z: 0, lv: 1 });
      tough(t);
      give(c, id);
      faceTo(c, t.pos);
      assert.ok(sim.useAbility(c.id, id, t.id).ok, id);
      run(ABILITIES[id].castTime * 0.3);
      assert.ok(c.cast, `${id} is channelling`);
      // the target steps off the open end and is under the deck, right below the caster
      t.pos = { x: -5, z: 0.5 };
      t.level = 0;
      const ev = run(ABILITIES[id].castTime);
      assert.ok(!ev.some((e) => e.t === 'damage' && e.src === c.id && e.tgt === t.id), `${id}: no damage after the target went under the floor`);
      assert.equal(c.cast, null, `${id}: the channel is over`);
    }
  });

  it('Reel In and Leap of Faith pull on the same floor and keep the target on its floor', () => {
    {
      const { sim, mk, run } = world();
      const w = mk('warrior', 0, { x: -5, z: 0, lv: 1 }, 'bot');
      const t = mk('mage', 1, { x: 3, z: 0, lv: 1 });
      tough(t);
      give(w, 'reel_in');
      faceTo(w, t.pos);
      assert.ok(sim.useAbility(w.id, 'reel_in', t.id).ok);
      run(100);
      assert.ok(Math.hypot(w.pos.x - t.pos.x, w.pos.z - t.pos.z) < 3, 'dragged in');
      assert.equal(t.level, 1);
      assert.ok(onRaised(ARENA, t.pos.x, t.pos.z));
    }
    {
      const { sim, mk, run } = world();
      const w = mk('warrior', 0, { x: -5, z: 0, lv: 1 }, 'bot');
      const t = mk('mage', 1, { x: -3.5, z: 0, lv: 0 });
      tough(t);
      give(w, 'reel_in');
      faceTo(w, t.pos);
      sim.useAbility(w.id, 'reel_in', t.id);
      const ev = run(100);
      assert.ok(!ev.some((e) => e.t === 'damage' && e.tgt === t.id), 'not through the floor');
      assert.ok(Math.hypot(t.pos.x + 3.5, t.pos.z) < 0.01, 'and not dragged either');
    }
    {
      const { sim, mk, run } = world();
      const p = mk('priest', 0, { x: -5, z: 0, lv: 1 }, 'bot');
      const ally = mk('warrior', 0, { x: -5, z: 0.5, lv: 0 });
      give(p, 'leap_of_faith');
      faceTo(p, ally.pos);
      const r = sim.useAbility(p.id, 'leap_of_faith', ally.id);
      run(100);
      assert.ok(!r.ok || (ally.level === 0 && !onRaised(ARENA, ally.pos.x, ally.pos.z)) || ally.level === 1, 'an ally under the floor is not hauled through it onto nothing');
    }
  });

  it('a cone (Sweep, Dragon\'s Breath, Slice and Dice) hits the floor it faces and not the one under it', () => {
    for (const id of ['sweep', 'dragons_breath', 'slice_and_dice', 'dragon_roar']) {
      const { sim, mk, run } = world();
      const c = mk(id === 'dragons_breath' ? 'mage' : id === 'slice_and_dice' ? 'rogue' : 'warrior', 0, { x: -4, z: 0, lv: 1 }, 'bot');
      const up = mk('warrior', 1, { x: -2.5, z: 0, lv: 1 });
      const below = mk('priest', 1, { x: -2.5, z: 0.2, lv: 0 });
      tough(up); tough(below);
      give(c, id);
      faceTo(c, up.pos);
      assert.ok(sim.useAbility(c.id, id, up.id).ok, id);
      const ev = run(ABILITIES[id].castTime + 800);
      assert.ok(ev.some((e) => e.t === 'damage' && e.tgt === up.id && e.ability === id), `${id}: hits the unit up on the deck`);
      assert.ok(!ev.some((e) => e.t === 'damage' && e.tgt === below.id && e.ability === id), `${id}: not the unit under the floor`);
    }
  });

  it('Bladestorm and the novas hit everyone on the floor they stand on, and nobody through it', () => {
    for (const id of ['bladestorm', 'frost_nova', 'holy_nova', 'arcane_explosion', 'fan_of_knives', 'whirlwind', 'shockwave']) {
      const { sim, mk, run } = world();
      const c = mk(id === 'bladestorm' || id === 'whirlwind' || id === 'shockwave' ? 'warrior' : id === 'holy_nova' ? 'priest' : id === 'fan_of_knives' ? 'rogue' : 'mage', 0, { x: -4, z: 0, lv: 1 }, 'bot');
      const up = mk('warrior', 1, { x: -2.5, z: 0, lv: 1 });
      const below = mk('priest', 1, { x: -4.2, z: 0.2, lv: 0 });
      tough(up); tough(below);
      give(c, id);
      faceTo(c, up.pos);
      assert.ok(sim.useAbility(c.id, id, up.id).ok, id);
      const ev = run((ABILITIES[id].castTime || 0) + 1200);
      const hurt = (u: Unit) => ev.some((e) => (e.t === 'damage' || e.t === 'aura') && e.tgt === u.id && ('src' in e) && e.src === c.id);
      if (ABILITIES[id].effects.some((e) => e.type === 'damage' || e.type === 'aura')) assert.ok(hurt(up), `${id}: hits the unit on the deck`);
      assert.ok(!hurt(below), `${id}: not the unit under the floor`);
    }
  });
});

describe('melee, auto-attacks and stealth across floors', () => {
  it('melee strikes and auto-attacks do not reach up or down a floor', () => {
    for (const [cls, ab] of [['warrior', 'mortal_strike'], ['rogue', 'sinister_strike']] as const) {
      const { sim, mk, run } = world();
      const a = mk(cls, 0, DECK1, 'bot');
      const t = mk('mage', 1, { x: -3.2, z: 0, lv: 0 });
      tough(t);
      give(a, ab);
      sim.setTarget(a.id, t.id);
      sim.setAutoAttack(a.id, true);
      const r = sim.useAbility(a.id, ab, t.id);
      assert.ok(!r.ok, `${ab} refused`);
      const ev = run(4000);
      assert.ok(!ev.some((e) => e.t === 'damage' && e.src === a.id), `${cls}: no swing lands from above`);
    }
  });

  it('a stealthed rogue directly below the deck is not seen from above', () => {
    const { sim, mk } = world();
    const r = mk('rogue', 1, { x: -3, z: 0, lv: 0 });
    const mage = mk('mage', 0, { x: -3, z: 0.4, lv: 1 }, 'bot');
    sim.applyAura(r, r, 'stealth');
    assert.equal(sim.canSee(mage, r), false, 'two yards in the plan view, but a floor and three yards apart');
    const near = mk('warrior', 0, { x: -3, z: 1, lv: 0 });
    assert.equal(sim.canSee(near, r), true, 'a unit on the same floor does spot it');
  });
});
