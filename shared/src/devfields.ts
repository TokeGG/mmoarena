import { ABILITIES, AURAS, CLASSES, SPECS, TALENTS, TUNING } from './data';
import { CLASS_BLURB, auraOrigins, describeAura, describeTalent, plainText, specPassives } from './describe';
import { ABILITY_CHOICES, ABILITY_FLAGS, AURA_FLAGS, MOD_ABILITY_DEFAULT, MOD_ABILITY_FLAGS, MOD_SCALAR_DEFAULT, TUNING_ID, currentValue, fileDefault, isAddition, isSwitch, tunableNumbers } from './devpatch';
import type { DataPatch, PatchFile, TunableNumber } from './devpatch';
import { FX_ID, FX_INFO, fxField } from './fx';
import { iconTitle } from './iconlib';
import type { ClassId } from './types';

/**
 * The catalogue the debug panel and the admin panel's Tuning tab draw: every value a dev can change, with plain-words
 * labels, what it does, its unit, the value now and the value in the data file, grouped into pages (classes, specs,
 * talents, skills, auras, game options). Nothing here changes data: edits are DataPatch objects (see devpatch.ts).
 */

export type FieldUnit = 'ms' | 'x' | 'yd' | 'chance' | 'percent' | 'count' | 'hp' | 'deg' | 'plain';

export interface DevField {
  file: PatchFile;
  id: string;
  path: (string | number)[];
  kind: 'number' | 'switch' | 'choice';
  /** Plain words for what the value is. */
  label: string;
  /** One sentence on what it does, when the label is not enough. */
  hint?: string;
  unit: FieldUnit;
  /** The value now (with any patch already applied). */
  value: number | string;
  /** The value in the data file. */
  base: number | string;
  /** The file does not have it yet: the value shown is the neutral one, and changing it adds it. */
  added?: boolean;
  options?: string[];
  /** Bounds of a number a page keeps it within (in the file's own unit: milliseconds for times). */
  min?: number;
  max?: number;
}

/** A titled run of fields. */
export interface FieldGroup { id: string; title: string; sub?: string; fields: DevField[]; open?: boolean }

/** A skill or buff a spec, talent or aura could be given a change for, with every number and switch it could have (the neutral value when it has none yet). */
export interface ModTarget { kind: 'ability' | 'aura'; id: string; name: string }

/** Everything one page entry shows. */
export interface DevEntry {
  file: PatchFile;
  id: string;
  name: string;
  /** What it is, in a few words under the title. */
  sub: string;
  /** What it does in plain words, as the game's own tooltips say it (numbers as they are now). */
  lines: string[];
  /** Facts that cannot be edited here (weapon, bar, where a talent sits), as label and value. */
  facts: [string, string][];
  groups: FieldGroup[];
  /** Skills and buffs that can be given stat changes here (the "add a change" picker). */
  addTargets?: ModTarget[];
  /** The skills it uses, to open on the Skills page. */
  skillLinks?: string[];
  /** The id of this entry on the Passives page, when it has passives to edit there. */
  passivesId?: string;
}

// ------------------------------------------------------------------ labels

const SCALAR_INFO: Record<string, { label: string; hint: string; unit: FieldUnit }> = {
  damageDone: { label: 'Damage dealt', hint: 'Multiplies all damage dealt. 1.1 is 10% more, 0.9 is 10% less.', unit: 'x' },
  healingDone: { label: 'Healing done', hint: 'Multiplies all healing done. 1.5 is 50% more.', unit: 'x' },
  healingTaken: { label: 'Healing received', hint: 'Multiplies healing received. 0.5 halves it.', unit: 'x' },
  damageTaken: { label: 'Damage taken', hint: 'Multiplies damage taken. 0.8 is 20% less (tougher).', unit: 'x' },
  maxHealth: { label: 'Maximum health', hint: 'Multiplies maximum health. 1.1 is 10% more.', unit: 'x' },
  castTime: { label: 'Cast times', hint: 'Multiplies every cast time. 0.8 casts 20% faster.', unit: 'x' },
  gcd: { label: 'Global cooldown length', hint: 'Multiplies the global cooldown. 0.8 is 20% shorter (never below 0.75 s).', unit: 'x' },
  regen: { label: 'Resource regeneration', hint: 'Multiplies mana or energy regeneration.', unit: 'x' },
  moveSpeed: { label: 'Movement speed', hint: 'Multiplies run speed. 1.1 is 10% faster.', unit: 'x' },
  autoSpeed: { label: 'Auto-attack swing time', hint: 'Multiplies the time between auto-attacks. Lower swings faster: 0.8 is 20% faster.', unit: 'x' },
  cpPower: { label: 'Combo point strength', hint: 'Multiplies what each combo point adds to finishers.', unit: 'x' },
  rage: { label: 'Rage gained', hint: 'Multiplies the rage earned from hitting and being hit.', unit: 'x' },
  maxCp: { label: 'Extra combo points allowed', hint: 'Added to the 5 combo point maximum.', unit: 'count' },
  lifesteal: { label: 'Lifesteal', hint: 'Share of damage dealt that comes back as healing (0.1 is 10%).', unit: 'chance' },
};

