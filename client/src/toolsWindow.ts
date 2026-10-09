import { makeResizable } from './resizable';
import type { Popup } from './popups';
import type { DevPanel } from './devPanel';
import type { AdminPanel } from './adminPanel';
import { TOOLS_TAB_LABEL, f2Decision, loadTab, pickTab, saveTab, visibleTabs } from './toolsLogic';
import type { ToolsAccount, ToolsTab } from './toolsLogic';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/**
 * One window for the Dev tools and the Admin panel, like a browser: a strip of tabs on top ("Dev" and "Admin", then the
 * pause button, the match status and the close button), and under it the panel of the tab picked, each with its own row
 * of tabs. The 🛠 button (kept by the Dev panel) and F2 open it anywhere the account has access: the menu, a match, a
 * watched match or replay, the end screen. The server decides what each tab may do; this only shapes what shows.
 */
export class ToolsWindow {
  readonly root = el('div', 'tw hidden');
  private strip = el('div', 'tw-strip');
  private body = el('div', 'tw-body');
  private opened = false;
  private current: ToolsTab | null = null;
  private remembered: ToolsTab | null = loadTab();
  private pending = 0;
  private visKey = '';
  readonly popup: Popup = { isOpen: () => this.opened, close: () => this.hide(), el: () => this.root };

  constructor(private dev: DevPanel, private admin: AdminPanel, private account: () => ToolsAccount | null) {
    this.root.dataset.tour = 'tools-window';
    this.body.append(dev.root, admin.root);
    this.root.append(this.strip, this.body);
    document.body.append(this.root);
    makeResizable(this.root, { key: 'tools', corner: 'br', minW: 320, minH: 280, z: 62 });
    this.draggable();
    dev.onChrome = () => this.opened && this.paintStrip();
    dev.onGone = () => this.hide();
    dev.onButton = () => this.toggle();
    admin.setWindow({ show: () => this.show('admin'), hide: () => this.hide() });
    this.paintHosts();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  get tab(): ToolsTab | null {
    return this.opened ? this.current : null;
  }

  /** Called every frame: the button and the open window follow the account (cheap while nothing changes). */
  sync() {
    const vis = visibleTabs(this.account());
    const key = vis.join();
    if (key === this.visKey) return;
    this.visKey = key;
    this.dev.setButton(vis.length > 0);
    if (!vis.length) return void this.hide();
    if (this.opened) {
      const t = pickTab(vis, this.current, null)!;
      if (t !== this.current) this.switchTo(t);
      else this.paintStrip();
    }
  }

  /** The number of dev proposals nobody has checked yet (the badge on the Admin tab). */
  setPending(n: number) {
    if (n === this.pending) return;
    this.pending = n;
    if (this.opened) this.paintStrip();
  }

  /** Open the window on `tab` (default: the remembered one). Returns false when this account has no tabs. */
  show(tab?: ToolsTab): boolean {
    const vis = visibleTabs(this.account());
    this.visKey = vis.join();
    const t = pickTab(vis, tab, this.remembered);
    if (!t) return false;
    this.dev.setButton(true);
    if (!this.opened) {
      this.opened = true;
      this.root.classList.remove('hidden');
    }
    this.switchTo(t);
    return true;
  }

  hide() {
    if (!this.opened) return;
    this.leave(this.current);
    this.opened = false;
    this.root.classList.add('hidden');
  }

  toggle() {
    if (this.opened) this.hide();
    else this.show();
  }

  /** F2 (Shift+F2 switches the tab). Returns whether the key was used. */
  f2(shift: boolean): boolean {
    const d = f2Decision({ visible: visibleTabs(this.account()), open: this.opened, tab: this.opened ? this.current : this.remembered, shift });
    if (d.kind === 'ignore') return false;
    if (d.kind === 'close') this.hide();
    else this.show(d.tab);
    return true;
  }

  private leave(t: ToolsTab | null) {
    if (t === 'dev') this.dev.setShown(false);
    else if (t === 'admin') this.admin.deactivate();
  }

  private switchTo(t: ToolsTab) {
    if (t !== this.current || !this.isActive(t)) {
      this.leave(this.current);
      this.current = t;
      this.remembered = t;
      saveTab(t);
      this.paintHosts();
      this.paintStrip();
      if (t === 'dev') this.dev.setShown(true);
      else this.admin.activate();
    } else this.paintStrip();
  }

  private isActive(t: ToolsTab): boolean {
    return t === 'dev' ? this.dev.open : this.admin.isOpen;
  }

  private paintHosts() {
    this.dev.root.classList.toggle('hidden', this.current !== 'dev');
    this.admin.root.classList.toggle('hidden', this.current !== 'admin');
  }

  private paintStrip() {
    const vis = visibleTabs(this.account());
    this.strip.replaceChildren();
    for (const t of vis) {
      const b = el('button', `tw-tab${t === this.current ? ' sel' : ''}`, TOOLS_TAB_LABEL[t]);
      b.dataset.tour = `tools-tab-${t}`;
      b.title = t === 'dev' ? 'Dev tools: change numbers, try them, match tools' : 'Admin panel: players, matches, replays, tuning, server';
      if (t === 'admin' && this.pending > 0) {
        const n = el('span', 'tw-badge', String(this.pending));
        n.title = `${this.pending} dev proposal${this.pending === 1 ? '' : 's'} not checked yet`;
        b.append(n);
      }
      b.addEventListener('click', () => this.switchTo(t));
      this.strip.append(b);
    }
    this.strip.append(el('span', 'tw-grow'));
    if (this.current === 'dev') {
      this.strip.append(el('small', 'tw-status', this.dev.statusText()));
      if (this.dev.matchMode) {
        const pause = el('button', `mm-small${this.dev.isPaused ? ' mm-go' : ''}`, this.dev.isPaused ? '▶ Resume' : '⏸ Pause');
        pause.addEventListener('click', () => this.dev.togglePause());
        this.strip.append(pause);
      }
    }
    const close = el('button', 'mm-small tw-close', '✕');
    close.title = 'Close (F2)';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.hide());
    this.strip.append(close);
  }

  /** Drag the window by the tab strip; where you leave it is remembered. */
  private draggable() {
    const KEY = 'arena.pos.tools';
    const place = (x: number, y: number) => {
      const w = this.root.offsetWidth || 300;
      this.root.style.left = `${Math.max(0, Math.min(x, window.innerWidth - Math.min(w, 120)))}px`;
      this.root.style.top = `${Math.max(0, Math.min(y, window.innerHeight - 40))}px`;
    };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as [number, number] | null;
      if (Array.isArray(saved) && saved.every((n) => Number.isFinite(n))) place(saved[0], saved[1]);
    } catch {
      /* default spot */
    }
    let drag: { dx: number; dy: number } | null = null;
    this.strip.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const r = this.root.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      this.strip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.strip.addEventListener('pointermove', (e) => {
      if (drag) place(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      try {
        localStorage.setItem(KEY, JSON.stringify([parseInt(this.root.style.left, 10), parseInt(this.root.style.top, 10)]));
      } catch {
        /* not remembered */
      }
    };
    this.strip.addEventListener('pointerup', end);
    this.strip.addEventListener('pointercancel', end);
  }
}
