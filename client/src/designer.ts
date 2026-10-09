import type { ChatTurn, ClassId, ClientMsg, DevRequestRow, ServerMsg } from '@arena/shared';
import { el } from './skillView';

/** One line of the thread: what the dev said, or Claude's answer. */
export interface ChatEntry { who: 'dev' | 'claude'; text: string; turn?: ChatTurn }

/** What the chat is about: one skill, or a whole class. */
export interface ChatScope { ability: string; classId?: ClassId; name: string }

export const scopeId = (s: ChatScope) => (s.classId ? `class:${s.classId}` : s.ability);

/** Change requests as a short status line for the dev and the owner. */
export const requestStatus = (r: DevRequestRow) => (r.status === 'done' ? '✅ done' : '🕓 open (the owner has it with the full details)');

/**
 * Ask Claude's chat thread and the change requests, kept for the page's session and shared by the debug panel and the
 * admin panel's Tuning tab (one thread per skill or class). Each place draws it with `renderChat`; answers arrive in `handle`.
 */
export class Designer {
  private threads = new Map<string, ChatEntry[]>();
  private drafts = new Map<string, string>();
  private waiting = new Set<string>();
  requests: DevRequestRow[] = [];
  /** The owner gets every request, a dev only their own. */
  allRequests = false;
  private listeners = new Set<() => void>();

