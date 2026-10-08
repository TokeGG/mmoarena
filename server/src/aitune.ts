import Anthropic from '@anthropic-ai/sdk';
import { ABILITIES, mergePatches, skillInfo, validPatch } from '@arena/shared';
import type { DataPatch } from '@arena/shared';

export interface AiTuneEnv {
  /** Anthropic API key (console.anthropic.com): turns on the dev panel's "Ask Claude" box. */
  ANTHROPIC_API_KEY?: string;
  /** Model for it, by default claude-opus-5-5. */
  AI_TUNE_MODEL?: string;
}

export interface AiTuneResult {
  ok: boolean;
  /** What Claude changed and why, or why nothing changed. */
  text: string;
  patches: DataPatch[];
}

/** The part of the SDK client this uses (a stand-in in tests). */
export interface MessagesLike {
  create(params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.Messages.BetaMessage>;
}

/** One number Claude may change, by its index in the list it was shown. */
export interface OfferedField { file: DataPatch['file']; id: string; path: (string | number)[]; label: string; value: number }

const MAX_CHANGES = 12;

/** Claude's answer: which offered numbers to change, and a line for the dev (structured output, always valid JSON). */
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { field: { type: 'integer', description: 'Index of the number in "fields".' }, value: { type: 'number' } },
        required: ['field', 'value'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string', description: 'One or two short sentences for the developer: what changed (old -> new) and why.' },
  },
  required: ['changes', 'summary'],
  additionalProperties: false,
};

const SYSTEM = [
  'You tune skills for a fast WoW-style arena game. A developer is testing a skill in a live match and asks for a change in plain words; your numbers go live in their match the moment you answer.',
  'You get the skill, the buffs and debuffs tied to it, what changes it, and "fields": every number you may change, each with an index, a label and its current value.',
  'Change as few numbers as the request needs, by their index. Times are in milliseconds; percentages and multipliers stay in the units the field already uses. Keep values sane for a game where players have a few thousand health.',
  'If the request cannot be done with these numbers, return no changes and say in the summary what would be needed.',
].join('\n');

/**
 * The dev panel's "Ask Claude" box: a dev describes a change to a skill in plain words ("make the slow shorter but
 * stronger"), Claude picks numbers among the skill's tunable fields, and only valid number changes come back (the
 * lobby tries them in the dev's match at once). Claude only ever sees the skill's data and the dev's words, and can
 * only change numbers that already exist.
 */
export class AiTune {
  private messages: MessagesLike | null;
  private model: string;
  /** Requests per account in the last hour, to keep the bill sane. */
  private used = new Map<string, number[]>();

  constructor(env: AiTuneEnv = {}, messages?: MessagesLike) {
    const key = env.ANTHROPIC_API_KEY?.trim();
    this.messages = messages ?? (key ? new Anthropic({ apiKey: key, timeout: 60_000, maxRetries: 1 }).beta.messages : null);
    this.model = env.AI_TUNE_MODEL?.trim() || 'claude-opus-5-5';
  }

  get enabled(): boolean {
    return !!this.messages;
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
    if (!this.messages) return { ok: false, text: 'Ask Claude is off: the server has no ANTHROPIC_API_KEY.', patches: [] };
    if (!def) return { ok: false, text: 'Pick a skill first.', patches: [] };
    if (!this.allow(who)) return { ok: false, text: 'Slow down a little: one request every few seconds, 30 an hour.', patches: [] };
    const info = skillInfo(abilityId);
    const now = new Map(testing.map((p) => [`${p.file}:${p.id}:${p.path.join('.')}`, p.value]));
    const fields: OfferedField[] = info.sections.flatMap((s) =>
      s.fields.map((f) => ({ file: f.file, id: f.id, path: f.path, label: `${s.name} · ${f.label}`, value: now.get(`${f.file}:${f.id}:${f.path.join('.')}`) ?? f.value })),
    );
    const context = {
      skill: def.name,
      sections: info.sections.map((s) => ({ name: s.name, kind: s.kind, link: s.link, from: s.from, does: s.does })),
      alsoChangedBy: info.modifiers.map((m) => `${m.name} (${m.where}): ${m.text}`),
      fields: fields.map((f, i) => ({ index: i, label: f.label, value: f.value })),
    };
    let msg: Anthropic.Beta.Messages.BetaMessage;
    try {
      msg = await this.messages.create({
        model: this.model,
        max_tokens: 16000,
        system: SYSTEM,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
        // a safety decline is retried on Anthropic's recommended fallback model
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [{ role: 'user', content: `Skill data:\n${JSON.stringify(context)}\n\nRequest: ${request.slice(0, 600)}` }],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return { ok: false, text: 'Claude refused the API key: check ANTHROPIC_API_KEY on the server.', patches: [] };
      if (e instanceof Anthropic.RateLimitError) return { ok: false, text: 'Claude is busy (rate limited). Try again in a moment.', patches: [] };
      if (e instanceof Anthropic.APIError) return { ok: false, text: `Claude could not answer: ${e.message}`, patches: [] };
      return { ok: false, text: 'Could not reach Claude.', patches: [] };
    }
    if (msg.stop_reason === 'refusal') return { ok: false, text: 'Claude declined that request.', patches: [] };
    const raw = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return parseAnswer(raw, fields);
  }
}

/** Claude's answer as patches: only numbers it was offered, each valid; anything else is dropped. */
export function parseAnswer(raw: string, offered: OfferedField[]): AiTuneResult {
  let v: { changes?: unknown; summary?: unknown };
  try {
    v = JSON.parse(raw) as typeof v;
  } catch {
    return { ok: false, text: 'Claude answered in a way the game could not read. Try saying it differently.', patches: [] };
  }
  const patches: DataPatch[] = [];
  for (const c of Array.isArray(v.changes) ? v.changes.slice(0, MAX_CHANGES) : []) {
    const { field, value } = (c ?? {}) as { field?: unknown; value?: unknown };
    const f = typeof field === 'number' ? offered[field] : undefined;
    if (!f || typeof value !== 'number') continue;
    const patch: DataPatch = { file: f.file, id: f.id, path: f.path, value: Math.round(value * 1000) / 1000 };
    if (validPatch(patch)) patches.push(patch);
  }
  const summary = typeof v.summary === 'string' ? v.summary.slice(0, 600) : '';
  if (!patches.length) return { ok: false, text: summary || 'Claude did not change any numbers.', patches: [] };
  return { ok: true, text: summary || `Claude changed ${patches.length} number${patches.length === 1 ? '' : 's'}.`, patches: mergePatches([], patches) };
}
