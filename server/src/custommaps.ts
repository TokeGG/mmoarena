import { MAP_LIMITS, checkReach, cleanCustomArena, findArena, registerCustomArenas, setDisabledMaps } from '@arena/shared';
import type { ArenaDef } from '@arena/shared';
import type { AdminLog } from './adminlog';
import type { Store } from './store';

/**
 * The owner's custom maps (the admin panel's Maps tab). They live in the server's store only, as one JSON list under
 * `custommaps`, and are registered into the shared arena lookup (registerCustomArenas) so every `arenaById` on the server finds them.
 * The server sends the whole list to every client on connect and whenever it changes. Every save is validated again here
 * (shape and geometry, then a walk-the-map check): the browser's own check is a convenience.
 *
 * Choices: a custom map is never in the random pool and never in ranked play; it can be picked by name in practice,
 * party matches, duels' practice, the owner's bot matches and the dev panel's map swap. A replay of a map that was
 * deleted since cannot be played (the client says so).
 */
const KEY = 'custommaps';
const OFF_KEY = 'mapsoff';

export type MapResult = { ok: true; id: string; text: string; warnings: string[] } | { ok: false; text: string; problems: string[] };

export class CustomMaps {
  private maps: ArenaDef[] = [];
  /** Resolves once the stored maps are read and registered. */
  ready: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private store: Store, private log?: AdminLog, /** Called after every change (the lobby tells every client). */ private onChange?: (maps: ArenaDef[]) => void) {
    this.ready = this.load();
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse((await this.store.get(KEY)) ?? '[]') as unknown;
      const out: ArenaDef[] = [];
      for (const m of Array.isArray(raw) ? raw : []) {
        // a stored map is read with the same check; one that no longer passes (limits changed) is left out
        const c = cleanCustomArena(m, out);
        if (c.arena && !c.problems.length) out.push(c.arena);
      }
      this.maps = out.slice(0, MAP_LIMITS.maps);
    } catch {
      // an unreadable store: no custom maps until it is back
    }
    try {
      const off = JSON.parse((await this.store.get(OFF_KEY)) ?? '[]') as unknown;
      this.off = (Array.isArray(off) ? off : []).filter((x): x is string => typeof x === 'string').slice(0, 200);
    } catch {
      this.off = [];
    }
    registerCustomArenas(this.maps);
    setDisabledMaps(this.off);
  }

  private off: string[] = [];

  /** Switch a map on or off for players. */
  setAvailable(by: string, id: string, on: boolean): Promise<MapResult> {
    const run = this.chain.then(async (): Promise<MapResult> => {
      await this.ready;
      const m = findArena(id);
      if (!m) return { ok: false, text: 'That map does not exist.', problems: [] };
      const next = on ? this.off.filter((x) => x !== id) : [...new Set([...this.off, id])];
      try {
        await this.store.set(OFF_KEY, JSON.stringify(next));
      } catch {
        return { ok: false, text: 'That could not be saved. Try again.', problems: [] };
      }
      this.off = next;
      setDisabledMaps(next);
      this.onChange?.(this.maps);
      void this.log?.add(by, on ? 'map on' : 'map off', id, m.name);
      return { ok: true, id, text: `${m.name} is ${on ? 'available' : 'switched off'} for players.`, warnings: [] };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  list(): ArenaDef[] {
    return this.maps;
  }

  /** Create or update (by id) a map. Resolves with the reasons when it is refused. */
  save(by: string, raw: unknown): Promise<MapResult> {
    const run = this.chain.then(() => this.doSave(by, raw));
    this.chain = run.catch(() => undefined);
    return run;
  }

  remove(by: string, id: string): Promise<MapResult> {
    const run = this.chain.then(() => this.doRemove(by, id));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async persist(next: ArenaDef[]): Promise<void> {
    await this.store.set(KEY, JSON.stringify(next));
    this.maps = next;
    registerCustomArenas(next);
    this.onChange?.(next);
  }

  private async doSave(by: string, raw: unknown): Promise<MapResult> {
    await this.ready;
    const fail = (problems: string[]): MapResult => ({ ok: false, text: problems.slice(0, 6).join(' '), problems });
    const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
    const others = this.maps.filter((m) => m.id !== id);
    const exists = this.maps.length !== others.length;
    if (!exists && this.maps.length >= MAP_LIMITS.maps) return fail([`There are already ${MAP_LIMITS.maps} custom maps. Delete one first.`]);
    const c = cleanCustomArena(raw, others);
    if (!c.arena || c.problems.length) return fail(c.problems);
    const reach = checkReach(c.arena);
    if (reach.length) return fail(reach);
    const next = exists ? this.maps.map((m) => (m.id === c.arena!.id ? c.arena! : m)) : [...this.maps, c.arena];
    try {
      await this.persist(next);
    } catch {
      return fail(['The map could not be saved. Try again.']);
    }
    void this.log?.add(by, exists ? 'map updated' : 'map created', c.arena.id, c.arena.name);
    return { ok: true, id: c.arena.id, text: `${exists ? 'Saved' : 'Created'} "${c.arena.name}".`, warnings: c.warnings };
  }

  private async doRemove(by: string, id: string): Promise<MapResult> {
    await this.ready;
    const m = this.maps.find((x) => x.id === id);
    if (!m) return { ok: false, text: 'That custom map does not exist.', problems: ['That custom map does not exist.'] };
    try {
      await this.persist(this.maps.filter((x) => x.id !== id));
    } catch {
      return { ok: false, text: 'The map could not be deleted. Try again.', problems: [] };
    }
    void this.log?.add(by, 'map deleted', id, m.name);
    return { ok: true, id, text: `Deleted "${m.name}".`, warnings: [] };
  }
}
