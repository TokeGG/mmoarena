import type { Popup } from './popups';
import { NAME_RE, resolveCosmetics, PARTY_MAX } from '@arena/shared';
import type { ClientMsg, FriendRow, PartyInfo, ServerMsg } from '@arena/shared';
import { applyName, avatarImg, avatarUrl } from './nameStyle';
import { GROUP_TITLES, groupFriends, onlineCount, statusLine } from './friendsState';

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
  /** Owner: follow a friend into every match they join. */
  follow?: { isOwner(): boolean; current(): string | null; set(name: string | null): void };
}


/** Friends list, party panel and the invite/notice toasts. */
export class FriendsUi {
  readonly button = el('button', 'acct-chip fr-btn', '👥 Friends');
  /** Open the friends window (guests get the sign-in window instead). */
  openOrSignIn() {
    if (this.hooks.signedIn()) this.open();
    else this.hooks.needSignIn();
  }
  /** Corner marks on the Friends icon: red = requests and invites waiting, green = friends online. */
  readonly badge = el('span', 'fr-badges');
  private pending = el('span', 'fr-badge hidden');
  private online = el('span', 'fr-online hidden');
  private filter = '';
  private offlineOpen = false;
  private modal: HTMLElement | null = null;
  readonly popup: Popup = { isOpen: () => !!this.modal, close: () => this.close(), el: () => this.modal };
  private friends: FriendRow[] = [];
  private requests: string[] = [];
  private party: PartyInfo | null = null;
  private toasts = el('div', 'fr-toasts');
  /** Invites arrive as big banners at the top of the screen, impossible to miss. */
  private banners = el('div', 'fr-invites');
  private invites = 0;
  readonly partyChip = el('button', 'acct-chip party-chip hidden');
  private baseTitle = document.title;
  private me = '';
  private addError = '';

  constructor(private hooks: Hooks) {
    this.badge.append(this.pending, this.online);
    this.button.append(this.badge);
    this.partyChip.addEventListener('click', () => this.open());
    this.button.addEventListener('click', () => (hooks.signedIn() ? this.open() : hooks.needSignIn()));
    document.body.append(this.toasts, this.banners);
  }

  setAccount(name: string | null) {
    this.me = name ?? '';
    if (!name) {
      this.friends = [];
      this.requests = [];
      this.party = null;
      this.hooks.onParty?.(null);
      this.paintParty();
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
        this.paintParty();
        if (this.modal) this.render();
        return true;
      case 'invite':
        this.inviteToast(m.id, m.kind, m.from);
        return true;
      case 'invite_gone':
        this.banners.querySelector(`[data-invite="${m.id}"]`)?.remove();
        this.paintBadge();
        return true;
      case 'notice':
        this.toast(m.text);
        return true;
    }
    return false;
  }

  private paintBadge() {
    this.invites = this.banners.querySelectorAll('[data-invite]').length;
    const n = this.requests.length + this.invites;
    this.pending.textContent = String(n);
    this.pending.classList.toggle('hidden', n === 0);
    const on = onlineCount(this.friends);
    this.online.textContent = String(on);
    this.online.classList.toggle('hidden', on === 0);
    this.badge.parentElement?.setAttribute('title', `Friends and party${on ? ` · ${on} online` : ''}${n ? ` · ${n} waiting` : ''}`);
    this.button.classList.toggle('pulse', n > 0);
    document.title = this.invites ? `(${this.invites}) Invite! · ${this.baseTitle}` : this.baseTitle;
  }

  /** A chip that is always on the menu while you are in a party: who is in it, and a click opens the panel. */
  private paintParty() {
    const p = this.party;
    this.partyChip.classList.toggle('hidden', !p);
    if (!p) return;
    this.partyChip.textContent = `👥 Party ${p.members.length}/${PARTY_MAX} · ${p.members.map((x) => (x.name === p.leader ? '👑' : '') + x.name).join(', ')}`;
    this.partyChip.title = 'Open your party';
  }

  // ------------------------------------------------------------------ toasts

  toast(text: string, ms = 4500): HTMLElement {
    const t = el('div', 'fr-toast', text);
    this.toasts.append(t);
    window.setTimeout(() => t.remove(), ms);
    return t;
  }

