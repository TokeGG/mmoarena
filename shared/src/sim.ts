import { ABILITIES, ARENA, AURAS, CLASSES, TUNING } from './data';
import { barFor, barSwapped, compileMods, gearLook, withAuraMods } from './build';
import { blinkDestination, clamp, clampToGate, dist, hasLOS, resolveCollisions, stepMovement } from './geometry';
import { JUMP_DODGE_CD, JUMP_DODGE_HEIGHT, JUMP_MS, canStartJump, jumpHeight } from './jump';
import type {
  AbilityDef, AbilityMod, ArenaDef, AuraInst, AuraKind, Build, ClassId, Mods, MoveInput, Phase, Result, School, SimEvent, Snapshot, TeamId, Unit, UnitSnap,
} from './types';

const TICK = TUNING.tickMs;
const DT = TICK / 1000;
const ok: Result = { ok: true };
const fail = (reason: string): Result => ({ ok: false, reason });
const CC_KINDS: AuraKind[] = ['stun', 'incapacitate', 'fear'];

export const isMelee = (def: AbilityDef) => def.target === 'enemy' && def.range <= 5;

export interface SimOptions { seed?: number; prepMs?: number; arena?: ArenaDef; /** Players must face what they cast on or swing at (a cone in front of them). Off by default so unit tests can place units freely. */ facing?: boolean }
/** Every outside action on the sim, in a form a replay can feed back in. Ops: 0 input, 1 target, 2 ability, 3 auto-attack, 4 forfeit, 5 auto-attack setting. */
export type SimCommand = [tick: number, op: 0 | 1 | 2 | 3 | 4 | 5, unit: number, ...args: (number | string | boolean | null)[]];
export interface AddUnitOptions { name: string; classId: ClassId; team: TeamId; controller?: 'player' | 'dummy' | 'bot'; gearMult?: number; build?: Build }
export type AuraResult = { applied: true; duration: number; dr: number } | { applied: false; immune: true };

