/** When a patch went out, in the viewer's own time zone ("Oct 7, 2026, 5:06 PM CDT"); just the date for old entries. */
export function patchTime(p: { date: string; at?: string }, locale?: string, timeZone?: string): string {
  const t = p.at ? new Date(p.at) : null;
  if (!t || Number.isNaN(t.getTime())) return p.date;
  return t.toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(timeZone ? { timeZone } : {}) });
}
