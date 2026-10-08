import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABILITIES, ARENAS, hasLOS, ArenaSim, Bot, DEFAULT_BRAIN, MistakeWatch, ReplayRecorder, TUNING, botBuild, brainDiff, buildReport, clampBrain, formatReport, lessonBrain, limitChange, mergeLessons,
  mistakeLessons, sanityClamp, studyMatch, BRAIN_BOUNDS, BRAIN_KEYS, EMPTY_GRADED, averageGraded, gradedNudges, GradedWatch,
} from '../src/index';
import type { Brain, ClassId, Graded, SimEvent, TeamId, Unit } from '../src/index';

const TICK = TUNING.tickMs;
const fresh = () => new ArenaSim({ seed: 7, prepMs: 0 });
const unit = (sim: ArenaSim, classId: ClassId, team: TeamId, x: number, z: number, controller: 'bot' | 'player' | 'dummy' = 'bot', spec?: string): Unit => {
  const u = sim.addUnit({ name: `${classId}${team}${x}`, classId, team, controller, build: spec ? { spec, talents: [], gear: {} } : undefined });
  u.pos = { x, z };
  return u;
};
function go(sim: ArenaSim, bots: Bot[], ms: number, stop?: () => boolean): SimEvent[] {
  const out: SimEvent[] = [];
  if (sim.tickNo === 0 && sim.prepEndsAt === 0) {
    sim.step();
    sim.drainEvents();
  }
  for (let t = 0; t < ms; t += TICK) {
    for (const b of bots) b.tick();
    sim.step();
    out.push(...sim.drainEvents());
    if (stop?.()) break;
  }
  return out;
}
const brainWith = (o: Partial<Brain>): Brain => ({ ...DEFAULT_BRAIN, ...o });
const casts = (ev: SimEvent[], unitId: number) => ev.filter((e) => (e.t === 'cast' || e.t === 'cast_start') && e.unit === unitId).map((e) => (e as { ability: string }).ability);

// ------------------------------------------------------------------------------------------------ bot behaviour

