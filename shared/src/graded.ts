import { ABILITIES } from './data';
import { hasLOS, inLava } from './geometry';
import { BURST_IDS, RANGED } from './bot';
import { isDefensive } from './humanstyle';
import type { Brain } from './botbrain';
import type { ArenaSim } from './sim';
import type { ClassId, SimEvent, Unit } from './types';

/**
 * Graded signals: not "was there a mistake" but "how does this bot play compared with the person who beat it", as rates
 * and margins, measured the same way for both. Every fight a bot spends in teaches something this way, whether or not it
 * made one of the countable mistakes (mistakes.ts): a bot that stood still more than the winner, sat in the open more,
 * kept further from its target, left its healer more, burned in lava, let burst cooldowns idle, defended later, switched
 * targets more often, gets each number nudged a small step towards how the person played.
 */
export interface Graded {
  /** Seconds in a fight (a living unit with an enemy target within 40 yards). */
  sec: number;
  /** Share of fight time spent standing still (under half a yard a second). */
  still: number;
  /** Share of fight time an enemy had a line of sight to it (in the open, not behind cover). */
  exposed: number;
  /** Times a minute it broke an enemy's line of sight (stepped behind something). */
  losBreaks: number;
  /** Share of fight time it moved sideways. */
  strafed: number;
  /** Average distance to its target, yards. */
  dist: number;
  /** Share of fight time out of its healer partner's reach (over 36 yards, or out of sight); 0 without a healer partner. */
  healerOut: number;
  /** Seconds standing in lava. */
  lava: number;
  /** Share of fight time an offensive cooldown sat ready with the enemy in reach. */
  cdIdle: number;
  /** Mean health fraction at which it pressed a defensive (null when it never did). */
  defHp: number | null;
  /** Health fraction at which it used the trinket (null when it never did). */
  trinketHp: number | null;
  /** Target changes a minute. */
  switches: number;
}

export const EMPTY_GRADED: Graded = { sec: 0, still: 0, exposed: 0, losBreaks: 0, strafed: 0, dist: 0, healerOut: 0, lava: 0, cdIdle: 0, defHp: null, trinketHp: null, switches: 0 };

interface Acc {
  ticks: number; still: number; exposed: number; losBreaks: number; strafed: number; dist: number; healerTicks: number; healerOut: number; lava: number; cdIdle: number;
  def: number[]; trinket: number[]; switches: number;
  last: { x: number; z: number } | null; wasExposed: boolean; target: number | null;
}