const ABILITY_MOD_INFO: Record<string, { label: string; hint: string; unit: FieldUnit }> = {
  damage: { label: 'damage', hint: 'Multiplies the damage it does.', unit: 'x' },
  heal: { label: 'healing', hint: 'Multiplies the healing it does.', unit: 'x' },
  cooldown: { label: 'cooldown', hint: 'Multiplies the cooldown. 0.8 is 20% shorter.', unit: 'x' },
  castTime: { label: 'cast time', hint: 'Multiplies the cast time. 0.8 is 20% faster.', unit: 'x' },
  cost: { label: 'resource cost', hint: 'Multiplies the resource it costs.', unit: 'x' },
  gain: { label: 'resource gained', hint: 'Multiplies the resource it earns (rage).', unit: 'x' },
  stored: { label: 'extra stored uses', hint: 'Extra uses kept in store, each recharging on its own.', unit: 'count' },
  cpChance: { label: 'chance of an extra combo point', hint: 'Chance each hit gives one more combo point.', unit: 'chance' },
  shadowProc: { label: 'chance to teleport behind the target', hint: 'Chance each cast first moves you behind the target for free.', unit: 'chance' },
  range: { label: 'extra range', hint: 'Yards added to its range.', unit: 'yd' },
  charges: { label: 'extra charges', hint: 'Extra uses allowed while the cooldown runs.', unit: 'count' },
  shieldPct: { label: 'share of its healing also given as a barrier', hint: '0.5 turns half of the healing into a damage barrier on the target.', unit: 'chance' },
  echo: { label: 'share of its heal echoed to the other side', hint: 'Heals the ally (or you) with this share of the healing done.', unit: 'chance' },
  ticks: { label: 'channel ticks', hint: 'Replaces the base number of ticks of the channel.', unit: 'count' },
};
const ABILITY_MOD_FLAG_INFO: Record<string, { label: string; hint: string }> = {
  castWhileMoving: { label: 'can be cast while moving', hint: 'Moving does not cancel it (a channel keeps going).' },
  free: { label: 'works without its usual target requirement', hint: 'Skips the "target needs this debuff" rule.' },
  castDuring: { label: 'can be used in the middle of another cast', hint: 'Using it does not stop the cast.' },
  allyOk: { label: 'may also be aimed at allies and yourself', hint: 'An enemy-targeted skill can be used on friends.' },
};

const LEAF: Record<string, { label: string; unit: FieldUnit; hint?: string }> = {
  amount: { label: 'amount', unit: 'plain' },
  damage: { label: 'damage', unit: 'plain' },
  duration: { label: 'duration', unit: 'ms' },
  maxDuration: { label: 'longest duration', unit: 'ms' },
  cooldown: { label: 'cooldown', unit: 'ms' },
  castTime: { label: 'cast time (0 = instant)', unit: 'ms' },
  lockout: { label: 'school lockout', unit: 'ms' },
  interval: { label: 'time between ticks', unit: 'ms' },
  delay: { label: 'delay before the first hit', unit: 'ms' },
  pulse: { label: 'time between pulses', unit: 'ms' },
  initial: { label: 'opening hit', unit: 'plain' },
  riseMs: { label: 'time to rise', unit: 'ms' },
  fallMs: { label: 'time to come down', unit: 'ms' },
  range: { label: 'range', unit: 'yd' },
  minRange: { label: 'minimum range', unit: 'yd' },
  radius: { label: 'area radius', unit: 'yd' },
  distance: { label: 'distance', unit: 'yd' },
  stopDistance: { label: 'stops this far from the target', unit: 'yd' },
  height: { label: 'height', unit: 'yd' },
  speed: { label: 'speed', unit: 'plain' },
  coneDeg: { label: 'cone width', unit: 'deg' },
  cost: { label: 'resource cost', unit: 'plain' },
  chance: { label: 'chance', unit: 'chance' },
  stacks: { label: 'stacks added', unit: 'count' },
  maxStacks: { label: 'most stacks', unit: 'count' },
  ticks: { label: 'ticks', unit: 'count' },
  count: { label: 'count', unit: 'count' },
  cpGain: { label: 'combo points gained', unit: 'count' },
  perStack: { label: 'per stack', unit: 'plain' },
  perCp: { label: 'per combo point', unit: 'plain' },
  extraPerCp: { label: 'extra per combo point', unit: 'plain' },
  mult: { label: 'multiplier', unit: 'x' },
  behindMult: { label: 'multiplier from behind', unit: 'x' },
  bleedFraction: { label: 'share dealt as a bleed', unit: 'chance' },
  bleedMult: { label: 'bleed multiplier', unit: 'x' },
  maxTargetHealthPct: { label: 'only works under this target health (%)', unit: 'percent' },
  slowPct: { label: 'slow', unit: 'percent', hint: 'Percent of movement speed removed.' },
  speedPct: { label: 'speed bonus', unit: 'percent', hint: 'Percent of movement speed added.' },
  absorbPct: { label: 'barrier (share of the heal)', unit: 'chance' },
  absorb: { label: 'barrier size', unit: 'hp' },
  pct: { label: 'percent', unit: 'plain' },
  hit: { label: 'hit', unit: 'plain' },
  maxHealth: { label: 'health', unit: 'hp' },
  start: { label: 'at the start', unit: 'plain' },
  max: { label: 'maximum', unit: 'plain' },
  regenPerSec: { label: 'regeneration per second', unit: 'plain' },
};

const TIER = ['I', 'II', 'III', 'IV', 'V'];
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const words = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase();
const abilityName = (id: string) => ABILITIES[id]?.name ?? words(id);
const auraName = (id: string) => AURAS[id]?.name ?? words(id);

const className = (c: string) => CLASSES[c as ClassId]?.name ?? c;
const specInfo = (id: string) => {
  for (const [cls, specs] of Object.entries(SPECS)) for (const s of specs) if (s.id === id) return { cls: cls as ClassId, spec: s };
  return null;
};

/** The thing's own name: an ability, aura, class, spec or talent (the game options are "Game options"). */
export function nameOf(file: PatchFile, id: string, path: readonly (string | number)[] = []): string {
  switch (file) {
    case 'icons': return path[0] === 'aura' ? `${auraName(id)} (${AURAS[id]?.harmful ? 'debuff' : 'buff'})` : path[0] === 'class' ? `${className(id)} class` : path[0] === 'spec' ? specInfo(id)?.spec.name ?? id : abilityName(id);
    case 'abilities': return abilityName(id);
    case 'auras': return auraName(id);
    case 'classes': return className(id);
    case 'specs': return specInfo(id)?.spec.name ?? id;
    case 'talents': return findTalent(id)?.t.name ?? id;
    case 'fx': return 'Animations';
    default: return 'Game options';
  }
}

function findTalent(id: string): { cls: ClassId; spec: string; tier: number; t: (typeof TALENTS)[ClassId][string][number][number] } | null {
  for (const [cls, bySpec] of Object.entries(TALENTS)) {
    for (const [spec, tiers] of Object.entries(bySpec)) {
      for (let i = 0; i < tiers.length; i++) for (const t of tiers[i]) if (t.id === id) return { cls: cls as ClassId, spec, tier: i, t };
    }
  }
  return null;
}