describe('the new brain numbers change what a bot does', () => {
  it('trinketAt: a stunned bot with the cleanse trinket breaks out sooner the higher it is', () => {
    const when = (trinketAt: number) => {
      const sim = fresh();
      const me = unit(sim, 'warrior', 0, 0, 0);
      const foe = unit(sim, 'warrior', 1, 6, 0, 'dummy');
      me.trinket = 'trinket_cleanse';
      const b = new Bot(sim, me.id, 'normal', 3, brainWith({ trinketAt }));
      go(sim, [], 1); // live
      sim.applyAura(foe, me, 'concussion_stun', 4000);
      const start = sim.time;
      const ev = go(sim, [b], 3000, () => !!me.cooldowns.trinket_cleanse);
      assert.ok(ev.some((e) => e.t === 'cast' && e.unit === me.id && e.ability === 'trinket_cleanse'), 'it used the trinket');
      return sim.time - start;
    };
    assert.ok(when(1) < when(0), `eager ${when(1)} ms, slow ${when(0)} ms`);
  });

  it('trinketAt: the heal trinket is used at a higher health the higher it is', () => {
    const used = (trinketAt: number) => {
      const sim = fresh();
      const me = unit(sim, 'warrior', 0, 0, 0);
      const foe = unit(sim, 'warrior', 1, 3, 0, 'dummy');
      me.trinket = 'trinket_heal';
      foe.target = me.id;
      me.health = me.maxHealth * 0.55;
      const b = new Bot(sim, me.id, 'hard', 3, brainWith({ trinketAt, panicHp: 0.3, dangerAt: 0.7 }));
      return casts(go(sim, [b], 2000), me.id).includes('trinket_heal');
    };
    assert.equal(used(1), true);
    assert.equal(used(0), false);
  });

  it('burstUse: a hurt rogue pops Adrenaline Rush at once with a high number, and holds it with a low one (target still healthy)', () => {
    const popped = (burstUse: number) => {
      const sim = fresh();
      const me = unit(sim, 'rogue', 0, 0, 0, 'bot', 'combat');
      const foe = unit(sim, 'warrior', 1, 3, 0, 'dummy');
      foe.maxHealth = foe.health = 1e6;
      me.health = me.maxHealth * 0.5;
      const b = new Bot(sim, me.id, 'hard', 3, brainWith({ burstUse, burstHp: 0.05, defHp: 0.25, panicHp: 0.15 }));
      return casts(go(sim, [b], 2500), me.id).includes('adrenaline_rush');
    };
    assert.equal(popped(1), true, 'losing: everything goes');
    assert.equal(popped(0), false, 'the old rule: only when the target is nearly dead');
  });

  it('peelAt: a healer with melee on it screams before it is hurt when the number is high', () => {
    const peeled = (peelAt: number) => {
      const sim = fresh();
      const me = unit(sim, 'priest', 0, 0, 0, 'bot', 'holy');
      unit(sim, 'warrior', 0, -6, 0, 'dummy');
      const foe = unit(sim, 'warrior', 1, 3, 0, 'dummy');
      foe.maxHealth = foe.health = 1e6;
      foe.target = me.id;
      const b = new Bot(sim, me.id, 'hard', 3, brainWith({ peelAt, preShield: 0.5 }));
      return casts(go(sim, [b], 2500), me.id).includes('psychic_scream');
    };
    assert.equal(peeled(1), true);
    assert.equal(peeled(0), false);
  });

  it('shieldAt: the healer shields a hurt ally first when the number is high, heals first when it is low', () => {
    const first = (shieldAt: number) => {
      const sim = fresh();
      const me = unit(sim, 'priest', 0, 0, 0, 'bot', 'holy');
      const ally = unit(sim, 'warrior', 0, 4, 0, 'dummy');
      unit(sim, 'warrior', 1, 22, 0, 'dummy');
      ally.health = ally.maxHealth * 0.6;
      const b = new Bot(sim, me.id, 'hard', 3, brainWith({ shieldAt, preShield: 0.5 }));
      const c = go(sim, [b], 1500);
      return c.find((e) => e.t === 'cast' && e.unit === me.id && e.target === ally.id && ['power_word_shield', 'flash_heal', 'greater_heal', 'holy_word', 'pain_suppression'].includes(e.ability)) as Extract<SimEvent, { t: 'cast' }> | undefined;
    };
    assert.equal(first(0.8)?.ability, 'power_word_shield');
    assert.notEqual(first(0.25)?.ability, 'power_word_shield');
  });

  it('healCap: no heal on an ally above the cap', () => {
    const healed = (healCap: number) => {
      const sim = fresh();
      const me = unit(sim, 'priest', 0, 0, 0, 'bot', 'holy');
      const ally = unit(sim, 'warrior', 0, 4, 0, 'dummy');
      unit(sim, 'warrior', 1, 22, 0, 'dummy');
      ally.health = ally.maxHealth * 0.93;
      const b = new Bot(sim, me.id, 'hard', 3, brainWith({ healCap, healAt: 1.3, preShield: 0.5 }));
      const ev = go(sim, [b], 4000);
      return ev.some((e) => (e.t === 'cast' || e.t === 'cast_start') && e.unit === me.id && e.target === ally.id);
    };
    assert.equal(healed(0.99), true);
    assert.equal(healed(0.6), false);
  });

  it('switchHp: a bot finishes a nearly dead target instead of switching to a healthier one', () => {
    const target = (switchHp: number) => {
      const sim = fresh();
      const me = unit(sim, 'priest', 0, 0, 0, 'bot', 'holy');
      const weak = unit(sim, 'warrior', 1, 0, 30, 'dummy');
      weak.maxHealth = 1e6;
      weak.health = 1e6 * 0.15;
      const b = new Bot(sim, me.id, 'hard', 3, brainWith({ switchHp, stickiness: 0, killLow: 20, chase: 0, focus: 0, healerPrio: 0 }));
      go(sim, [b], 400);
      assert.equal(me.target, weak.id, 'starts on the only enemy');
      const strong = unit(sim, 'warrior', 1, 3, 3, 'dummy');
      strong.maxHealth = strong.health = 1e6;
      go(sim, [b], 3500);
      return me.target === weak.id;
    };
    assert.equal(target(0.3), true, 'stays on the weak one');
    assert.equal(target(0), false, 'drops it for the closer, healthier one');
  });

  it('stickiness: a bot leaves a target it cannot hit (behind a pillar) sooner the lower the number is', () => {
    const left = (stickiness: number) => {
      const sim = fresh();
      const me = unit(sim, 'mage', 0, -10, -16, 'bot', 'frost');
      const a = unit(sim, 'warrior', 1, -16, -7, 'dummy');
      a.maxHealth = a.health = 1e6;
      const foe = unit(sim, 'warrior', 1, 30, 30, 'dummy');
      sim.applyAura(foe, me, 'frost_nova_root', 60000); // it stays where the pillar hides the target
      const b = new Bot(sim, me.id, 'hard', 3, brainWith({ stickiness, chase: 0 }));
      foe.pos = { x: -4, z: -16 };
      foe.maxHealth = foe.health = 1e6;
      go(sim, [b], 400);
      assert.equal(me.target, foe.id === me.target ? foe.id : a.id === me.target ? a.id : -1);
      const first = me.target;
      a.pos = { x: -10, z: 1 };
      assert.ok(!hasLOS(me.pos, a.pos, sim.arena), 'hidden');
      const t0 = sim.time;
      go(sim, [b], 8000, () => me.target !== first);
      return me.target !== first ? sim.time - t0 : Infinity;
    };
    assert.ok(left(0) <= left(30), `loose ${left(0)} ms, sticky ${left(30)} ms`);
  });

  it('losCheck: a normal bot stops a cast at a target behind a pillar sooner with a high number', () => {
    const stopped = (losCheck: number) => {
      const sim = fresh();
      const me = unit(sim, 'mage', 0, -10, -16, 'bot', 'frost');
      const foe = unit(sim, 'priest', 1, -16, -7, 'dummy');
      foe.maxHealth = foe.health = 1e6;
      const b = new Bot(sim, me.id, 'normal', 3, brainWith({ losCheck }));
      go(sim, [b], 6000, () => !!me.cast && (me.cast.end - me.cast.start) >= 1500);
      if (!me.cast) return null;
      foe.pos = { x: -10, z: 1 };
      const t0 = sim.time;
      const ev: SimEvent[] = [];
      for (let t = 0; t < 2000 && !ev.some((e) => e.t === 'cast_fail' && e.unit === me.id); t += TICK) ev.push(...go(sim, [b], TICK));
      return ev.some((e) => e.t === 'cast_fail' && e.unit === me.id) ? sim.time - t0 : null;
    };
    const quick = stopped(1);
    const slow = stopped(0);
    assert.ok(quick !== null && slow !== null && quick < slow, `quick ${quick} slow ${slow}`);
  });

  it('rangeBuffer: no cast begins within the buffer of the maximum range', () => {
    const sim = fresh();
    const me = unit(sim, 'mage', 0, 0, 0, 'bot', 'frost');
    const foe = unit(sim, 'warrior', 1, 0, ABILITIES.frostbolt.range - 1.5, 'dummy');
    go(sim, [], 1);
    const tryCast = (rangeBuffer: number) => {
      const b = new Bot(sim, me.id, 'hard', 3, brainWith({ rangeBuffer })) as unknown as { use(u: Unit, a: string, t?: number): boolean };
      return b.use(me, 'frostbolt', foe.id);
    };
    assert.equal(tryCast(3), false, 'within 3 yards of the maximum: it holds the cast');
    assert.equal(tryCast(0), true, 'the same shot with no buffer goes off');
  });

  it('drRespect: a careful bot keeps crowd control off a target already at a quarter of its length', () => {
    const sim = fresh();
    const me = unit(sim, 'rogue', 0, 0, 0, 'bot');
    const foe = unit(sim, 'warrior', 1, 2, 0, 'dummy');
    go(sim, [], 1);
    foe.dr.stun = { count: 2, resetAt: sim.time + 15000 };
    const wastes = (drRespect: number) => (new Bot(sim, me.id, 'hard', 3, brainWith({ drRespect })) as unknown as { wastesCC(u: Unit, a: string, t?: number): boolean }).wastesCC(me, 'kidney_shot', foe.id);
    assert.equal(wastes(0), false, 'the old rule: only at full immunity');
    assert.equal(wastes(1), true);
  });

  it('spendBias: a priest keeps its mana for heals (no filler on an empty bar), and a mage Evocates sooner', () => {
    const smites = (spendBias: number) => {
      const sim = fresh();
      const me = unit(sim, 'priest', 0, 0, 0, 'bot', 'holy');
      unit(sim, 'warrior', 1, 12, 0, 'dummy');
      me.resource = me.resourceMax * 0.2;
      const b = new Bot(sim, me.id, 'hard', 3, brainWith({ spendBias }));
      return casts(go(sim, [b], 2500), me.id).some((a) => ['smite', 'mind_blast', 'penance', 'plague_bloom', 'mind_flay'].includes(a));
    };
    assert.equal(smites(0), true);
    assert.equal(smites(1), false);
    const evoc = (spendBias: number) => {
      const sim = fresh();
      const me = unit(sim, 'mage', 0, 0, 0, 'bot', 'frost');
      unit(sim, 'warrior', 1, 22, 0, 'dummy');
      me.bar = [...me.bar, 'evocation'];
      me.resource = me.resourceMax * 0.5;
      const b = new Bot(sim, me.id, 'hard', 3, brainWith({ spendBias }));
      return casts(go(sim, [b], 1500), me.id).includes('evocation');
    };
    assert.equal(evoc(1), true);
    assert.equal(evoc(0), false);
  });

  it('every new number has bounds, a default, and an older brain file without them still loads', () => {
    const fresh2 = ['trinketAt', 'burstUse', 'peelAt', 'shieldAt', 'healCap', 'switchHp', 'stickiness', 'losCheck', 'rangeBuffer', 'drRespect', 'spendBias'] as const;
    for (const k of fresh2) {
      assert.ok(BRAIN_BOUNDS[k] && BRAIN_BOUNDS[k][0] < BRAIN_BOUNDS[k][1], k);
      assert.ok(DEFAULT_BRAIN[k] >= BRAIN_BOUNDS[k][0] && DEFAULT_BRAIN[k] <= BRAIN_BOUNDS[k][1], `${k} default in bounds`);
      assert.ok(BRAIN_KEYS.includes(k), `${k} is trained and mutated like the rest`);
    }
    const old = clampBrain({ defHp: 0.3, strafe: 0.2 });
    for (const k of fresh2) assert.equal(old[k], DEFAULT_BRAIN[k]);
  });
});

