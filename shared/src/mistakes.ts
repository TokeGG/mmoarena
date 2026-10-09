import { ABILITIES, AURAS } from './data';
import { hasLOS } from './geometry';
import { BURST_IDS, RANGED } from './bot';
import { DEFAULT_BRAIN, BRAIN_BOUNDS } from './botbrain';
import type { Brain } from './botbrain';
import type { ArenaSim } from './sim';
import type { ClassId, SimEvent, Unit } from './types';
import type { Measure } from './humanstyle';

/**
 * The mistakes a bot can be seen making in a replay, beyond the first eight (kicked casts, dying with a defensive,
 * burst deaths...) that outplay.ts measures. Each has a signal in the replay, a brain number it teaches, and a hook in
 * bot.ts where the number changes what the bot does:
 *
 * | mistake                                                         | teaches                                  |
 * |-----------------------------------------------------------------|------------------------------------------|
 * | locked down (stun, fear, sheep) for 1.5 s with the trinket ready | `trinketAt` up                           |
 * | died with the trinket ready                                      | `trinketAt` up                           |
 * | died with an offensive cooldown still ready                      | `burstUse` up                            |
 * | a caster stood still with melee on it and a push-off ready       | `peelAt` up                              |
 * | an ally died while the healer's shield / Pain Suppression was up | `shieldAt` up, `healAt` up               |
 * | an ally under 40% and the healer idle with a free global         | `healAt` up                              |
 * | heals landing on allies who were nearly full                     | `healCap` down                           |
 * | dropped a target under 30% health for another                    | `switchHp` up                            |
 * | kept hitting a target it could not hit (out of sight, immune)    | `stickiness` down                        |
 * | casts failing for no line of sight                               | `losCheck` up                            |
 * | casts failing for range                                          | `rangeBuffer` up                         |
 * | crowd control into a target already at its diminishing-returns cap | `drRespect` up                          |
 * | out of mana while the fight went on                              | `spendBias` up                           |
 *
 * Not measured, and why: high ground use when kited (needs the arena's height map to say what a better spot was, no
 * clean yes/no), staying near the healer (a team-play movement question with no single mistake to count), crowd control
 * on the wrong target (which target was right is a judgement the replay cannot settle) and an overlapping chain
 * (the sim already refuses most of it).
 */
export type MistakeKind =
  | 'lockedTrinket' | 'diedTrinket' | 'diedBurst' | 'stoodPinned' | 'allyDiedHealer' | 'healIdle' | 'overheal'
  | 'droppedLow' | 'badTarget' | 'castNoLos' | 'castOutOfRange' | 'ccWasted' | 'manaStarved';

export type MistakeCounts = Partial<Record<MistakeKind, number>>;

export const MISTAKE_LABELS: Record<MistakeKind, string> = {
  lockedTrinket: 'locked down with the trinket ready',
  diedTrinket: 'died with the trinket ready',
  diedBurst: 'died with an offensive cooldown ready',
  stoodPinned: 'stood still with melee on it and a push-off ready',
  allyDiedHealer: 'an ally died with the shield or Pain Suppression ready',
  healIdle: 'seconds an ally was under 40% and the healer did nothing',
  overheal: 'heals wasted on allies at full health',
  droppedLow: 'dropped a nearly dead target',
  badTarget: 'kept hitting a target it could not hit',
  castNoLos: 'casts lost to no line of sight',
  castOutOfRange: 'casts lost to range',
  ccWasted: 'crowd control into diminished or immune targets',
  manaStarved: 'seconds out of mana in a fight',
};

/** The legacy counters outplay.ts keeps (labels for the report). */
export const FACT_LABELS = {
  kicked: 'casts kicked',
  juked: 'kicks it threw at fakes',
  diedWithDefensive: 'died with a defensive ready',
  burstDeaths: 'burst deaths',
  bigCastsTaken: 'long casts taken in the open',
  zoneHits: 'hits taken standing in ground effects',
} as const;

const LOCKED = new Set(['stun', 'incapacitate', 'fear']);
const PEELS = ['frost_nova', 'dragons_breath', 'psychic_scream', 'deep_freeze', 'polymorph', 'judgment_hammer', 'ascend', 'blink'];
const TPS = 20;

interface State {
  lockedSince: number | null;
  lockedCounted: boolean;
  trail: { t: number; x: number; z: number }[];
  pinSince: number | null;
  pinQuiet: number;
  lastTarget: number | null;
  badSince: number | null;
  badCounted: boolean;
  idleTicks: number;
  starvedTicks: number;
  lastHealAt: number;
  counts: MistakeCounts;
}

const ready = (u: Unit, id: string, now: number) => u.bar.includes(id) && (u.cooldowns[id] ?? 0) <= now;
const trinketReady = (u: Unit, now: number) => !!u.trinket && (u.cooldowns[u.trinket] ?? 0) <= now;

/**
 * Watches each bot of a replay, tick by tick, for the mistakes above. `kinds` says who is a person and who a bot.
 * Feed it every live tick (`tick`, after the sim stepped) and every event of that step (`event`).
 */
