import { ABILITIES, AURAS, CLASSES, TUNING } from './data';
import { newMods } from './build';
import { JUMP_DODGE_CD } from './jump';
import type { AbilityDef, Mods, ModsInput } from './types';

/** Human-readable text for tooltips, generated from the same data the sim uses so it can never drift. */

const sec = (ms: number) => `${Math.round(ms / 100) / 10}s`;
const pct = (v: number) => `${Math.round(Math.abs(v - 1) * 1000) / 10}%`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function describeMods(m: ModsInput | undefined): string[] {
  const out: string[] = [];
  if (!m) return out;
  const up = (v: number | undefined, more: string, less: string) => {
    if (v === undefined || v === 1) return;
    out.push(v > 1 ? `+${pct(v)} ${more}` : `−${pct(v)} ${less}`);
  };
  up(m.damageDone, 'damage dealt', 'damage dealt');
  up(m.healingDone, 'healing and shields', 'healing and shields');
  if (m.healingTaken !== undefined && m.healingTaken !== 1) out.push(m.healingTaken < 1 ? `−${pct(m.healingTaken)} healing received` : `+${pct(m.healingTaken)} healing received`);
  if (m.damageTaken !== undefined && m.damageTaken !== 1) out.push(m.damageTaken < 1 ? `−${pct(m.damageTaken)} damage taken` : `+${pct(m.damageTaken)} damage taken`);
  up(m.maxHealth, 'maximum health', 'maximum health');
  if (m.castTime !== undefined && m.castTime !== 1) out.push(m.castTime < 1 ? `−${pct(m.castTime)} cast time` : `+${pct(m.castTime)} cast time`);
  if (m.gcd !== undefined && m.gcd !== 1) out.push(m.gcd < 1 ? `−${pct(m.gcd)} global cooldown` : `+${pct(m.gcd)} global cooldown`);
  up(m.regen, 'resource regeneration', 'resource regeneration');
  up(m.moveSpeed, 'movement speed', 'movement speed');
  if (m.autoSpeed !== undefined && m.autoSpeed !== 1) out.push(m.autoSpeed < 1 ? `+${pct(1 / m.autoSpeed)} auto attack speed` : `−${pct(1 / m.autoSpeed)} auto attack speed`);
  for (const [id, a] of Object.entries(m.ability ?? {})) {
    const name = ABILITIES[id]?.name ?? id;
    if (a.damage) out.push(`${name}: ${a.damage > 1 ? '+' : '−'}${pct(a.damage)} damage`);
    if (a.heal) out.push(`${name}: ${a.heal > 1 ? '+' : '−'}${pct(a.heal)} healing`);
    if (a.cooldown) out.push(`${name}: ${a.cooldown < 1 ? '−' : '+'}${pct(a.cooldown)} cooldown`);
    if (a.castTime) out.push(`${name}: ${a.castTime < 1 ? '−' : '+'}${pct(a.castTime)} cast time`);
    if (a.range) out.push(`${name}: ${a.range > 0 ? '+' : '−'}${Math.abs(a.range)} yd range`);
  }
  for (const [id, v] of Object.entries(m.auraDuration ?? {})) out.push(`${AURAS[id]?.name ?? id}: ${v > 1 ? '+' : '−'}${pct(v)} duration`);
  return out;
}

/** One line on what an aura does while it is on you. */
export function describeAura(id: string, mods?: Mods): string {
  const a = AURAS[id];
  if (!a) return '';
  return describeBase(id, mods);
}

