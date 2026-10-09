import { fileDefault, isSwitch, mergePatches, nameOf, plainPath, valueHint } from '@arena/shared';
import type { DataPatch, DevField } from '@arena/shared';

/** The key two patches share when they change the same value. */
export const patchKey = (p: Pick<DataPatch, 'file' | 'id' | 'path'>) => `${p.file}:${p.id}:${p.path.join('.')}`;

/** One line of the "changes so far" list. */
export interface ChangeRow {
  key: string;
  patch: DataPatch;
  /** What the thing is ("Warden", "Pyroblast"). */
  owner: string;
  /** What changes, in plain words. */
  label: string;
  /** The value in the data file. */
  from: number | string;
  to: number | string;
  /** Not sent yet (typed in the panel), against already being tried or proposed. */
  pending: boolean;
  /** The same two values in words ("1.5 (+50%)", "on"). */
  fromText: string;
  toText: string;
}

/** A value as a row shows it: a switch as on or off, a number with its plain meaning ("1.5 (+50%)"). */
export const showValue = (p: Pick<DataPatch, 'file' | 'id' | 'path'>, v: number | string): string => {
  if (isSwitch(p)) return Number(v) === 1 ? 'on' : 'off';
  if (typeof v !== 'number') return String(v);
  const hint = valueHint(plainPath(p.file, p.id, p.path).unit, v);
  return hint ? `${Math.round(v * 10000) / 10000} (${hint})` : String(Math.round(v * 10000) / 10000);
};

/**
 * What a dev has typed in the debug panel or the Tuning tab and not sent yet, and the numbers they put back to the file's
 * value. No DOM here: the pages draw it and the buttons ask it for the patches to send. `testing` is the patches already in
 * effect (the match's test numbers, the session's, or what is proposed).
 */
export class EditSet {
  /** Typed values by patch key. */
  readonly edits = new Map<string, DataPatch>();
  /** Values being tried that the dev put back to the file's number (they leave the list when it is sent). */
  readonly reverted = new Set<string>();

  clear(): void {
    this.edits.clear();
    this.reverted.clear();
  }

  get size(): number {
    return this.edits.size + this.reverted.size;
  }

  /** Set a field to a value; one equal to the file's value is the same as putting it back. */
  set(f: Pick<DevField, 'file' | 'id' | 'path' | 'base' | 'value'>, value: number | string, testing: ReadonlyMap<string, DataPatch>, canRevert = true): void {
    const k = patchKey(f);
    if (String(value) === String(f.base)) {
      this.edits.delete(k);
      if (canRevert && testing.has(k)) this.reverted.add(k);
      // the value differs from the file only because of a number saved for everyone: say the file's number outright
      else if (String(f.value) !== String(f.base) && !testing.has(k)) this.edits.set(k, { file: f.file, id: f.id, path: f.path, value });
      return;
    }
    this.reverted.delete(k);
    this.edits.set(k, { file: f.file, id: f.id, path: f.path, value });
  }

  /** The value a field shows: what was typed, else the file's number if it was put back, else what is being tried, else the live number. */
  shown(f: DevField, testing: ReadonlyMap<string, DataPatch>): number | string {
    const k = patchKey(f);
    const e = this.edits.get(k);
    if (e) return e.value;
    if (this.reverted.has(k)) return f.base;
    const t = testing.get(k);
    return t ? t.value : f.value;
  }

  /** Differs from the data file (typed, being tried, or already live). */
  changed(f: DevField, testing: ReadonlyMap<string, DataPatch>): boolean {
    return String(this.shown(f, testing)) !== String(f.base);
  }

  /** Not sent yet. */
  pending(f: Pick<DevField, 'file' | 'id' | 'path'>): boolean {
    const k = patchKey(f);
    return this.edits.has(k) || this.reverted.has(k);
  }

  /** The patches to send: the ones already in effect minus those put back, with what was typed on top. */
  patches(inEffect: readonly DataPatch[]): DataPatch[] {
    return mergePatches(
      inEffect.filter((p) => !this.reverted.has(patchKey(p))),
      [...this.edits.values()],
    );
  }

  /** Every change that would be in effect after sending, as old -> new rows (typed ones first). */
  rows(inEffect: readonly DataPatch[]): ChangeRow[] {
    const typed = new Set(this.edits.keys());
    const out: ChangeRow[] = [];
    for (const p of this.patches(inEffect)) {
      const key = patchKey(p);
      const from = fileDefault(p) ?? '?';
      const pl = plainPath(p.file, p.id, p.path);
      out.push({
        key, patch: p, owner: nameOf(p.file, p.id), label: pl.label, from, to: p.value, pending: typed.has(key),
        fromText: showValue(p, from as number | string), toText: showValue(p, p.value),
      });
    }
    // typed first, then the rest
    return out.sort((a, b) => Number(b.pending) - Number(a.pending));
  }

  /** Undo one row: a typed change is forgotten, one being tried goes back to the file's number. */
  undo(key: string, testing: ReadonlyMap<string, DataPatch>, canRevert = true): void {
    this.edits.delete(key);
    if (canRevert && testing.has(key)) this.reverted.add(key);
  }

  /** Put back everything (typed or being tried) on some files: a page's reset. */
  resetFiles(files: readonly DataPatch['file'][], inEffect: readonly DataPatch[], canRevert = true): void {
    for (const [k, p] of [...this.edits]) if (files.includes(p.file)) this.edits.delete(k);
    if (canRevert) for (const p of inEffect) if (files.includes(p.file)) this.reverted.add(patchKey(p));
  }

  /** Put back every value. */
  resetAll(inEffect: readonly DataPatch[], canRevert = true): void {
    this.edits.clear();
    if (canRevert) for (const p of inEffect) this.reverted.add(patchKey(p));
  }
}
