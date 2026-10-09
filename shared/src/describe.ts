import { ABILITIES, AURAS, CLASSES, SPECS, TALENTS, TUNING } from './data';
import { NEUTRAL_MODS, newMods } from './build';
import { JUMP_DODGE_CD } from './jump';
import type { AbilityDef, AuraKind, ClassId, Effect, Mods, ModsInput, TalentDef } from './types';

/** The one-line pitch of each class (menu blurb and class tooltip). */
export const CLASS_BLURB: Record<ClassId, string> = {
  warrior: 'Heavy melee fighter. Builds rage by fighting. Charges in, hamstrings, interrupts.',
  mage: 'Ranged caster. Slows, roots and polymorphs. Fragile, so keep your distance.',
  priest: 'Healer and support. Shields, heals, dispels and fears. Mana-hungry.',
  rogue: 'Stealth melee assassin. Stuns from stealth, kicks casters, hard to pin down.',
};

/** Where a modifier comes from, for the in-depth tooltip (the spec, a talent, a buff). */
export interface ModSource {
  label: string;
  mods?: ModsInput;
}

/** Human-readable text for tooltips, generated from the same data the sim uses so it can never drift. */

const sec = (ms: number) => `${Math.round(ms / 100) / 10}s`;
const pct = (v: number) => `${Math.round(Math.abs(v - 1) * 1000) / 10}%`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "a 5" or "an 8": the article that goes with a number said aloud. */
const an = (n: number) => `${/^(8|11|18)/.test(String(n)) ? 'an' : 'a'} ${n}`;
const mult = (v: number) => `x${Math.round(v * 100) / 100}`;

/** One generated modifier line plus what it is about, so a hand-written description that already says it can be detected. */
interface ModFact {
  text: string;
  /** The number as written in `text`: "25%" or "5 yd". */
  amount: string;
  /** The ability or aura it changes (absent for a general stat). */
  subject?: string;
  /** Words a description uses for this kind of stat. */
  kind: RegExp;
}

const K = {
  damage: /damage|hit/, heal: /heal|shield/, taken: /damage|taken/, health: /health/, cast: /cast/, gcd: /global cooldown|gcd/,
  regen: /regen|mana|energy|rage|resource/, move: /mov|speed|run/, swing: /auto|swing|attack/, cooldown: /cooldown|recharge/,
  range: /range|reach|further|farther|yard|yd/, duration: /last|longer|duration/,
};

function modFacts(m: ModsInput | undefined, res = 'resource'): ModFact[] {
  const out: ModFact[] = [];
  if (!m) return out;
  const add = (sign: string, p: number, label: string, kind: RegExp, subject?: string) => {
    const amount = pct(p);
    out.push({ text: `${subject ? `${subject}: ` : ''}${sign}${amount} ${label}`, amount, subject, kind });
  };
  const up = (v: number | undefined, label: string, kind: RegExp) => {
    if (v !== undefined && v !== 1) add(v > 1 ? '+' : '−', v, label, kind);
  };
  up(m.damageDone, 'damage dealt', K.damage);
  up(m.healingDone, 'healing and shields', K.heal);
  up(m.healingTaken, 'healing received', /heal/);
  up(m.damageTaken, 'damage taken', K.taken);
  up(m.maxHealth, 'maximum health', K.health);
  up(m.castTime, 'cast time', K.cast);
  up(m.gcd, 'global cooldown', K.gcd);
  up(m.regen, `${res} regeneration`, K.regen);
  up(m.rage, 'rage from all sources', K.regen);
  if (m.lifesteal) { const n = Math.round(m.lifesteal * 100); out.push({ text: `Heals you for ${n}% of the damage you deal`, amount: `${n}%`, kind: /heal|damage/ }); }
  up(m.moveSpeed, 'movement speed', K.move);
  if (m.autoSpeed !== undefined && m.autoSpeed !== 1) add(m.autoSpeed < 1 ? '+' : '−', 1 / m.autoSpeed, 'auto attack speed', K.swing);
  for (const [id, a] of Object.entries(m.ability ?? {})) {
    const name = ABILITIES[id]?.name ?? id;
    if (a.damage) add(a.damage > 1 ? '+' : '−', a.damage, 'damage', K.damage, name);
    if (a.heal) add(a.heal > 1 ? '+' : '−', a.heal, ABILITIES[id]?.effects.some((e) => e.type === 'aura' && AURAS[e.aura]?.kind === 'absorb') ? 'shield strength' : 'healing', /heal|shield/, name);
    if (a.castWhileMoving) out.push({ text: `${name}: can be cast while moving`, amount: 'moving', subject: name, kind: /moving|move/ });
    if (a.cooldown) add(a.cooldown < 1 ? '−' : '+', a.cooldown, 'cooldown', K.cooldown, name);
    if (a.castTime) add(a.castTime < 1 ? '−' : '+', a.castTime, 'cast time', K.cast, name);
    if (a.range) out.push({ text: `${name}: ${a.range > 0 ? '+' : '−'}${Math.abs(a.range)} yd range`, amount: `${Math.abs(a.range)} yd`, subject: name, kind: K.range });
    for (const e of a.extra ?? []) {
      // extra effects a buff or talent bolts onto an ability (Enraged Regeneration's Bloodthirst heal)
      if (e.type === 'healMax') out.push({ text: `${name}: also heals you for ${Math.round(e.pct * 100)}% of your maximum health`, amount: `${Math.round(e.pct * 100)}%`, subject: name, kind: /heal/ });
    }
  }
  for (const [id, v] of Object.entries(m.auraDuration ?? {})) add(v > 1 ? '+' : '−', v, 'duration', K.duration, AURAS[id]?.name ?? id);
  return out;
}

