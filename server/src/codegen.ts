import Anthropic from '@anthropic-ai/sdk';
import { requestText } from '@arena/shared';
import type { DevRequestRow } from '@arena/shared';
import type { MessagesLike } from './aitune';

/**
 * Writes the code for a change request with the game's own Claude (the server's ANTHROPIC_API_KEY, the same one Ask Claude uses) and
 * uploads it: a branch and a pull request on GitHub (the server's GITHUB_TOKEN needs Contents and Pull requests "Read and write").
 * Nothing goes live until the owner merges the pull request, and the repository's checks run on it first.
 *
 * Two questions go to Claude: which files to read (it is shown the list of source files), then the edits themselves as exact
 * find-and-replace blocks (a block whose `find` text is not in the file exactly once is dropped, so a wrong guess can never write
 * a broken file) plus any new files. Only source and test files may be touched.
 */

export interface CodeEnv {
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  ARENA_AI_MODEL?: string;
  AI_TUNE_MODEL?: string;
}

export interface CodeEdit { path: string; find: string; replace: string }
export interface CodeFile { path: string; content: string }
export interface CodeProposal { summary: string; edits: CodeEdit[]; files: CodeFile[] }
export type CodeResult = { ok: true; prUrl: string; prNumber: number; branch: string; summary: string; files: string[] } | { ok: false; text: string };

const ALLOWED = /^(shared|server|client)\/(src|test)\/[A-Za-z0-9_./-]+\.ts$/;
const MAX_READ = 8;
const MAX_FILE_BYTES = 90_000;
const MAX_TOTAL_BYTES = 260_000;
const MAX_EDITS = 24;
const MAX_NEW_FILES = 6;

const str = { type: 'string' };
const PICK_SCHEMA = {
  type: 'object',
  properties: { files: { type: 'array', items: str, description: 'Paths of the source files to read before writing the change (at most 8), exactly as listed.' }, plan: str },
  required: ['files', 'plan'],
  additionalProperties: false,
};
const CODE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'What the change does, for the pull request, in plain words (a few sentences).' },
    edits: {
      type: 'array',
      items: { type: 'object', properties: { path: str, find: { type: 'string', description: 'Exact text of the file to replace: it must appear exactly once. Include enough surrounding lines to be unique.' }, replace: str }, required: ['path', 'find', 'replace'], additionalProperties: false },
    },
    files: { type: 'array', items: { type: 'object', properties: { path: str, content: str }, required: ['path', 'content'], additionalProperties: false }, description: 'New files only (a test for the change belongs here).' },
  },
  required: ['summary', 'edits', 'files'],
  additionalProperties: false,
};

const SYSTEM = `You write code changes for a browser arena game (TypeScript monorepo: shared/ simulation and data, server/, client/). A developer filed a change request; write the smallest correct change that does it.
Rules:
- Follow the repository's own rules (CLAUDE.md is given). Match the style and comment density of the surrounding code.
- Do NOT edit package.json, README, shared/data/patches.json, SIM_REVISION or any version: the owner does that when merging. Do not touch workflows, scripts or generated data.
- The simulation (shared/src/sim.ts) is deterministic: never use Math.random or the clock there.
- Every edit's "find" must be copied exactly from the file text you were shown and appear exactly once in it.
- Add a focused test under shared/test, server/test or client/test when the change is testable (the repository has node:test tests run with tsx).
- If the request cannot be done safely with what you can see, return no edits and say why in the summary.`;

/** Apply edits to file texts; returns the new texts and what was dropped and why. */
export function applyEdits(files: Record<string, string>, edits: CodeEdit[]): { out: Record<string, string>; dropped: string[] } {
  const out = { ...files };
  const dropped: string[] = [];
  for (const e of edits) {
    const cur = out[e.path];
    if (cur === undefined) {
      dropped.push(`${e.path}: not a file that was read`);
      continue;
    }
    if (!e.find) {
      dropped.push(`${e.path}: an empty find`);
      continue;
    }
    const at = cur.indexOf(e.find);
    if (at < 0) dropped.push(`${e.path}: the text to replace was not found`);
    else if (cur.indexOf(e.find, at + 1) >= 0) dropped.push(`${e.path}: the text to replace appears more than once`);
    else out[e.path] = cur.slice(0, at) + e.replace + cur.slice(at + e.find.length);
  }
  return { out, dropped };
}

