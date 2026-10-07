import { ABILITIES } from './data';
import { hasLOS } from './geometry';
import { RANGED } from './bot';
import { BRAIN_BOUNDS } from './botbrain';
import type { Brain } from './botbrain';
import { isDefensive, measureHumans } from './humanstyle';
import type { Measure } from './humanstyle';
import { ReplayRunner } from './replay';
import type { ReplayData } from './replay';
import type { ClassId, Unit } from './types';

/**
 * Learning from how bots get outplayed. A finished match against people is played back, and every way a person beat a
 * bot becomes evidence for one of its brain numbers:
 *
 * | what the replay shows                                               | the lesson                                   |
 * |---------------------------------------------------------------------|----------------------------------------------|
 * | its casts get kicked while a kick is ready on it                    | fake more casts (`jukeChance`)               |
 * | people kick its casts at a certain point                            | stop a fake before then (`jukeAt`)           |
 * | its kicks hit nothing after a person faked                          | kick later, past their fakes (`kickAt`)      |
 * | it dies with a defensive still ready (and could have pressed it)    | defend earlier (`defHp`, `panicHp`)          |
 * | it dies to a burst it did not react to                              | treat smaller bursts as danger (`dangerAt`)  |
 * | long casts land on it again and again                               | use pillars more (`losUse`)                  |
 * | it keeps standing in ground effects                                 | walk out sooner (`dodge`)                    |
 * | a melee bot is kited / a caster bot is pinned by melee              | chase, keep moving, keep range               |
 *
 * Losses to people count three times as much as wins: the point is what people do that beats the bots. The same pass
 * also measures how the people themselves kick and fake, so offline training can play against something like them.
 */
export type Lessons = Partial<Record<keyof Brain, Measure>>;

export interface BotStudy {
  unitId: number;
  classId: ClassId;
  /** Classes of the people it fought. */
  foes: ClassId[];
  won: boolean;
  lessons: Lessons;
  /** What the replay saw, for reports. */
  facts: { castsUnderThreat: number; kicked: number; juked: number; kicksLanded: number; diedWithDefensive: number; burstDeaths: number; bigCastsTaken: number; zoneHits: number; engagedSec: number; kitedFrac: number; pinnedFrac: number };
}

export interface PlayerHabits {
  unitId: number;
  classId: ClassId;
  /** Kick timing (fraction into the cast) and fakes (fraction at which they stopped), as brain-number samples. */
  sample: Lessons;
}

export interface MatchStudy {
  bots: BotStudy[];
  players: PlayerHabits[];
}

const MELEE = new Set<ClassId>(['warrior', 'rogue']);
const FAKE_REASONS = new Set(['moved', 'cancelled', 'switched spell']);
const LOCKED = new Set(['stun', 'incapacitate', 'fear']);
const TPS = 20;

const clampK = (k: keyof Brain, v: number) => Math.min(BRAIN_BOUNDS[k][1], Math.max(BRAIN_BOUNDS[k][0], v));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const interruptsOf = (u: Unit) => u.bar.filter((id) => ABILITIES[id]?.effects.some((e) => e.type === 'interrupt'));
const isHuman = (o: ReplayData['units'][number]) => o.controller === 'player' || o.controller === undefined;

