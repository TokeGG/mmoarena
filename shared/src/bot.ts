import { ABILITIES, AURAS, TUNING } from './data';
import { angleTo, blinkDestination, dist, distPointToSegment, hasLOS, heightAt, navStep, stepMovementL } from './geometry';
import { coverSpot, highSpot, navRoute, needsNavGrid } from './nav';
import { JUMP_HEIGHT, canStartJump } from './jump';
import { mulberry32 } from './sim';
import type { ArenaSim } from './sim';
import type { ClassId, Unit, Vec2 } from './types';

import { SPECS } from './data';
import { autoFor, talentsFor } from './build';
import type { Build } from './types';
import { brainFor, clampBrain } from './botbrain';
import { rotationFor } from './rotation';
import type { Brain } from './botbrain';

/**
 * A bot's loadout: one of the class's specs (so bots field every weapon spec and bar that exists in the data) and a talent
 * in most tiers, picked from the seed, so the skill swaps of tiers IV to VI get played by bots too.
 */
export function botBuild(classId: ClassId, seed: number, withTalents = true): Build {
  const specs = SPECS[classId];
  const spec = specs[Math.abs(seed) % specs.length].id;
  if (!withTalents) return { spec, talents: [], gear: {} };
  const rng = mulberry32(seed * 7919 + 17);
  const talents = talentsFor(classId, spec).map((tier) => (rng() < 0.85 && tier.length ? tier[Math.floor(rng() * tier.length)].id : ''));
  return { spec, talents, gear: {} };
}

export type Difficulty = 'easy' | 'normal' | 'hard';

/**
 * react: how long a bot needs to notice something (a cast, a crowd control on an ally) before it responds.
 * think: ticks between decisions (movement is still sent every tick).
 * interruptChance: fraction of enemy casts the bot even tries to interrupt.
 * guard: multiplies the health thresholds for defensives and cover (lower = it waits longer before saving itself).
 * tricks: multiplies its willingness to fake casts and to break line of sight.
 * lapse: chance a decision is skipped (a slower, sloppier player presses fewer buttons).
 */
const PARAMS: Record<Difficulty, { react: number; think: number; interruptChance: number; guard: number; tricks: number; lapse: number }> = {
  easy: { react: 1300, think: 6, interruptChance: 0.2, guard: 0.6, tricks: 0, lapse: 0.35 },
  normal: { react: 550, think: 2, interruptChance: 0.6, guard: 0.9, tricks: 0.6, lapse: 0.08 },
  hard: { react: 160, think: 1, interruptChance: 1, guard: 1, tricks: 1, lapse: 0 },
};

/** Abilities on a unit's bar that interrupt (Kick, Pummel, Counterspell, and whatever a talent swapped in). */
export function interruptsOf(x: Pick<Unit, 'bar'>): string[] {
  return x.bar.filter((id) => ABILITIES[id]?.effects.some((e) => e.type === 'interrupt'));
}

export const RANGED: Partial<Record<ClassId, { min: number; max: number }>> = {
  mage: { min: 14, max: 26 },
  priest: { min: 15, max: 30 },
};
const MELEE = new Set<ClassId>(['warrior', 'rogue']);
const HARD_CC = ['incapacitate', 'fear', 'stun', 'root'];
/** Control that takes a unit out of the fight entirely (a root still lets it cast). */
const LOCKED_DOWN = ['incapacitate', 'fear', 'stun'];

