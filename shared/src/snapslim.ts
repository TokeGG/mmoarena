import type { Snapshot, UnitSnap } from './types';

/**
 * Lighter snapshots. What never changes during a match (who a unit is: name, class, spec, look, bar, trinket, resource kind)
 * is sent once per team as `info` and again only when it changes; every tick's snapshot then carries only the state.
 * The client merges the two back into ordinary full `UnitSnap`s in one place (`SnapMerger`), so nothing else changes.
 * Spectators, the live feed for the owner and replays keep using full snapshots; the merger passes full units through.
 */
export type UnitInfo = Pick<UnitSnap, 'id' | 'name' | 'team' | 'classId' | 'spec' | 'look' | 'bar' | 'trinket' | 'stealthSwaps' | 'resourceType'>;
export type SlimUnit = Omit<UnitSnap, 'name' | 'team' | 'classId' | 'spec' | 'look' | 'bar' | 'trinket' | 'stealthSwaps' | 'resourceType'>;
export type SlimSnapshot = Omit<Snapshot, 'units'> & { units: (UnitSnap | SlimUnit)[] };

export function infoOf(u: UnitSnap): UnitInfo {
  return {
    id: u.id, name: u.name, team: u.team, classId: u.classId, spec: u.spec, look: u.look, resourceType: u.resourceType,
    ...(u.bar ? { bar: u.bar } : {}),
    ...(u.trinket ? { trinket: u.trinket } : {}),
    ...(u.stealthSwaps ? { stealthSwaps: u.stealthSwaps } : {}),
  };
}

function slimOf(u: UnitSnap): SlimUnit {
  const { name: _n, team: _t, classId: _c, spec: _s, look: _l, bar: _b, trinket: _tr, stealthSwaps: _ss, resourceType: _r, ...rest } = u;
  return rest;
}

/** Remembers what a group of recipients (a team) has been sent, so identity goes out once and again only when it changes. */
export class SlimEncoder {
  private known = new Map<number, string>();

  /**
   * Splits a full snapshot. `info` holds the identity of units new or changed since the last call; with `all`, every unit
   * in the snapshot (for someone who has seen nothing yet).
   */
  encode(snap: Snapshot): { snap: SlimSnapshot; info: UnitInfo[]; allInfo: UnitInfo[] } {
    const info: UnitInfo[] = [];
    const allInfo: UnitInfo[] = [];
    for (const u of snap.units) {
      const i = infoOf(u);
      allInfo.push(i);
      const key = JSON.stringify(i);
      if (this.known.get(u.id) !== key) {
        this.known.set(u.id, key);
        info.push(i);
      }
    }
    return { snap: { ...snap, units: snap.units.map(slimOf) }, info, allInfo };
  }
}

const isFull = (u: UnitSnap | SlimUnit): u is UnitSnap => typeof (u as UnitSnap).name === 'string' && (u as UnitSnap).classId !== undefined;

/** Client side: rebuilds full `UnitSnap`s from slim units and the identity received so far. Full units pass straight through. */
export class SnapMerger {
  private infos = new Map<number, UnitInfo>();

  merge(snap: Snapshot | SlimSnapshot, info?: readonly UnitInfo[]): Snapshot {
    if (info) for (const i of info) this.infos.set(i.id, i);
    const units: UnitSnap[] = [];
    for (const u of snap.units) {
      if (isFull(u)) {
        this.infos.set(u.id, infoOf(u)); // a full unit also teaches the identity (a paused frame, a spectator feed)
        units.push(u);
        continue;
      }
      const i = this.infos.get(u.id);
      if (i) units.push({ ...u, ...i });
    }
    return { ...snap, units };
  }
}
