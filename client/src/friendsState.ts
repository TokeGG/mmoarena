import type { FriendRow } from '@arena/shared';

export type FriendGroup = 'party' | 'online' | 'queue' | 'match' | 'offline';

export const GROUP_TITLES: Record<FriendGroup, string> = { party: 'In your party', online: 'Online', queue: 'Queueing', match: 'In a match', offline: 'Offline' };
export const GROUP_ORDER: FriendGroup[] = ['party', 'online', 'queue', 'match', 'offline'];

/** Friends that are signed in right now (anything but offline). */
export function onlineCount(friends: FriendRow[]): number {
  return friends.filter((f) => f.status !== 'offline').length;
}

/** The group a friend is listed in; `mates` are the names in your own party. */
export function groupOf(f: FriendRow, mates: string[]): FriendGroup {
  if (f.status === 'offline') return 'offline';
  if (mates.some((n) => n.toLowerCase() === f.name.toLowerCase())) return 'party';
  if (f.status === 'match') return 'match';
  if (f.status === 'queue') return 'queue';
  return 'online';
}

/** What the friend is doing, in words. */
export function statusLine(f: FriendRow, mates: string[]): string {
  switch (groupOf(f, mates)) {
    case 'party': return 'In your party';
    case 'match': return 'In a match';
    case 'queue': return 'Queueing';
    case 'offline': return 'Offline';
    default: return f.status === 'party' ? 'In another party' : 'In the menu';
  }
}

/** Filter by name (case-insensitive substring) and split into the non-empty groups, in display order. */
export function groupFriends(friends: FriendRow[], mates: string[], filter = ''): { group: FriendGroup; rows: FriendRow[] }[] {
  const q = filter.trim().toLowerCase();
  const out: { group: FriendGroup; rows: FriendRow[] }[] = GROUP_ORDER.map((group) => ({ group, rows: [] }));
  for (const f of friends) {
    if (q && !f.name.toLowerCase().includes(q)) continue;
    out[GROUP_ORDER.indexOf(groupOf(f, mates))].rows.push(f);
  }
  return out.filter((g) => g.rows.length);
}
