/**
 * Writes WIKI.md: every class, spec, skill, talent and effect, built from the same data and tooltip text the game uses.
 *   npx tsx scripts/gen-wiki.ts
 * Run it after any change to abilities, auras, specs, talents or tooltip wording (a test fails while WIKI.md is stale).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ABILITIES, AURAS, CLASSES, CLASS_BLURB, CLASS_IDS, SPECS, TUNING, autoFor, compileMods, describeAbility, describeAura, describeMods, describeTalent,
  markedParts, newMods, talentsFor,
} from '../shared/src/index';
import type { AbilityDef, ClassId, SpecDef, TalentDef } from '../shared/src/index';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const secs = (ms: number) => `${Math.round(ms / 100) / 10}s`;
/** Table cells cannot hold a raw pipe. */
const cell = (s: string) => s.replace(/\|/g, '\\|');
/** A number the spec changed, as "**4.5** (base 3)". */
const md = (s: string) => markedParts(s).map((p) => ('text' in p ? p.text : `**${p.value}** (base ${p.base})`)).join('');

const skillAnchor = (id: string) => `skill-${id.replace(/_/g, '-')}`;
const specAnchor = (c: ClassId, s: string) => `${c}-${s}`;
const auraAnchor = (id: string) => `effect-${id.replace(/_/g, '-')}`;
const skillLink = (id: string) => `[${ABILITIES[id]?.name ?? id}](#${skillAnchor(id)})`;

/** Every skill a class can have, in the order a player meets them: spec bars first, then talent swaps. */
function classSkills(c: ClassId): string[] {
  const out: string[] = [];
  const add = (id: string) => ABILITIES[id] && !out.includes(id) && out.push(id);
  for (const s of SPECS[c]) s.bar.forEach(add);
  for (const s of SPECS[c]) for (const t of talentsFor(c, s.id).flat()) if (t.swap) add(t.swap.to);
  for (const id of [...out]) if (ABILITIES[id].stealthSwap) add(ABILITIES[id].stealthSwap!);
  return out;
}

