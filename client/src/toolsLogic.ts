/**
 * The tools window (Dev and Admin in one): which tabs a signed-in account is shown, the remembered tab, and what the F2
 * key does. Pure, so it is tested without a page. The server still decides every action; this only shapes what shows.
 */
export type ToolsTab = 'dev' | 'admin';
export const TOOLS_TABS: readonly ToolsTab[] = ['dev', 'admin'];
export const TOOLS_TAB_LABEL: Record<ToolsTab, string> = { dev: 'Dev', admin: 'Admin' };

/** The parts of an account the tabs depend on. */
export interface ToolsAccount {
  role?: string;
  ownerOk?: boolean;
  grants: readonly string[];
}

/** Dev tools: the dev tag or the owner (code entered). */
export function devAccess(a: ToolsAccount | null | undefined): boolean {
  return !!a && (!!a.ownerOk || a.grants.includes('dev'));
}

/** Admin panel: the owner account (even before the code is entered: the Admin tab then shows the unlock form) or the dev tag. */
export function adminTabAccess(a: ToolsAccount | null | undefined): boolean {
  return !!a && (a.role === 'owner' || !!a.ownerOk || a.grants.includes('dev'));
}

/** The tabs this account sees, in order. Empty: no button, no key. */
export function visibleTabs(a: ToolsAccount | null | undefined): ToolsTab[] {
  const out: ToolsTab[] = [];
  if (devAccess(a)) out.push('dev');
  if (adminTabAccess(a)) out.push('admin');
  return out;
}

export function parseTab(raw: unknown): ToolsTab | null {
  return raw === 'dev' || raw === 'admin' ? raw : null;
}

/** The tab to show: the one asked for, else the remembered one, else the first visible. null when nothing is visible. */
export function pickTab(visible: readonly ToolsTab[], asked?: ToolsTab | null, remembered?: ToolsTab | null): ToolsTab | null {
  if (asked && visible.includes(asked)) return asked;
  if (remembered && visible.includes(remembered)) return remembered;
  return visible[0] ?? null;
}

/** The other visible tab (the same one when there is only one). */
export function otherTab(visible: readonly ToolsTab[], current: ToolsTab): ToolsTab {
  return visible.filter((t) => t !== current)[0] ?? current;
}

export interface KeyState {
  /** Visible tabs of the signed-in account. */
  visible: readonly ToolsTab[];
  open: boolean;
  /** The tab showing now, or the remembered one when closed. */
  tab: ToolsTab | null;
  shift: boolean;
}

export type KeyDecision = { kind: 'ignore' } | { kind: 'close' } | { kind: 'open'; tab: ToolsTab } | { kind: 'switch'; tab: ToolsTab };

/** F2 opens and closes the window; Shift+F2 switches the tab (and opens the window on the other tab when it was closed). */
export function f2Decision(k: KeyState): KeyDecision {
  const cur = pickTab(k.visible, k.tab, null);
  if (!cur) return { kind: 'ignore' };
  if (k.shift) {
    const next = otherTab(k.visible, cur);
    return k.open ? (next === cur ? { kind: 'ignore' } : { kind: 'switch', tab: next }) : { kind: 'open', tab: next };
  }
  return k.open ? { kind: 'close' } : { kind: 'open', tab: cur };
}

const KEY = 'arena.tools.tab';

export function loadTab(storage?: Pick<Storage, 'getItem'>): ToolsTab | null {
  try {
    return parseTab((storage ?? localStorage).getItem(KEY));
  } catch {
    return null;
  }
}

export function saveTab(tab: ToolsTab, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? localStorage).setItem(KEY, tab);
  } catch {
    /* not remembered */
  }
}
