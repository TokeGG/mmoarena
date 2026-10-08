import { ABILITIES, mergePatches, skillInfo, validPatch } from '@arena/shared';
import type { DataPatch } from '@arena/shared';

export interface AiTuneEnv {
  /** Anthropic API key: turns on the dev panel's "Ask Claude" box. */
  ANTHROPIC_API_KEY?: string;
  /** Model for it, by default claude-sonnet-5-5. */
  AI_TUNE_MODEL?: string;
}

export interface AiTuneResult {
  ok: boolean;
  /** What Claude changed and why, or why nothing changed. */
  text: string;
  patches: DataPatch[];
}

const MAX_CHANGES = 12;

/**
 * The dev panel's "Ask Claude" box: a dev describes a change to a skill in plain words ("make the slow shorter but
 * stronger"), Claude picks numbers among the skill's tunable fields, and only valid number changes come back (the
 * lobby tries them in the dev's match at once). Claude only ever sees the skill's data and the dev's words, and can
 * only change numbers that already exist.
 */
export class AiTune {
  private key: string | null;
  private model: string;
  /** Requests per account in the last hour, to keep the bill sane. */
  private used = new Map<string, number[]>();

  constructor(env: AiTuneEnv = {}, private http: typeof fetch = (...a) => fetch(...a)) {
    this.key = env.ANTHROPIC_API_KEY?.trim() || null;
    this.model = env.AI_TUNE_MODEL?.trim() || 'claude-sonnet-5-5';
  }

  get enabled(): boolean {
    return !!this.key;
  }

  /** Room for one more request from `who` (at most 30 an hour and one every 4 seconds). */
  private allow(who: string): boolean {
    const now = Date.now();
    const list = (this.used.get(who) ?? []).filter((t) => now - t < 3_600_000);
    if (list.length >= 30 || (list.length && now - list[list.length - 1] < 4000)) return false;
    list.push(now);
    this.used.set(who, list);
    return true;
  }

  async suggest(who: string, abilityId: string, request: string, testing: DataPatch[]): Promise<AiTuneResult> {
    const def = ABILITIES[abilityId];
    if (!this.key) return { ok: false, text: 'Ask Claude is off: the server has no ANTHROPIC_API_KEY.', patches: [] };
    if (!def) return { ok: false, text: 'Pick a skill first.', patches: [] };
    if (!this.allow(who)) return { ok: false, text: 'Slow down a little: one request every few seconds, 30 an hour.', patches: [] };
    const info = skillInfo(abilityId);
    const now = new Map(testing.map((p) => [`${p.file}:${p.id}:${p.path.join('.')}`, p.value]));
    const fields = info.sections.flatMap((s) =>
      s.fields.map((f) => ({ file: f.file, id: f.id, path: f.path, label: `${s.name} · ${f.label}`, value: now.get(`${f.file}:${f.id}:${f.path.join('.')}`) ?? f.value })),
    );
    const context = {
      skill: def.name,
      sections: info.sections.map((s) => ({ name: s.name, kind: s.kind, link: s.link, does: s.does })),
      alsoChangedBy: info.modifiers.map((m) => `${m.name}: ${m.text}`),
      fields,
    };
    const system = [
      'You tune skills for a fast WoW-style arena game. A developer is testing a skill in a live match and asks for a change in plain words.',
      'Answer ONLY with a JSON object: {"changes":[{"file":"abilities"|"auras","id":string,"path":[...],"value":number}],"summary":string}.',
      'Only use file/id/path triples that appear in "fields" (copy them exactly). Change as few numbers as the request needs.',
      'Times are in milliseconds, percentages as the field already uses them. Keep values sane for a game where players have a few thousand health.',
      'The summary is one or two short sentences for the developer: what you changed (old → new) and why. If the request cannot be done with these numbers, return no changes and say what would be needed.',
    ].join('\n');
    let raw: string;
    try {
      const r = await this.http('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': this.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1200,
          system,
          messages: [{ role: 'user', content: `Skill data:\n${JSON.stringify(context)}\n\nRequest: ${request.slice(0, 600)}` }],
        }),
      });
      const body = (await r.json().catch(() => ({}))) as { content?: { type: string; text?: string }[]; error?: { message?: string } };
      if (!r.ok) return { ok: false, text: `Claude could not answer: ${body.error?.message ?? r.status}`, patches: [] };
      raw = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    } catch {
      return { ok: false, text: 'Could not reach Claude.', patches: [] };
    }
    return parseAnswer(raw, fields);
  }
}

/** Claude's answer as patches: only numbers it was offered, each valid; anything else is dropped. */
export function parseAnswer(raw: string, offered: { file: string; id: string; path: (string | number)[] }[]): AiTuneResult {
  const json = /\{[\s\S]*\}/.exec(raw)?.[0];
  let v: { changes?: unknown; summary?: unknown };
  try {
    v = JSON.parse(json ?? '') as typeof v;
  } catch {
    return { ok: false, text: 'Claude answered in a way the game could not read. Try saying it differently.', patches: [] };
  }
  const allowed = new Set(offered.map((f) => `${f.file}:${f.id}:${f.path.join('.')}`));
  const patches: DataPatch[] = [];
  for (const c of Array.isArray(v.changes) ? v.changes.slice(0, MAX_CHANGES) : []) {
    const p = c as DataPatch;
    if (!p || !Array.isArray(p.path) || typeof p.value !== 'number') continue;
    const k = `${p.file}:${p.id}:${p.path.join('.')}`;
    const patch: DataPatch = { file: p.file, id: p.id, path: p.path, value: Math.round(p.value * 1000) / 1000 };
    if (allowed.has(k) && validPatch(patch)) patches.push(patch);
  }
  const summary = typeof v.summary === 'string' ? v.summary.slice(0, 600) : '';
  if (!patches.length) return { ok: false, text: summary || 'Claude did not change any numbers.', patches: [] };
  return { ok: true, text: summary || `Claude changed ${patches.length} number${patches.length === 1 ? '' : 's'}.`, patches: mergePatches([], patches) };
}
