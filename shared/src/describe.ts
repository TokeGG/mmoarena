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
  if (m.damageTaken !== undefined && m.damageTaken !== 1) out.push(m.damageTaken < 1 ? `−${pct(m.damageTaken)} damage taken` : `+${pct(m.damageTaken)} damage taken`);
  up(m.maxHealth, 'maximum health', 'maximum health');
  if (m.castTime !== undefined && m.castTime !== 1) out.push(m.castTime < 1 ? `−${pct(m.castTime)} cast time` : `+${pct(m.castTime)} cast time`);
  if (m.gcd !== undefined && m.gcd !== 1) out.push(m.gcd < 1 ? `−${pct(m.gcd)} global cooldown` : `+${pct(m.gcd)} global cooldown`);
  up(m.regen, 'resource regeneration', 'resource regeneration');
  up(m.moveSpeed, 'movement speed', 'movement speed');
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
export function describeAura(id: string): string {
  const a = AURAS[id];
  if (!a) return '';
  switch (a.kind) {
    case 'stun': return 'Cannot move, cast or act.';
    case 'incapacitate': return 'Cannot move, cast or act. Breaks on damage.';
    case 'fear': return 'Runs around in fear. Cannot cast or act.';
    case 'root': return 'Cannot move.';
    case 'slow': return `Movement speed reduced by ${a.slowPct ?? 0}%.`;
    case 'speed': return `Movement speed increased by ${a.speedPct ?? 0}%.`;
    case 'absorb': return `Absorbs ${a.absorb ?? 0} damage.`;
    case 'stealth': return `Hidden from enemies farther than ${TUNING.stealthDetect} yards. Movement speed reduced by ${Math.abs(a.speedPct ?? 0)}%. Broken by damage or attacking.`;
    case 'buff': return describeMods(a.mods).map(cap).join('. ') + '.';
    case 'dot': return a.dot ? `Takes about ${a.dot.amount} ${a.dot.school} damage every ${sec(a.dot.interval)}${a.duration ? ` (${Math.round((a.duration / a.dot.interval) * a.dot.amount)} total)` : ''}.` : '';
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
  if (def.target === 'aoe_enemy') stats.push(`${def.radius} yd radius`);
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
        if (def.channel && e.only) lines.push(`On an enemy: deals about ${n} ${def.school} damage per pulse (${n * def.channel.ticks} total).`);
        else if (def.channel) lines.push(`Fires ${def.channel.ticks} missiles, each dealing about ${n} ${def.school} damage (${n * def.channel.ticks} total). Moving or being interrupted stops the volley.`);
        else lines.push(`Deals about ${n} ${def.school} damage${def.target === 'aoe_enemy' ? ' to all enemies in range' : ''}.`);
        break;
      }
      case 'heal':
        lines.push(`${e.only === 'ally' ? 'On an ally: heals' : 'Heals'} for about ${Math.round(e.amount * mods.healingDone * (am.heal ?? 1))}${def.channel ? ` per pulse (${Math.round(e.amount * mods.healingDone * (am.heal ?? 1)) * def.channel.ticks} total)` : ''}.`);
        break;
      case 'aura': {
        const a = AURAS[e.aura];
        if (!a) break;
        const dur = a.duration > 0 ? Math.round((a.duration * (mods.auraDuration[e.aura] ?? 1)) / 100) / 10 : 0;
        const body = a.kind === 'absorb' ? `Absorbs ${Math.round((a.absorb ?? 0) * mods.healingDone)} damage` : describeAura(e.aura).replace(/\.$/, '');
        const who = def.target === 'self' ? 'You gain' : def.target === 'aoe_enemy' || def.target === 'enemy' ? 'Applies' : 'Target gains';
        lines.push(`${who} ${a.name}${dur ? ` for ${dur}s` : ''}: ${body}.`);
        break;
      }
      case 'interrupt':
        lines.push(`Interrupts the target's spellcasting and locks out that school for ${sec(e.lockout)}.`);
        break;
      case 'dispel':
        lines.push(def.target === 'any' ? 'Removes one magic effect: a harmful one from allies, a beneficial one from enemies.' : 'Removes one magic effect.');
        break;
      case 'charge':
        lines.push(`Stuns the target as you sprint at it, closing the distance in about a second${e.hit ? `, then hits it for ${e.hit} and ends the stun when you land` : ''}. You cannot steer while charging; taking damage, a stun or a root stops you (and frees the target).`);
        break;
      case 'dashToTarget':
        lines.push('Rushes to the target.');
        break;
      case 'blink':
        lines.push(`Teleports you ${e.distance} yards forward.`);
        break;
      case 'gain':
        lines.push(`Generates ${e.amount} ${res}.`);
        break;
      case 'smoke':
        lines.push(`Drops a smoke cloud ${e.radius} yards wide for ${e.duration / 1000} sec. Enemies inside lose their target and cannot target anyone, or cast anything that needs a target, until they leave it.`);
        break;
      case 'zone':
        lines.push(`Marks the ground at the chosen spot for ${e.duration / 1000} sec. Enemies inside take ${Math.round(e.amount * mods.damageDone * (mods.ability[def.id]?.damage ?? 1))} ${def.school} damage every ${e.pulse / 1000} sec. Jump to avoid a pulse (one dodging jump every ${JUMP_DODGE_CD / 1000} sec).`);
        break;
    }
  }

  const notes: string[] = [];
  if (def.requiresStealth) notes.push('Requires stealth.');
  if (def.requiresTargetCasting) notes.push('Target must be casting.');
  if (def.outOfCombatOnly) notes.push('Cannot be used in combat.');
  if (def.ignoresLockout) notes.push('Usable while locked out.');
  if (!def.gcd) notes.push('Does not trigger the global cooldown.');
  return { name: def.name, school: def.school, stats, lines, notes };
}
