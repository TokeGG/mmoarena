/** Names bots wear ("Bot <Name>"), and the rules for the owner's editable list of them. */

/** Used until the owner saves a list of their own. */
export const DEFAULT_BOT_NAMES: readonly string[] = ['Toke', 'Twizz', 'Scrandy', 'Qreti', 'Drippy', 'Jaybelly'];
export const BOT_NAMES_MAX = 24;
export const BOT_NAME_MIN_LEN = 2;
export const BOT_NAME_MAX_LEN = 16;
const NAME_OK = /^[A-Za-z0-9_-]+$/;

/** Check a list of bot names. Returns the cleaned list (trimmed) or the first thing that is wrong, in words. */
export function validateBotNames(input: unknown): { ok: true; names: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'The list must be names, one per line.' };
  if (input.some((n) => typeof n !== 'string')) return { ok: false, error: 'The list must be names, one per line.' };
  const names = (input as string[]).map((n) => n.trim()).filter(Boolean);
  if (names.length < 1) return { ok: false, error: 'Add at least one name.' };
  if (names.length > BOT_NAMES_MAX) return { ok: false, error: `At most ${BOT_NAMES_MAX} names (you have ${names.length}).` };
  const seen = new Set<string>();
  for (const n of names) {
    if (n.length < BOT_NAME_MIN_LEN || n.length > BOT_NAME_MAX_LEN) return { ok: false, error: `"${n.slice(0, 20)}" must be ${BOT_NAME_MIN_LEN} to ${BOT_NAME_MAX_LEN} characters.` };
    if (!NAME_OK.test(n)) return { ok: false, error: `"${n}" may only use letters, digits, underscore or hyphen.` };
    if (/^(bot|dummy)/i.test(n)) return { ok: false, error: `"${n}" must not start with Bot or Dummy.` };
    if (seen.has(n.toLowerCase())) return { ok: false, error: `"${n}" is listed twice.` };
    seen.add(n.toLowerCase());
  }
  return { ok: true, names };
}

/** The whole display name of a bot ("Bot Toke"), numbered when the list ran out ("Bot Toke 2"). */
export function botDisplayName(name: string, round = 1): string {
  return round > 1 ? `Bot ${name} ${round}` : `Bot ${name}`;
}

/**
 * Pick a name for a new bot that no other bot in the match wears: random among the unused names of the list; once every
 * name is used, a random one again with the next number. `taken` holds display names already in the match.
 */
export function pickBotName(list: readonly string[], taken: ReadonlySet<string>, rng: () => number = Math.random): string {
  const names = list.length ? list : DEFAULT_BOT_NAMES;
  for (let round = 1; ; round++) {
    const free = names.filter((n) => !taken.has(botDisplayName(n, round)));
    if (free.length) return botDisplayName(free[Math.floor(rng() * free.length)], round);
  }
}

/** Whether a unit name is a bot's (also "Bot Toke 2"). */
export const isBotName = (name: string): boolean => name.startsWith('Bot ');