function describeBase(id: string, mods?: Mods): string {
  const a = AURAS[id];
  switch (a.kind) {
    case 'stun': return 'Cannot move, cast or act.';
    case 'incapacitate': return `Cannot move, cast or act${a.canTurn ? ' (can still turn)' : ''}${a.locksAbilities ? ', not even Blink' : ''}. Breaks on damage.${a.hot ? ` Heals ${a.hot.pct}% of maximum health every ${a.hot.interval / 1000}s.` : ''}`;
    case 'fear': return `Runs around in fear at ${Math.round(TUNING.fearSpeed * 100)}% speed. Cannot cast or act${a.locksAbilities ? ', not even Blink' : ''}.${a.breaksOnDamage ? ' Breaks on direct damage, not damage over time.' : ''}`;
    case 'root': return 'Cannot move.';
    case 'mark': {
      const parts: string[] = [];
      if (a.vulnerable) parts.push(`Takes ${a.vulnerable.mult}x damage from ${a.vulnerable.school} abilities`);
      parts.push(...describeMods(a.mods).map(cap));
      if (a.breaksOnDamage) parts.push(`Lost when damaged${a.heldBy ? `, unless ${AURAS[a.heldBy]?.name ?? a.heldBy} is active` : ''}`);
      if (!a.vulnerable && !a.mods) parts.push('Ice Lance treats it as Shatter and uses it up');
      return `${parts.join('. ')}.`;
    }
    case 'slow': return `Movement speed reduced by ${a.slowPct ?? 0}%.`;
    case 'speed': return `Movement speed increased by ${a.speedPct ?? 0}%.`;
    case 'absorb': return a.absorbPct ? `Absorbs damage equal to ${Math.round(a.absorbPct * 100)}% of max health.` : `Absorbs ${a.absorb ?? 0} damage.`;
    case 'stealth': return `Hidden from enemies farther than ${TUNING.stealthDetect} yards. Broken by damage or attacking.`;
    case 'buff': {
      if (a.instantFor) return `Your next ${ABILITIES[a.instantFor]?.name ?? a.instantFor} is instant.`;
      const parts = describeMods(a.mods).map(cap);
      if (a.empower) parts.push(`Your next ${a.empower.school} damage ability deals ${Math.round((a.empower.mult - 1) * 100)}% more damage and uses this up`);
      if (a.hot) parts.push(`Heals ${a.hot.pct}% of maximum health every ${a.hot.interval / 1000}s`);
      if (a.noCast) parts.push('You cannot use any ability while it lasts');
      if (a.maxStacks) parts.push(`Stacks up to ${a.maxStacks} times`);
      return parts.join('. ') + '.';
    }
    case 'dot': {
      if (!a.dot) return '';
      const per = Math.round(a.dot.amount * (mods ? mods.damageDone * (mods.ability[a.dot.ability]?.damage ?? 1) : 1));
      return `${a.bleed ? 'Bleeding: takes' : 'Takes'} ${per} ${a.dot.school} damage every ${sec(a.dot.interval)}${a.duration ? ` (${per * Math.round(a.duration / a.dot.interval)} total)` : ''}.`;
    }
  }
}

export interface AbilityText {
  name: string;
  school: string;
  /** "40 mana · 30 yd range · 1.5s cast" style header pieces. */
  stats: string[];
  /** One sentence per effect. */
  lines: string[];
  /** Special requirements, shown in red/yellow. */
  notes: string[];
}

