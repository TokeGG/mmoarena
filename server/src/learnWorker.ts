import { parentPort } from 'node:worker_threads';
import { readReplay } from '@arena/shared';
import type { ReplayData } from '@arena/shared';

/**
 * Worker thread for the bot learner: replaying a finished match to measure how its people played takes from a fraction
 * of a second to several seconds, which must never stall the game loop that runs every room.
 */
parentPort?.on('message', (m: { id: number; replay: ReplayData }) => {
  try {
    parentPort!.postMessage({ id: m.id, ok: true, measured: readReplay(m.replay) });
  } catch {
    parentPort!.postMessage({ id: m.id, ok: false });
  }
});
