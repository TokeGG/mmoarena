import { BOT_NAMES_MAX, BOT_NAME_MAX_LEN, BOT_NAME_MIN_LEN, CLASSES, CLASS_IDS, formatReport, mergePatches, moveText, requestText, validateBotNames } from '@arena/shared';
import type { BotBug, DataPatch, DevRequestRow, NoteInfo } from '@arena/shared';
import { noteBox } from './botNoteUi';
import { DevWorkspace } from './devPages';
import { patchKey } from './devEdits';
import { designer, requestStatus } from './designer';
import { pendingProposals } from './counts';
import type { AccountInfo, AdminLogRow, AdminOnline, ClassKnowledge, ClientMsg, LearnReport, LiveLearning, MatchRecord, ProposalRow, ServerMsg, TrainJobRow } from '@arena/shared';
import { OwnerPanel } from './ownerUi';
import { TimeView } from './timeUi';
import { mapName } from './spectate';
import type { Popup } from './popups';
import { tours } from './tour';
import { toursList } from './tourUi';

/** The panel's access for an account (the server decides for real; this only shapes what is shown). */
export function adminAccessOf(a: AccountInfo | null): 'owner' | 'dev' | null {
  if (!a) return null;
  if (a.ownerOk) return 'owner';
  return a.grants.includes('dev') ? 'dev' : null;
}

let designerOnce = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export type Tab = 'dashboard' | 'players' | 'time' | 'matches' | 'replays' | 'moderation' | 'proposals' | 'tuning' | 'requests' | 'server' | 'log';
const TABS: [Tab, string][] = [
  ['dashboard', 'Dashboard'],
  ['players', 'Players'],
  ['time', 'Play time'],
  ['matches', 'Live matches'],
  ['replays', 'Replays'],
  ['moderation', 'Moderation'],
  ['proposals', 'Proposals'],
  ['tuning', 'Tuning'],
  ['requests', 'Requests'],
  ['server', 'Server'],
  ['log', 'Log'],
];

/** The tabs a dev can use (the rest is account moderation, announcements and maintenance). */
const DEV_TABS: readonly Tab[] = ['dashboard', 'matches', 'replays', 'moderation', 'proposals', 'tuning', 'log'];

interface Hooks {
  send(m: ClientMsg): void;
  token(): string;
  account(): AccountInfo | null;
  watch(id: string): void;
  follow(name: string): void;
  /** Play a stored replay. */
  replay(id: string): void;
  /** The number of dev proposals nobody has checked yet changed (for the badge on the admin button). */
  onPending?(n: number): void;
}

