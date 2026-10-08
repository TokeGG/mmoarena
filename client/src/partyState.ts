import { partyWaitingText } from '@arena/shared';
import type { PartyInfo } from '@arena/shared';

export interface PartyReadiness {
  /** Members who still have to press Ready (never the leader). */
  waiting: string[];
  /** Ready members, the leader counted. */
  ready: number;
  total: number;
  /** The leader may pick a mode: nobody is left to wait for. */
  canStart: boolean;
  /** One line for the party panel and the disabled buttons. */
  label: string;
}

/** Who the party leader is still waiting for, and the text that says so. A party of one (or none) never waits. */
export function partyReadiness(info: PartyInfo | null): PartyReadiness {
  if (!info) return { waiting: [], ready: 1, total: 1, canStart: true, label: '' };
  const waiting = info.members.filter((m) => !m.ready && m.name !== info.leader).map((m) => m.name);
  const total = info.members.length;
  const ready = total - waiting.length;
  return {
    waiting,
    ready,
    total,
    canStart: waiting.length === 0,
    label: waiting.length ? partyWaitingText(waiting, ready, total) : 'Everyone is ready.',
  };
}
