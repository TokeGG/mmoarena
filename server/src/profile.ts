import crypto from 'node:crypto';

/**
 * Signed progress token. The server has no database, so the browser stores {matches, wins} and the server only
 * accepts it back if its HMAC checks out. A player can lose a token (clearing storage) but cannot forge a higher
 * count. Set ARENA_SECRET in the environment so tokens survive restarts and redeploys; without it a built-in
 * development secret is used, which anyone who reads the source could forge.
 */
const SECRET = process.env.ARENA_SECRET || 'dev-secret-change-me';

export interface Progress {
  matches: number;
  wins: number;
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const sign = (body: string) => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');

export function issueProfile(p: Progress): string {
  const body = b64(JSON.stringify({ v: 1, m: p.matches, w: p.wins }));
  return `${body}.${sign(body)}`;
}

export function verifyProfile(token: string | undefined): Progress | null {
  if (!token) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (d?.v !== 1 || !Number.isInteger(d.m) || !Number.isInteger(d.w) || d.m < 0 || d.w < 0 || d.w > d.m || d.m > 1e6) return null;
    return { matches: d.m, wins: d.w };
  } catch {
    return null;
  }
}
