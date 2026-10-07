import { AURAS, TUNING } from './data';
import { angleTo, dist, distPointToSegment, hasLOS } from './geometry';
import type { ArenaSim } from './sim';
import type { ClassId, Unit, Vec2 } from './types';

import { SPECS } from './data';
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

const RANGED: Partial<Record<ClassId, { min: number; max: number }>> = {
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

    const all = [...sim.units.values()];
    const enemies = all.filter((e) => e.alive && e.team !== u.team && sim.canSee(u, e));
    const allies = all.filter((a) => a.alive && a.team === u.team);

    this.pickTarget(u, enemies);
    const tgt = this.target !== null ? sim.units.get(this.target) : undefined;

    // nobody in sight (e.g. a stealthed rogue): walk towards where the nearest enemy is rather than standing about
    if (!enemies.length && sim.canMove(u) && !u.cast) {
      const hidden = all.filter((e) => e.alive && e.team !== u.team).sort((a, b) => dist(u.pos, a.pos) - dist(u.pos, b.pos))[0];
      if (hidden && !(u.classId === 'priest' && allies.length > 1)) {
        this.send(u, { facing: angleTo(u.pos, this.waypoint(u.pos, hidden.pos)), fwd: 1, strafe: 0 });
        return;
      }
    }

    // hurt: duck behind a pillar to break line of sight, wait a moment, then come back (not every few seconds)
    const threat = [...enemies].sort((a, b) => dist(u.pos, a.pos) - dist(u.pos, b.pos))[0];
    if (threat && hpFrac(u) < this.brain.coverHp && sim.time >= this.coverReadyAt && !this.cover) {
      this.cover = this.coverPoint(u, threat.pos);
      this.coverUntil = sim.time + 3500;
      this.coverReadyAt = sim.time + 9000;
    }
    if (this.cover && sim.time >= this.coverUntil) this.cover = null;
    if (this.cover && sim.canMove(u)) {
      if (dist(u.pos, this.cover) > 0.9) {
        // run for it, abandoning any cast (moving cancels it)
        this.send(u, { facing: angleTo(u.pos, this.cover), fwd: 1, strafe: 0 });
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

  private send(u: Unit, c: Cmd): void {
    this.sim.queueInput(u.id, { seq: ++this.seq, ...c });
  }

  private use(u: Unit, ability: string, target?: number): boolean {
    return this.sim.useAbility(u.id, ability, target).ok;
  }

  /** First ability from the list that goes off: each spec's bar holds a different mix, and anything off the bar just fails. */
  private useFirst(u: Unit, abilities: string[], target?: number): boolean {
    for (const a of abilities) if (this.use(u, a, target)) return true;
    return false;
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
      (mates.some((a) => a.target === e.id) ? B.focus : 0) - (fleeing(e) ? B.chase * 15 : 0);
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
      if (s.will && this.sim.time - s.at >= this.P.react) out.push(e);
    }
    return out;
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

  private warrior(u: Unit, enemies: Unit[], tgt?: Unit): void {
    for (const e of this.interruptible(enemies)) if (this.use(u, 'pummel', e.id)) return;
    if (!tgt) return;
    this.sim.setAutoAttack(u.id, true); // rage and damage start from swinging, not only from abilities
    const d = dist(u.pos, tgt.pos);
    const slowed = tgt.auras.some((a) => a.kind === 'slow');
    if (d >= 8 && d <= 25 && this.use(u, 'charge', tgt.id)) return;
    if (hpFrac(u) < this.brain.defHp && (this.use(u, 'enraged_regeneration') || this.use(u, 'shield_wall'))) return;
    // Slow ranged targets so they cannot walk away from us.
    const kiter = tgt.classId === 'mage' || tgt.classId === 'priest';
    if (kiter && !slowed && u.resource >= 10 && this.use(u, 'hamstring', tgt.id)) return;
    if (hpFrac(tgt) < 0.2 && this.use(u, 'execute', tgt.id)) return;
    if (d <= 8 && hpFrac(tgt) <= this.brain.burstHp) this.use(u, 'recklessness');
    if (!tgt.auras.some((a) => a.kind === 'stun') && d <= 8 && this.use(u, 'concussion_blow', tgt.id)) return;
    if (d <= 8 && enemies.filter((e) => dist(u.pos, e.pos) <= 8).length >= 2 && this.use(u, 'whirlwind')) return;
    // whichever main strike this spec carries
    for (const strike of ['mortal_strike', 'bloodthirst', 'shield_slam']) if (this.use(u, strike, tgt.id)) return;
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
    if (d <= 8 && hpFrac(tgt) <= this.brain.burstHp) this.use(u, 'adrenaline_rush');
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
    if (hpFrac(u) < 0.4 && meleeNear.length) {
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
    if (hpFrac(u) < 0.75 && !u.auras.some((a) => a.kind === 'absorb') && this.use(u, 'ice_barrier')) return;

    const poly = this.polyTarget(u, enemies, tgt);
    if (poly && this.use(u, 'polymorph', poly.id)) return;

    if (!tgt) return;
    const slowed = tgt.auras.some((a) => a.id === 'frostbolt_slow');
    if (!slowed && this.use(u, 'frostbolt', tgt.id)) return;
    if (hpFrac(tgt) <= this.brain.burstHp) this.use(u, 'arcane_power');
    // every spec's nukes in priority order; instants and cooldown spells first, the filler that is on this bar last
    this.useFirst(u, ['deep_freeze', 'fireball', 'pyroblast', 'arcane_barrage', 'ice_lance', 'arcane_blast', 'frostbolt', 'scorch', 'arcane_missiles'], tgt.id);
  }

  /** Sheep the enemy that is not the kill target, but only while it can still be sheeped. */
  private polyTarget(u: Unit, enemies: Unit[], tgt?: Unit): Unit | undefined {
    if (enemies.length < 2) return undefined;
    const sim = this.sim;
    return enemies.find((e) => {
      if (e === tgt || dist(u.pos, e.pos) > 28 || !hasLOS(u.pos, e.pos, sim.arena)) return false;
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
    const reachable = allies.filter((a) => dist(u.pos, a.pos) <= 38 && hasLOS(u.pos, a.pos, sim.arena)).sort((a, b) => hpFrac(a) - hpFrac(b));
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
  private waypoint(from: Vec2, to: Vec2): Vec2 {
    const arena = this.sim.arena;
    if (hasLOS(from, to, arena)) return to;
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
    const toT = angleTo(u.pos, tgt.pos);
    const base = RANGED[u.classId];
    const range = base && { min: base.min + this.brain.rangeBias, max: base.max + this.brain.rangeBias };
    if (!range) {
      // Backstab doubles from behind: run round to the target's back instead of strafing in front of it
      if (u.bar.includes('backstab') && !sim.isStealthed(u)) {
        const back = { x: tgt.pos.x - Math.sin(tgt.facing) * 2, z: tgt.pos.z - Math.cos(tgt.facing) * 2 };
        if (dist(u.pos, back) > 1.2 && d < 12) return { facing: angleTo(u.pos, this.waypoint(u.pos, back)), fwd: 1, strafe: 0 };
        if (d <= 2.9) return { facing: toT, fwd: 0, strafe: 0 };
      }
      if (d > 2.9) return { facing: angleTo(u.pos, this.waypoint(u.pos, tgt.pos)), fwd: 1, strafe: 0 };
      // in melee range: keep moving round the target instead of standing still
      return { facing: toT, fwd: 0, strafe: this.strafeSign * 0.9 * this.brain.strafe };
    }
    if (!hasLOS(u.pos, tgt.pos, sim.arena) || d > range.max) {
      return { facing: angleTo(u.pos, this.waypoint(u.pos, tgt.pos)), fwd: 1, strafe: 0 };
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
    if (!hasLOS(u.pos, buddy.pos, sim.arena) || dist(u.pos, buddy.pos) > 30) {
      return { facing: angleTo(u.pos, this.waypoint(u.pos, buddy.pos)), fwd: 1, strafe: 0 };
    }
    if (!tgt) return idle;
    const toT = angleTo(u.pos, tgt.pos);
    return { facing: toT, fwd: 0, strafe: sim.time < u.gcdEnd ? this.strafeSign * this.brain.strafe : 0 };
  }
}
