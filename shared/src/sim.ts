import { ABILITIES, ARENA, AURAS, CLASSES, TUNING } from './data';
import { barFor, compileMods, withAuraMods } from './build';
import { blinkDestination, clamp, clampToGate, dist, hasLOS, resolveCollisions, stepMovement } from './geometry';
import { canStartJump, jumpHeight } from './jump';
import type {
  AbilityDef, AbilityMod, ArenaDef, AuraInst, AuraKind, Build, ClassId, Mods, MoveInput, Phase, Result, School, SimEvent, Snapshot, TeamId, Unit, UnitSnap,
} from './types';

const TICK = TUNING.tickMs;
const DT = TICK / 1000;
const ok: Result = { ok: true };
const fail = (reason: string): Result => ({ ok: false, reason });
const CC_KINDS: AuraKind[] = ['stun', 'incapacitate', 'fear'];

export const isMelee = (def: AbilityDef) => def.target === 'enemy' && def.range <= 5;

export interface SimOptions { seed?: number; prepMs?: number; arena?: ArenaDef }
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
  phase: Phase = 'prep';
  winner: TeamId | 'draw' | null = null;
  readonly prepEndsAt: number;
  readonly matchEndsAt: number;
  readonly units = new Map<number, Unit>();
  private events: SimEvent[] = [];
  private nextId = 1;
  private rng: () => number;

  constructor(opts: SimOptions = {}) {
    this.arena = opts.arena ?? ARENA;
    this.rng = mulberry32(opts.seed ?? 1);
    this.prepEndsAt = opts.prepMs ?? TUNING.prepMs;
    this.matchEndsAt = this.prepEndsAt + TUNING.maxMatchMs;
  }

  // ------------------------------------------------------------------ setup

  addUnit(o: AddUnitOptions): Unit {
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
      gearMult: gear, bar: barFor(o.classId, o.build, cls.bar), spec: o.build?.spec ?? null, mods, target: null, cast: null, gcdEnd: 0, cooldowns: {}, auras: [], dr: {}, lockouts: {},
      autoAttack: false, nextSwing: 0, lastCombatAt: -1e9,
      inputQueue: [], jumpStart: -1e9, lastInput: { seq: 0, fwd: 0, strafe: 0, facing }, lastSeq: 0, starve: 0,
      fearDir: { x: 0, z: 0 }, fearRetargetAt: 0,
    };
    this.units.set(u.id, u);
    return u;
  }

  /** A disconnect counts as a forfeit: the unit dies so match-end logic runs normally. */
  forfeit(id: number): void {
    const u = this.units.get(id);
    if (u?.alive) this.die(u, null);
  }

  // ------------------------------------------------------------------ player commands

  queueInput(id: number, input: MoveInput): void {
    const u = this.units.get(id);
    if (!u || !u.alive) return;
    u.inputQueue.push({
      seq: input.seq,
      fwd: clamp(input.fwd, -1, 1),
      strafe: clamp(input.strafe, -1, 1),
      facing: input.facing,
      jump: input.jump === true,
    });
    while (u.inputQueue.length > 5) u.inputQueue.shift();
  }

  setTarget(id: number, targetId: number | null): Result {
    const u = this.units.get(id);
    if (!u) return fail('no unit');
    if (targetId === null) {
      u.target = null;
      return ok;
    }
    const t = this.units.get(targetId);
    if (!t) return fail('no such target');
    if (t.team !== u.team && !this.canSee(u, t)) return fail('target not visible');
    u.target = targetId;
    return ok;
  }

  setAutoAttack(id: number, on: boolean): void {
    const u = this.units.get(id);
    if (u) u.autoAttack = on && !!CLASSES[u.classId].auto;
  }

  useAbility(id: number, abilityId: string, targetId?: number | null): Result {
    const u = this.units.get(id);
    if (!u || !u.alive) return fail('you are dead');
    const def = ABILITIES[abilityId];
    if (!def || !u.bar.includes(abilityId)) return fail('unknown ability');
    if (this.phase === 'ended') return fail('match is over');
    if (this.phase === 'prep' && !def.prepOk) return fail('match has not started');
    if (!this.canAct(u)) return fail('you are incapacitated');
    if (!def.ignoresLockout && (u.lockouts[def.school] ?? 0) > this.time) return fail(`${def.school} school is locked out`);
    if ((u.cooldowns[def.id] ?? 0) > this.time) return fail('ability is on cooldown');
    if (def.gcd && u.gcdEnd > this.time) return fail('global cooldown');
    if (u.cast && (def.castTime > 0 || def.gcd)) return fail('already casting');
    if (u.resource < def.cost) return fail(`not enough ${u.resourceType}`);
    if (def.requiresStealth && !this.isStealthed(u)) return fail('requires stealth');
    if (def.outOfCombatOnly && this.time - u.lastCombatAt < TUNING.outOfCombatMs) return fail('cannot use in combat');
    if (this.hasAura(u, ['root']) && !def.allowWhileRooted && def.effects.some((e) => e.type === 'dashToTarget')) return fail('you are rooted');

    const tgt = this.resolveTarget(u, def, targetId);
    if (typeof tgt === 'string') return fail(tgt);

    if (tgt !== u) {
      const d = dist(u.pos, tgt.pos);
      if (def.range > 0 && d > this.rangeOf(u, def) + TUNING.rangeTolerance) return fail('out of range');
      if (def.minRange && d < def.minRange) return fail('too close');
      if (!hasLOS(u.pos, tgt.pos, this.arena)) return fail('no line of sight');
      if (def.requiresTargetCasting && !tgt.cast) return fail('target is not casting');
    }
    if (def.effects.some((e) => e.type === 'dispel') && !this.dispelCandidate(u, tgt)) return fail('nothing to dispel');

    if (def.target === 'enemy') u.target = tgt.id;

    if (def.channel && def.castTime > 0) {
      // channels pay and go on cooldown up front, then fire their effects once per tick while the caster stands still
      const castMs = this.castTimeOf(u, def);
      u.resource -= def.cost;
      if (def.cooldown > 0) u.cooldowns[def.id] = this.time + Math.round(def.cooldown * (this.modsOf(u).ability[def.id]?.cooldown ?? 1));
      u.cast = { ability: def.id, target: tgt.id, start: this.time, end: this.time + castMs, ticks: def.channel.ticks, done: 0 };
      if (def.gcd) u.gcdEnd = this.time + this.gcdOf(u);
      if (!def.keepsStealth && this.isStealthed(u)) this.breakStealth(u);
      this.emit({ t: 'cast_start', unit: u.id, ability: def.id, target: tgt.id, end: u.cast.end });
      return ok;
    }
    if (def.castTime > 0) {
      const castMs = this.castTimeOf(u, def);
      u.cast = { ability: def.id, target: tgt.id, start: this.time, end: this.time + castMs };
      if (def.gcd) u.gcdEnd = this.time + this.gcdOf(u);
      this.emit({ t: 'cast_start', unit: u.id, ability: def.id, target: tgt.id, end: u.cast.end });
      return ok;
    }
    this.execute(u, def, tgt);
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
    if (this.phase === 'live') this.checkEnd();
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private tickUnit(u: Unit): void {
    const cls = CLASSES[u.classId];
    for (const a of [...u.auras]) if (a.expiresAt <= this.time) this.removeAura(u, a, 'expired');

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
    if (queued?.jump && this.canAct(u) && canStartJump(this.time - u.jumpStart)) u.jumpStart = this.time;

    // movement
    const before = { x: u.pos.x, z: u.pos.z };
    if (this.hasAura(u, ['fear'])) {
      if (this.time >= u.fearRetargetAt) {
        const ang = this.rng() * Math.PI * 2;
        u.fearDir = { x: Math.sin(ang), z: Math.cos(ang) };
        u.facing = ang;
        u.fearRetargetAt = this.time + 1000;
      }
      u.pos = resolveCollisions({ x: u.pos.x + u.fearDir.x * TUNING.runSpeed * 0.9 * DT, z: u.pos.z + u.fearDir.z * TUNING.runSpeed * 0.9 * DT }, this.arena);
    } else {
      if (this.canAct(u) && Number.isFinite(input.facing)) u.facing = input.facing;
      const speed = TUNING.runSpeed * this.speedMult(u);
      if (speed > 0) u.pos = stepMovement(u.pos, input, speed, DT, this.arena);
    }
    if (this.phase === 'prep') u.pos = clampToGate(u.pos, u.team, this.arena);
    if (u.cast && dist(before, u.pos) > 0.001) this.cancelCast(u, 'moved');

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
        if (def.range > 0 && dist(u.pos, tgt.pos) > this.rangeOf(u, def) + TUNING.rangeTolerance) return this.cancelCast(u, 'out of range');
        if (!hasLOS(u.pos, tgt.pos, this.arena)) return this.cancelCast(u, 'no line of sight');
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
      if (def.range > 0 && dist(u.pos, tgt.pos) > this.rangeOf(u, def) + TUNING.rangeTolerance) return this.failCast(u, c.ability, 'out of range');
      if (!hasLOS(u.pos, tgt.pos, this.arena)) return this.failCast(u, c.ability, 'no line of sight');
      if (!this.canSee(u, tgt)) return this.failCast(u, c.ability, 'target not visible');
    }
    if (u.resource < def.cost) return this.failCast(u, c.ability, `not enough ${u.resourceType}`);
    this.execute(u, def, tgt);
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

  private execute(u: Unit, def: AbilityDef, tgt: Unit): void {
    u.resource -= def.cost;
    if (def.cooldown > 0) u.cooldowns[def.id] = this.time + Math.round(def.cooldown * (this.modsOf(u).ability[def.id]?.cooldown ?? 1));
    if (def.gcd && def.castTime === 0) u.gcdEnd = this.time + this.gcdOf(u);
    this.emit({ t: 'cast', unit: u.id, ability: def.id, target: tgt.id });

    const targets: Unit[] =
      def.target === 'aoe_enemy'
        ? [...this.units.values()].filter((v) => v.alive && v.team !== u.team && dist(u.pos, v.pos) <= (def.radius ?? 0))
        : [tgt];

    for (const t of targets) for (const eff of def.effects) this.applyEffect(u, def, t, eff);

    if (isMelee(def) && CLASSES[u.classId].auto) u.autoAttack = true;
    if (!def.keepsStealth && this.isStealthed(u)) this.breakStealth(u);
  }

  private applyEffect(u: Unit, def: AbilityDef, t: Unit, eff: AbilityDef['effects'][number]): void {
    switch (eff.type) {
      case 'damage':
        this.dealDamage(u, t, eff.amount * u.gearMult * this.variance() * this.modsOf(u).damageDone * (this.modsOf(u).ability[def.id]?.damage ?? 1), def.school, def.id);
        break;
      case 'heal':
        this.heal(u, t, eff.amount * u.gearMult * this.variance() * this.modsOf(u).healingDone * (this.modsOf(u).ability[def.id]?.heal ?? 1), def.id);
        break;
      case 'aura':
        this.applyAura(u, t, eff.aura);
        break;
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
  dealDamage(src: Unit | null, tgt: Unit, raw: number, school: School, ability: string | null): number {
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
      for (const a of [...tgt.auras]) if (AURAS[a.id].breaksOnDamage) this.removeAura(tgt, a, 'damage');
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
    u.auras = [];
    u.autoAttack = false;
    this.emit({ t: 'death', unit: u.id, killer });
  }

  private tryAutoAttack(u: Unit): void {
    const auto = CLASSES[u.classId].auto;
    if (!auto || !u.autoAttack || this.phase !== 'live' || !this.canAct(u) || u.cast) return;
    const t = u.target !== null ? this.units.get(u.target) : undefined;
    if (!t || !t.alive || t.team === u.team || !this.canSee(u, t)) return;
    if (dist(u.pos, t.pos) > auto.range + TUNING.rangeTolerance || this.time < u.nextSwing) return;
    u.nextSwing = this.time + auto.interval;
    if (this.isStealthed(u)) this.breakStealth(u);
    this.dealDamage(u, t, auto.damage * u.gearMult * this.variance() * this.modsOf(u).damageDone, 'physical', null);
  }

  // ------------------------------------------------------------------ auras, crowd control, diminishing returns

  applyAura(src: Unit, tgt: Unit, auraId: string): AuraResult {
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

    tgt.auras = tgt.auras.filter((a) => !(a.id === auraId && a.sourceId === src.id));
    const inst: AuraInst = {
      id: auraId, kind: def.kind, sourceId: src.id,
      expiresAt: def.duration > 0 ? this.time + duration : Infinity,
      absorbLeft: (def.absorb ?? 0) * src.gearMult * this.modsOf(src).healingDone,
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
    if (def.target === 'self' || def.target === 'aoe_enemy') return u;
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
    };
  }

  private toSnap(u: Unit): UnitSnap {
    const cooldowns: Record<string, number> = {};
    for (const [k, v] of Object.entries(u.cooldowns)) if (v > this.time) cooldowns[k] = v;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      id: u.id, name: u.name, team: u.team, classId: u.classId, spec: u.spec,
      x: r2(u.pos.x), z: r2(u.pos.z), facing: Math.round(u.facing * 1000) / 1000,
      alive: u.alive, health: Math.round(u.health), maxHealth: u.maxHealth,
      resource: Math.round(u.resource), resourceMax: u.resourceMax, resourceType: u.resourceType,
      target: u.target, cast: u.cast, gcdEnd: u.gcdEnd, cooldowns,
      auras: u.auras.map((a) => ({ id: a.id, kind: a.kind, src: a.sourceId, expiresAt: isFinite(a.expiresAt) ? a.expiresAt : 0 })),
      stealthed: this.isStealthed(u),
      y: u.alive ? Math.round(jumpHeight(this.time - u.jumpStart) * 100) / 100 : 0,
      speedMult: this.speedMult(u),
      controlled: !this.canAct(u),
      autoAttack: u.autoAttack,
      lastSeq: u.lastSeq,
    };
  }

  private emit(e: SimEvent): void {
    this.events.push(e);
  }
}
