import { NAME_RE, resolveCosmetics } from '@arena/shared';
import type { ClientMsg, FriendRow, FriendStatus, PartyInfo, ServerMsg } from '@arena/shared';
import { applyName } from './nameStyle';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

interface Hooks {
  send(m: ClientMsg): void;
  signedIn(): boolean;
  /** The sign-in window, for guests who press Friends. */
  needSignIn(): void;
  /** Your party changed (null: you left or it ended). */
  onParty?(p: PartyInfo | null): void;
}

const STATUS_TEXT: Record<FriendStatus, string> = { offline: 'Offline', menu: 'In menu', queue: 'In queue', match: 'In a match', party: 'In a party' };

/** Friends list, party panel and the invite/notice toasts. */
export class FriendsUi {
  readonly button = el('button', 'acct-chip fr-btn', '👥 Friends');
  private badge = el('span', 'fr-badge hidden');
  private modal: HTMLElement | null = null;
  private friends: FriendRow[] = [];
  private requests: string[] = [];
  private party: PartyInfo | null = null;
  private toasts = el('div', 'fr-toasts');
  private me = '';
  private addError = '';

  constructor(private hooks: Hooks) {
    this.button.append(this.badge);
    this.button.addEventListener('click', () => (hooks.signedIn() ? this.open() : hooks.needSignIn()));
    document.body.append(this.toasts);
  }

  setAccount(name: string | null) {
    this.me = name ?? '';
    if (!name) {
      this.friends = [];
      this.requests = [];
      this.party = null;
      this.hooks.onParty?.(null);
      this.close();
    }
    this.paintBadge();
  }

  get inParty(): boolean {
    return !!this.party;
  }

  handle(m: ServerMsg): boolean {
    switch (m.t) {
      case 'friends':
        this.friends = m.friends;
        this.requests = m.requests;
        this.paintBadge();
        if (this.modal) this.render();
        return true;
      case 'party':
        this.party = m.party;
        this.hooks.onParty?.(m.party);
        if (this.modal) this.render();
        return true;
      case 'invite':
        this.inviteToast(m.id, m.kind, m.from);
        return true;
      case 'invite_gone':
        this.toasts.querySelector(`[data-invite="${m.id}"]`)?.remove();
        return true;
      case 'notice':
        this.toast(m.text);
        return true;
    }
    return false;
  }

  private paintBadge() {
    const n = this.requests.length;
    this.badge.textContent = String(n);
    this.badge.classList.toggle('hidden', n === 0);
  }

  // ------------------------------------------------------------------ toasts

  toast(text: string, ms = 4500): HTMLElement {
    const t = el('div', 'fr-toast', text);
    this.toasts.append(t);
    window.setTimeout(() => t.remove(), ms);
    return t;
  }

  private inviteToast(id: string, kind: 'party' | 'duel', from: string) {
    const t = el('div', 'fr-toast inv');
    t.dataset.invite = id;
    t.append(el('span', '', kind === 'party' ? `${from} invites you to a party` : `${from} challenges you to a 1v1 duel`));
    const yes = el('button', 'mm-small', 'Accept');
    const no = el('button', 'mm-small', 'Decline');
    yes.addEventListener('click', () => {
      this.hooks.send({ t: 'invite_reply', id, accept: true });
      t.remove();
    });
    no.addEventListener('click', () => {
      this.hooks.send({ t: 'invite_reply', id, accept: false });
      t.remove();
    });
    t.append(yes, no);
    this.toasts.append(t);
    window.setTimeout(() => t.remove(), 60000);
  }

  // ------------------------------------------------------------------ panel

  open() {
    this.close();
    const modal = el('div', 'mm-modal');
    modal.addEventListener('mousedown', (e) => e.target === modal && this.close());
    document.body.append(modal);
    this.modal = modal;
    this.hooks.send({ t: 'friends' });
    this.render();
  }

  close() {
    this.modal?.remove();
    this.modal = null;
    this.addError = '';
  }