/** Play a match back and say what each bot should learn from it, and how its people kick and fake. */
export function studyMatch(data: ReplayData): MatchStudy {
  const kinds = new Map<number, 'human' | 'bot' | 'other'>(data.units.map((u, i) => [i + 1, isHuman(u) ? 'human' : u.controller === 'bot' ? 'bot' : 'other']));
  const bots = [...kinds].filter(([, k]) => k === 'bot').map(([id]) => id);
  const humans = [...kinds].filter(([, k]) => k === 'human').map(([id]) => id);
  if (!bots.length || !humans.length) return { bots: [], players: [] };

  type BotAcc = {
    castsUnderThreat: number; kicked: number; kickedByThreat: number; kickFracs: number[]; juked: number; kicksLanded: number;
    diedWithDefensive: number; burstDeaths: number; deaths: number; bigCastsTaken: number; zoneHits: number;
    engaged: number; kited: number; pinned: number; hp: number[];
  };
  const acc = new Map<number, BotAcc>(bots.map((id) => [id, { castsUnderThreat: 0, kicked: 0, kickedByThreat: 0, kickFracs: [], juked: 0, kicksLanded: 0, diedWithDefensive: 0, burstDeaths: 0, deaths: 0, bigCastsTaken: 0, zoneHits: 0, engaged: 0, kited: 0, pinned: 0, hp: [] }]));
  type HumanAcc = { kickFracs: number[]; fakeFracs: number[]; castsUnderThreat: number; fakesUnderThreat: number };
  const hacc = new Map<number, HumanAcc>(humans.map((id) => [id, { kickFracs: [], fakeFracs: [], castsUnderThreat: 0, fakesUnderThreat: 0 }]));

  const runner = new ReplayRunner(data);
  /** The cast each unit had going before this tick, and whether a kick was ready on it when it started. */
  const casts = new Map<number, { ability: string; start: number; end: number; threat: boolean }>();
  /** When each human last stopped a cast short (for "the bot's kick hit nothing after a fake"). */
  const fakedAt = new Map<number, number>();

  const kickReadyOn = (sim: ArenaSimLike, u: Unit, byKind: 'human' | 'bot') => {
    for (const e of sim.units.values()) {
      if (e.team === u.team || !e.alive || kinds.get(e.id) !== byKind || !sim.canAct(e)) continue;
      for (const id of interruptsOf(e)) {
        if ((e.cooldowns[id] ?? 0) > sim.time) continue;
        if (Math.hypot(e.pos.x - u.pos.x, e.pos.z - u.pos.z) <= ABILITIES[id].range + 2.5 && hasLOS(e.pos, u.pos, sim.arena, e.level, u.level)) return true;
      }
    }
    return false;
  };

  while (!runner.done) {
    const sim = runner.sim;
    const live = sim.phase === 'live';
    // casts as they were before this tick: an interrupt or a stop in this tick is measured against them
    for (const u of sim.units.values()) {
      const c = u.cast;
      const def = c ? ABILITIES[c.ability] : undefined;
      if (!c || !def || def.castTime <= 0 || def.channel) {
        casts.delete(u.id);
        continue;
      }
      const known = casts.get(u.id);
      if (known && known.start === c.start && known.ability === c.ability) continue;
      const k = kinds.get(u.id);
      const threat = live && (k === 'bot' ? kickReadyOn(sim, u, 'human') : k === 'human' ? kickReadyOn(sim, u, 'bot') : false);
      casts.set(u.id, { ability: c.ability, start: c.start, end: c.end, threat });
      if (threat && k === 'bot') acc.get(u.id)!.castsUnderThreat++;
      if (threat && k === 'human') hacc.get(u.id)!.castsUnderThreat++;
    }
    const before = new Map(casts);
    const events = runner.step();
    if (!live) continue;
    const now = sim.time;
    for (const ev of events) {
      switch (ev.t) {
        case 'interrupt': {
          const c = before.get(ev.tgt);
          const frac = c ? Math.min(1, Math.max(0, (now - c.start) / Math.max(1, c.end - c.start))) : null;
          if (kinds.get(ev.src) === 'human' && kinds.get(ev.tgt) === 'bot') {
            const a = acc.get(ev.tgt)!;
            a.kicked++;
            if (c?.threat) a.kickedByThreat++;
            if (frac !== null) {
              a.kickFracs.push(frac);
              hacc.get(ev.src)!.kickFracs.push(frac);
            }
          }
          if (kinds.get(ev.src) === 'bot' && kinds.get(ev.tgt) === 'human') acc.get(ev.src)!.kicksLanded++;
          break;
        }
        case 'miss':
          // a bot's kick that found nothing, just after the person it aimed at stopped a cast short: it was juked
          if (kinds.get(ev.src) === 'bot' && kinds.get(ev.tgt) === 'human' && now - (fakedAt.get(ev.tgt) ?? -1e9) <= 900) acc.get(ev.src)!.juked++;
          break;
        case 'cast_fail': {
          if (kinds.get(ev.unit) !== 'human' || !FAKE_REASONS.has(ev.reason)) break;
          const c = before.get(ev.unit);
          if (!c) break;
          const frac = (now - c.start) / Math.max(1, c.end - c.start);
          if (frac >= 0.95) break;
          fakedAt.set(ev.unit, now);
          const h = hacc.get(ev.unit)!;
          h.fakeFracs.push(frac);
          if (c.threat) h.fakesUnderThreat++;
          break;
        }
        case 'cast': {
          // a long cast from a person that landed on a bot: it could have stepped out of sight
          const def = ABILITIES[ev.ability];
          if (kinds.get(ev.unit) === 'human' && kinds.get(ev.target) === 'bot' && def && def.castTime >= 1500 && !def.channel) acc.get(ev.target)!.bigCastsTaken++;
          break;
        }
        case 'damage':
          if (kinds.get(ev.src) === 'human' && kinds.get(ev.tgt) === 'bot' && ev.ability && ABILITIES[ev.ability]?.target === 'ground') acc.get(ev.tgt)!.zoneHits++;
          break;
        case 'death': {
          if (kinds.get(ev.unit) !== 'bot') break;
          const me = sim.units.get(ev.unit)!;
          const a = acc.get(ev.unit)!;
          a.deaths++;
          // a defensive that was ready, while it was free to press it: it waited too long
          const free = !me.auras.some((x) => LOCKED.has(x.kind));
          // only real cooldowns count (a 10 s or longer one): a priest's ordinary heal is always "ready"
          if (free && me.bar.some((id) => isDefensive(id) && ABILITIES[id].cooldown >= 10000 && (me.cooldowns[id] ?? 0) <= now)) a.diedWithDefensive++;
          const hp3 = a.hp.length ? Math.max(...a.hp) : me.maxHealth;
          if (hp3 / me.maxHealth >= 0.55) a.burstDeaths++; // more than half its health went in the last three seconds
          break;
        }
      }
    }
    for (const id of bots) {
      const me = sim.units.get(id);
      const a = acc.get(id)!;
      if (!me?.alive) continue;
      a.hp.push(me.health);
      if (a.hp.length > 3 * TPS) a.hp.shift();
      const tgt = me.target !== null ? sim.units.get(me.target) : undefined;
      if (!tgt?.alive || tgt.team === me.team || kinds.get(tgt.id) !== 'human') continue;
      const d = Math.hypot(tgt.pos.x - me.pos.x, tgt.pos.z - me.pos.z);
      if (d > 40) continue;
      a.engaged++;
      if (MELEE.has(me.classId) && d > 5.5) a.kited++;
      if (RANGED[me.classId] && [...sim.units.values()].some((e) => e.alive && e.team !== me.team && kinds.get(e.id) === 'human' && MELEE.has(e.classId) && Math.hypot(e.pos.x - me.pos.x, e.pos.z - me.pos.z) <= 6)) a.pinned++;
    }
  }

  const sim = runner.sim;
  const out: MatchStudy = { bots: [], players: [] };
  for (const id of bots) {
    const me = sim.units.get(id)!;
    const a = acc.get(id)!;
    const foes = humans.map((h) => sim.units.get(h)!).filter((h) => h.team !== me.team).map((h) => h.classId);
    if (!foes.length) continue; // a bot on the people's side learns nothing about beating people
    const won = sim.winner === me.team;
    const m = won ? 0.5 : 1.5;
    const L: Lessons = {};
    const put = (k: keyof Brain, value: number, weight: number) => {
      if (weight > 0 && Number.isFinite(value)) L[k] = { value: clampK(k, value), weight };
    };
    if (a.castsUnderThreat >= 3) put('jukeChance', 0.15 + 1.5 * (a.kickedByThreat / a.castsUnderThreat), a.castsUnderThreat * 3 * m);
    if (a.kickFracs.length) put('jukeAt', median(a.kickFracs) - 0.12, 12 * a.kickFracs.length * m);
    const fakes = humans.flatMap((h) => (sim.units.get(h)!.team !== me.team ? hacc.get(h)!.fakeFracs : []));
    if (a.juked > 0 && fakes.length) put('kickAt', median(fakes) + 0.12, 15 * a.juked * m);
    if (a.diedWithDefensive) {
      put('defHp', 0.6, 25 * a.diedWithDefensive * m);
      put('panicHp', 0.42, 25 * a.diedWithDefensive * m);
    }
    if (a.burstDeaths) put('dangerAt', 0.22, 20 * a.burstDeaths * m);
    const sec = a.engaged / TPS;
    // only what went wrong teaches: no long casts landing says nothing about pillars, so it is no lesson at all
    if (sec >= 20) {
      const perMin = a.bigCastsTaken / (sec / 60);
      if (perMin >= 1) put('losUse', 0.4 + 0.1 * perMin, sec * 0.5 * m);
      if (MELEE.has(me.classId)) {
        const k = a.kited / a.engaged;
        if (k >= 0.25) {
          put('chase', 0.4 + 0.6 * k, sec * 0.5 * m);
          put('mobility', 0.5 + 0.5 * k, sec * 0.3 * m);
        }
      } else if (RANGED[me.classId]) {
        const p = a.pinned / a.engaged;
        if (p >= 0.25) {
          put('rangeBias', 6 * p - 1, sec * 0.5 * m);
          put('mobility', 0.5 + 0.5 * p, sec * 0.3 * m);
        }
      }
    }
    if (a.zoneHits >= 2) put('dodge', 0.6 + 0.04 * a.zoneHits, a.zoneHits * 4 * m);
    out.bots.push({
      unitId: id, classId: me.classId, foes, won, lessons: L,
      facts: {
        castsUnderThreat: a.castsUnderThreat, kicked: a.kicked, juked: a.juked, kicksLanded: a.kicksLanded, diedWithDefensive: a.diedWithDefensive, burstDeaths: a.burstDeaths,
        bigCastsTaken: a.bigCastsTaken, zoneHits: a.zoneHits, engagedSec: Math.round(sec), kitedFrac: a.engaged ? a.kited / a.engaged : 0, pinnedFrac: a.engaged ? a.pinned / a.engaged : 0,
      },
    });
  }
  for (const id of humans) {
    const h = hacc.get(id)!;
    const S: Lessons = {};
    if (h.kickFracs.length) S.kickAt = { value: clampK('kickAt', median(h.kickFracs)), weight: 12 * h.kickFracs.length };
    if (h.fakeFracs.length) S.jukeAt = { value: clampK('jukeAt', median(h.fakeFracs)), weight: 12 * h.fakeFracs.length };
    if (h.castsUnderThreat >= 3) S.jukeChance = { value: clampK('jukeChance', h.fakesUnderThreat / h.castsUnderThreat), weight: h.castsUnderThreat * 3 };
    out.players.push({ unitId: id, classId: sim.units.get(id)!.classId, sample: S });
  }
  return out;
}

