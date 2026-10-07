import { NOTE_MAX } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

interface Hooks {
  send(m: ClientMsg): void;
  isOwner(): boolean;
}

/** The suggestion box: anyone can send an idea; the owner also reads what has come in. */
export class SuggestUi {
  readonly button = el('button', 'acct-chip', '💡 Suggest');
  private modal: HTMLElement | null = null;
  private status = el('div', 'fr-status');
  private list = el('div', 'fr-list');
  private rows: { at: number; name: string; text: string; note?: string }[] | null = null;
  private note = '';

  constructor(private hooks: Hooks) {
    this.button.title = 'Send an idea for the game';
    this.button.addEventListener('click', () => this.open());
  }

  handle(m: ServerMsg): void {
    if (m.t === 'suggest_ack') {
      this.status.textContent = m.ok ? 'Thanks! Your suggestion was sent.' : m.reason ?? 'Could not send.';
      this.status.style.color = m.ok ? '#4ade80' : '#f87171';
      if (m.ok && this.hooks.isOwner()) this.hooks.send({ t: 'suggestions' });
    } else if (m.t === 'suggestions') {
      this.rows = m.rows;
      this.paintList();
    }
  }

  private paintList(): void {
    this.list.replaceChildren();
    if (!this.hooks.isOwner()) return;
    if (!this.rows) return void this.list.append(el('small', '', 'Loading…'));
    if (!this.rows.length) return void this.list.append(el('small', '', 'No suggestions yet.'));
    for (const r of this.rows) {
      const row = el('div', 'fr-row');
      const info = el('div', 'fr-info');
      info.append(el('b', '', r.name), el('span', '', r.text), el('small', '', new Date(r.at).toLocaleString()));
      if (r.note) {
        const d = el('details');
        d.append(el('summary', '', `📎 Attached note (${r.note.length} characters)`));
        const pre = el('pre', '', r.note);
        pre.style.cssText = 'white-space:pre-wrap;max-height:240px;overflow:auto;margin:6px 0 0;padding:8px;background:#0b0e14;border-radius:6px;font:12px/1.4 monospace;';
        d.append(pre);
        info.append(d);
      }
      const del = el('button', 'mm-small', 'Delete');
      del.addEventListener('click', () => {
        this.rows = this.rows!.filter((x) => x !== r); // gone at once; the server confirms with the fresh list
        this.paintList();
        this.hooks.send({ t: 'suggest_delete', at: r.at, text: r.text });
      });
      row.append(info, del);
      this.list.append(row);
    }
  }

  private open(): void {
    if (this.modal) return;
    const modal = el('div', 'mm-modal');
    modal.addEventListener('mousedown', (e) => e.target === modal && this.close());
    const card = el('div', 'mm-modal-card fr-card');
    const head = el('div', 'mm-modal-head');
    head.append(el('h2', '', 'Suggestion box'));
    const x = el('button', 'mm-small', 'Close');
    x.addEventListener('click', () => this.close());
    head.append(x);
    const ta = el('textarea');
    ta.maxLength = 600;
    ta.rows = 5;
    ta.placeholder = 'An ability, a balance change, a bug, anything you want to see…';
    ta.style.cssText = 'width:100%;box-sizing:border-box;background:#10131a;border:1px solid #333b4d;color:#e6e9ef;border-radius:6px;padding:8px;font:14px system-ui;resize:vertical;';
    ta.addEventListener('keydown', (e) => e.stopPropagation()); // typing must not trigger game keybinds
    const count = el('small', '', '0/600');
    // a notepad file for more room than the box allows
    const file = el('input');
    file.type = 'file';
    file.accept = '.txt,text/plain';
    file.style.display = 'none';
    const attach = el('button', 'mm-small', '📎 Attach a note (.txt)');
    const attached = el('small', '');
    const clear = el('button', 'mm-small hidden', 'Remove');
    const showNote = () => {
      attached.textContent = this.note ? `${this.note.length} characters attached` : '';
      clear.classList.toggle('hidden', !this.note);
    };
    attach.addEventListener('click', () => file.click());
    clear.addEventListener('click', () => { this.note = ''; file.value = ''; showNote(); });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      if (f.size > 200_000) {
        this.status.textContent = 'That file is too big: keep it under about 10,000 characters.';
        this.status.style.color = '#f87171';
        return;
      }
      const text = (await f.text()).trim();
      this.note = text.slice(0, NOTE_MAX);
      this.status.textContent = text.length > NOTE_MAX ? `Only the first ${NOTE_MAX.toLocaleString()} characters will be sent.` : '';
      this.status.style.color = '';
      showNote();
    });
    ta.addEventListener('input', () => (count.textContent = `${ta.value.length}/600`));
    const send = el('button', 'mm-small', 'Send');
    send.addEventListener('click', () => {
      const text = ta.value.trim();
      if (text.length < 5) {
        this.status.textContent = 'Write a bit more (at least 5 characters).';
        this.status.style.color = '#f87171';
        return;
      }
      this.status.textContent = 'Sending…';
      this.status.style.color = '';
      this.hooks.send({ t: 'suggest', text, ...(this.note ? { note: this.note } : {}) });
      this.note = '';
      file.value = '';
      showNote();
      ta.value = '';
      count.textContent = '0/600';
    });
    const row = el('div', 'own-row');
    row.append(send, count);
    const attachRow = el('div', 'own-row');
    attachRow.append(attach, attached, clear, file);
    card.append(head, ta, attachRow, row, this.status);
    if (this.hooks.isOwner()) {
      card.append(el('h3', '', 'Received'), this.list);
      this.rows = null;
      this.paintList();
      this.hooks.send({ t: 'suggestions' });
    }
    modal.append(card);
    document.body.append(modal);
    this.modal = modal;
    ta.focus();
  }

  private close(): void {
    this.modal?.remove();
    this.modal = null;
    this.note = '';
    this.status.textContent = '';
  }
}
