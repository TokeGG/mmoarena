import { ABILITIES, ICONLIB, ICONS } from './data';
import type { IconDef, IconPack, IconTable } from './data';

/**
 * Icons: the art on skills and buffs. Visual only: nothing here is read by the simulation, and shared/data/icons.json (which
 * icon each skill and buff wears) and shared/data/iconlib.json (every icon there is) are not part of the content hash
 * (replay.ts contentHash), so changing an icon never changes a match or a replay. The client draws these (iconArt.ts); the
 * dev panel's "Icon edit" page changes them with the same patches as every other number.
 */

export type IconKind = 'ability' | 'aura' | 'class' | 'spec';
/** The table of icons.json each kind lives in. */
export const ICON_TABLE: Record<IconKind, keyof IconTable> = { ability: 'abilities', aura: 'auras', class: 'classes', spec: 'specs' };

/** The library: the manifest's packs and icons, then the custom ones the server has (setCustomIcons). Both arrays are updated in place. */
export const ICON_PACKS: readonly IconPack[] = [...ICONLIB.packs];
export const ICON_LIST: readonly IconDef[] = [...ICONLIB.icons];
const BUILT_IN = new Set(ICONLIB.packs.map((p) => p.id));
const BY_ID = new Map(ICON_LIST.map((i) => [i.id, i]));
const PACK_BY_ID = new Map(ICON_PACKS.map((p) => [p.id, p]));

/** A custom pack's id: 2 to 24 of a-z, 0-9 and dashes (not starting or ending with a dash). */
export const CUSTOM_PACK_ID = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])$/;
export const validPackId = (id: unknown): id is string => typeof id === 'string' && CUSTOM_PACK_ID.test(id) && !BUILT_IN.has(id);
/** A custom icon's file name part: lowercase letters, digits and dashes, 1 to 48. */
export const CUSTOM_ICON_SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * The icons uploaded to the server (GET /api/icons/custom) join the library: the grid, the search, the pack chips and the
 * icon validation (validPatch) all see them. Replaces the previous custom set; a pack or icon whose id is already a built-in one is ignored.
 */
export function setCustomIcons(packs: readonly IconPack[], icons: readonly IconDef[]): void {
  const keepP = ICON_PACKS.filter((p) => BUILT_IN.has(p.id));
  const keepI = ICON_LIST.filter((i) => BUILT_IN.has(i.pack));
  const ok = new Set<string>();
  const seen = new Set<string>(keepI.map((i) => i.id));
  for (const p of packs) if (validPackId(p.id) && !ok.has(p.id)) {
    ok.add(p.id);
    keepP.push({ id: p.id, name: String(p.name), count: 0, license: String(p.license ?? ''), custom: true });
  }
  for (const i of icons) if (ok.has(i.pack) && i.id.startsWith(`${i.pack}/`) && CUSTOM_ICON_SLUG.test(i.id.slice(i.pack.length + 1)) && !seen.has(i.id)) {
    seen.add(i.id);
    keepI.push({ id: i.id, pack: i.pack, name: String(i.name), file: i.file, tags: Array.isArray(i.tags) ? i.tags.map(String) : [] });
  }
  for (const p of keepP) if (p.custom) p.count = keepI.filter((i) => i.pack === p.id).length;
  (ICON_PACKS as IconPack[]).splice(0, ICON_PACKS.length, ...keepP);
  (ICON_LIST as IconDef[]).splice(0, ICON_LIST.length, ...keepI);
  BY_ID.clear();
  for (const i of ICON_LIST) BY_ID.set(i.id, i);
  PACK_BY_ID.clear();
  for (const p of ICON_PACKS) PACK_BY_ID.set(p.id, p);
  haystack.clear();
}

/** The mapping as the file has it, copied before any patch can be applied. */
export const PRISTINE_ICONS: IconTable = structuredClone(ICONS);

export const iconDef = (id: string | undefined | null): IconDef | undefined => (id ? BY_ID.get(id) : undefined);
export const iconExists = (id: unknown): id is string => typeof id === 'string' && BY_ID.has(id);
export const iconPack = (packId: string): IconPack | undefined => PACK_BY_ID.get(packId);
/** True for an icon of a pack that was uploaded to the server. */
export const isCustomIcon = (id: string | undefined | null): boolean => !!iconDef(id) && !!PACK_BY_ID.get(iconDef(id)!.pack)?.custom;
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
  const t = table[ICON_TABLE[kind]] ?? {};
  const own = Object.hasOwn(t, id) ? t[id] : undefined;
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
export const hasOwnIcon = (kind: IconKind, id: string): boolean => Object.hasOwn(ICONS[ICON_TABLE[kind]], id);

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
