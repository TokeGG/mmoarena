import { ABILITIES, ARENA, AURAS, CLASSES, SPECS, TUNING } from './data';
import { autoFor, barFor, barSwapped, compileMods, gearLook, stealthSwapsFor, trinketFor, withAuraMods } from './build';
import { LOW_CLEAR, STEP_HEIGHT, blinkDestination, inLava, onRaised, clamp, clampToGate, dist, hasLOS, heightAt, moveTo, resolveCollisions, stepMovementL } from './geometry';
import { JUMP_DODGE_CD, JUMP_DODGE_HEIGHT, JUMP_MS, canStartJump, jumpHeight } from './jump';
import type {
  AbilityDef, AbilityMod, ArenaDef, AuraInst, AuraKind, Build, ClassId, Mods, MoveInput, Phase, Result, School, SimEvent, Snapshot, TeamId, Unit, UnitSnap, Vec2,
} from './types';

/** Height of a leap above the ground (absolute) part way through: a 5-yard arc from the floor you left to the floor you land on. */
const leapHeight = (L: { fromH: number; toH: number }, p: number) => L.fromH + (L.toH - L.fromH) * p + Math.sin(Math.PI * p) * 5;
/** A ground-targeted point; lv 1 = on top of a walkway (the aim hit the deck), else the ground. */
type Ground = { x: number; z: number; lv?: 1 };
/** A Counterspell pressed this long after a cast finished still locks that school out. */
const INTERRUPT_GRACE_MS = 250;
const ok: Result = { ok: true };
const fail = (reason: string): Result => ({ ok: false, reason });
/** How far back unit positions are kept for lag compensation: the longest rewind (TUNING.maxRewindMs) plus the age of the oldest view time accepted, whatever the tick length. */
const HISTORY_MS = 600;
/**
 * Input queue limits, in milliseconds of input so they mean the same at any tick length (at 50 ms ticks these are the 5, 3, 2, 2 and 5 ticks they
 * were written as). The queue holds at most INPUT_QUEUE_MS (older ones are dropped); with nothing queued the last input is repeated for
 * INPUT_REPEAT_MS before the unit stops. Input catch-up (see tickUnit): above CATCHUP_DEPTH_MS of queued input the surplus is consumed in the
 * same tick, paid for by owed repeat ticks (no movement) and idle-tick credit (at most CATCHUP_MAX_MS of moving steps per tick); both capped at CATCHUP_CREDIT_MS.
 */
export const INPUT_QUEUE_MS = 250;
export const INPUT_REPEAT_MS = 150;
export const CATCHUP_DEPTH_MS = 100;
export const CATCHUP_MAX_MS = 100;
export const CATCHUP_CREDIT_MS = 250;
/** A melee swing reaches this far up or down (a ramp's slope), not from a walkway's top to the ground below. */
const MELEE_FLOOR_GAP = 1.6;
/** Failures a player cast may be held through for TUNING.castGraceMs. */
const GRACE_REASONS = ['out of range', 'that spot is not in front of you', 'target is not in front of you', 'already casting that'];
/** Ways a cast can stop that give its global cooldown back (the caster's own choice, or the target slipping away). */
const GCD_REFUND = ['moved', 'cancelled', 'switched spell', 'target vanished', 'blinded by smoke'];
/** A repeat of the spell being cast, pressed this close to the end of the cast, is held and cast right after it. */
const REPEAT_HOLD_MS = 400;
const CC_KINDS: AuraKind[] = ['stun', 'incapacitate', 'fear'];
/** What an unstoppable channel (Bladestorm) is immune to. */
const UNSTOPPABLE_KINDS: AuraKind[] = ['stun', 'incapacitate', 'fear', 'root', 'slow'];

export const isMelee = (def: AbilityDef) => def.target === 'enemy' && def.range <= 5;

export interface SimOptions { /** Length of one step in whole milliseconds (default TUNING.tickMs). Every rule runs on sim time, so a match plays the same at any value; a replay must be run with the value it was recorded at. */ tickMs?: number; seed?: number; prepMs?: number; arena?: ArenaDef; /** Players must face what they cast on or swing at (a cone in front of them). Off by default so unit tests can place units freely. */ facing?: boolean }
/** Every outside action on the sim, in a form a replay can feed back in. Ops: 0 input, 1 target, 2 ability, 3 auto-attack, 4 forfeit, 5 auto-attack setting, 6 stop casting. */
export type SimCommand = [tick: number, op: 0 | 1 | 2 | 3 | 4 | 5 | 6, unit: number, ...args: (number | string | boolean | null)[]];
export interface AddUnitOptions { name: string; classId: ClassId; team: TeamId; controller?: 'player' | 'dummy' | 'bot'; gearMult?: number; build?: Build }
export type AuraResult = { applied: true; duration: number; dr: number } | { applied: false; immune: true };

/** Small seeded random number generator: the same seed gives the same sequence (sim, bots, training scripts). */
export function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Headless, server-authoritative arena simulation. No rendering, no I/O, no wall-clock:
 * call step() once per tick (`tickMs`). Same inputs + same seed = same outcome.
 */
export class ArenaSim {
  /** Fixed for a match; only `switchArena` (dev test matches) changes it. */
  arena: ArenaDef;
  time = 0;
  tickNo = 0;
  /** Set to record commands for a replay. */
  onCommand: ((c: SimCommand) => void) | null = null;
  /** Set to record the units added, in order. */
  onUnit: ((o: AddUnitOptions) => void) | null = null;
  phase: Phase = 'prep';
  winner: TeamId | 'draw' | null = null;
  readonly prepEndsAt: number;
  matchEndsAt: number;
  readonly units = new Map<number, Unit>();
  private events: SimEvent[] = [];
  private zones: { id: number; owner: number; team: TeamId; x: number; z: number; r: number; school: School; ability: string; amount: number; start: number; firstAt: number; nextAt: number; pulse: number; end: number; smoke?: boolean; flag?: boolean; /** A circle that keeps `aura` on those inside (Battle Banner, Rune of Power). */ buff?: { aura: string; who: 'allies' | 'self' }; held?: Set<number>; /** Floor height it lies on (on top of a walkway or the ground). */ h: number }[] = [];
  private nextZoneId = 1;
  private facingRule = false;
  private nextId = 1;
  private rng: () => number;
  /** Milliseconds per step, and per step in seconds. */
  readonly tickMs: number;
  private readonly dt: number;
  /** The tick-count form of the input queue limits and of the lag compensation history (see INPUT_QUEUE_MS), worked out once from tickMs. */
  readonly limits: { queue: number; repeat: number; catchDepth: number; catchMax: number; credit: number; history: number };

  constructor(opts: SimOptions = {}) {
    this.tickMs = Math.max(1, Math.round(opts.tickMs ?? TUNING.tickMs));
    this.dt = this.tickMs / 1000;
    const n = (ms: number) => Math.max(1, Math.ceil(ms / this.tickMs - 1e-9));
    this.limits = { queue: n(INPUT_QUEUE_MS), repeat: n(INPUT_REPEAT_MS), catchDepth: n(CATCHUP_DEPTH_MS), catchMax: n(CATCHUP_MAX_MS), credit: n(CATCHUP_CREDIT_MS), history: Math.max(12, n(HISTORY_MS)) };
    this.arena = opts.arena ?? ARENA;
    this.facingRule = opts.facing ?? false;
    this.rng = mulberry32(opts.seed ?? 1);
    this.prepEndsAt = opts.prepMs ?? TUNING.prepMs;
    this.matchEndsAt = this.prepEndsAt + TUNING.maxMatchMs;
  }

  // ------------------------------------------------------------------ setup

  addUnit(o: AddUnitOptions): Unit {
    this.onUnit?.(o);
    const cls = CLASSES[o.classId];
    const gear = clamp(o.gearMult ?? 1, 1, TUNING.gearCap);
    const slot = [...this.units.values()].filter((u) => u.team === o.team).length;
    const spawns = this.arena.spawns[o.team];
    const spawn = spawns[slot % spawns.length];
    const facing = this.arena.spawnFacing[o.team];
    const mods = compileMods(o.classId, o.build);
    const maxHealth = Math.round(cls.maxHealth * gear * mods.maxHealth);
    const u: Unit = {
      id: this.nextId++, name: o.name, team: o.team, classId: o.classId, controller: o.controller ?? 'player',
      pos: { x: spawn.x, z: spawn.z }, facing, alive: true,
      health: maxHealth, maxHealth,
      resource: cls.resource.start, resourceMax: cls.resource.max, resourceType: cls.resource.type,
      level: 0, gearMult: gear, bar: barFor(o.classId, o.build, cls.bar), spec: o.build?.spec ?? null, talents: [...(o.build?.talents ?? [])], trinket: trinketFor(o.classId, o.build), stealthSwaps: stealthSwapsFor(o.classId, o.build), buildRef: o.build, look: gearLook(o.build?.gear), mods, target: null, cast: null, gcdEnd: 0, cooldowns: {}, chargesUsed: {}, cp: 0, auras: [], dr: {}, lockouts: {},
      autoAttack: false, autoSince: 0, autoDisabled: false, nextSwing: 0, lastCombatAt: -1e9,
      inputQueue: [], charge: null, leap: null, lastCast: null, jumpStart: -1e9, dodgeUntil: 0, dodgeReadyAt: 0, lastInput: { seq: 0, fwd: 0, strafe: 0, facing }, lastSeq: 0, starve: 0,
      fearDir: { x: 0, z: 0 }, fearRetargetAt: 0,
    };
    if (u.controller === 'dummy') u.home = { x: spawn.x, z: spawn.z };
    this.units.set(u.id, u);
    return u;
  }

  /**
   * Dev tools: give a unit another class and build in the middle of a match (a bot picked in the debug window). It keeps
   * its place, team and name but starts fresh: full health and resource, no auras or cooldowns. Only used in test matches,
   * which are never recorded.
   */
  rebuildUnit(id: number, classId: ClassId, build: Build | undefined, name?: string): Unit | null {
    const u = this.units.get(id);
    if (!u) return null;
    const cls = CLASSES[classId];
    const mods = compileMods(classId, build);
    const maxHealth = Math.round(cls.maxHealth * u.gearMult * mods.maxHealth);
    this.endCharge(u, false);
    this.recharge.delete(id);
    Object.assign(u, {
      classId, name: name ?? u.name, alive: true, health: maxHealth, maxHealth, mods,
      resource: cls.resource.start, resourceMax: cls.resource.max, resourceType: cls.resource.type,
      bar: barFor(classId, build, cls.bar), spec: build?.spec ?? null, talents: [...(build?.talents ?? [])], trinket: trinketFor(classId, build), stealthSwaps: stealthSwapsFor(classId, build), buildRef: build,
      look: gearLook(build?.gear), cast: null, gcdEnd: 0, cooldowns: {}, chargesUsed: {}, cp: 0, auras: [], dr: {}, lockouts: {}, autoAttack: false, leap: null, target: null,
    } as Partial<Unit>);
    return u;
  }

  /**
   * Dev tools: start the match over with the same units and builds: everyone back at their spawn at full health, cooldowns
   * and effects cleared, and the fight live at once (no preparation). Only used in test matches, which are never recorded.
   */
  resetMatch(): void {
    const slots = new Map<number, number>();
    for (const u of this.units.values()) {
      const i = slots.get(u.team) ?? 0;
      slots.set(u.team, i + 1);
      const spawns = this.arena.spawns[u.team];
      const sp = spawns[i % spawns.length];
      this.rebuildUnit(u.id, u.classId, u.buildRef);
      Object.assign(u, {
        pos: { x: sp.x, z: sp.z }, facing: this.arena.spawnFacing[u.team], level: 0, charge: null, leap: null, inputQueue: [], lastCast: null,
        lastCombatAt: -1e9, nextSwing: 0, autoSince: 0, jumpStart: -1e9, dodgeUntil: 0, dodgeReadyAt: 0, starve: 0, catchUp: 0, owed: 0, fearDir: { x: 0, z: 0 }, fearRetargetAt: 0, respawnAt: undefined,
      } as Partial<Unit>);
      u.lastInput = { seq: u.lastSeq, fwd: 0, strafe: 0, facing: this.arena.spawnFacing[u.team] };
    }
    this.zones = [];
    this.recharge.clear();
    this.pending.clear();
    this.winner = null;
    this.phase = 'live';
    this.matchEndsAt = this.time + TUNING.maxMatchMs;
    this.emit({ t: 'phase', phase: 'live', winner: null });
  }

  /**
   * Dev tools: move the running test match to another arena: everyone is put at the new arena's spawns (facing included)
   * like `resetMatch`, with the same units, builds, bots, dummies and live numbers. Only used in dev test rooms, which are
   * never replayed, so recorded matches (which never call it) are unaffected.
   */
  switchArena(arena: ArenaDef): void {
    this.arena = arena;
    this.resetMatch();
    for (const u of this.units.values()) if (u.home) u.home = { x: u.pos.x, z: u.pos.z };
  }