// ------------------------------------------------------------------ plain label of any path

interface Plain { label: string; hint?: string; unit: FieldUnit }

/** Words for one spot in a data file. */
export function plainPath(file: PatchFile, id: string, path: readonly (string | number)[]): Plain {
  const last = String(path[path.length - 1]);
  if (file === 'icons') return { label: path[0] === 'aura' ? 'Icon of the buff or debuff' : 'Icon', hint: 'The picture it wears on the action bar, in tooltips and on buff rows. Looks only: never changes a match.', unit: 'plain' };
  if (file === 'fx') {
    const f = fxField(path);
    return f ? { label: `${FX_INFO[String(path[0])].title}: ${f.label.charAt(0).toLowerCase()}${f.label.slice(1)}`, hint: f.hint, unit: f.unit } : { label: cap(words(last)), unit: 'plain' };
  }
  if (file === 'tuning') {
    const t = TUNING_INFO[String(path[0])];
    if (t) return path.length > 1 ? { label: `${t.label}: ${ordinal(Number(path[1]))} time`, hint: t.hint, unit: t.unit } : { label: t.label, hint: t.hint, unit: t.unit };
    return { label: cap(words(last)), unit: 'plain' };
  }
  if (path[0] === 'mods') {
    const k = String(path[1]);
    if (path.length === 2 && SCALAR_INFO[k]) return SCALAR_INFO[k];
    if (k === 'auraDuration' && path.length === 3) return { label: `${auraName(String(path[2]))} lasts`, hint: 'Multiplies how long this buff or debuff lasts. 1.5 is 50% longer.', unit: 'x' };
    if (k === 'auraExtend' && path.length === 3) return { label: `${auraName(String(path[2]))} lasts longer by`, hint: 'Seconds added to its duration.', unit: 'ms' };
    if (k === 'ability' && typeof path[2] === 'string') {
      const skill = abilityName(path[2]);
      if (path.length === 4 && last === 'heal' && ABILITIES[path[2]]?.effects.some((e) => e.type === 'aura' && AURAS[e.aura]?.kind === 'absorb') && !ABILITIES[path[2]]?.effects.some((e) => e.type === 'heal')) return { label: `${skill}: shield strength`, hint: 'Multiplies the damage it absorbs. 1.5 is 50% stronger.', unit: 'x' };
      if (path.length === 4 && ABILITY_MOD_INFO[last]) return { label: `${skill}: ${ABILITY_MOD_INFO[last].label}`, hint: ABILITY_MOD_INFO[last].hint, unit: ABILITY_MOD_INFO[last].unit };
      if (path.length === 4 && ABILITY_MOD_FLAG_INFO[last]) return { label: `${skill}: ${ABILITY_MOD_FLAG_INFO[last].label}`, hint: ABILITY_MOD_FLAG_INFO[last].hint, unit: 'plain' };
      if (typeof path[3] === 'string' && typeof path[4] === 'number') {
        const leaf = LEAF[last] ?? { label: words(last), unit: 'plain' as FieldUnit };
        return { label: `${skill}: added effect ${path[4] + 1} (${words(String(path[3]))}), ${leaf.label}`, hint: leaf.hint, unit: leaf.unit };
      }
    }
  }
  if (file === 'auras' && AURA_FULL[path.join('.')]) return AURA_FULL[path.join('.')];
  if (file === 'abilities' && path.length === 1) {
    if (ABILITY_FLAGS[last]) return { label: ABILITY_FLAGS[last], unit: 'plain' };
    if (ABILITY_CHOICES[last]) return { label: ABILITY_CHOICES[last].label, unit: 'plain' };
  }
  if (file === 'auras' && path.length === 1 && AURA_FLAGS[last]) return { label: AURA_FLAGS[last], unit: 'plain' };
  if (file === 'classes' && path[0] === 'resource') {
    const res = CLASSES[id as ClassId]?.resource.type ?? 'resource';
    if (last === 'max') return { label: `Maximum ${res}`, unit: 'plain' };
    if (last === 'start') return { label: `${cap(res)} at the start of a match`, unit: 'plain' };
    if (last === 'regenPerSec') return { label: `${cap(res)} regenerated per second`, unit: 'plain' };
  }
  if (file === 'classes' && path.length === 1 && last === 'maxHealth') return { label: 'Health', hint: 'Base maximum health before gear and talents.', unit: 'hp' };
  if (path[0] === 'auto') {
    const m: Record<string, Plain> = {
      interval: { label: 'Auto-attack swing time', hint: 'Seconds between swings.', unit: 'ms' },
      damage: { label: 'Auto-attack damage', hint: 'Damage of one swing.', unit: 'plain' },
      range: { label: 'Auto-attack reach', hint: 'How far away it can hit, in yards.', unit: 'yd' },
    };
    if (m[last]) return m[last];
  }
  // a number inside an ability or aura: say where it sits ("damage amount", "aura duration", "dot interval")
  const parts: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (typeof k === 'number' || k === 'effects') continue;
    parts.push(words(String(k)));
  }
  const eff = path[0] === 'effects' && typeof path[1] === 'number' ? effectType(file, id, path[1]) : '';
  const leaf = LEAF[last] ?? { label: words(last), unit: 'plain' as FieldUnit };
  const prefix = eff ? `${eff} ` : parts.length ? `${parts.join(' ')} ` : '';
  return { label: cap(`${prefix}${leaf.label}`.trim()), hint: leaf.hint, unit: leaf.unit };
}

function effectType(file: PatchFile, id: string, n: number): string {
  const e = file === 'abilities' ? ABILITIES[id]?.effects[n] : undefined;
  if (!e) return `effect ${n + 1}`;
  const t = e.type;
  if (t === 'aura') return `${auraName((e as { aura: string }).aura)} (applied)`;
  return `${words(t)}${ABILITIES[id]?.effects.filter((x) => x.type === t).length! > 1 ? ` ${n + 1}` : ''}`;
}

