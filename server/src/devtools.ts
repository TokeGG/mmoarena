import { ABILITIES, AURAS, applyPatches, currentValue, mergePatches, validPatch } from '@arena/shared';
import type { DataPatch } from '@arena/shared';
import type { Store } from './store';

const KEY = 'devoverrides';
const WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
/** The data files a patch can land in, as the repository has them. */
const FILES: Record<DataPatch['file'], string> = { abilities: 'shared/data/abilities.json', auras: 'shared/data/auras.json' };

export interface DevToolsEnv {
  /** A GitHub token that may push branches and open pull requests on the repository. */
  GITHUB_TOKEN?: string;
  /** owner/repo, by default TokeGG/mmoarena. */
  GITHUB_REPO?: string;
  /** Branch pull requests go into, by default main. */
  GITHUB_BASE?: string;
  /** Discord webhook for dev notes (else the suggestion box's). */
  DEV_NOTES_WEBHOOK_URL?: string;
  SUGGESTION_WEBHOOK_URL?: string;
}

/**
 * The server's side of dev tuning. Numbers a dev saves are kept in the store and applied over the data files for
 * everyone (they survive restarts), and each save is also proposed for the data files as a GitHub pull request, so it
 * becomes a real patch once the owner merges it. Notes on skills go to the owner's Discord.
 */
export class DevTools {
  private list: DataPatch[] = [];
  private undo: (() => void) | null = null;
  private ready: Promise<void>;
  private webhook: string | null;

  constructor(private store: Store, private env: DevToolsEnv = {}, private http: typeof fetch = (...a) => fetch(...a)) {
    const hook = (env.DEV_NOTES_WEBHOOK_URL || env.SUGGESTION_WEBHOOK_URL || '').trim();
    this.webhook = WEBHOOK.test(hook) ? hook : null;
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const raw = await this.store.get(KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      if (Array.isArray(v)) this.setLive((v as DataPatch[]).filter((p) => validPatch(p)));
    } catch {
      /* no overrides */
    }
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  /** The numbers changed for everyone, over the data files. */
  get overrides(): DataPatch[] {
    return this.list;
  }

  /** Put the data back as the files have it, then apply `list` (so removing an override restores the file's number). */
  private setLive(list: DataPatch[]): void {
    this.undo?.();
    this.list = list;
    this.undo = applyPatches(list);
  }

  /** Keep `patches` for everyone: applied now, stored for restarts. Returns the full override list. */
  async save(patches: DataPatch[]): Promise<DataPatch[]> {
    this.setLive(mergePatches(this.list, patches));
    await this.store.set(KEY, JSON.stringify(this.list));
    return this.list;
  }

  async clear(): Promise<void> {
    this.setLive([]);
    await this.store.set(KEY, JSON.stringify([]));
  }

  get canOpenPr(): boolean {
    return !!this.env.GITHUB_TOKEN;
  }

  /**
   * Propose the numbers for the data files: a branch with the edited JSON (formatting kept) and a pull request into the
   * base branch. Resolves to the pull request's URL, or throws a message fit to show.
   */
  async openPullRequest(patches: DataPatch[], by: string, note?: string): Promise<string> {
    const token = this.env.GITHUB_TOKEN;
    if (!token) throw new Error('No GITHUB_TOKEN on the server: the numbers are live, but no pull request was opened.');
    const repo = this.env.GITHUB_REPO || 'TokeGG/mmoarena';
    const base = this.env.GITHUB_BASE || 'main';
    const api = (path: string, init: RequestInit = {}) =>
      this.http(`https://api.github.com/repos/${repo}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'arena-devtools', ...(init.headers ?? {}) },
      }).then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        if (!r.ok) throw new Error(`GitHub: ${String(body.message ?? r.status)}`);
        return body;
      });
    const ref = (await api(`/git/ref/heads/${base}`)) as { object: { sha: string } };
    const branch = `dev-tuning/${Date.now().toString(36)}`;
    await api('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: ref.object.sha }) });
    const lines: string[] = [];
    for (const file of ['abilities', 'auras'] as const) {
      const mine = patches.filter((p) => p.file === file);
      if (!mine.length) continue;
      const got = (await api(`/contents/${FILES[file]}?ref=${branch}`)) as { content: string; sha: string };
      const text = Buffer.from(got.content, 'base64').toString('utf8');
      const next = patchJsonText(text, file, mine);
      for (const p of mine) lines.push(`- ${label(p)}: ${fileValue(text, file, p) ?? '?'} → ${p.value}`);
      await api(`/contents/${FILES[file]}`, { method: 'PUT', body: JSON.stringify({ message: `Dev tuning by ${by}`, content: Buffer.from(next, 'utf8').toString('base64'), sha: got.sha, branch }) });
    }
    const pr = (await api('/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title: `Dev tuning: ${patches.slice(0, 3).map(label).join(', ')}${patches.length > 3 ? ` and ${patches.length - 3} more` : ''}`,
        head: branch,
        base,
        body: `Numbers tested in game by **${by}** and saved with the dev tools (already live on the server as overrides).\n\n${lines.join('\n')}${note ? `\n\nNote: ${note}` : ''}\n\nBefore merging: bump the version and add a patch note, run \`npx tsx scripts/gen-wiki.ts\`, \`npx tsx scripts/train-rotations.ts\` and \`npx tsx scripts/train-bots.ts\`, and run the tests (see CLAUDE.md).`,
      }),
    })) as { html_url: string };
    return pr.html_url;
  }

  get notifies(): boolean {
    return !!this.webhook;
  }

  /** A dev's note on a skill, posted to the owner's Discord with the skill's numbers as they are now. */
  async note(by: string, abilityId: string, text: string, testing: DataPatch[] = []): Promise<boolean> {
    if (!this.webhook) return false;
    const def = ABILITIES[abilityId];
    const mine = testing.filter((p) => p.id === abilityId || def?.effects.some((e) => e.type === 'aura' && e.aura === p.id));
    const content = [
      `📝 **Skill note** on **${def?.name ?? abilityId}** from **${by}**`,
      text,
      ...(mine.length ? ['Testing with: ' + mine.map((p) => `${label(p)} ${currentValue(p) ?? '?'} → ${p.value}`).join(', ')] : []),
    ].join('\n').slice(0, 1900);
    try {
      const r = await this.http(this.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
      return r.ok;
    } catch {
      return false;
    }
  }
}