  /**
   * Dev tools: work every unit's numbers out again from the data as it is now (class health and resource, spec and talent
   * bonuses), after a dev changed a class, spec or talent number. Health and resource keep their share.
   */
  refreshMods(): void {
    for (const u of this.units.values()) {
      const cls = CLASSES[u.classId];
      const mods = compileMods(u.classId, u.buildRef);
      const maxHealth = Math.round(cls.maxHealth * u.gearMult * mods.maxHealth);
      const frac = u.maxHealth > 0 ? u.health / u.maxHealth : 1;
      const rf = u.resourceMax > 0 ? u.resource / u.resourceMax : 0;
      u.mods = mods;
      u.maxHealth = maxHealth;
      if (u.alive) u.health = Math.max(1, Math.round(maxHealth * frac));
      u.resourceMax = cls.resource.max;
      u.resource = Math.round(cls.resource.max * rf);
    }
  }

  /** A disconnect counts as a forfeit: the unit dies so match-end logic runs normally. */
  forfeit(id: number): void {
    this.onCommand?.([this.tickNo, 4, id]);
    const u = this.units.get(id);
    if (u?.alive) this.die(u, null);
  }

  // ------------------------------------------------------------------ player commands

  queueInput(id: number, input: MoveInput): void {
    const u = this.units.get(id);
    if (!u || !u.alive) return;
    // quantised here (not just in the recorder) so a replay of the recorded numbers is bit-identical to the live match
    const fwd = Math.round(clamp(input.fwd, -1, 1) * 100) / 100;
    const strafe = Math.round(clamp(input.strafe, -1, 1) * 100) / 100;
    const facing = Math.round(input.facing * 1000) / 1000;
    this.onCommand?.([this.tickNo, 0, id, input.seq, fwd, strafe, facing, input.jump === true ? 1 : 0]);
    u.inputQueue.push({ seq: input.seq, fwd, strafe, facing, jump: input.jump === true });
    while (u.inputQueue.length > this.limits.queue) u.inputQueue.shift();
  }

  setTarget(id: number, targetId: number | null): Result {
    this.onCommand?.([this.tickNo, 1, id, targetId]);
    const u = this.units.get(id);
    if (!u) return fail('no unit');
    if (targetId === null) {
      u.target = null;
      u.autoAttack = false; // clicking off the target stops swinging
      return ok;
    }
    const t = this.units.get(targetId);
    if (!t) return fail('no such target');
    if (t.team !== u.team && !this.canSee(u, t)) return fail('target not visible');
    u.target = targetId;
    return ok;
  }

  setAutoAttack(id: number, on: boolean): void {
    this.onCommand?.([this.tickNo, 3, id, on]);
    const u = this.units.get(id);
    if (!u) return;
    const next = on && !u.autoDisabled && !!autoFor(u.classId, u.spec);
    if (next && !u.autoAttack) u.autoSince = this.time;
    u.autoAttack = next;
  }

  /** The auto-attack setting: while disabled the unit never auto-attacks. Recorded in replays as op 5. */
  setAutoDisabled(id: number, disabled: boolean): void {
    this.onCommand?.([this.tickNo, 5, id, disabled]);
    const u = this.units.get(id);
    if (!u) return;
    u.autoDisabled = disabled;
    if (disabled) u.autoAttack = false;
  }

  /** Casts held back for a moment because the target was just out of range or not quite in front (online play only). */
  private pending = new Map<number, { ability: string; target: number | null; ground: Ground | null; until: number; reason: string }>();

  /**
   * Lag compensation: `rewindMs` is how far behind the live state the caster's screen was when they pressed the button. Range and facing are judged
   * against where the target stood then (capped at TUNING.maxRewindMs), because that is what the player saw and aimed at.
   */
  useAbility(id: number, abilityId: string, targetId?: number | null, ground?: Ground | null, rewindMs = 0): Result {
    rewindMs = Number.isFinite(rewindMs) ? Math.max(0, Math.min(TUNING.maxRewindMs, Math.round(rewindMs))) : 0;
    const cmd: SimCommand = [this.tickNo, 2, id, abilityId, targetId ?? null, ground ? Math.round(ground.x * 100) / 100 : null, ground ? Math.round(ground.z * 100) / 100 : null, rewindMs, ...(ground?.lv === 1 ? [1] : [])];
    if (ground) ground = { x: Math.round(ground.x * 100) / 100, z: Math.round(ground.z * 100) / 100, ...(ground.lv === 1 ? { lv: 1 as const } : {}) };
    const dropped = this.pending.delete(id); // any new press replaces a held cast
    const r = this.tryUse(id, abilityId, targetId ?? null, ground ?? null, false, rewindMs);
    // a refused press changes nothing (unless it replaced a held cast), so it is left out of the replay: bots press a lot of buttons that fail
    if (r.ok || dropped) this.onCommand?.(cmd);
    return r;
  }

  /** Stop casting or channelling (a bot changing its mind). Recorded, so a replay stops the same cast on the same tick. */
  stopCast(id: number, reason = 'cancelled'): void {
    const u = this.units.get(id);
    if (!u?.cast) return;
    this.onCommand?.([this.tickNo, 6, id]);
    this.cancelCast(u, reason);
  }

  /** Retry held casts each tick until they land or the grace window runs out. */
  private retryPending(): void {
    for (const [id, p] of [...this.pending]) {
      const u = this.units.get(id);
      if (!u || !u.alive) { this.pending.delete(id); continue; }
      this.pending.delete(id);
      const r = this.tryUse(id, p.ability, p.target, p.ground, true, 0);
      if (r.ok) continue;
      if (this.time >= p.until || !GRACE_REASONS.includes(r.reason)) this.failCast(u, p.ability, this.time >= p.until ? p.reason : r.reason);
      else this.pending.set(id, p);
    }
  }

  private tryUse(id: number, abilityId: string, targetId: number | null, ground: Ground | null, retry: boolean, rewindMs: number): Result {
    const u = this.units.get(id);
    if (!u || !u.alive) return fail('you are dead');
    const soft = (reason: string): Result => {
      // a player cast that only misses on range or facing is held for a moment (the target may have been in reach on their screen)
      if (this.facingRule && u.controller === 'player' && TUNING.castGraceMs > 0 && !retry) {
        this.pending.set(id, { ability: abilityId, target: targetId, ground, until: this.time + TUNING.castGraceMs, reason });
        return ok;
      }
      return fail(reason);
    };
    const def = ABILITIES[abilityId];
    if (def && !u.bar.includes(abilityId)) {
      // a slot can turn into another ability while stealthed (Sinister Strike and Mutilate become Cheap Shot)
      if (u.bar.some((b) => (u.stealthSwaps?.[b] ?? ABILITIES[b]?.stealthSwap) === abilityId)) {
        if (!this.isStealthed(u)) return fail('requires stealth');
      } else if (u.trinket !== abilityId) return fail('unknown ability');
    } else if (!def) return fail('unknown ability');
    if (this.phase === 'ended') return fail('match is over');
    if (this.phase === 'prep' && !def.prepOk) return fail('match has not started');
    if (u.auras.some((a) => AURAS[a.id]?.noCast)) return fail('you cannot act while dispersed');
    if (!this.canAct(u) && !def.ignoresControl) return fail('you are incapacitated');
    if (def.ignoresControl && u.auras.some((a) => AURAS[a.id]?.locksAbilities)) return fail(u.auras.some((a) => a.id === 'polymorph') ? 'you are polymorphed' : 'you are disoriented');
    if (!def.ignoresLockout && (u.lockouts[def.school] ?? 0) > this.time) return fail(`${def.school} school is locked out`);
    if (this.storedFull(u, def)) return fail('ability is on cooldown');
    if (!this.modsOf(u).ability[def.id]?.stored && (u.cooldowns[def.id] ?? 0) > this.time && (u.chargesUsed[def.id] ?? 0) >= (this.modsOf(u).ability[def.id]?.charges ?? 0)) return fail('ability is on cooldown');
    if (def.gcd && u.gcdEnd > this.time) return fail('global cooldown');
    if (u.resource < this.costOf(u, def)) return fail(`not enough ${u.resourceType}`);
    if (def.cpSpend && u.cp < 1) return fail('needs combo points');
    if (def.requiresStealth && !this.isStealthed(u)) return fail('requires stealth');
    if (def.outOfCombatOnly && this.time - u.lastCombatAt < TUNING.outOfCombatMs) return fail('cannot use in combat');
    if (this.hasAura(u, ['root']) && !def.allowWhileRooted && def.effects.some((e) => e.type === 'dashToTarget' || e.type === 'charge' || e.type === 'leap')) return fail('you are rooted');

    if (def.target === 'ground') {
      if (!ground && targetId !== undefined && targetId !== null) {
        const t0 = this.units.get(targetId);
        if (t0) ground = { x: t0.pos.x, z: t0.pos.z, ...(t0.level === 1 && onRaised(this.arena, t0.pos.x, t0.pos.z) ? { lv: 1 as const } : {}) }; // at the target's feet, on its floor
      }
      if (!ground || !Number.isFinite(ground.x) || !Number.isFinite(ground.z)) return fail('no target location');
      const b = this.arena.bounds;
      ground = { x: clamp(ground.x, b.minX, b.maxX), z: clamp(ground.z, b.minZ, b.maxZ), ...(ground.lv === 1 && onRaised(this.arena, ground.x, ground.z) ? { lv: 1 as const } : {}) };
      if (dist(u.pos, ground) > this.rangeOf(u, def) + TUNING.rangeTolerance) return soft('out of range');
      if (!hasLOS(u.pos, ground, this.arena, u.level, ground.lv ?? 0, this.airOf(u))) return fail('no line of sight');
    }

    const tgt = this.resolveTarget(u, def, targetId);
    if (typeof tgt === 'string') return fail(tgt);

    if (tgt !== u) {
      // judged where the target was on the caster's screen, not where it has moved to since
      const seen = rewindMs > 0 && tgt.team !== u.team ? this.posAt(tgt, this.time - rewindMs) : tgt.pos;
      const d = this.gap(u, seen, tgt.level);
      if (def.range > 0 && d > this.reachOf(u, def)) return soft('out of range');
      if (isMelee(def) && tgt.team !== u.team && this.floorsApart(u, seen, tgt.level)) return soft('out of range'); // a blade does not reach up or down to another floor
      if (def.minRange && d < def.minRange && tgt.team !== u.team) return fail('too close');
      if (!this.sees(u, tgt)) return fail('no line of sight');
      // friendly spells need no facing (a shield on the ally behind you), only spells aimed at enemies do
      if (def.target !== 'aoe_enemy' && def.target !== 'aoe_all' && !def.unmissable && tgt.team !== u.team && !this.inFront(u, seen.x, seen.z)) return soft('target is not in front of you');
      if (def.requiresTargetCasting && !tgt.cast && !(tgt.lastCast && this.time - tgt.lastCast.at <= INTERRUPT_GRACE_MS)) return fail('target is not casting');
      if (def.requiresTargetAura && !this.abilityMod(u, def).free && !tgt.auras.some((a) => def.requiresTargetAura!.includes(a.id))) return fail(`target needs ${def.requiresTargetAura.map((x) => AURAS[x]?.name ?? x).join(' or ')}`);
      if (def.maxTargetHealthPct !== undefined && tgt.health >= (tgt.maxHealth * def.maxTargetHealthPct) / 100) return fail(`target must be below ${def.maxTargetHealthPct}% health`);
    }
    if (def.effects.some((e) => e.type === 'dispel' && !e.all) && !this.dispelCandidate(u, tgt)) return fail('nothing to dispel');

    // pressing the spell you are already casting does not start it over: in the last moments of the cast it is held and goes
    // off as soon as this one finishes (a player's spell queue arriving a little early); otherwise it is ignored
    if (u.cast && u.cast.ability === def.id) {
      if (!retry && this.facingRule && u.controller === 'player' && u.cast.end - this.time <= REPEAT_HOLD_MS) {
        this.pending.set(id, { ability: abilityId, target: targetId, ground, until: u.cast.end + this.tickMs * 2, reason: 'already casting that' });
        return ok;
      }
      return fail('already casting that');
    }
    // some abilities go off in the middle of a cast without stopping it (the trinket, Blink with its talent)
    const through = u.trinket === def.id || !!this.abilityMod(u, def).castDuring;
    // an unstoppable channel (Bladestorm) is not ended by pressing something else either: it runs its course
    if (u.cast && !through && ABILITIES[u.cast.ability]?.unstoppable) return fail(`you are channelling ${ABILITIES[u.cast.ability].name}`);
    // using any other ability stops the cast in progress, interrupts included (they can still be pressed mid-cast)
    if (u.cast && !through) this.cancelCast(u, 'switched spell');
    if (def.target === 'enemy' && tgt.team !== u.team) u.target = tgt.id;

    if (def.channel && def.castTime > 0) {
      // channels pay and go on cooldown up front, then fire their effects once per tick while the caster stands still
      const castMs = this.castTimeOf(u, def);
      u.resource -= this.costOf(u, def);
      this.startCooldown(u, def);
      u.cast = { ability: def.id, target: tgt.id, start: this.time, end: this.time + castMs, ticks: this.abilityMod(u, def).ticks ?? def.channel.ticks, done: 0 };
      if (def.gcd) u.gcdEnd = this.time + this.gcdOf(u);
      if (!def.keepsStealth && this.isStealthed(u)) this.breakStealth(u);
      this.breakHealChain(u, def.id);
      this.emit({ t: 'cast_start', unit: u.id, ability: def.id, target: tgt.id, end: u.cast.end });
      if (def.channel.immediate) this.tickChannel(u); // the first strike (and its stun) lands the moment the channel starts, not a tick later
      return ok;
    }
    const proc = def.castTime > 0 ? u.auras.find((a) => AURAS[a.id]?.instantFor === def.id) : undefined;
    if (proc) {
      // a proc (Hot Streak) makes this cast instant and is used up
      this.removeAura(u, proc, 'consumed');
      if (def.gcd) u.gcdEnd = this.time + this.gcdOf(u);
      this.procCast = true;
      try { this.execute(u, def, tgt, ground ?? undefined); } finally { this.procCast = false; }
      return ok;
    }
    if (def.castTime > 0) {
      const castMs = this.castTimeOf(u, def);
      u.cast = { ability: def.id, target: tgt.id, start: this.time, end: this.time + castMs, ...(ground ? { gx: ground.x, gz: ground.z, ...(ground.lv === 1 ? { gl: 1 as const } : {}) } : {}) };
      if (def.gcd) u.gcdEnd = this.time + this.gcdOf(u);
      this.breakHealChain(u, def.id);
      this.emit({ t: 'cast_start', unit: u.id, ability: def.id, target: tgt.id, end: u.cast.end });
      return ok;
    }
    this.execute(u, def, tgt, ground ?? undefined);
    return ok;
  }

