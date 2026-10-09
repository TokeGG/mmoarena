import type { DevCommitRow } from '@arena/shared';
import { ABILITY_CHOICES, ABILITY_FLAGS, AURA_FLAGS, PATCH_FILES, applyPatches, currentValue, isSwitch, mergePatches, modSlot, nameOf, plainPath, validPatch } from '@arena/shared';
import { ABILITIES, AURAS } from '@arena/shared';
import { dataFileText, mergePlayers } from '@arena/shared';
import type { ClassId, DataPatch, PlayersEntry, PlayersFile, ProposalRow } from '@arena/shared';

/** A file in a commit: its path in the repository and its whole new text. */
interface CommitFile { path: string; content: string }
import type { Store } from './store';

const KEY = 'devoverrides';
const PROPOSALS = 'devproposals';
const COMMITS = 'devcommits';
const MAX_PROPOSALS = 100;
const WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
/** The data files a patch can land in, as the repository has them. */
const FILES: Record<DataPatch['file'], string> = { abilities: 'shared/data/abilities.json', auras: 'shared/data/auras.json', specs: 'shared/data/specs.json', talents: 'shared/data/talents.json', classes: 'shared/data/classes.json', tuning: 'shared/data/tuning.json' };

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
  private commitRows: DevCommitRow[] = [];
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
    await this.ready; // the stored list is read first, or it would overwrite this one
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
        const r1 = await this.commitToBase(merged, by, notes || undefined);
        for (const r of rows) { r.status = 'committed'; r.url = r1.url; }
        await this.persistProposals();
        return { ok: true, text: `Committed ${r1.applied} number${r1.applied === 1 ? '' : 's'} from ${rows.length} proposal${rows.length === 1 ? '' : 's'} to the main branch on GitHub as patch ${r1.version}. The game updates when the next deploy finishes.${r1.skipped.length ? ` Left out: ${r1.skipped.join('; ')}.` : ''}`, url: r1.url };
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
      const rawC = await this.store.get(COMMITS);
      const vc = rawC ? (JSON.parse(rawC) as unknown) : [];
      if (Array.isArray(vc)) this.commitRows = (vc as DevCommitRow[]).filter((r) => r && typeof r.version === 'string' && Array.isArray(r.lines)).slice(0, 30);
    } catch {
      /* none */
    }
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
    for (const file of PATCH_FILES) {
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
   * JSON data files' numbers change, and the same single commit is a patch: a new patch-notes entry (one short line per
   * number), the version bumped in package.json, client/package.json and the README, and SIM_REVISION raised. One commit
   * means one deploy and never a half-updated repository. Each number is judged against the repository's own files, so
   * one that no longer exists there (an update changed it) or already has that value is left out and reported.
   */
  async commitToBase(patches: DataPatch[], by: string, note?: string): Promise<{ url: string; applied: number; skipped: string[]; version: string }> {
    const token = this.env.GITHUB_TOKEN;
    if (!token) throw new Error('No GITHUB_TOKEN on the server: nothing was committed.');
    const sane = (p: DataPatch) => !!p && typeof p.id === 'string' && Array.isArray(p.path) && p.path.length > 0 && p.path.every((k) => typeof k === 'string' || typeof k === 'number')
      && (typeof p.value === 'number' ? Number.isFinite(p.value) && Math.abs(p.value) <= 1e9 : typeof p.value === 'string' && p.value.length <= 40) && (PATCH_FILES as readonly string[]).includes(p.file);
    if (!patches.length || !patches.every(sane)) throw new Error('Those changes are not numbers the data files can take.');
    const sum = await this.commitPatch(token, {
      title: 'Balance changes',
      build: async (read) => {
        const files: CommitFile[] = [];
        const skipped: string[] = [];
        const lines: string[] = [];
        const notes: string[] = [];
        for (const file of PATCH_FILES) {
          const mine = patches.filter((p) => p.file === file);
          if (!mine.length) continue;
          const text = await read(FILES[file]);
          const todo: DataPatch[] = [];
          for (const p of mine) {
            const was = fileValue(text, file, p);
            if (was === undefined) skipped.push(`${label(p)} (no longer in the data files)`);
            else if (String(was) === String(p.value)) skipped.push(`${label(p)} (already ${p.value})`);
            else {
              todo.push(p);
              notes.push(`${label(p)}: ${was} -> ${p.value}`);
              lines.push(playerLine(text, file, p, was));
            }
          }
          if (todo.length) files.push({ path: FILES[file], content: patchJsonText(text, file, todo) });
        }
        if (!files.length) throw new Error(`Nothing was committed: ${skipped.length ? skipped.join('; ') : 'those numbers are already what the files have'}.`);
        return { files, lines, message: (version) => `Dev tuning by ${by} (${version}): ${notes.slice(0, 3).join('; ')}${notes.length > 3 ? ` and ${notes.length - 3} more` : ''}${note ? `\n\n${note}` : ''}`, extra: { applied: notes.length, skipped } };
      },
      by,
    });
    return { url: sum.url, applied: sum.extra.applied, skipped: sum.extra.skipped, version: sum.version };
  }

  /**
   * The learned bots straight to the base branch in ONE commit: botbrain.json (the classes that learned something, over the
   * file's other classes) and players.json (the live human-style data, merged over what the file has), plus the same patch
   * bookkeeping as a number change, with a single player-facing line saying how many matches the bots studied. The data
   * comes from BotLearner.exportLive (the formats scripts/study-replays.ts writes).
   */
  async commitLearnedBots(data: { brains: Partial<Record<ClassId, Record<string, number>>>; players: PlayersFile; matches: number }, by: string): Promise<{ url: string; version: string; classes: ClassId[]; matches: number }> {
    const token = this.env.GITHUB_TOKEN;
    if (!token) throw new Error('No GITHUB_TOKEN on the server: nothing was committed.');
    if (data.matches < 1) throw new Error('Nothing was committed: the bots have not studied a match with people since the last commit.');
    const sum = await this.commitPatch(token, {
      title: 'Bots learned from live matches',
      by,
      build: async (read) => {
        const brainText = await read('shared/data/botbrain.json');
        const playersText = await read('shared/data/players.json');
        const brainFile = JSON.parse(brainText) as Record<string, Record<string, number>>;
        const classes = Object.keys(data.brains) as ClassId[];
        for (const c of classes) brainFile[c] = data.brains[c]!;
        const playersFile = mergePlayers(JSON.parse(playersText) as Record<string, Partial<PlayersEntry>>, data.players);
        const files: CommitFile[] = [];
        const nextBrain = dataFileText(brainFile);
        const nextPlayers = dataFileText(playersFile);
        if (nextBrain !== brainText) files.push({ path: 'shared/data/botbrain.json', content: nextBrain });
        if (nextPlayers !== playersText) files.push({ path: 'shared/data/players.json', content: nextPlayers });
        if (!files.length) throw new Error('Nothing was committed: the files already have everything the bots have learned.');
        const n = data.matches;
        return {
          files, lines: [`The bots studied ${n} more match${n === 1 ? '' : 'es'} against players and play better for it.`],
          message: (version) => `Bots learned from live matches (${version}), committed by ${by}\n\n${n} match${n === 1 ? '' : 'es'} with people studied since the last commit. Brains changed for: ${classes.join(', ') || 'no class'}. Human-style data and results against people updated in players.json.`,
          extra: { classes, matches: n },
        };
      },
    });
    return { url: sum.url, version: sum.version, classes: sum.extra.classes, matches: sum.extra.matches };
  }

  /**
   * One commit that is also a patch: `build` makes the changed files (reading the repository's own files at the base
   * branch) and the player-facing lines; this adds the patch-notes entry, the version bumped by its last number in
   * package.json, client/package.json and the README, and SIM_REVISION raised, makes one tree and one commit, and moves the
   * branch. A push that raced ours starts again from the new head. Every committer here goes through it.
   */
  private async commitPatch<X>(token: string, o: { title: string; by: string; build: (read: (path: string) => Promise<string>) => Promise<{ files: CommitFile[]; lines: string[]; message: (version: string) => string; extra: X }> }): Promise<{ url: string; version: string; extra: X }> {
    const { api, base } = this.github(token);
    const read = async (path: string): Promise<string> => {
      const got = (await api(`/contents/${path}?ref=${base}`)) as { content: string };
      return Buffer.from(got.content, 'base64').toString('utf8');
    };
    try {
      for (let attempt = 1; ; attempt++) {
        const ref = (await api(`/git/ref/heads/${base}`)) as { object: { sha: string } };
        const head = (await api(`/git/commits/${ref.object.sha}`)) as { tree: { sha: string } };
        const built = await o.build(read);
        const files = [...built.files];
        // the patch: notes entry, version, README, SIM_REVISION
        const patchesText = await read('shared/data/patches.json');
        const list = JSON.parse(patchesText) as { version: string; date: string; at?: string; title: string; changes: string[]; by?: string }[];
        const version = nextPatchVersion(list[0]?.version ?? '0.0.0');
        const now = new Date();
        const at = now.toISOString().replace(/\.\d+Z$/, 'Z');
        const lines = [...new Set(built.lines)];
        list.unshift({ version, date: at.slice(0, 10), at, title: o.title, changes: lines, by: o.by.slice(0, 40) });
        files.push({ path: 'shared/data/patches.json', content: JSON.stringify(list, null, 1) + (patchesText.endsWith('\n') ? '\n' : '') });
        for (const path of ['package.json', 'client/package.json']) files.push({ path, content: (await read(path)).replace(/("version":\s*")[^"]+(")/, `$1${version}$2`) });
        files.push({ path: 'README.md', content: (await read('README.md')).replace(/^([^\n]*?v)\d+\.\d+\.\d+/, `$1${version}`) });
        files.push({ path: 'shared/src/replay.ts', content: (await read('shared/src/replay.ts')).replace(/(SIM_REVISION\s*=\s*)(\d+)/, (_m, a: string, n: string) => `${a}${Number(n) + 1}`) });
        const tree = (await api('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) }) })) as { sha: string };
        const message = built.message(version);
        const commit = (await api('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }) })) as { sha: string; html_url?: string };
        try {
          await api(`/git/refs/heads/${base}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
        } catch (e) {
          // someone pushed to the branch since we read it: start again from the new head
          if (attempt < 3 && /not a fast.?forward|422|409/i.test((e as Error).message)) continue;
          throw e;
        }
        const url = commit.html_url ?? `https://github.com/${this.env.GITHUB_REPO || 'TokeGG/mmoarena'}/commit/${commit.sha}`;
        await this.recordCommit({ version, by: o.by, at: Date.now(), url, lines });
        return { url, version, extra: built.extra };
      }
    } catch (e) {
      const m = (e as Error).message;
      throw new Error(m.startsWith('Nothing was committed') ? m : friendlyGithubError(m, base));
    }
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
        const body = await r.text().then((t) => t.replace(/\s+/g, ' ').trim().slice(0, 160), () => '');
        throw new Error(`Render refused the deploy (${r.status}${body ? `: ${body}` : ''}). Check that RENDER_DEPLOY_HOOK_URL is the full deploy hook URL, with its key, from the service's Settings.`);
      }
    } catch (e) {
      this.lastRedeploy = 0;
      throw e instanceof Error && e.message.startsWith('Render') ? e : new Error(`Could not reach Render to start the deploy (${e instanceof Error ? e.message : 'network error'}). If the server cannot make outside web requests, allow api.render.com.`);
    }
    return 'Deploy started on Render. The game restarts when it is ready (a minute or two), so everyone online is disconnected for a moment.';
  }

  /** Recent commits to GitHub, newest first. */
  get commits(): DevCommitRow[] {
    return this.commitRows;
  }

  private async recordCommit(row: DevCommitRow): Promise<void> {
    await this.ready;
    this.commitRows = [row, ...this.commitRows].slice(0, 30);
    try {
      await this.store.set(COMMITS, JSON.stringify(this.commitRows));
    } catch {
      /* the commit stands even if the list is not kept */
    }
  }

  get notifies(): boolean {
    return !!this.webhook;
  }

  /** A dev's note on a skill, posted to the owner's Discord with the skill's numbers as they are now. */
  async note(by: string, abilityId: string, text: string, testing: DataPatch[] = []): Promise<boolean> {
    const def = ABILITIES[abilityId];
    const mine = testing.filter((p) => p.id === abilityId || def?.effects.some((e) => e.type === 'aura' && e.aura === p.id));
    const content = [
      `📝 **Skill note** on **${def?.name ?? abilityId}** from **${by}**`,
      text,
      ...(mine.length ? ['Testing with: ' + mine.map((p) => `${label(p)} ${currentValue(p) ?? '?'} → ${p.value}`).join(', ')] : []),
    ].join('\n');
    return this.post(content);
  }

  /** A line to the owner's Discord (dev notes webhook); false when there is none or it failed. */
  async post(text: string): Promise<boolean> {
    if (!this.webhook) return false;
    try {
      const r = await this.http(this.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }) });
      return r.ok;
    } catch {
      return false;
    }
  }
}

/** Always the last number only: 0.69.7 -> 0.69.8, 0.69.9 -> 0.69.10 (never the minor or major one). */
export function nextPatchVersion(v: string): string {
  const [a, b, c] = v.split('.').map((x) => Number(x) || 0);
  return `${a}.${b}.${c + 1}`;
}

const MS_KEYS = new Set(['cooldown', 'castTime', 'duration', 'interval', 'lockout', 'maxDuration']);
const NOUN: Record<string, string> = { cooldown: 'cooldown', castTime: 'cast time', duration: 'duration', cost: 'cost', range: 'range', radius: 'radius', interval: 'tick time', maxDuration: 'longest duration', lockout: 'lockout', absorb: 'shield', absorbPct: 'shield', charges: 'charges' };

/** A value the way patch notes say it: a multiplier as a percent, a time in seconds, a share as a percent, a switch as on or off. */
function showValue(p: DataPatch, v: number | string): string {
  if (isSwitch(p)) return Number(v) === 1 ? 'on' : 'off';
  if (typeof v !== 'number') return String(v);
  const r = (n: number) => String(Math.round(n * 100) / 100);
  switch (plainPath(p.file, p.id, p.path).unit) {
    case 'x': return v === 1 ? 'normal' : v > 1 ? `+${r((v - 1) * 100)}%` : `-${r((1 - v) * 100)}%`;
    case 'ms': return `${r(v / 1000)} s`;
    case 'chance': return `${r(v * 100)}%`;
    case 'percent': return `${r(v)}%`;
    case 'yd': return `${r(v)} yd`;
    default: return r(v);
  }
}

/** One short, player-facing patch-notes line for a number: "Fireball: cooldown 8 s to 7 s". */
function playerLine(text: string, file: DataPatch['file'], p: DataPatch, was: number | string): string {
  // stat bonuses, switches and the game's own rules are worded from the shared labels: "Warden: Power Word: Shield shield strength +50% to +60%."
  if (file === 'tuning' || file === 'specs' || file === 'talents' || (file === 'classes' && p.path[0] === 'resource') || p.path[0] === 'mods' || isSwitch(p)) {
    let name = file === 'tuning' ? 'Game rules' : p.id;
    try {
      const data = JSON.parse(text) as unknown;
      const t = file === 'tuning' ? undefined : ((file === 'classes' ? (data as Record<string, unknown>)[p.id] : targetsIn(data, file, p.id)[0]) as { name?: string } | undefined);
      if (t?.name) name = t.name;
    } catch {
      /* keep the id */
    }
    const plain = plainPath(file, p.id, p.path).label;
    // the label starts with a skill or buff name ("Power Word: Shield: shield strength"): keep its capitals
    const label = [...Object.values(ABILITIES), ...Object.values(AURAS)].some((x) => plain.startsWith(x.name)) ? plain : `${plain.charAt(0).toLowerCase()}${plain.slice(1)}`;
    if (isSwitch(p)) return `${name}: ${label} (now ${showValue(p, p.value)}).`;
    return `${name}: ${label} ${showValue(p, was)} to ${showValue(p, p.value)}.`;
  }
  let name = p.id;
  let parent: Record<string, unknown> | undefined;
  try {
    const data = JSON.parse(text) as unknown;
    const target = file === 'classes' ? (data as Record<string, unknown>)[p.id] : targetsIn(data, file, p.id)[0];
    const t = target as { name?: string } | undefined;
    if (t?.name) name = t.name;
    let o: unknown = target;
    for (let i = 0; i < p.path.length - 1; i++) o = o && typeof o === 'object' ? (o as Record<string | number, unknown>)[p.path[i]] : undefined;
    if (o && typeof o === 'object') parent = o as Record<string, unknown>;
  } catch {
    /* keep the id */
  }
  const key = String(p.path[p.path.length - 1]);
  let noun = NOUN[key];
  if (!noun && (key === 'amount' || key === 'dmg')) {
    const type = parent?.type;
    noun = type === 'damage' ? 'damage' : type === 'heal' ? 'healing' : type === 'absorb' ? 'shield' : 'strength';
  }
  noun ??= key.replace(/([A-Z])/g, ' $1').toLowerCase();
  const show = (v: number | string) => {
    if (typeof v === 'number' && MS_KEYS.has(key)) return `${Math.round((v / 1000) * 100) / 100} s`;
    return String(v);
  };
  return `${name}: ${noun} ${show(was)} to ${show(p.value)}.`;
}

/** GitHub's message in plain words, with what to change when the commit was refused. */
function friendlyGithubError(msg: string, base: string): string {
  if (/protected branch|required status|review required|pull request is required|repository rule/i.test(msg)) return `GitHub refused it: the ${base} branch is protected, so nothing can be committed straight to it. In GitHub open Settings, Branches (or Rules), and allow the token's account to push to ${base} (or turn off "Require a pull request"). ${msg}`;
  if (/resource not accessible|bad credentials|requires authentication|not found/i.test(msg)) return `GitHub refused it: the server's GITHUB_TOKEN cannot write to this repository. It needs the Contents "Read and write" permission on the repository. ${msg}`;
  return msg;
}

/** "Fireball · Damage amount", "Warden · Power Word: Shield: shield strength" */
export function label(p: DataPatch): string {
  return `${nameOf(p.file, p.id)} · ${plainPath(p.file, p.id, p.path).label}`;
}

/** The objects in a data file's parsed JSON that a patch changes: one ability, aura, class or spec, or every copy of a talent (the game options are the whole file). */
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
    case 'tuning':
      return id === 'game' ? [data] : [];
  }
}

/** The number at a patch's spot in a data file's text (the file as the repository has it); a stat change or switch the file does not have yet reads as the value that does nothing. */
function fileValue(text: string, file: DataPatch['file'], p: DataPatch): number | string | undefined {
  try {
    const target = targetsIn(JSON.parse(text) as unknown, file, p.id)[0];
    if (!target) return undefined;
    let o: unknown = target;
    for (const k of p.path) o = o && typeof o === 'object' ? (o as Record<string | number, unknown>)[k] : undefined;
    if (typeof o === 'number' || typeof o === 'string') return o;
    if (typeof o === 'boolean') return o ? 1 : 0;
    // not in the file: a stat change can be added, a switch is off
    const slot = modSlot(p);
    if (slot && (file === 'specs' || file === 'talents' || file === 'auras')) return slot.def;
    if (isSwitch(p)) return 0;
    return undefined;
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
      if (!start || typeof start !== 'object') continue;
      const last = p.path[p.path.length - 1];
      // walk down to the object that holds the value; a stat change the file does not have yet gets its missing levels made
      const chain: Record<string | number, unknown>[] = [start as Record<string | number, unknown>];
      let o: unknown = start;
      let broken = false;
      for (let i = 0; i < p.path.length - 1; i++) {
        const k = p.path[i];
        let next = o && typeof o === 'object' ? (o as Record<string | number, unknown>)[k] : undefined;
        if (next === undefined && o && typeof o === 'object' && !Array.isArray(o) && modSlot(p)) {
          next = {};
          (o as Record<string | number, unknown>)[k] = next;
        }
        if (!next || typeof next !== 'object') {
          broken = true;
          break;
        }
        chain.push(next as Record<string | number, unknown>);
        o = next;
      }
      if (broken) continue;
      const rec = o as Record<string | number, unknown>;
      if (file === 'abilities' && p.path.length === 1 && Object.hasOwn(ABILITY_FLAGS, String(last))) {
        // a yes/no option: true or false (an option the file does not have stays out when it is off)
        if (p.value === 1) rec[last] = true;
        else if (last === 'gcd') rec[last] = false;
        else delete rec[last];
      } else if (file === 'abilities' && p.path.length === 1 && Object.hasOwn(ABILITY_CHOICES, String(last))) rec[last] = p.value;
      else if (file === 'auras' && p.path.length === 1 && Object.hasOwn(AURA_FLAGS, String(last))) {
        // an aura's option: on is written, off leaves it out
        if (p.value === 1) rec[last] = true;
        else delete rec[last];
      } else if (modSlot(p)?.kind === 'flag') {
        // a switch inside mods (castWhileMoving): on is written; off removes it, and a skill entry left empty goes with it
        if (p.value === 1) rec[last] = true;
        else {
          delete rec[last];
          for (let i = chain.length - 1; i >= 2; i--) {
            if (Object.keys(chain[i]).length) break;
            delete chain[i - 1][p.path[i - 1]];
          }
        }
      } else if (typeof rec[last] === 'number' || (modSlot(p) && rec[last] === undefined && typeof p.value === 'number')) rec[last] = p.value;
    }
  }
  const indent = /\n( +)\S/.exec(text)?.[1].length ?? 2;
  let json = JSON.stringify(data, null, indent);
  // specs.json keeps its symbols as \u escapes
  if (file === 'specs') json = json.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return json + (text.endsWith('\n') ? '\n' : '');
}