  /** Called when the thread or the requests change (the panel draws again). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const f of this.listeners) f();
  }

  handle(m: ServerMsg): boolean {
    if (m.t === 'dev_requests') {
      this.requests = m.rows;
      this.allRequests = m.all;
      this.changed();
      return true;
    }
    if (m.t === 'dev_chat') {
      const list = this.threads.get(m.turn.scope) ?? [];
      const at = list.findIndex((e) => e.turn?.id === m.turn.id);
      if (at >= 0) list[at] = { who: 'claude', text: m.turn.text, turn: m.turn };
      else list.push({ who: 'claude', text: m.turn.text, turn: m.turn });
      this.threads.set(m.turn.scope, list.slice(-40));
      this.waiting.delete(m.turn.scope);
      this.changed();
      return true;
    }
    if (m.t === 'dev_result' && !m.ok && this.waiting.size) {
      // a refusal (not a dev, Ask Claude off): stop waiting
      this.waiting.clear();
      this.changed();
    }
    return false;
  }

  /**
   * The chat for one scope. `propose` is the admin panel's Tuning tab: the changes become proposals to commit; in a
   * match they are tried in it. The change card offers Apply/Undo and a Commit to GitHub path.
   */
  renderChat(scope: ChatScope, send: (m: ClientMsg) => void, propose: boolean): HTMLElement {
    const id = scopeId(scope);
    const box = el('div', 'devp-chat');
    const head = el('div', 'devp-row');
    head.append(el('b', '', `🤖 Ask Claude about ${scope.name}`));
    const fresh = el('button', 'mm-small', 'New thread');
    fresh.addEventListener('click', () => {
      this.threads.delete(id);
      send({ t: 'dev_ai_clear', scope: id });
      this.changed();
    });
    head.append(fresh);
    box.append(head);
    const thread = this.threads.get(id) ?? [];
    const log = el('div', 'devp-chatlog');
    if (!thread.length) log.append(el('small', 'devp-dim', `Say how you want ${scope.name} to be, in plain words. If anything is unclear I will ask before changing anything.`));
    for (const e of thread) log.append(e.who === 'dev' ? el('div', 'devp-msg dev', e.text) : this.answerCard(e.turn!, send, propose));
    if (this.waiting.has(id)) log.append(el('div', 'devp-msg claude', 'Claude is thinking…'));
    box.append(log);
    queueMicrotask(() => (log.scrollTop = log.scrollHeight));

    const input = el('textarea', 'devp-note devp-ask');
    input.placeholder = thread.some((e) => e.turn?.kind === 'questions') ? 'Answer Claude’s questions…' : 'e.g. "make the slow shorter but stronger" or "it should also leave a fire patch"';
    input.maxLength = 600;
    input.value = this.drafts.get(id) ?? '';
    input.addEventListener('input', () => this.drafts.set(id, input.value));
    const go = el('button', 'mm-small mm-go', this.waiting.has(id) ? 'Claude is thinking…' : 'Send');
    go.disabled = this.waiting.has(id);
    const post = () => {
      const text = (this.drafts.get(id) ?? '').trim();
      if (!text || this.waiting.has(id)) return;
      const list = this.threads.get(id) ?? [];
      list.push({ who: 'dev', text });
      this.threads.set(id, list.slice(-40));
      this.drafts.set(id, '');
      this.waiting.add(id);
      send({ t: 'dev_ai', ability: scope.classId ? '' : scope.ability, ...(scope.classId ? { classId: scope.classId } : {}), text, ...(propose ? { propose: true } : {}) });
      this.changed();
    };
    go.addEventListener('click', post);
    // Enter sends (Shift+Enter for a new line); typing here never casts spells
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        post();
      }
    });
    box.append(input, go);
    return box;
  }

  private answerCard(t: ChatTurn, send: (m: ClientMsg) => void, propose: boolean): HTMLElement {
    const card = el('div', `devp-msg claude ${t.kind}`);
    card.append(el('div', 'devp-msg-text', t.text));
    if (t.questions?.length) {
      const ul = el('ol', 'devp-questions');
      for (const q of t.questions) ul.append(el('li', '', q));
      card.append(ul);
    }
    if (t.changes?.length) {
      const ul = el('ul', 'devp-changes');
      for (const c of t.changes) {
        const li = el('li');
        li.append(el('span', '', c.label), el('span', 'devp-dim', ` ${c.from ?? '?'} → `), el('b', '', String(c.to)));
        ul.append(li);
      }
      card.append(ul);
      const row = el('div', 'devp-row');
      if (t.applied) {
        row.append(el('small', 'devp-ok', propose ? '✓ Added to the proposals below' : '✓ Trying it now'));
        const undo = el('button', 'mm-small', 'Undo');
        undo.addEventListener('click', () => send({ t: 'dev_ai_undo', turn: t.id }));
        row.append(undo);
        const commit = el('button', 'mm-small mm-go', '⤴ Commit to GitHub');
        commit.title = 'Commits these numbers straight to the main branch (the data files only). There is no review: the game updates on the next deploy.';
        commit.addEventListener('click', () => {
          if (!window.confirm(`Commit ${t.changes!.length} change${t.changes!.length === 1 ? '' : 's'} straight to the main branch on GitHub? There is no review and the live game updates on the next deploy.`)) return;
          if (t.proposalId) send({ t: 'admin_proposals', op: 'commit', ids: [t.proposalId] });
          else if (t.patches?.length) send({ t: 'dev_commit', patches: t.patches });
        });
        row.append(commit);
      } else {
        const apply = el('button', 'mm-small mm-go', propose ? 'Add to proposals' : 'Apply (try it)');
        apply.addEventListener('click', () => send({ t: 'dev_ai_apply', turn: t.id }));
        row.append(apply);
      }
      card.append(row);
    }
    if (t.dropped?.length) card.append(el('small', 'devp-dim', `Left out: ${t.dropped.join('; ')}`));
    if (t.request) {
      const note = el('div', 'devp-reqnote', `📋 Request saved: ${t.request.title}`);
      if (t.request.issueUrl) {
        const a = el('a', '', ' GitHub issue');
        a.href = t.request.issueUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        note.append(a);
      }
      card.append(note);
    }
    return card;
  }

  /** The dev's own requests with their status (the debug panel). */
  renderRequests(mine: boolean): HTMLElement | null {
    const rows = this.requests.slice(0, 8);
    if (!rows.length) return null;
    const box = el('div', 'devp-sec');
    box.append(el('b', '', mine ? 'Your change requests' : 'Change requests'));
    for (const r of rows) {
      const line = el('div', 'devp-commit');
      line.append(el('span', r.status === 'done' ? 'devp-ok' : 'devp-dim', requestStatus(r)), el('span', '', ` ${r.title}`));
      line.title = r.proposed;
      box.append(line);
    }
    return box;
  }
}

/** The one thread and request list of this page. */
export const designer = new Designer();
