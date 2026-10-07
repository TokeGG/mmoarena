import type { Store } from './store';

export interface Suggestion { at: number; name: string; text: string; note?: string }
const NOTE_LIMIT = 10000;
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

  add(name: string, text: string, note?: string): Promise<boolean> {
    const run = this.chain.then(async () => {
      const rows = await this.list();
      rows.unshift({ at: Date.now(), name: name.slice(0, 24), text: text.slice(0, SUGGESTION_MAX), ...(note ? { note: note.slice(0, NOTE_LIMIT) } : {}) });
      await this.store.set(KEY, JSON.stringify(rows.slice(0, KEEP)));
      this.notify(rows[0]);
      return true;
    });
    this.chain = run.catch(() => undefined);
    return run.catch(() => false);
  }

  /** Take one suggestion out of the box (matched by time and text). */
  remove(at: number, text: string): Promise<boolean> {
    const run = this.chain.then(async () => {
      const rows = await this.list();
      const left = rows.filter((r) => !(r.at === at && r.text === text));
      if (left.length === rows.length) return false;
      await this.store.set(KEY, JSON.stringify(left));
      return true;
    });
    this.chain = run.catch(() => undefined);
    return run.catch(() => false);
  }

  private notify(s: Suggestion): void {
    if (!this.webhook) return;
    const payload = JSON.stringify({
      username: 'Arena suggestions',
      content: `💡 **${s.name.replace(/[*_`~|>@]/g, '')}** suggests:\n${s.text.replace(/@/g, '@\u200b')}`.slice(0, 1900),
      allowed_mentions: { parse: [] },
    });
    // fire and forget: a Discord outage must never lose or delay the suggestion
    if (s.note) {
      // the attached note goes along as a text file
      const form = new FormData();
      form.append('payload_json', payload);
      form.append('files[0]', new Blob([s.note], { type: 'text/plain' }), 'suggestion-note.txt');
      void this.post(this.webhook, { method: 'POST', body: form }).catch(() => undefined);
      return;
    }
    void this.post(this.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }).catch(() => undefined);
  }
}
