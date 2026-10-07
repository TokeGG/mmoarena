import abilitiesJson from '../data/abilities.json' with { type: 'json' };
import aurasJson from '../data/auras.json' with { type: 'json' };
import classesJson from '../data/classes.json' with { type: 'json' };
import arenasJson from '../data/arenas.json' with { type: 'json' };
import specsJson from '../data/specs.json' with { type: 'json' };
import talentsJson from '../data/talents.json' with { type: 'json' };
import cosmeticsJson from '../data/cosmetics.json' with { type: 'json' };
import tuningJson from '../data/tuning.json' with { type: 'json' };
import patchesJson from '../data/patches.json' with { type: 'json' };
import type { AbilityDef, ArenaDef, AuraDef, ClassDef, ClassId, CosmeticsDef, SpecDef, TalentDef, Tuning } from './types';

export const ABILITIES: Record<string, AbilityDef> = Object.fromEntries(
  (abilitiesJson as unknown as AbilityDef[]).map((a) => [a.id, a]),
);
export const AURAS = aurasJson as unknown as Record<string, AuraDef>;
export const CLASSES = classesJson as unknown as Record<ClassId, ClassDef>;
/** Every arena the server can play on. The first is the default. */
export const ARENAS = arenasJson as unknown as ArenaDef[];
export const ARENA = ARENAS[0];
export const arenaById = (id: string | undefined): ArenaDef => ARENAS.find((a) => a.id === id) ?? ARENA;
export const TUNING = tuningJson as unknown as Tuning;

export const SPECS = specsJson as unknown as Record<ClassId, SpecDef[]>;
/** Per class: talent tiers, each a list of choices (pick at most one per tier). */
export const TALENTS = talentsJson as unknown as Record<ClassId, Record<string, TalentDef[][]>>;
/** Cosmetic slots and every item. Purely visual: nothing here touches combat. */
export const COSMETICS = cosmeticsJson as unknown as CosmeticsDef;

export const CLASS_IDS = Object.keys(CLASSES) as ClassId[];

/** Patch notes, newest first. The top entry's version is always the game's version (a test checks it). */
/** `at`: when it went out, in UTC (ISO 8601); shown in each viewer's own time zone. */
export interface PatchNote { version: string; date: string; at?: string; title: string; changes: string[] }
export const PATCHES = patchesJson as PatchNote[];
