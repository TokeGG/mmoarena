import { GEAR, itemById, itemColor, perkById, rarityOf } from '@arena/shared';
import type { StatId } from '@arena/shared';

/** The "you got loot" screen shown on the main menu after a match. Items queue up and are shown together. */

const STAT_ORDER: StatId[] = ['power', 'vitality', 'haste', 'resilience'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export class LootUi {
  private drops: string[] = [];
  private discarded: string[] = [];
  private modal: HTMLElement | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if ((e.code === 'Escape' || e.code === 'Enter') && this.modal) this.close();
    });
  }

  /** Remember new loot; call `flush` when the menu is on screen. */
  add(drops: string[], discarded: string[]) {
    this.drops.push(...drops);
    this.discarded.push(...discarded);
  }

  flush() {
    if (!this.drops.length || this.modal) return;
    const modal = el('div', 'mm-modal loot-modal');
    modal.addEventListener('mousedown', (e) => e.target === modal && this.close());
    const card = el('div', 'mm-modal-card loot-card');
    card.append(el('h2', '', this.drops.length === 1 ? 'Loot!' : `Loot! ${this.drops.length} items`));
    const row = el('div', 'loot-cards');
    for (const id of this.drops) {
      const item = itemById(id);
      if (!item) continue;
      const rarity = rarityOf(item.rarity ?? '');
      const c = el('div', `loot-item r-${item.rarity}`);
      c.style.setProperty('--q', itemColor(item));
      const slot = GEAR.slots.find((s) => s.id === item.slot);
      c.append(el('div', 'li-rarity', rarity?.name ?? ''), el('div', 'li-icon', slot?.icon ?? '✦'), el('div', 'li-name', item.name), el('div', 'li-slot', slot?.name ?? ''));
      for (const s of STAT_ORDER) if (item.stats[s] > 0) c.append(el('div', 'li-stat', `+${item.stats[s]} ${GEAR.stats[s].name}`));
      const perk = perkById(item.perk);
      if (perk) c.append(el('div', 'li-perk', `✦ ${perk.name}: ${perk.desc}`));
      row.append(c);
    }
    card.append(row);
    if (this.discarded.length) {
      card.append(el('div', 'mm-modal-foot', `Inventory full: ${this.discarded.length} older item${this.discarded.length === 1 ? ' was' : 's were'} discarded to make room.`));
    }
    card.append(el('div', 'mm-modal-foot', 'Equip it from the Gear slots. Auto-equip picks the best match for your chosen style.'));
    const ok = el('button', 'mm-btn primary', 'Nice');
    ok.addEventListener('click', () => this.close());
    card.append(ok);
    modal.append(card);
    document.body.append(modal);
    this.modal = modal;
    this.drops = [];
    this.discarded = [];
  }

  private close() {
    this.modal?.remove();
    this.modal = null;
  }
}