function mulberry32(seed: number) {
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
 * call step() once per tick (TUNING.tickMs). Same inputs + same seed = same outcome.
 */
export class ArenaSim {
  readonly arena: ArenaDef;
  time = 0;
  tickNo = 0;
  /** Set to record commands for a replay. */
  onCommand: ((c: SimCommand) => void) | null = null;
  /** Set to record the units added, in order. */
  onUnit: ((o: AddUnitOptions) => void) | null = null;
  phase: Phase = 'prep';
  winner: TeamId | 'draw' | null = null;
  readonly prepEndsAt: number;
  readonly matchEndsAt: number;
  readonly units = new Map<number, Unit>();
  private events: SimEvent[] = [];
  private zones: { id: number; owner: number; team: TeamId; x: number; z: number; r: number; school: School; ability: string; amount: number; start: number; firstAt: number; nextAt: number; pulse: number; end: number; smoke?: boolean }[] = [];
  private nextZoneId = 1;
  private facingRule = false;
  private nextId = 1;
  private rng: () => number;

  constructor(opts: SimOptions = {}) {
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
      gearMult: gear, bar: barFor(o.classId, o.build, cls.bar), spec: o.build?.spec ?? null, look: gearLook(o.build?.gear), mods, target: null, cast: null, gcdEnd: 0, cooldowns: {}, chargesUsed: {}, cp: 0, auras: [], dr: {}, lockouts: {},
      autoAttack: false, autoSince: 0, autoDisabled: false, nextSwing: 0, lastCombatAt: -1e9,
      inputQueue: [], charge: null, jumpStart: -1e9, dodgeUntil: 0, dodgeReadyAt: 0, lastInput: { seq: 0, fwd: 0, strafe: 0, facing }, lastSeq: 0, starve: 0,
      fearDir: { x: 0, z: 0 }, fearRetargetAt: 0,
    };
    this.units.set(u.id, u);
    return u;
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
    while (u.inputQueue.length > 5) u.inputQueue.shift();
  }

  setTarget(id: number, targetId: number | null): Result {
    this.onCommand?.([this.tickNo, 1, id, targetId]);
    const u = this.units.get(id);
    if (!u) return fail('no unit');
    if (targetId !== null && this.inSmoke(u)) return fail('blinded by smoke');
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
    const next = on && !u.autoDisabled && !!CLASSES[u.classId].auto;
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

  useAbility(id: number, abilityId: string, targetId?: number | null, ground?: { x: number; z: number } | null): Result {
    this.onCommand?.([this.tickNo, 2, id, abilityId, targetId ?? null, ground ? Math.round(ground.x * 100) / 100 : null, ground ? Math.round(ground.z * 100) / 100 : null]);
    if (ground) ground = { x: Math.round(ground.x * 100) / 100, z: Math.round(ground.z * 100) / 100 };
    const u = this.units.get(id);
    if (!u || !u.alive) return fail('you are dead');
    const def = ABILITIES[abilityId];
    if (def && !u.bar.includes(abilityId)) {
      // a slot can turn into another ability while stealthed (Sinister Strike and Mutilate become Cheap Shot)
      if (u.bar.some((b) => ABILITIES[b]?.stealthSwap === abilityId)) {
        if (!this.isStealthed(u)) return fail('requires stealth');
      } else return fail('unknown ability');
    } else if (!def) return fail('unknown ability');
    if (this.phase === 'ended') return fail('match is over');
    if (this.phase === 'prep' && !def.prepOk) return fail('match has not started');
    if (!this.canAct(u) && !def.ignoresControl) return fail('you are incapacitated');
    if (def.ignoresControl && u.auras.some((a) => AURAS[a.id]?.locksAbilities)) return fail('you are polymorphed');
    if (!def.ignoresLockout && (u.lockouts[def.school] ?? 0) > this.time) return fail(`${def.school} school is locked out`);
    if ((u.cooldowns[def.id] ?? 0) > this.time && (u.chargesUsed[def.id] ?? 0) >= (this.modsOf(u).ability[def.id]?.charges ?? 0)) return fail('ability is on cooldown');
    if (def.gcd && u.gcdEnd > this.time) return fail('global cooldown');
    if (u.resource < def.cost) return fail(`not enough ${u.resourceType}`);
    if (def.cpSpend && u.cp < 1) return fail('needs combo points');
    if (def.requiresStealth && !this.isStealthed(u)) return fail('requires stealth');
    if ((def.target === 'enemy' || def.target === 'ally' || def.target === 'ally_or_self' || def.target === 'any') && this.inSmoke(u)) return fail('blinded by smoke');
    if (def.outOfCombatOnly && this.time - u.lastCombatAt < TUNING.outOfCombatMs) return fail('cannot use in combat');
    if (this.hasAura(u, ['root']) && !def.allowWhileRooted && def.effects.some((e) => e.type === 'dashToTarget' || e.type === 'charge')) return fail('you are rooted');

    if (def.target === 'ground') {
      if (!ground && targetId !== undefined && targetId !== null) {
        const t0 = this.units.get(targetId);
        if (t0) ground = { x: t0.pos.x, z: t0.pos.z };
      }
      if (!ground || !Number.isFinite(ground.x) || !Number.isFinite(ground.z)) return fail('no target location');
      const b = this.arena.bounds;
      ground = { x: clamp(ground.x, b.minX, b.maxX), z: clamp(ground.z, b.minZ, b.maxZ) };
      if (dist(u.pos, ground) > this.rangeOf(u, def) + TUNING.rangeTolerance) return fail('out of range');
      if (!hasLOS(u.pos, ground, this.arena)) return fail('no line of sight');
      if (!this.inFront(u, ground.x, ground.z)) return fail('that spot is not in front of you');
    }

    const tgt = this.resolveTarget(u, def, targetId);
    if (typeof tgt === 'string') return fail(tgt);

    if (tgt !== u) {
      const d = dist(u.pos, tgt.pos);
      if (def.range > 0 && d > this.reachOf(u, def)) return fail('out of range');
      if (def.minRange && d < def.minRange) return fail('too close');
      if (!hasLOS(u.pos, tgt.pos, this.arena)) return fail('no line of sight');
      if (def.target !== 'aoe_enemy' && def.target !== 'aoe_all' && !this.inFront(u, tgt.pos.x, tgt.pos.z)) return fail('target is not in front of you');
      if (def.requiresTargetCasting && !tgt.cast) return fail('target is not casting');
    }
    if (def.effects.some((e) => e.type === 'dispel') && !this.dispelCandidate(u, tgt)) return fail('nothing to dispel');

    // using any other ability stops the cast in progress, interrupts included (they can still be pressed mid-cast)
    if (u.cast) this.cancelCast(u, 'switched spell');
    if (def.target === 'enemy') u.target = tgt.id;

    if (def.channel && def.castTime > 0) {
      // channels pay and go on cooldown up front, then fire their effects once per tick while the caster stands still
      const castMs = this.castTimeOf(u, def);
      u.resource -= def.cost;
      this.startCooldown(u, def);
      u.cast = { ability: def.id, target: tgt.id, start: this.time, end: this.time + castMs, ticks: def.channel.ticks, done: 0 };
      if (def.gcd) u.gcdEnd = this.time + this.gcdOf(u);
      if (!def.keepsStealth && this.isStealthed(u)) this.breakStealth(u);
      this.emit({ t: 'cast_start', unit: u.id, ability: def.id, target: tgt.id, end: u.cast.end });
      return ok;
    }
    const proc = def.castTime > 0 ? u.auras.find((a) => AURAS[a.id]?.instantFor === def.id) : undefined;
    if (proc) {
      // a proc (Hot Streak) makes this cast instant and is used up
      this.removeAura(u, proc, 'consumed');
      if (def.gcd) u.gcdEnd = this.time + this.gcdOf(u);
      this.execute(u, def, tgt, ground ?? undefined);
      return ok;
    }
    if (def.castTime > 0) {
      const castMs = this.castTimeOf(u, def);
      u.cast = { ability: def.id, target: tgt.id, start: this.time, end: this.time + castMs, ...(ground ? { gx: ground.x, gz: ground.z } : {}) };
      if (def.gcd) u.gcdEnd = this.time + this.gcdOf(u);
      this.emit({ t: 'cast_start', unit: u.id, ability: def.id, target: tgt.id, end: u.cast.end });
      return ok;
    }
    this.execute(u, def, tgt, ground ?? undefined);
    return ok;
  }

  // ------------------------------------------------------------------ tick

  step(): void {
    this.time += TICK;
    this.tickNo++;
    if (this.phase === 'prep' && this.time >= this.prepEndsAt) {
      this.phase = 'live';
      this.emit({ t: 'phase', phase: 'live', winner: null });
    }
    for (const u of this.units.values()) if (u.alive) this.tickUnit(u);
    this.tickZones();
    if (this.phase === 'live') this.checkEnd();
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private tickUnit(u: Unit): void {
    const cls = CLASSES[u.classId];
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
          this.dealDamage(src, u, dot.amount * (a.dotMult ?? 1) * (src?.gearMult ?? 1) * this.variance() * (m?.damageDone ?? 1) * (m?.ability[dot.ability]?.damage ?? 1), dot.school, dot.ability, true);
        }
      }
      if (u.alive && a.expiresAt <= this.time) this.removeAura(u, a, 'expired');
    }
    if (!u.alive) return;

    // combo points drain once combat has been over a while
    if (u.cp > 0 && this.time - u.lastCombatAt > TUNING.outOfCombatMs) u.cp = 0;

    // auto-attack switches itself off once combat has been over for a while
    if (u.autoAttack && this.time - Math.max(u.lastCombatAt, u.autoSince) > TUNING.outOfCombatMs) u.autoAttack = false;

    // resources
    if (u.resourceType === 'rage') {
      if (this.time - u.lastCombatAt > TUNING.outOfCombatMs) u.resource = Math.max(0, u.resource - TUNING.rageDecayPerSec * DT);
    } else {
      u.resource = Math.min(u.resourceMax, u.resource + cls.resource.regenPerSec * this.modsOf(u).regen * DT);
    }

    // input: one queued command per tick; briefly repeat the last one if a packet is late
    let input: MoveInput;
    const queued = u.inputQueue.shift();
    if (queued) {
      input = queued;
      u.lastInput = queued;
      u.lastSeq = queued.seq;
      u.starve = 0;
    } else if (u.starve < 3) {
      input = u.lastInput;
      u.starve++;
    } else {
      input = { ...u.lastInput, fwd: 0, strafe: 0 };
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
    if (u.charge) {
      const ch = u.charge;
      const tgt = this.units.get(ch.target);
      const d = tgt ? dist(u.pos, tgt.pos) : 0;
      if (!tgt || !tgt.alive || this.time > ch.until || !this.canAct(u) || this.hasAura(u, ['root']) || d <= ch.stop + 0.05) {
        this.endCharge(u, !!tgt && tgt.alive && this.canAct(u) && !this.hasAura(u, ['root']) && d <= ch.stop + 0.05);
      } else {
        const k = Math.min(ch.speed * DT, d - ch.stop);
        const nx = u.pos.x + ((tgt.pos.x - u.pos.x) / d) * k;
        const nz = u.pos.z + ((tgt.pos.z - u.pos.z) / d) * k;
        u.facing = Math.atan2(tgt.pos.x - u.pos.x, tgt.pos.z - u.pos.z);
        u.pos = resolveCollisions({ x: nx, z: nz }, this.arena);
        // blocked by a pillar: stop rather than push against it
        if (dist(before, u.pos) < k * 0.3) this.endCharge(u, false);
        if (this.phase === 'prep') u.pos = clampToGate(u.pos, u.team, this.arena);
        if (u.cast && dist(before, u.pos) > 0.001 && !ABILITIES[u.cast.ability]?.castWhileMoving) this.cancelCast(u, 'moved');
        this.tryAutoAttack(u);
        return;
      }
    }
    const feared = this.hasAura(u, ['fear']);
    if (feared) {
      if (this.time >= u.fearRetargetAt) {
        const ang = this.rng() * Math.PI * 2;
        u.fearDir = { x: Math.sin(ang), z: Math.cos(ang) };
        u.facing = ang;
        u.fearRetargetAt = this.time + 1000;
      }
      const k = 0.9 * TUNING.runSpeed * DT;
      u.pos = resolveCollisions({ x: u.pos.x + u.fearDir.x * k, z: u.pos.z + u.fearDir.z * k }, this.arena);
    } else {
      if ((this.canAct(u) || u.auras.some((a) => AURAS[a.id]?.canTurn)) && Number.isFinite(input.facing)) u.facing = input.facing;
      const speed = TUNING.runSpeed * this.speedMult(u);
      if (speed > 0) u.pos = stepMovement(u.pos, input, speed, DT, this.arena);
    }
    if (this.phase === 'prep') u.pos = clampToGate(u.pos, u.team, this.arena);
    if (u.cast && dist(before, u.pos) > 0.001 && !ABILITIES[u.cast.ability]?.castWhileMoving) this.cancelCast(u, 'moved');

    if (u.cast?.ticks) this.tickChannel(u);
    if (u.cast && u.cast.end <= this.time) this.completeCast(u);
    this.tryAutoAttack(u);
  }

  private checkEnd(): void {
    let alive0 = 0;
    let alive1 = 0;
    for (const u of this.units.values()) if (u.alive) (u.team === 0 ? alive0++ : alive1++);
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
    while (u.cast === c && (c.done ?? 0) < c.ticks && this.time >= c.start + (span * ((c.done ?? 0) + 1)) / c.ticks - 1e-6) {
      const tgt = this.units.get(c.target);
      if (!tgt || !tgt.alive) {
        u.cast = null;
        this.emit({ t: 'channel_end', unit: u.id, ability: def.id });
        return;
      }
      if (tgt !== u) {
        if (def.range > 0 && dist(u.pos, tgt.pos) > this.reachOf(u, def)) return this.cancelCast(u, 'out of range');
        // a channel that has started keeps ticking when the target steps behind a pillar or wall
        if (!this.canSee(u, tgt)) return this.cancelCast(u, 'target not visible');
      }
      c.done = (c.done ?? 0) + 1;
      this.emit({ t: 'cast', unit: u.id, ability: def.id, target: tgt.id });
      for (const eff of def.effects) this.applyEffect(u, def, tgt, eff);
    }
  }

  private completeCast(u: Unit): void {
    const c = u.cast;
    if (!c) return;
    u.cast = null;
    const def = ABILITIES[c.ability];
    if (def.channel) {
      this.emit({ t: 'channel_end', unit: u.id, ability: def.id });
      return;
    }
    const tgt = this.units.get(c.target);
    if (!tgt || !tgt.alive) return this.failCast(u, c.ability, 'target is dead');
    if (tgt !== u) {
      if (def.range > 0 && dist(u.pos, tgt.pos) > this.reachOf(u, def)) return this.failCast(u, c.ability, 'out of range');
      if (!hasLOS(u.pos, tgt.pos, this.arena)) return this.failCast(u, c.ability, 'no line of sight');
      if (!this.canSee(u, tgt)) return this.failCast(u, c.ability, 'target not visible');
    }
    if (u.resource < def.cost) return this.failCast(u, c.ability, `not enough ${u.resourceType}`);
    this.execute(u, def, tgt, c.gx !== undefined && c.gz !== undefined ? { x: c.gx, z: c.gz } : undefined);
  }

  cancelCast(u: Unit, reason: string): void {
    if (!u.cast) return;
    const ability = u.cast.ability;
    u.cast = null;
    this.failCast(u, ability, reason);
  }

  private failCast(u: Unit, ability: string, reason: string): void {
    this.emit({ t: 'cast_fail', unit: u.id, ability, reason });
  }

  /** Start an ability's cooldown; a use made while it is already running spends an extra charge instead of restarting it. */
  private startCooldown(u: Unit, def: AbilityDef): void {
    if (def.cooldown <= 0) return;
    if ((u.cooldowns[def.id] ?? 0) > this.time) { u.chargesUsed[def.id] = (u.chargesUsed[def.id] ?? 0) + 1; return; }
    u.chargesUsed[def.id] = 0;
    u.cooldowns[def.id] = this.time + Math.round(def.cooldown * (this.modsOf(u).ability[def.id]?.cooldown ?? 1));
  }

  private ground: { x: number; z: number } | null = null;
  /** Per-cast scratch values (see execute). */
  private cpSpent = 0;
  private empowerMult = 1;
  private stackMult = 1;

  private execute(u: Unit, def: AbilityDef, tgt: Unit, ground?: { x: number; z: number }): void {
    this.ground = ground ?? null;
    u.resource -= def.cost;
    this.startCooldown(u, def);
    if (def.gcd && def.castTime === 0) u.gcdEnd = this.time + this.gcdOf(u);
    this.emit({ t: 'cast', unit: u.id, ability: def.id, target: tgt.id });

    // combo points spent, shatter-style empowering and stack eating, worked out once for the whole cast
    this.cpSpent = def.cpSpend ? u.cp : 0;
    this.empowerMult = 1;
    this.stackMult = 1;
    const hits = def.effects.some((e) => e.type === 'damage');
    const empowerAura = hits ? u.auras.find((a) => AURAS[a.id]?.empower?.school === def.school && !def.effects.some((e) => e.type === 'aura' && AURAS[e.aura]?.empower)) : undefined;
    if (empowerAura) this.empowerMult = AURAS[empowerAura.id].empower!.mult;
    const eaten = def.consumes ? u.auras.find((a) => a.id === def.consumes!.aura) : undefined;
    if (eaten) this.stackMult = 1 + def.consumes!.perStack * (eaten.stacks ?? 1);

    const targets: Unit[] =
      def.target === 'aoe_enemy'
        ? [...this.units.values()].filter((v) => v.alive && v.team !== u.team && dist(u.pos, v.pos) <= (def.radius ?? 0))
        : def.target === 'aoe_all'
          ? [...this.units.values()].filter((v) => v.alive && dist(u.pos, v.pos) <= (def.radius ?? 0) && (v === u || hasLOS(u.pos, v.pos, this.arena)))
          : [tgt];

    for (const t of targets) for (const eff of def.effects) this.applyEffect(u, def, t, eff);
    for (const id of this.modsOf(u).ability[def.id]?.after ?? []) this.applyAura(u, u, id);
    if (empowerAura) this.removeAura(u, empowerAura, 'consumed');
    if (eaten) this.removeAura(u, eaten, 'consumed');
    if (def.cpSpend) u.cp = 0;
    if (def.cpGain) u.cp = Math.min(5, u.cp + def.cpGain);
    this.cpSpent = 0;
    this.empowerMult = 1;
    this.stackMult = 1;
    this.ground = null;

    if (isMelee(def) && CLASSES[u.classId].auto && !u.autoDisabled) {
      if (!u.autoAttack) u.autoSince = this.time;
      u.autoAttack = true;
    }
    if (!def.keepsStealth && this.isStealthed(u)) this.breakStealth(u);
  }

  private applyEffect(u: Unit, def: AbilityDef, t: Unit, eff: AbilityDef['effects'][number]): void {
    switch (eff.type) {
      case 'damage':
        if (eff.only === 'enemy' && t.team === u.team) break;
        if (eff.only === 'ally' && t.team !== u.team) break;
        this.dealDamage(u, t, eff.amount * u.gearMult * this.variance() * this.modsOf(u).damageDone * (this.modsOf(u).ability[def.id]?.damage ?? 1) * (def.cpScale ? Math.max(1, this.cpSpent) : 1) * this.empowerMult * this.stackMult, def.school, def.id);
        break;
      case 'heal':
        if (eff.only === 'enemy' && t.team === u.team) break;
        if (eff.only === 'ally' && t.team !== u.team) break;
        this.heal(u, t, eff.amount * u.gearMult * this.variance() * this.modsOf(u).healingDone * (this.modsOf(u).ability[def.id]?.heal ?? 1), def.id);
        break;
      case 'aura':
        if (eff.chance !== undefined && this.rng() >= eff.chance) break;
        this.applyAura(u, eff.self ? u : t, eff.aura, (eff.extraPerCp ?? 0) * this.cpSpent);
        break;
      case 'exsanguinate': {
        let bleed = 0;
        for (const a of t.auras) {
          const d = AURAS[a.id];
          if (!d?.bleed || !d.dot) continue;
          bleed += d.dot.amount * (a.dotMult ?? 1) * Math.max(0, Math.ceil((a.expiresAt - this.time) / d.dot.interval));
          a.dotMult = (a.dotMult ?? 1) * eff.bleedMult;
        }
        this.dealDamage(u, t, (eff.perCp * Math.max(1, this.cpSpent) + bleed * eff.bleedFraction) * u.gearMult * this.modsOf(u).damageDone * (this.modsOf(u).ability[def.id]?.damage ?? 1), def.school, def.id);
        break;
      }
      case 'interrupt':
        this.interrupt(u, t, def, eff.lockout);
        break;
      case 'dispel': {
        const a = this.dispelCandidate(u, t);
        if (a) {
          this.removeAura(t, a, 'dispelled');
          this.emit({ t: 'dispel', src: u.id, tgt: t.id, aura: a.id });
        }
        break;
      }
      case 'charge': {
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
          u.pos = resolveCollisions({ x: u.pos.x + (dx / d) * travel, z: u.pos.z + (dz / d) * travel }, this.arena);
          u.facing = Math.atan2(dx, dz);
        }
        break;
      }
      case 'blink':
        u.pos = blinkDestination(u.pos, u.facing, eff.distance, this.arena);
        // blinking out breaks you free of stuns, roots and slows
        for (const a of [...u.auras]) if (a.kind === 'stun' || a.kind === 'root' || a.kind === 'slow') this.removeAura(u, a, 'blinked');
        break;
      case 'zone':
        this.zones.push({
          id: this.nextZoneId++, owner: u.id, team: u.team, x: this.ground?.x ?? t.pos.x, z: this.ground?.z ?? t.pos.z, r: eff.radius, school: def.school, ability: def.id, amount: eff.amount,
          start: this.time, firstAt: this.time + (eff.delay ?? 800), nextAt: this.time + (eff.delay ?? 800), pulse: eff.pulse, end: this.time + eff.duration,
        });
        break;
      case 'cleanse':
        for (const a of [...u.auras]) if (AURAS[a.id].harmful) this.removeAura(u, a, 'cleansed');
        break;
      case 'dropCombat':
        u.lastCombatAt = -1e9;
        u.autoAttack = false;
        for (const e of this.units.values()) {
          if (e.team === u.team) continue;
          if (e.target === u.id) {
            e.target = null;
            e.autoAttack = false;
          }
          if (e.cast && e.cast.target === u.id && ABILITIES[e.cast.ability]?.target !== 'ground') this.cancelCast(e, 'target vanished');
        }
        break;
      case 'smoke':
        this.zones.push({
          id: this.nextZoneId++, owner: u.id, team: u.team, x: u.pos.x, z: u.pos.z, r: eff.radius, school: def.school, ability: def.id, amount: 0,
          start: this.time, firstAt: this.time + eff.duration + 1, nextAt: Infinity, pulse: eff.duration, end: this.time + eff.duration, smoke: true,
        });
        break;
      case 'gain':
        u.resource = Math.min(u.resourceMax, u.resource + eff.amount);
        break;
    }
  }

  private interrupt(src: Unit, t: Unit, def: AbilityDef, lockout: number): void {
    if (!t.cast) return;
    const cast = ABILITIES[t.cast.ability];
    t.cast = null;
    t.lockouts[cast.school] = this.time + lockout;
    src.lastCombatAt = this.time;
    t.lastCombatAt = this.time;
    this.emit({ t: 'interrupt', src: src.id, tgt: t.id, ability: cast.id, school: cast.school, lockout });
    this.failCast(t, cast.id, 'interrupted');
  }

  // ------------------------------------------------------------------ damage / healing

  private variance(): number {
    return 1 + (this.rng() * 2 - 1) * TUNING.damageVariance;
  }

  /** Returns damage that actually reached health (after absorbs). */
  dealDamage(src: Unit | null, tgt: Unit, raw: number, school: School, ability: string | null, periodic = false): number {
    if (!tgt.alive) return 0;
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
    tgt.health = Math.max(0, tgt.health - remaining);
    tgt.lastCombatAt = this.time;
    if (src) src.lastCombatAt = this.time;
    this.emit({ t: 'damage', src: src?.id ?? 0, tgt: tgt.id, amount: remaining, absorbed, ability, school });

    if (src?.resourceType === 'rage') src.resource = Math.min(src.resourceMax, src.resource + remaining * TUNING.rageFromDealt);
    if (tgt.resourceType === 'rage') tgt.resource = Math.min(tgt.resourceMax, tgt.resource + remaining * TUNING.rageFromTaken);

    if (remaining + absorbed > 0) {
      if (tgt.charge) this.endCharge(tgt, false); // being hit stops a charge
      for (const a of [...tgt.auras]) if (AURAS[a.id].breaksOnDamage && !(periodic && a.kind === 'fear')) this.removeAura(tgt, a, 'damage'); // damage-over-time ticks do not break fear
      if (this.isStealthed(tgt)) this.breakStealth(tgt);
    }
    if (tgt.health <= 0) this.die(tgt, src?.id ?? null);
    return remaining;
  }

  heal(src: Unit, tgt: Unit, raw: number, ability: string): number {
    if (!tgt.alive) return 0;
    const want = Math.max(0, Math.round(raw));
    const amount = Math.min(want, tgt.maxHealth - tgt.health);
    tgt.health += amount;
    src.lastCombatAt = this.time;
    this.emit({ t: 'heal', src: src.id, tgt: tgt.id, amount, overheal: want - amount, ability });
    return amount;
  }

  private die(u: Unit, killer: number | null): void {
    u.alive = false;
    u.health = 0;
    u.cast = null;
    this.endCharge(u, false);
    u.auras = [];
    u.autoAttack = false;
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
    if (landed && t.alive && ch.hit > 0) {
      this.dealDamage(u, t, ch.hit * u.gearMult * this.variance() * this.modsOf(u).damageDone * (this.modsOf(u).ability['charge']?.damage ?? 1), 'physical', 'charge');
    }
  }

  private tryAutoAttack(u: Unit): void {
    const auto = CLASSES[u.classId].auto;
    if (!auto || !u.autoAttack || this.phase !== 'live' || !this.canAct(u) || u.cast) return;
    const t = u.target !== null ? this.units.get(u.target) : undefined;
    if (!t || !t.alive || t.team === u.team || !this.canSee(u, t)) return;
    // auto-attack is held while stealthed, unless the target is right next to you: then the swing lands and breaks stealth
    if (this.isStealthed(u) && dist(u.pos, t.pos) > TUNING.stealthDetect) return;
    if (dist(u.pos, t.pos) > auto.range + TUNING.autoTolerance || this.time < u.nextSwing) return;
    if (!hasLOS(u.pos, t.pos, this.arena)) return; // no swinging through pillars
    if (!this.inFront(u, t.pos.x, t.pos.z)) return; // and no swinging at what is behind you
    u.nextSwing = this.time + auto.interval * this.modsOf(u).autoSpeed;
    if (this.isStealthed(u)) this.breakStealth(u);
    this.dealDamage(u, t, auto.damage * u.gearMult * this.variance() * this.modsOf(u).damageDone, 'physical', null);
  }

  // ------------------------------------------------------------------ auras, crowd control, diminishing returns

  applyAura(src: Unit, tgt: Unit, auraId: string, extraMs = 0): AuraResult {
    const def = AURAS[auraId];
    if (!def || !tgt.alive) return { applied: false, immune: true };

    let duration = def.duration;
    let drMult = 1;
    if (def.dr) {
      const st = (tgt.dr[def.dr] ??= { count: 0, resetAt: 0 });
      if (this.time >= st.resetAt) st.count = 0;
      drMult = TUNING.drSteps[Math.min(st.count, TUNING.drSteps.length - 1)];
      if (drMult === 0) {
        this.emit({ t: 'immune', src: src.id, tgt: tgt.id, aura: auraId });
        return { applied: false, immune: true };
      }
      duration = def.duration * drMult * (this.modsOf(src).auraDuration[auraId] ?? 1);
      st.count++;
      st.resetAt = this.time + duration + TUNING.drResetMs;
    }

    else duration = def.duration * (this.modsOf(src).auraDuration[auraId] ?? 1);
    if (def.duration > 0) duration += extraMs;

    const prior = tgt.auras.find((a) => a.id === auraId && a.sourceId === src.id);
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
      absorbLeft: (def.absorb ?? 0) * src.gearMult * this.modsOf(src).healingDone,
      ...(def.maxStacks ? { stacks: Math.min(def.maxStacks, (prior?.stacks ?? 0) + 1) } : {}),
      ...(def.dot ? { nextTick: this.time + def.dot.interval } : def.hot ? { nextTick: this.time + def.hot.interval } : {}),
    };
    tgt.auras.push(inst);

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
  }

  /** Allies lose a harmful magic aura; enemies lose a beneficial magic aura. Crowd control goes first. */
  private dispelCandidate(src: Unit, tgt: Unit): AuraInst | undefined {
    const friendly = src.team === tgt.team;
    const order: AuraKind[] = ['incapacitate', 'fear', 'stun', 'root', 'slow', 'absorb', 'speed'];
    return tgt.auras
      .filter((a) => AURAS[a.id].dispellable && AURAS[a.id].harmful === friendly)
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0];
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

  /** Stealthed enemies are only visible up close. */
  canSee(viewer: Unit, other: Unit): boolean {
    if (viewer.team === other.team || !this.isStealthed(other)) return true;
    return dist(viewer.pos, other.pos) <= TUNING.stealthDetect;
  }

  private resolveTarget(u: Unit, def: AbilityDef, targetId?: number | null): Unit | string {
    if (def.target === 'self' || def.target === 'aoe_enemy' || def.target === 'aoe_all' || def.target === 'ground') return u;
    const t = this.units.get(targetId ?? u.target ?? -1);
    switch (def.target) {
      case 'enemy':
        if (!t || t.team === u.team) return 'no valid target';
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

  /** True while the unit stands in an enemy smoke cloud: it cannot target. */
  inSmoke(u: Unit): boolean {
    return this.zones.some((z) => z.smoke && z.team !== u.team && this.time < z.end && Math.hypot(u.pos.x - z.x, u.pos.z - z.z) <= z.r);
  }

  private tickZones(): void {
    if (!this.zones.length) return;
    for (const v of this.units.values()) {
      if (!v.alive || !this.inSmoke(v)) continue;
      if (v.target !== null) v.target = null;
      v.autoAttack = false;
      if (v.cast) {
        const kind = ABILITIES[v.cast.ability]?.target;
        if (kind === 'enemy' || kind === 'ally' || kind === 'ally_or_self' || kind === 'any') this.cancelCast(v, 'blinded by smoke');
      }
    }
    for (const z of this.zones) {
      if (z.smoke) continue;
      while (this.phase === 'live' && z.nextAt <= this.time && z.nextAt <= z.end) {
        const owner = this.units.get(z.owner);
        for (const v of this.units.values()) {
          if (!v.alive || v.team === z.team || !owner) continue;
          if (Math.hypot(v.pos.x - z.x, v.pos.z - z.z) > z.r) continue;
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
    const all = [...this.units.values()];
    const units: UnitSnap[] = [];
    for (const u of all) {
      if (viewerTeam !== undefined && u.team !== viewerTeam && this.isStealthed(u)) {
        const seen = all.some((v) => v.team === viewerTeam && v.alive && dist(v.pos, u.pos) <= TUNING.stealthDetect);
        if (!seen) continue;
      }
      units.push(this.toSnap(u));
    }
    return {
      tick: this.tickNo, time: this.time, phase: this.phase,
      phaseEndsAt: this.phase === 'prep' ? this.prepEndsAt : this.matchEndsAt,
      winner: this.winner, units,
      zones: this.zones.map((z) => ({ id: z.id, owner: z.owner, team: z.team, x: Math.round(z.x * 100) / 100, z: Math.round(z.z * 100) / 100, r: z.r, school: z.school, ability: z.ability, start: z.start, firstAt: z.firstAt, pulse: z.pulse, end: z.end, ...(z.smoke ? { smoke: true } : {}) })),
    };
  }

  private toSnap(u: Unit): UnitSnap {
    const cooldowns: Record<string, number> = {};
    for (const [k, v] of Object.entries(u.cooldowns)) if (v > this.time && (u.chargesUsed[k] ?? 0) >= (this.modsOf(u).ability[k]?.charges ?? 0)) cooldowns[k] = v; // a spare charge shows the slot as ready
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      id: u.id, name: u.name, team: u.team, classId: u.classId, spec: u.spec, look: u.look,
      ...(barSwapped(u.classId, u.spec, u.bar) ? { bar: u.bar } : {}),
      x: r2(u.pos.x), z: r2(u.pos.z), facing: Math.round(u.facing * 1000) / 1000,
      alive: u.alive, health: Math.round(u.health), maxHealth: u.maxHealth,
      resource: Math.round(u.resource), resourceMax: u.resourceMax, resourceType: u.resourceType,
      target: u.target, cast: u.cast, gcdEnd: u.gcdEnd, cooldowns,
      auras: u.auras.map((a) => ({ id: a.id, kind: a.kind, src: a.sourceId, expiresAt: isFinite(a.expiresAt) ? a.expiresAt : 0, ...(a.stacks ? { stacks: a.stacks } : {}) })),
      ...(u.cp > 0 ? { cp: u.cp } : {}),
      ...(Object.values(u.lockouts).some((t) => (t ?? 0) > this.time) ? { lockouts: Object.fromEntries(Object.entries(u.lockouts).filter(([, t]) => (t ?? 0) > this.time)) } : {}),
      stealthed: this.isStealthed(u),
      ...(u.auras.some((a) => a.kind === 'absorb' && a.absorbLeft > 0) ? { absorb: Math.round(u.auras.reduce((n, a) => n + (a.kind === 'absorb' ? a.absorbLeft : 0), 0)) } : {}),
      y: u.alive ? Math.round(jumpHeight(this.time - u.jumpStart) * 100) / 100 : 0,
      speedMult: this.speedMult(u),
      controlled: !this.canAct(u) || !!u.charge,
      autoAttack: u.autoAttack,
      lastSeq: u.lastSeq,
    };
  }

  private emit(e: SimEvent): void {
    this.events.push(e);
  }
}
