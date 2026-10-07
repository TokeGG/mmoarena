import { ABILITIES, AURAS, TUNING } from './data';
import { angleTo, dist, distPointToSegment, hasLOS } from './geometry';
import type { ArenaSim } from './sim';
import type { ClassId, Unit, Vec2 } from './types';

import { SPECS } from './data';
import { autoFor } from './build';
import type { Build } from './types';
import { brainFor } from './botbrain';
import type { Brain } from './botbrain';

/** A bot's loadout: one of the class's specs, so bots field every weapon spec and bar that exists in the data. */
export function botBuild(classId: ClassId, seed: number): Build {
  const specs = SPECS[classId];
  return { spec: specs[Math.abs(seed) % specs.length].id, talents: [], gear: {} };
}

export type Difficulty = 'easy' | 'normal' | 'hard';

/**
 * react: how long a bot needs to notice something (a cast, a crowd control on an ally) before it responds.
 * think: ticks between decisions (movement is still sent every tick).
 * interruptChance: fraction of enemy casts the bot even tries to interrupt.
 */
const PARAMS: Record<Difficulty, { react: number; think: number; interruptChance: number }> = {
  easy: { react: 700, think: 4, interruptChance: 0.4 },
  normal: { react: 650, think: 3, interruptChance: 0.5 },
  hard: { react: 160, think: 1, interruptChance: 1 },
};

export const RANGED: Partial<Record<ClassId, { min: number; max: number }>> = {
  mage: { min: 14, max: 26 },
  priest: { min: 15, max: 30 },
};
const MELEE = new Set<ClassId>(['warrior', 'rogue']);
const HARD_CC = ['incapacitate', 'fear', 'stun', 'root'];