/** Where a skill comes from: the bars it starts on and the talents that teach it. */
function skillSources(c: ClassId, id: string): string {
  const bars = SPECS[c].filter((s) => s.bar.includes(id)).map((s) => `[${s.name}](#${specAnchor(c, s.id)}) (key ${s.bar.indexOf(id) + 1})`);
  const taught: string[] = [];
  for (const s of SPECS[c]) talentsFor(c, s.id).forEach((tier, i) => tier.forEach((t) => {
    if (t.swap?.to === id) taught.push(`${s.name} tier ${ROMAN[i]} *${t.name}* (replaces ${ABILITIES[t.swap.from]?.name ?? t.swap.from})`);
  }));
  const stealthed = Object.values(ABILITIES).filter((a) => a.class === c && a.stealthSwap === id).map((a) => skillLink(a.id));
  return [
    bars.length ? `On the bar: ${bars.join(', ')}.` : '',
    taught.length ? `Talent: ${taught.join('; ')}.` : '',
    stealthed.length ? `While you are stealthed it takes the slot of ${stealthed.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
}

function skillEntry(c: ClassId, def: AbilityDef): string[] {
  const d = describeAbility(def);
  const out = [`<a id="${skillAnchor(def.id)}"></a>`, `#### ${def.name}`, '', `*${cap(def.school)}* · ${d.stats.join(' · ')}`, ''];
  for (const l of [...d.lines, ...d.added]) out.push(`- ${l}`);
  for (const l of d.notes) out.push(`- *${l}*`);
  const auras = def.effects.flatMap((e) => (e.type === 'aura' && AURAS[e.aura] && AURAS[e.aura].name !== def.name ? [e.aura] : []));
  if (auras.length) out.push(`- Effects: ${[...new Set(auras)].map((a) => `[${AURAS[a].name}](#${auraAnchor(a)})`).join(', ')}`);
  out.push('', skillSources(c, def.id), '');
  return out;
}

/** Talent text: the description, any modifier it does not spell out, and the skill it teaches. */
function talentText(t: TalentDef): string {
  const d = describeTalent(t);
  const parts = [...d.lines, ...d.mods.map((m) => `${m}.`)];
  if (d.swap) parts.push(`${d.swap}.`);
  if (t.swap) parts.push(`→ ${skillLink(t.swap.to)}`);
  return cell(parts.join(' '));
}

function talentTable(tiers: { tier: number; talents: TalentDef[] }[]): string[] {
  const out = ['| Tier | Talent | What it does |', '|---|---|---|'];
  for (const { tier, talents } of tiers) talents.forEach((t, j) => out.push(`| ${j === 0 ? ROMAN[tier] : ''} | ${t.icon} **${cell(t.name)}** | ${talentText(t)} |`));
  return out;
}

/** Tiers whose three choices are the same for every spec of the class (listed once at class level). */
function sharedTiers(c: ClassId): number[] {
  const specs = SPECS[c];
  const first = talentsFor(c, specs[0].id);
  return first.map((_, i) => i).filter((i) => specs.every((s) => JSON.stringify(talentsFor(c, s.id)[i]?.map((t) => t.id)) === JSON.stringify(first[i].map((t) => t.id))));
}

function specSection(c: ClassId, spec: SpecDef, shared: number[]): string[] {
  const out = [`<a id="${specAnchor(c, spec.id)}"></a>`, `### ${spec.icon} ${spec.name} · ${spec.role}`, '', spec.desc, ''];
  const auto = autoFor(c, spec.id);
  const facts: string[] = [];
  if (spec.weapon) facts.push(`**Weapon:** ${spec.weapon.name}`);
  if (auto) facts.push(`**Auto-attack:** ${auto.damage} damage every ${secs(auto.interval)}, ${auto.range} yd reach`);
  if (spec.passive === 'cauterize') facts.push(`**Passive, Cauterize:** a killing blow leaves you at ${Math.round(TUNING.cauterizeHealth * 100)}% health instead, once every ${TUNING.cauterizeCooldownMs / 60000} minutes`);
  const bonuses = describeMods(spec.mods, CLASSES[c].resource.type);
  if (bonuses.length) facts.push(`**Spec bonuses:** ${bonuses.join(', ')}`);
  for (const f of facts) out.push(`- ${f}`);
  if (facts.length) out.push('');
  const mods = compileMods(c, { spec: spec.id, talents: [], gear: {} });
  out.push('| Key | Skill | Numbers with this spec |', '|---|---|---|');
  spec.bar.forEach((id, i) => {
    const d = describeAbility(ABILITIES[id], mods, undefined, { mark: true });
    out.push(`| ${i + 1} | ${skillLink(id)} | ${cell(d.stats.map(md).join(' · '))} |`);
  });
  const own = talentsFor(c, spec.id).map((talents, tier) => ({ tier, talents })).filter((x) => !shared.includes(x.tier));
  if (own.length) out.push('', `**Talents** (one per tier${shared.length ? `; tiers ${shared.map((i) => ROMAN[i]).join(' and ')} are under [${CLASSES[c].name}](#${c})` : ''}):`, '', ...talentTable(own));
  out.push('');
  return out;
}

function classSection(c: ClassId): string[] {
  const cls = CLASSES[c];
  const r = cls.resource;
  const out = [`<a id="${c}"></a>`, `## ${cls.name}`, '', CLASS_BLURB[c], ''];
  const resource = `**${cap(r.type)}:** ${r.max} max, start with ${r.start}${r.regenPerSec ? `, +${r.regenPerSec} a second` : ''}${r.type === 'rage' ? `; built by dealing damage (${Math.round(TUNING.rageFromDealt * 100)}% of it with a free skill or auto-attack) and taking damage (${Math.round(TUNING.rageFromTaken * 1000) / 10}%), and drains ${TUNING.rageDecayPerSec} a second out of combat` : ''}${r.type === 'energy' ? '; skills that award combo points fill up to 5 for finishers to spend' : ''}`;
  out.push(`- **Health:** ${cls.maxHealth}`, `- ${resource}`, `- **Specs:** ${SPECS[c].map((s) => `[${s.name}](#${specAnchor(c, s.id)}) (${s.role})`).join(' · ')}`, '');
  const shared = sharedTiers(c);
  if (shared.length) {
    out.push(`**Talents every ${cls.name} spec shares** (one pick per tier, kept when you change spec):`, '');
    out.push(...talentTable(shared.map((tier) => ({ tier, talents: talentsFor(c, SPECS[c][0].id)[tier] }))), '');
  }
  for (const s of SPECS[c]) out.push(...specSection(c, s, shared));
  out.push(`### ${cls.name} skills`, '', 'Base numbers, before spec and talent changes (in game, hover a skill to see yours).', '');
  for (const id of classSkills(c)) out.push(...skillEntry(c, ABILITIES[id]));
  return out;
}

function effectsSection(): string[] {
  // who applies each effect: skills, talents (extra effects on a skill) and spec passives
  const sources = new Map<string, { links: string[]; ms: Set<number>; res?: string }>();
  const note = (id: string, link: string, ms: number, res?: string) => {
    const s = sources.get(id) ?? { links: [], ms: new Set<number>(), res };
    if (!s.links.includes(link)) s.links.push(link);
    if (ms > 0) s.ms.add(ms);
    sources.set(id, s);
  };
  for (const a of Object.values(ABILITIES)) for (const e of a.effects) if (e.type === 'aura' && AURAS[e.aura]) note(e.aura, skillLink(a.id), e.duration ?? AURAS[e.aura].duration, a.class === 'trinket' ? 'mana' : CLASSES[a.class].resource.type);
  for (const c of CLASS_IDS) for (const s of SPECS[c]) {
    if (s.passive === 'cauterize') note('cauterized', `${s.name} passive (Cauterize)`, AURAS.cauterized.duration, CLASSES[c].resource.type);
    for (const t of talentsFor(c, s.id).flat()) for (const [ab, m] of Object.entries(t.mods.ability ?? {})) {
      for (const e of m.extra ?? []) if (e.type === 'aura' && AURAS[e.aura]) note(e.aura, `talent *${t.name}* (${skillLink(ab)})`, e.duration ?? AURAS[e.aura].duration, CLASSES[c].resource.type);
      for (const id of m.after ?? []) if (AURAS[id]) note(id, `talent *${t.name}* (${skillLink(ab)})`, AURAS[id].duration, CLASSES[c].resource.type);
    }
  }
  const out = ['<a id="effects"></a>', '## Effects reference', '', 'Every buff, debuff and proc in the game. Durations are base values (some talents lengthen them).', '', '| Effect | Kind | Lasts | What it does | From |', '|---|---|---|---|---|'];
  const rows = [...sources.entries()].sort((a, b) => AURAS[a[0]].name.localeCompare(AURAS[b[0]].name));
  for (const [id, src] of rows) {
    const a = AURAS[id];
    const kind = `${a.harmful ? 'Debuff' : 'Buff'}${a.kind === 'buff' ? '' : ` (${a.kind})`}${a.dispellable ? ', magic' : ''}`;
    const lasts = src.ms.size ? [...src.ms].sort((x, y) => x - y).map(secs).join(' or ') : 'until broken';
    out.push(`| <a id="${auraAnchor(id)}"></a>**${cell(a.name)}** | ${kind} | ${lasts} | ${cell(describeAura(id, newMods(), { res: src.res }))} | ${src.links.join(', ')} |`);
  }
  return [...out, '', '*Magic* effects can be removed with Dispel Magic.', ''];
}

function rulesSection(): string[] {
  const dr = TUNING.drSteps.map((v) => (v <= 0 ? 'immune' : `${Math.round(v * 100)}%`)).join(' → ');
  return [
    '<a id="rules"></a>',
    '## Rules every class shares',
    '',
    `- **Global cooldown:** ${secs(TUNING.gcdMs)} after most skills (tooltips say when a skill does not trigger it).`,
    `- **Facing:** casts and swings need the target inside the ${TUNING.castConeDeg}° half-circle in front of you.`,
    `- **Diminishing returns:** the same kind of crowd control on one target lasts ${dr}; the count resets after ${secs(TUNING.drResetMs)} without it. Interrupts have their own school lockout instead.`,
    `- **Stealth:** a stealthed rogue is seen within ${TUNING.stealthDetect} yards; damage or attacking breaks it.`,
    `- **Fear:** a feared unit stumbles around at ${Math.round(TUNING.fearSpeed * 100)}% run speed.`,
    `- **Out of combat:** ${secs(TUNING.outOfCombatMs)} without dealing or taking damage.`,
    '- **No random damage:** every hit and heal does exactly the number on its tooltip.',
    '',
  ];
}

/** The whole wiki as Markdown. */
export function wikiMarkdown(): string {
  const toc = CLASS_IDS.map((c) => `- [${CLASSES[c].name}](#${c}): ${SPECS[c].map((s) => `[${s.name}](#${specAnchor(c, s.id)})`).join(' · ')}`);
  const lines = [
    '# Arena wiki: classes, skills and talents',
    '',
    '<!-- Generated by `npx tsx scripts/gen-wiki.ts` from shared/data and the in-game tooltip text. Do not edit by hand. -->',
    '',
    'Everything here comes straight from the game data, so it matches the in-game tooltips. Numbers are base values; each spec lists what it changes, and in game you can hover any skill to see your own numbers (hold **Alt** for how they are worked out). Back to the [player guide](README.md).',
    '',
    ...toc,
    '- [Effects reference](#effects) · [Rules every class shares](#rules)',
    '',
    ...rulesSection(),
    ...CLASS_IDS.flatMap(classSection),
    ...effectsSection(),
  ];
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export const WIKI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'WIKI.md');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(WIKI_PATH, wikiMarkdown());
  console.log(`wrote ${path.relative(process.cwd(), WIKI_PATH)}`);
}
