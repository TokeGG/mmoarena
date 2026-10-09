import { BOT_NOTE_MAX } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';

/**
 * "Note for the bots": a text box for the owner and devs (the server refuses anyone else) under a match that had bots: the
 * end-of-match card, the dev panel's Match tools while it is live, and the admin Replays rows. What is written goes to the bot
 * learner with the match id (server/src/botlearn.ts), which turns plain phrases into brain numbers.
 */

const CSS = `
.botnote { margin:8px 0 2px; padding:8px 10px; border:1px solid #6b4fb0; border-radius:6px; background:rgba(36,26,61,.55); color:#eadcff; font:13px/1.35 system-ui; text-align:left; }
.botnote b { display:block; margin-bottom:3px; }
.botnote textarea { width:100%; box-sizing:border-box; min-height:58px; resize:vertical; background:#12101c; color:#fff; border:1px solid #5a4a8a; border-radius:4px; padding:5px 7px; font:13px/1.35 system-ui; }
.botnote .bn-row { display:flex; gap:8px; align-items:center; margin-top:4px; flex-wrap:wrap; }
.botnote .bn-row small { opacity:.75; }
.botnote .bn-out { margin-top:5px; font-size:12px; }
.botnote .bn-out.ok { color:#b9f5c4; } .botnote .bn-out.bad { color:#ffb3a8; }
.botnote .bn-out div { margin-top:2px; }
`;
let styled = false;
function ensureStyles(): void {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const s = document.createElement('style');
  s.id = 'bot-note-styles';
  s.textContent = CSS;
  document.head.append(s);
}

type Ack = Extract<ServerMsg, { t: 'bot_note_ack' }>;
/** What was typed and not sent yet, and the last answer, per match: a redraw of the card or the admin panel keeps both. */
const drafts = new Map<string, string>();
const answers = new Map<string, Ack | 'sending'>();
const live = new Set<() => void>();

/** The server answered a note: show it in every box for that match. */
export function handleNoteAck(m: Ack): void {
  answers.set(m.id, m);
  if (m.ok) drafts.delete(m.id);
  for (const repaint of live) repaint();
}

/** The lines under the box for an answer: what it moved first, then what could not be placed. */
export function ackLines(a: Ack): string[] {
  if (!a.ok) return [a.text];
  const lines = a.lines?.length ? a.lines.slice(0, 1) : [a.text];
  if (a.unmapped?.length) lines.push(`Could not place: ${a.unmapped.map((u) => `"${u}"`).join(', ')}. Try other words, e.g. "didn't los enough", "ran out of mana", "kicked too early".`);
  if (a.bug) lines.push('The bug part is in the owner\'s "Bot bugs reported" list.');
  return lines;
}

/** The note box for a match. `liveNote`: the match is still running (the note is stamped with the time in the fight). */
export function noteBox(matchId: string, send: (m: ClientMsg) => void, o: { liveNote?: boolean; title?: string } = {}): HTMLElement {
  ensureStyles();
  const root = document.createElement('div');
  root.className = 'botnote';
  root.dataset.noteFor = matchId;
  const head = document.createElement('b');
  head.textContent = o.title ?? 'Note for the bots';
  const ta = document.createElement('textarea');
  ta.maxLength = BOT_NOTE_MAX;
  ta.rows = 3;
  ta.placeholder = 'Say what went wrong, in plain words. e.g. "didn\'t los enough and ran out of mana". Tag a class: "mage: kicked too early". Bugs ("got stuck") go to the owner\'s list.';
  ta.value = drafts.get(matchId) ?? '';
  const row = document.createElement('div');
  row.className = 'bn-row';
  const btn = document.createElement('button');
  btn.className = 'mm-small mm-go';
  btn.textContent = 'Send to the bot brain';
  const count = document.createElement('small');
  const out = document.createElement('div');
  out.className = 'bn-out';
  const paintCount = () => {
    count.textContent = `${ta.value.length}/${BOT_NOTE_MAX}`;
    btn.disabled = !ta.value.trim() || answers.get(matchId) === 'sending';
  };
  const paintAnswer = () => {
    const a = answers.get(matchId);
    out.replaceChildren();
    out.className = `bn-out${a && a !== 'sending' ? (a.ok ? ' ok' : ' bad') : ''}`;
    if (a === 'sending') out.textContent = 'Sending…';
    else if (a) for (const l of ackLines(a)) {
      const d = document.createElement('div');
      d.textContent = l;
      out.append(d);
    }
    if (a && a !== 'sending' && a.ok && !drafts.has(matchId)) ta.value = '';
    paintCount();
  };
  ta.addEventListener('input', () => {
    drafts.set(matchId, ta.value);
    paintCount();
  });
  btn.addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text) return;
    answers.set(matchId, 'sending');
    send({ t: 'bot_note', id: matchId, text, ...(o.liveNote ? { live: true } : {}) });
    paintAnswer();
  });
  row.append(btn, count);
  root.append(head, ta, row, out);
  paintAnswer();
  const repaint = () => (root.isConnected ? paintAnswer() : live.delete(repaint));
  live.add(repaint);
  return root;
}