  // ------------------------------------------------------------------ tick

  /** True while a proc-made instant cast executes (so it cannot chain into another proc). */
  private procCast = false;
  /** The channel whose tick is being applied right now, and the diminishing-returns level each of its casts set per target. */
  private channelOf: { unit: number; start: number; end: number } | null = null;
  private channelDr = new Map<string, number>();

  step(): void {
    this.time += this.tickMs;
    this.tickNo++;
    if (this.phase === 'prep' && this.time >= this.prepEndsAt) {
      this.phase = 'live';
      this.emit({ t: 'phase', phase: 'live', winner: null });
    }
    for (const u of this.units.values()) if (u.alive) this.tickUnit(u);
    if (this.pending.size) this.retryPending();
    this.recordHistory();
    this.tickZones();
    if (this.phase === 'live') this.checkEnd();
  }

  /** Where every unit stood over the last few ticks, for lag compensation. Derived from sim state only, so replays rebuild it exactly. */
  private history: { time: number; pos: Map<number, { x: number; z: number }> }[] = [];

  private recordHistory(): void {
    const pos = new Map<number, { x: number; z: number }>();
    for (const u of this.units.values()) pos.set(u.id, { x: u.pos.x, z: u.pos.z });
    this.history.push({ time: this.time, pos });
    if (this.history.length > this.limits.history) this.history.shift();
  }