const AURA_FULL: Record<string, Plain> = {
  'hot.pct': { label: 'Healing over time: share of max health per tick', unit: 'percent' },
  'hot.interval': { label: 'Healing over time: time between ticks', unit: 'ms' },
  'dot.amount': { label: 'Damage over time: damage per tick', unit: 'plain' },
  'dot.interval': { label: 'Damage over time: time between ticks', unit: 'ms' },
  'vulnerable.mult': { label: 'Extra damage taken (multiplier)', unit: 'x' },
  'hover.height': { label: 'Hover height', unit: 'yd' },
  'hover.riseMs': { label: 'Time to rise', unit: 'ms' },
  'hover.fallMs': { label: 'Time to come back down', unit: 'ms' },
  duration: { label: 'Duration', unit: 'ms' },
  maxDuration: { label: 'Longest it can be extended to', unit: 'ms' },
};

const ordinal = (i: number) => ['first', 'second', 'third', 'fourth', 'fifth'][i] ?? `#${i + 1}`;

// ------------------------------------------------------------------ game options

export const TUNING_INFO: Record<string, { label: string; hint: string; unit: FieldUnit; group: string }> = {
  gcdMs: { label: 'Global cooldown', hint: 'Time after most skills before the next one can be used.', unit: 'ms', group: 'Timing' },
  castGraceMs: { label: 'Cast grace after a failed range or facing check', hint: 'A cast that only failed on range or facing is retried for this long.', unit: 'ms', group: 'Timing' },
  outOfCombatMs: { label: 'Time until you are out of combat', hint: 'Seconds without fighting before combat ends (stealth skills, rage decay).', unit: 'ms', group: 'Timing' },
  runSpeed: { label: 'Run speed', hint: 'Yards per second for everyone before speed bonuses.', unit: 'plain', group: 'Movement' },
  fearSpeed: { label: 'Fear stumble speed', hint: 'A feared unit moves at this share of run speed.', unit: 'chance', group: 'Movement' },
  drResetMs: { label: 'Diminishing returns reset', hint: 'How long after a crowd control ends the count starts over.', unit: 'ms', group: 'Crowd control' },
  drSteps: { label: 'Diminishing returns', hint: 'Share of the full duration for each repeat of the same kind of crowd control (0 is immune).', unit: 'chance', group: 'Crowd control' },
  rangeTolerance: { label: 'Range leniency (spells)', hint: 'Extra yards allowed when checking the range of a spell.', unit: 'yd', group: 'Range and targeting' },
  autoTolerance: { label: 'Range leniency (melee)', hint: 'Extra yards allowed when checking melee and auto-attack reach.', unit: 'yd', group: 'Range and targeting' },
  castConeDeg: { label: 'Facing cone', hint: 'Width of the cone in front of you in which targets can be cast on or hit.', unit: 'deg', group: 'Range and targeting' },
  stealthDetect: { label: 'Stealth detection distance', hint: 'Enemies closer than this see a stealthed unit.', unit: 'yd', group: 'Range and targeting' },
  maxRewindMs: { label: 'Lag compensation limit', hint: 'Furthest back that a cast looks at where its target was.', unit: 'ms', group: 'Range and targeting' },
  prepMs: { label: 'Preparation time before the gates open', hint: 'Length of the preparation phase.', unit: 'ms', group: 'Match rules' },
  maxMatchMs: { label: 'Longest match', hint: 'A match ends in a draw after this long.', unit: 'ms', group: 'Match rules' },
  gearCap: { label: 'Gear power cap', hint: 'Highest multiplier gear can give.', unit: 'x', group: 'Match rules' },
  damageVariance: { label: 'Damage variance', hint: 'Random spread on every hit (0 is none, 0.1 is up to 10% either way).', unit: 'chance', group: 'Match rules' },
  dampenStartMs: { label: 'Dampening starts after', hint: 'Healing starts to weaken this long into a fight.', unit: 'ms', group: 'Healing dampening' },
  dampenPerSec: { label: 'Dampening per second', hint: 'How much weaker healing gets every second (0.003 is 0.3%).', unit: 'chance', group: 'Healing dampening' },
  dampenMax: { label: 'Dampening cap', hint: 'Healing never gets weaker than this share (0.9 is 90% less).', unit: 'chance', group: 'Healing dampening' },
  rageFromDealt: { label: 'Rage from damage dealt', hint: 'Rage gained per point of damage you deal.', unit: 'plain', group: 'Rage' },
  rageFromTaken: { label: 'Rage from damage taken', hint: 'Rage gained per point of damage you take.', unit: 'plain', group: 'Rage' },
  rageDecayPerSec: { label: 'Rage lost per second out of combat', hint: 'Rage drains at this rate when not fighting.', unit: 'plain', group: 'Rage' },
  cauterizeHealth: { label: 'Cauterize: health left', hint: 'A killing blow leaves the Pyromancy mage at this share of maximum health.', unit: 'chance', group: 'Cauterize (Pyromancy passive)' },
  cauterizeCooldownMs: { label: 'Cauterize: cooldown', hint: 'How long until Cauterize can save the mage again.', unit: 'ms', group: 'Cauterize (Pyromancy passive)' },
  lavaIntervalMs: { label: 'Lava: time between burns', hint: 'How often standing in lava burns you.', unit: 'ms', group: 'Lava' },
  lavaPct: { label: 'Lava: damage per burn', hint: 'Share of maximum health taken each burn.', unit: 'chance', group: 'Lava' },
};

// ------------------------------------------------------------------ value formatting

/** The number in more familiar words: "+50%", "1.5 s", "10%". Empty when it needs none. */
export function valueHint(unit: FieldUnit, v: number | string): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  const r = (n: number) => String(Math.round(n * 100) / 100);
  switch (unit) {
    case 'x': return v === 1 ? 'no change' : v > 1 ? `+${r((v - 1) * 100)}%` : `-${r((1 - v) * 100)}%`;
    case 'ms': return `${r(v / 1000)} s`;
    case 'chance': return `${r(v * 100)}%`;
    case 'percent': return `${r(v)}%`;
    case 'yd': return `${r(v)} yd`;
    case 'deg': return `${r(v)}°`;
    default: return '';
  }
}

