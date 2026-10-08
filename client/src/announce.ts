import type { ServerMsg } from '@arena/shared';

/**
 * The owner's announcement: a big banner across the top middle of the screen (over the menu or a match), with who sent
 * it and when, until it is closed or has had time to be read. A newer one replaces it.
 */
export class AnnounceBanner {
  private root: HTMLElement | null = null;
  private timer = 0;
  private lastAt = 0;

  show(m: Extract<ServerMsg, { t: 'announce' }>, onShow?: () => void) {
    if (m.at === this.lastAt) return; // the same one again (a reconnect)
    this.lastAt = m.at;
    this.hide();
    const root = document.createElement('div');
    root.className = 'announce';
    root.setAttribute('role', 'alert');
    const head = document.createElement('div');
    head.className = 'announce-head';
    head.textContent = `📣 Announcement from ${m.by}`;
    const time = document.createElement('small');
    time.textContent = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    head.append(time);
    const close = document.createElement('button');
    close.className = 'announce-x';
    close.textContent = '✕';
    close.title = 'Close';
    close.addEventListener('click', () => this.hide());
    const text = document.createElement('div');
    text.className = 'announce-text';
    text.textContent = m.text;
    root.append(close, head, text);
    document.body.append(root);
    // fade in without waiting for an animation frame (a busy match, or a background tab, can hold those back)
    void root.offsetWidth;
    root.classList.add('in');
    this.root = root;
    // long enough to read: 15 s, plus a little per word
    const words = m.text.split(/\s+/).length;
    this.timer = window.setTimeout(() => this.hide(), 15000 + words * 400);
    onShow?.();
  }

  hide() {
    window.clearTimeout(this.timer);
    const r = this.root;
    this.root = null;
    if (!r) return;
    r.classList.remove('in');
    window.setTimeout(() => r.remove(), 300);
  }
}
