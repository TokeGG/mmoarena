/**
 * Roughly where a connection comes from, for the owner's "Online now" list. Nothing leaves the server: the country comes from
 * the header the host's proxy adds (Cloudflare-style `CF-IPCountry`), and a private address is labelled as such.
 * City-level detail is a link the owner opens from their own browser (see the admin panel).
 */
const names = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

const isPrivate = (ip: string): boolean =>
  !ip || ip === '::1' || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip.replace(/^::ffff:/i, ''));

/** A readable country (or "local network"), or an empty string when the host does not say. */
export function whereIs(ip: string, country?: string): string {
  if (isPrivate(ip)) return 'local network';
  const c = (country ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === 'XX' || c === 'T1') return '';
  try {
    return names?.of(c) ?? c;
  } catch {
    return c;
  }
}