const hpFrac = (u: Unit) => u.health / u.maxHealth;
const angleDiff = (a: number, b: number) => ((((a - b + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;


/** A ground point at a unit's feet, on its floor (on top of a walkway when it stands there). */
const feetOf = (t: Unit): Vec2 & { lv?: 1 } => ({ x: t.pos.x, z: t.pos.z, ...(t.level === 1 ? { lv: 1 as const } : {}) });

interface Cmd { facing: number; fwd: number; strafe: number; /** retreating: look ahead for walls before committing */ guard?: boolean }

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
  private castSeen = new Map<number, { start: number; at: number; will: boolean; wait: number }>();
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
  private highGround = false;
  private wasUp = false;
  private climbSince: number | undefined;

  /** A fake cast in progress: stop it at `until` (the enemy's interrupt is ready and we want it wasted). */
  private juke: { start: number; until: number } | null = null;
  private lastJuke = -1e9;
  /** Enemies seen faking casts at us: their next casts are kicked later. */
  private jukers = new Map<number, number>();
  /** Running to cover or out of a cast's sight: only instants (and spells cast on the move) are used meanwhile. */
  private moving = false;
  /** The enemy casts already weighed for a line-of-sight dodge (by cast start). */
  private dodgeSeen = new Map<number, number>();
  /** The floor the cover spot is on. */
  private coverLv: 0 | 1 = 0;

  constructor(private sim: ArenaSim, readonly unitId: number, difficulty: Difficulty = 'normal', seed = 1, brain?: Brain) {
    this.P = PARAMS[difficulty];
    // a brain from storage may be missing newer traits: those come from the class's trained baseline
    const b = clampBrain(brain, brainFor(sim.units.get(unitId)?.classId ?? 'warrior'));
    const g = this.P.guard;
    this.brain = { ...b, defHp: b.defHp * g, panicHp: b.panicHp * g, coverHp: b.coverHp * g, jukeChance: b.jukeChance * this.P.tricks, losUse: b.losUse * this.P.tricks };
    this.rng = mulberry32(seed);
    // on a raised walkway, casters like the high ground about half the time
    this.highGround = sim.units.get(unitId)?.classId === 'mage' && this.rng() < 0.5;
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

    // a fake cast: stop it once it has drawn the kick (or at the planned moment)
    if (this.juke) {
      if (!u.cast || u.cast.start !== this.juke.start) this.juke = null;
      else if (sim.time >= this.juke.until) {
        sim.stopCast(u.id);
        this.juke = null;
        this.lastJuke = sim.time;
      }
    }
    this.watchJukes(enemies);
    this.moving = false;

    // what it can see is all it knows: a stealthed or vanished rogue is remembered where it was last seen, never tracked
    for (const e of enemies) this.lastSeen.set(e.id, { pos: { ...e.pos }, lv: e.level, at: sim.time });

    // nobody in sight: go and look where an enemy was last seen, then search around there, like a player would
    if (!enemies.length && sim.canMove(u) && !u.cast) {
      const c = this.searchPoint(u);
      if (c && !(u.classId === 'priest' && allies.length > 1)) {
        this.send(u, { facing: angleTo(u.pos, this.waypoint(u.pos, c.pos, u.level, c.lv)), fwd: 1, strafe: 0 });
        return;
      }
    }

    // hurt: duck behind a pillar (or under a deck, round a wall) to break line of sight, wait a moment, then come back
    const threat = [...enemies].sort((a, b) => dist(u.pos, a.pos) - dist(u.pos, b.pos))[0];
    if (threat && hpFrac(u) < this.brain.coverHp && sim.time >= this.coverReadyAt && !this.cover) {
      this.takeCover(u, threat, 3500 + 3000 * (1 - hpFrac(u) / this.brain.coverHp)); // the lower it is, the longer it stays hidden
      this.coverReadyAt = sim.time + 9000;
    }
    // a big enemy cast aimed at us: step out of its sight before it lands, so it fails
    if (!this.cover) this.dodgeCast(u, enemies);
    if (this.cover && (sim.time >= this.coverUntil || (this.coverFromHp && hpFrac(u) >= this.brain.coverHp + 0.25))) this.cover = null; // back out once healed up
    if (this.cover && sim.canMove(u)) {
      if (dist(u.pos, this.cover) > 0.45 || u.level !== this.coverLv) {
        // run for it, abandoning any cast (moving cancels it), and keep fighting with instants on the way
        this.moving = true;
        if (sim.time >= this.nextThink) {
          this.nextThink = sim.time + this.P.think * TUNING.tickMs;
          this.decide(u, enemies, allies, tgt);
        }
        this.send(u, { facing: angleTo(u.pos, this.waypoint(u.pos, this.cover, u.level, this.coverLv)), fwd: 1, strafe: 0, guard: true });
        return;
      }
    }

    // standing in an enemy's Flamestrike or Blizzard: step out (a bot with a long cast to protect only leaves when it is hurting)
    if (this.brain.dodge > 0.15 && sim.canMove(u)) {
      const hz = sim.hazardsFor(u.team).find((z) => dist(u.pos, z) < z.r + 0.6);
      if (hz && (!u.cast || hpFrac(u) < this.brain.dodge * 0.9) && this.noticed(`zone:${hz.id}`)) {
        this.send(u, { facing: dist(u.pos, hz) < 0.2 ? u.facing : angleTo(hz, u.pos), fwd: 1, strafe: 0, guard: true });
        return;
      }
    }

    if (u.classId === 'priest' && allies.length <= 1 && !u.cast && sim.time >= this.nextDance && tgt) {
      this.danceUntil = sim.time + 600;
      this.nextDance = sim.time + 6000;
    }

    // a person-high barricade between us and the target: hop, and throw an instant over it from the top of the jump
    if (tgt && !u.cast && this.P.tricks > 0 && sim.canAct(u) && this.popShot(u, tgt)) return;

    // a caster with melee on it runs, and fights with instants on the way (a bot needs no facing to cast them)
    // a run, once started, lasts a moment, and so does a stand: switching every tick would only spin the bot round
    const kiteNow = this.kiteFrom(u, enemies);
    if (kiteNow && !this.kite && sim.time < this.kiteSwitchAt) this.kite = null;
    else if (!kiteNow && this.kite && sim.time < this.kiteSwitchAt && this.kite.alive && sim.canMove(u) && !u.cast) {
      /* keep running */
    } else {
      if (!!kiteNow !== !!this.kite) this.kiteSwitchAt = sim.time + (kiteNow ? 900 : 700);
      this.kite = kiteNow;
    }
    if (this.kite) this.moving = true;

    // Decide first, move second: if a cast just started, movement sees it and stands still.
    if (sim.time >= this.nextThink) {
      this.nextThink = sim.time + this.P.think * TUNING.tickMs;
      if (this.P.lapse === 0 || this.rng() >= this.P.lapse) this.decide(u, enemies, allies, tgt);
    }
    this.send(u, this.movement(u, enemies, allies, tgt));
    if (this.auraSeen.size > 200) this.auraSeen.clear();
  }

  // ------------------------------------------------------------------ helpers

  private lastWalk = false;
  /** The route says jump now (a rail to clear, a barricade, the side of a ramp). */
  private jumpNow = false;
  /** The melee enemy a caster is running from this tick, if any. */
  private kite: Unit | null = null;
  private kiteSwitchAt = 0;
  /** The line a run follows, held for a moment so the bot does not weave between equally good directions. */
  private kiteAngle: { angle: number; until: number } | null = null;
  /**
   * Casters kite like players: a melee enemy within about 7 yards that can still chase (not rooted, stunned, feared or
   * sheeped; a slowed one only once it is within 4.5) is run from at full speed, with instants thrown on the way. Once it
   * is held or left behind, the caster stands and casts again. How eagerly is the brain's `mobility`.
   */
  private kiteFrom(u: Unit, enemies: Unit[]): Unit | null {
    if (!RANGED[u.classId] || !this.sim.canMove(u) || u.cast || this.brain.mobility < 0.25) return null;
    if (u.classId === 'priest' && u.spec !== 'shadow') return null; // a healer's heals have cast times: it stands and heals
    const reach = 4.5 + 2.5 * this.brain.mobility;
    // running from a melee that is not slowed only pays while there is an instant to throw on the way (it keeps up)
    const instant = u.bar.some((id) => {
      const a = ABILITIES[id];
      return !!a && a.castTime === 0 && a.target === 'enemy' && a.effects.some((e) => e.type === 'damage') && this.ready(u, id) && u.resource >= a.cost;
    });
    return enemies
      .filter((e) => MELEE.has(e.classId) && this.sim.canMove(e) && !e.auras.some((a) => HARD_CC.includes(a.kind)))
      .filter((e) => {
        const slowed = e.auras.some((a) => a.kind === 'slow');
        return slowed ? dist(u.pos, e.pos) < Math.max(4.5, (RANGED[u.classId]!.min + this.brain.rangeBias) * 0.6) : instant && dist(u.pos, e.pos) < reach;
      })
      .sort((a, b) => dist(u.pos, a.pos) - dist(u.pos, b.pos))[0] ?? null;
  }

  /** Jump on the spot to see over a barricade (jumpNow only fires while walking). */
  private popJump = false;
  private nextPop = 0;

  /**
   * Over a low barricade: standing, the target is out of sight, but from the top of a jump it is not. Jump, and once high
   * enough, fire the best instant on the bar (in rotation order). Returns true when it cast this tick.
   */
  private popShot(u: Unit, tgt: Unit): boolean {
    const sim = this.sim;
    if (!sim.arena.lows?.length || u.level !== 0) return false;
    const theirAir = sim.airOf(tgt);
    if (hasLOS(u.pos, tgt.pos, sim.arena, u.level, tgt.level, 0, theirAir)) return false; // nothing in the way
    const d = dist(u.pos, tgt.pos);
    const order = rotationFor(u.classId, u.spec, u.bar) ?? u.bar;
    const shots = [...new Set([...order, ...u.bar])].filter((id) => {
      const a = ABILITIES[id];
      return !!a && u.bar.includes(id) && a.castTime === 0 && a.target === 'enemy' && !a.effects.some((e) => e.type === 'interrupt') && d <= a.range && this.ready(u, id);
    });
    if (!shots.length) return false;
    const air = sim.airOf(u);
    if (air > 0) return air >= 1 && hasLOS(u.pos, tgt.pos, sim.arena, u.level, tgt.level, air, theirAir) && this.useFirst(u, shots, tgt.id);
    if (sim.time >= this.nextPop && canStartJump(sim.time - u.jumpStart) && hasLOS(u.pos, tgt.pos, sim.arena, u.level, tgt.level, JUMP_HEIGHT * 0.8, theirAir) && this.rng() < this.P.tricks) {
      this.popJump = true;
      this.nextPop = sim.time + 900;
    }
    return false;
  }
  private send(u: Unit, c: Cmd): void {
    if (this.sim.time < this.unstickUntil && c.fwd > 0) c = { facing: c.facing + this.unstickSign * 1.2, fwd: 1, strafe: 0 };
    if (c.guard) c = this.wallGuard(u, c);
    this.lastWalk = c.fwd !== 0 || c.strafe !== 0 ? c.fwd > 0 : false;
    this.sim.queueInput(u.id, { seq: ++this.seq, facing: c.facing, fwd: c.fwd, strafe: c.strafe, jump: (this.jumpNow && (c.fwd > 0 || c.strafe !== 0)) || this.popJump || undefined });
    this.jumpNow = false;
    this.popJump = false;
  }

  /** Where a command would take the unit in a bit over a second, walls, pillars and edges included. */
  private probe(u: Unit, c: Cmd): Vec2 {
    let pos = u.pos;
    let level = u.level;
    for (let i = 0; i < 12; i++) {
      const r = stepMovementL(pos, level, c, TUNING.runSpeed, 0.1, this.sim.arena);
      pos = r.pos;
      level = r.level;
    }
    return pos;
  }

  /**
   * Running away into a wall is how bots die: look ahead, and when the way is blocked, slide along the wall or turn
   * to whichever direction keeps the most distance from the nearest enemy and still has room to run.
   */
  private wallGuard(u: Unit, c: Cmd): Cmd {
    const arena = this.sim.arena;
    const speed = TUNING.runSpeed * (c.fwd < 0 ? 0.75 : 1);
    const want = speed * 1.2 * Math.min(1, Math.hypot(c.fwd, c.strafe));
    const end = this.probe(u, c);
    const got = Math.hypot(end.x - u.pos.x, end.z - u.pos.z);
    if (got >= want * 0.85) return c;
    const foes = [...this.sim.units.values()].filter((e) => e.alive && e.team !== u.team && this.sim.canSee(u, e)).sort((a, b) => dist(u.pos, a.pos) - dist(u.pos, b.pos));
    const threat = foes[0]?.pos;
    let best: Cmd = c;
    let bestScore = got * 0.5 - 1; // staying with the original is the fallback
    for (const [fwd, strafe] of [[-1, 0], [0, 1], [0, -1], [-1, 1], [-1, -1], [1, 1], [1, -1], [1, 0]]) {
      const cand: Cmd = { facing: c.facing, fwd, strafe };
      const e2 = this.probe(u, cand);
      const moved = Math.hypot(e2.x - u.pos.x, e2.z - u.pos.z);
      if (moved < want * 0.8) continue; // that way is blocked as well
      const b = arena.bounds;
      const edge = Math.min(e2.x - b.minX, b.maxX - e2.x, e2.z - b.minZ, b.maxZ - e2.z);
      const score = (threat ? dist(e2, threat) - dist(u.pos, threat) : 0) * 1.5 + moved + Math.min(edge, 6) * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    return best;
  }

  /** The Blink heading with the most open room that also ends furthest from the enemy (a blink into a wall is a wasted cooldown). */
  private blinkAngle(u: Unit, threat: Vec2): number | null {
    const away = angleTo(threat, u.pos);
    let best: number | null = null;
    let bestScore = -Infinity;
    for (let k = -4; k <= 4; k++) {
      const a = away + k * (Math.PI / 8);
      const dest = blinkDestination(u.pos, a, 20, this.sim.arena, u.level);
      const moved = dist(u.pos, dest);
      if (moved < 12) continue;
      const score = dist(dest, threat) + moved * 0.5 - Math.abs(k) * 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    return best;
  }

  private use(u: Unit, ability: string, target?: number, ground?: Vec2 & { lv?: 1 }): boolean {
    const def = ABILITIES[ability];
    // on the run (to cover, out of a cast's sight) a cast would only be cancelled by the next step
    if (this.moving && def && def.castTime > 0 && !def.castWhileMoving) return false;
    if (this.wastesCC(u, ability, target)) return false;
    const ok = this.sim.useAbility(u.id, ability, target, ground ?? null).ok;
    if (ok && def && def.castTime > 0 && !def.channel && u.cast?.ability === ability) this.maybeJuke(u, def, target);
    return ok;
  }

  /** Abilities on a unit's bar that interrupt (Kick, Pummel, Counterspell, and whatever a talent swapped in). */
  private interruptsOf(x: Unit): string[] {
    return interruptsOf(x);
  }

  /** An enemy who could interrupt us right now: its interrupt is ready, it is in reach and it can see us. */
  private kickThreat(u: Unit, enemies: Unit[]): boolean {
    const sim = this.sim;
    // in reach, or closing in fast enough to be in reach before a cast finishes
    return enemies.some((e) => sim.canAct(e) && this.interruptsOf(e).some((id) => (e.cooldowns[id] ?? 0) <= sim.time && dist(e.pos, u.pos) <= ABILITIES[id].range + 6) && hasLOS(e.pos, u.pos, sim.arena, e.level, u.level));
  }

  /**
   * The juke: a cast started while an enemy's interrupt is ready may be a fake. It is stopped part way, so a kick
   * thrown at it is wasted (and its school is not locked), and the real cast follows once the interrupt is down.
   */
  private maybeJuke(u: Unit, def: (typeof ABILITIES)[string], target?: number): void {
    const sim = this.sim;
    if (this.brain.jukeChance <= 0 || sim.time - this.lastJuke < 4000 || !u.cast) return;
    const tgt = target !== undefined ? sim.units.get(target) : undefined;
    if (def.effects.some((e) => e.type === 'heal') && tgt && hpFrac(tgt) < 0.35) return; // no fooling about with a dying ally
    const enemies = [...sim.units.values()].filter((e) => e.alive && e.team !== u.team && sim.canSee(u, e));
    if (!this.kickThreat(u, enemies) || this.rng() >= this.brain.jukeChance) return;
    const span = u.cast.end - u.cast.start;
    this.juke = { start: u.cast.start, until: u.cast.start + span * this.brain.jukeAt * (0.8 + 0.4 * this.rng()) };
  }

  /** Enemy casts as they start and stop: one stopped early without being kicked or controlled was a fake. */
  private seenCasts = new Map<number, { start: number; end: number; ability: string }>();
  private watchJukes(enemies: Unit[]): void {
    const sim = this.sim;
    for (const e of enemies) {
      const prev = this.seenCasts.get(e.id);
      if (e.cast) {
        if (!prev || prev.start !== e.cast.start) this.seenCasts.set(e.id, { start: e.cast.start, end: e.cast.end, ability: e.cast.ability });
        continue;
      }
      if (!prev) continue;
      this.seenCasts.delete(e.id);
      const school = ABILITIES[prev.ability]?.school;
      const kicked = !!school && (e.lockouts[school] ?? 0) > sim.time;
      if (sim.time < prev.end - 150 && !kicked && sim.canAct(e)) this.jukers.set(e.id, (this.jukers.get(e.id) ?? 0) + 1);
    }
  }

  private coverFromHp = false;
  /** Head for the nearest spot `threat` cannot see (walk grid, both floors) and stay there `ms`. */
  private takeCover(u: Unit, threat: Unit, ms: number, fromHp = true, maxWalk = 16): boolean {
    const c = coverSpot(this.sim.arena, u.pos, u.level, threat.pos, threat.level, maxWalk);
    if (!c) return false;
    this.cover = c.point;
    this.coverLv = c.level;
    this.coverUntil = this.sim.time + ms;
    this.coverFromHp = fromHp;
    return true;
  }

  /** A cast worth running from: crowd control, or a big hit. */
  private dangerous(def: (typeof ABILITIES)[string]): boolean {
    if (def.effects.some((e) => e.type === 'aura' && AURAS[e.aura]?.harmful && ['stun', 'incapacitate', 'fear'].includes(AURAS[e.aura].kind))) return true;
    return def.effects.reduce((n, e) => n + (e.type === 'damage' ? e.amount : 0), 0) >= 200;
  }

  /**
   * Line of sight as a weapon: a long cast at this bot (a Polymorph, a Pyroblast) fails if it is out of the caster's sight
   * when the cast ends, so it steps behind the nearest pillar or deck it can reach in time.
   */
  private dodgeCast(u: Unit, enemies: Unit[]): void {
    const sim = this.sim;
    if (this.brain.losUse <= 0 || !sim.canMove(u)) return;
    for (const e of enemies) {
      const c = e.cast;
      if (!c || c.target !== u.id || this.dodgeSeen.get(e.id) === c.start || sim.time - c.start < this.P.react) continue;
      this.dodgeSeen.set(e.id, c.start);
      const def = ABILITIES[c.ability];
      if (!def || def.channel || def.target !== 'enemy' || !this.dangerous(def)) continue;
      if (u.cast && ABILITIES[u.cast.ability]?.effects.some((x) => x.type === 'heal')) continue; // landing a heal matters more
      if (this.rng() >= this.brain.losUse) continue;
      const left = c.end - sim.time;
      const reach = (left / 1000) * TUNING.runSpeed * sim.speedMult(u) * 0.85;
      if (reach >= 1.5 && this.takeCover(u, e, left + 400, false, reach)) return;
    }
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
    const foes = def.target === 'enemy' ? [sim.units.get(target ?? -1)] : [...sim.units.values()].filter((e) => e.alive && e.team !== u.team && sim.canSee(u, e) && dist(u.pos, e.pos) <= (def.radius ?? 8));
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
    // with an enemy interrupt ready and in reach, instants go first: a cast is only started when there is nothing else (and may be a fake)
    const list = this.kickRisk ? [...abilities].sort((a, b) => Number((ABILITIES[a]?.castTime ?? 0) > 0) - Number((ABILITIES[b]?.castTime ?? 0) > 0)) : abilities;
    for (const a of list) if (this.use(u, a, target)) return true;
    return false;
  }
  private kickRisk = false;

  /**
   * The spec's damage rotation (learned offline: the order that deals the most damage with the real cooldowns and costs),
   * falling back to the hand-written order. Area abilities only when an enemy is inside their reach.
   */
  private rotate(u: Unit, tgt: Unit, fallback: string[]): boolean {
    const order = rotationFor(u.classId, u.spec, u.bar) ?? fallback;
    const list = order.filter((id) => {
      const d = ABILITIES[id];
      if (d?.target !== 'aoe_enemy') return true;
      const r = this.sim.radiusOf(u, d);
      return [...this.sim.units.values()].some((e) => e.alive && e.team !== u.team && this.sim.canSee(u, e) && dist(u.pos, e.pos) <= r - 0.5);
    });
    return this.useFirst(u, list, tgt.id);
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
      if (u.target !== null && sim.units.get(u.target)?.team !== u.team) sim.setTarget(u.id, null); // let go of an enemy it can no longer see
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
        // how far into this cast to wait before kicking: later beats a fake, and a known faker is waited out longer
        const wait = this.brain.kickAt + (this.rng() - 0.5) * 0.25 + Math.min(0.3, 0.12 * (this.jukers.get(e.id) ?? 0));
        s = { start: e.cast.start, at: this.sim.time, will: this.rng() < this.P.interruptChance, wait: Math.max(0, Math.min(0.9, wait)) };
        this.castSeen.set(e.id, s);
      }
      const span = Math.max(1, e.cast.end - e.cast.start);
      const into = (this.sim.time - e.cast.start) / span;
      const def = ABILITIES[e.cast.ability];
      // a channel does its work as it goes: stop it early; a cast only lands at the end, so there is time to wait it out
      const due = def?.channel ? into >= s.wait * 0.3 : into >= s.wait || e.cast.end - this.sim.time <= 300 + this.P.think * TUNING.tickMs;
      if (s.will && this.sim.time - s.at >= this.P.react && due && this.worthInterrupt(e)) out.push(e);
    }
    return out;
  }

  /** Throw whichever interrupt is on the bar (a talent may have swapped Kick for Knife Snipe, Counterspell for Arcane Silence...). */
  private tryInterrupt(u: Unit, enemies: Unit[]): boolean {
    const mine = this.interruptsOf(u);
    if (!mine.length) return false;
    for (const e of this.interruptible(enemies)) for (const id of mine) if (this.use(u, id, e.id)) return true;
    return false;
  }

  /** Kicks and counterspells are on a cooldown: spend them on heals, crowd control and big casts, not on filler. */
  private worthInterrupt(e: Unit): boolean {
    const def = e.cast ? ABILITIES[e.cast.ability] : undefined;
    if (!def) return true;
    if (def.unstoppable) return false; // Bladestorm cannot be kicked: keep the interrupt
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
    this.kickRisk = (u.classId === 'mage' || u.classId === 'priest') && this.brain.jukeChance > 0 && this.kickThreat(u, enemies);
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
        if (loss > B.dangerAt * 0.5 && this.use(u, 'evocation')) return true; // 15% less damage taken (and the mana) while it is being burst
        const close = byDist.filter((e) => dist(u.pos, e.pos) <= 9);
        if (close.length && hurting) {
          if (this.useFirst(u, ['frost_nova', 'dragons_breath', 'arcane_explosion'])) return true;
        }
        if (emergency && (stuck || close.length) && enemies.length && this.ready(u, 'blink')) {
          // Blink needs to face away first; turning is free, so turn now and blink on the next decision.
          const away = this.blinkAngle(u, byDist[0].pos);
          if (away === null) {
            // walled in: no clear Blink line, fight on
          } else if (Math.abs(angleDiff(u.facing, away)) < 0.35) {
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
        if (emergency && (f < B.panicHp * 0.7) && u.auras.some((a) => LOCKED_DOWN.includes(a.kind)) && this.use(u, 'dispersion')) return true;
        if (attacker && hurting && !disabled(attacker) && this.use(u, 'judgment_hammer', attacker.id)) return true; // stun whoever is on us
        if (emergency && this.use(u, 'holy_word', u.id)) return true;
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
    if (this.tryInterrupt(u, enemies)) return;
    if (!tgt) return;
    this.sim.setAutoAttack(u.id, true); // rage and damage start from swinging, not only from abilities
    const d = dist(u.pos, tgt.pos);
    const slowed = tgt.auras.some((a) => a.kind === 'slow');
    const stunned = tgt.auras.some((a) => a.kind === 'stun');
    const near = enemies.filter((e) => dist(u.pos, e.pos) <= 6);
    if (d >= 8 && d <= 25 && this.use(u, 'charge', tgt.id)) return;
    // Heroic Leap closes the gap Charge cannot (on cooldown, no line of sight, past its reach): a warrior never walks in
    if (d > 9 && (d > 25 || !this.ready(u, 'charge') || !hasLOS(u.pos, tgt.pos, this.sim.arena, u.level, tgt.level)) && this.use(u, 'heroic_leap', undefined, feetOf(tgt))) return;
    if (hpFrac(u) < this.brain.defHp && this.useFirst(u, ['enraged_regeneration', 'shield_wall', 'die_by_the_sword'])) return;
    // Slow ranged targets so they cannot walk away from us.
    const kiter = tgt.classId === 'mage' || tgt.classId === 'priest';
    if (kiter && !slowed && u.resource >= 10 && this.use(u, 'hamstring', tgt.id)) return;
    // Barbarian: drag a runner back in, fence a kiter in, throw axes while it is out of reach
    if (d >= 4 && d <= 9.5 && kiter && this.use(u, 'reel_in', tgt.id)) return; // a 10 yard cone in front: the bot already faces its target
    if (d >= 6 && d <= 15 && kiter && this.use(u, 'not_going_anywhere', undefined, feetOf(tgt))) return;
    if (d > 4 && d <= 10 && this.use(u, 'axe_throw', tgt.id)) return;
    if (hpFrac(tgt) < 0.2 && this.use(u, 'execute', tgt.id)) return;
    if (d <= 8 && hpFrac(tgt) <= this.brain.burstHp && this.reduction(tgt) > 0.8) this.useFirst(u, ['recklessness', 'bladestorm']); // not into a shield wall
    if (!stunned && d <= 8 && this.useFirst(u, ['concussion_blow', 'slice_and_dice'], tgt.id)) return;
    if (d <= 8 && near.length >= 2 && this.use(u, 'whirlwind')) return;
    // a rage payoff waits for a full bar; builders and the other strikes fill the gaps
    if (u.resource >= 70 && this.use(u, 'mortal_strike', tgt.id)) return;
    if (this.rotate(u, tgt, ['bloodthirst', 'slam', 'deep_cuts', 'whirlwind', 'axe_throw'])) return;
    if (u.resource >= 30 && this.use(u, 'mortal_strike', tgt.id)) return;
    if (!slowed && u.resource >= 40) this.use(u, 'hamstring', tgt.id);
  }

  private rogue(u: Unit, enemies: Unit[], tgt?: Unit): void {
    if (this.tryInterrupt(u, enemies)) return;
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
    // Fan of Knives whenever someone is within its 8 yards; Crippling Strike keeps a runner slowed
    if (enemies.some((e) => dist(u.pos, e.pos) <= 7.5) && this.use(u, 'fan_of_knives')) return;
    if (!tgt.auras.some((a) => a.kind === 'slow' || a.kind === 'root') && this.use(u, 'crippling_strike', tgt.id)) return;
    // finishers: spend at 4 (at 3 on a target about to die); Kidney Shot only with 4 or more, and only while its stun
    // still lands for long (not on a target that is already diminished), so points are not thrown away on 1-point stuns
    const stunDr = tgt.dr.stun && this.sim.time < tgt.dr.stun.resetAt ? tgt.dr.stun.count : 0;
    if (u.cp >= 4 && !stunned && stunDr === 0 && this.use(u, 'kidney_shot', tgt.id)) return;
    if ((u.cp >= 4 || (u.cp >= 3 && hpFrac(tgt) < 0.25)) && this.useFirst(u, ['eviscerate', 'exsanguinate'], tgt.id)) return;
    if (!tgt.auras.some((a) => a.id === 'garrote_bleed') && this.use(u, 'garrote', tgt.id)) return;
    this.rotate(u, tgt, ['mutilate', 'backstab', 'sinister_strike', 'garrote', 'crippling_strike', 'fan_of_knives']);
  }

  private mage(u: Unit, enemies: Unit[], tgt?: Unit): void {
    const sim = this.sim;
    if (this.tryInterrupt(u, enemies)) return;

    const meleeNear = enemies.filter((e) => MELEE.has(e.classId) && dist(u.pos, e.pos) <= 10);
    if (hpFrac(u) < 0.4 && meleeNear.length && this.ready(u, 'blink')) {
      // Blink needs to face away first; turning is free, so turn this tick and blink on the next decision.
      const away = this.blinkAngle(u, meleeNear[0].pos);
      if (away === null) {
        // no open line to Blink along
      } else if (Math.abs(angleDiff(u.facing, away)) < 0.35) {
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
    // out of mana and nobody on top of us: Evocation
    if (u.resource < u.resourceMax * 0.55 && !meleeNear.length && this.use(u, 'evocation')) return;

    if (!tgt) return;
    // ground storms where the target cannot walk out in time: held in place, slowed, or standing still for the cast
    {
      const held = tgt.auras.filter((a) => HARD_CC.includes(a.kind) && !this.isPolymorphed(tgt)).reduce((m, a) => Math.max(m, a.expiresAt - sim.time), 0);
      const slow = tgt.auras.some((a) => a.kind === 'slow' || a.kind === 'root');
      for (const id of ['blizzard', 'flamestrike']) {
        const def = ABILITIES[id];
        if (!u.bar.includes(id) || dist(u.pos, tgt.pos) > def.range) continue;
        if (held >= def.castTime + 300 || (slow && def.castTime <= 1500) || (meleeNear.length === 0 && enemies.length >= 2 && enemies.filter((e) => dist(e.pos, tgt.pos) < 6).length >= 2)) {
          if (this.use(u, id, undefined, feetOf(tgt))) return;
        }
      }
    }
    const slowed = tgt.auras.some((a) => a.id === 'frostbolt_slow');
    if (!slowed && this.use(u, 'frostbolt', tgt.id)) return;
    if (hpFrac(tgt) <= this.brain.burstHp && this.reduction(tgt) > 0.8) this.use(u, 'arcane_power');
    // Fingers of Frost / Shatter on the target: Deep Freeze to hold it, then Ice Lance for the 5x hit
    if (tgt.auras.some((a) => a.id === 'fingers_of_frost' || a.id === 'shatter') && (this.use(u, 'deep_freeze', tgt.id) || this.use(u, 'ice_lance', tgt.id))) return;
    // every spec's nukes in priority order; instants and cooldown spells first, the filler that is on this bar last
    if (u.auras.some((a) => a.id === 'hot_streak') && this.use(u, 'pyroblast', tgt.id)) return; // the free instant 550 first
    if (this.use(u, 'deep_freeze', tgt.id)) return;
    this.rotate(u, tgt, ['fireball', 'pyroblast', 'arcane_barrage', 'ice_lance', 'arcane_blast', 'frostbolt', 'scorch', 'arcane_missiles']);
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
    if ((freeAlly || (lowest && hpFrac(lowest) < 0.6)) && u.cast?.ability === 'smite') sim.stopCast(u.id);
    if (freeAlly && this.use(u, 'dispel_magic', freeAlly.id)) return;
    if (this.tryInterrupt(u, enemies)) return; // Silence, if a talent put it on the bar
    // Dispersion is for real lockdown (stun, fear, sheep) or low health, not for any root
    if ((u.auras.some((a) => LOCKED_DOWN.includes(a.kind)) || hpFrac(u) < this.brain.defHp) && this.use(u, 'dispersion')) return;
    if (hpFrac(u) < this.brain.defHp - 0.05 && this.use(u, 'desperate_prayer')) return;
    // keep its own shield up while an enemy is on it or close
    if (!hasShield(u) && hpFrac(u) <= this.brain.preShield && enemies.some((e) => e.target === u.id || dist(u.pos, e.pos) <= 9) && this.use(u, 'power_word_shield', u.id)) return;
    if (u.cast) return;
    // purge like a player: strip an enemy's magic shield or buff (Ice Barrier, Power Infusion) when nobody needs healing
    if (u.bar.includes('dispel_magic') && (!lowest || hpFrac(lowest) > 0.6)) {
      const buffed = enemies.find((e) => dist(u.pos, e.pos) <= 30 && hasLOS(u.pos, e.pos, sim.arena, u.level, e.level) && e.auras.some((a) => !AURAS[a.id]?.harmful && AURAS[a.id]?.dispellable && this.noticed(`purge:${e.id}:${a.id}:${a.expiresAt}`)));
      if (buffed && this.use(u, 'dispel_magic', buffed.id)) return;
    }

    // on its own the priest has to win the fight too: it heals later and spends the rest of its time on Smite
    const solo = allies.length <= 1;
    const H = this.brain.healAt;
    const th = (x: number) => Math.min(0.99, x * H);
    if (lowest) {
      const f = hpFrac(lowest);
      if (f < 0.35 && lowest !== u && this.use(u, 'pain_suppression', lowest.id)) return;
      if (f < th(0.55) && this.use(u, 'holy_word', lowest.id)) return; // the instant heal first, then the casts
      // someone is beating on the low ally: stun them
      const onLow = enemies.find((e) => e.target === lowest.id && dist(e.pos, lowest.pos) <= 8 && !e.auras.some((a) => HARD_CC.includes(a.kind)));
      if (f < th(0.5) && onLow && this.use(u, 'judgment_hammer', onLow.id)) return;
      if (f < th(0.45) && !hasShield(lowest) && this.use(u, 'power_word_shield', lowest.id)) return;
      if (f < th(solo ? 0.6 : 0.8) && this.useFirst(u, f < th(0.5) ? ['flash_heal', 'greater_heal'] : ['greater_heal', 'flash_heal'], lowest.id)) return;
      if (f < th(solo ? 0.75 : 0.95) && !hasShield(lowest) && this.use(u, 'power_word_shield', lowest.id)) return;
    }

    const meleeNear = enemies.filter((e) => MELEE.has(e.classId) && dist(u.pos, e.pos) <= 7);
    // alone, a priest screams as soon as melee reaches it (the fear buys time to heal and cast); with a partner it waits until hurt
    if (meleeNear.length && (solo || hpFrac(u) < 0.75) && this.use(u, 'psychic_scream')) return;
    if (meleeNear.length && this.use(u, 'holy_nova')) return;

    // Power Infusion on whoever is about to burst: itself when it is the damage, else the partner with a target
    if (tgt && hpFrac(tgt) <= this.brain.burstHp && this.reduction(tgt) > 0.8) {
      const dps = allies.filter((a) => a !== u && a.classId !== 'priest' && a.target === tgt.id)[0];
      if (this.use(u, 'power_infusion', (dps ?? u).id)) return;
    }
    // keep Shadow Word: Pain (its damage over time) rolling on the target, then the nukes
    const dotted = tgt?.auras.some((a) => a.id === 'creeping_rot' && a.sourceId === u.id);
    if (tgt && (!lowest || hpFrac(lowest) > (solo ? 0.6 : 0.9))) {
      if (!dotted && this.use(u, 'shadow_word_death', tgt.id)) return; // a damage-over-time now: refreshing it early wastes a global cooldown
      this.rotate(u, tgt, ['mind_blast', 'penance', 'plague_bloom', 'smite', 'mind_flay']);
    }
    // a stun on a casting enemy that nothing else stopped
    const caster = enemies.find((e) => e.cast && ABILITIES[e.cast.ability]?.castTime >= 1500 && dist(u.pos, e.pos) <= 28);
    if (caster) this.use(u, 'judgment_hammer', caster.id);
  }

  // ------------------------------------------------------------------ movement

  /** Steer around whatever is in the way: the walk grid on arenas with walkways or barricades, else round pillars and walls. */
  /** Where each enemy was last seen (and on which floor): all a bot knows about one it cannot see now. */
  private lastSeen = new Map<number, { pos: Vec2; lv: 0 | 1; at: number }>();
  private search: { pos: Vec2; lv: 0 | 1; until: number } | null = null;

  /**
   * Where to look for an enemy it cannot see: the spot one was last seen, and once there, random spots close by (a
   * stealthed rogue is spotted within a couple of yards, so sweeping the area is how a player finds one). Null when it
   * has never seen anyone (then it holds its ground).
   */
  private searchPoint(u: Unit): { pos: Vec2; lv: 0 | 1 } | null {
    const sim = this.sim;
    // never seen anyone yet: what a player knows is the map, so it sweeps from the middle towards the enemy's gate
    const theirs = sim.arena.spawns[1 - u.team] ?? [];
    const gate = theirs.length ? { x: theirs.reduce((n, p) => n + p.x, 0) / theirs.length, z: theirs.reduce((n, p) => n + p.z, 0) / theirs.length } : { x: 0, z: 0 };
    const recent = [...this.lastSeen.entries()].filter(([id]) => sim.units.get(id)?.alive).sort((a, b) => b[1].at - a[1].at)[0]?.[1] ?? { pos: { x: gate.x / 2, z: gate.z / 2 }, lv: 0 as const, at: -1 };
    if (!this.search || sim.time >= this.search.until || dist(u.pos, this.search.pos) < 1.2) {
      const first = !this.search || this.search.until < recent.at;
      const b = sim.arena.bounds;
      const a = this.rng() * Math.PI * 2;
      // the longer nothing turns up, the wider it sweeps (a rogue that stays hidden has to be walked into: it shows at 2 yards)
      const lost = sim.time - Math.max(0, recent.at);
      const r = first ? 0 : 3 + this.rng() * (lost > 8000 ? 16 : 6);
      const pos = { x: Math.max(b.minX + 1, Math.min(b.maxX - 1, recent.pos.x + Math.sin(a) * r)), z: Math.max(b.minZ + 1, Math.min(b.maxZ - 1, recent.pos.z + Math.cos(a) * r)) };
      this.search = { pos, lv: first ? recent.lv : 0, until: sim.time + 3000 };
    }
    return this.search;
  }

  /** The last route point and when it was chosen, so a route that flickers between two ways round is not followed both ways. */
  private lastWp: { p: Vec2; at: number } | null = null;
  private waypoint(from: Vec2, to: Vec2, fromLv: 0 | 1 = 0, toLv: 0 | 1 = 0): Vec2 {
    const p = this.route(from, to, fromLv, toLv);
    const prev = this.lastWp;
    const t = this.sim.time;
    // a sudden about-turn within a moment of the last choice is the route flickering at a cell boundary: keep going the first way
    if (prev && t - prev.at < 600 && dist(from, prev.p) > 0.8 && Math.abs(angleDiff(angleTo(from, p), angleTo(from, prev.p))) > 2) return prev.p;
    this.lastWp = { p, at: t };
    return p;
  }

  private route(from: Vec2, to: Vec2, fromLv: 0 | 1 = 0, toLv: 0 | 1 = 0): Vec2 {
    const arena = this.sim.arena;
    if (needsNavGrid(arena)) {
      // casters that like the high ground fight from the walkway when there is a spot up there that sees the target
      if (this.highGround && toLv === 0) {
        const spot = highSpot(arena, to);
        if (spot) {
          to = spot;
          toLv = 1;
        }
      }
      const r = navRoute(arena, from, fromLv, to, toLv);
      if (r) {
        if (r.jump) this.jumpNow = true;
        return r.point;
      }
    }
    const around = navStep(from, to, arena); // walls in the way: follow the route points round them
    if (around) return around;
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
    if (this.kite) {
      // along the most open line away from it (the same search Blink uses), now and then a hop
      if (!this.kiteAngle || sim.time >= this.kiteAngle.until) this.kiteAngle = { angle: this.blinkAngle(u, this.kite.pos) ?? angleTo(this.kite.pos, u.pos), until: sim.time + 600 };
      const away = this.kiteAngle.angle;
      if (this.rng() < 0.01 * this.brain.mobility) this.jumpNow = true;
      return { facing: away, fwd: 1, strafe: 0, guard: true };
    }

    // only a healing priest minds its partner first; a Shadow priest fights like any caster
    if (u.classId === 'priest' && u.spec !== 'shadow') {
      const c = this.healerMove(u, enemies, allies, idle, tgt);
      if (c) return c; // null: a priest on its own fights like a caster, below
    }
    if (!tgt) return idle;
    if (u.classId === 'priest' && sim.time < this.danceUntil && !u.cast) return { facing: angleTo(u.pos, tgt.pos), fwd: 0, strafe: this.strafeSign };

    // casters that like the high ground make for the walkway first (once), then fight from it
    if (u.level === 1 && heightAt(sim.arena, u.pos.x, u.pos.z, 1) > 2) this.wasUp = true; // the foot of a ramp is not "up there"
    // (all the way up: standing on the foot of a ramp is not the high ground; after 8 s of trying it gives up)
    if (!this.wasUp && enemies.some((e) => MELEE.has(e.classId) && dist(u.pos, e.pos) < 12)) this.wasUp = true; // melee arrived first: fight here, for good
    if (this.highGround && sim.arena.deck && !this.wasUp && sim.time > 1500 && hpFrac(u) > 0.4) {
      this.climbSince ??= sim.time;
      if (sim.time - this.climbSince > 8000) this.wasUp = true;
      else return { facing: angleTo(u.pos, this.waypoint(u.pos, tgt.pos, u.level, 1)), fwd: 1, strafe: 0 };
    }
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
      // out of reach includes a pillar in the way and a target on another floor (standing under someone on the deck is not melee range):
      // the route goes round the pillar or up the ramp
      const floorGap = Math.abs(heightAt(sim.arena, u.pos.x, u.pos.z, u.level) - heightAt(sim.arena, tgt.pos.x, tgt.pos.z, tgt.level));
      if (d > reach || floorGap > 1.6 || !hasLOS(u.pos, tgt.pos, sim.arena, u.level, tgt.level)) return { facing: angleTo(u.pos, this.waypoint(u.pos, tgt.pos, u.level, tgt.level)), fwd: 1, strafe: 0 };
      // in melee range: circle the target like a player does (strafing round it, stepping in when it drifts out, now and
      // then a hop), never a standing target. The step in keeps the circle tight enough to stay in reach.
      const circle = 0.3 + 0.22 * Math.max(this.brain.strafe, this.brain.mobility); // faster than this, the orbit itself spins the bot round
      if (this.rng() < 0.006 * this.brain.mobility) this.jumpNow = true;
      return { facing: toT, fwd: d > reach * 0.75 ? 0.45 : 0, strafe: this.strafeSign * circle };
    }
    if (!hasLOS(u.pos, tgt.pos, sim.arena, u.level, tgt.level) || d > range.max) {
      return { facing: angleTo(u.pos, this.waypoint(u.pos, tgt.pos, u.level, tgt.level)), fwd: 1, strafe: 0 };
    }
    // Walking away from a melee enemy only helps while it is slowed or rooted; otherwise stand and cast.
    const kiteable = enemies.some(
      (e) => MELEE.has(e.classId) && dist(u.pos, e.pos) < range.min && e.auras.some((a) => a.kind === 'slow' || a.kind === 'root'),
    );
    if (d < range.min && kiteable) return { facing: toT, fwd: -1, strafe: this.strafeSign * 0.75 * this.brain.strafe, guard: true };
    // whenever it is not casting it keeps moving like a player does: sidestepping (and now and then a hop) so it is never a
    // standing target. Decisions run before movement, so a cast that just started has already stopped this.
    const sway = Math.max(this.brain.strafe, this.brain.mobility * 0.8);
    if (sway < 0.15) return { facing: toT, fwd: 0, strafe: 0 };
    if (this.rng() < 0.004 * this.brain.mobility) this.jumpNow = true;
    // sidestep, but never into a wall or pillar, out of the target's sight round a pillar edge, or back into an enemy ground
    // effect (stepping out and back every tick looks like a spinning top): try this way, then the other, else stand
    const okSide = (sign: number) => {
      const end = this.probe(u, { facing: toT, fwd: 0, strafe: sign * sway });
      return Math.hypot(end.x - u.pos.x, end.z - u.pos.z) >= TUNING.runSpeed * 1.2 * sway * 0.5 && hasLOS(end, tgt.pos, sim.arena, u.level, tgt.level) && !sim.hazardsFor(u.team).some((z) => dist(end, z) < z.r + 1);
    };
    if (!okSide(this.strafeSign)) {
      if (!okSide(-this.strafeSign)) return { facing: toT, fwd: 0, strafe: 0 };
      this.strafeSign = -this.strafeSign;
      this.strafeFlipAt = sim.time + this.brain.strafeFlip * 1000;
    }
    return { facing: toT, fwd: 0, strafe: this.strafeSign * sway };
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
