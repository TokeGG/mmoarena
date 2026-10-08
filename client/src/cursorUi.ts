/** The Cursor settings panel (style, size, tint, click ripple, trail and a live preview), used in the Esc menu and the profile's Customize tab. */
import { CURSORS, unlockText } from '@arena/shared';
import { SIZE_MAX, SIZE_MIN, TINT_CHOICES, TRAIL_MAX, TRAIL_MIN, cursorClassColor, cursorDeclarations, getCursorSettings, glowFor, isCursorOpen, onCursorChange, tintColor, updateCursorSettings } from './cursors';
import { cursorArt } from './cursorArt';
import type { ArtState } from './cursorArt';

let uid = 0;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const STATE_LABELS: [ArtState, string][] = [['default', 'Normal'], ['link', 'Buttons'], ['enemy', 'Enemy'], ['ally', 'Ally'], ['self', 'You'], ['aim', 'Aiming'], ['aimBlocked', 'Cannot cast'], ['busy', 'Stunned']];

export function buildCursorPanel(): HTMLElement {
  const root = el('div', 'cur-panel');
  const row = (label: string, ...kids: (HTMLElement | string)[]) => {
    const r = el('div', 'cur-row');
    r.append(el('span', 'cur-l', label), ...kids);
    root.append(r);
    return r;
  };

  const style = el('select');
  style.setAttribute('aria-label', 'Cursor style');
  row('Style', style);
  const size = el('input');
  size.type = 'range';
  size.min = String(SIZE_MIN);
  size.max = String(SIZE_MAX);
  size.step = '0.05';
  const sizeVal = el('span', 'cur-v');
  row('Size', size, sizeVal);
  const tint = el('select');
  for (const [v, t] of TINT_CHOICES) {
    const o = el('option', '', t);
    o.value = v;
    tint.append(o);
  }
  row('Tint', tint);
  const ripple = el('input');
  ripple.type = 'checkbox';
  const rippleLab = el('label', 'cur-tgl');
  rippleLab.append(ripple, el('span', '', 'Ripple where you click'));
  row('Click', rippleLab);
  const trail = el('input');
  trail.type = 'checkbox';
  const trailLab = el('label', 'cur-tgl');
  trailLab.append(trail, el('span', '', 'Trail'));
  const trailLen = el('input');
  trailLen.type = 'range';
  trailLen.min = String(TRAIL_MIN);
  trailLen.max = String(TRAIL_MAX);
  trailLen.step = '1';
  const trailVal = el('span', 'cur-v');
  row('Trail', trailLab, trailLen, trailVal);
  const preview = el('div', 'cur-prev');
  const chips = el('div', 'cur-chips');
  const tryBox = el('div', 'cur-try', 'Move here to try it');
  preview.append(chips, tryBox);
  root.append(preview);
  root.append(el('div', 'cur-hint', 'Locked cursors open as you play: matches played, wins and your best rating. The gauntlet changes over enemies, allies and aimed ground spells; other styles show them as a coloured glow and still switch to the aiming crosshair.'));

  const fillOptions = () => {
    style.replaceChildren();
    for (const c of CURSORS) {
      const open = isCursorOpen(c.id);
      if (!open && c.unlock.kind === 'owner') continue; // owner-only ones stay hidden from everyone else
      const o = el('option', '', open ? c.name : `🔒 ${c.name} (${unlockText(c)})`);
      o.value = c.id;
      o.disabled = !open;
      style.append(o);
    }
  };

  const paintChips = () => {
    const s = getCursorSettings();
    const t = tintColor(s, cursorClassColor());
    chips.replaceChildren();
    const states: ArtState[] = s.style === 'gauntlet' ? ['default', 'link', 'enemy', 'ally', 'self', 'aim', 'aimBlocked', 'busy'] : ['default', 'enemy', 'ally', 'aim', 'aimBlocked'];
    for (const st of states) {
      const chip = el('div', 'cur-chip');
      const a = cursorArt(s.style, st, { size: 1.25, glow: glowFor(s.style, st, t), ids: `cp${uid++}-` });
      const holder = el('div', 'cur-img');
      holder.innerHTML = a.svg;
      chip.append(holder, el('small', '', STATE_LABELS.find((x) => x[0] === st)![1]));
      chips.append(chip);
    }
    tryBox.setAttribute('style', cursorDeclarations(s.style, 'default', { size: s.size, glow: glowFor(s.style, 'default', t) }).join(''));
  };

  const sync = () => {
    const s = getCursorSettings();
    if (!style.options.length) fillOptions();
    style.value = s.style;
    size.value = String(s.size);
    sizeVal.textContent = `${s.size.toFixed(2).replace(/0$/, '')}×`;
    tint.value = TINT_CHOICES.some(([v]) => v === s.tint) ? s.tint : 'class';
    ripple.checked = s.ripple;
    trail.checked = s.trail;
    trailLen.value = String(s.trailLen);
    trailLen.disabled = !s.trail;
    trailVal.textContent = String(s.trailLen);
    paintChips();
  };

  style.addEventListener('change', () => updateCursorSettings({ style: style.value }));
  size.addEventListener('input', () => updateCursorSettings({ size: Number(size.value) }));
  tint.addEventListener('change', () => updateCursorSettings({ tint: tint.value }));
  ripple.addEventListener('change', () => updateCursorSettings({ ripple: ripple.checked }));
  trail.addEventListener('change', () => updateCursorSettings({ trail: trail.checked }));
  trailLen.addEventListener('input', () => updateCursorSettings({ trailLen: Number(trailLen.value) }));

  let wasShown = false;
  const off = onCursorChange(() => {
    // a panel that was shown and then thrown away (the profile window closed) stops listening
    if (root.isConnected) wasShown = true;
    else if (wasShown) return void off();
    fillOptions(); // the unlocked set may have changed (sign-in, a win)
    sync();
  });
  fillOptions();
  sync();
  return root;
}