export const UNIT_NAME: Record<FieldUnit, string> = { ms: 'seconds (typed as 1.2; saved in milliseconds)', x: 'multiplier', yd: 'yards', chance: 'share (1 = 100%)', percent: 'percent', count: 'count', hp: 'health', deg: 'degrees', plain: '' };

// ------------------------------------------------------------------ building fields

/** A field for one spot in the data (undefined when the spot is not a number, switch or choice that exists or could be added). */
export function fieldAt(file: PatchFile, id: string, path: (string | number)[], over: { label?: string; hint?: string; unit?: FieldUnit } = {}): DevField | null {
  const now = currentValue({ file, id, path });
  if (now === undefined) return null;
  const base = fileDefault({ file, id, path }) ?? now;
  const plain = plainPath(file, id, path);
  const choice = file === 'abilities' && path.length === 1 ? ABILITY_CHOICES[String(path[0])] : undefined;
  const kind: DevField['kind'] = choice ? 'choice' : isSwitch({ file, id, path }) ? 'switch' : 'number';
  const f: DevField = { file, id, path, kind, label: over.label ?? plain.label, unit: kind === 'number' ? over.unit ?? plain.unit : 'plain', value: now, base };
  const hint = over.hint ?? plain.hint;
  if (hint) f.hint = hint;
  if (choice) f.options = choice.options;
  if (path[0] === 'mods' && isAddition({ file, id, path })) f.added = true;
  if (file === 'fx') {
    const b = fxField(path);
    if (b) { f.min = b.min; f.max = b.max; }
  }
  return f;
}

/** Turns a number found by `tunableNumbers` into a field with words. */
export function fieldOf(t: TunableNumber, label?: string): DevField {
  return fieldAt(t.file, t.id, t.path, label ? { label } : {}) ?? { file: t.file, id: t.id, path: t.path, kind: 'number', label: label ?? t.label, unit: 'plain', value: t.value, base: t.value };
}

/** The patch that sets a field to a value. */
export const patchOf = (f: Pick<DevField, 'file' | 'id' | 'path'>, value: number | string): DataPatch => ({ file: f.file, id: f.id, path: f.path, value });

/** Every number and switch under `mods` of a spec, talent or aura, as the file has them (in file order). */
function existingMods(file: 'specs' | 'talents' | 'auras', id: string): DevField[] {
  const out: DevField[] = [];
  const walk = (o: unknown, path: (string | number)[]) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      const key: string | number = Array.isArray(o) ? Number(k) : k;
      if (k === 'type' || k === 'aura' || k === 'only' || k === 'who' || k === 'school' || k === 'kind') continue;
      const here = [...path, key];
      if (typeof v === 'number' || typeof v === 'boolean') {
        const f = fieldAt(file, id, here);
        if (f) out.push(f);
      } else if (v && typeof v === 'object' && !(path.length === 3 && key === 'swapAura')) walk(v, here);
    }
  };
  const root = rootOf(file, id);
  if (root && typeof root === 'object' && 'mods' in root) walk((root as { mods?: unknown }).mods, ['mods']);
  return out;
}

function rootOf(file: PatchFile, id: string): unknown {
  if (file === 'auras') return AURAS[id];
  if (file === 'specs') return specInfo(id)?.spec;
  if (file === 'talents') return findTalent(id)?.t;
  return undefined;
}

/** Every stat change a spec, talent or aura could carry for one skill, with the neutral value for the ones it does not have yet. */
export function skillSlots(file: 'specs' | 'talents' | 'auras', id: string, abilityId: string): DevField[] {
  const out: DevField[] = [];
  for (const k of Object.keys(MOD_ABILITY_DEFAULT)) {
    if (k === 'ticks') continue;
    const f = fieldAt(file, id, ['mods', 'ability', abilityId, k]);
    if (f) out.push(f);
  }
  for (const k of MOD_ABILITY_FLAGS) {
    const f = fieldAt(file, id, ['mods', 'ability', abilityId, k]);
    if (f) out.push(f);
  }
  return out;
}

/** The two things a buff's duration can be changed by, for one aura. */
export function auraSlots(file: 'specs' | 'talents' | 'auras', id: string, auraId: string): DevField[] {
  return (['auraDuration', 'auraExtend'] as const).map((k) => fieldAt(file, id, ['mods', k, auraId])).filter((f): f is DevField => !!f);
}

/**
 * The stat changes of a spec, talent or buff, in groups: what it already has (stats, then one group per skill it changes),
 * and what it could have (every stat that does nothing yet, for adding one).
 */
export function modGroups(file: 'specs' | 'talents' | 'auras', id: string, scope = ''): FieldGroup[] {
  const have = existingMods(file, id);
  const groups: FieldGroup[] = [];
  const stats = have.filter((f) => f.path.length === 2);
  if (stats.length) groups.push({ id: `${scope}stats`, title: 'Stat bonuses', sub: 'apply to everything this build does', fields: stats, open: true });
  const perSkill = new Map<string, DevField[]>();
  const others: DevField[] = [];
  for (const f of have) {
    if (f.path.length === 2) continue;
    if (f.path[1] === 'ability') {
      const a = String(f.path[2]);
      perSkill.set(a, [...(perSkill.get(a) ?? []), f]);
    } else others.push(f);
  }
  for (const [a, fields] of perSkill) groups.push({ id: `${scope}skill:${a}`, title: `Changes to ${abilityName(a)}`, fields, open: true });
  if (others.length) groups.push({ id: `${scope}auras`, title: 'Buff and debuff durations', sub: 'how long other effects last', fields: others, open: true });
  const unused = Object.keys(MOD_SCALAR_DEFAULT).filter((k) => !stats.some((f) => f.path[1] === k)).map((k) => fieldAt(file, id, ['mods', k])).filter((f): f is DevField => !!f);
  if (unused.length) groups.push({ id: `${scope}unused`, title: 'Stat bonuses it does not have yet', sub: file === 'specs' ? 'change one to add it (specs are meant to have none: for trying)' : 'change one to add it', fields: unused, open: false });
  return groups;
}

// ------------------------------------------------------------------ the pages

export type DevPageId = 'classes' | 'specs' | 'talents' | 'skills' | 'passives' | 'auras' | 'animations' | 'icons' | 'options';

