import type { ClassId, SimEvent, TeamId } from '@arena/shared';

/** The unit facts a recap row needs (a subset of UnitSnap). */
export interface RecapUnit {
  id: number;
  name: string;
  team: TeamId;
  classId: ClassId;
  /** A Mirror Image: the unit id of the caster it copies. Images never get a row; what they do counts for their caster. */
  img?: number;
}

export interface RecapRow extends RecapUnit {
  damage: number;
  healing: number;
  taken: number;
  kills: number;
  deaths: number;
  /** The biggest single hit dealt: its ability id (null = auto attack) and amount; null amount-less when nothing landed. */
  best: { ability: string | null; amount: number } | null;
  /** Rating used to pick the MVP. */
  score: number;
  mvp: boolean;
}

interface Tally {
  damage: number;
  healing: number;
  taken: number;
  kills: number;
  deaths: number;
  best: { ability: string | null; amount: number } | null;
}

const blank = (): Tally => ({ damage: 0, healing: 0, taken: 0, kills: 0, deaths: 0, best: null });

/** Adds up a match's damage, healing and kills from the sim events, for the end-of-match recap card. */
export class Recap {
  private tally = new Map<number, Tally>();
  private units = new Map<number, RecapUnit>();
  private owners = new Map<number, number>();

  reset() {
    this.tally.clear();
    this.units.clear();
    this.owners.clear();
  }

  /** Remember who the units are (call with each snapshot's units; later calls refresh names). */
  setUnits(units: RecapUnit[]) {
    for (const u of units) {
      if (u.img !== undefined) this.owners.set(u.id, u.img);
      else this.units.set(u.id, { id: u.id, name: u.name, team: u.team, classId: u.classId });
    }
  }

  private of(id: number): Tally {
    let t = this.tally.get(id);
    if (!t) this.tally.set(id, (t = blank()));
    return t;
  }

  add(ev: SimEvent) {
    switch (ev.t) {
      case 'damage':
        if (ev.amount <= 0) break;
        if (ev.tgt > 0 && !this.owners.has(ev.tgt)) this.of(ev.tgt).taken += ev.amount;
        if (ev.src > 0) {
          const s = this.of(this.owners.get(ev.src) ?? ev.src);
          s.damage += ev.amount;
          if (!s.best || ev.amount > s.best.amount) s.best = { ability: ev.ability, amount: ev.amount };
        }
        break;
      case 'heal':
        if (ev.amount > 0 && ev.src > 0) this.of(this.owners.get(ev.src) ?? ev.src).healing += ev.amount;
        break;
      case 'death':
        if (this.owners.has(ev.unit)) break; // an image falling is not a death
        if (ev.unit > 0) this.of(ev.unit).deaths++;
        if (ev.killer !== null && ev.killer > 0 && ev.killer !== ev.unit) this.of(this.owners.get(ev.killer) ?? ev.killer).kills++;
        break;
      default:
        break;
    }
  }

  /** Whether anything has been counted. */
  get empty(): boolean {
    return this.tally.size === 0;
  }

  /** One row per known unit, best performer first; exactly one row (the top score) is the MVP. */
  rows(): RecapRow[] {
    const rows: RecapRow[] = [];
    for (const [id, u] of this.units) {
      const t = this.tally.get(id) ?? blank();
      const score = t.damage + t.healing * 0.9 + t.kills * 1500 - t.deaths * 500;
      rows.push({ ...u, ...t, score, mvp: false });
    }
    rows.sort((a, b) => b.score - a.score || a.id - b.id);
    if (rows.length && rows[0].score > 0) rows[0].mvp = true;
    return rows;
  }
}
