import type { ClassId, School } from '@arena/shared';

/** Emoji stand-ins for ability and aura art. Swap for real icon sprites later; only this file changes. */
export const ABILITY_ICON: Record<string, string> = {
  mortal_strike: '⚔️', charge: '🐗', pummel: '👊', hamstring: '🩸',
  frostbolt: '❄️', fireball: '🔥', polymorph: '🐑', counterspell: '🚫', frost_nova: '🧊', blink: '✨',
  flash_heal: '💚', power_word_shield: '🛡️', smite: '☀️', dispel_magic: '🪄', psychic_scream: '😱',
  stealth: '👤', cheap_shot: '💫', sinister_strike: '🗡️', kidney_shot: '🥊', kick: '🦶', sprint: '💨',
  recklessness: '😡', execute: '💀', intimidating_shout: '📢', bloodthirst: '💢', whirlwind: '🌪️', enraged_regeneration: '💖',
  shield_slam: '🔰', concussion_blow: '🔨', shield_wall: '🧱',
  ice_barrier: '🥶', pyroblast: '☄️', flamestrike: '🌋', arcane_blast: '🔮', arcane_barrage: '🌟', arcane_missiles: '🌠', arcane_explosion: '💥', evocation: '🧘', dragons_breath: '🐉', arcane_power: '⚡',
  greater_heal: '💗', pain_suppression: '🙏', desperate_prayer: '🕯️', mind_blast: '🧠', shadow_word_death: '💀', dispersion: '🌫️',
  mutilate: '🔪', vanish: '🌑', adrenaline_rush: '💉', shadowstep: '👣', evasion: '🌀',
  shockwave: '💥', piercing_howl: '📯', die_by_the_sword: '🗡️', 
  ice_lance: '🗡️', blizzard: '🌨️', scorch: '🔥', deep_freeze: '🧊', arcane_silence: '🤐', hammer_toss: '🔨', harpoon_throw: '🪝',
  judgment_hammer: '⚖️', hush: '🤫', plague_bloom: '🦠', choke_bomb: '💨', knife_snipe: '🗡️', garrote: '🩸', holy_nova: '✨', mind_flay: '🧠', fan_of_knives: '🔪',
  penance: '🔆', holy_word: '🌟', power_infusion: '🙌', blind: '😵', eviscerate: '🩸', exsanguinate: '🧛', crippling_strike: '🦵',
};

export const AURA_ICON: Record<string, string> = {
  polymorph: '🐑', frost_nova_root: '🧊', frostbolt_slow: '❄️', hamstring_slow: '🩸',
  cheap_shot_stun: '💫', kidney_shot: '💫', psychic_scream: '😱', pw_shield: '🛡️', stealth: '👤', sprint: '💨',
  recklessness: '😡', shield_wall: '🧱', intimidating_shout: '📢', concussion_stun: '🔨', ice_barrier: '🥶', arcane_power: '⚡',
  pain_suppression: '🙏', dispersion: '🌫️', adrenaline_rush: '💉', evasion: '🌀',
  shockwave_stun: '💥', howl_slow: '📯', die_by_the_sword: '🗡️', 
  power_infusion: '🙌', blind: '😵', crippling_slow: '🦵', blink_speed: '💨', blink_haste: '⚡', arcane_slow: '💥', garrote_bleed: '🩸', mutilate_bleed: '🩸', shatter: '💎', arcane_charge: '🔮', dragons_breath: '🐉', evocation: '🧘', hot_streak: '🔥',
  deep_freeze_stun: '🧊', hammer_stun: '🔨', judgment_stun: '⚖️', choke_stun: '💨', creeping_rot: '☠️', plague_bloom: '🦠',
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