export const DEV_PAGES: { id: DevPageId; label: string; blurb: string; /** The tab row is read left to right in these steps. */ step: string }[] = [
  { id: 'classes', label: 'Classes', step: 'Who', blurb: 'Health, resource and auto-attack of each class.' },
  { id: 'specs', label: 'Specs', step: 'Who', blurb: 'What each spec is: role, weapon and auto-attack. Its bonuses are on the Passives page.' },
  { id: 'talents', label: 'Talents', step: 'Who', blurb: 'What each talent does and where it sits. Its bonuses are on the Passives page.' },
  { id: 'skills', label: 'Skills', step: 'What they do', blurb: 'Every ability: numbers, options, effects and the buffs and debuffs it applies.' },
  { id: 'passives', label: 'Passives', step: 'What they do', blurb: 'What a spec or talent gives without a button: stat bonuses, changes to skills, Cauterize.' },
  { id: 'auras', label: 'Buffs & debuffs', step: 'What they do', blurb: 'Every buff and debuff (the icons on a unit): duration, ticks, stacks, stat changes.' },
  { id: 'animations', label: 'Animations', step: 'What they do', blurb: 'How long the big visual effects take and stay (Dragon\'s Breath, Flamestrike, Charge, Heroic Leap). Looks only: never changes a match. Shows on the next cast.' },
  { id: 'icons', label: 'Icon edit', step: 'Look', blurb: 'Pick the picture of any skill or buff from the whole icon library. Looks only: never changes a match. Shows at once.' },
  { id: 'options', label: 'Game options', step: 'Rules', blurb: 'Global rules: cooldowns, speeds, dampening, match length.' },
];


/** One line of the navigation. */
export interface NavEntry { id: string; name: string; sub?: string; icon?: string }
export interface NavGroup { title: string; entries: NavEntry[]; groups?: NavGroup[] }

const CLASS_IDS_LIST = Object.keys(CLASSES) as ClassId[];

/** The navigation tree of a page. */
export function navFor(page: DevPageId): NavGroup[] {
  switch (page) {
    case 'classes':
      return [{ title: 'Classes', entries: CLASS_IDS_LIST.map((c) => ({ id: c, name: CLASSES[c].name, sub: CLASSES[c].resource.type })) }];
    case 'specs':
      return CLASS_IDS_LIST.map((c) => ({ title: className(c), entries: SPECS[c].map((s) => ({ id: s.id, name: s.name, sub: s.role, icon: s.icon })) }));
    case 'talents':
      return CLASS_IDS_LIST.map((c) => {
        const seen = new Set<string>();
        const tiers: NavGroup[] = [];
        const specs = SPECS[c];
        for (let ti = 0; ti < 5; ti++) {
          const entries: NavEntry[] = [];
          for (const s of specs) {
            for (const t of TALENTS[c]?.[s.id]?.[ti] ?? []) {
              if (seen.has(t.id)) continue;
              seen.add(t.id);
              const also = specs.filter((x) => TALENTS[c][x.id]?.[ti]?.some((y) => y.id === t.id));
              entries.push({ id: t.id, name: t.name, sub: also.length === specs.length ? 'every spec' : also.map((x) => x.name).join(', '), icon: t.icon });
            }
          }
          if (entries.length) tiers.push({ title: `Tier ${TIER[ti]}`, entries });
        }
        return { title: className(c), entries: [], groups: tiers };
      });
    case 'passives': {
      const talents = navFor('talents');
      return CLASS_IDS_LIST.map((c, i) => ({
        title: className(c),
        entries: [],
        groups: [
          { title: 'Spec passives', entries: SPECS[c].map((sp) => ({ id: `s:${sp.id}`, name: sp.name, sub: sp.passive ? `${sp.role} · has Cauterize` : sp.role, icon: sp.icon })) },
          { title: 'Talent passives', entries: [], groups: (talents[i].groups ?? []).map((g) => ({ ...g, entries: g.entries.map((e) => ({ ...e, id: `t:${e.id}` })) })) },
        ],
      }));
    }
    case 'skills': {
      const used = new Set<string>();
      const out: NavGroup[] = [];
      const entry = (id: string): NavEntry => ({ id, name: abilityName(id), sub: ABILITIES[id]?.school });
      for (const c of CLASS_IDS_LIST) {
        const groups: NavGroup[] = [];
        const own = CLASSES[c].bar.filter((id) => ABILITIES[id] && !used.has(id));
        own.forEach((id) => used.add(id));
        if (own.length) groups.push({ title: 'Every spec', entries: own.map(entry) });
        for (const s of SPECS[c]) {
          const ids = s.bar.filter((id) => ABILITIES[id] && !used.has(id));
          ids.forEach((id) => used.add(id));
          if (ids.length) groups.push({ title: s.name, entries: ids.map(entry) });
        }
        const rest = Object.keys(ABILITIES).filter((id) => ABILITIES[id].class === c && !ABILITIES[id].retired && !used.has(id));
        rest.forEach((id) => used.add(id));
        if (rest.length) groups.push({ title: 'From talents', entries: rest.map(entry) });
        out.push({ title: className(c), entries: [], groups });
      }
      const trinkets = Object.keys(ABILITIES).filter((id) => ABILITIES[id].class === 'trinket' && !ABILITIES[id].retired);
      const other = Object.keys(ABILITIES).filter((id) => !used.has(id) && !trinkets.includes(id) && !ABILITIES[id].retired);
      if (trinkets.length) out.push({ title: 'Trinkets', entries: trinkets.map(entry) });
      if (other.length) out.push({ title: 'Other', entries: other.map(entry) });
      return out;
    }
    case 'auras': {
      const byKind = new Map<string, NavEntry[]>();
      for (const [id, a] of Object.entries(AURAS)) {
        const k = a.kind;
        byKind.set(k, [...(byKind.get(k) ?? []), { id, name: a.name, sub: a.harmful ? 'debuff' : 'buff' }]);
      }
      return [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, entries]) => ({ title: cap(words(k)), entries }));
    }
    case 'icons': return iconNav();
    case 'animations':
      return [{ title: 'Animations', entries: Object.entries(FX_INFO).map(([id, g]) => ({ id, name: g.title, sub: g.sub })) }];
    default:
      return [{ title: 'Game options', entries: [{ id: TUNING_ID, name: 'Game options', sub: 'global rules' }] }];
  }
}

