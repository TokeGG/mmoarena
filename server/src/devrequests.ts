import { requestText } from '@arena/shared';
import type { ChatChange, DevRequestRow } from '@arena/shared';
import type { Store } from './store';
import type { RequestDraft } from './aitune';

const KEY = 'devrequests';
const MAX_ROWS = 100;
const PER_HOUR = 10;
export const REQUEST_LABEL = 'dev-request';

export interface DevRequestsEnv {
  /** Opens the GitHub issue (needs the token's Issues permission). */
  GITHUB_TOKEN?: string;
  /** owner/repo, by default TokeGG/mmoarena. */
  GITHUB_REPO?: string;
  /** Set to 1 to also open a GitHub issue labelled dev-request for each request (off by default). */
  ARENA_DEV_REQUEST_ISSUES?: string;
}

export { requestText };

/** Change requests devs file through Ask Claude for what needs code: kept in the store, posted to Discord, opened as a GitHub issue. */
export class DevRequests {
  private rows: DevRequestRow[] = [];
  private ready: Promise<void>;
  private filed = new Map<string, number[]>();

  constructor(
    private store: Store,
    private env: DevRequestsEnv = {},
    private http: typeof fetch = (...a) => fetch(...a),
    private post: (text: string) => Promise<boolean> = async () => false,
  ) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const raw = await this.store.get(KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      if (Array.isArray(v)) this.rows = (v as DevRequestRow[]).filter((r) => r && typeof r.id === 'string' && typeof r.title === 'string').slice(0, MAX_ROWS);
    } catch {
      /* none */
    }
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  get list(): DevRequestRow[] {
    return this.rows;
  }

  /** The rows a viewer may see: the owner all of them, a dev their own. */
  visible(name: string, all: boolean): DevRequestRow[] {
    return all ? this.rows : this.rows.filter((r) => r.by === name);
  }

  private persist(): Promise<void> {
    return this.store.set(KEY, JSON.stringify(this.rows)).catch(() => undefined);
  }

  private repo(): string {
    return this.env.GITHUB_REPO || 'TokeGG/mmoarena';
  }

  private api(path: string, init: RequestInit = {}) {
    return this.http(`https://api.github.com/repos/${this.repo()}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'arena-devtools', ...(init.headers ?? {}) },
    }).then(async (r) => {
      const body = (await r.json().catch(() => ({}))) as unknown;
      if (!r.ok) throw new Error(`GitHub: ${String((body as { message?: unknown }).message ?? r.status)}`);
      return body;
    });
  }

  /** Room for one more request from `by` (ten an hour). */
  private allow(by: string): boolean {
    const now = Date.now();
    const l = (this.filed.get(by) ?? []).filter((t) => now - t < 3_600_000);
    if (l.length >= PER_HOUR) return false;
    l.push(now);
    this.filed.set(by, l);
    return true;
  }

  /**
   * Store a request, post it to Discord and, when ARENA_DEV_REQUEST_ISSUES=1, open a GitHub issue labelled dev-request. Discord and GitHub failures never lose the request: the reason is kept on it.
   */
  async file(by: string, scope: string, d: RequestDraft, tested: ChatChange[]): Promise<{ ok: boolean; row?: DevRequestRow; text: string }> {
    await this.ready;
    if (!this.allow(by)) return { ok: false, text: 'You filed a lot of requests this hour (10 at most). Try again later.' };
    const row: DevRequestRow = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      by, at: Date.now(), scope, title: d.title, wants: d.wants, current: d.current, proposed: d.proposed,
      acceptance: d.acceptance, affects: d.affects, needsCode: d.needsCode, tested: tested.slice(0, 40), status: 'open',
    };
    const body = requestText(row);
    if (this.env.ARENA_DEV_REQUEST_ISSUES === '1' && this.env.GITHUB_TOKEN) {
      try {
        // the label first (it starts Claude Code on GitHub); an existing one answers 422
        await this.api('/labels', { method: 'POST', body: JSON.stringify({ name: REQUEST_LABEL, color: 'a371f7', description: 'Asked for in the game by a dev' }) }).catch(() => undefined);
        const issue = (await this.api('/issues', { method: 'POST', body: JSON.stringify({ title: `Dev request: ${row.title}`.slice(0, 200), body: body.slice(0, 60000), labels: [REQUEST_LABEL] }) })) as { html_url?: string; number?: number };
        row.issueUrl = issue.html_url;
        row.issueNumber = issue.number;
      } catch (e) {
        const m = (e as Error).message;
        row.issueError = /resource not accessible|bad credentials|forbidden|not found|requires authentication/i.test(m)
          ? `GitHub refused to open the issue: the server's GITHUB_TOKEN needs the Issues "Read and write" permission on the repository. ${m}`
          : m;
      }
    } else if (this.env.ARENA_DEV_REQUEST_ISSUES === '1') row.issueError = 'No GITHUB_TOKEN on the server, so no GitHub issue was opened. The request is saved here.';
    this.rows = [row, ...this.rows].slice(0, MAX_ROWS);
    await this.persist();
    void this.post(`📋 **Change request** from **${by}**: ${row.title}\n${row.proposed}\n${row.issueUrl ? `Issue: ${row.issueUrl}` : '(no GitHub issue)'}\n${requestText(row).slice(0, 1200)}`).catch(() => false);
    return { ok: true, row, text: '' };
  }

  /** Owner: mark done or open again, or delete. Returns false when there is no such request. */
  async mark(id: string, op: 'done' | 'reopen' | 'delete'): Promise<boolean> {
    await this.ready;
    const r = this.rows.find((x) => x.id === id);
    if (!r) return false;
    if (op === 'delete') this.rows = this.rows.filter((x) => x !== r);
    else if (op === 'done') {
      r.status = 'done';
      r.doneAt = Date.now();
    } else {
      r.status = 'open';
      delete r.doneAt;
    }
    await this.persist();
    return true;
  }
}