type ArenaSimLike = ReplayRunner['sim'];

/**
 * Which way each lesson may move a brain: a lesson says "at least this" (kick later, defend earlier, use pillars more)
 * or, for the numbers where lower is the fix, "at most this". A bot already past the mark is left alone.
 */
const LOWER: ReadonlySet<keyof Brain> = new Set(['jukeAt', 'dangerAt']);

/** `base` moved towards the lessons, only in the direction each one points; `pull` and `full` as in styledBrain. */
export function lessonBrain(base: Brain, lessons: Lessons, pull = 0.8, full = 150): Brain {
  const out = { ...base };
  for (const k of Object.keys(lessons) as (keyof Brain)[]) {
    const m = lessons[k];
    if (!m || m.weight < 30 || !(k in base) || !Number.isFinite(m.value)) continue;
    const wants = LOWER.has(k) ? m.value < base[k] : m.value > base[k];
    if (!wants) continue;
    out[k] = clampK(k, base[k] + (m.value - base[k]) * pull * Math.min(1, m.weight / full));
  }
  return out;
}

/** Everything the bot learner takes from one replay: how its people played, and how they beat the bots. */
export function readReplay(data: ReplayData): { humans: ReturnType<typeof measureHumans>; study: MatchStudy } {
  return { humans: measureHumans(data), study: studyMatch(data) };
}