/** Everything the page shows for one entry. */
export function entryFor(page: DevPageId, id: string): DevEntry | null {
  switch (page) {
    case 'classes': return classEntry(id as ClassId);
    case 'specs': return specEntry(id);
    case 'talents': return talentEntry(id);
    case 'passives': return id.startsWith('s:') ? specEntry(id.slice(2), true) : id.startsWith('t:') ? talentEntry(id.slice(2), true) : null;
    case 'auras': return auraEntry(id);
    case 'animations': return animationEntry(id);
    case 'icons': return iconEntry(id);
    case 'options': return optionsEntry();
    default: return null;
  }
}

const some = <T,>(a: (T | null)[]): T[] => a.filter((x): x is T => x !== null);

function autoGroup(file: 'classes' | 'specs', id: string, has: boolean): FieldGroup | null {
  if (!has) return null;
  return { id: 'auto', title: 'Auto-attack', sub: 'the swing it makes without a button', open: true, fields: some(['interval', 'damage', 'range'].map((k) => fieldAt(file, id, ['auto', k]))) };
}

function classEntry(c: ClassId): DevEntry | null {
  const def = CLASSES[c];
  if (!def) return null;
  const groups: FieldGroup[] = [
    { id: 'stats', title: 'Base stats', sub: 'before gear, spec and talents', open: true, fields: some([fieldAt('classes', c, ['maxHealth']), fieldAt('classes', c, ['resource', 'max']), fieldAt('classes', c, ['resource', 'start']), fieldAt('classes', c, ['resource', 'regenPerSec'])]) },
  ];
  const auto = autoGroup('classes', c, !!def.auto);
  if (auto) groups.push(auto);
  return {
    file: 'classes', id: c, name: def.name, sub: `${def.resource.type} class`,
    lines: [CLASS_BLURB[c]].filter(Boolean),
    facts: [['Resource', def.resource.type], ...(def.auto ? [] : [['Auto-attack', 'none (each spec sets its own, if any)'] as [string, string]])],
    groups, skillLinks: def.bar,
  };
}

function specEntry(id: string, passives = false): DevEntry | null {
  const f = specInfo(id);
  if (!f) return null;
  const { cls, spec } = f;
  const groups: FieldGroup[] = [];
  if (passives && spec.passive === 'cauterize') {
    groups.push({ id: 'passive', title: 'Passive: Cauterize', sub: 'a killing blow leaves you alive (the numbers are game options)', open: true, fields: some([fieldAt('tuning', TUNING_ID, ['cauterizeHealth']), fieldAt('tuning', TUNING_ID, ['cauterizeCooldownMs'])]) });
  }
  const auto = autoGroup('specs', id, !!spec.auto);
  if (auto && !passives) groups.push(auto);
  if (passives) groups.push(...modGroups('specs', id));
  const facts: [string, string][] = [['Class', className(cls)], ['Role', spec.role]];
  if (spec.weapon) facts.push(['Weapon', spec.weapon.name]);
  if (spec.passive) facts.push(['Built-in effect', spec.passive]);
  if (!spec.auto && CLASSES[cls].auto) facts.push(['Auto-attack', "uses the class's (see Classes)"]);
  const targets: ModTarget[] = [...new Set([...spec.bar, ...CLASSES[cls].bar])].filter((a) => ABILITIES[a]).map((a) => ({ kind: 'ability', id: a, name: abilityName(a) }));
  if (!passives) return { file: 'specs', id, name: spec.name, sub: `${className(cls)} · ${spec.role}`, lines: [spec.desc].filter(Boolean), facts, groups, skillLinks: spec.bar, passivesId: `s:${id}` };
  return { file: 'specs', id, name: `${spec.name} passives`, sub: `${className(cls)} · what it gives without a button`, lines: specPassives(cls, id), facts: [], groups, addTargets: [...targets, ...auraTargets()] };
}

function auraTargets(): ModTarget[] {
  return Object.entries(AURAS).map(([id, a]) => ({ kind: 'aura' as const, id, name: a.name }));
}

function talentEntry(id: string, passives = false): DevEntry | null {
  const f = findTalent(id);
  if (!f) return null;
  const { cls, tier, t } = f;
  const where = SPECS[cls].filter((s) => TALENTS[cls][s.id]?.[tier]?.some((x) => x.id === id));
  const d = describeTalent(t);
  const groups = passives ? modGroups('talents', id) : [];
  const facts: [string, string][] = [['Class', className(cls)], ['Tier', TIER[tier]], ['In specs', where.length === SPECS[cls].length ? 'every spec (one change covers all copies)' : where.map((s) => s.name).join(', ')]];
  if (t.swap) facts.push(['Swaps in', `${abilityName(t.swap.to)} instead of ${abilityName(t.swap.from)}${t.swap.alt?.length ? ` (or ${t.swap.alt.map(abilityName).join(', ')})` : ''}${t.swap.stealth ? ', while stealthed' : ''}`]);
  if (t.trinket) facts.push(['Trinket', abilityName(t.trinket)]);
  const targets: ModTarget[] = Object.keys(ABILITIES).filter((a) => !ABILITIES[a].retired && (ABILITIES[a].class === cls || ABILITIES[a].class === 'trinket')).map((a) => ({ kind: 'ability', id: a, name: abilityName(a) }));
  if (!passives) return { file: 'talents', id, name: t.name, sub: `${className(cls)} · tier ${TIER[tier]}`, lines: [t.desc].filter(Boolean), facts, groups, skillLinks: [t.swap?.to, t.trinket].filter((x): x is string => !!x), passivesId: d.mods.length || modGroups('talents', id).length ? `t:${id}` : undefined };
  return { file: 'talents', id, name: `${t.name} passives`, sub: `${className(cls)} · tier ${TIER[tier]}`, lines: d.mods, facts: [['In specs', facts[2][1]]], groups, addTargets: [...targets, ...auraTargets()] };
}

