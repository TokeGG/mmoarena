import type { BotTest } from '@arena/shared';
import type { TipContent } from './tooltip';

/**
 * The words of the "Learning test" marker an owner or dev sees on a bot that plays an experimental brain. Pure text, built
 * from the `bot_tests` message (which the server builds from the same variant records as the "What was learned" report).
 */

/** "won 3 of 12 games against people so far" / "no games against people yet". */
export function testRecord(t: Pick<BotTest, 'games' | 'wins'>): string {
  if (t.games <= 0) return 'no games against people yet';
  return `won ${Math.round(t.wins)} of ${t.games} game${t.games === 1 ? '' : 's'} against people so far`;
}

/**
 * One sentence: "Learning test: this bot is trying: use defensive cooldowns later (62% instead of 65%) · look for: Evasion,
 * Vanish, Desperate Prayer, Enraged Regeneration going off (lesson, no games against people yet)".
 */
export function botTestSummary(t: BotTest): string {
  const tries = t.tries.map((x) => x.text).join(' · ');
  const more = t.more > 0 ? ` · and ${t.more} smaller change${t.more === 1 ? '' : 's'}` : '';
  const look = t.tries[0]?.watch ?? '';
  return `Learning test: this bot is trying: ${tries}${more}${look ? ` · look for: ${look}` : ''} (${t.label}, ${testRecord(t)})`;
}

/** The tooltip the pseudo-aura shows. */
export function botTestTip(t: BotTest): TipContent {
  const lines = t.tries.map((x) => `• ${x.text}`);
  if (t.more > 0) lines.push(`• and ${t.more} smaller change${t.more === 1 ? '' : 's'}`);
  const watch = [...new Set(t.tries.map((x) => x.watch))];
  return {
    title: 'Learning test',
    titleColor: '#c792ff',
    tag: t.label,
    stats: ['This bot is trying, against the brain it ships with:', testRecord(t)],
    lines,
    notes: watch.length ? [`Look for: ${watch.join('; ')}`] : [],
    footer: 'Only you (owner and devs) can see this. Players are never told.',
  };
}
