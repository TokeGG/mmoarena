import { botTests } from './botTestState';

/** The glyph of the pseudo-aura: a flask, because the bot is an experiment. */
export const BOT_TEST_GLYPH = '🧪';

const CSS = `
.aura.bottest { border-color:#a06bff; box-shadow:0 0 6px rgba(160,107,255,.75); background:linear-gradient(#2a1f45,#171326); }
.pdebuff.bottest { border:1px solid #a06bff; background:linear-gradient(#2a1f45,#171326); box-shadow:0 0 5px rgba(160,107,255,.8); pointer-events:auto; cursor:help; border-radius:3px; }
.bd-test { margin-left:6px; padding:0 4px; border-radius:3px; border:1px solid #a06bff; background:#241a3d; color:#e4d4ff; font:600 10px/16px system-ui; cursor:help; white-space:nowrap; }
`;
let styled = false;
function ensureStyles(): void {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const s = document.createElement('style');
  s.id = 'bot-test-styles';
  s.textContent = CSS;
  document.head.append(s);
}

/**
 * The marker as a debuff-style icon for a unit frame's buff row; its tooltip (data-tip "bottest:<unit>") is built by tips.ts
 * from the same state. Null when the unit plays the shipped brain.
 */
export function botTestIcon(unit: number): HTMLElement | null {
  const t = botTests.get(unit);
  if (!t) return null;
  ensureStyles();
  const icon = document.createElement('div');
  icon.className = 'aura bad bottest';
  icon.textContent = BOT_TEST_GLYPH;
  icon.dataset.tip = `bottest:${unit}`;
  icon.setAttribute('aria-label', `Learning test: ${t.label}`);
  return icon;
}

/** The small badge in the spectator builds panel's name row. */
export function botTestBadge(unit: number): HTMLElement | null {
  const t = botTests.get(unit);
  if (!t) return null;
  ensureStyles();
  const b = document.createElement('span');
  b.className = 'bd-test';
  b.textContent = `${BOT_TEST_GLYPH} ${t.label}`;
  b.dataset.tip = `bottest:${unit}`;
  return b;
}

/** Make sure the styles exist before the nameplate builds its icon. */
export const ensureBotTestStyles = ensureStyles;