const fresh = (): Acc => ({ ticks: 0, still: 0, exposed: 0, losBreaks: 0, strafed: 0, dist: 0, healerTicks: 0, healerOut: 0, lava: 0, cdIdle: 0, def: [], trinket: [], switches: 0, last: null, wasExposed: false, target: null });
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export class GradedWatch {
  private acc = new Map<number, Acc>();

  constructor(ids: number[]) {
    for (const id of ids) this.acc.set(id, fresh());
  }

  tick(sim: ArenaSim): void {
    const dt = sim.tickMs / 1000;
    for (const [id, a] of this.acc) {
      const me = sim.units.get(id);
      if (!me?.alive) {
        a.last = null;
        continue;
      }
      const tgt = me.target !== null ? sim.units.get(me.target) : undefined;
      const fighting = !!tgt && tgt.alive && tgt.team !== me.team && Math.hypot(tgt.pos.x - me.pos.x, tgt.pos.z - me.pos.z) <= 40;
      const moved = a.last ? Math.hypot(me.pos.x - a.last.x, me.pos.z - a.last.z) / dt : 99;
      a.last = { x: me.pos.x, z: me.pos.z };
      if (me.level === 0 && inLava(sim.arena, me.pos)) a.lava += dt;
      if (!fighting) {
        a.target = me.target;
        continue;
      }
      a.ticks++;
      if (moved < 0.5) a.still++;
      if (me.lastInput.strafe !== 0) a.strafed++;
      a.dist += Math.hypot(tgt!.pos.x - me.pos.x, tgt!.pos.z - me.pos.z);
      const seen = [...sim.units.values()].some((e) => e.alive && e.team !== me.team && hasLOS(e.pos, me.pos, sim.arena, e.level, me.level));
      if (seen) a.exposed++;
      else if (a.wasExposed) a.losBreaks++;
      a.wasExposed = seen;
      if (a.target !== null && me.target !== a.target) a.switches++;
      a.target = me.target;
      const healer = [...sim.units.values()].find((x) => x.alive && x.team === me.team && x.id !== me.id && x.classId === 'priest');
      if (healer && me.classId !== 'priest') {
        a.healerTicks++;
        if (Math.hypot(healer.pos.x - me.pos.x, healer.pos.z - me.pos.z) > 36 || !hasLOS(me.pos, healer.pos, sim.arena, me.level, healer.level)) a.healerOut++;
      }
      const reach = RANGED[me.classId] ? 30 : 9;
      if (Math.hypot(tgt!.pos.x - me.pos.x, tgt!.pos.z - me.pos.z) <= reach && BURST_IDS.some((b) => me.bar.includes(b) && (me.cooldowns[b] ?? 0) <= sim.time)) a.cdIdle++;
    }
  }

  event(sim: ArenaSim, ev: SimEvent): void {
    if (ev.t !== 'cast') return;
    const a = this.acc.get(ev.unit);
    const me = sim.units.get(ev.unit);
    if (!a || !me) return;
    const hp = me.health / me.maxHealth;
    if (me.trinket === ev.ability) a.trinket.push(hp);
    else if (isDefensive(ev.ability) && (ABILITIES[ev.ability]?.cooldown ?? 0) >= 10000) a.def.push(hp);
  }

  graded(id: number): Graded {
    const a = this.acc.get(id);
    if (!a || a.ticks === 0) return { ...EMPTY_GRADED };
    const sec = a.ticks * 0.05;
    return {
      sec, still: a.still / a.ticks, exposed: a.exposed / a.ticks, losBreaks: a.losBreaks / (sec / 60), strafed: a.strafed / a.ticks, dist: a.dist / a.ticks,
      healerOut: a.healerTicks ? a.healerOut / a.healerTicks : 0, lava: a.lava, cdIdle: a.cdIdle / a.ticks, defHp: mean(a.def), trinketHp: mean(a.trinket), switches: a.switches / (sec / 60),
    };
  }
}

