import type { ClassId, School } from '@arena/shared';

/** Emoji stand-ins for ability and aura art. Swap for real icon sprites later; only this file changes. */
export const ABILITY_ICON: Record<string, string> = {
  // trinkets
  trinket_cleanse: '🧼', trinket_shield: '🔰', trinket_heal: '🧪',
  // warrior
  mortal_strike: '⚔️', charge: '🐗', pummel: '👊', hamstring: '🥾', execute: '💀', intimidating_shout: '📢', bloodthirst: '💢', whirlwind: '🌪️',
  enraged_regeneration: '💖', heroic_leap: '🦘', slice_and_dice: '🌀', bladestorm: '🪚', slam: '🔨', reel_in: '⛓️', deep_cuts: '✂️', axe_throw: '🪓',
  not_going_anywhere: '🚩', dragon_roar: '🦖', battle_banner: '🏴',
  // mage
  frostbolt: '❄️', fireball: '🔥', polymorph: '🐑', counterspell: '🚫', frost_nova: '🧊', blink: '✨', ice_barrier: '🥶', pyroblast: '☄️', flamestrike: '🌋',
  arcane_blast: '🔮', arcane_barrage: '🌟', arcane_power: '⚡', arcane_missiles: '🌠', arcane_explosion: '💥', ice_lance: '🔱', scorch: '🧨', deep_freeze: '⛄',
  dragons_breath: '🐉', evocation: '🧘', mirror_image: '👥', rune_of_power: '🔯',
  // priest
  flash_heal: '💚', power_word_shield: '🛡️', smite: '☀️', dispel_magic: '🪄', psychic_scream: '😱', greater_heal: '💗', pain_suppression: '🙏',
  desperate_prayer: '🕯️', mind_blast: '🧠', shadow_word_death: '☠️', dispersion: '🌫️', penance: '🔆', plague_bloom: '🦠', holy_nova: '🔔', mind_flay: '🧿',
  leap_of_faith: '🤝', purifying_light: '🕊️', ascend: '☁️',
  // rogue
  stealth: '👤', cheap_shot: '💫', sinister_strike: '🗡️', backstab: '🔪', kidney_shot: '🥊', kick: '🦶', sprint: '💨', mutilate: '🥩', vanish: '🌑',
  adrenaline_rush: '💉', shadowstep: '👣', evasion: '🤺', blind: '😵', eviscerate: '🩸', garrote: '🪢', exsanguinate: '🧛', gouge: '👁️', sap: '🪵',
};

/** Auras are unique among themselves; an aura an ability applies mostly wears that ability's icon, and the rest get their own. */
export const AURA_ICON: Record<string, string> = {
  polymorph: '🐑', frost_nova_root: '🧊', frostbolt_slow: '❄️', frostbolt_root: '🌨️', hamstring_slow: '🥾', charge_stun: '🐗', charge_root: '⚓',
  cheap_shot_stun: '💫', kidney_shot: '🥊', psychic_scream: '😱', psychic_stun: '🤯', psychic_flee: '🏃', pw_shield: '🛡️', stealth: '👤', sprint: '💨',
  recklessness: '😡', shield_wall: '🧱', enraged_regeneration: '💖', deep_cuts_bleed: '✂️', slice_hold: '🌀', intimidating_shout: '📢', concussion_stun: '🪨',
  ice_barrier: '🥶', arcane_power: '⚡', pain_suppression: '🙏', dispersion: '🌫️', adrenaline_rush: '💉', evasion: '🤺',
  shockwave_stun: '💥', howl_slow: '📯', die_by_the_sword: '🗡️', power_infusion: '🙌', blind: '😵', crippling_slow: '🦂', rogue_slow: '🕸️',
  blink_speed: '👟', blink_haste: '🚀', arcane_slow: '💠', garrote_bleed: '🪢', mutilate_bleed: '🥩', shatter: '💎', fingers_of_frost: '🖐️',
  arcane_charge: '🔮', dragons_breath: '🐉', evocation: '🧘', hot_streak: '🔥', cauterized: '🧯', burn: '♨️', deep_freeze_stun: '⛄',
  mortal_wounds: '🩸', mind_flay_slow: '🧿', mind_slow: '💭', hammer_stun: '🌩️', judgment_stun: '⚖️', creeping_rot: '☠️', plague_bloom: '🦠', plague_ready: '🧫',
  trinket_shield: '🔰', gouge: '👁️', sap: '🪵', banner_buff: '🏴', mirror_image: '👥', rune_of_power: '🔯', purified: '🕊️', ascended: '☁️',
  intercept_guard: '🤝', renew: '🌿', penance_barrier: '🔆',
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