  private render() {
    const m = this.modal;
    if (!m) return;
    const keep = document.activeElement instanceof HTMLInputElement ? { v: document.activeElement.value, on: true } : null;
    const card = el('div', 'mm-modal-card fr-card');
    const head = el('div', 'mm-modal-head');
    head.append(el('h2', '', 'Friends'));
    const x = el('button', 'mm-small', 'Close');
    x.addEventListener('click', () => this.close());
    head.append(x);
    card.append(head);

    if (this.party) card.append(this.partyBox(this.party));

    const add = el('div', 'own-row');
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'Add a friend by name';
    input.maxLength = 16;
    input.dataset.f = 'addfriend';
    if (keep?.on) input.value = keep.v;
    const go = el('button', 'mm-small', 'Add');
    const submit = () => {
      const name = input.value.trim();
      if (!NAME_RE.test(name)) {
        this.addError = 'Names are 3-16 letters, numbers or underscores.';
        return this.render();
      }
      this.addError = '';
      this.hooks.send({ t: 'friend', op: 'add', name });
      input.value = '';
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    add.append(input, go);
    card.append(el('h3', '', 'Add a friend'), add);
    if (this.addError) card.append(el('div', 'auth-err', this.addError));

    if (this.requests.length) {
      card.append(el('h3', '', `Requests (${this.requests.length})`));
      for (const name of this.requests) {
        const row = el('div', 'fr-row');
        row.append(el('b', '', name));
        const yes = el('button', 'mm-small', 'Accept');
        yes.addEventListener('click', () => this.hooks.send({ t: 'friend', op: 'accept', name }));
        const no = el('button', 'mm-small', 'Decline');
        no.addEventListener('click', () => this.hooks.send({ t: 'friend', op: 'decline', name }));
        row.append(yes, no);
        card.append(row);
      }
    }

    card.append(el('h3', '', `Friends (${this.friends.length})`));
    if (!this.friends.length) card.append(el('p', 'mm-modal-foot', 'No friends yet. Add someone by name, they get a request to accept.'));
    const list = el('div', 'fr-list');
    for (const f of this.friends) list.append(this.friendRow(f));
    card.append(list);
    m.replaceChildren(card);
    if (keep?.on) (m.querySelector('[data-f="addfriend"]') as HTMLElement | null)?.focus();
  }

  private friendRow(f: FriendRow): HTMLElement {
    const row = el('div', 'fr-row');
    row.append(el('span', `fr-dot ${f.status}`));
    const nm = el('b', '', f.name);
    if (f.cosmetics) applyName(nm, resolveCosmetics(f.cosmetics));
    const info = el('div', 'fr-info');
    info.append(nm, el('small', '', f.status === 'offline' ? 'Offline' : `${STATUS_TEXT[f.status]}${f.rating ? ` · ${f.rating}` : ''}`));
    row.append(info);
    const free = f.status === 'menu';
    const isLeader = !this.party || this.party.leader === this.me;
    const party = el('button', 'mm-small', 'Party');
    party.title = 'Invite to your party: queue together on one team';
    party.disabled = !free || !isLeader;
    party.addEventListener('click', () => this.hooks.send({ t: 'invite', kind: 'party', name: f.name }));
    const duel = el('button', 'mm-small', 'Duel');
    duel.title = 'Challenge to an unranked 1v1';
    duel.disabled = !free || !!this.party;
    duel.addEventListener('click', () => this.hooks.send({ t: 'invite', kind: 'duel', name: f.name }));
    const rm = el('button', 'mm-small', '✕');
    rm.title = 'Remove friend';
    rm.addEventListener('click', () => {
      if (confirm(`Remove ${f.name} from your friends?`)) this.hooks.send({ t: 'friend', op: 'remove', name: f.name });
    });
    row.append(party, duel, rm);
    return row;
  }

  private partyBox(p: PartyInfo): HTMLElement {
    const box = el('div', 'fr-party');
    box.append(el('h3', '', `Your party (${p.members.length}/3)`));
    for (const mem of p.members) {
      const row = el('div', 'fr-row');
      row.append(el('span', `fr-dot ${mem.ready ? 'menu' : 'party'}`), el('b', '', `${mem.name === p.leader ? '👑 ' : ''}${mem.name}`), el('small', '', mem.ready ? 'ready' : ''));
      if (p.leader === this.me && mem.name !== this.me) {
        const kick = el('button', 'mm-small', 'Remove');
        kick.addEventListener('click', () => this.hooks.send({ t: 'party_kick', name: mem.name }));
        row.append(kick);
      }
      box.append(row);
    }
    box.append(el('p', 'mm-modal-foot', 'The leader picks the mode and arena; everyone else presses Ready in the lobby. Parties play on the same team, in practice too.'));
    const leave = el('button', 'mm-small', 'Leave party');
    leave.addEventListener('click', () => this.hooks.send({ t: 'party_leave' }));
    box.append(leave);
    return box;
  }
}
