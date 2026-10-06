import abilitiesJson from '../data/abilities.json' with { type: 'json' };
import aurasJson from '../data/auras.json' with { type: 'json' };
import classesJson from '../data/classes.json' with { type: 'json' };
import arenaJson from '../data/arena.json' with { type: 'json' };
import tuningJson from '../data/tuning.json' with { type: 'json' };
import type { AbilityDef, ArenaDef, AuraDef, ClassDef, ClassId, Tuning } from './types';

export const ABILITIES: Record<string, AbilityDef> = Object.fromEntries(
  (abilitiesJson as unknown as AbilityDef[]).map((a) => [a.id, a]),
);
export const AURAS = aurasJson as unknown as Record<string, AuraDef>;
export const CLASSES = classesJson as unknown as Record<ClassId, ClassDef>;
export const ARENA = arenaJson as unknown as ArenaDef;
export const TUNING = tuningJson as unknown as Tuning;

export const CLASS_IDS = Object.keys(CLASSES) as ClassId[];
