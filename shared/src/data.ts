import abilitiesJson from '../data/abilities.json' with { type: 'json' };
import aurasJson from '../data/auras.json' with { type: 'json' };
import classesJson from '../data/classes.json' with { type: 'json' };
import arenasJson from '../data/arenas.json' with { type: 'json' };
import specsJson from '../data/specs.json' with { type: 'json' };
import talentsJson from '../data/talents.json' with { type: 'json' };
import cosmeticsJson from '../data/cosmetics.json' with { type: 'json' };
import tuningJson from '../data/tuning.json' with { type: 'json' };
import fxJson from '../data/fx.json' with { type: 'json' };
import iconsJson from '../data/icons.json' with { type: 'json' };
import iconlibJson from '../data/iconlib.json' with { type: 'json' };
import patchesJson from '../data/patches.json' with { type: 'json' };
import type { AbilityDef, ArenaDef, AuraDef, ClassDef, ClassId, CosmeticsDef, SpecDef, TalentDef, Tuning } from './types';

export const ABILITIES: Record<string, AbilityDef> = Object.fromEntries(
  (abilitiesJson as unknown as AbilityDef[]).map((a) => [a.id, a]),
);
export const AURAS = aurasJson as unknown as Record<string, AuraDef>;
/** An ability that ignores control is still locked by Polymorph and Dragon's Breath, except the one that clears them (Cleansing Charm). */
export const lockedByAura = (def: AbilityDef, auras: { id: string }[]): boolean =>
  !!def.ignoresControl && !def.effects.some((e) => e.type === 'cleanse') && auras.some((a) => AURAS[a.id]?.locksAbilities);

/** Why a unit with these auras cannot use this ability, or '' if it can: silence stops spells (anything not physical), disarm stops physical abilities. */
export function silencedBy(auras: { id: string }[], def: AbilityDef | undefined): string {
  if (!def) return '';
  const physical = def.school === 'physical';
  if (!physical && auras.some((a) => AURAS[a.id]?.silence)) return 'you are silenced';
  if (physical && auras.some((a) => AURAS[a.id]?.disarm)) return 'you are disarmed';
  return '';
}
export const CLASSES = classesJson as unknown as Record<ClassId, ClassDef>;
/** Every arena the server can play on. The first is the default. */
export const ARENAS = arenasJson as unknown as ArenaDef[];
export const ARENA = ARENAS[0];
export const arenaById = (id: string | undefined): ArenaDef => ARENAS.find((a) => a.id === id) ?? ARENA;
export const TUNING = tuningJson as unknown as Tuning;
/** Animation timings (shared/data/fx.json): visual only, not part of the simulation or its content hash. */
export const FX = fxJson as unknown as Record<string, Record<string, number>>;

/** Which icon each skill and buff wears (shared/data/icons.json): visual only, not part of the simulation or its content hash. */
export interface IconTable { abilities: Record<string, string>; auras: Record<string, string>; classes: Record<string, string>; specs: Record<string, string> }
export const ICONS = iconsJson as unknown as IconTable;
export interface IconPack { id: string; name: string; count: number; license: string; /** The files are not in the repository (the licence forbids sharing them): the server hands them out. */ private?: boolean }
export interface IconDef { id: string; pack: string; name: string; file: string; tags: string[] }
/** The icon library's manifest (shared/data/iconlib.json): the packs, and every icon's id, file and tags. */
export const ICONLIB = iconlibJson as unknown as { packs: IconPack[]; icons: IconDef[] };

export const SPECS = specsJson as unknown as Record<ClassId, SpecDef[]>;
/** Per class: talent tiers, each a list of choices (pick at most one per tier). */
export const TALENTS = talentsJson as unknown as Record<ClassId, Record<string, TalentDef[][]>>;
/** Cosmetic slots and every item. Purely visual: nothing here touches combat. */
export const COSMETICS = cosmeticsJson as unknown as CosmeticsDef;

export const CLASS_IDS = Object.keys(CLASSES) as ClassId[];

/** Patch notes, newest first. The top entry's version is always the game's version (a test checks it). */
/** `at`: when it went out, in UTC (ISO 8601); shown in each viewer's own time zone. */
/** `by`: who pushed it when it came from a commit made in the game's dev tools (shown in the patch list). */
export interface PatchNote { version: string; date: string; at?: string; title: string; changes: string[]; by?: string }
export const PATCHES = patchesJson as PatchNote[];