// ------------------------------------------------------------------------------------------------ detectors

/** A sim with a bot and a person on the other team, plus the watch over the bot. */
function setup(botClass: ClassId, foeClass: ClassId = 'warrior', botSpec?: string) {
  const sim = fresh();
  const me = unit(sim, botClass, 0, 0, 0, 'bot', botSpec);
  const foe = unit(sim, foeClass, 1, 4, 0, 'player');
  foe.maxHealth = foe.health = 1e6;
  go(sim, [], 1);
  const kinds = new Map<number, 'human' | 'bot' | 'other'>([[me.id, 'bot'], [foe.id, 'human']]);
  const watch = new MistakeWatch(kinds, [me.id]);
  const step = (ms: number, each?: () => void) => {
    for (let t = 0; t < ms; t += TICK) {
      each?.();
      sim.step();
      for (const ev of sim.drainEvents()) watch.event(sim, ev);
      watch.tick(sim);
    }
  };
  return { sim, me, foe, watch, kinds, step };
}

describe('the replay shows each mistake', () => {
  it('locked down with the trinket ready, and dying with it (or an offensive cooldown) ready', () => {
    const s = setup('warrior');
    s.me.trinket = 'trinket_cleanse';
    s.sim.applyAura(s.foe, s.me, 'concussion_stun', 4000);
    s.step(2500);
    assert.equal(s.watch.counts(s.me.id).lockedTrinket, 1, 'counted once per lock-down, not every tick');
    const d = setup('warrior', 'mage', 'fury');
    d.me.trinket = 'trinket_heal';
    d.watch.event(d.sim, { t: 'death', unit: d.me.id, killer: d.foe.id });
    assert.equal(d.watch.counts(d.me.id).diedTrinket, 1);
    assert.equal(d.watch.counts(d.me.id).diedBurst, 1, 'Recklessness was ready');
    const used = setup('warrior', 'mage', 'fury');
    used.me.cooldowns = { recklessness: used.sim.time + 30000, bladestorm: used.sim.time + 30000 };
    used.watch.event(used.sim, { t: 'death', unit: used.me.id, killer: used.foe.id });
    assert.equal(used.watch.counts(used.me.id).diedBurst ?? 0, 0, 'cooldowns spent: no mistake');
  });

  it('a caster standing still with melee on it and a push-off ready, but not one that moves', () => {
    const still = setup('mage', 'warrior', 'frost');
    still.foe.pos = { x: 3, z: 0 };
    still.foe.target = still.me.id;
    still.step(2600);
    assert.ok((still.watch.counts(still.me.id).stoodPinned ?? 0) >= 1);
    const moving = setup('mage', 'warrior', 'frost');
    moving.foe.pos = { x: 3, z: 0 };
    moving.foe.target = moving.me.id;
    let i = 0;
    moving.step(2600, () => {
      moving.me.pos = { x: 0.5 * i++, z: 0 };
      moving.foe.pos = { x: moving.me.pos.x + 3, z: 0 };
    });
    assert.equal(moving.watch.counts(moving.me.id).stoodPinned ?? 0, 0);
  });

  it('a healer: an ally dies with the shield ready, an ally at 30% goes unhealed, heals thrown at full health', () => {
    const sim = fresh();
    const healer = unit(sim, 'priest', 0, 0, 0, 'bot', 'holy');
    const ally = unit(sim, 'warrior', 0, 5, 0, 'bot');
    const foe = unit(sim, 'warrior', 1, 12, 0, 'player');
    go(sim, [], 1);
    const kinds = new Map<number, 'human' | 'bot' | 'other'>([[healer.id, 'bot'], [ally.id, 'bot'], [foe.id, 'human']]);
    const watch = new MistakeWatch(kinds, [healer.id, ally.id]);
    ally.health = ally.maxHealth * 0.3;
    for (let t = 0; t < 1500; t += TICK) {
      sim.step();
      for (const ev of sim.drainEvents()) watch.event(sim, ev);
      watch.tick(sim);
    }
    assert.ok((watch.counts(healer.id).healIdle ?? 0) >= 1, 'a healer with nothing running while an ally is at 30%');
    watch.event(sim, { t: 'death', unit: ally.id, killer: foe.id });
    assert.equal(watch.counts(healer.id).allyDiedHealer, 1);
    watch.event(sim, { t: 'heal', src: healer.id, tgt: ally.id, amount: 20, overheal: 180, ability: 'flash_heal' });
    watch.event(sim, { t: 'heal', src: healer.id, tgt: ally.id, amount: 180, overheal: 20, ability: 'flash_heal' });
    assert.equal(watch.counts(healer.id).overheal, 1, 'only the heal that was mostly wasted');
  });

  it('target switching: dropping a target under 30%, and sticking to one it cannot hit', () => {
    const s = setup('mage', 'warrior', 'frost');
    const weak = unit(s.sim, 'rogue', 1, 8, 0, 'player');
    weak.maxHealth = 1000;
    weak.health = 200;
    s.kinds.set(weak.id, 'human');
    s.me.target = weak.id;
    s.step(100);
    s.me.target = s.foe.id;
    s.step(100);
    assert.equal(s.watch.counts(s.me.id).droppedLow, 1);
    const b = setup('mage', 'warrior', 'frost');
    b.me.target = b.foe.id;
    b.sim.applyAura(b.foe, b.foe, 'ascended', 6000);
    b.step(3500, () => (b.me.target = b.foe.id));
    assert.equal(b.watch.counts(b.me.id).badTarget, 1);
  });

  it('casts lost to sight or range, crowd control into diminishing returns, and an empty mana bar', () => {
    const s = setup('mage', 'warrior', 'frost');
    s.watch.event(s.sim, { t: 'cast_fail', unit: s.me.id, ability: 'frostbolt', reason: 'no line of sight' });
    s.watch.event(s.sim, { t: 'cast_fail', unit: s.me.id, ability: 'frostbolt', reason: 'out of range' });
    s.watch.event(s.sim, { t: 'cast_fail', unit: s.me.id, ability: 'frostbolt', reason: 'interrupted' });
    s.watch.event(s.sim, { t: 'immune', src: s.me.id, tgt: s.foe.id, aura: 'deep_freeze_stun' });
    s.watch.event(s.sim, { t: 'aura', src: s.me.id, tgt: s.foe.id, aura: 'deep_freeze_stun', expiresAt: 1, dr: 0.25 });
    s.watch.event(s.sim, { t: 'aura', src: s.me.id, tgt: s.foe.id, aura: 'deep_freeze_stun', expiresAt: 1, dr: 1 });
    const c = s.watch.counts(s.me.id);
    assert.equal(c.castNoLos, 1);
    assert.equal(c.castOutOfRange, 1);
    assert.equal(c.ccWasted, 2);
    s.me.resource = 0;
    s.step(1500);
    assert.ok((s.watch.counts(s.me.id).manaStarved ?? 0) >= 1);
  });

  it('a real replay carries the counts, and the report lists them', () => {
    const arena = ARENAS[1];
    const sim = new ArenaSim({ seed: 3, prepMs: 3000, arena });
    const rec = new ReplayRecorder(sim, { arena: arena.id, seed: 3, prepMs: 3000 });
    const p = sim.addUnit({ name: 'P', classId: 'warrior', team: 0, controller: 'player', build: botBuild('warrior', 3) });
    const b = sim.addUnit({ name: 'B', classId: 'mage', team: 1, controller: 'bot', build: botBuild('mage', 12) });
    const drivers = [new Bot(sim, p.id, 'hard', 1), new Bot(sim, b.id, 'easy', 2)];
    for (let ms = 0; sim.phase !== 'ended' && ms < 150000; ms += 50) {
      for (const d of drivers) d.tick();
      sim.step();
      sim.drainEvents();
    }
    const study = studyMatch(rec.finish([]));
    assert.equal(study.bots.length, 1);
    assert.equal(typeof study.bots[0].facts.mistakes, 'object');
    const report = buildReport({ id: 'x', replayId: 'r', at: 1, source: 'owner', passes: 1, study, classes: [{ classId: 'mage', moved: [{ key: 'peelAt', before: 0.5, after: 0.62 }], replays: 3 }], habits: 1 });
    const text = formatReport(report).join('\n');
    assert.match(text, /mage: peelAt 0\.50 -> 0\.62/);
    assert.match(text, /mage bot \((won|lost) against warrior/);
    assert.equal(report.nothing, null);
    const none = buildReport({ id: 'x', replayId: 'r', at: 1, source: 'owner', passes: 1, study: { bots: [], players: [] }, classes: [], habits: 0 });
    assert.match(none.headline, /^Nothing to learn from this match: no bot fought a person/);
  });
});

// ------------------------------------------------------------------------------------------------ lessons

describe('what each mistake teaches', () => {
  const direction: [string, Parameters<typeof mistakeLessons>[0], ClassId, keyof Brain, 'up' | 'down'][] = [
    ['locked with the trinket', { lockedTrinket: 4 }, 'warrior', 'trinketAt', 'up'],
    ['died with the trinket', { diedTrinket: 4 }, 'rogue', 'trinketAt', 'up'],
    ['died with a cooldown', { diedBurst: 4 }, 'warrior', 'burstUse', 'up'],
    ['stood pinned', { stoodPinned: 4 }, 'mage', 'peelAt', 'up'],
    ['ally died, shield ready', { allyDiedHealer: 4 }, 'priest', 'shieldAt', 'up'],
    ['ally unhealed', { healIdle: 6 }, 'priest', 'healAt', 'up'],
    ['overheal', { overheal: 6 }, 'priest', 'healCap', 'down'],
    ['dropped a nearly dead target', { droppedLow: 4 }, 'mage', 'switchHp', 'up'],
    ['kept hitting what it could not hit', { badTarget: 4 }, 'rogue', 'stickiness', 'down'],
    ['no line of sight', { castNoLos: 4 }, 'mage', 'losCheck', 'up'],
    ['out of range', { castOutOfRange: 4 }, 'priest', 'rangeBuffer', 'up'],
    ['wasted crowd control', { ccWasted: 4 }, 'rogue', 'drRespect', 'up'],
    ['out of mana', { manaStarved: 4 }, 'mage', 'spendBias', 'up'],
  ];
  for (const [name, counts, cls, key, dir] of direction) {
    it(`${name}: ${key} moves ${dir}, more mistakes move it further, never past its bounds`, () => {
      const few = mistakeLessons({ ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, 1])) }, cls, 1.5);
      const many = mistakeLessons(counts, cls, 1.5);
      const lots = mistakeLessons(Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, (v as number) * 50])), cls, 1.5);
      assert.ok(many[key], `${key} has a lesson`);
      const base = DEFAULT_BRAIN;
      const step = (l: typeof many) => Math.abs(lessonBrain(base, l, 0.8, 150)[key] - base[key]);
      const moved = lessonBrain(base, many, 0.8, 150)[key];
      assert.ok(dir === 'up' ? moved > base[key] : moved < base[key], `${key} ${base[key]} -> ${moved}`);
      assert.ok(many[key]!.weight > few[key]!.weight, 'more evidence');
      assert.ok(step(many) >= step(few), 'a bigger step for more mistakes');
      const extreme = lessonBrain(base, lots, 0.8, 150)[key];
      assert.ok(extreme >= BRAIN_BOUNDS[key][0] && extreme <= BRAIN_BOUNDS[key][1]);
    });
  }

  it('healer lessons are for priests and mana lessons for casters only', () => {
    assert.equal(mistakeLessons({ overheal: 9, allyDiedHealer: 9 }, 'warrior', 1).healCap, undefined);
    assert.equal(mistakeLessons({ manaStarved: 9 }, 'warrior', 1).spendBias, undefined);
  });

  it('old evidence fades, one replay moves a number a limited way, and nothing drifts far from what shipped', () => {
    const a = mergeLessons({ peelAt: { value: 1, weight: 100 } }, { peelAt: { value: 0.5, weight: 100 } });
    assert.ok(a.peelAt!.weight < 200 && a.peelAt!.value < 0.8 && a.peelAt!.value > 0.5, 'older evidence counts a little less');
    const prev = DEFAULT_BRAIN;
    const big = limitChange(prev, { ...prev, peelAt: 1, trinketAt: 1 }, 0.2);
    assert.ok(Math.abs(big.peelAt - prev.peelAt) <= 0.2 + 1e-9);
    const far = sanityClamp({ ...prev, stickiness: 0, peelAt: 1 }, prev, 0.6);
    assert.ok(far.stickiness >= prev.stickiness - 0.6 * 40 - 1e-9);
    assert.deepEqual(brainDiff(prev, prev), []);
    assert.equal(brainDiff(prev, { ...prev, peelAt: 0.9 })[0].key, 'peelAt');
  });
});

