import type { BotTest, ServerMsg } from '@arena/shared';

/**
 * The testing markers of the match you are in or watching (owner and devs only: the server sends nobody else this). The
 * unit frames, nameplates and the spectator builds panel ask here whether a unit wears the pseudo-aura. Unit ids belong to
 * one match, so it is emptied whenever a new match starts or ends.
 */
class BotTestState {
  match = '';
  /** Every bot in the match (even on the shipped brain): the note box shows when there is one. */
  bots = 0;
  private units = new Map<number, BotTest>();

  handle(m: Extract<ServerMsg, { t: 'bot_tests' }>): void {
    this.match = m.match;
    this.bots = m.bots;
    this.units = new Map(m.units.map((u) => [u.unit, u]));
  }
  get(unit: number): BotTest | undefined {
    return this.units.get(unit);
  }
  /** A key that changes when a unit's marker does (icons are only rebuilt when it does). */
  key(unit: number): string {
    const t = this.units.get(unit);
    return t ? `${t.label}:${t.tries.map((x) => x.key).join(',')}:${t.games}` : '';
  }
  clear(): void {
    this.match = '';
    this.bots = 0;
    this.units.clear();
  }
}

export const botTests = new BotTestState();