const hpFrac = (u: Unit) => u.health / u.maxHealth;
const angleDiff = (a: number, b: number) => ((((a - b + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;

function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Cmd { facing: number; fwd: number; strafe: number }

/**
 * A bot plays through exactly the same entry points as a human (queueInput, setTarget, useAbility),
 * so it obeys every rule: GCD, range, line of sight, resources, lockouts, stealth visibility.
 * Call tick() once per sim step, before sim.step().
 */
export class Bot {
  private seq = 0;
  private nextThink = 0;
  private target: number | null = null;
  private retargetAt = 0;
  private castSeen = new Map<number, { start: number; at: number; will: boolean }>();
  private auraSeen = new Map<string, number>();
  private strafeSign = 1;
  private strafeFlipAt = 0;
  private forceFacing: { angle: number; until: number } | null = null;
  private cover: Vec2 | null = null;
  private coverUntil = 0;
  private coverReadyAt = 0;
  private rng: () => number;
  private P: (typeof PARAMS)[Difficulty];
  /** A lone priest casts back to back, so every few seconds it holds its casts for a moment and moves instead. */
  private danceUntil = 0;
  private nextDance = 0;
  /** Recent health samples, to tell a burst from a slow trade. */
  private hist: { t: number; hp: number }[] = [];
  /** Recent positions, to notice being stuck against something while trying to walk. */
  private trail: { t: number; x: number; z: number; walking: boolean }[] = [];
  private unstickUntil = 0;
  private unstickSign = 1;
  /** Running round to a target's back is only worth a short try: a target that keeps turning just makes both spin. */
  private backUntil = 0;
  private backReadyAt = 0;

  readonly brain: Brain;

  constructor(private sim: ArenaSim, readonly unitId: number, difficulty: Difficulty = 'normal', seed = 1, brain?: Brain) {
    this.brain = brain ?? brainFor(sim.units.get(unitId)?.classId ?? 'warrior');
    this.P = PARAMS[difficulty];
    this.rng = mulberry32(seed);
  }

  tick(): void {
    const sim = this.sim;
    const u = sim.units.get(this.unitId);
    if (!u || !u.alive) return;
    const idle: Cmd = { facing: u.facing, fwd: 0, strafe: 0 };

    if (sim.phase === 'prep') {
      this.use(u, 'stealth');
      this.send(u, idle);
      return;
    }
    if (sim.phase === 'ended') {
      this.send(u, idle);
      return;
    }

    this.trail.push({ t: sim.time, x: u.pos.x, z: u.pos.z, walking: this.lastWalk });
    while (this.trail.length && sim.time - this.trail[0].t > 1200) this.trail.shift();
    if (sim.time >= this.unstickUntil && this.trail.length >= 20 && this.trail.every((p) => p.walking) && sim.canMove(u) && !u.cast &&
        Math.hypot(u.pos.x - this.trail[0].x, u.pos.z - this.trail[0].z) < 0.4) {
      // walking into something (a pillar edge, a ramp wall, another unit): slide sideways for a moment
      this.unstickUntil = sim.time + 600;
      this.unstickSign = this.rng() < 0.5 ? -1 : 1;
      this.trail.length = 0;
    }
    this.hist.push({ t: sim.time, hp: u.health });
    while (this.hist.length && sim.time - this.hist[0].t > 2500) this.hist.shift();
    const all = [...sim.units.values()];
    const enemies = all.filter((e) => e.alive && e.team !== u.team && sim.canSee(u, e));
    const allies = all.filter((a) => a.alive && a.team === u.team);

    this.pickTarget(u, enemies);
    const tgt = this.target !== null ? sim.units.get(this.target) : undefined;

    // nobody in sight (e.g. a stealthed rogue): walk towards where the nearest enemy is rather than standing about
    if (!enemies.length && sim.canMove(u) && !u.cast) {
      const hidden = all.filter((e) => e.alive && e.team !== u.team).sort((a, b) => dist(u.pos, a.pos) - dist(u.pos, b.pos))[0];
      if (hidden && !(u.classId === 'priest' && allies.length > 1)) {
        this.send(u, { facing: angleTo(u.pos, this.waypoint(u.pos, hidden.pos, u.level, hidden.level)), fwd: 1, strafe: 0 });
        return;
      }
    }

    // hurt: duck behind a pillar to break line of sight, wait a moment, then come back (not every few seconds)
    const threat = [...enemies].sort((a, b) => dist(u.pos, a.pos) - dist(u.pos, b.pos))[0];
    if (threat && hpFrac(u) < this.brain.coverHp && sim.time >= this.coverReadyAt && !this.cover) {
      this.cover = this.coverPoint(u, threat.pos);
      this.coverUntil = sim.time + 3500 + 3000 * (1 - hpFrac(u) / this.brain.coverHp); // the lower it is, the longer it stays hidden
      this.coverReadyAt = sim.time + 9000;
    }
    if (this.cover && (sim.time >= this.coverUntil || hpFrac(u) >= this.brain.coverHp + 0.25)) this.cover = null; // back out once healed up
    if (this.cover && sim.canMove(u)) {
      if (dist(u.pos, this.cover) > 0.9) {
        // run for it, abandoning any cast (moving cancels it)
        this.send(u, { facing: angleTo(u.pos, this.cover), fwd: 1, strafe: 0 });
        return;
      }
    }

    // standing in an enemy's Flamestrike or Blizzard: step out (a bot with a long cast to protect only leaves when it is hurting)
    if (this.brain.dodge > 0.15 && sim.canMove(u)) {
      const hz = sim.hazardsFor(u.team).find((z) => dist(u.pos, z) < z.r + 0.6);
      if (hz && (!u.cast || hpFrac(u) < this.brain.dodge * 0.9) && this.noticed(`zone:${hz.id}`)) {
        this.send(u, { facing: dist(u.pos, hz) < 0.2 ? u.facing : angleTo(hz, u.pos), fwd: 1, strafe: 0 });
        return;
      }
    }

    if (u.classId === 'priest' && allies.length <= 1 && !u.cast && sim.time >= this.nextDance && tgt) {
      this.danceUntil = sim.time + 600;
      this.nextDance = sim.time + 6000;
    }

    // Decide first, move second: if a cast just started, movement sees it and stands still.
    if (sim.time >= this.nextThink) {
      this.nextThink = sim.time + this.P.think * TUNING.tickMs;
      this.decide(u, enemies, allies, tgt);
    }
    this.send(u, this.movement(u, enemies, allies, tgt));
    if (this.auraSeen.size > 200) this.auraSeen.clear();
  }

  // ------------------------------------------------------------------ helpers

  private lastWalk = false;
  private send(u: Unit, c: Cmd): void {
    if (this.sim.time < this.unstickUntil && c.fwd > 0) c = { facing: c.facing + this.unstickSign * 1.2, fwd: 1, strafe: 0 };
    this.lastWalk = c.fwd !== 0 || c.strafe !== 0 ? c.fwd > 0 : false;
    this.sim.queueInput(u.id, { seq: ++this.seq, ...c });
  }

  private use(u: Unit, ability: string, target?: number, ground?: Vec2): boolean {
    if (this.wastesCC(u, ability, target)) return false;
    return this.sim.useAbility(u.id, ability, target, ground ?? null).ok;
  }

  /** The strongest diminishing-returns category an ability's crowd control falls in, if it has any. */
  private ccCategory(ability: string): string | null {
    for (const e of ABILITIES[ability]?.effects ?? []) if (e.type === 'aura') {
      const a = AURAS[e.aura];
      if (a?.harmful && a.dr) return a.dr;
    }
    return null;
  }

  /** Crowd control into a target that is immune to it (diminishing returns), or already locked down, is a wasted cooldown. */
  private wastesCC(u: Unit, ability: string, target?: number): boolean {
    const cat = this.ccCategory(ability);
    if (!cat) return false;
    const def = ABILITIES[ability];
    const sim = this.sim;
    const foes = def.target === 'enemy' ? [sim.units.get(target ?? -1)] : [...sim.units.values()].filter((e) => e.alive && e.team !== u.team && dist(u.pos, e.pos) <= (def.radius ?? 8));
    const worth = (e?: Unit) => {
      if (!e || e.team === u.team) return true;
      const st = e.dr[cat as 'stun'];
      const used = st && sim.time < st.resetAt ? st.count : 0;
      if ((TUNING.drSteps[Math.min(used, TUNING.drSteps.length - 1)] ?? 1) <= 0) return false; // immune
      return !e.auras.some((a) => a.kind === 'stun' || a.kind === 'fear' || a.kind === 'incapacitate'); // already out of the fight
    };
    return foes.length > 0 && !foes.some(worth);
  }

  /** How much of the damage aimed at this unit gets through right now (a shield wall or evasion lowers it). */
  private reduction(e: Unit): number {
    let r = 1;
    for (const a of e.auras) r *= AURAS[a.id]?.mods?.damageTaken ?? 1;
    return r;
  }

  /** First ability from the list that goes off: each spec's bar holds a different mix, and anything off the bar just fails. */
  private useFirst(u: Unit, abilities: string[], target?: number): boolean {
    for (const a of abilities) if (this.use(u, a, target)) return true;
    return false;
  }

  /** The ability is on the bar, off cooldown and nothing is locking abilities: pressing it now would work. Checked before turning to face an escape, so a bot never spins for a Blink it cannot cast. */
  private ready(u: Unit, id: string): boolean {
    if (!u.bar.includes(id) || (u.cooldowns[id] ?? 0) > this.sim.time) return false;
    return !u.auras.some((a) => AURAS[a.id]?.locksAbilities);
  }

  private isPolymorphed(e: Unit): boolean {
    return e.auras.some((a) => AURAS[a.id].breaksOnDamage);
  }

  private pickTarget(u: Unit, enemies: Unit[]): void {
    const sim = this.sim;
    const cur = this.target !== null ? sim.units.get(this.target) : undefined;
    if (cur && cur.alive && enemies.includes(cur) && sim.time < this.retargetAt) return;
    const pool = enemies.filter((e) => !this.isPolymorphed(e));
    const list = pool.length ? pool : enemies;
    if (!list.length) {
      this.target = null;
      return;
    }
    const B = this.brain;
    const mates = [...sim.units.values()].filter((a) => a.alive && a.team === u.team && a !== u);
    const fleeing = (e: Unit) => e === cur && e.auras.some((a) => a.kind === 'slow' || a.kind === 'root');
    const score = (e: Unit) =>
      hpFrac(e) * B.killLow + dist(u.pos, e.pos) * 0.8 - (e.classId === 'priest' ? B.healerPrio : 0) - (e === cur ? 10 : 0) -
      (mates.some((a) => a.target === e.id) ? B.focus : 0) - (fleeing(e) ? B.chase * 15 : 0) +
      (this.reduction(e) < 0.65 ? 40 : 0); // someone behind a shield wall or evasion: hit the other one while it lasts
    list.sort((a, b) => score(a) - score(b));
    this.target = list[0].id;
    this.retargetAt = sim.time + 2500;
    sim.setTarget(u.id, this.target);
  }

  /** Enemies casting something the bot has had time to notice (and chose to answer). */
  private interruptible(enemies: Unit[]): Unit[] {
    const out: Unit[] = [];
    for (const e of enemies) {
      if (!e.cast) {
        this.castSeen.delete(e.id);
        continue;
      }
      let s = this.castSeen.get(e.id);
      if (!s || s.start !== e.cast.start) {
        s = { start: e.cast.start, at: this.sim.time, will: this.rng() < this.P.interruptChance };
        this.castSeen.set(e.id, s);
      }
      if (s.will && this.sim.time - s.at >= this.P.react && this.worthInterrupt(e)) out.push(e);
    }
    return out;
  }

  /** Kicks and counterspells are on a cooldown: spend them on heals, crowd control and big casts, not on filler. */
  private worthInterrupt(e: Unit): boolean {
    const def = e.cast ? ABILITIES[e.cast.ability] : undefined;
    if (!def) return true;
    if (def.effects.some((x) => x.type === 'heal' || (x.type === 'aura' && AURAS[x.aura]?.harmful && AURAS[x.aura].dr))) return true;
    if (def.castTime >= 1500) return true;
    const victim = e.cast?.target !== undefined ? this.sim.units.get(e.cast.target) : undefined;
    return !!victim && victim.team !== e.team && hpFrac(victim) < 0.85; // a hit on someone already hurt
  }

  private noticed(key: string): boolean {
    const at = this.auraSeen.get(key) ?? this.sim.time;
    this.auraSeen.set(key, at);
    return this.sim.time - at >= this.P.react;
  }

  // ------------------------------------------------------------------ decisions

  private decide(u: Unit, enemies: Unit[], allies: Unit[], tgt: Unit | undefined): void {
    // do not break crowd control that breaks on damage (a feared or blinded lone enemy is left alone until it wakes)
    if (tgt && this.isPolymorphed(tgt) && enemies.length === 1) tgt = undefined;
    if (this.survive(u, enemies, allies, tgt)) return;
    switch (u.classId) {
      case 'warrior':
        return this.warrior(u, enemies, tgt);
      case 'rogue':
        return this.rogue(u, enemies, tgt);
      case 'mage':
        return this.mage(u, enemies, tgt);
      case 'priest':
        return this.priest(u, enemies, allies, tgt);
    }
  }

  /** Net health lost over the last couple of seconds, as a fraction of max health (healing offsets it). */
  private recentLoss(u: Unit): number {
    let peak = u.health;
    for (const h of this.hist) peak = Math.max(peak, h.hp);
    return (peak - u.health) / u.maxHealth;
  }

  /**
   * Staying alive comes before dealing damage. When health is low, or a burst is landing, each class reaches for the
   * spells it has for that: damage reduction and heals, shields, stuns and fears on whoever is on it, a sheep, an escape.
   * Returns true when it spent its decision on that.
   */
  private survive(u: Unit, enemies: Unit[], allies: Unit[], tgt?: Unit): boolean {
    const B = this.brain;
    const f = hpFrac(u);
    const loss = this.recentLoss(u);
    const emergency = f < B.panicHp || (loss > B.dangerAt && f < 0.8);
    const hurting = f < B.defHp + 0.25 * B.ccEarly || loss > B.dangerAt * 0.6;
    if (!emergency && !hurting) return false;
    const sim = this.sim;
    const byDist = [...enemies].sort((a, b) => dist(u.pos, a.pos) - dist(u.pos, b.pos));
    const melee = byDist.filter((e) => MELEE.has(e.classId) && dist(u.pos, e.pos) <= 8);
    const attacker = melee[0] ?? byDist.find((e) => e.target === u.id || dist(u.pos, e.pos) <= 12);
    const disabled = (e: Unit) => e.auras.some((a) => HARD_CC.includes(a.kind));
    const stuck = u.auras.some((a) => HARD_CC.includes(a.kind) && a.kind !== 'root') || u.auras.some((a) => a.kind === 'root');
    switch (u.classId) {
      case 'warrior': {
        if (emergency && this.useFirst(u, ['enraged_regeneration', 'shield_wall', 'die_by_the_sword'])) return true;
        if (!melee.length && !attacker) return false;
        if (melee.length && hurting && this.useFirst(u, melee.length > 1 ? ['intimidating_shout', 'shockwave'] : ['shockwave', 'intimidating_shout'])) return true;
        if (attacker && !disabled(attacker) && dist(u.pos, attacker.pos) <= 8 && hurting && this.useFirst(u, ['concussion_blow', 'hammer_toss'], attacker.id)) return true;
        if (melee.length === 0 && attacker && emergency) this.useFirst(u, ['piercing_howl']);
        return false;
      }
      case 'rogue': {
        if (sim.isStealthed(u)) return false;
        if (emergency && this.use(u, 'evasion')) return true;
        if (attacker && !disabled(attacker) && dist(u.pos, attacker.pos) <= 9) {
          if (hurting && this.use(u, 'blind', attacker.id)) return true;
          if (u.cp >= 2 && hurting && this.use(u, 'kidney_shot', attacker.id)) return true;
        }
        if (melee.length && hurting && this.use(u, 'choke_bomb')) return true;
        if (f < B.panicHp * 0.8 && enemies.length && this.use(u, 'vanish')) return true;
        if (emergency && (!attacker || dist(u.pos, attacker.pos) > 4)) this.use(u, 'sprint');
        return false;
      }
      case 'mage': {
        if (!u.cast || emergency) {
          if (!u.auras.some((a) => a.kind === 'absorb') && (emergency || loss > B.dangerAt * 0.5 || (hurting && enemies.length)) && this.use(u, 'ice_barrier')) return true;
        }
        if (u.cast && !emergency) return false;
        const close = byDist.filter((e) => dist(u.pos, e.pos) <= 9);
        if (close.length && hurting) {
          if (this.useFirst(u, ['frost_nova', 'dragons_breath', 'arcane_explosion'])) return true;
        }
        if (emergency && (stuck || close.length) && enemies.length && this.ready(u, 'blink')) {
          // Blink needs to face away first; turning is free, so turn now and blink on the next decision.
          const away = angleTo(byDist[0].pos, u.pos);
          if (Math.abs(angleDiff(u.facing, away)) < 0.35) {
            if (this.use(u, 'blink')) return true;
          } else if (u.auras.some((a) => a.kind !== 'stun' && a.kind !== 'incapacitate' && a.kind !== 'fear') || sim.canMove(u)) {
            this.forceFacing = { angle: away, until: sim.time + 300 };
          }
        }
        if (attacker && close.length && hurting && !disabled(attacker)) {
          if (this.use(u, 'deep_freeze', attacker.id)) return true;
          if (enemies.length >= 2 && this.use(u, 'polymorph', attacker.id)) return true; // sheep whoever is on me
        }
        return false;
      }
      case 'priest': {
        const shielded = u.auras.some((a) => a.kind === 'absorb');
        if (emergency && this.use(u, 'desperate_prayer')) return true;
        if (u.cast && !emergency) return false;
        if (!shielded && (emergency || loss > B.dangerAt * 0.5) && this.use(u, 'power_word_shield', u.id)) return true;
        if (melee.length && hurting && this.use(u, 'psychic_scream')) return true;
        if (emergency && (f < B.panicHp * 0.7) && u.auras.some((a) => HARD_CC.includes(a.kind)) && this.use(u, 'dispersion')) return true;
        if (emergency && !u.cast) {
          const mine = allies.length > 0;
          if (mine && this.useFirst(u, f < 0.35 ? ['flash_heal', 'greater_heal'] : ['greater_heal', 'flash_heal'], u.id)) return true;
        }
        void tgt;
        return false;
      }
    }
  }

  private warrior(u: Unit, enemies: Unit[], tgt?: Unit): void {
    for (const e of this.interruptible(enemies)) if (this.useFirst(u, ['pummel', 'harpoon_throw'], e.id)) return;
    if (!tgt) return;
    this.sim.setAutoAttack(u.id, true); // rage and damage start from swinging, not only from abilities
    const d = dist(u.pos, tgt.pos);
    const slowed = tgt.auras.some((a) => a.kind === 'slow');
    const stunned = tgt.auras.some((a) => a.kind === 'stun');
    const near = enemies.filter((e) => dist(u.pos, e.pos) <= 6);
    if (d >= 8 && d <= 25 && this.use(u, 'charge', tgt.id)) return;
    if (d > 25 && this.use(u, 'heroic_leap', undefined, { x: tgt.pos.x, z: tgt.pos.z })) return;
    if (hpFrac(u) < this.brain.defHp && this.useFirst(u, ['enraged_regeneration', 'shield_wall', 'die_by_the_sword'])) return;
    // Slow ranged targets so they cannot walk away from us.
    const kiter = tgt.classId === 'mage' || tgt.classId === 'priest';
    if (kiter && !slowed && u.resource >= 10 && this.use(u, 'hamstring', tgt.id)) return;
    // Barbarian: drag a runner back in, fence a kiter in, throw axes while it is out of reach
    if (d >= 4 && d <= 9.5 && kiter && this.use(u, 'reel_in', tgt.id)) return; // a 10 yard cone in front: the bot already faces its target
    if (d >= 6 && d <= 15 && kiter && this.use(u, 'not_going_anywhere', undefined, { x: tgt.pos.x, z: tgt.pos.z })) return;
    if (d > 4 && d <= 10 && this.use(u, 'axe_throw', tgt.id)) return;
    if (hpFrac(tgt) < 0.2 && this.use(u, 'execute', tgt.id)) return;
    if (d <= 8 && hpFrac(tgt) <= this.brain.burstHp && this.reduction(tgt) > 0.8) this.useFirst(u, ['recklessness', 'bladestorm']); // not into a shield wall
    if (!stunned && d <= 8 && this.useFirst(u, ['concussion_blow', 'slice_and_dice'], tgt.id)) return;
    if (d <= 8 && near.length >= 2 && this.use(u, 'whirlwind')) return;
    // a rage payoff waits for a full bar; builders and the other strikes fill the gaps
    if (u.resource >= 70 && this.use(u, 'mortal_strike', tgt.id)) return;
    for (const strike of ['bloodthirst', 'slam', 'deep_cuts', 'shield_slam']) if (this.use(u, strike, tgt.id)) return;
    if (this.use(u, 'whirlwind')) return;
    if (u.resource >= 30 && this.use(u, 'mortal_strike', tgt.id)) return;
    if (!slowed && u.resource >= 40) this.use(u, 'hamstring', tgt.id);
  }

  private rogue(u: Unit, enemies: Unit[], tgt?: Unit): void {
    for (const e of this.interruptible(enemies)) if (this.use(u, 'kick', e.id)) return;
    if (!tgt) return;
    const d = dist(u.pos, tgt.pos);
    if (this.sim.isStealthed(u)) {
      if (d > 12) this.use(u, 'sprint');
      if (d > 8 && this.use(u, 'shadowstep', tgt.id)) return;
      this.useFirst(u, ['cheap_shot', 'garrote'], tgt.id);
      return;
    }
    this.sim.setAutoAttack(u.id, true);
    if (hpFrac(u) < this.brain.defHp + 0.05 && this.use(u, 'evasion')) return;
    if (hpFrac(u) < this.brain.defHp * 0.6 && enemies.length && this.use(u, 'vanish')) return;
    if (d <= 8 && hpFrac(tgt) <= this.brain.burstHp && this.reduction(tgt) > 0.8) this.use(u, 'adrenaline_rush');
    if (d > 8 && this.use(u, 'shadowstep', tgt.id)) return;
    if (d > 12) this.use(u, 'sprint');
    const stunned = tgt.auras.some((a) => a.kind === 'stun');
    if (u.cp >= 4 && this.useFirst(u, ['eviscerate', 'exsanguinate'], tgt.id)) return;
    if (u.cp >= 3 && !stunned && this.use(u, 'kidney_shot', tgt.id)) return;
    if (!tgt.auras.some((a) => a.id === 'garrote_bleed') && this.use(u, 'garrote', tgt.id)) return;
    this.useFirst(u, ['mutilate', 'backstab', 'sinister_strike'], tgt.id);
  }

  private mage(u: Unit, enemies: Unit[], tgt?: Unit): void {
    const sim = this.sim;
    for (const e of this.interruptible(enemies)) if (this.use(u, 'counterspell', e.id)) return;

    const meleeNear = enemies.filter((e) => MELEE.has(e.classId) && dist(u.pos, e.pos) <= 10);
    if (hpFrac(u) < 0.4 && meleeNear.length && this.ready(u, 'blink')) {
      // Blink needs to face away first; turning is free, so turn this tick and blink on the next decision.
      const away = angleTo(meleeNear[0].pos, u.pos);
      if (Math.abs(angleDiff(u.facing, away)) < 0.35) {
        if (this.use(u, 'blink')) return;
      } else {
        this.forceFacing = { angle: away, until: sim.time + 300 };
      }
    }
    if (u.cast) return;
    if (meleeNear.some((e) => dist(u.pos, e.pos) <= 9) && this.useFirst(u, ['frost_nova', 'dragons_breath', 'arcane_explosion'])) return;
    // the barrier soaks 40% of max health: keep it up whenever enemies are around, not only once hurt
    if (enemies.length && hpFrac(u) <= this.brain.preShield && !u.auras.some((a) => a.kind === 'absorb') && this.use(u, 'ice_barrier')) return;

    const poly = this.polyTarget(u, enemies, tgt);
    if (poly && this.use(u, 'polymorph', poly.id)) return;

    if (!tgt) return;
    const slowed = tgt.auras.some((a) => a.id === 'frostbolt_slow');
    if (!slowed && this.use(u, 'frostbolt', tgt.id)) return;
    if (hpFrac(tgt) <= this.brain.burstHp && this.reduction(tgt) > 0.8) this.use(u, 'arcane_power');
    // Fingers of Frost / Shatter on the target: Deep Freeze to hold it, then Ice Lance for the 5x hit
    if (tgt.auras.some((a) => a.id === 'fingers_of_frost' || a.id === 'shatter') && (this.use(u, 'deep_freeze', tgt.id) || this.use(u, 'ice_lance', tgt.id))) return;
    // every spec's nukes in priority order; instants and cooldown spells first, the filler that is on this bar last
    this.useFirst(u, ['deep_freeze', 'fireball', 'pyroblast', 'arcane_barrage', 'ice_lance', 'arcane_blast', 'frostbolt', 'scorch', 'arcane_missiles'], tgt.id);
  }

  /** Sheep the enemy that is not the kill target, but only while it can still be sheeped. */
  private polyTarget(u: Unit, enemies: Unit[], tgt?: Unit): Unit | undefined {
    if (enemies.length < 2) return undefined;
    const sim = this.sim;
    return enemies.find((e) => {
      if (e === tgt || dist(u.pos, e.pos) > 28 || !hasLOS(u.pos, e.pos, sim.arena, u.level, e.level)) return false;
      if (e.auras.some((a) => HARD_CC.includes(a.kind))) return false;
      const dr = e.dr.incapacitate;
      const used = dr && sim.time < dr.resetAt ? dr.count : 0;
      return used < 2;
    });
  }

  private priest(u: Unit, enemies: Unit[], allies: Unit[], tgt?: Unit): void {
    const sim = this.sim;
    if (sim.time < this.danceUntil && !u.cast) return; // moving instead of casting for a moment
    const hasShield = (x: Unit) => x.auras.some((a) => a.kind === 'absorb');
    const reachable = allies.filter((a) => dist(u.pos, a.pos) <= 38 && hasLOS(u.pos, a.pos, sim.arena, u.level, a.level)).sort((a, b) => hpFrac(a) - hpFrac(b));
    const lowest = reachable[0];

    // An ally that has been crowd controlled long enough for us to notice.
    let freeAlly: Unit | undefined;
    for (const a of allies) {
      for (const aura of a.auras) {
        const def = AURAS[aura.id];
        if (def.harmful && def.dispellable && HARD_CC.includes(aura.kind) && this.noticed(`${a.id}:${aura.id}:${aura.expiresAt}`)) freeAlly = a;
      }
    }

    // Smite is filler: drop it when something urgent shows up.
    if ((freeAlly || (lowest && hpFrac(lowest) < 0.6)) && u.cast?.ability === 'smite') sim.cancelCast(u, 'cancelled');
    if (freeAlly && this.use(u, 'dispel_magic', freeAlly.id)) return;
    if (u.auras.some((a) => HARD_CC.includes(a.kind)) && this.use(u, 'dispersion')) return;
    if (hpFrac(u) < this.brain.defHp - 0.05 && this.use(u, 'desperate_prayer')) return;
    // keep its own shield up while an enemy is on it or close
    if (!hasShield(u) && hpFrac(u) <= this.brain.preShield && enemies.some((e) => e.target === u.id || dist(u.pos, e.pos) <= 9) && this.use(u, 'power_word_shield', u.id)) return;
    if (u.cast) return;

    // on its own the priest has to win the fight too: it heals later and spends the rest of its time on Smite
    const solo = allies.length <= 1;
    const H = this.brain.healAt;
    const th = (x: number) => Math.min(0.99, x * H);
    if (lowest) {
      const f = hpFrac(lowest);
      if (f < 0.35 && lowest !== u && this.use(u, 'pain_suppression', lowest.id)) return;
      if (f < th(0.45) && !hasShield(lowest) && this.use(u, 'power_word_shield', lowest.id)) return;
      if (f < th(solo ? 0.6 : 0.8) && this.useFirst(u, f < th(0.5) ? ['flash_heal', 'greater_heal'] : ['greater_heal', 'flash_heal'], lowest.id)) return;
      if (f < th(solo ? 0.75 : 0.95) && !hasShield(lowest) && this.use(u, 'power_word_shield', lowest.id)) return;
    }

    const meleeNear = enemies.filter((e) => MELEE.has(e.classId) && dist(u.pos, e.pos) <= 7);
    // alone, a priest screams as soon as melee reaches it (the fear buys time to heal and cast); with a partner it waits until hurt
    if (meleeNear.length && (solo || hpFrac(u) < 0.75) && this.use(u, 'psychic_scream')) return;
    if (meleeNear.length && this.use(u, 'holy_nova')) return;

    if (tgt && (!lowest || hpFrac(lowest) > (solo ? 0.6 : 0.9))) this.useFirst(u, hpFrac(tgt) < 0.3 ? ['shadow_word_death', 'mind_blast', 'penance', 'plague_bloom', 'smite', 'mind_flay'] : ['mind_blast', 'penance', 'plague_bloom', 'smite', 'mind_flay'], tgt.id);
  }

  // ------------------------------------------------------------------ movement

  /** Steer around the pillar that blocks the way instead of pushing into it. */
  /** Between the ground and a bridge's deck the only way is a ramp: head for the foot of one (or out of the tunnel) first. */
  private levelWaypoint(from: Vec2, fromLv: 0 | 1, to: Vec2, toLv: 0 | 1): Vec2 | null {
    const arena = this.sim.arena;
    const br = arena.bridge;
    if (!br || fromLv === toLv) return null;
    const end = br.deckHalf + br.rampLen;
    if (fromLv === 1) return { x: (to.x === 0 ? Math.sign(from.x) || 1 : Math.sign(to.x)) * (end + 2), z: 0 }; // down the ramp nearer the target
    if (Math.abs(from.x) < br.deckHalf && Math.abs(from.z) < br.halfWidth) return { x: from.x, z: (to.z >= from.z ? 1 : -1) * (br.halfWidth + 2) }; // out of the tunnel first
    const s = Math.sign(from.x) || 1;
    // line up with the ramp in the open, then walk straight in so the climb starts (the foot itself is the way on)
    if (Math.abs(from.x) > end + 0.8 && Math.abs(from.z) > br.halfWidth - 1) return { x: s * (end + 2.5), z: 0 };
    return { x: s * (end - 1.5), z: 0 };
  }

  private waypoint(from: Vec2, to: Vec2, fromLv: 0 | 1 = 0, toLv: 0 | 1 = 0): Vec2 {
    const arena = this.sim.arena;
    const lw = this.levelWaypoint(from, fromLv, to, toLv);
    if (lw) return lw;
    if (hasLOS(from, to, arena, fromLv, toLv)) return to;
    let best: { x: number; z: number; r: number } | undefined;
    for (const pl of arena.pillars) {
      if (distPointToSegment(pl, from, to) < pl.r && (!best || dist(from, pl) < dist(from, best))) best = pl;
    }
    if (!best) return to;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const off = best.r + 2;
    const a = { x: best.x + nx * off, z: best.z + nz * off };
    const b = { x: best.x - nx * off, z: best.z - nz * off };
    return dist(a, to) < dist(b, to) ? a : b;
  }

  /** A spot just behind a pillar, as seen from `threat`, where nothing can hit us (out of line of sight). */
  private coverPoint(u: Unit, threat: Vec2): Vec2 | null {
    const arena = this.sim.arena;
    const b = arena.bounds;
    let best: Vec2 | null = null;
    let bestD = 24;
    for (const pl of arena.pillars) {
      const dx = pl.x - threat.x;
      const dz = pl.z - threat.z;
      const len = Math.hypot(dx, dz) || 1;
      const p = { x: pl.x + (dx / len) * (pl.r + 1.4), z: pl.z + (dz / len) * (pl.r + 1.4) };
      if (p.x < b.minX + 1 || p.x > b.maxX - 1 || p.z < b.minZ + 1 || p.z > b.maxZ - 1) continue;
      if (hasLOS(p, threat, arena)) continue;
      const d = dist(u.pos, p);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private movement(u: Unit, enemies: Unit[], allies: Unit[], tgt?: Unit): Cmd {
    const sim = this.sim;
    const idle: Cmd = { facing: u.facing, fwd: 0, strafe: 0 };
    if (this.forceFacing && sim.time < this.forceFacing.until) return { facing: this.forceFacing.angle, fwd: 0, strafe: 0 };
    if (u.cast || !sim.canMove(u)) return idle;

    if (sim.time >= this.strafeFlipAt) {
      this.strafeSign = this.rng() < 0.5 ? -1 : 1;
      this.strafeFlipAt = sim.time + this.brain.strafeFlip * 1000;
    }

    if (this.cover && sim.time < this.coverUntil) return idle; // sitting in cover

    if (u.classId === 'priest') {
      const c = this.healerMove(u, enemies, allies, idle, tgt);
      if (c) return c; // null: a priest on its own fights like a caster, below
    }
    if (!tgt) return idle;
    if (u.classId === 'priest' && sim.time < this.danceUntil && !u.cast) return { facing: angleTo(u.pos, tgt.pos), fwd: 0, strafe: this.strafeSign };

    const d = dist(u.pos, tgt.pos);
    const toT = d < 0.8 ? u.facing : angleTo(u.pos, tgt.pos); // standing on top of someone: do not whip round
    const reach = Math.max(2.9, (autoFor(u.classId, u.spec)?.range ?? 3) - 0.1);
    const base = RANGED[u.classId];
    const range = base && { min: base.min + this.brain.rangeBias, max: base.max + this.brain.rangeBias };
    if (!range) {
      // Backstab doubles from behind: run round to the target's back instead of strafing in front of it
      if (u.bar.includes('backstab') && !sim.isStealthed(u)) {
        const back = { x: tgt.pos.x - Math.sin(tgt.facing) * 2, z: tgt.pos.z - Math.cos(tgt.facing) * 2 };
        const helpless = tgt.auras.some((a) => HARD_CC.includes(a.kind));
        const turned = Math.abs(angleDiff(tgt.facing, angleTo(tgt.pos, u.pos))) > 1.6; // the target is not looking at us
        if (sim.time >= this.backReadyAt && (helpless || turned) && d < 12) {
          if (this.backUntil < sim.time) this.backUntil = sim.time + 1500; // one short try, then fight from the front
          if (sim.time < this.backUntil && dist(u.pos, back) > 1.2) return { facing: angleTo(u.pos, this.waypoint(u.pos, back, u.level, u.level)), fwd: 1, strafe: 0 };
          if (sim.time >= this.backUntil) this.backReadyAt = sim.time + 5000;
        }
        if (d <= 2.9) return { facing: toT, fwd: 0, strafe: 0 };
      }
      if (d > reach) return { facing: angleTo(u.pos, this.waypoint(u.pos, tgt.pos, u.level, tgt.level)), fwd: 1, strafe: 0 };
      // in melee range: keep moving round the target instead of standing still
      return { facing: toT, fwd: 0, strafe: this.strafeSign * 0.2 * this.brain.strafe }; // circling at this range only spins the bot, so it barely moves
    }
    if (!hasLOS(u.pos, tgt.pos, sim.arena, u.level, tgt.level) || d > range.max) {
      return { facing: angleTo(u.pos, this.waypoint(u.pos, tgt.pos, u.level, tgt.level)), fwd: 1, strafe: 0 };
    }
    // Walking away from a melee enemy only helps while it is slowed or rooted; otherwise stand and cast.
    const kiteable = enemies.some(
      (e) => MELEE.has(e.classId) && dist(u.pos, e.pos) < range.min && e.auras.some((a) => a.kind === 'slow' || a.kind === 'root'),
    );
    if (d < range.min && kiteable) return { facing: toT, fwd: -1, strafe: this.strafeSign * 0.75 * this.brain.strafe };
    // between casts, sidestep so the bot is not a stationary target (moving never interrupts: casts return early above)
    if (sim.time < u.gcdEnd) return { facing: toT, fwd: 0, strafe: this.strafeSign * this.brain.strafe };
    return { facing: toT, fwd: 0, strafe: 0 };
  }

  /**
   * Healers stay in line of sight of their partner and sidestep between casts. A priest with no partner left (or in
   * a 1v1) returns null and moves like any other caster: closes to range, keeps line of sight and kites slowed melee.
   */
  private healerMove(u: Unit, _enemies: Unit[], allies: Unit[], idle: Cmd, tgt?: Unit): Cmd | null {
    const sim = this.sim;
    const buddy = allies.filter((a) => a !== u && a.alive).sort((a, b) => hpFrac(a) - hpFrac(b))[0];
    if (!buddy) return null;
    if (!hasLOS(u.pos, buddy.pos, sim.arena, u.level, buddy.level) || dist(u.pos, buddy.pos) > 30) {
      return { facing: angleTo(u.pos, this.waypoint(u.pos, buddy.pos, u.level, buddy.level)), fwd: 1, strafe: 0 };
    }
    if (!tgt) return idle;
    const toT = dist(u.pos, tgt.pos) < 0.8 ? u.facing : angleTo(u.pos, tgt.pos); // standing on top of someone: do not whip round
    return { facing: toT, fwd: 0, strafe: sim.time < u.gcdEnd ? this.strafeSign * this.brain.strafe : 0 };
  }
}
