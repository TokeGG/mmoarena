import { deckPiers } from '@arena/shared';
import type { ArenaDef, Rect } from '@arena/shared';
import { itemOf, makeView } from './mapEditLogic';
import type { Sel, View } from './mapEditLogic';

/**
 * A top-down drawing of an arena (the map editor's live preview, and a thumbnail for the map list): ground in the theme's
 * colour, the start zones behind the gates, pillars, walls, barricades, lava, the walkway with its ramps and piers, and the
 * start spots with the way they face. Pure canvas, no game state. x runs right, z runs down.
 */

const GROUND: Record<string, [string, string]> = {
  colosseum: ['#c9b28a', '#b79c70'], ruins: ['#9aa38f', '#838c78'], frost: ['#cfe3ee', '#b4d0df'],
  cinder: ['#5a4a45', '#4a3b37'], forge: ['#6d5a4c', '#574639'], sandstone: ['#d9bb82', '#c4a46c'],
};

const rectPath = (c: CanvasRenderingContext2D, v: View, r: Rect) => c.rect(v.px(r.x0), v.py(r.z0), (r.x1 - r.x0) * v.scale, (r.z1 - r.z0) * v.scale);

export interface PreviewOpts {
  sel?: Sel;
  /** Draw the yard grid and the labels (the editor); off for thumbnails. */
  detail?: boolean;
  /** A box being dragged out by a tool. */
  ghost?: Rect | null;
}