/** "Fireball · effects.0.amount" */
export function label(p: DataPatch): string {
  const name = p.file === 'abilities' ? ABILITIES[p.id]?.name : AURAS[p.id]?.name;
  return `${name ?? p.id} · ${p.path.join('.')}`;
}

/** The number at a patch's spot in a data file's text (the file as the repository has it). */
function fileValue(text: string, file: DataPatch['file'], p: DataPatch): number | undefined {
  try {
    const data = JSON.parse(text) as unknown;
    let o: unknown = file === 'abilities' ? (data as { id: string }[]).find((a) => a.id === p.id) : (data as Record<string, unknown>)[p.id];
    for (const k of p.path) o = o && typeof o === 'object' ? (o as Record<string | number, unknown>)[k] : undefined;
    return typeof o === 'number' ? o : undefined;
  } catch {
    return undefined;
  }
}

/** A data file's text with the patches applied, keeping its indentation (abilities.json uses one space, auras.json two). */
export function patchJsonText(text: string, file: DataPatch['file'], patches: DataPatch[]): string {
  const data = JSON.parse(text) as unknown;
  for (const p of patches) {
    let o: unknown = file === 'abilities' ? (data as { id: string }[]).find((a) => a.id === p.id) : (data as Record<string, unknown>)[p.id];
    for (let i = 0; i < p.path.length - 1; i++) o = o && typeof o === 'object' ? (o as Record<string | number, unknown>)[p.path[i]] : undefined;
    const last = p.path[p.path.length - 1];
    if (o && typeof o === 'object' && typeof (o as Record<string | number, unknown>)[last] === 'number') (o as Record<string | number, unknown>)[last] = p.value;
  }
  const indent = /\n( +)\S/.exec(text)?.[1].length ?? 2;
  return JSON.stringify(data, null, indent) + (text.endsWith('\n') ? '\n' : '');
}