  private inviteToast(id: string, kind: 'party' | 'duel', from: string) {
    const t = el('div', `fr-invite ${kind}`);
    t.dataset.invite = id;
    const text = el('div', 'fr-invite-text');
    text.append(el('b', '', kind === 'party' ? '👥 Party invite' : '⚔️ Duel challenge'), el('span', '', kind === 'party' ? `${from} wants you in their party` : `${from} challenges you to a 1v1 duel`));
    const yes = el('button', 'fr-yes', 'Accept');
    const no = el('button', 'fr-no', 'Decline');
    const done = (accept: boolean) => {
      this.hooks.send({ t: 'invite_reply', id, accept });
      t.remove();
      this.paintBadge();
    };
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    const bar = el('div', 'fr-invite-bar');
    t.append(text, yes, no, bar);
    this.banners.append(t);
    this.paintBadge();
    window.setTimeout(() => {
      t.remove();
      this.paintBadge();
    }, 60000);
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
    const ae = document.activeElement;
    const keep = ae instanceof HTMLInputElement && ae.dataset.f ? { v: ae.value, on: true, f: ae.dataset.f } : null;
    const card = el('div', 'mm-modal-card fr-card');
    const head = el('div', 'mm-modal-head');
    head.append(el('h2', '', 'Friends'));
    const x = el('button', 'mm-small', 'Close');
    x.addEventListener('click', () => this.close());
    head.append(x);
    card.append(head);

    if (this.requests.length) {
      const box = el('div', 'fr-requests');
      box.append(el('h3', '', `Friend requests (${this.requests.length})`));
      for (const name of this.requests) {
        const row = el('div', 'fr-row');
        row.append(this.avatar(name), el('b', 'fr-grow', name));
        const yes = el('button', 'mm-small fr-go', 'Accept');
        yes.addEventListener('click', () => this.hooks.send({ t: 'friend', op: 'accept', name }));
        const no = el('button', 'mm-small', 'Decline');
        no.addEventListener('click', () => this.hooks.send({ t: 'friend', op: 'decline', name }));
        row.append(yes, no);
        box.append(row);
      }
      card.append(box);
    }

    if (this.party) card.append(this.partyBox(this.party));

    const add = el('div', 'own-row');
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'Add a friend by name';
    input.maxLength = 16;
    input.dataset.f = 'addfriend';
    if (keep?.on && keep.f === 'addfriend') input.value = keep.v;
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
    card.append(add);
    if (this.addError) card.append(el('div', 'auth-err', this.addError));

    const online = onlineCount(this.friends);
    card.append(el('h3', 'fr-h', `Friends · ${online} online of ${this.friends.length}`));
    if (!this.friends.length) {
      card.append(el('p', 'fr-empty', 'No friends yet. Add a friend by name above; they get a request to accept.'));
    } else {
      const search = el('input');
      search.type = 'search';
      search.placeholder = 'Search friends';
      search.className = 'fr-search';
      search.dataset.f = 'search';
      search.value = this.filter;
      search.addEventListener('input', () => {
        this.filter = search.value;
        this.render();
      });
      card.append(search);
      const mates = this.party?.members.map((x) => x.name) ?? [];
      const groups = groupFriends(this.friends, mates, this.filter);
      if (!groups.length) card.append(el('p', 'fr-empty', 'No friend matches that name.'));
      const list = el('div', 'fr-list');
      for (const g of groups) {
        const collapsed = g.group === 'offline' && !this.offlineOpen && !this.filter.trim();
        const head = el('button', `fr-group ${g.group}`, `${collapsed ? '▸' : '▾'} ${GROUP_TITLES[g.group]} (${g.rows.length})`);
        head.type = 'button';
        if (g.group === 'offline') {
          head.addEventListener('click', () => {
            this.offlineOpen = !this.offlineOpen;
            this.render();
          });
        } else head.disabled = true;
        list.append(head);
        if (!collapsed) for (const f of g.rows) list.append(this.friendRow(f, mates));
      }
      card.append(list);
    }
    m.replaceChildren(card);
    if (keep?.on) (m.querySelector(`[data-f="${keep.f}"]`) as HTMLInputElement | null)?.focus();
  }