export function drawArena(c: CanvasRenderingContext2D, a: ArenaDef, w: number, h: number, o: PreviewOpts = {}): View {
  const v = makeView(a.bounds, w, h, o.detail ? 18 : 4);
  const b = a.bounds;
  const [g1, g2] = GROUND[a.theme] ?? GROUND.colosseum;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#10131a';
  c.fillRect(0, 0, w, h);
  // ground, with the start zones behind each gate a shade different
  c.fillStyle = g1;
  c.fillRect(v.px(b.minX), v.py(b.minZ), (b.maxX - b.minX) * v.scale, (b.maxZ - b.minZ) * v.scale);
  c.fillStyle = 'rgba(70,120,255,0.16)';
  c.fillRect(v.px(b.minX), v.py(b.minZ), (-a.gateX - b.minX) * v.scale, (b.maxZ - b.minZ) * v.scale);
  c.fillStyle = 'rgba(255,80,70,0.16)';
  c.fillRect(v.px(a.gateX), v.py(b.minZ), (b.maxX - a.gateX) * v.scale, (b.maxZ - b.minZ) * v.scale);
  if (o.detail) {
    c.strokeStyle = g2;
    c.lineWidth = 1;
    c.beginPath();
    for (let x = Math.ceil(b.minX / 5) * 5; x <= b.maxX; x += 5) { c.moveTo(v.px(x), v.py(b.minZ)); c.lineTo(v.px(x), v.py(b.maxZ)); }
    for (let z = Math.ceil(b.minZ / 5) * 5; z <= b.maxZ; z += 5) { c.moveTo(v.px(b.minX), v.py(z)); c.lineTo(v.px(b.maxX), v.py(z)); }
    c.stroke();
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.setLineDash([5, 4]);
    c.beginPath();
    for (const gx of [-a.gateX, a.gateX]) { c.moveTo(v.px(gx), v.py(b.minZ)); c.lineTo(v.px(gx), v.py(b.maxZ)); }
    c.stroke();
    c.setLineDash([]);
  }

  // lows and lava sit on the ground
  for (const r of a.lows ?? []) {
    c.beginPath();
    rectPath(c, v, r);
    c.fillStyle = r.lava ? '#e2561c' : '#8a6a44';
    c.fill();
    c.strokeStyle = r.lava ? '#ffb347' : '#5c4428';
    c.lineWidth = 1.5;
    c.stroke();
  }
  // the walkway: piers under it, flats, ramps with an arrow towards the high end
  const dk = a.deck;
  if (dk) {
    let piers: Rect[] = [];
    try {
      piers = deckPiers(a);
    } catch {
      // a half-made walkway: draw the rest
    }
    for (const r of piers) { c.beginPath(); rectPath(c, v, r); c.fillStyle = '#4b4f57'; c.fill(); }
    for (const r of dk.flats) {
      c.beginPath();
      rectPath(c, v, r);
      c.fillStyle = 'rgba(235,225,200,0.82)';
      c.fill();
      c.strokeStyle = '#6a5d45';
      c.lineWidth = 2;
      c.stroke();
      if (o.detail) { c.fillStyle = '#4a4130'; c.font = '11px sans-serif'; c.textAlign = 'center'; c.fillText(`${dk.height}`, v.px((r.x0 + r.x1) / 2), v.py((r.z0 + r.z1) / 2) + 4); }
    }
    for (const r of dk.ramps) {
      const x0 = v.px(r.x0), x1 = v.px(r.x1), y0 = v.py(r.z0), y1 = v.py(r.z1);
      const horiz = r.rise === '+x' || r.rise === '-x';
      const grad = horiz ? c.createLinearGradient(x0, 0, x1, 0) : c.createLinearGradient(0, y0, 0, y1);
      const up = r.rise === '+x' || r.rise === '+z';
      grad.addColorStop(0, up ? 'rgba(180,165,130,0.45)' : 'rgba(235,225,200,0.9)');
      grad.addColorStop(1, up ? 'rgba(235,225,200,0.9)' : 'rgba(180,165,130,0.45)');
      c.fillStyle = grad;
      c.fillRect(x0, y0, x1 - x0, y1 - y0);
      c.strokeStyle = '#6a5d45';
      c.lineWidth = 1.5;
      c.strokeRect(x0, y0, x1 - x0, y1 - y0);
      if (o.detail) {
        // arrow towards the high end
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, len = (horiz ? x1 - x0 : y1 - y0) * 0.3 * (up ? 1 : -1);
        c.strokeStyle = '#4a4130';
        c.lineWidth = 2;
        c.beginPath();
        if (horiz) { c.moveTo(cx - len, cy); c.lineTo(cx + len, cy); c.lineTo(cx + len - Math.sign(len) * 5, cy - 4); c.moveTo(cx + len, cy); c.lineTo(cx + len - Math.sign(len) * 5, cy + 4); }
        else { c.moveTo(cx, cy - len); c.lineTo(cx, cy + len); c.lineTo(cx - 4, cy + len - Math.sign(len) * 5); c.moveTo(cx, cy + len); c.lineTo(cx + 4, cy + len - Math.sign(len) * 5); }
        c.stroke();
      }
    }
  }
  for (const r of a.walls ?? []) {
    c.beginPath();
    rectPath(c, v, r);
    c.fillStyle = '#3a3d44';
    c.fill();
    c.strokeStyle = '#15171b';
    c.lineWidth = 1.5;
    c.stroke();
  }
  for (const p of a.pillars) {
    c.beginPath();
    c.arc(v.px(p.x), v.py(p.z), p.r * v.scale, 0, Math.PI * 2);
    c.fillStyle = '#6c7078';
    c.fill();
    c.strokeStyle = '#2a2c31';
    c.lineWidth = 1.5;
    c.stroke();
  }
  // start spots
  a.spawns.forEach((side, team) => side.forEach((s, i) => {
    const px = v.px(s.x), py = v.py(s.z);
    const rr = Math.max(4, 0.9 * v.scale);
    c.beginPath();
    c.arc(px, py, rr, 0, Math.PI * 2);
    c.fillStyle = team === 0 ? '#3d7bff' : '#ff4d42';
    c.fill();
    c.strokeStyle = '#fff';
    c.lineWidth = 1.5;
    c.stroke();
    const f = a.spawnFacing[team] ?? 0;
    c.beginPath();
    c.moveTo(px, py);
    c.lineTo(px + Math.sin(f) * rr * 1.7, py + Math.cos(f) * rr * 1.7);
    c.stroke();
    if (o.detail) { c.fillStyle = '#fff'; c.font = 'bold 10px sans-serif'; c.textAlign = 'center'; c.fillText(String(i + 1), px, py + 3.5); }
  }));
  // the map's edge
  c.strokeStyle = '#000';
  c.lineWidth = 2;
  c.strokeRect(v.px(b.minX), v.py(b.minZ), (b.maxX - b.minX) * v.scale, (b.maxZ - b.minZ) * v.scale);

  if (o.ghost) {
    c.beginPath();
    rectPath(c, v, o.ghost);
    c.fillStyle = 'rgba(255,255,255,0.25)';
    c.fill();
    c.strokeStyle = '#fff';
    c.setLineDash([4, 3]);
    c.stroke();
    c.setLineDash([]);
  }
  // selection: an outline and handles
  const it = itemOf(a, o.sel ?? null);
  if (it) {
    c.strokeStyle = '#ffe14d';
    c.lineWidth = 2.5;
    if ('x0' in it) {
      c.beginPath();
      rectPath(c, v, it);
      c.stroke();
      c.fillStyle = '#ffe14d';
      for (const [x, z] of [[it.x0, it.z0], [it.x1, it.z0], [it.x0, it.z1], [it.x1, it.z1], [(it.x0 + it.x1) / 2, it.z0], [(it.x0 + it.x1) / 2, it.z1], [it.x0, (it.z0 + it.z1) / 2], [it.x1, (it.z0 + it.z1) / 2]]) c.fillRect(v.px(x) - 3, v.py(z) - 3, 6, 6);
    } else {
      const r = 'r' in it ? it.r : 1;
      c.beginPath();
      c.arc(v.px(it.x), v.py(it.z), r * v.scale + 3, 0, Math.PI * 2);
      c.stroke();
    }
  }
  return v;
}
