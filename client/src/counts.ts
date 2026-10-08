/** Small counters shown as badges on the main menu icons and the admin panel. */

/** Dev proposals nobody has checked yet: pending ones (live, pull request and dismissed are handled). */
export function pendingProposals(rows: { status: string }[] | null | undefined): number {
  return rows ? rows.filter((r) => r.status === 'pending').length : 0;
}

/** Live matches players may watch (the list the Watch tab shows). */
export function liveCount(rows: unknown[] | null | undefined): number {
  return rows ? rows.length : 0;
}

/** Text for a count bubble: empty when zero, "99+" when large. */
export function badgeText(n: number): string {
  return n <= 0 ? '' : n > 99 ? '99+' : String(n);
}
