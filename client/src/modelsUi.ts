import { CUSTOM_MODEL_LIMIT_BYTES, customModels } from '@arena/shared';
import { el } from './bar';
import { deleteModel, loadCustomModelList, uploadModel } from './customModels';

/**
 * The upload box at the top of the Models page: pick a .glb (or drop it on the box), it is kept on the server, and every
 * "your own model" list of the page offers it. A body part, a whole body or a weapon uses one by choosing it in its list.
 */
let asked = false;
export function modelUploadBox(box: HTMLElement, redraw: () => void): void {
  if (!asked) {
    asked = true;
    void loadCustomModelList().then((changed) => changed && redraw());
  }
  const d = el('details', 'devp-sec');
  d.open = customModels().length === 0;
  d.append(el('summary', '', `Your uploaded models (${customModels().length})`));
  const row = el('div', 'devp-row devp-links');
  const input = el('input');
  input.type = 'file';
  input.accept = '.glb,model/gltf-binary';
  input.multiple = true;
  input.hidden = true;
  const up = el('button', 'mm-small mm-go', 'Upload a model…');
  up.title = `A .glb up to ${CUSTOM_MODEL_LIMIT_BYTES / 1e6} MB. Hands, heads, weapons and other parts are fitted by the "your own model" lists below; a whole body must be rigged with the game's bone names.`;
  const note = el('small', 'devp-dim', 'Then pick it in a "your own model" list below: a hand, a head, a weapon or a whole body.');
  const send = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      note.textContent = `Uploading ${f.name}…`;
      const r = await uploadModel(f);
      if (!r.ok) {
        note.textContent = r.text;
        return;
      }
      note.textContent = `Saved ${r.file}.`;
    }
    redraw();
  };
  up.addEventListener('click', () => input.click());
  input.addEventListener('change', () => input.files && void send(input.files));
  d.addEventListener('dragover', (e) => e.dataTransfer?.types.includes('Files') && e.preventDefault());
  d.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    void send(e.dataTransfer.files);
  });
  row.append(up, input, note);
  d.append(row);
  for (const m of customModels()) {
    const line = el('div', 'devp-row');
    const del = el('button', 'mm-small', 'Delete');
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the uploaded model "${m.label}"? Anything that uses it goes back to the game's own.`)) return;
      const err = await deleteModel(m.file);
      if (err) note.textContent = err;
      else redraw();
    });
    line.append(el('span', '', `${m.label} `), el('small', 'devp-dim', m.file), del);
    d.append(line);
  }
  box.append(d);
}
