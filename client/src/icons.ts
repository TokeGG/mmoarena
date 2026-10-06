import type { ClassId, School } from '@arena/shared';

/** Emoji stand-ins for ability and aura art. Swap for real icon sprites later; only this file changes. */
export const ABILITY_ICON: Record<string, string> = {
  mortal_strike: '⚔️', charge: '🐗', pummel: '👊', hamstring: '🩸',
  frostbolt: '❄️', fireball: '🔥', polymorph: '🐑', counterspell: '🚫', frost_nova: '🧊', blink: '✨',
  flash_heal: '💚', power_word_shield: '🛡️', smite: '☀️', dispel_magic: '🪄', psychic_scream: '😱',
  stealth: '👤', cheap_shot: '💫', sinister_strike: '🗡️', kidney_shot: '🥊', kick: '🦶', sprint: '💨',
};

export const AURA_ICON: Record<string, string> = {
  polymorph: '🐑', frost_nova_root: '🧊', frostbolt_slow: '❄️', hamstring_slow: '🩸',
  cheap_shot_stun: '💫', kidney_shot: '💫', psychic_scream: '😱', pw_shield: '🛡️', stealth: '👤', sprint: '💨',
};

export const CLASS_ICON: Record<ClassId, string> = { warrior: '⚔️', mage: '🔮', priest: '✝️', rogue: '🗡️' };

export const SCHOOL_GRADIENT: Record<School, string> = {
  physical: 'linear-gradient(145deg,#6b5a45,#2e2620)',
  fire: 'linear-gradient(145deg,#a8431c,#3a1a0c)',
  frost: 'linear-gradient(145deg,#2f77a8,#10243a)',
  arcane: 'linear-gradient(145deg,#7a4ab0,#241440)',
  holy: 'linear-gradient(145deg,#b8962f,#3d3010)',
  shadow: 'linear-gradient(145deg,#5a2f8a,#1a0f2a)',
  nature: 'linear-gradient(145deg,#3f8a3a,#13280f)',
};