  /** A unit's position at an earlier sim time (linear between recorded ticks; the oldest or current position outside the window). */
  private posAt(u: Unit, time: number): { x: number; z: number } {
    const h = this.history;
    if (!h.length || time >= this.time) return u.pos;
    if (time <= h[0].time) return h[0].pos.get(u.id) ?? u.pos;
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].time <= time) {
        const a = h[i - 1].pos.get(u.id);
        const b = h[i].pos.get(u.id);
        if (!a || !b) return u.pos;
        const k = (time - h[i - 1].time) / Math.max(1, h[i].time - h[i - 1].time);
        return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
      }
    }
    return u.pos;
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private tickUnit(u: Unit): void {
    const cls = CLASSES[u.classId];
    const DT = this.dt;
    const { catchDepth, catchMax, credit } = this.limits;
    for (const a of [...u.auras]) {
      const hot = AURAS[a.id]?.hot;
      if (hot && a.nextTick !== undefined) {
        while (u.alive && a.nextTick <= this.time && a.nextTick <= a.expiresAt && u.auras.includes(a)) {
          a.nextTick += hot.interval;
          this.heal(u, u, (u.maxHealth * hot.pct) / 100, a.id);
        }
      }
      const dot = AURAS[a.id]?.dot;
      if (dot && a.nextTick !== undefined) {
        while (u.alive && a.nextTick <= this.time && a.nextTick <= a.expiresAt && u.auras.includes(a)) {
          a.nextTick += dot.interval;
          const src = this.units.get(a.sourceId) ?? null;
          const m = src ? this.modsOf(src) : null;
          this.dealDamage(src, u, dot.amount * (a.dotMult ?? 1) * (AURAS[a.id].maxStacks ? (a.stacks ?? 1) : 1) * (src?.gearMult ?? 1) * this.variance() * (m?.damageDone ?? 1) * (m?.ability[dot.ability]?.damage ?? 1), dot.school, dot.ability, true);
        }
      }
      if (u.alive && a.expiresAt <= this.time) this.removeAura(u, a, 'expired');
    }
    if (!u.alive) return;

    // auto-attack switches itself off once combat has been over for a while
    // (not while an enemy is still targeted: swinging stays on while you walk up to it, as in WoW)
    if (u.autoAttack && this.time - Math.max(u.lastCombatAt, u.autoSince) > TUNING.outOfCombatMs) {
      const tg = u.target !== null ? this.units.get(u.target) : undefined;
      if (!tg || !tg.alive || tg.team === u.team) u.autoAttack = false;
    }

    // resources
    if (u.resourceType === 'rage') {
      if (this.time - u.lastCombatAt > TUNING.outOfCombatMs) u.resource = Math.max(0, u.resource - TUNING.rageDecayPerSec * DT);
    } else {
      u.resource = Math.min(u.resourceMax, u.resource + cls.resource.regenPerSec * this.modsOf(u).regen * DT);
    }

    // input catch-up: a backlog (a late burst after a stall) is worked off in this same tick instead of staying for the whole
    // match. Two kinds of tick are owed back, and neither can make a unit move more ticks than the clock has run:
    //  - a tick that repeated the last input (`owed`) already moved the unit, so the same number of queued inputs are consumed
    //    without moving it again (their seq is still acknowledged);
    //  - a tick with nothing to play that left the unit standing (`catchUp` credit) lets one queued input move it, up to
    //    CATCHUP_MAX such extra steps per tick.
    const extras: MoveInput[] = [];
    while (u.inputQueue.length > catchDepth) {
      let move = false;
      if ((u.owed ?? 0) >= 1) u.owed = (u.owed ?? 0) - 1;
      else if (extras.length < catchMax && (u.catchUp ?? 0) >= 1) {
        u.catchUp = (u.catchUp ?? 0) - 1;
        move = true;
      } else break;
      const x = u.inputQueue.shift()!;
      if (move) extras.push(x);
      u.lastInput = x;
      u.lastSeq = x.seq;
      if (x.jump && this.canAct(u) && canStartJump(this.time - u.jumpStart)) {
        u.jumpStart = this.time;
        if (this.time >= u.dodgeReadyAt) {
          u.dodgeUntil = this.time + JUMP_MS;
          u.dodgeReadyAt = this.time + JUMP_DODGE_CD;
        }
      }
    }
    // input: one queued command per tick; briefly repeat the last one if a packet is late
    let input: MoveInput;
    const queued = u.inputQueue.shift();
    if (queued) {
      input = queued;
      u.lastInput = queued;
      u.lastSeq = queued.seq;
      u.starve = 0;
    } else if (u.starve < this.limits.repeat) {
      input = u.lastInput;
      u.starve++;
      u.owed = Math.min(credit, (u.owed ?? 0) + 1); // this tick moved the unit on a guess: the input that belongs to it must not move it again
    } else {
      input = { ...u.lastInput, fwd: 0, strafe: 0 };
      u.catchUp = Math.min(credit, (u.catchUp ?? 0) + 1); // a tick with nothing played and no movement is owed back
    }

    // a fresh jump request only (a repeated stale input must not re-jump)
    if (queued?.jump && this.canAct(u) && canStartJump(this.time - u.jumpStart)) {
      u.jumpStart = this.time;
      if (this.time >= u.dodgeReadyAt) {
        u.dodgeUntil = this.time + JUMP_MS;
        u.dodgeReadyAt = this.time + JUMP_DODGE_CD;
      }
    }

    // movement
    const before = { x: u.pos.x, z: u.pos.z };
    if (u.leap) {
      const L = u.leap;
      const p = Math.min(1, (this.time + this.tickMs - L.start) / L.dur);
      u.facing = Math.atan2(L.toX - L.fromX, L.toZ - L.fromZ);
      const yAbs = leapHeight(L, p);
      this.place(u, { x: L.fromX + (L.toX - L.fromX) * p, z: L.fromZ + (L.toZ - L.fromZ) * p }, Math.max(0, yAbs - heightAt(this.arena, u.pos.x, u.pos.z, u.level))); // in the air: over rails and barricades
      // coming down onto a walkway: once over it and no lower than its floor, you are on it
      if (L.toLv === 1 && u.level === 0 && onRaised(this.arena, u.pos.x, u.pos.z) && yAbs >= heightAt(this.arena, u.pos.x, u.pos.z, 1) - STEP_HEIGHT) u.level = 1;
      if (p >= 1) {
        u.leap = null;
        this.emit({ t: 'leap_land', unit: u.id, x: u.pos.x, z: u.pos.z });
        if (L.damage > 0) for (const e of this.units.values()) if (e.alive && e.team !== u.team && this.gap(u, e.pos, e.level) <= L.radius && this.sees(u, e)) this.dealDamage(u, e, L.damage * u.gearMult * this.variance() * this.modsOf(u).damageDone * (this.modsOf(u).ability['heroic_leap']?.damage ?? 1), 'physical', 'heroic_leap');
      }
      return;
    }
    if (u.charge) {
      const ch = u.charge;
      const tgt = this.units.get(ch.target);
      const d = tgt ? dist(u.pos, tgt.pos) : 0;
      const arrived = d <= ch.stop + 0.05;
      if (tgt && arrived && tgt.level !== u.level && this.gap(u, tgt.pos, tgt.level) > ch.stop + TUNING.autoTolerance) {
        // under (or over) a target on another floor: the charge ends there without the hit, instead of parking you out of reach
        this.endCharge(u, false);
      } else if (!tgt || !tgt.alive || this.time > ch.until || !this.canAct(u) || this.hasAura(u, ['root']) || arrived) {
        this.endCharge(u, !!tgt && tgt.alive && this.canAct(u) && !this.hasAura(u, ['root']) && arrived);
      } else {
        const k = Math.min(ch.speed * DT, d - ch.stop);
        const nx = u.pos.x + ((tgt.pos.x - u.pos.x) / d) * k;
        const nz = u.pos.z + ((tgt.pos.z - u.pos.z) / d) * k;
        u.facing = Math.atan2(tgt.pos.x - u.pos.x, tgt.pos.z - u.pos.z);
        this.place(u, { x: nx, z: nz }, LOW_CLEAR); // a charge bounds over rails and barricades (and off a walkway onto someone below)
        // blocked by a pillar: stop rather than push against it
        if (dist(before, u.pos) < k * 0.3) this.endCharge(u, false);
        if (this.phase === 'prep') u.pos = clampToGate(u.pos, u.team, this.arena);
        if (u.cast && dist(before, u.pos) > 0.001 && !ABILITIES[u.cast.ability]?.castWhileMoving) this.cancelCast(u, 'moved');
        this.tryAutoAttack(u);
        return;
      }
    }
    const feared = this.hasAura(u, ['fear']);
    if (extras.length && !feared && !(u.cast && ABILITIES[u.cast.ability]?.channel?.hold)) {
      // the extra steps of the catch-up (only where the unit moves freely; held, feared or channelling it is just consumed)
      const speed = TUNING.runSpeed * this.speedMult(u);
      if (speed > 0) {
        for (const x of extras) {
          if (!Number.isFinite(x.facing)) continue;
          const r = stepMovementL(u.pos, u.level, x, speed, DT, this.arena, jumpHeight(this.time - u.jumpStart));
          u.pos = r.pos;
          u.level = r.level;
        }
      }
    }
    if (feared && this.hasAura(u, ['root', 'stun', 'incapacitate'])) {
      // feared but also held in place: the fear cannot make you run
    } else if (feared) {
      if (this.time >= u.fearRetargetAt) {
        let ang = this.rng() * Math.PI * 2;
        const fa = u.auras.find((a) => a.kind === 'fear' && AURAS[a.id]?.flee);
        const from = fa ? this.units.get(fa.sourceId) : undefined;
        if (from) ang = Math.atan2(u.pos.x - from.pos.x, u.pos.z - from.pos.z) + (this.rng() - 0.5) * 0.5; // away from whoever screamed
        u.fearDir = { x: Math.sin(ang), z: Math.cos(ang) };
        u.facing = ang;
        u.fearRetargetAt = this.time + 1000;
      }
      const k = TUNING.fearSpeed * TUNING.runSpeed * DT;
      this.place(u, { x: u.pos.x + u.fearDir.x * k, z: u.pos.z + u.fearDir.z * k });
    } else if (u.cast && ABILITIES[u.cast.ability]?.channel?.hold) {
      // locked in a channel that holds the caster (Slice and Dice): you stand where you are and keep facing your target
    } else {
      if ((this.canAct(u) || u.auras.some((a) => AURAS[a.id]?.canTurn)) && Number.isFinite(input.facing)) u.facing = input.facing;
      const speed = TUNING.runSpeed * this.speedMult(u);
      if (speed > 0) { const r = stepMovementL(u.pos, u.level, input, speed, DT, this.arena, jumpHeight(this.time - u.jumpStart)); u.pos = r.pos; u.level = r.level; } // high enough in a jump, rails and barricades are cleared
    }
    // come down from a jump on top of a barricade (and stopped there): step off it, never stand inside it
    if (u.level === 0 && this.arena.lows?.length && jumpHeight(this.time - u.jumpStart) < LOW_CLEAR && this.arena.lows.some((r) => u.pos.x > r.x0 - 0.3 && u.pos.x < r.x1 + 0.3 && u.pos.z > r.z0 - 0.3 && u.pos.z < r.z1 + 0.3)) {
      u.pos = resolveCollisions(u.pos, this.arena, 0, jumpHeight(this.time - u.jumpStart), before);
    }
    // lava pits: whoever stands in one (jumped in, nobody walks in) burns every half second until they climb out
    if (u.alive && u.level === 0 && this.arena.lows?.some((r) => r.lava) && jumpHeight(this.time - u.jumpStart) < 0.3 && inLava(this.arena, u.pos)) {
      if ((u.lavaAt ?? 0) <= this.time) {
        u.lavaAt = this.time + TUNING.lavaIntervalMs;
        this.dealDamage(null, u, u.maxHealth * TUNING.lavaPct, 'fire', 'lava', true);
      }
    }
    if (this.phase === 'prep') u.pos = clampToGate(u.pos, u.team, this.arena);
    if (u.cast && dist(before, u.pos) > 0.001 && !ABILITIES[u.cast.ability]?.castWhileMoving) this.cancelCast(u, 'moved');

    if (u.cast?.ticks) this.tickChannel(u);
    if (u.cast && u.cast.end <= this.time) this.completeCast(u);
    this.tryAutoAttack(u);
  }

  /** Training dummies stand up again, at full health, a moment after they fall. */
  private respawnDummies(): void {
    for (const u of this.units.values()) {
      if (u.alive || u.respawnAt === undefined || this.time < u.respawnAt) continue;
      u.respawnAt = undefined;
      u.alive = true;
      u.health = u.maxHealth;
      u.pos = { ...(u.home ?? u.pos) };
      u.auras = [];
      u.cooldowns = {};
      u.dr = {}; // a fresh dummy: no leftover diminishing returns
      u.level = 0;
      u.cp = 0;
      u.lastCombatAt = -1e9;
      this.emit({ t: 'respawn', unit: u.id });
    }
  }

  private checkEnd(): void {
    this.respawnDummies();
    let alive0 = 0;
    let alive1 = 0;
    // a dummy that is about to stand up again does not end the match
    for (const u of this.units.values()) if (u.alive || u.respawnAt !== undefined) (u.team === 0 ? alive0++ : alive1++);
    let winner: TeamId | 'draw' | null = null;
    if (alive0 === 0 && alive1 === 0) winner = 'draw';
    else if (alive0 === 0) winner = 1;
    else if (alive1 === 0) winner = 0;
    else if (this.time >= this.matchEndsAt) winner = 'draw';
    if (winner !== null) {
      this.phase = 'ended';
      this.winner = winner;
      this.emit({ t: 'phase', phase: 'ended', winner });
    }
  }

  // ------------------------------------------------------------------ casting

  /** Fire every channel tick that has come due. A dead or unreachable target ends the channel. */
  private tickChannel(u: Unit): void {
    const c = u.cast;
    if (!c || !c.ticks) return;
    const def = ABILITIES[c.ability];
    const span = c.end - c.start;
    while (u.cast === c && (c.done ?? 0) < c.ticks && this.time >= c.start + (span * ((c.done ?? 0) + (def.channel?.immediate ? 0 : 1))) / c.ticks - 1e-6) {
      const tgt = this.units.get(c.target);
      if (!tgt || !tgt.alive) {
        u.cast = null;
        this.emit({ t: 'channel_end', unit: u.id, ability: def.id });
        return;
      }
      if (tgt !== u) {
        if (def.range > 0 && this.gap(u, tgt.pos, tgt.level) > this.reachOf(u, def)) return this.cancelCast(u, 'out of range');
        // a channel that has started keeps ticking when the target steps behind a pillar or wall
        if (!this.canSee(u, tgt)) return this.cancelCast(u, 'target not visible');
      }
      c.done = (c.done ?? 0) + 1;
      this.emit({ t: 'cast', unit: u.id, ability: def.id, target: tgt.id });
      // area channels (Bladestorm, Slice and Dice) hit whoever stands in the area at each tick
      this.channelOf = { unit: u.id, start: c.start, end: c.end };
      try {
        for (const t of this.targetsOf(u, def, tgt)) for (const eff of def.effects) this.applyEffect(u, def, t, eff);
      } finally {
        this.channelOf = null;
      }
    }
  }

  private completeCast(u: Unit): void {
    const c = u.cast;
    if (!c) return;
    u.cast = null;
    u.lastCast = { ability: c.ability, at: this.time };
    const def = ABILITIES[c.ability];
    if (def.channel) {
      this.emit({ t: 'channel_end', unit: u.id, ability: def.id });
      return;
    }
    const tgt = this.units.get(c.target);
    if (!tgt || !tgt.alive) return this.failCast(u, c.ability, 'target is dead');
    if (tgt !== u) {
      if (def.range > 0 && this.gap(u, tgt.pos, tgt.level) > this.reachOf(u, def)) return this.failCast(u, c.ability, 'out of range');
      if (!this.sees(u, tgt)) return this.failCast(u, c.ability, 'no line of sight');
      if (!this.canSee(u, tgt)) return this.failCast(u, c.ability, 'target not visible');
    }
    if (u.resource < this.costOf(u, def)) return this.failCast(u, c.ability, `not enough ${u.resourceType}`);
    this.execute(u, def, tgt, c.gx !== undefined && c.gz !== undefined ? { x: c.gx, z: c.gz, ...(c.gl === 1 ? { lv: 1 as const } : {}) } : undefined);
  }

  cancelCast(u: Unit, reason: string): void {
    if (!u.cast) return;
    const ability = u.cast.ability;
    const def = ABILITIES[ability];
    u.cast = null;
    // a cast the caster stopped (moved, stopped, faked, lost its target) never went off: the global cooldown it started is given
    // back, so the other skills are usable at once. Interrupts and crowd control keep it, and channels have already paid.
    if (def?.gcd && !def.channel && GCD_REFUND.includes(reason) && u.gcdEnd > this.time) u.gcdEnd = this.time;
    this.failCast(u, ability, reason);
  }

  private failCast(u: Unit, ability: string, reason: string): void {
    this.emit({ t: 'cast_fail', unit: u.id, ability, reason });
  }

  /** Start an ability's cooldown; a use made while it is already running spends an extra charge instead of restarting it. */
  private startCooldown(u: Unit, def: AbilityDef): void {
    if (def.cooldown <= 0) return;
    // a buff that makes the next use free of cooldown (Mind Blast's Plague Ready) is used up by it
    const free = u.auras.find((a) => AURAS[a.id]?.freeCooldownFor === def.id);
    if (free) {
      this.removeAura(u, free, 'consumed');
      return;
    }
    const stored = this.modsOf(u).ability[def.id]?.stored ?? 0;
    if (stored > 0) {
      // each use recharges on its own timer; the slot only shows a cooldown while every charge is spent
      const pend = (this.recharge.get(u.id)?.[def.id] ?? []).filter((t) => t > this.time);
      pend.push(this.time + Math.round(def.cooldown * (this.modsOf(u).ability[def.id]?.cooldown ?? 1)));
      const per = this.recharge.get(u.id) ?? {};
      per[def.id] = pend;
      this.recharge.set(u.id, per);
      u.cooldowns[def.id] = pend.length >= 1 + stored ? Math.min(...pend) : 0;
      u.chargesUsed[def.id] = 0;
      return;
    }
    if ((u.cooldowns[def.id] ?? 0) > this.time) { u.chargesUsed[def.id] = (u.chargesUsed[def.id] ?? 0) + 1; return; }
    u.chargesUsed[def.id] = 0;
    u.cooldowns[def.id] = this.time + Math.round(def.cooldown * (this.modsOf(u).ability[def.id]?.cooldown ?? 1));
  }

  /** Everyone an ability's effects land on: the area for aoe abilities, otherwise the one target. */
  /** Area abilities reach as far as their radius plus any range a talent adds (a cone gets longer). Measured in 3D, and never through a pillar or a floor. */
  private targetsOf(u: Unit, def: AbilityDef, tgt: Unit): Unit[] {
    const r = this.radiusOf(u, def);
    if (def.target === 'aoe_enemy') return [...this.units.values()].filter((v) => v.alive && v.team !== u.team && this.gap(u, v.pos, v.level) <= r && this.inCone(u, v.pos, def.coneDeg) && this.sees(u, v));
    if (def.target === 'aoe_all') return [...this.units.values()].filter((v) => v.alive && (v === u || (this.gap(u, v.pos, v.level) <= r && this.sees(u, v))));
    return [tgt];
  }
  radiusOf(u: Unit, def: AbilityDef): number {
    return (def.radius ?? 0) + (this.abilityMod(u, def).range ?? 0);
  }
  /** Channelling something unstoppable (Bladestorm). */
  private unstoppable(u: Unit): boolean {
    return !!u.cast && !!ABILITIES[u.cast.ability]?.unstoppable;
  }
  /** A unit no longer standing over a walkway is on the ground. */
  private settleLevel(u: Unit): void {
    if (u.level === 1 && !onRaised(this.arena, u.pos.x, u.pos.z)) u.level = 0;
  }
  private recharge = new Map<number, Record<string, number[]>>();
  private storedFull(u: Unit, def: AbilityDef): boolean {
    const stored = this.modsOf(u).ability[def.id]?.stored ?? 0;
    if (!stored) return false;
    const pend = (this.recharge.get(u.id)?.[def.id] ?? []).filter((t) => t > this.time);
    return pend.length >= 1 + stored;
  }
  private costOf(u: Unit, def: AbilityDef): number {
    return Math.round(def.cost * (this.modsOf(u).ability[def.id]?.cost ?? 1));
  }
  /** True when `u` stands in the rear arc of `t` (about 110 degrees either side of straight behind). */
  private isBehind(u: Unit, t: Unit): boolean {
    let d = Math.atan2(u.pos.x - t.pos.x, u.pos.z - t.pos.z) - t.facing;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return Math.abs(d) >= (110 * Math.PI) / 180;
  }
  private ground: Ground | null = null;
  /** Per-cast scratch values (see execute). */
  private cpSpent = 0;
  private rageMult = 1;
  private empowerMult = 1;
  private stackMult = 1;

  /** Damage multiplier from marks on the target (Shatter) or an exploited aura (Fingers of Frost); they do not stack. */
  private vulnMult(t: Unit, def: AbilityDef): number {
    let m = 1;
    for (const a of t.auras) { const v = AURAS[a.id]?.vulnerable; if (v && v.school === def.school) m = Math.max(m, v.mult); }
    if (def.exploit && t.auras.some((a) => a.id === def.exploit!.aura)) m = Math.max(m, def.exploit.mult);
    return m;
  }

  private execute(u: Unit, def: AbilityDef, tgt: Unit, ground?: Ground): void {
    this.ground = ground ?? null;
    this.rageMult = 1;
    if (def.rageSpend) {
      // a rage payoff: everything you have goes in, and the blow scales with it
      const spent = Math.max(u.resource, def.rageSpend.min);
      this.rageMult = 1 + (def.rageSpend.maxMult - 1) * Math.min(1, Math.max(0, (spent - def.rageSpend.min) / Math.max(1, u.resourceMax - def.rageSpend.min)));
      u.resource = 0;
    } else u.resource -= this.costOf(u, def);
    this.startCooldown(u, def);
    if (def.gcd && def.castTime === 0) u.gcdEnd = this.time + this.gcdOf(u);
    this.breakHealChain(u, def.id);
    this.emit({ t: 'cast', unit: u.id, ability: def.id, target: tgt.id });

    const abMod = this.modsOf(u).ability[def.id];
    if (abMod?.shadowProc && tgt !== u && tgt.team !== u.team && this.rng() < abMod.shadowProc) {
      // a free Shadowstep first: land just behind the target (no combo points, unlike the real thing)
      const p = resolveCollisions({ x: tgt.pos.x - Math.sin(tgt.facing) * 1.6, z: tgt.pos.z - Math.cos(tgt.facing) * 1.6 }, this.arena, u.level);
      if (u.level === tgt.level && hasLOS(p, tgt.pos, this.arena, u.level, tgt.level)) {
        u.pos = p;
        u.facing = Math.atan2(tgt.pos.x - p.x, tgt.pos.z - p.z);
        u.lastInput = { ...u.lastInput, facing: u.facing };
        this.emit({ t: 'turn', unit: u.id, facing: u.facing });
      }
    }
    // combo points spent, shatter-style empowering and stack eating, worked out once for the whole cast
    this.cpSpent = def.cpSpend ? u.cp : 0;
    this.empowerMult = 1;
    this.stackMult = 1;
    const hits = def.effects.some((e) => e.type === 'damage');
    const empowerAura = hits ? u.auras.find((a) => AURAS[a.id]?.empower?.school === def.school && !def.effects.some((e) => e.type === 'aura' && AURAS[e.aura]?.empower)) : undefined;
    if (empowerAura) this.empowerMult = AURAS[empowerAura.id].empower!.mult;
    const eaten = def.consumes ? u.auras.find((a) => a.id === def.consumes!.aura) : undefined;
    if (eaten) this.stackMult = 1 + def.consumes!.perStack * (eaten.stacks ?? 1);

    const targets = this.targetsOf(u, def, tgt);

    const effects = abMod?.extra || abMod?.before ? [...(abMod.before ?? []), ...def.effects, ...(abMod.extra ?? [])] : def.effects;
    targets.forEach((t, i) => { for (const eff of effects) if (i === 0 || !(eff.type === 'aura' && eff.self)) this.applyEffect(u, def, t, eff); }); // a self aura is rolled once per cast, not once per enemy hit
    for (const id of this.modsOf(u).ability[def.id]?.after ?? []) this.applyAura(u, u, id);
    if (empowerAura) this.removeAura(u, empowerAura, 'consumed');
    if (def.exploit) for (const t of targets) { const x = t.auras.find((a) => a.id === def.exploit!.aura); if (!x) continue; if ((x.stacks ?? 1) > 1) x.stacks = (x.stacks ?? 1) - 1; else this.removeAura(t, x, 'consumed'); } // one stack per lance
    if (eaten) this.removeAura(u, eaten, 'consumed');
    if (def.cpSpend) u.cp = 0;
    if (def.cpGain) u.cp = Math.min(5 + this.modsOf(u).maxCp, u.cp + def.cpGain + (abMod?.cpChance && this.rng() < abMod.cpChance ? 1 : 0));
    this.cpSpent = 0;
    this.rageMult = 1;
    this.empowerMult = 1;
    this.stackMult = 1;
    this.ground = null;

    if (isMelee(def) && !def.stopsAuto && autoFor(u.classId, u.spec) && !u.autoDisabled) {
      if (!u.autoAttack) u.autoSince = this.time;
      u.autoAttack = true;
    }
    if (!def.keepsStealth && this.isStealthed(u)) this.breakStealth(u);
  }

  private applyEffect(u: Unit, def: AbilityDef, t: Unit, eff: AbilityDef['effects'][number]): void {
    const only = (eff as { only?: 'ally' | 'enemy' }).only;
    if ((only === 'enemy' && t.team === u.team) || (only === 'ally' && t.team !== u.team)) return;
    switch (eff.type) {
      case 'proc':
        // one roll for the whole group of effects
        if (this.rng() < eff.p) for (const e of eff.effects) this.applyEffect(u, def, t, e);
        break;
      case 'cast': {
        // everything another ability does, free (a Frost Nova where Blink began, a Hamstring on a strike)
        const nd = ABILITIES[eff.ability];
        if (!nd) break;
        for (const tt of this.targetsOf(u, nd, t)) for (const e of nd.effects) this.applyEffect(u, nd, tt, e);
        break;
      }
      case 'strip':
        for (const a of [...t.auras]) if (eff.kinds.includes(a.kind)) this.removeAura(t, a, 'stripped');
        break;
      case 'dropTargets':
        for (const e of this.units.values()) if (e.team !== u.team) this.loseTarget(e, u);
        break;
      case 'zoneBuff':
        this.zones.push({
          id: this.nextZoneId++, owner: u.id, team: u.team, x: this.ground?.x ?? u.pos.x, z: this.ground?.z ?? u.pos.z, r: eff.radius, school: def.school, ability: def.id, amount: 0,
          start: this.time, firstAt: this.time + eff.duration + 1, nextAt: Infinity, pulse: eff.duration, end: this.time + eff.duration, buff: { aura: eff.aura, who: eff.who }, h: this.ground ? this.zoneFloor(u) : heightAt(this.arena, u.pos.x, u.pos.z, u.level),
        });
        break;
      case 'damage':
        if (eff.only === 'enemy' && t.team === u.team) break;
        if (eff.only === 'ally' && t.team !== u.team) break;
        this.dealDamage(u, t, eff.amount * u.gearMult * this.variance() * this.modsOf(u).damageDone * (this.modsOf(u).ability[def.id]?.damage ?? 1) * (def.cpScale ? Math.max(1, this.cpSpent) * this.modsOf(u).cpPower : 1) * (def.behindMult && this.isBehind(u, t) ? def.behindMult : 1) * this.rageMult * this.empowerMult * this.stackMult * this.vulnMult(t, def), def.school, def.id);
        break;
      case 'healMax':
        this.heal(u, u, u.maxHealth * eff.pct, def.id);
        break;
      case 'leap': {
        const g = this.ground;
        if (!g) break;
        const fromX = u.pos.x, fromZ = u.pos.z;
        // aimed on top of a walkway (the deck or a ramp): land up there; else on the ground
        const toLv: 0 | 1 = g.lv === 1 && onRaised(this.arena, g.x, g.z) ? 1 : 0;
        const to = resolveCollisions({ x: g.x, z: g.z }, this.arena, toLv);
        const dur = 450 + dist({ x: fromX, z: fromZ }, to) * 15;
        u.leap = { fromX, fromZ, toX: to.x, toZ: to.z, start: this.time, dur, damage: eff.damage ?? 0, radius: eff.radius ?? 5, fromH: heightAt(this.arena, fromX, fromZ, u.level), toH: heightAt(this.arena, to.x, to.z, toLv), toLv };
        if (u.cast) this.cancelCast(u, 'leapt');
        this.emit({ t: 'leap', unit: u.id, fromX, fromZ, x: to.x, z: to.z });
        break;
      }
      case 'pull': {
        if (t === u || (eff.ally ? t.team !== u.team : t.team === u.team)) break;
        const dx = t.pos.x - u.pos.x, dz = t.pos.z - u.pos.z;
        const d = Math.hypot(dx, dz);
        if (d <= eff.stopDistance + 1e-6) break;
        if (this.unstoppable(t)) break; // a Bladestorming warrior cannot be dragged
        t.pos = resolveCollisions({ x: u.pos.x + (dx / d) * eff.stopDistance, z: u.pos.z + (dz / d) * eff.stopDistance }, this.arena, t.level);
        this.settleLevel(t); // pulled off the deck: on the ground now
        if (t.cast) this.cancelCast(t, 'pulled');
        break;
      }
      case 'flag':
        this.zones.push({
          id: this.nextZoneId++, owner: u.id, team: u.team, x: this.ground?.x ?? u.pos.x, z: this.ground?.z ?? u.pos.z, r: eff.radius, school: def.school, ability: def.id, amount: 0,
          start: this.time, firstAt: this.time + eff.duration + 1, nextAt: Infinity, pulse: eff.duration, end: this.time + eff.duration, flag: true, held: new Set(), h: this.zoneFloor(u),
        });
        break;
      case 'healMissing':
        { const keep = u.lastCombatAt; this.heal(u, t, (t.maxHealth - t.health) * eff.pct, def.id); u.lastCombatAt = keep; } // a self-heal on Vanish must not put you back in combat
        break;
      case 'heal':
        if (eff.only === 'enemy' && t.team === u.team) break;
        if (eff.only === 'ally' && t.team !== u.team) break;
      {
        const healed = this.heal(u, t, eff.amount * u.gearMult * this.variance() * this.modsOf(u).healingDone * (this.modsOf(u).ability[def.id]?.heal ?? 1) * this.healSpam(u, def), def.id);
        const echo = this.abilityMod(u, def).echo;
        if (echo && healed > 0) {
          // the same heal arrives on the other side of the pair: your ally if you healed yourself, you if you healed an ally
          let other: Unit | undefined = t === u ? undefined : u;
          if (t === u) for (const v of this.units.values()) if (v !== u && v.alive && v.team === u.team && v.health < v.maxHealth && this.gap(u, v.pos, v.level) <= this.rangeOf(u, def) && this.sees(u, v) && (!other || v.health / v.maxHealth < other.health / other.maxHealth)) other = v;
          if (other) this.heal(u, other, healed * echo, def.id);
        }
        break;
      }
      case 'aura':
        if (eff.fullCast && this.procCast) break; // an instant proc cast does not earn the next proc
        if (eff.chance !== undefined && this.rng() >= eff.chance) break;
        {
          const r = this.applyAura(u, eff.self ? u : t, this.abilityMod(u, def).swapAura?.[eff.aura] ?? eff.aura, (eff.extraPerCp ?? 0) * this.cpSpent * this.modsOf(u).cpPower, eff.duration);
          if (def.stopsAuto && r.applied && t.team !== u.team) u.autoAttack = false;
        }
        break;
      case 'exsanguinate': {
        let bleed = 0;
        for (const a of t.auras) {
          const d = AURAS[a.id];
          if (!d?.bleed || !d.dot) continue;
          bleed += d.dot.amount * (a.dotMult ?? 1) * Math.max(0, Math.ceil((a.expiresAt - this.time) / d.dot.interval));
          a.dotMult = Math.max(a.dotMult ?? 1, eff.bleedMult); // sets bleeds to x3; using it again does not compound (x9, x27)
        }
        this.dealDamage(u, t, (eff.perCp * Math.max(1, this.cpSpent) * this.modsOf(u).cpPower + bleed * eff.bleedFraction) * u.gearMult * this.modsOf(u).damageDone * (this.modsOf(u).ability[def.id]?.damage ?? 1), def.school, def.id);
        break;
      }
      case 'interrupt':
        this.interrupt(u, t, def, eff.lockout);
        break;
      case 'dispel': {
        if (eff.all) {
          // every harmful magic effect on an ally comes off (Purifying Light)
          for (const x of [...t.auras]) if (AURAS[x.id].dispellable && AURAS[x.id].harmful === (u.team === t.team)) { this.removeAura(t, x, 'dispelled'); this.emit({ t: 'dispel', src: u.id, tgt: t.id, aura: x.id }); }
          break;
        }
        const a = this.dispelCandidate(u, t);
        if (a) {
          this.removeAura(t, a, 'dispelled');
          this.emit({ t: 'dispel', src: u.id, tgt: t.id, aura: a.id });
        }
        break;
      }
      case 'charge': {
        if (t === u) break; // Intercept on yourself stays where you stand
        if (u.cast) this.cancelCast(u, 'moved');
        u.charge = { target: t.id, stop: eff.stopDistance, speed: eff.speed, until: this.time + 2000, hit: eff.hit ?? 0 };
        break;
      }
      case 'dashToTarget': {
        const dx = t.pos.x - u.pos.x;
        const dz = t.pos.z - u.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 1e-6) {
          const travel = Math.max(0, d - eff.stopDistance);
          // a step through the shadows lands at the target's level (up on a walkway or down on the ground)
          let land = resolveCollisions({ x: u.pos.x + (dx / d) * travel, z: u.pos.z + (dz / d) * travel }, this.arena, t.level);
          // up on a walkway, a landing spot past the edge of the deck is no good: you would hang in the air marked as up there
          const onFloor = (p: Vec2) => t.level === 0 || onRaised(this.arena, p.x, p.z);
          if (!onFloor(land)) land = { x: t.pos.x, z: t.pos.z };
          if (eff.behind) {
            const back = resolveCollisions({ x: t.pos.x - Math.sin(t.facing) * eff.stopDistance, z: t.pos.z - Math.cos(t.facing) * eff.stopDistance }, this.arena, t.level);
            if (onFloor(back) && hasLOS(back, t.pos, this.arena, t.level, t.level)) land = back;
          }
          u.level = t.level;
          u.pos = land;
          u.facing = Math.atan2(t.pos.x - land.x, t.pos.z - land.z);
          u.lastInput = { ...u.lastInput, facing: u.facing };
          this.emit({ t: 'turn', unit: u.id, facing: u.facing });
        }
        break;
      }
      case 'freeMove':
        for (const a of [...u.auras]) if (a.kind === 'root' || a.kind === 'slow') this.removeAura(u, a, 'freed');
        break;
      case 'blink':
        this.place(u, blinkDestination(u.pos, u.facing, eff.distance, this.arena, u.level));
        // blinking out breaks you free of stuns, roots and slows
        for (const a of [...u.auras]) if (a.kind === 'stun' || a.kind === 'root' || a.kind === 'slow') this.removeAura(u, a, 'blinked');
        break;
      case 'zone':
        this.zones.push({
          id: this.nextZoneId++, owner: u.id, team: u.team, x: this.ground?.x ?? t.pos.x, z: this.ground?.z ?? t.pos.z, r: eff.radius, school: def.school, ability: def.id, amount: eff.amount,
          start: this.time, firstAt: this.time + (eff.delay ?? 800), nextAt: this.time + (eff.delay ?? 800), pulse: eff.pulse, end: this.time + eff.duration, h: this.ground ? this.zoneFloor(u) : heightAt(this.arena, t.pos.x, t.pos.z, t.level),
        });
        if (eff.initial) {
          // the cast landing: everything standing in the area takes one big hit at once (the pulses that follow are the smaller ones)
          const zx = this.ground?.x ?? t.pos.x;
          const zz = this.ground?.z ?? t.pos.z;
          const m = this.modsOf(u);
          let struck = 0;
          const zone = this.zones[this.zones.length - 1];
          for (const v of [...this.units.values()]) {
            if (!v.alive || v.team === u.team || Math.hypot(v.pos.x - zx, v.pos.z - zz) > eff.radius || !this.onZoneFloor(v, zone)) continue;
            struck++;
            this.dealDamage(u, v, eff.initial * u.gearMult * this.variance() * m.damageDone * (m.ability[def.id]?.damage ?? 1), def.school, def.id);
          }
          if (struck > 0 && eff.procOnHit) this.applyAura(u, u, eff.procOnHit);
        }
        break;
      case 'cleanse':
        for (const a of [...u.auras]) if (AURAS[a.id].harmful) this.removeAura(u, a, 'cleansed');
        break;
      case 'dropCombat':
        u.lastCombatAt = -1e9;
        u.autoAttack = false;
        for (const e of this.units.values()) if (e.team !== u.team) this.loseTarget(e, u);
        break;
      case 'smoke':
        this.zones.push({
          id: this.nextZoneId++, owner: u.id, team: u.team, x: u.pos.x, z: u.pos.z, r: eff.radius, school: def.school, ability: def.id, amount: 0,
          start: this.time, firstAt: this.time + eff.duration + 1, nextAt: Infinity, pulse: eff.duration, end: this.time + eff.duration, smoke: true, h: heightAt(this.arena, u.pos.x, u.pos.z, u.level),
        });
        break;
      case 'gain':
        u.resource = Math.min(u.resourceMax, u.resource + eff.amount * (this.modsOf(u).ability[def.id]?.gain ?? 1) * this.modsOf(u).rage);
        break;
    }
  }

  /** `e` can no longer see `u`: its target, swing, cast and charge at `u` stop. */
  private loseTarget(e: Unit, u: Unit): void {
    if (e.target === u.id) {
      e.target = null;
      e.autoAttack = false;
    }
    if (e.cast && e.cast.target === u.id && ABILITIES[e.cast.ability]?.target !== 'ground') this.cancelCast(e, 'target vanished');
    if (e.charge?.target === u.id) this.endCharge(e, false); // a charge on its way in loses its mark too
  }

  private interrupt(src: Unit, t: Unit, def: AbilityDef, lockout: number): void {
    // a cast that finished a moment before the button reached the server still gets locked out (lag must not make Counterspell miss)
    const late = !t.cast && t.lastCast && this.time - t.lastCast.at <= INTERRUPT_GRACE_MS ? t.lastCast : null;
    if (!t.cast && !late) {
      this.emit({ t: 'miss', src: src.id, tgt: t.id, ability: def.id }); // nothing to interrupt: the spell whiffs and is still spent
      return;
    }
    const live = !!t.cast;
    const cast = ABILITIES[(t.cast?.ability ?? late!.ability)];
    if (cast.unstoppable && live) {
      this.emit({ t: 'immune', src: src.id, tgt: t.id, aura: def.id }); // Bladestorm cannot be kicked
      return;
    }
    t.cast = null;
    t.lastCast = null;
    if (cast.school === 'physical') {
      // a physical channel (a warrior's spin) is not a spell school: only that ability is locked, not every physical skill
      t.cooldowns[cast.id] = Math.max(t.cooldowns[cast.id] ?? 0, this.time + lockout);
    } else t.lockouts[cast.school] = this.time + lockout;
    src.lastCombatAt = this.time;
    t.lastCombatAt = this.time;
    this.emit({ t: 'interrupt', src: src.id, tgt: t.id, ability: cast.id, school: cast.school, lockout });
    if (live) this.failCast(t, cast.id, 'interrupted');
  }

  // ------------------------------------------------------------------ damage / healing

  private variance(): number {
    return 1 + (this.rng() * 2 - 1) * TUNING.damageVariance;
  }

  /** Returns damage that actually reached health (after absorbs). */
  dealDamage(src: Unit | null, tgt: Unit, raw: number, school: School, ability: string | null, periodic = false): number {
    if (!tgt.alive) return 0;
    if (tgt.auras.some((a) => AURAS[a.id]?.invulnerable)) return 0; // Ascend to the Heavens: nothing touches you
    const decoy = !periodic && ability !== null && src && src.team !== tgt.team ? tgt.auras.find((a) => AURAS[a.id]?.decoys) : undefined;
    if (decoy && this.rng() < AURAS[decoy.id].decoys!) {
      this.emit({ t: 'miss', src: src!.id, tgt: tgt.id, ability: ability! }); // it struck an image
      return 0;
    }
    let remaining = Math.max(0, Math.round(raw * this.modsOf(tgt).damageTaken));
    let absorbed = 0;
    for (const a of [...tgt.auras]) {
      if (a.kind !== 'absorb' || remaining <= 0) continue;
      const take = Math.min(a.absorbLeft, remaining);
      a.absorbLeft -= take;
      remaining -= take;
      absorbed += take;
      if (a.absorbLeft <= 0) this.removeAura(tgt, a, 'consumed');
    }
    if (remaining >= tgt.health && tgt.alive && this.canCauterize(tgt)) {
      // Cauterize: a killing blow leaves you at 35% health instead (once per cooldown)
      tgt.cooldowns['cauterize'] = this.time + TUNING.cauterizeCooldownMs;
      const before = tgt.health;
      tgt.health = Math.round(tgt.maxHealth * TUNING.cauterizeHealth);
      this.emit({ t: 'heal', src: tgt.id, tgt: tgt.id, amount: Math.max(0, tgt.health - before), overheal: 0, ability: 'cauterize' });
      remaining = 0;
      this.applyAura(tgt, tgt, 'cauterized');
    }
    tgt.health = Math.max(0, tgt.health - remaining);
    tgt.lastCombatAt = this.time;
    if (src) src.lastCombatAt = this.time;
    this.emit({ t: 'damage', src: src?.id ?? 0, tgt: tgt.id, amount: remaining, absorbed, ability, school });

    // a rage spender (Mortal Strike, Execute...) does not refund rage off its own hit
    const spender = ability !== null && !!ABILITIES[ability]?.cost && src?.resourceType === 'rage';
    if (src?.resourceType === 'rage' && !spender) src.resource = Math.min(src.resourceMax, src.resource + remaining * TUNING.rageFromDealt * this.modsOf(src).rage);
    if (tgt.resourceType === 'rage') tgt.resource = Math.min(tgt.resourceMax, tgt.resource + remaining * TUNING.rageFromTaken * this.modsOf(tgt).rage);

    const steal = src && src.alive ? this.modsOf(src).lifesteal : 0;
    if (steal > 0 && remaining > 0) this.heal(src!, src!, remaining * steal, 'enraged_regeneration');

    if (remaining + absorbed > 0) {
      if (tgt.charge && !periodic) this.endCharge(tgt, false); // a direct hit stops a charge (a damage-over-time tick does not)
      const soft = periodic || (ability !== null && ABILITIES[ability]?.noBreak === true);
      for (const a of [...tgt.auras]) if (AURAS[a.id].breaksOnDamage && !(soft && a.kind === 'fear') && !(AURAS[a.id].heldBy && tgt.auras.some((x) => x.id === AURAS[a.id].heldBy))) this.removeAura(tgt, a, 'damage'); // damage-over-time ticks do not break fear
      if (this.isStealthed(tgt)) this.breakStealth(tgt);
    }
    if (tgt.health <= 0) this.die(tgt, src?.id ?? null);
    return remaining;
  }

  /** The floor a ground spell lands on: the top of a walkway when aimed there, else the ground (no aim: the caster's floor). */
  private zoneFloor(u: Unit): number {
    const g = this.ground;
    if (!g) return heightAt(this.arena, u.pos.x, u.pos.z, u.level);
    return g.lv === 1 ? heightAt(this.arena, g.x, g.z, 1) : 0;
  }
  /** Is a unit on the same floor as a zone (a zone on the deck does not reach the ground below, and the other way round)? */
  private onZoneFloor(v: Unit, z: { h: number }): boolean {
    return Math.abs(heightAt(this.arena, v.pos.x, v.pos.z, v.level) - z.h) <= 1.6;
  }
  /** Ground zones that hurt `team`'s units (Flamestrike and the like), for bots to step out of. */
  hazardsFor(team: TeamId): { x: number; z: number; r: number; id: number; firstAt: number }[] {
    return this.zones.filter((z) => z.team !== team && z.amount > 0 && !z.smoke && !z.flag && this.time < z.end).map((z) => ({ x: z.x, z: z.z, r: z.r, id: z.id, firstAt: z.firstAt }));
  }

  /** Put a unit at a raw position: settles its walkway level, then pushes it out of anything solid at that level. */
  private place(u: Unit, raw: { x: number; z: number }, air = 0): void {
    // in short steps, so a fast move (a charge, a fear run) cannot pass through a thin rail or barricade in one tick
    let pos = u.pos;
    let lv = u.level;
    const total = dist(pos, raw);
    const n = Math.max(1, Math.ceil(total / 0.4));
    for (let i = 0; i < n; i++) {
      const dx = raw.x - pos.x;
      const dz = raw.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-6) break;
      const k = Math.min(1, total / n / d);
      const r = moveTo(this.arena, lv, pos, { x: pos.x + dx * k, z: pos.z + dz * k }, air);
      const moved = dist(r.pos, pos);
      pos = r.pos;
      lv = r.level;
      if (moved < 1e-4) break;
    }
    u.pos = pos;
    u.level = lv;
  }

  /** Line of sight between two units, which also respects walkway levels. */
  private sees(a: Unit, b: Unit): boolean {
    // a jump lifts the sight line: over a low barricade for a moment
    return hasLOS(a.pos, b.pos, this.arena, a.level, b.level, this.airOf(a), this.airOf(b));
  }

  /** How high a unit is in a jump right now (0 on its feet). */
  airOf(u: Unit): number {
    return jumpHeight(this.time - u.jumpStart);
  }

  private canCauterize(u: Unit): boolean {
    if (!u.spec || (u.cooldowns['cauterize'] ?? 0) > this.time) return false;
    return SPECS[u.classId]?.find((s) => s.id === u.spec)?.passive === 'cauterize';
  }

  /**
   * Heal spam: pressing the same heal again and again weakens it (each repeat in a row is `healSpamStep` weaker, down to
   * `healSpamFloor`), while casting anything else in between (another heal or any other skill) keeps each heal at full strength. A pause longer than
   * `healSpamWindowMs` starts fresh. One cast (several targets, an echo) counts once.
   */
  /** Any cast other than the heal being chained starts the heal-spam count again. */
  private breakHealChain(u: Unit, abilityId: string): void {
    if (u.lastHeal && u.lastHeal.ability !== abilityId) u.lastHeal = undefined;
  }

  private healSpam(u: Unit, def: { id: string }): number {
    const st = u.lastHeal;
    if (st && st.ability === def.id && st.at === this.time) return st.mult;
    const chained = !!st && st.ability === def.id && this.time - st.at <= TUNING.healSpamWindowMs;
    const stacks = chained ? st!.stacks + 1 : 0;
    const mult = Math.max(TUNING.healSpamFloor, 1 - stacks * TUNING.healSpamStep);
    u.lastHeal = { ability: def.id, stacks, at: this.time, mult };
    return mult;
  }

  heal(src: Unit, tgt: Unit, raw: number, ability: string): number {
    if (!tgt.alive) return 0;
    const want = Math.max(0, Math.round(raw * this.modsOf(tgt).healingTaken));
    const amount = Math.min(want, tgt.maxHealth - tgt.health);
    tgt.health += amount;
    src.lastCombatAt = this.time;
    this.emit({ t: 'heal', src: src.id, tgt: tgt.id, amount, overheal: want - amount, ability });
    const share = this.modsOf(src).ability[ability]?.shieldPct;
    if (share && amount > 0) this.addBarrier(src, tgt, Math.round(amount * share));
    return amount;
  }

  /** Adds to the target's barrier from `src` (Penance's healing also shields), starting one if it has none. */
  private addBarrier(src: Unit, tgt: Unit, amount: number): void {
    let b = tgt.auras.find((a) => a.id === 'penance_barrier' && a.sourceId === src.id);
    if (!b) {
      this.applyAura(src, tgt, 'penance_barrier');
      b = tgt.auras.find((a) => a.id === 'penance_barrier' && a.sourceId === src.id);
      if (b) b.absorbLeft = 0;
    }
    if (!b) return;
    b.absorbLeft += amount;
    b.expiresAt = this.time + AURAS.penance_barrier.duration;
  }

  /** The owner removes a unit from the match (admin panel): it dies at once, no kill credit. */
  adminKill(unitId: number): boolean {
    const u = this.units.get(unitId);
    if (!u || !u.alive) return false;
    this.die(u, null);
    return true;
  }

  private die(u: Unit, killer: number | null): void {
    u.alive = false;
    u.health = 0;
    u.cast = null;
    this.endCharge(u, false);
    u.auras = [];
    u.autoAttack = false;
    if (u.controller === 'dummy') u.respawnAt = this.time + 2500;
    this.emit({ t: 'death', unit: u.id, killer });
  }

  /** A charge ends: the target's stun is lifted, and on a landing the warrior hits it. */
  private endCharge(u: Unit, landed: boolean): void {
    const ch = u.charge;
    if (!ch) return;
    u.charge = null;
    const t = this.units.get(ch.target);
    if (!t) return;
    const stun = t.auras.find((a) => a.id === 'charge_stun' && a.sourceId === u.id);
    if (stun) this.removeAura(t, stun, 'charge ended');
    if (landed && t.alive) for (const eff of this.modsOf(u).ability['charge']?.landing ?? []) this.applyEffect(u, ABILITIES['charge'], t, eff); // (Charge's root after arriving)
    if (landed && t.alive && ch.hit > 0) {
      this.dealDamage(u, t, ch.hit * u.gearMult * this.variance() * this.modsOf(u).damageDone * (this.modsOf(u).ability['charge']?.damage ?? 1), 'physical', 'charge');
    }
  }

  private tryAutoAttack(u: Unit): void {
    const auto = autoFor(u.classId, u.spec);
    if (!auto || !u.autoAttack || this.phase !== 'live' || !this.canAct(u) || u.cast) return;
    const t = u.target !== null ? this.units.get(u.target) : undefined;
    if (!t || !t.alive || t.team === u.team || !this.canSee(u, t)) return;
    // auto-attack is held while stealthed, unless the target is right next to you: then the swing lands and breaks stealth
    if (this.isStealthed(u) && dist(u.pos, t.pos) > TUNING.stealthDetect) return;
    if (this.gap(u, t.pos, t.level) > auto.range + TUNING.autoTolerance || this.time < u.nextSwing) return;
    if (this.floorsApart(u, t.pos, t.level)) return; // on top of a walkway and under it (or below its edge): out of reach
    if (!this.sees(u, t)) return; // no swinging through pillars
    if (!this.inFront(u, t.pos.x, t.pos.z)) return; // and no swinging at what is behind you
    u.nextSwing = this.time + auto.interval * this.modsOf(u).autoSpeed;
    if (this.isStealthed(u)) this.breakStealth(u);
    this.dealDamage(u, t, auto.damage * u.gearMult * this.variance() * this.modsOf(u).damageDone, 'physical', null);
  }

  // ------------------------------------------------------------------ auras, crowd control, diminishing returns

  applyAura(src: Unit, tgt: Unit, auraId: string, extraMs = 0, baseMs?: number): AuraResult {
    const def = AURAS[auraId];
    if (!def || !tgt.alive) return { applied: false, immune: true };

    // Purifying Light and Ascend keep new harmful effects off (and a beneficial effect from the enemy is not a thing)
    if (def.harmful && src !== tgt && tgt.auras.some((a) => AURAS[a.id]?.blocksDebuffs || AURAS[a.id]?.invulnerable)) {
      this.emit({ t: 'immune', src: src.id, tgt: tgt.id, aura: auraId });
      return { applied: false, immune: true };
    }

    // while Bladestorming a warrior shrugs off anything that would stop it or slow it down
    if (def.harmful && src.team !== tgt.team && UNSTOPPABLE_KINDS.includes(def.kind) && this.unstoppable(tgt)) {
      this.emit({ t: 'immune', src: src.id, tgt: tgt.id, aura: auraId });
      return { applied: false, immune: true };
    }
    // combo-point time is part of the stun, so diminishing returns shorten all of it; some stuns have a ceiling
    const base = Math.min((baseMs ?? def.duration) + (def.duration > 0 ? extraMs : 0), def.maxDuration ?? Infinity);
    let duration = def.duration;
    let drMult = 1;
    // a channel that applies crowd control every tick (Slice and Dice) is one diminishing-returns step for the whole cast:
    // the first tick sets the level and counts, every later tick of the same cast gets that same full level
    const chanKey = this.channelOf && def.dr ? `${this.channelOf.unit}:${this.channelOf.start}:${tgt.id}:${auraId}` : null;
    const chanMult = chanKey ? this.channelDr.get(chanKey) : undefined;
    // and the channel's hold is diminished as one block: at full returns the target is held for the whole channel (each tick
    // stuns past the next one, so there is no gap to walk or swing in); at half it is held for the first half, then free
    const holdLeft = (mult: number) => this.channelOf ? this.channelOf.start + (this.channelOf.end - this.channelOf.start + 100) * mult - this.time : Infinity;
    if (def.dr && chanMult !== undefined) {
      drMult = chanMult;
      const left = holdLeft(drMult);
      if (drMult === 0 || left <= 0) {
        if (drMult === 0) this.emit({ t: 'immune', src: src.id, tgt: tgt.id, aura: auraId });
        return { applied: false, immune: true };
      }
      duration = Math.min(base * (this.modsOf(src).auraDuration[auraId] ?? 1), left);
      const st = (tgt.dr[def.dr] ??= { count: 0, resetAt: 0 });
      st.resetAt = Math.max(st.resetAt, this.time + duration + TUNING.drResetMs);
    } else if (def.dr) {
      const st = (tgt.dr[def.dr] ??= { count: 0, resetAt: 0 });
      if (this.time >= st.resetAt) st.count = 0;
      drMult = TUNING.drSteps[Math.min(st.count, TUNING.drSteps.length - 1)];
      if (chanKey) {
        if (this.channelDr.size > 64) this.channelDr.clear();
        this.channelDr.set(chanKey, drMult);
      }
      if (drMult === 0) {
        this.emit({ t: 'immune', src: src.id, tgt: tgt.id, aura: auraId });
        return { applied: false, immune: true };
      }
      duration = chanKey ? Math.min(base * (this.modsOf(src).auraDuration[auraId] ?? 1), holdLeft(drMult)) : base * drMult * (this.modsOf(src).auraDuration[auraId] ?? 1);
      st.count++;
      st.resetAt = this.time + duration + TUNING.drResetMs;
    } else duration = base * (this.modsOf(src).auraDuration[auraId] ?? 1);

    const prior = tgt.auras.find((a) => a.id === auraId && a.sourceId === src.id);
    const extend = this.modsOf(src).auraExtend[auraId];
    if (prior && extend && def.duration > 0) duration = Math.min(def.duration * 4, Math.max(0, prior.expiresAt - this.time) + extend);
    tgt.auras = tgt.auras.filter((a) => !(a.id === auraId && a.sourceId === src.id));
    if (def.unique) {
      for (const v of this.units.values()) {
        if (v === tgt) continue;
        for (const a of [...v.auras]) if (a.id === auraId && a.sourceId === src.id) this.removeAura(v, a, 'replaced');
      }
    }
    const inst: AuraInst = {
      id: auraId, kind: def.kind, sourceId: src.id,
      expiresAt: def.duration > 0 ? this.time + duration : Infinity,
      absorbLeft: Math.round(((def.absorb ?? 0) + (def.absorbPct ?? 0) * tgt.maxHealth) * src.gearMult * this.modsOf(src).healingDone),
      ...(def.maxStacks ? { stacks: Math.min(def.maxStacks, (prior?.stacks ?? 0) + 1) } : {}),
      ...(def.dot ? { nextTick: this.time + def.dot.interval } : def.hot ? { nextTick: this.time + def.hot.interval } : {}),
    };
    tgt.auras.push(inst);
    if (def.resetsCooldown) {
      // (a proc that hands out a free Devouring Plague also takes it off cooldown)
      tgt.cooldowns[def.resetsCooldown] = 0;
      tgt.chargesUsed[def.resetsCooldown] = 0;
      const per = this.recharge.get(tgt.id);
      if (per) delete per[def.resetsCooldown];
    }

    if (def.harmful && src.team !== tgt.team) {
      src.lastCombatAt = this.time;
      tgt.lastCombatAt = this.time;
    }
    if (CC_KINDS.includes(def.kind)) {
      if (tgt.cast) this.cancelCast(tgt, 'crowd controlled');
      if (def.kind === 'fear') tgt.fearRetargetAt = 0;
    }
    this.emit({ t: 'aura', src: src.id, tgt: tgt.id, aura: auraId, expiresAt: isFinite(inst.expiresAt) ? inst.expiresAt : 0, dr: drMult });
    return { applied: true, duration, dr: drMult };
  }

  removeAura(u: Unit, a: AuraInst, reason: string): void {
    if (!u.auras.includes(a)) return;
    u.auras = u.auras.filter((x) => x !== a);
    const def = AURAS[a.id];
    if (def.dr) {
      const st = u.dr[def.dr];
      if (st) st.resetAt = this.time + TUNING.drResetMs; // DR window starts when the CC ends
    }
    this.emit({ t: 'aura_removed', tgt: u.id, aura: a.id, reason });
    // Protective Vanish lasts only while you stay hidden
    if (a.kind === 'stealth') for (const x of u.auras) if (x.id === 'protective_vanish') this.removeAura(u, x, 'left stealth');
  }

  /** Allies lose a harmful magic aura; enemies lose a beneficial magic aura. Crowd control goes first. */
  private dispelCandidate(src: Unit, tgt: Unit): AuraInst | undefined {
    const friendly = src.team === tgt.team;
    const order: AuraKind[] = ['incapacitate', 'fear', 'stun', 'root', 'slow', 'dot', 'mark', 'absorb', 'buff', 'speed'];
    const rank = (k: AuraKind) => { const i = order.indexOf(k); return i < 0 ? order.length : i; }; // anything unlisted goes last, never first
    return tgt.auras
      .filter((a) => AURAS[a.id].dispellable && AURAS[a.id].harmful === friendly)
      .sort((a, b) => rank(a.kind) - rank(b.kind))[0];
  }

  /** Base build modifiers combined with any active buff auras. */
  modsOf(u: Unit): Mods {
    return u.auras.length ? withAuraMods(u.mods, u.auras.map((a) => a.id)) : u.mods;
  }
  private abilityMod(u: Unit, def: AbilityDef): AbilityMod {
    return this.modsOf(u).ability[def.id] ?? {};
  }
  private rangeOf(u: Unit, def: AbilityDef): number {
    return def.range + (this.abilityMod(u, def).range ?? 0);
  }
  /** Range is measured in 3D: up on a walkway you are out of melee reach of someone on the ground below. */
  private gap(u: Unit, p: Vec2, level: 0 | 1): number {
    const dh = heightAt(this.arena, u.pos.x, u.pos.z, u.level) - heightAt(this.arena, p.x, p.z, level);
    return Math.hypot(dist(u.pos, p), dh);
  }
  /** Standing on different floors: a walkway's top and the ground below it (ramps in between are reachable). */
  private floorsApart(u: Unit, p: Vec2, level: 0 | 1): boolean {
    return Math.abs(heightAt(this.arena, u.pos.x, u.pos.z, u.level) - heightAt(this.arena, p.x, p.z, level)) > MELEE_FLOOR_GAP;
  }
  /** Furthest distance an ability can still land from: its range plus a small lag allowance (smaller for melee). */
  private reachOf(u: Unit, def: AbilityDef): number {
    return this.rangeOf(u, def) + (isMelee(def) ? TUNING.autoTolerance : TUNING.rangeTolerance);
  }
  private castTimeOf(u: Unit, def: AbilityDef): number {
    const m = this.modsOf(u);
    return Math.max(250, Math.round(def.castTime * m.castTime * (m.ability[def.id]?.castTime ?? 1)));
  }
  private gcdOf(u: Unit): number {
    return Math.max(750, Math.round(TUNING.gcdMs * this.modsOf(u).gcd));
  }

  hasAura(u: Unit, kinds: AuraKind[]): boolean {
    return u.auras.some((a) => kinds.includes(a.kind));
  }
  isStealthed(u: Unit): boolean {
    return u.auras.some((a) => a.kind === 'stealth');
  }
  private breakStealth(u: Unit): void {
    const a = u.auras.find((x) => x.kind === 'stealth');
    if (a) this.removeAura(u, a, 'broken');
  }
  canAct(u: Unit): boolean {
    return !this.hasAura(u, CC_KINDS);
  }
  canMove(u: Unit): boolean {
    return this.canAct(u) && !this.hasAura(u, ['root']);
  }
  speedMult(u: Unit): number {
    if (!this.canMove(u)) return 0;
    let slow = 1;
    let boost = 0;
    for (const a of u.auras) {
      const d = AURAS[a.id];
      if (d.kind === 'slow') slow = Math.min(slow, 1 - (d.slowPct ?? 0) / 100);
      else if (d.kind === 'speed' || d.kind === 'stealth') boost += (d.speedPct ?? 0) / 100;
    }
    return Math.max(0, (1 + boost) * slow * this.modsOf(u).moveSpeed);
  }

  // ------------------------------------------------------------------ targeting & visibility

  /** Stealthed enemies are only visible up close (measured in 3D: a rogue on the deck above you is not "close"). */
  canSee(viewer: Unit, other: Unit): boolean {
    if (viewer.team === other.team) return true;
    if (other.auras.some((a) => AURAS[a.id]?.untargetable)) return false;
    if (this.smokeHides(viewer, other)) return false;
    if (!this.isStealthed(other)) return true;
    return this.gap(viewer, other.pos, other.level) <= TUNING.stealthDetect;
  }

  /**
   * Smoke Bomb is a wall of sight: enemies both inside the same cloud see and fight each other as usual, but nobody
   * outside a cloud can see an enemy inside it, and nobody inside can see an enemy outside it.
   */
  smokeHides(viewer: Unit, other: Unit): boolean {
    if (viewer.team === other.team || !this.zones.length) return false;
    const inCloud = (u: Unit, z: (typeof this.zones)[number]) => Math.hypot(u.pos.x - z.x, u.pos.z - z.z) <= z.r && this.onZoneFloor(u, z);
    return this.zones.some((z) => z.smoke && this.time < z.end && inCloud(viewer, z) !== inCloud(other, z));
  }

  /** Enemy units that `team` cannot see right now: stealthed, and no living member of the team is close enough to spot them. */
  hiddenFrom(team: TeamId): Set<number> {
    const out = new Set<number>();
    const all = [...this.units.values()];
    for (const u of all) {
      if (u.team === team || !this.isStealthed(u)) continue;
      if (!all.some((v) => v.team === team && v.alive && this.gap(v, u.pos, u.level) <= TUNING.stealthDetect)) out.add(u.id);
    }
    return out;
  }

  /**
   * The events `team` may see: anything a hidden enemy did (casts, buffs, turning) is left out unless it touched the team,
   * so a stealthed rogue's actions do not give away where or what it is.
   */
  eventsFor(team: TeamId, events: SimEvent[], hidden = this.hiddenFrom(team)): SimEvent[] {
    if (!hidden.size) return events;
    const ours = (id: number | null | undefined) => id !== null && id !== undefined && this.units.get(id)?.team === team;
    return events.filter((e) => {
      const ids: (number | null)[] = 'unit' in e ? [e.unit, 'target' in e ? e.target : null] : 'src' in e ? [e.src, e.tgt] : 'tgt' in e ? [e.tgt] : [];
      if (!ids.some((id) => id !== null && hidden.has(id))) return true;
      return ids.some((id) => ours(id));
    });
  }

  private resolveTarget(u: Unit, def: AbilityDef, targetId?: number | null): Unit | string {
    if (def.target === 'self' || def.target === 'aoe_enemy' || def.target === 'aoe_all' || def.target === 'ground') return u;
    const t = this.units.get(targetId ?? u.target ?? -1);
    switch (def.target) {
      case 'enemy':
        if (!t || (t.team === u.team && !this.abilityMod(u, def).allyOk)) return 'no valid target';
        break;
      case 'ally':
        if (!t || t.team !== u.team) return 'no valid target';
        break;
      case 'ally_or_self':
        return t && t.team === u.team && t.alive ? t : u;
      case 'any':
        return t && t.alive && this.canSee(u, t) ? t : u;
    }
    if (!t || !t.alive) return 'target is dead';
    if (!this.canSee(u, t)) return 'target not visible';
    return t;
  }

  /**
   * Ground effects pulse on a fixed beat (a short telegraph first). Enemies inside the circle take damage, unless they are
   * airborne at that instant: a well-timed jump dodges a pulse. Targeted spells never check this; only zones do.
   */
  /** Is the point inside a `coneDeg`-wide cone in front of the unit (always true when the ability has no cone)? */
  private inCone(u: Unit, p: { x: number; z: number }, coneDeg?: number): boolean {
    if (!coneDeg) return true;
    const dx = p.x - u.pos.x;
    const dz = p.z - u.pos.z;
    if (Math.hypot(dx, dz) < 0.6) return true;
    let d = Math.atan2(dx, dz) - u.facing;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return Math.abs(d) <= (coneDeg * Math.PI) / 360 + 1e-6;
  }

  /** Is the point inside the cone in front of the unit? Bots and anything not player-controlled skip the rule. */
  private inFront(u: Unit, x: number, z: number): boolean {
    if (!this.facingRule || u.controller !== 'player') return true;
    const dx = x - u.pos.x;
    const dz = z - u.pos.z;
    if (Math.hypot(dx, dz) < 0.6) return true;
    let d = Math.atan2(dx, dz) - u.facing;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return Math.abs(d) <= (TUNING.castConeDeg * Math.PI) / 360 + 0.03;
  }

  private tickZones(): void {
    if (!this.zones.length) return;
    for (const v of this.units.values()) {
      if (!v.alive) continue;
      // the smoke's edge cuts sight: a target on the other side of it is lost, and so are the swing and a cast at it
      const t = v.target !== null ? this.units.get(v.target) : undefined;
      if (t && this.smokeHides(v, t)) {
        v.target = null;
        v.autoAttack = false;
        if (v.cast && v.cast.target === t.id) this.cancelCast(v, 'target vanished');
      }
    }
    for (const z of this.zones) {
      if (z.flag) {
        // the banner's wall: an enemy inside the circle stays inside (blinks and dashes included) until it falls or the banner ends
        for (const v of this.units.values()) {
          if (!v.alive || v.team === z.team || !this.onZoneFloor(v, z)) continue;
          const dx = v.pos.x - z.x, dz = v.pos.z - z.z;
          const d = Math.hypot(dx, dz);
          if (d <= z.r) z.held!.add(v.id);
          else if (z.held!.has(v.id)) v.pos = resolveCollisions({ x: z.x + (dx / d) * (z.r - 0.05), z: z.z + (dz / d) * (z.r - 0.05) }, this.arena, v.level);
        }
        continue;
      }
      if (z.buff) {
        // the circle keeps its buff on those standing in it (short buffs, refreshed while they stay)
        const owner = this.units.get(z.owner);
        for (const v of this.units.values()) {
          if (!v.alive || !owner || !this.onZoneFloor(v, z) || Math.hypot(v.pos.x - z.x, v.pos.z - z.z) > z.r) continue;
          if (z.buff.who === 'self' ? v !== owner : v.team !== z.team) continue;
          const have = v.auras.find((a) => a.id === z.buff!.aura && a.sourceId === owner.id);
          if (!have || have.expiresAt - this.time < 400) this.applyAura(owner, v, z.buff.aura);
        }
        continue;
      }
      if (z.smoke) continue;
      while (this.phase === 'live' && z.nextAt <= this.time && z.nextAt <= z.end) {
        const owner = this.units.get(z.owner);
        for (const v of this.units.values()) {
          if (!v.alive || v.team === z.team || !owner) continue;
          if (Math.hypot(v.pos.x - z.x, v.pos.z - z.z) > z.r || !this.onZoneFloor(v, z)) continue;
          if (this.time < v.dodgeUntil && jumpHeight(this.time - v.jumpStart) >= JUMP_DODGE_HEIGHT) {
            this.emit({ t: 'dodge', unit: v.id, ability: z.ability });
            continue;
          }
          const m = this.modsOf(owner);
          this.dealDamage(owner, v, z.amount * owner.gearMult * this.variance() * m.damageDone * (m.ability[z.ability]?.damage ?? 1), z.school, z.ability);
        }
        z.nextAt += z.pulse;
      }
    }
    this.zones = this.zones.filter((z) => this.time < z.end && this.phase !== 'ended');
  }

  // ------------------------------------------------------------------ snapshots

  /** With viewerTeam set, enemy units the team cannot currently see are left out entirely. */
  snapshot(viewerTeam?: TeamId): Snapshot {
    const hidden = viewerTeam !== undefined ? this.hiddenFrom(viewerTeam) : null;
    const units: UnitSnap[] = [];
    for (const u of this.units.values()) {
      if (hidden?.has(u.id)) continue;
      units.push(this.toSnap(u));
    }
    return {
      tick: this.tickNo, time: this.time, phase: this.phase,
      phaseEndsAt: this.phase === 'prep' ? this.prepEndsAt : this.matchEndsAt,
      winner: this.winner, units,
      zones: this.zones.map((z) => ({ id: z.id, owner: z.owner, team: z.team, x: Math.round(z.x * 100) / 100, z: Math.round(z.z * 100) / 100, r: z.r, school: z.school, ability: z.ability, start: z.start, firstAt: z.firstAt, pulse: z.pulse, end: z.end, ...(z.smoke ? { smoke: true } : {}), ...(z.flag ? { flag: true } : {}), ...(z.buff ? { buff: z.buff.who } : {}), ...(z.h > 0.05 ? { y: Math.round(z.h * 100) / 100 } : {}) })),
    };
  }

  private toSnap(u: Unit): UnitSnap {
    const cooldowns: Record<string, number> = {};
    for (const [k, v] of Object.entries(u.cooldowns)) if (v > this.time && (u.chargesUsed[k] ?? 0) >= (this.modsOf(u).ability[k]?.charges ?? 0)) cooldowns[k] = v; // a spare charge shows the slot as ready
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      id: u.id, name: u.name, team: u.team, classId: u.classId, spec: u.spec, look: u.look,
      ...(barSwapped(u.classId, u.spec, u.bar) ? { bar: u.bar } : {}),
      ...(u.trinket ? { trinket: u.trinket } : {}),
      ...(u.stealthSwaps && Object.keys(u.stealthSwaps).length ? { stealthSwaps: u.stealthSwaps } : {}),
      ...(u.level ? { lv: 1 as const } : {}),
      x: r2(u.pos.x), z: r2(u.pos.z), facing: Math.round(u.facing * 1000) / 1000,
      alive: u.alive, health: Math.round(u.health), maxHealth: u.maxHealth,
      resource: Math.round(u.resource), resourceMax: u.resourceMax, resourceType: u.resourceType,
      target: u.target, cast: u.cast, gcdEnd: u.gcdEnd, cooldowns,
      auras: u.auras.map((a) => ({ id: a.id, kind: a.kind, src: a.sourceId, expiresAt: isFinite(a.expiresAt) ? a.expiresAt : 0, ...(a.stacks ? { stacks: a.stacks } : {}) })),
      ...this.chargesOf(u),
      ...(u.cp > 0 ? { cp: u.cp } : {}),
      ...(u.mods.maxCp ? { cpMax: 5 + u.mods.maxCp } : {}),
      ...(Object.values(u.lockouts).some((t) => (t ?? 0) > this.time) ? { lockouts: Object.fromEntries(Object.entries(u.lockouts).filter(([, t]) => (t ?? 0) > this.time)) } : {}),
      stealthed: this.isStealthed(u),
      ...(u.auras.some((a) => a.kind === 'absorb' && a.absorbLeft > 0) ? { absorb: Math.round(u.auras.reduce((n, a) => n + (a.kind === 'absorb' ? a.absorbLeft : 0), 0)) } : {}),
      y: u.alive ? (u.leap ? Math.round(Math.max(0, leapHeight(u.leap, Math.min(1, (this.time - u.leap.start) / u.leap.dur)) - heightAt(this.arena, u.pos.x, u.pos.z, u.level)) * 100) / 100 : Math.round(jumpHeight(this.time - u.jumpStart) * 100) / 100) : 0,
      speedMult: this.speedMult(u),
      controlled: !this.canAct(u) || !!u.charge || !!u.leap,
      autoAttack: u.autoAttack,
      lastSeq: u.lastSeq,
    };
  }

  /** Charges ready on abilities that store several uses (Blink with its talent), for the number on the button. */
  private chargesOf(u: Unit): { charges?: Record<string, number> } {
    let out: Record<string, number> | undefined;
    for (const [id, m] of Object.entries(this.modsOf(u).ability)) {
      if (!m.stored) continue;
      const pend = (this.recharge.get(u.id)?.[id] ?? []).filter((t) => t > this.time).length;
      (out ??= {})[id] = Math.max(0, 1 + m.stored - pend);
    }
    return out ? { charges: out } : {};
  }

  private emit(e: SimEvent): void {
    this.events.push(e);
  }
}