  private avatar(name: string, av?: number): HTMLElement {
    const img = avatarImg(avatarUrl(name, av), 'fr-av');
    if (img) return img;
    const d = el('span', 'fr-av fr-av-i', name.slice(0, 1).toUpperCase());
    return d;
  }

  private friendRow(f: FriendRow, mates: string[]): HTMLElement {
    const row = el('div', `fr-row ${f.status === 'offline' ? 'off' : ''}`);
    const av = this.avatar(f.name, f.avatar);
    av.classList.add(f.status);
    const nm = el('b', '', f.name);
    if (f.cosmetics) applyName(nm, resolveCosmetics(f.cosmetics));
    const info = el('div', 'fr-info');
    info.append(nm, el('small', '', `${statusLine(f, mates)}${f.status !== 'offline' && f.rating ? ` · ${f.rating}` : ''}`));
    row.append(av, info);
    const free = f.status === 'menu';
    const isLeader = !this.party || this.party.leader === this.me;
    const inParty = mates.some((n) => n.toLowerCase() === f.name.toLowerCase());
    const why = (ok: boolean, text: string) => (ok ? text : f.status === 'offline' ? `${f.name} is offline` : inParty ? `${f.name} is already in your party` : !free ? `${f.name} is ${statusLine(f, mates).toLowerCase()}` : text);
    const party = el('button', 'mm-small', 'Party');
    party.disabled = !free || !isLeader || inParty;
    party.title = !isLeader ? 'Only the party leader can invite' : this.party && this.party.members.length >= PARTY_MAX ? `Your party is full (${PARTY_MAX})` : why(!party.disabled, 'Invite to your party: you play on the same team');
    party.addEventListener('click', () => this.hooks.send({ t: 'invite', kind: 'party', name: f.name }));
    const duel = el('button', 'mm-small', 'Duel');
    duel.disabled = !free || !!this.party;
    duel.title = this.party ? 'Leave your party to duel' : why(!duel.disabled, 'Challenge to an unranked 1v1');
    duel.addEventListener('click', () => this.hooks.send({ t: 'invite', kind: 'duel', name: f.name }));
    const rm = el('button', 'mm-small fr-rm', '✕');
    rm.title = 'Remove friend';
    rm.addEventListener('click', () => {
      if (confirm(`Remove ${f.name} from your friends?`)) this.hooks.send({ t: 'friend', op: 'remove', name: f.name });
    });
    const fol = this.hooks.follow;
    if (fol?.isOwner() && f.status !== 'offline') {
      const on = fol.current()?.toLowerCase() === f.name.toLowerCase();
      const follow = el('button', `mm-small${on ? ' mm-go' : ''}`, on ? 'Following' : 'Follow');
      follow.title = on ? `Stop following ${f.name}` : `Join ${f.name} in every match they play, as a spectator`;
      follow.addEventListener('click', () => {
        fol.set(on ? null : f.name);
        window.setTimeout(() => this.hooks.send({ t: 'friends' }), 300); // repaint the button with the new state
      });
      row.append(follow);
    }
    row.append(party, duel, rm);
    return row;
  }

  private partyBox(p: PartyInfo): HTMLElement {
    const box = el('div', 'fr-party');
    box.append(el('h3', '', `Your party (${p.members.length}/${PARTY_MAX})`));
    for (const mem of p.members) {
      const row = el('div', 'fr-row');
      row.append(el('span', `fr-dot ${mem.ready ? 'menu' : 'party'}`), el('b', '', `${mem.name === p.leader ? '👑 ' : ''}${mem.name}`), el('small', '', `Team ${mem.side + 1} · ${mem.name === p.leader ? 'leader' : mem.ready ? 'ready ✓' : 'not ready'}`));
      if (p.leader === this.me && mem.name !== this.me) {
        const kick = el('button', 'mm-small', 'Remove');
        kick.addEventListener('click', () => this.hooks.send({ t: 'party_kick', name: mem.name }));
        row.append(kick);
      }
      box.append(row);
    }
    box.append(el('p', 'mm-modal-foot', 'The leader picks the mode and arena once everyone else has pressed Ready in the lobby. Members start on the leader\'s team until it is full (3); switch teams in the lobby.'));
    const leave = el('button', 'mm-small', 'Leave party');
    leave.addEventListener('click', () => this.hooks.send({ t: 'party_leave' }));
    box.append(leave);
    return box;
  }
}