export class CodeWriter {
  private messages: MessagesLike | null;
  private model: string;
  private busy = false;

  constructor(private env: CodeEnv & { ANTHROPIC_API_KEY?: string } = {}, messages?: MessagesLike, private http: typeof fetch = (...a) => fetch(...a)) {
    const key = env.ANTHROPIC_API_KEY?.trim();
    this.messages = messages ?? (key ? new Anthropic({ apiKey: key, timeout: 180_000, maxRetries: 1 }).beta.messages : null);
    this.model = env.ARENA_AI_MODEL?.trim() || env.AI_TUNE_MODEL?.trim() || 'claude-sonnet-5-5';
  }

  get enabled(): boolean {
    return !!this.messages && !!this.env.GITHUB_TOKEN;
  }

  private repo(): string {
    return this.env.GITHUB_REPO || 'TokeGG/mmoarena';
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await this.http(`https://api.github.com/repos/${this.repo()}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'arena-codegen', ...(init.headers ?? {}) },
    });
    const body = (await r.json().catch(() => ({}))) as unknown;
    if (!r.ok) throw new Error(`GitHub: ${String((body as { message?: unknown }).message ?? r.status)}`);
    return body as T;
  }

  private async ask(system: string, user: string, schema: object): Promise<unknown> {
    const msg = await this.messages!.create({
      model: this.model,
      max_tokens: 32_000,
      system,
      output_config: { effort: 'high', format: { type: 'json_schema', schema } },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: user }],
    } as never);
    if (msg.stop_reason === 'refusal') throw new Error('Claude declined that request.');
    if (msg.stop_reason === 'max_tokens') throw new Error('The change was too big for one go. Split the request into smaller ones.');
    return JSON.parse(msg.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
  }

  private async text(path: string, ref: string): Promise<string | null> {
    try {
      const f = await this.api<{ content?: string; encoding?: string; size?: number }>(`/contents/${path}?ref=${encodeURIComponent(ref)}`);
      if (f.encoding !== 'base64' || !f.content) return null;
      return Buffer.from(f.content, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  /** Ask Claude for the change (no GitHub writes). */
  async propose(row: DevRequestRow): Promise<{ ok: true; proposal: CodeProposal; read: Record<string, string>; dropped: string[] } | { ok: false; text: string }> {
    if (!this.messages) return { ok: false, text: 'The game has no ANTHROPIC_API_KEY, so Claude cannot write code here.' };
    if (!this.env.GITHUB_TOKEN) return { ok: false, text: 'The server has no GITHUB_TOKEN, so the code cannot be read from or uploaded to GitHub.' };
    try {
      const base = await this.api<{ default_branch: string }>('');
      const branch = base.default_branch || 'main';
      const tree = await this.api<{ tree: { path: string; type: string; size?: number }[] }>(`/git/trees/${branch}?recursive=1`);
      const listing = tree.tree.filter((t) => t.type === 'blob' && ALLOWED.test(t.path) && (t.size ?? 0) <= MAX_FILE_BYTES);
      const rules = (await this.text('CLAUDE.md', branch)) ?? '';
      const ask = requestText(row);
      const pick = (await this.ask(`${SYSTEM}\n\nRepository rules (CLAUDE.md):\n${rules.slice(0, 8000)}`, `${ask}\n\nSource files you may read (path, bytes):\n${listing.map((f) => `${f.path} ${f.size ?? 0}`).join('\n')}\n\nChoose the files you need to read.`, PICK_SCHEMA)) as { files?: string[]; plan?: string };
      const wanted = [...new Set((pick.files ?? []).filter((p) => listing.some((f) => f.path === p)))].slice(0, MAX_READ);
      const read: Record<string, string> = {};
      let total = 0;
      for (const p of wanted) {
        const t = await this.text(p, branch);
        if (t === null || total + t.length > MAX_TOTAL_BYTES) continue;
        read[p] = t;
        total += t.length;
      }
      const shown = Object.entries(read).map(([p, t]) => `=== ${p} ===\n${t}`).join('\n\n');
      const code = (await this.ask(`${SYSTEM}\n\nRepository rules (CLAUDE.md):\n${rules.slice(0, 8000)}`, `${ask}\n\nYour plan: ${pick.plan ?? ''}\n\nThe files:\n${shown}\n\nWrite the change.`, CODE_SCHEMA)) as Partial<CodeProposal>;
      const edits = (code.edits ?? []).filter((e) => e && typeof e.path === 'string' && ALLOWED.test(e.path) && !e.path.includes('..')).slice(0, MAX_EDITS);
      const files = (code.files ?? []).filter((f) => f && typeof f.path === 'string' && ALLOWED.test(f.path) && !f.path.includes('..') && typeof f.content === 'string' && f.content.length < MAX_FILE_BYTES && !(f.path in read)).slice(0, MAX_NEW_FILES);
      const applied = applyEdits(read, edits);
      const changed = Object.keys(applied.out).filter((p) => applied.out[p] !== read[p]);
      if (!changed.length && !files.length) return { ok: false, text: `Claude wrote no change: ${String(code.summary ?? 'it could not do this safely').slice(0, 400)}${applied.dropped.length ? ` (dropped: ${applied.dropped.slice(0, 3).join('; ')})` : ''}` };
      return { ok: true, proposal: { summary: String(code.summary ?? row.title).slice(0, 1500), edits, files }, read, dropped: applied.dropped };
    } catch (e) {
      return { ok: false, text: (e as Error).message || 'Claude could not write that.' };
    }
  }

  /** Write the code and upload it as a pull request (a branch of its own off main). */
  async write(row: DevRequestRow, by: string): Promise<CodeResult> {
    if (this.busy) return { ok: false, text: 'Claude is already writing code for another request. Try again in a minute.' };
    this.busy = true;
    try {
      const p = await this.propose(row);
      if (!p.ok) return p;
      const applied = applyEdits(p.read, p.proposal.edits);
      const writes: CodeFile[] = [...Object.keys(applied.out).filter((path) => applied.out[path] !== p.read[path]).map((path) => ({ path, content: applied.out[path] })), ...p.proposal.files];
      const base = await this.api<{ default_branch: string }>('');
      const main = base.default_branch || 'main';
      const head = await this.api<{ object: { sha: string } }>(`/git/ref/heads/${main}`);
      const branch = `game-code/${row.id}`;
      await this.api('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head.object.sha }) });
      for (const w of writes) {
        let sha: string | undefined;
        try {
          sha = (await this.api<{ sha: string }>(`/contents/${w.path}?ref=${encodeURIComponent(branch)}`)).sha;
        } catch {
          sha = undefined; // a new file
        }
        await this.api(`/contents/${w.path}`, { method: 'PUT', body: JSON.stringify({ message: `${row.title}: ${w.path}`.slice(0, 200), content: Buffer.from(w.content, 'utf8').toString('base64'), branch, ...(sha ? { sha } : {}) }) });
      }
      const body = [
        `Written in the game by Claude for ${by}'s change request. The repository's checks run on this pull request; read the diff before merging.`,
        `## What it does\n${p.proposal.summary}`,
        `## Files\n${writes.map((w) => `- ${w.path}`).join('\n')}`,
        p.dropped.length ? `## Left out (could not be applied exactly)\n${p.dropped.map((d) => `- ${d}`).join('\n')}` : '',
        requestText(row),
      ].filter(Boolean).join('\n\n');
      const pr = await this.api<{ html_url: string; number: number }>('/pulls', { method: 'POST', body: JSON.stringify({ title: `Game request: ${row.title}`.slice(0, 200), head: branch, base: main, body: body.slice(0, 60000) }) });
      return { ok: true, prUrl: pr.html_url, prNumber: pr.number, branch, summary: p.proposal.summary, files: writes.map((w) => w.path) };
    } catch (e) {
      return { ok: false, text: /resource not accessible|forbidden|bad credentials/i.test((e as Error).message) ? `GitHub refused: the server's GITHUB_TOKEN needs Contents and Pull requests "Read and write" on the repository. ${(e as Error).message}` : (e as Error).message };
    } finally {
      this.busy = false;
    }
  }
}
