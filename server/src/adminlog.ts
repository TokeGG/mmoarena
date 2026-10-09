import type { AdminLogRow } from '@arena/shared';
import type { Store } from './store';

const KEY = 'adminlog';
const KEEP = 600;

/** Every owner action (bans, kicks, rating changes, announcements, ended matches...), newest first, kept in the store. */
export class AdminLog {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private store: Store) {}

  async list(): Promise<AdminLogRow[]> {
    try {
      const raw = await this.store.get(KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(v) ? (v as AdminLogRow[]) : [];
    } catch {
      return [];
    }
  }

  /** Maintenance mode's message, or null when off (kept over restarts). */
  async maintenance(): Promise<string | null> {
    try {
      return (await this.store.get('maintenance')) || null;
    } catch {
      return null;
    }
  }

  async setMaintenance(text: string | null): Promise<void> {
    if (text) await this.store.set('maintenance', text);
    else await this.store.del('maintenance');
  }

  /** Whether the bots train on every finished match, player matches included (kept over restarts). */
  async autoTrain(): Promise<boolean> {
    try {
      return (await this.store.get('autotrain')) === '1';
    } catch {
      return false;
    }
  }

  async setAutoTrain(on: boolean): Promise<void> {
    if (on) await this.store.set('autotrain', '1');
    else await this.store.del('autotrain');
  }

  add(by: string, action: string, target?: string, detail?: string): Promise<void> {
    const run = this.chain.then(async () => {
      const rows = await this.list();
      rows.unshift({ at: Date.now(), by, action, ...(target ? { target } : {}), ...(detail ? { detail: detail.slice(0, 300) } : {}) });
      await this.store.set(KEY, JSON.stringify(rows.slice(0, KEEP)));
    });
    this.chain = run.catch(() => undefined);
    return run.catch(() => undefined);
  }
}
