import { ABILITIES } from '@arena/shared';
import type { SimEvent, TeamId } from '@arena/shared';
import { iconEl } from './iconArt';

const MAX = 5;
const LIFE_MS = 6000;

export interface FeedUnit {
  name: string;
  team: TeamId;
}

/** A small fading list of kills ("Killer ⚔ Victim", with the killing ability) in a corner of the screen. */
export class KillFeed {
  private root = document.getElementById('killfeed') as HTMLElement;
  /** The last damage each unit took, to name the ability that finished it. */
  private lastHit = new Map<number, { src: number; ability: string | null }>();

  clear() {
    this.lastHit.clear();
    this.root.replaceChildren();
  }

  /** `unitOf` looks a unit up; `myTeam` is the team shown in the friendly colour (null: team 0, as when spectating). */
  event(ev: SimEvent, unitOf: (id: number) => FeedUnit | undefined, myTeam: TeamId | null) {
    if (ev.t === 'damage') {
      if (ev.amount > 0) this.lastHit.set(ev.tgt, { src: ev.src, ability: ev.ability });
      return;
    }
    if (ev.t !== 'death') return;
    const victim = unitOf(ev.unit);
    if (!victim) return;
    const killer = ev.killer !== null && ev.killer !== ev.unit ? unitOf(ev.killer) : undefined;
    const hit = this.lastHit.get(ev.unit);
    this.lastHit.delete(ev.unit);
    const friendly = myTeam ?? 0;
    const name = (u: FeedUnit) => {
      const s = document.createElement('span');
      s.className = u.team === friendly ? 'kf-ally' : 'kf-foe';
      s.textContent = u.name;
      return s;
    };
    const row = document.createElement('div');
    row.className = 'kf-row';
    if (killer) {
      const id = hit && hit.src === ev.killer ? hit.ability : null;
      const def = id ? ABILITIES[id] : undefined;
      const sword = document.createElement('span');
      sword.className = 'kf-sword';
      sword.textContent = '⚔';
      row.append(name(killer));
      if (id) {
        const ic = document.createElement('span');
        ic.className = 'kf-icon';
        ic.append(iconEl('ability', id));
        ic.title = def?.name ?? id;
        row.append(ic);
      }
      row.append(sword, name(victim));
      if (id || hit) {
        const ab = document.createElement('span');
        ab.className = 'kf-ability';
        ab.textContent = id ? def?.name ?? id : 'Auto Attack';
        row.append(ab);
      }
    } else row.append(name(victim));
    this.root.append(row);
    while (this.root.children.length > MAX) this.root.firstElementChild?.remove();
    setTimeout(() => row.classList.add('kf-out'), LIFE_MS);
    setTimeout(() => row.remove(), LIFE_MS + 600);
  }
}
