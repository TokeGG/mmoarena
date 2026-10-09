import { layerLayout } from '@arena/shared';
import type { HudLayoutMap } from '@arena/shared';

/**
 * Which layer of the HUD layout an element's place comes from, kept pure so it can be tested. From the bottom: the
 * built-in spots, the owner's default for everyone, then what the player moved themselves. The owner's "everyone" mode
 * edits a draft of the default instead, and shows only that.
 */
export type EditMode = 'me' | 'all';
export type Source = 'own' | 'default' | 'builtin';

export interface Layers {
  /** The player's own layout. */
  saved: HudLayoutMap;
  /** The owner's default for everyone. */
  def: HudLayoutMap;
  /** The owner's unpublished edits to the default ("everyone" mode). */
  draft: HudLayoutMap;
  /** Elements moved since the layer being edited was last saved. */
  touched: ReadonlySet<string>;
}

/** Where `id` sits from, in the given edit mode. */
export function sourceOf(mode: EditMode, id: string, l: Layers): Source {
  if (mode === 'all') return id in l.draft || l.touched.has(id) ? 'own' : 'builtin';
  if (id in l.saved || l.touched.has(id)) return 'own';
  return id in l.def ? 'default' : 'builtin';
}

/** The layout that is on screen: the owner's draft in "everyone" mode, else the player's over the default. */
export function viewLayout(mode: EditMode, l: Pick<Layers, 'saved' | 'def' | 'draft'>): HudLayoutMap {
  return mode === 'all' ? l.draft : layerLayout(l.saved, l.def);
}

/** The text on an element's tag in the editor: its name, and a diamond while it follows the owner's default. */
export function tagText(label: string, mode: EditMode, source: Source): string {
  return mode === 'me' && source === 'default' ? `${label} ◆ default` : label;
}

/** What the editor says about the selected element. */
export function whereText(mode: EditMode, source: Source): string {
  if (mode === 'all') return source === 'own' ? 'moved in the default layout' : 'at its built-in spot';
  return source === 'own' ? 'your own position' : source === 'default' ? "following the owner's default" : 'at its built-in spot';
}

/** Whether two layouts say the same thing (key order aside). */
export function sameLayout(a: HudLayoutMap, b: HudLayoutMap): boolean {
  const keys = (l: HudLayoutMap) => Object.keys(l).sort();
  const ka = keys(a);
  const kb = keys(b);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && JSON.stringify(a[k]) === JSON.stringify(b[k]));
}