/** One line per modifier ("+6% damage dealt"). `res` names the resource in regeneration ("+20% mana regeneration"). */
export function describeMods(m: ModsInput | undefined, res?: string): string[] {
  return modFacts(m, res).map((f) => f.text);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `text` already states this modifier: the same number and unit, the same ability or aura, and the same kind of stat. */
function states(text: string, f: ModFact): boolean {
  const t = text.toLowerCase();
  const n = escapeRe(f.amount.replace(/ yd$|%$/, ''));
  const amount = f.amount.endsWith('%') ? new RegExp(`(?<![\\d.])${n}\\s*%`) : new RegExp(`(?<![\\d.])${n}[\\s-]*(?:yd|yards?)\\b`);
  return amount.test(t) && (!f.subject || t.includes(f.subject.toLowerCase())) && f.kind.test(t);
}

/**
 * The generated modifier lines that a hand-written description (a talent's or a spec's `desc`) does not already state, so
 * the tooltip shows each fact once. A line whose number the text gets wrong stays, which makes the mismatch visible.
 */
export function modsNotIn(text: string, m: ModsInput | undefined): string[] {
  return modFacts(m).filter((f) => !states(text, f)).map((f) => f.text);
}

/**
 * Tooltip text for a talent: its description, the modifier lines it does not spell out, and the bar swap unless the
 * description already says it (a talent named after the ability it teaches only needs to say what it replaces).
 */
export function describeTalent(t: TalentDef): { lines: string[]; mods: string[]; swap?: string } {
  const lines = t.desc ? [t.desc] : [];
  let swap: string | undefined;
  if (t.swap) {
    const to = ABILITIES[t.swap.to]?.name ?? t.swap.to;
    const from = ABILITIES[t.swap.from]?.name ?? t.swap.from;
    const d = t.desc.toLowerCase();
    const namesTo = d.includes(to.toLowerCase()) || t.name.toLowerCase() === to.toLowerCase();
    if (!(namesTo && d.includes(from.toLowerCase()))) swap = `Learn ${to} in place of ${from}`;
  }
  return { lines, mods: modsNotIn(t.desc, t.mods), swap };
}

/**
 * Numbers your build changed can be wrapped as `⟦shown|base|+⟧` (`+` better, `-` worse) so the client can colour them and show
 * the original value; `plainText` strips the marks. Only produced when a describe function is asked to `mark`.
 */
const MARK_RE = /⟦([^|⟧]*)\|([^|⟧]*)\|([+-])⟧/g;
export function plainText(s: string): string {
  return s.replace(MARK_RE, '$1');
}
/** A tooltip line split into plain text and marked numbers. */
export function markedParts(s: string): ({ text: string } | { value: string; base: string; better: boolean })[] {
  const out: ({ text: string } | { value: string; base: string; better: boolean })[] = [];
  let at = 0;
  for (const m of s.matchAll(MARK_RE)) {
    if (m.index! > at) out.push({ text: s.slice(at, m.index) });
    out.push({ value: m[1], base: m[2], better: m[3] === '+' });
    at = m.index! + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}
function marked(mark: boolean | undefined, value: number, base: number, fmt: (n: number) => string = String, higherIsBetter = true): string {
  const v = fmt(value);
  const b = fmt(base);
  if (!mark || v === b) return v;
  return `⟦${v}|${b}|${(higherIsBetter ? value > base : value < base) ? '+' : '-'}⟧`;
}
const secs = (ms: number) => Math.round(ms / 100) / 10;
const fmtS = (n: number) => `${n}s`;

export interface DescribeOptions {
  /** Mark numbers the modifiers changed (see `markedParts`). */
  mark?: boolean;
  /** Name of the resource in regeneration bonuses ("mana regeneration" instead of "resource regeneration"). */
  res?: string;
}

/** One line on what an aura does while it is on you. */
export function describeAura(id: string, mods?: Mods, opts: DescribeOptions = {}): string {
  const a = AURAS[id];
  if (!a) return '';
  return describeBase(id, mods, opts);
}

function describeBase(id: string, mods: Mods | undefined, opts: DescribeOptions): string {
  const a = AURAS[id];
  const modsText = (m: ModsInput | undefined) => describeMods(m, opts.res).map(cap);
  switch (a.kind) {
    case 'stun': return `Cannot move, cast or act.${a.breaksOnDamage ? ' Breaks on damage.' : ''}`;
    case 'incapacitate': return `Cannot move, cast or act${a.canTurn ? ' (can still turn)' : ''}${a.locksAbilities ? ', not even Blink' : ''}. Breaks on damage.${a.hot ? ` Heals ${a.hot.pct}% of maximum health every ${a.hot.interval / 1000}s.` : ''}`;
    case 'fear': return `Runs around in fear at ${Math.round(TUNING.fearSpeed * 100)}% speed. Cannot cast or act${a.locksAbilities ? ', not even Blink' : ''}.${a.breaksOnDamage ? ' Breaks on direct damage, not damage over time.' : ''}`;
    case 'root': return `Cannot move.${a.breaksOnDamage ? ' Breaks on damage.' : ''}`;
    case 'mark': {
      const parts: string[] = [];
      if (a.note) parts.push(a.note);
      if (a.vulnerable) parts.push(`Takes ${a.vulnerable.mult}x damage from ${a.vulnerable.school} abilities`);
      parts.push(...modsText(a.mods));
      if (a.breaksOnDamage) parts.push(`Lost when damaged${a.heldBy ? `, unless ${AURAS[a.heldBy]?.name ?? a.heldBy} is active` : ''}`);
      if (!a.vulnerable && !a.mods && !a.note) parts.push('Ice Lance treats it as Shatter and uses it up');
      return `${parts.join('. ')}.`;
    }
    case 'slow': return `Movement speed reduced by ${a.slowPct ?? 0}%.`;
    case 'speed': return `Movement speed increased by ${a.speedPct ?? 0}%.`;
    case 'absorb': return a.note ? a.note : a.absorbPct ? `Absorbs damage equal to ${Math.round(a.absorbPct * 100)}% of max health.` : `Absorbs ${a.absorb ?? 0} damage.`;
    case 'stealth': return `Hidden from enemies farther than ${TUNING.stealthDetect} yards. Broken by damage or attacking.`;
    case 'buff': {
      if (a.instantFor) return `Your next ${ABILITIES[a.instantFor]?.name ?? a.instantFor} is instant.`;
      const parts = modsText(a.mods);
      if (a.empower) parts.push(`Your next ${a.empower.school} damage ability deals ${Math.round((a.empower.mult - 1) * 100)}% more damage and uses this up`);
      if (a.hot) parts.push(`Heals ${a.hot.pct}% of maximum health every ${a.hot.interval / 1000}s`);
      if (a.noCast) parts.push('You cannot use any ability while it lasts');
      if (a.maxStacks) parts.push(`Stacks up to ${a.maxStacks} times`);
      if (a.note) parts.unshift(a.note.replace(/\.$/, ''));
      return parts.join('. ') + '.';
    }
    case 'dot': {
      if (!a.dot) return '';
      const dot = a.dot;
      const per = (m: Mods | undefined) => Math.round(dot.amount * (m ? m.damageDone * (m.ability[dot.ability]?.damage ?? 1) : 1));
      const total = (m: Mods | undefined) => per(m) * Math.round((a.duration * (m?.auraDuration[id] ?? 1)) / dot.interval);
      const mk = (f: (m: Mods | undefined) => number) => marked(opts.mark, f(mods), f(undefined));
      const cant = a.silence && a.disarm ? ' Silenced and disarmed: cannot cast spells, auto attack or use physical abilities.' : a.silence ? ' Silenced: cannot cast spells.' : a.disarm ? ' Disarmed: cannot auto attack or use physical abilities.' : '';
      return `${a.bleed ? 'Bleeding: takes' : 'Takes'} ${mk(per)} ${dot.school} damage every ${sec(dot.interval)}${a.perCp ? ' for each combo point spent' : a.duration ? ` (${mk(total)} total)` : ''}.${cant}`;
    }
  }
}

export interface AbilityText {
  name: string;
  school: string;
  /** "40 mana · 30 yd range · 1.5s cast · 8s slow" style header pieces. */
  stats: string[];
  /** One sentence per effect. */
  lines: string[];
  /** What the build's talents add to the ability (extra effects, charges, procs), shown as bonuses. */
  added: string[];
  /** Special requirements, shown in red/yellow. */
  notes: string[];
}

type AuraEffect = Extract<Effect, { type: 'aura' }>;

/** The label of a duration chip ("8s slow"): what kind of lasting effect it is. */
const LASTING: Record<AuraKind, string> = {
  stun: 'stun', incapacitate: 'incapacitate', fear: 'fear', root: 'root', slow: 'slow', speed: 'speed boost', absorb: 'shield',
  stealth: 'stealth', buff: 'buff', dot: 'damage over time', mark: 'effect',
};

/**
 * Describe an ability, optionally with a unit's modifiers applied so the numbers match what it will actually do. Every
 * cost, resource gain, cast, cooldown, range and duration is stated once: as a chip in `stats` or in the effect line.
 */
export function describeAbility(def: AbilityDef, mods: Mods = newMods(), classResource?: string, opts: DescribeOptions = {}): AbilityText {
  const am = mods.ability[def.id] ?? {};
  const res = classResource ?? (def.class === 'trinket' ? 'mana' : CLASSES[def.class].resource.type);
  const o: DescribeOptions = { ...opts, res };
  /** A number worked out with these modifiers, marked against the unmodified data when asked. */
  const M = (f: (m: Mods) => number, fmt: (n: number) => string = String, higherIsBetter = true) => marked(opts.mark, f(mods), f(NEUTRAL_MODS), fmt, higherIsBetter);
  const ab = (m: Mods) => m.ability[def.id] ?? {};
  const aoe = def.target === 'aoe_enemy' || def.target === 'aoe_all';

  const stats: string[] = [];
  if (def.cost) stats.push(`${M((m) => Math.round(def.cost * (ab(m).cost ?? 1)), String, false)} ${res}`);
  // a range talent makes an area ability reach further (a longer cone, a wider circle)
  const reachOf = (m: Mods) => (def.radius ?? 0) + (ab(m).range ?? 0);
  if (def.target === 'aoe_enemy' && def.coneDeg) stats.push(`${M(reachOf)} yd range, ${def.coneDeg}° cone in front of you`);
  else if (aoe) stats.push(`${M(reachOf)} yd radius`);
  else if (def.target === 'ground') stats.push(`${M((m) => def.range + (ab(m).range ?? 0))} yd range`, 'Aimed at the cursor');
  else if (def.range > 0) stats.push(`${M((m) => def.range + (ab(m).range ?? 0))} yd range`);
  else if (def.target === 'enemy' || def.target === 'any') stats.push('Melee range');
  if (def.minRange) stats.push(`min ${def.minRange} yd`);
  const castMs = (m: Mods) => def.castTime * m.castTime * (ab(m).castTime ?? 1);
  if (def.castTime > 0) stats.push(`${M((m) => secs(castMs(m)), fmtS, false)} ${def.channel ? 'channel' : 'cast'}`);
  else stats.push('Instant');
  if (def.cooldown > 0) stats.push(`${M((m) => secs(def.cooldown * (ab(m).cooldown ?? 1)), fmtS, false)} cooldown`);
  const uses = (m: Mods) => 1 + (ab(m).stored ?? 0) + (ab(m).charges ?? 0);
  if (uses(mods) > 1) stats.push(`${M(uses)} charges`);

  /** How long an aura effect lasts in seconds (the effect can override the aura's own duration), 0 for until removed. */
  const auraSecs = (e: AuraEffect, m: Mods) => {
    const ms = e.duration ?? AURAS[e.aura]?.duration ?? 0;
    return ms > 0 ? secs(ms * (m.auraDuration[e.aura] ?? 1)) : 0;
  };
  const D = (e: AuraEffect) => M((m) => auraSecs(e, m), fmtS);
  // Charge describes its own stun, so that aura gets no line of its own
  const chargeStun = def.effects.some((e) => e.type === 'charge') ? def.effects.find((e): e is AuraEffect => e.type === 'aura' && AURAS[e.aura]?.kind === 'stun') : undefined;
  // the ability's own lasting effect (Hamstring's slow, Blizzard's storm, the banner) gets its duration as a chip
  const lasting = def.effects.filter((e): e is AuraEffect | Extract<Effect, { type: 'zone' | 'flag' | 'smoke' }> => (e.type === 'aura' && e !== chargeStun && e.chance === undefined && AURAS[e.aura]?.name === def.name && auraSecs(e, mods) > 0)
    || e.type === 'zone' || e.type === 'flag' || e.type === 'smoke');
  const main = lasting.length === 1 ? lasting[0] : undefined;
  if (main?.type === 'aura') {
    const a = AURAS[main.aura];
    if (main.cpDot) stats.push(`+${sec(main.extraPerCp ?? 0)} per combo point, up to ${sec(a.maxDuration ?? 0)} ${LASTING[a.kind]}`);
    else stats.push(`${D(main)} ${a.kind === 'dot' && a.bleed ? 'bleed' : LASTING[a.kind]}${main.extraPerCp ? ` (+${sec(main.extraPerCp)} per combo point${a.maxDuration ? `, up to ${sec(a.maxDuration)}` : ''})` : ''}`);
  } else if (main) stats.push(`${fmtS(main.duration / 1000)} ${main.type === 'zone' ? 'ground effect' : main.type === 'flag' ? 'banner' : 'smoke cloud'}`);

  const ticks = def.channel?.ticks ?? 1;
  const every = def.channel ? M((m) => secs(castMs(m) / ticks), fmtS, false) : '';
  const stops = def.unstoppable ? '' : def.channel?.hold ? 'You stand still while it lasts, and being interrupted stops it.' : def.castWhileMoving || ab(mods).castWhileMoving ? 'Being interrupted stops it.' : 'Moving or being interrupted stops it.';
  const dmgOf = (amount: number) => (m: Mods) => Math.round(amount * m.damageDone * (ab(m).damage ?? 1));
  const healOf = (amount: number) => (m: Mods) => Math.round(amount * m.healingDone * (ab(m).heal ?? 1));

  const describeEffect = (e: Effect): string | undefined => {
    switch (e.type) {
      case 'damage': {
        const n = dmgOf(e.amount);
        const N = M(n);
        const T = M((m) => n(m) * ticks);
        // stated here only (the in-depth view does not repeat it)
        const scaling = `${def.cpScale ? ' Damage is multiplied by the combo points spent.' : ''}${def.consumes ? ` Consumes ${AURAS[def.consumes.aura]?.name ?? def.consumes.aura}: +${Math.round(def.consumes.perStack * 100)}% damage per stack.` : ''}`;
        const first = def.channel?.immediate ? ' (the first at once)' : '';
        if (def.channel?.beam) return `Channels a beam into the target, dealing ${N} ${def.school} damage every ${every} (${T} total).${stops ? ` ${stops}` : ''}${scaling}`;
        if (def.channel && e.only) return `On an enemy: deals ${N} ${def.school} damage every ${every} (${T} total).${scaling}`;
        if (def.channel && def.school === 'physical') return `Strikes${aoe ? ' every enemy in range' : ''} ${ticks} times, once every ${every}${first}, for ${N} physical damage each (${T} total).${stops ? ` ${stops}` : ''}${scaling}`;
        if (def.channel) return `Fires ${ticks} missiles, one every ${every}${first}, each dealing ${N} ${def.school} damage (${T} total).${stops ? ` ${stops}` : ''}${scaling}`;
        return `Deals ${N} ${def.school} damage${aoe ? ' to all enemies in range' : ''}.${scaling}`;
      }
      case 'heal': {
        const h = healOf(e.amount);
        return `${e.only === 'ally' ? (def.target === 'aoe_all' ? 'Heals you and every ally in range' : 'On an ally: heals') : 'Heals'} for ${M(h)}${def.channel ? ` every ${every} (${M((m) => h(m) * ticks)} total)` : ''}.`;
      }
      case 'healMissing':
        return `Heals ${def.target === 'self' ? 'you' : 'the target'} for ${Math.round(e.pct * 100)}% of ${def.target === 'self' ? 'your' : 'its'} missing health.`;
      case 'aura': {
        const a = AURAS[e.aura];
        if (!a || e === chargeStun) return undefined;
        const dur = auraSecs(e, mods);
        const extra = e.extraPerCp ? ` (+${sec(e.extraPerCp)} per combo point spent${a.maxDuration ? `, up to ${sec(a.maxDuration)} in all` : ''})` : '';
        const body = a.kind === 'absorb'
          ? `Absorbs ${a.absorbPct ? `${Math.round(a.absorbPct * 100)}% of your max health` : `${M((m) => Math.round((a.absorb ?? 0) * m.healingDone * (m.ability[def.id]?.heal ?? 1)))} damage`}`
          : describeAura(e.aura, mods, o).replace(/\.$/, '');
        const onYou = e.self || def.target === 'self';
        const youLead = onYou && def.target !== 'self' ? 'On you' : '';
        if (e === main) return `${youLead ? `${youLead}: ` : ''}${body}.`; // the duration is the chip
        if (a.name === def.name && e.chance === undefined) {
          // the effect carries the ability's own name (Frost Nova's root): don't repeat the title
          const lead = youLead ? `On you${dur ? ` for ${D(e)}` : ''}` : dur ? `For ${D(e)}` : '';
          return `${lead ? `${lead}${extra}: ` : ''}${body}.`;
        }
        const who = onYou ? 'You gain' : def.target === 'aoe_all' && e.only === 'ally' ? 'You and every ally in range gain' : def.target === 'aoe_enemy' || def.target === 'enemy' ? 'Applies' : 'Target gains';
        const when = e.fullCast ? ' (only from a full-length cast)' : '';
        return `${e.chance !== undefined ? `${Math.round(e.chance * 100)}% chance: ` : ''}${who} ${a.name}${dur ? ` for ${D(e)}` : ''}${extra}${when}: ${body}.`;
      }
      case 'exsanguinate':
        return `Deals ${M(dmgOf(e.perCp))} damage per combo point spent plus ${Math.round(e.bleedFraction * 100)}% of the bleed damage remaining on the target, then makes every current bleed deal ${e.bleedMult}x damage (using it again does not stack).`;
      case 'interrupt':
        return `Interrupts the target's spellcasting and locks out that school for ${sec(e.lockout)}.`;
      case 'dispel':
        if (e.all) return `Removes every harmful magic effect from ${def.target === 'aoe_all' ? 'you and every ally in range' : 'the target'}.`;
        return def.target === 'any' ? 'Removes one magic effect: a harmful one from allies, a beneficial one from enemies.' : 'Removes one magic effect.';
      case 'charge':
        return `Stuns the target${chargeStun && auraSecs(chargeStun, mods) ? ` for up to ${D(chargeStun)}` : ''} as you sprint at it, closing the distance in about a second${e.hit ? `, then hits it for ${M(dmgOf(e.hit))} and ends the stun when you land` : ''}. You cannot steer while charging; taking damage, a stun or a root stops you (and frees the target).`;
      case 'dashToTarget':
        return e.behind ? 'Rushes to the target and lands behind it, turning you to face it.' : 'Rushes to the target.';
      case 'healMax':
        return `Heals you for ${Math.round(e.pct * 100)}% of your maximum health.`;
      case 'leap':
        return `Leaps through the air to the chosen spot${e.damage ? `, slamming enemies within ${e.radius ?? 5} yards for ${M(dmgOf(e.damage))} damage on landing` : ''}.`;
      case 'pull':
        return `Drags ${def.target === 'aoe_enemy' ? 'every enemy hit' : 'the target'} to ${e.stopDistance} yards in front of you.`;
      case 'flag':
        return `Plants a banner at the chosen spot${e === main ? '' : ` for ${fmtS(e.duration / 1000)}`}. Enemies inside its ${e.radius}-yard circle cannot leave it.`;
      case 'blink':
        return `Teleports you ${e.distance} yards forward and frees you from stuns, roots and slows. Works while stunned.`;
      case 'gain':
        return `Generates ${e.amount} ${res}.`;
      case 'freeMove':
        // a full cleanse already removes roots and slows (Vanish has both)
        return def.effects.some((x) => x.type === 'cleanse') ? undefined : 'Removes every root and slow from you.';
      case 'cleanse':
        return 'Removes every harmful effect from you.';
      case 'dropCombat':
        return 'Drops you out of combat: enemies lose their target on you and spells aimed at you are cancelled.';
      case 'smoke':
        return `Drops a smoke cloud with a ${e.radius}-yard radius${e === main ? '' : ` for ${fmtS(e.duration / 1000)}`}. Its edge blocks sight: enemies outside cannot see or target anyone inside, and enemies inside cannot see or target anyone outside. Inside the cloud everyone sees and fights each other as usual.`;
      case 'proc':
        return `${Math.round(e.p * 100)}% chance: ${e.effects.map(describeEffect).filter(Boolean).join(' ')}`;
      case 'cast': {
        const other = ABILITIES[e.ability];
        return `Also casts ${other?.name ?? e.ability} for free${other ? `: ${describeAbility(other).lines.join(' ')}` : ''}`;
      }
      case 'strip':
        return `Removes ${e.kinds.map((k) => (k === 'dot' ? 'damage over time' : k === 'fear' ? 'fear' : `${k}`)).join(' and ')} effects from the target.`;
      case 'dropTargets':
        return 'Enemies lose their target on you and spells aimed at you are cancelled.';
      case 'zoneBuff': {
        const a = AURAS[e.aura];
        return `Marks ${an(e.radius)}-yard circle at the chosen spot for ${fmtS(e.duration / 1000)}. ${e.who === 'allies' ? 'You and your allies' : 'You'} standing inside: ${a ? describeAura(e.aura, mods, o).replace(/\.$/, '') : e.aura}.`;
      }
      case 'zone': {
        const first = e.initial ? `Enemies in the area take ${M(dmgOf(e.initial))} ${def.school} damage the moment the cast lands. ` : '';
        return `${first}Marks ${an(e.radius)}-yard circle at the chosen spot${e === main ? '' : ` for ${fmtS(e.duration / 1000)}`}. Enemies ${e.initial ? 'still ' : ''}inside take ${M(dmgOf(e.amount))} ${def.school} damage every ${fmtS(e.pulse / 1000)}. Jump to avoid a pulse (one dodging jump every ${fmtS(JUMP_DODGE_CD / 1000)}).${e.procOnHit && AURAS[e.procOnHit] ? ` If the opening hit lands on an enemy you always gain ${AURAS[e.procOnHit].name}.` : ''}`;
      }
    }
  };

  const lines = def.effects.map(describeEffect).filter((l): l is string => !!l);

  // what the talents add on top of the ability's own effects
  const added: string[] = [];
  for (const e of am.extra ?? []) {
    const l = describeEffect(e);
    if (l) added.push(l);
  }
  for (const id of am.after ?? []) {
    const a = AURAS[id];
    if (a) added.push(`After using it you gain ${a.name}${a.duration ? ` for ${sec(a.duration * (mods.auraDuration[id] ?? 1))}` : ''}: ${describeAura(id, mods, o).replace(/\.$/, '')}.`);
  }
  for (const e of [...def.effects, ...(am.extra ?? [])]) {
    const ext = e.type === 'aura' ? mods.auraExtend[e.aura] : 0;
    if (e.type !== 'aura' || !ext) continue;
    const a = AURAS[e.aura];
    const what = a?.name === def.name ? `its ${a.kind === 'dot' && a.bleed ? 'bleed' : LASTING[a.kind]}` : a?.name ?? e.aura;
    added.push(`Using it again while ${what} lasts adds ${sec(ext)} to it instead of restarting it.`);
  }
  if (am.cpChance && def.cpGain) added.push(`${Math.round(am.cpChance * 100)}% chance to award 1 extra combo point.`);
  if (am.shadowProc) added.push(`${Math.round(am.shadowProc * 100)}% chance to first Shadowstep you behind the target for free (no combo points).`);
  const usesCp = def.cpScale || def.cpSpend || def.effects.some((e) => (e.type === 'aura' && e.extraPerCp) || e.type === 'exsanguinate');
  if (usesCp && mods.maxCp) added.push(`Can spend up to ${5 + mods.maxCp} combo points.`);
  if (usesCp && mods.cpPower !== 1) added.push(`Each combo point spent counts ${mult(mods.cpPower)}.`);

  const notes: string[] = [];
  if (def.cpGain) notes.push(`Awards ${def.cpGain} combo point${def.cpGain > 1 ? 's' : ''}.`);
  if (def.rageSpend) notes.push(`Spends all your rage (needs ${def.rageSpend.min}): damage grows from x1 at ${def.rageSpend.min} rage to x${def.rageSpend.maxMult} at full rage.`);
  if (def.cpSpend) notes.push('Spends all combo points (needs at least 1).');
  // a free hit builds rage from the damage it deals (an ability that costs rage refunds none from its own hit)
  const firstHit = def.effects.map((e) => (e.type === 'damage' ? e.amount : e.type === 'charge' ? e.hit ?? 0 : e.type === 'leap' ? e.damage ?? 0 : e.type === 'zone' ? e.initial ?? e.amount : 0)).find((n) => n > 0);
  if (res === 'rage' && !def.cost && firstHit) notes.push(`Its damage builds rage: ${Math.round(TUNING.rageFromDealt * 100)}% of the damage dealt (${M((m) => Math.round(dmgOf(firstHit)(m) * TUNING.rageFromDealt))} per ${aoe || def.effects.some((e) => e.type === 'leap' || e.type === 'zone') ? 'enemy hit' : 'hit'}).`);
  if (def.requiresStealth) notes.push('Requires stealth.');
  if (def.stealthSwap && ABILITIES[def.stealthSwap]) notes.push(`While you are stealthed this slot becomes ${ABILITIES[def.stealthSwap].name}.`);
  if (def.castWhileMoving || mods.ability[def.id]?.castWhileMoving) notes.push('Can be cast while moving.');
  if (def.unstoppable) notes.push('Cannot be interrupted, and nothing ends it early: while it lasts you are immune to stuns, fears, incapacitates, roots, slows and pulls, and your other skills wait until it is over.');
  if (def.requiresTargetCasting) notes.push('Target must be casting.');
  if (def.maxTargetHealthPct !== undefined) notes.push(`Only usable on targets below ${def.maxTargetHealthPct}% health.`);
  if (def.outOfCombatOnly) notes.push('Cannot be used in combat.');
  if (def.ignoresLockout) notes.push('Usable while locked out.');
  if (def.ignoresControl && def.effects.some((e) => e.type === 'cleanse')) notes.push('Works even while polymorphed or disoriented.');
  else if (def.ignoresControl && !lines.some((l) => /while stunned/i.test(l))) {
    const locks = Object.values(AURAS).filter((a) => a.locksAbilities).map((a) => a.name);
    notes.push(`Works while stunned, feared or rooted${locks.length ? `, but not while ${locks.join(' or ')} holds you` : ''}.`);
  }
  if (!def.gcd) notes.push('Does not trigger the global cooldown.');
  return { name: def.name, school: def.school, stats, lines, added, notes };
}


/**
 * The in-depth tooltip text (hold Alt): how each number is worked out, what boosts it and what changes it. Built from the
 * same data and the same modifiers the sim uses. `sources` lists the spec and talents so each bonus can be named.
 */
export function explainAbility(def: AbilityDef, mods: Mods = newMods(), sources: ModSource[] = []): string[] {
  const out: string[] = [];
  const am = mods.ability[def.id] ?? {};
  const from = (pick: (m: ModsInput) => number | undefined) => sources.flatMap((s) => {
    const v = s.mods ? pick(s.mods) : undefined;
    return v !== undefined && v !== 1 ? [{ label: s.label, v }] : [];
  });
  const dmgSources = [...from((m) => m.damageDone), ...from((m) => m.ability?.[def.id]?.damage)];
  const healSources = [...from((m) => m.healingDone), ...from((m) => m.ability?.[def.id]?.heal)];

  // The short view already shows each changed number next to its base value, so this only says what changed it and by how
  // much. Combo points, rage spending and Consumes are explained there too, so they are not repeated here.
  const because = (list: { label: string; v: number }[], total: number) =>
    list.length ? list.map((x) => `${mult(x.v)} ${x.label}`).join(', ') : Math.abs(total - 1) > 1e-9 ? `${mult(total)} from your build` : '';
  const why = (what: string, list: { label: string; v: number }[], total: number) => {
    const b = because(list, total);
    if (b) out.push(`${what}: ${b}.`);
  };
  const dealsDamage = def.effects.some((e) => e.type === 'damage' || e.type === 'zone' || e.type === 'exsanguinate' || (e.type === 'leap' && !!e.damage) || (e.type === 'charge' && !!e.hit));
  const heals = def.effects.some((e) => e.type === 'heal');
  const dmgWhy = dealsDamage ? because(dmgSources, mods.damageDone * (am.damage ?? 1)) : '';
  const healWhy = heals ? because(healSources, mods.healingDone * (am.heal ?? 1)) : '';
  if (dmgWhy && dmgWhy === healWhy) out.push(`Damage and healing: ${dmgWhy}.`);
  else {
    if (dmgWhy) out.push(`Damage: ${dmgWhy}.`);
    if (healWhy) out.push(`Healing: ${healWhy}.`);
  }
  if (heals) out.push('Healing on a target with a healing debuff is reduced by it.');
  if (def.castTime > 0) why('Cast time', [...from((m) => m.castTime), ...from((m) => m.ability?.[def.id]?.castTime)], mods.castTime * (am.castTime ?? 1));
  if (def.cooldown > 0) why('Cooldown', from((m) => m.ability?.[def.id]?.cooldown), am.cooldown ?? 1);
  if (def.cost) why('Cost', from((m) => m.ability?.[def.id]?.cost), am.cost ?? 1);
  const reach = sources.flatMap((x) => (x.mods?.ability?.[def.id]?.range ? [`+${x.mods.ability[def.id].range} yd ${x.label}`] : []));
  if (reach.length) out.push(`Range: ${reach.join(', ')}.`);
  for (const id of new Set(def.effects.flatMap((e) => (e.type === 'aura' ? [e.aura] : [])))) {
    if ((mods.auraDuration[id] ?? 1) !== 1) why(AURAS[id]?.name === def.name ? 'Duration' : `${AURAS[id]?.name ?? id} duration`, from((m) => m.auraDuration?.[id]), mods.auraDuration[id]);
  }
  if (def.behindMult) out.push(`Position: x${def.behindMult} damage from behind the target.`);
  if (def.exploit) out.push(`Bonus: counts as ${mult(def.exploit.mult)} when the target has ${AURAS[def.exploit.aura]?.name ?? def.exploit.aura}, and uses it up.`);
  if (def.requiresTargetAura && !am.free) out.push(`Needs the target to have ${def.requiresTargetAura.map((a) => AURAS[a]?.name ?? a).join(' or ')}.`);

  // buffs on you that raise it, debuffs on the target that make it hit harder
  const boosts: string[] = [];
  const weaknesses: string[] = [];
  const usable = (auraId: string) => {
    const givers = Object.values(ABILITIES).filter((ab) => ab.effects.some((e) => e.type === 'aura' && e.aura === auraId));
    return !givers.length || givers.some((ab) => ab.class === def.class || ab.target === 'ally' || ab.target === 'any'); // a buff only counts when you can have it
  };
  // auras this ability applies are already described in the short tooltip (Pyroblast's Hot Streak, Frost Nova's Shatter)
  const own = new Set(def.effects.flatMap((e) => (e.type === 'aura' ? [e.aura] : [])));
  for (const [auraId, a] of Object.entries(AURAS)) {
    if (own.has(auraId) || !usable(auraId)) continue;
    if (a.harmful) {
      if (dealsDamage && a.vulnerable && a.vulnerable.school === def.school) weaknesses.push(`${a.name}: target takes ${mult(a.vulnerable.mult)} ${def.school} damage`);
      continue;
    }
    const m = a.mods;
    const v = (m?.damageDone ?? 1) * (m?.ability?.[def.id]?.damage ?? 1);
    const h = (m?.healingDone ?? 1) * (m?.ability?.[def.id]?.heal ?? 1);
    const dmgUp = v > 1 && def.effects.some((e) => e.type === 'damage');
    const healUp = h > 1 && def.effects.some((e) => e.type === 'heal');
    // one entry per buff, even when it raises both the damage and the healing (Power Infusion on Penance)
    if (dmgUp && healUp) boosts.push(v === h ? `${a.name} ${mult(v)}` : `${a.name} ${mult(v)} damage, ${mult(h)} healing`);
    else if (dmgUp) boosts.push(`${a.name} ${mult(v)}`);
    else if (healUp) boosts.push(`${a.name} ${mult(h)}`);
    if (a.empower && a.empower.school === def.school) boosts.push(`${a.name} ${mult(a.empower.mult)} on your next hit`);
    if (a.instantFor === def.id) boosts.push(`${a.name}: makes it instant`);
  }
  if (boosts.length) out.push(`Boosted by: ${boosts.join(', ')}.`);
  if (weaknesses.length) out.push(`Hits harder on: ${weaknesses.join(', ')}.`);

  // crowd control: diminishing returns
  const cc = def.effects.flatMap((e) => (e.type === 'aura' && AURAS[e.aura] && ['stun', 'incapacitate', 'fear', 'root'].includes(AURAS[e.aura].kind) ? [AURAS[e.aura]] : []));
  if (cc.length) {
    const steps = TUNING.drSteps.map((v) => (v <= 0 ? 'immune' : `${Math.round(v * 100)}%`)).join(' → ');
    out.push(`Diminishing returns: repeated crowd control of the same kind lasts ${steps}. The count resets after ${sec(TUNING.drResetMs)} without it.`);
  }
  if (def.effects.some((e) => e.type === 'interrupt')) out.push('Interrupts have their own lockout and do not share diminishing returns with other crowd control.');
  if (def.gcd) out.push(`Triggers the global cooldown (${sec(TUNING.gcdMs * mods.gcd)}).`);
  return out;
}

/**
 * A spec's passives: what it gives without a button. Its built-in effect (Cauterize), its weapon and auto-attack, and
 * every bonus its stat modifiers carry, one line each. Shown on the spec card and in the spec tooltip.
 */
export function specPassives(classId: ClassId, specId: string): string[] {
  const spec = SPECS[classId]?.find((s) => s.id === specId);
  if (!spec) return [];
  const out: string[] = [];
  if (spec.passive === 'cauterize') {
    out.push(`Cauterize: a blow that would kill you leaves you at ${Math.round(TUNING.cauterizeHealth * 100)}% health instead (once every ${Math.round(TUNING.cauterizeCooldownMs / 60000)} minutes).`);
  }
  if (spec.weapon) {
    const auto = spec.auto ?? CLASSES[classId].auto;
    out.push(`${spec.weapon.name}${auto ? `: auto-attacks for ${auto.damage} every ${(auto.interval / 1000).toFixed(1)}s at ${auto.range} yd` : ''}.`);
  }
  out.push(...describeMods(spec.mods, CLASSES[classId].resource.type).map(cap));
  return out;
}

/**
 * Where an aura can come from, for its tooltip: the abilities that apply it (and who has them), a spec's built-in passive,
 * or a talent that adds it to an ability.
 */
export function auraOrigins(auraId: string): string[] {
  const out = new Set<string>();
  for (const a of Object.values(ABILITIES)) if (a.effects.some((e) => (e.type === 'aura' && e.aura === auraId) || (e.type === 'zone' && e.procOnHit === auraId))) out.add(a.name);
  for (const [cls, specs] of Object.entries(SPECS)) {
    for (const s of specs) {
      if (s.passive === 'cauterize' && auraId === 'cauterized') out.add(`${s.name}'s passive (Cauterize)`);
      for (const tier of TALENTS[cls as ClassId]?.[s.id] ?? []) {
        for (const t of tier) {
          const adds = Object.values(t.mods?.ability ?? {}).some((m) => (m.after ?? []).includes(auraId) || (m.extra ?? []).some((e) => e.type === 'aura' && e.aura === auraId));
          if (adds) out.add(`talent ${t.name}`);
        }
      }
    }
  }
  return [...out];
}
