import type { Store } from './store';

export interface Suggestion { at: number; name: string; text: string }
export const SUGGESTION_MAX = 600;
const KEY = 'suggestions';
const KEEP = 300;

/** Players' suggestion box: newest first, capped, kept in the same store as accounts. The owner reads it in the menu. */
export class Suggestions {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private store: Store) {}

  async list(): Promise<Suggestion[]> {
    try {
      const raw = await this.store.get(KEY);
      const rows = raw ? (JSON.parse(raw) as Suggestion[]) : [];
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  add(name: string, text: string): Promise<boolean> {
    const run = this.chain.then(async () => {
      const rows = await this.list();
      rows.unshift({ at: Date.now(), name: name.slice(0, 24), text: text.slice(0, SUGGESTION_MAX) });
      await this.store.set(KEY, JSON.stringify(rows.slice(0, KEEP)));
      return true;
    });
    this.chain = run.catch(() => undefined);
    return run.catch(() => false);
  }
}
