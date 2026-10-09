import { SPECS, ICON_LIST, ICON_PACKS, fileIconIdFor, iconDef, iconIdFor, iconPatch, isPrivateIcon, searchIcons } from '@arena/shared';
import type { DataPatch, IconDef, IconKind, IconPack } from '@arena/shared';
import { patchKey } from './devEdits';
import type { EditSet } from './devEdits';

/** What the Icon edit page needs to decide, with no DOM: which icons the grid shows, what is picked, what is sent. */

/** The skill or buff a navigation id ("a:fireball", "u:polymorph") names. */
export function iconTarget(navId: string): { kind: IconKind; id: string } | null {
  if (navId.startsWith('a:')) return { kind: 'ability', id: navId.slice(2) };
  if (navId.startsWith('u:')) return { kind: 'aura', id: navId.slice(2) };
  if (navId.startsWith('c:')) return { kind: 'class', id: navId.slice(2) };
  if (navId.startsWith('p:')) return { kind: 'spec', id: navId.slice(2) };
  return null;
}

/** An icon of a private pack is only offered when the server has its file (`available`, null while unknown or when the request failed). */
export const iconOffered = (i: IconDef, available: ReadonlySet<string> | null): boolean => !isPrivateIcon(i.id) || !!available?.has(i.id);

/** The icons the grid shows for a search and a pack chip (the whole library for an empty search and "All"). */
export function gridIcons(query: string, pack: string, available: ReadonlySet<string> | null = null): IconDef[] {
  return searchIcons(query, pack).filter((i) => iconOffered(i, available));
}

/** The chips above the grid: "All" and every pack that has icons on offer, with how many match the search. A private pack is marked, and so is one uploaded to the server (custom). */
export function packChips(query: string, available: ReadonlySet<string> | null = null): { id: string; name: string; count: number; locked: boolean; custom: boolean }[] {
  const found = searchIcons(query).filter((i) => iconOffered(i, available));
  const chips = ICON_PACKS.filter((p: IconPack) => !p.private || ICON_LIST.some((i) => i.pack === p.id && available?.has(i.id))).map((p) => ({ id: p.id, name: p.name, count: found.filter((i) => i.pack === p.id).length, locked: !!p.private, custom: !!p.custom }));
  return [{ id: '', name: 'All', count: found.length, locked: false, custom: false }, ...chips];
}

/** The patch of an icon pick, or null when the id is not an icon of the library. */
export function iconPick(navId: string, icon: string): DataPatch | null {
  return iconTarget(navId) && iconDef(icon) ? iconPatch(navId, icon) : null;
}

/** The pieces EditSet needs to treat an icon like any other value: the file's icon is the base, the live one the value. */
function fieldOfIcon(navId: string): { file: 'icons'; id: string; path: [IconKind]; base: string; value: string } | null {
  const t = iconTarget(navId);
  if (!t) return null;
  return { file: 'icons', id: t.id, path: [t.kind], base: fileIconIdFor(t.kind, t.id) ?? '', value: iconIdFor(t.kind, t.id) ?? '' };
}

/** Pick an icon for a skill or buff: the default one is the same as putting it back. Returns false for an icon that does not exist. */
export function chooseIcon(set: EditSet, navId: string, icon: string, testing: ReadonlyMap<string, DataPatch>, canRevert = true): boolean {
  const f = fieldOfIcon(navId);
  if (!f || !iconDef(icon)) return false;
  set.set(f, icon, testing, canRevert);
  return true;
}

/** Put a skill or buff's icon back to the data file's. */
export function putBackIcon(set: EditSet, navId: string, testing: ReadonlyMap<string, DataPatch>, canRevert = true): void {
  const f = fieldOfIcon(navId);
  if (f) set.set(f, f.base, testing, canRevert);
}

/** The icon id the page shows for an entry: what was picked, else what is being tried, else what it wears now ('' for none). */
export function chosenIcon(set: EditSet, navId: string, testing: ReadonlyMap<string, DataPatch>): string {
  const f = fieldOfIcon(navId);
  return f ? String(set.shown(f, testing)) : '';
}

/** Does it wear something other than the data file's icon (picked, tried or saved)? */
export function iconChanged(set: EditSet, navId: string, testing: ReadonlyMap<string, DataPatch>): boolean {
  const f = fieldOfIcon(navId);
  return !!f && set.changed(f, testing);
}

/**
 * What the screen should show before anything is sent: every icon the dev picked (or put back) in the editor, keyed as iconArt.ts
 * wants it ("ability:fireball" -> icon id, '' for none). Put-back ones map to the data file's icon.
 */
export function previewOf(set: EditSet): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of set.edits.values()) if (p.file === 'icons' && typeof p.value === 'string') out.set(`${p.path[0]}:${p.id}`, p.value);
  for (const k of set.reverted) {
    const [file, id, kind] = k.split(':');
    if (file !== 'icons' || (kind !== 'ability' && kind !== 'aura' && kind !== 'class' && kind !== 'spec')) continue;
    out.set(`${kind}:${id}`, fileIconIdFor(kind, id) ?? '');
  }
  return out;
}

export { patchKey };

/** The icons made for a class or spec (its five options in classart / specart), shown first above the grid; none for a skill or buff. */
export function suggestedIcons(navId: string, available: ReadonlySet<string> | null = null): IconDef[] {
  const t = iconTarget(navId);
  if (!t || (t.kind !== 'class' && t.kind !== 'spec')) return [];
  const art = t.kind === 'class' ? t.id : Object.values(SPECS).flat().find((s) => s.id === t.id)?.name.toLowerCase() ?? t.id; // the art is named by the spec's name
  const prefix = `${t.kind === 'class' ? 'classart' : 'specart'}/${art}-`;
  return ICON_LIST.filter((i) => i.id.startsWith(prefix) && iconOffered(i, available));
}
