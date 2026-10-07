import type { PartyInfo } from '@arena/shared';

/** Name tags floating over each party member's model in the lobby: a green check when ready, a crown on the leader. */
export class LobbyTags {
  private root = document.createElement('div');
  private tags = new Map<string, HTMLElement>();

  constructor() {
    this.root.className = 'lobby-tags hidden';
    document.body.append(this.root);
  }

  hide() {
    this.root.classList.add('hidden');
  }

  show(party: PartyInfo, placed: { name: string; x: number; z: number }[], project: (x: number, y: number, z: number) => { x: number; y: number; visible: boolean }) {
    this.root.classList.remove('hidden');
    const keep = new Set<string>();
    for (const p of placed) {
      const m = party.members.find((x) => x.name === p.name);
      if (!m) continue;
      keep.add(p.name);
      let tag = this.tags.get(p.name);
      if (!tag) {
        tag = document.createElement('div');
        this.tags.set(p.name, tag);
        this.root.append(tag);
      }
      const ready = m.ready;
      const text = `${ready ? '✔' : '…'} ${party.leader === m.name ? '👑 ' : ''}${m.name}`;
      if (tag.textContent !== text) tag.textContent = text;
      tag.className = `lobby-tag ${ready ? 'ready' : 'wait'}`;
      const s = project(p.x, 2.35, p.z);
      tag.style.display = s.visible ? '' : 'none';
      tag.style.left = `${s.x}px`;
      tag.style.top = `${s.y}px`;
    }
    for (const [name, el] of this.tags) {
      if (!keep.has(name)) {
        el.remove();
        this.tags.delete(name);
      }
    }
  }
}