const AURA_OPTION_FIELDS = (id: string): DevField[] => some(Object.keys(AURA_FLAGS).map((k) => fieldAt('auras', id, [k])));

function auraEntry(id: string): DevEntry | null {
  const a = AURAS[id];
  if (!a) return null;
  const nums = tunableNumbers('auras', id).filter((t) => t.path[0] !== 'mods').map((t) => fieldOf(t));
  const groups: FieldGroup[] = [];
  if (nums.length) groups.push({ id: 'numbers', title: 'Timing and strength', sub: 'duration, ticks, stacks, slows, barriers', open: true, fields: nums });
  groups.push({ id: 'options', title: 'Options', sub: 'switches on or off', open: false, fields: AURA_OPTION_FIELDS(id) });
  groups.push(...modGroups('auras', id));
  const origins = auraOrigins(id);
  const facts: [string, string][] = [['Kind', a.kind], ['Type', a.harmful ? 'debuff (harmful)' : 'buff']];
  if (origins.length) facts.push(['Comes from', origins.join(', ')]);
  const targets: ModTarget[] = Object.keys(ABILITIES).filter((x) => !ABILITIES[x].retired).map((x) => ({ kind: 'ability', id: x, name: abilityName(x) }));
  return { file: 'auras', id, name: a.name, sub: `${a.harmful ? 'debuff' : 'buff'} · ${a.kind}`, lines: [plainText(describeAura(id))].filter(Boolean), facts, groups, addTargets: [...targets, ...auraTargets()] };
}

/** The Icon edit page's list: every skill as on the Skills page (ids "a:fireball"), then the buffs and debuffs (ids "u:polymorph"). */
function iconNav(): NavGroup[] {
  const mark = (g: NavGroup): NavGroup => ({ ...g, entries: g.entries.map((e) => ({ ...e, id: `a:${e.id}` })), groups: g.groups?.map(mark) });
  const out: NavGroup[] = [
    { title: 'Classes', entries: CLASS_IDS_LIST.map((c) => ({ id: `c:${c}`, name: CLASSES[c].name, sub: 'class' })) },
    { title: 'Specs', entries: [], groups: CLASS_IDS_LIST.map((c) => ({ title: className(c), entries: SPECS[c].map((s) => ({ id: `p:${s.id}`, name: s.name, sub: s.role })) })) },
    ...navFor('skills').map(mark),
  ];
  const buffs: NavEntry[] = [];
  const debuffs: NavEntry[] = [];
  for (const [id, a] of Object.entries(AURAS)) (a.harmful ? debuffs : buffs).push({ id: `u:${id}`, name: a.name, sub: a.kind });
  out.push({ title: 'Buffs', entries: buffs }, { title: 'Debuffs', entries: debuffs });
  return out;
}

/** What the Icon edit page shows for an entry (the page draws the picker itself, so it has no number fields). */
function iconEntry(id: string): DevEntry | null {
  const aura = id.startsWith('u:');
  const raw = id.slice(2);
  if (id.startsWith('c:')) return CLASSES[raw as ClassId] ? { file: 'icons', id: raw, name: className(raw), sub: 'class', lines: [], facts: [], groups: [] } : null;
  if (id.startsWith('p:')) return specInfo(raw) ? { file: 'icons', id: raw, name: specInfo(raw)!.spec.name, sub: `${className(specInfo(raw)!.cls)} spec`, lines: [], facts: [], groups: [] } : null;
  if (!id.startsWith('a:') && !aura) return null;
  if (aura ? !AURAS[raw] : !ABILITIES[raw]) return null;
  return {
    file: 'icons', id: raw, name: aura ? auraName(raw) : abilityName(raw), sub: aura ? `${AURAS[raw].harmful ? 'debuff' : 'buff'} · ${AURAS[raw].kind}` : `${ABILITIES[raw].school} skill`,
    lines: [], facts: [], groups: [],
  };
}

/** The patch that gives a skill (`a:id`) or buff (`u:id`) of the Icon edit page an icon. */
export const iconPatch = (navId: string, icon: string): DataPatch => ({ file: 'icons', id: navId.slice(2), path: [navId.startsWith('u:') ? 'aura' : navId.startsWith('c:') ? 'class' : navId.startsWith('p:') ? 'spec' : 'ability'], value: icon });
/** Words for an icon in a change list: "fire-mage-3" style ids are shown as the library names them. */
export const iconLabel = (id: string | number | undefined): string => (typeof id === 'string' && id ? iconTitle(id) : 'none');

function animationEntry(id: string): DevEntry | null {
  const g = FX_INFO[id];
  if (!g) return null;
  const fields = some(Object.keys(g.fields).map((k) => fieldAt('fx', FX_ID, [id, k])));
  return {
    file: 'fx', id: FX_ID, name: g.title, sub: g.sub,
    lines: ['These only change how the effect looks. Times are in seconds. A change shows the next time the effect plays (cast it again).'],
    facts: [],
    groups: [{ id: 'timing', title: 'Timing and size', sub: 'seconds and scales', open: true, fields }],
  };
}

function optionsEntry(): DevEntry {
  const groups = new Map<string, DevField[]>();
  for (const k of Object.keys(TUNING)) {
    const info = TUNING_INFO[k];
    if (!info) continue;
    const v = (TUNING as unknown as Record<string, unknown>)[k];
    const fields: DevField[] = [];
    if (Array.isArray(v)) v.forEach((_x, i) => { const f = fieldAt('tuning', TUNING_ID, [k, i]); if (f) fields.push(f); });
    else {
      const f = fieldAt('tuning', TUNING_ID, [k]);
      if (f) fields.push(f);
    }
    groups.set(info.group, [...(groups.get(info.group) ?? []), ...fields]);
  }
  return {
    file: 'tuning', id: TUNING_ID, name: 'Game options', sub: 'global rules for every match',
    lines: ['These numbers apply to every class and match. The length of a server step is not editable here.'],
    facts: [],
    groups: [...groups.entries()].map(([title, fields]) => ({ id: title, title, fields, open: true })),
  };
}

/** Everything searchable about an entry's nav line, lowercase. */
export const navText = (e: NavEntry) => `${e.name} ${e.sub ?? ''} ${e.id}`.toLowerCase();