export class MistakeWatch {
  private st = new Map<number, State>();

  constructor(private kinds: Map<number, 'human' | 'bot' | 'other'>, bots: number[]) {
    for (const id of bots) this.st.set(id, { lockedSince: null, lockedCounted: false, trail: [], pinSince: null, pinQuiet: 0, lastTarget: null, badSince: null, badCounted: false, idleTicks: 0, starvedTicks: 0, lastHealAt: -1e9, counts: {} });
  }

  counts(id: number): MistakeCounts {
    return this.st.get(id)?.counts ?? {};
  }

  private add(s: State, k: MistakeKind, n = 1) {
    s.counts[k] = (s.counts[k] ?? 0) + n;
  }

  tick(sim: ArenaSim): void {
    const now = sim.time;
    for (const [id, s] of this.st) {
      const me = sim.units.get(id);
      if (!me?.alive) {
        s.lockedSince = null;
        s.pinSince = null;
        s.badSince = null;
        continue;
      }
      const foes = [...sim.units.values()].filter((e) => e.alive && e.team !== me.team);
      const humanFoes = foes.filter((e) => this.kinds.get(e.id) === 'human');
      if (!humanFoes.length) continue;

      // (a) locked down with the trinket (its cleanse frees a stun, fear or sheep) ready
      const locked = me.auras.some((a) => LOCKED.has(a.kind) && AURAS[a.id]?.harmful);
      if (locked) {
        s.lockedSince ??= now;
        if (!s.lockedCounted && now - s.lockedSince >= 1500 && me.trinket === 'trinket_cleanse' && trinketReady(me, now)) {
          this.add(s, 'lockedTrinket');
          s.lockedCounted = true;
        }
      } else {
        s.lockedSince = null;
        s.lockedCounted = false;
      }

      // (c) a caster standing still with melee on it, push-off ready
      s.trail.push({ t: now, x: me.pos.x, z: me.pos.z });
      while (s.trail.length && now - s.trail[0].t > 2000) s.trail.shift();
      s.pinQuiet = Math.max(0, s.pinQuiet - sim.tickMs);
      if (RANGED[me.classId]) {
        const on = humanFoes.some((e) => (e.classId === 'warrior' || e.classId === 'rogue') && Math.hypot(e.pos.x - me.pos.x, e.pos.z - me.pos.z) <= 6 && e.target === me.id);
        const still = s.trail.length > 1 && now - s.trail[0].t >= 1800 && Math.hypot(me.pos.x - s.trail[0].x, me.pos.z - s.trail[0].z) < 1.5;
        if (on && still && s.pinQuiet === 0 && sim.canAct(me) && PEELS.some((p) => ready(me, p, now))) {
          this.add(s, 'stoodPinned');
          s.pinQuiet = 4000;
        }
      }

      // (e) the healer: an ally under 40% and nothing done with a free global cooldown
      if (me.classId === 'priest') {
        const lowAlly = [...sim.units.values()].some((a) => a.alive && a.team === me.team && a.health / a.maxHealth < 0.4 && Math.hypot(a.pos.x - me.pos.x, a.pos.z - me.pos.z) <= 36 && hasLOS(me.pos, a.pos, sim.arena, me.level, a.level));
        if (lowAlly && !me.cast && sim.canAct(me) && now >= me.gcdEnd && now - s.lastHealAt > 1000 && foes.some((e) => Math.hypot(e.pos.x - me.pos.x, e.pos.z - me.pos.z) < 45)) {
          s.idleTicks++;
          if (s.idleTicks >= TPS) {
            this.add(s, 'healIdle');
            s.idleTicks = 0;
          }
        } else s.idleTicks = Math.max(0, s.idleTicks - 1);
      }

      // (h) target switching: dropped a nearly dead one, or kept hitting what it could not hit
      const t = me.target !== null ? sim.units.get(me.target) : undefined;
      if (s.lastTarget !== null && me.target !== s.lastTarget && me.target !== null) {
        const old = sim.units.get(s.lastTarget);
        if (old?.alive && old.team !== me.team && this.kinds.get(old.id) === 'human' && old.health / old.maxHealth <= 0.3 && Math.hypot(old.pos.x - me.pos.x, old.pos.z - me.pos.z) <= 30 && !old.auras.some((a) => AURAS[a.id]?.invulnerable)) this.add(s, 'droppedLow');
      }
      s.lastTarget = me.target;
      if (t?.alive && t.team !== me.team && this.kinds.get(t.id) === 'human') {
        const bad = t.auras.some((a) => AURAS[a.id]?.invulnerable) || !hasLOS(me.pos, t.pos, sim.arena, me.level, t.level);
        if (bad) {
          s.badSince ??= now;
          if (!s.badCounted && now - s.badSince >= 3000) {
            this.add(s, 'badTarget');
            s.badCounted = true;
          }
        } else {
          s.badSince = null;
          s.badCounted = false;
        }
      } else {
        s.badSince = null;
        s.badCounted = false;
      }

      // (g) mana: empty in the middle of a fight
      if (me.resourceType === 'mana' && me.resource < me.resourceMax * 0.08 && humanFoes.some((e) => Math.hypot(e.pos.x - me.pos.x, e.pos.z - me.pos.z) < 40)) {
        s.starvedTicks++;
        if (s.starvedTicks >= TPS) {
          this.add(s, 'manaStarved');
          s.starvedTicks = 0;
        }
      }
    }
  }