/** Average of several people's graded numbers (weighted by their time in a fight). */
export function averageGraded(list: Graded[]): Graded | null {
  const live = list.filter((g) => g.sec > 0);
  if (!live.length) return null;
  const w = live.reduce((n, g) => n + g.sec, 0);
  const avg = (f: (g: Graded) => number) => live.reduce((n, g) => n + f(g) * g.sec, 0) / w;
  const opt = (f: (g: Graded) => number | null) => {
    const xs = live.map(f).filter((x): x is number => x !== null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  return {
    sec: w, still: avg((g) => g.still), exposed: avg((g) => g.exposed), losBreaks: avg((g) => g.losBreaks), strafed: avg((g) => g.strafed), dist: avg((g) => g.dist),
    healerOut: avg((g) => g.healerOut), lava: avg((g) => g.lava), cdIdle: avg((g) => g.cdIdle), defHp: opt((g) => g.defHp), trinketHp: opt((g) => g.trinketHp), switches: avg((g) => g.switches),
  };
}

/** One small adjustment a comparison asks for: which numbers (the first that is not at a limit moves), which way, how strongly. */
export interface Nudge {
  metric: string;
  /** In words: what the bot did against what the person did. */
  why: string;
  keys: (keyof Brain)[];
  sign: 1 | -1;
  /** 0.2..1: how far apart the two were, against the scale of that measure. */
  strength: number;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const yd = (x: number) => `${x.toFixed(1)} yd`;

/**
 * The comparisons of a bot with the people it fought. Every difference above a small floor becomes a nudge, so a fight of
 * any length that was played differently from how the person played teaches something; only a bot that played exactly
 * like the person (or had no fight at all) teaches nothing.
 */
export function gradedNudges(bot: Graded, people: Graded, classId: ClassId): Nudge[] {
  const out: Nudge[] = [];
  if (bot.sec < 8 || people.sec < 8) return out;
  const add = (metric: string, delta: number, scale: number, keysUp: (keyof Brain)[], keysDown: (keyof Brain)[], why: string) => {
    if (Math.abs(delta) < 0.06 * scale) return;
    const keys = delta > 0 ? keysUp : keysDown;
    if (!keys.length) return;
    out.push({ metric, why, keys, sign: delta > 0 ? 1 : -1, strength: Math.min(1, Math.max(0.2, Math.abs(delta) / scale)) });
  };
  // movement
  add('standing still', bot.still - people.still, 0.5, ['mobility', 'strafe'], ['mobility'], `stood still ${pct(bot.still)} of the fight, the people ${pct(people.still)}`);
  add('time in the open', bot.exposed - people.exposed, 0.5, ['coverHp', 'losUse'], ['losUse'], `in an enemy's sight ${pct(bot.exposed)} of the fight, the people ${pct(people.exposed)}`);
  add('line-of-sight breaks', people.losBreaks - bot.losBreaks, 4, ['losUse'], ['losUse'], `broke sight ${bot.losBreaks.toFixed(1)} times a minute, the people ${people.losBreaks.toFixed(1)}`);
  add('sidestepping', people.strafed - bot.strafed, 0.4, ['strafe'], ['strafe'], `moved sideways ${pct(bot.strafed)} of the fight, the people ${pct(people.strafed)}`);
  if (RANGED[classId]) add('spacing', people.dist - bot.dist, 8, ['rangeBias'], ['rangeBias'], `stood ${yd(bot.dist)} from its target, the people ${yd(people.dist)}`);
  else add('chasing', bot.dist - people.dist, 4, ['chase', 'mobility'], ['chase'], `stood ${yd(bot.dist)} from its target, the people ${yd(people.dist)}`);
  add('staying near the healer', bot.healerOut - people.healerOut, 0.3, ['stayNear'], ['stayNear'], `out of its healer's reach ${pct(bot.healerOut)} of the fight, the people ${pct(people.healerOut)}`);
  add('lava', bot.lava - people.lava, 1, ['edgeCare'], [], `${bot.lava.toFixed(1)}s in lava, the people ${people.lava.toFixed(1)}s`);
  // gameplay
  add('offensive cooldowns', bot.cdIdle - people.cdIdle, 0.4, ['burstUse', 'burstHp'], [], `held a cooldown ready ${pct(bot.cdIdle)} of the fight, the people ${pct(people.cdIdle)}`);
  if (bot.defHp !== null || people.defHp !== null) {
    const b = bot.defHp ?? 0;
    const h = people.defHp ?? 0;
    add('defensive timing', h - b, 0.25, ['defHp', 'panicHp'], ['defHp'], `pressed defensives at ${pct(b)} health${bot.defHp === null ? ' (never)' : ''}, the people at ${pct(h)}${people.defHp === null ? ' (never)' : ''}`);
  }
  add('target switching', bot.switches - people.switches, 6, ['stickiness', 'switchHp'], ['stickiness'], `changed target ${bot.switches.toFixed(1)} times a minute, the people ${people.switches.toFixed(1)}`);
  if (bot.trinketHp !== null || people.trinketHp !== null) {
    const b = bot.trinketHp ?? 0;
    const h = people.trinketHp ?? 0;
    add('trinket use', h - b, 0.3, ['trinketAt'], ['trinketAt'], `used the trinket at ${pct(b)} health${bot.trinketHp === null ? ' (never)' : ''}, the people at ${pct(h)}${people.trinketHp === null ? ' (never)' : ''}`);
  }
  return out;
}
