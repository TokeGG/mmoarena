import { ABILITIES, AURAS } from './data';
import { RANGED } from './bot';
import { BRAIN_BOUNDS, clampBrain } from './botbrain';
import type { Brain } from './botbrain';
import { ReplayRunner } from './replay';
import type { ReplayData } from './replay';
import type { ClassId } from './types';

/**
 * Learning from people: a finished match's replay is played back and what each human actually did (how much they
 * sidestep, how far they stand from the target, how low their health is when they use a defensive, who they hit,
 * whether they focus the same target as their team) becomes a measurement of the matching bot-brain numbers.
 * The server folds those into a per-class running average and gives the bots a "human style" brain to try.
 */
/** Any learnable brain number: people's habits and the lessons of how bots got outplayed use the same samples. */
export type StyleKey = keyof Brain;
export interface Measure { value: number; /** Seconds of play (or ten per defensive use) behind the number. */ weight: number }
export type StyleSample = Partial<Record<StyleKey, Measure>>;
export type HumanStyle = Partial<Record<StyleKey, Measure>>;

/** Abilities a player uses to survive: shields, damage reduction, stealth escapes, self heals. */
export function isDefensive(id: string): boolean {
  const a = ABILITIES[id];
  if (!a || (a.target !== 'self' && a.target !== 'ally_or_self')) return false;
  return a.effects.some((e) => {
    if (e.type === 'heal' || e.type === 'healMissing' || e.type === 'healMax') return true;
    if (e.type !== 'aura') return false;
    const d = AURAS[e.aura];
    return !!d && (d.kind === 'absorb' || d.kind === 'stealth' || (d.mods?.damageTaken !== undefined && d.mods.damageTaken < 1));
  });
}

/** What every human in this recording did, one sample per human unit. */
export function measureHumans(data: ReplayData): { classId: ClassId; sample: StyleSample }[] {
  const humans = data.units.map((u, i) => ({ id: i + 1, u })).filter((x) => x.u.controller === 'player' || x.u.controller === undefined);
  if (!humans.length) return [];
  const defAt = new Map<number, number[]>(); // tick -> unit ids that used a defensive
  for (const c of data.cmds) if (c[1] === 2 && humans.some((h) => h.id === c[2]) && typeof c[3] === 'string' && isDefensive(c[3])) defAt.set(c[0], [...(defAt.get(c[0]) ?? []), c[2]]);
  type Acc = { engaged: number; strafed: number; dist: number; priestTicks: number; priestHits: number; allyTicks: number; focusHits: number; def: number[] };
  const acc = new Map<number, Acc>(humans.map((h) => [h.id, { engaged: 0, strafed: 0, dist: 0, priestTicks: 0, priestHits: 0, allyTicks: 0, focusHits: 0, def: [] }]));
  const runner = new ReplayRunner(data);
  while (!runner.done) {
    const sim = runner.sim;
    if (sim.phase === 'live') {
      for (const [id, uses] of [...defAt.entries()].filter(([t]) => t === runner.tick).flatMap(([, ids]) => ids.map((i) => [i, 1] as const))) {
        const me = sim.units.get(id);
        if (me?.alive) acc.get(id)!.def.push(me.health / me.maxHealth);
        void uses;
      }
      for (const h of humans) {
        const me = sim.units.get(h.id);
        const a = acc.get(h.id)!;
        if (!me?.alive || me.target === null) continue;
        const tgt = sim.units.get(me.target);
        if (!tgt || !tgt.alive || tgt.team === me.team) continue;
        const d = Math.hypot(tgt.pos.x - me.pos.x, tgt.pos.z - me.pos.z);
        if (d > 40) continue;
        a.engaged++;
        if (me.lastInput.strafe !== 0) a.strafed++;
        a.dist += d;
        const foes = [...sim.units.values()].filter((x) => x.alive && x.team !== me.team);
        const priest = foes.find((x) => x.classId === 'priest');
        if (priest && foes.length >= 2) {
          a.priestTicks++;
          if (me.target === priest.id) a.priestHits++;
        }
        const mates = [...sim.units.values()].filter((x) => x.alive && x.team === me.team && x.id !== me.id && x.target !== null);
        if (mates.length) {
          a.allyTicks++;
          if (mates.some((x) => x.target === me.target)) a.focusHits++;
        }
      }
    }
    runner.step();
  }
  const tps = 20;
  return humans.map((h) => {
    const a = acc.get(h.id)!;
    const s: StyleSample = {};
    if (a.engaged >= 10 * tps) {
      s.strafe = { value: a.strafed / a.engaged, weight: a.engaged / tps };
      const r = RANGED[h.u.classId];
      if (r) s.rangeBias = { value: a.dist / a.engaged - (r.min + r.max) / 2, weight: a.engaged / tps };
    }
    if (a.priestTicks >= 5 * tps) s.healerPrio = { value: (a.priestHits / a.priestTicks) * BRAIN_BOUNDS.healerPrio[1], weight: a.priestTicks / tps };
    if (a.allyTicks >= 5 * tps) s.focus = { value: (a.focusHits / a.allyTicks) * BRAIN_BOUNDS.focus[1], weight: a.allyTicks / tps };
    if (a.def.length) s.defHp = { value: a.def.reduce((x, y) => x + y, 0) / a.def.length, weight: a.def.length * 10 };
    return { classId: h.u.classId, sample: s };
  });
}

/** Weight above which the running average stops growing, so the style keeps following how people play now. */
export const STYLE_CAP = 1200;

export function mergeStyle(style: HumanStyle, sample: StyleSample): HumanStyle {
  const out: HumanStyle = { ...style };
  for (const k of Object.keys(sample) as StyleKey[]) {
    const s = sample[k]!;
    const old = out[k];
    const w = (old?.weight ?? 0) + s.weight;
    out[k] = { value: old ? (old.value * old.weight + s.value * s.weight) / w : s.value, weight: Math.min(STYLE_CAP, w) };
  }
  return out;
}

/**
 * The base brain pulled towards what the evidence says: more as it grows, never all the way. `pull` is how far full
 * evidence moves it, `full` the weight at which the evidence counts in full.
 */
export function styledBrain(base: Brain, style: HumanStyle, pull = 0.7, full = 300): Brain {
  const out: Partial<Brain> = { ...base };
  for (const k of Object.keys(style) as StyleKey[]) {
    const m = style[k]!;
    if (!m || m.weight < 30 || !(k in base)) continue;
    const f = pull * Math.min(1, m.weight / full);
    out[k] = base[k] + (m.value - base[k]) * f;
  }
  return clampBrain(out);
}