// ------------------------------------------------------------------------------------------------ movement and graded signals

describe('movement numbers change what a bot does', () => {
  it('stayNear: a fighter walks back to a healer that is too far away, the more the higher the number is', () => {
    const gap = (stayNear: number) => {
      const sim = fresh();
      const me = unit(sim, 'warrior', 0, 0, 0, 'bot', 'arms');
      const healer = unit(sim, 'priest', 0, -33, 0, 'dummy');
      const foe = unit(sim, 'warrior', 1, 5, 0, 'dummy');
      foe.maxHealth = foe.health = 1e6;
      const b = new Bot(sim, me.id, 'hard', 3, brainWith({ stayNear }));
      go(sim, [b], 3000);
      return Math.hypot(me.pos.x - healer.pos.x, me.pos.z - healer.pos.z);
    };
    assert.ok(gap(1) < gap(0) - 5, `high ${gap(1)} low ${gap(0)}`);
  });

  it('edgeCare: no hop for its own sake near a lava pit rim', () => {
    const lava = ARENAS.find((a) => a.lows?.some((r) => r.lava))!;
    const pit = lava.lows!.find((r) => r.lava)!;
    const sim = new ArenaSim({ seed: 7, prepMs: 0, arena: lava });
    const me = unit(sim, 'warrior', 0, pit.x0 - 1.5, (pit.z0 + pit.z1) / 2, 'bot', 'arms');
    const far = { x: pit.x0 - 40, z: (pit.z0 + pit.z1) / 2 };
    const hops = (edgeCare: number, at: { x: number; z: number }) => {
      const b = new Bot(sim, me.id, 'hard', 3, brainWith({ edgeCare })) as unknown as { hop(u: Unit): void; jumpNow: boolean };
      me.pos = at;
      b.jumpNow = false;
      b.hop(me);
      return b.jumpNow;
    };
    assert.equal(hops(1, { x: pit.x0 - 1.5, z: (pit.z0 + pit.z1) / 2 }), false, 'at the rim: no hop');
    assert.equal(hops(1, { x: pit.x0 - 4, z: (pit.z0 + pit.z1) / 2 }), false, 'a careful bot keeps its distance');
    assert.equal(hops(0, { x: pit.x0 - 4, z: (pit.z0 + pit.z1) / 2 }), true, 'a careless bot hops there');
    assert.equal(hops(1, far), true, 'far from the lava it hops freely');
  });

  it('graded comparisons ask for the right movement and gameplay changes, at a strength that grows with the difference', () => {
    const people: Graded = { ...EMPTY_GRADED, sec: 60, still: 0.1, exposed: 0.3, losBreaks: 6, strafed: 0.7, dist: 20, healerOut: 0, lava: 0, cdIdle: 0.05, defHp: 0.6, trinketHp: 0.4, switches: 4 };
    const bot: Graded = { ...people, still: 0.6, exposed: 0.8, losBreaks: 1, strafed: 0.2, dist: 12, healerOut: 0.5, lava: 3, cdIdle: 0.6, defHp: 0.25, trinketHp: null, switches: 14 };
    const caster = Object.fromEntries(gradedNudges(bot, people, 'mage').map((n) => [n.metric, n]));
    assert.deepEqual(caster['standing still'].keys, ['mobility', 'strafe']);
    assert.equal(caster['standing still'].sign, 1);
    assert.deepEqual(caster['time in the open'].keys, ['coverHp', 'losUse']);
    assert.deepEqual(caster['line-of-sight breaks'].keys, ['losUse']);
    assert.deepEqual(caster['sidestepping'].keys, ['strafe']);
    assert.equal(caster['spacing'].sign, 1, 'closer than the people: keeps further away');
    assert.deepEqual(caster['spacing'].keys, ['rangeBias']);
    assert.deepEqual(caster['staying near the healer'].keys, ['stayNear']);
    assert.deepEqual(caster['lava'].keys, ['edgeCare']);
    assert.deepEqual(caster['offensive cooldowns'].keys, ['burstUse', 'burstHp']);
    assert.deepEqual(caster['defensive timing'].keys, ['defHp', 'panicHp']);
    assert.deepEqual(caster['target switching'].keys, ['stickiness', 'switchHp']);
    assert.deepEqual(caster['trinket use'].keys, ['trinketAt']);
    const melee = Object.fromEntries(gradedNudges({ ...bot, dist: 9 }, { ...people, dist: 3 }, 'warrior').map((n) => [n.metric, n]));
    assert.deepEqual(melee['chasing'].keys, ['chase', 'mobility']);
    assert.ok(caster['standing still'].strength > gradedNudges({ ...bot, still: 0.2 }, people, 'mage').find((n) => n.metric === 'standing still')!.strength);
    assert.deepEqual(gradedNudges(people, people, 'mage'), [], 'played exactly like the people: nothing to ask');
    assert.deepEqual(gradedNudges({ ...bot, sec: 3 }, people, 'mage'), [], 'too short a fight to compare');
    assert.ok(averageGraded([people, { ...people, still: 0.3 }])!.still > 0.1);
  });

  it('the watch measures standing still, being seen, strafing and lava on a real unit', () => {
    const sim = fresh();
    const me = unit(sim, 'mage', 0, 0, 0, 'bot', 'frost');
    const foe = unit(sim, 'warrior', 1, 15, 0, 'dummy');
    me.target = foe.id;
    go(sim, [], 1);
    const w = new GradedWatch([me.id]);
    for (let t = 0; t < 4000; t += TICK) {
      sim.step();
      for (const ev of sim.drainEvents()) w.event(sim, ev);
      w.tick(sim);
    }
    const g = w.graded(me.id);
    assert.ok(g.sec > 3.5);
    assert.ok(g.still > 0.9, `still ${g.still}`);
    assert.ok(g.exposed > 0.9, 'in plain sight');
    assert.ok(Math.abs(g.dist - 15) < 0.5);
  });
});