/** Server pushes that arrive on a timer while the panel is open (not an answer to something the person just did). */
const PERIODIC = new Set<string>(['admin_overview', 'admin_feed', 'train_status', 'bot_knowledge']);

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
const dur = (ms: number) => {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/**
 * The owner's admin panel, a window of its own: the server at a glance, every player (search, moderation, unlocks,
 * history), every match (watch, pause, end), the suggestion box, tuning (live number changes, bot matches),
 * announcements and maintenance mode, and a log of every admin action. The server checks every action again.
 */
export class AdminPanel {
  /** The panel's body inside the tools window (always there; the window shows it on its Admin tab). */
  readonly root: HTMLElement = el('div', 'admp embed');
  /** The Admin tab is showing: the panel refreshes and redraws only then. */
  private active = false;
  /** The tools window (set by it) that shows and hides this panel. */
  private win: { show(): void; hide(): void } | null = null;
  private tab: Tab = 'dashboard';
  private log: AdminLogRow[] | null = null;
  private suggestions: { at: number; name: string; text: string; note?: string }[] | null = null;
  private maintText = '';
  /** Owner only: the text box of bot names (one per line) and what the server said about the last save. */
  private botNamesText: string | null = null;
  private botNamesMsg: { ok: boolean; text: string } | null = null;
  /** Every match played on the server (newest first), with its replay. */
  private feed: MatchRecord[] | null = null;
  private feedFilter: 'all' | 'people' | 'bots' | 'ranked' = 'all';
  /** What devs sent in from the debug window, newest first. */
  private proposals: ProposalRow[] | null = null;
  private picked = new Set<string>();
  private propNote = '';
  private propMsg: { ok: boolean; text: string; url?: string } | null = null;
  private trainMsg: { ok: boolean; text: string } | null = null;
  /** The replays the bots are training on or just trained on, pushed by the server every second while any runs. */
  private jobs: TrainJobRow[] = [];
  private picks = new Set<string>();
  /** What the bots know now against what shipped, and the last reports of what they learned (owner only). */
  private knowledge: { classes: ClassKnowledge[]; reports: LearnReport[]; live?: LiveLearning; canCommit?: boolean; notes: NoteInfo[]; bugs: BotBug[] } | null = null;
  /** Replay rows whose 'Note for the bots' box is open. */
  private noteRows = new Set<string>();
  /** Queue rows opened to show exactly what was learned. */
  private opened = new Set<string>();
  /** Passes (1..5) for the owner's forced training on one replay. */
  private passes = 1;
  /** The same tools as the profile's Owner tab (players, matches, tuning), drawn here. */
  private op: OwnerPanel;
  /** Play time per player (owner only). */
  private time: TimeView;
  /** The bot battle window, started from the main menu (owner only). */
  private bb: HTMLElement | null = null;
  readonly bbPopup: Popup = { isOpen: () => !!this.bb, close: () => this.closeBotBattle(), el: () => this.bb };

  /** Pick both sides of a bot match and watch it, without going through the admin panel. */
  openBotBattle() {
    if (!this.bb) {
      this.bb = el('div', 'admp');
      this.bb.addEventListener('mousedown', (e) => e.target === this.bb && this.closeBotBattle());
      document.body.append(this.bb);
    }
    this.paintBotBattle();
  }

  closeBotBattle() {
    this.bb?.remove();
    this.bb = null;
  }

  private paintBotBattle() {
    const r = this.bb;
    if (!r) return;
    const a = this.hooks.account();
    const card = el('div', 'admp-card admp-small');
    const head = el('div', 'admp-head');
    const close = el('button', 'mm-small', 'Close');
    close.addEventListener('click', () => this.closeBotBattle());
    head.append(el('h2', '', '🤖 Bot battle'), el('span', 'admp-status', 'Watch bots fight each other'), close);
    card.append(head);
    const body = el('div', 'admp-body');
    if (!a || a.role !== 'owner') body.append(el('p', 'mm-modal-foot', 'Only the founder account can start a bot battle.'));
    else if (!a.ownerOk) body.append(this.op.render(a));
    else body.append(this.op.botMatch(() => this.closeBotBattle()));
    card.append(body);
    r.replaceChildren(card);
  }

  /** The window itself, kept between redraws so its size (grab the corner) sticks. */
  private card = el('div', 'admp-card');

  constructor(private hooks: Hooks) {
    this.time = new TimeView((m) => hooks.send(m), () => this.paint());
    this.root.append(this.card);
    this.root.addEventListener('focusout', () => window.setTimeout(() => this.repaintLater && !this.typing() && this.paint(), 150));
    this.op = new OwnerPanel({ limited: () => this.access() === 'dev', send: hooks.send, token: hooks.token, rerender: () => {
        this.paint();
        this.paintBotBattle(); // the bot battle window from the main menu redraws too (more bots when the size changes)
      }, watch: (id) => { this.close(); hooks.watch(id); }, follow: (n) => hooks.follow(n), play: (id, unit) => { this.close(); hooks.send({ t: 'admin_takeover', id, unit }); }, release: () => hooks.send({ t: 'admin_release' }) });
  }

  /** What the signed-in account may do here: the owner (code entered) everything, the dev tag the read and training part. The server checks again. */
  private access(): 'owner' | 'dev' | null {
    return adminAccessOf(this.hooks.account());
  }

  /** The tools window is open on the Admin tab. */
  get isOpen(): boolean {
    return this.active;
  }

  setWindow(w: { show(): void; hide(): void }) {
    this.win = w;
  }

  /** Live matches and the dashboard keep themselves up to date while the panel is open. */
  private timer = 0;

  /** Open the tools window on the Admin tab (on `tab`). */
  open(tab?: Tab) {
    if (tab) this.tab = tab;
    if (this.win && !this.active) this.win.show(); // the window calls activate()
    else this.activate();
  }

  /** The window shows the Admin tab: the lists refresh themselves every few seconds until it stops showing. */
  activate() {
    this.active = true;
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      if (!this.active || document.hidden || !this.access()) return;
      if (this.tab === 'matches' || this.tab === 'dashboard') this.hooks.send({ t: 'admin_overview' });
      else if (this.tab === 'replays') this.hooks.send({ t: 'admin_act', act: 'feed' });
    }, 3000);
    this.refresh();
    this.paint();
    this.tourMoment();
  }

  /** The window closed or switched to the Dev tab: no more polling. */
  deactivate() {
    this.active = false;
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  /** The first time ever on the panel (or on its Tuning tab) a dev is walked through it. */
  private tourMoment() {
    tours.autoRun(this.tab === 'tuning' ? 'tuning' : 'admin', true);
  }

  /** Show a tab (the tours open the panel on the tab they talk about). */
  showTab(tab: Tab) {
    this.open(tab);
  }

  /** The "?" button's list: every tour, each with a replay button. */
  private toursOpen = false;

  /** Close the whole tools window (watching or taking over a match, losing access). */
  close() {
    if (this.win) this.win.hide();
    else this.deactivate();
  }

  /** Ask the server for what the current tab shows. */
  private refresh() {
    const access = this.access();
    if (!access) return;
    if (access === 'dev' && !DEV_TABS.includes(this.tab)) this.tab = 'dashboard';
    const s = this.hooks.send;
    s({ t: 'admin_overview' });
    if (this.tab === 'players' && access === 'owner') s({ t: 'admin_list' });
    if (this.tab === 'time' && access === 'owner') this.time.refresh();
    if (this.tab === 'proposals' || this.tab === 'tuning' || this.tab === 'dashboard') s({ t: 'admin_proposals', op: 'list' });
    if (this.tab === 'requests') s({ t: 'dev_requests', op: 'list' });
    if (this.tab === 'dashboard' || this.tab === 'log') s({ t: 'admin_act', act: 'log' });
    if (this.tab === 'moderation') s({ t: 'suggestions' });
    if (this.tab === 'server' && access === 'owner' && this.botNamesText === null) s({ t: 'admin_botnames' });
    if (this.tab === 'replays') {
      s({ t: 'admin_act', act: 'feed' });
      s({ t: 'admin_act', act: 'train_status' });
      s({ t: 'admin_act', act: 'bot_knowledge' });
    }
  }

  handle(m: ServerMsg) {
    this.time.handle(m);
    switch (m.t) {
      case 'admin_log':
        this.log = m.rows;
        break;
      case 'suggestions':
        this.suggestions = m.rows;
        break;
      case 'admin_feed':
        this.feed = m.rows;
        break;
      case 'train_status':
        this.jobs = m.jobs;
        break;
      case 'bot_knowledge':
        this.knowledge = { classes: m.classes, reports: m.reports, live: m.live, canCommit: m.canCommit, notes: m.notes ?? [], bugs: m.bugs ?? [] };
        break;
      case 'proposals':
        this.proposals = m.rows;
        this.hooks.onPending?.(pendingProposals(m.rows));
        for (const id of [...this.picked]) if (!m.rows.some((r) => r.id === id && r.status === 'pending')) this.picked.delete(id);
        break;
      case 'dev_result':
        if (this.redeployWait) {
          this.redeployWait = false;
          this.redeployMsg = { ok: m.ok, text: m.text };
          break;
        }
        if (this.tab === 'tuning' || this.tab === 'proposals') {
          this.propMsg = { ok: m.ok, text: m.text, url: m.url };
          this.picked.clear();
        }
        if (this.tab === 'replays') {
          this.trainMsg = { ok: m.ok, text: m.text };
        }
        break;
      case 'owner':
        if (m.ok) this.refresh();
        break;
      case 'botnames':
        if (m.error) this.botNamesMsg = { ok: false, text: m.error };
        else {
          this.botNamesText = m.names.join('\n');
        }
        break;
    }
    this.op.handle(m);
    if (m.t === 'admin_overview' && m.maintenance && !this.maintText) this.maintText = m.maintenance;
    // the lists refresh themselves every few seconds: a redraw must not close the phone keyboard on a box being typed in
    if (this.active && PERIODIC.has(m.t) && this.typing()) this.repaintLater = true;
    else if (this.active) this.paint();
    if (this.bb) this.paintBotBattle();
  }

  /** A periodic update arrived while a box was being typed in: the redraw waits until the person leaves it. */
  private repaintLater = false;
  private typing(): boolean {
    const a = document.activeElement;
    return !!a && this.root.contains(a) && (a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'file'].includes(a.type)));
  }

  private paint() {
    const r = this.root;
    if (!this.active) return;
    this.repaintLater = false;
    const a = this.hooks.account();
    const card = this.card;
    // a redraw keeps the place in the list and in the tab row (the lists refresh while someone scrolls them)
    const prevBody = card.querySelector<HTMLElement>('.admp-body');
    const prevTabs = card.querySelector<HTMLElement>('.admp-tabs');
    const keep = prevBody && card.dataset.tab === this.tab ? { top: prevBody.scrollTop, tabs: prevTabs?.scrollLeft ?? 0 } : { top: 0, tabs: prevTabs?.scrollLeft ?? 0 };
    card.dataset.tab = this.tab;
    card.replaceChildren();
    const head = el('div', 'admp-head');
    const o = this.op.overview;
    head.append(el('span', 'admp-status', o ? `${o.online} online · ${o.rooms.length} match${o.rooms.length === 1 ? '' : 'es'} · v${o.version ?? '?'}${o.maintenance ? ' · 🛠 maintenance' : ''}` : ''));
    const refresh = el('button', 'mm-small', '↻');
    refresh.title = 'Refresh';
    refresh.addEventListener('click', () => this.refresh());
    const help = el('button', `mm-small${this.toursOpen ? ' mm-go' : ''}`, '? Tours');
    help.title = 'Guided tours: replay the walkthroughs of the Dev tools, this panel and the game';
    help.dataset.tour = 'admin-tours';
    help.addEventListener('click', () => {
      this.toursOpen = !this.toursOpen;
      this.paint();
    });
    head.append(help, refresh);
    card.append(head);

    const access = this.access();
    if (!a || (!access && a.role !== 'owner')) {
      card.append(el('p', 'mm-modal-foot', 'Only the founder account and accounts with the dev tag can use the admin panel.'));
      r.replaceChildren(card);
      return;
    }
    if (!access) {
      // the unlock form of the Owner tab
      card.append(this.op.render(a));
      r.replaceChildren(card);
      return;
    }

    const tabs = el('div', 'admp-tabs');
    tabs.dataset.tour = 'admin-tabs'; // the guided tours point at these (tourData.ts)
    for (const [id, label] of TABS) {
      if (access === 'dev' && !DEV_TABS.includes(id)) continue;
      const waiting = id === 'proposals' ? pendingProposals(this.proposals) : id === 'requests' ? designer.requests.filter((r) => r.status === 'open').length : 0;
      const b = el('button', `admp-tab${id === this.tab ? ' sel' : ''}`, waiting ? `${label} (${waiting})` : label);
      b.dataset.tour = `admin-tab-${id}`;
      b.addEventListener('click', () => {
        this.tab = id;
        this.refresh();
        this.paint();
        this.tourMoment();
      });
      tabs.append(b);
    }
    const body = el('div', 'admp-body');
    if (this.toursOpen) body.append(el('h3', '', 'Guided tours'), toursList(['dev', 'admin', 'player']));
    switch (this.tab) {
      case 'dashboard':
        body.append(this.dashboard());
        break;
      case 'players':
        body.append(el('p', 'mm-modal-foot', 'Click a player for moderation (kick, ban, mute), rating and stats, unlocks and the dev tag, a private note and their recent matches.'), this.op.adminList());
        break;
      case 'time':
        body.append(this.time.render());
        break;
      case 'matches':
        body.append(el('p', 'mm-modal-foot', access === 'dev' ? 'Every match running now. You can watch the ones open for watching (the same slightly delayed view as everyone). Pausing and ending matches is the owner\u2019s.' : 'Every match running now, bot matches included. Watch one, pause it to change numbers (F2 while watching), or end it.'), this.op.serverBox());
        break;
      case 'replays':
        body.append(this.replays());
        break;
      case 'moderation':
        body.append(this.moderation());
        break;
      case 'proposals':
        body.append(el('h3', '', 'Proposed by devs (newest first)'), this.proposalBox(), el('h3', '', 'Deploy'), this.redeployBox());
        break;
      case 'tuning':
        body.append(el('h3', '', 'Skill designer'), this.propMsgBox(), this.designerBox(), el('h3', '', 'Live number changes'), this.prState(), this.op.overridesBox());
        if (access === 'owner') body.append(el('h3', '', 'Bot match'), el('p', 'mm-modal-foot', 'Start bot battles from the main menu (the robot button next to the admin button). They show live on the Watch tab, and every one is kept under Replays, where you can train the bots on it.'));
        break;
      case 'requests':
        body.append(this.requestsBox());
        break;
      case 'server':
        body.append(el('h3', '', 'Announcement'), this.op.announceBox(), el('h3', '', 'Maintenance mode'), this.maintenance(), ...(access === 'owner' ? [el('h3', '', 'Bot names'), this.botNamesBox()] : []), el('h3', '', 'Guided tours'), toursList(['dev', 'admin', 'player']));
        break;
      case 'log':
        body.append(this.logList(this.log ?? [], 300));
        break;
    }
    card.append(tabs, body);
    r.replaceChildren(card);
    tabs.scrollLeft = keep.tabs;
    body.scrollTop = keep.top;
    if (!keep.top) tabs.querySelector('.sel')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** The designer's pages (the same ones as the debug panel's Edit values section) and where the chat sits. */
  private dsWorkspace: DevWorkspace | null = null;
  private dsChat: HTMLElement | null = null;
  private dsAddBtn: HTMLButtonElement | null = null;

  /** What this account has proposed and nobody has handled yet, by patch key. */
  private pendingMine(): DataPatch[] {
    const me = this.hooks.account()?.name;
    return (this.proposals ?? []).filter((r) => r.status === 'pending' && r.by === me).reverse().reduce<DataPatch[]>((acc, r) => mergePatches(acc, r.patches), []);
  }

  private workspace(): DevWorkspace {
    if (!this.dsWorkspace) {
      this.dsWorkspace = new DevWorkspace({
        testing: () => new Map(this.pendingMine().map((p) => [patchKey(p), p])),
        inEffect: () => this.pendingMine(),
        canRevert: false,
        onEdit: () => this.refreshAdd(),
        saveTitle: 'Saves what you picked: adds it to the Proposals list, ready to commit to GitHub.',
        save: () => {
          const patches = [...(this.dsWorkspace?.set.edits.values() ?? [])];
          if (!patches.length) return 'Nothing to save yet.';
          this.dsWorkspace?.set.clear();
          this.hooks.send({ t: 'dev_save', patches });
          return 'Saved: it is on the Proposals tab.';
        },
        repaint: () => this.paint(),
        startClass: () => CLASS_IDS[0],
        onSelect: () => this.dsChat?.isConnected && this.dsWorkspace && this.dsChat.replaceChildren(designer.renderChat(this.dsWorkspace.chatScope(), this.hooks.send, true)),
      });
    }
    return this.dsWorkspace;
  }

  private refreshAdd() {
    const ws = this.dsWorkspace;
    if (this.dsAddBtn && ws) this.dsAddBtn.textContent = `Add my edits to proposals (${ws.set.edits.size})`;
  }

  /**
   * The debug window's pages and Ask Claude chat, for the admin panel (no match is running here): classes, specs, talents,
   * skills, auras and game options, with the same search, resets and changes list. Edits and Claude's changes become proposals
   * below, which are committed to GitHub with "Commit the ticked ones" (one commit that is also a patch) or deleted.
   */
  private designerBox(): HTMLElement {
    const box = el('div', 'admp-designer');
    if (!designerOnce) {
      designerOnce = true;
      designer.onChange(() => this.active && this.tab === 'tuning' && this.paint());
    }
    const ws = this.workspace();
    const left = el('div', 'admp-ds-left');
    const add = el('button', 'mm-small mm-go', `Add my edits to proposals (${ws.set.edits.size})`);
    add.title = 'Puts the numbers you typed on the Proposals tab (old -> new), ready to commit to GitHub.';
    add.dataset.tour = 'admin-add';
    this.dsAddBtn = add;
    add.addEventListener('click', () => {
      const patches = [...ws.set.edits.values()];
      if (!patches.length) {
        this.propMsg = { ok: false, text: 'Change a number first.' };
        return this.paint();
      }
      ws.set.clear();
      this.hooks.send({ t: 'dev_save', patches });
    });
    const changes = el('details', 'devp-sec');
    changes.append(el('summary', 'devp-sec-head', 'Changes so far (old -> new)'), ws.changesList());
    left.append(add, ws.render(), changes);
    const chat = el('div', 'admp-chatholder');
    chat.append(designer.renderChat(ws.chatScope(), this.hooks.send, true));
    this.dsChat = chat;
    box.append(left, chat);
    return box;
  }

  /** The owner's list of change requests: what devs asked for that needs code, written so it can be handed to a coding session. */
  private requestsBox(): HTMLElement {
    const box = el('div', 'own-box admp-reqs');
    const rows = designer.requests;
    box.append(el('p', 'mm-modal-foot', 'Things devs asked Claude for that need a code change (new mechanics, visuals, AI). Each is a complete spec: copy it into a coding session. Number-only changes never land here: they are proposals under Proposals.'));
    if (!rows.length) box.append(el('p', 'mm-modal-foot', 'No requests yet.'));
    const owner = this.access() === 'owner';
    for (const r of rows) box.append(this.requestCard(r, owner));
    return box;
  }

  private requestCard(r: DevRequestRow, owner: boolean): HTMLElement {
    const card = el('details', 'admp-prop');
    const sum = el('summary', 'admp-prop-head');
    sum.append(el('b', '', r.title), el('small', '', ` · ${r.by} · ${r.scope} · ${ago(r.at)} · ${requestStatus(r)}`));
    card.append(sum);
    const pre = el('pre', 'admp-req-text', requestText(r));
    pre.style.whiteSpace = 'pre-wrap';
    card.append(pre);
    const row = el('div', 'own-row');
    const copy = el('button', 'mm-small', 'Copy spec');
    copy.addEventListener('click', () => void navigator.clipboard?.writeText(requestText(r)).catch(() => undefined));
    row.append(copy);
    if (r.issueUrl) {
      const a = el('a', '', ' GitHub issue');
      a.href = r.issueUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      row.append(a);
    }
    if (r.issueError) row.append(el('small', 'devp-dim', ` (no GitHub issue: ${r.issueError})`));
    if (r.prUrl) {
      const a = el('a', '', ` Pull request #${r.prNumber} (${r.prState})`);
      a.href = r.prUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      row.append(a);
    } else if (r.build) row.append(el('small', 'devp-dim', ` Claude is building it (asked by ${r.build.by} ${ago(r.build.at)}). The pull request shows here when it is ready.`));
    if (owner && r.prUrl && r.prState === 'open') {
      const mg = el('button', 'mm-small mm-go', '✅ Merge it');
      mg.title = 'Merges the pull request into main (only if its checks have all passed). The game redeploys with the change.';
      mg.addEventListener('click', () => window.confirm(`Merge pull request #${r.prNumber} into main now? The live game updates when it deploys.`) && this.hooks.send({ t: 'dev_requests', op: 'merge', id: r.id }));
      row.append(mg);
    }
    if (r.build && !r.prUrl) {
      const chk = el('button', 'mm-small', 'Check for the pull request');
      chk.addEventListener('click', () => this.hooks.send({ t: 'dev_requests', op: 'check', id: r.id }));
      row.append(chk);
    }
    if (owner && !r.build && r.status !== 'done') {
      const bld = el('button', 'mm-small mm-go', '🤖 Build it with Claude');
      bld.title = 'Claude changes the code on GitHub, runs the checks and opens a pull request for you to review and merge. Nothing goes live until you merge it.';
      bld.addEventListener('click', () => window.confirm(`Ask Claude to build "${r.title}"? It opens a pull request on GitHub (this uses your Anthropic API key on GitHub).`) && this.hooks.send({ t: 'dev_requests', op: 'build', id: r.id }));
      row.append(bld);
    }
    if (owner) {
      const done = el('button', 'mm-small mm-go', r.status === 'done' ? 'Reopen' : 'Mark done');
      done.addEventListener('click', () => this.hooks.send({ t: 'dev_requests', op: r.status === 'done' ? 'reopen' : 'done', id: r.id }));
      const del = el('button', 'mm-small', 'Delete');
      del.addEventListener('click', () => {
        if (window.confirm(`Delete the request "${r.title}"?`)) this.hooks.send({ t: 'dev_requests', op: 'delete', id: r.id });
      });
      row.append(done, del);
    }
    card.append(row);
    return card;
  }

  private dashboard(): HTMLElement {
    const box = el('div', 'admp-dash');
    const o = this.op.overview;
    const kinds = (k: string) => o?.rooms.filter((x) => x.kind === k).length ?? 0;
    const cards: [string, string][] = o
      ? [
          ['Online', String(o.online)],
          ['In queue', String(o.queued)],
          ['Matches', String(o.rooms.length)],
          ['Ranked', String(kinds('ranked'))],
          ['Practice', String(kinds('practice') + kinds('dummies') + kinds('party'))],
          ['Bot matches', String(kinds('bots'))],
          ['Uptime', o.uptimeMs !== undefined ? dur(o.uptimeMs) : '?'],
          ['Number changes', String(o.overrides ?? 0)],
        ]
      : [];
    const grid = el('div', 'admp-stats');
    for (const [k, v] of cards) {
      const c = el('div', 'admp-stat');
      c.append(el('b', '', v), el('small', '', k));
      grid.append(c);
    }
    box.append(grid);
    if (o?.tick) {
      // how the server loop copes (owner only): red when a tick needs over 70 % of its step or any tick was late in the last minute
      const t = o.tick;
      const bad = t.load > 0.7 || t.late > 0;
      const row = el('div', `adm-state ${bad ? 'bad' : 'ok'}`, `Server tick: ${t.ms} ms (${(1000 / t.ms).toFixed(1)} Hz) · load ${Math.round(t.load * 100)} % (${t.avgMs} ms avg, ${t.maxMs} ms worst) · ${t.late} late tick${t.late === 1 ? '' : 's'} in the last minute`);
      box.append(row);
    }
    if (o?.maintenance) box.append(el('div', 'adm-state warn', `🛠 Maintenance mode is on: ${o.maintenance}`));
    const pending = this.proposals?.filter((r) => r.status === 'pending').length ?? 0;
    if (pending) {
      const b = el('button', 'adm-state warn adm-link', `📨 ${pending} dev proposal${pending === 1 ? '' : 's'} waiting for you`);
      b.addEventListener('click', () => { this.tab = 'proposals'; this.refresh(); this.paint(); });
      box.append(b);
    }
    if (o) box.append(this.prState());
    if (o?.players) box.append(this.onlineNow(o.players));
    box.append(el('h3', '', 'Recent admin actions'), this.logList(this.log ?? [], 10));
    return box;
  }

  private logList(rows: AdminLogRow[], max: number): HTMLElement {
    const ul = el('ul', 'admp-log');
    for (const row of rows.slice(0, max)) {
      const li = el('li');
      li.append(el('small', '', `${new Date(row.at).toLocaleString()} (${ago(row.at)})`), el('span', '', ` ${row.by}: ${row.action}${row.target ? ` · ${row.target}` : ''}${row.detail ? ` · ${row.detail}` : ''}`));
      ul.append(li);
    }
    if (!rows.length) ul.append(el('li', '', 'Nothing logged yet.'));
    return ul;
  }

  /** Everyone connected right now, guests included: name, address, country, what they are doing, how long. The address links to a city lookup that opens from your own browser. */
  private onlineNow(list: AdminOnline[]): HTMLElement {
    const box = el('div');
    box.append(el('h3', '', `Online now (${list.length})`));
    const ul = el('ul', 'admp-log');
    for (const q of list) {
      const li = el('li');
      if (q.ip === undefined) {
        // a dev: name, status and time only, never an address or a location
        li.append(el('b', '', `${q.name}${q.guest ? ' (guest)' : ''}`), el('span', '', ` · ${q.status} · ${dur(q.sinceMs)}`));
        ul.append(li);
        continue;
      }
      const ip = el('a', '', q.ip || '?') as HTMLAnchorElement;
      if (q.ip && q.where !== 'local network') {
        ip.href = `https://ipwho.is/${encodeURIComponent(q.ip)}`;
        ip.target = '_blank';
        ip.rel = 'noopener noreferrer';
      }
      li.append(el('b', '', `${q.name}${q.guest ? ' (guest)' : ''}`), el('span', '', ' · '), ip, el('span', '', ` · ${q.where || 'location unknown'} · ${q.status} · ${dur(q.sinceMs)}`));
      ul.append(li);
    }
    if (!list.length) ul.append(el('li', '', 'Nobody is connected.'));
    box.append(ul);
    return box;
  }

  /** The suggestion box and skill notes, newest first, with delete. */
  private moderation(): HTMLElement {
    const box = el('div');
    box.append(el('h3', '', 'Suggestion box and skill notes'));
    if (!this.suggestions) {
      box.append(el('p', 'mm-modal-foot', 'Loading…'));
      return box;
    }
    if (!this.suggestions.length) box.append(el('p', 'mm-modal-foot', 'The box is empty.'));
    for (const s of this.suggestions) {
      const row = el('div', 'own-room');
      const info = el('div', 'own-room-info');
      info.append(el('b', '', `${s.name} · ${new Date(s.at).toLocaleString()}`), el('span', 'admp-wrap', s.text));
      if (s.note) info.append(el('small', '', `+ attached note (${s.note.length} characters)`));
      row.append(info);
      if (this.access() === 'owner') {
        const del = el('button', 'mm-small', 'Delete');
        del.addEventListener('click', () => {
          this.hooks.send({ t: 'suggest_delete', at: s.at, text: s.text });
          this.suggestions = this.suggestions!.filter((x) => x !== s);
          this.paint();
        });
        row.append(del);
      }
      box.append(row);
    }
    return box;
  }

  /**
   * Everything devs sent with "Send to the admin panel", stacked: each shows who, when and every number with its old
   * and new value. Tick the ones you want, then open one pull request with them all, make them live, or dismiss them.
   * Nothing is live until you do.
   */
  /** Starts a Render deploy of the latest commit (what a commit from the Proposals list needs to go live if auto-deploy is off). */
  private redeployWait = false;
  private redeployMsg: { ok: boolean; text: string } | null = null;
  private redeployBox(): HTMLElement {
    const box = el('div', 'own-box');
    const b = el('button', 'mm-small', 'Redeploy Render');
    b.title = 'Starts a deploy of the latest commit on Render. The game restarts when it is ready, so everyone online is disconnected for a moment.';
    b.addEventListener('click', () => {
      if (!window.confirm('Start a deploy on Render now? The game restarts when it is ready (a minute or two) and everyone online is disconnected for a moment.')) return;
      this.redeployWait = true;
      this.redeployMsg = { ok: true, text: 'Asking Render…' };
      this.hooks.send({ t: 'dev_redeploy' });
      this.paint();
    });
    if (this.redeployMsg) box.append(el('div', `adm-state ${this.redeployMsg.ok ? 'ok' : 'warn'}`, this.redeployMsg.text));
    box.append(b, el('p', 'mm-modal-foot', 'Starts a deploy of the latest commit. Commits to main deploy on their own; use this when one did not.'));
    return box;
  }

  private propMsgBox(): HTMLElement {
    const wrap = el('div');
    if (!this.propMsg) return wrap;
    const m = el('div', `adm-state ${this.propMsg.ok ? 'ok' : 'warn'}`, this.propMsg.text);
    if (this.propMsg.url) {
      const a = el('a', '', ' Open the pull request');
      a.href = this.propMsg.url;
      a.target = '_blank';
      a.rel = 'noopener';
      m.append(a);
    }
    if (this.tab === 'tuning') {
      const go = el('button', 'mm-small', ' Open Proposals');
      go.addEventListener('click', () => { this.tab = 'proposals'; this.refresh(); this.paint(); });
      m.append(go);
    }
    wrap.append(m);
    return wrap;
  }

  private proposalBox(): HTMLElement {
    const box = el('div', 'own-box admp-props');
    const rows = this.proposals?.filter((r) => r.status === 'pending') ?? [];
    if (!this.proposals) {
      box.append(el('p', 'mm-modal-foot', 'Loading…'));
      return box;
    }
    box.append(this.propMsgBox());
    if (!rows.length) box.append(el('p', 'mm-modal-foot', this.access() === 'dev' ? 'Nothing waiting. Send your number changes from the debug window (F2): "Send to the admin panel". The owner decides what goes live.' : 'Nothing waiting. Devs send their number changes here from the debug window (F2): "Send to the admin panel". Nothing they send is live until you act on it.'));
    for (const r of rows) {
      const card = el('div', 'admp-prop');
      const top = el('label', 'admp-prop-head');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = this.picked.has(r.id);
      cb.addEventListener('change', () => (cb.checked ? this.picked.add(r.id) : this.picked.delete(r.id)));
      top.append(cb, el('b', '', ` ${r.by}`), el('small', '', ` · ${new Date(r.at).toLocaleString()} (${ago(r.at)}) · ${r.changes.length} change${r.changes.length === 1 ? '' : 's'}`));
      card.append(top);
      if (r.note) card.append(el('div', 'admp-prop-note', `“${r.note}”`));
      const ul = el('ul', 'admp-prop-list');
      for (const c of r.changes) {
        const li = el('li');
        li.append(el('span', '', c.label), el('span', 'admp-prop-num', ` ${c.from ?? '?'} → `), el('b', '', String(c.to)));
        ul.append(li);
      }
      card.append(ul);
      box.append(card);
    }
    const done = this.proposals.filter((r) => r.status !== 'pending').slice(0, 5);
    if (rows.length && this.access()) {
      const owner = this.access() === 'owner';
      const all = el('button', 'mm-small', 'Select all');
      all.addEventListener('click', () => { for (const r of rows) this.picked.add(r.id); this.paint(); });
      const note = el('input');
      note.type = 'text';
      note.maxLength = 600;
      note.placeholder = 'Note for the commit or pull request (optional)';
      note.value = this.propNote;
      note.addEventListener('input', () => (this.propNote = note.value));
      const act = (op: 'pr' | 'live' | 'commit' | 'dismiss') => {
        const ids = [...this.picked];
        if (!ids.length) return;
        if (op === 'live' && !window.confirm(`Make ${ids.length} proposal${ids.length === 1 ? '' : 's'} live for everyone now?`)) return;
        if (op === 'commit' && !window.confirm(`Commit ${ids.length} proposal${ids.length === 1 ? '' : 's'} straight to the main branch on GitHub? There is no review and the live game updates on the next deploy.`)) return;
        this.hooks.send({ t: 'admin_proposals', op, ids, ...((op === 'pr' || op === 'commit') && this.propNote.trim() ? { note: this.propNote.trim() } : {}) });
      };
      const commit = el('button', 'mm-small mm-go', '⤴ Commit the ticked ones to GitHub');
      commit.title = 'Commits the ticked numbers straight to the main branch (the data files only). There is no review: the game updates on the next deploy.';
      commit.addEventListener('click', () => act('commit'));
      const pr = el('button', 'mm-small', 'One pull request with the ticked ones');
      pr.addEventListener('click', () => act('pr'));
      const del = el('button', 'mm-small', 'Delete ticked');
      del.title = 'Takes the ticked proposals off the list without applying them';
      del.addEventListener('click', () => act('dismiss'));
      const r1 = el('div', 'own-row');
      r1.append(all, commit);
      if (owner) r1.append(pr);
      r1.append(del);
      const r2 = el('div', 'own-row');
      r2.append(note);
      box.append(r1, r2);
    }
    if (done.length) {
      box.append(el('small', 'devp-dim', 'Recently handled'));
      for (const r of done) {
        const line = el('div', 'admp-prop-done', `${r.by} · ${r.changes.length} change${r.changes.length === 1 ? '' : 's'} · ${r.status === 'pr' ? 'pull request' : r.status === 'committed' ? 'committed to GitHub' : r.status}`);
        if (r.url) {
          const a = el('a', '', ' open');
          a.href = r.url;
          a.target = '_blank';
          a.rel = 'noopener';
          line.append(a);
        }
        box.append(line);
      }
    }
    return box;
  }

  /** Whether "Save for everyone" can open pull requests and skill notes reach Discord (server settings). */
  private prState(): HTMLElement {
    const o = this.op.overview;
    const box = el('div', 'admp-env');
    const pr = o?.pullRequests;
    const notes = o?.notes;
    box.append(
      el('div', `adm-state ${pr ? 'ok' : 'warn'}`, pr ? '✔ Saving numbers for everyone also opens a GitHub pull request.' : '⚠ No GITHUB_TOKEN on the server: saved numbers go live, but no pull request is opened. Set GITHUB_TOKEN (a fine-grained token for the repository with Contents and Pull requests: read and write) in the server\'s environment and restart it.'),
      el('div', `adm-state ${notes ? 'ok' : 'warn'}`, notes ? '✔ Skill notes go to Discord.' : '⚠ No Discord webhook: skill notes are not sent. Set DEV_NOTES_WEBHOOK_URL (or SUGGESTION_WEBHOOK_URL).'),
      el('div', `adm-state ${o?.ai ? 'ok' : 'warn'}`, o?.ai ? '✔ Ask Claude works in the dev panel.' : '⚠ Ask Claude is off: set ANTHROPIC_API_KEY (from console.anthropic.com) in the server\'s environment.'),
    );
    return box;
  }

  /** Every match on the server with its replay: watch it, save the file, or make the bots train on it; or upload a file. */
  private replays(): HTMLElement {
    const box = el('div');
    const top = el('div', 'own-row');
    const filters: [typeof this.feedFilter, string][] = [['all', 'All'], ['people', 'With people'], ['bots', 'Bot matches'], ['ranked', 'Ranked']];
    for (const [id, label] of filters) {
      const b = el('button', `mm-small${this.feedFilter === id ? ' mm-go' : ''}`, label);
      b.addEventListener('click', () => {
        this.feedFilter = id;
        this.paint();
      });
      top.append(b);
    }
    const up = el('label', 'mm-small admp-upload', '⬆ Train on a file…');
    const file = el('input');
    file.type = 'file';
    file.accept = '.json,.gz,.replay,application/json,application/gzip,application/octet-stream';
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      file.value = '';
      if (f) void this.upload(f);
    });
    up.append(file);
    top.append(up);
    box.append(top);
    box.append(el('p', 'mm-modal-foot', 'Every match played here, bot matches included (replays are kept for 30 days). "Train bots" makes the bots learn from it now and keeps it for offline study: from a match against bots they learn how people beat them; from a player match or a bot match, the losing classes learn from the winners (and people\u2019s habits are studied).'));
    // the owner's switch: train on every finished match without picking each one
    const auto = el('label', 'he-tgl admp-auto');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!this.op.overview?.autoTrain;
    cb.addEventListener('change', () => this.hooks.send({ t: 'admin_act', act: 'autotrain', on: cb.checked }));
    auto.append(cb, document.createTextNode(' 🧠 Train the bots on every match automatically (player matches and bot matches too)'));
    if (this.access() === 'owner') box.append(auto);
    box.append(this.liveBox());
    box.append(this.trainBanner());
    const allBtn = el('button', 'mm-small mm-go', '🧠 Train on all archived replays');
    allBtn.title = 'Plays back every replay the server kept (people against bots, and the ones you picked) one after another; replays from another version of the game are skipped and counted.';
    allBtn.disabled = this.isTraining('all-archived');
    allBtn.addEventListener('click', () => {
      this.trainMsg = null;
      this.jobs = [{ id: 'all-archived', state: 'training', startedAt: Date.now(), etaMs: 60000, progress: { done: 0, total: 0, skipped: 0 } }, ...this.jobs.filter((j) => j.id !== 'all-archived')];
      this.hooks.send({ t: 'admin_act', act: 'train_all', value: this.passes });
      this.paint();
    });
    const pass = el('select', 'mm-small');
    for (let n = 1; n <= 5; n++) pass.append(new Option(`${n} pass${n === 1 ? '' : 'es'}`, String(n), false, n === this.passes));
    pass.title = 'How many times each replay\u2019s lessons are applied (the owner\u2019s forced training). More passes make the same mistakes count for more.';
    pass.addEventListener('change', () => (this.passes = Number(pass.value)));
    const reset = el('button', 'mm-small adm-danger', 'Reset learned brain to shipped defaults');
    reset.addEventListener('click', () => {
      if (!window.confirm('Put every bot class back on the brain it ships with? Everything the bots learned (lessons, habits, counters and the log) is cleared. This cannot be undone.')) return;
      this.hooks.send({ t: 'admin_act', act: 'bot_reset' });
    });
    const learnBar = el('div', 'own-row');
    learnBar.append(allBtn, pass);
    if (this.access() === 'owner') learnBar.append(reset);
    box.append(learnBar, this.jobList(), this.knowledgeBox(), this.bugsBox());
    if (this.trainMsg) box.append(el('div', `adm-state ${this.trainMsg.ok ? 'ok' : 'warn'}`, this.trainMsg.text));
    if (!this.feed) {
      box.append(el('p', 'mm-modal-foot', 'Loading…'));
      return box;
    }
    const rows = this.feed.filter((m) => (this.feedFilter === 'bots' ? m.bots : this.feedFilter === 'people' ? !m.bots : this.feedFilter === 'ranked' ? m.ranked : true));
    if (!rows.length) box.append(el('p', 'mm-modal-foot', 'No matches yet.'));
    // batches: tick several and train them all at the same time
    const trainable = rows.filter((m) => m.replay && !this.isTraining(m.id));
    const bar = el('div', 'own-row');
    const picked = trainable.filter((m) => this.picks.has(m.id));
    const go = el('button', 'mm-small mm-go', `🧠 Train the ${picked.length} ticked`);
    go.disabled = !picked.length;
    go.addEventListener('click', () => this.trainMany(picked.map((m) => m.id)));
    const all = el('button', 'mm-small', `Tick all ${trainable.length} shown`);
    all.disabled = !trainable.length;
    all.addEventListener('click', () => {
      for (const m of trainable) this.picks.add(m.id);
      this.paint();
    });
    const none = el('button', 'mm-small', 'Clear ticks');
    none.addEventListener('click', () => {
      this.picks.clear();
      this.paint();
    });
    bar.append(go, all, none);
    box.append(bar);
    for (const m of rows) box.append(this.feedRow(m));
    return box;
  }

  private feedRow(m: MatchRecord): HTMLElement {
    const row = el('div', 'own-room');
    const info = el('div', 'own-room-info');
    const kind = m.bots ? '🤖 Bot match' : m.ranked ? 'Ranked' : 'Unranked';
    const won = m.winner === 'draw' ? 'Draw' : m.winner === null ? 'No result' : `Team ${m.winner + 1} won`;
    info.append(el('b', '', `${kind} ${m.size}v${m.size} · ${mapName(m.map)} · ${won}`), el('small', '', `${new Date(m.at).toLocaleString()} (${ago(m.at)}) · ${dur(m.durationMs)}`));
    const teams = el('span', 'admp-wrap');
    for (const t of [0, 1]) {
      const names = m.players.filter((p) => p.team === t).map((p) => `${p.name} (${CLASSES[p.classId as keyof typeof CLASSES]?.name ?? p.classId})`);
      if (names.length) teams.append(el('span', m.winner === t ? 'admp-win' : '', `${t ? ' vs ' : ''}${names.join(', ')}`));
    }
    info.append(teams);
    row.append(info);
    if (m.replay) {
      const watch = el('button', 'mm-small', '▶ Watch');
      watch.addEventListener('click', () => {
        this.close();
        this.hooks.replay(m.id);
      });
      const save = el('a', 'mm-small', '⬇ Save');
      save.href = `/api/replay/${m.id}`;
      save.download = `replay-${m.id}.json.gz`;
      save.title = 'Save the replay file (it can be uploaded here later to train on it)';
      const job = this.jobs.find((j) => j.id === m.id);
      const busy = job?.state === 'training';
      const train = el('button', 'mm-small mm-go', busy ? 'Training…' : '🧠 Train bots');
      train.disabled = busy;
      train.addEventListener('click', () => this.trainMany([m.id]));
      train.title = `Train on it (${this.passes} pass${this.passes === 1 ? '' : 'es'}; change the passes above)`;
      const tick = el('input');
      tick.type = 'checkbox';
      tick.checked = this.picks.has(m.id);
      tick.disabled = busy;
      tick.title = 'Tick to train several at once';
      tick.addEventListener('change', () => {
        if (tick.checked) this.picks.add(m.id);
        else this.picks.delete(m.id);
        this.paint();
      });
      row.prepend(tick);
      if (job) info.append(this.jobBar(job));
      row.append(watch, save, train);
    } else row.append(el('small', 'devp-dim', 'no replay'));
    // owner and devs: tell the bot brain what went wrong in a match that had bots, and see what earlier notes did
    const notes = this.knowledge?.notes.filter((n) => n.matchId === m.id) ?? [];
    if (m.players.some((p) => !p.human)) {
      const open = this.noteRows.has(m.id);
      const nb = el('button', `mm-small${open || notes.length ? ' mm-go' : ''}`, `📝 Note for the bots${notes.length ? ` (${notes.length})` : ''}`);
      nb.title = 'Say what the bots did wrong in this match, in plain words. It moves the bots\' lesson brain and shows under "What was learned".';
      nb.addEventListener('click', () => {
        if (open) this.noteRows.delete(m.id);
        else this.noteRows.add(m.id);
        this.paint();
      });
      row.append(nb);
      if (open || notes.length) {
        const wrap = el('div', 'admp-notes');
        wrap.style.cssText = 'width:calc(100% - 22px);margin:2px 0 8px 22px;box-sizing:border-box;';
        for (const n of notes) {
          const rep = this.knowledge?.reports.find((r) => r.note?.id === n.id);
          const line = el('div', 'devp-dim');
          line.textContent = `${new Date(n.at).toLocaleString()} · ${n.by}${n.role === 'owner' ? ' (owner)' : ''}${n.liveSec !== undefined ? ` · ${n.liveSec}s in` : ''} · ${rep?.headline ?? `"${n.text}"`}`;
          wrap.append(line);
          if (rep) wrap.append(this.reportLines(rep, `rep:${rep.id}`));
        }
        if (open) wrap.append(noteBox(m.id, (msg) => this.hooks.send(msg)));
        const both = el('div');
        both.append(row, wrap);
        return both;
      }
    }
    return row;
  }

  /** Bot bugs reported in notes (stuck, frozen...): no brain number fixes these. The owner marks them fixed. */
  private bugsBox(): HTMLElement {
    const d = el('details', 'admp-know');
    d.open = this.opened.has('bugs');
    d.addEventListener('toggle', () => {
      if (d.open) this.opened.add('bugs');
      else this.opened.delete('bugs');
    });
    const bugs = this.knowledge?.bugs ?? [];
    const openCount = bugs.filter((b) => !b.fixed).length;
    d.append(el('summary', '', `🐞 Bot bugs reported (${openCount} open)`));
    if (!bugs.length) d.append(el('div', 'devp-dim', 'None. A note like "the mage got stuck behind the pillar" lands here: it is a bug in what the bots can do, not a brain number.'));
    for (const b of bugs) {
      const row = el('div', 'admp-know-row');
      row.append(el('div', b.fixed ? 'devp-dim' : '', `${b.fixed ? '✔ ' : '• '}${b.text}`));
      row.append(el('small', 'devp-dim', `${b.by} · ${new Date(b.at).toLocaleString()} · match ${b.matchId}${b.fixed ? ` · fixed${b.fixedBy ? ` by ${b.fixedBy}` : ''}` : ''} `));
      const watch = el('button', 'mm-small', '▶ Watch');
      watch.addEventListener('click', () => {
        this.close();
        this.hooks.replay(b.matchId);
      });
      row.append(watch);
      if (this.access() === 'owner') {
        const fix = el('button', 'mm-small', b.fixed ? 'Reopen' : 'Mark fixed');
        fix.addEventListener('click', () => this.hooks.send({ t: 'admin_act', act: 'bug_fixed', id: b.id, on: b.fixed }));
        row.append(fix);
      }
      d.append(row);
    }
    return d;
  }

  private isTraining(id: string): boolean {
    return this.jobs.some((j) => j.id === id && j.state === 'training');
  }

  /** Start training on every one of these replays now, all at the same time. */
  private trainMany(ids: string[]) {
    this.trainMsg = null;
    for (const id of ids) {
      if (this.isTraining(id)) continue;
      // show it at once; the server's first status replaces this
      this.jobs = [{ id, state: 'training', startedAt: Date.now(), etaMs: 8000 }, ...this.jobs.filter((j) => j.id !== id)];
      if (this.passes > 1) this.hooks.send({ t: 'admin_act', act: 'train_passes', id, value: this.passes });
      else this.hooks.send({ t: 'admin_act', act: 'train', id });
      this.picks.delete(id);
    }
    this.paint();
  }

  /** A bar for one job: fills as the time passes, the time left beside it. */
  private jobBar(job: TrainJobRow): HTMLElement {
    const wrap = el('div', `admp-job ${job.state}`);
    const left = Math.max(0, job.etaMs - (Date.now() - job.startedAt));
    const frac = job.state === 'training' ? Math.min(0.95, (Date.now() - job.startedAt) / Math.max(1, job.etaMs)) : 1;
    const track = el('div', 'admp-job-track');
    const fill = el('div', 'admp-job-fill');
    fill.style.width = `${Math.round(frac * 100)}%`;
    track.append(fill);
    const label = job.state === 'training' ? (left > 0 ? `~${Math.ceil(left / 1000)}s left` : 'almost done…') : job.state === 'done' ? `Done in ${Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000)}s` : 'Failed';
    wrap.append(track, el('small', '', label));
    if (job.progress) wrap.append(el('small', 'devp-dim', ` ${job.progress.done}/${job.progress.total} replays${job.progress.skipped ? `, ${job.progress.skipped} skipped` : ''}`));
    if (job.state !== 'training' && job.text) wrap.append(el('small', 'devp-dim', ` ${job.text}`));
    if (job.report) wrap.append(this.reportLines(job.report, `job:${job.id}`));
    return wrap;
  }

  /** The lines of a report under a row, opened and closed with a click. */
  private reportLines(r: LearnReport, key: string): HTMLElement {
    const box = el('div', 'admp-report');
    const open = this.opened.has(key);
    const toggle = el('button', 'mm-small', open ? '▾ Hide what was learned' : '▸ What was learned');
    toggle.addEventListener('click', () => {
      if (open) this.opened.delete(key);
      else this.opened.add(key);
      this.paint();
    });
    box.append(toggle);
    if (open) for (const line of formatReport(r)) box.append(el('div', 'devp-dim', line));
    return box;
  }

  /** Jobs that belong to no replay row (the batch over the archive) are listed here. */
  private jobList(): HTMLElement {
    const box = el('div');
    const job = this.jobs.find((j) => j.id === 'all-archived');
    if (job) {
      box.append(el('b', '', 'All archived replays'));
      box.append(this.jobBar(job));
    }
    return box;
  }

  /**
   * Live learning: what the bots have studied in real play, whether the server keeps it, and the owner's button that commits
   * the learned bots to GitHub. Devs see the status; the button is the owner's.
   */
  private liveBox(): HTMLElement {
    const box = el('div', 'admp-live');
    box.append(el('b', '', '📡 Live learning'));
    const l = this.knowledge?.live;
    if (!l) {
      box.append(el('small', 'devp-dim', ' Loading…'));
      return box;
    }
    if (!l.persistent) box.append(el('div', 'adm-state warn', 'Learning is lost when the server restarts: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Render. (The server is using its in-memory store, so what the bots learn from live matches disappears on every restart or deploy.)'));
    const last = l.lastAt ? new Date(l.lastAt).toLocaleString() : 'never';
    box.append(el('div', '', `${l.people + l.botOnly} match${l.people + l.botOnly === 1 ? '' : 'es'} studied since the store began (${l.storeKind}): ${l.people} with people, ${l.botOnly} bot-only. Last learned: ${last}.`));
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    for (const c of l.classes) {
      const row = el('div', 'devp-dim');
      row.textContent = `${CLASSES[c.classId as keyof typeof CLASSES]?.name ?? c.classId}: ${c.people} with people, ${c.botOnly} bot-only · bots won ${c.vsWinRate === null ? 'no games yet' : `${pct(c.vsWinRate)} of ${c.vsGames} games against people`} · learned variant ${c.variant ? `wins ${pct(c.variant.winRate)} of ${c.variant.games} games` : 'has not played yet'}`;
      box.append(row);
    }
    box.append(el('small', 'devp-dim', 'Matches with people are always studied. "Train on every match" also studies bot-only matches (lower value, off by default).'));
    const c = l.lastCommit;
    const row = el('div', 'own-row');
    if (this.access() === 'owner') {
      const btn = el('button', 'mm-small mm-go', '⬆ Commit learned bots to GitHub');
      btn.title = 'Writes the brains the bots learned and the human-style data to shared/data/botbrain.json and players.json on the main branch in one commit, as a patch (version +1, patch notes). The game updates on the next deploy.';
      btn.disabled = l.sinceCommit < 1 || this.knowledge?.canCommit === false;
      btn.addEventListener('click', () => {
        if (!window.confirm(`Commit the learned bots to the main branch? It is one commit and a new patch (${l.sinceCommit} match${l.sinceCommit === 1 ? '' : 'es'} studied since the last one) and starts a deploy.`)) return;
        this.trainMsg = { ok: true, text: 'Committing the learned bots…' };
        this.hooks.send({ t: 'admin_act', act: 'bot_commit' });
        this.paint();
      });
      row.append(btn);
    }
    row.append(el('small', 'devp-dim', `${l.sinceCommit} match${l.sinceCommit === 1 ? '' : 'es'} with people studied since the last commit${c ? ` · last commit ${c.version} on ${new Date(c.at).toLocaleString()}` : ' · nothing committed yet'}${this.knowledge?.canCommit === false ? ' · no GITHUB_TOKEN on the server' : ''}`));
    if (c) {
      const a = el('a', 'mm-small', 'view');
      a.setAttribute('href', c.url);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
      row.append(a);
    }
    box.append(row);
    return box;
  }

  /** What the bots know: per class the learned numbers against the shipped ones, and the log of the last reports. */
  private knowledgeBox(): HTMLElement {
    const d = el('details', 'admp-know');
    d.open = this.opened.has('know');
    d.addEventListener('toggle', () => {
      if (d.open) this.opened.add('know');
      else this.opened.delete('know');
    });
    d.append(el('summary', '', '🧠 What the bots know'));
    const k = this.knowledge;
    if (!k) {
      d.append(el('small', 'devp-dim', 'Loading…'));
      return d;
    }
    for (const c of k.classes) {
      const row = el('div', 'admp-know-row');
      const last = c.lastAt ? new Date(c.lastAt).toLocaleString() : 'never';
      row.append(el('b', '', `${CLASSES[c.classId as keyof typeof CLASSES]?.name ?? c.classId}`), el('small', 'devp-dim', ` · ${c.replays} replay${c.replays === 1 ? '' : 's'} taught it · last learned ${last}${c.variant ? ` · learned variant wins ${Math.round(c.variant.winRate * 100)}% of ${c.variant.games} games` : ''}`));
      row.append(el('div', 'devp-dim', c.diff.length ? `Differs from the shipped brain: ${c.diff.map(moveText).join(', ')}` : 'Same as the shipped brain: nothing learned yet.'));
      // the brains in play, in the words of the learning-test marker a bot wears in a match (same records)
      for (const v of c.variants ?? []) if (v.tries.length) row.append(el('div', 'devp-dim', `🧪 ${v.label} (${v.games} game${v.games === 1 ? '' : 's'}, ${v.wins} won) is trying: ${v.tries.map((t) => t.text).join(' · ')}${v.more ? ` · and ${v.more} smaller` : ''}`));
      if (c.mistakes.length) row.append(el('div', 'devp-dim', `Mistakes seen: ${c.mistakes.slice(0, 8).map((m) => `${m.count} ${m.label}`).join(', ')}`));
      d.append(row);
    }
    d.append(el('b', '', `Last ${k.reports.length} lessons`));
    if (!k.reports.length) d.append(el('div', 'devp-dim', 'Nothing learned yet.'));
    for (const r of k.reports) {
      const line = el('div', 'admp-know-row');
      line.append(el('small', 'devp-dim', `${new Date(r.at).toLocaleString()} · ${r.source} · ${r.replayId}${r.passes > 1 ? ` · ${r.passes} passes` : ''}`), el('div', '', r.headline));
      line.append(this.reportLines(r, `rep:${r.id}`));
      d.append(line);
    }
    return d;
  }

  /** On top of the replays: what the bots are actively training on and how long is left (the longest of the batch). */
  private trainBanner(): HTMLElement {
    const active = this.jobs.filter((j) => j.state === 'training');
    const box = el('div', `admp-train ${active.length ? 'on' : ''}`);
    if (!active.length) {
      box.append(el('small', 'devp-dim', 'The bots are not training right now. Training starts the moment you press the button, and they play with what they learn as soon as it is done: there is nothing to save or deploy.'));
      return box;
    }
    const left = Math.max(...active.map((j) => Math.max(0, j.etaMs - (Date.now() - j.startedAt))));
    const head = el('div', 'admp-train-head');
    head.append(el('span', 'admp-pulse'), el('b', '', `Actively training on ${active.length} replay${active.length === 1 ? '' : 's'}`), el('small', '', left > 0 ? ` · about ${Math.ceil(left / 1000)}s left` : ' · almost done…'));
    box.append(head);
    return box;
  }

  private async upload(f: File) {
    this.trainMsg = { ok: true, text: `Training on ${f.name}…` };
    this.paint();
    try {
      const r = await fetch('/api/botlearn/upload', { method: 'POST', headers: { authorization: `Bearer ${this.hooks.token()}`, 'content-type': 'application/octet-stream' }, body: f });
      const j = (await r.json().catch(() => ({ ok: false, text: `The server said ${r.status}.` }))) as { ok: boolean; text: string };
      this.trainMsg = { ok: !!j.ok, text: j.text };
    } catch {
      this.trainMsg = { ok: false, text: 'Could not reach the server.' };
    }
    this.paint();
  }

  /** The names bots take in matches ("Bot <Name>"): one per line. Owner only; the server checks the list again. */
  private botNamesBox(): HTMLElement {
    const box = el('div', 'own-box');
    box.append(el('p', 'mm-modal-foot', `One name per line, 1 to ${BOT_NAMES_MAX} names, ${BOT_NAME_MIN_LEN} to ${BOT_NAME_MAX_LEN} letters, digits, _ or -. Each bot in a match gets a different one.`));
    const area = el('textarea');
    area.rows = 8;
    area.value = this.botNamesText ?? '';
    area.addEventListener('input', () => (this.botNamesText = area.value));
    const msg = el('p', this.botNamesMsg?.ok ? 'adm-state ok' : 'adm-state bad', this.botNamesMsg?.text ?? '');
    msg.classList.toggle('hidden', !this.botNamesMsg);
    const row = el('div', 'own-row');
    const save = el('button', 'mm-small', 'Save');
    save.addEventListener('click', () => {
      const names = area.value.split('\n');
      const v = validateBotNames(names);
      if (!v.ok) {
        this.botNamesMsg = { ok: false, text: v.error };
        return this.paint();
      }
      this.botNamesMsg = { ok: true, text: 'Saved.' };
      this.hooks.send({ t: 'admin_botnames', names: v.names });
    });
    const reset = el('button', 'mm-small', 'Reset to default');
    reset.addEventListener('click', () => {
      this.botNamesMsg = { ok: true, text: 'Back to the built-in list.' };
      this.hooks.send({ t: 'admin_botnames', names: null });
    });
    row.append(save, reset);
    box.append(area, msg, row);
    return box;
  }

  /** While on, only the owner can start matches; everyone online is told, and new players see the message. */
  private maintenance(): HTMLElement {
    const box = el('div', 'own-box');
    const on = !!this.op.overview?.maintenance;
    box.append(el('p', 'mm-modal-foot', on ? `On: "${this.op.overview!.maintenance}". Nobody but you can start a match.` : 'Off. Turning it on stops everyone but you from starting matches (matches already running finish) and tells everyone online.'));
    const row = el('div', 'own-row');
    const input = el('input');
    input.type = 'text';
    input.maxLength = 200;
    input.placeholder = 'Message (e.g. Updating, back in 10 minutes)';
    input.value = this.maintText;
    input.addEventListener('input', () => (this.maintText = input.value));
    const go = el('button', `mm-small${on ? '' : ' adm-danger'}`, on ? 'Turn off' : 'Turn on');
    go.addEventListener('click', () => this.hooks.send({ t: 'admin_act', act: 'maintenance', on: !on, text: input.value }));
    row.append(input, go);
    box.append(row);
    return box;
  }
}
