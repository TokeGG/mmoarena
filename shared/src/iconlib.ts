import { ABILITIES, ICONLIB, ICONS } from './data';
import type { IconDef, IconPack, IconTable } from './data';

/**
 * Icons: the art on skills and buffs. Visual only: nothing here is read by the simulation, and shared/data/icons.json (which
 * icon each skill and buff wears) and shared/data/iconlib.json (every icon there is) are not part of the content hash
 * (replay.ts contentHash), so changing an icon never changes a match or a replay. The client draws these (iconArt.ts); the
 * dev panel's "Icon edit" page changes them with the same patches as every other number.
 */

export type IconKind = 'ability' | 'aura';

export const ICON_PACKS: readonly IconPack[] = ICONLIB.packs;
export const ICON_LIST: readonly IconDef[] = ICONLIB.icons;
const BY_ID = new Map(ICON_LIST.map((i) => [i.id, i]));
const PACK_BY_ID = new Map(ICON_PACKS.map((p) => [p.id, p]));

/** The mapping as the file has it, copied before any patch can be applied. */
export const PRISTINE_ICONS: IconTable = structuredClone(ICONS);

export const iconDef = (id: string | undefined | null): IconDef | undefined => (id ? BY_ID.get(id) : undefined);
export const iconExists = (id: unknown): id is string => typeof id === 'string' && BY_ID.has(id);
export const iconPack = (packId: string): IconPack | undefined => PACK_BY_ID.get(packId);
/** True for an icon of a pack whose files the server hands out (they are not in the repository). */
export const isPrivateIcon = (id: string | undefined | null): boolean => !!iconDef(id) && !!PACK_BY_ID.get(iconDef(id)!.pack)?.private;
/** Where the picture of an icon is served from (empty for an id that is not in the library). */
export const iconUrl = (id: string | undefined | null): string => iconDef(id)?.file ?? '';

/** The skill whose icon a buff wears when it has none of its own: the first skill that applies it (a skill a player can use before a retired one). */
const auraSources = new Map<string, string>();
export function auraSource(auraId: string): string | undefined {
  if (!auraSources.size) {
    const live = Object.values(ABILITIES).filter((a) => !a.retired);
    const old = Object.values(ABILITIES).filter((a) => a.retired);
    for (const a of [...live, ...old]) for (const e of a.effects) if ((e.type === 'aura' || e.type === 'zoneBuff') && !auraSources.has(e.aura)) auraSources.set(e.aura, a.id);
  }
  return auraSources.get(auraId);
}

/** The icon id a skill or buff wears in `table`: its own entry, else (a buff) the icon of the skill that applies it. Null when there is none. */
export function resolveIcon(table: IconTable, kind: IconKind, id: string): string | null {
  const own = Object.hasOwn(kind === 'ability' ? table.abilities : table.auras, id) ? (kind === 'ability' ? table.abilities : table.auras)[id] : undefined;
  if (own) return own;
  if (kind === 'aura') {
    const src = auraSource(id);
    if (src && Object.hasOwn(table.abilities, src)) return table.abilities[src];
  }
  return null;
}

/** The icon a skill or buff wears now (any patch applied); null when it has none (the emoji is drawn instead). */
export const iconIdFor = (kind: IconKind, id: string): string | null => resolveIcon(ICONS, kind, id);
/** The icon the data file gives it, before any patch. */
export const fileIconIdFor = (kind: IconKind, id: string): string | null => resolveIcon(PRISTINE_ICONS, kind, id);

/** Whether the icon a buff wears is its own (set for it) or only borrowed from the skill that applies it. */
export const hasOwnIcon = (kind: IconKind, id: string): boolean => Object.hasOwn(kind === 'ability' ? ICONS.abilities : ICONS.auras, id);

// ------------------------------------------------------------------ the library picker

const haystack = new Map<string, string>();
function textOf(i: IconDef): string {
  let t = haystack.get(i.id);
  if (t === undefined) {
    t = `${i.name} ${i.id} ${PACK_BY_ID.get(i.pack)?.name ?? i.pack} ${i.tags.join(' ')}`.toLowerCase().replace(/[_-]/g, ' ');
    haystack.set(i.id, t);
  }
  return t;
}

/** Icons whose name, pack or tags contain every word of the search (all of them for an empty search), optionally of one pack only. */
export function searchIcons(query: string, pack = ''): IconDef[] {
  const words = query.toLowerCase().replace(/[_-]/g, ' ').split(/\s+/).filter(Boolean);
  return ICON_LIST.filter((i) => (!pack || i.pack === pack) && words.every((w) => textOf(i).includes(w)));
}

/** Each pack with how many of its icons match the search (the chips above the grid). */
export function packCounts(query: string): { pack: IconPack; count: number }[] {
  const found = searchIcons(query);
  return ICON_PACKS.map((p) => ({ pack: p, count: found.filter((i) => i.pack === p.id).length }));
}

/** The plain-words name of an icon for lists and tooltips: "Fire mage set: Fire mage 3". */
export function iconTitle(id: string): string {
  const i = iconDef(id);
  return i ? `${PACK_BY_ID.get(i.pack)?.name ?? i.pack}: ${i.name}` : id;
}
