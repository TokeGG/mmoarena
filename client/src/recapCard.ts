import { ABILITIES, CLASSES } from '@arena/shared';
import type { TeamId } from '@arena/shared';
import { CLASS_ICON } from './icons';
import type { Recap } from './recap';

const n = (v: number) => Math.round(v).toLocaleString('en-US');

/** The end-of-match recap card: a table per unit from a Recap, with the MVP highlighted. */
export class RecapCard {
  private root = document.getElementById('recap') as HTMLElement;

  hide() {
    this.root.classList.add('hidden');
    this.root.replaceChildren();
  }

  show(recap: Recap, title: string, myTeam: TeamId | null) {
    const rows = recap.rows();
    if (!rows.length) return this.hide();
    const friendly = myTeam ?? 0;
    const head = document.createElement('div');
    head.className = 'recap-head';
    const t = document.createElement('b');
    t.textContent = `${title} · Match recap`;
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = 'Close';
    x.addEventListener('click', () => this.hide());
    head.append(t, x);

    const table = document.createElement('table');
    const hr = table.createTHead().insertRow();
    for (const h of ['Player', 'Damage', 'Healing', 'Taken', 'K', 'D', 'Biggest hit']) hr.insertCell().outerHTML = `<th>${h}</th>`;
    const body = table.createTBody();
    for (const r of rows) {
      const tr = body.insertRow();
      tr.className = (r.team === friendly ? 'recap-ally' : 'recap-foe') + (r.mvp ? ' recap-mvp' : '');
      const who = tr.insertCell();
      who.className = 'recap-who';
      who.textContent = `${CLASS_ICON[r.classId] ?? ''} ${r.name}`;
      who.title = CLASSES[r.classId]?.name ?? r.classId;
      if (r.mvp) {
        const m = document.createElement('span');
        m.className = 'recap-badge';
        m.textContent = 'MVP';
        who.append(m);
      }
      for (const v of [n(r.damage), n(r.healing), n(r.taken), String(r.kills), String(r.deaths)]) tr.insertCell().textContent = v;
      tr.insertCell().textContent = r.best ? `${n(r.best.amount)} ${r.best.ability ? ABILITIES[r.best.ability]?.name ?? r.best.ability : 'Auto Attack'}` : '-';
    }
    const wrap = document.createElement('div');
    wrap.className = 'recap-scroll';
    wrap.append(table);
    this.root.replaceChildren(head, wrap);
    this.root.classList.remove('hidden');
  }
}
