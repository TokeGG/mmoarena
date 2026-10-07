import type { Store } from './store';

export interface Suggestion { at: number; name: string; text: string }
export const SUGGESTION_MAX = 600;
const KEY = 'suggestions';
const KEEP = 300;

const WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

/** Players' suggestion box: newest first, capped, kept in the same store as accounts. The owner reads it in the menu. */
export class Suggestions {
  private chain: Promise<unknown> = Promise.resolve();
  private webhook: string | null;
  /**
   * `webhook` is a Discord webhook URL (set SUGGESTION_WEBHOOK_URL on the server; it is a secret and never lives in the
   * repo). Every suggestion is also posted there, without any @mentions.
   */
  constructor(private store: Store, webhook?: string, private post: typeof fetch = (...a) => fetch(...a)) {
    this.webhook = webhook && WEBHOOK.test(webhook.trim()) ? webhook.trim() : null;
  }

  get notifies(): boolean {
    return !!this.webhook;
  }

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
      this.notify(rows[0]);
      return true;
    });
    this.chain = run.catch(() => undefined);
    return run.catch(() => false);
  }

  private notify(s: Suggestion): void {
    if (!this.webhook) return;
    const body = JSON.stringify({
      username: 'Arena suggestions',
      content: `💡 **${s.name.replace(/[*_`~|>@]/g, '')}** suggests:\n${s.text.replace(/@/g, '@\u200b')}`.slice(0, 1900),
      allowed_mentions: { parse: [] },
    });
    // fire and forget: a Discord outage must never lose or delay the suggestion
    void this.post(this.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => undefined);
  }
}