  event(sim: ArenaSim, ev: SimEvent): void {
    const now = sim.time;
    switch (ev.t) {
      case 'cast_fail': {
        const s = this.st.get(ev.unit);
        if (!s) break;
        if (ev.reason === 'no line of sight' || ev.reason === 'target not visible') this.add(s, 'castNoLos');
        else if (ev.reason === 'out of range') this.add(s, 'castOutOfRange');
        break;
      }
      case 'immune': {
        const s = this.st.get(ev.src);
        if (s && AURAS[ev.aura]?.dr && AURAS[ev.aura]?.harmful && this.kinds.get(ev.tgt) === 'human') this.add(s, 'ccWasted');
        break;
      }
      case 'aura': {
        // crowd control that landed at a quarter of its length or less was thrown into diminishing returns
        const s = this.st.get(ev.src);
        if (s && AURAS[ev.aura]?.dr && AURAS[ev.aura]?.harmful && ev.dr > 0 && ev.dr <= 0.26 && this.kinds.get(ev.tgt) === 'human') this.add(s, 'ccWasted');
        break;
      }
      case 'heal': {
        const s = this.st.get(ev.src);
        if (s) {
          s.lastHealAt = now;
          const tgt = sim.units.get(ev.tgt);
          // at least 70% of the heal was wasted on an ally who was nearly full
          if (tgt && tgt.team === sim.units.get(ev.src)?.team && ev.overheal >= (ev.amount + ev.overheal) * 0.7 && ev.overheal > 0 && ev.ability !== 'cauterize') this.add(s, 'overheal');
        }
        break;
      }
      case 'death': {
        const me = sim.units.get(ev.unit);
        const s = this.st.get(ev.unit);
        if (s && me) {
          if (trinketReady(me, now)) this.add(s, 'diedTrinket');
          if (BURST_IDS.some((id) => ready(me, id, now))) this.add(s, 'diedBurst');
        }
        // a teammate of a healer bot died while the healer held a shield or Pain Suppression
        if (me) {
          for (const [hid, hs] of this.st) {
            if (hid === ev.unit) continue;
            const healer = sim.units.get(hid);
            if (!healer?.alive || healer.classId !== 'priest' || healer.team !== me.team) continue;
            if ((ready(healer, 'pain_suppression', now) || ready(healer, 'power_word_shield', now)) && sim.canAct(healer)) this.add(hs, 'allyDiedHealer');
          }
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------- lessons

export type LessonSet = Partial<Record<keyof Brain, Measure>>;

/** How far towards its extreme a lesson's value moves with `n` mistakes: one nudges, a handful nearly gets there. */
export const saturate = (n: number) => 1 - Math.exp(-n / 3);

const clampK = (k: keyof Brain, v: number) => Math.min(BRAIN_BOUNDS[k][1], Math.max(BRAIN_BOUNDS[k][0], v));

/**
 * What the counted mistakes teach. The value is the default moved towards the extreme by `saturate(count)` (so more
 * mistakes mean a larger step, never past the bound), and the weight is count times 20 (times 1.5 for a loss, 0.5 for a
 * win, as in outplay.ts). Call with `m` already chosen by the caller.
 */
export function mistakeLessons(c: MistakeCounts, classId: ClassId, m: number): LessonSet {
  const L: LessonSet = {};
  const put = (k: keyof Brain, to: number, n: number, perWeight = 20) => {
    if (n <= 0) return;
    const from = DEFAULT_BRAIN[k];
    const value = clampK(k, from + (to - from) * saturate(n));
    const weight = n * perWeight * m;
    const old = L[k];
    // two mistakes pointing at one number: the heavier evidence sets the value, the weights add up
    L[k] = old ? { value: old.weight >= weight ? old.value : value, weight: old.weight + weight } : { value, weight };
  };
  const n = (k: MistakeKind) => c[k] ?? 0;
  put('trinketAt', 1, n('lockedTrinket') + n('diedTrinket'));
  put('burstUse', 1, n('diedBurst'));
  put('peelAt', 1, n('stoodPinned'));
  if (classId === 'priest') {
    put('shieldAt', 0.7, n('allyDiedHealer'));
    put('healAt', 1.25, n('allyDiedHealer') + n('healIdle'), 12);
    put('healCap', 0.8, n('overheal'), 8);
  }
  put('switchHp', 0.35, n('droppedLow'));
  put('stickiness', 2, n('badTarget'));
  put('losCheck', 1, n('castNoLos'), 10);
  put('rangeBuffer', 2.5, n('castOutOfRange'), 10);
  put('drRespect', 0.9, n('ccWasted'));
  if (classId === 'mage' || classId === 'priest') put('spendBias', 1, n('manaStarved'));
  return L;
}
