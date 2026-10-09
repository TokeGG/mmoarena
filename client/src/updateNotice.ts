import { compareVersions } from './patchSeen';

/** Whether the server runs a different build than this page loaded (an update went live, or was rolled back). */
export const needsRefresh = (loaded: string, running: unknown): running is string => typeof running === 'string' && /^\d+(\.\d+)*$/.test(running) && compareVersions(running, loaded) !== 0;

/**
 * Tells people when a new version of the game has gone live, so they know to refresh. A deploy restarts the server and
 * drops every connection, so the page asks the server's status page what it runs: right after a connection closes (retrying
 * until the server answers) and every few minutes while it stays open. Shows a small banner with a Refresh button.
 */
export class UpdateNotice {
  private root: HTMLElement | null = null;
  private shownFor = '';
  private timer = 0;

  constructor(private loaded: string, private fetchStatus: () => Promise<unknown> = () => fetch('/api/status', { cache: 'no-store' }).then((r) => r.json())) {}

  /** Ask once; true when a different version is running (the banner is up). */
  async check(): Promise<boolean> {
    try {
      const s = (await this.fetchStatus()) as { version?: unknown } | null;
      const v = s?.version;
      if (!needsRefresh(this.loaded, v)) return false;
      this.show(v);
      return true;
    } catch {
      return false;
    }
  }

  /** A connection just closed: the server may be restarting, so ask now and again every few seconds for about two minutes. */
  afterDrop(): void {
    window.clearTimeout(this.timer);
    let tries = 0;
    const go = async () => {
      if (await this.check()) return;
      if (++tries < 24) this.timer = window.setTimeout(go, 5000);
    };
    this.timer = window.setTimeout(go, 3000);
  }

  /** Ask now and then while the page stays open. */
  watch(everyMs = 180_000): void {
    window.setInterval(() => void this.check(), everyMs);
  }

  private show(version: string): void {
    if (this.shownFor === version && this.root?.isConnected) return;
    this.hide();
    this.shownFor = version;
    const root = document.createElement('div');
    root.className = 'update-notice';
    root.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = `New update available (v${version}). Refresh to play it.`;
    const go = document.createElement('button');
    go.className = 'big primary';
    go.textContent = 'Refresh';
    go.addEventListener('click', () => window.location.reload());
    const later = document.createElement('button');
    later.className = 'update-x';
    later.textContent = '✕';
    later.title = 'Later';
    later.addEventListener('click', () => this.hide());
    root.append(text, go, later);
    document.body.append(root);
    this.root = root;
  }

  private hide(): void {
    this.root?.remove();
    this.root = null;
  }
}
