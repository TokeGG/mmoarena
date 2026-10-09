import { ABILITIES, ABILITY_CHOICES, ABILITY_FLAGS, AURAS, CLASSES, SPECS, TALENTS, applyPatches, currentValue, mergePatches, validPatch } from '@arena/shared';
import type { ClassId, DataPatch, ProposalRow } from '@arena/shared';
import type { Store } from './store';

const KEY = 'devoverrides';
const PROPOSALS = 'devproposals';
const MAX_PROPOSALS = 100;
const WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
/** The data files a patch can land in, as the repository has them. */
const FILES: Record<DataPatch['file'], string> = { abilities: 'shared/data/abilities.json', auras: 'shared/data/auras.json', specs: 'shared/data/specs.json', talents: 'shared/data/talents.json', classes: 'shared/data/classes.json' };

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
  /** Render's deploy hook for this service (Dashboard, Settings, Deploy Hook): a request to it starts a deploy. */
  RENDER_DEPLOY_HOOK_URL?: string;
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

  private props: ProposalRow[] = [];

  /** What devs sent to the owner, newest first. */
  get proposals(): ProposalRow[] {
    return this.props;
  }

  /** A dev's changes go to the owner's admin panel, stacked with the others; nothing changes in the game. */
  async propose(by: string, patches: DataPatch[], note?: string): Promise<ProposalRow> {
    const row: ProposalRow = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      by, at: Date.now(), ...(note ? { note } : {}), patches,
      changes: patches.map((p) => ({ label: label(p), from: currentValue(p) ?? null, to: p.value })),
      status: 'pending',
    };
    this.props = [row, ...this.props].slice(0, MAX_PROPOSALS);
    await this.persistProposals();
    return row;
  }

  private persistProposals(): Promise<void> {
    return this.store.set(PROPOSALS, JSON.stringify(this.props));
  }

  /**
   * The owner acts on proposals: `live` applies them over the data files, `pr` opens one pull request with all of them
   * (later changes to the same number win), `dismiss` forgets them. Returns a line to show and a pull request link.
   */
  async actOn(op: 'live' | 'pr' | 'commit' | 'dismiss', ids: string[] | undefined, by: string, note?: string): Promise<{ ok: boolean; text: string; url?: string }> {
    const rows = this.props.filter((r) => r.status === 'pending' && (!ids || ids.includes(r.id)));
    if (!rows.length) return { ok: false, text: 'There is nothing pending to act on.' };
    // oldest first, so a newer proposal for the same number wins
    const merged = [...rows].reverse().reduce<DataPatch[]>((acc, r) => mergePatches(acc, r.patches), []);
    if (op === 'dismiss') {
      for (const r of rows) r.status = 'dismissed';
      await this.persistProposals();
      return { ok: true, text: `Dismissed ${rows.length} proposal${rows.length === 1 ? '' : 's'}.` };
    }
    if (op === 'live') {
      await this.save(merged);
      for (const r of rows) r.status = 'live';
      await this.persistProposals();
      return { ok: true, text: `${rows.length} proposal${rows.length === 1 ? ' is' : 's are'} live for everyone now (${merged.length} number${merged.length === 1 ? '' : 's'}).` };
    }
    if (op === 'commit') {
      // straight onto the main branch (the owner's choice), credited to whoever pressed the button
      const notes = [...rows.filter((r) => r.note).map((r) => `${r.by}: ${r.note}`), ...(note ? [note] : [])].join('\n');
      try {
        const url = await this.commitToBase(merged, by, notes || undefined);
        for (const r of rows) { r.status = 'committed'; r.url = url; }
        await this.persistProposals();
        return { ok: true, text: `Committed ${rows.length} proposal${rows.length === 1 ? '' : 's'} (${merged.length} number${merged.length === 1 ? '' : 's'}) to the main branch on GitHub. The game updates when the next deploy finishes.`, url };
      } catch (e) {
        return { ok: false, text: (e as Error).message };
      }
    }
    const names = [...new Set(rows.map((r) => r.by))].join(', ');
    const notes = [...rows.filter((r) => r.note).map((r) => `${r.by}: ${r.note}`), ...(note ? [note] : [])].join('\n');
    try {
      const url = await this.openPullRequest(merged, names, notes || undefined);
      for (const r of rows) { r.status = 'pr'; r.url = url; }
      await this.persistProposals();
      return { ok: true, text: `One pull request with ${rows.length} proposal${rows.length === 1 ? '' : 's'} is open.`, url };
    } catch (e) {
      return { ok: false, text: (e as Error).message };
    }
  }

  private async load(): Promise<void> {
    try {
      const rawP = await this.store.get(PROPOSALS);
      const vp = rawP ? (JSON.parse(rawP) as unknown) : [];
      if (Array.isArray(vp)) this.props = (vp as ProposalRow[]).filter((r) => r && typeof r.id === 'string' && Array.isArray(r.patches)).slice(0, MAX_PROPOSALS);
    } catch {
      /* none */
    }
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
    const { api, base } = this.github(token);
    const ref = (await api(`/git/ref/heads/${base}`)) as { object: { sha: string } };
    const branch = `dev-tuning/${Date.now().toString(36)}`;
    await api('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: ref.object.sha }) });
    const lines: string[] = [];
    for (const file of ['abilities', 'auras', 'specs', 'talents', 'classes'] as const) {
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

  /** A GitHub API caller for the repository (token in the header), and the base branch. */
  private github(token: string) {
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
    return { api, base, repo };
  }

  /**
   * A dev commits their numbers straight to the base branch (the owner's choice: no pull request, no review). Only the
   * JSON data files' numbers can change this way (the patches are validated first), one commit per file. Resolves to the
   * URL of the last commit, or throws a message fit to show.
   */
  async commitToBase(patches: DataPatch[], by: string, note?: string): Promise<string> {
    const token = this.env.GITHUB_TOKEN;
    if (!token) throw new Error('No GITHUB_TOKEN on the server: nothing was committed.');
    if (!patches.length || !patches.every((p) => validPatch(p))) throw new Error('Those changes are not valid numbers.');
    const { api, base } = this.github(token);
    let url = '';
    let n = 0;
    try {
      for (const file of ['abilities', 'auras', 'specs', 'talents', 'classes'] as const) {
        const mine = patches.filter((p) => p.file === file);
        if (!mine.length) continue;
        // someone else may commit the same file between our read and our write: read again and retry a few times
        for (let attempt = 1; ; attempt++) {
          const got = (await api(`/contents/${FILES[file]}?ref=${base}`)) as { content: string; sha: string };
          const text = Buffer.from(got.content, 'base64').toString('utf8');
          const next = patchJsonText(text, file, mine);
          if (next === text) break;
          const lines = mine.map((p) => `${label(p)}: ${fileValue(text, file, p) ?? '?'} -> ${p.value}`);
          try {
            const res = (await api(`/contents/${FILES[file]}`, {
              method: 'PUT',
              body: JSON.stringify({ message: `Dev tuning by ${by}: ${lines.slice(0, 3).join('; ')}${lines.length > 3 ? ` and ${lines.length - 3} more` : ''}${note ? `\n\n${note}` : ''}`, content: Buffer.from(next, 'utf8').toString('base64'), sha: got.sha, branch: base }),
            })) as { commit?: { html_url?: string } };
            url = res.commit?.html_url ?? url;
            n++;
            break;
          } catch (e) {
            if (attempt < 3 && /does not match|409|422/.test((e as Error).message)) continue;
            throw e;
          }
        }
      }
    } catch (e) {
      throw new Error(friendlyGithubError((e as Error).message, base));
    }
    if (!n) throw new Error('Nothing changed: those numbers are already what the files have.');
    return url || `https://github.com/${this.env.GITHUB_REPO || 'TokeGG/mmoarena'}/commits/${base}`;
  }

  private lastRedeploy = 0;

  /** Is a Render deploy hook set? */
  get canRedeploy(): boolean {
    return !!this.env.RENDER_DEPLOY_HOOK_URL;
  }

  /** Starts a deploy of the latest commit on Render through its deploy hook (at most one every two minutes). */
  async redeploy(): Promise<string> {
    const hook = this.env.RENDER_DEPLOY_HOOK_URL;
    if (!hook) throw new Error('No Render deploy hook on the server. In Render open the service, Settings, Deploy Hook, copy the URL and add it as RENDER_DEPLOY_HOOK_URL in the server environment.');
    let url: URL;
    try {
      url = new URL(hook);
    } catch {
      throw new Error('RENDER_DEPLOY_HOOK_URL is not a web address.');
    }
    if (url.protocol !== 'https:' || !/(^|\.)render\.com$/.test(url.hostname)) throw new Error('RENDER_DEPLOY_HOOK_URL must be the https deploy hook address from Render.');
    const wait = this.lastRedeploy + 120000 - Date.now();
    if (wait > 0) throw new Error(`A deploy was just started. Try again in ${Math.ceil(wait / 1000)} seconds.`);
    this.lastRedeploy = Date.now();
    try {
      const r = await this.http(url.toString(), { method: 'POST' });
      if (!r.ok) {
        this.lastRedeploy = 0;
        throw new Error(`Render refused the deploy (${r.status}). Check the deploy hook URL.`);
      }
    } catch (e) {
      this.lastRedeploy = 0;
      throw e instanceof Error && e.message.startsWith('Render') ? e : new Error('Could not reach Render to start the deploy.');
    }
    return 'Deploy started on Render. The game restarts when it is ready (a minute or two), so everyone online is disconnected for a moment.';
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

/** GitHub's message in plain words, with what to change when the commit was refused. */
function friendlyGithubError(msg: string, base: string): string {
  if (/protected branch|required status|review required|pull request is required|repository rule/i.test(msg)) return `GitHub refused it: the ${base} branch is protected, so nothing can be committed straight to it. In GitHub open Settings, Branches (or Rules), and allow the token's account to push to ${base} (or turn off "Require a pull request"). ${msg}`;
  if (/resource not accessible|bad credentials|requires authentication|not found/i.test(msg)) return `GitHub refused it: the server's GITHUB_TOKEN cannot write to this repository. It needs the Contents "Read and write" permission on the repository. ${msg}`;
  return msg;
}

/** "Fireball · effects.0.amount" */
export function label(p: DataPatch): string {
  const name = p.file === 'abilities' ? ABILITIES[p.id]?.name : p.file === 'auras' ? AURAS[p.id]?.name : p.file === 'classes' ? CLASSES[p.id as ClassId]?.name : p.file === 'specs' ? Object.values(SPECS).flat().find((x) => x.id === p.id)?.name : Object.values(TALENTS).flatMap((b) => Object.values(b).flat(2)).find((x) => x.id === p.id)?.name;
  return `${name ?? p.id} · ${p.path.join('.')}`;
}

/** The objects in a data file's parsed JSON that a patch changes: one ability, aura, class or spec, or every copy of a talent. */
function targetsIn(data: unknown, file: DataPatch['file'], id: string): unknown[] {
  switch (file) {
    case 'abilities':
      return [(data as { id: string }[]).find((a) => a.id === id)];
    case 'auras':
    case 'classes':
      return [(data as Record<string, unknown>)[id]];
    case 'specs':
      return Object.values(data as Record<string, { id: string }[]>).flat().filter((x) => x.id === id);
    case 'talents':
      return Object.values(data as Record<string, Record<string, { id: string }[][]>>).flatMap((bySpec) => Object.values(bySpec).flat(2)).filter((x) => x.id === id);
  }
}

/** The number at a patch's spot in a data file's text (the file as the repository has it). */
function fileValue(text: string, file: DataPatch['file'], p: DataPatch): number | string | undefined {
  try {
    let o: unknown = targetsIn(JSON.parse(text) as unknown, file, p.id)[0];
    for (const k of p.path) o = o && typeof o === 'object' ? (o as Record<string | number, unknown>)[k] : undefined;
    return typeof o === 'number' || typeof o === 'string' ? o : typeof o === 'boolean' ? (o ? 1 : 0) : undefined;
  } catch {
    return undefined;
  }
}

/** classes.json is laid out by hand, so its numbers are replaced in the text and nothing else moves. */
function patchClassesText(text: string, patches: DataPatch[]): string {
  let out = text;
  for (const p of patches) {
    const start = out.indexOf(`"${p.id}": {`);
    if (start < 0) continue;
    const end = out.indexOf('\n  }', start);
    let from = start;
    for (let i = 0; i < p.path.length - 1; i++) {
      const at = out.indexOf(`"${String(p.path[i])}": {`, from);
      if (at < 0 || at > end) { from = -1; break; }
      from = at;
    }
    if (from < 0) continue;
    const key = String(p.path[p.path.length - 1]);
    const re = new RegExp(`("${key}": )-?[0-9.]+`);
    const seg = out.slice(from, end);
    if (re.test(seg)) out = out.slice(0, from) + seg.replace(re, `$1${p.value}`) + out.slice(end);
  }
  return out;
}

/** A data file's text with the patches applied, keeping its layout (abilities.json indents by one space, the others by two). */
export function patchJsonText(text: string, file: DataPatch['file'], patches: DataPatch[]): string {
  if (file === 'classes') return patchClassesText(text, patches);
  const data = JSON.parse(text) as unknown;
  for (const p of patches) {
    for (const start of targetsIn(data, file, p.id)) {
      let o: unknown = start;
      for (let i = 0; i < p.path.length - 1; i++) o = o && typeof o === 'object' ? (o as Record<string | number, unknown>)[p.path[i]] : undefined;
      const last = p.path[p.path.length - 1];
      if (!o || typeof o !== 'object') continue;
      const rec = o as Record<string | number, unknown>;
      if (file === 'abilities' && p.path.length === 1 && Object.hasOwn(ABILITY_FLAGS, String(last))) {
        // a yes/no option: true or false (an option the file does not have stays out when it is off)
        if (p.value === 1) rec[last] = true;
        else if (last === 'gcd') rec[last] = false;
        else delete rec[last];
      } else if (file === 'abilities' && p.path.length === 1 && Object.hasOwn(ABILITY_CHOICES, String(last))) rec[last] = p.value;
      else if (typeof rec[last] === 'number') rec[last] = p.value;
    }
  }
  const indent = /\n( +)\S/.exec(text)?.[1].length ?? 2;
  let json = JSON.stringify(data, null, indent);
  // specs.json keeps its symbols as \u escapes
  if (file === 'specs') json = json.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return json + (text.endsWith('\n') ? '\n' : '');
}
