import { CUSTOM_SOUND_LIMIT_BYTES, SOUND_LIBRARY, customSounds, setCustomSounds } from '@arena/shared';
import { el } from './bar';

/**
 * The Sounds page of the dev panel: listening to a sound or a recording, uploading a recording of your own, and the library
 * list. Uploads live in the server's store (server/src/customsounds.ts) and are served at /audio/custom/<name>; a sound uses one
 * by choosing it in its Recording list, like any library recording.
 */

/** Set by main.ts: play a sound as it is set now (`file` tries a recording first). */
export const soundHooks: { preview: (id: string, file?: string) => void } = { preview: () => undefined };

const sessionToken = (): string => {
  try {
    return localStorage.getItem('arena.session.v1') ?? ''; // accountUi.ts SESSION_KEY
  } catch {
    return '';
  }
};

let loaded = false;
/** Ask the server for the uploaded recordings and offer them in every Recording list. */
export async function loadCustomSounds(force = false): Promise<boolean> {
  if (loaded && !force) return false;
  loaded = true;
  try {
    const r = await fetch('/api/sounds/custom', { cache: 'no-store' });
    if (!r.ok) return false;
    const j = (await r.json()) as { sounds?: { file: string; label: string }[] };
    const before = JSON.stringify(customSounds());
    setCustomSounds(Array.isArray(j.sounds) ? j.sounds : []);
    return before !== JSON.stringify(customSounds());
  } catch {
    return false;
  }
}

const toBase64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

export type UploadResult = { ok: true; file: string } | { ok: false; text: string };

export async function uploadSound(f: File): Promise<UploadResult> {
  if (!/\.(mp3|ogg|wav)$/i.test(f.name)) return { ok: false, text: 'Use an mp3, ogg or wav file.' };
  if (f.size > CUSTOM_SOUND_LIMIT_BYTES) return { ok: false, text: `That file is too big (${Math.round(f.size / 1000)} KB; the limit is ${Math.round(CUSTOM_SOUND_LIMIT_BYTES / 1000)} KB). Trim it or save it as mp3.` };
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const r = await fetch('/api/sounds/custom', { method: 'POST', headers: { authorization: `Bearer ${sessionToken()}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name, data: toBase64(bytes) }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; file?: string; text?: string };
    if (!r.ok || !j.ok || !j.file) return { ok: false, text: j.text ?? 'The upload did not work.' };
    await loadCustomSounds(true);
    return { ok: true, file: j.file };
  } catch {
    return { ok: false, text: 'The server could not be reached.' };
  }
}

export async function deleteSound(file: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/sounds/custom/${encodeURIComponent(file.replace(/^custom\//, ''))}`, { method: 'DELETE', headers: { authorization: `Bearer ${sessionToken()}` } });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; text?: string };
    if (!r.ok || !j.ok) return j.text ?? 'That did not work.';
    await loadCustomSounds(true);
    return null;
  } catch {
    return 'The server could not be reached.';
  }
}

/** The line of tools at the top of one sound's page: Play, and uploading a recording of your own for it. */
export function soundTools(box: HTMLElement, o: { id: string; setFile: (file: string) => void; redraw: () => void }): void {
  const row = el('div', 'devp-row devp-links');
  const play = el('button', 'mm-small mm-go', '▶ Play');
  play.title = 'Hear it as it is set now';
  play.addEventListener('click', () => soundHooks.preview(o.id));
  const input = el('input');
  input.type = 'file';
  input.accept = '.mp3,.ogg,.wav,audio/mpeg,audio/ogg,audio/wav';
  input.hidden = true;
  const up = el('button', 'mm-small', 'Upload your own…');
  up.title = 'Pick an mp3, ogg or wav (up to 1.5 MB). It is saved on the server and used for this sound at once.';
  const note = el('small', 'devp-dim', '');
  up.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    note.textContent = 'Uploading…';
    const r = await uploadSound(f);
    if (!r.ok) {
      note.textContent = r.text;
      return;
    }
    o.setFile(r.file);
    note.textContent = `Saved as ${r.file} and set for this sound.`;
    o.redraw();
  });
  row.append(play, up, input, note);
  box.append(row);
}

/** A recording of the library (or an upload) in the listening list: Play, and for an upload, Delete. */
export function libraryPage(box: HTMLElement, file: string, redraw: () => void): void {
  const lib = SOUND_LIBRARY.find((x) => x.file === file);
  const mine = customSounds().find((x) => x.file === file);
  const row = el('div', 'devp-row devp-links');
  const play = el('button', 'mm-small mm-go', '▶ Play');
  play.addEventListener('click', () => soundHooks.preview('', file));
  row.append(play);
  if (!lib && mine) {
    const del = el('button', 'mm-small', 'Delete this upload');
    const note = el('small', 'devp-dim', '');
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the uploaded recording "${mine.label}"? Sounds that use it go back to the built-in sound.`)) return;
      const err = await deleteSound(file);
      if (err) note.textContent = err;
      else redraw();
    });
    row.append(del, note);
  }
  box.append(row);
}
