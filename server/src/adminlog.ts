import { packHudDefault, parseHudDefault, validateBotNames } from '@arena/shared';
import type { AdminLogRow, HudLayoutMap } from '@arena/shared';
import type { Store } from './store';

const KEY = 'adminlog';
const KEEP = 600;
/** The owner's default HUD layout for everyone (store key). */
export const HUD_DEFAULT_KEY = 'hud:default';
export interface HudDefault {
  layout: HudLayoutMap;
  at: number;
  by: string;
}

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

  /** The owner's default HUD layout, or null when there is none (kept over restarts). */
  async hudDefault(): Promise<HudDefault | null> {
    try {
      const raw = await this.store.get(HUD_DEFAULT_KEY);
      const v = raw ? (JSON.parse(raw) as Partial<HudDefault>) : null;
      const layout = v ? parseHudDefault(v.layout) : null;
      return v && layout ? { layout, at: typeof v.at === 'number' ? v.at : 0, by: typeof v.by === 'string' ? v.by : '' } : null;
    } catch {
      return null;
    }
  }

  /** Save the default (false if it is empty or too big to keep) or remove it with null. */
  async setHudDefault(d: HudDefault | null): Promise<boolean> {
    if (!d) {
      await this.store.del(HUD_DEFAULT_KEY);
      return true;
    }
    const packed = packHudDefault(d.layout);
    if (!packed) return false;
    await this.store.set(HUD_DEFAULT_KEY, JSON.stringify({ layout: JSON.parse(packed), at: d.at, by: d.by }));
    return true;
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

  /** The owner's list of bot names (store key `botnames`), or null while the built-in list is in use. */
  async botNames(): Promise<string[] | null> {
    try {
      const raw = await this.store.get('botnames');
      const v = raw ? validateBotNames(JSON.parse(raw)) : null;
      return v?.ok ? v.names : null;
    } catch {
      return null;
    }
  }

  async setBotNames(names: string[] | null): Promise<void> {
    if (names) await this.store.set('botnames', JSON.stringify(names));
    else await this.store.del('botnames');
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