/** Describe an ability, optionally with a unit's modifiers applied so the numbers match what it will actually do. */
export function describeAbility(def: AbilityDef, mods: Mods = newMods(), classResource?: string): AbilityText {
  const am = mods.ability[def.id] ?? {};
  const res = classResource ?? CLASSES[def.class].resource.type;
  const stats: string[] = [];
  if (def.cost) stats.push(`${def.cost} ${res}`);
  if (def.target === 'aoe_enemy' && def.coneDeg) stats.push(`${def.radius} yd range, ${def.coneDeg}° cone in front of you`);
  else if (def.target === 'aoe_enemy' || def.target === 'aoe_all') stats.push(`${def.radius} yd radius`);
  else if (def.target === 'ground') stats.push(`${def.range + (am.range ?? 0)} yd range`, 'Aimed at the cursor');
  else if (def.range > 0) stats.push(`${def.range + (am.range ?? 0)} yd range`);
  else if (def.target === 'enemy' || def.target === 'any') stats.push('Melee range');
  if (def.minRange) stats.push(`min ${def.minRange} yd`);
  if (def.castTime > 0) stats.push(`${sec(def.castTime * mods.castTime * (am.castTime ?? 1))} ${def.channel ? 'channel' : 'cast'}`);
  else stats.push('Instant');
  if (def.cooldown > 0) stats.push(`${sec(def.cooldown * (am.cooldown ?? 1))} cooldown`);

  const lines: string[] = [];
  for (const e of def.effects) {
    switch (e.type) {
      case 'damage': {
        const n = Math.round(e.amount * mods.damageDone * (am.damage ?? 1));
        if (def.channel?.beam) lines.push(`Channels a beam into the target, dealing ${n} ${def.school} damage per pulse (${n * def.channel.ticks} total). Moving or being interrupted breaks the beam.`);
        else if (def.channel && e.only) lines.push(`On an enemy: deals ${n} ${def.school} damage per pulse (${n * def.channel.ticks} total).`);
        else if (def.channel) lines.push(`Fires ${def.channel.ticks} missiles, each dealing ${n} ${def.school} damage (${n * def.channel.ticks} total). Moving or being interrupted stops the volley.`);
        else lines.push(`Deals ${n} ${def.school} damage${def.target === 'aoe_enemy' || def.target === 'aoe_all' ? ' to all enemies in range' : ''}.${def.cpScale ? ' Damage is multiplied by the combo points spent.' : ''}${def.consumes ? ` Consumes ${AURAS[def.consumes.aura]?.name ?? def.consumes.aura}: +${Math.round(def.consumes.perStack * 100)}% damage per stack.` : ''}`);
        break;
      }
      case 'heal':
        lines.push(`${e.only === 'ally' ? 'On an ally: heals' : 'Heals'} for ${Math.round(e.amount * mods.healingDone * (am.heal ?? 1))}${def.channel ? ` per pulse (${Math.round(e.amount * mods.healingDone * (am.heal ?? 1)) * def.channel.ticks} total)` : ''}.`);
        break;
      case 'aura': {
        const a = AURAS[e.aura];
        if (!a) break;
        const dur = a.duration > 0 ? Math.round((a.duration * (mods.auraDuration[e.aura] ?? 1)) / 100) / 10 : 0;
        const extra = e.extraPerCp ? ` (+${sec(e.extraPerCp)} per combo point spent)` : '';
        const body = a.kind === 'absorb' ? `Absorbs ${a.absorbPct ? `${Math.round(a.absorbPct * 100)}% of your max health` : `${Math.round((a.absorb ?? 0) * mods.healingDone)} damage`}` : describeAura(e.aura, mods).replace(/\.$/, '');
        const who = e.self || def.target === 'self' ? 'You gain' : def.target === 'aoe_enemy' || def.target === 'enemy' ? 'Applies' : 'Target gains';
        lines.push(`${e.chance !== undefined ? `${Math.round(e.chance * 100)}% chance: ` : ''}${who} ${a.name}${dur ? ` for ${dur}s` : ''}${extra}: ${body}.`);
        break;
      }
      case 'exsanguinate':
        lines.push(`Deals ${Math.round(e.perCp * mods.damageDone * (am.damage ?? 1))} damage per combo point spent plus ${Math.round(e.bleedFraction * 100)}% of the bleed damage remaining on the target, then increases all current bleeds by ${Math.round((e.bleedMult - 1) * 100)}%.`);
        break;
      case 'interrupt':
        lines.push(`Interrupts the target's spellcasting and locks out that school for ${sec(e.lockout)}.`);
        break;
      case 'dispel':
        lines.push(def.target === 'any' ? 'Removes one magic effect: a harmful one from allies, a beneficial one from enemies.' : 'Removes one magic effect.');
        break;
      case 'charge':
        lines.push(`Stuns the target as you sprint at it, closing the distance in about a second${e.hit ? `, then hits it for ${Math.round(e.hit * mods.damageDone * (mods.ability['charge']?.damage ?? 1))} and ends the stun when you land` : ''}. You cannot steer while charging; taking damage, a stun or a root stops you (and frees the target).`);
        break;
      case 'dashToTarget':
        lines.push(e.behind ? 'Rushes to the target and lands behind it, turning you to face it.' : 'Rushes to the target.');
        break;
      case 'healMax':
        lines.push(`Heals you for ${Math.round(e.pct * 100)}% of your maximum health.`);
        break;
      case 'leap':
        lines.push(`Leaps through the air to the chosen spot${e.damage ? `, slamming enemies within ${e.radius ?? 5} yards for ${Math.round(e.damage * mods.damageDone * (mods.ability[def.id]?.damage ?? 1))} damage on landing` : ''}.`);
        break;
      case 'pull':
        lines.push(`Drags the target to ${e.stopDistance} yards in front of you.`);
        break;
      case 'flag':
        lines.push(`Plants a banner at the chosen spot for ${e.duration / 1000} sec. Enemies inside its ${e.radius}-yard circle cannot leave it.`);
        break;
      case 'blink':
        lines.push(`Teleports you ${e.distance} yards forward and frees you from stuns, roots and slows. Works while stunned.`);
        break;
      case 'gain':
        lines.push(`Generates ${e.amount} ${res}.`);
        break;
      case 'freeMove':
        lines.push('Removes every root and slow from you.');
        break;
      case 'cleanse':
        lines.push('Removes every harmful effect from you.');
        break;
      case 'dropCombat':
        lines.push('Drops you out of combat: enemies lose their target on you and spells aimed at you are cancelled.');
        break;
      case 'smoke':
        lines.push(`Drops a smoke cloud ${e.radius} yards wide for ${e.duration / 1000} sec. Enemies inside lose their target and cannot target anyone, or cast anything that needs a target, until they leave it.`);
        break;
      case 'zone':
        {
          const dmg = (n: number) => Math.round(n * mods.damageDone * (mods.ability[def.id]?.damage ?? 1));
          const first = e.initial ? `Enemies in the area take ${dmg(e.initial)} ${def.school} damage the moment the cast lands. ` : '';
          lines.push(`${first}Marks the ground at the chosen spot for ${e.duration / 1000} sec. Enemies ${e.initial ? 'still ' : ''}inside take ${dmg(e.amount)} ${def.school} damage every ${e.pulse / 1000} sec. Jump to avoid a pulse (one dodging jump every ${JUMP_DODGE_CD / 1000} sec).${e.procOnHit && AURAS[e.procOnHit] ? ` If the opening hit lands on an enemy you always gain ${AURAS[e.procOnHit].name}.` : ''}`);
        }
        break;
    }
  }

  const notes: string[] = [];
  if (def.cpGain) notes.push(`Awards ${def.cpGain} combo point${def.cpGain > 1 ? 's' : ''}.`);
  if (def.rageSpend) notes.push(`Spends all your rage (needs ${def.rageSpend.min}): damage grows from x1 at ${def.rageSpend.min} rage to x${def.rageSpend.maxMult} at full rage.`);
  if (def.cpSpend) notes.push('Spends all combo points (needs at least 1).');
  if (def.requiresStealth) notes.push('Requires stealth.');
  if (def.castWhileMoving) notes.push('Can be cast while moving.');
  if (def.requiresTargetCasting) notes.push('Target must be casting.');
  if (def.maxTargetHealthPct !== undefined) notes.push(`Only usable on targets below ${def.maxTargetHealthPct}% health.`);
  if (def.outOfCombatOnly) notes.push('Cannot be used in combat.');
  if (def.ignoresLockout) notes.push('Usable while locked out.');
  if (!def.gcd) notes.push('Does not trigger the global cooldown.');
  return { name: def.name, school: def.school, stats, lines, notes };
}
